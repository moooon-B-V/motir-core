import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeInstallState, encodeInstallState } from '@/lib/github/installState';

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
