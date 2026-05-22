import { describe, expect, it } from 'vitest';
import type { AgentSpec } from './agent-factory';
import { agentBriefing, goalTerms, scoreAgentFit, selectAgent } from './agent-runtime';

const agent = (over: Partial<AgentSpec>): AgentSpec => ({
  id: 'architecture-review-agent',
  purpose: 'Review changes against the inferred architecture',
  triggeredBy: ['modular-monolith'],
  rules: ['no layer-up imports'],
  scope: ['*'],
  capabilities: ['fs.read'],
  escalateAtRisk: 'medium',
  ...over,
});

const ROUTING = agent({
  id: 'nextjs-routing-agent',
  purpose: 'Guard Next.js routing',
  triggeredBy: ['next'],
  rules: ['route segments follow the app-router conventions'],
  scope: ['src/app', 'src/routes'],
  capabilities: ['fs.read', 'fs.write'],
});
const TESTING = agent({
  id: 'testing-agent',
  purpose: 'Keep behaviour covered',
  triggeredBy: ['vitest'],
  rules: ['test behaviour, not implementation'],
  scope: ['*'],
  capabilities: ['fs.read', 'fs.write'],
  escalateAtRisk: 'low',
});
const REVIEW = agent({});

describe('goalTerms', () => {
  it('drops stopwords and short tokens, lowercases', () => {
    expect([...goalTerms('Add a new routing guard for the App')].sort()).toEqual(['app', 'guard', 'routing']);
  });
});

describe('scoreAgentFit', () => {
  it('rewards an id-word match', () => {
    expect(scoreAgentFit(ROUTING, goalTerms('fix the routing'))).toBeGreaterThan(0);
  });

  it('rewards a trigger-framework match', () => {
    expect(scoreAgentFit(ROUTING, goalTerms('next app router bug'))).toBeGreaterThan(
      scoreAgentFit(TESTING, goalTerms('next app router bug')),
    );
  });

  it('scores zero when nothing matches', () => {
    expect(scoreAgentFit(ROUTING, goalTerms('rename a database column'))).toBe(0);
  });
});

describe('selectAgent', () => {
  it('picks the agent whose triggers/id fit the goal', () => {
    expect(selectAgent([REVIEW, ROUTING, TESTING], 'fix nextjs routing')?.id).toBe('nextjs-routing-agent');
    expect(selectAgent([REVIEW, ROUTING, TESTING], 'add test coverage')?.id).toBe('testing-agent');
  });

  it('falls back to the architecture reviewer when nothing matches', () => {
    expect(selectAgent([REVIEW, ROUTING, TESTING], 'rename a database column')?.id).toBe(
      'architecture-review-agent',
    );
  });

  it('returns undefined for an empty roster', () => {
    expect(selectAgent([], 'anything')).toBeUndefined();
  });
});

describe('agentBriefing', () => {
  it('renders mandate, explicit scope, capability ceiling and rules', () => {
    const out = agentBriefing(ROUTING);
    expect(out).toContain('# Active agent: nextjs-routing-agent');
    expect(out).toContain('Scope: src/app, src/routes');
    expect(out).toContain('Granted capabilities: fs.read, fs.write');
    expect(out).toContain('risk ≥ medium');
    expect(out).toContain('- route segments follow the app-router conventions');
  });

  it('describes a repo-wide scope in words', () => {
    expect(agentBriefing(REVIEW)).toContain('Scope: the whole repository');
  });
});
