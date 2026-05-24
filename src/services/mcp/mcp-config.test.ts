import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMcpConfig, parseMcpConfig } from './mcp-config';

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('parseMcpConfig', () => {
  it('returns an empty list for an empty/null body or a body without `servers`', () => {
    expect(parseMcpConfig('').servers).toEqual([]);
    expect(parseMcpConfig('null').servers).toEqual([]);
    expect(parseMcpConfig('other: value').servers).toEqual([]);
  });

  it('parses a complete server entry with args + env', () => {
    const cfg = parseMcpConfig(`servers:
  - id: claude-code
    command: claude-mcp
    args: [--stdio]
    env:
      FOO: bar
`);
    expect(cfg.servers).toHaveLength(1);
    expect(cfg.servers[0]).toEqual({
      id: 'claude-code',
      command: 'claude-mcp',
      args: ['--stdio'],
      env: { FOO: 'bar' },
    });
  });

  it('omits args/env keys entirely when not provided (clean serialization)', () => {
    const cfg = parseMcpConfig(`servers:
  - id: minimal
    command: m
`);
    expect(cfg.servers[0]).toEqual({ id: 'minimal', command: 'm' });
    expect('args' in (cfg.servers[0] ?? {})).toBe(false);
  });

  it('rejects malformed entries with a path-prefixed error', () => {
    expect(() => parseMcpConfig(`servers:
  - id: ''
    command: m
`)).toThrow(/servers\[0\]\.id/);
    expect(() => parseMcpConfig(`servers:
  - id: ok
    command: c
    args: "not-an-array"
`)).toThrow(/servers\[0\]\.args must be a string\[\]/);
  });

  it('rejects duplicate ids — the client keys records by id', () => {
    expect(() => parseMcpConfig(`servers:
  - id: dup
    command: a
  - id: dup
    command: b
`)).toThrow(/duplicate server id "dup"/);
  });
});

describe('loadMcpConfig', () => {
  it('returns an empty list when no .archon/mcp.yaml exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-mcp-cfg-'));
    const cfg = await loadMcpConfig(dir);
    expect(cfg.servers).toEqual([]);
  });

  it('reads and validates an existing config file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-mcp-cfg-'));
    await mkdir(join(dir, '.archon'), { recursive: true });
    await writeFile(
      join(dir, '.archon/mcp.yaml'),
      `servers:
  - id: archon
    command: node
    args: [dist/cli.js, mcp]
`,
    );
    const cfg = await loadMcpConfig(dir);
    expect(cfg.servers).toEqual([{ id: 'archon', command: 'node', args: ['dist/cli.js', 'mcp'] }]);
  });

  it('surfaces malformed YAML with a useful path prefix', async () => {
    dir = await mkdtemp(join(tmpdir(), 'archon-mcp-cfg-'));
    await mkdir(join(dir, '.archon'), { recursive: true });
    await writeFile(join(dir, '.archon/mcp.yaml'), 'servers: not-a-list');
    await expect(loadMcpConfig(dir)).rejects.toThrow(/"servers" must be a sequence/);
  });
});
