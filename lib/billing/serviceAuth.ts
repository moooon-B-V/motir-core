import { authenticateServiceRequest, ServiceAuthError } from '@/lib/internalApi/serviceAuth';

// Service-to-service auth for the inbound billing-propagation surface
// (/api/internal/billing/*, Story 8.1). motir-ai writes Stripe-derived
// subscription state across the open-core boundary; a billing-state write is
// org-keyed and has NO acting user, so it authenticates with a single shared
// service bearer only.
//
// ⚠️ THE IMPLEMENTATION MOVED (MOTIR-2197), the contract did not. The same gate
// now also fronts the live-project read that motir-ai's offboarding backstop
// calls, so it lives in `lib/internalApi/serviceAuth` — one implementation, so a
// hardening fix lands once instead of drifting between two copies. These names
// stay because Story 8.1's callers and its tests are written against them, and
// renaming a security boundary to tidy an import is churn with a downside.
//
// Unlike the /api/internal/ai/* read-back (which needs both a service bearer AND
// a user/project-scoped job token, because it acts AS a user — see lib/ai/jobAuth),
// nothing authenticated here is tenant-scoped by its credential; the body's
// identifiers are RLS-scoped at the write instead (billingPropagationService binds
// app.organization_id). Service-to-service only; never a cookie session, never
// CORS-exposed.

export { ServiceAuthError as BillingServiceAuthError };

/**
 * Verify the inbound request carries the shared service bearer. Throws
 * `BillingServiceAuthError` (401) on any failure. Fails CLOSED: an unset
 * `MOTIR_AI_TO_CORE_SERVICE_TOKEN` rejects every request (mirrors jobAuth's
 * unset-secret behaviour, so a misconfigured deploy can't accept unauthenticated
 * billing writes).
 */
export function authenticateBillingServiceRequest(req: Request): void {
  authenticateServiceRequest(req);
}
