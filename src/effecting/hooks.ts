import { posix } from 'node:path';
import type { ArchitecturalFingerprint } from '../core/types';

/** The directory cluster a repo-relative file belongs to (mirrors the boundary model's `moduleOf`). */
const moduleOf = (path: string): string => {
  const dir = posix.dirname(path.replace(/\\/g, '/'));
  return dir === '.' ? '(root)' : dir;
};

/**
 * Hooks engine (M19): the static, pre-write gate that runs BEFORE a planned
 * change reaches the broker, plus the post-write check specs the Verifier runs
 * after. Pre-hooks are pure and structural — they reason over the change's target
 * files and the import edges it would add, against the current module graph — so
 * a forbidden import or boundary leak is caught before anything is written.
 *
 * Pure: takes the planned change + the indexed edge set, returns findings. The
 * broker/loop decides what to do with a `block` finding; this module never writes.
 */

export type HookSeverity = 'warn' | 'block';
export type PreHookKind = 'never-modify' | 'forbidden-import' | 'boundary-leak';

export interface PreHookFinding {
  hook: PreHookKind;
  severity: HookSeverity;
  /** The file or edge the finding is about. */
  subject: string;
  detail: string;
}

export interface PlannedChange {
  /** Repo-relative files the change would write. */
  writes: string[];
  /** Import edges (src file → dst file) the change would add. */
  addedImports: { src: string; dst: string }[];
  /** The full current file-import edge set (for reachability / cycle checks). */
  existingEdges: { src: string; dst: string }[];
}

/** Path segments that mark a structurally sensitive (never-modify) zone — mirrors the risk engine. */
const NEVER_MODIFY_SEGMENTS = ['auth', 'payment', 'payments', 'billing', 'secrets', 'infra'];

/** A module's public surface — an import targeting one of these is not a leak. */
const PUBLIC_SURFACE = /\/(index|mod|public-api|index\.public)\.[cm]?[jt]sx?$/;

/** True if `to` can already reach `from` through module edges (so from→to closes a cycle). */
function reaches(from: string, to: string, adj: Map<string, Set<string>>): boolean {
  const seen = new Set<string>([from]);
  const stack = [from];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === to) return true;
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

/** Lift file edges to a module adjacency map (intra-module edges dropped). */
function moduleAdjacency(edges: { src: string; dst: string }[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    const s = moduleOf(e.src);
    const d = moduleOf(e.dst);
    if (s === d) continue;
    let set = adj.get(s);
    if (set === undefined) adj.set(s, (set = new Set()));
    set.add(d);
  }
  return adj;
}

export function evaluatePreHooks(change: PlannedChange): PreHookFinding[] {
  const findings: PreHookFinding[] = [];

  // 1. never-modify — a write into a sensitive zone always blocks.
  for (const file of change.writes) {
    const segs = file.replace(/\\/g, '/').split('/');
    if (NEVER_MODIFY_SEGMENTS.some((seg) => segs.includes(seg))) {
      findings.push({
        hook: 'never-modify',
        severity: 'block',
        subject: file,
        detail: 'write targets a sensitive (never-modify) zone — requires explicit human authorisation',
      });
    }
  }

  // Module adjacency from the edges that already exist (before this change).
  const adj = moduleAdjacency(change.existingEdges);

  for (const e of change.addedImports) {
    const sMod = moduleOf(e.src);
    const dMod = moduleOf(e.dst);
    if (sMod === dMod) continue; // intra-module imports are always fine

    // 2. forbidden-import — the added edge would create/extend a module cycle.
    if (reaches(dMod, sMod, adj)) {
      findings.push({
        hook: 'forbidden-import',
        severity: 'block',
        subject: `${sMod} → ${dMod}`,
        detail: `${dMod} already depends on ${sMod} — this import would close an import cycle`,
      });
      continue;
    }

    // 3. boundary-leak — a cross-module import that reaches past the target's public surface.
    if (!PUBLIC_SURFACE.test(e.dst.replace(/\\/g, '/'))) {
      findings.push({
        hook: 'boundary-leak',
        severity: 'warn',
        subject: `${e.src} → ${e.dst}`,
        detail: `imports an internal of ${dMod} rather than its public surface`,
      });
    }
  }

  return findings;
}

/** A post-write check the Verifier runs (argv, no shell) — typecheck, lint, tests. */
export interface PostHookCheck {
  name: string;
  argv: string[];
}

/**
 * The post-write checks implied by the detected stack: a type check when the repo
 * is typed, and the project's test runner when one is present. The loop's Verifier
 * already runs argv checks; this names the ones a change must pass.
 */
export function postHookChecks(fingerprint: ArchitecturalFingerprint): PostHookCheck[] {
  const checks: PostHookCheck[] = [];
  if (fingerprint.languages.includes('typescript') || fingerprint.buildSystem.includes('tsc')) {
    checks.push({ name: 'typecheck', argv: ['npx', 'tsc', '--noEmit'] });
  }
  if (fingerprint.testRunners.includes('vitest')) checks.push({ name: 'test', argv: ['npx', 'vitest', 'run'] });
  else if (fingerprint.testRunners.includes('jest')) checks.push({ name: 'test', argv: ['npx', 'jest'] });
  else if (fingerprint.testRunners.includes('node:test')) checks.push({ name: 'test', argv: ['node', '--test'] });
  return checks;
}

const SEV_LABEL: Record<HookSeverity, string> = { block: 'BLOCK', warn: 'WARN ' };

/** Human-readable hook report for the TUI. */
export function formatHooks(findings: PreHookFinding[], post: PostHookCheck[]): string {
  const lines: string[] = [];
  if (findings.length === 0) {
    lines.push('pre-write hooks: clean — no forbidden imports, boundary leaks, or never-modify writes');
  } else {
    const blocks = findings.filter((f) => f.severity === 'block').length;
    lines.push(`pre-write hooks: ${findings.length} finding(s), ${blocks} blocking:`);
    for (const f of findings) {
      lines.push(`  [${SEV_LABEL[f.severity]}] ${f.hook}: ${f.subject}`);
      lines.push(`         ${f.detail}`);
    }
  }
  lines.push('', post.length > 0 ? 'post-write checks:' : 'post-write checks: none for this stack');
  for (const c of post) lines.push(`  ✓ ${c.name}: ${c.argv.join(' ')}`);
  return lines.join('\n');
}
