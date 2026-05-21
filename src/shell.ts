import { createInterface } from 'node:readline';
import { cmdIndex, cmdMemory, cmdPlan, cmdRun, cmdStatus, plannerLabel } from './commands';
import { buildRuntime, type Runtime } from './runtime';

const PROMPT = 'archon› ';

const SHELL_HELP = `commands:
  /plan <goal>     plan a task — no writes
  /run <goal>      plan → act → verify under a worktree transaction
  /index           incrementally index changed files
  /status          task journal + budgets
  /memory <goal>   recall prior episodes for a goal (retriever-ranked)
  /help            this help
  /exit, /quit     leave the shell  (Ctrl-D also works)
  <text>           shorthand for /plan <text>`;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
      if (needGoal()) await cmdMemory(rt, arg);
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
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: PROMPT });

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
  }
}
