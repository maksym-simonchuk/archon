import type { CapabilityRequest, PolicyVerdict, Profile } from '../core/types';
import { notImplemented } from '../core/result';

/**
 * Evaluates (action, target, blastRadius) against the active profile's rules
 * from .archon/policy.yaml -> allow | ask | deny. Default-deny outside the repo.
 * See ADR-0003 / ADR-0010.
 */
export class PolicyEngine {
  constructor(_profile: Profile) {}

  evaluate(_req: CapabilityRequest): PolicyVerdict {
    return notImplemented('PolicyEngine.evaluate', 'M3');
  }
}
