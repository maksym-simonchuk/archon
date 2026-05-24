/**
 * Pure unified-diff producer + parser + applier. No I/O. Used by M27
 * patch-staging and by the TUI diff card.
 */

export interface Hunk {
  /** 1-based starting line in the original file. */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Raw lines, each prefixed with ' ', '-', or '+'. No trailing newline. */
  lines: string[];
}

export interface UnifiedDiff {
  oldFile: string;
  newFile: string;
  hunks: Hunk[];
}

const CONTEXT = 3;

const splitLines = (s: string): string[] => {
  if (s === '') return [];
  const norm = s.replace(/\r\n/g, '\n');
  const parts = norm.split('\n');
  // A trailing newline produces an empty final element we drop — typical for
  // text files. The applier re-adds the trailing newline based on the original.
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
};

type Op = { kind: 'equal'; a: number; b: number } | { kind: 'del'; a: number } | { kind: 'ins'; b: number };

/** Textbook LCS edit script — O(n*m). Fine for typical diff sizes. */
function lcsScript(a: string[], b: string[]): Op[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i] as number[];
    const next = dp[i + 1] as number[];
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) row[j] = (next[j + 1] as number) + 1;
      else row[j] = Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: 'equal', a: i, b: j });
      i++;
      j++;
    } else if (((dp[i + 1] as number[])[j] as number) >= ((dp[i] as number[])[j + 1] as number)) {
      out.push({ kind: 'del', a: i });
      i++;
    } else {
      out.push({ kind: 'ins', b: j });
      j++;
    }
  }
  while (i < m) out.push({ kind: 'del', a: i++ });
  while (j < n) out.push({ kind: 'ins', b: j++ });
  return out;
}

function scriptToHunks(script: Op[], a: string[], b: string[], context: number): Hunk[] {
  // Phase 1 — collect change ranges (no context yet).
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < script.length; ) {
    if (script[i]?.kind === 'equal') {
      i++;
      continue;
    }
    const s = i;
    while (i < script.length && script[i]?.kind !== 'equal') i++;
    ranges.push([s, i]);
  }
  if (ranges.length === 0) return [];

  // Phase 2 — merge ranges whose padded extents would overlap.
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] <= context * 2) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }

  // Phase 3 — emit hunks with `context` lines of padding on each side.
  const hunks: Hunk[] = [];
  for (const [rs, re] of merged) {
    const start = Math.max(0, rs - context);
    const end = Math.min(script.length, re + context);
    const seg = script.slice(start, end);

    let firstA = -1;
    let firstB = -1;
    for (const op of seg) {
      if (op.kind === 'equal') {
        if (firstA < 0) firstA = op.a;
        if (firstB < 0) firstB = op.b;
      } else if (op.kind === 'del') {
        if (firstA < 0) firstA = op.a;
      } else if (firstB < 0) firstB = op.b;
    }
    if (firstA < 0) firstA = 0;
    if (firstB < 0) firstB = 0;

    let oldLines = 0;
    let newLines = 0;
    const lines: string[] = [];
    for (const op of seg) {
      if (op.kind === 'equal') {
        lines.push(` ${a[op.a] as string}`);
        oldLines++;
        newLines++;
      } else if (op.kind === 'del') {
        lines.push(`-${a[op.a] as string}`);
        oldLines++;
      } else {
        lines.push(`+${b[op.b] as string}`);
        newLines++;
      }
    }
    hunks.push({ oldStart: firstA + 1, newStart: firstB + 1, oldLines, newLines, lines });
  }
  return hunks;
}

export function diffStrings(oldText: string, newText: string, oldFile = 'a', newFile = 'b'): UnifiedDiff {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const script = lcsScript(a, b);
  return { oldFile, newFile, hunks: scriptToHunks(script, a, b, CONTEXT) };
}

export function renderUnified(diff: UnifiedDiff): string {
  if (diff.hunks.length === 0) return '';
  const out: string[] = [`--- ${diff.oldFile}`, `+++ ${diff.newFile}`];
  for (const h of diff.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    out.push(...h.lines);
  }
  return `${out.join('\n')}\n`;
}

export function applyUnified(
  original: string,
  diff: UnifiedDiff,
): { ok: true; text: string } | { ok: false; reason: string } {
  const src = splitLines(original);
  const out: string[] = [];
  let cursor = 0;
  for (const h of diff.hunks) {
    const start = h.oldStart - 1;
    if (start < cursor) return { ok: false, reason: `overlapping hunks at line ${h.oldStart}` };
    while (cursor < start) out.push(src[cursor++] as string);
    let oldOff = start;
    for (const line of h.lines) {
      const marker = line[0];
      const rest = line.slice(1);
      if (marker === ' ') {
        if (src[oldOff] !== rest) return { ok: false, reason: `context mismatch at line ${oldOff + 1}` };
        out.push(rest);
        oldOff++;
      } else if (marker === '-') {
        if (src[oldOff] !== rest) return { ok: false, reason: `delete mismatch at line ${oldOff + 1}` };
        oldOff++;
      } else if (marker === '+') {
        out.push(rest);
      } else {
        return { ok: false, reason: `unknown marker "${marker}"` };
      }
    }
    cursor = oldOff;
  }
  while (cursor < src.length) out.push(src[cursor++] as string);
  return { ok: true, text: out.join('\n') + (original.endsWith('\n') ? '\n' : '') };
}

export function selectHunks(diff: UnifiedDiff, keep: number[]): UnifiedDiff {
  const set = new Set(keep);
  return { ...diff, hunks: diff.hunks.filter((_, i) => set.has(i)) };
}

export function parseUnified(patch: string): UnifiedDiff | null {
  const lines = patch.split('\n');
  let oldFile = 'a';
  let newFile = 'b';
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.startsWith('--- ')) {
      oldFile = line.slice(4);
      i++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      newFile = line.slice(4);
      i++;
      continue;
    }
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(line);
    if (header) {
      const h: Hunk = {
        oldStart: parseInt(header[1] as string, 10),
        oldLines: parseInt(header[2] as string, 10),
        newStart: parseInt(header[3] as string, 10),
        newLines: parseInt(header[4] as string, 10),
        lines: [],
      };
      i++;
      while (i < lines.length) {
        const body = lines[i] as string;
        if (body.startsWith('@@') || body.startsWith('--- ') || body.startsWith('+++ ')) break;
        if (body === '' && i === lines.length - 1) break;
        if (body[0] === ' ' || body[0] === '-' || body[0] === '+') h.lines.push(body);
        i++;
      }
      hunks.push(h);
      continue;
    }
    i++;
  }
  return { oldFile, newFile, hunks };
}
