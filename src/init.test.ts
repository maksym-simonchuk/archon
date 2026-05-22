import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdInit } from './init';
import { buildRuntime } from './runtime';

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
