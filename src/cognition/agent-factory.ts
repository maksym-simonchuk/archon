import type { CapabilityAction, ArchitecturalFingerprint } from '../core/types';
import type { BoundaryModel } from '../sensing/boundaries';
import type { PhilosophyProfile } from '../sensing/philosophy';

/**
 * Agent Factory (M18): generates project-native agent specs from the detected
 * stack (M8) + module topology (M9) + philosophy (M11). Agents are NEVER
 * hand-coded — they are derived so they always match the repo. Each spec carries
 * its trigger frameworks, the rules it enforces, the modules it is scoped to, the
 * capabilities it may request, and the risk ceiling above which it must escalate.
 *
 * Pure: takes the three models, returns specs. The spec is a *declaration*; the
 * runtime that binds it to a prompt + a capability-scoped broker session and
 * drives the loop lives in `agent-runtime.ts` (`selectAgent` / `agentBriefing`)
 * + `effecting/agent-broker.ts` (the `/agent` command). This module just
 * generates and renders the declarations (the `agents` command).
 */

export type AgentRisk = 'low' | 'medium' | 'high';

export interface AgentSpec {
  /** Stable kebab-case id, e.g. `nextjs-routing-agent`. */
  id: string;
  /** One-line statement of what the agent governs. */
  purpose: string;
  /** Frameworks/signals whose presence generated this agent. */
  triggeredBy: string[];
  /** The conventions/invariants it enforces. */
  rules: string[];
  /** Modules (bounded contexts) the agent may act within; `['*']` = repo-wide. */
  scope: string[];
  /** Capabilities the agent may request through the broker — never more. */
  capabilities: CapabilityAction[];
  /** Risk level at or above which the agent must escalate to a human (M13). */
  escalateAtRisk: AgentRisk;
}

/** A framework detector → the agent it produces. `scope` is resolved against the boundary model. */
interface AgentTemplate {
  /** Frameworks (any-of) in the fingerprint that activate this template. */
  when: string[];
  build: (ctx: FactoryContext) => AgentSpec;
}

interface FactoryContext {
  fingerprint: ArchitecturalFingerprint;
  model: BoundaryModel;
  philosophy: PhilosophyProfile;
}

const READ_ONLY: CapabilityAction[] = ['fs.read'];
const READ_WRITE: CapabilityAction[] = ['fs.read', 'fs.write'];

/** Modules whose name contains any of `needles` — the agent's natural scope. */
function modulesMatching(model: BoundaryModel, needles: string[]): string[] {
  const hits = model.modules
    .map((m) => m.name)
    .filter((name) => needles.some((n) => name.toLowerCase().includes(n)));
  return hits.length > 0 ? hits : ['*'];
}

const FRAMEWORK_TEMPLATES: AgentTemplate[] = [
  {
    when: ['next'],
    build: ({ model }) => ({
      id: 'nextjs-routing-agent',
      purpose: 'Guard Next.js routing, server/client boundaries, and data-fetching conventions',
      triggeredBy: ['next'],
      rules: [
        'no server-only modules imported into client components',
        'route segments follow the app-router file conventions',
        'data fetching stays in server components / route handlers',
      ],
      scope: modulesMatching(model, ['app', 'pages', 'routes']),
      capabilities: READ_WRITE,
      escalateAtRisk: 'medium',
    }),
  },
  {
    when: ['react', 'vue', 'svelte', 'solid', 'angular'],
    build: ({ fingerprint }) => ({
      id: 'state-management-agent',
      purpose: 'Keep UI free of business logic and fetches; enforce the chosen state layer',
      triggeredBy: fingerprint.frameworks.filter((f) => ['react', 'vue', 'svelte', 'solid', 'angular'].includes(f)),
      rules: [
        'no business logic in presentation components',
        'no fetch/async inside components — go through the service/state layer',
        'derived state is memoised; callbacks are stable',
      ],
      scope: ['*'],
      capabilities: READ_WRITE,
      escalateAtRisk: 'medium',
    }),
  },
  {
    when: ['nestjs', 'express', 'fastify', 'koa', 'hapi'],
    build: ({ model, fingerprint }) => ({
      id: 'api-contract-agent',
      purpose: 'Keep API handlers thin, validate at boundaries, and keep contracts typed',
      triggeredBy: fingerprint.frameworks.filter((f) => ['nestjs', 'express', 'fastify', 'koa', 'hapi'].includes(f)),
      rules: [
        'validate every external input at the boundary',
        'controllers/handlers stay thin — logic lives in services',
        'errors surface as typed responses, never swallowed',
      ],
      scope: modulesMatching(model, ['api', 'controllers', 'routes', 'handlers', 'server']),
      capabilities: READ_WRITE,
      escalateAtRisk: 'high',
    }),
  },
];

