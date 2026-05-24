import { describe, expect, it } from 'vitest';
import { renderMarkdownLine, styleInline } from './tui-markdown';

// eslint-disable-next-line no-control-regex
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
const sgr = (code: string): string => `\x1b[${code}m`;

describe('styleInline', () => {
  it('leaves a plain run untouched', () => {
    expect(styleInline('just some prose, no markup')).toBe('just some prose, no markup');
  });

  it('colours `inline code` and drops the backticks', () => {
    const out = styleInline('run `npm test` first');
    expect(out).toBe(`run ${sgr('36')}npm test\x1b[0m first`);
  });

  it('bolds **strong** text and drops the markers', () => {
    const out = styleInline('this is **important** here');
    expect(out).toBe(`this is ${sgr('1')}important\x1b[0m here`);
  });

  it('does not treat bold markers inside a code span as emphasis', () => {
    const out = styleInline('`a ** b`');
    expect(out).toBe(`${sgr('36')}a ** b\x1b[0m`);
  });

  it('leaves an unclosed marker literal', () => {
    expect(styleInline('a * b * c')).toBe('a * b * c');
    expect(styleInline('unterminated `code')).toBe('unterminated `code');
  });

  it('renders [label](url) as an underlined-cyan label and a dim url', () => {
    const out = styleInline('see [docs](https://archon.dev)');
    expect(strip(out)).toBe('see docs (https://archon.dev)');
    expect(out).toContain(`${sgr('4;36')}docs\x1b[0m`);
    expect(out).toContain(`${sgr('2')}(https://archon.dev)\x1b[0m`);
  });

  it('leaves an unclosed link literal', () => {
    expect(styleInline('open [missing](')).toBe('open [missing](');
    expect(styleInline('open [missing] paren')).toBe('open [missing] paren');
  });
});

describe('renderMarkdownLine', () => {
  it('returns empty and pre-styled lines unchanged', () => {
    expect(renderMarkdownLine('')).toBe('');
    const styled = `${sgr('36')}\x1b[1m›\x1b[0m hi`;
    expect(renderMarkdownLine(styled)).toBe(styled);
  });

  it('renders an ATX heading bold and strips the hashes', () => {
    const out = renderMarkdownLine('## TypeScript helpers');
    expect(out).toBe(`${sgr('1;36')}TypeScript helpers\x1b[0m`);
    expect(strip(out)).toBe('TypeScript helpers');
  });

  it('renders a bullet with a • glyph, preserving indent', () => {
    const out = renderMarkdownLine('  - first item');
    expect(strip(out)).toBe('  • first item');
  });

  it('treats * and + as bullet markers too', () => {
    expect(strip(renderMarkdownLine('* star'))).toBe('• star');
    expect(strip(renderMarkdownLine('+ plus'))).toBe('• plus');
  });

  it('renders a numbered list item keeping the number', () => {
    const out = renderMarkdownLine('2. second');
    expect(strip(out)).toBe('2. second');
  });

  it('renders a block quote with a bar glyph', () => {
    const out = renderMarkdownLine('> quoted');
    expect(strip(out)).toBe('▏ quoted');
  });

  it('renders a horizontal rule as a dim line, not a bullet', () => {
    expect(strip(renderMarkdownLine('---'))).toMatch(/^─+$/);
    expect(strip(renderMarkdownLine('* * *'))).toMatch(/^─+$/);
  });

  it('applies inline styling inside block text', () => {
    const out = renderMarkdownLine('- call `add()` now');
    expect(out).toContain(`${sgr('36')}add()\x1b[0m`);
  });

  it('does not mangle a code-ish line (globs, multiplication)', () => {
    expect(renderMarkdownLine('matches src/**/*.ts and a * b')).toBe('matches src/**/*.ts and a * b');
  });

  it('renders a pipe-table data row with dim `│` separators and styled cells', () => {
    const out = renderMarkdownLine('| Name | Type |');
    expect(strip(out)).toBe('Name  │  Type');
    expect(out).toContain(`${sgr('2')}│\x1b[0m`);
  });

  it('renders the table header rule entirely dim', () => {
    const out = renderMarkdownLine('| --- | --- |');
    expect(strip(out)).toBe('| --- | --- |');
    expect(out).toBe(`${sgr('2')}| --- | --- |\x1b[0m`);
  });

  it('inline-styles cells inside a table row', () => {
    const out = renderMarkdownLine('| `add` | sums two numbers |');
    expect(out).toContain(`${sgr('36')}add\x1b[0m`);
  });
});
