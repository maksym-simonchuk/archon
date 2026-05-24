import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdDoctor } from './commands';
import { buildRuntime, type Runtime } from './runtime';

const POLICY = readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8');

let dir: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A temp repo with the real policy and an optional archon.config.json. */
async function runtimeWith(config?: object): Promise<Runtime> {
  dir = await mkdtemp(join(tmpdir(), 'archon-doctor-'));
  await mkdir(join(dir, '.archon'), { recursive: true });
  await writeFile(join(dir, '.archon/policy.yaml'), POLICY);
  if (config) await writeFile(join(dir, 'archon.config.json'), JSON.stringify(config));
  return buildRuntime(dir);
}

const captured = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
const text = (log: ReturnType<typeof captured>): string => log.mock.calls.flat().join('\n');

describe('archon doctor', () => {
  it('reports the offline scaffold planner and creates no db (read-only)', async () => {
    const rt = await runtimeWith();
    const log = captured();
    await cmdDoctor(rt);
    const out = text(log);

    expect(out).toContain('planner:   deterministic (scaffold)');
    expect(out).toContain('providers: none configured');
    expect(out).toContain('plugins:   0 loaded');
    // M30/M31/M39: surfaces are exposed but unauthorized in the default-deny
    // safe profile, so the line shows 0 configured · 0 grant(s) but the
    // inbound tool/method counts remain non-zero (compiled-in surface).
    expect(out).toContain('mcp:       0 outbound configured · 0 grant(s) · 4 inbound tools');
    expect(out).toContain('lsp:       3 methods exposed (read-only)');
    expect(out).toContain('index:   absent');
    expect(out).toContain('health:    no index'); // no index ⇒ no health score
    // probing existence must not open (create) any db
    expect(existsSync(join(rt.root, '.archon/index.db'))).toBe(false);
    expect(existsSync(join(rt.root, '.archon/memory.db'))).toBe(false);
    rt.close();
  });

  it('flags a configured provider whose key is absent from the env', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', ''); // empty ⇒ treated as missing
    const rt = await runtimeWith({ providers: [{ id: 'anthropic', models: ['claude-haiku-4-5-20251001'] }] });
    const log = captured();
    await cmdDoctor(rt);
    expect(text(log)).toContain('anthropic: key missing');
    rt.close();
  });

  it('emits a single valid JSON document with --json', async () => {
    const rt = await runtimeWith();
    const log = captured();
    await cmdDoctor(rt, { json: true });

    const report = JSON.parse(text(log)); // throws if not exactly one JSON document
    expect(report.planner).toBe('deterministic');
    expect(report.providers).toEqual([]);
    expect(report.state).toEqual({ index: false, memory: false, journal: false });
    expect(report.plugins).toBe(0);
    // Stable automation contract for the M30/M31/M39 surfaces (ADR-0020):
    // a fresh repo has no outbound config + no grants, but the inbound
    // surfaces (tools/methods) are part of the binary so the counts hold.
    expect(report.integrations).toEqual({
      mcpOutbound: { configured: 0, grants: 0 },
      mcpInbound: { tools: 4 },
      lspInbound: { methods: 3 },
    });
    expect(report.health).toBeNull(); // no index to assess
    expect(report.evolution).toBeNull(); // no index ⇒ no evolution forecast
    // probing existence for the JSON path must still create no db
    expect(existsSync(join(rt.root, '.archon/index.db'))).toBe(false);
    rt.close();
  });

  it('surfaces a health trend and evolution forecast once an index exists (M15)', async () => {
    const rt = await runtimeWith();
    const { store, close } = await rt.indexer();
    // Two recorded scans → a trend; a near-god module record → an evolution lookup target.
    store.appendHealthSnapshot({ ts: '2026-01-01T00:00:00Z', inputHash: 'h1', score: 90, high: 0, medium: 1, low: 2 });
    store.appendHealthSnapshot({ ts: '2026-02-01T00:00:00Z', inputHash: 'h2', score: 94, high: 0, medium: 0, low: 2 });
    close();

    const log = captured();
    await cmdDoctor(rt, { json: true });
    const report = JSON.parse(text(log));

    expect(report.health.trend).toBe(4); // 94 − 90 across the last two scans
    expect(report.evolution).not.toBeNull(); // index present ⇒ forecast computed (temp repo: 0 commits)
    expect(report.evolution.commitsAnalyzed).toBe(0);
    rt.close();
  });
});
