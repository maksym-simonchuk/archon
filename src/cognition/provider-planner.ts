import type { BlastRadius, PlanStep, Task } from '../core/types';
import type { ProviderRouter } from '../services/provider-router';
import type { CognitivePlan, PlanStrategy, StepAction, VerifierCheck } from './types';

interface RawStep {
  intent: string;
  action: { kind: 'write'; target: string; content: string };
}
interface RawPlan {
  rationale: string;
  steps: RawStep[];
  checks: VerifierCheck[];
}

const SCHEMA = `Respond with ONLY a JSON object (no prose, no markdown fences) of this exact shape:
{"rationale": string,
 "steps": [{"intent": string, "action": {"kind": "write", "target": "<repo-relative path>", "content": "<full file contents>"}}],
 "checks": [{"name": string, "argv": [string, ...]}]}
Rules: each step writes exactly one file; targets are repo-relative (never absolute, never "..");
"argv" runs with no shell, e.g. ["npm","run","typecheck"] or ["node","path/to/test.mjs"];
include at least one check that proves the work; keep steps minimal and individually reversible.`;

const radius = (file: string): BlastRadius => ({ files: [file], symbols: [], escapesRepo: false });

/**
 * LLM-backed planner: asks the ProviderRouter (task class `plan`) for a
 * structured JSON plan and converts it to a `CognitivePlan`. The model's output
 * is validated against the schema and rejected if malformed — the loop then
 * discards rather than acting on garbage. Crucially, a hostile/incompetent plan
 * is still harmless: every write/exec it proposes is gated by the Capability
 * Broker at execution time (repo containment, blast-radius, policy), so the
 * planner is untrusted by design.
 */
export class ProviderPlanner implements PlanStrategy {
  constructor(
    private readonly router: ProviderRouter,
    private readonly maxTokens = 4096,
  ) {}

  async propose(task: Task, context: string): Promise<CognitivePlan> {
    const prompt = `${SCHEMA}\n\n# Goal\n${task.goal}\n\n# Repository context\n${context || '(none provided)'}\n`;
    const completion = await this.router.complete({ taskClass: 'plan', prompt, maxTokens: this.maxTokens });
    const raw = parsePlan(completion.text);

    const steps: PlanStep[] = [];
    const actions: Record<string, StepAction> = {};
    raw.steps.forEach((s, i) => {
      const id = `${task.id}-s${i + 1}`;
      steps.push({
        id,
        intent: s.intent,
        capability: { action: 'fs.write', target: s.action.target, blastRadius: radius(s.action.target), reason: s.intent },
        reversible: true,
      });
      actions[id] = { kind: 'write', target: s.action.target, content: s.action.content };
    });

    return { plan: { taskId: task.id, rationale: raw.rationale, steps }, actions, checks: raw.checks };
  }
}

/** Pull a JSON object out of a completion that may be fenced or prose-wrapped. */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

function parsePlan(text: string): RawPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    throw new Error('[archon] planner: model did not return valid JSON');
  }
  if (!isRawPlan(parsed)) throw new Error('[archon] planner: JSON did not match the plan schema');
  return parsed;
}

function isRawPlan(v: unknown): v is RawPlan {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.rationale !== 'string' || !Array.isArray(o.steps) || !Array.isArray(o.checks)) return false;
  for (const s of o.steps) {
    if (typeof s !== 'object' || s === null) return false;
    const st = s as Record<string, unknown>;
    const a = st.action as Record<string, unknown> | undefined;
    if (typeof st.intent !== 'string') return false;
    if (!a || a.kind !== 'write' || typeof a.target !== 'string' || typeof a.content !== 'string') return false;
  }
  for (const c of o.checks) {
    if (typeof c !== 'object' || c === null) return false;
    const ck = c as Record<string, unknown>;
    if (typeof ck.name !== 'string' || !Array.isArray(ck.argv) || !ck.argv.every((x) => typeof x === 'string')) return false;
  }
  return true;
}
