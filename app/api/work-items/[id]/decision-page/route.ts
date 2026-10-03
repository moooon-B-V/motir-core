import { NextResponse } from 'next/server';
import { decisionPageService } from '@/lib/services/decisionPageService';
import { resolveWorkItemByIdentifier } from '@/lib/publishAuth/ciPublishAuth';
import { DecisionPageError } from '@/lib/decisionPages/errors';
import { workItemGateErrorResponse } from '@/lib/workItems/gateResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// POST /api/work-items/[id]/decision-page (Story MOTIR-5761 · MOTIR-7434) —
// publish a page as a `decision` card's decision: the confirm port's *Choose
// page* calls it, as the `publish_decision_page` MCP tool does for an agent.
// Thin HTTP layer (CLAUDE.md § 4-layer): session → parse → one service call.
//
// SESSION-AUTHED: a publication names the person who made it. The `work_item:edit`
// (card) and `page:view` (page) checks are the service's. The segment is the
// card's KEY, resolved the way the design-evidence route beside this one does, so
// a hidden / cross-workspace / missing card reads 404 (finding #44).
//
// JSON body: `pageId` (required). The service's named refusals keep their own
// status: 404 PAGE_NOT_FOUND, 409 PAGE_ARCHIVED / CARD_IS_FINISHED, 422 for the
// rest. Publishing the version that is already the decision is a replay: 200
// with `replayed: true`, against 201 for a new publication.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { id } = await params;
  const item = await resolveWorkItemByIdentifier(id.trim().toUpperCase(), ctx);
  if (item instanceof Response) return item;

  let pageId: string | null = null;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    pageId =
      typeof body?.pageId === 'string' && body.pageId.trim() !== '' ? body.pageId.trim() : null;
  } catch {
    // Falls through to the 400 below.
  }
  if (!pageId) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body with a `pageId`.' },
      { status: 400 },
    );
  }

  try {
    const publication = await decisionPageService.publish({ workItemId: item.id, pageId }, ctx);
    return NextResponse.json({ publication }, { status: publication.replayed ? 200 : 201 });
  } catch (err) {
    const gateError = workItemGateErrorResponse(err);
    if (gateError) return gateError;
    if (err instanceof DecisionPageError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.status });
    }
    throw err;
  }
}
