import type { Prisma, PlanChangeSession, PlanSessionEndReason } from '@/generated/prisma/client';

import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  CLEARED_AWAITING_COLUMNS,
  CLEARED_FAILURE_COLUMNS,
  sessionWaitingState,
} from '@/lib/planChange/sessionWaitingState';
import {
  withSystemContext,
  withWorkspaceContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';
import { PLAN_TARGET_LOCK_LEASE_MS } from '@/lib/planChange/targetLock';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { planRevisionsService } from '@/lib/services/planRevisionsService';
import { PlanChangeSessionNotFoundError } from '@/lib/planChange/errors';
import {
  failureRecordFrom,
  type JobWalkPosition,
  type JobWalkStop,
} from '@/lib/planChange/failureRecord';
import type { PlanSessionFailureRecord } from '@/lib/planChange/sessionWaitingState';
import { getJob } from '@/lib/ai/motirAiClient';
import { clearWithin as clearPlanningSessionGate } from '@/lib/services/planningSessionGateService';

// THE ONE END OPERATION (story MOTIR-7630 · MOTIR-7637;
// `docs/decisions/agent-authored-plans.md` AMENDMENT 23 §2).
//
// A planning session is OPEN exactly while `ended_at IS NULL`, and this module is
// the only writer of its end. Six events end a session — a failed attempt, an
// idle close, a restart, a decline, an approve and the abandoned-plan sweep — and
// every one of them comes through here, so each gives the cards back the same
// way and none can end a session twice.
//
// Its own module rather than a method on `planChangeSessionsService` because
// `plansService` calls it from inside the decision transactions, and the
// conversation service already reaches `plansService` through the plan-edit
// service: one import the other way would close the cycle.

/** Who ended a session, and in whose name its cards are given back. */
export interface PlanSessionEndActor {
  /** The PERSON who ended it — the decider, or the person who restarted. `null`
   *  when Motir ended it (a failed attempt, an idle close). */
  endedById: string | null;
  /** The user each status restore is signed with. For a person it is that
   *  person; for Motir it is resolved by {@link endSession} when omitted. */
  actor: ServiceContext;
  now?: Date;
  /** The IDLE CLOSE's guard, checked under the session's lock: end only if the
   *  session's last activity is still older than this AND it holds no undecided
   *  plan. A turn that landed after the sweep's discovery read wins. */
  onlyIfIdleBefore?: Date;
}

/** What an end did: `ended` is false when the session had already ended, in
 *  which case `session` is the FIRST end, untouched — or, for the idle close,
 *  when the session turned out not to be idle, in which case it is still open. */
export interface PlanSessionEndResult {
  ended: boolean;
  session: PlanChangeSession;
}

/** The reasons whose end leaves the session's cards and its `generating` plan to
 *  this operation. `approved` / `declined` are a plan decision, whose own
 *  transaction already decides the plan and releases its locks after commit. */
const OPERATION_OWNS_RELEASE: ReadonlySet<PlanSessionEndReason> = new Set([
  'failed',
  'idle',
  'restarted',
]);

/**
 * END A SESSION INSIDE THE CALLER'S TRANSACTION.
 *
 * Under the session's row lock: an ended session returns its first end and
 * writes nothing (the idempotence every caller leans on — a relay frame and the
 * sweep may both see one failure). Otherwise it stamps `endedAt` / `endReason` /
 * `endedById` and, for a `failed` / `idle` / `restarted` end:
 *
 *   * discards the session's LATEST plan if it is still `generating` — as
 *     `abandoned` with no decider when Motir ended it, as `discarded` by the
 *     person who restarted. A `planned` or `stale` plan waits for a person and
 *     is left exactly as it is;
 *   * gives back everything the session (and that discarded plan) held, restoring
 *     each card's prior status as a system write.
 *
 * ⚠️ LOCK ORDER IS PLAN, THEN SESSION — the order the decision bodies take them
 * (`declineWithin` locks the plan and then ends its session here). Taking the
 * session first would let a person's discard of a generating plan and a relay's
 * failure end deadlock on the two rows.
 */
export async function endSessionWithin(
  tx: Prisma.TransactionClient,
  sessionId: string,
  workspaceId: string,
  reason: PlanSessionEndReason,
  by: PlanSessionEndActor,
): Promise<PlanSessionEndResult> {
  const now = by.now ?? new Date();
  const ownsRelease = OPERATION_OWNS_RELEASE.has(reason);
  const latestPlanId = ownsRelease
    ? await planRepository.findLatestIdBySession(sessionId, tx)
    : null;
  if (latestPlanId) await planRepository.lockById(latestPlanId, tx);

  const locked = await planChangeSessionRepository.lockById(sessionId, tx);
  if (!locked) throw new PlanChangeSessionNotFoundError(sessionId);
  const fresh = await planChangeSessionRepository.findById(sessionId, workspaceId, tx);
  if (!fresh) throw new PlanChangeSessionNotFoundError(sessionId);
  if (fresh.endedAt) return { ended: false, session: fresh };
  if (by.onlyIfIdleBefore) {
    // A session that is WAITING (failed, or awaiting its person) is never idle: a
    // mark that landed between the discovery read and this lock wins (MOTIR-7912).
    const stillIdle =
      sessionWaitingState(fresh) === 'open' &&
      fresh.lastActivityAt < by.onlyIfIdleBefore &&
      (await planRepository.countUndecidedBySession(sessionId, tx)) === 0;
    if (!stillIdle) return { ended: false, session: fresh };
  }

  const session = await planChangeSessionRepository.update(
    sessionId,
    {
      endedAt: now,
      endReason: reason,
      endedById: by.endedById,
      // AN ENDED SESSION WAITS ON NOTHING (MOTIR-7908). The `plan_change_session_one_wait`
      // CHECK requires it, so the one end write clears BOTH waits — a failed attempt
      // waiting to resume, and a conversation awaiting its person — in the same
      // statement. Anything that ends a session through this operation gets that for
      // free; nothing else may write `endedAt`.
      ...CLEARED_FAILURE_COLUMNS,
      ...CLEARED_AWAITING_COLUMNS,
    },
    tx,
  );
  // THE PLANNING-SESSION GATE ENDS WITH THE SESSION (MOTIR-7913): withdrawn `session_ended`
  // in the same transaction as the end write, whatever the reason. The end write above
  // already nulled the marker; this supersedes the gate row.
  await clearPlanningSessionGate(tx, { sessionId, cause: 'session_ended' });
  if (!ownsRelease) return { ended: true, session };

  if (latestPlanId) {
    const plan = await planRepository.findById(latestPlanId, workspaceId, tx);
    if (plan?.status === 'generating') {
      const byPerson = reason === 'restarted' && by.endedById !== null;
      await planRepository.update(
        plan.id,
        {
          status: 'declined',
          decidedAt: now,
          decidedById: byPerson ? by.endedById : null,
          decisionReason: byPerson ? 'discarded' : 'abandoned',
        },
        tx,
      );
      // A person's discard is a decision and goes on the trail, as
      // `declineWithin` records one. Motir's is not — the abandoned sweep has
      // never recorded its `abandoned` either; the reason on the row says it.
      if (byPerson) {
        await planRevisionsService.recordRevision(
          {
            planId: plan.id,
            changeKind: 'declined',
            changedById: by.endedById!,
            diff: { decisionReason: 'discarded', sessionEnd: reason },
          },
          tx,
        );
      }
      await planTargetLockService.releaseForPlanWithin(plan.id, by.actor, tx, { system: true });
    }
  }
  await planTargetLockService.releaseForSessionWithin(sessionId, by.actor, tx, { system: true });
  return { ended: true, session };
}

/**
 * END A SESSION IN ITS OWN TRANSACTION — the door for a caller that holds no
 * transaction: the stream relays, the two sweeps and the restart control.
 *
 * Binds the session's OWN workspace and project, so a background caller with no
 * acting user ends it under the right tenant. When `actor` is omitted (Motir
 * ended it), the restores are signed by the session's starter, falling back to
 * the workspace's stand-in manager — the same answer the lock sweep gives.
 */
export async function endSession(
  sessionId: string,
  reason: PlanSessionEndReason,
  opts: {
    workspaceId: string;
    endedById?: string | null;
    actorId?: string | null;
    now?: Date;
    onlyIfIdleBefore?: Date;
  },
): Promise<PlanSessionEndResult> {
  const { workspaceId } = opts;
  const located = await withWorkspaceServiceContext(workspaceId, async (tx) => {
    const session = await planChangeSessionRepository.findById(sessionId, workspaceId, tx);
    if (!session) return null;
    const signer =
      opts.actorId ??
      session.createdById ??
      (await workspaceMembershipRepository.findStandInManagerByWorkspace(workspaceId, tx))
        ?.userId ??
      null;
    return { session, signer };
  });
  if (!located) throw new PlanChangeSessionNotFoundError(sessionId);
  if (located.session.endedAt) return { ended: false, session: located.session };
  const { session, signer } = located;
  // A workspace always has a manager, so this is a corrupt tenant, not a race.
  if (!signer) throw new Error(`[planSessionEnd] nobody can sign the end of session ${sessionId}`);

  return withWorkspaceContext({ userId: signer, workspaceId, projectId: session.projectId }, (tx) =>
    endSessionWithin(tx, sessionId, workspaceId, reason, {
      endedById: opts.endedById ?? null,
      actor: { userId: signer, workspaceId },
      now: opts.now,
      onlyIfIdleBefore: opts.onlyIfIdleBefore,
    }),
  );
}

/**
 * END THE SESSION WHOSE ATTEMPT JUST FAILED (MOTIR-7638; AMENDMENT 23 §2) — the
 * stream relays call it on a terminal `failed` / `canceled` frame.
 *
 * The session is the one whose `lastJobId` is this job: only the session's
 * CURRENT attempt ends it. An older job of a session that has since submitted
 * again names no session, so its failure ends nothing. A job no session owns
 * (a work item's contextual plan) is a no-op. Idempotent with the abandoned-plan
 * sweep, which ends the same session as a backstop.
 */
export async function endSessionForFailedJob(
  jobId: string,
  ctx: { userId: string; workspaceId: string; projectId: string },
): Promise<PlanSessionEndResult | null> {
  const session = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    planChangeSessionRepository.findByProjectAndLastJobId(
      ctx.projectId,
      jobId,
      ctx.workspaceId,
      tx,
    ),
  );
  if (!session || session.endedAt) return null;
  // No `actorId`: Motir ended it, so the restores are signed by the session's
  // starter, whoever happens to be watching the stream.
  return endSession(session.id, 'failed', { workspaceId: ctx.workspaceId });
}

