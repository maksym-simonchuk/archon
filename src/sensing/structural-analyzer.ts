import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  ArchitecturalFingerprint,
  ArchitecturalStyle,
  PackageManager,
} from '../core/types';

/**
 * Structural analyzer (M8). Produces an {@link ArchitecturalFingerprint} from a
 * repository's manifest files + shallow directory topology — never the symbol
 * graph (that depth is M9). Detection is heuristic by design.
 *
 * Like the {@link Indexer}, this is a Sensing-plane reader: it reads files
 * directly under the `safe` policy's `fs.read: **` grant rather than through the
 * broker, and it runs inside `archon init` before any runtime exists. It reads
 * only a bounded set of manifests + two directory listings, so a re-run is cheap
 * regardless of repo size; `inputHash` lets callers skip an unchanged repo.
 */

// Dependency → canonical framework name. Presence of the key in package.json
// dependencies/devDependencies implies the framework.
const FRAMEWORK_DEPS: Record<string, string> = {
  react: 'react',
  next: 'next',
  vue: 'vue',
  nuxt: 'nuxt',
  svelte: 'svelte',
  '@angular/core': 'angular',
  'solid-js': 'solid',
  express: 'express',
  fastify: 'fastify',
  koa: 'koa',
  '@nestjs/core': 'nestjs',
  '@hapi/hapi': 'hapi',
  hapi: 'hapi',
};

const TEST_RUNNER_DEPS: Record<string, string> = {
  vitest: 'vitest',
  jest: 'jest',
  mocha: 'mocha',
  ava: 'ava',
  '@playwright/test': 'playwright',
  cypress: 'cypress',
};

// Source-tree directory vocabularies that signal an organising principle.
const DDD_DIRS = ['domain', 'application', 'infrastructure', 'presentation'];
const FEATURE_SLICED_DIRS = ['features', 'entities', 'widgets', 'shared', 'pages', 'app', 'processes'];
const LAYERED_DIRS = [
  'controllers',
  'services',
  'models',
  'repositories',
  'routes',
  'middleware',
  'views',
  'dao',
];

// Directories that never carry architectural signal — excluded when a repo has
// no `src/` and we fall back to top-level dirs for style inference.
const NOISE_DIRS = new Set([
  'node_modules',
  '.git',
  '.github',
  'dist',
  'build',
  'coverage',
  '.archon',
  'pkg',
  'target',
  '.next',
  'out',
  '.cache',
  '.vscode',
  '.idea',
  'docs',
]);

/** Extracted, hashable evidence — everything the detectors derive from. */
interface Evidence {
  rootDirs: string[];
  rootFiles: string[];
  srcDirs: string[];
  srcFiles: string[];
  hasSrcDir: boolean;
  pkg?: PkgEvidence;
  lockfiles: string[];
  markers: string[];
  /** Manifest paths found anywhere within a bounded depth (root + nested crates/packages). */
  manifests: string[];
  configs: string[];
  pnpmWorkspaces: string[];
  ci: string[];
  existingEntryFiles: string[];
}

interface PkgEvidence {
  deps: string[];
  workspaces: string[];
  scriptsTest: string;
  /** `packageManager` field (e.g. `pnpm@9.1.0`) — authoritative when present. */
  packageManagerField?: string;
  main?: string;
  module?: string;
  bin?: unknown;
  exports?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const uniqueSorted = (xs: string[]): string[] => [...new Set(xs)].sort();

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text);
    return isObj(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function listDir(path: string): Promise<{ dirs: string[]; files: string[] }> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const dirs: string[] = [];
    const files: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) dirs.push(e.name);
      else if (e.isFile()) files.push(e.name);
    }
    return { dirs: dirs.sort(), files: files.sort() };
  } catch {
    return { dirs: [], files: [] };
  }
}

function extractPkg(p: Record<string, unknown>): PkgEvidence {
  const deps = {
    ...(isObj(p.dependencies) ? p.dependencies : {}),
    ...(isObj(p.devDependencies) ? p.devDependencies : {}),
  };
  let workspaces: string[] = [];
  if (Array.isArray(p.workspaces)) {
    workspaces = p.workspaces.filter((x): x is string => typeof x === 'string');
  } else if (isObj(p.workspaces) && Array.isArray(p.workspaces.packages)) {
    workspaces = p.workspaces.packages.filter((x): x is string => typeof x === 'string');
  }
  const scripts = isObj(p.scripts) ? p.scripts : {};
  return {
    deps: Object.keys(deps).sort(),
    workspaces: workspaces.sort(),
    scriptsTest: typeof scripts.test === 'string' ? scripts.test : '',
    packageManagerField: typeof p.packageManager === 'string' ? p.packageManager : undefined,
    main: typeof p.main === 'string' ? p.main : undefined,
    module: typeof p.module === 'string' ? p.module : undefined,
    bin: p.bin,
    exports: p.exports,
  };
}

