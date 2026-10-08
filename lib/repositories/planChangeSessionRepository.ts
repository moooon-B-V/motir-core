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

  /** The RESUME read (AMENDMENT 17 §3, AMENDMENT 23 §3): this member's OWN most
   *  recent OPEN CONVERSATION for the scope. Another member's
   *  session never qualifies — auto-resume is own-only — and neither does a
   *  session a door opened for a plan with no conversation (`mcp`, `expand`, …):
   *  it has no turns to resume into. Served by the
   *  `(project_id, scope_key, created_by_id, last_activity_at)` index. */
  async findResumableForUser(
    projectId: string,
    scopeKey: string,
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    return tx.planChangeSession.findFirst({
      where: {
        projectId,
        scopeKey,
        workspaceId,
        createdById: userId,
        origin: 'conversation',
        // OPEN, at any age (AMENDMENT 23 §3) — the 2-hour window is retired. An
        // ended session is never resumed, however recent.
        endedAt: null,
      },
      orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
    });
  },

  /** What the SESSION HOLD reads of the session a lock names (AMENDMENT 23 §5;
   *  MOTIR-7640): whether it is open, its anchor, and who started it. */
  async findHoldSubject(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<{
    endedAt: Date | null;
    targetKeys: string[];
    createdBy: { id: string; name: string } | null;
  } | null> {
    return tx.planChangeSession.findUnique({
      where: { id },
      select: {
        endedAt: true,
        targetKeys: true,
        createdBy: { select: { id: true, name: true } },
      },
    });
  },

  /** This member's own most recent CONVERSATION for the scope, open or ended —
   *  the COPYABLE read (AMENDMENT 23 §6; MOTIR-7641): with no open session, the
   *  one that ended is what a new session may carry over. */
  async findLatestConversationForUser(
    projectId: string,
    scopeKey: string,
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    return tx.planChangeSession.findFirst({
      where: { projectId, scopeKey, workspaceId, createdById: userId, origin: 'conversation' },
      orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
    });
  },

  /**
   * The TAKE-BACK read (AMENDMENT 23 §3; MOTIR-7639): this member's own OPEN
   * conversation that HOLDS one of `targetKeys` — a lock naming the session, or
   * naming its plan. A first turn or an open on a card the member is already
   * planning lands back in that conversation instead of starting a second one.
   * Newest activity wins when more than one does.
   */
  async findOpenHoldingForUser(
    projectId: string,
    targetKeys: readonly string[],
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    if (targetKeys.length === 0) return null;
    const names = { workItem: { identifier: { in: [...targetKeys] } } };
    return tx.planChangeSession.findFirst({
      where: {
        projectId,
        workspaceId,
        createdById: userId,
        origin: 'conversation',
        endedAt: null,
        OR: [
          { targetLocks: { some: names } },
          { plans: { some: { targetLocks: { some: names } } } },
        ],
      },
      orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
    });
  },

  /** The GUIDE read (Story MOTIR-7459 · MOTIR-7464; ADR AMENDMENT 2, A2.2): this
   *  member's OWN most recent `guide` conversation on one card's scope. No resume
   *  window: a saved walk is resumable for as long as its list is on the card.
   *  Never another member's, and never a planning conversation of the same
   *  scope — {@link findResumableForUser} reads only `conversation`, and this
   *  reads only `guide`, so the two doors never pick up each other's thread. */
  async findLatestGuideForUser(
    projectId: string,
    scopeKey: string,
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    return tx.planChangeSession.findFirst({
      where: { projectId, scopeKey, workspaceId, createdById: userId, origin: 'guide' },
      orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
    });
  },

  /** The SEEDED-session read (AMENDMENT 17 §9; MOTIR-6207): this member's OWN
   *  most recent OPEN session seeded by `seedGateId` in this project (AMENDMENT
   *  23 §3 — no window). Never another member's (sessions are per member), never an
   *  unseeded session and never one seeded by a different gate. Served by the
   *  `(seed_gate_id, created_by_id, last_activity_at)` index. */
  async findSeededForUser(
    projectId: string,
    seedGateId: string,
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    return tx.planChangeSession.findFirst({
      where: {
        projectId,
        workspaceId,
        seedGateId,
        createdById: userId,
        endedAt: null,
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

  /** Who ENDED a session (AMENDMENT 23 §1), or null — Motir, or a departed member. */
  async findEnder(
    id: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; name: string } | null> {
    const row = await tx.planChangeSession.findFirst({
      where: { id, workspaceId },
      select: { endedBy: { select: { id: true, name: true } } },
    });
    return row?.endedBy ?? null;
  },

  /** The ids of this member's OTHER OPEN sessions of the scope — the sessions a
   *  new SEEDED session may take a live target lease over from (AMENDMENT 17 §6,
   *  kept for §9 only by AMENDMENT 23 §3). */
  async listIdsForUserInScope(
    projectId: string,
    scopeKey: string,
    userId: string,
    workspaceId: string,
    excludeId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.planChangeSession.findMany({
      // OPEN sessions only: an ended one released its leases when it ended
      // (AMENDMENT 23 §2), so it has nothing left to hand over.
      where: {
        projectId,
        scopeKey,
        workspaceId,
        createdById: userId,
        id: { not: excludeId },
        endedAt: null,
      },
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
  /**
   * The IDLE CLOSE's discovery read (AMENDMENT 23 §2; MOTIR-7638): open,
   * non-`guide` sessions whose last activity is older than `olderThan` and that
   * hold no undecided plan. Cross-tenant, so it runs under the system context
   * (`plan_change_session_system_read`); the end re-checks each one under its
   * own row lock before writing. Oldest first, bounded per pass.
   */
  async listIdleOpen(
    olderThan: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; workspaceId: string }>> {
    return tx.planChangeSession.findMany({
      where: {
        endedAt: null,
        origin: { not: 'guide' },
        lastActivityAt: { lt: olderThan },
        plans: { none: { status: { in: ['generating', 'planned', 'stale'] } } },
      },
      select: { id: true, workspaceId: true },
      orderBy: [{ lastActivityAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  },

  async lockById(id: string, tx: Prisma.TransactionClient): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "plan_change_session" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /** Bump a guide conversation's filed-bug counter by one (MOTIR-7800). The
   *  caller holds {@link lockById} on the row in the same transaction, so the
   *  count it checked and this increment are one decision. */
  async incrementGuideBugsFiled(id: string, tx: Prisma.TransactionClient): Promise<number> {
    const row = await tx.planChangeSession.update({
      where: { id },
      data: { guideBugsFiled: { increment: 1 } },
      select: { guideBugsFiled: true },
    });
    return row.guideBugsFiled;
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
   *
   * The SEED (MOTIR-6209) rides the same statement: `seed_gate_id → gate → work
   * item`, two plain joins, so a seeded row costs no query of its own.
   * `seedCardInProject` is the browse fact the mapper keys off — see
   * `toPlanSessionRowDto`.
   *
   * A `guide` conversation (MOTIR-7464; ADR `conversation-turn-intent.md`
   * AMENDMENT 2, A2.2) is NOT a planning session — it submits no plan — so it is
   * left out of the Plans room, here and in {@link countByLatestPlanState} alike.
   */
  async listPageByProject(
    args: {
      projectId: string;
      workspaceId: string;
      limit: number;
      after: { lastActivityAt: Date; id: string } | null;
      state: PlanSessionListState | null;
      sessionId?: string;
      /** The reader's OWN sessions only (`mine`), or null for every session. */
      mine?: PlanSessionMineScope | null;
      /** A Visitor's private-epic hidden set (MOTIR-6645) — see {@link sessionWithheldSql}. */
      hiddenIds?: readonly string[];
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
             pc."n" AS "planCount",
             ${sessionStateSql}::text AS "state",
             s."ended_at" AS "endedAt", s."end_reason"::text AS "endReason",
             eb."id" AS "endedById", eb."name" AS "endedByName",
             cf."id" AS "copiedFromId", cf."ended_at" AS "copiedFromEndedAt",
             s."seed_gate_id" AS "seedGateId", sg."kind"::text AS "seedGateKind",
             sg."state"::text AS "seedGateState",
             sg."chosen_option"->>'label' AS "seedChosenLabel",
             sw."identifier" AS "seedCardKey",
             (sw."id" IS NOT NULL AND sw."projectId" = s."project_id") AS "seedCardInProject"
      FROM "plan_change_session" s
      LEFT JOIN "user" u ON u."id" = s."created_by_id"
      LEFT JOIN "user" eb ON eb."id" = s."ended_by_id"
      LEFT JOIN "plan_change_session" cf
        ON cf."id" = s."copied_from_session_id" AND cf."workspace_id" = s."workspace_id"
       AND cf."project_id" = s."project_id"
      LEFT JOIN "approval_gate" sg
        ON sg."id" = s."seed_gate_id" AND sg."workspace_id" = s."workspace_id"
      LEFT JOIN "work_item" sw
        ON sw."id" = sg."work_item_id" AND sw."workspaceId" = s."workspace_id"
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
        AND s."origin" <> 'guide'
        ${stateFilter(args.state)} ${mineFilter(args.mine ?? null)} ${after} ${only}
        ${sessionWithheldSql(args.hiddenIds)}
      ORDER BY s."last_activity_at" DESC, s."id" DESC
      LIMIT ${args.limit}
    `;
  },

  /**
   * Whether a Visitor must be refused ONE plan (Story MOTIR-6170 · MOTIR-6645) —
   * its proposals name a hidden id, or its session is withheld by
   * {@link sessionWithheldSql}. The same predicates the room's list applies, so a
   * plan the list does not show is exactly one its page refuses. An empty hidden
   * set withholds nothing.
   */
  async isPlanWithheld(
    planId: string,
    hiddenIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    if (hiddenIds.length === 0) return false;
    const hidden = hiddenIds as string[];
    const rows = await tx.$queryRaw<Array<{ withheld: boolean }>>`
      SELECT (
        EXISTS (
          SELECT 1 FROM "plan_item" pi
           WHERE pi."plan_id" = ${planId} AND ${planItemTouchesHiddenSql('pi', hidden)}
        )
        OR EXISTS (
          SELECT 1 FROM "plan" p
           WHERE p."id" = ${planId}
             AND p."session_id" IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM "plan_change_session" s
                WHERE s."id" = p."session_id"
                  ${sessionWithheldSql(hiddenIds)}
             )
        )
      ) AS "withheld"`;
    return rows[0]?.withheld ?? false;
  },

  /**
   * EVERY plan of a project a Visitor must be refused (MOTIR-6645) — the
   * {@link isPlanWithheld} predicate over the whole project, for the rooms that
   * reach a plan only through its id (a `plan_approval` record's subject). An
   * empty hidden set withholds nothing and reads nothing.
   */
  async findWithheldPlanIds(
    projectId: string,
    hiddenIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    if (hiddenIds.length === 0) return [];
    const hidden = hiddenIds as string[];
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT p."id"
        FROM "plan" p
       WHERE p."project_id" = ${projectId}
         AND (
           EXISTS (
             SELECT 1 FROM "plan_item" pi
              WHERE pi."plan_id" = p."id" AND ${planItemTouchesHiddenSql('pi', hidden)}
           )
           OR (
             p."session_id" IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM "plan_change_session" s
                WHERE s."id" = p."session_id"
                  ${sessionWithheldSql(hiddenIds)}
             )
           )
         )`;
    return rows.map((r) => r.id);
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
    mine: PlanSessionMineScope | null = null,
    /** A Visitor's hidden set (MOTIR-6645): the counts are over the list's rows. */
    hiddenIds?: readonly string[],
  ): Promise<Array<{ state: string; count: number }>> {
    return tx.$queryRaw<Array<{ state: string; count: number }>>`
      SELECT ${sessionStateSql}::text AS "state", count(*)::int AS "count"
      FROM "plan_change_session" s
      ${latestPlanJoin}
      WHERE s."project_id" = ${projectId} AND s."workspace_id" = ${workspaceId}
        AND s."origin" <> 'guide'
        ${mineFilter(mine)}
        ${sessionWithheldSql(hiddenIds)}
      GROUP BY 1
    `;
  },
};

/** A session state the list filters on — `none`, `closed` or a `PlanStatus`
 *  value (AMENDMENT 23 §1). */
export type PlanSessionListState = 'none' | 'closed' | PlanStatus;

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
  /** The session's state, END first — {@link sessionStateSql}. */
  state: string;
  endedAt: Date | null;
  endReason: string | null;
  endedById: string | null;
  endedByName: string | null;
  /** The session this one was COPIED from (AMENDMENT 23 §6), when it is still
   *  in the project; null otherwise — a gone source reads like no source. */
  copiedFromId: string | null;
  copiedFromEndedAt: Date | null;
  /** MOTIR-6207's `seed_gate_id` — still set when the gate's work item moved away. */
  seedGateId: string | null;
  /** The seeding gate's kind; null when the session is unseeded or the gate is gone. */
  seedGateKind: string | null;
  /** The seeding gate's state — `approved` on a chosen `decision_choice` is a PICK
   *  (MOTIR-6434), every other seeding state a refusal. */
  seedGateState: string | null;
  /** The chosen option's stamped label on a pick, else null. */
  seedChosenLabel: string | null;
  /** The seeding gate's work item's identifier, when it still exists. */
  seedCardKey: string | null;
  /** Whether that work item is in the SESSION's project — the one the list is
   *  browse-gated on. False when there is no such work item. */
  seedCardInProject: boolean;
}

/**
 * The Plans room's WITHHOLDING for a Visitor (Story MOTIR-6170 · MOTIR-6645;
 * `epic-privacy.md` §3). A session is withheld when ANY of these joins reaches a
 * private epic's descendant — the whole session, because its turns, its plans'
 * titles and summaries may describe the hidden work and cannot be redacted:
 *
 * - its `target_keys` name a hidden work item;
 * - its seeding gate sits on a hidden work item;
 * - ANY of its plans holds a proposal whose `work_item_id`, `parent_ref`,
 *   `blocked_by_refs`, or a `modify` patch's `parentRef` / `blockedByAdd`, names
 *   a hidden id.
 *
 * Absent / empty ⇒ no clause (a member's read, and a project with no private
 * epic, are byte-for-byte unchanged).
 */
export function sessionWithheldSql(hiddenIds: readonly string[] | undefined): Prisma.Sql {
  if (!hiddenIds || hiddenIds.length === 0) return Prisma.empty;
  const hidden = hiddenIds as string[];
  return Prisma.sql`AND NOT EXISTS (
          SELECT 1 FROM "work_item" hw
           WHERE hw."id" = ANY(${hidden}) AND hw."identifier" = ANY(s."target_keys")
        )
        AND NOT EXISTS (
          SELECT 1 FROM "approval_gate" hg
           WHERE hg."id" = s."seed_gate_id" AND hg."work_item_id" = ANY(${hidden})
        )
        AND NOT EXISTS (
          SELECT 1 FROM "plan" hp
            JOIN "plan_item" hpi ON hpi."plan_id" = hp."id"
           WHERE hp."session_id" = s."id"
             AND ${planItemTouchesHiddenSql('hpi', hidden)}
        )`;
}

/**
 * Whether one proposal row (alias `alias`) names a hidden id through any of its
 * references — the predicate {@link sessionWithheldSql} and the plan-by-id read
 * share, so a plan the list withholds is exactly one its page refuses.
 */
export function planItemTouchesHiddenSql(alias: 'hpi' | 'pi', hidden: string[]): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`(
               ${a}."work_item_id" = ANY(${hidden})
            OR ${a}."parent_ref" = ANY(${hidden})
            OR ${a}."blocked_by_refs" && ${hidden}
            OR (${a}."patch" ->> 'parentRef') = ANY(${hidden})
            OR (jsonb_typeof(${a}."patch" -> 'blockedByAdd') = 'array'
                AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements_text(${a}."patch" -> 'blockedByAdd') ref
                   WHERE ref = ANY(${hidden})
                ))
          )`;
}

/** A session's LATEST plan — newest `created_at`, `id` breaking a tie. */
const latestPlanJoin = Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT p."id", p."status", p."title", p."summary" FROM "plan" p
    WHERE p."session_id" = s."id"
    ORDER BY p."created_at" DESC, p."id" DESC LIMIT 1
  ) lp ON true`;

/**
 * A session's STATE (AMENDMENT 23 §1), END FIRST: an ended session reads
 * `declined` / `approved` when a person's decision ended it and `closed` when
 * Motir did (`failed` · `idle` · `restarted`); an OPEN one reads its latest
 * plan's status, or `none`. Over `s` and {@link latestPlanJoin}'s `lp`, and the
 * ONE expression the list, its filter and the counts all read — so a count, its
 * tab and a row's chip cannot disagree.
 */
export const sessionStateSql = Prisma.sql`(CASE
    WHEN s."ended_at" IS NULL THEN COALESCE(lp."status"::text, 'none')
    WHEN s."end_reason" IN ('declined', 'approved') THEN s."end_reason"::text
    ELSE 'closed'
  END)`;

/**
 * The Plans room's `mine` scope (Story MOTIR-6179 · MOTIR-6330): WHO is reading,
 * and the ids of the plans whose approval gate is routed to them — resolved ONCE
 * per read by the service through `approvalGateRepository.findAwaitingRoutedPlanIds`,
 * so this filter adds no per-row query.
 */
export interface PlanSessionMineScope {
  userId: string;
  routedPlanIds: string[];
}

/**
 * A session is the reader's when they STARTED it, or when one of its plans was
 * asked for by them, DECIDED by them, or is awaiting their decision. Written
 * ONCE, and read by the list and the counts alike, so a count and its list
 * cannot disagree about which sessions are mine.
 */
function mineFilter(mine: PlanSessionMineScope | null): Prisma.Sql {
  if (mine === null) return Prisma.empty;
  const routed =
    mine.routedPlanIds.length > 0
      ? Prisma.sql`OR p."id" IN (${Prisma.join(mine.routedPlanIds)})`
      : Prisma.empty;
  return Prisma.sql`AND (
    s."created_by_id" = ${mine.userId}
    OR EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."session_id" = s."id"
        AND (p."created_by_id" = ${mine.userId} OR p."decided_by_id" = ${mine.userId} ${routed})
    )
  )`;
}

function stateFilter(state: PlanSessionListState | null): Prisma.Sql {
  if (state === null) return Prisma.empty;
  return Prisma.sql`AND ${sessionStateSql} = ${state}`;
}
