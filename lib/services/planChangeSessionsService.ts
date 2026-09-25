import {
  Prisma,
  type PlanChangeSession,
  type PlanChangeTurn,
  type PlanChangeTurnIntent,
  type PlanChangeTurnRole,
} from '@/generated/prisma/client';

import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import {
  planChangeSessionRepository,
  type PlanChangeSessionUpdateInput,
} from '@/lib/repositories/planChangeSessionRepository';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { planSessionsService } from '@/lib/services/planSessionsService';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { toPlanChangeSessionDto } from '@/lib/mappers/planChangeMappers';
import { parseWorkItemTokenIds } from '@/lib/mentions/workItemRefs';
import { normalizeBodyRefs } from '@/lib/workItems/normalizeBodyRefs';
import { resolveWorkItemRefSummaries } from '@/lib/workItems/resolveWorkItemRefs';
import { readPlanningTurn } from '@/lib/planning/plannerTurn';
import { getJob } from '@/lib/ai/motirAiClient';
import type { SubmittedRequirement } from '@/lib/ai/types';
import type {
  PlanChangeSessionDto,
  PlanChangeSubmitResultDto,
  ResumableSessionDto,
} from '@/lib/dto/planChange';
import { planRepository } from '@/lib/repositories/planRepository';
import { PermissionDeniedError } from '@/lib/projects/errors';
import {
  EmptyPlanChangeIntentError,
  EmptyPlanChangeTurnError,
  PlanChangeSessionNotFoundError,
  PlanChangeTurnConflictError,
  PlanChangeTurnNotFoundError,
  PlanSessionNotFoundError,
} from '@/lib/planChange/errors';
import { PROJECT_SCOPE_KEY, type PlanChangeScope } from '@/lib/planChange/scope';
import { resumableSince } from '@/lib/planChange/sessionWindow';

/**
 * How a write ADDRESSES its session (AMENDMENT 17 §2, story MOTIR-6011): by its
 * ID. A scope holds many sessions over time, so the id is the only address that
 * names exactly one. (The scope-key compatibility address MOTIR-6021 kept for
 * the doors' migration was removed with its last caller, MOTIR-6028.)
 */
export type PlanChangeSessionAddress = { sessionId: string };

// The plan-change CONVERSATION seam (Story 7.30 · MOTIR-1728) — what makes
// changing a plan a dialogue instead of a one-shot prompt.
//
// WHAT THIS IS NOT: a new AI capability. The engine is untouched — MOTIR-899
// (augment) and MOTIR-1347 (modify/remove ops) already emit the deltas, and
// MOTIR-902 already ships `POST /api/ai/augment` plus the job / stream / approve
// routes. This service COMPOSES a conversation on top of that contract: it
// accumulates the user's turns and submits their accumulated intent as ONE
// ordinary `augment` job. No new job kind, no motir-ai change. (If the engine
// ever needs conversation-NATIVE context — the turns as structured history
// rather than one accumulated prompt — that is a separate motir-ai card, not an
// absorption into this one: ONE SUBTASK = ONE REPO = ONE PR.)
//
// WHY PERSISTED and not client state: a conversation that evaporates on reload
// is not a conversation. The thread is a row, so re-opening the planning
// workspace RESUMES it, and the accumulated context is what the job actually
// receives rather than whatever a component happened to still hold.
//
// 4-layer + concurrency (CLAUDE.md): this service owns the transactions and the
// DTO mapping; the repositories are single-op leaves. Appending a turn is
// READ-DERIVED — the next `seq` comes from the session's `turnCount` — so the
// append locks the session row (`SELECT … FOR UPDATE`) and RE-READS it inside
// the transaction before allocating (the lock-before-read-derived-update rule);
// the `(session_id, seq)` unique is the DB backstop, translated from P2002 to a
// typed `PlanChangeTurnConflictError` so no raw Prisma error escapes.
//
// SIDE-EFFECTS-OUTSIDE-TX (CLAUDE.md): submitting calls motir-ai over the
// network. That happens BEFORE the short transaction that records the marker
// turn — a conversation row is never locked across a motir-ai round-trip. (It is
// also structurally forced: `submitAugment` opens its own transactions, and
// Prisma cannot nest interactive ones.)

/**
 * Build the intent submitted to the plan-edit job from the thread's `user`
 * turns, IN ORDER. This is the whole point of the seam: the engine receives the
 * ACCUMULATED refinement, not just the latest message, so "make them smaller"
 * still carries "add auth to the billing epic" from three turns ago.
 *
 * A SINGLE-turn thread renders byte-identically to the turn itself — so a
 * one-shot change through the conversation is exactly the prompt the shipped
 * "Augment from prompt" path sent, with no added framing to shift the engine's
 * behaviour. Only a genuine multi-turn thread gets the numbered framing, which
 * states the one thing the engine cannot infer from a concatenation: later turns
 * REFINE earlier ones rather than contradicting them.
 *
 * Exported for direct unit testing — it is pure, and it is the contract the rail
 * and the engine meet on.
 */
