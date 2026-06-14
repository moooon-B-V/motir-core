import type { Prisma, WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { SprintNotFoundError, CrossProjectSprintAssignmentError } from '@/lib/sprints/errors';
import { WorkItemNotFoundError, CrossProjectParentError } from '@/lib/workItems/errors';
import { assertValidParent } from '@/lib/issues/parentRules';
import { keyForAppend, keyBetween } from '@/lib/workItems/positioning';
import { toWorkItemDto } from '@/lib/mappers/workItemMappers';
import { sendEvent } from '@/lib/jobs/sendEvent';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { TriageQueuePageDto } from '@/lib/dto/triage';
import { toTriageQueueItemDto } from '@/lib/mappers/triageMappers';
import { clampTriageLimit, decodeTriageCursor, encodeTriageCursor } from '@/lib/triage/triageQueue';
import {
  NotInTriageError,
  TriageSelfMergeError,
  InvalidSnoozeUntilError,
} from '@/lib/triage/errors';

// The terminal status a declined / merged submission moves to (ADR §5). It is
// the default workflow's `cancelled` key (category `done`); the `todo →
// cancelled` transition already ships in `lib/workflows/defaultWorkflow.ts`.
const CANCELLED_STATUS_KEY = 'cancelled';

/**
 * The graduation TARGET an accept / promote resolves to (ADR §4). `parentId`
 * and `sprintId` are each applied only when PRESENT (`undefined` = leave as-is):
 *   - epic/story promote → `parentId` set (+ tree `position` from before/after);
 *   - sprint promote      → `sprintId` set;
 *   - backlog (accept)    → `parentId: null, sprintId: null`.
 * A fresh `backlogRank` is always minted at the BOTTOM of the destination scope
 * (the target sprint, or the backlog) so a graduated item lands last in line —
 * the UI re-ranks afterwards via the shipped rank endpoint if needed.
 */
interface GraduateTarget {
  parentId?: string | null;
  sprintId?: string | null;
  beforeId?: string;
  afterId?: string;
}

// Triage inbox — business logic (Story 6.11). Subtask 6.11.3 ships the READ
// side: the queue read, gated + paged + mapped to DTOs. The triage ACTIONS
// (accept / promote / decline / mark-duplicate-merge / snooze, 6.11.5) and the
// intake create paths (6.11.4) land their own methods here on top of the same
// `triagedAt` model. All reads/writes go through the shipped
// repositories/services (4-layer) — no raw Prisma in this layer.

export const triageService = {
  /**
   * One page of a project's ACTIVE triage queue (Subtask 6.11.3) — the inbox
   * an admin works through. Resolves + workspace-gates the project (a missing
   * or cross-workspace `projectId` → `ProjectNotFoundError`, no existence leak)
   * and asserts the actor can browse it (6.4), then reads ONLY triage items via
   * `findTriageQueue` (the single read that inverts the global triage exclusion).
   *
   * Cursor-paginated (finding #57 — the public form can flood the inbox, never
   * load-all): fetches `limit + 1` rows so `hasMore` needs no separate COUNT;
   * `nextCursor` is the opaque `(triagedAt, id)` seek-after token, or null on the
   * last page. The limit is clamped to `[1, TRIAGE_QUEUE_MAX_LIMIT]`; an invalid
   * cursor token throws `InvalidTriageCursorError` (→ 400 at the route).
   */
  async getTriageQueue(
    projectId: string,
    params: { cursor?: string; limit?: number },
    ctx: ServiceContext,
  ): Promise<TriageQueuePageDto> {
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    await projectAccessService.assertCanBrowse(projectId, ctx);

    const limit = clampTriageLimit(params.limit);
    const cursor = params.cursor ? decodeTriageCursor(params.cursor) : undefined;

    const rows = await workItemRepository.findTriageQueue(projectId, project.workspaceId, {
      limit: limit + 1,
      cursor: cursor ? { triagedAt: new Date(cursor.triagedAt), id: cursor.id } : undefined,
    });

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(toTriageQueueItemDto);
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeTriageCursor({ triagedAt: last.triagedAt!.toISOString(), id: last.id })
        : null;

    return { items, nextCursor };
  },

  // ─── Triage ACTIONS (Subtask 6.11.5, per docs/decisions/triage-model.md §4/§5) ───
  // The verbs an admin clears the queue with: accept / promote (graduate →
  // clear `triagedAt`), decline / mark-duplicate-merge (terminal → cancel,
  // KEEP `triagedAt` so the item never re-pollutes the tree), and snooze /
  // unsnooze (defer out of the active queue). Each is ONE service method = ONE
  // transaction; the gate read (`lockTriageItem`) takes `tx` + a FOR-UPDATE
  // lock so two concurrent actions can't race the same item
  // (lock-before-read-derived-update). Graduation / re-parent route through the
  // shipped write authority — never raw Prisma — honouring 6.4 permissions and
  // the kind-parent matrix.

  /**
   * **Accept → backlog** (ADR §4). Graduate the item into the project backlog
   * (no parent) at the bottom of the rank, with an optional admin comment. The
   * item is born at the workflow's initial status, so accept changes no status —
   * it clears the triage marker and re-ranks. Returns the graduated item.
   */
  async acceptTriageItem(
    workItemId: string,
    input: { comment?: string },
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    return db.$transaction(async (tx) => {
      const item = await lockTriageItem(workItemId, ctx, tx);
      const row = await graduate(item, { parentId: null, sprintId: null }, ctx, tx);
      await addTriageNote(item, input.comment, ctx, tx);
      return toWorkItemDto(row);
    });
  },

  /**
   * **Promote → sprint / epic / story / backlog** (ADR §4). Graduate the item to
   * a chosen destination: an `parentId` (epic/story — the kind-parent matrix
   * bounds it, the same `assertValidParent` pre-flight the rest of the app uses)
   * and/or a `sprintId`, with an optional tree position via before/after
   * neighbours. Clears the triage marker so the same row — with its full
   * comment/attachment/history thread — appears in the tree.
   */
  async promoteTriageItem(
    workItemId: string,
    input: {
      parentId?: string | null;
      sprintId?: string | null;
      beforeId?: string;
      afterId?: string;
      comment?: string;
    },
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    return db.$transaction(async (tx) => {
      const item = await lockTriageItem(workItemId, ctx, tx);
      const row = await graduate(
        item,
        {
          parentId: input.parentId,
          sprintId: input.sprintId,
          beforeId: input.beforeId,
          afterId: input.afterId,
        },
        ctx,
        tx,
      );
      await addTriageNote(item, input.comment, ctx, tx);
      return toWorkItemDto(row);
    });
  },

  /**
   * **Decline** (ADR §5). Move the submission to the terminal `cancelled`
   * status with an optional comment; the triage marker is KEPT, so the
   * parentless cancelled item stays out of EVERY normal read (a cleared marker
   * would surface it as a tree root) while leaving the active queue. The
   * `todo → cancelled` transition runs through the shipped
   * `workItemsService.applyStatusTransition` (same validation + revision), and
   * the `work-item/transitioned` event fires post-commit.
   */
  async declineTriageItem(
    workItemId: string,
    input: { comment?: string },
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    const { dto, transition } = await db.$transaction(async (tx) => {
      const item = await lockTriageItem(workItemId, ctx, tx);
      const result = await workItemsService.applyStatusTransition(
        workItemId,
        CANCELLED_STATUS_KEY,
        ctx,
        tx,
      );
      await addTriageNote(item, input.comment, ctx, tx);
      return result;
    });
    await emitTransition(dto, transition, ctx);
    return dto;
  },

  /**
   * **Mark duplicate / merge** (ADR §5). Fold the submission into a canonical
   * item: re-point the duplicate's comments + attachments onto the canonical
   * item (mirroring Linear moving attachments to the canonical issue), record a
   * `duplicates` link, then cancel the duplicate (triage marker KEPT). The
   * optional comment lands on the duplicate. Returns the (now cancelled)
   * duplicate.
   */
  async markDuplicateTriageItem(
    workItemId: string,
    input: { canonicalId: string; comment?: string },
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    if (workItemId === input.canonicalId) throw new TriageSelfMergeError(workItemId);
    const { dto, transition } = await db.$transaction(async (tx) => {
      const item = await lockTriageItem(workItemId, ctx, tx);
      const canonical = await workItemRepository.findById(input.canonicalId, tx);
      if (!canonical || canonical.workspaceId !== ctx.workspaceId) {
        throw new WorkItemNotFoundError(input.canonicalId);
      }

      // Fold the thread onto the canonical item BEFORE cancelling the duplicate.
      await commentRepository.reassignWorkItem(workItemId, input.canonicalId, tx);
      await attachmentRepository.reassignWorkItem(workItemId, input.canonicalId, tx);

      // Record the duplicate→canonical link (the 6.9 `duplicates` grammar) on
      // the duplicate, then a revision for the trail.
      await workItemLinkRepository.create(
        {
          workspaceId: item.workspaceId,
          fromId: workItemId,
          toId: input.canonicalId,
          kind: 'duplicates',
          createdById: ctx.userId,
        },
        tx,
      );
      await workItemRevisionsService.recordRevision(
        {
          workItemId,
          changedById: ctx.userId,
          changeKind: 'updated',
          diff: { links: { added: [{ toId: input.canonicalId, kind: 'duplicates' }] } },
        },
        tx,
      );

      const result = await workItemsService.applyStatusTransition(
        workItemId,
        CANCELLED_STATUS_KEY,
        ctx,
        tx,
      );
      await addTriageNote(item, input.comment, ctx, tx);
      return result;
    });
    await emitTransition(dto, transition, ctx);
    return dto;
  },

  /**
   * **Snooze** (ADR §5). Hide the item from the ACTIVE queue until
   * `snoozedUntil` — or until new activity returns it sooner (a comment clears
   * the marker; see `commentsService.addComment`). The marker stays set, so the
   * item never leaks into a normal read while snoozed. `snoozedUntil` must be a
   * valid future instant.
   */
  async snoozeTriageItem(
    workItemId: string,
    input: { snoozedUntil: string },
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    const until = new Date(input.snoozedUntil);
    if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
      throw new InvalidSnoozeUntilError();
    }
    return db.$transaction(async (tx) => {
      await lockTriageItem(workItemId, ctx, tx);
      const row = await workItemRepository.update(workItemId, { snoozedUntil: until }, tx);
      return toWorkItemDto(row);
    });
  },

  /**
   * **Unsnooze** (ADR §5). Clear `snoozedUntil` immediately, returning the item
   * to the active queue.
   */
  async unsnoozeTriageItem(workItemId: string, ctx: ServiceContext): Promise<WorkItemDto> {
    return db.$transaction(async (tx) => {
      await lockTriageItem(workItemId, ctx, tx);
      const row = await workItemRepository.update(workItemId, { snoozedUntil: null }, tx);
      return toWorkItemDto(row);
    });
  },
};

