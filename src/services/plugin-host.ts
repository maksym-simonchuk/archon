import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { err, ok, type Result } from '../core/result';
import type { CapabilityAction, PolicyVerdict, Verdict } from '../core/types';
import type { CapabilityBroker } from '../effecting/capability-broker';
import type { Plugin, PluginKind, PluginManifest, ProviderPlugin } from '../plugins/abi';
import type {
  EventListenerPlugin,
  McpToolPlugin,
  PluginV1,
  WorkflowStepPlugin,
} from '../plugins/abi-v1';
import { isEventListener, isMcpTool, isWorkflowStep } from '../plugins/abi-v1';
import type { EventBus } from './event-bus';

const KINDS = new Set<PluginKind>(['tool', 'verifier', 'provider', 'skill', 'retriever']);
/** ABI v1 plugin kinds — backward-compatible additions (M40, ADR-0015). */
const V1_KINDS = new Set(['event-listener', 'workflow-step', 'mcp-tool']);
const ACTIONS = new Set<CapabilityAction>(['fs.read', 'fs.write', 'fs.delete', 'exec', 'net', 'secret.read']);

function validateManifest(m: PluginManifest, allowV1 = false): void {
  if (!m.name) throw new Error('[archon] plugin manifest: missing name');
  if (!m.version) throw new Error(`[archon] plugin "${m.name}": missing version`);
  const known = allowV1 ? KINDS.has(m.kind) || V1_KINDS.has(m.kind as string) : KINDS.has(m.kind);
  if (!known) throw new Error(`[archon] plugin "${m.name}": unknown kind "${m.kind}"`);
  for (const cap of m.capabilities) {
    if (!ACTIONS.has(cap)) throw new Error(`[archon] plugin "${m.name}": unknown capability "${cap}"`);
  }
}

/**
 * Loads plugins against ABI v0 and runs them with ZERO ambient authority: a
 * plugin acts only through the capabilities its manifest declares, and each is
 * checked against the live policy via the Capability Broker before the plugin
 * runs. A plugin that declares a capability the policy will not grant simply does
 * not run. Embeddings and LSP ship as plugins, keeping the core minimal (ADR-0009).
 */
export class PluginHost {
  private readonly plugins = new Map<string, Plugin>();
  /**
   * ABI v1 registry (M40). Parallel to `plugins` so v0 typing stays clean: a v1
   * plugin never appears in `list()`/`invokeTool` and never participates in v0
   * dispatch. The host exposes typed accessors (`eventListeners`, `workflowSteps`,
   * `mcpTools`) the runtime composes against. Backward-compatible by construction.
   */
  private readonly v1Plugins = new Map<string, PluginV1>();
  /** Bus subscriptions installed for event-listener plugins (cancelled in `dispose`). */
  private readonly subscriptions: (() => void)[] = [];

  constructor(private readonly broker: CapabilityBroker) {}

  /** Register an in-process plugin (used by built-ins and tests). */
  register(plugin: Plugin): void {
    validateManifest(plugin.manifest);
    if (this.plugins.has(plugin.manifest.name)) {
      throw new Error(`[archon] duplicate plugin "${plugin.manifest.name}"`);
    }
    this.plugins.set(plugin.manifest.name, plugin);
  }

  /**
   * Register an ABI v1 plugin (M40). Kind decides the surface — listeners are
   * subscribed to the bus by `attachListeners`, workflow steps surface through
   * `workflowSteps()`, MCP tools through `mcpTools()`. The plugin's declared
   * capabilities are still gated by the broker at call time. See `abi-v1.ts`.
   */
  registerV1(plugin: PluginV1): void {
    validateManifest(plugin.manifest, true);
    if (this.v1Plugins.has(plugin.manifest.name) || this.plugins.has(plugin.manifest.name)) {
      throw new Error(`[archon] duplicate plugin "${plugin.manifest.name}"`);
    }
    this.v1Plugins.set(plugin.manifest.name, plugin);
  }

  list(): Plugin[] {
    return [...this.plugins.values()];
  }

  /** Read-only view of registered ABI v1 plugins (for `/plugins` rendering). */
  listV1(): PluginV1[] {
    return [...this.v1Plugins.values()];
  }

  /** Every registered event-listener plugin (M40). */
  eventListeners(): EventListenerPlugin[] {
    return this.listV1().filter(isEventListener);
  }

  /** Every registered workflow-step plugin (M40). */
  workflowSteps(): WorkflowStepPlugin[] {
    return this.listV1().filter(isWorkflowStep);
  }

  /** Every registered MCP-tool plugin (M40). */
  mcpTools(): McpToolPlugin[] {
    return this.listV1().filter(isMcpTool);
  }

  /**
   * Subscribe every registered event-listener plugin to `bus`. Each listener
   * runs in its own iterator loop; an exception inside a listener is swallowed
   * so one bad plugin can't break the engine (ADR-0015: bus carries no
   * authority, producer never blocks on a slow consumer). Idempotent across
   * repeat calls is the caller's responsibility — typical wiring is one shot
   * from `buildRuntime` after `load()`.
   */
  attachListeners(bus: EventBus): void {
    for (const listener of this.eventListeners()) {
      let alive = true;
      this.subscriptions.push(() => {
        alive = false;
      });
      void (async (): Promise<void> => {
        try {
          for await (const e of bus.subscribe()) {
            if (!alive) break;
            try {
              await listener.onEvent(e);
            } catch {
              // Listener exceptions are isolated — the loop keeps running.
            }
          }
        } catch {
          // Subscribe iterator errors (e.g. bus closed mid-yield) end the loop.
        }
      })();
    }
  }

