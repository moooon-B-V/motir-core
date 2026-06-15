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

const DEFAULT_TTL_SECONDS = 15 * 60; // expires with the job (contract §4b)

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

// Verify signature + expiry. Returns the claims, or null when the token is
// malformed, the signature doesn't match (constant-time), or it has expired.
// (Consumed by the 7.1.6 read-back route; lives here so mint+verify stay one
// module.)
export function verifyJobToken(token: string): JobTokenClaims | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  const expected = sign(payloadB64);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let claims: JobTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as JobTokenClaims;
  } catch {
    return null;
  }
  if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}
