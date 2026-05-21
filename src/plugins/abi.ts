import type { CapabilityAction, Completion, RouteRequest, Verdict } from '../core/types';

// Plugin ABI v0 — the only stable contract third-party code may depend on.
// Five hook kinds. A plugin's declared capabilities are enforced by the
// Capability Broker; no plugin receives ambient authority. See ADR-0009.

export type PluginKind = 'tool' | 'verifier' | 'provider' | 'skill' | 'retriever';

export interface PluginManifest {
  name: string;
  version: string;
  kind: PluginKind;
  /** Capabilities the plugin needs — enforced by the Capability Broker. */
  capabilities: CapabilityAction[];
}

export interface ToolPlugin {
  kind: 'tool';
  manifest: PluginManifest;
  run(input: unknown): Promise<unknown>;
}

export interface VerifierPlugin {
  kind: 'verifier';
  manifest: PluginManifest;
  verify(files: string[]): Promise<Verdict>;
}

export interface ProviderPlugin {
  kind: 'provider';
  manifest: PluginManifest;
  complete(req: RouteRequest): Promise<Completion>;
}

export interface SkillPlugin {
  kind: 'skill';
  manifest: PluginManifest;
  /** A reusable procedural playbook (Markdown). */
  playbook: string;
}

export interface RetrieverPlugin {
  kind: 'retriever';
  manifest: PluginManifest;
  retrieve(query: string, k: number): Promise<string[]>;
}

export type Plugin =
  | ToolPlugin
  | VerifierPlugin
  | ProviderPlugin
  | SkillPlugin
  | RetrieverPlugin;