export function buildAccumulatedIntent(
  turns: Array<Pick<PlanChangeTurn, 'role' | 'body'>>,
): string {
  const userTurns = turns.filter((t) => t.role === 'user').map((t) => t.body.trim());
  if (userTurns.length === 0) return '';
  if (userTurns.length === 1) return userTurns[0]!;
  const numbered = userTurns.map((body, i) => `${i + 1}. ${body}`).join('\n');
  return (
    `Plan change requested across ${userTurns.length} turns of one conversation. ` +
    `Apply the ACCUMULATED intent below as a single change — later turns REFINE ` +
    `earlier ones rather than replacing them:\n\n${numbered}`
  );
}

/** Read a session's thread and map both to the DTO. `tx` joins a surrounding
 *  transaction (an append returns the thread it just extended).
 *
 *  The thread's `assistant` bodies carry `[KEY](motir:<id>)` tokens (normalized
 *  at write time by {@link recordPlannerTurn}), so their summaries are resolved
 *  here — ONE resolve for the whole thread — and threaded to the rail, which
 *  renders them through the shipped `WorkItemRefChip` path exactly as the detail
 *  page and the comment thread do. A thread with no references pays nothing:
 *  `resolveWorkItemRefSummaries` returns `{}` for an empty ref set. */
async function toDto(
  row: PlanChangeSession,
  pctx: ProjectContext,
  tx?: Prisma.TransactionClient,
): Promise<PlanChangeSessionDto> {
  // Bound when the caller holds no transaction (MOTIR-2846). Forwarding a `tx?`
  // that may be undefined into a bindable read looks bound at this line and is
  // not: under `motir_app` the turn list came back empty and every conversation
  // rendered as having no history.
  const turns = tx
    ? await planChangeTurnRepository.listBySessionId(row.id, pctx.workspaceId, tx)
    : await withWorkspaceServiceContext(pctx.workspaceId, (t) =>
        planChangeTurnRepository.listBySessionId(row.id, pctx.workspaceId, t),
      );
  const ids = turns
    .filter((t) => t.role === 'assistant')
    .flatMap((t) => parseWorkItemTokenIds(t.body));
  // An ANSWER's citations are stored as IDENTIFIERS, not as `motir:` id tokens
  // in the body, so they ride the `keys` half of the same ONE resolve
  // (MOTIR-1818). Two reasons they are not left to the client: the rail must
  // render a citation through the shipped `WorkItemRefChip` path exactly as the
  // detail page does, and resolving them here keeps a citation chip's title
  // subject to the same access checks as everything else on the thread.
  const citedKeys = turns.flatMap((t) => t.citations);
  const workItemRefs = await resolveWorkItemRefSummaries(
    { ids: [...new Set(ids)], keys: [...new Set(citedKeys)] },
    pctx.projectId,
    { userId: pctx.userId, workspaceId: pctx.workspaceId },
  );
  return toPlanChangeSessionDto(row, turns, workItemRefs);
}

/**
 * Assert the actor may run the PLANNER on this project — `ai:plan`
 * (Story MOTIR-2291 · Subtask MOTIR-2355).
 *
 * ⚠️ IT REPLACES `assertCanEdit`, AND THE TWO ARE NOT THE SAME ACTOR SET. Editing
 * a work item and submitting a planning job look alike from a route — both are
 * writes a member does — but a planning job SPENDS THE WORKSPACE'S AI CREDITS,
 * and `work_item:edit` is held by the implicit workspace-member grant while
 * `ai:plan` deliberately is not (`docs/decisions/member-facing-permissions.md`
 * §2). So a workspace member with no membership on THIS project could open a
 * plan-change thread and run the planner on somebody else's project, on the
 * workspace's bill. That is the case this card is really about, and it does not
 * follow from the viewer case.
 */
async function assertCanPlan(projectId: string, ctx: ServiceContext): Promise<void> {
  await projectAccessService.assertPermission(projectId, ctx, 'ai:plan');
}

/** Resolve the ADDRESSED conversation — the shared precondition of every write
 *  (AMENDMENT 17 §2: by id; a session of another project is
 *  `PLAN_SESSION_NOT_FOUND`). Gated on `ai:plan`: every caller mutates it. */
async function requireSession(
  pctx: ProjectContext,
  address: PlanChangeSessionAddress,
): Promise<PlanChangeSession> {
  const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
  await assertCanPlan(pctx.projectId, ctx);
  return findSessionById(pctx, address.sessionId);
}

/** One session BY ID in this project, or the typed `PLAN_SESSION_NOT_FOUND` — an
 *  id from another project never resolves to a sibling session of the same
 *  scope (AMENDMENT 17 §2). Gate-free: the callers assert their own permission. */
async function findSessionById(
  pctx: ProjectContext,
  sessionId: string,
): Promise<PlanChangeSession> {
  const session = await withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
    planChangeSessionRepository.findByIdInProject(sessionId, pctx.projectId, pctx.workspaceId, tx),
  );
  if (!session) throw new PlanSessionNotFoundError(sessionId);
  return session;
}

