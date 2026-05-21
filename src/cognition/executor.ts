import type { PlanStep, StepResult } from '../core/types';
import type { CapabilityBroker } from '../effecting/capability-broker';
import { notImplemented } from '../core/result';

/** Executes one plan step — every side effect goes through the broker. */
export class Executor {
  constructor(_broker: CapabilityBroker) {}

  async run(_step: PlanStep): Promise<StepResult> {
    return notImplemented('Executor.run', 'M6');
  }
}
