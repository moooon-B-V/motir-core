// The planner's NARRATION, as a value (Story MOTIR-8060 · Subtask MOTIR-8062):
// the caps both write doors enforce and the one cleaner every stored sentence —
// and every stored step-words title — goes through. Pure: no I/O.

/** The longest sentence the store keeps, in CODE POINTS (not UTF-16 units). */
export const PLAN_NARRATION_SENTENCE_MAX = 240;

/** The most sentences one narration call may carry. */
export const PLAN_NARRATION_BATCH_MAX = 20;

const WHITESPACE_RUN = /\s+/gu;
const CONTROL = /\p{Cc}/gu;

/**
 * One planner sentence as it is stored: every whitespace run (newlines and tabs
 * included) collapsed to one space, any remaining control character dropped,
 * trimmed, and cut to {@link PLAN_NARRATION_SENTENCE_MAX} code points ending in
 * `…` when longer. `null` when nothing is left — the caller refuses it.
 *
 * The cut is on code points (`Array.from`), so it never splits a surrogate pair
 * and never cuts inside a CJK character.
 */
export function cleanNarrationSentence(raw: string): string | null {
  const text = raw.replace(WHITESPACE_RUN, ' ').replace(CONTROL, '').trim();
  if (text.length === 0) return null;
  const points = Array.from(text);
  if (points.length <= PLAN_NARRATION_SENTENCE_MAX) return text;
  return `${points.slice(0, PLAN_NARRATION_SENTENCE_MAX - 1).join('')}…`;
}
