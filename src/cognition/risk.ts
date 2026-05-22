import type { ModuleNode } from '../sensing/boundaries';

/**
 * Risk + confidence primitives (M13, read-only slice). Scores how dangerous a
 * change to a given file is, from signals already in the index: its blast radius
 * (reverse reachability), its module's criticality (fan-in) and confidence (test
 * coverage), plus a coarse region classification and a never-modify flag.
 *
 * Pure and advisory: this slice does NOT touch the Policy Engine — it computes a
 * level the operator can inspect via `archon risk <file>`. Wiring risk into the
 * gating path (escalate critical-region writes to `ask`) is the deferred M13
 * follow-up, kept separate so the safety path changes under its own review.
 */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Coarse change-tolerance of a region, derived from its module topology. */
export type Region = 'stable' | 'evolving' | 'experimental';

export interface FileRisk {
  file: string;
  module: string;
  level: RiskLevel;
  region: Region;
  /** A change here is structurally forbidden (sensitive zone) — always escalates. */
  neverModify: boolean;
  /** Distinct downstream symbols that depend on this file (transitive). */
  blastRadius: number;
  /** Module criticality — how many other modules depend on it (fan-in). */
  criticality: number;
  /** Module confidence 0–1 — share of its code-defining files that have tests. */
  confidence: number;
  /** Human-readable reasons the level was assigned. */
  rationale: string[];
}

export interface RiskInput {
  file: string;
  /** The file's module node (criticality + role), or undefined if unknown. */
  module: ModuleNode | undefined;
  blastRadius: number;
  confidence: number;
}

/** Path segments that mark a structurally sensitive (never-modify) zone. */
const NEVER_MODIFY_SEGMENTS = ['auth', 'payment', 'payments', 'billing', 'secrets', 'infra'];

// Thresholds are absolute and explainable rather than tuned weights, so the
// rationale can name exactly which signal pushed a file up a level.
const BLAST_LARGE = 15;
const BLAST_MODERATE = 5;
const CRIT_HIGH = 5;
const CRIT_MODERATE = 2;
const CONF_LOW = 0.34;
const CONF_MODERATE = 0.67;

export function scoreRisk(input: RiskInput): FileRisk {
  const { file, module, blastRadius, confidence } = input;
  const criticality = module?.fanIn ?? 0;
  const rationale: string[] = [];
  let points = 0;

  if (blastRadius >= BLAST_LARGE) {
    points += 2;
    rationale.push(`large blast radius (${blastRadius} dependents)`);
  } else if (blastRadius >= BLAST_MODERATE) {
    points += 1;
    rationale.push(`moderate blast radius (${blastRadius} dependents)`);
  }

  if (criticality >= CRIT_HIGH) {
    points += 2;
    rationale.push(`high criticality (${criticality} modules depend on it)`);
  } else if (criticality >= CRIT_MODERATE) {
    points += 1;
    rationale.push(`moderate criticality (${criticality} modules depend on it)`);
  }

  if (confidence < CONF_LOW) {
    points += 2;
    rationale.push(`low confidence (${pct(confidence)} test coverage)`);
  } else if (confidence < CONF_MODERATE) {
    points += 1;
    rationale.push(`partial confidence (${pct(confidence)} test coverage)`);
  }

  const neverModify = NEVER_MODIFY_SEGMENTS.some((seg) => file.split('/').includes(seg));
  if (neverModify) rationale.push('sensitive (never-modify) zone');

  const level: RiskLevel = neverModify
    ? 'critical'
    : points >= 4
      ? 'critical'
      : points >= 3
        ? 'high'
        : points >= 1
          ? 'medium'
          : 'low';
  if (rationale.length === 0) rationale.push('isolated, well-covered, low coupling');

  return {
    file,
    module: module?.name ?? '(unknown)',
    level,
    region: classifyRegion(module),
    neverModify,
    blastRadius,
    criticality,
    confidence,
    rationale,
  };
}

/** Region from the module's role: stable core, experimental islands, evolving in between. */
export function classifyRegion(module: ModuleNode | undefined): Region {
  if (module === undefined || module.role === 'isolated') return 'experimental';
  if (module.role === 'core') return 'stable';
  return 'evolving';
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

const LEVEL_LABEL: Record<RiskLevel, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
};

/** Human-readable risk report for the TUI. */
export function formatRisk(risk: FileRisk): string {
  const lines = [
    `risk: ${risk.file}  →  ${LEVEL_LABEL[risk.level]}${risk.neverModify ? ' (never-modify)' : ''}`,
    `  module ${risk.module} · region ${risk.region}`,
    `  blast radius ${risk.blastRadius} · criticality ${risk.criticality} · confidence ${pct(risk.confidence)}`,
    '  why:',
  ];
  for (const r of risk.rationale) lines.push(`    - ${r}`);
  return lines.join('\n');
}
