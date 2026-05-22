import { posix } from 'node:path';

/**
 * Cross-file import extraction + resolution (M8.5). The Rust parser only emits
 * intra-file `calls` edges (cross-file resolution is deferred — ROADMAP M2), so
 * the module-topology substrate that M9 boundary inference needs is built here
 * in the host: pull import specifiers out of TS/JS source, then resolve the
 * relative ones to concrete repo files.
 *
 * This is deliberately syntactic (regex), not a full parse: it over-matches
 * inside strings/comments occasionally, but every match is re-validated by
 * `resolveImport` against files that actually exist, so a spurious specifier
 * resolves to nothing and is dropped. Bare specifiers (`react`, `node:fs`) are
 * out of scope — only first-party file→file edges matter for boundaries.
 */

// `import ... from 'x'`, `export ... from 'x'`, side-effect `import 'x'`,
// dynamic `import('x')`, and `require('x')`. The specifier is whichever of the
// capture groups matched.
const SPECIFIER_RE =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Candidate file suffixes tried, in order, when a relative import omits one. */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Every import/require specifier referenced by `source`, in first-seen order. */
export function extractImports(source: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of source.matchAll(SPECIFIER_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec !== undefined && !seen.has(spec)) {
      seen.add(spec);
      out.push(spec);
    }
  }
  return out;
}

/**
 * Resolve a relative import `spec` written in `fromFile` to a repo-relative file
 * path, or undefined if it is bare, escapes the repo, or hits no real file.
 *
 * `exists(relPath)` is injected (rather than touching `fs` here) so resolution
 * stays pure and testable; the indexer wires it to a repo-contained existence
 * check. All paths are POSIX-normalised so edges are stable across platforms.
 */
export function resolveImport(
  fromFile: string,
  spec: string,
  exists: (relPath: string) => boolean,
): string | undefined {
  if (!spec.startsWith('.')) return undefined; // bare / built-in → not a file edge

  const base = posix.dirname(toPosix(fromFile));
  const target = posix.normalize(posix.join(base, spec));
  if (target === '..' || target.startsWith('../')) return undefined; // escaped the repo

  // Exact path (with extension), then extension trial, then directory index.
  if (hasKnownExt(target) && exists(target)) return target;
  for (const ext of EXTENSIONS) {
    const cand = target + ext;
    if (exists(cand)) return cand;
  }
  for (const ext of EXTENSIONS) {
    const cand = posix.join(target, `index${ext}`);
    if (exists(cand)) return cand;
  }
  return undefined;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function hasKnownExt(p: string): boolean {
  return EXTENSIONS.includes(posix.extname(p));
}
