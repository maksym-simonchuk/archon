import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { realContainedPath } from '../core/path-safety';
import { type Commit, parseGitLog } from './evolution';
import { extractImports, resolveImport } from './import-resolver';
import type { ComputeCore } from '../core/compute';
import type { FileHash } from '../core/types';
import type { IndexStore } from './store';
import type { SymbolGraph } from './symbol-graph';

/** File extension → tree-sitter grammar the compute core should parse with. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.rs': 'rust',
  '.py': 'python',
};

/**
 * Incremental indexer (ADR-0005). Reindexes ONLY the paths reported by git /
 * the file watcher, keyed by content hash (a Merkle DAG) — never full-rescans.
 *
 * This class owns the read-only git/fs I/O for Sensing. Those reads are allowed
 * directly under the safe policy (`fs.read: **`, `git status|diff`); the
 * Capability Broker (M3) gates *effecting* writes, not sensing reads. Hashing
 * and parsing run in the Rust/WASM compute core (ADR-0011); this class feeds it
 * bytes and routes the results into the index store and symbol graph.
 */
export class Indexer {
  private readonly git: SimpleGit;

  constructor(
    private readonly core: ComputeCore,
    private readonly store: IndexStore,
    private readonly graph: SymbolGraph,
    private readonly repoRoot: string = process.cwd(),
  ) {
    this.git = simpleGit(repoRoot);
  }

  /** Paths changed in the working tree (tracked edits + untracked files). */
  async dirtyPaths(): Promise<string[]> {
    try {
      const status = await this.git.status();
      return [...new Set(status.files.map((f) => f.path))];
    } catch {
      return []; // not a git repo (or git unavailable) — nothing to reindex, like commitHistory
    }
  }

  /**
   * The last `limit` commits with the paths each touched (M15 churn substrate).
   * Read-only `git log` — allowed directly under the safe policy, like `status`.
   * The NUL-prefixed `%H` header lets the pure parser separate commits from the
   * `--name-only` file lists unambiguously.
   */
  async commitHistory(limit = 200): Promise<Commit[]> {
    try {
      const raw = await this.git.raw(['log', `-n${limit}`, '--name-only', '--pretty=format:%x00%H']);
      return parseGitLog(raw);
    } catch {
      return []; // no commits yet (or not a git repo) — no history to analyze
    }
  }

  /**
   * Reindex exactly the given paths. Files whose content hash is unchanged are
   * skipped (this is what "no full rescan" means in practice); changed files are
   * re-parsed and their graph slice replaced. Paths git reports as dirty include
   * deletions/renames, so a path that no longer exists is dropped from the index.
   */
  async reindex(paths: string[]): Promise<void> {
    if (paths.length === 0) return;

    const bytesByPath = new Map<string, Uint8Array>();
    for (const path of paths) {
      const bytes = await this.readFileOrNull(path);
      if (bytes === null) {
        this.store.removeFile(path); // deleted / renamed-away → drop its slice
        continue;
      }
      bytesByPath.set(path, bytes);
    }
    if (bytesByPath.size === 0) return;

    const hashes: FileHash[] = await this.core.hashFiles(
      [...bytesByPath].map(([path, bytes]) => ({ path, bytes })),
    );

    for (const { path, hash } of hashes) {
      if (this.store.getFileHash(path) === hash) continue; // unchanged → skip reparse

      const language: string | undefined = LANGUAGE_BY_EXT[extname(path)];
      const bytes = bytesByPath.get(path);
      if (language !== undefined && bytes !== undefined) {
        this.graph.applyParse(path, await this.core.parseSymbols(language, path, bytes));
        if (language === 'typescript' || language === 'javascript') {
          this.store.replaceFileImports(path, this.resolveImports(path, bytes));
        }
      }
      // Record the hash only after the graph slice is updated: a parse failure
      // then leaves the file dirty for the next run instead of marking it stale.
      this.store.upsertFileHash(path, hash);
    }
  }

  /**
   * Cross-file `imports` edges for one TS/JS file (M8.5): decode, pull
   * specifiers, resolve the relative ones to real repo files. Existence is
   * checked against the repo root (a sibling dirty file may not be on disk yet,
   * but already-indexed neighbours are); self-imports are excluded.
   */
  private resolveImports(path: string, bytes: Uint8Array): string[] {
    const source = new TextDecoder().decode(bytes);
    const dsts = new Set<string>();
    for (const spec of extractImports(source)) {
      const dst = resolveImport(path, spec, (rel) => existsSync(join(this.repoRoot, ...rel.split('/'))));
      if (dst !== undefined && dst !== path) dsts.add(dst);
    }
    return [...dsts];
  }

  private async readFileOrNull(path: string): Promise<Uint8Array | null> {
    // Resolve symlinks and reject anything that escapes the repo: a tracked
    // symlink pointing outside the tree must not let indexing read (e.g.) /etc
    // or a secret store. Out-of-tree and missing paths alike yield null, so a
    // path that escapes is simply dropped from the index rather than read.
    const real = await realContainedPath(this.repoRoot, path);
    if (real === null) return null;
    try {
      return new Uint8Array(await readFile(real));
    } catch (e) {
      if (e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
}