  /** Cancel every active listener subscription (call before bus.close on shutdown). */
  dispose(): void {
    for (const cancel of this.subscriptions) cancel();
    this.subscriptions.length = 0;
  }

  /**
   * Load each immediate subdirectory's `plugin.mjs` entry — it must
   * `export const plugin`. The dynamic import is host bootstrapping, not an
   * agent path: the loaded code still receives no authority beyond what the
   * broker grants at call time. A missing directory yields no plugins (not an
   * error).
   */
  async load(dir: string): Promise<Plugin[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const loaded: Plugin[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const url = pathToFileURL(join(dir, entry.name, 'plugin.mjs')).href;
      // v0 + v1 plugins live in the same loader: a v0 plugin exports `plugin`
      // (one of `tool|verifier|provider|skill|retriever`); a v1 module may
      // additionally export `pluginsV1` (an array) to register listeners,
      // workflow steps, or MCP tools without disturbing the v0 export.
      const mod = (await import(url)) as { plugin?: Plugin; pluginsV1?: PluginV1[] };
      if (!mod.plugin && !mod.pluginsV1) {
        throw new Error(`[archon] plugin "${entry.name}": missing 'plugin' or 'pluginsV1' export`);
      }
      if (mod.plugin) {
        this.register(mod.plugin);
        loaded.push(mod.plugin);
      }
      if (mod.pluginsV1) {
        for (const p of mod.pluginsV1) this.registerV1(p);
      }
    }
    return loaded;
  }

  /**
   * The first declared capability the active policy will not `allow` for this
   * plugin (with the verdict), or `null` when every capability is granted. The
   * single gate both `invokeTool` and `runVerifiers` consult before running a
   * plugin, so no plugin ever acts beyond what its manifest declares + the
   * policy grants.
   */
  private async firstRefusal(
    name: string,
    capabilities: CapabilityAction[],
  ): Promise<{ action: CapabilityAction; verdict: PolicyVerdict } | null> {
    for (const action of capabilities) {
      const verdict = await this.broker.request({
        action,
        target: `plugin:${name}`,
        reason: `plugin "${name}" declared capability ${action}`,
      });
      if (verdict.decision !== 'allow') return { action, verdict };
    }
    return null;
  }

  /**
   * Run a tool plugin, enforcing its declared capabilities first: every action
   * in the manifest must be `allow`ed by the policy (for the plugin's namespaced
   * target) or the call is refused before the plugin executes. Non-tool and
   * unknown plugins are refused.
   */
  async invokeTool(name: string, input: unknown): Promise<Result<unknown>> {
    const plugin = this.plugins.get(name);
    if (!plugin) return err({ code: 'plugin.unknown', message: `no plugin "${name}"` });
    if (plugin.kind !== 'tool') return err({ code: 'plugin.kind', message: `plugin "${name}" is not a tool` });

    const refusal = await this.firstRefusal(name, plugin.manifest.capabilities);
    if (refusal) {
      return err({
        code: `policy.${refusal.verdict.decision}`,
        message: `plugin "${name}" capability ${refusal.action} not granted: ${refusal.verdict.message}`,
      });
    }

    try {
      return ok(await plugin.run(input));
    } catch (e) {
      return err({ code: 'plugin.failed', message: e instanceof Error ? e.message : String(e), cause: e });
    }
  }

  /**
   * Run every loaded `verifier`-kind plugin against the changed `files`, one
   * Verdict each. A plugin runs only if the policy grants all its declared
   * capabilities — a refused one is inert (skipped, surfaced in `archon
   * plugins`) rather than blocking. A plugin that throws yields a failed verdict
   * (fail-safe: a broken verifier blocks the merge, never silently passes). The
   * loop ANDs these into the built-in verdict, so plugin verifiers can only make
   * verification stricter, never widen it. See ADR-0009.
   */
  async runVerifiers(files: string[]): Promise<Verdict[]> {
    const verdicts: Verdict[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.kind !== 'verifier') continue;
      if (await this.firstRefusal(plugin.manifest.name, plugin.manifest.capabilities)) continue;
      try {
        verdicts.push(await plugin.verify(files));
      } catch (e) {
        verdicts.push({
          passed: false,
          checks: [
            {
              name: `plugin:${plugin.manifest.name}`,
              passed: false,
              output: e instanceof Error ? e.message : String(e),
            },
          ],
        });
      }
    }
    return verdicts;
  }

  /**
   * Provider-kind plugins the active policy will let run — those whose every
   * declared capability is granted (a refused one is excluded, so enabling a
   * network completer is an explicit `trusted`/grant decision). The router calls
   * these as a self-priced fallback when no configured model serves a request;
   * the network call itself is inference substrate, not re-gated per call. See
   * ADR-0012.
   */
  async providerPlugins(): Promise<ProviderPlugin[]> {
    const granted: ProviderPlugin[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.kind !== 'provider') continue;
      if (await this.firstRefusal(plugin.manifest.name, plugin.manifest.capabilities)) continue;
      granted.push(plugin);
    }
    return granted;
  }

  /**
   * Gather hits from every loaded `retriever`-kind plugin whose capabilities the
   * policy grants (refused ⇒ skipped). Hits are flattened in registration order;
   * a throwing retriever contributes nothing (fail-safe — a broken plugin must
   * never break context assembly). The runtime folds these into the planner
   * context alongside the built-in memory + repo-map retrieval.
   */
  async runRetrievers(query: string, k: number): Promise<string[]> {
    const hits: string[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.kind !== 'retriever') continue;
      if (await this.firstRefusal(plugin.manifest.name, plugin.manifest.capabilities)) continue;
      try {
        hits.push(...(await plugin.retrieve(query, k)));
      } catch {
        // a failing retriever yields no hits — context assembly carries on
      }
    }
    return hits;
  }
}
