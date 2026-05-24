import { describe, expect, it } from 'vitest';
import { parseReasoningMode, renderReasoning, type ReasoningNode } from './reasoning';

const node = (plane: ReasoningNode['plane'], phase: string, message: string, at = 1, detail?: string): ReasoningNode =>
  detail !== undefined ? { plane, phase, message, at, detail } : { plane, phase, message, at };

describe('renderReasoning', () => {
  const nodes: ReasoningNode[] = [
    node('planner', 'analyse', 'identified 3 affected files'),
    node('planner', 'analyse', 'narrowed to auth.ts'),
    node('planner', 'propose', 'add hashPassword'),
    node('executor', 'write', 'wrote auth.ts'),
  ];

  it('mode=off emits no lines', () => {
    expect(renderReasoning(nodes, 'off').lines).toEqual([]);
  });

  it('mode=trace emits one line per node, in order', () => {
    const r = renderReasoning(nodes, 'trace');
    expect(r.lines.length).toBe(4);
    expect(r.lines[0]).toContain('planner/analyse');
  });

  it('mode=summary collapses repeated (plane,phase) into the last entry', () => {
    const r = renderReasoning(nodes, 'summary');
    expect(r.lines.length).toBe(3); // planner/analyse + planner/propose + executor/write
    expect(r.lines[0]).toContain('narrowed to auth.ts'); // last analyse wins
  });

  it('summary truncates long messages with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const r = renderReasoning([node('planner', 'analyse', long)], 'summary');
    expect((r.lines[0] as string).endsWith('…')).toBe(true);
  });
});

describe('parseReasoningMode', () => {
  it('accepts the three valid modes case-insensitively', () => {
    expect(parseReasoningMode('OFF')).toBe('off');
    expect(parseReasoningMode('Summary')).toBe('summary');
    expect(parseReasoningMode(' trace ')).toBe('trace');
  });
  it('falls back when input is unknown', () => {
    expect(parseReasoningMode('verbose', 'summary')).toBe('summary');
  });
});
