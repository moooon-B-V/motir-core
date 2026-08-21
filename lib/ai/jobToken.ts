import { createHmac, timingSafeEqual } from 'node:crypto';

// The job-scoped read-back token (boundary contract §4b). motir-core mints it
// at job submit and embeds it in the request envelope; motir-ai presents it on
// every /api/internal/ai/* read-back (7.1.6), where motir-core verifies it and
// runs the read AS the encoded user — so the AI can read/propose only what the
// requesting user could, and only for the job's lifetime.
//
// Signed HMAC-SHA256 over a base64url JSON payload, keyed by BETTER_AUTH_SECRET
// — core's existing stateless-token signing secret (the SAME pattern as
// lib/savedFilters/subscriptionToken.ts; no new env key). Format
// `<payload-b64url>.<sig-b64url>`, verified in constant time.
//
// NOTE (refines contract §4b): the token does NOT encode a jobId. motir-ai
// mints the jobId at submit (it's in the 202 response), so it isn't known when
// core mints the token a moment earlier. The token scopes the read-back to
// user + workspace + project + a short TTL, which is the permission-critical
// part; the contract card for 7.1.5 specifies exactly "user + project + a short
// TTL".

// ⚠️ THIS IS A LIFETIME FOR ONE STRETCH OF WORK, NOT FOR A WHOLE JOB
// (MOTIR-3288). The comment here used to read "expires with the job", and that
// assumption was false in both directions: a planning turn can legitimately run
// longer than this (one measured at 19 minutes), and a job can sit QUEUED for
// longer than this before it starts, burning the whole window on somebody
// else's work. Either way the job did its LLM work, was billed for it, and then
// failed at the write-back with `token_invalid`.
//
// The number is deliberately NOT raised — a short blast radius for a leaked
// token is what it is for. Instead the holder RENEWS it while the work runs,
// the same answer MOTIR-3221 reached for the job's lease, via
// {@link refreshJobToken} and `POST /api/internal/ai/job-token/refresh`.
const DEFAULT_TTL_SECONDS = 15 * 60;

export interface JobTokenClaims {
  sub: string; // the requesting user id
  workspaceId: string;
  projectId: string;
  iat: number; // issued-at (epoch seconds)
  exp: number; // expiry (epoch seconds)
}

export interface MintJobTokenInput {
  userId: string;
  workspaceId: string;
  projectId: string;
  ttlSeconds?: number;
}

function secret(): string {
  const value = process.env['BETTER_AUTH_SECRET'];
  if (!value) {
    throw new Error('BETTER_AUTH_SECRET is not set — cannot sign job-scoped read-back tokens.');
  }
  return value;
}

function sign(payloadB64: string): string {
  return createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

export function mintJobToken(input: MintJobTokenInput): string {
  const iat = Math.floor(Date.now() / 1000);
  const claims: JobTokenClaims = {
    sub: input.userId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    iat,
    exp: iat + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };
  const payloadB64 = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Why a token was refused, so the caller can SAY so (MOTIR-3288).
 *
 * `verifyJobToken` collapses every failure to `null`, which is right for an
 * access decision and wrong for the message that follows it: an EXPIRED token
 * and a FORGED one are the same answer to "may this proceed?" and completely
 * different answers to "what went wrong?". Conflating them is what put
 * `token_invalid` — which reads as a configuration fault — in front of an
 * operator whose actual problem was that a job ran for nineteen minutes.
 */
export type JobTokenVerdict =
  | { ok: true; claims: JobTokenClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' }
  | { ok: false; reason: 'expired'; claims: JobTokenClaims; expiredAt: number };

/** Verify signature + expiry, and say WHICH failed. */
export function inspectJobToken(token: string): JobTokenVerdict {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed' };
  const payloadB64 = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  const expected = sign(payloadB64);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    return { ok: false, reason: 'bad_signature' };

  let claims: JobTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as JobTokenClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof claims.exp !== 'number') return { ok: false, reason: 'malformed' };
  // ⚠️ The expiry check happens AFTER the signature check, and must stay there:
  // `expiredAt` is only meaningful once the payload is known to be ours.
  if (claims.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'expired', claims, expiredAt: claims.exp };
  }
  return { ok: true, claims };
}

/**
 * Mint a fresh token carrying the SAME identity for another full window.
 *
 * The renewal half of MOTIR-3288, mirroring the lease renewal MOTIR-3221 built:
 * the credential's lifetime tracks the work instead of the wall clock at
 * submit. It re-derives every claim from the presented token, so a refresh can
 * never widen scope — same user, same workspace, same project, new window.
 *
 * ⚠️ The CALLER must have verified the token first. This function does not
 * check expiry, deliberately: it is the route's job to refuse an expired
 * token, and hiding that decision in here would make it impossible to see that
 * an expired token cannot be revived.
 */
export function refreshJobToken(claims: JobTokenClaims, ttlSeconds?: number): string {
  return mintJobToken({
    userId: claims.sub,
    workspaceId: claims.workspaceId,
    projectId: claims.projectId,
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
  });
}

// Verify signature + expiry. Returns the claims, or null when the token is
// malformed, the signature doesn't match (constant-time), or it has expired.
// Thin wrapper over {@link inspectJobToken} — kept because an access decision
// wants a boolean-ish answer and should not have to destructure a verdict.
export function verifyJobToken(token: string): JobTokenClaims | null {
  const verdict = inspectJobToken(token);
  return verdict.ok ? verdict.claims : null;
}
