import { describe, expect, it } from 'vitest';
import { decomposeIntent, resolveScope, type ScopeInput } from './context-scope';

describe('decomposeIntent', () => {
  it('lowercases, drops short words + stopwords, and dedupes', () => {
    expect(decomposeIntent('Add the auth login flow for AUTH')).toEqual(['auth', 'login', 'flow']);
  });

  it('splits on any non-alphanumeric boundary', () => {
    expect(decomposeIntent('refactor user-service/session.ts')).toEqual(['user', 'service', 'session']);
  });

  it('returns nothing for an all-stopword goal', () => {
    expect(decomposeIntent('add the new feature')).toEqual([]);
  });
});

describe('resolveScope', () => {
  // auth/ imports session/; billing/ is unrelated.
  const input: ScopeInput = {
    symbols: [
      { name: 'auth/login.ts#login', file: 'auth/login.ts', kind: 'function' },
      { name: 'session/store.ts#open', file: 'session/store.ts', kind: 'function' },
      { name: 'billing/charge.ts#charge', file: 'billing/charge.ts', kind: 'function' },
    ],
    fileEdges: [{ src: 'auth/login.ts', dst: 'session/store.ts' }],
    goal: 'fix the login flow',
  };

  it('seeds from a name match and lifts to the import-neighbor bounded context', () => {
    const scope = resolveScope(input);
    expect(scope.matchedTerms).toEqual(['login']);
    expect(scope.seedSymbols).toEqual(['auth/login.ts#login']);
    expect(scope.seedModules).toEqual(['auth']);
    // auth's import neighbor `session` is pulled in; unrelated `billing` is not.
    expect(scope.scopeModules).toEqual(['auth', 'session']);
    expect(scope.scopedSymbols).toEqual(['auth/login.ts#login', 'session/store.ts#open']);
  });

  it('matches a term against the file path, not just the symbol name', () => {
    const scope = resolveScope({ ...input, goal: 'touch billing' });
    expect(scope.seedSymbols).toEqual(['billing/charge.ts#charge']);
    expect(scope.scopeModules).toEqual(['billing']); // no edges → no neighbors
  });

  it('returns an empty scope when the goal names nothing in the repo', () => {
    const scope = resolveScope({ ...input, goal: 'understand telemetry' });
    expect(scope).toEqual({
      matchedTerms: [],
      seedSymbols: [],
      seedModules: [],
      scopeModules: [],
      scopedSymbols: [],
    });
  });

  it('returns an empty scope for an all-stopword goal', () => {
    expect(resolveScope({ ...input, goal: 'add the feature' }).seedSymbols).toEqual([]);
  });
});
