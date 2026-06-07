import { Prisma, BoardSwimlaneGroupBy } from '@prisma/client';
import type { BoardColumn, WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { boardRepository } from '@/lib/repositories/boardRepository';
import { boardColumnRepository } from '@/lib/repositories/boardColumnRepository';
import { boardColumnStatusRepository } from '@/lib/repositories/boardColumnStatusRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { keyBetween } from '@/lib/workItems/positioning';
import { isOwnerRole } from '@/lib/workspaces/roles';
import { toWorkflowStatusDto } from '@/lib/mappers/workflowMappers';
import { toBoardCardDto, toBoardColumnConfigDto, toBoardDto } from '@/lib/mappers/boardMappers';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { buildDefaultBoard } from '@/lib/boards/defaultBoard';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { BOARD_SWIMLANE_NO_VALUE } from '@/lib/dto/boards';
import type {
  BoardColumnConfigDto,
  BoardColumnDto,
  BoardDto,
  BoardProjectionDto,
  BoardSwimlaneDto,
  BoardSwimlaneGroupByDto,
  BoardTypeDto,
  MoveCardResultDto,
  MoveCardTarget,
  PagedColumnCardsDto,
} from '@/lib/dto/boards';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  BoardColumnNotFoundError,
  BoardNotFoundError,
  IllegalBoardMoveError,
  InvalidSwimlaneGroupByError,
  InvalidWipLimitError,
  NotBoardAdminError,
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
   * The board READ projection (Subtask 3.1.4) — turn a project's default board +
   * workflow + issues into the column-of-cards shape the 3.2 UI renders, BOUNDED
   * (never load-all, finding #57). For each column it returns the column meta,
   * its mapped status keys, the FULL card count, a bounded first page of cards
   * (ranked by `position`, or by recency for a terminal/done column), and a
   * `cursor` for lazy "load more". Plus a top-level `unmappedStatuses` — every
   * project status mapped to NO column (Jira's behaviour: surfaced, never
   * dropped). Read-only: no transaction; the explicit `workspaceId` gate
   * (finding #26) is carried into every repo read.
   *
   * Throws `BoardNotFoundError` (404) when the project has no board yet (a
   * project predating the 3.1.2 seed/backfill — the 3.2 UI shows its no-board
   * state).
   */
  async getBoard(projectId: string, ctx: ServiceContext): Promise<BoardProjectionDto> {
    const board = await boardRepository.findDefaultForProject(projectId, ctx.workspaceId);
    if (!board) throw new BoardNotFoundError(`default board for project ${projectId}`);

    const [columns, mappings, statuses] = await Promise.all([
      boardColumnRepository.findByBoard(board.id, ctx.workspaceId),
      boardColumnStatusRepository.findByBoard(board.id, ctx.workspaceId),
      workflowsService.listStatusesByProject(projectId, ctx.workspaceId),
    ]);

    const statusById = new Map(statuses.map((s) => [s.id, s]));
    const terminalKeys = terminalKeySet(statuses);

    // column id → its mapped LIVE statuses; plus the set of all mapped status
    // ids (any status NOT in it is unmapped). A mapping to a deleted status is
    // skipped (no live key) but does not make the status "unmapped".
    const liveByColumn = new Map<string, WorkflowStatusDto[]>();
    const mappedStatusIds = new Set<string>();
    for (const m of mappings) {
      mappedStatusIds.add(m.statusId);
      const s = statusById.get(m.statusId);
      if (!s) continue;
      const list = liveByColumn.get(m.columnId) ?? [];
      list.push(s);
      liveByColumn.set(m.columnId, list);
    }

    // Build each column's count + bounded first page (per-column, NOT per-card —
    // bounded by column count, so no N+1 over cards).
    const built = await Promise.all(
      columns.map((col) => {
        const live = (liveByColumn.get(col.id) ?? []).slice().sort(byPosition);
        const statusKeys = live.map((s) => s.key);
        const terminal = isTerminalColumn(statusKeys, terminalKeys);
        return buildColumnPage(projectId, col, statusKeys, terminal, ctx);
      }),
    );

    // Batch readiness across EVERY card on the board in ONE pass (finding #21
    // without an N+1).
    const allRows = built.flatMap((b) => b.rows);
    const readyById = await workItemsService.getReadinessForItems(
      allRows.map((r) => r.id),
      ctx,
    );

    // Swimlanes (Subtask 3.3.4). The union of the board's mapped column statuses
    // IS the board's card population, so lane membership (per loaded card) and
    // the lane list are both resolved over that set — a bounded aggregate, never
    // a load-all (finding #57). For the flat `none` board both are no-ops: an
    // empty `swimlanes` and no per-card `swimlaneKey` (so the projection is
    // byte-for-byte the 3.1.4 shape).
    const groupBy = board.swimlaneGroupBy as BoardSwimlaneGroupByDto;
    const boardStatusKeys = [...new Set(built.flatMap((b) => b.statusKeys))];
    const [swimlaneKeyByCard, swimlanes] = await Promise.all([
      resolveSwimlaneKeys(groupBy, allRows, ctx),
      buildSwimlanes(groupBy, projectId, boardStatusKeys, ctx),
    ]);

    const columnsDto: BoardColumnDto[] = built.map((b) => ({
      id: b.col.id,
      name: b.col.name,
      position: b.col.position.toString(),
      wipLimit: b.col.wipLimit,
      statusKeys: b.statusKeys,
      cards: b.rows.map((r) =>
        toBoardCardDto(r, {
          ready: readyById.get(r.id) ?? true,
          swimlaneKey: swimlaneKeyByCard.get(r.id),
        }),
      ),
      totalCount: b.totalCount,
      cursor: b.cursor,
    }));

    return {
      boardId: board.id,
      name: board.name,
      type: board.type as BoardTypeDto,
      swimlaneGroupBy: groupBy,
      columns: columnsDto,
      swimlanes,
      unmappedStatuses: statuses.filter((s) => !mappedStatusIds.has(s.id)),
    };
  },

  /**
   * One lazy "load more" page for a single column (Subtask 3.1.4, finding #57) —
   * the next slice of cards after `cursor` (null/absent = the first page) plus
   * the cursor for the page after it (null at the end of the column's bounded
   * window). The 3.2 UI calls this as a column scrolls. Same column resolution +
   * terminal/recent ordering + tenant gate as `getBoard`.
   *
   * Throws `BoardNotFoundError` / `BoardColumnNotFoundError` (404) for an
   * unknown board or a column that isn't on it.
   */
  async loadColumnCards(
    boardId: string,
    columnId: string,
    cursor: string | null | undefined,
    ctx: ServiceContext,
  ): Promise<PagedColumnCardsDto> {
    const board = await boardRepository.findById(boardId, ctx.workspaceId);
    if (!board) throw new BoardNotFoundError(boardId);
    const column = await boardColumnRepository.findById(columnId, ctx.workspaceId);
    if (!column || column.boardId !== boardId) throw new BoardColumnNotFoundError(columnId);

    const [mappings, statuses] = await Promise.all([
      boardColumnStatusRepository.findByColumn(columnId, ctx.workspaceId),
      workflowsService.listStatusesByProject(board.projectId, ctx.workspaceId),
    ]);
    const statusById = new Map(statuses.map((s) => [s.id, s]));
    const statusKeys = mappings
      .map((m) => statusById.get(m.statusId))
      .filter((s): s is WorkflowStatusDto => s != null)
      .map((s) => s.key);
    if (statusKeys.length === 0) return { cards: [], cursor: null };

    const terminal = isTerminalColumn(statusKeys, terminalKeySet(statuses));
    const offset = parseCursor(cursor);
    const [totalCount, rows] = await Promise.all([
      workItemRepository.countProjectIssues(board.projectId, ctx.workspaceId, {
        statuses: statusKeys,
      }),
      workItemRepository.findColumnCards(
        board.projectId,
        ctx.workspaceId,
        statusKeys,
        terminal ? 'recent' : 'position',
        { limit: BOARD_COLUMN_PAGE_SIZE, offset },
      ),
    ]);
    const readyById = await workItemsService.getReadinessForItems(
      rows.map((r) => r.id),
      ctx,
    );
    // Stamp each load-more card with its lane key (Subtask 3.3.4) so the UI
    // buckets the paged-in cards into the same (lane, column) cells.
    const swimlaneKeyByCard = await resolveSwimlaneKeys(
      board.swimlaneGroupBy as BoardSwimlaneGroupByDto,
      rows,
      ctx,
    );
    return {
      cards: rows.map((r) =>
        toBoardCardDto(r, {
          ready: readyById.get(r.id) ?? true,
          swimlaneKey: swimlaneKeyByCard.get(r.id),
        }),
      ),
      cursor: nextCursor(offset, BOARD_COLUMN_PAGE_SIZE, totalCount, terminal),
    };
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
    const { row, appliedStatus, columnName, swimlaneGroupBy } = await db.$transaction(
      async (tx) => {
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
              throw new IllegalBoardMoveError(
                err.fromKey,
                err.toKey,
                'no such workflow transition',
              );
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

        return {
          row,
          appliedStatus,
          columnName: column.name,
          swimlaneGroupBy: board.swimlaneGroupBy,
        };
      },
    );

    // Readiness (finding #21) is independent of THIS card's own move (it depends
    // on the card's blockers, which the move doesn't touch) — compute it after
    // the commit, via the read-only path, to complete the returned card.
    const { ready } = await workItemsService.getReadiness(workItemId, ctx);
    // Stamp the moved card with its lane key (Subtask 3.3.4) so the UI
    // reconciles it back into the right lane (a status-only move never changes
    // the card's lane, but the card shape must stay consistent under a grouped
    // board).
    const swimlaneKeyByCard = await resolveSwimlaneKeys(
      swimlaneGroupBy as BoardSwimlaneGroupByDto,
      [row],
      ctx,
    );
    return {
      card: toBoardCardDto(row, { ready, swimlaneKey: swimlaneKeyByCard.get(row.id) }),
      appliedStatus,
      column: { id: target.toColumnId, name: columnName },
    };
  },

  /**
   * Set a board's swimlane group-by (Subtask 3.3.3) — the write half of the
   * board flow-management config. `groupBy` must be a `BoardSwimlaneGroupBy`
   * (`none` / `assignee` / `epic` / `priority`); `none` is the flat 3.2 board.
   * Returns the updated board config DTO so the 3.3.5 UI reconciles.
   *
   * Order mirrors the 2.2.5 workflow mutations: resolve + tenant-gate (404) →
   * authorize (403) → validate input (400) → write. Tenant gate (finding #26):
   * a board id from another workspace resolves to `null` → `BoardNotFoundError`
   * (no cross-tenant existence leak). Config writes are workspace-OWNER-gated
   * (finding #36), mirroring the workflow editor — see `assertBoardConfigAdmin`.
   *
   * Throws: `BoardNotFoundError` (404), `NotBoardAdminError` (403),
   * `InvalidSwimlaneGroupByError` (400).
   */
  async setSwimlaneGroupBy(
    boardId: string,
    groupBy: string,
    ctx: ServiceContext,
  ): Promise<BoardDto> {
    const board = await boardRepository.findById(boardId, ctx.workspaceId);
    if (!board) throw new BoardNotFoundError(boardId);
    await assertBoardConfigAdmin(ctx.userId, board.projectId, ctx.workspaceId);
    if (!isSwimlaneGroupBy(groupBy)) throw new InvalidSwimlaneGroupByError(groupBy);

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => boardRepository.update(boardId, { swimlaneGroupBy: groupBy }, tx),
    );
    return toBoardDto(row);
  },

  /**
   * Set (or clear) a board column's WIP limit (Subtask 3.3.3). `limit` is a
   * non-negative integer, or `null` to remove the limit; a negative, fractional,
   * or non-numeric value is rejected with `InvalidWipLimitError`. The limit is
   * advisory only — the over-limit warning is a UI treatment (3.3.6), never a
   * blocked drop (the 3.2.4 move contract is untouched). Returns the updated
   * column config DTO so the 3.3.6 UI reconciles its optimistic edit.
   *
   * Same order + gates as `setSwimlaneGroupBy`: resolve + tenant-gate the column
   * (404) → owner-authorize via the column's project (403) → validate (400) →
   * write. The column row carries its scalar `projectId` (3.1.3), so the admin
   * gate needs no extra board read.
   *
   * Throws: `BoardColumnNotFoundError` (404), `NotBoardAdminError` (403),
   * `InvalidWipLimitError` (400).
   */
  async setColumnWipLimit(
    columnId: string,
    limit: number | null,
    ctx: ServiceContext,
  ): Promise<BoardColumnConfigDto> {
    const column = await boardColumnRepository.findById(columnId, ctx.workspaceId);
    if (!column) throw new BoardColumnNotFoundError(columnId);
    await assertBoardConfigAdmin(ctx.userId, column.projectId, ctx.workspaceId);
    if (!isValidWipLimit(limit)) throw new InvalidWipLimitError();

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => boardColumnRepository.update(columnId, { wipLimit: limit }, tx),
    );
    return toBoardColumnConfigDto(row);
  },
};

