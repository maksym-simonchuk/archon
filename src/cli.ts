#!/usr/bin/env node
// Archon CLI — command surface for the MVP. With no args it launches the
// interactive shell; otherwise it runs one command and exits. Every command
// composes through the single runtime root (buildRuntime); the shared command
// implementations live in src/commands.ts (reused by the shell).

import {
  cmdAsk,
  cmdDoctor,
  cmdExplain,
  cmdImpact,
  cmdIndex,
  cmdMemory,
  cmdModel,
  cmdPlan,
  cmdPlugins,
  cmdPromote,
  cmdPromotions,
  cmdRun,
  cmdSkills,
  cmdStatus,
  cmdTool,
  extractFlag,
} from './commands';
import { cmdInit } from './init';
import { buildRuntime, type Runtime } from './runtime';
import { startShell } from './shell';

const HELP = `archon — constrained AI staff-engineer runtime (MVP)

Usage:
  archon                  Launch the interactive shell
  archon init             Scaffold .archon/policy.yaml + config         (M0)
  archon index            Incrementally index changed files            (M1)
  archon impact <file>    Blast radius — what a change here affects     (M1)
  archon explain <symbol> Definition + direct callers/callees            (M1)
  archon plan [--skill <n>] [--json] <goal>   Plan tree — no writes     (M6)
  archon run  [--skill <name>] <goal>   Plan→act→verify (worktree tx)   (M6)
  archon ask <question>   Stream an answer; @path attaches a file       (M7)
  archon status [--json] [taskId]   Task journal — or one run's replay   (M0)
  archon doctor [--json]  Report runtime readiness (planner/keys/state)
  archon model            Show the provider routing table                (M7)
  archon memory           List memory-promotion candidates              (M5)
  archon memory promote <id>   Confirm a promotion (the human gate)     (M5)
  archon plugins          List loaded plugins + capability previews     (M7)
  archon skills [name]    List skill playbooks, or print one            (M7)
  archon tool <name> [json]    Invoke a tool plugin (policy-gated)       (M7)
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
  const json = rest.includes('--json'); // machine-readable output for the report commands
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
    case 'impact': {
      const file = rest[0];
      if (!file) return usageError('impact <file|symbol>');
      return withRuntime((rt) => cmdImpact(rt, file));
    }
    case 'explain': {
      const symbol = rest[0];
      if (!symbol) return usageError('explain <symbol>');
      return withRuntime((rt) => cmdExplain(rt, symbol));
    }
    case 'plan': {
      const { value: skill, rest: r } = extractFlag(rest, '--skill');
      const g = r.filter((a) => a !== '--json').join(' ').trim();
      if (!g) return usageError('plan [--skill <name>] [--json] <goal>');
      return withRuntime((rt) => cmdPlan(rt, g, { skill, json }));
    }
    case 'run': {
      const { value: skill, rest: r } = extractFlag(rest, '--skill');
      const g = r.join(' ').trim();
      if (!g) return usageError('run [--skill <name>] <goal>');
      return withRuntime((rt) => cmdRun(rt, g, { skill }));
    }
    case 'ask':
      if (!goal) return usageError('ask <question>');
      return withRuntime(async (rt) => {
        // No readline here, so Ctrl-C arrives as a process signal: catch it to
        // abort the stream gracefully (partial answer kept) instead of a hard kill.
        const controller = new AbortController();
        const onSigint = (): void => controller.abort();
        process.once('SIGINT', onSigint);
        try {
          await cmdAsk(rt, goal, [], controller.signal); // one-shot: no transcript
        } finally {
          process.removeListener('SIGINT', onSigint);
        }
      });
    case 'status': {
      const taskId = rest.find((a) => !a.startsWith('--')); // first non-flag token = a task to replay
      return withRuntime((rt) => cmdStatus(rt, { json, taskId }));
    }
    case 'doctor':
      return withRuntime((rt) => cmdDoctor(rt, { json }));
    case 'model':
      return withRuntime((rt) => cmdModel(rt));
    case 'plugins':
      return withRuntime(cmdPlugins);
    case 'skills': {
      const [name] = rest;
      return withRuntime((rt) => cmdSkills(rt, name));
    }
    case 'tool': {
      const [name, ...more] = rest;
      if (!name) return usageError('tool <name> [json-input]');
      const input = more.join(' ').trim();
      return withRuntime((rt) => cmdTool(rt, name, input || undefined));
    }
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
