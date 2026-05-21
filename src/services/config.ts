import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Profile, TaskClass } from '../core/types';

export interface ArchonConfig {
  profile: Profile;
  providers: { id: string; models: string[] }[];
  routing: Partial<Record<TaskClass, string>> & { fallback: string[] };
  budgets: { perTaskUsd: number; globalDailyUsd: number; contextTokensMax: number };
  paths: { policy: string; journal: string; memory: string; index: string };
}

/** Built-in defaults; budgets mirror the hard limits in `.archon/policy.yaml`. */
const DEFAULTS: ArchonConfig = {
  profile: 'safe',
  providers: [],
  routing: { fallback: [] },
  budgets: { perTaskUsd: 2, globalDailyUsd: 25, contextTokensMax: 60_000 },
  paths: {
    policy: '.archon/policy.yaml',
    journal: '.archon/journal.db',
    memory: '.archon/memory.db',
    index: '.archon/index.db',
  },
};

const isProfile = (v: unknown): v is Profile => v === 'safe' || v === 'trusted';

/**
 * Load `archon.config.json` from `root` (optional) and merge it over the
 * built-in defaults. A missing file is not an error — defaults stand. The active
 * `.archon/policy.yaml` remains the machine-enforced safety contract; this config
 * only carries non-safety knobs (provider registry, routing, budgets, paths).
 */
export async function loadConfig(root: string): Promise<ArchonConfig> {
  const file = join(root, 'archon.config.json');
  let user: Partial<ArchonConfig> = {};
  try {
    user = JSON.parse(await readFile(file, 'utf8')) as Partial<ArchonConfig>;
  } catch (e) {
    if (!(e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT')) {
      throw new Error(`[archon] failed to read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (user.profile !== undefined && !isProfile(user.profile)) {
    throw new Error(`[archon] archon.config.json: invalid profile "${String(user.profile)}"`);
  }

  return {
    profile: user.profile ?? DEFAULTS.profile,
    providers: user.providers ?? DEFAULTS.providers,
    routing: { ...DEFAULTS.routing, ...user.routing, fallback: user.routing?.fallback ?? DEFAULTS.routing.fallback },
    budgets: { ...DEFAULTS.budgets, ...user.budgets },
    paths: { ...DEFAULTS.paths, ...user.paths },
  };
}
