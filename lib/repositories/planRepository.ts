import { Prisma, type Plan } from '@prisma/client';
import { db } from '@/lib/db';

// Plan repository — single Prisma operations on the `plan` table (Story 7.21 ·
// MOTIR-1336). Writes require `tx` (a compile-time guarantee they run in a
// transaction); pure read paths use the `db` singleton. No business logic, no
// transactions, no DTO mapping — those belong in `plansService`.
export const planRepository = {
  /** A plan by id, scoped to its workspace. Read-only; optional `tx` joins a
   *  surrounding transaction (e.g. the locked re-read inside approve/decline). */
  async findById(
    id: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Plan | null> {
    const client = tx ?? db;
    return client.plan.findFirst({ where: { id, workspaceId } });
  },

  async create(data: Prisma.PlanUncheckedCreateInput, tx: Prisma.TransactionClient): Promise<Plan> {
    return tx.plan.create({ data });
  },

  /**
   * Take a row lock on the plan (`SELECT … FOR UPDATE`) so a status-deciding
   * write (markPlanned / approve / decline) serializes against a concurrent
   * decider on the SAME plan — the lost-update guard for the one-shot
   * generating→planned→decided lifecycle (the `notes.html` lock-before-
   * read-derived-update rule). Returns the id, or `null` when the plan does not
   * exist; the caller re-reads the current row under the lock to re-validate
   * the status.
   */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "plan" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  async update(
    id: string,
    data: Prisma.PlanUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<Plan> {
    return tx.plan.update({ where: { id }, data });
  },

  /**
   * A project's plans, newest first, keyset-paginated. `cursorId` is the id of
   * the last plan on the previous page (omitted for the first page); `limit`
   * rows are returned. Ordered (createdAt desc, id desc) so the cursor is
   * stable even when two plans share a `createdAt`.
   */
  async listByProject(
    projectId: string,
    workspaceId: string,
    limit: number,
    cursorId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<Plan[]> {
    const client = tx ?? db;
    return client.plan.findMany({
      where: { projectId, workspaceId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
  },
};
