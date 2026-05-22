import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdTool } from './commands';
import { buildRuntime, type Runtime } from './runtime';

const POLICY = readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8');

let dir: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function runtimeWith(plugins: Record<string, string>): Promise<Runtime> {
  dir = await mkdtemp(join(tmpdir(), 'archon-tool-'));
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

// fs.read is granted under the safe profile; net is only *asked* → refused.
const echoPlugin =
  `export const plugin = { kind: 'tool', manifest: { name: 'echo', version: '1.0.0', kind: 'tool', capabilities: ['fs.read'] }, run: async (i) => ({ echoed: i }) };\n`;
const netPlugin =
  `export const plugin = { kind: 'tool', manifest: { name: 'fetcher', version: '0.2.0', kind: 'tool', capabilities: ['net'] }, run: async () => 'should not run' };\n`;

describe('archon tool command', () => {
  it('invokes a tool whose capability the policy grants, parsing JSON input', async () => {
    const rt = await runtimeWith({ echo: echoPlugin });
    const log = captured();
    await cmdTool(rt, 'echo', '{"n":42}');
    expect(text(log)).toContain('tool echo: {"echoed":{"n":42}}');
    rt.close();
  });

  it('refuses a tool whose declared capability the policy will not grant', async () => {
    const rt = await runtimeWith({ fetcher: netPlugin });
    const log = captured();
    await cmdTool(rt, 'fetcher', undefined);
    const out = text(log);
    expect(out).toContain('refused');
    expect(out).toContain('policy.ask');
    rt.close();
  });

  it('reports an unknown tool and rejects malformed JSON input', async () => {
    const rt = await runtimeWith({ echo: echoPlugin });
    const log = captured();
    await cmdTool(rt, 'ghost', undefined);
    expect(text(log)).toContain('plugin.unknown');

    log.mockClear();
    await cmdTool(rt, 'echo', '{not json');
    expect(text(log)).toContain('not valid JSON');
    rt.close();
  });
});
