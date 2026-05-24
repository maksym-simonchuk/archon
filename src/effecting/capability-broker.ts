import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import type { BlastRadius, CapabilityRequest, PolicyVerdict } from '../core/types';
import { err, ok, type Result } from '../core/result';
import { realContainedPath } from '../core/path-safety';
import type { AuditLog } from './audit-log';
import type { PolicyEngine, PolicyEvalContext } from './policy-engine';

const execFileAsync = promisify(execFile);

/** Options for a guarded filesystem write. */
export interface FsWriteOptions extends PolicyEvalContext {
  /** Files/symbols transitively affected — drives the blast-radius rules. */
  blastRadius?: BlastRadius;
  /** Why the write is happening (recorded in the audit log). */
  reason: string;
}

/** Options for a guarded filesystem read. */
export interface FsReadOptions extends PolicyEvalContext {
  /** Why the read is happening (recorded in the audit log). */
  reason: string;
}

/** Options for a guarded filesystem delete. */
export interface FsDeleteOptions extends PolicyEvalContext {
  /** Files transitively removed — drives the blast-radius rules. */
  blastRadius?: BlastRadius;
  /** Why the delete is happening (recorded in the audit log). */
  reason: string;
  /** Delete a directory tree recursively. Default: file-only delete. */
  recursive?: boolean;
}

/** Options for a guarded command execution. */
export interface ExecOptions extends PolicyEvalContext {
  /** Working directory for the command (defaults to the repo root). */
  cwd?: string;
  /** Why the command runs (recorded in the audit log). */
  reason?: string;
}

/**
 * The single mediator for ALL side effects (fs / exec / net / secret). Agents
 * hold zero ambient authority: every effect routes through here, is checked by
 * the PolicyEngine, and is recorded in the AuditLog. This is the one module
 * allowed to import `fs` / `child_process` in agent paths. See ADR-0003.
 */
