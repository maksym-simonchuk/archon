/**
 * Plugin ABI v1 extensions (M40). Backward-compatible additions on top of v0:
 *   - `onEvent`        — read-only bus subscriber (telemetry, dashboards)
 *   - `provideWorkflowStep` — contribute a workflow step (M33)
 *   - `provideMcpTool` — contribute an MCP-callable tool (M31)
 *
 * v0 plugins remain valid. The host detects v1 hooks by their presence.
 */

import type { ArchonEvent } from '../services/event-bus';
import type { McpCallToolResult, McpToolDescription } from '../services/mcp/protocol';
import type { Step } from '../cognition/workflow';
import type { Plugin, PluginManifest } from './abi';

export interface EventListenerPlugin {
  kind: 'event-listener';
  manifest: PluginManifest;
  /** Pure side-effect-free subscriber. Throws are swallowed by the host. */
  onEvent(event: ArchonEvent): void | Promise<void>;
}

export interface WorkflowStepPlugin {
  kind: 'workflow-step';
  manifest: PluginManifest;
  /** Provide an executable step the host registers in the workflow registry. */
  provideStep(): Step<unknown, unknown>;
}

export interface McpToolPlugin {
  kind: 'mcp-tool';
  manifest: PluginManifest;
  /** Tool description as advertised by the MCP server. */
  describe(): McpToolDescription;
  /** Invocation — broker authorization happens at the host before this fires. */
  invoke(args: unknown): Promise<McpCallToolResult>;
}

export type PluginV1 = Plugin | EventListenerPlugin | WorkflowStepPlugin | McpToolPlugin;

export const isEventListener = (p: PluginV1): p is EventListenerPlugin => p.kind === 'event-listener';
export const isWorkflowStep = (p: PluginV1): p is WorkflowStepPlugin => p.kind === 'workflow-step';
export const isMcpTool = (p: PluginV1): p is McpToolPlugin => p.kind === 'mcp-tool';
