import { describe, expect, it } from 'vitest';
import type { ArchitecturalFingerprint } from './core/types';
import type { Indexer } from './sensing/indexer';
import { IndexStore } from './sensing/store';
import { assembleSimulation } from './simulation-assembly';

/** Indexer stub — assembleSimulation only calls commitHistory (M15 churn). */
const noChurn = { commitHistory: async () => [] } as unknown as Indexer;

const fingerprint = (): ArchitecturalFingerprint => ({
  scannedAt: '2026-05-22T00:00:00Z',
  inputHash: 'h',
  layout: 'single',
  packageManager: 'bun',
  workspaces: [],
  languages: ['typescript'],
  buildSystem: ['tsc'],
  ci: [],
  frameworks: [],
  testRunners: ['vitest'],
  entryPoints: ['src/index.ts'],
  architecturalStyle: 'layered',
  topDirectories: ['src'],
});

/** Seed a store with a fingerprint + one indexed file defining one symbol. */
const seed = (path: string): IndexStore => {
  const store = new IndexStore(':memory:');
  store.saveFingerprint(fingerprint());
  store.upsertFileHash(path, 'h1');
  store.replaceFileGraph(path, [{ name: `${path}#thing`, kind: 'function' }], []);
  return store;
};

describe('assembleSimulation (M14/M20 shared gate)', () => {
  it('returns a BLOCK recommendation for a never-modify zone (auth)', async () => {
    const store = seed('src/auth/login.ts');
    try {
      const report = await assembleSimulation('/nonexistent-root', noChurn, store, 'src/auth/login.ts', 'modify');
      expect(report?.recommendation).toBe('block');
    } finally {
      store.close();
    }
  });

  it('does not block an ordinary, low-risk file', async () => {
    const store = seed('src/util/format.ts');
    try {
      const report = await assembleSimulation('/nonexistent-root', noChurn, store, 'src/util/format.ts', 'modify');
      expect(report?.recommendation).not.toBe('block');
    } finally {
      store.close();
    }
  });

  it('returns null for a target that is not in the index (nothing to preserve)', async () => {
    const store = seed('src/util/format.ts');
    try {
      expect(await assembleSimulation('/nonexistent-root', noChurn, store, 'src/brand-new.ts', 'modify')).toBeNull();
    } finally {
      store.close();
    }
  });
});