/** What {@link recordFailureWithin} did. */
export type RecordFailureOutcome = 'recorded' | 'ended' | 'plan_not_generating' | 'not_latest';

/**
 * RECORD A FAILED ATTEMPT ON ITS OPEN SESSION, INSIDE THE CALLER'S TRANSACTION
 * (MOTIR-7912; `agent-authored-plans.md` AMENDMENT 23's 2026-10-09 sub-amendment).
 *
 * The replacement for ending: nothing is declined, nothing is released — the plan
 * stays `generating` with its proposals and the cards stay held. Same lock order as
 * {@link endSessionWithin}: the latest plan, then the session, and the waiting state
 * is re-read UNDER the session's lock, so a person's end (or the other writer of the
 * same failure) that landed first wins deterministically.
 *
 * Only a `generating` LATEST plan is a failed walk; anything else is
 * `'plan_not_generating'` and the caller falls back to the existing end. When
 * `onlyPlanId` is given (the sweep), that plan must still be the session's latest.
 */
export async function recordFailureWithin(
  tx: Prisma.TransactionClient,
  sessionId: string,
  workspaceId: string,
  record: PlanSessionFailureRecord,
  opts: { onlyPlanId?: string } = {},
): Promise<RecordFailureOutcome> {
  const latestPlanId = await planRepository.findLatestIdBySession(sessionId, tx);
  if (latestPlanId) await planRepository.lockById(latestPlanId, tx);
  const locked = await planChangeSessionRepository.lockById(sessionId, tx);
  if (!locked) throw new PlanChangeSessionNotFoundError(sessionId);
  const fresh = await planChangeSessionRepository.findWaitingState(sessionId, workspaceId, tx);
  if (!fresh || fresh.endedAt) return 'ended';
  if (opts.onlyPlanId !== undefined && latestPlanId !== opts.onlyPlanId) return 'not_latest';
  const plan = latestPlanId ? await planRepository.findById(latestPlanId, workspaceId, tx) : null;
  if (plan?.status !== 'generating') return 'plan_not_generating';
  return (await planChangeSessionRepository.markFailed(sessionId, record, tx))
    ? 'recorded'
    : 'ended';
}

