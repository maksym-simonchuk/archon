import type { CapabilityRequest, PolicyVerdict } from '../core/types';
import type { PolicyEngine } from './policy-engine';
import type { AuditLog } from './audit-log';
import { notImplemented } from '../core/result';

/**
 * The single mediator for ALL side effects (fs / exec / net / secret).
 * Agents hold zero ambient authority — every effect routes through here, is
 * checked by the PolicyEngine, and is recorded in the AuditLog. This is the
 * one module allowed to import `fs` / `child_process` in agent paths.
 * See ADR-0003.
 */
export class CapabilityBroker {
  constructor(_policy: PolicyEngine, _audit: AuditLog) {}

  /** Check policy and, if allowed, perform the guarded side effect. */
  async request(_req: CapabilityRequest): Promise<PolicyVerdict> {
    return notImplemented('CapabilityBroker.request', 'M3');
  }
}
