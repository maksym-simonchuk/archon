import { describe, expect, it } from 'vitest';

import {
  applyUnified,
  buildPatchSet,
  diffStrings,
  listHunks,
  parseUnified,
  renderUnified,
  resolvePatchSet,
  setHunkAccepted,
} from './index';

describe('unified diff', () => {
  it('round-trips a no-change as the empty patch', () => {
    const d = diffStrings('a\nb\nc\n', 'a\nb\nc\n');
    expect(d.hunks).toEqual([]);
    expect(renderUnified(d)).toBe('');
  });

  it('diff → apply → original-output, on a real edit', () => {
    const before = 'one\ntwo\nthree\nfour\nfive\n';
    const after = 'one\nTWO\nthree\nfour\nFIVE\n';
    const d = diffStrings(before, after);
    expect(d.hunks.length).toBeGreaterThan(0);
    const applied = applyUnified(before, d);
    if (!applied.ok) throw new Error(applied.reason);
    expect(applied.text).toBe(after);
  });

  it('renderUnified produces a canonical patch that parseUnified reads back', () => {
    const before = 'alpha\nbeta\ngamma\ndelta\n';
    const after = 'alpha\nBETA\ngamma\nDELTA\n';
    const rendered = renderUnified(diffStrings(before, after));
    const parsed = parseUnified(rendered);
    if (!parsed) throw new Error('parse returned null');
    const applied = applyUnified(before, parsed);
    if (!applied.ok) throw new Error(applied.reason);
    expect(applied.text).toBe(after);
  });
});

describe('patch-set hunk staging', () => {
  it('accepts all hunks by default and applies the full new text', () => {
    const set = buildPatchSet([{ path: 'x.txt', before: 'a\nb\nc\n', after: 'A\nb\nC\n' }]);
    const res = resolvePatchSet(set);
    expect(res.errors).toEqual([]);
    expect(res.writes['x.txt']).toBe('A\nb\nC\n');
    expect(res.rejected).toEqual([]);
  });

  it('skips hunks the user rejects — they land in `rejected`', () => {
    // Two changes separated by > context*2 unchanged lines → two hunks.
    const before = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].join('\n') + '\n';
    const after = ['ONE', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'TEN'].join('\n') + '\n';
    let set = buildPatchSet([{ path: 'x.txt', before, after }]);
    expect(set.edits[0]?.diff.hunks.length).toBe(2);
    // Reject the first hunk; keep the second.
    set = setHunkAccepted(set, 0, 0, false);
    const res = resolvePatchSet(set);
    expect(res.writes['x.txt']).toBeDefined();
    expect(res.rejected.length).toBe(1);
    expect(res.rejected[0]?.path).toBe('x.txt');
    // The kept-only application changes line 10 but leaves line 1 alone.
    expect(res.writes['x.txt']?.startsWith('one\n')).toBe(true);
    expect(res.writes['x.txt']?.endsWith('TEN\n')).toBe(true);
  });

  it('listHunks enumerates every hunk across every edit', () => {
    const set = buildPatchSet([
      { path: 'a.txt', before: 'x\n', after: 'X\n' },
      { path: 'b.txt', before: 'y\n', after: 'Y\n' },
    ]);
    const hunks = listHunks(set);
    expect(hunks.map((h) => h.path)).toEqual(['a.txt', 'b.txt']);
  });

  it('rejecting all hunks omits the file from writes', () => {
    let set = buildPatchSet([{ path: 'x.txt', before: 'a\n', after: 'b\n' }]);
    set = setHunkAccepted(set, 0, 0, false);
    const res = resolvePatchSet(set);
    expect(res.writes['x.txt']).toBeUndefined();
    expect(res.rejected.length).toBe(1);
  });
});
