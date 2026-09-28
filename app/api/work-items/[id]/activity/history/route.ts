import { NextResponse } from 'next/server';
import { memberThenVisitor } from '@/lib/visitor/readActor';
import type { VisitorReadContext } from '@/lib/visitor/context';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { activityService } from '@/lib/services/activityService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { workItemGateErrorResponse } from '@/lib/workItems/gateResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET /api/work-items/[id]/activity/history (Story 5.5 · Subtask 5.5.1) —
// one page of the issue's History feed: displayable `work_item_revision`
// entries rendered to typed parts, `?cursor=` continuation + `?order=asc|desc`
// (default desc — newest first). READ-ONLY surface: the revision trail is
// append-only (the verified Jira rule), so this route tree deliberately
// exposes no POST / PATCH / DELETE — and must never grow one. Thin HTTP layer
// over `activityService.listHistory`; no db / no transaction here (CLAUDE.md).
// The sibling `all` route (Subtask 5.5.2) adds the merged comments+history
// stream beside this one.
//
// Typed errors → status codes:
//   WorkItemNotFoundError → 404 (unknown / cross-workspace item, no existence leak)
//   malformed ?order      → 400
/** The read itself, for a member's context or a Visitor's (MOTIR-6647). */
async function serve(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
  ctx: ServiceContext | VisitorReadContext,
): Promise<Response> {
  const { id } = await params;
  const url = new URL(req.url);
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const orderParam = url.searchParams.get('order');
  if (orderParam !== null && orderParam !== 'asc' && orderParam !== 'desc') {
    return NextResponse.json({ code: 'INVALID_ORDER' }, { status: 400 });
  }

  try {
    const page = await activityService.listHistory(
      id,
      { cursor, order: orderParam ?? undefined },
      ctx,
    );
    return NextResponse.json(page);
  } catch (err) {
    const gate = workItemGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof WorkItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}

async function memberGET(
  req: Request,
  route: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  return serve(req, route, ctx);
}

/**
 * A work item's history — members exactly as before; a VISITOR (MOTIR-6647) of the
 * item's public project reads it through the Visitor path (MOTIR-6652), only when
 * the member read found nothing for them.
 */
export async function GET(
  req: Request,
  route: { params: Promise<{ id: string }> },
): Promise<Response> {
  return memberThenVisitor(
    req,
    () => memberGET(req, route),
    (ctx) => serve(req, route, ctx),
  );
}
