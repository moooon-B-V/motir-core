import { createHmac, randomBytes } from 'node:crypto';
import { deriveTerminalKey } from '@/lib/agentInstances/terminalKey';

// THE RELAY TOKEN — THE SIGNING HALF (Story MOTIR-6861 · MOTIR-6940,
// `docs/decisions/agent-terminal.md` Q3).
//
// The relay presents this on every upgrade to an agent's terminal server as
// `Authorization: Motir-Relay <token>`. The VERIFYING half is MOTIR-6938's
// `packages/cli/src/agentTerminal/relayToken.ts`, which owns the byte format.
// This file cannot import it (`packages/cli` crossings from `lib/` are
// restricted), so it is a second implementation of the same bytes, pinned by
// `tests/agentTerminal/relayToken.test.ts` against that module's
// `RELAY_TOKEN_TEST_VECTOR`, copied verbatim:
//
//   token        <p>.<s>
//   p            base64url, no padding, of the UTF-8 bytes of JSON.stringify of
//                { instanceId, machineId, exp, nonce[, sessionId] } IN THAT ORDER
//   exp          whole SECONDS since the Unix epoch (now + 60)
//   nonce        base64url of 16 random bytes
//   s            base64url, no padding, of HMAC-SHA256(key, the same payload bytes)
//   key          the UTF-8 bytes of the 43-character STRING
//                deriveTerminalKey(MOTIR_TERMINAL_MASTER_KEY, instanceId) — the
//                machine's MOTIR_TERMINAL_KEY as the env var holds it, never
//                base64url-decoded.
//
// A token is a credential: it is never logged and never put in an Error message.

export const RELAY_AUTH_SCHEME = 'Motir-Relay';

/** Q3: a token lives 60 seconds. */
export const RELAY_TOKEN_TTL_SECONDS = 60;

export interface RelayTokenPayload {
  instanceId: string;
  machineId: string;
  /** Expiry, whole seconds since the Unix epoch. */
  exp: number;
  /** base64url of 16 random bytes; the server refuses a nonce it has seen. */
  nonce: string;
  /** The terminal session to resume (Q5). */
  sessionId?: string;
}

/** Sign a payload with an instance key (the MOTIR_TERMINAL_KEY string). Pure. */
export function signRelayToken(instanceKey: string, payload: RelayTokenPayload): string {
  const ordered: RelayTokenPayload = {
    instanceId: payload.instanceId,
    machineId: payload.machineId,
    exp: payload.exp,
    nonce: payload.nonce,
    ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
  };
  const bytes = Buffer.from(JSON.stringify(ordered), 'utf8');
  const signature = createHmac('sha256', Buffer.from(instanceKey, 'utf8')).update(bytes).digest();
  return `${bytes.toString('base64url')}.${signature.toString('base64url')}`;
}

/**
 * The `Authorization` header value for one connection to one machine: a fresh
 * nonce, `exp = now + 60 s`, signed with the key derived for that instance.
 *
 * ⚠️ NO `sessionId`, DELIBERATELY. The server resumes a session named in the
 * token OR in the browser's `open` frame, and a token-bound one wins — so a
 * session bound here would pin the panel to it: after a cold boot the server
 * answers `unknown_session` and the panel could never open a fresh shell. The
 * session travels only in the `open` frame, which the relay forwards unchanged.
 */
export function relayAuthorization(input: {
  masterKey: string;
  instanceId: string;
  machineId: string;
  nowMs: number;
}): string {
  const token = signRelayToken(deriveTerminalKey(input.masterKey, input.instanceId), {
    instanceId: input.instanceId,
    machineId: input.machineId,
    exp: Math.floor(input.nowMs / 1000) + RELAY_TOKEN_TTL_SECONDS,
    nonce: randomBytes(16).toString('base64url'),
  });
  return `${RELAY_AUTH_SCHEME} ${token}`;
}
