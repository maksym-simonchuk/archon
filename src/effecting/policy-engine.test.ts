import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BlastRadius, CapabilityRequest } from '../core/types';
import { loadPolicy, PolicyEngine } from './policy-engine';

// Evaluate against the REAL committed policy — this test IS the contract check.
const doc = loadPolicy(readFileSync(join(process.cwd(), '.archon/policy.yaml'), 'utf8'));
const safe = new PolicyEngine(doc, 'safe');
const trusted = new PolicyEngine(doc, 'trusted');

const radius = (n: number): BlastRadius => ({
  files: Array.from({ length: n }, (_, i) => `f${i}.ts`),
  symbols: [],
  escapesRepo: false,
});
const req = (
  r: Partial<CapabilityRequest> & Pick<CapabilityRequest, 'action' | 'target'>,
): CapabilityRequest => ({ reason: 'test', ...r });

describe('PolicyEngine — deny (M3)', () => {
  it('denies destructive exec', () => {
    expect(safe.evaluate(req({ action: 'exec', target: 'git push --force origin main' })).decision).toBe('deny');
    expect(safe.evaluate(req({ action: 'exec', target: 'git reset --hard HEAD~3' })).decision).toBe('deny');
    expect(safe.evaluate(req({ action: 'exec', target: 'rm -rf /tmp/x' })).decision).toBe('deny');
  });

  it('denies secret reads', () => {
    expect(safe.evaluate(req({ action: 'secret.read', target: 'apps/web/.env.local' })).decision).toBe('deny');
    expect(safe.evaluate(req({ action: 'secret.read', target: 'config/secrets/db.json' })).decision).toBe('deny');
    expect(safe.evaluate(req({ action: 'secret.read', target: 'keys/server.pem' })).decision).toBe('deny');
  });

  it('denies destructive exec even when flags trail positional args', () => {
    // Regression: a prefix-only matcher let `git push origin main --force` slip
    // past the `git push --force` deny. Deny now matches the dangerous tokens as
    // an in-order subsequence, in safe AND in trusted (which allows plain push).
    expect(safe.evaluate(req({ action: 'exec', target: 'git push origin main --force' })).decision).toBe('deny');
    expect(trusted.evaluate(req({ action: 'exec', target: 'git push origin main --force' })).decision).toBe('deny');
    expect(trusted.evaluate(req({ action: 'exec', target: 'git push -f origin feature' })).decision).toBe('deny');
  });

  it('denies secret reads via the ordinary fs.read grant too', () => {
    // Regression: the broad `fs.read: **` allow must not become a secret-exfil path.
    expect(safe.evaluate(req({ action: 'fs.read', target: 'apps/web/.env.local' })).decision).toBe('deny');
    expect(safe.evaluate(req({ action: 'fs.read', target: 'config/secrets/db.json' })).decision).toBe('deny');
    expect(safe.evaluate(req({ action: 'fs.read', target: 'keys/server.pem' })).decision).toBe('deny');
    expect(safe.evaluate(req({ action: 'fs.read', target: 'src/app.ts' })).decision).toBe('allow'); // ordinary source still reads
  });
});

describe('PolicyEngine — ask (M3)', () => {
  it('asks when a write exceeds the 5-file blast radius', () => {
    expect(safe.evaluate(req({ action: 'fs.write', target: 'src/a.ts', blastRadius: radius(8) })).decision).toBe('ask');
  });

  it('asks on large edits and on any network egress', () => {
    expect(
      safe.evaluate(req({ action: 'fs.write', target: 'src/a.ts', blastRadius: radius(1) }), { linesChanged: 80 }).decision,
    ).toBe('ask');
    expect(safe.evaluate(req({ action: 'net', target: 'api.openai.com' })).decision).toBe('ask');
  });
});

