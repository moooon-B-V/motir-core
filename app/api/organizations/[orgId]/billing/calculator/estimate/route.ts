import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { billingService } from '@/lib/services/billingService';
import { mapBillingError } from '@/lib/billing/errorResponse';

// POST /api/organizations/[orgId]/billing/calculator/estimate — one Calculator
// estimate (MOTIR-8637 · MOTIR-9004 · MOTIR-9224). The body is `{ plannedPerMonth:
// { low, high }, runPerMonth: { low, high }, categories: [1-3 category keys], cadence? }`
// — no model is ever chosen; the replaced `itemsPerMonth` and `planning` / `running` /
// `modelIds` shapes are refused by name. The
// service gates the actor, parses it with the strict request schema and asks the
// engine. The answer is the engine's body unaltered — `kind: 'estimate'` or
// `kind: 'empty_category'`, both 200 — or a typed refusal: 400
// CALCULATOR_REQUEST_INVALID (naming the field), 503 CALCULATOR_UNAVAILABLE, 502 for the boundary.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;

  const { orgId } = await params;
  // A body that is not JSON reaches the schema as `undefined`, which refuses it.
  const body: unknown = await req.json().catch(() => undefined);
  try {
    const answer = await billingService.estimateCalculator({
      organizationId: orgId,
      actorUserId: session.user.id,
      body,
    });
    return NextResponse.json(answer, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const mapped = mapBillingError(err);
    if (mapped) return mapped;
    throw err;
  }
}
