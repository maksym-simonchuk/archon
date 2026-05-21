import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('loadConfig (M0)', () => {
  it('returns built-in defaults when no archon.config.json exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-cfg-'));
    const config = await loadConfig(dir);
    expect(config.profile).toBe('safe');
    expect(config.budgets).toEqual({ perTaskUsd: 2, globalDailyUsd: 25, contextTokensMax: 60_000 });
    expect(config.paths.journal).toBe('.archon/journal.db');
  });

  it('merges a user config over the defaults', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-cfg-'));
    await writeFile(
      join(dir, 'archon.config.json'),
      JSON.stringify({ profile: 'trusted', budgets: { perTaskUsd: 10 } }),
    );
    const config = await loadConfig(dir);
    expect(config.profile).toBe('trusted');
    expect(config.budgets.perTaskUsd).toBe(10); // overridden
    expect(config.budgets.globalDailyUsd).toBe(25); // default preserved
  });

  it('rejects an invalid profile', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-cfg-'));
    await writeFile(join(dir, 'archon.config.json'), JSON.stringify({ profile: 'root' }));
    await expect(loadConfig(dir)).rejects.toThrow(/invalid profile/);
  });
});
