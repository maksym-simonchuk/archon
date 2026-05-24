/**
 * Approval cards (M32). Structured `ask` payload that flows through the event
 * bus when the broker decides a capability action is `ask`-rated. The TUI
 * renders a card; the user decides; the decision flows back as a resolve.
 *
 * The broker itself stays the gate — the card is a UX layer over the
 * existing `ask` mechanism, not a new authority path.
 */

import type { CapabilityAction } from '../core/types';
import type { EventBus } from '../services/event-bus';

export interface ApprovalRequest {
  runId: string;
  /** Stable id used to correlate request ↔ resolve. */
  approvalId: string;
  capability: CapabilityAction;
  /** Target the broker would act on (path / command summary). */
  target: string;
  /** Number of files in the action's blast radius (from M13 graph stamp). */
  blastRadius: number;
  /** Human reason the broker computed `ask` rather than `allow`. */
  reason: string;
  /** Optional preview (diff text, command line) to render in the card. */
  preview?: string;
  /** Suggested default — UI may auto-select but always require confirm. */
  suggestion?: 'allow' | 'deny';
}

export type ApprovalDecision = 'allow' | 'deny';

/**
 * In-memory broker for approval requests. Publishes `approval.request` on the
 * bus and exposes `resolve(approvalId, decision)`. `await request(...)` blocks
 * until a matching `resolve` is called.
 */
export class ApprovalBroker {
  private pending = new Map<string, (d: ApprovalDecision) => void>();

  constructor(private readonly bus: EventBus) {}

  /** Block until the user resolves the request; null = caller cancelled. */
  request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const id = req.approvalId;
      this.pending.set(id, resolve);
      if (signal) {
        const onAbort = () => {
          if (this.pending.delete(id)) resolve('deny');
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.bus.publish({
        kind: 'approval.request',
        runId: req.runId,
        at: Date.now(),
        approvalId: id,
        capability: req.capability,
        target: req.target,
        blastRadius: req.blastRadius,
        ...(req.reason ? { reason: req.reason } : {}),
        ...(req.preview ? { preview: req.preview } : {}),
      });
    });
  }

  /** Called by the UI when the user decides. */
  resolve(approvalId: string, decision: ApprovalDecision, runId: string): boolean {
    const cb = this.pending.get(approvalId);
    if (!cb) return false;
    this.pending.delete(approvalId);
    this.bus.publish({ kind: 'approval.resolve', runId, at: Date.now(), approvalId, decision });
    cb(decision);
    return true;
  }

  /** Inspect every pending request without resolving — for the TUI to render the queue. */
  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  /** Outstanding approval count — useful for shutdown checks. */
  get pendingCount(): number {
    return this.pending.size;
  }
}

/** Stable approval id factory. Crypto-random; safe to use as a correlation key. */
export const newApprovalId = (): string => `apv_${crypto.randomUUID()}`;
