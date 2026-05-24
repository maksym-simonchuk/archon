/**
 * Archon read-only tools exposed through MCP (M31). Other agents (Claude
 * Code, Cursor, Codex) call these via JSON-RPC to leverage Archon's
 * intelligence — blast radius, symbol explanation, architecture violations,
 * repo map — without writing anything. Every tool is `mutating: false` and
 * opens the existing IndexStore read-only (existsSync-guarded so a fresh
 * repo with no index returns an empty report instead of throwing).
 *
 * Per ADR-0015 invariant 9 the MCP server exposes a strict read-only subset
 * by default; mutating tools require an explicit `mutatingEnabled:true` on
 * the server (which itself sits behind the `mcp:<server>:<tool>` capability
 * gate when this Archon instance calls *out*). These tools are the inbound
 * side — they don't go through the broker because they only read the index;
 * a tool that *did* perform a side effect would route through `rt.brokerAt`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Runtime } from '../../runtime';
import { IndexStore } from '../../sensing/store';
import { SymbolGraph } from '../../sensing/symbol-graph';
import { detectViolations } from '../../sensing/violations';
import { inferBoundaries } from '../../sensing/boundaries';
import type { McpCallToolResult, McpToolDescription } from './protocol';
import type { ServerTool } from './server';

/** Pure result type for the blast-radius tool. */
interface BlastRadiusOutput {
  target: string;
  seeds: string[];
  dependents: string[];
  files: string[];
  indexed: boolean;
}

/** Pure result type for the explain tool. */
interface ExplainOutput {
  query: string;
  resolved: string | null;
  kind: string | null;
  file: string | null;
  dependsOn: { name: string; kind: string }[];
  dependedOnBy: { name: string; kind: string }[];
  candidates: string[];
}

/** A typed args parser that throws an MCP-style invalid-params error. */
function requireString(args: unknown, key: string): string {
  if (!args || typeof args !== 'object' || !(key in args)) {
    throw new Error(`missing required argument: ${key}`);
  }
  const v = (args as Record<string, unknown>)[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${key} must be a non-empty string`);
  return v;
}

/** The segment after `#` in a qualified id (`src/x.ts#foo` → `foo`); the whole string if unqualified. */
const bareName = (qualified: string): string => qualified.slice(qualified.indexOf('#') + 1);

/** Open the index for `rt` and run `body`, or return `whenMissing` if the index doesn't exist yet. */
function withIndex<T>(rt: Runtime, body: (store: IndexStore) => T, whenMissing: () => T): T {
  const indexPath = join(rt.root, rt.config.paths.index);
  if (!existsSync(indexPath)) return whenMissing();
  const store = new IndexStore(indexPath);
  try {
    return body(store);
  } finally {
    store.close();
  }
}

/** Wrap a pure JSON payload in the MCP tool-result envelope (text block fallback for non-JSON clients). */
function ok<T>(payload: T): McpCallToolResult {
  return {
    content: [
      { type: 'json', json: payload as unknown },
      { type: 'text', text: JSON.stringify(payload, null, 2) },
    ],
  };
}

const BLAST_RADIUS_DESC: McpToolDescription = {
  name: 'archon.blastRadius',
  description: 'Reverse-reachability: every symbol and file transitively affected if `target` changes.',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'A file path (seeds every symbol it defines) or a single symbol id.' },
    },
    required: ['target'],
  },
};

const EXPLAIN_DESC: McpToolDescription = {
  name: 'archon.explain',
  description: 'One-hop neighborhood of `query`: where it is defined, what it depends on, what depends on it.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'A qualified id (`src/x.ts#foo`) or a bare symbol name.' },
    },
    required: ['query'],
  },
};

const VIOLATIONS_DESC: McpToolDescription = {
  name: 'archon.violations',
  description: 'Architecture-health findings ranked by severity × impact. Returns an empty list if the repo is clean.',
  inputSchema: { type: 'object', properties: {} },
};

const MAP_DESC: McpToolDescription = {
  name: 'archon.map',
  description: 'Repo overview: file/symbol/edge counts, edge-kind breakdown, most depended-on symbols.',
  inputSchema: { type: 'object', properties: {} },
};

/** Compute the blast-radius report for a target. Pure beyond the IndexStore read. */
async function computeBlastRadius(rt: Runtime, target: string): Promise<BlastRadiusOutput> {
  const empty: BlastRadiusOutput = { target, seeds: [], dependents: [], files: [], indexed: false };
  return withIndex(
    rt,
    async (store): Promise<BlastRadiusOutput> => {
      const all = store.allSymbols();
      const fileSeeds = all.filter((s) => s.file === target).map((s) => s.name);
      const seeds = fileSeeds.length > 0 ? fileSeeds : all.filter((s) => s.name === target).map((s) => s.name);
      if (seeds.length === 0) {
        const indexed = store.allFileHashes().some((f) => f.path === target);
        return { target, seeds: [], dependents: [], files: [], indexed };
      }
      const radius = await new SymbolGraph(store).blastRadius(seeds);
      const dependents = radius.symbols.filter((s) => !seeds.includes(s));
      return { target, seeds, dependents, files: radius.files, indexed: true };
    },
    async () => empty,
  );
}

