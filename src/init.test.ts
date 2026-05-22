import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdInit } from './init';
import { MemoryStore } from './memory/store';
import { buildRuntime } from './runtime';
import { IndexStore } from './sensing/store';

let dir: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('cmdInit (archon init)', () => {
  it('scaffolds a usable repo that buildRuntime accepts', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-init-'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await cmdInit(dir);

    expect(existsSync(join(dir, '.archon/policy.yaml'))).toBe(true);
    expect(existsSync(join(dir, '.archon/README.md'))).toBe(true);
    expect(existsSync(join(dir, 'archon.config.json'))).toBe(true);

    const cfg = JSON.parse(await readFile(join(dir, 'archon.config.json'), 'utf8'));
    expect(cfg).toMatchObject({ profile: 'safe', providers: [] });

    // The runtime boots against the freshly-scaffolded policy.
    const rt = await buildRuntime(dir);
    expect(rt.llmPlanning).toBe(false);
    rt.close();
  });

  it('runs the structural deep scan and persists a fingerprint', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-init-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^4' } }));
    await writeFile(join(dir, 'tsconfig.json'), '{}');

    await cmdInit(dir);

    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('structural fingerprint');
    expect(output).toContain('typescript');

    // The fingerprint is readable from the index, and a re-run is a no-op.
    const store = new IndexStore(join(dir, '.archon', 'index.db'));
    const first = store.getFingerprint();
    expect(first?.languages).toContain('typescript');
    store.close();

    log.mockClear();
    await cmdInit(dir); // re-run: unchanged inputs ⇒ skip persist, still report
    const second = log.mock.calls.flat().join('\n');
    expect(second).toContain('structural fingerprint (unchanged)');
    expect(second).toContain('project memory (unchanged)');
  });

  it('generates the project-memory file + intelligence layer (M10)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-init-'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^4' } }));
    await writeFile(join(dir, 'tsconfig.json'), '{}');

    await cmdInit(dir);

    const memory = await readFile(join(dir, '.archon/project-memory.md'), 'utf8');
    expect(memory).toContain('<!-- archon:generated');
    expect(memory).toContain('**Package manager:** npm');

    // The machine-readable intelligence layer is persisted alongside it.
    const store = new IndexStore(join(dir, '.archon', 'index.db'));
    expect(store.loadModuleIntelligence()).toBeDefined();
    store.close();
  });

  it('ingests ADRs into pinned semantic decision memory (M16)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-init-'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await mkdir(join(dir, 'docs/adr'), { recursive: true });
    await writeFile(
      join(dir, 'docs/adr/0001-record-decisions.md'),
      '# 0001 — Record decisions\n\n- Status: accepted\n\n## Decision\n\nKeep ADRs in docs/adr.\n',
    );
    await writeFile(join(dir, 'docs/adr/template.md'), '# NNNN — <title>\n'); // must be skipped

    await cmdInit(dir);

    const store = new MemoryStore(join(dir, '.archon', 'memory.db'));
    const semantic = store.list('semantic');
    store.close();
    expect(semantic).toHaveLength(1); // the ADR, not the template
    expect(semantic[0]).toMatchObject({ key: 'Record decisions', confirmed: true });
    expect(semantic[0].content).toContain('ADR-0001 [accepted]');
  });

  it('creates no memory store when the repo has no ADRs', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-init-'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await cmdInit(dir);
    expect(existsSync(join(dir, '.archon/memory.db'))).toBe(false);
  });

  it('refuses to clobber an existing policy', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-init-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await cmdInit(dir);

    const policyPath = join(dir, '.archon/policy.yaml');
    await writeFile(policyPath, 'version: 0\nactive_profile: trusted\nprofiles: {}\n'); // user edit
    log.mockClear();

    await cmdInit(dir); // second init — must not overwrite
    expect(log.mock.calls.flat().join('\n')).toContain('already initialized');
    expect(await readFile(policyPath, 'utf8')).toContain('active_profile: trusted');
  });
});
