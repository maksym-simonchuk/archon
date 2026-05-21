// Public library surface.
export * from './core/types';
export * from './core/result';
export type { ComputeCore } from './core/compute';
export { loadComputeCore } from './core/compute';

export { CognitionLoop } from './cognition/loop';
export { CapabilityBroker } from './effecting/capability-broker';
export { PolicyEngine } from './effecting/policy-engine';
export { Transaction } from './effecting/transaction';
export { Indexer } from './sensing/indexer';
export { SymbolGraph } from './sensing/symbol-graph';
export { ContextService } from './sensing/context-service';
export { MemoryStore } from './memory/store';
export { ProviderRouter } from './services/provider-router';
export { PluginHost } from './services/plugin-host';
export { TaskJournal } from './services/task-journal';
export { loadConfig } from './services/config';
export type { ArchonConfig } from './services/config';
export type { Plugin, PluginManifest, PluginKind } from './plugins/abi';
