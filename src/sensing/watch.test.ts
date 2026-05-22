import { describe, expect, it } from 'vitest';
import { changedSince, formatWatchTick } from './watch';

describe('changedSince', () => {
  it('reports a path that became dirty', () => {
    const d = changedSince(new Set(), ['a.ts']);
    expect(d.entered).toEqual(['a.ts']);
    expect(d.left).toEqual([]);
    expect(d.quiet).toBe(false);
    expect([...d.current]).toEqual(['a.ts']);
  });

  it('reports a path that was cleaned (committed / reverted)', () => {
    const d = changedSince(new Set(['a.ts', 'b.ts']), ['a.ts']);
    expect(d.entered).toEqual([]);
    expect(d.left).toEqual(['b.ts']);
    expect(d.quiet).toBe(false);
  });

  it('is quiet when the dirty set is unchanged', () => {
    const d = changedSince(new Set(['a.ts']), ['a.ts']);
    expect(d.quiet).toBe(true);
    expect(d.entered).toEqual([]);
    expect(d.left).toEqual([]);
  });

  it('reports entries and exits together, sorted', () => {
    const d = changedSince(new Set(['z.ts', 'b.ts']), ['b.ts', 'a.ts']);
    expect(d.entered).toEqual(['a.ts']);
    expect(d.left).toEqual(['z.ts']);
  });

  it('dedupes the current set from a list with repeats', () => {
    const d = changedSince(new Set(), ['a.ts', 'a.ts']);
    expect(d.current.size).toBe(1);
    expect(d.entered).toEqual(['a.ts']);
  });
});

describe('formatWatchTick', () => {
  it('summarises changed and cleared counts with health', () => {
    const d = changedSince(new Set(['x.ts']), ['a.ts', 'b.ts']);
    expect(formatWatchTick(d, 87)).toBe('watch: ~2 changed · ✓1 cleared · 2 dirty · health 87');
  });

  it('says "no changes" when nothing entered or left', () => {
    const d = changedSince(new Set(['a.ts']), ['a.ts']);
    expect(formatWatchTick(d, 100)).toBe('watch: no changes · 1 dirty · health 100');
  });
});
