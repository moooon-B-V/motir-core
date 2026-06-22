import { NextResponse } from 'next/server';
import { OrganizationNotFoundError } from '@/lib/organizations/errors';
import { MotirAiError, MotirAiJobNotFoundError } from '@/lib/ai/errors';
import {
  BillingForbiddenError,
  BillingNotAvailableError,
  EntitlementExceededError,
  UnknownBillingPriceError,
} from '@/lib/billing/errors';

// Typed-error → HTTP-status mapper for the org-facing billing routes (Story
// 8.1.6), mirroring lib/organizations/errorResponse.ts. The route layer is
// HTTP-only (CLAUDE.md § 4-layer): it calls one billingService method, then hands
// any thrown error here. Returns a NextResponse for a known error, or null so the
// route rethrows (a genuine 500 the platform logs).
//
// The cross-tenant posture (the no-leak rule): a non-member of the org gets
// OrganizationNotFoundError → 404 (indistinguishable from a non-existent org); a
// member lacking the billing role gets BillingForbiddenError → 403 (the org IS
// visible to them). Off-cloud, the surface doesn't exist → 404. A motir-ai outage
// → 502 (the billing figures are temporarily unavailable; the subscription + the
// org's credits are safe — the design's "couldn't load billing" state), EXCEPT a
// boundary not-found (the org has no Stripe customer yet) → 404 (the empty state).
export function mapBillingError(err: unknown): NextResponse | null {
  if (err instanceof BillingNotAvailableError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof BillingForbiddenError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (err instanceof UnknownBillingPriceError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
  }
  if (err instanceof EntitlementExceededError) {
    // §4 cap hit (8.1.11) → 402 Payment Required + the upgrade-prompt payload
    // (the `entitlement` kind + limit/usage the UI keys its prompt off).
    return NextResponse.json(
      { code: err.code, error: err.message, entitlement: err.entitlement, detail: err.detail },
      { status: 402 },
    );
  }
  if (err instanceof OrganizationNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof MotirAiJobNotFoundError) {
    // The org has no Stripe customer yet (portal with nothing to open) — the
    // first-run empty state, not a boundary outage.
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof MotirAiError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
  }
  return null;
}
