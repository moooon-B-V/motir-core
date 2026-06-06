import { Prisma, type BoardColumn } from '@prisma/client';
import { db } from '@/lib/db';

// Data access for the `board_column` table (Story 3.1 · Subtask 3.1.3).
// Single-Prisma-op leaves per CLAUDE.md — no business logic, no DTO mapping,
// no transactions. Named by its primary entity.
//
// Every read carries an explicit `workspaceId` in its WHERE clause (finding
// #26) — RLS is the backstop, the explicit filter is the primary gate under
// the BYPASSRLS dev/CI superuser. Columns are ordered by `position` (the
// opaque base-62 fractional-index String the `work_item` / `workflow_status`
// columns use — `lib/workItems/positioning.ts`); lexical String ordering is
// the fractional-index order, so `ORDER BY position ASC` is the column order.
//
// Writes (`create`, `update`) require `tx`: the default board's columns are
// seeded inside createProject's transaction (3.1.2), and the column rename /
// WIP-limit writes a later admin story uses are transactional too.

export const boardColumnRepository = {
  /** A board's columns in display order (`position asc`). */
  async findByBoard(
    boardId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<BoardColumn[]> {
    const client = tx ?? db;
    return client.boardColumn.findMany({
      where: { boardId, workspaceId },
      orderBy: { position: 'asc' },
    });
  },

  /**
   * Columns across MANY boards in ONE query — the batched read behind the
   * projection (3.1.4) so resolving columns for N boards is O(1) round-trips,
   * not N+1 (mirrors `workflowsRepository.findStatusesByProjects`). Ordered by
   * `(boardId, position)` so each board's columns arrive contiguous and in
   * display order; the caller groups by `boardId`. Empty `boardIds` short-
   * circuits to `[]` (no query).
   */
  async findByBoards(
    boardIds: string[],
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<BoardColumn[]> {
    if (boardIds.length === 0) return [];
    const client = tx ?? db;
    return client.boardColumn.findMany({
      where: { boardId: { in: boardIds }, workspaceId },
      orderBy: [{ boardId: 'asc' }, { position: 'asc' }],
    });
  },

  /** One column by id, scoped to the workspace, or null. */
  async findById(
    columnId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<BoardColumn | null> {
    const client = tx ?? db;
    return client.boardColumn.findFirst({ where: { id: columnId, workspaceId } });
  },

  // Writes. `tx` REQUIRED; scalar-FK `Unchecked` create input (finding #33 —
  // avoid a relation `connect`'s parent SELECT under FORCE RLS).
  async create(
    data: Prisma.BoardColumnUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<BoardColumn> {
    return tx.boardColumn.create({ data });
  },

  /** Update a column (rename / WIP-limit / reorder — a later admin story). */
  async update(
    columnId: string,
    data: Prisma.BoardColumnUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<BoardColumn> {
    return tx.boardColumn.update({ where: { id: columnId }, data });
  },
};
