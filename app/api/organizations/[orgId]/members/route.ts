import { NextResponse } from 'next/server';
import type { OrganizationRole } from '@prisma/client';
import { getSession } from '@/lib/auth';
import { organizationsService } from '@/lib/services/organizationsService';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { mapOrgError } from '@/lib/organizations/errorResponse';

// /api/organizations/[orgId]/members (Story 6.10.5) — the cross-workspace
// roster transport. Thin HTTP layer over organizationsService (CLAUDE.md §
// 4-layer): session-gated (401), then one service call; the service owns the
// org-member / org-admin gate (404-not-403 cross-tenant) and the paging.

const ROSTER_MAX_LIMIT = 100;

function isOrganizationRole(value: unknown): value is OrganizationRole {
  return (
    value === ORGANIZATION_ROLE.owner ||
    value === ORGANIZATION_ROLE.admin ||
    value === ORGANIZATION_ROLE.member
  );
}

// GET — one paginated page of the org's members across its workspaces. Query:
// `cursor` (the membership id from a prior page's nextCursor) + `limit`. ANY
// org member may read the roster (the service's assertOrgMember gate). The
// at-scale rule (finding #57): a page at a time, never load-all.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  const { orgId } = await params;

  const url = new URL(req.url);
  const cursor = url.searchParams.get('cursor');
  const limitParam = url.searchParams.get('limit');
  const parsedLimit = limitParam === null ? undefined : Number.parseInt(limitParam, 10);
  const limit =
    parsedLimit !== undefined && Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), ROSTER_MAX_LIMIT)
      : undefined;

  try {
    const page = await organizationsService.listMembers({
      organizationId: orgId,
      actorUserId: session.user.id,
      cursor,
      limit,
    });
    return NextResponse.json(page);
  } catch (err) {
    const mapped = mapOrgError(err);
    if (mapped) return mapped;
    throw err;
  }
}

// POST — invite a member to the org by email. Body: { email, role }. Resolves
// an EXISTING Motir user (422 ORG_INVITEE_NOT_FOUND otherwise); org owner/admin
// only. Returns 201 on success.
export async function POST(
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
  const { email, role } = (body ?? {}) as Record<string, unknown>;
  if (typeof email !== 'string' || !email.trim()) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`email` is required.' },
      {
        status: 400,
      },
    );
  }
  if (!isOrganizationRole(role)) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`role` must be owner, admin, or member.' },
      { status: 400 },
    );
  }

  try {
    await organizationsService.addMemberByEmail({
      organizationId: orgId,
      email,
      role,
      actorUserId: session.user.id,
    });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    const mapped = mapOrgError(err);
    if (mapped) return mapped;
    throw err;
  }
}
