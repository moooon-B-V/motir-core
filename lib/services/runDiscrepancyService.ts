import {
  DiscrepancyAlreadyRecordedError,
  RUN_DISCREPANCY_FIELD_MAX,
  RUN_DISCREPANCY_POINTS_MAX,
  RunDiscrepancyInvalidError,
} from '@/lib/dispatchRuns/errors';
import {
  composeDiscrepancyComment,
  type RunDiscrepancyPoint,
} from '@/lib/dispatchRuns/discrepancyComment';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { dispatchRunCardRepository } from '@/lib/repositories/dispatchRunCardRepository';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { DISPATCH_RUN_EVENT_LIMIT } from '@/lib/services/dispatchRunService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// A RUN'S DISCREPANCY RECORD (Story MOTIR-8651 · Subtask MOTIR-8655). The accepted record is
// the decision page MOTIR-8654, *A run builds through a wrong HOW — the discrepancy record*;
// this header states only what the code does.
//
// A runner that finds its card wrong only about the HOW builds through it and calls
// `record_run_discrepancy` ONCE with every point (what the plan asked · what was built · why).
// This service writes ONE comment on the card listing the points, and — when the card has an
// OPEN LEG on a running dispatch run — ONE `discrepancy_recorded` finding on that leg whose
// `data` is a POINTER (`{ commentId, pointCount, dispatchRunCardId }`), never the text.
//
// ⚠️ ONE TRANSACTION, AND THE FINDING IS NOT BEST-EFFORT. `recordFinding` swallows every
// failure because it observes a write that already committed. Here the comment IS the act and
// the answer must say truthfully whether the record exists, so a failed finding write fails the
// whole call and NOTHING is written (the runner then states the record is missing).
//
// ⚠️ ONE RECORD PER LEG. The run row is locked `FOR UPDATE` first — the same lock the event
// append takes, so it also serialises the `seq` allocation — and the dedupe
// (`findFindingOnRun`, keyed on `data.dispatchRunCardId`) is read UNDER it, so two concurrent
// calls cannot both pass. A second call is refused with `DISCREPANCY_ALREADY_RECORDED` and
// writes no second comment.
//
// ⚠️ NO OPEN LEG IS NOT AN ERROR. The comment is still written and `recorded` is false: a card
// with no run record, or no approving plan, still gets its discrepancy.
//
// `reportedBy` on the event is the RUN's own reporter (`cli` or `agent`), so a reader knows
// whose account the record is in.
//
// Permission: `work_item:edit` on the card's project — the key `CLI_TOKEN_GRANT` already holds.

/** What the runner sends. */
export interface RecordDiscrepancyInput {
  /** The card that was built through, `KEY-<n>` (the in-flight child, on a parent run). */
  key: string;
  points: readonly RunDiscrepancyPoint[];
}

/** The whole answer — acknowledgement only. */
export interface RecordDiscrepancyResult {
  commentId: string;
  /** Whether a finding was written on an open leg of a running dispatch run. */
  recorded: boolean;
}

function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

const FIELDS = ['planAsked', 'built', 'why'] as const;

/** Trim and bound the points. Refused, never truncated; nothing is resolved first. */
function validatePoints(points: readonly RunDiscrepancyPoint[]): RunDiscrepancyPoint[] {
  if (points.length === 0) throw new RunDiscrepancyInvalidError('points_empty');
  if (points.length > RUN_DISCREPANCY_POINTS_MAX) {
    throw new RunDiscrepancyInvalidError('points_too_many');
  }
  return points.map((point, index) => {
    const clean = { planAsked: '', built: '', why: '' };
    for (const field of FIELDS) {
      const value = (point[field] ?? '').trim();
      if (value.length === 0) {
        throw new RunDiscrepancyInvalidError('field_empty', { point: index + 1, field });
      }
      if (value.length > RUN_DISCREPANCY_FIELD_MAX) {
        throw new RunDiscrepancyInvalidError('field_too_long', { point: index + 1, field });
      }
      clean[field] = value;
    }
    return clean;
  });
}

export const runDiscrepancyService = {
  /**
   * Record that the caller's run built `key` through a wrong HOW. See the file header.
   *
   * @throws RunDiscrepancyInvalidError — the points are empty, too many, or a field is empty or
   *   over {@link RUN_DISCREPANCY_FIELD_MAX} characters.
   * @throws WorkItemNotFoundError — the card does not exist for this caller.
   * @throws PermissionDeniedError — the caller may not edit the card.
   * @throws DiscrepancyAlreadyRecordedError — the card's open leg already carries a record.
   */
  async recordDiscrepancy(
    input: RecordDiscrepancyInput,
    ctx: ServiceContext,
  ): Promise<RecordDiscrepancyResult> {
    const points = validatePoints(input.points);
    const key = input.key.trim().toUpperCase();

    const project = await projectsService.getByKey(projectKeyOf(key), ctx);
    await projectAccessService.assertCanEdit(project.id, ctx);

    const bound = { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id };
    const { result, workItemId } = await withWorkspaceContext(bound, async (tx) => {
      const item = await workItemRepository.findByIdentifier(project.id, key, tx);
      if (!item) throw new WorkItemNotFoundError(key);

      // The leg first, then the run row's lock, then the dedupe UNDER the lock.
      const leg = await dispatchRunCardRepository.findOpenLegForWorkItem(item.id, tx);
      let run: Awaited<ReturnType<typeof dispatchRunRepository.findById>> = null;
      if (leg) {
        await dispatchRunRepository.findTerminalStateForUpdate(leg.dispatchRunId, tx);
        const already = await dispatchRunEventRepository.findFindingOnRun(
          leg.dispatchRunId,
          'discrepancy_recorded',
          leg.id,
          tx,
        );
        if (already) throw new DiscrepancyAlreadyRecordedError(key);
        run = await dispatchRunRepository.findById(leg.dispatchRunId, tx);
      }

      const comment = await commentRepository.create(
        {
          workspaceId: ctx.workspaceId,
          workItemId: item.id,
          authorId: ctx.userId,
          parentCommentId: null,
          bodyMd: composeDiscrepancyComment(points),
        },
        tx,
      );

      let recorded = false;
      if (leg && run) {
        const existing = await dispatchRunEventRepository.countByRun(run.id, tx);
        if (existing < DISPATCH_RUN_EVENT_LIMIT) {
          const seq = ((await dispatchRunEventRepository.maxSeq(run.id, tx)) ?? 0) + 1;
          await dispatchRunEventRepository.createMany(
            [
              {
                workspaceId: ctx.workspaceId,
                dispatchRunId: run.id,
                dispatchRunCardId: leg.id,
                seq,
                kind: 'discrepancy_recorded',
                reportedBy: run.reportedBy,
                // A POINTER and a count — never the text, which lives in the comment.
                data: {
                  commentId: comment.id,
                  pointCount: points.length,
                  dispatchRunCardId: leg.id,
                },
              },
            ],
            tx,
          );
          recorded = true;
        }
      }
      return { result: { commentId: comment.id, recorded }, workItemId: item.id };
    });

    // Post-commit, like every comment: a rollback must not have notified watchers.
    await sendEvent('work-item/comment.created', {
      workspaceId: ctx.workspaceId,
      workItemId,
      commentId: result.commentId,
      authorId: ctx.userId,
      mentionedUserIds: [],
      ...(ctx.viaAutomationRuleId ? { viaAutomationRuleId: ctx.viaAutomationRuleId } : {}),
    });

    return result;
  },
};
