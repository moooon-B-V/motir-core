import { Prisma, type PlanChangeSession } from '@/generated/prisma/client';
import { db } from '@/lib/db';

// Single Prisma operations on the `plan_change_session` table (Story 7.30 ·
// MOTIR-1728). Writes require `tx` (a compile-time guarantee they run in a
// transaction); reads take an optional `tx` so an append's locked re-read joins
// the surrounding transaction. No business logic, no transactions, no DTO
// mapping — those belong in `planChangeSessionsService`. Every tenant path runs
// under an active workspace context, so the RLS policy's `app.workspace_id` GUC
// gates the rows; the `workspaceId` argument is the belt-and-suspenders
// app-level scope (a cross-tenant project id returns null → 404, never 403).
export const planChangeSessionRepository = {
  async create(
    data: Prisma.PlanChangeSessionUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession> {
    return tx.planChangeSession.create({ data });
  },

  /** The project's conversation FOR ONE SCOPE — the RESUME read (re-opening the
   *  planning workspace, or re-opening the panel on the same work items, reloads
   *  the thread from here). `scopeKey` is the canonical anchor-set discriminator
   *  (`''` = the project-wide thread; 7.12.3 · MOTIR-909), so this reads exactly
   *  the row the `(project_id, scope_key)` unique admits. Workspace-scoped so a
   *  project id from another tenant resolves to null. Optional `tx` for use
   *  inside a transaction. */
  async findByProjectAndScope(
    projectId: string,
    scopeKey: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    const client = tx ?? db;
    return client.planChangeSession.findFirst({ where: { projectId, scopeKey, workspaceId } });
  },

  async findById(
    id: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    const client = tx ?? db;
    return client.planChangeSession.findFirst({ where: { id, workspaceId } });
  },

  /**
   * Take a row lock on the conversation (`SELECT … FOR UPDATE`) so appending a
   * turn serializes against a concurrent append on the SAME thread — the
   * lost-update guard for the read-derived `turnCount → seq` allocation (the
   * lock-before-read-derived-update rule). Returns the id, or `null` when the
   * session does not exist; the caller re-reads the current row UNDER the lock
   * to allocate from a `turnCount` no sibling transaction can still move.
   */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "plan_change_session" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  async update(
    id: string,
    data: Prisma.PlanChangeSessionUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession> {
    return tx.planChangeSession.update({ where: { id }, data });
  },
};
