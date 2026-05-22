import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdPlugins } from './commands';
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
  dir = await mkdtemp(join(tmpdir(), 'archon-plugins-cmd-'));
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

const echoPlugin =
  `export const plugin = { kind: 'tool', manifest: { name: 'echo', version: '1.0.0', kind: 'tool', capabilities: ['fs.read'] }, run: async (i) => i };\n`;
const fetcherPlugin =
  `export const plugin = { kind: 'tool', manifest: { name: 'fetcher', version: '0.2.0', kind: 'tool', capabilities: ['net'] }, run: async () => null };\n`;

describe('archon plugins command', () => {
  it('lists loaded plugins, previewing each capability against the active policy', async () => {
    const rt = await runtimeWith({ echo: echoPlugin, fetcher: fetcherPlugin });
    const log = captured();
    await cmdPlugins(rt);
    const out = text(log);

    // safe profile grants repo reads but only *asks* on net — same gate as invokeTool.
    expect(out).toContain('echo@1.0.0');
    expect(out).toContain('fs.read=allow');
    expect(out).toContain('fetcher@0.2.0');
    expect(out).toContain('net=ask');
    // echo's only capability is allowed → runnable (✓); fetcher's net asks → ⚠.
    expect(out).toMatch(/✓ echo/);
    expect(out).toMatch(/⚠ fetcher/);
    rt.close();
  });

  it('reports an empty / missing plugin dir without error', async () => {
    const rt = await runtimeWith();
    const log = captured();
    await cmdPlugins(rt);
    expect(text(log)).toContain('none loaded');
    rt.close();
  });
});
