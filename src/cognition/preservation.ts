import type { ModuleNode } from '../sensing/boundaries';
import type { PhilosophyProfile } from '../sensing/philosophy';
import type { FileRisk } from './risk';

/**
 * Preservation Layer (M14): the gate that distinguishes *intentional* complexity
 * from *accidental* complexity, and *business-critical* abstractions from
 * incidental ones — so the runtime improves a repo without erasing its identity.
 *
 * Pure and advisory: it does NOT mutate the Policy Engine. It takes the signals
 * the earlier planes already produce (M9 module topology, M11 philosophy, M13
 * risk/region) plus the kind of change being proposed, and returns a disposition
 * — `preserve` (block a generic rewrite of an intentional structure), `caution`
 * (proceed only with explicit intent), or `allow` (genuine accidental complexity,
 * improvement welcome). The Improvement engine (M21) consults it before ever
 * proposing a refactor; the cognition loop can consult it before a write.
 */

/** What the proposed change would do to the target — the axis preservation cares about. */
export type ChangeKind = 'modify' | 'simplify' | 'remove-abstraction' | 'rewrite' | 'extract';

/** Whether the target's complexity looks deliberate or like debt. */
export type ComplexityClass = 'intentional' | 'accidental' | 'unclear';
/** Whether the target's abstraction carries domain value or is incidental scaffolding. */
export type AbstractionValue = 'business-critical' | 'incidental' | 'unclear';
/** The gate's recommendation. */
export type Disposition = 'preserve' | 'caution' | 'allow';

export interface PreservationVerdict {
  disposition: Disposition;
  complexity: ComplexityClass;
  abstractionValue: AbstractionValue;
  /** Human-readable reasons — names the exact signal so the decision is auditable. */
  rationale: string[];
}

export interface PreservationInput {
  /** Repo-relative file/module the change targets. */
  target: string;
  /** The target module's topology node, or undefined if unknown. */
  module: ModuleNode | undefined;
  /** Risk + region classification for the target (M13). */
  risk: FileRisk;
  /** The project's engineering philosophy (M11) — the cultural baseline. */
  philosophy: PhilosophyProfile;
  /** What the proposed change would do. */
  change: ChangeKind;
  /** The target sits in a module the boundary model flagged as a god-module candidate. */
  isGodModule?: boolean;
}

/** Changes that strip structure — the ones that can erase intentional design. */
const STRUCTURE_STRIPPING: ReadonlySet<ChangeKind> = new Set<ChangeKind>(['simplify', 'remove-abstraction', 'rewrite']);

function classifyComplexity(input: PreservationInput): { complexity: ComplexityClass; reasons: string[] } {
  const { module, risk, philosophy, isGodModule } = input;
  const reasons: string[] = [];

  // A god module's complexity is accidental even if it is heavily depended on —
  // that is precisely the over-coupling preservation should NOT protect.
  if (isGodModule) {
    reasons.push('flagged god-module — its complexity is accidental (over-coupling), not intentional');
    return { complexity: 'accidental', reasons };
  }

  const stableCore = risk.region === 'stable' && (module?.role === 'core');
  const depended = risk.criticality >= 3;
  const cultureFavoursAbstraction = philosophy.abstractionTolerance === 'high';

  if (stableCore || depended) {
    reasons.push(
      stableCore
        ? 'stable core module — structure has settled and is depended upon'
        : `${risk.criticality} modules depend on it — structure carries load`,
    );
    if (cultureFavoursAbstraction) reasons.push('project tolerates high abstraction — indirection here is likely deliberate');
    return { complexity: 'intentional', reasons };
  }

  const experimentalIsland = risk.region === 'experimental' && risk.criticality === 0;
  if (experimentalIsland) {
    reasons.push('isolated experimental module — low criticality, structure not load-bearing');
    return { complexity: 'accidental', reasons };
  }

  return { complexity: 'unclear', reasons: ['mixed signals — neither clearly load-bearing nor isolated'] };
}

function classifyAbstraction(input: PreservationInput): AbstractionValue {
  if (input.risk.neverModify) return 'business-critical';
  if (input.isGodModule) return 'incidental';
  if (input.risk.criticality >= 3 && input.risk.region !== 'experimental') return 'business-critical';
  if (input.risk.region === 'experimental' && input.risk.criticality === 0) return 'incidental';
  return 'unclear';
}

export function assessPreservation(input: PreservationInput): PreservationVerdict {
  const { risk, change } = input;
  const { complexity, reasons } = classifyComplexity(input);
  const abstractionValue = classifyAbstraction(input);
  const rationale = [...reasons];

  // A never-modify zone is always preserved, regardless of the change kind.
  if (risk.neverModify) {
    rationale.push('never-modify zone (sensitive) — change requires explicit human authorisation');
    return { disposition: 'preserve', complexity, abstractionValue, rationale };
  }

  const strips = STRUCTURE_STRIPPING.has(change);

  // The core preservation rule: do NOT let a generic "simplify/de-abstract"
  // erase a structure that is intentional or business-critical.
  if (strips && (complexity === 'intentional' || abstractionValue === 'business-critical')) {
    rationale.push(
      `proposed \`${change}\` would strip an ${complexity === 'intentional' ? 'intentional' : 'business-critical'} structure — preserve unless intent is explicit`,
    );
    return { disposition: 'preserve', complexity, abstractionValue, rationale };
  }

  // Genuine accidental complexity / incidental abstraction → improvement welcome.
  if (complexity === 'accidental' && abstractionValue !== 'business-critical') {
    rationale.push('accidental complexity with no domain value — safe to refactor');
    return { disposition: 'allow', complexity, abstractionValue, rationale };
  }

  // Everything else proceeds, but only with explicit, scoped intent.
  rationale.push(
    strips
      ? 'unclear whether the structure is intentional — proceed only with explicit, scoped intent'
      : `\`${change}\` does not strip structure — low preservation risk`,
  );
  return { disposition: strips ? 'caution' : 'allow', complexity, abstractionValue, rationale };
}

const DISP_LABEL: Record<Disposition, string> = {
  preserve: 'PRESERVE',
  caution: 'CAUTION ',
  allow: 'ALLOW   ',
};

/** Human-readable preservation report for the TUI. */
export function formatPreservation(target: string, change: ChangeKind, v: PreservationVerdict): string {
  const lines = [
    `preservation: ${target}  (proposed: ${change})`,
    `  → ${DISP_LABEL[v.disposition].trim()}  ·  complexity ${v.complexity}  ·  abstraction ${v.abstractionValue}`,
    '  why:',
  ];
  for (const r of v.rationale) lines.push(`    - ${r}`);
  return lines.join('\n');
}
