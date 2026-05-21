import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CapabilityAction } from '../core/types';
import { AuditLog } from '../effecting/audit-log';
import { CapabilityBroker } from '../effecting/capability-broker';
import { loadPolicy, PolicyEngine } from '../effecting/policy-engine';
import type { Plugin, ToolPlugin } from '../plugins/abi';
import { PluginHost } from './plugin-host';

const doc = loadPolicy(readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8'));
const broker = (): CapabilityBroker =>
  new CapabilityBroker(new PolicyEngine(doc, 'safe'), new AuditLog(), process.cwd());

const tool = (
  name: string,
  capabilities: CapabilityAction[],
  run: ToolPlugin['run'] = async (i) => i,
): Plugin => ({ kind: 'tool', manifest: { name, version: '0.0.0', kind: 'tool', capabilities }, run });

describe('PluginHost (M7)', () => {
  it('runs a tool whose declared capabilities the policy grants', async () => {
    const host = new PluginHost(broker());
    host.register(tool('reader', ['fs.read'], async (i) => ({ echoed: i })));
    const res = await host.invokeTool('reader', 42);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ echoed: 42 });
  });

  it('refuses a tool that declares a capability the policy will not grant', async () => {
    const host = new PluginHost(broker());
    host.register(tool('net-tool', ['net'])); // safe profile only *asks* on net
    const res = await host.invokeTool('net-tool', null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('policy.ask');
  });

  it('rejects duplicates + invalid manifests, and refuses unknown plugins', async () => {
    const host = new PluginHost(broker());
    host.register(tool('dup', ['fs.read']));
    expect(() => host.register(tool('dup', ['fs.read']))).toThrow(/duplicate/);
    expect(() => host.register(tool('bad', ['nope'] as unknown as CapabilityAction[]))).toThrow(/capability/);
    expect((await host.invokeTool('ghost', null)).ok).toBe(false);
  });

  it('loads plugins from <dir>/<name>/plugin.mjs and runs them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archon-plugins-'));
    try {
      await mkdir(join(dir, 'echo'));
      await writeFile(
        join(dir, 'echo', 'plugin.mjs'),
        `export const plugin = { kind: 'tool', manifest: { name: 'echo', version: '0.0.0', kind: 'tool', capabilities: ['fs.read'] }, run: async (i) => i };\n`,
      );
      const host = new PluginHost(broker());
      const loaded = await host.load(dir);
      expect(loaded.map((p) => p.manifest.name)).toEqual(['echo']);
      const res = await host.invokeTool('echo', 'hi');
      expect(res.ok && res.value).toBe('hi');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
