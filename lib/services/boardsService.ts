import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { boardRepository } from '@/lib/repositories/boardRepository';
import { boardColumnRepository } from '@/lib/repositories/boardColumnRepository';
import { boardColumnStatusRepository } from '@/lib/repositories/boardColumnStatusRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { keyBetween } from '@/lib/workItems/positioning';
import { toWorkflowStatusDto } from '@/lib/mappers/workflowMappers';
import { toBoardCardDto } from '@/lib/mappers/boardMappers';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { buildDefaultBoard } from '@/lib/boards/defaultBoard';
import { ProjectNotFoundError } from '@/lib/projects/errors';
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

// Boards service (Story 3.1) — business logic for the board entity. It hosts
// two surfaces:
//   * the default-board SEED (Subtask 3.1.2) — `seedDefaultBoard` /
//     `backfillDefaultBoard` below;
//   * the board WRITE side (Subtask 3.1.5) — `moveCard`.
// (The read projection is Subtask 3.1.4; the drag-drop UI is Story 3.2.)
//
// Like workflowsService, every write runs under the active workspace context so
// the FORCE-RLS WITH CHECK on the board tables passes under the non-bypass
// prodect_app role (the scalar-FK `Unchecked` creates avoid a relation
// connect's parent SELECT — finding #33). TENANCY (finding #26): every repo
// read/write carries an explicit `workspaceId`; RLS is the structural backstop,
// inert under the dev/CI BYPASSRLS superuser.
//
// The load-bearing principle for the write side: **moving a card = a workflow
// transition, never a board-local write.** A cross-column drop resolves to the
// validated status-transition path (`workItemsService.applyStatusTransition`,
// the 2.2.4 core that runs `workflowsService.canTransition` under the project's
// policy mode); an in-column drop is a pure rank change on `work_item.position`.
// The board stores NOTHING about a card's placement — its column is derived from
// its `status`, its rank is the global `work_item.position`.
//
// One service method = one transaction (CLAUDE.md). For `moveCard` we do NOT
// call the public `workItemsService.updateStatus` (it opens its OWN
// `db.$transaction`, which would deadlock against the row this method already
// `FOR UPDATE`-locks); instead we call its transaction-aware core within OUR
// `tx`, so the validation is reused, not re-implemented (the 3.1.5 contract).

export const boardsService = {
  /**
   * Seed a project's default Kanban board (Subtask 3.1.2) — the column-from-
   * workflow projection: one column per workflow status (in `status.position`
   * order), each mapped to its single status. A seeded default OVER the durable
   * many-to-one mapping (3.1.1), not a hardcoded 1:1.
   *
   * NEVER opens its own transaction: `tx` is REQUIRED and supplied by the
   * caller (createProject), so the project insert, its workflow seed (2.2.2),
   * and its board are atomic — a rollback of any rolls back all. It reads the
   * statuses through the SAME `tx` because they were just created in this
   * transaction and aren't visible outside it yet, then resolves each column's
   * status `key → id` against those rows. Rows carry the SCALAR workspaceId
   * (not a relation connect) so the writes pass the board RLS WITH CHECK under
   * the active workspace context (finding #33).
   */
  async seedDefaultBoard(
    projectId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const statuses = await workflowsRepository.findStatuses(projectId, workspaceId, tx);
    const statusIdByKey = new Map(statuses.map((s) => [s.key, s.id]));
    const spec = buildDefaultBoard(statuses.map(toWorkflowStatusDto));

    const board = await boardRepository.create(
      { workspaceId, projectId, name: spec.name, type: spec.type },
      tx,
    );

    for (const col of spec.columns) {
      const column = await boardColumnRepository.create(
        { workspaceId, projectId, boardId: board.id, name: col.name, position: col.position },
        tx,
      );
      for (const key of col.statusKeys) {
        const statusId = statusIdByKey.get(key);
        // Unreachable — buildDefaultBoard only emits keys drawn from `statuses`;
        // the guard turns a future projection bug into a clear failure instead
        // of a Prisma null-FK error (mirrors seedDefaultWorkflow's guard).
        if (!statusId) {
          throw new Error(`defaultBoard: column "${col.name}" maps an unknown status key "${key}"`);
        }
        await boardColumnStatusRepository.create(
          { workspaceId, projectId, boardId: board.id, columnId: column.id, statusId },
          tx,
        );
      }
    }
  },

  /**
   * One-off backfill of the default board onto a project that predates this
   * Story (a project with a workflow but no board). Admin/CLI-only —
   * `actorUserId` is required because the seed must run under
   * withWorkspaceContext (binding the workspace GUC the FORCE-RLS writes need;
   * rung-2 shipped-context shape, mirroring `workflowsService.backfillDefault-
   * Workflow`). Idempotent: a no-op (returns false) when the project already
   * has a board; seeds and returns true otherwise. Throws ProjectNotFoundError
   * if the project is absent. Drives the `scripts/backfill-default-boards.ts`
   * fleet sweep, one project at a time.
   */
  async backfillDefaultBoard(projectId: string, actorUserId: string): Promise<boolean> {
    const project = await projectRepository.findById(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);

    const existing = await boardRepository.findDefaultForProject(projectId, project.workspaceId);
    if (existing) return false;

    await withWorkspaceContext({ userId: actorUserId, workspaceId: project.workspaceId }, (tx) =>
      boardsService.seedDefaultBoard(projectId, project.workspaceId, tx),
    );
    return true;
  },

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
