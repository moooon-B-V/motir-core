import { Prisma, BoardSwimlaneGroupBy, BoardType } from '@prisma/client';
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
import { keyBetween, keyForAppend } from '@/lib/workItems/positioning';
import { isOwnerRole } from '@/lib/workspaces/roles';
import { toWorkflowStatusDto } from '@/lib/mappers/workflowMappers';
import {
  toBoardCardDto,
  toBoardColumnConfigDto,
  toBoardColumnStatusDto,
  toBoardDto,
  toBoardSummaryDto,
} from '@/lib/mappers/boardMappers';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { buildDefaultBoard, DEFAULT_BOARD_NAME } from '@/lib/boards/defaultBoard';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { BOARD_SWIMLANE_NO_VALUE } from '@/lib/dto/boards';
import type {
  BoardColumnConfigDto,
  BoardColumnDto,
  BoardColumnStatusDto,
  BoardDto,
  BoardProjectionDto,
  BoardSummaryDto,
  BoardSwimlaneDto,
  BoardSwimlaneGroupByDto,
  BoardTypeDto,
  MoveCardResultDto,
  MoveCardTarget,
} from '@/lib/dto/boards';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  BoardColumnNotFoundError,
  BoardNotFoundError,
  ColumnNotEmptyError,
  IllegalBoardMoveError,
  InvalidBoardNameError,
  InvalidBoardTypeError,
  InvalidColumnNameError,
  InvalidColumnPositionError,
  InvalidSwimlaneGroupByError,
  InvalidWipLimitError,
  LastBoardError,
  LastColumnError,
  NotBoardAdminError,
  StatusMappingConflictError,
  UnmappedColumnTargetError,
} from '@/lib/boards/errors';
import { IllegalTransitionError, WorkItemNotFoundError } from '@/lib/workItems/errors';
import { WorkflowStatusNotFoundError } from '@/lib/workflows/errors';

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
    // The seeded board is the project's DEFAULT (Story 3.7.2 — the one
    // `/boards` opens when no `?board=` is given) and takes the first
    // fractional-index position. `keyForAppend(null)` mints the same `a0` the
    // migration backfills onto pre-3.7 boards, so a seeded board and a migrated
    // board carry identical initial state. The partial unique index guarantees
    // this stays the project's only default until 3.7.3's `setDefaultBoard`.
    // Name/type are the constant default (`DEFAULT_BOARD_NAME` / kanban), so no
    // status read is needed for the board row itself.
    const board = await boardRepository.create(
      {
        workspaceId,
        projectId,
        name: DEFAULT_BOARD_NAME,
        type: BoardType.kanban,
        isDefault: true,
        position: keyForAppend(null),
      },
      tx,
    );
    await seedColumnsForBoard(board.id, projectId, workspaceId, tx);
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
   * The board READ projection (Subtask 3.1.4, load model corrected by 3.8.2) —
   * turn a project's default board + workflow + issues into the column-of-cards
   * shape the 3.2 UI renders, the **mirror-faithful** way: the board loads the
   * **whole bounded set** (NOT a per-column first page + cursor), bounded by a
   * **board-level cap** (`BOARD_ISSUE_CAP`) with a **Done-age window** trimming
   * terminal columns, and the client virtualizes the render. This is still
   * BOUNDED (the cap is the bound; never "load every row", finding #57) — it just
   * drops the per-column "Load more" the mirror product (Jira) never had
   * (`notes.html` mistake #33).
   *
   * For each column it returns the column meta, its mapped status keys, the FULL
   * card count (`totalCount`, the denominator — unaffected by the Done-age
   * window), and the column's bounded card set (ranked by `position`, or by
   * recency + windowed to the last ~14 days for a terminal/done column). At the
   * board level it returns `cap` (the bound) and `truncated` — true exactly when
   * the board's total card count exceeds the cap, so the 3.8.4 UI shows the
   * "refine the filter" banner. Plus a top-level `unmappedStatuses` — every
   * project status mapped to NO column (Jira's behaviour: surfaced, never
   * dropped). Read-only: no transaction; the explicit `workspaceId` gate
   * (finding #26) is carried into every repo read.
   *
   * Board SELECTION (Subtask 3.7.5): `boardId` picks WHICH of the project's
   * boards to project. Absent → the project's DEFAULT board (`isDefault`, the
   * board `/boards` opens with no `?board=`). Present → that board, but ONLY if
   * it belongs to the active project AND workspace — `findById` scopes by
   * `workspaceId` (a cross-WORKSPACE id returns null), and we additionally
   * reject a cross-PROJECT id (right workspace, wrong project). Either miss is a
   * `BoardNotFoundError` (404), so a stale / forged `?board=` is tenant-safe,
   * never a cross-project leak.
   *
   * Throws `BoardNotFoundError` (404) when the project has no default board yet
   * (a project predating the 3.1.2 seed/backfill — the 3.2 UI shows its no-board
   * state) or when a named `boardId` is not a board of the active project.
   */
  async getBoard(
    projectId: string,
    ctx: ServiceContext,
    boardId?: string,
  ): Promise<BoardProjectionDto> {
    const board = boardId
      ? await boardRepository.findById(boardId, ctx.workspaceId)
      : await boardRepository.findDefaultForProject(projectId, ctx.workspaceId);
    // A selected board must live in the active project (the workspace gate is
    // already in the repo read); the default lookup is project-scoped by query.
    if (!board || board.projectId !== projectId) {
      throw new BoardNotFoundError(boardId ?? `default board for project ${projectId}`);
    }

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

    // Build each column's full count + bounded card set (per-column, NOT per-card
    // — bounded by the board cap, so no N+1 over cards). Terminal columns are
    // windowed to issues touched within the Done-age window (3.8.2).
    const doneSince = doneAgeCutoff();
    const built = await Promise.all(
      columns.map((col) => {
        const live = (liveByColumn.get(col.id) ?? []).slice().sort(byPosition);
        const statusKeys = live.map((s) => s.key);
        const terminal = isTerminalColumn(statusKeys, terminalKeys);
        return buildColumnCards(projectId, col, statusKeys, terminal, doneSince, ctx);
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
    // byte-for-byte the 3.1.4 shape). The board TOTAL (over the same status
    // union) is the truncation denominator: `truncated` when it exceeds the cap.
    const groupBy = board.swimlaneGroupBy as BoardSwimlaneGroupByDto;
    const boardStatusKeys = [...new Set(built.flatMap((b) => b.statusKeys))];
    const [swimlaneKeyByCard, swimlanes, boardTotal] = await Promise.all([
      resolveSwimlaneKeys(groupBy, allRows, ctx),
      buildSwimlanes(groupBy, projectId, boardStatusKeys, ctx),
      boardStatusKeys.length
        ? workItemRepository.countProjectIssues(projectId, ctx.workspaceId, {
            statuses: boardStatusKeys,
          })
        : Promise.resolve(0),
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
      // Retired in 3.8.2: the board loads the whole bounded set, never a paged
      // window, so there is no "next page". The field stays (always null) until
      // 3.8.3 / 3.8.5 strip it with the UI's load-more plumbing.
      cursor: null,
    }));

    return {
      boardId: board.id,
      name: board.name,
      type: board.type as BoardTypeDto,
      swimlaneGroupBy: groupBy,
      columns: columnsDto,
      swimlanes,
      unmappedStatuses: statuses.filter((s) => !mappedStatusIds.has(s.id)),
      cap: BOARD_ISSUE_CAP,
      truncated: boardTotal > BOARD_ISSUE_CAP,
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

  // ── Column / board ADMIN writes (Subtask 3.6.2) ────────────────────────────
  // The board-configuration admin surface (Story 3.6): add / rename / reorder /
  // delete a column, map / unmap a status onto a column, rename the board. Each
  // extends the 3.3 config seam — same order (resolve + tenant-gate 404 →
  // owner-authorize 403 → validate 400 → write under withWorkspaceContext so
  // the FORCE-RLS WITH CHECK passes), same `assertBoardConfigAdmin` gate, same
  // scalar-FK `Unchecked` writes (finding #33). NO new table, NO migration —
  // pure config over the Story-3.1 schema. A card's column is always DERIVED
  // from its `work_item.status`, so NONE of these writes ever touch a work item.

  /**
   * Add a column to a board (Subtask 3.6.2). Appends to the end of the board's
   * columns unless an explicit `position` (a fractional-index key the client
   * mints to insert at a spot) is given — mirrors `workflowsService.createStatus`'s
   * append. Returns the new column's config DTO.
   *
   * Throws: `BoardNotFoundError` (404), `NotBoardAdminError` (403),
   * `InvalidColumnNameError` (400).
   */
  async addColumn(
    boardId: string,
    input: { name: string; position?: string },
    ctx: ServiceContext,
  ): Promise<BoardColumnConfigDto> {
    const board = await boardRepository.findById(boardId, ctx.workspaceId);
    if (!board) throw new BoardNotFoundError(boardId);
    await assertBoardConfigAdmin(ctx.userId, board.projectId, ctx.workspaceId);

    const name = input.name?.trim();
    if (!name) throw new InvalidColumnNameError();

    let position = input.position;
    if (position == null) {
      const columns = await boardColumnRepository.findByBoard(boardId, ctx.workspaceId);
      const last = columns.length ? columns[columns.length - 1]!.position : null;
      position = keyForAppend(last);
    }

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) =>
        boardColumnRepository.create(
          { workspaceId: ctx.workspaceId, projectId: board.projectId, boardId, name, position },
          tx,
        ),
    );
    return toBoardColumnConfigDto(row);
  },

  /**
   * Rename a board column (Subtask 3.6.2). The column row carries its scalar
   * `projectId` (3.1.3) so the admin gate needs no extra board read, exactly
   * like `setColumnWipLimit`. Returns the updated column config DTO.
   *
   * Throws: `BoardColumnNotFoundError` (404), `NotBoardAdminError` (403),
   * `InvalidColumnNameError` (400).
   */
  async renameColumn(
    columnId: string,
    name: string,
    ctx: ServiceContext,
  ): Promise<BoardColumnConfigDto> {
    const column = await boardColumnRepository.findById(columnId, ctx.workspaceId);
    if (!column) throw new BoardColumnNotFoundError(columnId);
    await assertBoardConfigAdmin(ctx.userId, column.projectId, ctx.workspaceId);

    const trimmed = name?.trim();
    if (!trimmed) throw new InvalidColumnNameError();

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => boardColumnRepository.update(columnId, { name: trimmed }, tx),
    );
    return toBoardColumnConfigDto(row);
  },

  /**
   * Reorder a board column (Subtask 3.6.2). `position` is the opaque
   * fractional-index sort key the client mints strictly between the two
   * neighbours it dropped the column between (the SAME rank scheme work items /
   * statuses use, `lib/workItems/positioning.ts`) — a reorder is a single-row
   * rewrite needing no cascade, mirroring the status-reorder path
   * (`updateStatus({ position })`). Returns the updated column config DTO.
   *
   * Throws: `BoardColumnNotFoundError` (404), `NotBoardAdminError` (403),
   * `InvalidColumnPositionError` (400).
   */
  async reorderColumn(
    columnId: string,
    position: string,
    ctx: ServiceContext,
  ): Promise<BoardColumnConfigDto> {
    const column = await boardColumnRepository.findById(columnId, ctx.workspaceId);
    if (!column) throw new BoardColumnNotFoundError(columnId);
    await assertBoardConfigAdmin(ctx.userId, column.projectId, ctx.workspaceId);

    if (typeof position !== 'string' || position.length === 0) {
      throw new InvalidColumnPositionError();
    }

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => boardColumnRepository.update(columnId, { position }, tx),
    );
    return toBoardColumnConfigDto(row);
  },

  /**
   * Delete a board column (Subtask 3.6.2). Two guards, both decided from the
   * mirror product (Jira board settings → Columns, decision-authority rung 1):
   *   - `LastColumnError` (409) — a board must keep ≥1 column (Jira never lets
   *     you delete down to zero columns).
   *   - `ColumnNotEmptyError` (409) — refuse while a mapped status still holds
   *     work items on the board ("you can't delete a column with issues"); the
   *     admin remaps those statuses elsewhere first.
   * When it proceeds, it unmaps the column's statuses (they return to
   * `unmappedStatuses` — the 3.2.6 tray) and deletes the `board_column` row, in
   * ONE transaction. It NEVER deletes a work item (a card's column is derived
   * from its `work_item.status`). NOTE: it does NOT specially guard a column
   * mapping the INITIAL status — Story 3.1 deliberately ALLOWS an unmapped
   * status (it surfaces in the tray, its issues simply hidden from the board),
   * so an initial-status guard would contradict that shipped decision (rung 2).
   *
   * Throws: `BoardColumnNotFoundError` (404), `NotBoardAdminError` (403),
   * `LastColumnError` (409), `ColumnNotEmptyError` (409).
   */
  async deleteColumn(columnId: string, ctx: ServiceContext): Promise<void> {
    const column = await boardColumnRepository.findById(columnId, ctx.workspaceId);
    if (!column) throw new BoardColumnNotFoundError(columnId);
    await assertBoardConfigAdmin(ctx.userId, column.projectId, ctx.workspaceId);

    // The project's statuses are stable w.r.t. this op (deleteColumn never
    // touches the workflow), so resolve them once outside the tx; the column
    // mappings + counts are read INSIDE the tx, after the lock.
    const statuses = await workflowsService.listStatusesByProject(
      column.projectId,
      ctx.workspaceId,
    );
    const statusById = new Map(statuses.map((s) => [s.id, s]));

    await withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
      // Lock the board row so concurrent column adds/deletes on this board
      // serialize — without it two deletes of DIFFERENT columns each read
      // `count == 2`, both pass the last-column guard, and the board is zeroed
      // out (the TOCTOU on the ≥1-column invariant). The not-empty guard's race
      // against a card transitioning INTO the column mid-delete stays
      // best-effort (work-item writes don't touch the board row, so no lock can
      // serialize them) — but that race only UNMAPS a card (it returns to the
      // tray), never loses it, matching Jira's config-vs-issue separation.
      await boardRepository.lockById(column.boardId, ctx.workspaceId, tx);

      // Re-read the board's columns under the lock. A concurrent delete of THIS
      // column (resolved before the lock) leaves it absent now → 404.
      const columns = await boardColumnRepository.findByBoard(column.boardId, ctx.workspaceId, tx);
      if (!columns.some((c) => c.id === columnId)) throw new BoardColumnNotFoundError(columnId);
      // Last-column guard — a board must keep at least one column.
      if (columns.length <= 1) throw new LastColumnError();

      // Not-empty guard — refuse if any of the column's mapped (live) statuses
      // still holds non-archived work items on the board.
      const mappings = await boardColumnStatusRepository.findByColumn(
        columnId,
        ctx.workspaceId,
        tx,
      );
      const statusKeys = mappings
        .map((m) => statusById.get(m.statusId))
        .filter((s): s is WorkflowStatusDto => s != null)
        .map((s) => s.key);
      if (statusKeys.length > 0) {
        const cardCount = await workItemRepository.countProjectIssues(
          column.projectId,
          ctx.workspaceId,
          { statuses: statusKeys },
          tx,
        );
        if (cardCount > 0) throw new ColumnNotEmptyError(columnId, cardCount);
      }

      // Unmap the column's statuses (back to the tray), then drop the column.
      await boardColumnStatusRepository.deleteByColumn(columnId, tx);
      await boardColumnRepository.delete(columnId, tx);
    });
  },

  /**
   * Map (or MOVE) a workflow status onto a board column (Subtask 3.6.2). The
   * mapping table carries `@@unique([boardId, statusId])` (3.1.1) — a status
   * lives in AT MOST ONE column per board — so this is a MOVE, not a duplicate:
   * in ONE transaction it deletes any existing mapping for the status on this
   * board (`deleteByStatus`) then creates the new edge (`create`). Re-mapping a
   * status therefore REPLACES its row; a P2002 backstop covers the concurrent
   * race (mirrors `createStatus`). Returns the new mapping edge DTO.
   *
   * The status must belong to the board's project (else nothing to map);
   * the column must belong to this board.
   *
   * Throws: `BoardNotFoundError` / `BoardColumnNotFoundError` (404),
   * `WorkflowStatusNotFoundError` (404), `NotBoardAdminError` (403),
   * `StatusMappingConflictError` (409).
   */
  async mapStatusToColumn(
    boardId: string,
    columnId: string,
    statusId: string,
    ctx: ServiceContext,
  ): Promise<BoardColumnStatusDto> {
    const board = await boardRepository.findById(boardId, ctx.workspaceId);
    if (!board) throw new BoardNotFoundError(boardId);
    await assertBoardConfigAdmin(ctx.userId, board.projectId, ctx.workspaceId);

    const column = await boardColumnRepository.findById(columnId, ctx.workspaceId);
    if (!column || column.boardId !== boardId) throw new BoardColumnNotFoundError(columnId);

    const status = await workflowsRepository.findStatusById(statusId, ctx.workspaceId);
    if (!status || status.projectId !== board.projectId) {
      throw new WorkflowStatusNotFoundError(statusId);
    }

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        // MOVE-not-duplicate: drop any existing column for this status on this
        // board, then create the new edge — both in this one transaction so the
        // unique invariant never sees two rows.
        await boardColumnStatusRepository.deleteByStatus(boardId, statusId, tx);
        try {
          return await boardColumnStatusRepository.create(
            {
              workspaceId: ctx.workspaceId,
              projectId: board.projectId,
              boardId,
              columnId,
              statusId,
            },
            tx,
          );
        } catch (err) {
          /* istanbul ignore next -- defensive: P2002 only fires when a concurrent map of the same (boardId, statusId) commits between this tx's delete and create; not deterministically testable (mirrors createStatus's P2002 guard) */
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw new StatusMappingConflictError(statusId);
          }
          /* istanbul ignore next -- defensive rethrow: the only expected write error here is the P2002 handled above */
          throw err;
        }
      },
    );
    return toBoardColumnStatusDto(row);
  },

  /**
   * Unmap a workflow status from the board (Subtask 3.6.2) — delete its
   * `board_column_status` edge so the status returns to `unmappedStatuses` (the
   * 3.2.6 tray); its work items are simply hidden from the board, never deleted.
   * Idempotent: unmapping a status that is already unmapped (0 rows) is a no-op
   * success — the desired end-state (not mapped) holds either way, so there is
   * no 404 for an already-unmapped / unknown status (the board + admin gates
   * already bound the operation to this workspace).
   *
   * Throws: `BoardNotFoundError` (404), `NotBoardAdminError` (403).
   */
  async unmapStatus(boardId: string, statusId: string, ctx: ServiceContext): Promise<void> {
    const board = await boardRepository.findById(boardId, ctx.workspaceId);
    if (!board) throw new BoardNotFoundError(boardId);
    await assertBoardConfigAdmin(ctx.userId, board.projectId, ctx.workspaceId);

    await withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, (tx) =>
      boardColumnStatusRepository.deleteByStatus(boardId, statusId, tx),
    );
  },

  /**
   * Rename a board (Subtask 3.6.2). Same gate + order as `setSwimlaneGroupBy`;
   * returns the updated board config DTO so the 3.6.3 UI reconciles.
   *
   * Throws: `BoardNotFoundError` (404), `NotBoardAdminError` (403),
   * `InvalidBoardNameError` (400).
   */
  async renameBoard(boardId: string, name: string, ctx: ServiceContext): Promise<BoardDto> {
    const board = await boardRepository.findById(boardId, ctx.workspaceId);
    if (!board) throw new BoardNotFoundError(boardId);
    await assertBoardConfigAdmin(ctx.userId, board.projectId, ctx.workspaceId);

    const trimmed = name?.trim();
    if (!trimmed) throw new InvalidBoardNameError();

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => boardRepository.update(boardId, { name: trimmed }, tx),
    );
    return toBoardDto(row);
  },

  // ── Board LIFECYCLE writes (Subtask 3.7.3) — the multi-board CRUD path:
  // create (seed columns) / set-default / delete (rename is 3.6.2's
  // `renameBoard` above, reused as-is). Same admin gate + write convention as
  // the config writes: resolve + tenant-gate (404) → owner-authorize (403) →
  // validate (400) → write under `withWorkspaceContext` so the FORCE-RLS WITH
  // CHECK passes; scalar-FK `Unchecked` writes (finding #33). A board's CRUD is
  // a project-config write, so it rides the SAME `assertBoardConfigAdmin`
  // (workspace-OWNER) gate the rest of board admin uses — see the gate's note
  // on the card-vs-shipped resolution (the 3.7.3 card said "membership-gated",
  // but the shipped board-config precedent + Jira both gate board admin to
  // admins, so the consistent build is the owner gate; `// TODO(6.4)` widens it
  // to the project-admin role). Issues are NEVER touched by any of these — a
  // card's column is derived from `work_item.status`, and issues belong to the
  // PROJECT, not a board.

  /**
   * List a project's boards in switcher order (Subtask 3.7.3) — the `GET
   * /api/boards` read behind the 3.7.4 switcher. A plain read available to any
   * workspace member (NOT owner-gated — viewing the board switcher is not a
   * config write; the explicit `workspaceId` filter is the tenant gate, finding
   * #26). Returns the boards as switcher DTOs (id / name / type / isDefault /
   * position), ordered by `position`.
   */
  async listBoards(projectId: string, ctx: ServiceContext): Promise<BoardSummaryDto[]> {
    const boards = await boardRepository.findByProjectByPosition(projectId, ctx.workspaceId);
    return boards.map(toBoardSummaryDto);
  },

  /**
   * Create a new (non-default) board on a project (Subtask 3.7.3) and seed its
   * default columns off the project workflow (REUSE the 3.1 board-bootstrap, so
   * a new board is immediately usable). The board appends to the end of the
   * switcher (`position` after the last board); it is NOT the default (the
   * project keeps its existing default — set this one default via
   * `setDefaultBoard`). `type` defaults to `kanban` (the only UI option until
   * the Scrum board, Story 4.5) but is validated against the SHIPPED `BoardType`
   * enum (rung 2) so the check stays total. Returns the new board's switcher DTO.
   *
   * Throws: `ProjectNotFoundError` (404 — unknown / cross-workspace project),
   * `NotBoardAdminError` (403), `InvalidBoardNameError` (400),
   * `InvalidBoardTypeError` (400).
   */
  async createBoard(
    projectId: string,
    input: { name: string; type?: string },
    ctx: ServiceContext,
  ): Promise<BoardSummaryDto> {
    // Resolve + tenant-gate the project AND owner-authorize in one call (the
    // gate 404s a foreign projectId before any membership probe).
    await assertBoardConfigAdmin(ctx.userId, projectId, ctx.workspaceId);

    const name = input.name?.trim();
    if (!name) throw new InvalidBoardNameError();
    const type = input.type ?? BoardType.kanban;
    if (!isBoardType(type)) throw new InvalidBoardTypeError(String(type));

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        // Append after the last board by position (the switcher order).
        const boards = await boardRepository.findByProjectByPosition(
          projectId,
          ctx.workspaceId,
          tx,
        );
        const last = boards.length ? boards[boards.length - 1]!.position : null;
        const board = await boardRepository.create(
          {
            workspaceId: ctx.workspaceId,
            projectId,
            name,
            type,
            isDefault: false,
            position: keyForAppend(last),
          },
          tx,
        );
        await seedColumnsForBoard(board.id, projectId, ctx.workspaceId, tx);
        return board;
      },
    );
    return toBoardSummaryDto(row);
  },

  /**
   * Make a board the project's DEFAULT (Subtask 3.7.3) — the board `/boards`
   * opens when no `?board=` is given. Flips the project's default in ONE
   * transaction: clear the prior default, then set this board — the order the
   * partial unique index `board_one_default_per_project` (`WHERE is_default`)
   * requires (two `is_default = true` rows for a project are rejected, so the
   * clear must precede the set). A no-op (returns the board unchanged) when it is
   * already the default. Returns the now-default board's switcher DTO.
   *
   * Throws: `BoardNotFoundError` (404), `NotBoardAdminError` (403).
   */
  async setDefaultBoard(boardId: string, ctx: ServiceContext): Promise<BoardSummaryDto> {
    const board = await boardRepository.findById(boardId, ctx.workspaceId);
    if (!board) throw new BoardNotFoundError(boardId);
    await assertBoardConfigAdmin(ctx.userId, board.projectId, ctx.workspaceId);

    // Already the default → no write (and the clear-then-set below would be a
    // wasteful self-flip).
    if (board.isDefault) return toBoardSummaryDto(board);

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        await boardRepository.clearDefaultForProject(board.projectId, ctx.workspaceId, tx);
        return boardRepository.update(boardId, { isDefault: true }, tx);
      },
    );
    return toBoardSummaryDto(row);
  },

  /**
   * Delete a board (Subtask 3.7.3). Removes the board + its column/config rows
   * (the FK `onDelete: Cascade` tears down `board_column` + `board_column_status`);
   * the project's ISSUES are untouched (they belong to the project, and still
   * show on the remaining boards). Two guards, both from the mirror product
   * (rung 1) + the board analogue of `deleteColumn`'s guards:
   *   - `LastBoardError` (409) — a project must keep ≥1 board (the last board
   *     can't be deleted — there'd be no board to open).
   *   - deleting the **default** PROMOTES the next board by position to default,
   *     so the project never ends up with no default.
   * Runs under a project-wide `FOR UPDATE` lock so two concurrent deletes of
   * different boards serialize (closing the TOCTOU on the ≥1-board invariant —
   * the board analogue of `deleteColumn`'s board-row lock).
   *
   * Throws: `BoardNotFoundError` (404), `NotBoardAdminError` (403),
   * `LastBoardError` (409).
   */
  async deleteBoard(boardId: string, ctx: ServiceContext): Promise<void> {
    const board = await boardRepository.findById(boardId, ctx.workspaceId);
    if (!board) throw new BoardNotFoundError(boardId);
    await assertBoardConfigAdmin(ctx.userId, board.projectId, ctx.workspaceId);

    await withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
      // Lock the project's boards so concurrent deletes serialize — without it
      // two deletes of DIFFERENT boards in a 2-board project each read
      // `length == 2`, both pass the last-board guard, and the project is
      // zeroed out (the TOCTOU on the ≥1-board invariant).
      await boardRepository.lockByProject(board.projectId, ctx.workspaceId, tx);

      // Re-read under the lock, in switcher (position) order. A concurrent
      // delete of THIS board (resolved before the lock) leaves it absent → 404.
      const boards = await boardRepository.findByProjectByPosition(
        board.projectId,
        ctx.workspaceId,
        tx,
      );
      const target = boards.find((b) => b.id === boardId);
      if (!target) throw new BoardNotFoundError(boardId);
      // Last-board guard — a project must keep at least one board.
      if (boards.length <= 1) throw new LastBoardError();

      // Delete the board first (cascade drops its columns + mappings); doing
      // it BEFORE promoting keeps the partial unique index satisfied (the
      // default row is gone, so setting another default can't collide).
      await boardRepository.delete(boardId, tx);

      // Promote the next board (lowest remaining position) to default if we
      // just deleted the default — never leave the project without one.
      if (target.isDefault) {
        const next = boards.find((b) => b.id !== boardId)!;
        await boardRepository.update(next.id, { isDefault: true }, tx);
      }
    });
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

