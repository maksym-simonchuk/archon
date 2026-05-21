// Shared domain types. The single source of truth referenced by every plane.

// ── Safety / capability model ────────────────────────────────────────────────
export type CapabilityAction =
  | 'fs.read'
  | 'fs.write'
  | 'fs.delete'
  | 'exec'
  | 'net'
  | 'secret.read';

export type Profile = 'safe' | 'trusted';
export type PolicyDecision = 'allow' | 'ask' | 'deny';

export interface CapabilityRequest {
  action: CapabilityAction;
  /** Path, command, host, or secret key the action targets. */
  target: string;
  /** Files/symbols transitively affected — computed from the symbol graph. */
  blastRadius?: BlastRadius;
  reason: string;
}

export interface BlastRadius {
  files: string[];
  symbols: string[];
  /** True if the effect can leave the repo working tree (e.g. push, network). */
  escapesRepo: boolean;
}

export interface PolicyVerdict {
  decision: PolicyDecision;
  /** Id of the matched rule in policy.yaml. */
  rule: string;
  message: string;
}

// ── Sensing / symbol graph ──────────────────────────────────────────────────
/** Symbol-graph edge relationship; direction is src → dst. */
export type EdgeKind = 'defines' | 'imports' | 'calls' | 'tests';

/** A symbol defined within a file (a node in the graph). */
export interface ParsedSymbol {
  /**
   * Repo-unique, fully-qualified symbol id (e.g. `src/auth/login.ts#handleLogin`),
   * NOT a bare local name — two files may both define `foo`. `parseSymbols` is
   * responsible for qualifying it using the source path. The symbol graph keys on
   * this id, so a collision here silently corrupts blast radius.
   */
  name: string;
  /** tree-sitter node kind: 'function' | 'class' | 'const' | … */
  kind: string;
}

/** A directed relationship between two symbols, by their qualified ids (src → dst). */
export interface ParsedEdge {
  src: string;
  dst: string;
  kind: EdgeKind;
}

/** `parseSymbols` output for one file — the JS↔WASM boundary payload (ADR-0011). */
export interface ParsedFile {
  symbols: ParsedSymbol[];
  edges: ParsedEdge[];
}

/** `hashFiles` output: a Merkle leaf hash for one file (ADR-0005). */
export interface FileHash {
  path: string;
  hash: string;
}

/** `rankRepoMap` input: the symbol graph as nodes + directed edges (ADR-0006). */
export interface RepoMapInput {
  nodes: string[];
  edges: { src: string; dst: string }[];
}

/** `rankRepoMap` output: a symbol id with its PageRank score (higher = more central). */
export interface RankedSymbol {
  id: string;
  score: number;
}

// ── Cognition ─────────────────────────────────────────────────────────────────
export interface Task {
  id: string;
  goal: string;
  profile: Profile;
  createdAt: string;
}

export interface Plan {
  taskId: string;
  steps: PlanStep[];
  rationale: string;
}

export interface PlanStep {
  id: string;
  intent: string;
  /** Capability the step will request — surfaced for pre-approval. */
  capability: CapabilityRequest;
  /** Every step is a smallest reversible unit (one commit). */
  reversible: true;
}

export interface StepResult {
  stepId: string;
  diff?: Diff;
  verdict: Verdict;
}

export interface Diff {
  files: string[];
  added: number;
  removed: number;
  patch: string;
}

export interface Verdict {
  passed: boolean;
  checks: { name: string; passed: boolean; output?: string }[];
}

// ── Providers ──────────────────────────────────────────────────────────────────
export type TaskClass = 'plan' | 'summarize' | 'reason' | 'diff' | 'embed';

export interface ModelSpec {
  id: string;
  provider: string;
  contextWindow: number;
  costPer1kInput: number;
  costPer1kOutput: number;
  strengths: TaskClass[];
}

export interface RouteRequest {
  taskClass: TaskClass;
  prompt: string;
  maxTokens: number;
}

export interface Completion {
  modelId: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  cached: boolean;
}

// ── Memory ──────────────────────────────────────────────────────────────────────
export type MemoryTier = 'episodic' | 'semantic' | 'procedural';

export interface MemoryRecord {
  id: string;
  tier: MemoryTier;
  /** Entity name or content-hash anchor the record is keyed to. */
  key: string;
  content: string;
  createdAt: string;
  /** Set once a human/heuristic confirmed promotion to a higher tier. */
  confirmed?: boolean;
}

// ── Journal / audit ───────────────────────────────────────────────────────────
export type JournalKind = 'plan' | 'step' | 'decision' | 'diff' | 'verdict' | 'cost';

export interface JournalEntry {
  seq: number;
  taskId: string;
  ts: string;
  kind: JournalKind;
  payload: unknown;
}
