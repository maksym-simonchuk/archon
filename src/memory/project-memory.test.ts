import { describe, expect, it } from 'vitest';
import type { BoundaryModel } from '../sensing/boundaries';
import type { ArchitecturalFingerprint } from '../core/types';
import { contentHash, extractHash, PROJECT_MEMORY_PATH, renderProjectMemory } from './project-memory';

const fp: ArchitecturalFingerprint = {
  scannedAt: '2026-01-01T00:00:00.000Z',
  inputHash: 'abc',
  layout: 'single',
  packageManager: 'npm',
  workspaces: [],
  languages: ['typescript'],
  buildSystem: ['tsc'],
  ci: ['github-actions'],
  frameworks: [],
  testRunners: ['vitest'],
  entryPoints: ['src/index.ts'],
  architecturalStyle: 'modular-monolith',
  topDirectories: ['core', 'sensing'],
};

const model: BoundaryModel = {
  modules: [
    { name: 'src/core', files: 4, fanIn: 9, fanOut: 1, instability: 0.1, role: 'core' },
    { name: 'src', files: 26, fanIn: 0, fanOut: 9, instability: 1, role: 'unstable' },
  ],
  couplingHotspots: [{ name: 'src/core', coupling: 10 }],
  godModules: [{ name: 'src/services', files: 9, coupling: 6 }],
  cycles: [['a', 'b']],
};

describe('renderProjectMemory', () => {
  it('renders the fingerprint + boundary model as marked markdown', () => {
    const md = renderProjectMemory(fp, model);
    expect(md.startsWith('<!-- archon:generated')).toBe(true);
    expect(md).toContain('# Project memory');
    expect(md).toContain('**Package manager:** npm');
    expect(md).toContain('| `src/core` | 4 | 9 | 1 | 0.10 | core |');
    expect(md).toContain('`src/services` — 9 files, coupling 6');
    expect(md).toContain('`a` → `b` → `a`'); // the cycle
    expect(PROJECT_MEMORY_PATH).toBe('.archon/project-memory.md');
  });

  it('embeds a content hash that round-trips and is input-sensitive', () => {
    const md = renderProjectMemory(fp, model);
    expect(extractHash(md)).toBe(contentHash(fp, model));

    // The hash keys on inputHash (+ model), not the per-scan timestamp.
    expect(extractHash(renderProjectMemory({ ...fp, scannedAt: 'later' }, model))).toBe(extractHash(md));
    expect(extractHash(renderProjectMemory({ ...fp, inputHash: 'xyz' }, model))).not.toBe(extractHash(md));
  });

  it('reports an empty boundary model gracefully', () => {
    const md = renderProjectMemory(fp, { modules: [], couplingHotspots: [], godModules: [], cycles: [] });
    expect(md).toContain('No module topology yet');
    expect(md).toContain('_None — module graph is acyclic._');
  });
});
