import type { PlanChangeTurnDto } from '@/lib/dto/planChange';

// The plan-change thread's DERIVED state (MOTIR-2226; design `design/ai-chat/`
// § "The planner SPEAKS in the plan-change thread", states A–E).
//
// ⭐ AWAITING IS DERIVED, NOT STORED CLIENT-SIDE. The rail is waiting on an
// answer exactly when THE LAST PLANNER TURN IS A QUESTION WITH NO USER TURN
// AFTER IT. That one sentence is the whole state machine, and deriving it from
// the persisted thread — rather than from a flag the rail sets when a question
// arrives — is what makes the design's panel C hold: the same session reopened
// hours later, from a cold start, comes back to the identical answer bar,
// placeholder and button, because the thread it reads has not changed.
//
// The opposite (a `useState` set when the question streams in) loses the pending
// question on the first navigation. That is not a cosmetic loss: the planner is
// BLOCKED on the answer, so a user who navigates away is left with a plan that
// never arrives and nothing on screen explaining why.
//
// Pure functions over the DTO thread, exported for direct unit testing — the
// rail, the composer and the marker rendering all read the same derivation
// rather than each re-deciding it.

/**
 * The question the thread is currently waiting on, or null when it is not
 * waiting.
 *
 * Scanning from the END is what makes both closing conditions fall out of one
 * pass: the first `user` turn seen means whatever question preceded it is
 * already disposed of (answered or superseded — state C or E), and the first
 * `assistant` turn seen is the latest planner turn, which is a question only if
 * it carries one. A `system` marker is provenance, not conversation, and neither
 * opens nor closes the state.
 */
export function pendingQuestion(turns: readonly PlanChangeTurnDto[]): PlanChangeTurnDto | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]!;
    if (turn.role === 'user') return null;
    if (turn.role === 'assistant') return turn.question === null ? null : turn;
  }
  return null;
}

/** How a question that is no longer pending was DISPOSED of. */
export type QuestionDisposition = 'answered' | 'superseded';

/**
 * The disposition marker owed BENEATH `turn`, or null when `turn` owes none.
 *
 * A marker is owed by the USER turn that closed a question — not by the question
 * itself — which is why it renders under the reply rather than under the ask:
 * that is where the design draws it, and it is the moment the thread actually
 * changed direction.
 *
 * `answered` when that user turn was sent through the answer bar (state C,
 * "Answered — planning resumed"); `superseded` when it changed the subject and
 * the planner carried on with the original request (state E, "Not answered —
 * Motir AI carried on with what you asked"). The distinction is RECORDED at send
 * time (`isAnswer`), never inferred from the words — a question is rare and a
 * skimmed one kills the thread, so the transcript must say plainly which of the
 * two happened rather than guessing.
 */
export function dispositionMarkerFor(
  turns: readonly PlanChangeTurnDto[],
  index: number,
): QuestionDisposition | null {
  const turn = turns[index];
  if (!turn || turn.role !== 'user') return null;
  // Was a question pending immediately before this turn? Everything up to it is
  // exactly the thread the user was looking at when they sent.
  if (!pendingQuestion(turns.slice(0, index))) return null;
  return turn.isAnswer ? 'answered' : 'superseded';
}