export class CapabilityBroker {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly audit: AuditLog,
    private readonly repoRoot: string = process.cwd(),
  ) {}

  /**
   * The universal gate: evaluate a capability request and record the decision.
   * Every guarded effect asks here first; nothing acts on a non-`allow` verdict.
   */
  async request(req: CapabilityRequest, ctx: PolicyEvalContext = {}): Promise<PolicyVerdict> {
    const verdict = this.policy.evaluate(req, ctx);
    this.record(req, verdict, ctx.taskId);
    return verdict;
  }

  /**
   * Guarded filesystem write: refuses to escape the repo tree (following
   * symlinks, so an in-repo symlink can't redirect a write outside), evaluates
   * the `fs.write` capability, and writes only on `allow`. The one place a write
   * reaches disk — agents never import `node:fs` themselves.
   */
  async fsWrite(target: string, content: string, opts: FsWriteOptions): Promise<Result<void>> {
    const real = await realContainedPath(this.repoRoot, target);
    if (real === null) {
      const verdict: PolicyVerdict = {
        decision: 'deny',
        rule: 'broker.repo_escape',
        message: `path escapes the repo tree: ${target}`,
      };
      this.record({ action: 'fs.write', target, reason: opts.reason }, verdict, opts.taskId);
      return err({ code: 'policy.deny', message: verdict.message });
    }

    const req: CapabilityRequest = {
      action: 'fs.write',
      target,
      blastRadius: opts.blastRadius,
      reason: opts.reason,
    };
    const verdict = await this.request(req, opts);
    if (verdict.decision !== 'allow') {
      return err({ code: `policy.${verdict.decision}`, message: verdict.message });
    }
    // Create intermediate dirs only after the allow verdict (a denied write must
    // leave no trace). `real` is already proven contained, so its parent is too.
    await mkdir(dirname(real), { recursive: true });
    await writeFile(real, content);
    return ok(undefined);
  }

  /**
   * Guarded filesystem read: refuses to escape the repo tree (following
   * symlinks, mirroring `fsWrite`), evaluates the `fs.read` capability, and reads
   * only on `allow`. This is where the policy's secret-glob denies (dotenv files,
   * `secrets/` dirs, PEM keys, `id_rsa`) are *enforced* rather than merely
   * declared — the broad `fs.read` allow can't become a secret-exfil path. A
   * missing file resolves to a benign `fs.read_failed` Result (an agent-facing
   * `@file` typo shouldn't throw). The indexer's bulk sensing reads are separate.
   */
  async fsRead(target: string, opts: FsReadOptions): Promise<Result<string>> {
    const real = await realContainedPath(this.repoRoot, target);
    if (real === null) {
      const verdict: PolicyVerdict = {
        decision: 'deny',
        rule: 'broker.repo_escape',
        message: `path escapes the repo tree: ${target}`,
      };
      this.record({ action: 'fs.read', target, reason: opts.reason }, verdict, opts.taskId);
      return err({ code: 'policy.deny', message: verdict.message });
    }

    // Evaluate against the original `target` so the secret globs match by name
    // (same as fsWrite); `real` is only used to read once allowed.
    const verdict = await this.request({ action: 'fs.read', target, reason: opts.reason }, opts);
    if (verdict.decision !== 'allow') {
      return err({ code: `policy.${verdict.decision}`, message: verdict.message });
    }
    try {
      return ok(await readFile(real, 'utf8'));
    } catch (e) {
      return err({ code: 'fs.read_failed', message: e instanceof Error ? e.message : String(e), cause: e });
    }
  }

  /**
   * Guarded directory listing. Re-uses the `fs.read` capability — listing a
   * directory is a read of its inode entries. Returns names only (not full
   * paths), with directories suffixed by `/` so the caller can distinguish.
   * A missing directory returns an empty list (not an error) so callers can
   * treat "no openspec/changes yet" uniformly.
   */
  async fsList(target: string, opts: FsReadOptions): Promise<Result<string[]>> {
    const real = await realContainedPath(this.repoRoot, target);
    if (real === null) {
      const verdict: PolicyVerdict = {
        decision: 'deny',
        rule: 'broker.repo_escape',
        message: `path escapes the repo tree: ${target}`,
      };
      this.record({ action: 'fs.read', target, reason: opts.reason }, verdict, opts.taskId);
      return err({ code: 'policy.deny', message: verdict.message });
    }
    const verdict = await this.request({ action: 'fs.read', target, reason: opts.reason }, opts);
    if (verdict.decision !== 'allow') {
      return err({ code: `policy.${verdict.decision}`, message: verdict.message });
    }
    try {
      const entries = await readdir(real, { withFileTypes: true });
      return ok(entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)));
    } catch (e) {
      // ENOENT = "not yet" — return empty so callers don't need a special case.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ok([]);
      return err({ code: 'fs.list_failed', message: e instanceof Error ? e.message : String(e), cause: e });
    }
  }

  /**
   * Guarded filesystem delete (M40b). Refuses to escape the repo tree
   * (following symlinks), evaluates the `fs.delete` capability, and removes
   * only on `allow`. `recursive:true` removes a directory tree; otherwise a
   * single file. Default-deny in `safe` profile (policy.yaml asks); `trusted`
   * may grant explicitly. A missing target resolves to a no-op `ok`.
   */
  async fsDelete(target: string, opts: FsDeleteOptions): Promise<Result<void>> {
    const real = await realContainedPath(this.repoRoot, target);
    if (real === null) {
      const verdict: PolicyVerdict = {
        decision: 'deny',
        rule: 'broker.repo_escape',
        message: `path escapes the repo tree: ${target}`,
      };
      this.record({ action: 'fs.delete', target, reason: opts.reason }, verdict, opts.taskId);
      return err({ code: 'policy.deny', message: verdict.message });
    }
    const req: CapabilityRequest = {
      action: 'fs.delete',
      target,
      blastRadius: opts.blastRadius,
      reason: opts.reason,
    };
    const verdict = await this.request(req, opts);
    if (verdict.decision !== 'allow') {
      return err({ code: `policy.${verdict.decision}`, message: verdict.message });
    }
    try {
      await rm(real, { recursive: opts.recursive ?? false, force: true });
      return ok(undefined);
    } catch (e) {
      return err({ code: 'fs.delete_failed', message: e instanceof Error ? e.message : String(e), cause: e });
    }
  }

  /**
   * Guarded command execution. There is no shell — `argv` is handed to
   * `execFile`, so there is no shell-injection surface. The capability is
   * evaluated against the joined command string and runs only on `allow`.
   */
  async exec(argv: string[], opts: ExecOptions = {}): Promise<Result<{ stdout: string; stderr: string }>> {
    if (argv.length === 0) return err({ code: 'exec.empty', message: 'no command given' });
    const command = argv.join(' ');
    const verdict = await this.request({ action: 'exec', target: command, reason: opts.reason ?? command }, opts);
    if (verdict.decision !== 'allow') {
      return err({ code: `policy.${verdict.decision}`, message: verdict.message });
    }
    try {
      const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1), {
        cwd: opts.cwd ?? this.repoRoot,
        encoding: 'utf8',
      });
      return ok({ stdout, stderr });
    } catch (e) {
      return err({ code: 'exec.failed', message: e instanceof Error ? e.message : String(e), cause: e });
    }
  }

  /** Append a decision to the audit log. `protected` so a scoping subclass (AgentBroker) records its own denials. */
  protected record(req: CapabilityRequest, verdict: PolicyVerdict, taskId?: string): void {
    this.audit.append({
      taskId: taskId ?? 'unknown',
      ts: new Date().toISOString(),
      kind: 'decision',
      payload: { request: req, verdict },
    });
  }
}
