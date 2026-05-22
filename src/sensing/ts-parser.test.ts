import { describe, expect, it } from 'vitest';
import { parseTsSymbols } from './ts-parser';

describe('parseTsSymbols', () => {
  it('extracts functions, classes (+ methods), and bindings with qualified ids', () => {
    const src = `
      export function handleLogin() {}
      class Session {
        start() {}
        stop() {}
      }
      export const PAGE_SIZE = 20;
      export const render = () => {};
      interface Token { v: string }
      type Id = string;
    `;
    const { symbols } = parseTsSymbols('src/auth/login.ts', src);
    const byName = new Map(symbols.map((s) => [s.name, s.kind]));

    expect(byName.get('src/auth/login.ts#handleLogin')).toBe('function');
    expect(byName.get('src/auth/login.ts#Session')).toBe('class');
    expect(byName.get('src/auth/login.ts#Session.start')).toBe('method');
    expect(byName.get('src/auth/login.ts#Session.stop')).toBe('method');
    expect(byName.get('src/auth/login.ts#PAGE_SIZE')).toBe('binding');
    expect(byName.get('src/auth/login.ts#render')).toBe('function'); // arrow const
    expect(byName.get('src/auth/login.ts#Token')).toBe('interface');
    expect(byName.get('src/auth/login.ts#Id')).toBe('type');
  });

  it('emits a calls edge from the enclosing declaration to a local callee', () => {
    const src = `
      function helper() {}
      function main() { helper(); }
    `;
    const { edges } = parseTsSymbols('x.ts', src);
    expect(edges).toContainEqual({ src: 'x.ts#main', dst: 'x.ts#helper', kind: 'calls' });
  });

  it('attributes a call to the nearest enclosing declaration (method over class)', () => {
    const src = `
      function log() {}
      class Service {
        run() { log(); }
      }
    `;
    const { edges } = parseTsSymbols('s.ts', src);
    expect(edges).toContainEqual({ src: 's.ts#Service.run', dst: 's.ts#log', kind: 'calls' });
  });

  it('does NOT treat keywords or string content as calls (the heuristic\'s false positives)', () => {
    // `if (...)` and the word "helper(" inside a string must not produce edges;
    // only a real call expression to a local declaration does.
    const src = `
      function helper() {}
      function main() {
        if (true) {}
        const s = "helper()";
        for (let i = 0; i < 1; i++) {}
      }
    `;
    const { edges } = parseTsSymbols('x.ts', src);
    expect(edges).toEqual([]);
  });

  it('returns an empty parse for unrelated content rather than throwing', () => {
    expect(parseTsSymbols('empty.ts', 'const a = 1 + 2;')).toEqual({
      symbols: [{ name: 'empty.ts#a', kind: 'binding' }],
      edges: [],
    });
  });
});
