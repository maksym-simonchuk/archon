import { parse } from 'yaml';
import type {
  CapabilityRequest,
  PolicyDecision,
  PolicyVerdict,
  Profile,
} from '../core/types';

// ── Policy document (the shape of .archon/policy.yaml) ───────────────────────

/** A `when:` clause — extra conditions a rule requires before it matches. */
export interface WhenClause {
  blast_radius_files_max?: number;
  blast_radius_files_exceeds?: number;
  lines_changed_min?: number;
  in_worktree?: boolean;
}

export interface PolicyRule {
  action: CapabilityRequest['action'];
  /** Path glob(s) for fs/secret, command prefix(es) for exec. Absent ⇒ any target. */
  target?: string | string[];
  when?: WhenClause;
}

export interface PolicyProfile {
  description?: string;
  /** Name of a profile whose rules are inherited (then extended). */
  inherits?: string;
  allow?: PolicyRule[];
  ask?: PolicyRule[];
  deny?: PolicyRule[];
}

export interface PolicyLimits {
  blast_radius_files_max?: number;
  per_task_usd?: number;
  global_daily_usd?: number;
  context_tokens_max?: number;
}

export interface PolicyDocument {
  version: number;
  active_profile: Profile;
  defaults?: { decision?: PolicyDecision };
  profiles: Record<string, PolicyProfile>;
  limits?: PolicyLimits;
}

/** Conditions the evaluator needs that aren't part of the request itself. */
export interface PolicyEvalContext {
  /** Inside an isolated git worktree (enables `trusted`-profile writes). */
  inWorktree?: boolean;
  /** Lines the pending edit changes (drives the >50-line ask rule). */
  linesChanged?: number;
  /** Audit correlation only — ignored by policy evaluation. */
  taskId?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Parse + minimally validate `.archon/policy.yaml`. The file is repo-controlled
 * and integrity-guarded, so only the load-bearing top level is validated; the
 * nested rule shape is trusted. Throws on a malformed document.
 */
export function loadPolicy(yamlText: string): PolicyDocument {
  const raw: unknown = parse(yamlText);
  if (!isRecord(raw)) throw new Error('[archon] policy.yaml: root must be a mapping');
  if (!isRecord(raw.profiles)) throw new Error('[archon] policy.yaml: missing "profiles" mapping');
  if (typeof raw.active_profile !== 'string') {
    throw new Error('[archon] policy.yaml: missing "active_profile"');
  }
  return raw as unknown as PolicyDocument;
}

const asArray = <T>(x: T | T[] | undefined): T[] =>
  x === undefined ? [] : Array.isArray(x) ? x : [x];

/**
 * Glob to RegExp. A globstar-then-slash is an optional any-depth prefix; a bare
 * globstar crosses path separators; a single star stays within one segment; a
 * question mark matches exactly one character.
 */
const globToRegExp = (glob: string): RegExp => {
  let body = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++; // consume the second '*'
        if (glob[i + 1] === '/') {
          i++; // consume the '/': **/ ⇒ optional any-depth prefix
          body += '(?:.*/)?';
        } else {
          body += '.*'; // ** ⇒ anything, including separators
        }
      } else {
        body += '[^/]*'; // * ⇒ within one path segment
      }
    } else if (c === '?') {
      body += '.';
    } else if ('.+^${}()|[]\\/'.includes(c)) {
      body += `\\${c}`; // escape regex specials
    } else {
      body += c;
    }
  }
  return new RegExp(`^${body}$`);
};

/** Split a command string into whitespace-delimited tokens. */
const tokenize = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);

/** All of `target`'s tokens appear, in order, among `command`'s tokens. */
const commandSubsequence = (target: string, command: string): boolean => {
  const want = tokenize(target);
  const have = tokenize(command);
  let i = 0;
  for (const tok of have) if (i < want.length && tok === want[i]) i++;
  return i === want.length;
};

/** `command` is exactly `target`, or `target` followed by more tokens. */
const commandPrefix = (target: string, command: string): boolean =>
  command === target || command.startsWith(`${target} `);

/**
 * Evaluates (action, target, blastRadius) against the active profile's rules
 * from `.archon/policy.yaml` → allow | ask | deny, with default-deny. Precedence
 * is deny > ask > allow; a profile-independent hard limit on blast radius always
 * denies. See ADR-0003 / ADR-0010.
 */
export class PolicyEngine {
  private readonly profileName: Profile;

  constructor(
    private readonly doc: PolicyDocument,
    profile?: Profile,
  ) {
    this.profileName = profile ?? doc.active_profile;
  }

