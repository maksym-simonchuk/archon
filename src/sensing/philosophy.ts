import type { ArchitecturalFingerprint } from '../core/types';
import type { BoundaryModel } from './boundaries';

/**
 * Convention & Philosophy engine (M11): infers the project's engineering culture
 * so later layers (preservation, improvement) adapt their recommendations to it
 * rather than imposing generic best practice. Pure — takes the M8 fingerprint,
 * the M9 boundary model, and a few scalar signals the caller reads from disk,
 * and returns a {@link PhilosophyProfile}. Nothing here touches the store.
 *
 * Every axis is derived from explainable signals (named in `rationale`), never a
 * tuned weight, so a recommendation can cite exactly which trait it respected.
 */

/** How strictly the project types itself — drives how aggressive type-tightening advice may be. */
export type TypingStrictness = 'strict' | 'loose' | 'untyped';
/** How much indirection the project tolerates — high means custom abstractions are likely intentional. */
export type AbstractionTolerance = 'minimal' | 'moderate' | 'high';
/** Where the project sits on the speed↔stability axis — gates how conservative changes must be. */
export type StabilityBias = 'speed' | 'balanced' | 'stability';
/** Rough organisational scale — startups tolerate churn, enterprises prize stability. */
export type ProjectScale = 'prototype' | 'growth' | 'enterprise';
/** Dominant file-naming convention of the source tree. */
export type NamingConvention = 'kebab-case' | 'camelCase' | 'PascalCase' | 'mixed';

export interface PhilosophyProfile {
  typingStrictness: TypingStrictness;
  abstractionTolerance: AbstractionTolerance;
  /** The fingerprint's organising principle, surfaced here as the layering culture. */
  layeringStyle: ArchitecturalFingerprint['architecturalStyle'];
  stabilityBias: StabilityBias;
  scale: ProjectScale;
  /** Dominant source-file naming convention, and whether tests sit beside source. */
  naming: NamingConvention;
  colocatedTests: boolean;
  /** Human-readable signals behind each axis. */
  rationale: string[];
}

/** Scalar signals the caller reads from disk / the index and the index can't infer itself. */
export interface PhilosophySignals {
  /** `tsconfig` has `strict: true` (or all strict family flags). */
  strictTypes: boolean;
  /** Project is typed at all (a `tsconfig.json` exists / `typescript` is a language). */
  typed: boolean;
  /** Share 0–1 of testable source files with a co-located test. */
  testRatio: number;
  /** Total indexed source files — a coarse size signal. */
  fileCount: number;
  /** Basenames (no path) of indexed source files — the naming-convention sample. */
  sourceBasenames: string[];
}

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const CAMEL = /^[a-z][a-zA-Z0-9]*$/;
const PASCAL = /^[A-Z][a-zA-Z0-9]*$/;

/** Strip one or two trailing extensions (e.g. `.test.ts`) and return the bare stem. */
function stem(basename: string): string {
  return basename.replace(/\.(test|spec)\.[cm]?[jt]sx?$/, '').replace(/\.[cm]?[jt]sx?$/, '');
}

function inferNaming(basenames: string[]): NamingConvention {
  const counts = { kebab: 0, camel: 0, pascal: 0 };
  let total = 0;
  for (const b of basenames) {
    const s = stem(b);
    if (s.length === 0 || s.includes('.')) continue;
    total++;
    if (KEBAB.test(s) && s.includes('-')) counts.kebab++;
    else if (PASCAL.test(s)) counts.pascal++;
    else if (CAMEL.test(s)) counts.camel++;
  }
  if (total === 0) return 'mixed';
  const [top, n] = (['kebab', 'camel', 'pascal'] as const)
    .map((k) => [k, counts[k]] as const)
    .sort((a, b) => b[1] - a[1])[0];
  // A convention only "wins" if it covers a clear majority; otherwise it's mixed.
  if (n / total < 0.6) return 'mixed';
  return top === 'kebab' ? 'kebab-case' : top === 'pascal' ? 'PascalCase' : 'camelCase';
}

