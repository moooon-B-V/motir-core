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
};
