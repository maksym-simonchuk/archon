import { describe, expect, it } from 'vitest';
import { ChangeBatcher, isWatchable, type Schedule, type ScheduledTimer } from './fs-watcher';

describe('isWatchable', () => {
  it('accepts JS/TS source files', () => {
    for (const p of ['src/a.ts', 'src/b.tsx', 'lib/c.js', 'd.mjs', 'e.cts']) {
      expect(isWatchable(p)).toBe(true);
    }
  });

  it('rejects non-source files and type declarations', () => {
    for (const p of ['README.md', 'src/types.d.ts', 'data.json', 'style.css', 'noext']) {
      expect(isWatchable(p)).toBe(false);
    }
  });

  it('rejects anything under a noise directory', () => {
    for (const p of ['node_modules/x/index.ts', '.git/HEAD.ts', 'dist/a.js', '.archon/index.ts', 'pkg/build/y.ts']) {
      expect(isWatchable(p)).toBe(false);
    }
  });
});

/** A schedule whose pending callback fires only when the test calls `tick()`. */
function manualClock(): { schedule: Schedule; tick: () => void; armed: () => boolean } {
  let pending: (() => void) | undefined;
  const schedule: Schedule = (fn) => {
    pending = fn;
    const timer: ScheduledTimer = { cancel: () => { if (pending === fn) pending = undefined; } };
    return timer;
  };
  return {
    schedule,
    tick: () => {
      const fn = pending;
      pending = undefined;
      fn?.();
    },
    armed: () => pending !== undefined,
  };
}

describe('ChangeBatcher', () => {
  it('coalesces a burst of edits into one sorted, deduplicated batch', () => {
    const clock = manualClock();
    const batches: string[][] = [];
    const b = new ChangeBatcher({ debounceMs: 300, accept: isWatchable, schedule: clock.schedule, onFlush: (p) => batches.push(p) });

    b.push('src/b.ts');
    b.push('src/a.ts');
    b.push('src/b.ts'); // duplicate
    expect(batches).toEqual([]); // nothing emitted until the timer fires
    expect(b.size).toBe(2);

    clock.tick();
    expect(batches).toEqual([['src/a.ts', 'src/b.ts']]);
    expect(b.size).toBe(0);
  });

  it('drops events that fail the filter', () => {
    const clock = manualClock();
    const batches: string[][] = [];
    const b = new ChangeBatcher({ debounceMs: 300, accept: isWatchable, schedule: clock.schedule, onFlush: (p) => batches.push(p) });

    b.push('node_modules/x.ts');
    b.push('README.md');
    expect(b.size).toBe(0);
    expect(clock.armed()).toBe(false); // a rejected push never arms the timer
  });

  it('re-arms the timer on each push so only a quiet period flushes', () => {
    const clock = manualClock();
    const batches: string[][] = [];
    const b = new ChangeBatcher({ debounceMs: 300, accept: isWatchable, schedule: clock.schedule, onFlush: (p) => batches.push(p) });

    b.push('src/a.ts');
    b.push('src/b.ts'); // cancels the first timer, arms a new one
    clock.tick(); // only the latest timer fires → one batch with both
    expect(batches).toEqual([['src/a.ts', 'src/b.ts']]);
  });

  it('flush() emits immediately and is a no-op when empty', () => {
    const clock = manualClock();
    const batches: string[][] = [];
    const b = new ChangeBatcher({ debounceMs: 300, accept: isWatchable, schedule: clock.schedule, onFlush: (p) => batches.push(p) });

    b.flush(); // nothing pending
    expect(batches).toEqual([]);

    b.push('src/a.ts');
    b.flush(); // emit now, without waiting for the clock
    expect(batches).toEqual([['src/a.ts']]);
    expect(clock.armed()).toBe(false); // flush cancelled the pending timer
  });
});
