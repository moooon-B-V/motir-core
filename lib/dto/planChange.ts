import type { AttachmentDTO } from '@/lib/dto/attachments';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import type { GuideTurnRecord } from '@/lib/ai/guideWorkItem';

// DTO types for the plan-change CONVERSATION (Story 7.30 · MOTIR-1728) — the
// shape that crosses the API boundary. No Prisma row leaks: the
// `PlanChangeTurnRole` enum becomes a string union and every `Date` becomes an
// ISO string. The conversational rail (MOTIR-1730) binds to these.

/** Wire form of the Prisma `PlanChangeTurnRole` enum. `user` turns are what the
 *  person typed (and what the accumulated intent is built from); `system` turns
 *  are thread markers Motir wrote — today, "these turns were submitted", carrying
 *  the resulting job id; `assistant` turns are the PLANNER speaking (MOTIR-2226)
 *  — its findings report, and the one question it asks when the request was not
 *  determinate. */
export type PlanChangeTurnRoleDto = 'user' | 'system' | 'assistant';

/**
 * Wire form of the Prisma `PlanChangeTurnIntent` enum — what a `user` turn asked
 * for (MOTIR-1816 · `docs/decisions/conversation-turn-intent.md`).
 *
 * ⚠️ It travels ONE WAY ONLY. The client never sends an intent; it posts the
 * text and reads back what Motir resolved (ADR §1). A field of this type
 * appearing on a REQUEST body would be the mode the design deliberately does not
 * have, re-entering through the back door.
 *
 * `debug` (MOTIR-7047 · the ADR's AMENDMENT 1) is the third reading: the turn
 * reported broken behaviour, and a `debug_bug` job ran for it.
 */
// `guide` (Story MOTIR-7459 · MOTIR-7464; ADR AMENDMENT 2, A2.1/A2.2): every
// `user` turn of a conversation the Guide me through door opened. Fixed by the
// DOOR, never classified, so it is never corrected (`intentCorrected` stays
// false), and its `anchorKey` is always the guided card.
//
// `new_session` (MOTIR-7649; ADR AMENDMENT 3, A3.1): the turn asked to plan
// something new. `ask_project` redirected it, NO job ran, and core wrote the
// fixed confirm (see {@link PlanChangeTurnConfirmDto}) instead.
export type PlanChangeTurnIntentDto = 'plan_change' | 'ask' | 'debug' | 'guide' | 'new_session';

/** Wire form of the Prisma `PlanChangeTurnConfirm` enum (MOTIR-7649; ADR
 *  AMENDMENT 3, A3.2) — which fixed confirm an `assistant` turn core wrote is. */
export type PlanChangeTurnConfirmDto = 'new_session';

/** One turn on the thread, in `seq` order (0-based, gapless). `jobId` is set on a
 *  `system` submission marker and on an `assistant` turn (the job that produced
 *  it); `authorId` only on a `user` turn (and null once that user is deleted). */
