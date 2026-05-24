import { describe, expect, it } from 'vitest';
import { createEventBus, type ArchonEvent } from '../services/event-bus';
import { ApprovalBroker, newApprovalId } from './approval';

describe('ApprovalBroker', () => {
  it('publishes approval.request on the bus and resolves with the user decision', async () => {
    const bus = createEventBus();
    const broker = new ApprovalBroker(bus);
    const id = newApprovalId();
    const events: ArchonEvent[] = [];
    const iter = bus.subscribe()[Symbol.asyncIterator]();
    (async () => {
      while (true) {
        const next = await iter.next();
        if (next.done) break;
        events.push(next.value);
        if (next.value.kind === 'approval.resolve') {
          await iter.return?.();
          break;
        }
      }
    })();
    const pending = broker.request({
      runId: 'r1',
      approvalId: id,
      capability: 'fs.write',
      target: 'src/x.ts',
      blastRadius: 7,
      reason: 'blast radius exceeds 5',
    });
    // Wait a tick for the request to publish.
    await new Promise((r) => setTimeout(r, 5));
    expect(broker.pendingCount).toBe(1);
    const ok = broker.resolve(id, 'allow', 'r1');
    expect(ok).toBe(true);
    const decision = await pending;
    expect(decision).toBe('allow');
    expect(broker.pendingCount).toBe(0);
  });

  it('resolves to deny on AbortSignal', async () => {
    const bus = createEventBus();
    const broker = new ApprovalBroker(bus);
    const controller = new AbortController();
    const id = newApprovalId();
    const pending = broker.request(
      { runId: 'r2', approvalId: id, capability: 'fs.write', target: 'x', blastRadius: 1, reason: 'r' },
      controller.signal,
    );
    controller.abort();
    expect(await pending).toBe('deny');
  });

  it('resolve(unknownId) returns false', () => {
    const bus = createEventBus();
    const broker = new ApprovalBroker(bus);
    expect(broker.resolve('bogus', 'allow', 'r')).toBe(false);
  });
});
