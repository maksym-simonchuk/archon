import { describe, expect, it } from 'vitest';
import {
  bufferLines,
  cursorFromRowCol,
  cursorRowCol,
  insertAt,
  isMultiline,
  lineEnd,
  lineHome,
  moveLineDown,
  moveLineUp,
} from './tui-input';

describe('cursorRowCol / cursorFromRowCol', () => {
  it('a single-line buffer reports row 0 and col = cursor', () => {
    expect(cursorRowCol('hello', 0)).toEqual({ row: 0, col: 0 });
    expect(cursorRowCol('hello', 3)).toEqual({ row: 0, col: 3 });
    expect(cursorRowCol('hello', 5)).toEqual({ row: 0, col: 5 });
  });

  it('counts each \\n as a row boundary', () => {
    const buf = 'aa\nbbb\nc';
    expect(cursorRowCol(buf, 0)).toEqual({ row: 0, col: 0 });
    expect(cursorRowCol(buf, 2)).toEqual({ row: 0, col: 2 });
    expect(cursorRowCol(buf, 3)).toEqual({ row: 1, col: 0 }); // just past the \n
    expect(cursorRowCol(buf, 6)).toEqual({ row: 1, col: 3 });
    expect(cursorRowCol(buf, 7)).toEqual({ row: 2, col: 0 });
    expect(cursorRowCol(buf, 8)).toEqual({ row: 2, col: 1 });
  });

  it('cursorFromRowCol round-trips with cursorRowCol', () => {
    const buf = 'one\ntwo\nthree';
    for (let i = 0; i <= buf.length; i++) {
      const { row, col } = cursorRowCol(buf, i);
      expect(cursorFromRowCol(buf, row, col)).toBe(i);
    }
  });

  it('cursorFromRowCol clamps an out-of-range (row, col) instead of throwing', () => {
    const buf = 'aa\nbbb';
    expect(cursorFromRowCol(buf, 99, 99)).toBe(buf.length);
    expect(cursorFromRowCol(buf, -1, -1)).toBe(0);
    expect(cursorFromRowCol(buf, 0, 99)).toBe(2); // clamps to end of row 0
  });
});

describe('insertAt', () => {
  it('inserts text and advances the cursor past it', () => {
    expect(insertAt({ buffer: 'ab', cursor: 1 }, 'X')).toEqual({ buffer: 'aXb', cursor: 2 });
  });

  it('inserts a newline (multi-line composition)', () => {
    const out = insertAt({ buffer: 'hello', cursor: 5 }, '\nworld');
    expect(out).toEqual({ buffer: 'hello\nworld', cursor: 11 });
  });

  it('inserts a pasted multi-line block in one shot', () => {
    const out = insertAt({ buffer: '> ', cursor: 2 }, 'line one\nline two\nline three');
    expect(out.buffer).toBe('> line one\nline two\nline three');
    expect(out.cursor).toBe(out.buffer.length);
  });
});

describe('moveLineUp / moveLineDown', () => {
  it('returns the state unchanged on a single-line buffer', () => {
    const s = { buffer: 'hello', cursor: 3 };
    expect(moveLineUp(s)).toBe(s);
    expect(moveLineDown(s)).toBe(s);
  });

  it('moves up preserving the column', () => {
    const buf = 'first\nsecond';
    const s = { buffer: buf, cursor: cursorFromRowCol(buf, 1, 3) };
    expect(cursorRowCol(buf, moveLineUp(s).cursor)).toEqual({ row: 0, col: 3 });
  });

  it('clamps the column when the target row is shorter', () => {
    const buf = 'hi\nlonger line';
    const s = { buffer: buf, cursor: cursorFromRowCol(buf, 1, 7) };
    expect(cursorRowCol(buf, moveLineUp(s).cursor)).toEqual({ row: 0, col: 2 }); // clamped to "hi"
  });

  it('moves down preserving the column', () => {
    const buf = 'first\nsecond';
    const s = { buffer: buf, cursor: cursorFromRowCol(buf, 0, 2) };
    expect(cursorRowCol(buf, moveLineDown(s).cursor)).toEqual({ row: 1, col: 2 });
  });
});

describe('lineHome / lineEnd', () => {
  it('snap to the boundaries of the cursor\'s current row', () => {
    const buf = 'aa\nbbbbb\ncc';
    const s = { buffer: buf, cursor: cursorFromRowCol(buf, 1, 3) };
    expect(cursorRowCol(buf, lineHome(s).cursor)).toEqual({ row: 1, col: 0 });
    expect(cursorRowCol(buf, lineEnd(s).cursor)).toEqual({ row: 1, col: 5 });
  });
});

describe('isMultiline / bufferLines', () => {
  it('reports single vs multi-line', () => {
    expect(isMultiline('one')).toBe(false);
    expect(isMultiline('one\ntwo')).toBe(true);
  });

  it('bufferLines always returns at least one element', () => {
    expect(bufferLines('')).toEqual(['']);
    expect(bufferLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });
});
