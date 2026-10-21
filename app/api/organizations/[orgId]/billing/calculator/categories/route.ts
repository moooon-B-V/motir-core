import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { billingService } from '@/lib/services/billingService';
import { mapBillingError } from '@/lib/billing/errorResponse';

// GET /api/organizations/[orgId]/billing/calculator/categories — the Calculator's
// pickers (MOTIR-8637): the engine's model categories, answered unaltered. HTTP
// only (CLAUDE.md § 4-layer): session gate, ONE billingService call, typed-error
// mapping. The service owns the billing page's own view gate. `no-store`, as the
// engine's own route answers: the model list is live, and nothing here may hold
// it longer than the engine does.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;

  const { orgId } = await params;
  try {
    const categories = await billingService.getCalculatorCategories({
      organizationId: orgId,
      actorUserId: session.user.id,
    });
    return NextResponse.json(categories, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const mapped = mapBillingError(err);
    if (mapped) return mapped;
    throw err;
  }
}