/**
 * Board-config admin gate (Subtask 3.3.3). v1 routes "board admin" to the
 * workspace OWNER (finding #36), EXACTLY mirroring `workflowsService`'s
 * `assertProjectAdmin` — board configuration (swimlanes, WIP) is project-
 * settings, the same tier the workflow editor guards. Full per-project RBAC is
 * Epic 6.4 (TODO(6.4): widen the role-set behind this gate; the gate SHAPE is
 * already durable, only the allowed roles change). Also asserts the project
 * belongs to the workspace (404 no-existence-leak) so a foreign projectId can't
 * probe membership.
 *
 * NOTE (decision-ladder + PRODECT_FINDINGS): the 3.3.3 card prose said board
 * config is "a write any workspace member can make today". The SHIPPED 2.2.5
 * editor it names as the precedent is owner-gated (rung 2 > the card), and Jira
 * gates board config to admins (rung 1) — so the owner gate is the consistent
 * build, not "any member". Logged as a finding.
 */
async function assertBoardConfigAdmin(
  userId: string,
  projectId: string,
  workspaceId: string,
): Promise<void> {
  const project = await projectRepository.findById(projectId);
  if (!project || project.workspaceId !== workspaceId) {
    throw new ProjectNotFoundError(projectId);
  }
  const membership = await workspaceMembershipRepository.findByUserAndWorkspace(
    userId,
    workspaceId,
  );
  if (!isOwnerRole(membership?.role)) {
    throw new NotBoardAdminError();
  }
}

