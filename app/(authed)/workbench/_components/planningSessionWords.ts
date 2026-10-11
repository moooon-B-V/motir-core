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

// ── Situation 2 (Story MOTIR-7905 · MOTIR-7940; design § 38) ───────────────────────────────

/** The three forms an entry takes, by the server's `ToResumeForm`. */
export type ResumeEntryForm =
  | 'failed_walk'
  | 'failed_beside_waiting_plan'
  | 'ended_with_waiting_plan';

/**
 * What an entry offers. **Resume only on a failed walk**: a failure beside a waiting plan is
 * continued by the next turn in the overlay, and a session that ended is carried into a new
 * conversation by its next message — a Resume on either would be refused by the server.
 */
export function entryControlsOf(form: ResumeEntryForm): { resume: boolean; open: true } {
  switch (form) {
    case 'failed_walk':
      return { resume: true, open: true };
    case 'failed_beside_waiting_plan':
    case 'ended_with_waiting_plan':
      return { resume: false, open: true };
    default: {
      const unreachable: never = form;
      return unreachable;
    }
  }
}

/** The waiting plan's state in words (`workbench.planningSession.form.b.*`) — TOTAL. */
export function waitingPlanStateKeyOf(status: 'planned' | 'stale'): 'stateWaiting' | 'stateStale' {
  return status === 'stale' ? 'stateStale' : 'stateWaiting';
}

/** The next step on a form-B entry's own line: reply to carry on, or plan it again. */
export function nextStepKeyOf(status: 'planned' | 'stale'): 'nextReply' | 'nextAgain' {
  return status === 'stale' ? 'nextAgain' : 'nextReply';
}

/** The held line's key (`workbench.planningSession.left.*`) for an entry that left. */
export type LeftLineKey = 'turn' | 'carry' | 'decided' | 'again';

/**
 * Why a form-B / C entry left the read. Form A's held line is *Resuming*, never this, so it
 * answers `null`. `decided` is what a read of the plan found; the rest are inferred.
 */
export function leftLineKeyOf(
  form: ResumeEntryForm,
  status: 'planned' | 'stale' | null,
  decided: boolean,
): LeftLineKey | null {
  if (form === 'failed_walk') return null;
  if (decided) return 'decided';
  if (form === 'ended_with_waiting_plan') return 'carry';
  return status === 'stale' ? 'again' : 'turn';
}
