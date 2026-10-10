import { OUT_OF_CREDITS_CODE } from '@/lib/planning/planEditsClient';

// THE WORDS OF A FAILED PLANNING SESSION'S TO RESUME ENTRY (Story MOTIR-7905 ·
// MOTIR-7917; design `design/workbench/design-notes.md` § 37.2 / § 37.6).
//
// Pure, so the maps unit-test without React. Every function returns a KEY under
// `workbench.planningSession.*`, never a sentence: the catalogue owns the words, in both
// locales, and the word ORDER (zh puts the title first).
//
// ⚠️ COPY IS KEYED ON THE STABLE CODE, NEVER ON motir-ai's ENGLISH. `failure.reason` is the
// `reasonCode` core stored (`lib/planChange/failureRecord.ts`); an unknown string — a code a
// newer motir-ai wrote before this build learned it — reads as the `internal` sentence rather
// than leaking the raw code to a person.

/** The five stable reason codes a failed attempt records. */
export const RESUME_REASON_CODES = [
  'rate_limited',
  'out_of_credits',
  'model_unavailable',
  'token_expired',
  'internal',
] as const;
export type ResumeReasonCode = (typeof RESUME_REASON_CODES)[number];

/** The key (under `workbench.planningSession.reason.`) for a stored reason code — TOTAL. */
export function resumeReasonKeyOf(code: string | null | undefined): ResumeReasonCode {
  return RESUME_REASON_CODES.find((known) => known === code) ?? 'internal';
}

/** Where the walk stopped, as the progress line's step words (design § 37.2). */
export type StopPhraseKey = 'lay' | 'layTop' | 'author' | 'draft';

/**
 * `{lay, title}` → *Laying {title}* · `{lay, null}` → *Laying the project's top level* ·
 * `{author, title}` → *Writing {title}* · anything else (no phase, or an `author` with no
 * title to name) → *Drafting a new item*.
 */
export function stopPhraseKeyOf(failure: {
  stopPhase: 'lay' | 'author' | null;
  stopTitle: string | null;
}): StopPhraseKey {
  if (failure.stopPhase === 'lay') return failure.stopTitle ? 'lay' : 'layTop';
  if (failure.stopPhase === 'author' && failure.stopTitle) return 'author';
  return 'draft';
}

/**
 * Every refusal the resume route can answer with (`lib/planChange/errors.ts`, the
 * metered-AI errors a submit can raise), as the key of the sentence that explains it.
 *
 *   · `alreadyStarted` is NOT an error: a concurrent Resume won, so the entry reads as
 *     resuming and is held;
 *   · `ended` / `notFailed` mean the session is no longer waiting to resume — the entry is
 *     held with the sentence and the list is re-read;
 *   · the rest keep the row as it was, with its Resume, so the person can try again.
 */
export type ResumeRefusalKey =
  | 'alreadyStarted'
  | 'ended'
  | 'notFailed'
  | 'notOwner'
  | 'notResumable'
  | 'credits'
  | 'unavailable';

export const RESUME_REFUSAL_KEYS: readonly ResumeRefusalKey[] = [
  'alreadyStarted',
  'ended',
  'notFailed',
  'notOwner',
  'notResumable',
  'credits',
  'unavailable',
];

/** The key for a refusal's stable `code` (and HTTP status, for the credit ceiling) — TOTAL. */
export function resumeRefusalKeyOf(
  code: string | null | undefined,
  status: number | null = null,
): ResumeRefusalKey {
  if (code === OUT_OF_CREDITS_CODE || status === 402) return 'credits';
  switch (code) {
    case 'RESUME_ALREADY_STARTED':
      return 'alreadyStarted';
    case 'PLAN_SESSION_ENDED':
    case 'SESSION_ENDED':
      return 'ended';
    case 'SESSION_NOT_FAILED':
      return 'notFailed';
    case 'NOT_SESSION_OWNER':
      return 'notOwner';
    case 'PLAN_NOT_RESUMABLE':
      return 'notResumable';
    default:
      return 'unavailable';
  }
}

/** Whether a refusal means the session is no longer waiting to resume (hold + re-read). */
export function refusalEndsWaiting(key: ResumeRefusalKey): boolean {
  return key === 'ended' || key === 'notFailed';
}