/**
 * Append one turn under the session's row lock. Shared by the user-turn append,
 * the submission marker AND the planner's own turn so ALL THREE allocate `seq`
 * the same safe way — a second allocation route for assistant turns would
 * quietly reintroduce exactly the lost-append race this one guards.
 * Returns the updated session row (its `turnCount` bumped, plus any extra patch).
 *
 * `skipIf` is an IDEMPOTENCY gate evaluated INSIDE the lock, for callers whose
 * append may legitimately be replayed (the planner turn, whose recording the
 * client can re-issue on a reload or from a second tab). Returning true skips
 * the insert and yields the thread as it already stands. It has to run under the
 * lock, not before it: checked outside, two concurrent replays would both see
 * "not there yet" and both insert.
 */
/**
 * Keep only the citations that name a work item IN THIS PROJECT, in the order
 * the answer gave them (MOTIR-1818; ADR §1).
 *
 * Three things it drops, and each is a real failure mode of a grounded answer:
 * a key the model invented, a key that resolves in ANOTHER project (the read is
 * `projectId`-scoped, so a cross-tenant identifier simply does not come back),
 * and a duplicate. What survives is a list the rail can render as chips knowing
 * every one of them opens something.
 *
 * BOUND, and deliberately so (MOTIR-2846's shape): `findByIdentifiers` falls
 * back to the `db` singleton when handed no `tx`, and `work_item` is
 * workspace-keyed — so an unbound read under `motir_app` matches no row, returns
 * `[]`, and every citation would be silently dropped as "unresolvable". That
 * failure has no error and no log; it just looks like an answer that cited
 * nothing. This runs before `appendLocked` opens its short write lock
 * (side-effects and reads that need no lock stay outside it), so it opens its
 * own read-only binding rather than threading a `tx` that does not exist yet.
 */
async function resolveCitations(
  citations: readonly string[],
  pctx: ProjectContext,
): Promise<string[]> {
  const wanted = [...new Set(citations.map((c) => c.trim()).filter(Boolean))];
  if (wanted.length === 0) return [];
  const rows = await withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
    workItemRepository.findByIdentifiers(pctx.projectId, wanted, tx),
  );
  const known = new Set(rows.map((r) => r.identifier));
  return wanted.filter((c) => known.has(c));
}

interface AppendTurn {
  role: PlanChangeTurnRole;
  body: string;
  jobId?: string | null;
  authorId?: string | null;
  question?: string | null;
  isAnswer?: boolean;
  intent?: PlanChangeTurnIntent | null;
  citations?: string[];
}

async function appendLocked(
  session: PlanChangeSession,
  pctx: ProjectContext,
  turn: AppendTurn,
  patch: PlanChangeSessionUpdateInput = {},
  skipIf?: (tx: Prisma.TransactionClient) => Promise<boolean>,
): Promise<PlanChangeSessionDto> {
  return withWorkspaceContext(
    { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
    async (tx) => {
      const row = await appendWithin(session.id, pctx, turn, patch, tx, skipIf);
      return toDto(row, pctx, tx);
    },
  );
}

/**
 * The transactional CORE of {@link appendLocked}, factored out so the FIRST turn
 * of a new session can be appended inside the transaction that creates the
 * session (MOTIR-6021) — a session with no turn is exactly the "opened by a look"
 * row AMENDMENT 17 §1 forbids. `tx` is REQUIRED; this never opens a transaction.
 *
 * Every append moves `lastActivityAt` in the SAME update that bumps `turnCount`
 * (§3): the resume window and the Plans page's order both read it, and a turn
 * that did not move it would let a live conversation age out mid-sentence.
 */
async function appendWithin(
  sessionId: string,
  pctx: ProjectContext,
  turn: AppendTurn,
  patch: PlanChangeSessionUpdateInput,
  tx: Prisma.TransactionClient,
  skipIf?: (tx: Prisma.TransactionClient) => Promise<boolean>,
): Promise<PlanChangeSession> {
  const locked = await planChangeSessionRepository.lockById(sessionId, tx);
  if (!locked) throw new PlanChangeSessionNotFoundError(pctx.projectId);
  // Re-read UNDER the lock: `turnCount` is the read-derived value the next
  // `seq` comes from, and a sibling append may have moved it between the
  // caller's read and this transaction.
  const fresh = await planChangeSessionRepository.findById(sessionId, pctx.workspaceId, tx);
  if (!fresh) throw new PlanChangeSessionNotFoundError(pctx.projectId);

  if (skipIf && (await skipIf(tx))) return fresh;

  const seq = fresh.turnCount;
  try {
    await planChangeTurnRepository.create(
      {
        workspaceId: pctx.workspaceId,
        sessionId: fresh.id,
        seq,
        role: turn.role,
        body: turn.body,
        jobId: turn.jobId ?? null,
        question: turn.question ?? null,
        isAnswer: turn.isAnswer ?? false,
        intent: turn.intent ?? null,
        citations: turn.citations ?? [],
        authorId: turn.authorId ?? null,
      },
      tx,
    );
  } catch (err) {
    // The `(session_id, seq)` unique fired: some writer claimed this position
    // without holding the lock (a desynced `turnCount`). Surface the typed
    // conflict — a raw P2002 never escapes the service.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new PlanChangeTurnConflictError(fresh.id, seq);
    }
    throw err;
  }

  return planChangeSessionRepository.update(
    fresh.id,
    { ...patch, turnCount: seq + 1, lastActivityAt: new Date() },
    tx,
  );
}

