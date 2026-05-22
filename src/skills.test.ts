import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdSkills } from './commands';
import { buildRuntime, type Runtime } from './runtime';

const POLICY = readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8');

let dir: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A repo with a real policy and zero or more `.archon/plugins/<name>/plugin.mjs`. */
async function runtimeWith(plugins: Record<string, string> = {}): Promise<Runtime> {
  dir = await mkdtemp(join(tmpdir(), 'archon-skills-cmd-'));
  await mkdir(join(dir, '.archon'), { recursive: true });
  await writeFile(join(dir, '.archon/policy.yaml'), POLICY);
  for (const [name, src] of Object.entries(plugins)) {
    await mkdir(join(dir, '.archon/plugins', name), { recursive: true });
    await writeFile(join(dir, '.archon/plugins', name, 'plugin.mjs'), src);
  }
  return buildRuntime(dir);
}

const captured = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
const text = (log: ReturnType<typeof captured>): string => log.mock.calls.flat().join('\n');

const skillPlugin = (name: string, version: string, playbook: string): string =>
  `export const plugin = { kind: 'skill', manifest: { name: '${name}', version: '${version}', kind: 'skill', capabilities: [] }, playbook: ${JSON.stringify(playbook)} };\n`;
// A tool plugin that must never appear in `skills` output (the kind filter excludes it).
const toolPlugin = `export const plugin = { kind: 'tool', manifest: { name: 'echo', version: '1.0.0', kind: 'tool', capabilities: ['fs.read'] }, run: async (i) => i };\n`;

describe('archon skills command', () => {
  it('lists skill plugins with a one-line playbook preview, ignoring other kinds', async () => {
    const rt = await runtimeWith({
      refactor: skillPlugin('refactor', '1.2.0', '# Refactor safely\n1. extract\n2. test'),
      echo: toolPlugin,
    });
    const log = captured();
    await cmdSkills(rt);
    const out = text(log);

    expect(out).toContain('1 loaded'); // the tool plugin is excluded from the count
    expect(out).toContain('refactor@1.2.0');
    expect(out).toContain('# Refactor safely'); // first non-empty line shown as the preview
    expect(out).not.toContain('echo'); // a non-skill kind never appears
    rt.close();
  });

  it("prints a named skill's full playbook", async () => {
    const rt = await runtimeWith({
      refactor: skillPlugin('refactor', '1.2.0', '# Refactor safely\n1. extract a function\n2. run the tests'),
    });
    const log = captured();
    await cmdSkills(rt, 'refactor');
    const out = text(log);

    expect(out).toContain('skill: refactor@1.2.0');
    expect(out).toContain('1. extract a function'); // the whole playbook, not just the first line
    expect(out).toContain('2. run the tests');
    rt.close();
  });

  it('reports an unknown skill name, listing the ones that are loaded', async () => {
    const rt = await runtimeWith({ refactor: skillPlugin('refactor', '1.0.0', 'do the thing') });
    const log = captured();
    await cmdSkills(rt, 'ghost');
    const out = text(log);

    expect(out).toContain('no skill "ghost"');
    expect(out).toContain('refactor'); // the loaded set is surfaced to guide the next try
    rt.close();
  });

  it('reports when no skills are loaded', async () => {
    const rt = await runtimeWith();
    const log = captured();
    await cmdSkills(rt);
    expect(text(log)).toContain('none loaded');
    rt.close();
  });
});
