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

  /**
   * The plan a generation job is producing into, resolved by its `sourceJobId`
   * (the generate seam sets `sourceJobId = jobId` at `createPlan`). Scoped to
   * the workspace so a job token for one tenant can never reach another's plan
   * — a cross-tenant lookup returns `null` (→ 404, never 403). Newest-first so a
   * re-submitted job resolves to its latest plan. Read-only.
   */
  async findBySourceJobId(sourceJobId: string, workspaceId: string): Promise<Plan | null> {
    return db.plan.findFirst({
      where: { sourceJobId, workspaceId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /**
   * The project's UNDECIDED plan, if it has one — the read behind the
   * pending-proposal GATE (MOTIR-916). "Undecided" is `generating` (the engine
   * is still producing it) or `planned` (it is sitting in the human review
   * queue); `approved` / `declined` are decided and do not gate anything.
   *
   * WHO started it is deliberately NOT part of the predicate: a user-clicked
   * expand saturates the reviewer exactly as much as a cadence-fired one, and a
   * second proposal against the same committed tree makes the first STALE
   * (`planStalenessService` warns but never blocks). So any undecided plan
   * pauses cadence for the project, whatever its `origin`.
   *
   * Newest first, so the ONE row returned is the plan a caller would show. Takes
   * an optional `tx` because both consumers read it inside a workspace context
   * (correct under the non-bypass `prodect_app` role, where the plan policy keys
   * on the per-transaction workspace GUC).
   */
  async findUndecidedByProject(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Plan | null> {
    const client = tx ?? db;
    return client.plan.findFirst({
      where: { projectId, workspaceId, status: { in: ['generating', 'planned'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
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
