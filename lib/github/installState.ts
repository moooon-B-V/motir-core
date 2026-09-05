import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseReturnSurfaceId, type GithubReturnSurfaceId } from './returnSurface';

// Signed, self-contained state carried through the GitHub App install round-trip
// (MOTIR-1588). Unlike the OAuth identity flow — which stashes a CSRF nonce in an
// httpOnly cookie (MOTIR-1498) — the App INSTALL starts from a bare GitHub URL
// (`github.com/apps/<slug>/installations/new`) with no request to Motir, so no
// cookie can be set. GitHub echoes back whatever `state` the install URL carried,
// so the state must be self-verifying: a base64url JSON payload
// `{ w: workspaceId, u: userId, exp }` + an HMAC-SHA256 signature.
//
// Keyed by `BETTER_AUTH_SECRET` (always configured — the app can't run without
// it) with a domain-separation context so this signature can never be confused
// with any other HMAC the app makes. Short-lived (10 min) so a leaked install
// link can't be replayed to bind an installation later. The setup handler
// re-checks the acting session user == `u` and that they're a member of `w`, so
// the state is a binding HINT, not an authorization by itself.

const CONTEXT = 'github-install-state.v1';
const TTL_SECONDS = 600;

function signingKey(): string {
  const secret = process.env['BETTER_AUTH_SECRET'];
  if (!secret) {
    throw new Error('BETTER_AUTH_SECRET is not set (required to sign the GitHub install state)');
  }
  return secret;
}

function sign(payloadB64: string): string {
  return createHmac('sha256', signingKey()).update(`${CONTEXT}.${payloadB64}`).digest('base64url');
}

export interface InstallState {
  workspaceId: string;
  userId: string;
  /** WHERE THE FLOW STARTED, so the setup handler can return the person there
   *  (MOTIR-4676). OPTIONAL, and it has to stay optional: an envelope minted
   *  before this field existed is still in somebody's browser, still verifies,
   *  and must decode to a state with no origin rather than to a rejection.
   *
   *  It is an ID from `GITHUB_RETURN_SURFACES`, never a path — see that module
   *  for why. It rides INSIDE the signature rather than beside it because the
   *  App install starts from a bare github.com URL where no cookie can be set,
   *  so this value takes the round trip and has to come back unforged. */
  origin?: GithubReturnSurfaceId;
}

/** Encode + sign a short-lived install-state token.
 *
 *  ⚠️ `o` is OMITTED when there is no origin rather than written as `null`, so
 *  a token minted with no origin is byte-identical to one minted before the
 *  field existed. That keeps the compatibility claim above testable with a
 *  fixture rather than with a promise. */
export function encodeInstallState(
  state: InstallState,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const payload: { w: string; u: string; exp: number; o?: GithubReturnSurfaceId } = {
    w: state.workspaceId,
    u: state.userId,
    exp: nowSeconds + TTL_SECONDS,
  };
  if (state.origin) payload.o = state.origin;
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${b64}.${sign(b64)}`;
}

/** Why a token did not decode. `expired` is separated from the rest because it
 *  is the one rejection that is NOT a sign anything is wrong: the person took
 *  longer than the TTL on GitHub's repository picker, and the remedy is to start
 *  again from Settings rather than to conclude the install failed (MOTIR-3755).
 *  Everything else — a truncated token, a bad signature, a payload of the wrong
 *  shape — is indistinguishable from tampering and stays one reason. */
export type InstallStateRejection = 'malformed' | 'expired';

export type InstallStateResult =
  | { ok: true; state: InstallState }
  | { ok: false; reason: InstallStateRejection };

/** Verify + decode an install-state token, reporting WHY it was rejected.
 *  Constant-time signature compare. The checks are unchanged — this only names
 *  the outcome the caller was previously handed as a bare `null`. */
export function decodeInstallStateResult(
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): InstallStateResult {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed' };
  const b64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = sign(b64);

  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'malformed' };

  let payload: { w?: unknown; u?: unknown; exp?: unknown; o?: unknown };
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as typeof payload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    typeof payload.w !== 'string' ||
    typeof payload.u !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  // Only a token that VERIFIED can be called expired — an unsigned payload
  // claiming a past `exp` must stay `malformed`, so the expiry banner (which
  // says nothing is broken) is never reachable from an unauthenticated string.
  if (payload.exp < nowSeconds) return { ok: false, reason: 'expired' };
  // The origin is NARROWED, not trusted. It arrived inside the signature, so it
  // is ours — but an id this build no longer registers (a surface that was
  // renamed or removed between minting and return) must decode to "no origin"
  // and fall back, never to a path this build cannot serve.
  const origin = parseReturnSurfaceId(typeof payload.o === 'string' ? payload.o : null);
  return {
    ok: true,
    state: { workspaceId: payload.w, userId: payload.u, ...(origin ? { origin } : {}) },
  };
}

/** Verify + decode an install-state token, or `null` when it is malformed,
 *  tampered (bad signature), or expired. */
export function decodeInstallState(
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): InstallState | null {
  const result = decodeInstallStateResult(token, nowSeconds);
  return result.ok ? result.state : null;
}
