/**
 * `archon mcp` entry point — starts a read-only MCP server over stdio so
 * external clients (Claude Code, Cursor, Codex) can call Archon tools as a
 * child process. Read-only by ADR-0015 #9 + ADR-0020: only the
 * `archonReadOnlyTools(rt)` surface is exposed; mutating tools require an
 * explicit opt-in that this entry point does NOT take.
 *
 * Lifecycle: build runtime → wire stdio transport → start server. The
 * process exits when stdin closes (the parent client drops the pipe), or on
 * SIGINT/SIGTERM. Runtime resources are closed on the way out so any open
 * sqlite handles flush cleanly.
 */

import { buildRuntime } from '../../runtime';
import type { StreamLike } from './client';
import { archonReadOnlyTools } from './archon-tools';
import { McpServer } from './server';
import { stdioTransport } from './stdio';

const VERSION = '0.1.0';

/**
 * Build a runtime rooted at `root`, start the MCP server on stdio, and
 * resolve once the transport closes (parent dropped the pipe or signal
 * caught). The runtime is closed before resolving. Pure orchestration —
 * authority lives in `archonReadOnlyTools` (none, by design).
 *
 * `transport` defaults to a real `process.stdin/stdout` adapter; tests pass
 * a paired PassThrough-backed transport to drive the full boot path without
 * spawning a child process.
 */
export async function serveMcpStdio(
  root: string = process.cwd(),
  transport: StreamLike = stdioTransport(),
): Promise<void> {
  const rt = await buildRuntime(root);
  const io = transport;
  const server = new McpServer(io, {
    name: 'archon',
    version: VERSION,
    tools: archonReadOnlyTools(rt),
    // mutatingEnabled defaults to false. This entry point keeps it that way —
    // a future `archon mcp --mutating` would be a separate, opt-in flag.
  });
  // Stop on signals so we don't leak the sqlite handle if the parent killed us.
  // SIGPIPE is what we get when the parent closes its end of the pipe; honour it.
  const stop = (): void => {
    try {
      server.stop();
    } catch {
      // server may already be stopped; nothing to do.
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('SIGPIPE', stop);
  try {
    await server.serve();
  } finally {
    rt.close();
  }
}
