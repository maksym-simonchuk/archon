import { readdir } from 'node:fs/promises';
import { emitKeypressEvents } from 'node:readline';
import { basename, join, relative } from 'node:path';
import { format } from 'node:util';
import { loadComputeCore } from './core/compute';
import { buildRuntime } from './runtime';
import { isWatchable } from './sensing/fs-watcher';
import { newRunId } from './services/event-bus';
import { applyCompletion, atTokenAtCursor, type AtToken, rankFilesByQuery } from './tui-completion';
import {
  bufferLines,
  cursorRowCol,
  insertAt,
  isMultiline,
  lineEnd as bufLineEnd,
  lineHome as bufLineHome,
  moveLineDown,
  moveLineUp,
} from './tui-input';
import { renderMarkdownLine } from './tui-markdown';
import { fenceLang, highlightDiff, highlightTs, isDiffLang, isTsLang } from './tui-syntax';
import {
  COMMANDS,
  dispatch,
  loadHistory,
  newSession,
  saveHistory,
  type ShellSession,
  suggestLine,
} from './shell';

/**
 * Full-screen interactive TUI — the `archon` surface on a TTY (the line-based
 * `startShell` is the non-TTY / piped fallback, see src/cli.ts). Zero new deps:
 * the alternate screen, layout, input box, slash-command menu, ghost-text
 * suggestion, and streaming transcript are hand-built from ANSI escapes; key
 * decoding reuses `node:readline`'s `emitKeypressEvents` (raw mode, no Interface).
 *
 * It reuses the shell's pure core unchanged — `dispatch` routes every command,
 * `suggestLine` powers ghost text, `COMMANDS` drives the menu, history is the
 * same `.archon/shell_history`. Because existing commands print via
 * `console.log` / `process.stdout.write`, the TUI captures those writes during a
 * command and feeds them into its own scrollback, so nothing in commands.ts had
 * to change. The renderer writes through a saved reference to the *real* stdout
 * so it never captures itself.
 */

// ── Pure helpers (exported for tests) ────────────────────────────────────────

