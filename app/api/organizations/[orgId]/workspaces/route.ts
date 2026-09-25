import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { workspacesService } from '@/lib/services/workspacesService';
import { mapOrgError } from '@/lib/organizations/errorResponse';

// /api/organizations/[orgId]/workspaces (MOTIR-6309) — the org Workspaces
// section's list. Thin HTTP layer over workspacesService (CLAUDE.md § 4-layer):
// session-gated (401), then one service call; the service owns the org-Admin
// gate (`manageWorkspaces` — 404 for a non-member, 403 for a Member) and the
// paging.

const MAX_LIMIT = 100;

// GET — one keyset page of the org's workspaces with member and project counts.
// Query: `cursor` (a workspace id from a prior page's nextCursor) + `limit`. The
// at-scale rule: a page at a time, never load-all.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;
  const { orgId } = await params;

  const url = new URL(req.url);
  const cursor = url.searchParams.get('cursor');
  const limitParam = url.searchParams.get('limit');
  const parsedLimit = limitParam === null ? undefined : Number.parseInt(limitParam, 10);
  const limit =
    parsedLimit !== undefined && Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), MAX_LIMIT)
      : undefined;

  try {
    const page = await workspacesService.listOrganizationWorkspaces({
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
