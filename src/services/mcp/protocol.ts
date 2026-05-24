/**
 * MCP (Model Context Protocol) JSON-RPC 2.0 wire types. Pure data; no I/O.
 * We implement client + server (M30/M31) without depending on a third-party
 * package — the wire format is small and stable enough to own.
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result: T;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcError;

/** MCP capability declaration sent during `initialize`. */
export interface McpCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { listChanged?: boolean; subscribe?: boolean };
  prompts?: { listChanged?: boolean };
}

export interface McpToolDescription {
  name: string;
  description?: string;
  /** JSON-Schema-shaped input declaration. */
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
}

export interface McpCallToolResult {
  /** Free-form content blocks the host may render. */
  content: Array<{ type: 'text'; text: string } | { type: 'json'; json: unknown }>;
  isError?: boolean;
}

export const ERR_PARSE = -32700;
export const ERR_INVALID_REQUEST = -32600;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
export const ERR_INTERNAL = -32603;
export const ERR_DENIED = 1001;

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return 'id' in m && 'method' in m && !('result' in m) && !('error' in m);
}
export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return !('id' in m) && 'method' in m;
}
export function isResponse(m: JsonRpcMessage): m is JsonRpcSuccess | JsonRpcError {
  return 'id' in m && ('result' in m || 'error' in m);
}
