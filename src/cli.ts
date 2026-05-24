#!/usr/bin/env node
// Archon entrypoint. On a TTY it launches the full-screen TUI (src/tui.ts); when
// stdin/stdout are piped (CI, scripts, `echo … | archon`) it falls back to the
// line-based shell (src/shell.ts), which shares the same command dispatch. The
// command *logic* lives in src/commands.ts; the --json report shapes remain as
// internal automation contracts.

import { cmdInit } from './init';
import { startShell } from './shell';
import { startTui } from './tui';

const die = (e: unknown): void => {
  console.error(`[archon] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
};

const [arg] = process.argv.slice(2);

// Two pre-launch entry points — both bypass the interactive surface because
// neither is a *user* command: `init` scaffolds a fresh repo before the
// surface can start (policy.yaml doesn't exist yet), `mcp` is an integration
// transport invoked by another process (Claude Code / Cursor / Codex) over
// stdio JSON-RPC. Every other CLI argument falls through to the shell/TUI.
if (arg === 'init') {
  cmdInit(process.cwd()).catch(die);
} else if (arg === 'mcp') {
  // Read-only MCP server over stdio (ADR-0020). Caller manages lifecycle by
  // closing the pipe; we exit cleanly when stdin ends.
  import('./services/mcp/serve')
    .then(({ serveMcpStdio }) => serveMcpStdio(process.cwd()))
    .catch(die);
} else {
  if (process.argv.length > 2) {
    console.error(
      'archon: one-shot commands were removed — launching the interactive surface (type /help inside). ' +
        '(`archon init` scaffolds a fresh repo; `archon mcp` exposes the read-only MCP surface over stdio.)',
    );
  }
  // Full-screen TUI needs a real terminal on both ends; piped/redirected I/O
  // (tests, scripts) gets the line-based shell so output stays plain + parseable.
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  (interactive ? startTui() : startShell()).catch(die);
}
