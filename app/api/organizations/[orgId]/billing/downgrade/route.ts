import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { billingService } from '@/lib/services/billingService';
import { mapBillingError } from '@/lib/billing/errorResponse';
import { readPlanChangeBody } from '@/lib/billing/planChangeRequest';

// POST /api/organizations/[orgId]/billing/downgrade — schedule the org's AI plan down to
// `toPlanKey` for the end of the current period
// (Story MOTIR-8387 · MOTIR-8399). HTTP-only: session-gate, parse
// `toPlanKey`, call ONE billingService method, map typed errors. The service owns the
// cloud gate, the owner/admin gate and the catalog check; motir-ai owns every
// figure, and a refusal it answers comes back as BILLING_PLAN_CHANGE_REFUSED with
// the `reason` the dialog draws.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;

  const { orgId } = await params;
  const body = await readPlanChangeBody(req, { prorationDate: false });
  if (!body.ok) return body.response;

  try {
    const result = await billingService.scheduleDowngrade({
      organizationId: orgId,
      actorUserId: session.user.id,
      toPlanKey: body.toPlanKey,
    });
    return NextResponse.json(result);
  } catch (err) {
    const mapped = mapBillingError(err);
    if (mapped) return mapped;
    throw err;
  }
}
