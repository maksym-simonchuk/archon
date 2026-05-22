import type { Violation, ViolationKind } from '../sensing/violations';

/**
 * Autonomous improvement engine (M21): turns architecture-health findings (M12)
 * into ranked, conservative, ROI-gated improvement proposals. It NEVER proposes a
 * change to a protected subject (a never-modify zone, or a structure the
 * Preservation Layer (M14) ruled `preserve`) — the caller passes those subjects
 * in. Pure: takes findings + the protected set, returns proposals. It proposes;
 * it never applies (constrained autonomy — the apply path goes through the loop).
 */

/** A conservative, structure-preserving remediation verb. */
export type ImprovementAction = 'break-cycle' | 'decompose' | 'realign-dependency' | 'add-tests';

export interface Improvement {
  action: ImprovementAction;
  /** The module/file/edge the proposal addresses (the violation subject). */
  subject: string;
  /** What to do, phrased as a safe, incremental step. */
  recommendation: string;
  /** Relative effort 1–5 (higher = more work / more risk of disruption). */
  effort: number;
  /** Value of fixing it — the violation's impact score. */
  value: number;
  /** ROI = value / effort, the ranking key (higher first). */
  roi: number;
}

export interface ImprovementReport {
  proposals: Improvement[];
  /** Subjects that were skipped because they are protected (preservation/never-modify). */
  skipped: { subject: string; reason: string }[];
}

export interface ImprovementInput {
  violations: Violation[];
  /** Subjects the Preservation Layer / risk engine marked off-limits. */
  protectedSubjects?: Set<string>;
}

/** Per-kind remediation: the conservative action + its effort + how to phrase it. */
const REMEDIATION: Record<ViolationKind, { action: ImprovementAction; effort: number; how: (v: Violation) => string }> = {
  'circular-dependency': {
    action: 'break-cycle',
    effort: 3,
    how: (v) => `extract the shared contract into a stable module so ${v.subject} no longer import each other`,
  },
  'god-module': {
    action: 'decompose',
    effort: 5,
    how: (v) => `split ${v.subject} into cohesive submodules by responsibility — one extraction at a time, behaviour-preserving`,
  },
  'unstable-dependency': {
    action: 'realign-dependency',
    effort: 2,
    how: (v) => `invert the ${v.subject} dependency: depend on an abstraction owned by the stable side`,
  },
  'missing-tests': {
    action: 'add-tests',
    effort: 1,
    how: (v) => `add behaviour tests for ${v.subject} (boundary + error cases) before any further change`,
  },
};

export function proposeImprovements(input: ImprovementInput): ImprovementReport {
  const protectedSubjects = input.protectedSubjects ?? new Set<string>();
  const proposals: Improvement[] = [];
  const skipped: { subject: string; reason: string }[] = [];

  for (const v of input.violations) {
    // A violation whose subject (or any module named in it) is protected is not
    // auto-proposed — preservation wins over generic remediation.
    const involved = v.subject.split(/ ↔ | → /);
    const protectedHit = involved.find((s) => protectedSubjects.has(s)) ?? (protectedSubjects.has(v.subject) ? v.subject : undefined);
    if (protectedHit !== undefined) {
      skipped.push({ subject: v.subject, reason: `${protectedHit} is preserved (intentional / never-modify)` });
      continue;
    }

    const r = REMEDIATION[v.kind];
    const roi = Math.round((v.impact / r.effort) * 10) / 10;
    proposals.push({
      action: r.action,
      subject: v.subject,
      recommendation: r.how(v),
      effort: r.effort,
      value: v.impact,
      roi,
    });
  }

  proposals.sort((a, b) => b.roi - a.roi || b.value - a.value || a.subject.localeCompare(b.subject));
  return { proposals, skipped };
}

const ACTION_LABEL: Record<ImprovementAction, string> = {
  'break-cycle': 'break-cycle     ',
  decompose: 'decompose       ',
  'realign-dependency': 'realign-dep     ',
  'add-tests': 'add-tests       ',
};

/** Human-readable improvement report for the TUI. */
export function formatImprovements(report: ImprovementReport, limit = 15): string {
  if (report.proposals.length === 0 && report.skipped.length === 0) {
    return 'improve: architecture is clean — no conservative improvements to propose';
  }
  const lines = [`conservative improvements (${report.proposals.length}, ranked by ROI):`];
  for (const p of report.proposals.slice(0, limit)) {
    lines.push(`  [ROI ${String(p.roi).padStart(4)}] ${ACTION_LABEL[p.action]} ${p.subject}`);
    lines.push(`              ${p.recommendation}  (value ${p.value}, effort ${p.effort})`);
  }
  if (report.proposals.length > limit) lines.push(`  … and ${report.proposals.length - limit} more`);
  if (report.skipped.length > 0) {
    lines.push('', `preserved (not auto-proposed) — ${report.skipped.length}:`);
    for (const s of report.skipped) lines.push(`  - ${s.subject}: ${s.reason}`);
  }
  return lines.join('\n');
}
