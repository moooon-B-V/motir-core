import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { organizationsService } from '@/lib/services/organizationsService';
import { mapOrgError } from '@/lib/organizations/errorResponse';

// /api/organizations/[orgId] (Story 6.10.5) — the org-settings transport. Thin
// HTTP layer over organizationsService (CLAUDE.md § 4-layer): session-gated
// (401), then exactly one service call; the service owns the org-admin gate
// (404 for a non-member — the no-leak rule — / 403 for a non-admin member) and
// the transaction. No db.* / no $transaction here.

// PATCH /api/organizations/[orgId] — rename the organization. Body: { name }.
// Org owner/admin only (enforced in the service).
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
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
