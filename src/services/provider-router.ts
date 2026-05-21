import type { Completion, ModelSpec, RouteRequest } from '../core/types';
import { notImplemented } from '../core/result';

/**
 * Picks a model by task class (cheap for plan/summarize, strong for reason/diff),
 * with an exact/prefix prompt cache, a static fallback chain on error/rate-limit,
 * and a budget circuit-breaker. Starts with two providers. See ADR-0007.
 */
export class ProviderRouter {
  constructor(_registry: ModelSpec[]) {}

  async complete(_req: RouteRequest): Promise<Completion> {
    return notImplemented('ProviderRouter.complete', 'M7');
  }
}