/**
 * Seed a board's default columns off its project's workflow (Subtask 3.1.2 core,
 * SHARED by 3.7.3's `createBoard`). One column per workflow status in
 * `status.position` order, each mapped to its single status — the column-from-
 * workflow projection over the durable many-to-one mapping (3.1.1), NOT a
 * hardcoded 1:1. Reads the statuses through the SAME `tx` (a brand-new project's
 * statuses aren't visible outside the createProject tx yet; an existing
 * project's are stable), then resolves each column's status `key → id`. Rows
 * carry the SCALAR workspaceId/projectId (finding #33). The board row itself is
 * created by the caller (with its own default-ness + position); this only writes
 * the columns + mappings.
 */
async function seedColumnsForBoard(
  boardId: string,
  projectId: string,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const statuses = await workflowsRepository.findStatuses(projectId, workspaceId, tx);
  const statusIdByKey = new Map(statuses.map((s) => [s.key, s.id]));
  const spec = buildDefaultBoard(statuses.map(toWorkflowStatusDto));

  for (const col of spec.columns) {
    const column = await boardColumnRepository.create(
      { workspaceId, projectId, boardId, name: col.name, position: col.position },
      tx,
    );
    for (const key of col.statusKeys) {
      const statusId = statusIdByKey.get(key);
      // Unreachable — buildDefaultBoard only emits keys drawn from `statuses`;
      // the guard turns a future projection bug into a clear failure instead of
      // a Prisma null-FK error (mirrors seedDefaultWorkflow's guard).
      if (!statusId) {
        throw new Error(`defaultBoard: column "${col.name}" maps an unknown status key "${key}"`);
      }
      await boardColumnStatusRepository.create(
        { workspaceId, projectId, boardId, columnId: column.id, statusId },
        tx,
      );
    }
  }
}

