/**
 * `.archon/mcp.yaml` loader for the MCP client (M30). Lists the external
 * MCP servers Archon can call *out* to. The actual transport (child-process
 * stdio, HTTP) is the caller's responsibility — this module only parses the
 * file. Per ADR-0015 every outbound MCP call is still gated by the
 * `mcp:<server>:<tool>` capability, so a server appearing here does not
 * imply authority; it implies *configured* — the policy still gates use.
 *
 * Shape (every field besides `id`+`command` is optional):
 *
 *     servers:
 *       - id: claude-code
 *         command: claude-mcp
 *         args: [--stdio]
 *         env:
 *           FOO: bar
 *
 * A missing file is *not* an error — `loadMcpConfig` returns `{ servers: [] }`.
 * The default-deny v2 policy (ADR-0015) keeps "no config" identical to "no
 * grants": clients are configured separately from being authorized.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

/** A single external MCP server entry. Transport details live alongside `command`. */
export interface McpServerConfig {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Top-level shape of `.archon/mcp.yaml`. */
export interface McpConfig {
  servers: McpServerConfig[];
}

const EMPTY: McpConfig = { servers: [] };

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/** Coerce one YAML node to an `McpServerConfig`; throws with a useful path on shape failure. */
function readServer(raw: unknown, index: number): McpServerConfig {
  if (!isRecord(raw)) throw new Error(`mcp.yaml: servers[${index}] must be a mapping`);
  const id = raw.id;
  const command = raw.command;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`mcp.yaml: servers[${index}].id must be a non-empty string`);
  }
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error(`mcp.yaml: servers[${index}].command must be a non-empty string`);
  }
  const argsRaw = raw.args;
  let args: string[] | undefined;
  if (argsRaw !== undefined) {
    if (!Array.isArray(argsRaw) || !argsRaw.every((a) => typeof a === 'string')) {
      throw new Error(`mcp.yaml: servers[${index}].args must be a string[]`);
    }
    args = argsRaw as string[];
  }
  const envRaw = raw.env;
  let env: Record<string, string> | undefined;
  if (envRaw !== undefined) {
    if (!isRecord(envRaw) || !Object.values(envRaw).every((v) => typeof v === 'string')) {
      throw new Error(`mcp.yaml: servers[${index}].env must be a string→string mapping`);
    }
    env = envRaw as Record<string, string>;
  }
  const out: McpServerConfig = { id, command };
  if (args !== undefined) out.args = args;
  if (env !== undefined) out.env = env;
  return out;
}

/**
 * Parse an `mcp.yaml` body. Pure (no fs). Exposed so the runtime composition
 * root and tests can validate config in-memory without writing a temp file.
 *
 * - Empty body / `null` / missing `servers` → `{ servers: [] }` (no error).
 * - Duplicate `id` → error (the client keys server records by id).
 */
export function parseMcpConfig(yamlText: string): McpConfig {
  const raw: unknown = parse(yamlText);
  if (raw === null || raw === undefined) return EMPTY;
  if (!isRecord(raw)) throw new Error('mcp.yaml: root must be a mapping');
  const serversRaw = raw.servers;
  if (serversRaw === undefined || serversRaw === null) return EMPTY;
  if (!Array.isArray(serversRaw)) throw new Error('mcp.yaml: "servers" must be a sequence');
  const servers = serversRaw.map(readServer);
  const seen = new Set<string>();
  for (const s of servers) {
    if (seen.has(s.id)) throw new Error(`mcp.yaml: duplicate server id "${s.id}"`);
    seen.add(s.id);
  }
  return { servers };
}

/**
 * Load `<root>/.archon/mcp.yaml`. Missing file → `{ servers: [] }`. Any other
 * read error (permission denied, malformed YAML, shape failure) propagates.
 */
export async function loadMcpConfig(root: string): Promise<McpConfig> {
  const path = join(root, '.archon', 'mcp.yaml');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw new Error(`[archon] failed to read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseMcpConfig(text);
}
