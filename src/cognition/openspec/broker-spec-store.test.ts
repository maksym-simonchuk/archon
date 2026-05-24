import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../../effecting/audit-log';
import { CapabilityBroker } from '../../effecting/capability-broker';
import { PolicyEngine, loadPolicy } from '../../effecting/policy-engine';
import { readFile } from 'node:fs/promises';
import { BrokerSpecStore, changeFromPlanSummary } from './broker-spec-store';
import { specStatus, specValidate } from './spec-commands';

// The real PolicyDocument shape: profile.allow is an array of rules with
// `action` + `target`. The trusted profile here is permissive on openspec/**
// (and openspec/** for reads) — enough to exercise the broker write path.
const TRUSTED_POLICY = loadPolicy(`
version: 0
active_profile: trusted
profiles:
  trusted:
    allow:
      - { action: fs.read,   target: "**" }
      - { action: fs.write,  target: "openspec/**" }
      - { action: fs.delete, target: "openspec/changes/**" }
`);

const brokerFor = (root: string): CapabilityBroker =>
  new CapabilityBroker(new PolicyEngine(TRUSTED_POLICY, 'trusted'), new AuditLog(), root);

describe('BrokerSpecStore', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'archon-spec-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists no active or archived specs in an empty repo', async () => {
    const store = new BrokerSpecStore(brokerFor(root));
    const status = await specStatus(store);
    expect(status).toEqual({ active: [], archived: [] });
  });

  it('writes a change folder through the broker and reads it back', async () => {
    const broker = brokerFor(root);
    const store = new BrokerSpecStore(broker);
    const { files } = changeFromPlanSummary({
      id: 'add-greeter',
      goal: 'Add a greeter helper',
      why: 'Onboarding needs a quick smoke-test path',
      tasks: ['Define the greeter signature', 'Wire it through the helper module'],
    });
    await store.writeChange('add-greeter', files);

    // The broker wrote real files on disk under root/openspec/changes/...
    const proposal = await readFile(join(root, 'openspec/changes/add-greeter/proposal.md'), 'utf8');
    expect(proposal).toContain('Onboarding needs a quick smoke-test path');

    const read = await store.readChange('add-greeter');
    expect(read).toBeTruthy();
    expect(Object.keys(read ?? {}).sort()).toEqual(['proposal.md', 'tasks.md']);

    const status = await specStatus(store);
    expect(status.active).toEqual(['add-greeter']);
  });

  it('validates the emitted change as well-formed', async () => {
    const store = new BrokerSpecStore(brokerFor(root));
    const { files } = changeFromPlanSummary({
      id: 'noop-change',
      goal: 'No-op change to test validation',
      why: 'We want the validator to accept the emitter output',
      tasks: ['Stage', 'Verify'],
    });
    await store.writeChange('noop-change', files);
    const result = await specValidate(store, 'noop-change');
    expect(result?.ok).toBe(true);
  });

  it('archives an active change, surfaces it under archived, and removes the active copy', async () => {
    const store = new BrokerSpecStore(brokerFor(root));
    const { files } = changeFromPlanSummary({
      id: 'arch-me',
      goal: 'Archive me',
      why: 'Just to test the archive path',
      tasks: ['Done'],
    });
    await store.writeChange('arch-me', files);
    await store.archiveChange('arch-me');

    const archived = await store.listArchived();
    expect(archived).toContain('arch-me');
    const active = await store.listActive();
    expect(active).not.toContain('arch-me');
  });
});

describe('changeFromPlanSummary', () => {
  it('builds a minimal valid change with proposal + tasks', () => {
    const { change, files } = changeFromPlanSummary({
      id: 'add-x',
      goal: 'Add X',
      why: 'X is needed because of Y',
      tasks: ['Implement X', 'Add a test'],
    });
    expect(change.id).toBe('add-x');
    expect(change.tasks.map((t) => t.text)).toEqual(['Implement X', 'Add a test']);
    expect(files['proposal.md']).toContain('## Why');
    expect(files['proposal.md']).toContain('X is needed because of Y');
    expect(files['tasks.md']).toContain('- [ ] Implement X');
  });
});
