/**
 * Pure helpers for the TUI's `@file` Tab-completion — Claude-Code-style mention
 * of a path inside an answer or a goal. The detector finds an `@token` under
 * the cursor (so Tab anywhere inside it triggers completion, not just at the
 * end); the applier rewrites the token with the chosen path. Both are pure so
 * the matching/cycling logic is unit-tested without a terminal.
 *
 * The ranking is intentionally a tiny standalone fallback — when the WASM
 * `fuzzy_rank` kernel is available the TUI calls it instead, but we keep this
 * here so the module is self-sufficient and the tests don't need WASM.
 */

/** A `@…` token under the cursor: where it starts/ends in the buffer, and the query (without the `@`). */
export interface AtToken {
  start: number; // index of the `@`
  end: number; // exclusive — the character that ended the token (whitespace or buffer end)
  query: string; // characters between `@` and `end`
}

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && !/\s/.test(ch);

/**
 * Find an `@token` at or just before the cursor. Walks back from `cursor` to
 * the nearest `@` or whitespace: an `@` wins (token found), a whitespace
 * cancels (no token). Forward-extends `end` to the next whitespace so Tab in
 * the middle of a token still completes the whole word.
 */
export function atTokenAtCursor(buffer: string, cursor: number): AtToken | null {
  const c = Math.max(0, Math.min(cursor, buffer.length));
  for (let i = c - 1; i >= 0; i--) {
    const ch = buffer[i];
    if (ch === '@') {
      let end = c;
      while (end < buffer.length && isWordChar(buffer[end])) end++;
      return { start: i, end, query: buffer.slice(i + 1, end) };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

/** Replace the token's slice with `@${path}` and place the cursor just past it. */
export function applyCompletion(
  buffer: string,
  token: AtToken,
  path: string,
): { buffer: string; cursor: number } {
  const replacement = `@${path}`;
  const next = buffer.slice(0, token.start) + replacement + buffer.slice(token.end);
  return { buffer: next, cursor: token.start + replacement.length };
}

/**
 * A standalone fuzzy ranker — prefix-on-basename first, then prefix-on-path,
 * then contains, ties broken by path length (shorter = more relevant). Good
 * enough as a fallback and a unit-testable baseline; production uses the WASM
 * `fuzzy_rank` kernel for richer scoring.
 */
export function rankFilesByQuery(query: string, files: readonly string[], limit = 50): string[] {
  if (query === '') return files.slice(0, limit);
  const q = query.toLowerCase();
  const basenameOf = (p: string): string => {
    const slash = p.lastIndexOf('/');
    return slash === -1 ? p : p.slice(slash + 1);
  };
  const buckets: string[][] = [[], [], []];
  for (const f of files) {
    const lower = f.toLowerCase();
    const base = basenameOf(lower);
    if (base.startsWith(q)) buckets[0].push(f);
    else if (lower.startsWith(q)) buckets[1].push(f);
    else if (lower.includes(q)) buckets[2].push(f);
  }
  for (const b of buckets) b.sort((a, c) => a.length - c.length);
  return [...buckets[0], ...buckets[1], ...buckets[2]].slice(0, limit);
}
