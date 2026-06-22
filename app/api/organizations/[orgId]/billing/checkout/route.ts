import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { billingService } from '@/lib/services/billingService';
import { mapBillingError } from '@/lib/billing/errorResponse';

// POST /api/organizations/[orgId]/billing/checkout — start a Stripe Checkout
// Session for a selected catalog price, returning `{ url }` to redirect to
// (Subtask 8.1.6). HTTP-only: session-gate, parse the priceLookupKey, call ONE
// billingService method, map typed errors. The service owns the cloud gate, the
// OWNER-ONLY mutation gate (ADR §7), and the catalog allow-list check; the Stripe
// secret never reaches motir-core (the open-core invariant).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { orgId } = await params;

  let priceLookupKey: unknown;
  try {
    const body: unknown = await req.json();
    priceLookupKey = (body as { priceLookupKey?: unknown })?.priceLookupKey;
  } catch {
    priceLookupKey = undefined;
  }
  if (typeof priceLookupKey !== 'string' || !priceLookupKey) {
    return NextResponse.json(
      { code: 'INVALID_REQUEST', error: 'priceLookupKey is required' },
      { status: 400 },
    );
  }

  try {
    const sessionUrl = await billingService.startCheckout({
      organizationId: orgId,
      actorUserId: session.user.id,
      priceLookupKey,
    });
    return NextResponse.json(sessionUrl);
  } catch (err) {
    const mapped = mapBillingError(err);
    if (mapped) return mapped;
    throw err;
  }
}
