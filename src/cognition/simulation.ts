import type { ChangeKind, PreservationVerdict } from './preservation';
import type { FileRisk } from './risk';

/**
 * Execution Simulation Engine (M20): predict the consequences of a proposed
 * change BEFORE it is applied — the pre-apply complement to the worktree
 * verifier's post-hoc check ("No dangerous change is applied blindly"). It
 * composes the advisory primitives the earlier planes already produce — M9
 * boundary cycles, M13 risk/confidence, M14 preservation, M15 churn, and the
 * symbol graph's reverse-reachability — into one prediction: dependency
 * propagation, the type-system + API-contract drift surface, architecture-
 * boundary state, a regression-probability estimate, and an autonomy verdict.
 *
 * Pure and advisory: like risk/preservation it does NOT touch the Policy Engine.
 * The recommendation (`auto` | `review` | `block`) is what the cognition loop or
 * an operator consults before a worktree write; turning it into a hard pre-apply
 * gate is a separate, safety-reviewed step (the M20→loop wire, tracked alongside
 * the deferred M13/M14 gating). The command assembles the inputs from the index;
 * this module only reasons over them, so it is fully testable in isolation.
 */

/** Advisory autonomy level for the proposed change — never a hard gate here. */
export type SimRecommendation = 'auto' | 'review' | 'block';

export interface RegressionEstimate {
  /** 0–1 likelihood an applied change introduces an uncaught downstream defect. */
  probability: number;
  /** Structural likelihood a change here propagates a defect (reach + criticality + volatility). */
  hazard: number;
  /** Likelihood a regression escapes the tests (1 − module test confidence). */
  exposure: number;
  /** The normalized 0–1 components behind `hazard`, for an auditable rationale. */
  factors: { reach: number; criticality: number; volatility: number };
}

export interface SimulationReport {
  target: string;
  change: ChangeKind;
  module: string;
  /** Dependency propagation: distinct downstream symbols / files / modules affected. */
  propagation: { dependents: number; files: number; modules: number };
  /** Type-system impact surface — downstream files that import the changed symbols. */
  typeImpact: string[];
  /** API-contract drift: other modules that depend on the changed file's public surface. */
  contractDrift: { drifts: boolean; modules: string[] };
  /** Architecture-boundary state: does the target's module sit in a dependency cycle? */
  boundary: { inCycle: boolean; cycle: string[] };
  /** Reused M13 risk classification for the target. */
  risk: FileRisk;
  /** Reused M14 preservation verdict for the proposed change. */
  preservation: PreservationVerdict;
  regression: RegressionEstimate;
  recommendation: SimRecommendation;
  /** Human-readable reasons — names the exact signal so the prediction is auditable. */
  rationale: string[];
}

