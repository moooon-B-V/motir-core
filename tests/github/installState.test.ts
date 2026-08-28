import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeInstallState,
  decodeInstallStateResult,
  encodeInstallState,
} from '@/lib/github/installState';

// Story 7.10 · MOTIR-1588 — the signed install-state token carried through the
// GitHub App install round-trip. Pure crypto (HMAC over BETTER_AUTH_SECRET); no
// I/O. `nowSeconds` is injectable so expiry is deterministic.

const SECRET = 'test-better-auth-secret-abcdef0123456789';
const NOW = 1_700_000_000;

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('encode/decode round-trip', () => {
  it('recovers the workspaceId + userId from a freshly-signed token', () => {
    const token = encodeInstallState({ workspaceId: 'ws_1', userId: 'usr_1' }, NOW);
    expect(decodeInstallState(token, NOW + 10)).toEqual({ workspaceId: 'ws_1', userId: 'usr_1' });
  });
});

describe('rejections', () => {
  it('rejects an EXPIRED token (past its 10-minute TTL)', () => {
    const token = encodeInstallState({ workspaceId: 'ws_1', userId: 'usr_1' }, NOW);
    expect(decodeInstallState(token, NOW + 601)).toBeNull(); // TTL is 600s
    expect(decodeInstallState(token, NOW + 599)).not.toBeNull();
  });

  it('rejects a TAMPERED payload (signature no longer matches)', () => {
    const token = encodeInstallState({ workspaceId: 'ws_1', userId: 'usr_1' }, NOW);
    const [payload, sig] = token.split('.');
    // Re-encode a different workspace but keep the original signature.
    const forgedPayload = Buffer.from(
      JSON.stringify({ w: 'ws_ATTACKER', u: 'usr_1', exp: NOW + 600 }),
    ).toString('base64url');
    expect(decodeInstallState(`${forgedPayload}.${sig}`, NOW + 10)).toBeNull();
    // sanity: the untampered token still verifies
    expect(decodeInstallState(`${payload}.${sig}`, NOW + 10)).not.toBeNull();
  });

  it('rejects a token signed with a DIFFERENT secret', () => {
    const token = encodeInstallState({ workspaceId: 'ws_1', userId: 'usr_1' }, NOW);
    vi.stubEnv('BETTER_AUTH_SECRET', 'a-completely-different-secret');
    expect(decodeInstallState(token, NOW + 10)).toBeNull();
  });

  it('rejects malformed input (no signature, garbage)', () => {
    expect(decodeInstallState('', NOW)).toBeNull();
    expect(decodeInstallState('nosignature', NOW)).toBeNull();
    expect(decodeInstallState('not.base64url.payload', NOW)).toBeNull();
  });
});

// MOTIR-3755 — the caller needs to tell an EXPIRED state from a broken one: the
// first means "start again from Settings", the second means the token cannot be
// trusted. `decodeInstallState` keeps returning `null` for both.
describe('decodeInstallStateResult names WHY it rejected', () => {
  it('reports a verified token as ok, carrying the same state', () => {
    const token = encodeInstallState({ workspaceId: 'ws_1', userId: 'usr_1' }, NOW);
    expect(decodeInstallStateResult(token, NOW + 10)).toEqual({
      ok: true,
      state: { workspaceId: 'ws_1', userId: 'usr_1' },
    });
  });

  it('reports EXPIRED past the TTL, and not before it', () => {
    const token = encodeInstallState({ workspaceId: 'ws_1', userId: 'usr_1' }, NOW);
    expect(decodeInstallStateResult(token, NOW + 601)).toEqual({ ok: false, reason: 'expired' });
    expect(decodeInstallStateResult(token, NOW + 599).ok).toBe(true);
  });

  it('reports MALFORMED for a tampered payload, a foreign secret, and garbage', () => {
    const token = encodeInstallState({ workspaceId: 'ws_1', userId: 'usr_1' }, NOW);
    const [, sig] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ w: 'ws_ATTACKER', u: 'usr_1', exp: NOW + 600 }),
    ).toString('base64url');
    expect(decodeInstallStateResult(`${forgedPayload}.${sig}`, NOW + 10)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(decodeInstallStateResult('not.base64url.payload', NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });

    vi.stubEnv('BETTER_AUTH_SECRET', 'a-completely-different-secret');
    expect(decodeInstallStateResult(token, NOW + 10)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('will not call an UNSIGNED expired-looking payload expired', () => {
    // The benign banner must not be reachable from a string nobody signed: a
    // payload that fails the signature is malformed, whatever its `exp` says.
    const unsigned = Buffer.from(JSON.stringify({ w: 'ws_1', u: 'usr_1', exp: NOW - 1 })).toString(
      'base64url',
    );
    expect(decodeInstallStateResult(`${unsigned}.notasignature`, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});
