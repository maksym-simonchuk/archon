/**
 * M22 daemon support — the pure tick-diff for the `watch` poller.
 *
 * The watcher polls the working tree's dirty set (git status, via the Indexer)
 * on an interval and incrementally reindexes it. The Indexer already skips files
 * whose content hash is unchanged (ADR-0005), so reindexing the whole dirty set
 * every tick is cheap and never a full rescan; this module's job is purely to
 * describe what *changed between ticks* so the daemon can print a one-line delta
 * and stay quiet when nothing moved. Pure + exported so the diff is testable
 * without a clock or a filesystem.
 */

export interface WatchDelta {
  /** Paths that became dirty since the previous tick (newly edited / created). Sorted. */
  readonly entered: readonly string[];
  /** Paths no longer dirty since the previous tick (committed / reverted / deleted). Sorted. */
  readonly left: readonly string[];
  /** The full dirty set at this tick — thread back as `prev` on the next call. */
  readonly current: ReadonlySet<string>;
  /** True when the dirty set is identical to `prev` — the daemon prints nothing. */
  readonly quiet: boolean;
}

/** Pure set-diff of two consecutive dirty snapshots. Order-stable (sorted). */
export function changedSince(prev: ReadonlySet<string>, curr: readonly string[]): WatchDelta {
  const current = new Set(curr);
  const entered = [...current].filter((p) => !prev.has(p)).sort();
  const left = [...prev].filter((p) => !current.has(p)).sort();
  return { entered, left, current, quiet: entered.length === 0 && left.length === 0 };
}

/** One-line, human-readable summary of a tick: what moved · dirty count · health. */
export function formatWatchTick(delta: WatchDelta, health: number): string {
  const parts: string[] = [];
  if (delta.entered.length > 0) parts.push(`~${delta.entered.length} changed`);
  if (delta.left.length > 0) parts.push(`✓${delta.left.length} cleared`);
  const what = parts.length > 0 ? parts.join(' · ') : 'no changes';
  return `watch: ${what} · ${delta.current.size} dirty · health ${health}`;
}
