#!/usr/bin/env node
// Archon entrypoint — launches the interactive TUI, the sole user surface.
// One-shot subcommands (`archon run`, `archon plan --json`, …) were removed in
// favour of the TUI; the command *logic* still lives in src/commands.ts (reused
// by the TUI dispatch) and the --json report shapes remain as internal
// automation contracts. See src/shell.ts for the surface itself.

import { cmdInit } from './init';
import { startShell } from './shell';

const die = (e: unknown): void => {
  console.error(`[archon] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
};

const [arg] = process.argv.slice(2);

// `init` is the one pre-launch escape hatch — it must run WITHOUT a runtime,
// since the TUI itself can't start until `.archon/policy.yaml` exists. Every
// other command lives inside the TUI.
if (arg === 'init') {
  cmdInit(process.cwd()).catch(die);
} else {
  if (process.argv.length > 2) {
    console.error(
      'archon: one-shot commands were removed — launching the interactive TUI (type /help inside). ' +
        '(`archon init` scaffolds a fresh repo.)',
    );
  }
  startShell().catch(die);
}
