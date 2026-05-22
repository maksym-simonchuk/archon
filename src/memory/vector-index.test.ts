import { describe, expect, it } from 'vitest';
import { DEFAULT_DIM, embedText, packVector, unpackVector } from './vector-index';

const dot = (a: Float32Array, b: Float32Array): number => a.reduce((s, x, i) => s + x * b[i], 0);

describe('embedText', () => {
  it('is deterministic — identical text yields an identical vector', () => {
    expect([...embedText('login handler', 16)]).toEqual([...embedText('login handler', 16)]);
  });

  it('produces a unit vector (so cosine is a dot product), or zero for empty text', () => {
    const norm = Math.sqrt(dot(embedText('auth session token'), embedText('auth session token')));
    expect(norm).toBeCloseTo(1, 5);
    expect([...embedText('', 8)]).toEqual(new Array(8).fill(0));
    expect([...embedText('!!! ???', 8)]).toEqual(new Array(8).fill(0)); // no alphanumeric tokens
  });

  it('ranks a related query nearer than an unrelated one (cosine ordering)', () => {
    const q = embedText('refactor the auth login flow');
    const related = embedText('auth login refactor changes');
    const unrelated = embedText('database migration rollback schema');
    expect(dot(q, related)).toBeGreaterThan(dot(q, unrelated));
  });

  it('defaults to DEFAULT_DIM', () => {
    expect(embedText('x').length).toBe(DEFAULT_DIM);
  });
});

describe('pack/unpack', () => {
  it('round-trips a vector through the SQLite blob format', () => {
    const v = embedText('round trip vector', 32);
    expect([...unpackVector(packVector(v))]).toEqual([...v]);
  });
});
