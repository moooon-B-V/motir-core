import type { PlanChangeRunPauseDto, PlanChangeTurnDto } from '@/lib/dto/planChange';

// THE PLANNER'S MID-RUN PAUSE, as the rail reads it (Story MOTIR-7990 ·
// MOTIR-8010). Pure derivations over the pause DTO the door ships — no React, no
// fetch — so the rail, the hook and the tests all read the same facts.
//
// ⚠️ THE PAUSED STATE IS DERIVED, NOT STORED. The hosted pause exposes no
// "paused" flag: an unanswered pause on the running job IS the paused state, and
// the rail reads that and nothing else.

/** How often the rail asks whether the planner has paused, and whether the
 *  mailbox has drained — one cadence for both, so a reply's queued → read and the
 *  indicator giving way land together. */
export const MAILBOX_POLL_MS = 3000;

/** The pause a state carries: the poll's read when it has made one (even a `null`
 *  one), else the one the session DTO arrived with. */
export function pauseOf(state: {
  runPause?: PlanChangeRunPauseDto | null;
  session?: { runPause?: PlanChangeRunPauseDto | null } | null;
  jobId?: string | null;
}): PlanChangeRunPauseDto | null {
  const pause = state.runPause !== undefined ? state.runPause : (state.session?.runPause ?? null);
  // A pause on ANOTHER run (the previous one, still in state) is not this run's.
  return pause && state.jobId && pause.jobId !== state.jobId ? null : pause;
}

/** An `unclear` pause nobody has answered: the composer's next turn IS the answer. */
export function isOpenUnclear(pause: PlanChangeRunPauseDto | null): boolean {
  return pause !== null && pause.kind === 'unclear' && pause.answer === null;
}

/**
 * The mailbox entry the thread draws ITSELF for this pause, to pass as `extra`
 * to `threadOwnedMailboxIds`: a decline's and a reply's. START OVER's `restart`
 * turn keeps the standalone render, and an open pause owns nothing.
 */
export function pauseOwnedIds(pause: PlanChangeRunPauseDto | null): string[] {
  if (!pause || !pause.mailboxEntryId) return [];
  return pause.answer === 'apply' || pause.answer === 'replied' ? [pause.mailboxEntryId] : [];
}

/**
 * Where the pause is drawn: the index of the LAST thread turn whose forwarded
 * mailbox entry is one of the pause's change turns, else the last turn, else -1
 * (an empty thread draws it first).
 */
export function pauseAnchorIndex(
  turns: readonly PlanChangeTurnDto[],
  pause: PlanChangeRunPauseDto,
): number {
  let found = -1;
  turns.forEach((turn, i) => {
    const id = turn.forwarded?.mailboxEntryId;
    if (id && pause.changeTurnIds.includes(id)) found = i;
  });
  return found >= 0 ? found : turns.length - 1;
}
