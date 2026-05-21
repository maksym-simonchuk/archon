import type { BlastRadius, EdgeKind, ParsedFile } from '../core/types';
import type { IndexStore } from './store';

/**
 * Symbol graph over the incremental index (ADR-0005). Persists the
 * defines/imports/calls/tests edges produced by the compute core's
 * `parseSymbols`, and answers `blastRadius()` — the set of symbols that
 * transitively DEPEND ON a changed symbol. That set feeds both context
 * selection (Sensing) and the policy ask-threshold (Effecting, M3).
 *
 * Parsing itself runs in the Rust/WASM core; the Indexer feeds parse results
 * here via `applyParse`. This class only persists and queries.
 */
export class SymbolGraph {
  /** Edge kinds meaning "src depends on dst" — so a change to dst affects src. */
  private static readonly DEPENDENCY_KINDS = new Set<EdgeKind>(['calls', 'imports', 'tests']);

  constructor(private readonly store: IndexStore) {}

  /** Persist one file's parsed symbols + edges, replacing any previous slice. */
  applyParse(file: string, parsed: ParsedFile): void {
    this.store.replaceFileGraph(file, parsed.symbols, parsed.edges);
  }

  /**
   * Reverse-reachability from `changedSymbols` over dependency edges: which
   * symbols would be affected if these changed, plus the files that define them.
   * `escapesRepo` is always false — a blast radius is by definition contained
   * within the repository.
   */
  async blastRadius(changedSymbols: string[]): Promise<BlastRadius> {
    // dst -> [src, ...]: the symbols that depend on `dst`.
    const dependents = new Map<string, string[]>();
    for (const e of this.store.loadEdges()) {
      if (!SymbolGraph.DEPENDENCY_KINDS.has(e.kind)) continue;
      const list = dependents.get(e.dst) ?? [];
      list.push(e.src);
      dependents.set(e.dst, list);
    }

    const reached = new Set<string>(changedSymbols);
    const queue = [...changedSymbols];
    while (queue.length > 0) {
      const symbol = queue.shift();
      if (symbol === undefined) break;
      for (const dependent of dependents.get(symbol) ?? []) {
        if (reached.has(dependent)) continue;
        reached.add(dependent);
        queue.push(dependent);
      }
    }

    const symbols = [...reached];
    return { files: this.store.filesForSymbols(symbols), symbols, escapesRepo: false };
  }
}
