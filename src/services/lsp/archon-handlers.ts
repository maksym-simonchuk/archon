/**
 * Runtime-bound LSP handlers (M39). Wires `ArchonLspServer`'s custom methods
 * (`archon/blastRadius`, `archon/explain`, `archon/violations`) plus
 * `workspace/executeCommand` to real Archon implementations.
 *
 * Read-only by design: every handler opens the existing IndexStore through
 * the shared `compute*` primitives in `mcp/archon-tools.ts`, so the LSP
 * bridge and the MCP server return the *same* shape for the same query —
 * no chance of one surface drifting from the other.
 *
 * `executeCommand` mediates *any* named command. The default dispatch only
 * exposes the read-only verbs (`archon.blastRadius`, `archon.explain`,
 * `archon.violations`); a request for any other command throws so the
 * caller knows it isn't bound (ADR-0015 invariant 9 — server exposes
 * read-only by default; anything else needs explicit opt-in).
 */

import type { Runtime } from '../../runtime';
import { computeBlastRadius, computeExplain, computeViolations } from '../mcp/archon-tools';
import type { ArchonLspHandlers } from './server';
import type { LspDiagnostic } from './protocol';

const STRINGS_ONLY = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Map a violation severity to LSP's 1=Error / 2=Warning / 3=Information / 4=Hint. */
function severityFor(s: 'high' | 'medium' | 'low'): LspDiagnostic['severity'] {
  if (s === 'high') return 1; // Error
  if (s === 'medium') return 2; // Warning
  return 3; // Information
}

/** Whole-file LSP range (line 0 col 0 → line 1 col 0). The Indexer doesn't track per-line spans yet. */
const FILE_RANGE = { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } as const;

/**
 * Build the handler bundle for `ArchonLspServer`. Every handler is read-only
 * — no broker call, no fs.write — so the LSP bridge inherits the same
 * zero-authority posture as the MCP read-only surface.
 */
export function archonLspHandlers(rt: Runtime): ArchonLspHandlers {
  return {
    async blastRadius(args: { path: string }) {
      if (!STRINGS_ONLY(args?.path)) throw new Error('archon/blastRadius: missing or empty `path`');
      const out = await computeBlastRadius(rt, args.path);
      // LSP shape is the trimmed envelope — clients only need files+symbols.
      return { files: out.files, symbols: out.dependents };
    },

    async explain(args: { symbol: string }) {
      if (!STRINGS_ONLY(args?.symbol)) throw new Error('archon/explain: missing or empty `symbol`');
      const out = computeExplain(rt, args.symbol);
      if (out.resolved === null) {
        // Ambiguous → expose candidates so the client can re-query; unknown → empty.
        const summary =
          out.candidates.length > 0
            ? `${args.symbol} is ambiguous (${out.candidates.length} candidates)`
            : `${args.symbol} is not indexed`;
        return { summary, neighbours: out.candidates };
      }
      const inbound = out.dependedOnBy.map((e) => e.name);
      const outbound = out.dependsOn.map((e) => e.name);
      const summary =
        out.kind && out.file
          ? `${out.kind} ${out.resolved} in ${out.file} · ${inbound.length} caller(s), ${outbound.length} dependency(ies)`
          : out.resolved;
      // Neighbours = the union of one-hop edges; callers first because the
      // change-impact use case usually wants "who breaks if I edit this".
      return { summary, neighbours: [...inbound, ...outbound] };
    },

    async violations(args: { path?: string }) {
      const report = computeViolations(rt);
      // Violation.subject is the module-or-file the finding is about; filter
      // by exact match or by prefix (a module subject like `src/cognition`
      // covers every path under it).
      const filtered = args?.path
        ? report.violations.filter((v) => v.subject === args.path || args.path?.startsWith(`${v.subject}/`))
        : report.violations;
      return filtered.map((v): LspDiagnostic => ({
        range: FILE_RANGE,
        severity: severityFor(v.severity),
        message: `${v.kind}: ${v.detail}`,
        source: 'archon',
      }));
    },

    async executeCommand(name: string, args: unknown[]) {
      // Read-only allowlist. Any future write-shaped command must opt in here
      // explicitly AND route through the Capability Broker — there is no
      // ambient authority on this path. ADR-0015 #9.
      switch (name) {
        case 'archon.blastRadius':
          return this.blastRadius((args[0] as { path: string }) ?? { path: '' });
        case 'archon.explain':
          return this.explain((args[0] as { symbol: string }) ?? { symbol: '' });
        case 'archon.violations':
          return this.violations((args[0] as { path?: string }) ?? {});
        default:
          throw new Error(`archon-lsp: command "${name}" is not bound (read-only surface only)`);
      }
    },
  };
}
