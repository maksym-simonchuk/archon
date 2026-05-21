#!/usr/bin/env node
// Archon CLI — command surface for the MVP. With no args it launches the
// interactive shell; otherwise it runs one command and exits. Every command
// composes through the single runtime root (buildRuntime); the shared command
// implementations live in src/commands.ts (reused by the shell).

import { cmdIndex, cmdMemory, cmdPlan, cmdPlugins, cmdPromote, cmdPromotions, cmdRun, cmdStatus } from './commands';
import { cmdInit } from './init';
import { buildRuntime, type Runtime } from './runtime';
import { startShell } from './shell';

const HELP = `archon — constrained AI staff-engineer runtime (MVP)

Usage:
  archon                  Launch the interactive shell
  archon init             Scaffold .archon/policy.yaml + config         (M0)
  archon index            Incrementally index changed files            (M1)
  archon plan <goal>      Produce a plan tree — no writes               (M6)
  archon run <goal>       Plan -> act -> verify under a worktree tx     (M6)
  archon status           Show task journal + budgets                   (M0)
  archon memory           List memory-promotion candidates              (M5)
  archon memory promote <id>   Confirm a promotion (the human gate)     (M5)
  archon plugins          List loaded plugins + capability previews     (M7)
  archon --help           Show this help

See docs/ROADMAP.md and AGENTS.md.`;

/** Build a runtime, run one command against it, and always close it. */
async function withRuntime(fn: (rt: Runtime) => Promise<void>): Promise<void> {
  const rt = await buildRuntime(process.cwd());
  try {
    await fn(rt);
  } finally {
    rt.close();
  }
}

function usageError(form: string): void {
  console.error(`usage: archon ${form}`);
  process.exitCode = 1;
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const goal = rest.join(' ').trim();
  switch (cmd) {
    case undefined:
      return startShell();
    case '-h':
    case '--help':
      console.log(HELP);
      return;
    case 'init':
      return cmdInit(process.cwd());
    case 'index':
      return withRuntime(cmdIndex);
    case 'plan':
      if (!goal) return usageError('plan <goal>');
      return withRuntime((rt) => cmdPlan(rt, goal));
    case 'run':
      if (!goal) return usageError('run <goal>');
      return withRuntime((rt) => cmdRun(rt, goal));
    case 'status':
      return withRuntime(cmdStatus);
    case 'plugins':
      return withRuntime(cmdPlugins);
    case 'memory': {
      const [sub, ...more] = rest;
      if (sub === 'promote') {
        const id = more[0];
        if (!id) return usageError('memory promote <id>');
        return withRuntime((rt) => cmdPromote(rt, id));
      }
      if (sub === 'recall') {
        const g = more.join(' ').trim();
        if (!g) return usageError('memory recall <goal>');
        return withRuntime((rt) => cmdMemory(rt, g));
      }
      if (sub) return usageError('memory [promote <id> | recall <goal>]');
      return withRuntime(cmdPromotions);
    }
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(`[archon] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
