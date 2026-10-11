import type { Prisma } from '@/generated/prisma/client';

import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// THE PLANNING-SESSION GATE'S RAISE AND CLEAR (Story MOTIR-7905 · MOTIR-7913;
// ADR `approval-gates.md` §1's MOTIR-7906 amendment).
//
// A hosted planning session that needs its person is a card-less approval gate whose
// subject is the SESSION. Two things put it there — `question` (the planner stopped with
// a WHAT question) and `reply` (the planner replied and the person left) — and two things
// take it away: the person's next turn (`answered`) and the session's end
// (`session_ended`). Every function here takes a `tx` and is called UNDER THE SESSION'S
// ROW LOCK (`planChangeSessionRepository.lockById`), so the marker on the session and the
// gate row commit together or not at all. A marker without its row, or a row without its
// marker, is a state no read is written for.
//
// ⚠️ THE GATE ROW IS NOT THE SOURCE OF TRUTH FOR "IS THIS SESSION WAITING" — the session's
// marker is (`AWAITING_PERSON_WHERE`). The Waiting on you read admits a gate row only while
// its session still matches that predicate, so a session that failed (it moves to To
// resume) or ended through a writer that did not call this service never shows a stale row.

/**
 * HOW LONG a planner's reply may sit unanswered before the conversation counts as left
 * (MOTIR-7913). One constant: raising at the reply itself would list a session as
 * "waiting on your reply" while the person is still typing in the overlay. The decision
 * may settle a different threshold; this is the one place to change it.
 */
export const AWAITING_REPLY_AFTER_MS = 10 * 60 * 1000;

/** Sessions raised per sweep pass; a backlog drains over several passes. */
export const AWAITING_REPLY_BATCH_SIZE = 200;

export const PLANNING_SESSION_GATE_KIND = 'planning_session' as const;

/**
 * RAISE the gate for a session that now waits on its person, inside the caller's
 * transaction and under the session's lock. Returns whether the session is now waiting
 * with a gate.
 *
 * Does nothing — and writes nothing — for a `guide` session, a session whose origin is not
 * `conversation`, a session with no owner, a failed-waiting one (it waits in To resume) and
 * an ended one. A session ALREADY waiting keeps its `since`; a `question` upgrades a
 * `reply` wait, never the reverse. The gate insert yields to the partial unique index on
 * `(subject_id, kind)`, so a second raise leaves the one row.
 */
export async function raiseWithin(
  tx: Prisma.TransactionClient,
  args: {
    sessionId: string;
    workspaceId: string;
    cause: 'question' | 'reply';
    now?: Date;
  },
): Promise<boolean> {
  const { sessionId, workspaceId, cause } = args;
  const session = await planChangeSessionRepository.findById(sessionId, workspaceId, tx);
  if (
    !session ||
    session.endedAt ||
    session.failedAt ||
    session.origin !== 'conversation' ||
    !session.createdById
  ) {
    return false;
  }

  const already = session.awaitingPersonSince !== null;
  if (already && (session.awaitingPersonCause === cause || cause === 'reply')) return true;

  const since = already ? session.awaitingPersonSince! : (args.now ?? new Date());
  if (!(await planChangeSessionRepository.markAwaitingPerson(sessionId, { cause, since }, tx))) {
    return false;
  }
  await approvalGateRepository.createCardlessAwaitingIfAbsent(
    {
      workspaceId,
      projectId: session.projectId,
      kind: PLANNING_SESSION_GATE_KIND,
      subjectId: sessionId,
      routedToId: session.createdById,
      subjectVersion: since.toISOString(),
    },
    tx,
  );
  return true;
}

/**
 * CLEAR the wait inside the caller's transaction and under the session's lock: null the
 * marker, then withdraw the session's awaiting gate with the cause. Safe on a session
 * that is not waiting — it writes nothing.
 */
export async function clearWithin(
  tx: Prisma.TransactionClient,
  args: { sessionId: string; cause: 'answered' | 'session_ended' },
): Promise<void> {
  await planChangeSessionRepository.clearAwaitingPerson(args.sessionId, tx);
  await approvalGateRepository.supersedeAwaitingCardlessBySubject(
    PLANNING_SESSION_GATE_KIND,
    args.sessionId,
    args.cause,
    tx,
  );
}

/**
 * THE `reply` PASS (run by the 5-minute lock sweep BEFORE the idle close, so the close
 * never reaches a session this pass is about to mark): raise the gate for every
 * conversation the planner replied to that the person has left for longer than
 * {@link AWAITING_REPLY_AFTER_MS}. Discovery is cross-tenant (system context); each raise
 * binds the session's own workspace, takes its lock and RE-CHECKS the predicate, so a turn
 * that landed after discovery wins.
 */
export async function raiseAwaitingReplies(
  now: Date = new Date(),
  batchSize: number = AWAITING_REPLY_BATCH_SIZE,
): Promise<{ raised: number; sessionIds: string[] }> {
  const before = new Date(now.getTime() - AWAITING_REPLY_AFTER_MS);
  const candidates = await withSystemContext((tx) =>
    planChangeSessionRepository.listAwaitingReplyCandidates(before, batchSize, tx),
  );
  const sessionIds: string[] = [];
  for (const candidate of candidates) {
    const raised = await withWorkspaceServiceContext(candidate.workspaceId, async (tx) => {
      if (!(await planChangeSessionRepository.lockById(candidate.id, tx))) return false;
      if (!(await planChangeSessionRepository.isAwaitingReplyCandidate(candidate.id, before, tx))) {
        return false;
      }
      return raiseWithin(tx, {
        sessionId: candidate.id,
        workspaceId: candidate.workspaceId,
        cause: 'reply',
        now,
      });
    });
    if (raised) sessionIds.push(candidate.id);
  }
  return { raised: sessionIds.length, sessionIds };
}

export const planningSessionGateService = {
  raiseWithin,
  clearWithin,
  raiseAwaitingReplies,
};
