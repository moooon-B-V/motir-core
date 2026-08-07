import {
  Prisma,
  type PlanChangeSession,
  type PlanChangeTurn,
  type PlanChangeTurnRole,
} from '@/generated/prisma/client';

import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { toPlanChangeSessionDto } from '@/lib/mappers/planChangeMappers';
import { parseWorkItemTokenIds } from '@/lib/mentions/workItemRefs';
import { normalizeBodyRefs } from '@/lib/workItems/normalizeBodyRefs';
import { resolveWorkItemRefSummaries } from '@/lib/workItems/resolveWorkItemRefs';
import { readPlanningTurn } from '@/lib/planning/plannerTurn';
import { getJob } from '@/lib/ai/motirAiClient';
import type { PlanChangeSessionDto, PlanChangeSubmitResultDto } from '@/lib/dto/planChange';
import {
  EmptyPlanChangeIntentError,
  EmptyPlanChangeTurnError,
  PlanChangeSessionNotFoundError,
  PlanChangeTurnConflictError,
} from '@/lib/planChange/errors';
import { PROJECT_SCOPE, PROJECT_SCOPE_KEY, type PlanChangeScope } from '@/lib/planChange/scope';

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
  const turns = await planChangeTurnRepository.listBySessionId(row.id, pctx.workspaceId, tx);
  const ids = turns
    .filter((t) => t.role === 'assistant')
    .flatMap((t) => parseWorkItemTokenIds(t.body));
  const workItemRefs = await resolveWorkItemRefSummaries(
    { ids: [...new Set(ids)], keys: [] },
    pctx.projectId,
    { userId: pctx.userId, workspaceId: pctx.workspaceId },
  );
  return toPlanChangeSessionDto(row, turns, workItemRefs);
}

/** Resolve ONE of the project's conversations — the shared precondition of append
 *  + submit. `scopeKey` selects the thread: `''` is the project-wide one (the
 *  shipped 7.30 behaviour), a canonical anchor-set key is a contextual planning
 *  thread (7.12.3 · MOTIR-909). Access-gated for EDIT: both mutate the thread.
 *  (The per-TARGET view gate is the caller's — `contextualPlanningService`
 *  resolves every anchor through `workItemsService` first, so an anchor the actor
 *  cannot browse never reaches a scope key.) */