/** What a settled failure came to. */
export interface SettleFailedJobResult {
  settled: 'recorded' | 'ended';
  sessionId: string;
}

/** The seam a test replaces: what motir-ai says about the failed job. */
export interface SettleFailedJobDeps {
  readJob?: (
    jobId: string,
    coreProjectId: string,
  ) => Promise<{ error: { code: string; message?: string } | null; walkStop: JobWalkStop | null }>;
}

/**
 * SETTLE THE SESSION WHOSE ATTEMPT JUST ENDED BADLY (MOTIR-7912) — the stream
 * relays call it on a terminal `failed` / `canceled` frame, replacing the old
 * unconditional end.
 *
 * The session is the one whose `lastJobId` is this job: only the CURRENT attempt
 * counts, an older job of a session that has submitted again names none, and a job
 * no session owns is a no-op. Then:
 *
 *   * a `failed` job on an open `conversation` session whose latest plan is
 *     `generating` → the failure is RECORDED, the session stays open;
 *   * a `canceled` job (someone chose to stop), a `guide` session, or a latest plan
 *     that is not `generating` → the existing end, unchanged.
 */
export async function settleFailedJob(
  jobId: string,
  ctx: { userId: string; workspaceId: string; projectId: string },
  input: { status: 'failed' | 'canceled'; lastPosition?: JobWalkPosition | null },
  deps: SettleFailedJobDeps = {},
): Promise<SettleFailedJobResult | null> {
  const session = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    planChangeSessionRepository.findByProjectAndLastJobId(
      ctx.projectId,
      jobId,
      ctx.workspaceId,
      tx,
    ),
  );
  if (!session || session.endedAt) return null;

  const end = async (): Promise<SettleFailedJobResult> => {
    // No `actorId`: Motir ended it, so the restores are signed by the session's starter.
    await endSession(session.id, 'failed', { workspaceId: ctx.workspaceId });
    return { settled: 'ended', sessionId: session.id };
  };
  if (input.status === 'canceled' || session.origin !== 'conversation') return end();

  const job = await (deps.readJob ?? readFailedJob)(jobId, ctx.projectId).catch(() => null);
  const record = failureRecordFrom({
    failedJobId: jobId,
    now: new Date(),
    walkStop: job?.walkStop ?? null,
    lastPosition: input.lastPosition ?? null,
    error: job?.error ?? null,
  });
  const outcome = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    recordFailureWithin(tx, session.id, ctx.workspaceId, record),
  );
  if (outcome === 'recorded') return { settled: 'recorded', sessionId: session.id };
  if (outcome === 'ended') return null;
  return end();
}

