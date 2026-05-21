import { z } from 'zod';
import type { BlastRadius, PlanStep, Task } from '../core/types';
import type { ProviderRouter } from '../services/provider-router';
import type { CognitivePlan, PlanStrategy, StepAction } from './types';

/**
 * The plan the model must produce. The provider is asked to emit JSON matching
 * this schema (via the AI SDK's structured output) and the SDK validates it
 * before we ever see it — so the planner never parses prose or strips markdown
 * fences. A schema violation rejects at the provider boundary; the loop then
 * discards rather than acting on garbage.
 */
const planSchema = z.object({
  rationale: z.string(),
  steps: z.array(
    z.object({
      intent: z.string(),
      action: z.object({
        kind: z.literal('write'),
        target: z.string(),
        content: z.string(),
      }),
    }),
  ),
  checks: z.array(z.object({ name: z.string(), argv: z.array(z.string()) })),
});

type RawPlan = z.infer<typeof planSchema>;

const INSTRUCTIONS = `You are Archon's planner. Produce a minimal, reversible plan to accomplish the goal.
Rules: each step writes exactly one file; targets are repo-relative (never absolute, never "..");
"argv" runs with no shell, e.g. ["npm","run","typecheck"] or ["node","path/to/test.mjs"];
include at least one check that proves the work; keep steps minimal and individually reversible.`;

const radius = (file: string): BlastRadius => ({ files: [file], symbols: [], escapesRepo: false });

/**
 * LLM-backed planner: asks the ProviderRouter (task class `plan`) for a
 * schema-validated plan and converts it to a `CognitivePlan`. Crucially, a
 * hostile/incompetent plan is still harmless: every write/exec it proposes is
 * gated by the Capability Broker at execution time (repo containment,
 * blast-radius, policy), so the planner is untrusted by design.
 */
export class ProviderPlanner implements PlanStrategy {
  constructor(
    private readonly router: ProviderRouter,
    private readonly maxTokens = 4096,
  ) {}

  async propose(task: Task, context: string): Promise<CognitivePlan> {
    const prompt = `${INSTRUCTIONS}\n\n# Goal\n${task.goal}\n\n# Repository context\n${context || '(none provided)'}\n`;
    const { object: raw } = await this.router.completeObject<RawPlan>(
      { taskClass: 'plan', prompt, maxTokens: this.maxTokens },
      planSchema,
    );

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
