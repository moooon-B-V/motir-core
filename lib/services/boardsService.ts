import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { boardRepository } from '@/lib/repositories/boardRepository';
import { boardColumnRepository } from '@/lib/repositories/boardColumnRepository';
import { boardColumnStatusRepository } from '@/lib/repositories/boardColumnStatusRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { keyBetween } from '@/lib/workItems/positioning';
import { toBoardCardDto } from '@/lib/mappers/boardMappers';
import type { MoveCardResultDto, MoveCardTarget } from '@/lib/dto/boards';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  BoardColumnNotFoundError,
  BoardNotFoundError,
  IllegalBoardMoveError,
  UnmappedColumnTargetError,
} from '@/lib/boards/errors';
import { IllegalTransitionError, WorkItemNotFoundError } from '@/lib/workItems/errors';

// Board write side (Story 3.1 · Subtask 3.1.5). The load-bearing principle:
// **moving a card = a workflow transition, never a board-local write.** A
// cross-column drop resolves to the validated status-transition path
// (`workItemsService.applyStatusTransition`, the 2.2.4 core that runs
// `workflowsService.canTransition` under the project's policy mode); an
// in-column drop is a pure rank change on `work_item.position`. The board
// stores NOTHING about a card's placement — its column is derived from its
// `status`, its rank is the global `work_item.position`. (The read side — the
// column-of-cards projection — is Subtask 3.1.4; the drag-drop UI is 3.2.)
//
// One service method = one transaction (CLAUDE.md): the status change and the
// rank write commit atomically. We do NOT call the public
// `workItemsService.updateStatus` (it opens its OWN `db.$transaction`, which
// would deadlock against the row this method already `FOR UPDATE`-locks);
// instead we call its transaction-aware core within OUR `tx`, so the validation
// is reused, not re-implemented (the 3.1.5 card's contract).

export const boardsService = {
  /**
   * Move a card on a board: resolve the target column's status, run a workflow
   * transition for a cross-column move (validated; illegal → snapback), and
   * re-rank the card within the column — all in one transaction.
   *
   * `target.toColumnId` is the drop column; `beforeId` / `afterId` bracket the
   * drop slot (the card's new `position` sorts strictly between them).
   *
   * Throws (all typed; the 3.1.6 route maps them to status codes):
   *  - `WorkItemNotFoundError` (404) — unknown / cross-workspace card or neighbour;
   *  - `BoardNotFoundError` / `BoardColumnNotFoundError` (404) — unknown board / column;
   *  - `UnmappedColumnTargetError` (422) — the column maps no live status;
   *  - `IllegalBoardMoveError` (409) — the resolved cross-column transition is
   *    illegal under `restricted` policy (status + rank left unchanged — the
   *    snapback contract the 3.2 UI branches on).
   */
  async moveCard(
    boardId: string,
    workItemId: string,
    target: MoveCardTarget,
    ctx: ServiceContext,
  ): Promise<MoveCardResultDto> {
    const { row, appliedStatus, columnName } = await db.$transaction(async (tx) => {
      // Lock the card up front — serialize the status + rank writes against a
      // concurrent move of the same card (lost-update guard, like updateStatus).
      const locked = await workItemRepository.lockById(workItemId, tx);
      if (!locked) throw new WorkItemNotFoundError(workItemId);

      // Resolve + tenant-gate the board and the target column. The column must
      // belong to THIS board (a column id from another board is a 404).
      const board = await boardRepository.findById(boardId, ctx.workspaceId, tx);
      if (!board) throw new BoardNotFoundError(boardId);
      const column = await boardColumnRepository.findById(target.toColumnId, ctx.workspaceId, tx);
      if (!column || column.boardId !== boardId) {
        throw new BoardColumnNotFoundError(target.toColumnId);
      }

      // Tenant-gate the card and confirm it lives on this board's project.
      const item = await workItemRepository.findById(workItemId, tx);
      if (!item || item.workspaceId !== ctx.workspaceId || item.projectId !== board.projectId) {
        throw new WorkItemNotFoundError(workItemId);
      }

      // Resolve the target column's mapped statuses → keys (the status of a card
      // in the column) + positions (the multi-status pick order). A column that
      // maps no LIVE status (none, or only deleted statuses) is an unmapped
      // target — there is nothing to move the card into.
      const mappings = await boardColumnStatusRepository.findByColumn(
        target.toColumnId,
        ctx.workspaceId,
        tx,
      );
      const statuses = await workflowsService.listStatusesByProject(
        board.projectId,
        ctx.workspaceId,
      );
      const statusById = new Map(statuses.map((s) => [s.id, s]));
      const mappedStatuses = mappings
        .map((m) => statusById.get(m.statusId))
        .filter((s): s is WorkflowStatusDto => s != null);
      if (mappedStatuses.length === 0) throw new UnmappedColumnTargetError(target.toColumnId);
      const mappedKeys = new Set(mappedStatuses.map((s) => s.key));

      // STATUS. If the card's current status is already in the target column's
      // mapped set (a within-column drop, OR a drop into a multi-status column
      // that already contains the card's status) → NO transition. Otherwise the
      // target status is the column's mapped status ordered FIRST by
      // `status.position` (Jira's multi-status rule).
      let appliedStatus = item.status;
      if (!mappedKeys.has(item.status)) {
        const targetStatus = [...mappedStatuses].sort((a, b) =>
          a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
        )[0]!;
        try {
          await workItemsService.applyStatusTransition(workItemId, targetStatus.key, ctx, tx);
        } catch (err) {
          // Re-raise an illegal transition as the board-shaped 409 (snapback).
          if (err instanceof IllegalTransitionError) {
            throw new IllegalBoardMoveError(err.fromKey, err.toKey, 'no such workflow transition');
          }
          throw err;
        }
        appliedStatus = targetStatus.key;
      }

      // RANK. The new position sorts strictly between the bracketing neighbours
      // (a missing neighbour = the open end of the column). A pure within-column
      // reorder reaches here having attempted NO transition.
      const prev = await resolveNeighbourPosition(target.beforeId, board.projectId, ctx, tx);
      const next = await resolveNeighbourPosition(target.afterId, board.projectId, ctx, tx);
      const position = keyBetween(prev, next);
      const row = await workItemRepository.update(workItemId, { position }, tx);

      return { row, appliedStatus, columnName: column.name };
    });

    // Readiness (finding #21) is independent of THIS card's own move (it depends
    // on the card's blockers, which the move doesn't touch) — compute it after
    // the commit, via the read-only path, to complete the returned card.
    const { ready } = await workItemsService.getReadiness(workItemId, ctx);
    return {
      card: toBoardCardDto(row, { ready }),
      appliedStatus,
      column: { id: target.toColumnId, name: columnName },
    };
  },
};

/**
 * Resolve a rank-neighbour id to its `position`, or null when no neighbour is
 * given (the open end of the column). A neighbour must exist and be in the same
 * workspace + project as the board; otherwise it's a 404 (no cross-tenant leak).
 */
async function resolveNeighbourPosition(
  neighbourId: string | undefined,
  projectId: string,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<string | null> {
  if (!neighbourId) return null;
  const neighbour = await workItemRepository.findById(neighbourId, tx);
  if (
    !neighbour ||
    neighbour.workspaceId !== ctx.workspaceId ||
    neighbour.projectId !== projectId
  ) {
    throw new WorkItemNotFoundError(neighbourId);
  }
  return neighbour.position;
}
