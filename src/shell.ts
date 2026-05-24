import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface, moveCursor } from 'node:readline';
import {
  type AskTurn,
  cmdAgentRun,
  cmdAgents,
  cmdAsk,
  cmdBoundaries,
  cmdCost,
  cmdDecisions,
  cmdDoctor,
  cmdEvolution,
  cmdExplain,
  cmdHooks,
  cmdImpact,
  cmdImprove,
  cmdIndex,
  cmdMap,
  cmdMemory,
  cmdMemoryGraph,
  cmdMemoryList,
  cmdModel,
  cmdPath,
  cmdPhilosophy,
  cmdPlan,
  cmdPlugins,
  cmdPolicy,
  cmdPreserve,
  cmdPromote,
  cmdPromotions,
  cmdRefactor,
  cmdRecap,
  cmdRisk,
  cmdRun,
  cmdSh,
  cmdSimulate,
  cmdSkill,
  cmdSkills,
  cmdStatus,
  cmdTool,
  cmdViolations,
  cmdWatch,
  extractFlag,
} from './commands';
import type { ChangeKind } from './cognition/preservation';
import { buildRuntime, type Runtime } from './runtime';
import { type TreeWatcher, watchTree } from './sensing/fs-watcher';

const HISTORY_FILE = 'shell_history';
const HISTORY_MAX = 1000;
/** Width of the framing rule, capped so it stays readable on wide terminals. */
const RULE_WIDTH = 60;
/** Cap on prior /ask turns fed back into the model — bounds prompt growth + cost. */
const ASK_CONTEXT_TURNS = 8;

/** Mutable per-REPL state that must persist across dispatched lines (the /ask transcript). */
export interface ShellSession {
  askHistory: AskTurn[];
  /** Controller for an in-flight /ask, if any — Ctrl-C aborts it (see `startShell`). */
  abort?: AbortController;
  /** Dirty-set snapshot threaded across `/watch` ticks (M22) so each tick reports a delta. */
  watchDirty: ReadonlySet<string>;
  /**
   * Runtime v2 correlation id for the active turn. The TUI mints this on
   * submit and threads it through every router/tool call so bus events from
   * one turn can be grouped (and replayed) together. Undefined between turns.
   */
  currentRunId?: string;
  /**
   * Reasoning visibility mode for this session (M28). `off` (default) hides
   * model reasoning; `summary` shows the deterministic compress of structured
   * ReasoningNode events; `trace` shows the full structured trail. NEVER the
   * provider's raw chain-of-thought — that boundary is in `cognition/reasoning.ts`.
   * Controlled by `/think off|summary|trace`.
   */
  reasoningMode: 'off' | 'summary' | 'trace';
}
export const newSession = (): ShellSession => ({
  askHistory: [],
  watchDirty: new Set(),
  reasoningMode: 'off',
});

/** Every slash command the shell understands — drives tab-completion (and the TUI slash menu). */
export const COMMANDS = [
  '/plan',
  '/run',
  '/ask',
  '/clear',
  '/index',
  '/watch',
  '/impact',
  '/explain',
  '/map',
  '/boundaries',
  '/violations',
  '/risk',
  '/evolution',
  '/decisions',
  '/philosophy',
  '/preserve',
  '/agents',
  '/agent',
  '/improve',
  '/refactor',
  '/hooks',
  '/simulate',
  '/path',
  '/status',
  '/recap',
  '/cost',
  '/model',
  '/think',
  '/approve',
  '/doctor',
  '/memory',
  '/promote',
  '/plugins',
  '/skill',
  '/skills',
  '/sh',
  '/policy',
  '/tool',
  '/help',
  '/exit',
  '/quit',
] as const;

