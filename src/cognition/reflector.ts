import type { StepResult, Task } from '../core/types';
import type { MemoryStore } from '../memory/store';

/**
 * Writes the outcome of a task run to episodic memory (ADR-0008). Episodes are
 * written unconfirmed — promotion to a higher tier is human-gated (the
 * PromotionEngine), so a single run never auto-mutates long-term behavior.
 */
export class Reflector {
  constructor(private readonly memory: MemoryStore) {}

  async reflect(task: Task, results: StepResult[]): Promise<void> {
    const passed = results.every((r) => r.verdict.passed);
    this.memory.write({
      id: `episode:${task.id}`,
      tier: 'episodic',
      key: task.goal,
      content: JSON.stringify({
        goal: task.goal,
        passed,
        steps: results.map((r) => ({ step: r.stepId, passed: r.verdict.passed })),
      }),
      createdAt: new Date().toISOString(),
    });
  }
}
