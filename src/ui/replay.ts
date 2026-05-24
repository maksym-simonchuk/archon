/**
 * Session replay (M38). Reconstructs the live event stream from the Task
 * Journal so a finished run can be re-rendered offline. Replay is strictly
 * read-only (ADR-0015 invariant 10) — re-issuing broker calls is `run --resume`,
 * a separate path.
 */

import type { ArchonEvent, EventBus } from '../services/event-bus';

export interface ReplaySource {
  /** Yield events in journal order. Implementations: SQLite journal scan; fixture array. */
  events(runId: string): AsyncIterable<ArchonEvent>;
}

export interface ReplayOptions {
  /** Wall-clock pacing — multiplier on inter-event gaps. 0 = as fast as possible. */
  speed?: number;
  /** Stop after this many events (for slicing). */
  limit?: number;
}

/** Replay events from `source` for `runId` onto `bus`. Returns when exhausted. */
export async function replay(
  source: ReplaySource,
  runId: string,
  bus: EventBus,
  opts: ReplayOptions = {},
): Promise<{ count: number }> {
  const speed = opts.speed ?? 0;
  const limit = opts.limit ?? Infinity;
  let count = 0;
  let prevAt: number | undefined;
  for await (const e of source.events(runId)) {
    if (count >= limit) break;
    if (speed > 0 && prevAt !== undefined) {
      const gap = Math.max(0, e.at - prevAt) / speed;
      if (gap > 0) await new Promise((r) => setTimeout(r, Math.min(gap, 5000)));
    }
    bus.publish(e);
    prevAt = e.at;
    count++;
  }
  return { count };
}

/** In-memory replay source seeded with a fixed event list — handy for tests. */
export const fixtureSource = (events: ArchonEvent[]): ReplaySource => ({
  async *events(runId) {
    for (const e of events) if (e.runId === runId) yield e;
  },
});
