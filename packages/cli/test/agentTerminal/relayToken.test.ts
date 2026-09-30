import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  NonceMemory,
  RELAY_AUTH_SCHEME,
  RELAY_TOKEN_TEST_VECTOR as RELAY_TOKEN_VECTOR,
  deriveInstanceKey,
  keyBytes,
  newNonce,
  relayAuthorizationHeader,
  signRelayToken,
  verifyRelayAuthorization,
  verifyRelayToken,
} from '../../src/agentTerminal/relayToken.js';

// The relay token's byte format (MOTIR-6938 · `docs/decisions/agent-terminal.md`
// Q3). The relay (MOTIR-6940) signs with the SAME module, and
// `RELAY_TOKEN_TEST_VECTOR` is the fixed vector its own tests can assert
// against. Here it is recomputed by hand with `node:crypto`, independently of
// the module, so the vector pins the FORMAT and not merely the implementation.

const NOW = 1_789_999_990;
const expected = {
  instanceKey: RELAY_TOKEN_VECTOR.instanceKey,
  instanceId: 'inst_1',
  machineId: 'mach_1',
  nowSeconds: NOW,
};

describe('the byte format', () => {
  it('derives the instance key as base64url(HMAC-SHA256(master, instanceId))', () => {
    expect(deriveInstanceKey(RELAY_TOKEN_VECTOR.masterKey, RELAY_TOKEN_VECTOR.instanceId)).toBe(
      RELAY_TOKEN_VECTOR.instanceKey,
    );
    expect(RELAY_TOKEN_VECTOR.instanceKey).toHaveLength(43);
    // The HMAC key is the STRING's UTF-8 bytes, never its decoded form.
    expect(keyBytes(RELAY_TOKEN_VECTOR.instanceKey).toString('utf8')).toBe(
      RELAY_TOKEN_VECTOR.instanceKey,
    );
  });

  it('signs the vector to the pinned token', () => {
    expect(signRelayToken(RELAY_TOKEN_VECTOR.instanceKey, RELAY_TOKEN_VECTOR.payload)).toBe(
      RELAY_TOKEN_VECTOR.token,
    );
  });

  it('is exactly base64url(JSON bytes) "." base64url(HMAC over those bytes) — recomputed by hand', () => {
    const payloadBytes = Buffer.from(JSON.stringify(RELAY_TOKEN_VECTOR.payload), 'utf8');
    const keyString = createHmac('sha256', Buffer.from(RELAY_TOKEN_VECTOR.masterKey, 'utf8'))
      .update(RELAY_TOKEN_VECTOR.instanceId, 'utf8')
      .digest('base64url');
    expect(keyString).toBe(RELAY_TOKEN_VECTOR.instanceKey);
    // The HMAC key is the key STRING's UTF-8 bytes, as MOTIR_TERMINAL_KEY holds it.
    const signature = createHmac('sha256', Buffer.from(keyString, 'utf8'))
      .update(payloadBytes)
      .digest();
    expect(`${payloadBytes.toString('base64url')}.${signature.toString('base64url')}`).toBe(
      RELAY_TOKEN_VECTOR.token,
    );
  });

  it('fixes key order, so a payload built in any order signs the same', () => {
    const shuffled = {
      sessionId: RELAY_TOKEN_VECTOR.payload.sessionId,
      nonce: RELAY_TOKEN_VECTOR.payload.nonce,
      exp: RELAY_TOKEN_VECTOR.payload.exp,
      machineId: RELAY_TOKEN_VECTOR.payload.machineId,
      instanceId: RELAY_TOKEN_VECTOR.payload.instanceId,
    };
    expect(signRelayToken(RELAY_TOKEN_VECTOR.instanceKey, shuffled)).toBe(RELAY_TOKEN_VECTOR.token);
  });

  it('verifies over the CARRIED bytes, not a re-serialisation', () => {
    const bytes = Buffer.from(
      '{ "machineId":"mach_1", "instanceId":"inst_1", "exp":1790000000, "nonce":"n1" }',
    );
    const signature = createHmac('sha256', keyBytes(RELAY_TOKEN_VECTOR.instanceKey))
      .update(bytes)
      .digest();
    const token = `${bytes.toString('base64url')}.${signature.toString('base64url')}`;
    expect(verifyRelayToken(token, expected)).toMatchObject({ ok: true });
  });

  it('puts the token behind the Motir-Relay scheme', () => {
    expect(RELAY_AUTH_SCHEME).toBe('Motir-Relay');
    expect(relayAuthorizationHeader('a.b')).toBe('Motir-Relay a.b');
  });

  it('mints 16-byte nonces', () => {
    expect(Buffer.from(newNonce(), 'base64url')).toHaveLength(16);
    expect(newNonce()).not.toBe(newNonce());
  });
});

