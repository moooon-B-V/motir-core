import { Prisma, type PlanChangeMailboxEntry } from '@/generated/prisma/client';

import type { ProjectContext } from '@/lib/projects';

/**
 * The tenancy this service needs, and no more.
 *
 * ⚠️ IT IS NARROWER THAN `ProjectContext`, DELIBERATELY. That type carries a
 * `project: ProjectDTO` because it is the ACTIVE-project context a browser
 * request resolves. The READ DOOR has no browser and no active project: it is
 * authenticated by a job token, whose claims are exactly a user, a workspace and
 * a project ID. Requiring the DTO there would mean loading a project row to
 * satisfy a type, on the hottest path in this file — a read every phase boundary
 * of every planning run makes.
 *
 * A `ProjectContext` is assignable to it, so the session-authenticated door
 * passes its own context through unchanged.
 */
export type MailboxContext = Pick<ProjectContext, 'userId' | 'workspaceId' | 'projectId'>;
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planChangeMailboxRepository } from '@/lib/repositories/planChangeMailboxRepository';
import { getJob } from '@/lib/ai/motirAiClient';
import type { MailboxDeliveryDto } from '@/lib/dto/planChangeMailbox';
import {
  EmptyPlanChangeTurnError,
  PlanChangeJobNotRunningError,
  PlanChangeMailboxJobMismatchError,
  PlanChangeSessionNotFoundError,
  PlanChangeTurnConflictError,
} from '@/lib/planChange/errors';

// THE BOUNDARY MAILBOX (Story MOTIR-4054 · MOTIR-4067) — the pipe between a user
// who is still typing and a planning job that has already read its envelope.
//
// WHAT THIS IS NOT: a way to interrupt a run. A planning job reads `requestJson`
// once, at dispatch, and the obvious repair — deliver input as a signal — is the
// wrong one, settled next door by MOTIR-3942 / MOTIR-4060 and not re-opened
// here. A planning session is a COHERENT ACT: a card authored half under one set
// of instructions and half under another is written from two minds, and nothing
// downstream can tell which half came from where. So this is STORAGE THE JOB
// CHECKS, at a phase boundary it already has, never a mechanism that preempts
// it. A turn that arrives during an `author` sits until that author finishes.
//
// ⚠️ THE READ SHAPE IS A TWO-REPO CONTRACT AND THE CONSUMER LANDED FIRST.
// `motir-ai` `src/llm/mailbox.ts` (MOTIR-4060, merged) already accepts
// `{ turns: [{ id, text, receivedAt, disposition, target }], stopped }`, and its
// parse is TOTAL: an unreadable body, a 404, a core that predates the contract —
// all read as an empty mailbox rather than failing a run. This side matches that
// shape rather than designing a second one and reconciling later, and
// {@link toDelivery} is the single place it is built.
//
// 4-layer + concurrency (CLAUDE.md): this service owns the transactions and the
// DTO mapping; the repository is single-op leaves. Appending is READ-DERIVED —
// the next `seq` comes from the job's own top row — so every append locks the
// SESSION row (`SELECT … FOR UPDATE`) and re-reads inside the transaction (the
// lock-before-read-derived-update rule); `(session_id, job_id, seq)` is the DB
// backstop, translated from P2002 to a typed conflict so no raw Prisma error
// escapes.
//
// ⚠️ THE SESSION ROW IS THE LOCK, not a mailbox row, and it is the SAME lock
// `planChangeSessionsService`'s turn appends take. That is deliberate: the two
// writers serialize against each other, which costs nothing (both are short
// writes on one thread) and removes the question of whether a mailbox append can
// interleave with a transcript append. It does not; there is one lock per
// conversation.
//
// SIDE-EFFECTS-OUTSIDE-TX (CLAUDE.md): the RUNNING check calls motir-ai over the
// network. It happens BEFORE the short transaction that writes the row — a
// conversation row is never locked across a motir-ai round-trip.

/**
 * The `JobStatus` values that still have a phase boundary ahead of them.
 * `queued` counts: the job has not started, so every boundary is ahead of it.
 * Everything else — `succeeded`, `failed`, `canceled` — is terminal, and a turn
 * addressed there would sit unread for ever.
 */