export interface PlanChangeTurnDto {
  id: string;
  seq: number;
  role: PlanChangeTurnRoleDto;
  body: string;
  jobId: string | null;
  /**
   * The ONE clarifying question an `assistant` turn asked, or null when it only
   * reported. Null on every other role. This is what makes the awaiting state
   * DERIVED from the thread rather than stored on the client — see
   * `lib/planning/planChangeThread.ts`.
   */
  question: string | null;
  /**
   * A `user` turn that REPLIED to the pending question (sent through the answer
   * bar), as opposed to one that changed the subject and superseded it. The two
   * render different markers — design states C and E.
   */
  isAnswer: boolean;
  /**
   * What this turn asked for, on `user` turns — null on `system` / `assistant`,
   * and null on a `user` turn written before the intent model existed (no
   * back-fill asserts a classification that never ran).
   *
   * It is the EFFECTIVE disposition — what actually ran — so a corrected turn
   * reads as what it finally became, and {@link intentCorrected} is what says it
   * changed.
   */
  intent: PlanChangeTurnIntentDto | null;
  /** Whether this turn was re-run under the other intent after Motir read it
   *  wrong. The rail renders the correction marker off the assistant turn, not
   *  off this — this is the durable record that the correction happened. */
  intentCorrected: boolean;
  /**
   * The work items an `assistant` ANSWER rests on, as identifiers in citation
   * order — `[]` on every other role, and `[]` on an answer the graphs could not
   * support (an honest no-answer cites nothing rather than citing loosely).
   *
   * Their display summaries arrive in the session's {@link
   * PlanChangeSessionDto.workItemRefs}, resolved once for the whole thread, so
   * the rail renders a citation through the SAME `WorkItemRefChip` path the
   * detail page and the comment thread use rather than a second treatment.
   */
  citations: string[];
  /**
   * The work item a `user` turn was ANCHORED on (MOTIR-7064) — the report
   * widget's triage bug on its seeded debug turn — as its identifier. The rail
   * draws it as the turn's target chip. Null on every other turn.
   *
   * Optional (absent reads as null) so a turn built by hand — every rail test —
   * needs no change; the mapper always sets it.
   */
  anchorKey?: string | null;
  /**
   * What a `debug` turn LANDED (MOTIR-7064), on the `assistant` turn carrying its
   * diagnosis — the same {@link DebugLandingDto} the settle returned, persisted
   * with the reply so the OUTCOME LINE survives a reload. Null on every other
   * turn, which is what keeps a non-debug reply rendering as an ordinary answer.
   * Optional for the reason {@link anchorKey} is.
   */
  debugLanding?: DebugLandingDto | null;
  /**
   * What a `guide` turn's job returned and what landed (MOTIR-7470), on the
   * `assistant` turn carrying its message: the actions in order (the proposed
   * list, the current step, the close offer, the ticks), each one's outcome, and
   * whether the walk was on a temporary list. The rail and the canvas read it.
   * Null on every other turn. Optional for the reason {@link anchorKey} is.
   */
  guide?: GuideTurnRecord | null;
  /**
   * The files a `guide` `user` turn carried (MOTIR-7484; `guide-turn-files.md`
   * A3.2) — attachment ids on the guided card, in the order they were added.
   * `[]` on every other turn. An id whose attachment has since been deleted
   * stays here; the rail draws it as removed. Optional for the reason
   * {@link anchorKey} is.
   */
  attachmentIds?: string[];
  /**
   * The fixed confirm core wrote on this `assistant` turn (MOTIR-7649; ADR
   * AMENDMENT 3, A3.2): `new_session` is the Plan something new confirm, whose
   * answers are the two controls Confirm and Keep planning. It is PENDING while it
   * is the thread's latest turn and the session is open — see
   * `pendingRestartConfirm` in `lib/planning/planChangeThread.ts`. Null on every
   * other turn. Optional for the reason {@link anchorKey} is.
   */
  confirm?: PlanChangeTurnConfirmDto | null;
  authorId: string | null;
  createdAt: string;
}

/** Which door opened a planning session (AMENDMENT 17 §4) — the
 *  `PlanSessionOrigin` enum, restated so the boundary does not import Prisma. */
export type PlanSessionOriginDto =
  | 'conversation'
  | 'mcp'
  | 'generation'
  | 'expand'
  | 'cadence'
  | 'legacy'
  // A conversation the Guide me through door opened on ONE manual card (ADR
  // `conversation-turn-intent.md` AMENDMENT 2, A2.2). It submits no plan and
  // takes no target lock, so it is never a planning session.
  | 'guide';

/**
 * The project's plan-change conversation as the rail renders it. `turns` is the
 * FULL ordered thread (the resume payload — re-opening the workspace re-reads
 * this and the conversation continues where it stopped). `lastJobId` /
 * `lastSubmittedAt` describe the most recent submission, so a resumed rail can
 * re-attach to that job's stream / diff review; both are null on a thread that
 * has accumulated turns but never submitted.
 */
