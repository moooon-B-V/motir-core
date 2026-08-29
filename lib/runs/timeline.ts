import type {
  DispatchCardDisposition,
  DispatchEventKind,
  DispatchRunStatus,
  DispatchSkipReason,
} from '@/generated/prisma/client';

// The RUN SECTION's pure vocabulary (Story MOTIR-1789 · MOTIR-1796) — the maps
// that turn the record's four enums into something a surface can draw, and
// nothing else. No React, no Prisma client, no `db`: it is imported by a CLIENT
// island and by `dispatchRunService` alike, which is the whole reason it is its
// own module.
//
// ⚠️ EVERY MAP HERE IS `satisfies Record<Enum, …>`, AND THAT IS THE POINT.
// `design/runs/design-notes.md` records the failure these prevent: a step that
// renders as nothing because nobody wrote a case for a new event kind is
// indistinguishable from a run that had no such step, and a disposition that
// falls through to a plausible neighbour is worse — it says something FALSE
// confidently. `satisfies` turns each of those into a compile error in this
// file, which is the one place a person adding an enum member is already
// looking.

/** The ordered steps a CARD's timeline draws, and the order it draws them in. */
export const CARD_STEPS = [
  'claimed',
  'checkout',
  'prompt',
  'agent',
  'exit',
  'delivery',
  'settled',
] as const;

export type CardStep = (typeof CARD_STEPS)[number];

/**
 * Which STEP an event advances — TOTAL over `DispatchEventKind`.
 *
 * `null` means *this event is not a step on a card's timeline*, and it is a
 * deliberate value rather than an omission. Two kinds of event get it:
 *
 *   · **RUN-scoped events** (`run_opened`, `scope_claimed`, `snapshot_frozen`,
 *     `session_pr`, `plan_approved`, `run_closed`). They are about the run, and
 *     the run VIEW draws them. Rendering them on a card's timeline would tell a
 *     reader that something happened TO THIS CARD when it did not.
 *   · **`log`**, which is the opt-in body and belongs in the console rather
 *     than in the step list.
 *
 * A future kind added to the schema fails this file's `satisfies` and must be
 * given an answer — including, legitimately, `null`.
 */
export const EVENT_STEP = {
  // RUN-scoped — the run view's, not this card's.
  run_opened: null,
  scope_claimed: null,
  snapshot_frozen: null,
  session_pr: null,
  plan_approved: null,
  run_closed: null,

  // CARD-scoped.
  card_claimed: 'claimed',
  card_skipped: 'settled',
  checkout_ready: 'checkout',
  prompt_issued: 'prompt',
  agent_started: 'agent',
  agent_exited: 'exit',
  leg_verdict: 'settled',
  delivery_linked: 'delivery',
  // What THIS RUN observed of CI. It advances no step: the card's CI state is
  // the delivery set's, derived once by `derivePrCiState`, and a second verdict
  // on one page is how two answers to *is it green* appear.
  ci_verdict: null,
  ci_fix_attempt: null,
  ci_gave_up: null,
  card_settled: 'settled',
  log: null,
} as const satisfies Record<DispatchEventKind, CardStep | null>;

/**
 * The area's TONE vocabulary, as class-free names.
 *
 * The tones themselves are `design/runs/design-notes.md` § THE TONE VOCABULARY
 * — ten statuses over five backgrounds, the hue in a dot rather than in the ink.
 * This maps a value to a tone NAME; the component maps a name to tokens, so the
 * two enums below can share tones without either importing the other's chips.
 */
export type RunTone =
  | 'queued'
  | 'running'
  | 'integrated'
  | 'implemented'
  | 'failed'
  | 'replanned'
  | 'skipped'
  | 'cancelled'
  | 'timedout'
  | 'offline';

/** A LEG's disposition → its tone. TOTAL over `DispatchCardDisposition`. */
export const DISPOSITION_TONE = {
  queued: 'queued',
  running: 'running',
  integrated: 'integrated',
  implemented: 'implemented',
  failed: 'failed',
  replanned: 'replanned',
  skipped: 'skipped',
  // ⚠️ `not_reached` SHARES `queued`'s tone deliberately — both mean *nothing
  // ran*, and the LABEL is what tells them apart. The notes refuse a ninth tint
  // for a distinction the reader does not need.
  not_reached: 'queued',
} as const satisfies Record<DispatchCardDisposition, RunTone>;