async function requireSession(
  pctx: ProjectContext,
  scopeKey: string = PROJECT_SCOPE_KEY,
): Promise<PlanChangeSession> {
  const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
  await projectAccessService.assertCanEdit(pctx.projectId, ctx);
  const session = await planChangeSessionRepository.findByProjectAndScope(
    pctx.projectId,
    scopeKey,
    pctx.workspaceId,
  );
  if (!session) throw new PlanChangeSessionNotFoundError(pctx.projectId);
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
async function appendLocked(
  session: PlanChangeSession,
  pctx: ProjectContext,
  turn: {
    role: PlanChangeTurnRole;
    body: string;
    jobId?: string | null;
    authorId?: string | null;
    question?: string | null;
    isAnswer?: boolean;
  },
  patch: Prisma.PlanChangeSessionUncheckedUpdateInput = {},
  skipIf?: (tx: Prisma.TransactionClient) => Promise<boolean>,
): Promise<PlanChangeSessionDto> {
  return withWorkspaceContext(
    { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
    async (tx) => {
      const locked = await planChangeSessionRepository.lockById(session.id, tx);
      if (!locked) throw new PlanChangeSessionNotFoundError(pctx.projectId);
      // Re-read UNDER the lock: `turnCount` is the read-derived value the next
      // `seq` comes from, and a sibling append may have moved it between the
      // caller's read and this transaction.
      const fresh = await planChangeSessionRepository.findById(session.id, pctx.workspaceId, tx);
      if (!fresh) throw new PlanChangeSessionNotFoundError(pctx.projectId);

      if (skipIf && (await skipIf(tx))) return toDto(fresh, pctx, tx);

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

      const updated = await planChangeSessionRepository.update(
        fresh.id,
        { ...patch, turnCount: seq + 1 },
        tx,
      );
      return toDto(updated, pctx, tx);
    },
  );
}

export const planChangeSessionsService = {
  /**
   * Open the conversation for ONE SCOPE, or RESUME the existing one — the rail's
   * (and the work-item panel's) mount read. Idempotent by construction: the
   * `(project_id, scope_key)` unique admits at most one thread per scope, so a
   * lost create-race re-reads the winner's row and returns it rather than
   * failing.
   *
   * `scope` is derived from an ALREADY-RESOLVED anchor set (`buildScope`), never
   * from raw client input: the caller has resolved and permission-checked every
   * anchor, so an item the actor cannot browse can never become part of a key.
   */
  async getOrCreateForScope(
    pctx: ProjectContext,
    scope: PlanChangeScope = PROJECT_SCOPE,
  ): Promise<PlanChangeSessionDto> {
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    await projectAccessService.assertCanEdit(pctx.projectId, ctx);

    const existing = await planChangeSessionRepository.findByProjectAndScope(
      pctx.projectId,
      scope.scopeKey,
      pctx.workspaceId,
    );
    if (existing) return toDto(existing, pctx);

    try {
      const row = await withWorkspaceContext(
        { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
        (tx) =>
          planChangeSessionRepository.create(
            {
              workspaceId: pctx.workspaceId,
              projectId: pctx.projectId,
              createdById: pctx.userId,
              scopeKey: scope.scopeKey,
              targetKeys: scope.targetKeys,
            },
            tx,
          ),
      );
      return toDto(row, pctx);
    } catch (err) {
      // A concurrent opener won the unique-index race. "Open the conversation" is
      // idempotent, so the right answer is the winner's thread — not an error.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await planChangeSessionRepository.findByProjectAndScope(
          pctx.projectId,
          scope.scopeKey,
          pctx.workspaceId,
        );
        if (winner) return toDto(winner, pctx);
      }
      throw err;
    }
  },

  /**
   * READ one scope's thread without creating it — the entrance's mount read
   * (MOTIR-910). The workspace opens on an item the user may never have planned
   * before, and merely LOOKING at the door must not write a session row; so this
   * returns `null` for a scope that has no thread yet, and the first submitted
   * turn is what creates it (via {@link getOrCreateForScope}).
   *
   * Gated on `canBrowse` rather than `canEdit`: this is a read of a conversation,
   * and the write paths (append / submit) keep their own edit gate.
   */
  async findForScope(
    pctx: ProjectContext,
    scope: PlanChangeScope,
  ): Promise<PlanChangeSessionDto | null> {
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    await projectAccessService.assertCanBrowse(pctx.projectId, ctx);

    const existing = await planChangeSessionRepository.findByProjectAndScope(
      pctx.projectId,
      scope.scopeKey,
      pctx.workspaceId,
    );
    return existing ? toDto(existing, pctx) : null;
  },

  /**
   * Open / resume the PROJECT-WIDE conversation — the shipped 7.30 entry point
   * the planning rail mounts on, unchanged. The one-element case of
   * {@link getOrCreateForScope} with the empty scope.
   */
  async getOrCreateForProject(pctx: ProjectContext): Promise<PlanChangeSessionDto> {
    return this.getOrCreateForScope(pctx, PROJECT_SCOPE);
  },

  /**
   * Append what the user just typed to the thread and return the UPDATED session
   * (the full ordered thread included — the rail renders straight from it).
   * Appending does NOT submit: turns accumulate until the user asks for the
   * change, which is what makes refinement across turns possible.
   *
   * `scopeKey` selects WHICH thread (default: the project-wide one).
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
    scopeKey: string = PROJECT_SCOPE_KEY,
    opts: { isAnswer?: boolean } = {},
  ): Promise<PlanChangeSessionDto> {
    const trimmed = body.trim();
    if (!trimmed) throw new EmptyPlanChangeTurnError();
    const session = await requireSession(pctx, scopeKey);
    return appendLocked(session, pctx, {
      role: 'user',
      body: trimmed,
      authorId: pctx.userId,
      isAnswer: opts.isAnswer === true,
    });
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
    scopeKey: string = PROJECT_SCOPE_KEY,
  ): Promise<PlanChangeSessionDto> {
    const session = await requireSession(pctx, scopeKey);
    // (2) The thread narrates its OWN run. A mismatch is not an error — the
    // client may simply be replaying a stale settle after a newer turn — so it
    // yields the current thread rather than throwing at the user.
    if (session.lastJobId !== jobId) return toDto(session, pctx);

    const job = await getJob(jobId);
    const utterance = readPlanningTurn(job.result);
    if (!utterance) return toDto(session, pctx); // (3)

    // The report names work items by bare key; rewriting them to the canonical
    // `[KEY](motir:<id>)` token is what makes them render as the shipped
    // `WorkItemRefChip` rather than as plain text — the same write-side
    // normalization every stored body gets (MOTIR-1440), reused, not reinvented.
    const [normalized] = await normalizeBodyRefs({
      projectId: pctx.projectId,
      projectIdentifier: pctx.project.identifier,
      fields: [utterance.message],
    });

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
   */
  async submit(
    pctx: ProjectContext,
    scopeKey: string = PROJECT_SCOPE_KEY,
  ): Promise<PlanChangeSubmitResultDto> {
    const session = await requireSession(pctx, scopeKey);
    const turns = await planChangeTurnRepository.listBySessionId(session.id, pctx.workspaceId);
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
        ? await aiPlanEditsService.submitContextual(intent, session.targetKeys, pctx)
        : await aiPlanEditsService.submitAugment(intent, pctx);

    const updated = await appendLocked(
      session,
      pctx,
      { role: 'system', body: intent, jobId },
      { lastJobId: jobId, lastSubmittedAt: new Date() },
    );
    // `planId` is PASSED THROUGH, never re-derived: the submit above already
    // opened exactly one `generating` Plan bound to `jobId` (MOTIR-1743), so
    // this seam opens none of its own (MOTIR-1745).
    return { jobId, planId, session: updated };
  },
};
