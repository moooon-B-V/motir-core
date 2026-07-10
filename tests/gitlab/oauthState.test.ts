import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeOAuthState, encodeOAuthState } from '@/lib/gitlab/oauthState';

// Story 7.23 · MOTIR-1474 — the signed GitLab OAuth-state helper (pure, no DB).
// Carries the target workspace + acting user + a CSRF nonce through the connect
// round-trip, HMAC-signed so GitLab can't tamper with what it echoes back.

const SECRET = 'test-better-auth-secret-value-0001';
const STATE = { workspaceId: 'ws_1', userId: 'user_1', nonce: 'nonce_abc' };

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_SECRET', SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('gitlab oauthState', () => {
  it('round-trips workspace + user + nonce through encode/decode', () => {
    const token = encodeOAuthState(STATE);
    expect(decodeOAuthState(token)).toEqual(STATE);
  });

  it('rejects a tampered signature', () => {
    const token = encodeOAuthState(STATE);
    // Flip the last character of the signature segment.
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(decodeOAuthState(tampered)).toBeNull();
  });

  it('rejects a payload signed with a different secret', () => {
    const token = encodeOAuthState(STATE);
    vi.stubEnv('BETTER_AUTH_SECRET', 'a-completely-different-secret-9999');
    expect(decodeOAuthState(token)).toBeNull();
  });

  it('rejects an expired token', () => {
    const now = 1_000_000;
    const token = encodeOAuthState(STATE, now);
    // 601s later — past the 600s TTL.
    expect(decodeOAuthState(token, now + 601)).toBeNull();
    // Still valid a second before expiry.
    expect(decodeOAuthState(token, now + 599)).toEqual(STATE);
  });

  it('rejects a malformed token', () => {
    expect(decodeOAuthState('not-a-token')).toBeNull();
    expect(decodeOAuthState('')).toBeNull();
  });
});