const SHELL_HELP = `commands:
  /plan [--skill <name>] <goal>   plan a task — no writes
  /run  [--skill <name>] [--force] <goal>  plan → act → verify (--force overrides the preservation gate)
  /ask <question>  stream an answer; remembers prior turns; @path attaches a file
  /clear           forget the /ask conversation context
  /index           incrementally index changed files
  /watch [--loop|--stop]  reindex changed files + refresh health · --loop watches live (fs events) in the background
  /impact <file>   blast radius — what a change to <file> affects
  /explain <symbol>  definition + direct callers/callees (one hop)
  /map             graph overview — size + most depended-on symbols
  /boundaries      bounded contexts — coupling, instability, god modules, cycles
  /violations      architecture-health findings ranked by severity × impact
  /risk <file>     change-risk level for a file (blast × criticality × confidence)
  /evolution       churn × coupling over git history — modules trending toward god-object
  /decisions [query|propose]  ADR decision memory · propose: draft an ADR for the latest change
  /philosophy      inferred engineering culture (typing, abstraction, bias, scale)
  /preserve <file> [change]  would a change erase intentional/critical structure?
  /agents          project-native agents the stack + topology imply
  /agent [--run] <goal>  bind the best-fit agent to a goal — plan under it, or --run to execute scoped
  /improve         conservative, ROI-ranked, preservation-gated improvement proposals
  /refactor [--pick N] [--force]  apply a proposal, simulation-gated, under a scoped agent
  /hooks           pre-write gate (forbidden-import/boundary/never-modify) + post-write checks
  /simulate <file> [change]  predict blast radius + regression probability before applying
  /path <a> <b>    shortest dependency chain from symbol a to symbol b
  /status [taskId] task journal · <taskId>: that run's full replay
  /recap            per-run digest of recent activity + health trend
  /cost            session spend vs the per-task budget
  /model           provider routing table (models + per-task chain)
  /think [off|summary|trace]  reasoning visibility (never raw provider CoT)
  /approve [allow|deny] [id]  resolve a pending approval card (M32)
  /doctor          runtime readiness (planner/keys/state/plugins)
  /memory [list [tier]|graph|goal]  list: records · graph: intelligence layer · goal: recall
  /promote <id>    confirm a memory promotion (the human gate)
  /plugins         list loaded plugins + capability previews
  /skill [run <name> [--pick N] [--force]]  executable multi-phase skills (analyze→simulate→validate→execute)
  /skills [name]   list skill playbooks · <name>: print one
  /sh <command>    run a command through the policy broker (gated; argv only)
  /policy [check <cmd>]  show the safety policy · check: dry-run a command
  /tool <name> [json]  invoke a tool plugin (policy-gated)
  /help            this help
  /exit, /quit     leave the shell  (Ctrl-D also works)
  <text>           shorthand for /plan <text>

tip: @path in any goal or question attaches that file's contents — read through
the policy broker, so secrets (.env, keys) are refused, never sent to the model.
tip: as you type, a dimmed suggestion (recent history / commands) trails the
cursor — press → to accept it, Tab to complete a command.`;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Zero-dependency ANSI styling: active only on a real TTY and when NO_COLOR is
// unset (https://no-color.org), so piped/non-interactive output stays plain.
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const sgr =
  (code: number) =>
  (s: string): string =>
    useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const dim = sgr(2);
const cyan = sgr(36);
const bold = sgr(1);

const PROMPT_TEXT = 'archon› '; // visible width (8) — drives the ghost-text wrap guard
const PROMPT = cyan(PROMPT_TEXT);
const rule = (): string => dim('─'.repeat(RULE_WIDTH));

/** One-line status the TUI reprints above each prompt: profile · planner · live session spend. */
function statusLine(rt: Runtime): string {
  const planner = rt.llmPlanning ? 'llm' : 'scaffold';
  return dim(`archon  ${rt.config.profile} · ${planner} · $${rt.router.spent.toFixed(4)}/task`);
}

/** Memory tiers offered after `/memory list ` — mirrors MEMORY_TIERS in commands.ts. */
const MEMORY_COMPLETION_TIERS = ['episodic', 'semantic', 'procedural'] as const;

/** Change kinds accepted by `/preserve` — mirrors ChangeKind in cognition/preservation. */
const CHANGE_KINDS = ['modify', 'simplify', 'remove-abstraction', 'rewrite', 'extract'] as const;
/** Coerce a user token to a ChangeKind; `/preserve` defaults to the structure-stripping case, `/simulate` to a plain modify. */
const asChangeKind = (s: string | undefined, fallback: ChangeKind = 'remove-abstraction'): ChangeKind =>
  (CHANGE_KINDS as readonly string[]).includes(s ?? '') ? (s as ChangeKind) : fallback;

/**
 * Static argument completions for the few commands with a fixed subcommand
 * vocabulary. Returns the full candidate *lines* (so readline can append the
 * tail) for the token currently being completed; `words` is the line split on
 * whitespace, `words[0]` the command. Dynamic names (skills, tools, ids) are out
 * of scope — those need the runtime, which the pure completer deliberately omits.
 */