/**
 * RESUME-OR-START under the member's scope lock (AMENDMENT 17 §3, §6) — the core
 * of {@link planChangeSessionsService.startWithFirstTurn} and of the public
 * `open` doors' {@link planChangeSessionsService.openForScope}. Takes the
 * member's scope lock, RE-READS their resumable session under it, and either
 * resumes it (refreshing its target lease) or creates a new session and takes
 * the scope's targets — handing over any live lease the member's own older
 * sessions of this scope still hold. Returns the session id. `tx` is REQUIRED.
 */
async function resumeOrStartWithin(
  pctx: ProjectContext,
  scope: PlanChangeScope,
  now: Date,
  tx: Prisma.TransactionClient,
): Promise<string> {
  await planChangeSessionRepository.lockScopeForUser(
    pctx.projectId,
    scope.scopeKey,
    pctx.userId,
    tx,
  );
  const resumable = await planChangeSessionRepository.findResumableForUser(
    pctx.projectId,
    scope.scopeKey,
    pctx.userId,
    pctx.workspaceId,
    resumableSince(now),
    tx,
  );

  let sessionId: string;
  if (resumable) {
    sessionId = resumable.id;
    await planTargetLockService.acquireForScopeWithin(sessionId, scope.targetKeys, pctx, now, tx);
  } else {
    const created = await planChangeSessionRepository.create(
      {
        workspaceId: pctx.workspaceId,
        projectId: pctx.projectId,
        createdById: pctx.userId,
        scopeKey: scope.scopeKey,
        targetKeys: scope.targetKeys,
        origin: 'conversation',
        lastActivityAt: now,
      },
      tx,
    );
    sessionId = created.id;
    const predecessors = await planChangeSessionRepository.listIdsForUserInScope(
      pctx.projectId,
      scope.scopeKey,
      pctx.userId,
      pctx.workspaceId,
      created.id,
      tx,
    );
    await planTargetLockService.acquireForScopeWithin(sessionId, scope.targetKeys, pctx, now, tx, {
      takeOverFrom: predecessors,
    });
  }
  return sessionId;
}