/** True iff `value` is one of the `BoardSwimlaneGroupBy` enum values. */
function isSwimlaneGroupBy(value: string): value is BoardSwimlaneGroupBy {
  return (Object.values(BoardSwimlaneGroupBy) as string[]).includes(value);
}

/** True iff `limit` is `null` (clear) or a non-negative integer. */
function isValidWipLimit(limit: number | null): boolean {
  return limit === null || (Number.isInteger(limit) && limit >= 0);
}

/** Default per-column page size — the projection ships at most this many cards
 * per column per page (finding #57: never the whole column). */
const BOARD_COLUMN_PAGE_SIZE = 50;

/**
 * Terminal (done / cancelled) columns are bounded to a RECENT WINDOW — Jira
 * hides done issues older than ~14 days; lacking a `completedAt` column we order
 * terminal columns by `updatedAt` desc and cap the lazily-pageable window at the
 * most-recent N, with the FULL count still surfaced (`totalCount`). This is the
 * durable shape (a bounded recent window), not a magic display cap.
 */
const TERMINAL_COLUMN_WINDOW = 200;

/** The per-project terminal-status key set (category `done`) — the finding-#21
 * terminal generalization, reused for both readiness and terminal-column order. */
function terminalKeySet(statuses: WorkflowStatusDto[]): Set<string> {
  return new Set(statuses.filter((s) => s.category === 'done').map((s) => s.key));
}

