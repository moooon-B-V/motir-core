import { Prisma, type PlanChangeSession } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

/**
 * The `PlanChangeSession` update shape, NAMED BY THE OWNING REPOSITORY
 * (MOTIR-4296). Callers above this layer build their write payload against this
 * alias; `Prisma.PlanChangeSessionUncheckedUpdateInput` itself is named only here.
 */
export type PlanChangeSessionUpdateInput = Prisma.PlanChangeSessionUncheckedUpdateInput;

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

  /** The project's MOST RECENTLY ACTIVE conversation for one scope — the RESUME
   *  read (re-opening the planning workspace, or re-opening the panel on the same
   *  work items, reloads the thread from here). `scopeKey` is the canonical
   *  anchor-set discriminator (`''` = the project-wide thread; 7.12.3 ·
   *  MOTIR-909). A scope now holds MANY sessions (AMENDMENT 17 §2 — the
   *  `(project_id, scope_key)` unique is gone), so the read ORDERS by
   *  `lastActivityAt` and is deterministic when two exist. Workspace-scoped so a
   *  project id from another tenant resolves to null. Optional `tx` for use
   *  inside a transaction. */
  async findByProjectAndScope(
    projectId: string,
    scopeKey: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    const client = tx ?? dbRead;
    return client.planChangeSession.findFirst({
      where: { projectId, scopeKey, workspaceId },
      orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
    });
  },

  /**
   * ⚠️ `tx` is REQUIRED (MOTIR-2797) — unlike its sibling `findByProjectAndScope`,
   * which keeps its fallback because `planChangeSessionsService` still calls that
   * one unbound (MOTIR-2796's to fix). This one had no unbound caller left once
   * the tests bound, so the arm was dead code returning an EMPTY result under
   * `motir_app` while raising nothing.
   */
  async findById(
    id: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    return tx.planChangeSession.findFirst({ where: { id, workspaceId } });
  },

  /** One session BY ID, scoped to a project — the by-id address every door uses
   *  (AMENDMENT 17 §2). A session id from another project (or tenant) resolves to
   *  null, so the caller refuses it rather than writing to it. */
  async findByIdInProject(
    id: string,
    projectId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    return tx.planChangeSession.findFirst({ where: { id, projectId, workspaceId } });
  },

  /** The RESUME read (AMENDMENT 17 §3): this member's OWN most recent session for
   *  the scope, active at or after `since`. Another member's session never
   *  qualifies — auto-resume is own-only. Served by the
   *  `(project_id, scope_key, created_by_id, last_activity_at)` index. */
  async findResumableForUser(
    projectId: string,
    scopeKey: string,
    userId: string,
    workspaceId: string,
    since: Date,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    return tx.planChangeSession.findFirst({
      where: {
        projectId,
        scopeKey,
        workspaceId,
        createdById: userId,
        lastActivityAt: { gte: since },
      },
      orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
    });
  },

  /** The ids of this member's OTHER sessions of the scope — the predecessors a new
   *  session may take a live target lease over from (AMENDMENT 17 §6). */
  async listIdsForUserInScope(
    projectId: string,
    scopeKey: string,
    userId: string,
    workspaceId: string,
    excludeId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.planChangeSession.findMany({
      where: { projectId, scopeKey, workspaceId, createdById: userId, id: { not: excludeId } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  },

  /**
   * Serialize resume-or-start for ONE member in ONE scope, for the rest of the
   * transaction (`pg_advisory_xact_lock`). This is the write guard that replaced
   * the dropped `(project_id, scope_key)` unique (AMENDMENT 17 §2): the choice
   * between appending to a recent session and creating a new one is READ-DERIVED
   * (it reads `lastActivityAt`), so two tabs sending a first turn at once must
   * queue here and the second must re-read after the first commits. Keyed on the
   * member as well as the scope because auto-resume is own-only (§3) — two
   * members starting sessions in one scope do not contend. `folderRepository`'s
   * structure lock is the precedent.
   */
  async lockScopeForUser(
    projectId: string,
    scopeKey: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`plan-session:${projectId}:${scopeKey}:${userId}`}, 0))`;
  },

  /** The thread that SUBMITTED a given job (Story MOTIR-2786 · MOTIR-2787) — the
   *  reverse of `submit`'s `lastJobId` write, and how a plan decision finds the
   *  conversation whose target lock it should release. Workspace-scoped, so a job
   *  token from another tenant resolves to null. `tx` is required: every caller
   *  reads it to guard a following write. */
  async findByProjectAndLastJobId(
    projectId: string,
    lastJobId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    return tx.planChangeSession.findFirst({ where: { projectId, lastJobId, workspaceId } });
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
    data: PlanChangeSessionUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession> {
    return tx.planChangeSession.update({ where: { id }, data });
  },
};
