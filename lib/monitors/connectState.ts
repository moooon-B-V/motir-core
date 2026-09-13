import { randomBytes } from 'node:crypto';
import { parseMonitorReturnSurfaceId, type MonitorReturnSurfaceId } from './returnSurface';

// The monitor CONNECT STATE — what the start leg stashes so the callback knows
// which project it is completing, and that it is completing a flow this browser
// actually began (Story MOTIR-4926 · MOTIR-5260).
//
// ⚠️ IT LIVES IN AN httpOnly COOKIE AND IS NEVER SIGNED, and both halves of that
// are deliberate. `lib/github/returnSurface.ts` records the rule this follows:
// "THE OAUTH GRANT starts with a request to Motir, so it can set a cookie — and
// the origin therefore never leaves this server at all." A value that does not
// take the round trip needs no HMAC, because nothing outside this server ever
// holds it. The GitLab flow signs its state precisely because the value DOES
// travel, inside the `state` parameter the provider echoes.
//
// ⚠️ WHAT THE PROVIDER ECHOES IS A DOCUMENTED EXPECTATION, AND THE GATE DOES NOT
// DEPEND ON IT. Sentry's external-install redirect is documented to return
// `code` and `installationId`; whether it also preserves a `state` parameter we
// appended is a claim about somebody else's implementation that this code cannot
// verify (MOTIR-5257 is the card that meets the real dashboard). So the CSRF gate
// is built the other way round:
//
//   · the COOKIE must be present and unexpired — it is set only by our own start
//     leg, httpOnly, ten minutes, so its presence is what says this browser began
//     a real install. A forged callback carries none and stores nothing;
//   · IF the provider echoes a state value, it MUST equal the cookie's nonce — so
//     a substituted `code` inside a genuine window is refused too;
//   · if it echoes nothing, the cookie alone decides, and the flow still works.
//
// Reading it the other way — requiring the echo — would make the happy path
// depend on an unverified claim about a third party, and a connect flow that
// cannot complete is worse than one whose narrowest attack window is closed by a
// cookie rather than by a double submit.

/** How long a connect round trip may take. The authorisation is near-immediate;
 *  ten minutes is generous and still short enough that an abandoned cookie is
 *  not a standing credential. */
export const MONITOR_CONNECT_STATE_TTL_SECONDS = 600;

/** The cookie the start leg sets. */
export const MONITOR_CONNECT_STATE_COOKIE = 'motir_monitor_connect';

export interface MonitorConnectState {
  /** The CSRF nonce, and the value a provider echo must match when there is one. */
  nonce: string;
  /** The Motir project the grant is being connected FOR. Resolved here, on the
   *  way out, where the actor's permission on it has just been asserted — never
   *  from the callback's query string, where it would be an untrusted id. */
  projectId: string;
  /** Where to land afterwards, as a SURFACE ID (see `returnSurface.ts`). */
  returnSurfaceId: MonitorReturnSurfaceId;
  /** When the flow started, as epoch ms — the freshness half of the gate. */
  issuedAt: number;
}

/** A fresh nonce — 32 bytes, base64url, the same width the GitLab flow mints. */
export const mintMonitorConnectNonce = (): string => randomBytes(32).toString('base64url');

/** Serialize the state for the cookie. Plain JSON: the value never leaves this
 *  server, so there is nothing to sign and nothing for a reader to misparse. */
export const encodeMonitorConnectState = (state: MonitorConnectState): string =>
  Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');

/**
 * Read the cookie back, or `null`.
 *
 * `null` for every failure, with no distinction between them: absent,
 * unparseable, missing a field, and EXPIRED all mean the same thing to the
 * caller — this callback is not completing a flow we can account for — and a
 * caller that cannot tell them apart cannot accidentally treat one as recoverable.
 */
export function decodeMonitorConnectState(
  raw: string | null | undefined,
  now: number = Date.now(),
): MonitorConnectState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { nonce, projectId, returnSurfaceId, issuedAt } = parsed as Record<string, unknown>;
  if (typeof nonce !== 'string' || nonce.length < 16) return null;
  if (typeof projectId !== 'string' || projectId.length === 0) return null;
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) return null;
  if (now - issuedAt > MONITOR_CONNECT_STATE_TTL_SECONDS * 1000) return null;
  // An unknown surface id is not a refusal — it resolves to the default, which is
  // the whole point of the id map. But it must be narrowed here rather than
  // carried as a raw string into a redirect.
  const surface = parseMonitorReturnSurfaceId(
    typeof returnSurfaceId === 'string' ? returnSurfaceId : null,
  );
  return {
    nonce,
    projectId,
    returnSurfaceId: surface ?? 'projectMonitoring',
    issuedAt,
  };
}
