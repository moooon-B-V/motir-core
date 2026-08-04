import { Prisma, type MigrateOnboarding, type MigrateOnboardingStep } from '@prisma/client';
import { db } from '@/lib/db';

// Single Prisma operations on the `migrate_onboarding` table (Story 7.15 ·
// MOTIR-1499). Writes require `tx` (a compile-time guarantee they run in a
// transaction); reads take an optional `tx` so a transition's locked re-read
// joins the surrounding transaction. No business logic, no transactions, no DTO
// mapping — those belong in `migrateOnboardingService`. Every tenant path runs
// under an active workspace context, so the RLS policy's `app.workspace_id` GUC
// gates the rows; the `workspaceId` argument is the belt-and-suspenders app-level
// scope (a cross-tenant id returns null → 404, never 403).
export const migrateOnboardingRepository = {
  async create(
    data: Prisma.MigrateOnboardingUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<MigrateOnboarding> {
    return tx.migrateOnboarding.create({ data });
  },

  /** A run by id, scoped to its workspace. Optional `tx` joins a surrounding
   *  transaction (the locked re-read inside a step transition). */
  async findById(
    id: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<MigrateOnboarding | null> {
    const client = tx ?? db;
    return client.migrateOnboarding.findFirst({ where: { id, workspaceId } });
  },

  /** The single run for a project (the resumable head read — the wizard reloads
   *  from here). Workspace-scoped so a project id from another tenant resolves to
   *  null. Optional `tx` for use inside a transaction. */
  async findByProjectId(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<MigrateOnboarding | null> {
    const client = tx ?? db;
    return client.migrateOnboarding.findFirst({ where: { projectId, workspaceId } });
  },

  /**
   * Take a row lock on the run (`SELECT … FOR UPDATE`) so a step transition
   * serializes against a concurrent transition on the SAME run — the lost-update
   * guard for the one-directional step lifecycle (the lock-before-read-derived-
   * update rule). Returns the id, or `null` when the run does not exist; the
   * caller re-reads the current row under the lock to re-validate the step.
   */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "migrate_onboarding" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * The SWEEP's cross-workspace discovery scan (MOTIR-2082): every `active` run
   * parked at `step`, in ANY workspace, ordered by id so the caller can page with
   * a cursor. This is the one migrate-onboarding read with no workspace to bind —
   * it is the query that FINDS the workspaces — so it REQUIRES a
   * `withSystemContext` tx (the policy's system-admin branch, added in
   * 20260804180000). Under a tenant context the GUC is unset and this returns
   * that workspace's rows only, which is correct but not what the sweep wants.
   *
   * Bounded by `take` (finding #57 — no unbounded cross-tenant scan). `status`
   * is filtered HERE rather than by the caller so a `completed` / `failed` run
   * never even enters the sweep's working set.
   *
   * KEYSET paging (`id > after`), deliberately NOT Prisma's `cursor`. The caller
   * MUTATES the very set it is paging over: a swept run moves to `import` and so
   * leaves `step: 'index'`. Prisma's `cursor` has to LOCATE the cursor row within
   * the filtered result set, and that row is exactly the one that just left it —
   * so page 2 comes back empty and every run after the first page is silently
   * skipped. A plain `id > after` predicate needs no such lookup and is immune to
   * rows leaving the set mid-sweep.
   */
  async listActiveAtStep(
    step: MigrateOnboardingStep,
    params: { take: number; after?: string },
    tx: Prisma.TransactionClient,
  ): Promise<MigrateOnboarding[]> {
    return tx.migrateOnboarding.findMany({
      where: {
        step,
        status: 'active',
        ...(params.after ? { id: { gt: params.after } } : {}),
      },
      orderBy: { id: 'asc' },
      take: params.take,
    });
  },

  /**
   * The TERMINAL RECONCILIATION's cross-workspace discovery scan (MOTIR-2092):
   * every `active` run whose PROJECT is already established — its
   * `onboardingRanAt` marker stamped — in ANY workspace, ordered by id for
   * cursor paging. Like `listActiveAtStep` this is a read with no workspace to
   * bind (it is the query that FINDS them), so it REQUIRES a `withSystemContext`
   * tx; the `project` relation filter resolves through that table's own
   * system-admin READ branch (20260727225458).
   *
   * NO STEP FILTER, deliberately. The marker means the journey is OVER, and it
   * is stamped by writers that never look at the run at all (the dogfood seed,
   * the MOTIR-1799 operator stamp) — so a run can be orphaned at ANY step, not
   * only at `review` where the approve race leaves it. The live `MOTIR` row is
   * the proof: marker stamped 2026-08-04, run `active` at `index`.
   *
   * KEYSET paging (`id > after`) for the same reason `listActiveAtStep` uses it:
   * the caller MUTATES the set it is paging over (a reconciled run leaves
   * `status: 'active'`), and Prisma's `cursor` has to locate the cursor row
   * inside the filtered set — the one row that just left it.
   */
  async listActiveOnEstablishedProject(
    params: { take: number; after?: string },
    tx: Prisma.TransactionClient,
  ): Promise<MigrateOnboarding[]> {
    return tx.migrateOnboarding.findMany({
      where: {
        status: 'active',
        project: { onboardingRanAt: { not: null } },
        ...(params.after ? { id: { gt: params.after } } : {}),
      },
      orderBy: { id: 'asc' },
      take: params.take,
    });
  },

  async update(
    id: string,
    data: Prisma.MigrateOnboardingUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<MigrateOnboarding> {
    return tx.migrateOnboarding.update({ where: { id }, data });
  },
};