/** Compute the explain report for a query. Pure beyond the IndexStore read. */
function computeExplain(rt: Runtime, query: string): ExplainOutput {
  const empty = (candidates: string[] = []): ExplainOutput => ({
    query,
    resolved: null,
    kind: null,
    file: null,
    dependsOn: [],
    dependedOnBy: [],
    candidates,
  });
  return withIndex(
    rt,
    (store): ExplainOutput => {
      const all = store.allSymbols();
      const exact = all.find((s) => s.name === query);
      const matches = exact ? [exact] : all.filter((s) => bareName(s.name) === query);
      if (matches.length === 0) return empty();
      if (matches.length > 1) return empty(matches.map((m) => m.name));
      const hit = matches[0];
      if (!hit) return empty();
      const neighbors = new SymbolGraph(store).neighbors(hit.name);
      return {
        query,
        resolved: hit.name,
        kind: hit.kind,
        file: hit.file,
        dependsOn: neighbors.dependsOn.map((e) => ({ name: e.name, kind: e.kind })),
        dependedOnBy: neighbors.dependedOnBy.map((e) => ({ name: e.name, kind: e.kind })),
        candidates: [],
      };
    },
    () => empty(),
  );
}

/** Compute the violations report. Pure beyond the IndexStore read. */
function computeViolations(rt: Runtime): ReturnType<typeof detectViolations> {
  const emptyReport = {
    violations: [],
    healthScore: 100,
    countsBySeverity: { high: 0, medium: 0, low: 0 },
  } as ReturnType<typeof detectViolations>;
  return withIndex(
    rt,
    (store): ReturnType<typeof detectViolations> => {
      const files = store.allFileHashes();
      const edges = store.loadFileEdges();
      const model = store.loadModuleIntelligence() ?? inferBoundaries(files, edges);
      return detectViolations({
        model,
        files,
        edges,
        definedFiles: new Set(store.allSymbols().map((s) => s.file)),
      });
    },
    () => emptyReport,
  );
}

interface MapOutput {
  files: number;
  symbols: number;
  edges: number;
  edgesByKind: Record<string, number>;
  hot: { name: string; dependents: number }[];
}

/** Compute the map report. Pure beyond the IndexStore read. */
function computeMap(rt: Runtime): MapOutput {
  const empty: MapOutput = { files: 0, symbols: 0, edges: 0, edgesByKind: {}, hot: [] };
  return withIndex(
    rt,
    (store): MapOutput => {
      const files = store.allFileHashes().length;
      const symbols = store.allSymbols();
      const edges = store.loadEdges();
      const byKind = new Map<string, number>();
      for (const e of edges) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
      return {
        files,
        symbols: symbols.length,
        edges: edges.length,
        edgesByKind: Object.fromEntries(byKind),
        hot: new SymbolGraph(store).hotNodes(10),
      };
    },
    () => empty,
  );
}

/**
 * Build the read-only Archon tool set for an `McpServer`. Pass to
 * `new McpServer(io, { name, version, tools: archonReadOnlyTools(rt) })`.
 * All tools are `mutating: false` so they are visible by default and never
 * touched by the `mutatingEnabled` gate. They open the runtime's IndexStore
 * directly (existsSync-guarded); a fresh repo with no index returns the
 * shape's zero-value envelope rather than throwing.
 */
export function archonReadOnlyTools(rt: Runtime): ServerTool[] {
  return [
    {
      desc: BLAST_RADIUS_DESC,
      mutating: false,
      async invoke(args: unknown): Promise<McpCallToolResult> {
        const target = requireString(args, 'target');
        const out = await computeBlastRadius(rt, target);
        return ok(out);
      },
    },
    {
      desc: EXPLAIN_DESC,
      mutating: false,
      async invoke(args: unknown): Promise<McpCallToolResult> {
        const query = requireString(args, 'query');
        return ok(computeExplain(rt, query));
      },
    },
    {
      desc: VIOLATIONS_DESC,
      mutating: false,
      async invoke(): Promise<McpCallToolResult> {
        return ok(computeViolations(rt));
      },
    },
    {
      desc: MAP_DESC,
      mutating: false,
      async invoke(): Promise<McpCallToolResult> {
        return ok(computeMap(rt));
      },
    },
  ];
}
