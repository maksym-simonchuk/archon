import { emitKeypressEvents } from 'node:readline';
import { basename, join } from 'node:path';
import { format } from 'node:util';
import { loadComputeCore } from './core/compute';
import { buildRuntime } from './runtime';
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
  if (name === 'home' || (key.ctrl && name === 'a')) return { buffer, cursor: 0 };
  if (name === 'end' || (key.ctrl && name === 'e')) return { buffer, cursor: buffer.length };
  if (key.ctrl && name === 'u') return { buffer: buffer.slice(cursor), cursor: 0 };
  if (key.ctrl && name === 'k') return { buffer: buffer.slice(0, cursor), cursor };
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
  '/clear': 'forget the /ask conversation',
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
const SEARCH_PROMPT = ' ⌕ ';
const SEARCH_PROMPT_W = 3; // visible width of SEARCH_PROMPT
/** Menu command column = the longest command, so descriptions stay aligned as it filters. */
const CMD_COL = Math.max(...COMMANDS.map((c) => c.length));
const BOX = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' } as const;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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

  const pushTranscript = (line: string): void => {
    transcript.push(line);
  };
  const capture = (text: string): void => {
    pending += text.replace(/\r/g, '');
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    for (const p of parts) pushTranscript(p);
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
  let spinnerFrame = 0;
  let armedExit = false; // first ^C on an empty line arms exit; second exits
  let running = true;

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

  const headerRow = (cols: number): string => {
    const planner = rt.llmPlanning ? 'llm' : 'scaffold';
    const left = ` ${bold('archon')} ${dim('·')} ${basename(rt.root)} `;
    const right = ` ${rt.config.profile} ${dim('·')} ${planner} ${dim('·')} $${rt.router.spent.toFixed(4)} `;
    const gap = Math.max(1, cols - visibleWidth(left) - visibleWidth(right));
    return inverse(clip(left + ' '.repeat(gap) + right, cols));
  };

  const footerRow = (cols: number): string => {
    const hint = busy
      ? `${cyan(SPINNER[spinnerFrame])} ${dim('^C to cancel')}`
      : searchMode
        ? dim('↵ accept · ^R next · ↑↓ select · Esc cancel · type to filter')
        : armedExit
          ? yellow('press ^C again to exit')
          : dim('↵ send · ⇥ complete · ↑↓ history · ^R search · ^C clear · /help');
    return clip(` ${hint}`, cols);
  };

  // The inner content of the framed input box (between the `│` borders), padded
  // to the exact inner width so the right border always aligns. `cursorCol` is
  // the absolute 1-based screen column, offset by 1 for the left border.
  const inputContent = (cols: number): { content: string; cursorCol: number } => {
    const innerW = Math.max(0, cols - 2); // floors at 0 so the box never exceeds `cols`
    if (busy) {
      return { content: padTo(clip(`${cyan(SPINNER[spinnerFrame])} ${dim(busyLabel)}`, innerW), innerW), cursorCol: -1 };
    }
    const field = Math.max(1, innerW - PROMPT_W); // visible columns for the buffer itself
    const hscroll = input.cursor > field - 1 ? input.cursor - (field - 1) : 0;
    const visible = input.buffer.slice(hscroll, hscroll + field);
    let ghost = '';
    if (input.cursor === input.buffer.length) {
      const sug = suggestLine(input.buffer, history);
      if (sug) {
        const tail = sug.slice(input.buffer.length);
        if (visibleWidth(visible) + tail.length < field) ghost = dim(tail);
      }
    }
    const content = padTo(clip(cyan(PROMPT) + visible + ghost, innerW), innerW);
    // Clamp inside the borders: col 1 is `│`, col `cols` is the right `│`.
    const cursorCol = Math.min(1 + PROMPT_W + (input.cursor - hscroll) + 1, Math.max(2, cols - 1));
    return { content, cursorCol };
  };

  // The search field shown in the box while ^R reverse-search is active: ` ⌕ query`,
  // amber prompt when the query matches nothing. Cursor trails the query text.
  const searchContent = (cols: number): { content: string; cursorCol: number } => {
    const innerW = Math.max(0, cols - 2);
    const field = Math.max(1, innerW - SEARCH_PROMPT_W);
    const hscroll = searchQuery.length > field - 1 ? searchQuery.length - (field - 1) : 0;
    const visible = searchQuery.slice(hscroll, hscroll + field);
    const noMatch = searchQuery !== '' && searchMatches.length === 0;
    const prompt = noMatch ? yellow(SEARCH_PROMPT) : cyan(SEARCH_PROMPT);
    const content = padTo(clip(prompt + visible, innerW), innerW);
    const cursorCol = Math.min(1 + SEARCH_PROMPT_W + (searchQuery.length - hscroll) + 1, Math.max(2, cols - 1));
    return { content, cursorCol };
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

  const render = (): void => {
    const cols = stdout.columns ?? 80;
    const rows = stdout.rows ?? 24;

    // Rows below the input box: the fuzzy search matches (^R), else the slash menu.
    let belowBox: string[];
    if (searchMode) {
      belowBox = searchRows(cols);
    } else {
      const items = commandMenu(input.buffer);
      if (menuSel >= items.length) menuSel = Math.max(0, items.length - 1);
      const menuStart = busy ? 0 : menuWindowStart(items.length, menuSel, MENU_MAX);
      const menu = busy ? [] : items.slice(menuStart, menuStart + MENU_MAX);
      belowBox = menuRows(cols, menu, menuStart, items.length);
    }

    // Fixed chrome = header(1) + input box(3) + footer(1) = 5 rows.
    let transcriptHeight = rows - 5 - belowBox.length;
    if (transcriptHeight < 1) {
      belowBox = [];
      transcriptHeight = Math.max(1, rows - 5);
    }

    // Transcript display lines (wrapped), then the visible tail.
    const logical = pending ? [...transcript, pending] : transcript;
    const wrapped: string[] = [];
    for (const l of logical) for (const w of wrapLine(l, cols - 2)) wrapped.push(`  ${w}`);
    const view = tailLines(wrapped, transcriptHeight, scrollOffset);

    const frame: string[] = [headerRow(cols)];
    for (let i = 0; i < transcriptHeight; i++) frame.push(view[i] ?? '');

    // Framed input box: ╭──╮ / │ › … │ / ╰──╯. The cursor sits on the middle row.
    const span = Math.max(0, cols - 2);
    frame.push(dim(BOX.tl + BOX.h.repeat(span) + BOX.tr));
    const { content, cursorCol } = searchMode ? searchContent(cols) : inputContent(cols);
    const inputRowIndex = frame.length; // 0-based index of the input line in `frame`
    frame.push(dim(BOX.v) + content + dim(BOX.v));
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
    if (cursorCol > 0) out += `\x1b[${inputRowIndex + 1};${cursorCol}H${SHOW_CURSOR}`;
    realWrite(out);
  };

  // ── Submitting a line ─────────────────────────────────────────────────────────
  const recordHistory = (line: string): void => {
    history = [line, ...history.filter((h) => h !== line)].slice(0, HISTORY_MAX);
  };

  const submit = async (line: string): Promise<void> => {
    // Separate conversation turns with a blank line (but never lead with one).
    if (transcript.length > 0 && transcript[transcript.length - 1] !== '') pushTranscript('');
    pushTranscript(`${cyan(bold('›'))} ${bold(line)}`);
    recordHistory(line);
    input = { buffer: '', cursor: 0 };
    histIndex = -1;
    menuSel = 0;
    busy = true;
    busyLabel = line.startsWith('/ask') || !line.startsWith('/') ? 'thinking…' : 'working…';
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
      busy = false;
      render();
    }
  };

  // ── Key handling ──────────────────────────────────────────────────────────────
  const onKey = (_str: string | undefined, key: Key | undefined): void => {
    if (!key) return;

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

    if (busy) return; // ignore everything else mid-command

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
      if (menuActive) {
        const pick = items[menuSel] ?? items[0];
        input = { buffer: pick, cursor: pick.length };
        menuSel = 0;
      }
      render();
      return;
    }

    // Up/Down drive the menu when it's open, else history.
    if (key.name === 'up') {
      if (menuActive) menuSel = (menuSel - 1 + items.length) % items.length;
      else historyPrev();
      render();
      return;
    }
    if (key.name === 'down') {
      if (menuActive) menuSel = (menuSel + 1) % items.length;
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
    realWrite(`${SHOW_CURSOR}${LEAVE_ALT}`);
    rt.close();
    saveHistory(historyFile, history);
  };

  return new Promise<void>((resolve) => {
    realWrite(`${ENTER_ALT}${HIDE_CURSOR}`);
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
