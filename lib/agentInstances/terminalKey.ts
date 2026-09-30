import { createHash, createHmac } from 'node:crypto';

// THE PER-INSTANCE TERMINAL KEY (Story MOTIR-6861 · MOTIR-6939),
// `docs/decisions/agent-terminal.md` Q3:
//
//     instanceKey = HMAC-SHA256(MOTIR_TERMINAL_MASTER_KEY, instanceId)
//
// It is set on the agent's machine as `MOTIR_TERMINAL_KEY` (the lifecycle, on
// create and on a config-updating wake), and recomputed by the relay for each
// connection to sign its one-shot token. So this module is deliberately TINY and
// dependency-free — `node:crypto` only — for the relay bundle to import as is.
//
// ⚠️ THE ENCODING IS A CONTRACT between three processes (this lifecycle, the
// relay, the in-image terminal server), so it is pinned here:
//   * input:  the master key's UTF-8 bytes as the HMAC key; the instance id's
//     UTF-8 bytes as the message;
//   * output: the 32-byte digest as **base64url without padding** (43 chars) —
//     env-safe, URL-safe, no quoting;
//   * the relay token's signature (Q3) uses this key AS THE STRING the machine
//     holds in `MOTIR_TERMINAL_KEY` (its UTF-8 bytes), never a decoding of it —
//     both sides then call `createHmac('sha256', key)` on the same string.

/** The key an instance's terminal server verifies the relay with (Q3). Pure. */
export function deriveTerminalKey(masterKey: string, instanceId: string): string {
  return createHmac('sha256', masterKey).update(instanceId, 'utf8').digest('base64url');
}

/**
 * A NON-SECRET id of a derived key — the first 16 hex digits of its SHA-256 —
 * stamped in the machine's metadata so a rotated master key is noticed and the
 * next wake re-applies the machine config (Q3, Q8). One-way: it reveals nothing
 * that helps recover the key.
 */
export function terminalKeyId(terminalKey: string): string {
  return createHash('sha256').update(terminalKey, 'utf8').digest('hex').slice(0, 16);
}
