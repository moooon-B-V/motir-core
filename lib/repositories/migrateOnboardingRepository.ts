import { Prisma, type MigrateOnboarding } from '@prisma/client';
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

  async update(
    id: string,
    data: Prisma.MigrateOnboardingUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<MigrateOnboarding> {
    return tx.migrateOnboarding.update({ where: { id }, data });
  },
};