const RUNNING_STATUSES: ReadonlySet<string> = new Set(['queued', 'running']);

export interface AttachTurnInput {
  /** The run this turn is addressed at. Must be the thread's current run. */
  jobId: string;
  /** What the user typed. */
  body: string;
  /**
   * The caller's own stable key for this delivery — what makes a retry a no-op.
   * The client supplies it (a request id, the composer's draft id); the server
   * does not invent one, because a server-invented key cannot recognise the
   * SAME submit arriving twice.
   */
  idempotencyKey: string;
  /** `fold` (default) or `restart`. */
  disposition?: 'fold' | 'restart';
  /** Where a `restart` re-anchors the walk. Ignored on a `fold`. */
  restartTarget?: string | null;
}

/** Build the two-repo contract's shape from rows. The ONE place it is built. */
function toDelivery(
  entries: readonly PlanChangeMailboxEntry[],
  stopped: boolean,
): MailboxDeliveryDto {
  return {
    // Already `seq`-ordered by the repository. The array IS the order claim:
    // `readDelivery` sorts on `receivedAt` and breaks ties on array index, so
    // two entries written in the same millisecond still arrive in the order they
    // were typed.
    turns: entries
      .filter((e) => e.kind === 'turn')
      .map((e) => ({
        id: e.id,
        text: e.body ?? '',
        receivedAt: e.createdAt.toISOString(),
        disposition: e.disposition ?? 'fold',
        target: e.restartTarget,
      })),
    stopped,
  };
}

/**
 * Allocate `seq` and write ONE entry, under the session's row lock.
 *
 * Shared by the turn append and the stop so BOTH allocate the same safe way — a
 * second allocation route for the stop would quietly reintroduce exactly the
 * ordering the one-pipe rule exists to guarantee.
 *
 * `idempotencyKey` is checked INSIDE the lock and returns the existing row on a
 * hit. Checked outside, two concurrent replays would both see "not there yet"
 * and both insert, and only the unique index would stop them — which turns a
 * correct retry into a 409.
 */
async function appendLocked(
  sessionId: string,
  pctx: MailboxContext,
  entry: {
    jobId: string;
    kind: 'turn' | 'stop';
    body?: string | null;
    disposition?: 'fold' | 'restart' | null;
    restartTarget?: string | null;
    idempotencyKey: string;
    authorId?: string | null;
  },
): Promise<PlanChangeMailboxEntry> {
  return withWorkspaceContext(
    { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
    async (tx) => {
      const locked = await planChangeSessionRepository.lockById(sessionId, tx);
      if (!locked) throw new PlanChangeSessionNotFoundError(pctx.projectId);

      const existing = await planChangeMailboxRepository.findByIdempotencyKey(
        sessionId,
        entry.jobId,
        entry.idempotencyKey,
        pctx.workspaceId,
        tx,
      );
      if (existing) return existing;

      const seq = await planChangeMailboxRepository.nextSeq(
        sessionId,
        entry.jobId,
        pctx.workspaceId,
        tx,
      );
      try {
        return await planChangeMailboxRepository.create(
          {
            workspaceId: pctx.workspaceId,
            sessionId,
            jobId: entry.jobId,
            seq,
            kind: entry.kind,
            body: entry.body ?? null,
            disposition: entry.disposition ?? null,
            restartTarget: entry.restartTarget ?? null,
            idempotencyKey: entry.idempotencyKey,
            authorId: entry.authorId ?? null,
          },
          tx,
        );
      } catch (err) {
        // The `(session_id, job_id, seq)` unique fired: some writer claimed this
        // position without holding the lock. Surface the typed conflict — a raw
        // P2002 never escapes the service.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new PlanChangeTurnConflictError(sessionId, seq);
        }
        throw err;
      }
    },
  );
}

/**
 * The thread that is RUNNING this job, by the job — or null.
 *
 * ⚠️ THE JOB IS NOT A FREE PARAMETER. The mailbox is keyed by `(session, job)`,
 * and `job_id` is an opaque motir-ai token; without this the caller could write
 * an entry under their own session addressed at a run that is not theirs — read
 * by nobody, but existing. Resolving the session BY `last_job_id` makes the
 * address DERIVABLE from the tree rather than asserted by the request, so there
 * is no unbound `jobId` anywhere in this service.
 *
 * It also answers for the right thread when a project has several: a contextual
 * conversation and the project-wide one are different rows, and the mailbox
 * belongs to whichever of them SUBMITTED this job.
 */
