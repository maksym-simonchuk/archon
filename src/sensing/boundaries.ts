import { posix } from 'node:path';

/**
 * Domain & boundary inference (M9): a living model of the repo's bounded
 * contexts and module topology, derived from the cross-file import edges built
 * in M8.5. A "module" is a directory cluster of files; the module graph is the
 * file-import graph lifted to those clusters (intra-module edges dropped).
 *
 * Pure: takes indexed files + file→file edges, returns a model. The store and
 * CLI wiring live in the command. Everything is computed, never persisted —
 * boundaries are re-derived from the current index on demand.
 */

export type ModuleRole = 'core' | 'unstable' | 'balanced' | 'isolated';

export interface ModuleNode {
  /** Directory cluster, e.g. `src/sensing` (or `(root)` for top-level files). */
  name: string;
  files: number;
  /** Distinct modules that import this one (afferent coupling, Ca). */
  fanIn: number;
  /** Distinct modules this one imports (efferent coupling, Ce). */
  fanOut: number;
  /** Martin instability Ce / (Ca + Ce): 0 = maximally stable, 1 = maximally unstable. */
  instability: number;
  role: ModuleRole;
}

export interface BoundaryModel {
  /** Every module, ordered by total coupling (the bounded contexts). */
  modules: ModuleNode[];
  /** Modules ranked by total coupling — the entanglement hotspots. */
  couplingHotspots: { name: string; coupling: number }[];
  /** Large, highly-coupled modules — god-module candidates. */
  godModules: { name: string; files: number; coupling: number }[];
  /** Module-level dependency cycles (SCCs of size > 1) — circular-dependency seeds. */
  cycles: string[][];
}

/** The directory cluster a repo-relative file belongs to. */
export function moduleOf(path: string): string {
  const dir = posix.dirname(path.replace(/\\/g, '/'));
  return dir === '.' ? '(root)' : dir;
}

function roleOf(fanIn: number, fanOut: number, instability: number): ModuleRole {
  if (fanIn === 0 && fanOut === 0) return 'isolated';
  if (instability <= 0.3) return 'core'; // stable, depended-on
  if (instability >= 0.7) return 'unstable'; // depends outward, little depends on it
  return 'balanced';
}

export function inferBoundaries(
  files: { path: string }[],
  edges: { src: string; dst: string }[],
): BoundaryModel {
  const fileCount = new Map<string, number>();
  for (const f of files) {
    const m = moduleOf(f.path);
    fileCount.set(m, (fileCount.get(m) ?? 0) + 1);
  }

  // Lift file edges to distinct module→module edges (drop intra-module).
  const out = new Map<string, Set<string>>();
  const inn = new Map<string, Set<string>>();
  const ensure = (map: Map<string, Set<string>>, k: string) => {
    let s = map.get(k);
    if (s === undefined) map.set(k, (s = new Set()));
    return s;
  };
  for (const e of edges) {
    const s = moduleOf(e.src);
    const d = moduleOf(e.dst);
    if (s === d) continue;
    ensure(out, s).add(d);
    ensure(inn, d).add(s);
    // A module seen only via edges (e.g. an unindexed dependency) still counts.
    if (!fileCount.has(s)) fileCount.set(s, fileCount.get(s) ?? 0);
    if (!fileCount.has(d)) fileCount.set(d, fileCount.get(d) ?? 0);
  }

  const modules: ModuleNode[] = [...fileCount.keys()].map((name) => {
    const fanOut = out.get(name)?.size ?? 0;
    const fanIn = inn.get(name)?.size ?? 0;
    const total = fanIn + fanOut;
    const instability = total === 0 ? 0 : fanOut / total;
    return { name, files: fileCount.get(name) ?? 0, fanIn, fanOut, instability, role: roleOf(fanIn, fanOut, instability) };
  });

  const coupling = (m: ModuleNode) => m.fanIn + m.fanOut;
  const byCoupling = (a: ModuleNode, b: ModuleNode) =>
    coupling(b) - coupling(a) || b.files - a.files || a.name.localeCompare(b.name);

  modules.sort(byCoupling);

  const couplingHotspots = modules
    .filter((m) => coupling(m) > 0)
    .map((m) => ({ name: m.name, coupling: coupling(m) }));

  // God-module candidates: entangled with ≥3 other modules in BOTH directions —
  // a hub that both knows everyone and is known by everyone.
  const godModules = modules
    .filter((m) => m.fanIn >= 3 && m.fanOut >= 3)
    .map((m) => ({ name: m.name, files: m.files, coupling: coupling(m) }));

  return { modules, couplingHotspots, godModules, cycles: findCycles(out) };
}

/**
 * Strongly-connected components of size > 1 in the module graph (Tarjan) —
 * each is a knot of modules that transitively import each other. Returned with
 * members sorted, and the list ordered by first member, for stable output.
 */
function findCycles(out: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  const strongConnect = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of out.get(v) ?? []) {
      if (!index.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop() as string;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) sccs.push(component.sort());
    }
  };

  for (const v of out.keys()) if (!index.has(v)) strongConnect(v);
  return sccs.sort((a, b) => a[0].localeCompare(b[0]));
}

const ROLE_LABEL: Record<ModuleRole, string> = {
  core: 'core',
  unstable: 'unstable',
  balanced: 'balanced',
  isolated: 'isolated',
};

/** Human-readable boundary report for the TUI (top contexts + hotspots + cycles). */
export function formatBoundaries(model: BoundaryModel, limit = 12): string {
  if (model.modules.length === 0) return 'boundaries: no indexed files yet — run `archon index` first';

  const lines: string[] = [`bounded contexts (${model.modules.length}):`];
  for (const m of model.modules.slice(0, limit)) {
    const i = m.instability.toFixed(2);
    lines.push(
      `  ${m.name.padEnd(28)} ${String(m.files).padStart(3)} files  ` +
        `in:${String(m.fanIn).padStart(2)} out:${String(m.fanOut).padStart(2)}  I=${i}  ${ROLE_LABEL[m.role]}`,
    );
  }

  if (model.couplingHotspots.length > 0) {
    lines.push('', 'coupling hotspots:');
    for (const h of model.couplingHotspots.slice(0, 5)) lines.push(`  ${h.name} (${h.coupling})`);
  }

  lines.push('', model.godModules.length > 0 ? 'god-module candidates:' : 'god-module candidates: none');
  for (const g of model.godModules.slice(0, 5)) lines.push(`  ${g.name} — ${g.files} files, coupling ${g.coupling}`);

  lines.push('', model.cycles.length > 0 ? 'circular dependencies:' : 'circular dependencies: none');
  for (const c of model.cycles) lines.push(`  ${c.join(' → ')} → ${c[0]}`);

  return lines.join('\n');
}
