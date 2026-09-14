import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { organizationsService } from '@/lib/services/organizationsService';
import { mapOrgError } from '@/lib/organizations/errorResponse';

// /api/organizations/[orgId] (Story 6.10.5) — the org-settings transport. Thin
// HTTP layer over organizationsService (CLAUDE.md § 4-layer): session-gated
// (401), then exactly one service call; the service owns the org-admin gate
// (404 for a non-member — the no-leak rule — / 403 for a non-admin member) and
// the transaction. No db.* / no $transaction here.

// PATCH /api/organizations/[orgId] — rename the org. Body carries `name`, and it
// is required. Org owner/admin only (enforced in the service).
//
// ⚠️ THIS ROUTE USED TO TAKE `name` OR `acceptanceVideoEnabled` (the MOTIR-1630
// org-wide toggle) and require at least one. MOTIR-5172 retired the toggle arm:
// the switch is a PROJECT setting now, written by
// `PATCH /api/projects/[key]/approval-gates`. A body that carries only the old
// key is refused with the same `BAD_REQUEST` as an empty one rather than
// silently accepted — a caller still sending it is writing a flag nothing reads.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;
  const { orgId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      {
        status: 400,
      },
    );
  }
  const { name } = (body ?? {}) as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim()) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`name` is required.' },
      { status: 400 },
    );
  }

  try {
    const organization = await organizationsService.renameOrganization({
      organizationId: orgId,
      actorUserId: session.user.id,
      name,
    });
    return NextResponse.json({ organization });
  } catch (err) {
    const mapped = mapOrgError(err);
    if (mapped) return mapped;
    throw err;
  }
}
