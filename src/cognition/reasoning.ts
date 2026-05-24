/**
 * Reasoning visibility (M28). Three render modes:
 *   - off     — no reasoning surface
 *   - summary — one compressed line per phase (planner / executor / verifier / reflector)
 *   - trace   — the structured nodes the cognition planes already emit
 *
 * We never expose raw provider chain-of-thought. The "summary" mode is a
 * deterministic compress over our OWN structured trace nodes; no extra LLM
 * round-trip required for the default.
 */

export type ReasoningMode = 'off' | 'summary' | 'trace';

export interface ReasoningNode {
  /** Plane that emitted the node. */
  plane: 'planner' | 'executor' | 'verifier' | 'reflector' | 'workflow' | 'council';
  /** Short phase label (e.g. `analyse`, `propose`, `simulate`, `decide`). */
  phase: string;
  /** Single-line message; longer text goes into `detail` (truncated by summary). */
  message: string;
  detail?: string;
  /** Millisecond timestamp. */
  at: number;
}

export interface ReasoningRender {
  mode: ReasoningMode;
  /** Lines suitable for `TUI` rendering (or empty when `off`). */
  lines: string[];
}

/** Compose nodes into the user-visible render at the configured mode. */
export function renderReasoning(nodes: ReasoningNode[], mode: ReasoningMode): ReasoningRender {
  if (mode === 'off') return { mode, lines: [] };
  if (mode === 'trace') return { mode, lines: nodes.map((n) => formatTrace(n)) };
  // summary — one line per (plane, phase) group, keeping the last message.
  const seen = new Map<string, ReasoningNode>();
  for (const n of nodes) seen.set(`${n.plane}.${n.phase}`, n);
  return { mode, lines: [...seen.values()].map((n) => `${n.plane}/${n.phase}: ${truncate(n.message, 80)}`) };
}

const formatTrace = (n: ReasoningNode): string => {
  const head = `${n.plane}/${n.phase} @ ${new Date(n.at).toISOString().slice(11, 19)}`;
  const body = n.detail ? `${n.message}\n  ${n.detail.split('\n').join('\n  ')}` : n.message;
  return `${head}: ${body}`;
};

const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** Parse a free-form mode toggle (`/think off` / `/think summary` / `/think trace`). */
export function parseReasoningMode(input: string, fallback: ReasoningMode = 'off'): ReasoningMode {
  const v = input.trim().toLowerCase();
  if (v === 'off' || v === 'summary' || v === 'trace') return v;
  return fallback;
}
