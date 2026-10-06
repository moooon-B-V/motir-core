// Plan something new (Story MOTIR-7631 · MOTIR-7649; `docs/decisions/
// conversation-turn-intent.md` AMENDMENT 3, A3.2) — the fixed text of the two
// turns core writes for a restart, with no model call.
//
// They are PERSISTED as the turns' `body`, so the thread stays a readable record
// in any reader (the Plans page, an export, a database row). The overlay does not
// render these strings: it reads the turn's `confirm` marker and renders the
// confirm from the message catalogue, in the viewer's language.

/** The confirm's body (A3.2). Its answers are controls, never typed text. */
export const NEW_SESSION_CONFIRM_BODY =
  'Start something new? This closes the current planning session and gives its work items back.';

/** The `system` marker Keep planning writes (A3.2). It is identified by its
 *  POSITION — the turn right after a confirm — never by these words. */
export const KEEP_PLANNING_MARKER_BODY = 'Kept planning.';

/** The two answers the restart door takes (A3.3). */
export const RESTART_ANSWERS = ['confirm', 'keep'] as const;
export type RestartAnswer = (typeof RESTART_ANSWERS)[number];

export function isRestartAnswer(value: unknown): value is RestartAnswer {
  return value === 'confirm' || value === 'keep';
}
