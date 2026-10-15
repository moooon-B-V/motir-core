import { RunStopReportInvalidError, UnknownDispatchRunCardError } from '@/lib/dispatchRuns/errors';
import {
  composeStopComment,
  RUN_STOP_COMMENT_MAX,
  RUN_STOP_FIELD_MAX,
  STOP_REQUIREMENT_FIELDS,
  type StopRequirement,
} from '@/lib/dispatchRuns/stopComment';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { assertRunTokenScope, dispatchRunService } from '@/lib/services/dispatchRunService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type { Prisma } from '@/generated/prisma/client';

// A RUN'S STOP REPORT (MOTIR-8722) — `POST /api/v1/dispatch-runs/{id}/stop`.
//
// The dispatch prompt's STOP branch tells the agent to comment its finding on the card and,
// when the run re-plans, to move the card to Planning and submit a re-plan — every one of
// them a Motir MCP call. A hosted run's agent and an agent-instance run's agent hold no Motir
// token (`AGENT_RUN_WITHHELD_ENV`) and `/api/mcp` refuses a run token, so none of those calls
// could land: the card stayed In Progress with nothing on it. Now the agent writes the
// finding (and its brief) into `$MOTIR_AGENT_REPORT` as `stop`, and the CLI posts it here
// with the run's own credential after the agent exits. This service:
//
//   1. resolves the card and refuses one that is not an OPEN leg of the named run — a run's
//      credential reaches its own cards only;
//   2. writes ONE comment carrying the finding (and, on a re-plan, the brief);
//   3. with `toPlanning`, moves the card to Planning IN THE SAME TRANSACTION as the comment
//      (`workItemsService.updateStatus`'s `inTransaction`), so a refused move writes no
//      comment and the CLI's warning is the whole story.
//
// ⚠️ IT DOES NOT SUBMIT THE RE-PLAN, and the comment says so. A run's credential holds no
// `ai:*` key by decision (`HOSTED_RUN_TOKEN_GRANT`: "a run token can neither author nor read
// a plan"), and submitting is the act that spends the owner's AI credits. Widening that grant
// is not this card's to decide (`run-found-trigger-dispatched-path.md` AMENDMENT 2), so the
// brief is kept on the card and a person submits it — the card at Planning is out of the
// pickable set either way.
//
// Permission: `work_item:edit` on the card's project, which `HOSTED_RUN_TOKEN_GRANT` holds.

export interface ReportStopInput {
  /** The card the agent stopped on, `KEY-<n>` — a leg of the run. */
  key: string;
  /** The agent's finding: what is false, and the evidence. */
  comment: string;
  /** Move the card to Planning — the run re-plans (`FindingsPolicy.replan`). */
  toPlanning: boolean;
  /** The agent's re-plan brief, the six `SettledRequirement` fields; absent when it wrote none. */
  requirement?: StopRequirement | null;
}

export interface ReportStopResult {
  commentId: string;
  /** Whether the card is now at Planning (false when `toPlanning` was not asked). */
  movedToPlanning: boolean;
}

function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

function validate(input: ReportStopInput): {
  comment: string;
  requirement: StopRequirement | null;
} {
  const comment = input.comment.trim();
  if (comment.length === 0 || comment.length > RUN_STOP_COMMENT_MAX) {
    throw new RunStopReportInvalidError('comment');
  }
  if (!input.requirement) return { comment, requirement: null };
  const requirement: StopRequirement = {};
  for (const field of STOP_REQUIREMENT_FIELDS) {
    const value = input.requirement[field];
    if (value === undefined) continue;
    if (value.trim().length > RUN_STOP_FIELD_MAX) throw new RunStopReportInvalidError(field);
    requirement[field] = value.trim();
  }
  return { comment, requirement };
}

export const runStopReportService = {
  /**
   * Record that the run's agent STOPPED on `key`. See the file header.
   *
   * @throws DispatchRunTokenOutOfScopeError — a run token naming another run.
   * @throws RunStopReportInvalidError — the finding is empty or a field over its bound.
   * @throws WorkItemNotFoundError — the card does not exist for this caller.
   * @throws PermissionDeniedError — the caller may not edit the card.
   * @throws DispatchRunNotFoundError / DispatchRunTerminalError — not this caller's running run.
   * @throws UnknownDispatchRunCardError — the card is not an open leg of the run.
   * @throws IllegalTransitionError and the other `updateStatus` refusals — the move to
   *   Planning was refused; nothing was written.
   */
  async reportStopForRun(
    runId: string,
    input: ReportStopInput,
    ctx: ServiceContext,
  ): Promise<ReportStopResult> {
    assertRunTokenScope(runId, ctx);
    const { comment, requirement } = validate(input);
    const key = input.key.trim().toUpperCase();

    let item: Awaited<ReturnType<typeof workItemsService.getWorkItemByIdentifier>>;
    try {
      const project = await projectsService.getByKey(projectKeyOf(key), ctx);
      item = await workItemsService.getWorkItemByIdentifier(project.id, key, ctx);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw new WorkItemNotFoundError(key);
      throw err;
    }
    await projectAccessService.assertPermission(item.projectId, ctx, 'work_item:edit');

    const leg = await dispatchRunService.findOpenLegOnRun(runId, item.id, ctx);
    if (!leg) throw new UnknownDispatchRunCardError(key);

    const bodyMd = composeStopComment({ comment, toPlanning: input.toPlanning, requirement });
    let commentId: string | null = null;
    const writeComment = async (tx: Prisma.TransactionClient): Promise<void> => {
      const created = await commentRepository.create(
        {
          workspaceId: ctx.workspaceId,
          workItemId: item.id,
          authorId: ctx.userId,
          parentCommentId: null,
          bodyMd,
        },
        tx,
      );
      commentId = created.id;
    };

    let movedToPlanning = false;
    if (input.toPlanning) {
      const dto = await workItemsService.updateStatus(item.id, PLANNING_STATUS_KEY, ctx, {
        inTransaction: writeComment,
      });
      movedToPlanning = dto.status === PLANNING_STATUS_KEY;
    } else {
      await withWorkspaceContext(
        { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: item.projectId },
        writeComment,
      );
    }
    /* v8 ignore next 3 -- unreachable: both arms ran `writeComment` or threw. */
    if (commentId === null) {
      throw new Error(`the stop comment on ${key} was not written`);
    }

    // Post-commit, like every comment: a rollback must not have notified watchers.
    await sendEvent('work-item/comment.created', {
      workspaceId: ctx.workspaceId,
      workItemId: item.id,
      commentId,
      authorId: ctx.userId,
      mentionedUserIds: [],
      ...(ctx.viaAutomationRuleId ? { viaAutomationRuleId: ctx.viaAutomationRuleId } : {}),
    });

    return { commentId, movedToPlanning };
  },
};
