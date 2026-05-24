import { describe, expect, it } from 'vitest';
import { applyCompletion, atTokenAtCursor, rankFilesByQuery } from './tui-completion';

describe('atTokenAtCursor', () => {
  it('finds a token whose @ is left of the cursor', () => {
    expect(atTokenAtCursor('hello @src/tui.ts', 17)).toEqual({ start: 6, end: 17, query: 'src/tui.ts' });
  });

  it('finds a token when the cursor is inside it (Tab in the middle of a token completes the whole word)', () => {
    const buf = 'see @src/tui.ts now';
    const out = atTokenAtCursor(buf, 8); // cursor inside the word
    expect(out).toEqual({ start: 4, end: 15, query: 'src/tui.ts' });
  });

  it('returns null when no @ is reachable without crossing whitespace', () => {
    expect(atTokenAtCursor('plain text', 5)).toBeNull();
    expect(atTokenAtCursor('foo @one bar', 12)).toBeNull(); // whitespace blocks the walk back
  });

  it('handles an empty query (just `@`)', () => {
    expect(atTokenAtCursor('@', 1)).toEqual({ start: 0, end: 1, query: '' });
  });

  it('clamps an out-of-range cursor', () => {
    expect(atTokenAtCursor('@abc', 99)?.query).toBe('abc');
  });
});

describe('applyCompletion', () => {
  it('replaces the token with @${path} and moves the cursor past it', () => {
    const out = applyCompletion('see @src now', { start: 4, end: 8, query: 'src' }, 'src/tui.ts');
    expect(out.buffer).toBe('see @src/tui.ts now');
    expect(out.cursor).toBe(15); // just past the replacement
  });

  it('works when the token is at the buffer start', () => {
    const out = applyCompletion('@x', { start: 0, end: 2, query: 'x' }, 'package.json');
    expect(out.buffer).toBe('@package.json');
    expect(out.cursor).toBe(out.buffer.length);
  });
});

describe('rankFilesByQuery', () => {
  const files = [
    'src/tui.ts',
    'src/tui-syntax.ts',
    'src/tui-markdown.ts',
    'src/cli.ts',
    'src/commands.ts',
    'docs/ARCHITECTURE.md',
    'package.json',
  ];

  it('basename-prefix matches beat path-prefix matches beat contains', () => {
    const top = rankFilesByQuery('tui', files);
    expect(top.slice(0, 3)).toEqual(['src/tui.ts', 'src/tui-syntax.ts', 'src/tui-markdown.ts']);
  });

  it('is case-insensitive', () => {
    expect(rankFilesByQuery('TUI', files)[0]).toBe('src/tui.ts');
  });

  it('within a match bucket, shorter paths rank ahead of longer ones', () => {
    const fs = ['src/very-long-name.ts', 'src/x.ts', 'src/medium.ts'];
    expect(rankFilesByQuery('src', fs)).toEqual(['src/x.ts', 'src/medium.ts', 'src/very-long-name.ts']);
  });

  it('an empty query returns the input order, truncated', () => {
    expect(rankFilesByQuery('', files, 3)).toEqual(files.slice(0, 3));
  });

  it('a no-match query returns an empty list', () => {
    expect(rankFilesByQuery('zzz_nope', files)).toEqual([]);
  });
});
