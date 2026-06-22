import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { billingService } from '@/lib/services/billingService';
import { mapBillingError } from '@/lib/billing/errorResponse';

// POST /api/organizations/[orgId]/billing/portal — open a Stripe Billing Portal
// session, returning `{ url }` (Subtask 8.1.6). The portal session is short-lived
// (~5 min), so the client redirects immediately. HTTP-only: session-gate, call
// ONE billingService method, map typed errors. The service owns the cloud gate +
// the OWNER-ONLY mutation gate (ADR §7); a 404 means the org has no Stripe
// customer yet (open the storefront, not the portal).
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { orgId } = await params;
  try {
    const sessionUrl = await billingService.openPortal({
      organizationId: orgId,
      actorUserId: session.user.id,
    });
    return NextResponse.json(sessionUrl);
  } catch (err) {
    const mapped = mapBillingError(err);
    if (mapped) return mapped;
    throw err;
  }
}
