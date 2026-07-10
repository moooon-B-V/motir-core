import { createHmac, timingSafeEqual } from 'node:crypto';

// Signed, self-contained state carried through the GitLab OAuth connect round-trip
// (Story 7.23 · MOTIR-1474). GitLab echoes back whatever `state` the authorize URL
// carried, so the state is self-verifying: a base64url JSON payload
// `{ w: workspaceId, u: userId, n: nonce, exp }` + an HMAC-SHA256 signature.
//
// Unlike the GitHub App INSTALL (which starts from a bare github.com URL and can
// set no cookie — MOTIR-1588), the GitLab connect starts from a Motir request, so
// the `n` nonce is ALSO stashed in an httpOnly cookie and re-checked at the
// callback (the double-submit CSRF check the GitHub identity flow uses). The
// signed `w`/`u` carry the target workspace + acting user so the callback binds the
// connection to the SAME workspace the connect started from, and the setup handler
// re-checks the acting session user == `u` — the state is a binding HINT bound to a
// browser + user, not an authorization by itself.
//
// Keyed by `BETTER_AUTH_SECRET` (always configured — the app can't run without it)
// with a domain-separation context, and short-lived (10 min) so a leaked connect
// link can't be replayed later. Mirrors `lib/github/installState.ts`.

const CONTEXT = 'gitlab-oauth-state.v1';
const TTL_SECONDS = 600;

function signingKey(): string {
  const secret = process.env['BETTER_AUTH_SECRET'];
  if (!secret) {
    throw new Error('BETTER_AUTH_SECRET is not set (required to sign the GitLab OAuth state)');
  }
  return secret;
}

function sign(payloadB64: string): string {
  return createHmac('sha256', signingKey()).update(`${CONTEXT}.${payloadB64}`).digest('base64url');
}

export interface GitlabOAuthState {
  workspaceId: string;
  userId: string;
  nonce: string;
}

/** Encode + sign a short-lived GitLab OAuth-state token. */
export function encodeOAuthState(
  state: GitlabOAuthState,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const payload = {
    w: state.workspaceId,
    u: state.userId,
    n: state.nonce,
    exp: nowSeconds + TTL_SECONDS,
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${b64}.${sign(b64)}`;
}

/** Verify + decode a GitLab OAuth-state token, or `null` when it is malformed,
 *  tampered (bad signature), or expired. Constant-time signature compare. */
export function decodeOAuthState(
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): GitlabOAuthState | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const b64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = sign(b64);

  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: { w?: unknown; u?: unknown; n?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as typeof payload;
  } catch {
    return null;
  }
  if (
    typeof payload.w !== 'string' ||
    typeof payload.u !== 'string' ||
    typeof payload.n !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return null;
  }
  if (payload.exp < nowSeconds) return null;
  return { workspaceId: payload.w, userId: payload.u, nonce: payload.n };
}