/** True iff `value` is one of the `BoardType` enum values (`kanban` / `scrum`). */
function isBoardType(value: string): value is BoardType {
  return (Object.values(BoardType) as string[]).includes(value);
}

/** True iff `value` is one of the `BoardSwimlaneGroupBy` enum values. */
function isSwimlaneGroupBy(value: string): value is BoardSwimlaneGroupBy {
  return (Object.values(BoardSwimlaneGroupBy) as string[]).includes(value);
}

/** True iff `limit` is `null` (clear) or a non-negative integer. */
function isValidWipLimit(limit: number | null): boolean {
  return limit === null || (Number.isInteger(limit) && limit >= 0);
}

/**
 * The board-level issue cap (Subtask 3.8.2) — the GENEROUS bound the board loads
 * up to, the mirror-faithful replacement for per-column "Load more" (Jira loads
 * its whole saved-filter set up to 5,000 Software / 3,000 Business; this is the
 * Software figure). It is the bound, NOT a page size: there is no "next page",
 * the board loads up to the cap and stops, and `truncated` flags the rare board
 * that exceeds it (the 3.8.4 over-cap banner then points at the Epic-6 filter
 * seam). A real team's active board fits comfortably under it. Still
 * finding-#57-bounded (the cap IS the bound), the opposite of "load all rows".
 */
