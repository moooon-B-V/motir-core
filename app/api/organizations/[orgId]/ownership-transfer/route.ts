import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { organizationsService } from '@/lib/services/organizationsService';
import { mapOrgError } from '@/lib/organizations/errorResponse';

// POST /api/organizations/[orgId]/ownership-transfer (Story MOTIR-6167 · Subtask
// MOTIR-6310) — the Owner hands the organization to another member. Thin HTTP
// layer over organizationsService.transferOwnership (CLAUDE.md § 4-layer):
// session-gated (401), the body parsed here, one service call. The service owns
// the Owner-only gate, the typed confirmation check, the row locks and the
// notification.
//
// Body: { toUserId, confirmName }. Responses: 200 { ok: true }; 400 a malformed
// body or a `confirmName` that is not the organization's name; 403 an Admin or
// Member; 404 a non-member; 409 OWNERSHIP_CHANGED (a concurrent transfer won);
// 422 INVALID_OWNERSHIP_TARGET with `reason` `not_member` | `self`.
export async function POST(
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
      { status: 400 },
    );
  }
  const { toUserId, confirmName } = (body ?? {}) as Record<string, unknown>;
  if (typeof toUserId !== 'string' || toUserId.length === 0) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`toUserId` is required.' },
      { status: 400 },
    );
  }
  if (typeof confirmName !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`confirmName` is required.' },
      { status: 400 },
    );
  }

  try {
    await organizationsService.transferOwnership({
      organizationId: orgId,
      actorUserId: session.user.id,
      toUserId,
      confirmName,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const mapped = mapOrgError(err);
    if (mapped) return mapped;
    throw err;
  }
}
