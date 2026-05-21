import type { Profile, TaskClass } from '../core/types';
import { notImplemented } from '../core/result';

export interface ArchonConfig {
  profile: Profile;
  providers: { id: string; models: string[] }[];
  routing: Partial<Record<TaskClass, string>> & { fallback: string[] };
  budgets: { perTaskUsd: number; globalDailyUsd: number; contextTokensMax: number };
  paths: { policy: string; journal: string; memory: string };
}

/** Loads + validates archon.config.json and .archon/policy.yaml from `root`. */
export async function loadConfig(_root: string): Promise<ArchonConfig> {
  return notImplemented('loadConfig', 'M0');
}
