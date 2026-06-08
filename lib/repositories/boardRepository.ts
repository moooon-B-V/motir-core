import { Prisma, type Board } from '@prisma/client';
import { db } from '@/lib/db';

// Data access for the `board` table (Story 3.1 · Subtask 3.1.3). Single-
// Prisma-op leaves per CLAUDE.md — no business logic, no DTO mapping, no
// transactions. Named by its primary entity (`board`), not by call site.
//
// EVERY read carries an explicit `workspaceId` in its WHERE clause (finding
// #26): the board RLS policy is the DB-layer backstop but it is INERT under
// the dev/CI superuser (BYPASSRLS), so the explicit filter is the PRIMARY
// tenant gate. A cross-workspace read (right projectId, wrong workspaceId)
// therefore returns [] / null, not another tenant's rows.
//
// Reads take an optional `tx` (mirroring `workflowsRepository.findStatuses`):
// a read-only path passes nothing and uses the `db` singleton; a validation
// read inside a write (3.1.5's move path) passes its `tx` so the lookup runs
// in the same transaction. The write (`create`) requires `tx` — the default
// board is seeded inside `createProject`'s transaction (3.1.2).

export const boardRepository = {
  /**
   * A project's boards, ordered by `createdAt` (stable insertion order). v1
   * seeds exactly one board per project, so this returns a single-element
   * array today; the non-unique `board.projectId` FK lets it grow when
   * multi-board lands (post-v1) without a contract change.
   */
  async findByProject(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Board[]> {
    const client = tx ?? db;
    return client.board.findMany({
      where: { projectId, workspaceId },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * A project's boards in SWITCHER order (`position asc`, Subtask 3.7.3) — the
   * multi-board order the 3.7.4 switcher lists and the lifecycle service reads
   * to append a new board after the last position + to promote the next board
   * by position on a default delete. Hits the `(projectId, position)` composite
   * index (3.7.2). Distinct from `findByProject` (which orders by `createdAt`
   * for the legacy single-board reads); both carry the explicit `workspaceId`
   * gate (finding #26).
   */
  async findByProjectByPosition(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Board[]> {
    const client = tx ?? db;
    return client.board.findMany({
      where: { projectId, workspaceId },
      orderBy: { position: 'asc' },
    });
  },

  /**
   * The project's default board for the v1 single-board case, or null. Returns
   * the oldest board (`createdAt asc`) — the one `createProject` seeds — so a
   * future multi-board project still resolves the original default
   * deterministically. `findFirst` (not a unique lookup) because `projectId`
   * is deliberately non-unique and the `workspaceId` filter is part of the gate.
   */
  async findDefaultForProject(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Board | null> {
    const client = tx ?? db;
    return client.board.findFirst({
      where: { projectId, workspaceId },
      orderBy: { createdAt: 'asc' },
    });
  },

  /** One board by id, scoped to the workspace, or null. */
  async findById(
    boardId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Board | null> {
    const client = tx ?? db;
    return client.board.findFirst({ where: { id: boardId, workspaceId } });
  },

  /**
   * Lock the board row `FOR UPDATE` inside a transaction (Subtask 3.6.2 — the
   * column-config admin's lost-update guard). `deleteColumn` takes this lock so
   * two concurrent column deletes on the SAME board serialize, and the second
   * sees the first's decremented column count (closing the TOCTOU on the
   * last-column invariant). `tx` REQUIRED; the workspace filter keeps the lock
   * tenant-scoped (finding #26). Returns the locked row's id, or null if no
   * board matched (caller maps to a 404). Mirrors `workItemRepository.lockById`.
   */
  async lockById(
    boardId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "board" WHERE "id" = ${boardId} AND "workspace_id" = ${workspaceId} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * Lock ALL of a project's board rows `FOR UPDATE` (Subtask 3.7.3 — the
   * delete-board lost-update guard). `deleteBoard` takes this lock so two
   * concurrent deletes of DIFFERENT boards in the same project serialize: the
   * second blocks until the first commits, then re-reads and sees the
   * decremented board count (closing the TOCTOU on the ≥1-board invariant — the
   * board analogue of `lockById` guarding the ≥1-column invariant in
   * `deleteColumn`). `tx` REQUIRED; the workspace filter keeps the lock
   * tenant-scoped (finding #26). Returns the locked rows' ids (empty when the
   * project has no boards).
   */
  async lockByProject(
    projectId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string }>> {
    return tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "board" WHERE "project_id" = ${projectId} AND "workspace_id" = ${workspaceId} FOR UPDATE
    `;
  },

  // Write (3.1.2's default-board seed). `tx` is REQUIRED — the board is
  // persisted inside createProject's transaction so the project + its workflow
  // + its default board are atomic. The `Unchecked` create input takes the
  // SCALAR `workspaceId`/`projectId` FKs directly (not a relation `connect`):
  // under FORCE RLS a connect's validation SELECT on the parent could be
  // hidden by the parent's own policy — the scalar write avoids that, the same
  // lesson finding #33 recorded for the job-ledger / workflow writers.
  async create(
    data: Prisma.BoardUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<Board> {
    return tx.board.create({ data });
  },

  /** Update a board (the swimlane group-by config write — Subtask 3.3.3). `tx`
   * REQUIRED; the caller (boardsService.setSwimlaneGroupBy) has already tenant-
   * gated the board by id + workspaceId, so this is a plain id-keyed update. */
  async update(
    boardId: string,
    data: Prisma.BoardUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<Board> {
    return tx.board.update({ where: { id: boardId }, data });
  },

  /**
   * Clear the default flag on EVERY currently-default board of a project
   * (Subtask 3.7.3 — `setDefaultBoard`'s first write). The partial unique index
   * `board_one_default_per_project` (`WHERE is_default`) forbids two default
   * rows, so a default flip must clear the prior default BEFORE setting the new
   * one in the same transaction; this is that clear (a no-op `count: 0` when the
   * default was already deleted, e.g. the promote path). `tx` REQUIRED; the
   * workspace filter keeps it tenant-scoped. Returns the number of rows cleared.
   */
  async clearDefaultForProject(
    projectId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.board.updateMany({
      where: { projectId, workspaceId, isDefault: true },
      data: { isDefault: false },
    });
    return r.count;
  },

  /**
   * Delete a board row (Subtask 3.7.3 — `deleteBoard`). `tx` REQUIRED; the
   * caller has already tenant-gated + guarded the board (last-board / promote-
   * default) under a project-wide `FOR UPDATE` lock. The board's `board_column`
   * + `board_column_status` rows are removed by the FK `onDelete: Cascade`
   * (schema), so the card-less board config is fully torn down; work items are
   * NEVER touched (a card's column is derived from its `work_item.status`, and
   * issues belong to the project, not a board).
   */
  async delete(boardId: string, tx: Prisma.TransactionClient): Promise<Board> {
    return tx.board.delete({ where: { id: boardId } });
  },
};