/** A column is terminal iff it maps at least one live status and EVERY mapped
 * status is terminal (the Done / Cancelled columns). */
function isTerminalColumn(statusKeys: string[], terminalKeys: Set<string>): boolean {
  return statusKeys.length > 0 && statusKeys.every((k) => terminalKeys.has(k));
}

/** Sort `WorkflowStatusDto`s by their fractional-index `position` (lexicographic). */
function byPosition(a: WorkflowStatusDto, b: WorkflowStatusDto): number {
  return a.position < b.position ? -1 : a.position > b.position ? 1 : 0;
}

/** The card window actually reachable by paging — capped for terminal columns. */
function pageableTotal(total: number, terminal: boolean): number {
  return terminal ? Math.min(total, TERMINAL_COLUMN_WINDOW) : total;
}

/** The cursor for the page AFTER `offset` (null when the bounded window is
 * exhausted). The cursor is the opaque next offset; paging is offset-based,
 * mirroring the List's `?page=` window (Subtask 2.5.12). */
function nextCursor(
  offset: number,
  limit: number,
  total: number,
  terminal: boolean,
): string | null {
  const next = offset + limit;
  return next < pageableTotal(total, terminal) ? String(next) : null;
}

/** Decode a load-more cursor to its offset; absent/garbage → 0 (first page). */
function parseCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Build one column's projection page: its full card count + the bounded first
 * page of card rows (terminal columns ordered by recency, others by rank) + the
 * load-more cursor. A column mapping no live status is an empty column.
 */
