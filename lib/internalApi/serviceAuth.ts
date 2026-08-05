import { timingSafeEqual } from 'node:crypto';

// SERVICE-TO-SERVICE AUTH for the inbound motir-ai → motir-core surface.
//
// `Authorization: Bearer <MOTIR_AI_TO_CORE_SERVICE_TOKEN>` — one shared secret,
// held by motir-ai's `coreClient`. This is the trust boundary for a call that has
// NO ACTING USER and is not scoped to one tenant.
//
// ⚠️ It is deliberately NOT the `/api/internal/ai/*` read-back gate. Those routes
// need a service bearer AND a user/project-scoped JOB TOKEN (`lib/ai/jobAuth`),
// because they act AS a user inside one planning run's tenant — which is exactly
// what makes them safe. A route authenticated here can see across tenants, so the
// choice between the two gates is a scope decision, not a convenience one:
// widening a job token to answer a cross-tenant question would loosen every route
// that accepts one.
//
// Fails CLOSED: an unset `MOTIR_AI_TO_CORE_SERVICE_TOKEN` rejects every request,
// so a misconfigured deploy cannot accept unauthenticated service calls.
//
// This lives in a neutral module because it now has two kinds of caller — the
// Story 8.1 billing-propagation writes (`lib/billing/serviceAuth` re-exports it
// under its own name for those) and the MOTIR-2197 live-project read. One
// implementation, so a hardening fix lands once.

export class ServiceAuthError extends Error {
  readonly code = 'service_unauthorized';
  readonly httpStatus = 401;
  constructor(detail: string) {
    super(detail);
    this.name = 'ServiceAuthError';
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
 * {@link ServiceAuthError} (401) on any failure.
 */
export function authenticateServiceRequest(req: Request): void {
  const expected = process.env['MOTIR_AI_TO_CORE_SERVICE_TOKEN'];
  const header = req.headers.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!expected || !bearer || !safeEqual(bearer, expected)) {
    throw new ServiceAuthError('A valid service bearer is required.');
  }
}