function parsePnpmWorkspaces(text: string): string[] {
  try {
    const doc = parseYaml(text);
    return isObj(doc) && Array.isArray(doc.packages)
      ? doc.packages.filter((x): x is string => typeof x === 'string')
      : [];
  } catch {
    return [];
  }
}

function detectCi(root: string, rootFiles: string[]): string[] {
  const ci: string[] = [];
  if (existsSync(join(root, '.github', 'workflows'))) ci.push('github-actions');
  if (rootFiles.includes('.gitlab-ci.yml')) ci.push('gitlab-ci');
  if (existsSync(join(root, '.circleci', 'config.yml'))) ci.push('circleci');
  if (rootFiles.includes('azure-pipelines.yml')) ci.push('azure-pipelines');
  if (rootFiles.includes('Jenkinsfile')) ci.push('jenkins');
  return ci.sort();
}

const CONFIG_PREFIXES = ['vite.config', 'next.config', 'webpack.config', 'rollup.config', 'svelte.config', 'astro.config'];
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'];
const MARKERS = ['tsconfig.json', 'Cargo.toml', 'pyproject.toml', 'setup.py', 'requirements.txt', 'go.mod', 'turbo.json'];
// Non-JS manifests are commonly nested (crates/*, services/*), so they are
// searched depth-first rather than only at root.
const NESTED_MANIFESTS = ['Cargo.toml', 'pyproject.toml', 'setup.py', 'requirements.txt', 'go.mod'];
const ENTRY_CANDIDATES = ['src/index.ts', 'src/main.ts', 'src/cli.ts', 'src/index.js', 'src/main.js', 'index.ts', 'index.js', 'main.ts'];

/** Depth-bounded search for non-JS manifests, skipping noise/hidden dirs. */
async function findManifests(root: string, maxDepth = 4): Promise<string[]> {
  const found: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    const { dirs, files } = await listDir(join(root, rel));
    for (const f of files) if (NESTED_MANIFESTS.includes(f)) found.push(rel ? `${rel}/${f}` : f);
    if (depth >= maxDepth) return;
    for (const d of dirs) {
      if (NOISE_DIRS.has(d) || d.startsWith('.')) continue;
      await walk(rel ? `${rel}/${d}` : d, depth + 1);
    }
  };
  await walk('', 0);
  return found.sort();
}

/** Distinct manifest basenames found at root or nested — the language/build signal. */
function manifestNames(ev: Evidence): Set<string> {
  return new Set([...ev.markers, ...ev.manifests.map((m) => m.split('/').pop() as string)]);
}

async function gatherEvidence(root: string): Promise<Evidence> {
  const rt = await listDir(root);
  const hasSrcDir = rt.dirs.includes('src');
  const src = hasSrcDir ? await listDir(join(root, 'src')) : { dirs: [], files: [] };

  const pkgRaw = await readJson(join(root, 'package.json'));
  const pkg = pkgRaw ? extractPkg(pkgRaw) : undefined;

  const pnpmText = await readText(join(root, 'pnpm-workspace.yaml'));
  const pnpmWorkspaces = pnpmText ? parsePnpmWorkspaces(pnpmText) : [];

  return {
    rootDirs: rt.dirs,
    rootFiles: rt.files,
    srcDirs: src.dirs,
    srcFiles: src.files,
    hasSrcDir,
    pkg,
    lockfiles: LOCKFILES.filter((n) => rt.files.includes(n)),
    markers: MARKERS.filter((n) => rt.files.includes(n)),
    manifests: await findManifests(root),
    configs: rt.files.filter((f) => CONFIG_PREFIXES.some((p) => f.startsWith(p))),
    pnpmWorkspaces,
    ci: detectCi(root, rt.files),
    existingEntryFiles: ENTRY_CANDIDATES.filter((c) => existsSync(join(root, ...c.split('/')))),
  };
}

function detectPackageManager(ev: Evidence): PackageManager {
  const field = ev.pkg?.packageManagerField?.split('@')[0];
  if (field === 'npm' || field === 'pnpm' || field === 'yarn' || field === 'bun') return field;
  if (ev.lockfiles.includes('pnpm-lock.yaml')) return 'pnpm';
  if (ev.lockfiles.includes('yarn.lock')) return 'yarn';
  if (ev.lockfiles.includes('bun.lockb') || ev.lockfiles.includes('bun.lock')) return 'bun';
  if (ev.lockfiles.includes('package-lock.json')) return 'npm';
  return ev.pkg ? 'npm' : 'unknown';
}

function detectLanguages(ev: Evidence): string[] {
  const manifests = manifestNames(ev);
  const has = (n: string) => manifests.has(n);
  const langs: string[] = [];
  if (has('tsconfig.json')) langs.push('typescript');
  if (ev.pkg && !has('tsconfig.json')) langs.push('javascript');
  if (has('Cargo.toml')) langs.push('rust');
  if (has('pyproject.toml') || has('setup.py') || has('requirements.txt')) langs.push('python');
  if (has('go.mod')) langs.push('go');
  return langs;
}

