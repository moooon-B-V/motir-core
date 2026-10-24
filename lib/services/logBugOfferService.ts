import type { ProjectContext } from '@/lib/projects';
import type { LogBugOfferClaim } from '@/lib/ai/logBugOffer';
import type { AnswerOfferInput, LogBugOfferTargetDto } from '@/lib/dto/planChange';
import type { WorkItemDto } from '@/lib/dto/workItems';
import { workItemsService } from '@/lib/services/workItemsService';
import { bugLoggingAvailable } from '@/lib/services/planOfferService';
import { readWorkItem } from '@/lib/workspaces/tenantRead';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

// THE LOG-A-BUG OFFER, landed (Story MOTIR-9220 · MOTIR-9322). What the settle's
// answer arm STORES for a `log_bug` offer motir-ai returned, or null for none — the
// twin of `planOfferService.land`. Pure reads; the write is the answer's own
// `appendAnswerTurn`, so the offer can never precede its answer or outlive a failed
// append. Nothing here writes a work item or calls a model.
//
// ── THE TARGET IS RE-RESOLVED UNDER THE SENDER'S ACCESS ─────────────────────────
// motir-ai named the target from what its own reads saw; every claim is read again
// here as the PERSON, so Motir never names a card the person cannot see:
//
//   | claim      | kept when                                              |
//   | ---------- | ------------------------------------------------------ |
//   | `new`      | always                                                 |
//   | `anchored` | it IS the turn's anchor, and that is a readable triage |
//   |            | bug (the only card the anchored write adds to)         |
//   | `existing` | a readable work item in this project that is NOT the   |
//   |            | anchor                                                 |
//
// A claim that fails DEGRADES rather than refuses: to `anchored` when the turn's
// anchor is a readable triage bug, else to `new` — the same fallback motir-ai applies
// to a key its session never read. The target's `updatedAt` at this read is stored
// (`targetUpdatedAt`): a confirm refuses a target edited since, because a read taken
// at confirm cannot see an edit made between the offer and the press.
//
// ── THE GATE IS `ai:plan`, NOT `work_item:edit` ─────────────────────────────────
// The bug is written by Motir, the system account (MOTIR-9329), not by the person,
// so a member who may ask but not edit is offered it like anyone else. A caller
// without `ai:plan`, or with Motir AI not configured, gets the answer and no offer.

/** A key in the ACTIVE project read as the sender, or null for every "not for you". */
async function readable(key: string, pctx: ProjectContext): Promise<WorkItemDto | null> {
  try {
    const item = await workItemsService.getWorkItemByIdentifier(pctx.projectId, key, {
      userId: pctx.userId,
      workspaceId: pctx.workspaceId,
    });
    return item.projectId === pctx.projectId ? item : null;
  } catch (err) {
    if (
      err instanceof WorkItemNotFoundError ||
      err instanceof ProjectAccessDeniedError ||
      err instanceof ProjectNotFoundError
    ) {
      return null;
    }
    throw err;
  }
}

/** The turn's anchor when it is a readable TRIAGE bug — the one card an anchored
 *  write may add to — else null. The DTO carries no triage marker; the tenant read
 *  does. */
async function triageAnchor(
  anchorKey: string | null,
  pctx: ProjectContext,
): Promise<WorkItemDto | null> {
  if (!anchorKey) return null;
  const item = await readable(anchorKey, pctx);
  if (!item) return null;
  const row = await readWorkItem(item.id, { userId: pctx.userId, workspaceId: pctx.workspaceId });
  return row && row.kind === 'bug' && row.triagedAt !== null ? item : null;
}

function targetOf(
  kind: 'anchored' | 'existing',
  item: WorkItemDto,
): { target: LogBugOfferTargetDto; updatedAt: string } {
  return {
    target: { kind, key: item.identifier, title: item.title },
    updatedAt: item.updatedAt,
  };
}

/** The claim re-resolved as the sender — see the table above. */
async function resolveTarget(
  claim: LogBugOfferClaim['target'],
  anchorKey: string | null,
  pctx: ProjectContext,
): Promise<{ target: LogBugOfferTargetDto; updatedAt: string | null }> {
  const anchor = await triageAnchor(anchorKey, pctx);
  if (claim.kind === 'anchored' && anchor && claim.key === anchorKey) {
    return targetOf('anchored', anchor);
  }
  if (claim.kind === 'existing' && claim.key !== anchorKey) {
    const item = await readable(claim.key, pctx);
    if (item) return targetOf('existing', item);
  }
  if (anchor) return targetOf('anchored', anchor);
  return { target: { kind: 'new', key: null, title: null }, updatedAt: null };
}

export const logBugOfferService = {
  /**
   * What the settle stores for a checked `log_bug` offer (already through
   * `parseLogBugOffer`), or null when the caller may not use it. `anchorKey` is the
   * RESOLVED anchor of the turn being answered (`PlanChangeTurnDto.anchorKey`), never
   * a value from the envelope. Never throws on a gate.
   */
  async land(
    offer: LogBugOfferClaim,
    pctx: ProjectContext,
    anchorKey: string | null,
  ): Promise<AnswerOfferInput | null> {
    if (!(await bugLoggingAvailable(pctx))) return null;
    const { target, updatedAt } = await resolveTarget(offer.target, anchorKey, pctx);
    return {
      kind: 'log_bug',
      // The rail's one line, and what an ask submit states back as the pending
      // offer's request: the bug's title.
      requestMd: offer.title,
      targetKey: target.key,
      bug: {
        title: offer.title,
        acceptanceCriteria: offer.acceptanceCriteria,
        draft: offer.draft,
        target,
        targetUpdatedAt: updatedAt,
        contextRefs: offer.contextRefs,
      },
    };
  },
};