/** Mean efferent coupling (fan-out) across non-isolated modules — the indirection signal. */
function meanFanOut(model: BoundaryModel): number {
  const coupled = model.modules.filter((m) => m.fanIn + m.fanOut > 0);
  if (coupled.length === 0) return 0;
  return coupled.reduce((sum, m) => sum + m.fanOut, 0) / coupled.length;
}

export function inferPhilosophy(
  fingerprint: ArchitecturalFingerprint,
  model: BoundaryModel,
  signals: PhilosophySignals,
): PhilosophyProfile {
  const rationale: string[] = [];

  const typingStrictness: TypingStrictness = !signals.typed
    ? 'untyped'
    : signals.strictTypes
      ? 'strict'
      : 'loose';
  rationale.push(
    typingStrictness === 'strict'
      ? 'strict typing (tsconfig strict) — type-tightening advice is welcome'
      : typingStrictness === 'loose'
        ? 'typed but non-strict — gradual typing tolerated'
        : 'untyped — do not impose a type system',
  );

  const fanOut = meanFanOut(model);
  const layered = fingerprint.architecturalStyle === 'ddd' || fingerprint.architecturalStyle === 'layered';
  const abstractionTolerance: AbstractionTolerance =
    fanOut >= 4 || layered ? 'high' : fanOut >= 2 ? 'moderate' : 'minimal';
  rationale.push(
    abstractionTolerance === 'high'
      ? `high abstraction tolerance (mean fan-out ${fanOut.toFixed(1)}${layered ? `, ${fingerprint.architecturalStyle}` : ''}) — custom indirection is likely intentional`
      : abstractionTolerance === 'moderate'
        ? `moderate abstraction tolerance (mean fan-out ${fanOut.toFixed(1)})`
        : `minimal abstraction tolerance (mean fan-out ${fanOut.toFixed(1)}) — prefers directness`,
  );

  const hasCi = fingerprint.ci.length > 0;
  const wellTested = signals.testRatio >= 0.66;
  const stabilityBias: StabilityBias =
    wellTested && hasCi ? 'stability' : signals.testRatio < 0.33 && !hasCi ? 'speed' : 'balanced';
  rationale.push(
    stabilityBias === 'stability'
      ? `stability bias (${pct(signals.testRatio)} tested, CI present) — change conservatively`
      : stabilityBias === 'speed'
        ? `speed bias (${pct(signals.testRatio)} tested, no CI) — iteration over ceremony`
        : `balanced speed/stability (${pct(signals.testRatio)} tested)`,
  );

  const scale: ProjectScale =
    fingerprint.layout === 'monorepo' || signals.fileCount >= 400 || hasCi
      ? signals.fileCount >= 400 || fingerprint.workspaces.length > 1
        ? 'enterprise'
        : 'growth'
      : signals.fileCount < 40
        ? 'prototype'
        : 'growth';
  rationale.push(`${scale} scale (${signals.fileCount} files, ${fingerprint.layout})`);

  const naming = inferNaming(signals.sourceBasenames);
  const colocatedTests = signals.testRatio > 0;
  if (naming !== 'mixed') rationale.push(`naming convention: ${naming}`);
  if (colocatedTests) rationale.push('tests co-located with source');

  return {
    typingStrictness,
    abstractionTolerance,
    layeringStyle: fingerprint.architecturalStyle,
    stabilityBias,
    scale,
    naming,
    colocatedTests,
    rationale,
  };
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** Human-readable philosophy report for the TUI. */
export function formatPhilosophy(p: PhilosophyProfile): string {
  const rows: [string, string][] = [
    ['typing', p.typingStrictness],
    ['abstraction', p.abstractionTolerance],
    ['layering', p.layeringStyle],
    ['bias', p.stabilityBias],
    ['scale', p.scale],
    ['naming', p.naming],
    ['tests', p.colocatedTests ? 'co-located' : 'separate/none'],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  const lines = ['project philosophy:', ...rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`), '', '  why:'];
  for (const r of p.rationale) lines.push(`    - ${r}`);
  return lines.join('\n');
}
