/**
 * `archon lsp` entry point — starts a read-only LSP server over stdio
 * (Content-Length framed JSON-RPC) so VS Code / Neovim / JetBrains can
 * talk to Archon without a custom plugin.
 *
 * Read-only by ADR-0015 #9 + ADR-0020: every method routes through
 * `archonLspHandlers(rt)` which is itself a thin wrapper over the shared
 * compute primitives in `services/mcp/archon-tools.ts`. There is no
 * ambient authority on this path — write operations are not bound.
 */

import { buildRuntime } from '../../runtime';
import { archonLspHandlers } from './archon-handlers';
import { ArchonLspServer, type LspTransport } from './server';
import { lspStdioTransport } from './stdio';

/**
 * Build a runtime rooted at `root`, start the LSP server on stdio, and
 * resolve once the transport closes (editor dropped the pipe or signal
 * caught). The runtime is closed before resolving so any open sqlite
 * handles flush cleanly.
 *
 * `transport` defaults to a real `process.stdin/stdout` adapter; tests pass
 * a paired PassThrough-backed transport to drive the full boot path without
 * spawning a child process (mirror of `serveMcpStdio`).
 */
export async function serveLspStdio(
  root: string = process.cwd(),
  transport: LspTransport = lspStdioTransport(),
): Promise<void> {
  const rt = await buildRuntime(root);
  const io = transport;
  const server = new ArchonLspServer(io, archonLspHandlers(rt));
  const stop = (): void => {
    try {
      server.stop();
    } catch {
      // already stopped
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