export interface PlanChangeSessionDto {
  id: string;
  projectId: string;
  /**
   * The work items this thread is ANCHORED at, as identifiers, in canonical
   * (deduped + sorted) order — 7.12.3 · MOTIR-909. Empty on the project-wide
   * conversation; one or more entries on a contextual planning thread, which is
   * what the embedded panel labels itself with and what a resumed thread
   * re-submits as motir-ai's anchor set. The `scopeKey` these derive from is a
   * server-side storage detail and deliberately does NOT cross the boundary.
   */
  targetKeys: string[];
  turnCount: number;
  lastJobId: string | null;
  lastSubmittedAt: string | null;
  /** When the session was last used — every turn and every submit moves it
   *  (AMENDMENT 17 §3). The Plans list orders by it; the idle close reads it (AMENDMENT 23 §2). */
  lastActivityAt: string;
  /** Which door opened the session (AMENDMENT 17 §4). */
  origin: PlanSessionOriginDto;
  createdAt: string;
  updatedAt: string;
  turns: PlanChangeTurnDto[];
  /**
   * Resolved work-item reference summaries for the `[KEY](motir:<id>)` tokens the
   * thread's `assistant` bodies carry (MOTIR-2226), keyed by id — the SAME map
   * the detail page and comments thread into `renderMarkdown`, so a findings
   * report's references render as the shipped `WorkItemRefChip` and never as a
   * second inline treatment. Empty when nothing resolved.
   */
  workItemRefs: WorkItemRefMap;
  /**
   * The files the thread's turns carry (MOTIR-7486; `guide-turn-files.md` A3.2),
   * keyed by attachment id — resolved once for the whole thread, as the caller
   * may see them, so the rail draws each turn's chips and opens the shipped
   * preview. An id a turn names that is absent here was deleted (or is no longer
   * visible) and renders as removed. Optional: absent on a thread with no files.
   */
  attachments?: Record<string, AttachmentDTO>;
  /**
   * The REOPEN read's extras (MOTIR-6024) — filled by `getById` only, which is
   * how a Plans row reopens a conversation: who started it (the reopened line),
   * whether the viewer may continue it (else the rail is read-only), and its
   * still-undecided plan. Optional: every other read leaves them out.
   */
  startedBy?: { id: string; name: string } | null;
  /** Whether the viewer started it — "started by you" on the reopened line. */
  startedByViewer?: boolean;
  viewerCanPlan?: boolean;
  pendingPlanId?: string | null;
  /**
   * The session's END (AMENDMENT 23 §1; MOTIR-7643) — when, why, and (on the by-id
   * read) who ended it. All null while it is OPEN. Optional so a hand-built thread
   * (every rail test) is an open one. The overlay reads them from the server, never
   * from a stream error, so a reload shows the same end.
   */
  endedAt?: string | null;
  endReason?: 'failed' | 'idle' | 'restarted' | 'declined' | 'approved' | null;
  /** Who ended it — filled by the by-id read; null when Motir ended it. */
  endedBy?: { id: string; name: string } | null;
  /** The ENDED session this one carries over (AMENDMENT 23 §6), or null. Its
   *  copied turns keep their own `createdAt`, so they are the turns written
   *  before this session's own `createdAt`. */
  copiedFromSessionId?: string | null;
  /** The resume answered with the caller's OWN open session of ANOTHER scope that
   *  holds this card — the take-back (AMENDMENT 23 §3). Set by the resume read only. */
  takenBack?: boolean;
}

/**
 * ANOTHER holder has one of the scope's cards (AMENDMENT 23 §4) — the overlay's
 * refusal, read on open (`heldBy` on the anchored resume) or carried by a send's
 * `409 PLAN_TARGET_LOCKED`. `freesBy` is null for a plan waiting for a decision.
 */
export interface PlanTargetHeldByDto {
  target: string;
  holder: string | null;
  freesBy: string | null;
  holderSessionId: string | null;
}

/**
 * The result of submitting a conversation's accumulated intent: the motir-ai
 * `augment` job the SHIPPED contract created (the rail streams it via
 * `GET /api/ai/augment/[jobId]` and approves via the existing approve route —
 * this card adds no job kind and no new stream/approve surface), plus the
 * session as it now stands (its new `system` marker turn included).
 *
 * `planId` is the `generating` `Plan` that submit OPENED for the job (bound to
 * it by `sourceJobId` — MOTIR-1743), which the job's proposals append into. It
 * is carried here (MOTIR-1745) so the rail can name the Plan it must confirm
 * instead of re-resolving it from the job id; the same `{ jobId, planId }` pair
 * the three REST plan-edit submits already return. Nothing is opened twice: the
 * value is the one `aiPlanEditsService` produced, previously discarded.
 */
export interface PlanChangeSubmitResultDto {
  jobId: string;
  planId: string;
  session: PlanChangeSessionDto;
}

/**
 * What the ITEM-ANCHORED contextual endpoints return (7.12.3 · MOTIR-909) — the
 * submit result plus the thread's own id, which the anchored caller needs
 * because it did not open the session in a separate call. The wire shape of
 * `contextualPlanningService`'s result; named here so the client (MOTIR-910) and
 * the route agree on it without importing across the service boundary.
 */
export interface ContextualPlanResultDto extends PlanChangeSubmitResultDto {
  sessionId: string;
}

/**
 * What the anchored RESUME returns (the `GET` half of the contextual endpoint) —
 * the item's thread, or `null` when it was never planned.
 *
 * `planId` (MOTIR-1745) is the thread's still-UNDECIDED proposal, resolved from
 * its last submission's job. It matters because a resume is exactly the case the
 * submit response cannot cover: the user closed the workspace while a proposal
 * was pending and came back, so the rail has a thread but no in-memory job — and
 * without this it could not address the Plan awaiting confirmation. `null` when
 * there is no thread, when the thread never submitted, or when its plan was
 * already approved / declined (a decided plan is history, not a pending review).
 */
