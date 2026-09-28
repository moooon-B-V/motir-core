import { NextResponse } from 'next/server';
import { memberThenVisitor } from '@/lib/visitor/readActor';
import type { VisitorReadContext } from '@/lib/visitor/context';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { estimationService } from '@/lib/services/estimationService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { workItemGateErrorResponse } from '@/lib/workItems/gateResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET /api/work-items/[id]/rollup (Story 4.3 · Subtask 4.3.5) — the BOUNDED
// epic/parent subtree roll-up (`{ total }`) the list/tree parent row binds to
// (the issue-detail header computes the same figure server-side). Thin HTTP
// layer over `estimationService.rollupForParent`; the parent id is the path
// param, the workspace + actor come from the session context. The aggregate is
// statistic-aware and a single recursive-CTE SUM over the descendants — never a
// load-the-subtree + client sum (finding #57). No db / no transaction here
// (CLAUDE.md); a read open to any project member.
//
// Typed errors → status codes:
//   WorkItemNotFoundError → 404 (unknown / cross-workspace parent, no existence leak)
/** The read itself, for a member's context or a Visitor's (MOTIR-6647). */
async function serve(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
  ctx: ServiceContext | VisitorReadContext,
): Promise<Response> {
  const { id } = await params;

  try {
    const rollup = await estimationService.rollupForParent(id, ctx);
    return NextResponse.json(rollup);
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
 * A container's rollup — members exactly as before; a VISITOR (MOTIR-6647) of the
 * item's public project gets the rollup over VISIBLE descendants only
 * (MOTIR-6652), only when the member read found nothing for them.
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
