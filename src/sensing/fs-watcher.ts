import { watch as fsWatch } from 'node:fs';

/**
 * M22 daemon — a real filesystem-event watcher, replacing the git-status poller
 * as the *trigger* for incremental re-indexing. `watchTree` wraps Node's native
 * recursive `fs.watch` (zero dependencies) and feeds raw change events into a
 * {@link ChangeBatcher}, which debounces a burst of edits into a single batch of
 * source-file paths. The pure pieces — the watchable-path filter and the
 * batcher — are exported and tested without a clock or a filesystem; only the
 * thin `watchTree` glue touches `fs.watch`.
 *
 * Like the Indexer and the structural analyzer, this is a Sensing-plane reader:
 * it only *observes* file changes, it never writes, so it reads `fs` directly
 * rather than through the Capability Broker (the broker gates effects agents
 * propose, not the runtime's own observation of the tree).
 */

// Directory names that never carry source signal — an event anywhere beneath one
// is ignored (mirrors the structural analyzer's NOISE_DIRS).
const WATCH_NOISE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.archon',
  'target',
  '.next',
  'out',
  '.cache',
]);

/**
 * Whether a repo-relative path is worth reacting to: a JS/TS source file (not a
 * `.d.ts`) outside every noise directory. Keeps the watcher quiet for builds,
 * dependencies, VCS churn, and the index's own writes under `.archon/`.
 */
export function isWatchable(relPath: string): boolean {
  const segments = relPath.split('/');
  if (segments.some((s) => WATCH_NOISE.has(s))) return false;
  return /\.[cm]?[jt]sx?$/.test(relPath) && !relPath.endsWith('.d.ts');
}

/** A cancellable scheduled callback — abstracted so tests drive timing by hand. */
export interface ScheduledTimer {
  cancel(): void;
}
export type Schedule = (fn: () => void, ms: number) => ScheduledTimer;

/** Default schedule: an unref'd `setTimeout` (never keeps the process alive). */
export const defaultSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
};

export interface ChangeBatcherOptions {
  /** Coalesce events into one batch after this many ms of quiet. */
  debounceMs: number;
  /** Filter applied to every pushed path; rejected paths are dropped. */
  accept: (relPath: string) => boolean;
  /** Emit a deduplicated, sorted batch of accepted paths. */
  onFlush: (paths: string[]) => void;
  /** Timer factory (default {@link defaultSchedule}); inject a fake one in tests. */
  schedule?: Schedule;
}

/**
 * Debounces a stream of raw change paths into batches. Each accepted `push`
 * (re)arms a single timer; when it fires after `debounceMs` of quiet, the
 * accumulated distinct paths are flushed (sorted) and the set is cleared. A
 * burst of edits to many files therefore yields one reindex, not one per event.
 */
export class ChangeBatcher {
  private readonly pending = new Set<string>();
  private readonly schedule: Schedule;
  private timer: ScheduledTimer | undefined;

  constructor(private readonly opts: ChangeBatcherOptions) {
    this.schedule = opts.schedule ?? defaultSchedule;
  }

  /** Record a changed path (if accepted) and (re)arm the debounce timer. */
  push(relPath: string): void {
    if (!this.opts.accept(relPath)) return;
    this.pending.add(relPath);
    this.timer?.cancel();
    this.timer = this.schedule(() => this.flush(), this.opts.debounceMs);
  }

  /** Emit the pending batch immediately (no-op when nothing is pending). */
  flush(): void {
    this.timer?.cancel();
    this.timer = undefined;
    if (this.pending.size === 0) return;
    const paths = [...this.pending].sort();
    this.pending.clear();
    this.opts.onFlush(paths);
  }

  /** Count of distinct paths awaiting the next flush. */
  get size(): number {
    return this.pending.size;
  }
}

export interface TreeWatcher {
  close(): void;
}

/**
 * Watch `root` recursively for source-file changes, invoking `onBatch` with the
 * debounced set of changed repo-relative paths. Returns a handle to stop it, or
 * `undefined` when the platform does not support recursive `fs.watch` (the
 * caller should fall back to polling). Closing flushes any pending batch so a
 * final edit is never dropped.
 */
export function watchTree(
  root: string,
  onBatch: (paths: string[]) => void,
  opts: { debounceMs?: number; schedule?: Schedule } = {},
): TreeWatcher | undefined {
  const batcher = new ChangeBatcher({
    debounceMs: opts.debounceMs ?? 300,
    accept: isWatchable,
    schedule: opts.schedule,
    onFlush: onBatch,
  });
  try {
    const watcher = fsWatch(root, { recursive: true }, (_event, filename) => {
      if (filename === null) return;
      // fs.watch yields a path relative to `root`; normalise Windows separators.
      const rel = String(filename).split('\\').join('/');
      batcher.push(rel);
    });
    return {
      close: () => {
        watcher.close();
        batcher.flush();
      },
    };
  } catch {
    return undefined; // recursive fs.watch unsupported here → caller polls instead
  }
}