export const planChangeSessionsService = {
  /**
   * The RESUME read (AMENDMENT 17 §3): the caller's OWN most recent session for
   * the scope, if its last turn was inside `PLAN_SESSION_RESUME_WINDOW_MS`, else
   * `null`. Another member's session is never resumed automatically — reopening
   * one is an explicit by-id act ({@link getById}). WRITES NOTHING and takes no
   * lock: looking at the door is not starting a conversation.
   *
   * Browse-gated, like {@link getById}: it reads a conversation.
   */
  async findResumable(
    pctx: ProjectContext,
    scopeKey: string = PROJECT_SCOPE_KEY,
    now: Date = new Date(),
  ): Promise<PlanChangeSessionDto | null> {
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    await projectAccessService.assertCanBrowse(pctx.projectId, ctx);
    const row = await withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
      planChangeSessionRepository.findResumableForUser(
        pctx.projectId,
        scopeKey,
        pctx.userId,
        pctx.workspaceId,
        resumableSince(now),
        tx,
      ),
    );
    return row ? toDto(row, pctx) : null;
  },

  /**
   * One session BY ID — any member who may browse the project may READ any of
   * its sessions (AMENDMENT 17 §3: reopening from the Plans page is not
   * own-only). Writes nothing. An id outside this project is
   * `PLAN_SESSION_NOT_FOUND`.
   */
  async getById(pctx: ProjectContext, sessionId: string): Promise<PlanChangeSessionDto> {
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    await projectAccessService.assertCanBrowse(pctx.projectId, ctx);
    const row = await findSessionById(pctx, sessionId);
    // The REOPEN extras (MOTIR-6024): the reopened line names who started it,
    // a member without `ai:plan` reads it read-only, and a still-undecided plan
    // comes back reviewable — the three things a Plans row's reopen needs.
    const [startedBy, pending, viewerCanPlan] = await Promise.all([
      withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
        planChangeSessionRepository.findStarter(row.id, pctx.workspaceId, tx),
      ),
      withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
        planRepository.findLatestBySession(row.id, tx),
      ),
      assertCanPlan(pctx.projectId, ctx).then(
        () => true,
        (err: unknown) => {
          if (err instanceof PermissionDeniedError) return false;
          throw err;
        },
      ),
    ]);
    const undecided =
      pending && pending.status !== 'approved' && pending.status !== 'declined' ? pending.id : null;
    return {
      ...(await toDto(row, pctx)),
      startedBy,
      startedByViewer: row.createdById === pctx.userId,
      viewerCanPlan,
      pendingPlanId: undecided,
    };
  },

  /**
   * {@link getById} for a READER — the overlay's `GET /api/ai/plan-change/session`
   * (Story MOTIR-6179 · MOTIR-6330). A session outside the reader's Plans-room
   * scope (neither `plan:view_any` nor in their Mine view) is the same
   * `PLAN_SESSION_NOT_FOUND` an unknown id is, so a pasted link confirms nothing.
   * `getById` itself stays scope-free for its AUTHORING callers (the contextual
   * planner and the ask door), which continue a conversation under `ai:plan`.
   */
  async getByIdForReader(pctx: ProjectContext, sessionId: string): Promise<PlanChangeSessionDto> {
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    const inScope = await planSessionsService.isSessionInReaderScope(
      pctx.projectId,
      sessionId,
      ctx,
    );
    if (!inScope) throw new PlanSessionNotFoundError(sessionId);
    return this.getById(pctx, sessionId);
  },

  /**
   * The RESUME read plus what a FRESH start points to (AMENDMENT 17 §3;
   * MOTIR-6024): the caller's resumable conversation for the scope — or, when
   * there is none, the scope's most recent OTHER conversation (any member's),
   * which the overlay's notice links to on the Plans page. Writes nothing.
   */
  async findResumableWithEarlier(
    pctx: ProjectContext,
    scopeKey: string = PROJECT_SCOPE_KEY,
    now: Date = new Date(),
  ): Promise<ResumableSessionDto> {
    const session = await planChangeSessionsService.findResumable(pctx, scopeKey, now);
    if (session) return { session, earlier: null };
    const row = await withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
      planChangeSessionRepository.findLatestConversationInScope(
        pctx.projectId,
        scopeKey,
        pctx.workspaceId,
        null,
        tx,
      ),
    );
    return {
      session: null,
      earlier: row
        ? {
            id: row.id,
            targetKeys: row.targetKeys,
            lastActivityAt: row.lastActivityAt.toISOString(),
            startedBy: row.createdBy,
            mine: row.createdById === pctx.userId,
          }
        : null,
    };
  },

  /**
   * RESUME-OR-START with the member's FIRST TURN — the only way a conversation
   * comes into existence (AMENDMENT 17 §1). In ONE transaction:
   *
   *  1. take the member's scope lock ({@link planChangeSessionRepository.lockScopeForUser});
   *  2. RE-READ the resumable session UNDER it — so a second tab that sent its
   *     first turn a moment earlier is found here, and this turn lands on THAT
   *     session instead of forking a second one (the read-derived-write rule:
   *     the choice between append and create reads `lastActivityAt`);
   *  3. resume it (refreshing its target lease) — or create a new session and
   *     take the scope's target lock, TAKING OVER any live lease the member's
   *     own older sessions of this scope still hold (§6) rather than being
   *     refused by their own earlier conversation;
   *  4. append the turn, which moves `lastActivityAt`.
   *
   * The result is the session the turn landed on, so a caller that lost the race
   * observes the winner's id. `ai:plan`-gated: it writes.
   */
  async startWithFirstTurn(
    pctx: ProjectContext,
    scope: PlanChangeScope,
    body: string,
    opts: { isAnswer?: boolean } = {},
  ): Promise<PlanChangeSessionDto> {
    const trimmed = body.trim();
    if (!trimmed) throw new EmptyPlanChangeTurnError();
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    await assertCanPlan(pctx.projectId, ctx);
    const now = new Date();

    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        const sessionId = await resumeOrStartWithin(pctx, scope, now, tx);

        const row = await appendWithin(
          sessionId,
          pctx,
          { role: 'user', body: trimmed, authorId: pctx.userId, isAnswer: opts.isAnswer === true },
          {},
          tx,
        );
        return toDto(row, pctx, tx);
      },
    );
  },

  /**
   * The PUBLIC `open` doors' resume-or-start (MOTIR-6028) — `POST
   * /api/v1/projects/{key}/plan-session` and the MCP `open_plan_session`. The
   * caller's resumable session for the scope, or a NEW one, under the same lock
   * and lease hand-over as {@link startWithFirstTurn}, and with no turn.
   *
   * ⚠️ WHY AN OPEN MAY CREATE HERE AND NOT IN THE BROWSER (AMENDMENT 17 §1).
   * The browser's mount is a LOOK and creates nothing. These doors are an
   * explicit act by an API client or agent that is about to talk — and the
   * deployed `motir plan` CLI reads a session (its id and thread) from `open`
   * before its first turn, so returning nothing would break every shipped
   * client. The session this creates is a `conversation` like any other.
   */
  async openForScope(pctx: ProjectContext, scope: PlanChangeScope): Promise<PlanChangeSessionDto> {
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    await assertCanPlan(pctx.projectId, ctx);
    const now = new Date();
    const row = await withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        const sessionId = await resumeOrStartWithin(pctx, scope, now, tx);
        const session = await planChangeSessionRepository.findById(sessionId, pctx.workspaceId, tx);
        if (!session) throw new PlanSessionNotFoundError(sessionId);
        return session;
      },
    );
    return toDto(row, pctx);
  },

  // ── The PUBLIC doors (MOTIR-6028) ─────────────────────────────────────────
  // The v1 plan-session routes and the MCP `open_plan_session` /
  // `append_plan_turn` / `submit_plan_session` tools share ONE resolution, here,
  // so the two surfaces cannot drift. Each takes an OPTIONAL `sessionId`: given,
  // it addresses exactly that session (another project's is
  // `PLAN_SESSION_NOT_FOUND`); absent, the caller keeps the pre-session
  // behaviour — their resumable session for the scope, or a first turn starts
  // one — so a client built before the id existed keeps working.

  /** Open: the named session, else the caller's resumable one, else a new one. */
  async openPublic(
    pctx: ProjectContext,
    scope: PlanChangeScope,
    sessionId?: string,
  ): Promise<PlanChangeSessionDto> {
    if (!sessionId) return planChangeSessionsService.openForScope(pctx, scope);
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    await assertCanPlan(pctx.projectId, ctx);
    return toDto(await findSessionById(pctx, sessionId), pctx);
  },

  /** Append: to the named session (re-taking its targets, as a continuing
   *  conversation does), else resume-or-start with this turn. */
  async appendPublic(
    pctx: ProjectContext,
    scope: PlanChangeScope,
    body: string,
    sessionId?: string,
  ): Promise<PlanChangeSessionDto> {
    if (!sessionId) return planChangeSessionsService.startWithFirstTurn(pctx, scope, body);
    await requireSession(pctx, { sessionId });
    await planTargetLockService.acquireForScope(sessionId, scope.targetKeys, pctx);
    return planChangeSessionsService.appendTurn(body, pctx, { sessionId });
  },

  /** Submit: the named session, else the caller's resumable one — with neither
   *  there is nothing to submit (`PLAN_CHANGE_SESSION_NOT_FOUND`). */
  async submitPublic(
    pctx: ProjectContext,
    scope: PlanChangeScope,
    requirement?: SubmittedRequirement,
    sessionId?: string,
  ): Promise<PlanChangeSubmitResultDto> {
    // Gated by the SIBLINGS it delegates to (`findResumable` browse, `submit`
    // `ai:plan`) — `tests/permissions/noUngovernedOperation.test.ts` follows this
    // `this.` hop as its real-code control.
    const id = sessionId ?? (await this.findResumable(pctx, scope.scopeKey))?.id;
    if (!id) throw new PlanChangeSessionNotFoundError(pctx.projectId);
    return this.submit(pctx, { sessionId: id }, requirement);
  },

  /**
   * Append what the user just typed to the thread and return the UPDATED session
   * (the full ordered thread included — the rail renders straight from it).
   * Appending does NOT submit: turns accumulate until the user asks for the
   * change, which is what makes refinement across turns possible.
   *
   * `address` names WHICH conversation, by its `{ sessionId }`.
   *
   * `isAnswer` marks the turn as the REPLY to the planner's pending question
   * (MOTIR-2226) — set by the composer's answer bar, and by nothing else. It
   * changes no behaviour on the way in; it is recorded so the transcript can say
   * later whether the question was answered or merely superseded, which is a
   * judgement the words themselves cannot be asked to carry.
   */
  async appendTurn(
    body: string,
    pctx: ProjectContext,
    address: PlanChangeSessionAddress,
    opts: { isAnswer?: boolean; intent?: PlanChangeTurnIntent; jobId?: string } = {},
  ): Promise<PlanChangeSessionDto> {
    const trimmed = body.trim();
    if (!trimmed) throw new EmptyPlanChangeTurnError();
    const session = await requireSession(pctx, address);
    return appendLocked(session, pctx, {
      role: 'user',
      body: trimmed,
      authorId: pctx.userId,
      isAnswer: opts.isAnswer === true,
      // ⚠️ SERVER-RESOLVED (ADR §1). `opts.intent` is what the ASK SERVICE
      // decided after motir-ai classified the turn — never a value parsed off a
      // request body. The shipped plan-change append passes nothing and its
      // turns keep a null intent, exactly as every turn written before the
      // model existed does; that is why there is no back-fill.
      intent: opts.intent ?? null,
      ...(opts.jobId ? { jobId: opts.jobId } : {}),
    });
  },

  /**
   * Append the ANSWER an ask produced, as an `assistant` turn carrying its
   * CITATIONS (MOTIR-1818; ADR §1). The write half of the ask loop —
   * `recordPlannerTurn` is its plan-change sibling, and the two deliberately
   * share `appendLocked`'s row-locked allocation rather than growing a second
   * append path.
   *
   * IDEMPOTENT ON `jobId`, the same guarantee and the same mechanism the planner
   * turn has: the client records the answer when its stream settles, and a
   * reload, a second tab or a retried settle all replay that call. The skip is
   * evaluated UNDER the session lock, so two concurrent replays cannot both pass
   * it.
   *
   * CITATIONS ARE VALIDATED BEFORE THEY PERSIST — see {@link resolveCitations}.
   * A key that names no work item IN THIS PROJECT is dropped rather than stored,
   * because the rail renders each one as a work-item chip and a chip that
   * resolves to nothing is worse than a missing citation: it asserts the answer
   * rested on something it did not.
   */
  async appendAnswerTurn(
    input: { jobId: string; body: string; citations?: readonly string[] },
    pctx: ProjectContext,
    address: PlanChangeSessionAddress,
  ): Promise<PlanChangeSessionDto> {
    const trimmed = input.body.trim();
    if (!trimmed) throw new EmptyPlanChangeTurnError();
    const session = await requireSession(pctx, address);
    const citations = await resolveCitations(input.citations ?? [], pctx);
    return appendLocked(
      session,
      pctx,
      { role: 'assistant', body: trimmed, jobId: input.jobId, citations },
      {},
      async (tx) =>
        (await planChangeTurnRepository.findByJobIdAndRole(
          session.id,
          input.jobId,
          'assistant',
          pctx.workspaceId,
          tx,
        )) !== null,
    );
  },

  /**
   * Record what a `user` turn actually RAN AS (MOTIR-1818; ADR §1/§3).
   *
   * Two callers, one write. The REDIRECT: `ask_project` classified the turn as a
   * plan change, so the effective disposition moves before the plan-change job
   * is dispatched. The CORRECTION: the person pressed "Propose changes instead"
   * / "Answer this instead", so the turn is re-run the other way — same turn, no
   * second `user` row, because the thread is a record of who said what and they
   * said it once. `corrected` is what separates the two on the record.
   *
   * Under the session's row lock, so it cannot interleave with an append. A turn
   * id that is not on this thread — or is on another tenant's — raises
   * `PlanChangeTurnNotFoundError` rather than silently patching nothing.
   */
  async recordTurnIntent(
    turnId: string,
    intent: PlanChangeTurnIntent,
    pctx: ProjectContext,
    opts: { corrected?: boolean; jobId?: string } = {},
    address: PlanChangeSessionAddress,
  ): Promise<PlanChangeSessionDto> {
    const session = await requireSession(pctx, address);
    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        const locked = await planChangeSessionRepository.lockById(session.id, tx);
        if (!locked) throw new PlanChangeSessionNotFoundError(pctx.projectId);
        const turn = await planChangeTurnRepository.findByIdInSession(
          turnId,
          session.id,
          pctx.workspaceId,
          tx,
        );
        if (!turn) throw new PlanChangeTurnNotFoundError(turnId);
        await planChangeTurnRepository.updateIntent(
          turn.id,
          {
            intent,
            ...(opts.jobId ? { jobId: opts.jobId } : {}),
            // `corrected` LATCHES: a turn re-read a second time stays corrected,
            // because what the flag records is that Motir once got it wrong, and
            // that does not stop being true.
            intentCorrected: opts.corrected === true || turn.intentCorrected,
          },
          tx,
        );
        // A correction is the member acting on the thread, so it moves
        // `lastActivityAt` like a turn does (AMENDMENT 17 §3).
        const fresh = await planChangeSessionRepository.update(
          session.id,
          { lastActivityAt: new Date() },
          tx,
        );
        return toDto(fresh, pctx, tx);
      },
    );
  },

  /**
   * Record the PLANNER's turn for a settled job — the consuming half of
   * MOTIR-2222's contract (MOTIR-2226).
   *
   * The planning job's result carries a findings report and, when the request was
   * not determinate, one question. This persists that utterance as an `assistant`
   * turn so it lands in the thread's history: the report becomes a checkpoint the
   * user can act on, and a question becomes something that survives a reload and
   * can still be answered tomorrow.
   *
   * THREE properties this method exists to hold, none of which the caller can be
   * asked to guarantee:
   *
   *  1. **At most one turn per job.** The client records on settle, and a reload,
   *     a second tab or a re-read replays that call — so the append carries an
   *     idempotency gate on `(session, jobId, assistant)`, evaluated under the
   *     session's row lock. Every replay after the first is a no-op that returns
   *     the thread unchanged.
   *  2. **Only the thread's OWN job.** The job id arrives from the client, so it
   *     is checked against the session's `lastJobId` rather than trusted: a job
   *     this conversation did not submit has no business narrating into it.
   *  3. **A silent job is not a failure.** No result, no `turn`, or an
   *     unreadable one (an older engine, a kind that emits none) returns the
   *     thread as it stands. The run still happened and its proposals are still
   *     on the canvas; the only thing missing is narration.
   *
   * SIDE-EFFECTS-OUTSIDE-TX (CLAUDE.md): the motir-ai read and the reference
   * normalization both happen BEFORE the short locked append, so no session row
   * is held across a network round-trip.
   */
  async recordPlannerTurn(
    jobId: string,
    pctx: ProjectContext,
    address: PlanChangeSessionAddress,
  ): Promise<PlanChangeSessionDto> {
    const session = await requireSession(pctx, address);
    // (2) The thread narrates its OWN run. A mismatch is not an error — the
    // client may simply be replaying a stale settle after a newer turn — so it
    // yields the current thread rather than throwing at the user.
    if (session.lastJobId !== jobId) return toDto(session, pctx);

    const job = await getJob(jobId, pctx.projectId);
    const utterance = readPlanningTurn(job.result);
    if (!utterance) return toDto(session, pctx); // (3)

    // The report names work items by bare key; rewriting them to the canonical
    // `[KEY](motir:<id>)` token is what makes them render as the shipped
    // `WorkItemRefChip` rather than as plain text — the same write-side
    // normalization every stored body gets (MOTIR-1440), reused, not reinvented.
    //
    // BOUND, and the binding is opened HERE rather than threaded (MOTIR-2960).
    // `normalizeBodyRefs` resolves key → id through `findByIdentifiers`, whose
    // `tx ?? db` falls back to the singleton; `work_item` is workspace-keyed, so
    // an unbound resolve under `motir_app` matches no row and returns `[]` —
    // with no error and no log. The failure is therefore SILENT and total: every
    // key stays plain text and `workItemRefs` comes back empty, which reads as
    // "the planner linked nothing" rather than as a fault. The other four
    // `normalizeBodyRefs` callers sit inside a write transaction and pass its
    // `tx`; this one normalizes BEFORE `appendLocked` opens its short lock
    // (side-effects-outside-tx, above), so there is no `tx` to thread and the
    // correct fix is its own read-only binding — the same shape `toDto` uses a
    // few hundred lines up for exactly this reason (MOTIR-2846).
    const [normalized] = await withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
      normalizeBodyRefs(
        {
          projectId: pctx.projectId,
          projectIdentifier: pctx.project.identifier,
          fields: [utterance.message],
        },
        tx,
      ),
    );

    return appendLocked(
      session,
      pctx,
      {
        role: 'assistant',
        body: typeof normalized === 'string' ? normalized : utterance.message,
        jobId,
        question: utterance.question,
      },
      {},
      // (1) Under the lock, so two concurrent replays cannot both pass it.
      async (tx) =>
        (await planChangeTurnRepository.findByJobIdAndRole(
          session.id,
          jobId,
          'assistant',
          pctx.workspaceId,
          tx,
        )) !== null,
    );
  },

  /**
   * Submit the thread's ACCUMULATED intent to the shipped plan-edit job contract
   * and record the submission on the thread.
   *
   * The job is an ordinary `augment` — the rail streams it via the existing
   * `GET /api/ai/augment/[jobId]` and approves the delta via the existing
   * approve route; this seam adds neither. The marker turn's body IS the exact
   * intent that went out, so the thread carries its own provenance (what was
   * sent, and which job it became) with no invented, untranslatable copy.
   *
   * Ordering is deliberate: the motir-ai round-trip happens OUTSIDE the
   * transaction, which then only records the outcome.
   *
   * A CONTEXTUAL thread (7.12.3 · MOTIR-909 — one whose `targetKeys` are
   * non-empty) submits through the same job contract with the anchor set attached,
   * so motir-ai (7.12.2 · MOTIR-908) classifies the turn against those items'
   * neighborhood. The thread's own scope decides that — there is no second submit
   * surface and no second job kind.
   *
   * `requirement` (Story MOTIR-3942 · MOTIR-4172) is the optional six-field WHAT
   * the caller settled before submitting, riding through to `context.requirement`
   * on the envelope. It is a PASS-THROUGH: this seam neither validates it,
   * defaults it, nor persists it on the thread.
   *
   * ⚠️ BOTH ARMS OF THE FORK BELOW CARRY IT, stated rather than left to be read
   * off the code. A dispatched agent's re-plan is always ANCHORED, so the
   * contextual arm is the one that matters in practice and the augment arm is
   * the one that would go unnoticed if it silently dropped the value — which is
   * exactly why it does not. The two arms differ in what motir-ai classifies the
   * turn AGAINST, never in what reaches the envelope.
   *
   * ⚠️ AND IT IS NOT WRITTEN ONTO THE THREAD. The prose turns are the thread's
   * record and the marker turn's body stays byte-identical to the intent that
   * went out; persisting the struct back onto the session is a different seam
   * (MOTIR-4159), and writing it here would give the thread a second, silently
   * divergent copy of the same value.
   */
  async submit(
    pctx: ProjectContext,
    address: PlanChangeSessionAddress,
    requirement?: SubmittedRequirement,
  ): Promise<PlanChangeSubmitResultDto> {
    const session = await requireSession(pctx, address);
    const turns = await withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
      planChangeTurnRepository.listBySessionId(session.id, pctx.workspaceId, tx),
    );
    const intent = buildAccumulatedIntent(turns);
    if (!intent) throw new EmptyPlanChangeIntentError(session.id);

    // Side effect OUTSIDE the tx: the shipped submit path (tenant/org resolution,
    // code context, the metered motir-ai job). Its typed errors (out-of-credits /
    // transport) propagate for the route to map — a failed submit leaves the
    // thread untouched, so the user can retry without losing their turns. A
    // failure therefore also yields NO plan: `submitPlanEditJob` opens the Plan
    // only AFTER the job is accepted, so there is no `planId` to report and no
    // orphan row to clean up.
    const { jobId, planId } =
      session.targetKeys.length > 0
        ? await aiPlanEditsService.submitContextual(intent, session.targetKeys, pctx, requirement, {
            sessionId: session.id,
          })
        : await aiPlanEditsService.submitAugment(intent, pctx, requirement, {
            sessionId: session.id,
          });

    const updated = await appendLocked(
      session,
      pctx,
      { role: 'system', body: intent, jobId },
      { lastJobId: jobId, lastSubmittedAt: new Date() },
    );
    // HEARTBEAT (MOTIR-2787). Submitting is the thread proving it is alive, so it
    // pushes the target lease out by a fresh window. Without this a conversation
    // longer than one lease would have its own targets swept out from under it;
    // with it, the window only starts running down once the session goes quiet —
    // which is exactly the condition the sweep exists to detect. A thread holding
    // nothing refreshes nothing.
    await planTargetLockService.refreshForSession(session.id, pctx);
    // `planId` is PASSED THROUGH, never re-derived: the submit above already
    // opened exactly one `generating` Plan bound to `jobId` (MOTIR-1743), so
    // this seam opens none of its own (MOTIR-1745).
    return { jobId, planId, session: updated };
  },
};
