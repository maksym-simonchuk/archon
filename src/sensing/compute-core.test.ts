import { describe, expect, it } from 'vitest';
import { loadComputeCore } from '../core/compute';

// Exercises the REAL Rust/WASM core (requires `npm run build:wasm` first).
describe('Rust/WASM compute core', () => {
  it('hashFiles returns blake3 hex; identical bytes hash equally', async () => {
    const core = await loadComputeCore();
    const enc = new TextEncoder();
    const [a] = await core.hashFiles([{ path: 'a.ts', bytes: enc.encode('abc') }]);
    const [b] = await core.hashFiles([{ path: 'b.ts', bytes: enc.encode('abc') }]);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(b.hash);
  });

  it('parseSymbols extracts qualified defs + intra-file call edges', async () => {
    const core = await loadComputeCore();
    const src = new TextEncoder().encode(
      'export function a() { return b(); }\nfunction b() { return 1; }\n',
    );
    const parsed = await core.parseSymbols('typescript', 'src/x.ts', src);
    expect(parsed.symbols.map((s) => s.name)).toEqual(
      expect.arrayContaining(['src/x.ts#a', 'src/x.ts#b']),
    );
    expect(parsed.edges).toContainEqual({ src: 'src/x.ts#a', dst: 'src/x.ts#b', kind: 'calls' });
  });

  it('cosineTopK returns nearest row indices, highest similarity first', async () => {
    const core = await loadComputeCore();
    const query = new Float32Array([1, 0]);
    // row0 == query (sim 1), row1 orthogonal (0), row2 anti-parallel (-1).
    const matrix = new Float32Array([1, 0, 0, 1, -1, 0]);
    expect(await core.cosineTopK(query, matrix, 2, 2)).toEqual([0, 1]);
    expect(await core.cosineTopK(query, matrix, 2, 1)).toEqual([0]);
  });
});
