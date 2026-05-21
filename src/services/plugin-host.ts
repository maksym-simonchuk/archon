import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { err, ok, type Result } from '../core/result';
import type { CapabilityAction } from '../core/types';
import type { CapabilityBroker } from '../effecting/capability-broker';
import type { Plugin, PluginKind, PluginManifest } from '../plugins/abi';

const KINDS = new Set<PluginKind>(['tool', 'verifier', 'provider', 'skill', 'retriever']);
const ACTIONS = new Set<CapabilityAction>(['fs.read', 'fs.write', 'fs.delete', 'exec', 'net', 'secret.read']);

function validateManifest(m: PluginManifest): void {
  if (!m.name) throw new Error('[archon] plugin manifest: missing name');
  if (!m.version) throw new Error(`[archon] plugin "${m.name}": missing version`);
  if (!KINDS.has(m.kind)) throw new Error(`[archon] plugin "${m.name}": unknown kind "${m.kind}"`);
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

  constructor(private readonly broker: CapabilityBroker) {}

  /** Register an in-process plugin (used by built-ins and tests). */
  register(plugin: Plugin): void {
    validateManifest(plugin.manifest);
    if (this.plugins.has(plugin.manifest.name)) {
      throw new Error(`[archon] duplicate plugin "${plugin.manifest.name}"`);
    }
    this.plugins.set(plugin.manifest.name, plugin);
  }

  list(): Plugin[] {
    return [...this.plugins.values()];
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
      const mod = (await import(url)) as { plugin?: Plugin };
      if (!mod.plugin) throw new Error(`[archon] plugin "${entry.name}": missing 'plugin' export`);
      this.register(mod.plugin);
      loaded.push(mod.plugin);
    }
    return loaded;
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

    for (const action of plugin.manifest.capabilities) {
      const verdict = await this.broker.request({
        action,
        target: `plugin:${name}`,
        reason: `plugin "${name}" declared capability ${action}`,
      });
      if (verdict.decision !== 'allow') {
        return err({
          code: `policy.${verdict.decision}`,
          message: `plugin "${name}" capability ${action} not granted: ${verdict.message}`,
        });
      }
    }

    try {
      return ok(await plugin.run(input));
    } catch (e) {
      return err({ code: 'plugin.failed', message: e instanceof Error ? e.message : String(e), cause: e });
    }
  }
}
