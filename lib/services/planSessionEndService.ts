import type { Prisma, PlanChangeSession, PlanSessionEndReason } from '@/generated/prisma/client';

import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { planRevisionsService } from '@/lib/services/planRevisionsService';
import { PlanChangeSessionNotFoundError } from '@/lib/planChange/errors';

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
}

/** What an end did: `ended` is false when the session had already ended, in
 *  which case `session` is the FIRST end, untouched. */
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

  const session = await planChangeSessionRepository.update(
    sessionId,
    { endedAt: now, endReason: reason, endedById: by.endedById },
    tx,
  );
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
    }),
  );
}

export const planSessionEndService = { endSession, endSessionWithin };