export interface SimulationInput {
  target: string;
  change: ChangeKind;
  moduleName: string;
  risk: FileRisk;
  preservation: PreservationVerdict;
  /** Distinct downstream symbols that depend on the target (excl. the change seeds). */
  dependents: number;
  /** Downstream files importing the changed symbols (excl. the target itself). */
  impactedFiles: string[];
  /** Distinct modules of `impactedFiles`, excl. the target's module — the contract surface. */
  dependentModules: string[];
  /** The target module participates in a dependency cycle (M9). */
  inCycle: boolean;
  cycle: string[];
  /** Module test-coverage 0–1 (M13 confidence) — drives regression exposure. */
  confidence: number;
  /** Commits touching the target's module in the analyzed window (M15 churn). */
  moduleChurn: number;
  /** Churn normalization reference (≈ mean churn of touched modules), ≥ 1. */
  churnRef: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const round2 = (x: number): number => Math.round(x * 100) / 100;
const pct = (x: number): string => `${Math.round(x * 100)}%`;

// Reference points at which a signal is treated as maxed — aligned with risk.ts
// thresholds (BLAST_LARGE / CRIT_HIGH) so simulation and `risk` agree on "a lot".
const REACH_REF = 15;
const CRIT_REF = 5;
/** Regression probability at/above which the change escalates to review. */
const REGRESSION_REVIEW = 0.6;

function estimateRegression(input: SimulationInput): RegressionEstimate {
  const reach = clamp01(input.dependents / REACH_REF);
  const criticality = clamp01(input.risk.criticality / CRIT_REF);
  const volatility = clamp01(input.moduleChurn / Math.max(1, input.churnRef));
  // Structural propagation hazard — weighted toward reach (what is directly at risk).
  const hazard = clamp01(0.45 * reach + 0.3 * criticality + 0.25 * volatility);
  const exposure = clamp01(1 - input.confidence);
  // A regression can occur even with full coverage (a floor of 0.35·hazard);
  // weak coverage scales it up toward the full structural hazard.
  const probability = hazard * (0.35 + 0.65 * exposure);
  return {
    probability: round2(probability),
    hazard: round2(hazard),
    exposure: round2(exposure),
    factors: { reach: round2(reach), criticality: round2(criticality), volatility: round2(volatility) },
  };
}

export function simulateExecution(input: SimulationInput): SimulationReport {
  const { target, change, moduleName, risk, preservation, impactedFiles, dependentModules, inCycle, cycle } = input;
  const regression = estimateRegression(input);
  const drifts = dependentModules.length > 0;
  const rationale: string[] = [];

  rationale.push(
    input.dependents === 0
      ? 'no downstream dependents — change is locally contained'
      : `${input.dependents} downstream symbol(s) across ${impactedFiles.length} file(s) depend on this`,
  );
  if (drifts) {
    const shown = dependentModules.slice(0, 4).join(', ');
    rationale.push(
      `API-contract drift risk: ${dependentModules.length} other module(s) depend on this file's surface (${shown}${dependentModules.length > 4 ? '…' : ''})`,
    );
  }
  if (inCycle) {
    rationale.push(`architecture boundary: module \`${moduleName}\` is in a dependency cycle (${cycle.join(' → ')}) — change can ripple circularly`);
  }
  rationale.push(`regression probability ${pct(regression.probability)} (hazard ${pct(regression.hazard)} × exposure ${pct(regression.exposure)})`);

  // Recommendation — advisory autonomy scaling (the vision's "autonomy scales with risk").
  let recommendation: SimRecommendation;
  if (risk.neverModify || preservation.disposition === 'preserve') {
    recommendation = 'block';
    rationale.push(
      risk.neverModify
        ? 'never-modify zone — requires explicit human authorization'
        : 'preservation layer ruled PRESERVE — change would erase intentional/critical structure',
    );
  } else {
    const reasons = [
      risk.level === 'critical' || risk.level === 'high' ? `${risk.level} risk` : '',
      regression.probability >= REGRESSION_REVIEW ? 'high regression probability' : '',
      preservation.disposition === 'caution' ? 'preservation caution' : '',
      inCycle ? 'cyclic boundary' : '',
    ].filter(Boolean);
    if (reasons.length > 0) {
      recommendation = 'review';
      rationale.push(`escalate to review — ${reasons.join(', ')}`);
    } else {
      recommendation = 'auto';
      rationale.push('low predicted impact — safe to proceed autonomously');
    }
  }

  return {
    target,
    change,
    module: moduleName,
    propagation: { dependents: input.dependents, files: impactedFiles.length, modules: dependentModules.length },
    typeImpact: impactedFiles,
    contractDrift: { drifts, modules: dependentModules },
    boundary: { inCycle, cycle },
    risk,
    preservation,
    regression,
    recommendation,
    rationale,
  };
}

const REC_LABEL: Record<SimRecommendation, string> = { auto: 'AUTO', review: 'REVIEW', block: 'BLOCK' };

/** Human-readable simulation report for the TUI. */
export function formatSimulation(r: SimulationReport): string {
  const lines = [
    `simulate: ${r.target}  (proposed: ${r.change})  →  ${REC_LABEL[r.recommendation]}`,
    `  module ${r.module} · risk ${r.risk.level.toUpperCase()}${r.risk.neverModify ? ' (never-modify)' : ''} · preservation ${r.preservation.disposition}`,
    `  propagation: ${r.propagation.dependents} dependents · ${r.propagation.files} files · ${r.propagation.modules} modules`,
    `  regression probability: ${pct(r.regression.probability)}  (hazard ${pct(r.regression.hazard)}, exposure ${pct(r.regression.exposure)})`,
  ];
  if (r.contractDrift.drifts) lines.push(`  API-contract drift: ${r.contractDrift.modules.join(', ')}`);
  if (r.boundary.inCycle) lines.push(`  ⚠ dependency cycle: ${r.boundary.cycle.join(' → ')} → ${r.boundary.cycle[0]}`);
  if (r.typeImpact.length > 0) {
    lines.push('  type-system impact (downstream files):');
    for (const f of r.typeImpact.slice(0, 8)) lines.push(`    - ${f}`);
    if (r.typeImpact.length > 8) lines.push(`    … +${r.typeImpact.length - 8} more`);
  }
  lines.push('  why:');
  for (const x of r.rationale) lines.push(`    - ${x}`);
  return lines.join('\n');
}
