import { describe, expect, it } from 'vitest';
import type { ArchitecturalFingerprint } from '../core/types';
import { evaluatePreHooks, formatHooks, type PlannedChange, postHookChecks } from './hooks';

const change = (over: Partial<PlannedChange> = {}): PlannedChange => ({
  writes: [],
  addedImports: [],
  existingEdges: [],
  ...over,
});

const fp = (over: Partial<ArchitecturalFingerprint> = {}): ArchitecturalFingerprint => ({
  scannedAt: '',
  inputHash: '',
  layout: 'single',
  packageManager: 'npm',
  workspaces: [],
  languages: ['typescript'],
  buildSystem: ['tsc'],
  ci: [],
  frameworks: [],
  testRunners: ['vitest'],
  entryPoints: [],
  architecturalStyle: 'flat',
  topDirectories: [],
  ...over,
});

describe('evaluatePreHooks', () => {
  it('blocks a write into a never-modify zone', () => {
    const f = evaluatePreHooks(change({ writes: ['src/auth/login.ts'] }));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ hook: 'never-modify', severity: 'block' });
  });

  it('blocks an import that would close a module cycle', () => {
    // src/b already depends on src/a; adding src/a → src/b closes the cycle.
    const f = evaluatePreHooks(
      change({
        existingEdges: [{ src: 'src/b/x.ts', dst: 'src/a/index.ts' }],
        addedImports: [{ src: 'src/a/y.ts', dst: 'src/b/index.ts' }],
      }),
    );
    expect(f.some((x) => x.hook === 'forbidden-import' && x.severity === 'block')).toBe(true);
  });

  it('warns on a cross-module import that reaches past the public surface', () => {
    const f = evaluatePreHooks(change({ addedImports: [{ src: 'src/a/y.ts', dst: 'src/b/internal/secret.ts' }] }));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ hook: 'boundary-leak', severity: 'warn' });
  });

  it('allows an import that targets the module public surface', () => {
    expect(evaluatePreHooks(change({ addedImports: [{ src: 'src/a/y.ts', dst: 'src/b/index.ts' }] }))).toHaveLength(0);
  });

  it('ignores intra-module imports', () => {
    expect(evaluatePreHooks(change({ addedImports: [{ src: 'src/a/y.ts', dst: 'src/a/z.ts' }] }))).toHaveLength(0);
  });
});

describe('postHookChecks', () => {
  it('includes typecheck for typed projects and the detected test runner', () => {
    const checks = postHookChecks(fp());
    expect(checks.find((c) => c.name === 'typecheck')).toBeDefined();
    expect(checks.find((c) => c.name === 'test')?.argv).toEqual(['npx', 'vitest', 'run']);
  });

  it('emits no test check when no runner is detected', () => {
    expect(postHookChecks(fp({ testRunners: [] })).find((c) => c.name === 'test')).toBeUndefined();
  });
});

describe('formatHooks', () => {
  it('reports clean and lists post-write checks', () => {
    const out = formatHooks([], postHookChecks(fp()));
    expect(out).toContain('pre-write hooks: clean');
    expect(out).toContain('post-write checks:');
  });
});
