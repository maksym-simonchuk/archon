/**
 * Pure multi-line buffer helpers for the TUI input — the testable core of
 * Claude-Code-style multi-line composition. A buffer is a plain string, with
 * `\n` separating logical rows; the cursor is an absolute character index.
 * The helpers convert between (row, col) and that index, and implement the
 * navigation and editing primitives the TUI's `onKey` calls when the buffer
 * spans more than one row (paste, Alt+Enter, Up/Down inside the input).
 *
 * Single-line behaviour is identical to the old `{buffer, cursor}` model — a
 * buffer with no `\n` has one row, so `cursorRowCol` returns `{row:0,col:cursor}`
 * and `moveLineUp/Down` return the state unchanged.
 */

export interface InputState {
  buffer: string;
  cursor: number;
}

/** Split the buffer on `\n`; always returns at least one element. */
export function bufferLines(buffer: string): string[] {
  return buffer.split('\n');
}

/** The (row, col) the cursor sits at — row is the 0-based line index, col is the visible offset within it. */
export function cursorRowCol(buffer: string, cursor: number): { row: number; col: number } {
  const c = Math.max(0, Math.min(cursor, buffer.length));
  let row = 0;
  let lineStart = 0;
  for (let i = 0; i < c; i++) {
    if (buffer[i] === '\n') {
      row++;
      lineStart = i + 1;
    }
  }
  return { row, col: c - lineStart };
}

/** Inverse of `cursorRowCol`: clamp (row, col) into the buffer and return the absolute index. */
export function cursorFromRowCol(buffer: string, row: number, col: number): number {
  const lines = bufferLines(buffer);
  const r = Math.max(0, Math.min(row, lines.length - 1));
  const c = Math.max(0, Math.min(col, lines[r].length));
  let idx = 0;
  for (let i = 0; i < r; i++) idx += lines[i].length + 1; // +1 for the consumed `\n`
  return idx + c;
}

/** Insert `text` at the cursor — splices the string and advances cursor past it. */
export function insertAt(s: InputState, text: string): InputState {
  return {
    buffer: s.buffer.slice(0, s.cursor) + text + s.buffer.slice(s.cursor),
    cursor: s.cursor + text.length,
  };
}

/** Move the cursor up one row, preserving its column where possible. */
export function moveLineUp(s: InputState): InputState {
  const { row, col } = cursorRowCol(s.buffer, s.cursor);
  if (row === 0) return s;
  return { buffer: s.buffer, cursor: cursorFromRowCol(s.buffer, row - 1, col) };
}

/** Move the cursor down one row, preserving its column where possible. */
export function moveLineDown(s: InputState): InputState {
  const lines = bufferLines(s.buffer);
  const { row, col } = cursorRowCol(s.buffer, s.cursor);
  if (row >= lines.length - 1) return s;
  return { buffer: s.buffer, cursor: cursorFromRowCol(s.buffer, row + 1, col) };
}

/** Move the cursor to the start of its current row (readline ^A semantics). */
export function lineHome(s: InputState): InputState {
  const { row } = cursorRowCol(s.buffer, s.cursor);
  return { buffer: s.buffer, cursor: cursorFromRowCol(s.buffer, row, 0) };
}

/** Move the cursor to the end of its current row (readline ^E semantics). */
export function lineEnd(s: InputState): InputState {
  const { row } = cursorRowCol(s.buffer, s.cursor);
  const lines = bufferLines(s.buffer);
  return { buffer: s.buffer, cursor: cursorFromRowCol(s.buffer, row, lines[row].length) };
}

/** True when the buffer spans more than one row — guards whether Up/Down navigates the input or the history. */
export function isMultiline(buffer: string): boolean {
  return buffer.includes('\n');
}