describe('PolicyEngine — allow + default-deny (M3)', () => {
  it('allows in-scope writes, reads, and safelisted commands', () => {
    expect(safe.evaluate(req({ action: 'fs.write', target: 'src/a.ts', blastRadius: radius(3) })).decision).toBe('allow');
    expect(safe.evaluate(req({ action: 'fs.read', target: 'anything/at/all.ts' })).decision).toBe('allow');
    expect(safe.evaluate(req({ action: 'exec', target: 'npm run build' })).decision).toBe('allow');
    expect(safe.evaluate(req({ action: 'exec', target: 'git status' })).decision).toBe('allow');
  });

  it('default-denies anything unlisted (incl. plain push in safe)', () => {
    expect(safe.evaluate(req({ action: 'exec', target: 'curl http://x' })).decision).toBe('deny');
    expect(safe.evaluate(req({ action: 'exec', target: 'git push origin main' })).decision).toBe('deny');
  });
});

describe('PolicyEngine — profile inheritance + hard limits (M3)', () => {
  it('trusted allows worktree writes + push but still denies destructive', () => {
    expect(trusted.evaluate(req({ action: 'exec', target: 'git push origin main' })).decision).toBe('allow');
    expect(
      trusted.evaluate(req({ action: 'fs.write', target: 'src/a.ts', blastRadius: radius(20) }), { inWorktree: true }).decision,
    ).toBe('allow');
    expect(trusted.evaluate(req({ action: 'exec', target: 'git push --force' })).decision).toBe('deny');
  });

  it('enforces the profile-independent hard blast-radius ceiling', () => {
    expect(
      trusted.evaluate(req({ action: 'fs.write', target: 'src/a.ts', blastRadius: radius(30) }), { inWorktree: true }).decision,
    ).toBe('deny');
  });
});

describe('PolicyEngine — v2 capabilities (M40/ADR-0015)', () => {
  it('default-denies any namespace not in v2_capabilities', () => {
    // An unknown namespace must NEVER allow — tighten-only.
    expect(safe.evaluateV2('bogus:anything')).toBe('deny');
    expect(safe.evaluateV2('no-colon')).toBe('deny');
    expect(safe.evaluateV2('')).toBe('deny');
  });

  it('default-denies a known namespace whose allowlist is empty', () => {
    // `mcp: []` in policy.yaml — no MCP tool is callable.
    expect(safe.evaluateV2('mcp:filesystem:read_file')).toBe('deny');
    // `workflow: []` — no third-party workflow step can run.
    expect(safe.evaluateV2('workflow:any-step')).toBe('deny');
  });

  it('allows entries explicitly listed (LSP read-only methods)', () => {
    expect(safe.evaluateV2('lsp:archon/blastRadius')).toBe('allow');
    expect(safe.evaluateV2('lsp:archon/explain')).toBe('allow');
    expect(safe.evaluateV2('lsp:archon/violations')).toBe('allow');
    // A method not in the allowlist (even within an allowed namespace) is denied.
    expect(safe.evaluateV2('lsp:textDocument/didChange')).toBe('deny');
  });

  it('honours wildcard "*" inside a namespace (replay is read-only)', () => {
    expect(safe.evaluateV2('replay:run_anything')).toBe('allow');
    expect(safe.evaluateV2('replay:run_12345')).toBe('allow');
  });

  it('honours prefix:* and prefix* wildcards inside an allowlist', () => {
    const doc2 = loadPolicy(
      [
        'version: 0',
        'active_profile: safe',
        'profiles:',
        '  safe: { allow: [], ask: [], deny: [] }',
        'v2_capabilities:',
        '  mcp:',
        '    - filesystem:*',
        '    - github:list*',
      ].join('\n'),
    );
    const eng = new PolicyEngine(doc2, 'safe');
    expect(eng.evaluateV2('mcp:filesystem:read_file')).toBe('allow');
    expect(eng.evaluateV2('mcp:filesystem:write_file')).toBe('allow'); // prefix:* matches
    expect(eng.evaluateV2('mcp:github:list_commits')).toBe('allow'); // prefix* matches
    expect(eng.evaluateV2('mcp:github:delete_repo')).toBe('deny'); // not listed
    expect(eng.evaluateV2('mcp:other:tool')).toBe('deny'); // server not listed
  });
});
