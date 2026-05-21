import type { Verdict } from '../core/types';
import type { CapabilityBroker } from '../effecting/capability-broker';
import type { VerifierCheck } from './types';

/**
 * Runs the plan's verification checks (build / test / lint — argv, no shell) in
 * the task's worktree via the broker, returning a pass/fail verdict per check.
 * A task with no checks fails closed: "nothing verified" is not "verified", so a
 * plan that forgot to declare a check can never merge.
 */
export class Verifier {
  constructor(private readonly broker: CapabilityBroker) {}

  async verify(cwd: string, checks: VerifierCheck[]): Promise<Verdict> {
    const results: Verdict['checks'] = [];
    for (const check of checks) {
      const r = await this.broker.exec(check.argv, { cwd, reason: `verify: ${check.name}` });
      results.push({
        name: check.name,
        passed: r.ok,
        output: r.ok ? r.value.stdout.trim() : r.error.message,
      });
    }
    return { passed: checks.length > 0 && results.every((c) => c.passed), checks: results };
  }
}
