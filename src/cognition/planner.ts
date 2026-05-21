import type { Plan, Task } from '../core/types';
import { notImplemented } from '../core/result';

/**
 * Decomposes a goal into a plan of smallest reversible steps — plan before act.
 * Consumes a pre-assembled, budgeted context string from the ContextService.
 */
export class Planner {
  async plan(_task: Task, _context: string): Promise<Plan> {
    return notImplemented('Planner.plan', 'M6');
  }
}
