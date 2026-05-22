import type { AgentSpec } from './agent-factory';

/**
 * Agent runtime (M18 binding): turns the generated AgentSpec *declarations* (see
 * agent-factory) into something that actually drives a task. Two bindings:
 *
 *  - spec → prompt: `agentBriefing` renders the agent's mandate (purpose, scope,
 *    capability ceiling, rules) as a planner preamble, so an LLM planner produces
 *    a plan within the agent's constraints.
 *  - spec → authority: `selectAgent` picks the agent whose scope/triggers best fit
 *    a goal; the loop then runs under a broker scoped to `spec.capabilities` (see
 *    `AgentBroker`), so the agent can never request more than it declared.
 *
 * This module is pure (selection + briefing); the authority half lives in the
 * broker + runtime. Kept self-contained — a small inlined tokenizer rather than a
 * sensing import, so cognition stays free of a runtime edge into sensing.
 */

// Goal words too generic to discriminate between agents — dropped before scoring.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'add', 'fix',
  'use', 'make', 'new', 'set', 'get', 'all', 'any', 'change', 'update', 'should',
]);

/** Distinct, lowercased, ≥3-char non-stopword tokens of a goal. */
export function goalTerms(goal: string): Set<string> {
  return new Set(
    goal
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

/**
 * Score how well an agent fits a goal. Signals, most specific first: the agent's
 * id words (e.g. `routing`, `state`, `api`), its trigger frameworks, the basenames
 * of its scoped modules, then a single point per rule whose vocabulary the goal
 * touches. Higher is a better fit; 0 means nothing matched.
 */
export function scoreAgentFit(spec: AgentSpec, terms: ReadonlySet<string>): number {
  let score = 0;
  for (const w of spec.id.split('-')) if (w !== 'agent' && terms.has(w)) score += 2;
  for (const t of spec.triggeredBy) {
    const k = t.toLowerCase();
    if (terms.has(k) || [...terms].some((g) => k.includes(g) || g.includes(k))) score += 3;
  }
  for (const m of spec.scope) {
    if (m === '*') continue;
    const base = m.toLowerCase().split('/').pop();
    if (base && terms.has(base)) score += 2;
  }
  for (const r of spec.rules) {
    if (r.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length >= 4 && terms.has(w))) score += 1;
  }
  return score;
}

/**
 * Pick the agent that best fits a goal. Ties keep the earlier (more specific
 * framework/structural) agent, since the roster is order-stable. When nothing
 * matches, fall back to the always-present, read-only `architecture-review-agent`
 * — a safe default that can plan but (being read-only) never writes blindly.
 * Returns undefined only for an empty roster.
 */
export function selectAgent(agents: readonly AgentSpec[], goal: string): AgentSpec | undefined {
  if (agents.length === 0) return undefined;
  const terms = goalTerms(goal);
  let best: AgentSpec | undefined;
  let bestScore = -1;
  for (const a of agents) {
    const s = scoreAgentFit(a, terms);
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  if (bestScore <= 0) return agents.find((a) => a.id === 'architecture-review-agent') ?? agents[0];
  return best;
}

/** Render an agent's mandate as a planner preamble — the spec→prompt binding. */
export function agentBriefing(spec: AgentSpec): string {
  const scope = spec.scope.includes('*') ? 'the whole repository' : spec.scope.join(', ');
  return [
    `# Active agent: ${spec.id}`,
    spec.purpose,
    `Scope: ${scope}. Do not act outside it.`,
    `Granted capabilities: ${spec.capabilities.join(', ')}. Escalate to a human when risk ≥ ${spec.escalateAtRisk}.`,
    'Enforce these rules in your plan:',
    ...spec.rules.map((r) => `- ${r}`),
  ].join('\n');
}
