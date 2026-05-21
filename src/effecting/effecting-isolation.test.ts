import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Agent paths must hold zero ambient authority: only the broker may import the
// raw OS-effect modules. (Sensing's index bootstrap is infrastructure, not an
// agent path, and is intentionally out of scope here.)
const AGENT_DIRS = ['src/effecting', 'src/cognition'];
const ALLOWED_FS_IMPORTERS = new Set(['capability-broker.ts']);
const FORBIDDEN = /from ['"](?:node:)?(?:fs|fs\/promises|child_process)['"]/;

async function tsModules(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsModules(p)));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('effecting isolation (M3)', () => {
  it('only the capability broker imports fs / child_process in agent paths', async () => {
    const offenders: string[] = [];
    for (const dir of AGENT_DIRS) {
      for (const file of await tsModules(dir)) {
        const src = await readFile(file, 'utf8');
        const base = file.split('/').pop() ?? file;
        if (FORBIDDEN.test(src) && !ALLOWED_FS_IMPORTERS.has(base)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
