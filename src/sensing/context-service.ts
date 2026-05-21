import type { Task } from '../core/types';
import type { ComputeCore } from '../core/compute';
import { notImplemented } from '../core/result';

/**
 * Assembles a token-budgeted working set: a repo-map (PageRank-ranked symbol
 * skeleton) + graph/lexical retrieval, with hash-keyed summaries. Compression,
 * not ingestion; drops lowest-rank context first under budget. Ranking runs in
 * the Rust/WASM compute core (ADR-0011). See ADR-0006.
 */
export class ContextService {
  constructor(_core: ComputeCore) {}

  async assemble(_task: Task, _budgetTokens: number): Promise<string> {
    return notImplemented('ContextService.assemble', 'M2');
  }
}
