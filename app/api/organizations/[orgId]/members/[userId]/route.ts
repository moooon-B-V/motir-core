import { NextResponse } from 'next/server';
import type { OrganizationRole } from '@/generated/prisma/client';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { organizationsService } from '@/lib/services/organizationsService';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { mapOrgError } from '@/lib/organizations/errorResponse';

// /api/organizations/[orgId]/members/[userId] (Story 6.10.5) — per-member
// org-role change + removal. Thin HTTP layer over organizationsService
// (CLAUDE.md § 4-layer): session-gated (401), one service call; the service
// owns the org-admin gate, the Owner lock, and the transaction.

// A role this route may ASSIGN: Admin or Member. `owner` is not assignable —
// ownership moves only by the Owner's transfer (MOTIR-6307) — so it is refused
// here at validation (400) before the service is asked.
function isAssignableOrgRole(value: unknown): value is OrganizationRole {
  return value === ORGANIZATION_ROLE.admin || value === ORGANIZATION_ROLE.member;
}

// PATCH — change a member's org role between Admin and Member. Body: { role }.
// Owner/Admin only; changing the Owner's own row is refused (409
// ORG_OWNER_MEMBERSHIP_LOCKED).
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ orgId: string; userId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;
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
  if (!isAssignableOrgRole(role)) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`role` must be admin or member.' },
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
// removing the Owner is refused, the Owner leaving included (409
// ORG_OWNER_MEMBERSHIP_LOCKED).
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ orgId: string; userId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;
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
