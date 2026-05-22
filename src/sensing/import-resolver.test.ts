import { describe, expect, it } from 'vitest';
import { extractImports, resolveImport } from './import-resolver';

describe('extractImports', () => {
  it('pulls specifiers from every import/export/require form', () => {
    const src = [
      "import a from './a';",
      "import { b } from './b';",
      "export { c } from './c';",
      "import './side-effect';",
      "const d = await import('./d');",
      "const e = require('./e');",
      "import x from 'react';",
    ].join('\n');
    expect(extractImports(src)).toEqual([
      './a',
      './b',
      './c',
      './side-effect',
      './d',
      './e',
      'react',
    ]);
  });

  it('dedupes repeated specifiers, preserving first-seen order', () => {
    expect(extractImports("import {a} from './x';\nimport {b} from './x';")).toEqual(['./x']);
  });

  it('returns nothing for import-free source', () => {
    expect(extractImports('export const x = 1;')).toEqual([]);
  });
});

describe('resolveImport', () => {
  const fs = (...files: string[]) => {
    const set = new Set(files);
    return (rel: string) => set.has(rel);
  };

  it('resolves a sibling import by extension trial', () => {
    expect(resolveImport('src/a.ts', './b', fs('src/b.ts'))).toBe('src/b.ts');
  });

  it('resolves a directory import to its index file', () => {
    expect(resolveImport('src/a.ts', './util', fs('src/util/index.ts'))).toBe('src/util/index.ts');
  });

  it('resolves an explicit extension as written', () => {
    expect(resolveImport('src/a.ts', './b.js', fs('src/b.js'))).toBe('src/b.js');
  });

  it('resolves a parent-directory hop that stays in the repo', () => {
    expect(resolveImport('src/sub/a.ts', '../b', fs('src/b.ts'))).toBe('src/b.ts');
  });

  it('drops bare specifiers (node modules / built-ins)', () => {
    expect(resolveImport('src/a.ts', 'react', fs('src/react.ts'))).toBeUndefined();
    expect(resolveImport('src/a.ts', 'node:fs', () => true)).toBeUndefined();
  });

  it('drops specifiers that escape the repo root', () => {
    expect(resolveImport('a.ts', '../secret', () => true)).toBeUndefined();
  });

  it('drops a relative import that hits no real file', () => {
    expect(resolveImport('src/a.ts', './missing', fs('src/a.ts'))).toBeUndefined();
  });
});
