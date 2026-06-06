import { Prisma, type BoardColumnStatus } from '@prisma/client';
import { db } from '@/lib/db';

// Data access for the `board_column_status` mapping table (Story 3.1 ·
// Subtask 3.1.3) — the column ↔ workflow-status edges. Single-Prisma-op
// leaves per CLAUDE.md — no business logic, no DTO mapping, no transactions.
//
// Every read carries an explicit `workspaceId` in its WHERE clause (finding
// #26): RLS is the backstop, the explicit filter is the primary gate under
// the BYPASSRLS dev/CI superuser. The projection (3.1.4) reads the full
// per-board mapping to bucket each status into its column; a status with no
// row here is UNMAPPED and surfaced separately, never columned.
//
// `create` requires `tx` (seeded inside createProject's transaction, 3.1.2);
// the `delete*` writes are the re-map primitives a later admin story (split /
// merge a column) uses, also transactional.

export const boardColumnStatusRepository = {
  /**
   * The full column→status mapping for a board (every edge), for the
   * projection to group statuses into columns. Unordered — the caller indexes
   * by `columnId` / `statusId`.
   */
  async findByBoard(
    boardId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<BoardColumnStatus[]> {
    const client = tx ?? db;
    return client.boardColumnStatus.findMany({ where: { boardId, workspaceId } });
  },

  /** A single column's mapped statuses. */
  async findByColumn(
    columnId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<BoardColumnStatus[]> {
    const client = tx ?? db;
    return client.boardColumnStatus.findMany({ where: { columnId, workspaceId } });
  },

  // Writes. `tx` REQUIRED; scalar-FK `Unchecked` create input (finding #33).
  async create(
    data: Prisma.BoardColumnStatusUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<BoardColumnStatus> {
    return tx.boardColumnStatus.create({ data });
  },

  /** Drop every status mapping for a column (column delete / re-map). */
  async deleteByColumn(columnId: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.boardColumnStatus.deleteMany({ where: { columnId } });
    return r.count;
  },

  /**
   * Drop the mapping of one status on one board (re-map a status to a
   * different column). Scoped by `boardId` so it never touches another board's
   * row for the same status.
   */
  async deleteByStatus(
    boardId: string,
    statusId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.boardColumnStatus.deleteMany({ where: { boardId, statusId } });
    return r.count;
  },
};
