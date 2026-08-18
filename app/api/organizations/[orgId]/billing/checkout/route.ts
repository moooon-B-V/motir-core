import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { billingService } from '@/lib/services/billingService';
import { mapBillingError } from '@/lib/billing/errorResponse';

// POST /api/organizations/[orgId]/billing/checkout — start a Stripe Checkout
// Session for a selected catalog price, returning `{ url }` to redirect to
// (Subtask 8.1.6). HTTP-only: session-gate, parse the priceLookupKey + the
// optional quantity, call ONE billingService method, map typed errors. The
// service owns the cloud gate, the OWNER-ONLY mutation gate (ADR §7), the catalog
// allow-list check AND the which-prices-may-be-multiplied check; the Stripe
// secret never reaches motir-core (the open-core invariant).
//
// The route's own `quantity` check is a SHAPE check only — a positive integer —
// deliberately the same 400 shape the missing-priceLookupKey branch returns. What
// the catalog actually sells at that price is the service's call (MOTIR-2949).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { orgId } = await params;

  let priceLookupKey: unknown;
  let rawQuantity: unknown;
  try {
    const body: unknown = await req.json();
    priceLookupKey = (body as { priceLookupKey?: unknown })?.priceLookupKey;
    rawQuantity = (body as { quantity?: unknown })?.quantity;
  } catch {
    priceLookupKey = undefined;
    rawQuantity = undefined;
  }
  if (typeof priceLookupKey !== 'string' || !priceLookupKey) {
    return NextResponse.json(
      { code: 'INVALID_REQUEST', error: 'priceLookupKey is required' },
      { status: 400 },
    );
  }
  // Absent or null → let the service apply its default; present → it must be a
  // whole unit count, never a fraction and never zero/negative.
  const quantityGiven = rawQuantity !== undefined && rawQuantity !== null;
  if (
    quantityGiven &&
    (typeof rawQuantity !== 'number' || !Number.isInteger(rawQuantity) || rawQuantity < 1)
  ) {
    return NextResponse.json(
      { code: 'INVALID_REQUEST', error: 'quantity must be an integer >= 1 when present' },
      { status: 400 },
    );
  }

  try {
    const sessionUrl = await billingService.startCheckout({
      organizationId: orgId,
      actorUserId: session.user.id,
      priceLookupKey,
      ...(quantityGiven ? { quantity: rawQuantity as number } : {}),
    });
    return NextResponse.json(sessionUrl);
  } catch (err) {
    const mapped = mapBillingError(err);
    if (mapped) return mapped;
    throw err;
  }
}
