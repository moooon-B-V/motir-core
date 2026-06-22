import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { billingService } from '@/lib/services/billingService';
import { mapBillingError } from '@/lib/billing/errorResponse';

// GET /api/organizations/[orgId]/billing — the org's billing status (Subtask
// 8.1.6): the two billed lines (Motir seats + Motir AI) + the price catalog the
// 8.1.7 settings panel renders. HTTP-only (CLAUDE.md § 4-layer): session-gate,
// call ONE billingService method, map typed errors. The service owns the cloud
// gate (MOTIR_CLOUD), the 6.10.4 org access gate (404 for a non-member), and the
// ADR §7 view permission (owner/admin), so the route trusts neither the orgId nor
// the actor for authorization.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { orgId } = await params;
  try {
    const status = await billingService.getBillingStatus({
      organizationId: orgId,
      actorUserId: session.user.id,
    });
    return NextResponse.json(status);
  } catch (err) {
    const mapped = mapBillingError(err);
    if (mapped) return mapped;
    throw err;
  }
}
