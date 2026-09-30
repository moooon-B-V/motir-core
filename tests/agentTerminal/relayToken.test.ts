import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveTerminalKey } from '@/lib/agentInstances/terminalKey';
import {
  RELAY_TOKEN_TTL_SECONDS,
  relayAuthorization,
  signRelayToken,
} from '@/lib/agentTerminal/relayToken';

// THE RELAY TOKEN'S BYTES (MOTIR-6940), pinned against the VERIFYING side's own
// fixed vector: `RELAY_TOKEN_TEST_VECTOR` in MOTIR-6938's
// `packages/cli/src/agentTerminal/relayToken.ts`, copied here VERBATIM because
// `lib/` may not import `packages/cli`. If either side changes a byte of the
// format, one of the two copies of this vector goes red.

const RELAY_TOKEN_TEST_VECTOR = {
  masterKey: 'mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm',
  instanceId: 'inst_1',
  instanceKey: 'yQ3UpqcoVnc1TqoLi_mZVvBWZh7fI4BbdZNYCcVPIpI',
  payload: {
    instanceId: 'inst_1',
    machineId: 'mach_1',
    exp: 1790000000,
    nonce: 'AAECAwQFBgcICQoLDA0ODw',
    sessionId: '6f1c1c2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
  },
  token:
    'eyJpbnN0YW5jZUlkIjoiaW5zdF8xIiwibWFjaGluZUlkIjoibWFjaF8xIiwiZXhwIjoxNzkwMDAwMDAwLCJub25jZSI6IkFBRUNBd1FGQmdjSUNRb0xEQTBPRHciLCJzZXNzaW9uSWQiOiI2ZjFjMWMyZS0zYTRiLTRjNWQtOGU2Zi03YThiOWMwZDFlMmYifQ.nwIwYnzW32HlXXt9Li5Gwd4smpk4fm2_y0laZHl7kTc',
} as const;

describe('the relay token (Q3) — byte-identical to the terminal server’s', () => {
  it('derives the same instance key from the same master key', () => {
    const v = RELAY_TOKEN_TEST_VECTOR;
    expect(deriveTerminalKey(v.masterKey, v.instanceId)).toBe(v.instanceKey);
  });

  it('signs the vector’s payload to the vector’s token, whatever order the keys arrive in', () => {
    const v = RELAY_TOKEN_TEST_VECTOR;
    expect(signRelayToken(v.instanceKey, { ...v.payload })).toBe(v.token);
    const { sessionId, nonce, exp, machineId, instanceId } = v.payload;
    expect(signRelayToken(v.instanceKey, { sessionId, nonce, exp, machineId, instanceId })).toBe(
      v.token,
    );
  });

  it('omits an absent sessionId from the payload entirely', () => {
    const v = RELAY_TOKEN_TEST_VECTOR;
    const { sessionId: _omit, ...payload } = v.payload;
    const [p, s] = signRelayToken(v.instanceKey, payload).split('.') as [string, string];
    const bytes = Buffer.from(p, 'base64url');
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(payload);
    expect(bytes.toString('utf8')).toBe(JSON.stringify(payload));
    expect(s).toBe(
      createHmac('sha256', Buffer.from(v.instanceKey, 'utf8')).update(bytes).digest('base64url'),
    );
  });

  it('builds the Authorization header: now + 60 s in seconds, a fresh 16-byte nonce, no session', () => {
    const v = RELAY_TOKEN_TEST_VECTOR;
    const nowMs = 1_790_000_000_500;
    const header = relayAuthorization({
      masterKey: v.masterKey,
      instanceId: v.instanceId,
      machineId: 'mach_1',
      nowMs,
    });
    const [scheme, token] = header.split(' ') as [string, string];
    expect(scheme).toBe('Motir-Relay');
    const [p, s] = token.split('.') as [string, string];
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(payload)).toEqual(['instanceId', 'machineId', 'exp', 'nonce']);
    expect(payload['exp']).toBe(1_790_000_000 + RELAY_TOKEN_TTL_SECONDS);
    expect(Buffer.from(payload['nonce'] as string, 'base64url')).toHaveLength(16);
    expect(s).toBe(
      createHmac('sha256', Buffer.from(v.instanceKey, 'utf8'))
        .update(Buffer.from(p, 'base64url'))
        .digest('base64url'),
    );
    const again = relayAuthorization({
      masterKey: v.masterKey,
      instanceId: v.instanceId,
      machineId: 'mach_1',
      nowMs,
    });
    expect(again).not.toBe(header); // a new nonce every connection
  });
});