describe('verification', () => {
  const header = relayAuthorizationHeader(RELAY_TOKEN_VECTOR.token);

  it('accepts the vector and returns its payload', () => {
    expect(verifyRelayAuthorization(header, expected)).toEqual({
      ok: true,
      payload: RELAY_TOKEN_VECTOR.payload,
    });
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'Bearer x'],
    ['malformed', 'Motir-Relay onlyonepart'],
    ['malformed', 'Motir-Relay a.b.c'],
    ['malformed', 'Motir-Relay a!.b'],
  ] as const)('refuses as %s: %s', (reason, value) => {
    expect(verifyRelayAuthorization(value, expected)).toEqual({ ok: false, reason });
  });

  it('refuses a token signed with another key', () => {
    const token = signRelayToken(deriveInstanceKey('other', 'inst_1'), RELAY_TOKEN_VECTOR.payload);
    expect(verifyRelayToken(token, expected)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses when the server has no key', () => {
    expect(verifyRelayToken(RELAY_TOKEN_VECTOR.token, { ...expected, instanceKey: '' })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a tampered payload', () => {
    const [p, s] = RELAY_TOKEN_VECTOR.token.split('.');
    const tampered = Buffer.from(p!, 'base64url').toString().replace('mach_1', 'mach_2');
    expect(
      verifyRelayToken(`${Buffer.from(tampered).toString('base64url')}.${s}`, expected),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each([
    ['wrong_instance', { instanceId: 'inst_other' }],
    ['wrong_machine', { machineId: 'mach_other' }],
    ['expired', { nowSeconds: 1_790_000_000 }],
  ] as const)('refuses as %s', (reason, override) => {
    expect(verifyRelayToken(RELAY_TOKEN_VECTOR.token, { ...expected, ...override })).toEqual({
      ok: false,
      reason,
    });
  });

  it.each([
    ['not JSON', 'not json'],
    ['an array', '[]'],
    ['a missing machineId', '{"instanceId":"i","exp":1,"nonce":"n"}'],
    ['a string exp', '{"instanceId":"i","machineId":"m","exp":"1","nonce":"n"}'],
    ['an empty nonce', '{"instanceId":"i","machineId":"m","exp":1,"nonce":""}'],
    ['a numeric sessionId', '{"instanceId":"i","machineId":"m","exp":1,"nonce":"n","sessionId":5}'],
  ])('refuses a correctly SIGNED payload with %s as malformed', (_label, json) => {
    const bytes = Buffer.from(json);
    const signature = createHmac('sha256', keyBytes(RELAY_TOKEN_VECTOR.instanceKey))
      .update(bytes)
      .digest();
    expect(
      verifyRelayToken(
        `${bytes.toString('base64url')}.${signature.toString('base64url')}`,
        expected,
      ),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a replayed nonce until it expires, then forgets it', () => {
    const nonces = new NonceMemory();
    expect(verifyRelayAuthorization(header, { ...expected, nonces }).ok).toBe(true);
    expect(verifyRelayAuthorization(header, { ...expected, nonces })).toEqual({
      ok: false,
      reason: 'replayed',
    });
    expect(nonces.size).toBe(1);
    // Past its exp the nonce is swept on the next claim.
    expect(nonces.claim('other', 1_790_000_100, 1_790_000_001)).toBe(true);
    expect(nonces.size).toBe(1);
  });

  it('never remembers the nonce of a token it refused', () => {
    const nonces = new NonceMemory();
    verifyRelayToken(RELAY_TOKEN_VECTOR.token, { ...expected, machineId: 'x', nonces });
    expect(nonces.size).toBe(0);
  });
});
