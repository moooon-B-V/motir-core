import { timingSafeEqual } from 'node:crypto';

// Service-to-service auth for the inbound billing-propagation surface
// (/api/internal/billing/*, Story 8.1). motir-ai is the ONLY caller — it writes
// Stripe-derived subscription state across the open-core boundary. Unlike the
// /api/internal/ai/* read-back (which needs both a service bearer AND a
// user/project-scoped job token, because it acts AS a user — see lib/ai/jobAuth),
// a billing-state write is org-keyed and has NO acting user, so it authenticates
// with a single shared service bearer only.
//
// `Authorization: Bearer <MOTIR_AI_TO_CORE_SERVICE_TOKEN>` — the same secret is
// held by motir-ai's coreClient (8.1.4d). This is the only trust boundary; the
// body's organizationId is then RLS-scoped at the write (billingPropagationService
// binds app.organization_id to it). Service-to-service only; never a cookie
// session, never CORS-exposed.

export class BillingServiceAuthError extends Error {
  readonly code = 'service_unauthorized';
  readonly httpStatus = 401;
  constructor(detail: string) {
    super(detail);
    this.name = 'BillingServiceAuthError';
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Length check first: timingSafeEqual throws on unequal-length buffers. The
  // early return leaks only length, never content.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify the inbound request carries the shared service bearer. Throws
 * `BillingServiceAuthError` (401) on any failure. Fails CLOSED: an unset
 * `MOTIR_AI_TO_CORE_SERVICE_TOKEN` rejects every request (mirrors jobAuth's
 * unset-secret behaviour, so a misconfigured deploy can't accept unauthenticated
 * billing writes).
 */
export function authenticateBillingServiceRequest(req: Request): void {
  const expected = process.env['MOTIR_AI_TO_CORE_SERVICE_TOKEN'];
  const header = req.headers.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!expected || !bearer || !safeEqual(bearer, expected)) {
    throw new BillingServiceAuthError('A valid service bearer is required.');
  }
}
