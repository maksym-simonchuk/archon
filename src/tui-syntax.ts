/**
 * Zero-dependency TS/JS syntax highlighting for the TUI transcript — the
 * Claude-Code-style colouring of fenced code blocks in `/ask` answers. A single
 * left-to-right scanner colours one line of code with ANSI SGR escapes; the TUI
 * renderer detects ``` fences and highlights the lines between them.
 *
 * Pure and side-effect-free (it always emits colour; the caller decides whether
 * to apply it, e.g. it skips when `NO_COLOR` is set), so the tokeniser is unit-
 * tested without a terminal. Highlighting is non-destructive: stripping the ANSI
 * from `highlightTs(line)` yields the original line unchanged.
 */

// SGR colour codes, matching the TUI's palette (see src/tui.ts `sgr`).
const COLOR = {
  keyword: '35', // magenta — const / function / return / if …
  string: '32', // green — '…' "…" `…`
  number: '33', // yellow — 42, 0xFF, 1e3
  comment: '90', // bright black — // … and /* … */
  fn: '36', // cyan — an identifier immediately before `(`
} as const;

const paint = (code: string, s: string): string => `\x1b[${code}m${s}\x1b[0m`;

// TS/JS reserved words + the common type keywords, coloured as keywords.
const KEYWORDS = new Set([
  'abstract', 'any', 'as', 'asserts', 'async', 'await', 'boolean', 'break', 'case', 'catch',
  'class', 'const', 'continue', 'debugger', 'declare', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements',
  'import', 'in', 'infer', 'instanceof', 'interface', 'is', 'keyof', 'let', 'namespace', 'never',
  'new', 'null', 'number', 'object', 'of', 'private', 'protected', 'public', 'readonly', 'return',
  'satisfies', 'set', 'static', 'string', 'super', 'switch', 'symbol', 'this', 'throw', 'true',
  'try', 'type', 'typeof', 'undefined', 'unknown', 'var', 'void', 'while', 'yield',
]);

const isIdentStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isNumPart = (c: string): boolean => /[0-9._xXa-fA-FbBoOeE]/.test(c);

/**
 * Colour one line of TS/JS. Single pass so strings and comments are never
 * re-scanned for keywords inside them. Multi-line constructs (block comments,
 * template literals spanning rows) are coloured per-line, which is sufficient
 * for the short snippets answers contain.
 */
export function highlightTs(line: string): string {
  let out = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    const next = line[i + 1];

    // Line comment — the rest of the line is a comment.
    if (ch === '/' && next === '/') {
      out += paint(COLOR.comment, line.slice(i));
      break;
    }
    // Block comment — to the closing `*/` or end of line.
    if (ch === '/' && next === '*') {
      const close = line.indexOf('*/', i + 2);
      const stop = close === -1 ? n : close + 2;
      out += paint(COLOR.comment, line.slice(i, stop));
      i = stop;
      continue;
    }
    // String / template literal — to the matching quote (honouring escapes).
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < n && line[j] !== ch) {
        if (line[j] === '\\') j++;
        j++;
      }
      const stop = Math.min(j + 1, n);
      out += paint(COLOR.string, line.slice(i, stop));
      i = stop;
      continue;
    }
    // Number — only when a digit starts the token (identifiers consume trailing digits).
    if (isDigit(ch)) {
      let j = i;
      while (j < n && isNumPart(line[j])) j++;
      out += paint(COLOR.number, line.slice(i, j));
      i = j;
      continue;
    }
    // Identifier — a keyword, a call (followed by `(`), or plain.
    if (isIdentStart(ch)) {
      let j = i;
      while (j < n && isIdentPart(line[j])) j++;
      const word = line.slice(i, j);
      if (KEYWORDS.has(word)) out += paint(COLOR.keyword, word);
      else if (line[j] === '(') out += paint(COLOR.fn, word);
      else out += word;
      i = j;
      continue;
    }
    // Anything else (operators, punctuation, whitespace) passes through.
    out += ch;
    i++;
  }
  return out;
}

// A fenced code block opens/closes with ``` optionally followed by a language.
const FENCE = /^\s*```(\w+)?\s*$/;

/**
 * If `line` is a Markdown code-fence marker, return its language (`''` when the
 * fence names none); otherwise `undefined`. ANSI is stripped first so a styled
 * transcript line still matches.
 */
export function fenceLang(line: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
  const m = FENCE.exec(plain);
  return m ? (m[1] ?? '') : undefined;
}

const TS_LANGS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'javascript', 'typescript']);

/** Whether a fence language should be highlighted by the TS/JS tokeniser. */
export function isTsLang(lang: string): boolean {
  return TS_LANGS.has(lang.toLowerCase());
}
