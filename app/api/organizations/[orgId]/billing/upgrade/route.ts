import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { billingService } from '@/lib/services/billingService';
import { mapBillingError } from '@/lib/billing/errorResponse';
import { readPlanChangeBody } from '@/lib/billing/planChangeRequest';

// POST /api/organizations/[orgId]/billing/upgrade — upgrade the org's AI plan to `toPlanKey`
// now, at the `prorationDate` the preview returned
// (Story MOTIR-8387 · MOTIR-8399). HTTP-only: session-gate, parse
// `toPlanKey` and `prorationDate`, call ONE billingService method, map typed errors. The service owns the
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
  const body = await readPlanChangeBody(req, { prorationDate: true });
  if (!body.ok) return body.response;

  try {
    const result = await billingService.upgradePlan({
      organizationId: orgId,
      actorUserId: session.user.id,
      toPlanKey: body.toPlanKey,
      prorationDate: body.prorationDate as number,
    });
    return NextResponse.json(result);
  } catch (err) {
    const mapped = mapBillingError(err);
    if (mapped) return mapped;
    throw err;
  }
}
