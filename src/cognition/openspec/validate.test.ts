import { describe, expect, it } from 'vitest';

import { emitChange } from './emit';
import type { OpenSpecChange } from './types';
import { parseChange, validateChange } from './validate';

/** A minimal well-formed change used as the "happy path" baseline. */
const baseline = (): OpenSpecChange => ({
  id: '2026-05-25-add-streaming-tui',
  proposal: {
    why: ['Users want token-by-token rendering, not blocking 2-second turns.'],
    what: ['Add an event bus.', 'Wire ProviderRouter streamComplete to publish token deltas.'],
    whyNow: ['M0–M24 substrate is stable; v2 UX work unblocks the rest of Phase E.'],
  },
  tasks: [
    { done: false, text: 'Add `services/event-bus.ts` with tests' },
    { done: false, text: 'Publish `token.delta` from `streamComplete`' },
  ],
  specs: [
    {
      context: 'services',
      sections: {
        ADDED: [
          {
            name: 'event-bus is the v2 spine',
            body: ['The bus delivers ordered events with no shared authority.'],
            scenarios: [
              {
                name: 'subscribers receive events in publish order',
                body: ['GIVEN a fresh bus', 'WHEN I publish A then B', 'THEN the subscriber yields A, then B'],
              },
            ],
          },
        ],
      },
    },
  ],
});

describe('OpenSpec validator', () => {
  it('accepts a well-formed change', () => {
    const res = validateChange(baseline());
    expect(res.ok).toBe(true);
    // The "no Why Now" advisory should NOT fire — baseline includes one.
    expect(res.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('flags a missing Why section as an error', () => {
    const change = baseline();
    change.proposal.why = [];
    const res = validateChange(change);
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.file === 'proposal.md' && i.severity === 'error')).toBe(true);
  });

  it('flags a missing What Changes section as an error', () => {
    const change = baseline();
    change.proposal.what = [];
    const res = validateChange(change);
    expect(res.ok).toBe(false);
    expect(res.issues.find((i) => i.message.includes('What Changes'))).toBeDefined();
  });

  it('warns (not errors) when Why Now is absent', () => {
    const change = baseline();
    change.proposal.whyNow = [];
    const res = validateChange(change);
    expect(res.ok).toBe(true); // warning ≠ failure
    expect(res.issues.find((i) => i.severity === 'warning' && i.message.includes('Why Now'))).toBeDefined();
  });

  it('errors when tasks.md has no tasks at all', () => {
    const change = baseline();
    change.tasks = [];
    const res = validateChange(change);
    expect(res.ok).toBe(false);
    expect(res.issues.find((i) => i.file === 'tasks.md')).toBeDefined();
  });

  it('errors when a task has no description', () => {
    const change = baseline();
    change.tasks = [{ done: false, text: '   ' }];
    const res = validateChange(change);
    expect(res.ok).toBe(false);
  });

  it('errors when a spec file has no delta section', () => {
    const change = baseline();
    change.specs = [{ context: 'auth', sections: {} }];
    const res = validateChange(change);
    expect(res.ok).toBe(false);
    expect(res.issues.find((i) => i.file === 'specs/auth/spec.md')).toBeDefined();
  });

  it('errors when an ADDED requirement has no Scenario', () => {
    const change = baseline();
    const req = change.specs[0]?.sections.ADDED?.[0];
    if (req) req.scenarios = [];
    const res = validateChange(change);
    expect(res.ok).toBe(false);
    expect(res.issues.find((i) => i.message.includes('Scenario'))).toBeDefined();
  });

  it('does NOT require Scenarios on REMOVED requirements', () => {
    const change = baseline();
    change.specs = [
      {
        context: 'legacy',
        sections: {
          REMOVED: [{ name: 'old behaviour', body: ['no longer needed'], scenarios: [] }],
        },
      },
    ];
    const res = validateChange(change);
    expect(res.ok).toBe(true);
  });
});

describe('OpenSpec emit ↔ parse round-trip', () => {
  it('emit → parse → validate yields an identical, valid change', () => {
    const original = baseline();
    const files = emitChange(original);
    const parsed = parseChange(original.id, files);
    expect(validateChange(parsed).ok).toBe(true);

    // Structural equality on the load-bearing fields. We don't compare body
    // lines verbatim (the renderer normalises trailing blanks) — the validator
    // already proves shape; here we prove identity of the structured contract.
    expect(parsed.id).toBe(original.id);
    expect(parsed.proposal.why.length).toBeGreaterThan(0);
    expect(parsed.tasks.map((t) => t.text)).toEqual(original.tasks.map((t) => t.text));
    expect(parsed.specs.map((s) => s.context)).toEqual(original.specs.map((s) => s.context));
    const addedReqs = parsed.specs[0]?.sections.ADDED ?? [];
    expect(addedReqs[0]?.name).toBe('event-bus is the v2 spine');
    expect(addedReqs[0]?.scenarios[0]?.name).toBe('subscribers receive events in publish order');
  });

  it('handles a change with only REMOVED requirements (delete-only delta)', () => {
    const original: OpenSpecChange = {
      id: 'deprecate-legacy',
      proposal: { why: ['Dead code.'], what: ['Delete unused exports.'], whyNow: [] },
      tasks: [{ done: false, text: 'Remove the function' }],
      specs: [
        {
          context: 'legacy',
          sections: { REMOVED: [{ name: 'old function', body: [], scenarios: [] }] },
        },
      ],
    };
    const files = emitChange(original);
    const parsed = parseChange(original.id, files);
    const res = validateChange(parsed);
    expect(res.ok).toBe(true);
  });

  it('emit produces stable, repo-relative paths via changePaths()', async () => {
    const { changePaths } = await import('./emit');
    const c = baseline();
    const paths = changePaths(c, emitChange(c));
    expect(Object.keys(paths).every((p) => p.startsWith(`openspec/changes/${c.id}/`))).toBe(true);
    expect(paths[`openspec/changes/${c.id}/proposal.md`]).toBeDefined();
    expect(paths[`openspec/changes/${c.id}/tasks.md`]).toBeDefined();
    expect(paths[`openspec/changes/${c.id}/specs/services/spec.md`]).toBeDefined();
  });
});
