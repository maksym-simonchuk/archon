import { describe, expect, it } from 'vitest';
import {
  clip,
  commandMenu,
  editKey,
  type InputState,
  menuWindowStart,
  tailLines,
  visibleWidth,
  wrapLine,
} from './tui';

const state = (buffer: string, cursor = buffer.length): InputState => ({ buffer, cursor });

describe('visibleWidth', () => {
  it('counts visible chars, ignoring SGR colour escapes', () => {
    expect(visibleWidth('hello')).toBe(5);
    expect(visibleWidth('\x1b[36mhello\x1b[0m')).toBe(5);
  });
});

describe('wrapLine', () => {
  it('hard-wraps to the given width', () => {
    expect(wrapLine('abcdef', 3)).toEqual(['abc', 'def']);
  });

  it('keeps a short line intact and never drops an empty line', () => {
    expect(wrapLine('ab', 10)).toEqual(['ab']);
    expect(wrapLine('', 10)).toEqual(['']);
  });

  it('treats colour escapes as zero-width when measuring the wrap point', () => {
    const wrapped = wrapLine('\x1b[36mabcdef\x1b[0m', 3);
    expect(wrapped.map(visibleWidth)).toEqual([3, 3]);
  });
});

describe('tailLines', () => {
  const lines = ['1', '2', '3', '4', '5'];
  it('returns the bottom slice at offset 0', () => {
    expect(tailLines(lines, 2, 0)).toEqual(['4', '5']);
  });
  it('scrolls up by offset', () => {
    expect(tailLines(lines, 2, 2)).toEqual(['2', '3']);
  });
  it('clamps to the start and to a non-positive height', () => {
    expect(tailLines(lines, 10, 0)).toEqual(lines);
    expect(tailLines(lines, 0, 0)).toEqual([]);
  });
});

describe('clip', () => {
  it('truncates to visible width and resets colour if cut mid-style', () => {
    expect(clip('abcdef', 3)).toBe('abc');
    expect(clip('\x1b[36mabcdef', 3)).toBe('\x1b[36mabc\x1b[0m');
    expect(clip('abc', 10)).toBe('abc');
  });
});

describe('editKey', () => {
  it('inserts a printable char at the cursor', () => {
    expect(editKey(state('ac', 1), { sequence: 'b' })).toEqual({ buffer: 'abc', cursor: 2 });
  });
  it('backspaces and stops at the start', () => {
    expect(editKey(state('abc', 3), { name: 'backspace' })).toEqual({ buffer: 'ab', cursor: 2 });
    expect(editKey(state('abc', 0), { name: 'backspace' })).toEqual({ buffer: 'abc', cursor: 0 });
  });
  it('forward-deletes and stops at the end', () => {
    expect(editKey(state('abc', 1), { name: 'delete' })).toEqual({ buffer: 'ac', cursor: 1 });
    expect(editKey(state('abc', 3), { name: 'delete' })).toEqual({ buffer: 'abc', cursor: 3 });
  });
  it('moves the cursor within bounds', () => {
    expect(editKey(state('abc', 1), { name: 'left' }).cursor).toBe(0);
    expect(editKey(state('abc', 0), { name: 'left' }).cursor).toBe(0);
    expect(editKey(state('abc', 2), { name: 'right' }).cursor).toBe(3);
    expect(editKey(state('abc', 3), { name: 'home' }).cursor).toBe(0);
    expect(editKey(state('abc', 0), { name: 'end' }).cursor).toBe(3);
  });
  it('honours the emacs kill bindings', () => {
    expect(editKey(state('hello', 3), { ctrl: true, name: 'u' })).toEqual({ buffer: 'lo', cursor: 0 });
    expect(editKey(state('hello', 3), { ctrl: true, name: 'k' })).toEqual({ buffer: 'hel', cursor: 3 });
    expect(editKey(state('foo bar', 7), { ctrl: true, name: 'w' })).toEqual({ buffer: 'foo', cursor: 3 });
  });
  it('ignores control/meta chords and returns the same reference', () => {
    const s = state('abc');
    expect(editKey(s, { ctrl: true, sequence: 's' })).toBe(s);
    expect(editKey(s, { name: 'f5' })).toBe(s);
  });
});

describe('menuWindowStart', () => {
  it('does not scroll when everything fits', () => {
    expect(menuWindowStart(4, 0, 6)).toBe(0);
    expect(menuWindowStart(4, 3, 6)).toBe(0);
  });
  it('slides the window to keep the selection visible', () => {
    // 20 items, window of 6: selecting row 8 must scroll so 8 is in [start, start+6).
    expect(menuWindowStart(20, 5, 6)).toBe(0); // still within the first window
    expect(menuWindowStart(20, 6, 6)).toBe(1);
    expect(menuWindowStart(20, 8, 6)).toBe(3);
    expect(menuWindowStart(20, 19, 6)).toBe(14); // clamped to last full window
  });
  it('clamps to valid bounds for degenerate input', () => {
    expect(menuWindowStart(0, 0, 6)).toBe(0);
    expect(menuWindowStart(10, 5, 0)).toBe(0);
  });
});

describe('commandMenu', () => {
  it('matches command prefixes while typing the command word', () => {
    expect(commandMenu('/pl')).toEqual(['/plan', '/plugins']);
    expect(commandMenu('/improve')).toEqual(['/improve']);
  });
  it('offers nothing once past the command word or for a bare goal', () => {
    expect(commandMenu('/plan add x')).toEqual([]);
    expect(commandMenu('add a greeter')).toEqual([]);
    expect(commandMenu('/zzz')).toEqual([]);
  });
});
