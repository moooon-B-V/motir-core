import { NextResponse } from 'next/server';
import {
  authenticateBillingServiceRequest,
  BillingServiceAuthError,
} from '@/lib/billing/serviceAuth';
import { parseSetScaledTrackerStateInput } from '@/lib/billing/scaledTrackerState';
import { ScaledTrackerStateValidationError } from '@/lib/billing/errors';
import { billingPropagationService } from '@/lib/services/billingPropagationService';
import { OrganizationNotFoundError } from '@/lib/organizations/errors';

// POST /api/internal/billing/scaled-tracker-state (Subtask 8.1.4c) — the inbound
// motir-ai → motir-core propagation of a scaled-tracker subscription's state
// onto the billing-root Organization. motir-ai's Stripe webhook (8.1.4b) is the
// only caller, via its coreClient (8.1.4d). Service-to-service ONLY: a single
// shared service bearer (`MOTIR_AI_TO_CORE_SERVICE_TOKEN`); never a cookie
// session. Stripe never enters motir-core — this carries plain propagated state.
//
// Idempotent: repeating the same body re-writes the same value (200 again). Thin
// transport per CLAUDE.md: authenticate, parse, ONE service call, map errors.
//
// Body: { organizationId, scaledTrackerSubscription: {...} | null }  (null clears).
//
// Typed errors → status:
//   BillingServiceAuthError           → 401 (missing / wrong service bearer)
//   bad JSON / ScaledTrackerState…    → 400 (malformed body)
//   OrganizationNotFoundError         → 404 (unknown / unreachable org)
export async function POST(req: Request): Promise<Response> {
  try {
    authenticateBillingServiceRequest(req);
  } catch (err) {
    if (err instanceof BillingServiceAuthError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'SCALED_TRACKER_STATE_INVALID', error: 'request body must be valid JSON' },
      { status: 400 },
    );
  }

  try {
    const input = parseSetScaledTrackerStateInput(body);
    const result = await billingPropagationService.setScaledTrackerState(input);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ScaledTrackerStateValidationError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    if (err instanceof OrganizationNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
