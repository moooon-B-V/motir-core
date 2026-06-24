import { NextResponse } from 'next/server';
import {
  authenticateBillingServiceRequest,
  BillingServiceAuthError,
} from '@/lib/billing/serviceAuth';
import { parseSetAiIncludedSeatInput } from '@/lib/billing/aiIncludedSeat';
import { AiIncludedSeatValidationError } from '@/lib/billing/errors';
import { billingPropagationService } from '@/lib/services/billingPropagationService';
import { OrganizationNotFoundError } from '@/lib/organizations/errors';

// POST /api/internal/billing/ai-included-seat (Subtask 8.1.24) — the inbound
// motir-ai → motir-core propagation of whether the org holds a PAID Motir AI
// plan, which BUNDLES 1 Motir seat and so lifts the §4 caps (ADR §4, amended
// 2026-06-24 / 8.1.22). motir-ai's Stripe webhook (8.1.23) is the only caller,
// via its coreClient. DISTINCT from the scaled-tracker-state route: that carries
// a team's PURCHASED per-seat subscription; this carries the AI plan's single
// bundled seat, kept on its own column so the two never clobber (8.1.25 nets the
// included seat out of billable seats). Service-to-service ONLY (a shared service
// bearer); Stripe never enters motir-core.
//
// Idempotent: repeating the same body re-writes the same value (200 again). Thin
// transport per CLAUDE.md: authenticate, parse, ONE service call, map errors.
//
// Body: { organizationId, included: boolean }  (false clears the flag).
//
// Typed errors → status:
//   BillingServiceAuthError        → 401 (missing / wrong service bearer)
//   bad JSON / AiIncludedSeat…     → 400 (malformed body)
//   OrganizationNotFoundError      → 404 (unknown / unreachable org)
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
      { code: 'AI_INCLUDED_SEAT_INVALID', error: 'request body must be valid JSON' },
      { status: 400 },
    );
  }

  try {
    const input = parseSetAiIncludedSeatInput(body);
    const result = await billingPropagationService.setAiIncludedSeat(input);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AiIncludedSeatValidationError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    if (err instanceof OrganizationNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
