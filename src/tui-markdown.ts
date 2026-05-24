/**
 * Zero-dependency Markdown line renderer for the TUI transcript — the
 * Claude-Code-style prose rendering of `/ask` answers. Where `tui-syntax`
 * colours the inside of ``` fenced code blocks, this module renders the prose
 * *around* them: ATX headings, **bold**, `inline code`, [links](urls),
 * pipe-tables, bullet/numbered lists, block quotes and horizontal rules.
 *
 * It works one line at a time because the TUI transcript is a flat array of
 * lines. Two guards keep it safe to run over the whole transcript:
 *   1. The caller never feeds it lines inside a code fence (those go to
 *      `highlightTs` or pass through raw).
 *   2. A line that already carries ANSI (the user-echo line, the banner, any
 *      pre-styled command output) is returned untouched — only the model's
 *      plain-text stream is ever re-styled.
 *
 * Single-`*`/`_` italic is deliberately NOT parsed: in technical answers it
 * collides with `a * b`, glob patterns (`src/**` ) and snake_case identifiers,
 * where mangling the text is far worse than missing the emphasis.
 */

const ANSI = /\x1b\[[0-9;]*m/;

// SGR codes, matching the TUI palette (see src/tui.ts / src/tui-syntax.ts).
const RESET = '\x1b[0m';
const wrap = (codes: string, s: string): string => `\x1b[${codes}m${s}${RESET}`;
const BOLD = '1';
const DIM = '2';
const HEADING = '1;36'; // bold cyan
const CODE = '36'; // cyan — inline `code`
const RULE = '2'; // dim — horizontal rule glyph
const LINK = '4;36'; // underlined cyan — [label](url)

/**
 * Style the inline spans of a single text run: `code` (backticks dropped, the
 * content coloured) and **bold**. A single left-to-right pass so bold markers
 * inside a code span are never treated as emphasis. Returns the run unchanged
 * when it contains no inline markup.
 */
export function styleInline(text: string): string {
  if (!text.includes('`') && !text.includes('**') && !text.includes('](')) return text;
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    // `inline code` — to the next backtick; the backticks are dropped.
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close !== -1) {
        out += wrap(CODE, text.slice(i + 1, close));
        i = close + 1;
        continue;
      }
    }
    // **bold** — to the next `**`; the markers are dropped.
    if (ch === '*' && text[i + 1] === '*') {
      const close = text.indexOf('**', i + 2);
      if (close !== -1) {
        out += wrap(BOLD, text.slice(i + 2, close));
        i = close + 2;
        continue;
      }
    }
    // [label](url) — underlined cyan label, dim url in parens (terminals can't
    // make a link clickable here, so the url is preserved alongside the label).
    if (ch === '[') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const label = text.slice(i + 1, closeBracket);
          const url = text.slice(closeBracket + 2, closeParen);
          out += `${wrap(LINK, label)} ${wrap(DIM, `(${url})`)}`;
          i = closeParen + 1;
          continue;
        }
      }
    }
    out += ch;
    i++;
  }
  return out;
}

const HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/; // --- *** ___ (3+), checked before bullets
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const QUOTE_RE = /^(\s*)>\s?(.*)$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
const NUM_RE = /^(\s*)(\d{1,9}[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|/; // a row starts with `|` (the common pipe-table form)
const TABLE_SEP = /^[\s|:-]+$/; // the `| --- | :--: |` header rule: only pipes, dashes, colons, spaces

/**
 * Render one Markdown line to a styled terminal line. Block constructs
 * (heading, rule, quote, bullet, numbered item) are detected first, then the
 * remaining text gets inline styling. Lines that already carry ANSI, or are
 * empty, are returned unchanged.
 */
export function renderMarkdownLine(line: string): string {
  if (line === '' || ANSI.test(line)) return line;

  // Pipe-tables render row-by-row: dim the header rule, otherwise drop the
  // pipes for nice `│` separators and inline-style each cell.
  if (TABLE_ROW.test(line)) {
    const trimmed = line.trim();
    if (TABLE_SEP.test(trimmed)) return wrap(DIM, trimmed);
    const raw = line.split('|').map((c) => c.trim());
    // Leading/trailing empty cells appear when the row begins/ends with `|`.
    const cells = raw.filter((c, idx, arr) => !(c === '' && (idx === 0 || idx === arr.length - 1)));
    return cells.map((c) => styleInline(c)).join(`  ${wrap(DIM, '│')}  `);
  }

  if (HR.test(line)) return wrap(RULE, '─'.repeat(Math.max(3, line.trim().length)));

  const h = HEADING_RE.exec(line);
  if (h) return wrap(HEADING, styleInline(h[2]));

  const q = QUOTE_RE.exec(line);
  if (q) return `${q[1]}${wrap(DIM, '▏')} ${wrap(DIM, styleInline(q[2]))}`;

  const b = BULLET_RE.exec(line);
  if (b) return `${b[1]}${wrap(CODE, '•')} ${styleInline(b[2])}`;

  const num = NUM_RE.exec(line);
  if (num) return `${num[1]}${wrap(BOLD, num[2])} ${styleInline(num[3])}`;

  return styleInline(line);
}