/**
 * A RUN's status → its tone. TOTAL over `DispatchRunStatus`.
 *
 * ⚠️ `succeeded` carries the `implemented` tone, which means a run that ended
 * because an agent REFUSED its card and submitted a re-plan reads as a success
 * here — and it is one. The service derives the status from the stop reason and
 * only `halted` is a failure; the leg's own `replanned` tone is what says the
 * card was refused. The two are different facts and are drawn in different
 * places on purpose.
 */
export const RUN_STATUS_TONE = {
  running: 'running',
  succeeded: 'implemented',
  failed: 'failed',
  cancelled: 'cancelled',
  timed_out: 'timedout',
} as const satisfies Record<DispatchRunStatus, RunTone>;

/**
 * IS THIS RUN STILL GOING? — the live / terminal partition, stated ONCE.
 *
 * ⚠️ THIS IS THE ONLY DEFINITION, and it lives in a pure module for that
 * reason: `dispatchRunService` reads it on the server to answer
 * `?status=live|past`, and the run SECTION reads it in the browser to decide
 * whether to open a stream at all. A second copy is how one surface comes to
 * believe a run is finished while another still shows it running.
 *
 * `timed_out` is TERMINAL on purpose: it is what the abandoned-run reap writes
 * for a run whose machine stopped reporting, so the run is over whatever the
 * process is doing.
 */
export const RUN_IS_LIVE = {
  running: true,
  succeeded: false,
  failed: false,
  cancelled: false,
  timed_out: false,
} as const satisfies Record<DispatchRunStatus, boolean>;

export const isLiveRun = (status: DispatchRunStatus): boolean => RUN_IS_LIVE[status];

const statusesWhere = (live: boolean): DispatchRunStatus[] =>
  (Object.keys(RUN_IS_LIVE) as DispatchRunStatus[]).filter((s) => RUN_IS_LIVE[s] === live);

/** The statuses a run is still going in — what `?status=live` narrows to. */
export const DISPATCH_RUN_LIVE_STATUSES = statusesWhere(true);
/** The statuses a run has finished in — what `?status=past` narrows to. */
export const DISPATCH_RUN_PAST_STATUSES = statusesWhere(false);

/**
 * A skip reason's i18n key suffix — TOTAL over `DispatchSkipReason`, which has
 * **SEVEN** members and not six.
 *
 * ⚠️ SIX IS THE NUMBER A *BATCH SNAPSHOT* CAN CARRY; SEVEN IS THE NUMBER THE
 * *RECORD* CAN. `packages/cli/src/batchPlan.ts`'s `SKIP_LABEL` is
 * `Record<SnapshotSkipReason, string>` and has six, so anything counting from
 * that file gets six — but the schema says plainly that `DispatchSkipReason` is
 * *"the union of `SkipRecord.reason` and `SnapshotSkipReason`"*, and the extra
 * member comes from the other side of that union: **`blocked_in_scope`**, which
 * only a SCOPED run can produce (MOTIR-3199 — the claim took every member in the
 * to-do category, `blocked` included, which is not the same as being allowed to
 * build one out of order; it is skipped and NAMED, never forced).
 *
 * This map is where that was caught, by the `satisfies` and nothing else. Every
 * count of six in this story's prose and in `design/runs/run-view.mock.html`
 * came from reading the batch file, and a surface total over six enum members
 * out of seven renders the seventh as nothing.
 *
 * The SENTENCES are the CLI's, carried into the catalog rather than re-worded:
 * a skip shown without its reason says nothing, and a skip shown with a
 * DIFFERENT reason than the terminal printed is worse than either.
 */
export const SKIP_REASON_KEY = {
  needs_planning: 'needsPlanning',
  needs_human: 'needsHuman',
  integrated_dep: 'integratedDep',
  claim_refused: 'claimRefused',
  replan_submitted: 'replanSubmitted',
  checkout_unavailable: 'checkoutUnavailable',
  blocked_in_scope: 'blockedInScope',
} as const satisfies Record<DispatchSkipReason, string>;