function argCandidates(head: string, words: string[]): string[] {
  if (head === '/memory') {
    if (words.length === 2) return ['/memory list', '/memory graph'];
    if (words.length === 3 && words[1] === 'list')
      return MEMORY_COMPLETION_TIERS.map((t) => `/memory list ${t}`);
  }
  if (head === '/watch' && words.length === 2) return ['/watch --loop', '/watch --stop'];
  if (head === '/think' && words.length === 2) return ['/think off', '/think summary', '/think trace'];
  if (head === '/approve' && words.length === 2) return ['/approve allow', '/approve deny'];
  if (head === '/refactor' && words.length === 2) return ['/refactor --pick', '/refactor --force'];
  if (head === '/skill' && words.length === 2) return ['/skill run'];
  if (head === '/policy' && words.length === 2) return ['/policy check'];
  if (head === '/decisions' && words.length === 2) return ['/decisions propose'];
  if ((head === '/preserve' || head === '/simulate') && words.length === 3)
    return CHANGE_KINDS.map((k) => `${head} ${words[1]} ${k}`);
  return [];
}

/**
 * readline completer. The first word completes to a matching slash command; once
 * a known command has a trailing argument, its fixed subcommands/values are
 * offered (e.g. `/memory list`, its tiers, `/policy check`). Anything else (a
 * bare goal, an unknown command's args) offers nothing so the input isn't
 * disturbed. Returns the `[completions, line]` tuple readline expects — the line
 * is the match substring, and candidates are full lines, so readline appends only
 * the missing tail. Exported so the completion logic is testable without a TTY.
 */
export function completeShell(line: string): [string[], string] {
  const words = line.split(/\s+/);
  // First word (no argument yet) → complete the command name itself.
  if (words.length <= 1) return [COMMANDS.filter((c) => c.startsWith(line)), line];
  // Subsequent words → offer the command's static argument vocabulary, if any.
  return [argCandidates(words[0], words).filter((c) => c.startsWith(line)), line];
}

/**
 * Inline ghost-text suggestion for the current input `line`: the full line the
 * user most likely intends, drawn dimmed after the cursor and accepted with `→`.
 * Prefers the most-recent matching history entry (so a re-run is one keystroke),
 * then falls back to a matching command name. Returns the *whole* suggested line
 * (the renderer slices off the typed prefix), or undefined when nothing strictly
 * extends what's typed. `history` is most-recent-first (readline's order). Pure +
 * exported so the matching is testable without a TTY.
 */