/** Templates derived from architecture/topology rather than a specific framework. */
function structuralAgents(ctx: FactoryContext): AgentSpec[] {
  const { fingerprint, model, philosophy } = ctx;
  const agents: AgentSpec[] = [];

  // Always present: an architecture reviewer scoped to the whole repo.
  agents.push({
    id: 'architecture-review-agent',
    purpose: 'Review changes against the inferred architecture and conventions',
    triggeredBy: [fingerprint.architecturalStyle],
    rules: [
      `respect the ${fingerprint.architecturalStyle} organising principle`,
      `honour the project's ${philosophy.stabilityBias} bias and ${philosophy.abstractionTolerance} abstraction tolerance`,
      'no layer-up imports; dependencies point toward stability',
    ],
    scope: ['*'],
    capabilities: READ_ONLY,
    escalateAtRisk: 'medium',
  });

  // Feature-boundary enforcer only when the layout has clear boundaries.
  if (fingerprint.architecturalStyle === 'feature-sliced' || fingerprint.architecturalStyle === 'ddd') {
    agents.push({
      id: 'feature-boundary-enforcer',
      purpose: 'Prevent cross-boundary imports that leak between bounded contexts',
      triggeredBy: [fingerprint.architecturalStyle],
      rules: [
        'no imports that skip the public surface of a slice/context',
        'shared code lives in the shared/kernel layer, not reached across siblings',
      ],
      scope: model.modules.filter((m) => m.role === 'core').map((m) => m.name).slice(0, 8),
      capabilities: READ_ONLY,
      escalateAtRisk: 'medium',
    });
  }

  // Dependency-cleanup agent only when there is something to clean (cycles or god modules).
  if (model.cycles.length > 0 || model.godModules.length > 0) {
    agents.push({
      id: 'dependency-cleanup-agent',
      purpose: 'Break import cycles and decompose god modules conservatively',
      triggeredBy: [
        ...(model.cycles.length > 0 ? ['import-cycles'] : []),
        ...(model.godModules.length > 0 ? ['god-modules'] : []),
      ],
      rules: [
        'never delete a public export without confirming zero importers',
        'decompose by extracting, not rewriting; one cycle edge at a time',
      ],
      scope: [...new Set([...model.cycles.flat(), ...model.godModules.map((g) => g.name)])].slice(0, 8),
      capabilities: READ_WRITE,
      escalateAtRisk: 'high',
    });
  }

  // Typed-schema agent when a validation lib is in the stack.
  return agents;
}

/** Agents keyed off non-framework stack signals (test runners, schema libs). */
function stackAgents(ctx: FactoryContext): AgentSpec[] {
  const { fingerprint, model } = ctx;
  const agents: AgentSpec[] = [];
  if (fingerprint.testRunners.length > 0) {
    agents.push({
      id: 'testing-agent',
      purpose: `Keep behaviour covered with ${fingerprint.testRunners.join('/')} and flag coverage gaps`,
      triggeredBy: fingerprint.testRunners,
      rules: [
        'test behaviour, not implementation',
        'cover boundary, error, and empty cases — not just the happy path',
        'mock only at service boundaries',
      ],
      scope: ['*'],
      capabilities: READ_WRITE,
      escalateAtRisk: 'low',
    });
  }
  void model;
  return agents;
}

/**
 * Generate the project-native agent set. Deterministic and order-stable: framework
 * agents (in fingerprint order), then structural agents, then stack agents; ids
 * are de-duplicated so two signals never produce the same agent twice.
 */
export function generateAgents(
  fingerprint: ArchitecturalFingerprint,
  model: BoundaryModel,
  philosophy: PhilosophyProfile,
): AgentSpec[] {
  const ctx: FactoryContext = { fingerprint, model, philosophy };
  const fwSet = new Set(fingerprint.frameworks);
  const fromFrameworks = FRAMEWORK_TEMPLATES.filter((t) => t.when.some((w) => fwSet.has(w))).map((t) => t.build(ctx));
  const all = [...fromFrameworks, ...structuralAgents(ctx), ...stackAgents(ctx)];

  const seen = new Set<string>();
  return all.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
}

/** Human-readable agent roster for the TUI. */
export function formatAgents(agents: AgentSpec[]): string {
  if (agents.length === 0) return 'agents: none generated — run `archon init` then `archon index` first';
  const lines = [`generated agents (${agents.length}):`];
  for (const a of agents) {
    lines.push('');
    lines.push(`  ${a.id}`);
    lines.push(`    ${a.purpose}`);
    lines.push(`    triggered by: ${a.triggeredBy.join(', ') || '—'}`);
    lines.push(`    scope:        ${a.scope.join(', ')}`);
    lines.push(`    capabilities: ${a.capabilities.join(', ')} · escalate ≥ ${a.escalateAtRisk}`);
    for (const r of a.rules) lines.push(`      - ${r}`);
  }
  return lines.join('\n');
}
