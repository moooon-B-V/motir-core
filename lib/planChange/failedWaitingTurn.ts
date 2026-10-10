import type { SessionWaitingState } from '@/lib/planChange/sessionWaitingState';

// WHAT A TURN ON A FAILED-WAITING SESSION DOES (Story MOTIR-7905 · MOTIR-7938).
//
// MOTIR-7916 refused EVERY ordinary turn on a failed-waiting session, because the
// ordinary submit would open a second plan beside the held one. That refusal is
// right for a session holding a half-written failed walk (it takes Resume) and a
// dead end for situation 2: a session that is open, failed, and holds a decidable
// `planned` / `stale` plan, whose person asked a change of it. That turn REVISES the
// plan in place through the revise routing, and the bind that records it clears the
// failure.
//
//   - `not_failed`     → the session is not failed-waiting; the shipped routing, unchanged.
//   - `refuse_resume`  → a resumable failed `generating` walk exists (its `sourceJobId` is
//                        the session's `failedJobId`) — even beside an older waiting plan —
//                        or no shape below matches. Resume is the way on; a failure keeps
//                        no third exit.
//   - `continue`       → no resumable walk, and the most recent UNDECIDED plan is
//                        `planned` / `stale`: the shipped routing takes the turn, and the
//                        bind clears the failure.
//
// PURE — no I/O. It keys on the MOST RECENT undecided plan, as `classifySessionTurn`
// does, so the two agree on every failed shape.

export interface FailedWaitingTurnPlan {
  id: string;
  status: 'generating' | 'planned' | 'stale';
  sourceJobId: string | null;
  createdAt: Date;
}

export interface ClassifyFailedWaitingTurnInput {
  waiting: SessionWaitingState;
  failedJobId: string | null;
  plans: readonly FailedWaitingTurnPlan[];
}

export type FailedWaitingTurn = 'not_failed' | 'refuse_resume' | 'continue';

export function classifyFailedWaitingTurn(
  input: ClassifyFailedWaitingTurnInput,
): FailedWaitingTurn {
  if (input.waiting !== 'failed') return 'not_failed';
  const resumable = input.plans.some(
    (p) =>
      p.status === 'generating' &&
      input.failedJobId !== null &&
      p.sourceJobId === input.failedJobId,
  );
  if (resumable) return 'refuse_resume';
  const latest = [...input.plans].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1),
  )[0];
  if (latest && (latest.status === 'planned' || latest.status === 'stale')) return 'continue';
  return 'refuse_resume';
}
