import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  cmdIndex,
  cmdMemory,
  cmdPlan,
  cmdPlugins,
  cmdPromote,
  cmdPromotions,
  cmdRun,
  cmdStatus,
  plannerLabel,
} from './commands';
import { buildRuntime, type Runtime } from './runtime';

const PROMPT = 'archon› ';
const HISTORY_FILE = 'shell_history';
const HISTORY_MAX = 1000;

/** Every slash command the shell understands — drives tab-completion. */
const COMMANDS = [
  '/plan',
  '/run',
  '/index',
  '/status',
  '/memory',
  '/promote',
  '/plugins',
  '/help',
  '/exit',
  '/quit',
] as const;

const SHELL_HELP = `commands:
  /plan <goal>     plan a task — no writes
  /run <goal>      plan → act → verify under a worktree transaction
  /index           incrementally index changed files
  /status          task journal + budgets
  /memory [goal]   no arg: promotion candidates · <goal>: recall episodes
  /promote <id>    confirm a memory promotion (the human gate)
  /plugins         list loaded plugins + capability previews
  /help            this help
  /exit, /quit     leave the shell  (Ctrl-D also works)
  <text>           shorthand for /plan <text>`;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * readline completer: when the line is the start of a slash command, offer the
 * matching commands; for anything else (e.g. typing a goal) offer nothing so
 * the input isn't disturbed. Returns the `[completions, line]` tuple readline
 * expects. Exported so the completion logic is testable without a TTY.
 */
export function completeShell(line: string): [string[], string] {
  return [COMMANDS.filter((c) => c.startsWith(line)), line];
}

/** Load up to HISTORY_MAX prior input lines (most-recent-first) to seed readline. */
export function loadHistory(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(0, HISTORY_MAX);
  } catch {
    return []; // no history yet (or unreadable) — start clean
  }
}

/** Persist readline's history array (most-recent-first). Best-effort: never throws. */
export function saveHistory(file: string, history: string[]): void {
  try {
    writeFileSync(file, history.slice(0, HISTORY_MAX).join('\n'));
  } catch {
    // History is a convenience; a write failure must never break the shell.
  }
}

/**
 * Route one line of shell input to a command. A bare line (no leading slash) is
 * shorthand for `/plan`. Exported so the dispatch table is testable without
 * driving readline. Returns false only for /exit · /quit (signals the REPL to
 * stop); every other input returns true.
 */
export async function dispatch(rt: Runtime, input: string): Promise<boolean> {
  const [head, ...rest] = input.split(/\s+/);
  const arg = rest.join(' ').trim();
  const needGoal = (): boolean => {
    if (arg) return true;
    console.log(`usage: ${head} <goal>`);
    return false;
  };

  switch (head) {
    case '/exit':
    case '/quit':
      return false;
    case '/help':
      console.log(SHELL_HELP);
      return true;
    case '/plan':
      if (needGoal()) await cmdPlan(rt, arg);
      return true;
    case '/run':
      if (needGoal()) await cmdRun(rt, arg);
      return true;
    case '/index':
      await cmdIndex(rt);
      return true;
    case '/status':
      await cmdStatus(rt);
      return true;
    case '/memory':
      await (arg ? cmdMemory(rt, arg) : cmdPromotions(rt));
      return true;
    case '/promote':
      if (arg) await cmdPromote(rt, arg);
      else console.log('usage: /promote <id>');
      return true;
    case '/plugins':
      await cmdPlugins(rt);
      return true;
    default:
      if (head.startsWith('/')) {
        console.log(`unknown command "${head}" — try /help`);
        return true;
      }
      await cmdPlan(rt, input); // bare text → plan
      return true;
  }
}

/**
 * Interactive REPL — the `archon` no-arg surface. Builds one Runtime for the
 * whole session (so the journal, memory, and provider cache persist across
 * commands) and drives it line-by-line via readline. Zero new dependencies:
 * history (up/down) and line editing come from `node:readline`. Exits on /exit,
 * /quit, or EOF (Ctrl-D), closing the runtime.
 */
export async function startShell(): Promise<void> {
  const rt = await buildRuntime(process.cwd());
  const historyFile = join(rt.root, '.archon', HISTORY_FILE);
  let history = loadHistory(historyFile);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT,
    completer: completeShell,
    history,
    historySize: HISTORY_MAX,
    removeHistoryDuplicates: true,
  });
  // readline emits the full (most-recent-first) array on every change; keep the
  // latest so we can persist it once on exit rather than on every keystroke.
  rl.on('history', (h: string[]) => {
    history = h;
  });

  console.log('archon interactive shell — /help for commands, /exit to quit');
  console.log(plannerLabel(rt.llmPlanning));
  rl.prompt();

  try {
    for await (const line of rl) {
      const input = line.trim();
      if (input) {
        try {
          if (!(await dispatch(rt, input))) break;
        } catch (e) {
          console.error(`[archon] ${msg(e)}`);
        }
      }
      rl.prompt();
    }
  } finally {
    rl.close();
    rt.close();
    saveHistory(historyFile, history);
  }
}