async function buildColumnPage(
  projectId: string,
  col: BoardColumn,
  statusKeys: string[],
  terminal: boolean,
  ctx: ServiceContext,
): Promise<{
  col: BoardColumn;
  statusKeys: string[];
  rows: WorkItem[];
  totalCount: number;
  cursor: string | null;
}> {
  if (statusKeys.length === 0) {
    return { col, statusKeys, rows: [], totalCount: 0, cursor: null };
  }
  const [totalCount, rows] = await Promise.all([
    workItemRepository.countProjectIssues(projectId, ctx.workspaceId, { statuses: statusKeys }),
    workItemRepository.findColumnCards(
      projectId,
      ctx.workspaceId,
      statusKeys,
      terminal ? 'recent' : 'position',
      {
        limit: BOARD_COLUMN_PAGE_SIZE,
        offset: 0,
      },
    ),
  ]);
  return {
    col,
    statusKeys,
    rows,
    totalCount,
    cursor: nextCursor(0, BOARD_COLUMN_PAGE_SIZE, totalCount, terminal),
  };
}

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

/** Lane order for the `priority` group-by — Jira shows highest severity first;
 * the catch-all does not apply (priority is non-null). */
const PRIORITY_LANE_ORDER = ['highest', 'high', 'medium', 'low', 'lowest'];

/**
 * Resolve each loaded card's `swimlaneKey` under the active group-by (Subtask
 * 3.3.4), so the client never re-derives lane membership: `assignee` → the
 * card's `assigneeId` (or the catch-all sentinel when unassigned); `priority` →
 * the priority value; `epic` → the card's NEAREST ANCESTOR epic id (or the
 * catch-all when it has none). Returns an EMPTY map for `none` — the flat board
 * stamps no key (the mapper then omits the field). assignee/priority read
 * straight off the loaded row (no query); epic needs ONE bounded recursive walk
 * over the loaded ids (no N+1).
 */
async function resolveSwimlaneKeys(
  groupBy: BoardSwimlaneGroupByDto,
  rows: WorkItem[],
  ctx: ServiceContext,
): Promise<Map<string, string>> {
  const keyByCard = new Map<string, string>();
  if (groupBy === 'none' || rows.length === 0) return keyByCard;
  if (groupBy === 'assignee') {
    for (const r of rows) keyByCard.set(r.id, r.assigneeId ?? BOARD_SWIMLANE_NO_VALUE);
  } else if (groupBy === 'priority') {
    for (const r of rows) keyByCard.set(r.id, r.priority);
  } else {
    const pairs = await workItemRepository.findEpicAncestors(
      rows.map((r) => r.id),
      ctx.workspaceId,
    );
    const epicByCard = new Map(pairs.map((p) => [p.cardId, p.epicId]));
    for (const r of rows) keyByCard.set(r.id, epicByCard.get(r.id) ?? BOARD_SWIMLANE_NO_VALUE);
  }
  return keyByCard;
}

