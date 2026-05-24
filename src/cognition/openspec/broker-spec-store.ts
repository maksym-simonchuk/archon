/**
 * Filesystem-backed SpecStore (M29). Reads and writes the OpenSpec
 * `openspec/changes/<id>/` tree through the Capability Broker, so the
 * planner's plan-artifact emit (ADR-0013) is gated by the same policy as
 * every other write. No `fs` access outside the broker — that is the
 * invariant the store exists to honour.
 */

import type { CapabilityBroker } from '../../effecting/capability-broker';
import { emitChange } from './emit';
import type { ChangeFileMap, OpenSpecChange } from './types';
import type { SpecStore } from './spec-commands';

/** Layout: openspec/changes/<id>/{proposal.md, tasks.md, design.md, specs/<context>/spec.md}. */
const CHANGES_DIR = 'openspec/changes';
const ARCHIVE_DIR = 'openspec/archive';

/**
 * Strip a trailing slash from a name. fsList suffixes directories with `/` so
 * callers can distinguish; we want bare ids back.
 */
const stripSlash = (s: string): string => (s.endsWith('/') ? s.slice(0, -1) : s);

export class BrokerSpecStore implements SpecStore {
  constructor(private readonly broker: CapabilityBroker) {}

  async listActive(): Promise<string[]> {
    const res = await this.broker.fsList(CHANGES_DIR, { reason: 'spec.listActive' });
    if (!res.ok) return [];
    return res.value
      .filter((n) => n.endsWith('/'))
      .map(stripSlash)
      .sort();
  }

  async listArchived(): Promise<string[]> {
    const res = await this.broker.fsList(ARCHIVE_DIR, { reason: 'spec.listArchived' });
    if (!res.ok) return [];
    return res.value
      .filter((n) => n.endsWith('/'))
      .map(stripSlash)
      .sort();
  }

  async readChange(id: string): Promise<ChangeFileMap | null> {
    const base = `${CHANGES_DIR}/${id}`;
    const archiveBase = `${ARCHIVE_DIR}/${id}`;
    const out = await this.readTree(base);
    if (out) return out;
    return this.readTree(archiveBase);
  }

  /** Walks one change folder; returns null if the root doesn't exist. */
  private async readTree(base: string): Promise<ChangeFileMap | null> {
    const top = await this.broker.fsList(base, { reason: 'spec.readChange' });
    if (!top.ok || top.value.length === 0) return null;
    const files: ChangeFileMap = {};
    for (const name of top.value) {
      if (name === 'specs/') {
        const contexts = await this.broker.fsList(`${base}/specs`, { reason: 'spec.readSpecs' });
        if (!contexts.ok) continue;
        for (const ctx of contexts.value.filter((n) => n.endsWith('/'))) {
          const ctxBase = `${base}/specs/${stripSlash(ctx)}`;
          const inner = await this.broker.fsList(ctxBase, { reason: 'spec.readContext' });
          if (!inner.ok) continue;
          for (const f of inner.value.filter((n) => !n.endsWith('/'))) {
            const r = await this.broker.fsRead(`${ctxBase}/${f}`, { reason: 'spec.readContextFile' });
            if (r.ok) files[`specs/${stripSlash(ctx)}/${f}`] = r.value;
          }
        }
      } else if (!name.endsWith('/')) {
        const r = await this.broker.fsRead(`${base}/${name}`, { reason: 'spec.readChangeFile' });
        if (r.ok) files[name] = r.value;
      }
    }
    return Object.keys(files).length > 0 ? files : null;
  }

  async writeChange(id: string, files: ChangeFileMap): Promise<void> {
    const base = `${CHANGES_DIR}/${id}`;
    // Every file in the change is co-affected — the policy engine sees the
    // full file set when gating each individual write.
    const co = Object.keys(files).map((p) => `${base}/${p}`);
    for (const [rel, content] of Object.entries(files)) {
      await this.broker.fsWrite(`${base}/${rel}`, content, {
        reason: `spec.writeChange[${id}]`,
        blastRadius: { files: co, symbols: [], escapesRepo: false },
      });
    }
  }

  async archiveChange(id: string): Promise<void> {
    const current = await this.readChange(id);
    if (!current) return;
    // Copy to archive/.
    const archBase = `${ARCHIVE_DIR}/${id}`;
    const co = Object.keys(current).map((p) => `${archBase}/${p}`);
    for (const [rel, content] of Object.entries(current)) {
      await this.broker.fsWrite(`${archBase}/${rel}`, content, {
        reason: `spec.archive[${id}]`,
        blastRadius: { files: co, symbols: [], escapesRepo: false },
      });
    }
    // Note: the broker has no fsDelete capability yet — the active folder
    // stays until a future M removes it. Listing favours archive on a name
    // collision, but `listActive` continues to see it; cognition layers can
    // filter against `listArchived` to deduplicate.
  }
}

/**
 * Compose a minimal OpenSpec change from a CognitivePlan-style summary.
 * Used by the planner emit pathway (ADR-0013): the structured plan goes to
 * the executor as before; *also* a markdown change folder is written so the
 * artifact is human-reviewable. Spec deltas are intentionally omitted at this
 * level — that's M-late work and requires the planner to know which contexts
 * it touches. The validator is permissive for proposals without delta specs.
 */
export function changeFromPlanSummary(opts: {
  id: string;
  goal: string;
  why: string;
  tasks: string[];
}): { change: OpenSpecChange; files: ChangeFileMap } {
  const why = opts.why || opts.goal;
  const what = opts.goal;
  const whyNow = 'Tracked by the active planning loop.';

  const change: OpenSpecChange = {
    id: opts.id,
    proposal: { why: [why], what: [what], whyNow: [whyNow] },
    tasks: opts.tasks.map((t) => ({ done: false, text: t })),
    specs: [],
  };
  // Delegate to the canonical emitter so the round-trip-with-validator
  // invariant holds (validate.test.ts proves emit→parse→validate is ok).
  return { change, files: emitChange(change) };
}