/**
 * Lock + tenant-gate + edit-gate + assert-in-triage, inside the caller's `tx`.
 * The `SELECT FOR UPDATE` (via `lockById`) serialises concurrent triage actions
 * on the same item (lock-before-read-derived-update). A cross-workspace or
 * unknown id, and a non-browsable project, all read as 404 (no existence leak —
 * the `assertCanEdit` gate rejects a non-browser as 'browse' first); an item
 * that has already graduated (`triagedAt IS NULL`) is a 409 `NotInTriageError`.
 */
async function lockTriageItem(
  workItemId: string,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<WorkItem> {
  const locked = await workItemRepository.lockById(workItemId, tx);
  if (!locked) throw new WorkItemNotFoundError(workItemId);
  const item = await workItemRepository.findById(workItemId, tx);
  if (!item || item.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(workItemId);
  await projectAccessService.assertCanEdit(item.projectId, ctx, tx);
  if (item.triagedAt === null) throw new NotInTriageError(workItemId);
  return item;
}

/**
 * Graduate a triage item into the planned tree (ADR §4): clear `triagedAt`, set
 * the chosen parent/sprint, and mint a fresh `backlogRank` at the bottom of the
 * destination scope — all in the caller's `tx`, recording one revision. The
 * kind-parent matrix is enforced via the shipped `assertValidParent` pre-flight
 * (the DB trigger is the backstop). Returns the updated row.
 */
async function graduate(
  item: WorkItem,
  target: GraduateTarget,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<WorkItem> {
  const update: Prisma.WorkItemUncheckedUpdateInput = { triagedAt: null };
  const diff: Record<string, { from: unknown; to: unknown }> = {};

  // ── Parent (epic/story, or null for the backlog) ──────────────────────────
  let targetSprintId = item.sprintId;
  if (target.parentId !== undefined) {
    const targetParentId = target.parentId;
    if (targetParentId === null) {
      assertValidParent(null, item.kind);
    } else {
      const parent = await workItemRepository.findById(targetParentId, tx);
      if (!parent) throw new WorkItemNotFoundError(targetParentId);
      if (parent.projectId !== item.projectId) throw new CrossProjectParentError();
      assertValidParent(parent.kind, item.kind);
    }
    update.parentId = targetParentId;
    if (targetParentId !== item.parentId) {
      diff.parentId = { from: item.parentId, to: targetParentId };
      const newPosition = await resolveTreePosition(
        item.projectId,
        targetParentId,
        target.beforeId,
        target.afterId,
        tx,
      );
      update.position = newPosition;
      if (newPosition !== item.position) diff.position = { from: item.position, to: newPosition };
    }
  }

  // ── Sprint association ────────────────────────────────────────────────────
  if (target.sprintId !== undefined) {
    if (target.sprintId !== null) {
      const sprint = await sprintRepository.findById(target.sprintId, ctx.workspaceId, tx);
      if (!sprint) throw new SprintNotFoundError(target.sprintId);
      if (sprint.projectId !== item.projectId) {
        throw new CrossProjectSprintAssignmentError(item.id, target.sprintId);
      }
    }
    targetSprintId = target.sprintId;
    update.sprintId = target.sprintId;
    if (target.sprintId !== item.sprintId) {
      diff.sprintId = { from: item.sprintId, to: target.sprintId };
    }
  }

  // ── Fresh backlog rank at the BOTTOM of the destination scope ─────────────
  const lastRank = await workItemRepository.findBoundaryBacklogRank(
    item.projectId,
    ctx.workspaceId,
    targetSprintId,
    'max',
    tx,
  );
  const backlogRank = keyForAppend(lastRank);
  update.backlogRank = backlogRank;
  diff.backlogRank = { from: item.backlogRank, to: backlogRank };

  const row = await workItemRepository.update(item.id, update, tx);
  await workItemRevisionsService.recordRevision(
    { workItemId: item.id, changedById: ctx.userId, changeKind: 'updated', diff },
    tx,
  );
  return row;
}

/**
 * The tree `position` (fractional index under the new parent) a promotion lands
 * at — between named neighbours, else appended after the parent's last child.
 * Mirrors `workItemsService.moveWorkItem` / `createWorkItem` positioning.
 */
async function resolveTreePosition(
  projectId: string,
  parentId: string | null,
  beforeId: string | undefined,
  afterId: string | undefined,
  tx: Prisma.TransactionClient,
): Promise<string> {
  if (beforeId == null && afterId == null) {
    const siblings = await workItemRepository.findSiblings(projectId, parentId, tx);
    const last = siblings.length ? siblings[siblings.length - 1]!.position : null;
    return keyForAppend(last);
  }
  const beforePos = beforeId
    ? ((await workItemRepository.findById(beforeId, tx))?.position ?? null)
    : null;
  const afterPos = afterId
    ? ((await workItemRepository.findById(afterId, tx))?.position ?? null)
    : null;
  return keyBetween(beforePos, afterPos);
}

/**
 * Persist an optional admin note (accept / promote / decline / merge) as a plain
 * root comment on the item, in the caller's `tx`. A triage-action note is a
 * record, not a discussion post, so it goes straight through the comment
 * repository — no mention fan-out / watcher events (the inbox's normal comment
 * composer, `commentsService.addComment`, owns those). A blank/whitespace
 * comment is a no-op.
 */
async function addTriageNote(
  item: WorkItem,
  comment: string | undefined,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const body = comment?.trim();
  if (!body) return;
  await commentRepository.create(
    {
      workspaceId: item.workspaceId,
      workItemId: item.id,
      authorId: ctx.userId,
      parentCommentId: null,
      bodyMd: body,
    },
    tx,
  );
}

/**
 * Post-commit `work-item/transitioned` emit for decline / merge (the status
 * change rolls back with the tx, so the event can never fire inside it). A
 * no-op transition (`null`) emits nothing.
 */
async function emitTransition(
  dto: WorkItemDto,
  transition: { fromStatusKey: string; toStatusKey: string; revisionId: string } | null,
  ctx: ServiceContext,
): Promise<void> {
  if (!transition) return;
  await sendEvent('work-item/transitioned', {
    workspaceId: ctx.workspaceId,
    workItemId: dto.id,
    actorId: ctx.userId,
    fromStatusKey: transition.fromStatusKey,
    toStatusKey: transition.toStatusKey,
    revisionId: transition.revisionId,
  });
}
