import type { CapabilityAction, CapabilityRequest, PolicyVerdict } from '../core/types';
import type { AuditLog } from './audit-log';
import { CapabilityBroker } from './capability-broker';
import type { PolicyEngine, PolicyEvalContext } from './policy-engine';

/**
 * A CapabilityBroker scoped to one agent's declared capabilities (M18). It can
 * ONLY narrow authority: any action outside the agent's allowlist is denied
 * (`agent.capability_denied`) before the PolicyEngine is even consulted, and the
 * denial is recorded in the audit log; allowed actions fall through to the real
 * broker unchanged and are still subject to the full policy. So an agent can never
 * request more than its spec declares — the same "tighten, never widen" rule the
 * verifier/provider plugins follow (ADR-0003).
 *
 * It overrides `request`, the single gate every guarded effect (`fsWrite`,
 * `fsRead`, `exec`) funnels through, so the scope holds for all of them at once.
 * A read-only agent's executor therefore plans freely but cannot reach disk: its
 * write is denied here, the step fails, and the worktree transaction discards.
 */
export class AgentBroker extends CapabilityBroker {
  private readonly allowed: ReadonlySet<CapabilityAction>;

  constructor(
    policy: PolicyEngine,
    audit: AuditLog,
    repoRoot: string,
    allowed: Iterable<CapabilityAction>,
  ) {
    super(policy, audit, repoRoot);
    this.allowed = new Set(allowed);
  }

  override async request(req: CapabilityRequest, ctx: PolicyEvalContext = {}): Promise<PolicyVerdict> {
    if (!this.allowed.has(req.action)) {
      const verdict: PolicyVerdict = {
        decision: 'deny',
        rule: 'agent.capability_denied',
        message: `agent is not granted capability "${req.action}"`,
      };
      this.record(req, verdict, ctx.taskId);
      return verdict;
    }
    return super.request(req, ctx);
  }
}
