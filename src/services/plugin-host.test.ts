import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CapabilityAction } from '../core/types';
import { AuditLog } from '../effecting/audit-log';
import { CapabilityBroker } from '../effecting/capability-broker';
import { loadPolicy, PolicyEngine } from '../effecting/policy-engine';
import type { Plugin, ProviderPlugin, RetrieverPlugin, ToolPlugin, VerifierPlugin } from '../plugins/abi';
import { PluginHost } from './plugin-host';

const doc = loadPolicy(readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8'));
const broker = (): CapabilityBroker =>
  new CapabilityBroker(new PolicyEngine(doc, 'safe'), new AuditLog(), process.cwd());

const tool = (
  name: string,
  capabilities: CapabilityAction[],
  run: ToolPlugin['run'] = async (i) => i,
): Plugin => ({ kind: 'tool', manifest: { name, version: '0.0.0', kind: 'tool', capabilities }, run });

const verifier = (name: string, capabilities: CapabilityAction[], verify: VerifierPlugin['verify']): Plugin => ({
  kind: 'verifier',
  manifest: { name, version: '0.0.0', kind: 'verifier', capabilities },
  verify,
});

const provider = (name: string, capabilities: CapabilityAction[], complete: ProviderPlugin['complete']): Plugin => ({
  kind: 'provider',
  manifest: { name, version: '0.0.0', kind: 'provider', capabilities },
  complete,
});
const echoComplete: ProviderPlugin['complete'] = async (req) => ({
  modelId: 'plugin',
  text: req.prompt,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  cached: false,
});

const retriever = (name: string, capabilities: CapabilityAction[], retrieve: RetrieverPlugin['retrieve']): Plugin => ({
  kind: 'retriever',
  manifest: { name, version: '0.0.0', kind: 'retriever', capabilities },
  retrieve,
});

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

describe('PluginHost.runVerifiers (M7)', () => {
  it('runs granted verifier plugins, one verdict each, ignoring non-verifiers', async () => {
    const host = new PluginHost(broker());
    host.register(tool('reader', ['fs.read'])); // a tool — must not be run as a verifier
    host.register(
      verifier('shape', ['fs.read'], async (files) => ({
        passed: files.includes('src/a.ts'),
        checks: [{ name: 'shape', passed: files.includes('src/a.ts') }],
      })),
    );
    const verdicts = await host.runVerifiers(['src/a.ts']);
    expect(verdicts).toHaveLength(1); // only the verifier kind participates
    expect(verdicts[0]?.passed).toBe(true); // and it received the changed files
  });

  it('treats a throwing verifier as a failed verdict (fail-safe, blocks the merge)', async () => {
    const host = new PluginHost(broker());
    host.register(
      verifier('boom', ['fs.read'], async () => {
        throw new Error('verifier crashed');
      }),
    );
    const [verdict] = await host.runVerifiers([]);
    expect(verdict?.passed).toBe(false);
    expect(verdict?.checks[0]?.output).toContain('verifier crashed');
  });

  it('skips a verifier whose capability the policy will not grant (inert, not blocking)', async () => {
    const host = new PluginHost(broker());
    // safe profile only *asks* on net, so this verifier is refused → excluded.
    host.register(verifier('net-verifier', ['net'], async () => ({ passed: false, checks: [] })));
    expect(await host.runVerifiers([])).toEqual([]);
  });
});

describe('PluginHost.providerPlugins (ADR-0012)', () => {
  it('returns only provider plugins the policy grants, excluding other kinds', async () => {
    const host = new PluginHost(broker());
    host.register(provider('local', ['fs.read'], echoComplete)); // granted under safe
    host.register(provider('remote', ['net'], echoComplete)); // safe only asks on net → refused
    host.register(verifier('v', ['fs.read'], async () => ({ passed: true, checks: [] }))); // wrong kind
    const provs = await host.providerPlugins();
    expect(provs.map((p) => p.manifest.name)).toEqual(['local']);
  });
});

describe('PluginHost.runRetrievers', () => {
  it('flattens hits from granted retrievers, skipping other kinds and refused ones', async () => {
    const host = new PluginHost(broker());
    host.register(retriever('docs', ['fs.read'], async (q, k) => [`docs:${q}:${k}`]));
    host.register(retriever('net-r', ['net'], async () => ['SHOULD-NOT-APPEAR'])); // refused under safe
    host.register(verifier('v', ['fs.read'], async () => ({ passed: true, checks: [] }))); // wrong kind
    expect(await host.runRetrievers('q', 3)).toEqual(['docs:q:3']);
  });

  it('a throwing retriever contributes nothing (fail-safe), others still count', async () => {
    const host = new PluginHost(broker());
    host.register(
      retriever('boom', ['fs.read'], async () => {
        throw new Error('down');
      }),
    );
    host.register(retriever('ok', ['fs.read'], async () => ['hit']));
    expect(await host.runRetrievers('q', 1)).toEqual(['hit']);
  });
});
