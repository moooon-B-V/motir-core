import { NextResponse } from 'next/server';
import type { OrganizationRole } from '@prisma/client';
import { getSession } from '@/lib/auth';
import { organizationsService } from '@/lib/services/organizationsService';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { mapOrgError } from '@/lib/organizations/errorResponse';

// /api/organizations/[orgId]/members/[userId] (Story 6.10.5) — per-member
// org-role change + removal. Thin HTTP layer over organizationsService
// (CLAUDE.md § 4-layer): session-gated (401), one service call; the service
// owns the org-admin gate, the last-owner guard, and the transaction.

function isOrganizationRole(value: unknown): value is OrganizationRole {
  return (
    value === ORGANIZATION_ROLE.owner ||
    value === ORGANIZATION_ROLE.admin ||
    value === ORGANIZATION_ROLE.member
  );
}

// PATCH — change a member's org role. Body: { role }. Org owner/admin only;
// demoting the last owner is refused (409 LAST_ORG_OWNER).
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ orgId: string; userId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  const { orgId, userId } = await params;

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
  const { role } = (body ?? {}) as Record<string, unknown>;
  if (!isOrganizationRole(role)) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`role` must be owner, admin, or member.' },
      { status: 400 },
    );
  }

  try {
    await organizationsService.changeMemberRole({
      organizationId: orgId,
      userId,
      role,
      actorUserId: session.user.id,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const mapped = mapOrgError(err);
    if (mapped) return mapped;
    throw err;
  }
}

// DELETE — remove a member from the org. Org owner/admin (or self-leave);
// removing the last owner is refused (409 LAST_ORG_OWNER).
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ orgId: string; userId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  const { orgId, userId } = await params;

  try {
    await organizationsService.removeMember({
      organizationId: orgId,
      userId,
      actorUserId: session.user.id,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const mapped = mapOrgError(err);
    if (mapped) return mapped;
    throw err;
  }
}
