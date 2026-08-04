import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withV1Route } from '@/lib/api/v1/route';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import {
  encodeWorkItemETag,
  parseV1Body,
  presentTransitionTargets,
  presentWorkItemDetail,
} from '@/lib/api/v1/workItems/schema';
import { IllegalTransitionError } from '@/lib/workItems/errors';
import { commentsService } from '@/lib/services/commentsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';

// GET + POST /api/v1/work-items/{key}/transitions (Story 11.2 · Subtask 11.2.7
// — MOTIR-2048) — the legal-move list, and the move itself.
//
// ── Rung 1: the shape is Jira's, not invented ───────────────────────────────
// Jira exposes `GET /issue/{key}/transitions` ("what can I do from here?") and
// `POST /issue/{key}/transitions` ("do it"). A client that can ASK is not reduced
// to attempting a move and parsing the failure, and a UI built on this API can
// render exactly the buttons the workflow allows.
//
// ── Legality lives in the SERVICE, never here ───────────────────────────────
// `updateStatus` owns it (via `workflowsService.canTransition`), which is why the
// board, the MCP tool and this endpoint are governed by identical rules. This
// route decides nothing about what is legal; it only reports it.

const transitionBodySchema = z.object({ status: z.string().min(1) }).strict();

export const GET = withV1Route<{ key: string }>({ scope: 'read' }, async (ctx) => {
  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
  const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx.service);
  const workflow = await workflowsService.getWorkflow(projectId, ctx.workspaceId);

  // NOT the whole workflow graph: the question is "what can THIS item do now".
  // The full graph is a project resource, and 11.3's territory if it is ever
  // wanted.
  return NextResponse.json({ transitions: presentTransitionTargets(workflow, item.status) });
});

export const POST = withV1Route<{ key: string }>({ scope: 'work_items:write' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, transitionBodySchema);
  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
  const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx.service);

  try {
    await workItemsService.updateStatus(item.id, body.status, ctx.service);
  } catch (err) {
    // ⚠️ The refusal TEACHES: it carries the allowed targets as DATA, not as a
    // sentence to parse. Enriched here rather than in the shared wrapper
    // because the extra field is specific to THIS condition — the wrapper's
    // `{ code, error }` envelope stays the one shape every other failure has.
    //
    // The targets come from the SAME presenter `GET …/transitions` uses, so
    // the two surfaces cannot disagree about what is legal.
    if (err instanceof IllegalTransitionError) {
      const workflow = await workflowsService.getWorkflow(projectId, ctx.workspaceId);
      return NextResponse.json(
        {
          code: err.code,
          error: err.message,
          allowedTransitions: presentTransitionTargets(workflow, item.status),
        },
        { status: 422 },
      );
    }
    // `UNKNOWN_STATUS` (a key the project's workflow does not define at all)
    // stays a plain mapped 422 with its OWN code: collapsing it into
    // ILLEGAL_TRANSITION would make a typo and a workflow rule
    // indistinguishable, and a client can fix only one of those.
    throw err;
  }

  // Return the updated resource, so a client sees the new status without a
  // second read.
  const detail = await workItemsService.getIssueDetail(projectId, identifier, ctx.service);
  const counts = await commentsService.getCommentCountsForItems([detail.item.id], ctx.service);
  ctx.responseHeaders.set('ETag', encodeWorkItemETag(detail.item.updatedAt));
  return NextResponse.json(presentWorkItemDetail(detail, counts[detail.item.id] ?? 0));
});
