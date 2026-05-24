/**
 * LSP (Language Server Protocol) JSON-RPC types. Subset sufficient for the
 * M39 bridge: `initialize`, `textDocument/codeAction`, `workspace/executeCommand`,
 * plus diagnostics push. Pure data.
 */

export interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface LspDiagnostic {
  range: LspRange;
  severity: 1 | 2 | 3 | 4;
  message: string;
  source?: string;
}

export interface LspCodeAction {
  title: string;
  kind?: string;
  command?: { title: string; command: string; arguments?: unknown[] };
}