  /**
   * A read-only summary of the active profile for `archon policy`: the
   * inheritance chain (most-derived → base) and every rule it contributes,
   * grouped per profile in precedence order (deny, then ask, then allow). A rule
   * carrying a `when:` clause is flagged `conditional`. Evaluation is unaffected —
   * this is purely for introspection of the constraint surface.
   */
  describe(): {
    profile: Profile;
    chain: string[];
    rules: { decision: PolicyDecision; action: CapabilityRequest['action']; target: string; conditional: boolean }[];
  } {
    const chain = this.profileChain(this.profileName);
    const rules: {
      decision: PolicyDecision;
      action: CapabilityRequest['action'];
      target: string;
      conditional: boolean;
    }[] = [];
    for (const name of chain) {
      const own = this.rulesOf(name);
      for (const decision of ['deny', 'ask', 'allow'] as const) {
        for (const rule of own[decision]) {
          rules.push({
            decision,
            action: rule.action,
            target: asArray(rule.target).join(', ') || '(any target)',
            conditional: rule.when !== undefined,
          });
        }
      }
    }
    return { profile: this.profileName, chain, rules };
  }

  evaluate(req: CapabilityRequest, ctx: PolicyEvalContext = {}): PolicyVerdict {
    const files = req.blastRadius?.files.length ?? 0;

    // Hard ceiling, independent of profile (limits in policy.yaml).
    const hardMax = this.doc.limits?.blast_radius_files_max;
    if (hardMax !== undefined && files > hardMax) {
      return {
        decision: 'deny',
        rule: 'limits.blast_radius_files_max',
        message: `blast radius (${files} files) exceeds hard limit ${hardMax}`,
      };
    }

    const chain = this.profileChain(this.profileName); // most-derived → base

    // A deny anywhere in the chain wins — a derived profile can never relax a
    // base-profile deny (destructive actions stay denied).
    for (const name of chain) {
      const i = this.rulesOf(name).deny.findIndex((r) => this.matches(r, req, ctx, true));
      if (i >= 0) return this.verdict('deny', `${name}.deny[${i}]`, req);
    }

    // Otherwise the most-derived profile that matches decides: an explicit
    // `trusted` allow overrides an inherited `safe` ask. Within one profile, ask
    // is checked before allow (conservative tie-break).
    for (const name of chain) {
      const rules = this.rulesOf(name);
      const askIdx = rules.ask.findIndex((r) => this.matches(r, req, ctx, false));
      if (askIdx >= 0) return this.verdict('ask', `${name}.ask[${askIdx}]`, req);
      const allowIdx = rules.allow.findIndex((r) => this.matches(r, req, ctx, false));
      if (allowIdx >= 0) return this.verdict('allow', `${name}.allow[${allowIdx}]`, req);
    }

    return {
      decision: this.doc.defaults?.decision ?? 'deny',
      rule: 'defaults.decision',
      message: `no rule matched ${req.action} → ${req.target} (default-deny)`,
    };
  }

  private verdict(decision: PolicyDecision, rule: string, req: CapabilityRequest): PolicyVerdict {
    return { decision, rule, message: `${decision} ${req.action} → ${req.target}` };
  }

  /** Profiles from most-derived to base, following `inherits` (cycle-safe). */
  private profileChain(name: string): string[] {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = name;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = this.doc.profiles[cur]?.inherits;
    }
    return chain;
  }

  /** One profile's own rules (no inheritance flattening). */
  private rulesOf(name: string): Record<'allow' | 'ask' | 'deny', PolicyRule[]> {
    const profile = this.doc.profiles[name];
    if (!profile) throw new Error(`[archon] policy.yaml: unknown profile "${name}"`);
    return { allow: asArray(profile.allow), ask: asArray(profile.ask), deny: asArray(profile.deny) };
  }

  private matches(
    rule: PolicyRule,
    req: CapabilityRequest,
    ctx: PolicyEvalContext,
    deny: boolean,
  ): boolean {
    if (rule.action !== req.action) return false;
    if (!this.targetMatches(rule, req, deny)) return false;
    return this.whenHolds(rule.when, req, ctx);
  }

  private targetMatches(rule: PolicyRule, req: CapabilityRequest, deny: boolean): boolean {
    const targets = asArray(rule.target);
    if (targets.length === 0) return true; // no target ⇒ any
    if (req.action === 'exec') {
      // Deny matches when the dangerous tokens appear in order anywhere in the
      // command, so reordering args (`git push origin main --force`) can't slip
      // past a `git push --force` deny. Allow/ask use a strict prefix so a broad
      // grant can't be widened by a coincidental subsequence.
      return targets.some((t) =>
        deny ? commandSubsequence(t, req.target) : commandPrefix(t, req.target),
      );
    }
    return targets.some((t) => globToRegExp(t).test(req.target));
  }

  private whenHolds(
    when: WhenClause | undefined,
    req: CapabilityRequest,
    ctx: PolicyEvalContext,
  ): boolean {
    if (!when) return true;
    const files = req.blastRadius?.files.length ?? 0;
    if (when.blast_radius_files_max !== undefined && files > when.blast_radius_files_max) return false;
    if (when.blast_radius_files_exceeds !== undefined && files <= when.blast_radius_files_exceeds) return false;
    if (when.lines_changed_min !== undefined && (ctx.linesChanged ?? 0) < when.lines_changed_min) return false;
    if (when.in_worktree !== undefined && ctx.inWorktree !== when.in_worktree) return false;
    return true;
  }
}