export function suggestLine(line: string, history: readonly string[]): string | undefined {
  if (!line) return undefined; // never suggest on an empty prompt
  const extends_ = (c: string): boolean => c.length > line.length && c.startsWith(line);
  return history.find(extends_) ?? COMMANDS.find(extends_);
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
export async function dispatch(rt: Runtime, input: string, session: ShellSession = newSession()): Promise<boolean> {
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
    case '/plan': {
      const { value: skill, rest: r } = extractFlag(rest, '--skill');
      const g = r.join(' ').trim();
      if (g) await cmdPlan(rt, g, { skill });
      else console.log('usage: /plan [--skill <name>] <goal>');
      return true;
    }
    case '/run': {
      const { value: skill, rest: r } = extractFlag(rest, '--skill');
      const force = r.includes('--force');
      const g = r.filter((t) => t !== '--force').join(' ').trim();
      if (g) await cmdRun(rt, g, { skill, force });
      else console.log('usage: /run [--skill <name>] [--force] <goal>');
      return true;
    }
    case '/ask':
      if (needGoal()) {
        // Publish a controller for the SIGINT handler, then always retract it so
        // a later Ctrl-C at the prompt exits the shell rather than aborting nothing.
        const controller = new AbortController();
        session.abort = controller;
        try {
          // Thread the surrounding turn's runId so the router's bus events
          // group with the rest of the turn's activity.
          const answer = await cmdAsk(
            rt,
            arg,
            session.askHistory.slice(-ASK_CONTEXT_TURNS),
            controller.signal,
            session.currentRunId,
          );
          if (answer) session.askHistory.push({ question: arg, answer });
        } finally {
          session.abort = undefined;
        }
      }
      return true;
    case '/clear':
      session.askHistory = [];
      console.log('context cleared');
      return true;
    case '/index':
      await cmdIndex(rt);
      return true;
    case '/watch':
      // Single incremental tick (reindex changed subtree + refresh health). The
      // continuous `--loop` poller is a REPL affordance handled in startShell;
      // here a bare /watch (or a stray flag) runs one tick and threads the dirty set.
      session.watchDirty = await cmdWatch(rt, session.watchDirty);
      return true;
    case '/impact':
      if (arg) await cmdImpact(rt, arg);
      else console.log('usage: /impact <file|symbol>');
      return true;
    case '/explain':
      if (arg) await cmdExplain(rt, arg);
      else console.log('usage: /explain <symbol>');
      return true;
    case '/map':
      await cmdMap(rt);
      return true;
    case '/boundaries':
      await cmdBoundaries(rt);
      return true;
    case '/violations':
      await cmdViolations(rt);
      return true;
    case '/risk':
      if (arg) await cmdRisk(rt, arg);
      else console.log('usage: /risk <file>');
      return true;
    case '/evolution':
      await cmdEvolution(rt);
      return true;
    case '/decisions':
      await cmdDecisions(rt, arg);
      return true;
    case '/philosophy':
      await cmdPhilosophy(rt);
      return true;
    case '/preserve': {
      const [file, kind] = rest;
      if (!file) console.log(`usage: /preserve <file> [${CHANGE_KINDS.join('|')}]`);
      else await cmdPreserve(rt, file, asChangeKind(kind));
      return true;
    }
    case '/agents':
      await cmdAgents(rt);
      return true;
    case '/agent': {
      const run = rest.includes('--run'); // boolean flag — accepted anywhere in the args
      const g = rest.filter((t) => t !== '--run').join(' ').trim();
      if (!g) console.log('usage: /agent [--run] <goal>');
      else await cmdAgentRun(rt, g, { run });
      return true;
    }
    case '/improve':
      await cmdImprove(rt);
      return true;
    case '/refactor': {
      const { value: pick, rest: r } = extractFlag(rest, '--pick');
      const n = pick !== undefined ? Number(pick) : undefined;
      if (n !== undefined && (!Number.isInteger(n) || n < 0)) console.log('usage: /refactor [--pick <n≥0>] [--force]');
      else await cmdRefactor(rt, { pick: n, force: r.includes('--force') });
      return true;
    }
    case '/skill': {
      if (rest[0] !== 'run') {
        await cmdSkill(rt); // bare /skill (or anything but `run`) lists the built-ins
        return true;
      }
      const { value: pick, rest: r } = extractFlag(rest.slice(1), '--pick');
      const n = pick !== undefined ? Number(pick) : undefined;
      const name = r.find((t) => t !== '--force');
      if (n !== undefined && (!Number.isInteger(n) || n < 0)) console.log('usage: /skill run <name> [--pick <n≥0>] [--force]');
      else await cmdSkill(rt, name, { pick: n, force: r.includes('--force') });
      return true;
    }
    case '/hooks':
      await cmdHooks(rt);
      return true;
    case '/simulate': {
      const [file, kind] = rest;
      if (!file) console.log(`usage: /simulate <file> [${CHANGE_KINDS.join('|')}]`);
      else await cmdSimulate(rt, file, asChangeKind(kind, 'modify'));
      return true;
    }
    case '/path': {
      const [from, to] = rest;
      if (from && to) await cmdPath(rt, from, to);
      else console.log('usage: /path <from-symbol> <to-symbol>');
      return true;
    }
    case '/status':
      await cmdStatus(rt, { taskId: arg || undefined });
      return true;
    case '/recap':
      await cmdRecap(rt);
      return true;
    case '/cost':
      cmdCost(rt);
      return true;
    case '/model':
      await cmdModel(rt);
      return true;
    case '/approve': {
      // Resolve a pending approval card (M32). Usage:
      //   /approve              → show pending requests' ids
      //   /approve allow [id]   → allow the given id (default: the only one)
      //   /approve deny  [id]   → deny  the given id
      const words = arg.trim().split(/\s+/).filter(Boolean);
      const pending = rt.approval.pendingIds();
      if (words.length === 0) {
        if (pending.length === 0) console.log('no pending approvals');
        else console.log(`pending approvals:\n  ${pending.join('\n  ')}`);
        return true;
      }
      const decision = words[0];
      if (decision !== 'allow' && decision !== 'deny') {
        console.log('usage: /approve [allow|deny] [id]');
        return true;
      }
      const id = words[1] ?? (pending.length === 1 ? pending[0] : undefined);
      if (!id) {
        console.log(
          pending.length === 0
            ? 'no pending approvals'
            : `multiple pending — specify id: ${pending.join(', ')}`,
        );
        return true;
      }
      const ok = rt.approval.resolve(id, decision, session.currentRunId ?? id);
      console.log(ok ? `${decision} ${id}` : `no such approval: ${id}`);
      return true;
    }
    case '/think': {
      // Reasoning visibility toggle (M28). `/think` with no arg shows the
      // current mode; `/think off|summary|trace` updates it. NEVER shows
      // raw model CoT — the renderer in cognition/reasoning.ts only formats
      // structured ReasoningNode events Archon itself emits.
      const next = arg.trim();
      if (next === '') {
        console.log(`think mode: ${session.reasoningMode}`);
      } else if (next === 'off' || next === 'summary' || next === 'trace') {
        session.reasoningMode = next;
        console.log(`think mode: ${next}`);
      } else {
        console.log('usage: /think [off|summary|trace]');
      }
      return true;
    }
    case '/doctor':
      await cmdDoctor(rt);
      return true;
    case '/memory': {
      const [sub, ...more] = rest;
      if (sub === 'list') await cmdMemoryList(rt, more[0]); // /memory list [tier]
      else if (sub === 'graph') await cmdMemoryGraph(rt); // /memory graph → intelligence layer
      else if (arg) await cmdMemory(rt, arg); // /memory <goal> → recall
      else await cmdPromotions(rt); // /memory → promotion candidates
      return true;
    }
    case '/promote':
      if (arg) await cmdPromote(rt, arg);
      else console.log('usage: /promote <id>');
      return true;
    case '/plugins':
      await cmdPlugins(rt);
      return true;
    case '/skills':
      await cmdSkills(rt, arg || undefined);
      return true;
    case '/sh':
      if (arg) await cmdSh(rt, arg);
      else console.log('usage: /sh <command> [args…]');
      return true;
    case '/policy': {
      const [sub, ...more] = rest;
      if (sub === 'check') await cmdPolicy(rt, { check: more.join(' ').trim() });
      else if (sub) console.log('usage: /policy [check <command>]');
      else await cmdPolicy(rt);
      return true;
    }
    case '/tool': {
      const [name, ...more] = rest;
      if (!name) console.log('usage: /tool <name> [json-input]');
      else await cmdTool(rt, name, more.join(' ').trim() || undefined);
      return true;
    }
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
 * Interactive TUI — the sole `archon` surface (one-shot subcommands were
 * removed). Builds one Runtime for the whole session (so the journal, memory,
 * and provider cache persist across commands) and drives it line-by-line via
 * readline. Zero new dependencies: history (up/down), line editing, and
 * tab-completion come from `node:readline`; the framing is plain ANSI, gated on
 * a TTY. A status line (profile · planner · live spend) and a rule are reprinted
 * above each prompt, so the last command's output sits framed between them.
 * Exits on /exit, /quit, or EOF (Ctrl-D), closing the runtime.
 */
export async function startShell(): Promise<void> {
  const rt = await buildRuntime(process.cwd());
  const session = newSession(); // one /ask transcript for the whole REPL lifetime
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
  // Ctrl-C cancels an in-flight /ask and stays in the shell; with nothing
  // streaming it means "leave", same as Ctrl-D. (readline owns SIGINT once it
  // has a listener, so this never kills the process mid-stream.)
  rl.on('SIGINT', () => {
    if (session.abort) session.abort.abort();
    else rl.close();
  });

  // ── Inline ghost-text autosuggest ──────────────────────────────────────────
  // True while a command runs, so keystrokes during execution don't paint a
  // suggestion over command output. The keypress handler fires AFTER readline's
  // own (we register later), so rl.line/rl.cursor are already updated.
  let busy = false;

  // ── /watch background daemon (M22, in-process) ─────────────────────────────
  // Incrementally reindexes the dirty subtree and refreshes health without
  // re-running a command. Prefers a real recursive `fs.watch` (event-driven —
  // a tick runs only when a source file actually changes); on platforms without
  // recursive watch it falls back to a poller. A tick skips while a command is
  // mid-output (reuses `busy`), and redraws the prompt afterwards so background
  // output never strands it.
  const WATCH_INTERVAL_MS = 2000;
  let watchHandle: TreeWatcher | undefined; // event-driven watcher (preferred)
  let watchTimer: NodeJS.Timeout | undefined; // poller fallback
  const runWatchTick = (): void => {
    if (busy) return; // don't interleave a tick with a running command's output
    busy = true;
    void cmdWatch(rt, session.watchDirty)
      .then((next) => {
        session.watchDirty = next;
      })
      .catch((e) => console.error(`[archon] watch: ${msg(e)}`))
      .finally(() => {
        busy = false;
        rl.prompt(true); // redraw the prompt beneath any tick output
      });
  };
  const startWatchLoop = (): void => {
    if (watchHandle || watchTimer) {
      console.log('watch: already running — /watch --stop to stop');
      return;
    }
    watchHandle = watchTree(rt.root, runWatchTick);
    if (watchHandle) {
      console.log('watch: live (fs events) — /watch --stop to stop');
    } else {
      console.log(`watch: polling every ${WATCH_INTERVAL_MS / 1000}s (fs events unavailable) — /watch --stop to stop`);
      watchTimer = setInterval(runWatchTick, WATCH_INTERVAL_MS);
      watchTimer.unref?.();
    }
    runWatchTick(); // an immediate first tick so the current state is reported
  };
  const stopWatchLoop = (): void => {
    if (!watchHandle && !watchTimer) {
      console.log('watch: not running');
      return;
    }
    watchHandle?.close();
    watchHandle = undefined;
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = undefined;
    }
    console.log('watch: stopped');
  };
  // Repaint the dimmed suggestion after the cursor, then move the cursor back to
  // its logical spot. readline clears to end-of-line on its next refresh, so the
  // ghost erases itself on the following keystroke — we only ever draw. Cosmetic:
  // gated on a colour TTY, suppressed when busy / mid-line / when it would wrap.
  const paintGhost = (): void => {
    if (busy || !useColor) return;
    try {
      const { line, cursor } = rl;
      if (!line || cursor !== line.length) return; // only at end-of-line
      const suggestion = suggestLine(line, history);
      if (!suggestion) return;
      const tail = suggestion.slice(line.length);
      if (PROMPT_TEXT.length + line.length + tail.length >= (process.stdout.columns ?? 80)) return; // would wrap
      process.stdout.write(dim(tail));
      moveCursor(process.stdout, -tail.length, 0);
    } catch {
      // Autosuggest is cosmetic; a render glitch must never break line editing.
    }
  };
  process.stdin.on('keypress', (_str: string | undefined, key: { name?: string } | undefined) => {
    // `→` at end-of-line accepts the suggestion: write the missing tail as if
    // typed (readline does nothing on right-arrow at end, so there's no conflict).
    if (key?.name === 'right' && !busy && rl.cursor === rl.line.length) {
      const suggestion = suggestLine(rl.line, history);
      if (suggestion) {
        rl.write(suggestion.slice(rl.line.length));
        return; // the insert redraws; next keystroke repaints the next ghost
      }
    }
    paintGhost();
  });

  // Reprint the status line + rule, then the prompt — so each command's output
  // ends up framed between this rule and the next status line.
  const frame = (): void => {
    console.log(`\n${statusLine(rt)}`);
    console.log(rule());
    rl.prompt();
  };

  console.log(bold('archon') + dim(' — interactive TUI · /help for commands, /exit to quit'));
  frame();

  try {
    for await (const line of rl) {
      const input = line.trim();
      // The continuous watcher is a REPL affordance (it owns a timer the pure
      // dispatch table can't), so it's toggled here, before dispatch.
      if (input === '/watch --loop') {
        startWatchLoop();
        frame();
        continue;
      }
      if (input === '/watch --stop') {
        stopWatchLoop();
        frame();
        continue;
      }
      if (input) {
        busy = true; // suppress ghost-text painting while a command runs
        try {
          if (!(await dispatch(rt, input, session))) break;
        } catch (e) {
          console.error(`[archon] ${msg(e)}`);
        } finally {
          busy = false;
        }
      }
      frame();
    }
  } finally {
    if (watchHandle || watchTimer) stopWatchLoop();
    rl.close();
    rt.close();
    saveHistory(historyFile, history);
  }
}
