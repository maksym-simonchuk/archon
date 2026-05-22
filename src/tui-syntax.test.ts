import { describe, expect, it } from 'vitest';
import { fenceLang, highlightTs, isTsLang } from './tui-syntax';

// eslint-disable-next-line no-control-regex
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
const sgr = (code: string) => `\x1b[${code}m`;

describe('highlightTs', () => {
  it('is non-destructive: stripping the ANSI yields the original line', () => {
    const lines = [
      'export const add = (a: number, b: number): number => a + b;',
      'function multiply(x: number, y: number) { return x * y; }',
      "const s = 'hi'; // a comment",
      'const n = 0xFF + 1e3 * 42;',
    ];
    for (const l of lines) expect(strip(highlightTs(l))).toBe(l);
  });

  it('colours keywords (const/return/function)', () => {
    const out = highlightTs('const x = 1;');
    expect(out).toContain(`${sgr('35')}const\x1b[0m`);
  });

  it('colours string literals as a single green token', () => {
    const out = highlightTs("const s = 'hello world';");
    expect(out).toContain(`${sgr('32')}'hello world'\x1b[0m`);
  });

  it('colours numbers, including hex and exponent forms', () => {
    expect(highlightTs('let a = 42;')).toContain(`${sgr('33')}42\x1b[0m`);
    expect(highlightTs('let b = 0xFF;')).toContain(`${sgr('33')}0xFF\x1b[0m`);
  });

  it('colours line comments to end of line', () => {
    const out = highlightTs('return x; // done');
    expect(out).toContain(`${sgr('90')}// done\x1b[0m`);
  });

  it('colours an identifier that is immediately a call as a function', () => {
    const out = highlightTs('multiply(2, 2);');
    expect(out).toContain(`${sgr('36')}multiply\x1b[0m`);
  });

  it('does not treat a keyword before `(` as a function call', () => {
    const out = highlightTs('if (x) {');
    expect(out).toContain(`${sgr('35')}if\x1b[0m`);
    expect(out).not.toContain(`${sgr('36')}if\x1b[0m`);
  });

  it('does not scan for keywords inside a string', () => {
    const out = highlightTs("const k = 'return const';");
    expect(out).toContain(`${sgr('32')}'return const'\x1b[0m`);
    // the words inside the string must not be individually keyword-coloured
    expect(out).not.toContain(`${sgr('35')}return\x1b[0m`);
  });
});

describe('fenceLang', () => {
  it('detects a bare fence and a fence with a language', () => {
    expect(fenceLang('```')).toBe('');
    expect(fenceLang('```ts')).toBe('ts');
    expect(fenceLang('   ```tsx  ')).toBe('tsx');
  });

  it('returns undefined for a non-fence line', () => {
    expect(fenceLang('const x = 1;')).toBeUndefined();
    expect(fenceLang('text with ``` inline')).toBeUndefined();
  });

  it('matches a fence even when the line carries ANSI styling', () => {
    expect(fenceLang('\x1b[2m```ts\x1b[0m')).toBe('ts');
  });
});

describe('isTsLang', () => {
  it('accepts the JS/TS family case-insensitively', () => {
    for (const l of ['ts', 'TS', 'tsx', 'js', 'jsx', 'javascript', 'typescript', 'mjs']) {
      expect(isTsLang(l)).toBe(true);
    }
  });

  it('rejects other languages and the empty (no-lang) fence', () => {
    for (const l of ['', 'python', 'rust', 'json', 'bash']) expect(isTsLang(l)).toBe(false);
  });
});