async function readFailedJob(jobId: string, coreProjectId: string) {
  const view = await getJob(jobId, coreProjectId);
  return { error: view.error, walkStop: view.walkStop };
}

/**
 * END THE SESSION OF A PLAN THE ABANDONED SWEEP JUST DECLINED (MOTIR-7638) — the
 * backstop for an attempt nobody was watching. Only when that plan is still the
 * session's LATEST: a session that has moved on to a newer plan is not this
 * attempt's to end. Idempotent with the relay: a session it already ended
 * returns its first end.
 */
export async function endSessionForAbandonedPlan(plan: {
  id: string;
  workspaceId: string;
  sessionId: string | null;
}): Promise<PlanSessionEndResult | null> {
  const sessionId = plan.sessionId;
  if (!sessionId) return null;
  const latest = await withWorkspaceServiceContext(plan.workspaceId, (tx) =>
    planRepository.findLatestIdBySession(sessionId, tx),
  );
  if (latest !== plan.id) return null;
  return endSession(sessionId, 'failed', { workspaceId: plan.workspaceId });
}

/** Sessions ended per idle-close pass; a backlog drains over several passes. */
export const PLAN_SESSION_IDLE_CLOSE_BATCH_SIZE = 200;

/**
 * THE IDLE CLOSE (MOTIR-7638; AMENDMENT 23 §2) — run by the lock sweep every 5
 * minutes. Ends as `idle` every open, non-`guide` session with no undecided plan
 * whose last activity is older than the session lease, whether or not it holds a
 * lock. A session's lease is refreshed on every turn, so its lease expiry and its
 * idle deadline are the same instant: a person mid-conversation is never closed,
 * and a session whose plan waits for a decision stays open until that decision.
 *
 * CROSS-TENANT discovery, PER-TENANT end, exactly like the lease sweep: the read
 * runs under the system context and each end binds the session's own workspace
 * and re-checks idleness under the row lock.
 */
export async function closeIdleSessions(
  now: Date = new Date(),
  batchSize: number = PLAN_SESSION_IDLE_CLOSE_BATCH_SIZE,
): Promise<{ closed: number; sessionIds: string[] }> {
  const olderThan = new Date(now.getTime() - PLAN_TARGET_LOCK_LEASE_MS);
  const idle = await withSystemContext((tx) =>
    planChangeSessionRepository.listIdleOpen(olderThan, batchSize, tx),
  );
  const sessionIds: string[] = [];
  for (const session of idle) {
    const out = await endSession(session.id, 'idle', {
      workspaceId: session.workspaceId,
      now,
      onlyIfIdleBefore: olderThan,
    });
    if (out.ended) sessionIds.push(session.id);
  }
  return { closed: sessionIds.length, sessionIds };
}

export const planSessionEndService = {
  closeIdleSessions,
  endSession,
  endSessionWithin,
  endSessionForFailedJob,
  endSessionForAbandonedPlan,
  settleFailedJob,
};