async function findThreadForJob(jobId: string, pctx: MailboxContext) {
  return withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
    planChangeSessionRepository.findByProjectAndLastJobId(
      pctx.projectId,
      jobId,
      pctx.workspaceId,
      tx,
    ),
  );
}

/**
 * …and the same read as a REQUIREMENT, for the two write doors.
 *
 * One error for both "no such thread" and "that is not the run this thread is
 * on", deliberately: from the caller's side they are the same fact, and telling
 * them apart would answer a question about somebody else's job. It is the
 * no-existence-leak posture the rest of `lib/planChange/errors.ts` takes.
 */
async function requireThreadForJob(
  jobId: string,
  pctx: MailboxContext,
): Promise<{ sessionId: string }> {
  const session = await findThreadForJob(jobId, pctx);
  if (!session) throw new PlanChangeMailboxJobMismatchError(jobId);
  return { sessionId: session.id };
}

export const planChangeMailboxService = {
  /**
   * Attach ONE turn to the RUNNING job of this project's conversation.
   *
   * The order of the three gates is a contract rather than a detail:
   *
   *  1. the thread must exist and must be ON this job (a 404 — no existence leak);
   *  2. the body must be non-blank (a 400 — nothing to deliver);
   *  3. the job must still be RUNNING (a 409, and the network call, so it is the
   *     LAST thing tried and never paid for by a request that was going to fail
   *     anyway).
   *
   * Only then does the short locked write happen.
   */
  async attachTurn(input: AttachTurnInput, pctx: MailboxContext): Promise<MailboxDeliveryDto> {
    const body = input.body.trim();
    const { sessionId } = await requireThreadForJob(input.jobId, pctx);
    if (!body) throw new EmptyPlanChangeTurnError();

    // ⚠️ OUTSIDE the transaction, deliberately (side-effects-outside-tx): this
    // is a motir-ai round-trip, and a conversation row is never locked across
    // one.
    const job = await getJob(input.jobId, pctx.projectId);
    if (!RUNNING_STATUSES.has(job.status)) {
      throw new PlanChangeJobNotRunningError(input.jobId, job.status);
    }

    const entry = await appendLocked(sessionId, pctx, {
      jobId: input.jobId,
      kind: 'turn',
      body,
      disposition: input.disposition ?? 'fold',
      restartTarget: input.disposition === 'restart' ? (input.restartTarget ?? null) : null,
      idempotencyKey: input.idempotencyKey,
      authorId: pctx.userId,
    });

    // The caller gets the mailbox AS IT NOW STANDS, not just the row it wrote —
    // which is what lets the composer show "two queued" without a second read,
    // and what makes a retry's answer identical to the original's.
    return planChangeMailboxService.peek(input.jobId, entry.sessionId, pctx);
  },

  /**
   * RAISE THE STOP — the same pipe, taking the other kind.
   *
   * ⚠️ SCOPE. This is the pipe's write, and it is all of it: what a stop does to
   * the JOB's terminal state, to the plan, and to the surface is MOTIR-4068's,
   * and there is deliberately no route here for it. What this owns is that a
   * stop and a turn typed before it share one ordered sequence, so neither can
   * overtake the other — which is only true because they are one table with one
   * `seq`, and would stop being true the moment a stop got a channel of its own.
   *
   * ⚠️ AND MARKING THE JOB STOPPED IS NOT A STOP UNTIL THE WALK ASKS. The run
   * ends when `runWalk` reads this at its next phase boundary, which can be a
   * whole authoring session away. Nothing here shortens that interval, and the
   * surface must not claim it did.
   */
  async raiseStop(
    jobId: string,
    idempotencyKey: string,
    pctx: MailboxContext,
  ): Promise<MailboxDeliveryDto> {
    const { sessionId } = await requireThreadForJob(jobId, pctx);
    // No RUNNING check: stopping an already-finished run is a NO-OP that answers
    // cleanly, not an error. The control is reachable in states where the click
    // is redundant — the run may settle between render and click — so it has to
    // be safe there, and an entry nobody reads is harmless where a refusal the
    // user cannot act on is not.
    const entry = await appendLocked(sessionId, pctx, {
      jobId,
      kind: 'stop',
      idempotencyKey,
      authorId: pctx.userId,
    });
    return planChangeMailboxService.peek(jobId, entry.sessionId, pctx);
  },

  /**
   * What is waiting, WITHOUT consuming it — the read the composer makes to show
   * its own queued state.
   *
   * Separate from {@link readForBoundary} on purpose: a surface asking "what did
   * I queue?" must not claim the delivery the run has not read yet. The two
   * differ in exactly one thing, and it is the one that matters.
   */
  async peek(jobId: string, sessionId: string, pctx: MailboxContext): Promise<MailboxDeliveryDto> {
    return withWorkspaceServiceContext(pctx.workspaceId, async (tx) => {
      const pending = await planChangeMailboxRepository.listPending(
        sessionId,
        jobId,
        pctx.workspaceId,
        tx,
      );
      const stopped = await planChangeMailboxRepository.hasStop(
        sessionId,
        jobId,
        pctx.workspaceId,
        tx,
      );
      return toDelivery(pending, stopped);
    });
  },

  /**
   * ONE BOUNDARY CHECK — what `motir-ai` reads, and the read that CONSUMES.
   *
   * Everything it returns is stamped `consumed_at` in the SAME transaction, so a
   * turn read at one boundary is not read again at the next. That is at-MOST-once
   * delivery and it is the deliberate half of a trade: the alternative leaves a
   * turn unclaimed until the run acknowledges it, and a run that dies mid-fold
   * would then re-fold the same sentence into the next run's session. The
   * consumer is idempotent on `id` as well (`consumedTurnIds` in
   * `treeGeneration.ts`), so the two guards compose — this one survives a job
   * retry, which the in-process set does not.
   *
   * ⚠️ THE STOP IS NOT CONSUMED. It is derived from EXISTENCE, so every boundary
   * after the first still reads `stopped: true` — a run that has been ended stays
   * ended, and a consumed stop would silently un-stop the next check.
   *
   * ⚠️ AND AN EMPTY MAILBOX IS AN ANSWER, NOT A FAILURE. This returns
   * `{ turns: [], stopped: false }` and a 200; the caller's *"could not tell"* is
   * a transport error or a non-2xx, which `readDelivery` reads as empty anyway.
   * The two are distinguishable at the wire, which is what the card asks for:
   * only "nothing waiting" lets the run proceed on the strength of the answer.
   */
  async readForBoundary(jobId: string, pctx: MailboxContext): Promise<MailboxDeliveryDto> {
    const session = await findThreadForJob(jobId, pctx);
    // A job with no thread — deleted mid-flight, or a run this project never
    // submitted — has an EMPTY mailbox, which is true and is the reading
    // `readDelivery` would arrive at anyway. Not an error: a run whose thread
    // vanished must finish, not fail. ⚠️ And it is a 200 either way, because the
    // card's own criterion is that the run can tell "nothing waiting" from
    // "could not tell" — only the first lets it proceed on the answer, and a
    // failure shaped like an empty mailbox erases that distinction.
    if (!session) return { turns: [], stopped: false };

    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        // The lock serializes two boundary checks that race (a retried job, a
        // duplicated worker): the loser re-reads and finds the entries already
        // consumed rather than delivering them twice.
        const locked = await planChangeSessionRepository.lockById(session.id, tx);
        if (!locked) return { turns: [], stopped: false };

        const pending = await planChangeMailboxRepository.listPending(
          session.id,
          jobId,
          pctx.workspaceId,
          tx,
        );
        const stopped = await planChangeMailboxRepository.hasStop(
          session.id,
          jobId,
          pctx.workspaceId,
          tx,
        );
        await planChangeMailboxRepository.markConsumed(
          pending.map((e) => e.id),
          pctx.workspaceId,
          new Date(),
          tx,
        );
        return toDelivery(pending, stopped);
      },
    );
  },
};