export interface ContextualSessionResumeDto {
  session: PlanChangeSessionDto | null;
  planId: string | null;
  /** When NOTHING resumed: the scope's most recent other conversation, for the
   *  fresh-start notice (MOTIR-6024). Absent/null otherwise. */
  earlier?: EarlierSessionDto | null;
  /** When NOTHING resumed: the caller's own failed or idle-closed session of the
   *  scope, which a new session may carry over (AMENDMENT 23 §6). */
  copyable?: CopyableSessionDto | null;
  /** When NOTHING resumed and another holder has one of the scope's cards: who,
   *  and when it frees (AMENDMENT 23 §4). The overlay refuses in place. */
  heldBy?: PlanTargetHeldByDto | null;
}

/**
 * The scope's most recent OTHER conversation — any member's — that a FRESH
 * start points to (AMENDMENT 17 §3; MOTIR-6024's notice, design §19.8). A read:
 * nothing about it is recorded.
 */
export interface EarlierSessionDto {
  id: string;
  targetKeys: string[];
  lastActivityAt: string;
  /** Who started it; null for a departed or absent starter. */
  startedBy: { id: string; name: string } | null;
  /** Whether the caller started it — picks "Your earlier…" vs "…started by {name}". */
  mine: boolean;
}

/** The project-wide RESUME read (`GET /api/ai/plan-change/session`): the
 *  caller's resumable conversation, or none — and then the earlier one. */
export interface ResumableSessionDto {
  session: PlanChangeSessionDto | null;
  earlier: EarlierSessionDto | null;
  /** When nothing resumed and the caller's own latest conversation of the scope
   *  ended `failed` or `idle`: that session, which a new one may carry over
   *  (AMENDMENT 23 §6; MOTIR-7641). Absent/null otherwise. */
  copyable?: CopyableSessionDto | null;
}

/** A session whose conversation a new session may carry over (AMENDMENT 23 §6).
 *  A session that ended while a plan still waits is copyable whatever its end
 *  reason, and the carry takes that plan with it (Story MOTIR-7928 · MOTIR-7930). */
export interface CopyableSessionDto {
  id: string;
  endReason: 'failed' | 'idle' | 'restarted';
  endedAt: string;
  turnCount: number;
  /** The undecided plan the carry would MOVE into the new session, or `null` when
   *  only the conversation is carried. */
  waitingPlanId: string | null;
}

/**
 * What a settled `debug` turn LANDED (Story MOTIR-7042 · MOTIR-7049; ADR
 * `conversation-turn-intent.md` AMENDMENT 1 · A1.4) — the rail's account of the
 * one card the turn touched. Exactly one of A1.4's rows:
 *
 *  * `enrich_existing` — an existing card covers the defect; the diagnosis was
 *    added to it as a comment. `workItemKey` / `title` are that card.
 *  * `diagnose` — no card covers it; the diagnosis was written onto the anchored
 *    triage bug, or onto ONE bug filed into Triage for it (`createdInTriage`).
 *  * `ungrounded` — the report could not be grounded in the code, so NOTHING was
 *    written; `workItemKey` and `title` are null.
 */
export interface DebugLandingDto {
  outcome: 'enrich_existing' | 'diagnose' | 'ungrounded';
  /** The one card the turn touched, or null when it wrote nothing. */
  workItemKey: string | null;
  /** That card's current title, or null when it wrote nothing (or the card is
   *  gone by the time a replayed settle reads it). */
  title: string | null;
  /**
   * Whether this turn FILED a new bug into Triage (the orb path). The triage
   * inbox is a client island that refetches only on `ReportProvider`'s
   * `submissionsChangedAt` tick, which the server cannot bump — so the client
   * bumps it when this is true.
   */
  createdInTriage: boolean;
}

/**
 * What the Plan something new door answered on Confirm (MOTIR-7649; ADR
 * `conversation-turn-intent.md` AMENDMENT 3, A3.3): the session it ended (or
 * found already ended — nothing ends twice) and the NEW, empty conversation
 * session for the same scope the overlay swaps to in place. `session` is the
 * caller's own open session of that scope when they already had one (the
 * take-back), so a second session is never created.
 */
export interface PlanSessionRestartResultDto {
  outcome: 'restarted';
  endedSessionId: string;
  session: PlanChangeSessionDto;
}
