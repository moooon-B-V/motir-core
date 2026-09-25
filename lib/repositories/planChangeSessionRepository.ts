import { Prisma, type PlanChangeSession, type PlanStatus } from '@/generated/prisma/client';
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
  /** Create a session. `seedGateId` is set ONLY by a seeded first turn
   *  (`planChangeSessionsService.startSeededWithFirstTurn`, AMENDMENT 17 §9). */
  async create(
    data: Prisma.PlanChangeSessionUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession> {
    return tx.planChangeSession.create({ data });
  },

  /** The project's MOST RECENTLY ACTIVE conversation for one scope, of any
   *  member. ⚠️ NO PRODUCTION READER since MOTIR-6028 — every door addresses a
   *  session by id, and the resume read is {@link findResumableForUser}. It is
   *  kept because the E2E harness, the RLS fallback-arm guard and several suites
   *  read a scope's latest session through it; do not route a door back onto it. `scopeKey` is the canonical
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

  /** The RESUME read (AMENDMENT 17 §3): this member's OWN most recent
   *  CONVERSATION for the scope, active at or after `since`. Another member's
   *  session never qualifies — auto-resume is own-only — and neither does a
   *  session a door opened for a plan with no conversation (`mcp`, `expand`, …):
   *  it has no turns to resume into. Served by the
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
        origin: 'conversation',
        lastActivityAt: { gte: since },
      },
      orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
    });
  },

  /** The SEEDED-session read (AMENDMENT 17 §9; MOTIR-6207): this member's OWN
   *  most recent session seeded by `seedGateId` in this project, active at or
   *  after `since`. Never another member's (sessions are per member), never an
   *  unseeded session and never one seeded by a different gate. Served by the
   *  `(seed_gate_id, created_by_id, last_activity_at)` index. */
  async findSeededForUser(
    projectId: string,
    seedGateId: string,
    userId: string,
    workspaceId: string,
    since: Date,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    return tx.planChangeSession.findFirst({
      where: {
        projectId,
        workspaceId,
        seedGateId,
        createdById: userId,
        lastActivityAt: { gte: since },
      },
      orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
    });
  },

  /** The scope's most recent OTHER conversation, any member's — what a fresh
   *  start's notice points to (MOTIR-6024). Conversation origin only: a session
   *  a door opened for a plan has no conversation to return to. */
  async findLatestConversationInScope(
    projectId: string,
    scopeKey: string,
    workspaceId: string,
    excludeId: string | null,
    tx: Prisma.TransactionClient,
  ) {
    return tx.planChangeSession.findFirst({
      where: {
        projectId,
        scopeKey,
        workspaceId,
        origin: 'conversation',
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
      include: { createdBy: { select: { id: true, name: true } } },
    });
  },

  /** Who STARTED a session — the reopened line's name (MOTIR-6024). */
  async findStarter(
    id: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; name: string } | null> {
    const row = await tx.planChangeSession.findFirst({
      where: { id, workspaceId },
      select: { createdBy: { select: { id: true, name: true } } },
    });
    return row?.createdBy ?? null;
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

  /**
   * ONE PAGE of the Plans page's session list (MOTIR-6025, AMENDMENT 17 §8),
   * newest activity first, in ONE statement: each session with its starter, its
   * first `user` turn, its LATEST plan and its plan count, joined laterally so no
   * per-row read follows. Walks `(project_id, last_activity_at)`; the cursor is
   * the last row's `(lastActivityAt, id)`, compared as a ROW so two sessions
   * sharing a timestamp are neither skipped nor repeated across a page boundary.
   *
   * `state` filters on the LATEST plan: `none` = no plan at all, otherwise that
   * plan's status. `sessionId` narrows to one row (the `?session=` landing).
   */
  async listPageByProject(
    args: {
      projectId: string;
      workspaceId: string;
      limit: number;
      after: { lastActivityAt: Date; id: string } | null;
      state: PlanSessionListState | null;
      sessionId?: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<PlanSessionListRow[]> {
    const after = args.after
      ? Prisma.sql`AND (s."last_activity_at", s."id") < (${args.after.lastActivityAt}, ${args.after.id})`
      : Prisma.empty;
    const only = args.sessionId ? Prisma.sql`AND s."id" = ${args.sessionId}` : Prisma.empty;
    return tx.$queryRaw<PlanSessionListRow[]>`
      SELECT s."id", s."origin"::text AS "origin", s."target_keys" AS "targetKeys",
             s."last_activity_at" AS "lastActivityAt",
             u."id" AS "starterId", u."name" AS "starterName",
             ft."body" AS "firstTurn",
             lp."id" AS "planId", lp."status"::text AS "planStatus",
             lp."title" AS "planTitle", lp."summary" AS "planSummary",
             pc."n" AS "planCount"
      FROM "plan_change_session" s
      LEFT JOIN "user" u ON u."id" = s."created_by_id"
      LEFT JOIN LATERAL (
        SELECT t."body" FROM "plan_change_turn" t
        WHERE t."session_id" = s."id" AND t."role" = 'user'
        ORDER BY t."seq" ASC LIMIT 1
      ) ft ON true
      ${latestPlanJoin}
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS "n" FROM "plan" p WHERE p."session_id" = s."id"
      ) pc ON true
      WHERE s."project_id" = ${args.projectId} AND s."workspace_id" = ${args.workspaceId}
        ${stateFilter(args.state)} ${after} ${only}
      ORDER BY s."last_activity_at" DESC, s."id" DESC
      LIMIT ${args.limit}
    `;
  },

  /**
   * How many of the project's sessions hold each plan state — the filter's
   * counts — in ONE grouped statement over the same latest-plan join the list
   * uses, so a count and its filtered list can never disagree. Returns only the
   * states that have rows; the service zero-fills.
   */
  async countByLatestPlanState(
    projectId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ state: string; count: number }>> {
    return tx.$queryRaw<Array<{ state: string; count: number }>>`
      SELECT COALESCE(lp."status"::text, 'none') AS "state", count(*)::int AS "count"
      FROM "plan_change_session" s
      ${latestPlanJoin}
      WHERE s."project_id" = ${projectId} AND s."workspace_id" = ${workspaceId}
      GROUP BY 1
    `;
  },
};

/** A plan state the list filters on — `none` or a `PlanStatus` value. */
export type PlanSessionListState = 'none' | PlanStatus;

/** One raw row of {@link planChangeSessionRepository.listPageByProject}. */
export interface PlanSessionListRow {
  id: string;
  origin: string;
  targetKeys: string[];
  lastActivityAt: Date;
  starterId: string | null;
  starterName: string | null;
  firstTurn: string | null;
  planId: string | null;
  planStatus: string | null;
  planTitle: string | null;
  planSummary: string | null;
  planCount: number;
}

/** A session's LATEST plan — newest `created_at`, `id` breaking a tie. */
const latestPlanJoin = Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT p."id", p."status", p."title", p."summary" FROM "plan" p
    WHERE p."session_id" = s."id"
    ORDER BY p."created_at" DESC, p."id" DESC LIMIT 1
  ) lp ON true`;

function stateFilter(state: PlanSessionListState | null): Prisma.Sql {
  if (state === null) return Prisma.empty;
  if (state === 'none') return Prisma.sql`AND lp."id" IS NULL`;
  return Prisma.sql`AND lp."status" = CAST(${state} AS "plan_status")`;
}