export const BOARD_ISSUE_CAP = 5000;

/**
 * Done-age window (Subtask 3.8.2) — terminal (done / cancelled) columns load
 * only issues touched within the last ~14 days, the age-based shape Jira uses
 * (it hides done issues older than ~14 days). Lacking a `completedAt` column we
 * window by `updatedAt`; the FULL count is still surfaced (`totalCount`), so the
 * header denominator is unchanged. This refines 3.2.5's count-based window to
 * the age-based behaviour.
 */
export const DONE_AGE_WINDOW_DAYS = 14;

/** The cutoff instant for the Done-age window: now minus {@link DONE_AGE_WINDOW_DAYS}. */
function doneAgeCutoff(): Date {
  return new Date(Date.now() - DONE_AGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

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

/**
 * Build one column's projection (Subtask 3.8.2): its FULL card count + the
 * column's bounded card set (terminal columns ordered by recency and windowed to
 * the Done-age cutoff; others ranked by `position`), capped at the board-level
 * cap. No cursor — the whole bounded set loads at once (the client virtualizes).
 * `totalCount` is the full count (NOT windowed), so the header denominator is
 * unchanged. A column mapping no live status is an empty column.
 */
async function buildColumnCards(
  projectId: string,
  col: BoardColumn,
  statusKeys: string[],
  terminal: boolean,
  doneSince: Date,
  ctx: ServiceContext,
): Promise<{
  col: BoardColumn;
  statusKeys: string[];
  rows: WorkItem[];
  totalCount: number;
}> {
  if (statusKeys.length === 0) {
    return { col, statusKeys, rows: [], totalCount: 0 };
  }
  const [totalCount, rows] = await Promise.all([
    workItemRepository.countProjectIssues(projectId, ctx.workspaceId, { statuses: statusKeys }),
    workItemRepository.findColumnCards(
      projectId,
      ctx.workspaceId,
      statusKeys,
      terminal ? 'recent' : 'position',
      { limit: BOARD_ISSUE_CAP, updatedSince: terminal ? doneSince : undefined },
    ),
  ]);
  return { col, statusKeys, rows, totalCount };
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
