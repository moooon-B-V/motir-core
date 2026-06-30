import { timingSafeEqual } from 'node:crypto';

// The §4a SERVICE bearer check, shared by the two ai→core service-auth paths:
//   * `authenticateJobRequest` (lib/ai/jobAuth.ts) — the per-job read-back
//     (bearer + job token), bound to ONE tenant for 15 minutes; and
//   * `authenticateServiceRequest` (lib/ai/serviceAuth.ts) — the tenant-LESS
//     service path that acts AS the Motir system principal (bearer only).
// Both answer the same first question — "is this really motir-ai?" — so the
// secret comparison lives in exactly one place (MOTIR-1451).
//
// Fails CLOSED: an unset `CORE_CALLBACK_SECRET` rejects every request, so a
// mis-provisioned environment can never silently accept an empty bearer.

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * True iff the request carries the valid `Authorization: Bearer
 * <CORE_CALLBACK_SECRET>` service bearer. Constant-time compare; fails closed
 * when the secret is unset or the bearer is missing/empty/wrong.
 */
export function verifyServiceBearer(req: Request): boolean {
  const expected = process.env['CORE_CALLBACK_SECRET'];
  const header = req.headers.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  return Boolean(expected) && Boolean(bearer) && safeEqual(bearer, expected as string);
}
