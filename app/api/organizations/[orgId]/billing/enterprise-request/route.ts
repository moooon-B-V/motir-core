import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { enterpriseRequestService } from '@/lib/services/enterpriseRequestService';
import { mapBillingError } from '@/lib/billing/errorResponse';

// /api/organizations/[orgId]/billing/enterprise-request — the Enterprise card's
// Contact sales (Story MOTIR-7602 · Subtask MOTIR-7605). HTTP-only: session-gate,
// parse the body, call ONE enterpriseRequestService method, map typed errors.
// The service owns the cloud gate (404 off-cloud), the `manageBilling` gate, the
// body's validation and the one-open-request-per-org refusal (409).

type Ctx = { params: Promise<{ orgId: string }> };

/** POST — send the org's Enterprise request. 201 with the request as the org sees it. */
export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;
  const { orgId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = undefined;
  }

  try {
    const request = await enterpriseRequestService.create(
      { userId: session.user.id, email: session.user.email },
      orgId,
      body,
    );
    return NextResponse.json(request, { status: 201 });
  } catch (err) {
    const mapped = mapBillingError(err);
    if (mapped) return mapped;
    throw err;
  }
}

/** GET — the org's open request, or `null` when none is open. */
export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;
  const { orgId } = await params;

  try {
    const request = await enterpriseRequestService.getOpen(
      { userId: session.user.id, email: session.user.email },
      orgId,
    );
    return NextResponse.json(request);
  } catch (err) {
    const mapped = mapBillingError(err);
    if (mapped) return mapped;
    throw err;
  }
}
