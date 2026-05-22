// Shared assembly for the M20 execution simulation: gathers the M9 boundary
// model, M11 philosophy, M13 risk, M14 preservation, and M15 churn signals for a
// proposed change and runs them through `simulateExecution`. Extracted from the
// command layer so BOTH the `/simulate` / `/refactor` commands and the cognition
// loop's pre-apply gate produce the *same* prediction from one code path —
// keying the loop's hard gate (M14/M20 → block) to exactly what the user sees.
//
// Takes a repo `root` (not the full Runtime) so it carries no dependency on the
// composition root — no import cycle, and it is callable from inside the loop.
//
// Lives in the application layer (above the planes) rather than in `src/cognition`
// because it composes BOTH sensing and cognition analysis and reads the repo
// tsconfig — cognition holds zero ambient fs authority (the effecting-isolation
// invariant), so this cross-plane orchestration cannot live inside a plane.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArchitecturalFingerprint } from './core/types';
import { type BoundaryModel, inferBoundaries, moduleOf } from './sensing/boundaries';
import { analyzeEvolution } from './sensing/evolution';
import { inferPhilosophy, type PhilosophySignals } from './sensing/philosophy';
import { analyzeStructure } from './sensing/structural-analyzer';
import { moduleConfidence } from './sensing/violations';
import { scoreRisk } from './cognition/risk';
import { assessPreservation, type ChangeKind } from './cognition/preservation';
import { simulateExecution, type SimulationReport } from './cognition/simulation';
import type { Indexer } from './sensing/indexer';
import { IndexStore } from './sensing/store';
import { SymbolGraph } from './sensing/symbol-graph';

/**
 * Convention & philosophy scalar signals (M11): typing strictness + test ratio +
 * source-file shape, read from the repo's tsconfig and the indexed file list.
 */
export async function philosophySignals(
  root: string,
  fingerprint: ArchitecturalFingerprint,
  files: { path: string }[],
): Promise<PhilosophySignals> {
  const typed = fingerprint.languages.includes('typescript');
  let strictTypes = false;
  if (typed) {
    const text = await readFile(join(root, 'tsconfig.json'), 'utf8').catch(() => '');
    try {
      const cfg = JSON.parse(text) as { compilerOptions?: { strict?: boolean } };
      strictTypes = cfg.compilerOptions?.strict === true;
    } catch {
      strictTypes = /"strict"\s*:\s*true/.test(text); // tsconfig with comments
    }
  }
  const isTest = (p: string): boolean => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
  const isSource = (p: string): boolean => /\.[cm]?[jt]sx?$/.test(p) && !p.endsWith('.d.ts');
  const source = files.map((f) => f.path.replace(/\\/g, '/')).filter(isSource);
  const tests = source.filter(isTest);
  const nonTest = source.filter((p) => !isTest(p));
  const testRatio = nonTest.length === 0 ? 0 : Math.min(1, tests.length / nonTest.length);
  return {
    strictTypes,
    typed,
    testRatio,
    fileCount: nonTest.length,
    sourceBasenames: nonTest.map((p) => p.split('/').pop() ?? p),
  };
}

/** Load fingerprint (persisted by `init`) falling back to a live structural scan, plus the boundary model. */
export async function fingerprintAndModel(
  root: string,
  store: IndexStore,
): Promise<{ fingerprint: ArchitecturalFingerprint; model: BoundaryModel; files: { path: string }[] }> {
  const files = store.allFileHashes();
  const fingerprint = store.getFingerprint() ?? (await analyzeStructure(root));
  const model = store.loadModuleIntelligence() ?? inferBoundaries(files, store.loadFileEdges());
  return { fingerprint, model, files };
}

/**
 * Assemble + run the execution simulation for one proposed change. Returns null
 * when the target is not in the index (nothing to predict against). The same
 * report drives `/simulate`, the `/refactor` gate, and the loop's pre-apply gate.
 */
export async function assembleSimulation(
  root: string,
  indexer: Indexer,
  store: IndexStore,
  target: string,
  change: ChangeKind,
): Promise<SimulationReport | null> {
  const { fingerprint, model, files } = await fingerprintAndModel(root, store);
  if (!files.some((f) => f.path === target)) return null;

  const all = store.allSymbols();
  const definedFiles = new Set(all.map((s) => s.file));
  const seeds = all.filter((s) => s.file === target).map((s) => s.name);
  const radius = seeds.length > 0 ? await new SymbolGraph(store).blastRadius(seeds) : { symbols: seeds, files: [] };
  const dependents = radius.symbols.filter((s) => !seeds.includes(s)).length;
  const impactedFiles = radius.files.filter((f) => f !== target);

  const moduleName = moduleOf(target);
  const moduleNode = model.modules.find((m) => m.name === moduleName);
  const dependentModules = [...new Set(impactedFiles.map(moduleOf))].filter((m) => m !== moduleName).sort();
  const cycle = model.cycles.find((c) => c.includes(moduleName)) ?? [];

  const confidence = moduleConfidence(moduleName, files, definedFiles);
  const risk = scoreRisk({ file: target, module: moduleNode, blastRadius: dependents, confidence });
  const philosophy = inferPhilosophy(fingerprint, model, await philosophySignals(root, fingerprint, files));
  const preservation = assessPreservation({
    target,
    module: moduleNode,
    risk,
    philosophy,
    change,
    isGodModule: model.godModules.some((g) => g.name === moduleName),
  });

  // Module churn (M15) → regression volatility, normalized by the mean churn of touched modules.
  const evo = analyzeEvolution(await indexer.commitHistory(), model);
  const moduleChurn = evo.hotspots.find((h) => h.name === moduleName)?.commits ?? 0;
  const churned = evo.hotspots.filter((h) => h.commits > 0);
  const churnRef = churned.length > 0 ? Math.max(1, churned.reduce((s, h) => s + h.commits, 0) / churned.length) : 1;

  return simulateExecution({
    target,
    change,
    moduleName,
    risk,
    preservation,
    dependents,
    impactedFiles,
    dependentModules,
    inCycle: cycle.length > 0,
    cycle,
    confidence,
    moduleChurn,
    churnRef,
  });
}
