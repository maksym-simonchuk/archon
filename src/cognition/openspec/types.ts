/**
 * OpenSpec — Archon's plan artifact format. We adopt the structure of
 * Fission-AI/OpenSpec (https://github.com/Fission-AI/OpenSpec) so plans are
 * portable across tools; see `docs/RUNTIME-V2.md` §4.5 and ADR-0013.
 *
 * A *change* is a directory under `openspec/changes/<change-id>/` with:
 *   - `proposal.md`  — Why / What / Why-Now narrative (mandatory)
 *   - `tasks.md`     — checkbox tasks (mandatory) → the Verifier success matrix
 *   - `design.md`    — only for non-trivial changes (optional)
 *   - `specs/<bounded-context>/spec.md` — delta operations on capability specs
 *
 * Each delta spec contains only `## ADDED Requirements`, `## MODIFIED
 * Requirements`, and/or `## REMOVED Requirements` sections, plus the
 * unchanged-on-archive content. Each Requirement is followed by at least one
 * `#### Scenario:` block. We validate the structure but stay deliberately
 * permissive on the prose — the format is a contract, not a straitjacket.
 *
 * Pure data types. No I/O lives here.
 */

/** A `## <KIND> Requirements` section inside a delta `spec.md`. */
export type DeltaKind = 'ADDED' | 'MODIFIED' | 'REMOVED';

/** A single scenario under a requirement — at least one is required. */
export interface SpecScenario {
  /** The scenario title as written (without the `#### Scenario:` prefix). */
  name: string;
  /** Raw body lines (kept verbatim so we can round-trip without lossy edits). */
  body: string[];
}

/** A `### Requirement: ...` block inside a delta section. */
export interface SpecRequirement {
  name: string;
  body: string[];
  scenarios: SpecScenario[];
}

/** A parsed delta `spec.md` for one bounded context inside a change. */
export interface DeltaSpec {
  /** Bounded-context path the spec applies to (e.g. `auth`, `indexer`). */
  context: string;
  /** Sections present in this file, keyed by delta kind. */
  sections: Partial<Record<DeltaKind, SpecRequirement[]>>;
}

/** One checkbox task in `tasks.md`. */
export interface TaskItem {
  /** `false` = `[ ]`, `true` = `[x]` (case-insensitive). */
  done: boolean;
  /** Text after the checkbox, trimmed. */
  text: string;
}

/** The proposal narrative — Why / What / Why-Now. */
export interface ProposalDoc {
  why: string[];
  what: string[];
  whyNow: string[];
}

/** A complete change-folder model — what the Planner emits, what the Verifier reads. */
export interface OpenSpecChange {
  /** Change directory name (kebab-case, typically date-prefixed). */
  id: string;
  proposal: ProposalDoc;
  tasks: TaskItem[];
  /** Optional design narrative for non-trivial changes (gated by Risk). */
  design?: string[];
  /** Delta specs per bounded context (zero or more). */
  specs: DeltaSpec[];
}

/** A single validation problem — surfaced by `validateChange`. */
export interface ValidationIssue {
  /** Path-style locator inside the change (e.g. `proposal.md`, `specs/auth/spec.md`). */
  file: string;
  /** Human-readable explanation; one line. */
  message: string;
  severity: 'error' | 'warning';
}

/** The result of validating a parsed change. `ok` is true iff there are no errors. */
export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/**
 * A change emitted as a flat map of relative path → file contents. The caller
 * is responsible for writing these through the Capability Broker (per ADR-0003);
 * the emitter touches no `fs` itself. See `emit.ts`.
 */
export type ChangeFileMap = Record<string, string>;