/**
 * Build the ordered lane list for the board (Subtask 3.3.4) from a BOUNDED
 * grouped aggregate over the board's cards — lanes-with-cards + the catch-all,
 * NEVER a per-card fetch (finding #57). `statusKeys` is the union of the
 * board's mapped column statuses (the card population). Lane order: assignee by
 * display name (alpha), priority by severity rank, epic by epic `position`; the
 * catch-all (unassigned / no epic) always sorts LAST. `none` → no lanes.
 */
async function buildSwimlanes(
  groupBy: BoardSwimlaneGroupByDto,
  projectId: string,
  statusKeys: string[],
  ctx: ServiceContext,
): Promise<BoardSwimlaneDto[]> {
  if (groupBy === 'none' || statusKeys.length === 0) return [];

  if (groupBy === 'assignee') {
    const rows = await workItemRepository.aggregateBoardLanesByAssignee(
      projectId,
      ctx.workspaceId,
      statusKeys,
    );
    const assigneeIds = rows.map((r) => r.assigneeId).filter((id): id is string => id !== null);
    const users = await userRepository.findByIds(assigneeIds);
    const nameById = new Map(users.map((u) => [u.id, u.name?.trim() || u.email]));
    const lanes: BoardSwimlaneDto[] = rows
      .filter((r) => r.assigneeId !== null)
      .map((r) => ({
        key: r.assigneeId as string,
        label: nameById.get(r.assigneeId as string) ?? 'Unknown user',
        kind: 'assignee' as const,
        count: r.count,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const unassigned = rows.find((r) => r.assigneeId === null);
    if (unassigned) {
      lanes.push({
        key: BOARD_SWIMLANE_NO_VALUE,
        label: 'No assignee',
        kind: 'assignee',
        count: unassigned.count,
      });
    }
    return lanes;
  }

  if (groupBy === 'priority') {
    const rows = await workItemRepository.aggregateBoardLanesByPriority(
      projectId,
      ctx.workspaceId,
      statusKeys,
    );
    return rows
      .map((r) => ({
        key: r.priority as string,
        label: r.priority as string,
        kind: 'priority' as const,
        count: r.count,
      }))
      .sort((a, b) => PRIORITY_LANE_ORDER.indexOf(a.key) - PRIORITY_LANE_ORDER.indexOf(b.key));
  }

  // epic — group by ancestor epic; the catch-all count is DERIVED by
  // subtraction (total board cards − Σ epic-lane counts), so no extra per-card
  // scan is needed to size the "No epic" lane.
  const rows = await workItemRepository.aggregateBoardLanesByEpic(
    projectId,
    ctx.workspaceId,
    statusKeys,
  );
  const epics = await workItemRepository.findByIds(rows.map((r) => r.epicId));
  const epicById = new Map(epics.map((e) => [e.id, e]));
  const lanes: BoardSwimlaneDto[] = rows
    .map((r) => {
      const epic = epicById.get(r.epicId);
      return {
        lane: {
          key: r.epicId,
          label: epic ? `${epic.identifier} ${epic.title}` : 'Epic',
          kind: 'epic' as const,
          count: r.count,
        },
        position: epic?.position ?? '',
      };
    })
    .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
    .map((x) => x.lane);

  const epicCardCount = rows.reduce((sum, r) => sum + r.count, 0);
  const total = await workItemRepository.countProjectIssues(projectId, ctx.workspaceId, {
    statuses: statusKeys,
  });
  const noEpicCount = total - epicCardCount;
  if (noEpicCount > 0) {
    lanes.push({
      key: BOARD_SWIMLANE_NO_VALUE,
      label: 'No epic',
      kind: 'epic',
      count: noEpicCount,
    });
  }
  return lanes;
}
