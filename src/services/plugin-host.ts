import type { Plugin } from '../plugins/abi';
import { notImplemented } from '../core/result';

/**
 * Loads plugins against ABI v0. A plugin's declared capabilities are enforced by
 * the Capability Broker — no plugin gets ambient authority. Embeddings and LSP
 * ship as plugins, keeping the core minimal. See ADR-0009.
 */
export class PluginHost {
  async load(_dir: string): Promise<Plugin[]> {
    return notImplemented('PluginHost.load', 'M7');
  }
}
