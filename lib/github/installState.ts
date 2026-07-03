import { createHmac, timingSafeEqual } from 'node:crypto';

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
}

/** Encode + sign a short-lived install-state token. */
export function encodeInstallState(
  state: InstallState,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const payload = { w: state.workspaceId, u: state.userId, exp: nowSeconds + TTL_SECONDS };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${b64}.${sign(b64)}`;
}

/** Verify + decode an install-state token, or `null` when it is malformed,
 *  tampered (bad signature), or expired. Constant-time signature compare. */
export function decodeInstallState(
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): InstallState | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const b64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = sign(b64);

  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: { w?: unknown; u?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as typeof payload;
  } catch {
    return null;
  }
  if (
    typeof payload.w !== 'string' ||
    typeof payload.u !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return null;
  }
  if (payload.exp < nowSeconds) return null;
  return { workspaceId: payload.w, userId: payload.u };
}