const ANSI = /\x1b\[[0-9;]*m/g;
const ANSI_HEAD = /^\x1b\[[0-9;]*m/;

/**
 * Compact token count for the header chrome: `<1000` stays a literal integer,
 * `≥1000` collapses to a single-decimal `k` (so `12 345 → 12.3k`). Keeps the
 * header a single row even after long sessions.
 */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

/**
 * Trim a provider-qualified model id to its last segment for header display:
 * `anthropic/claude-sonnet-4-6 → claude-sonnet-4-6`, `openai:gpt-4o → gpt-4o`,
 * bare ids pass through. Pure cosmetic shortener — never used as a routing key.
 */
export function shortModel(id: string): string {
  const i = Math.max(id.lastIndexOf('/'), id.lastIndexOf(':'));
  return i === -1 ? id : id.slice(i + 1);
}

/** Visible width of a string, ignoring SGR colour escapes. */
export function visibleWidth(s: string): number {
  return s.replace(ANSI, '').length;
}

/** Hard-wrap `s` to `width` visible columns, treating colour escapes as zero-width. */
export function wrapLine(s: string, width: number): string[] {
  if (width <= 0) return [s];
  const out: string[] = [];
  let cur = '';
  let col = 0;
  let i = 0;
  while (i < s.length) {
    const m = s.slice(i).match(ANSI_HEAD);
    if (m) {
      cur += m[0];
      i += m[0].length;
      continue;
    }
    cur += s[i];
    col++;
    i++;
    if (col >= width) {
      out.push(cur);
      cur = '';
      col = 0;
    }
  }
  // A leftover with visible content (or the only line) becomes its own row; a
  // trailing escape-only remnant (e.g. a colour reset) attaches to the last row
  // so colour doesn't bleed and no phantom blank line appears.
  if (visibleWidth(cur) > 0 || out.length === 0) out.push(cur);
  else if (cur !== '') out[out.length - 1] += cur;
  return out;
}

/** The last `height` lines, scrolled up by `offset` (0 = bottom). */
export function tailLines(lines: string[], height: number, offset: number): string[] {
  if (height <= 0) return [];
  const end = Math.max(0, lines.length - Math.max(0, offset));
  const start = Math.max(0, end - height);
  return lines.slice(start, end);
}

/** Clip a string to `width` visible columns, resetting colour if cut mid-style. */
export function clip(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  let out = '';
  let col = 0;
  let i = 0;
  let styled = false;
  while (i < s.length && col < width) {
    const m = s.slice(i).match(ANSI_HEAD);
    if (m) {
      out += m[0];
      styled = true;
      i += m[0].length;
      continue;
    }
    out += s[i];
    col++;
    i++;
  }
  return styled ? `${out}\x1b[0m` : out;
}

/** Right-pad `s` with spaces to exactly `width` visible columns (ANSI-aware). */
function padTo(s: string, width: number): string {
  const pad = width - visibleWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

export interface InputState {
  buffer: string;
  cursor: number;
}

export interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

/**
 * Apply one editing keypress to the input line — pure. Handles cursor movement,
 * backspace/delete, and the common readline/emacs bindings (^A ^E ^U ^K ^W) plus
 * printable insertion. Non-editing keys (enter, up/down, tab, escape) return the
 * state unchanged; the loop handles those.
 */
export function editKey(s: InputState, key: Key): InputState {
  const { buffer, cursor } = s;
  const name = key.name;
  if (name === 'backspace') {
    if (cursor === 0) return s;
    return { buffer: buffer.slice(0, cursor - 1) + buffer.slice(cursor), cursor: cursor - 1 };
  }
  if (name === 'delete' && !key.ctrl) {
    if (cursor >= buffer.length) return s;
    return { buffer: buffer.slice(0, cursor) + buffer.slice(cursor + 1), cursor };
  }
  if (name === 'left') return cursor > 0 ? { buffer, cursor: cursor - 1 } : s;
  if (name === 'right') return cursor < buffer.length ? { buffer, cursor: cursor + 1 } : s;
  // Home/End/^A/^E are line-aware so they Do The Right Thing inside a multi-
  // line composition; for a single-line buffer they collapse to the old
  // buffer-start/end behaviour because `lineHome` of a buffer with no `\n` is 0
  // and `lineEnd` is `buffer.length`.
  if (name === 'home' || (key.ctrl && name === 'a')) return bufLineHome(s);
  if (name === 'end' || (key.ctrl && name === 'e')) return bufLineEnd(s);
  if (key.ctrl && name === 'u') {
    // Kill from the current line's start up to the cursor.
    const start = bufLineHome(s).cursor;
    return { buffer: buffer.slice(0, start) + buffer.slice(cursor), cursor: start };
  }
  if (key.ctrl && name === 'k') {
    // Kill from the cursor to the current line's end.
    const end = bufLineEnd(s).cursor;
    return { buffer: buffer.slice(0, cursor) + buffer.slice(end), cursor };
  }
  if (key.ctrl && name === 'w') {
    const left = buffer.slice(0, cursor);
    const m = left.match(/\s*\S+\s*$/);
    const cut = m ? m[0].length : cursor;
    return { buffer: buffer.slice(0, cursor - cut) + buffer.slice(cursor), cursor: cursor - cut };
  }
  const ch = key.sequence;
  if (!key.ctrl && !key.meta && typeof ch === 'string' && ch.length === 1 && ch >= ' ') {
    return { buffer: buffer.slice(0, cursor) + ch + buffer.slice(cursor), cursor: cursor + 1 };
  }
  return s;
}

/** Slash-command matches for the menu — only while typing the command word itself. */
export function commandMenu(buffer: string): string[] {
  if (!buffer.startsWith('/') || /\s/.test(buffer)) return [];
  return COMMANDS.filter((c) => c.startsWith(buffer));
}

/**
 * First index of the `max`-row scroll window that keeps the selected item
 * visible. The menu shows `items[start .. start+max]`; this slides `start` so
 * `sel` is always inside it (fixing the "selection scrolls off the bottom" bug).
 */
export function menuWindowStart(len: number, sel: number, max: number): number {
  if (len <= max || max <= 0) return 0;
  return Math.max(0, Math.min(sel - max + 1, len - max));
}

// ── Command descriptions (for the slash menu) ────────────────────────────────

const DESCRIPTIONS: Record<string, string> = {
  '/plan': 'plan a task — no writes',
  '/run': 'plan → act → verify in a worktree',
  '/ask': 'stream an answer (remembers turns; @path attaches a file)',
  '/clear': 'clear the /ask context + wipe the screen',
  '/index': 'incrementally index changed files',
  '/watch': 'reindex changed files + refresh health',
  '/impact': 'blast radius of a change to a file',
  '/explain': 'symbol definition + callers/callees',
  '/map': 'graph overview — most depended-on symbols',
  '/boundaries': 'bounded contexts, coupling, god modules, cycles',
  '/violations': 'architecture-health findings by impact',
  '/risk': 'change-risk level for a file',
  '/evolution': 'churn × coupling — god-object trends',
  '/decisions': 'ADR decision memory · propose',
  '/philosophy': 'inferred engineering culture',
  '/preserve': 'would a change erase intentional structure?',
  '/agents': 'project-native agents the stack implies',
  '/agent': 'bind the best-fit agent to a goal (--run to execute)',
  '/improve': 'conservative, ROI-ranked improvements',
  '/refactor': 'apply a proposal, simulation-gated, under an agent',
  '/hooks': 'pre-write gate + post-write checks',
  '/simulate': 'predict blast radius + regression before applying',
  '/path': 'shortest dependency chain a → b',
  '/status': 'task journal (· taskId for replay)',
  '/recap': 'per-run digest + health trend',
  '/cost': 'session spend vs budget',
  '/think': 'reasoning visibility off|summary|trace (never raw CoT)',
  '/approve': 'resolve a pending approval card (allow|deny [id])',
  '/diff': 'inspect & stage the queued patch (toggle e.h|apply|discard)',
  '/model': 'provider routing table',
  '/doctor': 'runtime readiness',
  '/memory': 'records · graph · recall',
  '/promote': 'confirm a memory promotion',
  '/plugins': 'loaded plugins + capability previews',
  '/skill': 'run executable multi-phase skills (analyze→simulate→validate→execute)',
  '/skills': 'skill playbooks',
  '/sh': 'run a command through the policy broker',
  '/policy': 'show the safety policy · check',
  '/tool': 'invoke a tool plugin (policy-gated)',
  '/help': 'show all commands',
  '/exit': 'leave the TUI',
  '/quit': 'leave the TUI',
};

// ── ANSI styling ─────────────────────────────────────────────────────────────

const useColor = !process.env.NO_COLOR;
const sgr =
  (code: string) =>
  (s: string): string =>
    useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const dim = sgr('2');
const bold = sgr('1');
const cyan = sgr('36');
const yellow = sgr('33');
const inverse = sgr('7');

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const HISTORY_FILE = 'shell_history';
const HISTORY_MAX = 1000;
const MENU_MAX = 6;
const PROMPT = ' › ';
const PROMPT_W = 3; // visible width of PROMPT
const PROMPT_CONT = ' '.repeat(PROMPT_W); // continuation indent for multi-line rows under the prompt
const SEARCH_PROMPT = ' ⌕ ';
const SEARCH_PROMPT_W = 3; // visible width of SEARCH_PROMPT
const MAX_INPUT_ROWS = 10; // cap the input box height; if the buffer exceeds it the window scrolls to keep the cursor visible
const PASTE_MODE_ON = '\x1b[?2004h';
const PASTE_MODE_OFF = '\x1b[?2004l';
/** Menu command column = the longest command, so descriptions stay aligned as it filters. */
const CMD_COL = Math.max(...COMMANDS.map((c) => c.length));
const BOX = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' } as const;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ── Approval card (M32) ─────────────────────────────────────────────────────
//
// Pure builder so the rendering is testable without spinning up a TUI session.
// Returns [] when there's nothing pending; otherwise a 5-row yellow-bordered
// card sized to `cols`. The card is informational — `/approve <a|d>` (handled
// in shell.ts) is what actually flips the broker.

export interface ApprovalCardInput {
  approvalId: string;
  capability: string;
  target: string;
  blastRadius: number;
  reason?: string;
  preview?: string;
}

export function buildApprovalCardRows(card: ApprovalCardInput | undefined, more: number, cols: number): string[] {
  if (!card || cols < 4) return [];
  const span = Math.max(0, cols - 2);
  const innerW = Math.max(0, cols - 2);
  const title = `${bold('⏵ approval requested')} ${dim(`(${card.capability} · ${card.blastRadius} files)`)}`;
  const target = card.target;
  const reasonTxt = card.reason ? ` · ${card.reason}` : '';
  const moreTxt = more > 0 ? ` · +${more} more` : '';
  const hint = `${dim(`/approve allow ${card.approvalId.slice(0, 12)}…`)}${dim(reasonTxt)}${dim(moreTxt)}`;
  return [
    yellow(`╭${'─'.repeat(span)}╮`),
    yellow('│') + padTo(clip(' ' + title, innerW), innerW) + yellow('│'),
    yellow('│') + padTo(clip(' ' + target, innerW), innerW) + yellow('│'),
    yellow('│') + padTo(clip(' ' + hint, innerW), innerW) + yellow('│'),
    yellow(`╰${'─'.repeat(span)}╯`),
  ];
}

// ── Alt-screen control ───────────────────────────────────────────────────────

const ENTER_ALT = '\x1b[?1049h';
const LEAVE_ALT = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

const BANNER = [
  `${bold('archon')} ${dim('— project-native engineering runtime')}`,
  dim('type a goal, or /help for commands · ↑↓ history · ^R search · Tab completes · ^C clears, again to exit'),
  '',
];

/**
 * Run the full-screen TUI against a freshly-built runtime until the user exits.
 * Builds one Runtime for the whole session (journal/memory/provider cache
 * persist), restores the terminal on every exit path.
 */
export async function startTui(): Promise<void> {
  const rt = await buildRuntime(process.cwd());
  const core = await loadComputeCore(); // fuzzy reverse-search ranks history in the Rust core
  const session: ShellSession = newSession();
  const historyFile = join(rt.root, '.archon', HISTORY_FILE);
  let history = loadHistory(historyFile); // most-recent-first

  const stdin = process.stdin;
  const stdout = process.stdout;
  const realWrite = stdout.write.bind(stdout); // the renderer's only path to the terminal

  // ── Scrollback transcript (captured command output) ────────────────────────
  const transcript: string[] = [...BANNER];
  let pending = ''; // partial last line (mid-stream, no newline yet)
  let scrollOffset = 0; // 0 = pinned to bottom
  let streamedChars = 0; // characters captured from stdout while busy — drives a fallback estimate when no bus deltas have arrived yet
  // Bus-driven turn telemetry (M26). The TUI subscribes to the runtime bus
  // (set up below) and tallies per-turn token counts. We track BOTH the live
  // delta-byte count (for a sub-second activity feel) and the precise
  // tokens.usage figures (final, from the provider). The header still shows
  // the router's cumulative totals; this is for the live status row only.
  let turnDeltaChars = 0; // characters arriving via `token.delta` events this turn
  let turnTokensIn = 0;
  let turnTokensOut = 0;
  let turnCostUsd = 0;
  // Approval card (M32). The bus subscriber accumulates requests here; the
  // renderer paints the oldest as a card above the input box. `/approve a|d`
  // resolves it through the broker which removes it from this list via the
  // matching `approval.resolve` event.
  interface PendingApproval {
    approvalId: string;
    capability: string;
    target: string;
    blastRadius: number;
    reason?: string;
    preview?: string;
  }
  let pendingApprovals: PendingApproval[] = [];
  // Claude-Code-style turn markers: the first output line of every turn is tagged
  // so it renders with a `⏺` glyph. `awaitingResponse` arms the next non-empty
  // pushed line as that start; `responseStarts` keeps the marks for scrollback.
  const responseStarts = new Set<number>();
  let awaitingResponse = false;

  const pushTranscript = (line: string): void => {
    if (awaitingResponse && line.trim() !== '') {
      responseStarts.add(transcript.length);
      awaitingResponse = false;
    }
    transcript.push(line);
  };
  const capture = (text: string): void => {
    pending += text.replace(/\r/g, '');
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    for (const p of parts) pushTranscript(p);
    if (busy) streamedChars += text.length; // feeds the live token estimate in the status line
    scrollOffset = 0; // new output snaps the view to the bottom
    scheduleRender();
  };

  // Route ALL command output (console.* and direct stdout/stderr writes) into the
  // transcript while the TUI owns the screen. Saved originals are restored on exit.
  const origStdoutWrite = stdout.write;
  const origStderrWrite = process.stderr.write;
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  const origInfo = console.info;
  const installCapture = (): void => {
    const sink = ((chunk: unknown, enc?: unknown, cb?: unknown): boolean => {
      capture(typeof chunk === 'string' ? chunk : String(chunk));
      if (typeof enc === 'function') (enc as () => void)();
      else if (typeof cb === 'function') (cb as () => void)();
      return true;
    }) as typeof stdout.write;
    stdout.write = sink;
    process.stderr.write = sink;
    console.log = (...a: unknown[]): void => capture(`${format(...a)}\n`);
    console.error = (...a: unknown[]): void => capture(`${format(...a)}\n`);
    console.warn = (...a: unknown[]): void => capture(`${format(...a)}\n`);
    console.info = (...a: unknown[]): void => capture(`${format(...a)}\n`);
  };
  const restoreCapture = (): void => {
    stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
    console.info = origInfo;
  };

  // ── Input + UI state ────────────────────────────────────────────────────────
  let input: InputState = { buffer: '', cursor: 0 };
  let menuSel = 0;
  let histIndex = -1; // -1 = live draft; 0..n-1 = into history
  let draft = ''; // the live draft stashed while browsing history
  let busy = false;
  let busyLabel = 'working…';
  let busyStart = 0; // ms timestamp the current command started (for elapsed time)
  let queued: string | null = null; // a line typed during a turn, auto-sent when it ends
  let spinnerFrame = 0;
  let armedExit = false; // first ^C on an empty line arms exit; second exits
  let running = true;

  // ── Bracketed paste — terminal wraps a paste in `\x1b[200~ … \x1b[201~`. We
  //    enable the mode on entry; while it's active a paste is inserted into the
  //    buffer as one block (newlines stay newlines), so a multi-line snippet
  //    can't fire N commands by tripping Enter per line.
  const PASTE_OPEN = '\x1b[200~';
  const PASTE_CLOSE = '\x1b[201~';
  let pasting = false;
  let pasteBuf = '';

  // ── @file Tab-completion menu state (Claude-Code-style mention picker) ───────
  let atMenu: { matches: string[]; sel: number; token: AtToken } | null = null;

  // ── Project-file index for @file completion — scanned once at startup off
  //    `rt.root`, filtered to the same source-file set the FS watcher cares
  //    about (no node_modules / dist / .git noise). The scan kicks off after
  //    `scheduleRender` is declared below so the closure resolves at fire time.
  let projectFiles: string[] = [];

  // ── Reverse-history search (^R) ───────────────────────────────────────────────
  let searchMode = false;
  let searchQuery = '';
  let searchMatches: number[] = []; // fuzzy-ranked indices into `history`
  let searchSel = 0;
  const recomputeSearch = async (): Promise<void> => {
    searchMatches = await core.fuzzyRank(searchQuery, history);
    if (searchSel >= searchMatches.length) searchSel = Math.max(0, searchMatches.length - 1);
    scheduleRender();
  };
  const enterSearch = (): void => {
    searchMode = true;
    searchQuery = '';
    searchSel = 0;
    void recomputeSearch();
  };

  // ── Renderer ────────────────────────────────────────────────────────────────
  let renderQueued = false;
  const scheduleRender = (): void => {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => {
      renderQueued = false;
      render();
    }, 16);
  };

  // ── Bus subscriber (M26): the TUI watches the v2 event bus to drive its
  // live token meter / cost row / future approval cards. We start a single
  // long-lived subscriber that updates per-turn counters and triggers a
  // re-render whenever counts change. The bus carries no authority — this is
  // pure observation. The subscriber ends when `rt.close()` is called (TUI
  // cleanup), which surfaces as a clean iterator end.
  let busSubAlive = true;
  void (async (): Promise<void> => {
    try {
      for await (const e of rt.bus.subscribe()) {
        if (!busSubAlive) break;
        // Only events from the currently-running turn move the meter; older
        // events (replay backfill, plugin emissions) are still observed but
        // don't kick the activity counters.
        const live = session.currentRunId && e.runId === session.currentRunId;
        if (live && e.kind === 'token.delta') {
          turnDeltaChars += e.text.length;
          scheduleRender();
        } else if (live && e.kind === 'tokens.usage') {
          turnTokensIn += e.usage.inputTokens;
          turnTokensOut += e.usage.outputTokens;
          turnCostUsd += e.usage.costUsd;
          scheduleRender();
        } else if (e.kind === 'approval.request') {
          // The broker is asking the user — render an inline card with the
          // approvalId so /approve allow|deny [id] can resolve it.
          pendingApprovals.push({
            approvalId: e.approvalId,
            capability: e.capability,
            target: e.target,
            blastRadius: e.blastRadius,
            ...(e.reason ? { reason: e.reason } : {}),
            ...(e.preview ? { preview: e.preview } : {}),
          });
          scheduleRender();
        } else if (e.kind === 'approval.resolve') {
          // Drop the matching pending entry — the broker has unblocked.
          pendingApprovals = pendingApprovals.filter((p) => p.approvalId !== e.approvalId);
          scheduleRender();
        } else if (e.kind === 'bus.lost') {
          // Surface back-pressure drops so the user knows the meter may be
          // under-counting (rare; only triggers under sustained 10k+ ev/s).
          pushTranscript(dim(`[bus] dropped ${e.dropped} events`));
          scheduleRender();
        }
      }
    } catch {
      // A subscriber crash must never affect the engine — silent on purpose.
    }
  })();

  // Kick off the project-file scan now that `scheduleRender` exists. Node 20.12+
  // exposes `parentPath` on Dirent; the project targets Node ≥20 so we rely on
  // it directly.
  void (async (): Promise<void> => {
    try {
      const entries = await readdir(rt.root, { recursive: true, withFileTypes: true });
      const out: string[] = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        const rel = relative(rt.root, join(e.parentPath, e.name)).split('\\').join('/');
        if (isWatchable(rel)) out.push(rel);
      }
      out.sort();
      projectFiles = out;
      scheduleRender();
    } catch {
      // Scan failure is non-fatal — @file completion just falls back to "no matches".
    }
  })();

  const headerRow = (cols: number): string => {
    const left = ` ${bold('archon')} ${dim('·')} ${basename(rt.root)} `;
    // Claude-Code-style token breakdown: last model · ↓input ↑output · $cost.
    // Compact `k` suffix once a counter passes 1k so the chrome stays a single line.
    const tokens = `↓${fmtTokens(rt.router.tokensIn)} ↑${fmtTokens(rt.router.tokensOut)}`;
    const lastModel = rt.router.lastModel;
    const modelChip = lastModel ? `${dim(shortModel(lastModel))} ${dim('·')} ` : '';
    const right = ` ${rt.config.profile} ${dim('·')} ${modelChip}${tokens} ${dim('·')} $${rt.router.spent.toFixed(4)} `;
    const gap = Math.max(1, cols - visibleWidth(left) - visibleWidth(right));
    return inverse(clip(left + ' '.repeat(gap) + right, cols));
  };

  const footerRow = (cols: number): string => {
    // While busy the activity line above the box carries the interrupt hint, so
    // the footer stays out of the way.
    if (busy) return '';
    const hint = searchMode
      ? dim('↵ accept · ^R next · ↑↓ select · Esc cancel · type to filter')
      : armedExit
        ? yellow('press ^C again to exit')
        : dim('↵ send · ⇥ complete · ↑↓ history · ^R search · ^C clear · /help');
    return clip(` ${hint}`, cols);
  };

  // The inner content of the framed input box (between the `│` borders), padded
  // to the exact inner width so the right border always aligns. `cursorCol` is
  // the absolute 1-based screen column, offset by 1 for the left border.
  // Claude-Code-style activity line: spinner, verb, and the "all the info" tail —
  // elapsed seconds, a live ≈token estimate while a model answer streams, and the
  // interrupt hint. Tokens are approximated from streamed characters (≈4 chars/token).
  const busyStatus = (): string => {
    const secs = Math.max(0, Math.round((Date.now() - busyStart) / 1000));
    const parts = [`${secs}s`];
    if (busyLabel === 'thinking…') {
      // Once the provider's `tokens.usage` event has landed for this turn we
      // surface real numbers (Claude-Code style: `↓ input  ↑ output`). Until
      // then a single approximate output count from streaming deltas keeps
      // the counter visibly moving so the user knows something's happening.
      if (turnTokensOut > 0 || turnTokensIn > 0) {
        parts.push(`↓${fmtTokens(turnTokensIn)} ↑${fmtTokens(turnTokensOut)}`);
      } else {
        const tok = Math.round((turnDeltaChars || streamedChars) / 4);
        if (tok > 0) parts.push(`≈${tok >= 1000 ? `${(tok / 1000).toFixed(1)}k` : tok} tok`);
      }
      if (turnCostUsd > 0) parts.push(`$${turnCostUsd.toFixed(4)}`);
    }
    parts.push('esc to interrupt');
    return parts.join(' · ');
  };

  // The activity line lives ABOVE the input box (Claude-Code style), so the box
  // itself always stays a clean prompt — the status is never painted into the
  // user's input field.
  const statusRow = (cols: number): string =>
    clip(` ${cyan(SPINNER[spinnerFrame])} ${bold(busyLabel)} ${dim(`(${busyStatus()})`)}`, cols);

  // The input box may span multiple rows now (Claude-Code-style multi-line
  // composition). Row 0 carries the `›` prompt; continuation rows are indented
  // under it. If the buffer has more lines than `MAX_INPUT_ROWS`, the visible
  // window slides so the cursor's row stays on screen. Ghost-suggest text from
  // `suggestLine` is only drawn for a single-line buffer at end-of-buffer.
  const inputBox = (cols: number): { rows: string[]; cursorRow: number; cursorCol: number } => {
    const innerW = Math.max(0, cols - 2); // floors at 0 so the box never exceeds `cols`
    const field = Math.max(1, innerW - PROMPT_W); // every row has the same writable width (continuations are space-indented)
    const lines = bufferLines(input.buffer);
    const { row, col } = cursorRowCol(input.buffer, input.cursor);
    // Slide the visible window so the cursor row is always inside it.
    const visibleRows = Math.min(lines.length, MAX_INPUT_ROWS);
    let winStart = 0;
    if (lines.length > visibleRows) {
      winStart = Math.max(0, Math.min(row - visibleRows + 1, lines.length - visibleRows));
      if (row < winStart) winStart = row;
    }

    const rows: string[] = [];
    for (let r = 0; r < visibleRows; r++) {
      const idx = winStart + r;
      const prompt = idx === 0 ? cyan(PROMPT) : PROMPT_CONT;
      const text = lines[idx];
      // Only the cursor's row scrolls horizontally; other rows render from col 0.
      const hscroll = idx === row && col > field - 1 ? col - (field - 1) : 0;
      const visible = text.slice(hscroll, hscroll + field);
      let ghost = '';
      if (idx === 0 && lines.length === 1 && input.cursor === input.buffer.length) {
        const sug = suggestLine(input.buffer, history);
        if (sug) {
          const tail = sug.slice(input.buffer.length);
          if (visibleWidth(visible) + tail.length < field) ghost = dim(tail);
        }
      }
      rows.push(padTo(clip(prompt + visible + ghost, innerW), innerW));
    }

    // Cursor screen position. The 1+PROMPT_W offset is the column inside the box,
    // accounting for the `│` border at col 1 and the prompt that occupies cols 2..PROMPT_W+1.
    const cursorHscroll = col > field - 1 ? col - (field - 1) : 0;
    const cursorRowInBox = row - winStart;
    const cursorCol = Math.min(1 + PROMPT_W + (col - cursorHscroll) + 1, Math.max(2, cols - 1));
    return { rows, cursorRow: cursorRowInBox, cursorCol };
  };

  // The search field shown in the box while ^R reverse-search is active: ` ⌕ query`,
  // amber prompt when the query matches nothing. Always one row.
  const searchBox = (cols: number): { rows: string[]; cursorRow: number; cursorCol: number } => {
    const innerW = Math.max(0, cols - 2);
    const field = Math.max(1, innerW - SEARCH_PROMPT_W);
    const hscroll = searchQuery.length > field - 1 ? searchQuery.length - (field - 1) : 0;
    const visible = searchQuery.slice(hscroll, hscroll + field);
    const noMatch = searchQuery !== '' && searchMatches.length === 0;
    const prompt = noMatch ? yellow(SEARCH_PROMPT) : cyan(SEARCH_PROMPT);
    const content = padTo(clip(prompt + visible, innerW), innerW);
    const cursorCol = Math.min(1 + SEARCH_PROMPT_W + (searchQuery.length - hscroll) + 1, Math.max(2, cols - 1));
    return { rows: [content], cursorRow: 0, cursorCol };
  };

  // Picker rows for `@file` Tab-completion — same windowed/overflow-marker
  // pattern as the slash menu, but shows `@path` entries and the captured token.
  const atMenuRows = (cols: number): string[] => {
    const menu = atMenu;
    if (!menu) return [];
    const start = menuWindowStart(menu.matches.length, menu.sel, MENU_MAX);
    const window = menu.matches.slice(start, start + MENU_MAX);
    return window.map((path, i) => {
      const abs = start + i;
      const selected = abs === menu.sel;
      const marker = selected
        ? cyan('›')
        : i === 0 && start > 0
          ? dim('▲')
          : i === window.length - 1 && start + window.length < menu.matches.length
            ? dim('▼')
            : ' ';
      const text = selected ? cyan(`@${path}`) : `@${path}`;
      return clip(`  ${marker} ${text}`, cols);
    });
  };

  // The fuzzy-ranked history matches under the search box (windowed like the menu).
  const searchRows = (cols: number): string[] => {
    if (searchMatches.length === 0) {
      return [clip(`  ${dim(searchQuery === '' ? '(type to search history)' : 'no matches')}`, cols)];
    }
    const start = menuWindowStart(searchMatches.length, searchSel, MENU_MAX);
    const window = searchMatches.slice(start, start + MENU_MAX);
    return window.map((idx, i) => {
      const abs = start + i;
      const selected = abs === searchSel;
      const marker = selected
        ? cyan('›')
        : i === 0 && start > 0
          ? dim('▲')
          : i === window.length - 1 && start + window.length < searchMatches.length
            ? dim('▼')
            : ' ';
      const text = history[idx] ?? '';
      return clip(`  ${marker} ${selected ? cyan(text) : text}`, cols);
    });
  };

  // `window` is the visible slice; `start` its absolute offset, `total` the full
  // match count — so the marker column can show ▲/▼ when items are scrolled off.
  const menuRows = (cols: number, window: string[], start: number, total: number): string[] =>
    window.map((cmd, i) => {
      const abs = start + i;
      const selected = abs === menuSel;
      const marker = selected
        ? cyan('›')
        : i === 0 && start > 0
          ? dim('▲')
          : i === window.length - 1 && start + window.length < total
            ? dim('▼')
            : ' ';
      const padded = cmd.padEnd(CMD_COL);
      const label = selected ? cyan(bold(padded)) : padded;
      return clip(`  ${marker} ${label}  ${dim(DESCRIPTIONS[cmd] ?? '')}`, cols);
    });

  // Approval card (M32). Delegates to the module-level `buildApprovalCardRows`
  // so the renderer stays testable in isolation.
  const approvalCardRows = (cols: number): string[] =>
    buildApprovalCardRows(pendingApprovals[0], Math.max(0, pendingApprovals.length - 1), cols);

  const render = (): void => {
    const cols = stdout.columns ?? 80;
    const rows = stdout.rows ?? 24;

    // Rows below the input box: fuzzy search matches (^R) win, then the @file
    // picker, then the slash menu.
    let belowBox: string[];
    if (searchMode) {
      belowBox = searchRows(cols);
    } else if (atMenu) {
      belowBox = atMenuRows(cols);
    } else {
      const items = commandMenu(input.buffer);
      if (menuSel >= items.length) menuSel = Math.max(0, items.length - 1);
      const menuStart = busy ? 0 : menuWindowStart(items.length, menuSel, MENU_MAX);
      const menu = busy ? [] : items.slice(menuStart, menuStart + MENU_MAX);
      belowBox = menuRows(cols, menu, menuStart, items.length);
    }

    // Approval card sits above the input — added to the chrome height budget
    // so it doesn't collide with the transcript. Five rows when present.
    const approvalRows = approvalCardRows(cols);

    // Build the input box rows up front so the variable height feeds into the
    // height budget. The box itself = box-top(1) + boxRows + box-bottom(1).
    const box = searchMode ? searchBox(cols) : inputBox(cols);
    const boxH = 2 + box.rows.length;

    // Fixed chrome = header(1) + box(boxH) + footer(1); plus statusH (activity
    // line and/or queued-type-ahead preview); plus belowBox; plus the approval
    // card if a request is pending (M32). The card is non-negotiable — it
    // displaces transcript rows, but never the input or the menu.
    const statusH = (busy ? 1 : 0) + (queued !== null ? 1 : 0);
    let approvalH = approvalRows.length;
    let transcriptHeight = rows - 2 - boxH - statusH - belowBox.length - approvalH;
    if (transcriptHeight < 1) {
      belowBox = [];
      transcriptHeight = rows - 2 - boxH - statusH - approvalH;
    }
    if (transcriptHeight < 1) {
      // Pathological tiny terminal: drop the card too so the input stays usable.
      approvalH = 0;
      transcriptHeight = Math.max(1, rows - 2 - boxH - statusH);
    }

    // Transcript display lines (wrapped), then the visible tail. Lines inside a
    // ``` fenced code block get TS/JS syntax highlighting (Claude-Code style);
    // the fence markers render dim. Highlighting is colour-only — skipped under
    // NO_COLOR — and runs on the logical line before wrapping.
    const logical = pending ? [...transcript, pending] : transcript;
    const wrapped: string[] = [];
    let fenceOpen = false;
    let currentLang = ''; // the lang on the open fence — drives highlighter choice
    let fenceLineNo = 0; // line counter inside the current fence (resets on open)
    for (let idx = 0; idx < logical.length; idx++) {
      const l = logical[idx];
      let rendered: string;
      const lang = useColor ? fenceLang(l) : undefined;
      if (lang !== undefined) {
        // Fence boundary. Opening renders as an inverse-video language chip
        // (` ts `, ` rust `, ` diff `, …); closing renders dim like before.
        fenceOpen = !fenceOpen;
        if (fenceOpen) {
          currentLang = lang;
          fenceLineNo = 0;
          rendered = inverse(` ${lang || 'code'} `);
        } else {
          currentLang = '';
          rendered = dim(l);
        }
      } else if (fenceOpen) {
        // Inside a code fence. TS/JS → syntax HL; diff/patch → +/- coloring;
        // everything else → raw. A dim right-aligned line number prefixes each
        // line so model-emitted code reads like Claude Code.
        fenceLineNo++;
        const code = isTsLang(currentLang)
          ? highlightTs(l)
          : isDiffLang(currentLang)
            ? highlightDiff(l)
            : l;
        rendered = `${dim(fenceLineNo.toString().padStart(3))} ${code}`;
      } else {
        // Prose: render the model's plain text as Markdown. renderMarkdownLine
        // no-ops on ANSI-styled lines, so the user-echo, banner and pre-styled
        // command output pass through untouched.
        rendered = useColor ? renderMarkdownLine(l) : l;
      }
      // The first line of each turn's output carries a `⏺` marker (Claude-Code
      // style). The 2-col marker replaces the 2-space indent, so wrapped
      // continuation rows stay aligned under the text. `pending` (the streaming,
      // not-yet-flushed line at index === transcript.length) is marked live.
      const isStart =
        responseStarts.has(idx) || (awaitingResponse && idx === transcript.length && l.trim() !== '');
      const rows = wrapLine(rendered, cols - 2);
      for (let r = 0; r < rows.length; r++) {
        wrapped.push(`${isStart && r === 0 ? `${cyan('⏺')} ` : '  '}${rows[r]}`);
      }
    }
    const view = tailLines(wrapped, transcriptHeight, scrollOffset);

    const frame: string[] = [headerRow(cols)];
    for (let i = 0; i < transcriptHeight; i++) frame.push(view[i] ?? '');

    // Activity line above the box, only while a turn runs; the queued type-ahead
    // line (if any) sits just under it.
    if (busy) frame.push(statusRow(cols));
    if (queued !== null) frame.push(clip(dim(` ⏎ queued — ${queued}`), cols));

    // Approval card sits above the input box so the user reads it in the same
    // glance as the prompt they're about to type into.
    if (approvalH > 0) for (const r of approvalRows) frame.push(r);

    // Framed input box: ╭──╮ / │ … │ × boxRows / ╰──╯. The cursor sits on the
    // box row that matches the buffer's cursor row (Claude-Code multi-line look).
    const span = Math.max(0, cols - 2);
    frame.push(dim(BOX.tl + BOX.h.repeat(span) + BOX.tr));
    const inputContentStart = frame.length; // 0-based index of the FIRST content row
    for (const r of box.rows) frame.push(dim(BOX.v) + r + dim(BOX.v));
    frame.push(dim(BOX.bl + BOX.h.repeat(span) + BOX.br));

    for (const m of belowBox) frame.push(m);
    frame.push(footerRow(cols));

    // Paint the whole frame in one write to minimise flicker.
    let out = HIDE_CURSOR + '\x1b[H';
    for (let r = 0; r < frame.length; r++) {
      out += `${frame[r]}\x1b[K`;
      if (r < frame.length - 1) out += '\r\n';
    }
    out += '\x1b[J';
    // The input stays live during a turn (type-ahead), so show the cursor too.
    if (box.cursorCol > 0) {
      const cursorScreenRow = inputContentStart + box.cursorRow + 1; // +1 = 1-based terminal rows
      out += `\x1b[${cursorScreenRow};${box.cursorCol}H${SHOW_CURSOR}`;
    }
    realWrite(out);
  };

  // ── Submitting a line ─────────────────────────────────────────────────────────
  const recordHistory = (line: string): void => {
    history = [line, ...history.filter((h) => h !== line)].slice(0, HISTORY_MAX);
  };

  const submit = async (line: string): Promise<void> => {
    awaitingResponse = false; // clear any leak from a previous no-output turn
    // Separate conversation turns with a blank line (but never lead with one).
    if (transcript.length > 0 && transcript[transcript.length - 1] !== '') pushTranscript('');
    pushTranscript(`${cyan('>')} ${line}`); // Claude-Code-style user-message echo
    recordHistory(line);
    input = { buffer: '', cursor: 0 };
    histIndex = -1;
    menuSel = 0;
    busy = true;
    busyLabel = line.startsWith('/ask') || !line.startsWith('/') ? 'thinking…' : 'working…';
    busyStart = Date.now();
    streamedChars = 0;
    // Mint a turn runId + reset per-turn telemetry. The bus subscriber (set up
    // below) updates these counters as `token.delta` and `tokens.usage` arrive.
    // Threaded through the session so `cmdAsk` can hand it to streamComplete.
    session.currentRunId = newRunId();
    turnDeltaChars = 0;
    turnTokensIn = 0;
    turnTokensOut = 0;
    turnCostUsd = 0;
    // Mark the start of this turn on the bus too — replay reconstructs the
    // session timeline from `turn.start` boundaries.
    rt.bus.publish({ kind: 'turn.start', runId: session.currentRunId, at: Date.now(), goal: line });
    awaitingResponse = true; // the next captured output line begins this turn's response
    render();
    try {
      const cont = await dispatch(rt, line, session);
      if (!cont) running = false;
    } catch (e) {
      pushTranscript(`${yellow('[archon]')} ${msg(e)}`);
    } finally {
      if (pending) {
        pushTranscript(pending);
        pending = '';
      }
      // `/clear` should wipe the on-screen scrollback too, not just the /ask
      // conversation context (dispatch already reset that). Match the user's
      // "clear the chat" expectation: drop the transcript and unpin the scroll.
      if (line.trim() === '/clear') {
        transcript.length = 0;
        scrollOffset = 0;
        responseStarts.clear();
        awaitingResponse = false;
        pushTranscript(dim('context cleared'));
      }
      // Publish the turn boundary so OTel/replay can close the span.
      if (session.currentRunId) {
        rt.bus.publish({
          kind: 'turn.done',
          runId: session.currentRunId,
          at: Date.now(),
          ok: true,
        });
      }
      session.currentRunId = undefined;
      busy = false;
      render();
      // A line composed during the turn (type-ahead) auto-sends now.
      if (queued !== null) {
        const next = queued;
        queued = null;
        void submit(next);
      }
    }
  };

  // ── Key handling ──────────────────────────────────────────────────────────────
  const onKey = (_str: string | undefined, key: Key | undefined): void => {
    if (!key) return;

    // Bracketed paste — the terminal wraps a paste in `\x1b[200~ … \x1b[201~`.
    // We funnel the whole paste into the buffer as one insertion, so multi-line
    // content can't fire N commands by tripping Enter per line. Handle the
    // case where the whole paste arrives in one event AND the case where it
    // streams as many small keypresses with the markers split off.
    const seq = key.sequence ?? '';
    if (pasting) {
      const close = seq.indexOf(PASTE_CLOSE);
      if (close !== -1) {
        pasteBuf += seq.slice(0, close);
        input = insertAt(input, pasteBuf);
        pasting = false;
        pasteBuf = '';
        atMenu = null;
        render();
        return;
      }
      // Inside a paste, Enter/Return is a literal newline, not a submit.
      if (key.name === 'return' || key.name === 'enter') pasteBuf += '\n';
      else pasteBuf += seq;
      return;
    }
    if (seq.startsWith(PASTE_OPEN)) {
      const rest = seq.slice(PASTE_OPEN.length);
      const close = rest.indexOf(PASTE_CLOSE);
      if (close !== -1) {
        input = insertAt(input, rest.slice(0, close));
        atMenu = null;
        render();
      } else {
        pasting = true;
        pasteBuf = rest;
      }
      return;
    }

    // Reverse-history search owns every key while active.
    if (searchMode) {
      if (key.name === 'escape' || (key.ctrl && (key.name === 'g' || key.name === 'c'))) {
        searchMode = false;
        render();
        return;
      }
      if (key.ctrl && key.name === 'r') {
        if (searchMatches.length > 0) searchSel = (searchSel + 1) % searchMatches.length;
        render();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        // Accept the highlighted match into the input line — edit, then Enter to run.
        const idx = searchMatches[searchSel];
        const line = idx === undefined ? undefined : history[idx];
        if (line !== undefined) input = { buffer: line, cursor: line.length };
        searchMode = false;
        histIndex = -1;
        render();
        return;
      }
      if (key.name === 'up' && searchMatches.length > 0) {
        searchSel = (searchSel - 1 + searchMatches.length) % searchMatches.length;
        render();
        return;
      }
      if (key.name === 'down' && searchMatches.length > 0) {
        searchSel = (searchSel + 1) % searchMatches.length;
        render();
        return;
      }
      if (key.name === 'backspace') {
        searchQuery = searchQuery.slice(0, -1);
        searchSel = 0;
        void recomputeSearch();
        return;
      }
      const sc = key.sequence;
      if (!key.ctrl && !key.meta && typeof sc === 'string' && sc.length === 1 && sc >= ' ') {
        searchQuery += sc;
        searchSel = 0;
        void recomputeSearch();
      }
      return; // swallow anything else while searching
    }

    // ^C — cancel a stream, clear the line, or (twice on an empty line) exit.
    if (key.ctrl && key.name === 'c') {
      if (busy) {
        if (session.abort) session.abort.abort();
        return;
      }
      if (input.buffer.length > 0) {
        input = { buffer: '', cursor: 0 };
        histIndex = -1;
        armedExit = false;
      } else if (armedExit) {
        running = false;
        cleanup();
        return;
      } else {
        armedExit = true;
      }
      render();
      return;
    }
    armedExit = false;

    // While a turn runs the input stays live (Claude-Code-style type-ahead):
    // edit the next message freely, Esc interrupts the model, and Enter queues
    // the line to auto-send the moment the turn finishes.
    if (busy) {
      if (key.name === 'escape') {
        if (session.abort) session.abort.abort();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const line = input.buffer.trim();
        if (line) {
          queued = line;
          input = { buffer: '', cursor: 0 };
          render();
        }
        return;
      }
      const next = editKey(input, key);
      if (next !== input) {
        input = next;
        render();
      }
      return;
    }

    // ^L — clear the screen (readline convention); keeps the /ask context, unlike /clear.
    if (key.ctrl && key.name === 'l') {
      transcript.length = 0;
      responseStarts.clear();
      awaitingResponse = false;
      scrollOffset = 0;
      render();
      return;
    }

    // @file completion menu owns Tab/Up/Down/Enter/Esc while it's open. Any
    // other key dismisses it and falls through, so typing extends the buffer
    // normally.
    if (atMenu) {
      if (key.name === 'escape') { atMenu = null; render(); return; }
      if (key.name === 'tab' || key.name === 'down') {
        atMenu = { ...atMenu, sel: (atMenu.sel + 1) % atMenu.matches.length };
        render();
        return;
      }
      if (key.name === 'up') {
        atMenu = { ...atMenu, sel: (atMenu.sel - 1 + atMenu.matches.length) % atMenu.matches.length };
        render();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const picked = atMenu.matches[atMenu.sel];
        const next = applyCompletion(input.buffer, atMenu.token, picked);
        input = next;
        atMenu = null;
        render();
        return;
      }
      atMenu = null; // any other key — dismiss and let it process below
    }

    // ^R — enter reverse-history search (fuzzy, ranked in the Rust core).
    if (key.ctrl && key.name === 'r') {
      if (history.length > 0) enterSearch();
      return;
    }

    // ^D — EOF on an empty line exits; otherwise forward-delete.
    if (key.ctrl && key.name === 'd') {
      if (input.buffer.length === 0) {
        running = false;
        cleanup();
        return;
      }
      input = editKey(input, { name: 'delete' });
      render();
      return;
    }

    const items = commandMenu(input.buffer);
    const menuActive = items.length > 0;

    if (key.name === 'return' || key.name === 'enter') {
      // Alt+Enter inserts a newline (multi-line composition) — emitKeypressEvents
      // flags this with `key.meta`.
      if (key.meta) {
        input = insertAt(input, '\n');
        render();
        return;
      }
      // `\`+Enter at the cursor is the fallback newline shortcut for terminals
      // that don't propagate Alt+Enter (Claude-Code convention). It replaces the
      // trailing `\` with `\n`.
      if (input.cursor > 0 && input.buffer[input.cursor - 1] === '\\') {
        input = {
          buffer: input.buffer.slice(0, input.cursor - 1) + '\n' + input.buffer.slice(input.cursor),
          cursor: input.cursor, // 1-char replaced with 1-char
        };
        render();
        return;
      }
      // On the menu, Enter first completes to the highlighted command; a second
      // Enter (now an exact match) submits — so a partial command never runs.
      if (menuActive && items[menuSel] !== undefined && items[menuSel] !== input.buffer) {
        const pick = items[menuSel];
        input = { buffer: pick, cursor: pick.length };
        menuSel = 0;
        render();
        return;
      }
      const line = input.buffer.trim();
      if (line) void submit(line);
      return;
    }

    if (key.name === 'tab') {
      // @file completion has priority — when the cursor sits inside an `@token`
      // and the project scan has finished, open the picker (Claude-Code-style).
      const token = atTokenAtCursor(input.buffer, input.cursor);
      if (token && projectFiles.length > 0) {
        const matches = rankFilesByQuery(token.query, projectFiles, 30);
        if (matches.length > 0) {
          atMenu = { matches, sel: 0, token };
          render();
          return;
        }
      }
      if (menuActive) {
        const pick = items[menuSel] ?? items[0];
        input = { buffer: pick, cursor: pick.length };
        menuSel = 0;
      }
      render();
      return;
    }

    // Up/Down: drive the slash menu when it's open, navigate rows inside a
    // multi-line buffer when there is one, otherwise step through history.
    if (key.name === 'up') {
      if (menuActive) menuSel = (menuSel - 1 + items.length) % items.length;
      else if (isMultiline(input.buffer)) input = moveLineUp(input);
      else historyPrev();
      render();
      return;
    }
    if (key.name === 'down') {
      if (menuActive) menuSel = (menuSel + 1) % items.length;
      else if (isMultiline(input.buffer)) input = moveLineDown(input);
      else historyNext();
      render();
      return;
    }

    // → at end-of-line accepts the ghost suggestion.
    if (key.name === 'right' && input.cursor === input.buffer.length) {
      const sug = suggestLine(input.buffer, history);
      if (sug) {
        input = { buffer: sug, cursor: sug.length };
        render();
        return;
      }
    }

    // PageUp/PageDown scroll the transcript.
    if (key.name === 'pageup') {
      scrollOffset += 5;
      render();
      return;
    }
    if (key.name === 'pagedown') {
      scrollOffset = Math.max(0, scrollOffset - 5);
      render();
      return;
    }

    const next = editKey(input, key);
    if (next !== input) {
      input = next;
      menuSel = 0;
      if (histIndex !== -1) histIndex = -1; // editing leaves history browsing
      render();
    }
  };

  const historyPrev = (): void => {
    if (history.length === 0) return;
    if (histIndex === -1) draft = input.buffer;
    histIndex = Math.min(history.length - 1, histIndex + 1);
    const line = history[histIndex];
    input = { buffer: line, cursor: line.length };
  };
  const historyNext = (): void => {
    if (histIndex === -1) return;
    histIndex--;
    const line = histIndex === -1 ? draft : history[histIndex];
    input = { buffer: line, cursor: line.length };
  };

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    stdin.off('keypress', onKey);
    stdout.off('resize', render);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    restoreCapture();
    realWrite(`${PASTE_MODE_OFF}${SHOW_CURSOR}${LEAVE_ALT}`);
    // Stop the bus subscriber first — `rt.close()` then closes the bus, which
    // ends the iterator cleanly. The flag flips the loop into an early break
    // even if a publish lands in the same tick as close.
    busSubAlive = false;
    rt.close();
    saveHistory(historyFile, history);
  };

  return new Promise<void>((resolve) => {
    realWrite(`${ENTER_ALT}${HIDE_CURSOR}${PASTE_MODE_ON}`);
    installCapture();
    emitKeypressEvents(stdin);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKey);
    stdout.on('resize', render);

    // Spinner animation while a command runs.
    const spinTimer = setInterval(() => {
      if (busy) {
        spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
        render();
      }
    }, 90);

    render();

    // Resolve when `running` flips false (set by /exit, /quit, or ^C/^D).
    const watch = setInterval(() => {
      if (!running) {
        clearInterval(watch);
        clearInterval(spinTimer);
        cleanup();
        resolve();
      }
    }, 30);
  });
}
