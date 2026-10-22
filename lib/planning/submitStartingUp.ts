import { PlanEditsClientError } from '@/lib/planning/planEditsClient';

// A conversation turn's submit that is still waiting on Motir AI (MOTIR-9255).
//
// motir-ai's conversation machines suspend after a minute idle, and waking one
// takes about a minute; the server re-sends the submit under one key for up to
// 90 s meanwhile (`MOTIR_AI_SUBMIT_BUDGET_MS`). So the first turn after a quiet
// spell can sit on its door for a long time with nothing wrong. Past this delay
// the rails say so — "Motir AI is starting up" — instead of looking stuck, and no
// error is drawn while the budget lasts.

/** How long a submit waits before the rail says Motir AI is starting up. */
export const STARTING_UP_AFTER_MS = 8_000;

/** The typed code a submit carries when its budget ran out with Motir AI still
 *  not answering — its own sentence, still with Try again. */
export const MOTIR_AI_UNAVAILABLE = 'MOTIR_AI_UNAVAILABLE';

/**
 * Await a submit, calling `onSlow` once if it has not settled after
 * {@link STARTING_UP_AFTER_MS}. `onSettled` runs however it ends, so the line is
 * always taken back down.
 */
export async function whileStartingUp<T>(
  pending: Promise<T>,
  onSlow: () => void,
  onSettled: () => void,
): Promise<T> {
  const timer = setTimeout(onSlow, STARTING_UP_AFTER_MS);
  try {
    return await pending;
  } finally {
    clearTimeout(timer);
    onSettled();
  }
}

/** `MOTIR_AI_UNAVAILABLE` when a door's refusal is Motir AI not answering, else null. */
export function unavailableCodeOf(err: unknown): typeof MOTIR_AI_UNAVAILABLE | null {
  return err instanceof PlanEditsClientError && err.code === MOTIR_AI_UNAVAILABLE
    ? MOTIR_AI_UNAVAILABLE
    : null;
}
