import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeStructure, formatFingerprint } from './structural-analyzer';

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function scaffold(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'archon-struct-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'));
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

const pkg = (obj: unknown) => JSON.stringify(obj);

describe('analyzeStructure', () => {
  it('detects a single TypeScript package with npm + vitest + tsc', async () => {
    const root = await scaffold({
      'package.json': pkg({
        main: 'dist/index.js',
        scripts: { build: 'tsc', test: 'vitest run' },
        devDependencies: { vitest: '^4', typescript: '^6' },
      }),
      'package-lock.json': '{}',
      'tsconfig.json': '{}',
      'src/index.ts': 'export const x = 1;',
    });

    const fp = await analyzeStructure(root);
    expect(fp.layout).toBe('single');
    expect(fp.packageManager).toBe('npm');
    expect(fp.languages).toContain('typescript');
    expect(fp.buildSystem).toContain('tsc');
    expect(fp.testRunners).toEqual(['vitest']);
    expect(fp.entryPoints).toEqual(expect.arrayContaining(['dist/index.js', 'src/index.ts']));
  });

  it('detects a pnpm monorepo and react/next frameworks', async () => {
    const root = await scaffold({
      'package.json': pkg({ dependencies: { next: '^15', react: '^19' } }),
      'pnpm-lock.yaml': '',
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
      'next.config.js': 'module.exports = {};',
    });

    const fp = await analyzeStructure(root);
    expect(fp.packageManager).toBe('pnpm');
    expect(fp.layout).toBe('monorepo');
    expect(fp.workspaces).toEqual(['apps/*', 'packages/*']);
    expect(fp.frameworks).toEqual(expect.arrayContaining(['next', 'react']));
    expect(fp.buildSystem).toContain('next');
  });

  it('detects github-actions CI and yarn from the lockfile', async () => {
    const root = await scaffold({
      'package.json': pkg({ dependencies: { express: '^4' } }),
      'yarn.lock': '',
      '.github/workflows/ci.yml': 'name: ci',
    });

    const fp = await analyzeStructure(root);
    expect(fp.packageManager).toBe('yarn');
    expect(fp.ci).toEqual(['github-actions']);
    expect(fp.frameworks).toEqual(['express']);
  });

  it('infers DDD style from domain/application/infrastructure dirs', async () => {
    const root = await scaffold({
      'package.json': pkg({}),
      'src/domain/entity.ts': '',
      'src/application/service.ts': '',
      'src/infrastructure/db.ts': '',
    });

    const fp = await analyzeStructure(root);
    expect(fp.architecturalStyle).toBe('ddd');
    expect(fp.topDirectories).toEqual(['application', 'domain', 'infrastructure']);
  });

  it('infers modular-monolith from 3+ unrecognised module dirs', async () => {
    const root = await scaffold({
      'package.json': pkg({}),
      'src/sensing/a.ts': '',
      'src/memory/b.ts': '',
      'src/cognition/c.ts': '',
    });

    const fp = await analyzeStructure(root);
    expect(fp.architecturalStyle).toBe('modular-monolith');
  });

  it('detects a rust crate with cargo, no package.json', async () => {
    const root = await scaffold({
      'Cargo.toml': '[package]\nname = "x"\n',
      'src/lib.rs': '',
    });

    const fp = await analyzeStructure(root);
    expect(fp.languages).toEqual(['rust']);
    expect(fp.buildSystem).toEqual(['cargo']);
    expect(fp.packageManager).toBe('unknown');
  });

  it('detects rust from a nested crate manifest (hybrid TS+Rust repo)', async () => {
    const root = await scaffold({
      'package.json': pkg({}),
      'tsconfig.json': '{}',
      'src/index.ts': '',
      'crates/core/Cargo.toml': '[package]\nname = "core"\n',
    });

    const fp = await analyzeStructure(root);
    expect(fp.languages).toEqual(expect.arrayContaining(['typescript', 'rust']));
    expect(fp.buildSystem).toEqual(expect.arrayContaining(['tsc', 'cargo']));
  });

  it('honours the package.json packageManager field over lockfiles', async () => {
    const root = await scaffold({
      'package.json': pkg({ packageManager: 'npm@10.2.0' }),
      'bun.lock': '',
      'package-lock.json': '{}',
    });

    const fp = await analyzeStructure(root);
    expect(fp.packageManager).toBe('npm');
  });

  it('produces a stable inputHash for unchanged inputs', async () => {
    const files = { 'package.json': pkg({ name: 'x' }), 'tsconfig.json': '{}' };
    const a = await analyzeStructure(await scaffold(files));
    await rm(dir, { recursive: true, force: true });
    const b = await analyzeStructure(await scaffold(files));
    expect(a.inputHash).toBe(b.inputHash);
  });

  it('handles an empty directory without throwing', async () => {
    const root = await scaffold({});
    const fp = await analyzeStructure(root);
    expect(fp.packageManager).toBe('unknown');
    expect(fp.architecturalStyle).toBe('flat');
    expect(formatFingerprint(fp)).toContain('pkg manager');
  });
});
