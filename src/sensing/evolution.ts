import { type BoundaryModel, moduleOf } from './boundaries';

/**
 * Temporal evolution (M15): model the repository over time and forecast
 * architectural risk. The signal is *churn × coupling* — a module that is both
 * heavily edited (git history) and heavily entangled (current M9 boundary
 * model) is accumulating gravity, and an entangled-both-ways module under heavy
 * churn is trending toward god-object status before it crosses the threshold.
 *
 * Pure: takes parsed commits + the boundary model, returns the forecast. The
 * git read and CLI wiring live in the indexer / command. Health *trend lines*
 * (the other half of M15's `doctor` surface) come from the `health_history`
 * snapshots in the store, not from here.
 */

/** One commit's touched repo-relative paths (parsed from `git log --name-only`). */
export interface Commit {
  hash: string;
  files: string[];
}

export interface ModuleChurn {
  /** Directory cluster, matching `ModuleNode.name`. */
  name: string;
  /** Commits that touched ≥1 file in this module within the analyzed window. */
  commits: number;
  /** Current total coupling (fanIn + fanOut) from the boundary model. */
  coupling: number;
  files: number;
  /** churn × coupling — heavily-edited *and* heavily-entangled ranks highest. */
  pressure: number;
  /** Entangled both ways and under heavy churn, but not yet a god module. */
  trendingGod: boolean;
}

export interface EvolutionModel {
  /** Modules ranked by pressure (churn × coupling), highest first. */
  hotspots: ModuleChurn[];
  /** Subset of hotspots flagged as trending toward god-object status. */
  godTrending: ModuleChurn[];
  commitsAnalyzed: number;
}

/** Entangled on both axes at/above this = reaching in and being reached into. */
const NEAR_GOD = 2;
/** God-module threshold — matches `boundaries.godModules` (fanIn ≥ 3 && fanOut ≥ 3). */
const GOD = 3;

/**
 * Parse `git log -n<N> --name-only --pretty=format:%x00%H`. The NUL prefix marks
 * each commit header unambiguously, so file paths (which can contain anything
 * else) never collide with commit boundaries. Pure — fed raw git output or a
 * fixture in tests.
 */
export function parseGitLog(raw: string): Commit[] {
  const commits: Commit[] = [];
  let current: Commit | undefined;
  for (const line of raw.split('\n')) {
    if (line.startsWith('\0')) {
      current = { hash: line.slice(1), files: [] };
      commits.push(current);
    } else if (current && line.trim() !== '') {
      current.files.push(line.trim());
    }
  }
  return commits;
}

export function analyzeEvolution(commits: Commit[], model: BoundaryModel): EvolutionModel {
  const byName = new Map(model.modules.map((m) => [m.name, m] as const));

  // Per-module commit count: one commit touching N files in a module counts once.
  const churn = new Map<string, number>();
  for (const c of commits) {
    const touched = new Set(c.files.map(moduleOf));
    for (const name of touched) churn.set(name, (churn.get(name) ?? 0) + 1);
  }

  const rows: ModuleChurn[] = [...churn].map(([name, commits]) => {
    const mod = byName.get(name);
    const coupling = mod ? mod.fanIn + mod.fanOut : 0;
    return { name, commits, coupling, files: mod?.files ?? 0, pressure: commits * coupling, trendingGod: false };
  });

  // "Heavy" churn is relative to the coupled modules — the population that can
  // actually drift toward god-object status (isolated modules never will).
  const coupled = rows.filter((r) => r.coupling > 0);
  const avgChurn = coupled.length ? coupled.reduce((s, r) => s + r.commits, 0) / coupled.length : 0;
  for (const r of rows) {
    const mod = byName.get(r.name);
    if (!mod) continue;
    const entangledBothWays = mod.fanIn >= NEAR_GOD && mod.fanOut >= NEAR_GOD;
    const alreadyGod = mod.fanIn >= GOD && mod.fanOut >= GOD;
    r.trendingGod = entangledBothWays && !alreadyGod && r.commits >= Math.max(2, avgChurn);
  }

  const byPressure = (a: ModuleChurn, b: ModuleChurn): number =>
    b.pressure - a.pressure || b.commits - a.commits || a.name.localeCompare(b.name);
  const hotspots = [...rows].sort(byPressure);
  return { hotspots, godTrending: hotspots.filter((r) => r.trendingGod), commitsAnalyzed: commits.length };
}

export function formatEvolution(model: EvolutionModel, limit = 12): string {
  if (model.commitsAnalyzed === 0) return 'evolution: no commit history to analyze';
  const lines = [`evolution: ${model.commitsAnalyzed} commits analyzed`];

  if (model.godTrending.length > 0) {
    lines.push('', `trending toward god-object (${model.godTrending.length}):`);
    for (const r of model.godTrending.slice(0, limit)) {
      lines.push(`  ⚠ ${r.name} — ${r.commits} commits · coupling ${r.coupling} · pressure ${r.pressure}`);
    }
  } else {
    lines.push('', 'trending toward god-object: none');
  }

  const hotspots = model.hotspots.filter((r) => r.pressure > 0).slice(0, limit);
  if (hotspots.length > 0) {
    lines.push('', 'churn × coupling hotspots:');
    for (const r of hotspots) {
      lines.push(`  ${r.name} — ${r.commits} commits · coupling ${r.coupling} · pressure ${r.pressure}`);
    }
  }
  return lines.join('\n');
}