function detectBuildSystem(ev: Evidence): string[] {
  const manifests = manifestNames(ev);
  const build: string[] = [];
  const hasConfig = (prefix: string) => ev.configs.some((c) => c.startsWith(prefix));
  if (manifests.has('tsconfig.json')) build.push('tsc');
  if (hasConfig('vite.config')) build.push('vite');
  if (hasConfig('next.config')) build.push('next');
  if (hasConfig('webpack.config')) build.push('webpack');
  if (hasConfig('rollup.config')) build.push('rollup');
  if (manifests.has('turbo.json')) build.push('turbo');
  if (manifests.has('Cargo.toml')) build.push('cargo');
  return uniqueSorted(build);
}

function detectFrameworks(ev: Evidence): string[] {
  const found = (ev.pkg?.deps ?? []).flatMap((d) => (FRAMEWORK_DEPS[d] ? [FRAMEWORK_DEPS[d]] : []));
  if (found.includes('next')) found.push('react'); // Next implies React
  return uniqueSorted(found);
}

function detectTestRunners(ev: Evidence): string[] {
  const runners = (ev.pkg?.deps ?? []).flatMap((d) => (TEST_RUNNER_DEPS[d] ? [TEST_RUNNER_DEPS[d]] : []));
  if ((ev.pkg?.scriptsTest ?? '').includes('--test')) runners.push('node:test');
  return uniqueSorted(runners);
}

function detectEntryPoints(ev: Evidence): string[] {
  const eps = new Set<string>();
  const pkg = ev.pkg;
  if (pkg) {
    if (pkg.main) eps.add(pkg.main);
    if (pkg.module) eps.add(pkg.module);
    if (typeof pkg.bin === 'string') eps.add(pkg.bin);
    else if (isObj(pkg.bin)) for (const v of Object.values(pkg.bin)) if (typeof v === 'string') eps.add(v);
    if (typeof pkg.exports === 'string') eps.add(pkg.exports);
    else if (isObj(pkg.exports)) {
      const dot = pkg.exports['.'];
      if (typeof dot === 'string') eps.add(dot);
      else if (isObj(dot)) {
        const first = Object.values(dot).find((v) => typeof v === 'string');
        if (typeof first === 'string') eps.add(first);
      }
    }
  }
  for (const f of ev.existingEntryFiles) eps.add(f);
  return uniqueSorted([...eps]);
}

function inferStyle(dirs: string[]): ArchitecturalStyle {
  const set = new Set(dirs.map((d) => d.toLowerCase()));
  const hits = (names: string[]) => names.filter((n) => set.has(n)).length;
  if (hits(DDD_DIRS) >= 2) return 'ddd';
  if (hits(FEATURE_SLICED_DIRS) >= 2) return 'feature-sliced';
  if (hits(LAYERED_DIRS) >= 2) return 'layered';
  if (dirs.length >= 3) return 'modular-monolith';
  if (dirs.length === 0) return 'flat';
  return 'unknown';
}

function deriveFingerprint(ev: Evidence, inputHash: string): ArchitecturalFingerprint {
  const workspaces = uniqueSorted([...(ev.pkg?.workspaces ?? []), ...ev.pnpmWorkspaces]);
  const layerDirs = ev.hasSrcDir ? ev.srcDirs : ev.rootDirs.filter((d) => !NOISE_DIRS.has(d));
  return {
    scannedAt: new Date().toISOString(),
    inputHash,
    layout: workspaces.length > 0 ? 'monorepo' : 'single',
    packageManager: detectPackageManager(ev),
    workspaces,
    languages: detectLanguages(ev),
    buildSystem: detectBuildSystem(ev),
    ci: ev.ci,
    frameworks: detectFrameworks(ev),
    testRunners: detectTestRunners(ev),
    entryPoints: detectEntryPoints(ev),
    architecturalStyle: inferStyle(layerDirs),
    topDirectories: layerDirs,
  };
}

/** Scan `root` and produce its architectural fingerprint. */
export async function analyzeStructure(root: string): Promise<ArchitecturalFingerprint> {
  const evidence = await gatherEvidence(root);
  const inputHash = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  return deriveFingerprint(evidence, inputHash);
}

/** Render a fingerprint as an aligned, human-readable block (for `archon init`). */
export function formatFingerprint(fp: ArchitecturalFingerprint): string {
  const list = (xs: string[]) => (xs.length ? xs.join(', ') : '—');
  const layout = fp.layout === 'monorepo' ? `monorepo (${list(fp.workspaces)})` : 'single package';
  const style = fp.topDirectories.length
    ? `${fp.architecturalStyle} (${fp.topDirectories.join(', ')})`
    : fp.architecturalStyle;
  const rows: [string, string][] = [
    ['layout', layout],
    ['pkg manager', fp.packageManager],
    ['languages', list(fp.languages)],
    ['build', list(fp.buildSystem)],
    ['ci', list(fp.ci)],
    ['frameworks', list(fp.frameworks)],
    ['test runners', list(fp.testRunners)],
    ['entrypoints', list(fp.entryPoints)],
    ['style', style],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`).join('\n');
}
