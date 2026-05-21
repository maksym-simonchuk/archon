// Public library surface.
export * from './core/types';
export * from './core/result';
export type { ComputeCore } from './core/compute';
export { loadComputeCore } from './core/compute';

export { CognitionLoop } from './cognition/loop';
export type { CognitionLoopDeps } from './cognition/loop';
export { Planner } from './cognition/planner';
export { Executor } from './cognition/executor';
export { Verifier } from './cognition/verifier';
export { Reflector } from './cognition/reflector';
export { ScaffoldStrategy } from './cognition/scaffold-strategy';
export type { CognitivePlan, PlanStrategy, StepAction, VerifierCheck } from './cognition/types';
export { CapabilityBroker } from './effecting/capability-broker';
export { PolicyEngine, loadPolicy } from './effecting/policy-engine';
export { Transaction } from './effecting/transaction';
export { Indexer } from './sensing/indexer';
export { SymbolGraph } from './sensing/symbol-graph';
export { ContextService } from './sensing/context-service';
export { MemoryStore } from './memory/store';
export { PromotionEngine } from './memory/promotion';
export { ProviderRouter } from './services/provider-router';
export type { ProviderClient, RouterOptions } from './services/provider-router';
export { PluginHost } from './services/plugin-host';
export { TaskJournal } from './services/task-journal';
export { loadConfig } from './services/config';
export type { ArchonConfig } from './services/config';
export type { Plugin, PluginManifest, PluginKind } from './plugins/abi';
