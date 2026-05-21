import type { BlastRadius } from '../core/types';
import type { ComputeCore } from '../core/compute';
import { notImplemented } from '../core/result';

/**
 * tree-sitter symbol graph (defines / imports / calls / tests edges) stored in
 * embedded SQLite. Parsing runs in the Rust/WASM compute core (ADR-0011).
 * Powers both retrieval AND blast-radius (reachability from changed symbols),
 * which feeds context selection and the policy ask-threshold. See ADR-0005.
 */
export class SymbolGraph {
  constructor(_core: ComputeCore) {}

  async blastRadius(_changedSymbols: string[]): Promise<BlastRadius> {
    return notImplemented('SymbolGraph.blastRadius', 'M1');
  }
}
