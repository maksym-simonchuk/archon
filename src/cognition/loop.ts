import type { StepResult, Task } from '../core/types';
import type { Planner } from './planner';
import type { Executor } from './executor';
import type { Verifier } from './verifier';
import type { Reflector } from './reflector';
import { notImplemented } from '../core/result';

/**
 * The load-bearing primitive: plan -> act -> verify -> reflect, one smallest
 * reversible increment at a time. Resumable via the Task Journal. See ADR-0002.
 */
export class CognitionLoop {
  constructor(
    _planner: Planner,
    _executor: Executor,
    _verifier: Verifier,
    _reflector: Reflector,
  ) {}

  async run(_task: Task): Promise<StepResult[]> {
    return notImplemented('CognitionLoop.run', 'M6');
  }
}
