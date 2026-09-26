'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EarlierSessionDto, PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import { announceGateStateDecided } from '@/lib/approvals/decidedGates';
import type { PlanItemOutcome } from '@/components/planning/PlanItemNode';
import { useGeneratingPlanPoll } from '@/lib/hooks/useGeneratingPlanPoll';
import {
  findResumableSession,
  getPlanChangeSession,
  recordPlannerTurn,
  rerunAskTurn,
  resubmitContextualPlan,
  resumeContextualSession,
  settleAskJob,
  submitAskTurn,
  submitContextualPlan,
  attachMidRunTurn,
  peekMailbox,
  stopPlanChangeRun,
  submitPlanChange,
  type AskRedirectResponse,
  type AskSubmitResponse,
} from '@/lib/planning/planChangeClient';
import { pendingQuestion } from '@/lib/planning/planChangeThread';
import { FRAME_DISPOSITIONS, isKnownFrameKind } from '@/lib/planning/planChangeFrames';
import {
  streamAskJob,
  streamAugmentJob,
  streamContextualPlanJob,
  PlanEditsClientError,
} from '@/lib/planning/planEditsClient';
import {
  approvePlanRequest,
  declinePlanRequest,
  fetchPlanReview,
  PlanRequestError,
} from '@/lib/planning/planReviewClient';
import {
  planDecisionErrorCode,
  readPendingProposal,
  summarizePlanApproval,
  type PlanApproveSummary,
} from '@/lib/planning/planReview';
import {
  extraPlanningTargetKeys,
  primaryPlanningTarget,
  type PlanningTarget,
} from '@/lib/planning/planningTargets';

// The client state machine behind the plan-change CONVERSATION rail (Subtask
// MOTIR-1730; design `plan-change-conversation.mock.html` panels 3 / 4 / 6). It
// drives the whole loop over ALREADY-SHIPPED surfaces:
//
//   mount    → POST /api/ai/plan-change/session      (open OR RESUME the thread)
//   a turn   → POST …/session/turns  (accumulate)  → POST …/session/submit
//   running  → GET  /api/ai/augment/[jobId]/stream  (the shipped SSE)
//   settled  → GET  /api/plans/[planId]             (the run's PROPOSALS)
//   approve  → POST /api/plans/[planId]/approve     (materialize — the write)
//   discard  → POST /api/plans/[planId]/decline
//
// ⚠️ It reviews the PLAN, not the job's `planDelta` (MOTIR-1746). Every plan-edit
// handler in motir-ai returns `planDelta: { operations: [] }` and writes its
// output as `PlanItem` proposals instead (`addProposals` → `markPlanned`), so the
// delta read always fell through to `EMPTY`: the user was told nothing was
// proposed while the proposals sat in the Plan store unread, and the Approve
// could never fire. The engine's invariant is that ALL planning appends to a Plan
// — whoever triggered it — so this reads and confirms that Plan, through the same
// route `/plans/[id]` uses. Two entrances, ONE gate.
//
// Three things this deliberately does NOT do:
//  • it does not re-implement the review read or the approve — those are
//    `planReviewClient`'s shipped helpers, the same ones the plan-detail island
//    calls (the compose-don't-reinvent rule);
//  • it does not close on approve — `approved` is recorded and the phase returns
//    to `idle` with the THREAD INTACT, which is what makes this a conversation
//    rather than a transaction (design panel 6, "after approve");
//  • it does not clear a pending proposal on a FAILED run: the design's error
//    state is "recoverable in place — the thread and any prior proposal survive",
//    so a retry continues the conversation instead of restarting it.
//
// ⚠️ Streaming, against shipped reality: the `augment` job's SSE carries
// STRUCTURED PROGRESS frames (`search` / `drill` / `level_complete` / `pass` /
// `planned` / `validated`), NOT assistant tokens — token streaming belongs to the
// onboarding conductor, a different job kind. So `progress` is the narration
// derived from those real frames, rendered into the rail's `aria-live` region
// with the shipped drafting spinner. Faking a token stream would mean an engine
// change, which this card explicitly does not make.

/** `deciding` covers BOTH decisions: approve and discard are now server writes
 *  against the Plan (materialize / decline), so the gate must read busy for
 *  either — a Discard that looked idle mid-POST could be double-fired. */
export type PlanChangePhase = 'loading' | 'idle' | 'streaming' | 'review' | 'deciding';

/** One turn typed mid-run, and whether the run has taken it yet. */
export interface QueuedTurn {
  /** The mailbox entry's id — what the peek is matched against. */
  id: string;
  text: string;
  /** The run consumed it at a phase boundary. */
  read: boolean;
}

/** A progress frame the run narrates while the job works. */
export type PlanChangeProgress =
  | { kind: 'submitted' }
  /** An ask turn is being READ — the first phase of the one door, before Motir
   *  knows whether it is answering or planning. */
  | { kind: 'reading' }
  /** The ask job settled saying the turn was a PLAN CHANGE, and the run has
   *  attached to the plan-edit job (ADR Consequence 3). The rail names the
   *  hand-off here rather than letting the user watch a spinner stop and a
   *  different one start. */
  | { kind: 'redirected' }
  | { kind: 'searching' }
  | { kind: 'drilling' }
  /** A graph LOOKUP the planner made (MOTIR-4069) — `{ tool, family }` over the
   *  five retrieval families, or the budget-exhausted variant. Emitted on every
   *  planner read since retrieval shipped, and rendered by nothing until now. */
  | { kind: 'retrieval'; family: string | null; blocked: boolean }
  /** A level being laid, and one card being written. */
  | { kind: 'laying'; target: string | null }
  | { kind: 'authoring'; title: string | null }
  /** The planner's OWN prose line for the act it just took. The producer emits
   *  nothing when the text is blank, so this is never an empty row. */
  | { kind: 'note'; text: string }
  | { kind: 'proposed'; count: number }
  | { kind: 'validating' }
  /**
   * ⚠️ A frame NOBODY HAS DECIDED ABOUT — the LOUD default (MOTIR-4069).
   *
   * It carries the raw kind so a developer can see WHICH frame arrived
   * unaccounted for. This is the arm that covers the future: the frame list is a
   * snapshot of a sweep, so a kind added upstream tomorrow lands here rather than
   * disappearing through a `default: return null` the way `retrieval` did for
   * its whole life.
   */
  | { kind: 'unknown'; frame: string };

/** What an approve landed, as the rail says it back — the shared summary every
 *  confirming surface reports (`planReviewClient`), re-exported here because the
 *  rail's components type their `onApproved` against the hook. */
export type { PlanApproveSummary };

export interface PlanChangeConversationState {
  phase: PlanChangePhase;
  /** The persisted thread — the resume payload, re-read on mount. */
  session: PlanChangeSessionDto | null;
  /** The live narration of the running job (the `aria-live` line). */
  progress: PlanChangeProgress | null;
  /**
   * THE ACT RAIL — every act this run has narrated, in order (MOTIR-4069).
   *
   * ⚠️ AN ACCUMULATING RECORD, where {@link progress} is a REPLACING line, and
   * the difference is the point. A run used to say one sentence at a time and
   * overwrite it, so its whole history was one sentence long. The user is now
   * making a decision against this — whether to stop it — and a decision needs
   * the record rather than the latest word
   * (`design/ai-chat/plan-change-run-live.mock.html` sheet 3).
   *
   * `progress` survives as the LIVE line: the newest act, which the pinned
   * running bar repeats so it is on screen however far the transcript is
   * scrolled.
   *
   * Never re-ordered, never collapsed, never de-duplicated: two `retrieval`
   * lines in a row mean the planner made two lookups, and folding them into
   * "2 lookups" turns a record into a summary.
   */
  acts: PlanChangeProgress[];
  /**
   * The run's PROPOSALS, read from its Plan — what the canvas draws and what the
   * gate confirms.
   *
   * ⚠️ IT SURVIVES THE DECISION (MOTIR-3162; bug MOTIR-3154). Approve and
   * discard each used to set it `null`, and `PlanningWorkspaceHost` derives its
   * ENTIRE diff index from this one field — so the overlay vanished the instant
   * a decision was taken. After an approve the items at least remained as
   * ordinary committed cards, so the canvas merely stopped saying which of them
   * you had just accepted; after a DISCARD nothing remained at all, and the
   * conversation that produced the tree was still on screen beside the space
   * where the tree had been.
   *
   * It is now cleared only when a NEW run starts, which is the moment it stops
   * describing anything. What the decision itself records is {@link decided},
   * beside this — not the erasure of it.
   */
  review: PlanReviewDto | null;
  /**
   * The LIVE review of the plan being WRITTEN (Subtask MOTIR-6295) — a whole
   * snapshot of a `generating` plan, replaced on every tick of the shared
   * generating-plan poll (`useGeneratingPlanPoll`), never merged.
   *
   * Fed for the plan the session is writing, whoever writes it: the hosted run's
   * plan from the moment its turn is submitted, and a NAMED session's
   * `pendingPlanId` at mount when that plan is still `generating` (an MCP agent
   * writing it). {@link review} cannot carry this: `readPendingProposal` is null
   * for a `generating` plan by design.
   *
   * ⚠️ A HAND-OVER, NOT A SECOND REVIEW. When the poll OBSERVES the plan leave
   * `generating` — the transition, once — the existing proposed-review path
   * (`readPendingProposal` → {@link review}) runs exactly once and this goes back
   * to `null` — in the SAME update that sets `review`, so the planning surface's
   * pane, which draws `liveReview ?? review`, is never without a plan in between
   * and is not remounted (MOTIR-6300).
   */
  liveReview: PlanReviewDto | null;
  /** Bumped on every applied live snapshot. */
  liveVersion: number;
  /** The live poll has failed several reads in a row (the last snapshot stands). */
  liveFailing: boolean;
  /**
   * The plan this session WATCHED being written, when it ended DISCARDED rather
   * than proposed (MOTIR-6300; design Part XXIII §23.12): `generating → declined`
   * with `decisionReason: 'discarded'` — a plan closed holding zero proposals,
   * decided by nobody. `readPendingProposal` is null for it, so {@link review}
   * never carries it; this is the last snapshot, kept so the pane that drew the
   * plan live can say how it ended instead of vanishing. Only an OBSERVED
   * transition sets it, and a new run clears it.
   */
  discardedReview: PlanReviewDto | null;
  /**
   * WHICH WAY the current `review` was decided, or `null` while it is still
   * pending (MOTIR-3162). It is what tells the canvas to draw the accepted or
   * declined treatment `design/ai-planning/design-notes.md` Part VI specifies —
   * the SAME treatment the plan-detail canvas renders, one language across both
   * surfaces rather than a second one invented here.
   */
  decided: PlanItemOutcome | null;
  jobId: string | null;
  /**
   * The `Plan` the current run's proposals append into (MOTIR-1743/1745) — what a
   * confirm must address. Set from the submit response, and RE-ESTABLISHED on
   * mount from the resume when the thread left a proposal undecided, so a user
   * who closed the workspace mid-review comes back able to act on it. `null`
   * whenever there is nothing pending, and read defensively: an older response or
   * a stubbed one carries only `jobId`.
   */
  planId: string | null;
  /** The last approve's result, so the rail can say what landed. */
  approved: PlanApproveSummary | null;
  /** A recoverable failure: `FAILED` / `EMPTY` / `immutable` / a typed code. */
  errorCode: string | null;
  /** The metered-AI refusal — a distinct state, not an error (design panel 6). */
  outOfCredits: boolean;
  /**
   * The user has asked for a stop and the walk has not reached its boundary yet
   * (Story MOTIR-4054 · MOTIR-4068).
   *
   * ⚠️ IT IS NOT A TERMINAL STATE, and keeping it separate from {@link stopped}
   * is the whole point. The click is not the stop: `runWalk` reads the flag at
   * its NEXT phase boundary, which can be a whole authoring session away, so
   * there is a real interval in which the run is still narrating and the user has
   * already asked it to end. A surface that collapses the two claims the run is
   * over while it is visibly still working, which is worse than a slow stop.
   */
  stopping: boolean;
  /**
   * What the user typed WHILE the run was working, and whether the run has read
   * it yet (Story MOTIR-4054 · MOTIR-4274).
   *
   * ⚠️ NOT PART OF THE THREAD, and that is the storage talking rather than a
   * choice. A mid-run turn goes into the boundary MAILBOX, which is a different
   * table from `plan_change_turn` — so it is not in `session.turns` and cannot be
   * rendered from there. It joins the transcript's history only if and when a
   * later run's accumulated intent carries it.
   *
   * `read` flips when the run has taken it at a phase boundary. Until then the
   * surface must say QUEUED: a message that looks delivered and changes nothing
   * for another thirty seconds reads as a bug, and the boundary can be a whole
   * authoring session away.
   */
  queued: QueuedTurn[];
  /**
   * The run ENDED because the user ended it.
   *
   * ⚠️ THIS IS NOT AN ERROR, and the code below goes out of its way not to record
   * one. A stopped run proposes nothing NEW at the moment it ends, which is
   * exactly the shape the settle path reads as `EMPTY` — so without this flag the
   * honest outcome of a deliberate act would surface as a failure the user has to
   * dismiss. `errorCode` stays null and `review` survives: what was proposed
   * before the stop is worth exactly what it was worth a second earlier.
   */
  stopped: boolean;
  /**
   * FRESH START pointer (MOTIR-6024; design §19.8): nothing resumed on open, and
   * the scope has an EARLIER conversation — the notice links to its Plans row.
   * Null once this conversation has a turn, and on a resumed or reopened one.
   */
  earlier: EarlierSessionDto | null;
  /**
   * REOPENED by id (a Plans row, `planSession=<id>`): who started it and when it
   * was last active, for the one line above the opener. Null otherwise.
   */
  reopened: {
    startedBy: { id: string; name: string } | null;
    mine: boolean;
    lastActivityAt: string;
  } | null;
  /** The reopened conversation is READ-ONLY for this viewer (no `ai:plan`): the
   *  composer is replaced by the reason. */
  readOnly: boolean;
}

const INITIAL: PlanChangeConversationState = {
  phase: 'loading',
  session: null,
  progress: null,
  acts: [],
  review: null,
  liveReview: null,
  liveVersion: 0,
  liveFailing: false,
  discardedReview: null,
  decided: null,
  jobId: null,
  planId: null,
  approved: null,
  errorCode: null,
  outOfCredits: false,
  stopping: false,
  stopped: false,
  queued: [],
  earlier: null,
  reopened: null,
  readOnly: false,
};

const OUT_OF_CREDITS_CODES = new Set(['MOTIR_AI_OUT_OF_CREDITS', 'out_of_credits']);

/**
 * How often the composer asks whether its queued turns have been read
 * (MOTIR-4274). Three seconds: a phase boundary is minutes apart, so this is
 * about how quickly the surface stops saying QUEUED, not about catching the
 * boundary. It only ticks while a run is streaming AND something is unread.
 */
const MAILBOX_POLL_MS = 3000;

/**
 * How often an open surface re-reads a plan whose gate is AWAITING, so a revision
 * lease taken or released SOMEWHERE ELSE — a second tab, another member, an agent
 * revising over MCP — reaches its verbs (bug MOTIR-6151). It bounds how long the
 * surface can offer a press the door will refuse, and it is the refresh bound the
 * acceptance criterion names. A focus or a return to the tab re-reads at once.
 */
export const PLAN_GATE_POLL_MS = 3000;

/**
 * The FIRST act of a run — the rail's opening line and the live line, one
 * object (MOTIR-4069). `design/ai-chat/plan-change-run-live.mock.html` sheet 3
 * draws `submitted` and `reading` as act lines like any other, so a run's record
 * starts with the act that started it rather than with the first frame the
 * server happened to send.
 */
function firstAct(
  kind: 'submitted' | 'reading',
): Pick<PlanChangeConversationState, 'progress' | 'acts'> {
  const act: PlanChangeProgress = { kind };
  return { progress: act, acts: [act] };
}

/** Map one raw SSE frame to the narration the rail shows, or null to ignore it. */
export function narrateFrame(event: string, data: unknown): PlanChangeProgress | null {
  const d = (data ?? {}) as Record<string, unknown>;

  // ⚠️ THE LOUD DEFAULT, AND IT IS THE FIRST THING RATHER THAN THE LAST.
  //
  // The bug this card repairs was not the missing `retrieval` arm — it was the
  // `default: return null` underneath it, which made EVERY frame kind added
  // upstream invisible with no signature: nothing threw, nothing logged, the
  // rail just said less than the run did. Adding one arm would have fixed
  // today's symptom and left the mechanism, and the next frame would have
  // reproduced it exactly.
  //
  // So an unaccounted kind is now the noisy case. It surfaces on the rail AND in
  // the console, where a developer sees it.
  if (!isKnownFrameKind(event)) {
    console.warn(
      `[plan-change] unnarrated frame kind "${event}" — add it to PLAN_CHANGE_FRAME_KINDS ` +
        `and give it a disposition in lib/planning/planChangeFrames.ts`,
    );
    return { kind: 'unknown', frame: event };
  }

  const disposition = FRAME_DISPOSITIONS[event];
  // QUIET is a DECISION, not a fall-through. The reason is on the map entry, and
  // this null is the one place a null is legitimate.
  if ('quiet' in disposition) return null;

  switch (disposition.show) {
    case 'retrieval': {
      const family = d['family'];
      return {
        kind: 'retrieval',
        family: typeof family === 'string' ? family : null,
        blocked: d['blocked'] === true,
      };
    }
    case 'laying': {
      const target = d['target'];
      return { kind: 'laying', target: typeof target === 'string' ? target : null };
    }
    case 'authoring': {
      const title = d['title'];
      return { kind: 'authoring', title: typeof title === 'string' ? title : null };
    }
    case 'note': {
      const text = d['text'];
      // Defensive on OUR side too: the producer already refuses to emit a blank
      // note ("a blank line is not a shorter line, it is a line the rail would
      // render as a hole"), and a hole is exactly what a bad payload would draw.
      const trimmed = typeof text === 'string' ? text.trim() : '';
      return trimmed.length === 0 ? null : { kind: 'note', text: trimmed };
    }
    case 'proposed': {
      const raw = d['proposed'];
      return { kind: 'proposed', count: typeof raw === 'number' ? raw : 0 };
    }
    case 'searching':
      return { kind: 'searching' };
    case 'drilling':
      return { kind: 'drilling' };
    case 'validating':
      return { kind: 'validating' };
    default:
      // Unreachable: `show` is a `PlanChangeProgress['kind']` and every one the
      // map uses is handled above. Kept so a new SHOW value is a visible gap
      // rather than a silent null — the same mistake, one level in.
      return null;
  }
}

export interface UsePlanChangeConversationOptions {
  /**
   * An approve COMMITTED work items — the caller routes the page-state fan-out
   * (`motir-core/CLAUDE.md`): the canvas is a client island that `router.refresh()`
   * cannot reach, so it needs an explicit refetch trigger, and the server-rendered
   * surfaces behind the workspace take the refresh. Both, where both apply.
   */
  onApproved?: (result: PlanApproveSummary) => void;
  /**
   * The work item this conversation is ANCHORED at, by database id (MOTIR-910's
   * per-item entrance). When set, every hop rides the item-scoped MOTIR-909
   * endpoints instead of the project-wide thread — a different CONVERSATION, not
   * a different mechanism: same substrate, same job kind, same approve route.
   * Absent (the launcher's project/roadmap contexts) → the shipped 7.30 thread.
   */
  anchorId?: string | null;
  /**
   * REOPEN this exact conversation (MOTIR-6024) — the overlay's `planSession`
   * address, which a Plans row writes. The resume window does not apply: a
   * named session opens whatever its age or starter.
   */
  sessionId?: string | null;
  /**
   * The named `sessionId` is a RESUME, not a reopen (MOTIR-6210; design MOTIR-6206
   * sheet 7): the refusal seed's `seededSessionId` names the viewer's OWN recent
   * seeded conversation, returned to within the window — MOTIR-6019's resumed
   * state. `reopened` stays `null`, so the rail claims no *Reopened from the
   * Plans page* line it would be lying about.
   */
  sessionIsResume?: boolean;
  /**
   * The REFUSED gate a seeded re-plan starts from (story MOTIR-6068 · MOTIR-6210).
   * Two effects, both once-only:
   *  · the mount opens NOTHING — the caller's ordinary resumable conversation on
   *    the card is not the one a refusal starts, and the seeded turn is unsent,
   *    so the rail is empty until Send (design sheet 2);
   *  · the FIRST anchored send — the one with no session yet — carries it, so
   *    the session the server starts remembers the gate. Every later send has a
   *    session and carries nothing.
   */
  seedGateId?: string | null;
}

/**
 * What one run is ANCHORED at: the primary anchor (the endpoint's path item) plus
 * the additional targets the `@`-mention picker added (MOTIR-1491). `null` is the
 * project-wide thread. Every hop of a run — submit, stream, resubmit — uses the
 * SAME anchor, because they all address one conversation.
 */
interface RunAnchor {
  anchorId: string;
  targetKeys: string[];
}

/**
 * Which conversation a turn belongs to. The picker's SET wins when the caller
 * has one (an empty set is a real answer — the project thread); a caller that
 * passes nothing keeps the entrance's single anchor.
 */
function resolveAnchor(
  targets: readonly PlanningTarget[] | undefined,
  entranceAnchorId: string | null,
): RunAnchor | null {
  if (targets === undefined) {
    return entranceAnchorId ? { anchorId: entranceAnchorId, targetKeys: [] } : null;
  }
  const primary = primaryPlanningTarget(targets);
  return primary ? { anchorId: primary.id, targetKeys: extraPlanningTargetKeys(targets) } : null;
}

/**
 * Tell the page an ASKED plan's gate was decided here (MOTIR-6037), so its To-approve row
 * settles in place under the overlay rather than reading *Decided elsewhere* on the next
 * refresh (`lib/approvals/decidedGates.ts`). Only a plan the reader was shown AS a
 * question — an `awaiting` gate on the review in hand — announces anything.
 *
 * The row reads only the STATE, and the state is all this surface announces: the gate's
 * audit columns are the server's and never reached it, so no gate row is built here
 * (`announceGateStateDecided`) — `approval_gate.outcome_ref` keeps its one writer.
 */
function announcePlanGateDecided(
  review: PlanReviewDto | null,
  state: 'approved' | 'declined',
): void {
  const gate = review?.gate;
  if (!gate || gate.state !== 'awaiting') return;
  announceGateStateDecided(gate.id, state);
}

export function usePlanChangeConversation({
  onApproved,
  anchorId = null,
  sessionId = null,
  sessionIsResume = false,
  seedGateId = null,
}: UsePlanChangeConversationOptions = {}) {
  const [state, setState] = useState<PlanChangeConversationState>(INITIAL);
  // The seed the FIRST send carries (MOTIR-6210). Seeded once from the option —
  // the host is keyed on its anchor, so it is fixed per mounted workspace — and
  // DROPPED when the server answers `SEED_NOT_APPLICABLE`: that refusal is
  // deterministic, so re-sending the same seed could only fail the same way, and
  // the person's words should still be sendable as an ordinary re-plan.
  const seedRef = useRef(seedGateId);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  // The entrance's anchor, read by callbacks that must not be re-created when it
  // changes (it is fixed per mounted workspace — the route's `?item=`).
  const anchorRef = useRef(anchorId);
  // What the LAST run was anchored at, so a retry resubmits to the same thread —
  // which, once the picker is in play, may be a different set than the entrance's.
  const lastAnchorRef = useRef<RunAnchor | null>(null);
  /** The `user` turn the last ASK run was for. A retry on the project thread
   *  re-runs THAT turn (no second user turn — ADR §3), and the correction
   *  affordance flips it. Null whenever the last run was a plan-change one. */
  const lastAskTurnRef = useRef<string | null>(null);
  /**
   * A stop is IN FLIGHT — the re-entry guard for {@link stop} (MOTIR-4068).
   *
   * ⚠️ A REF, NOT `state.stopping`, and the difference is the whole guard.
   * `stateRef` is written in an EFFECT (see its own comment below), so two clicks
   * in the SAME tick — which is exactly what a double-click is — both read the
   * pre-click value and both raise. This is set synchronously, inside the call,
   * before anything awaits, which is the shape `abortRef` already uses to keep a
   * second Enter from firing a second turn.
   */
  const stoppingRef = useRef(false);
  // A read-only mirror of the latest state, so a callback can read `jobId`/`planId`
  // without listing them as dependencies (which would re-create the callback — and
  // the rail's handlers — on every stream tick).
  const stateRef = useRef(state);
  // The latest `onApproved` without re-creating `approve` on every parent render.
  const approvedCbRef = useRef(onApproved);
  // Both mirrors are written in an EFFECT (never during render): the callbacks that
  // read them only run from a user event or after an await, by which point effects
  // have flushed.
  useEffect(() => {
    stateRef.current = state;
    approvedCbRef.current = onApproved;
    anchorRef.current = anchorId;
  });

  useEffect(() => {
    mountedRef.current = true;
    const live = new AbortController();
    liveAbortRef.current = live;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      live.abort();
    };
  }, []);

  // ── THE LIVE REVIEW (Subtask MOTIR-6295) ─────────────────────────────────
  // The plan being written right now, if any: the hosted run's (set when its turn
  // is submitted, cleared when the run ends) or a named session's pending one
  // (set at mount when it is still `generating`).
  const [livePlanId, setLivePlanId] = useState<string | null>(null);
  // The plan the poll has SEEN generating — what makes a later non-`generating`
  // snapshot a TRANSITION rather than merely a state.
  const sawGeneratingRef = useRef<string | null>(null);
  // The plan a NAMED session's open is still waiting on (bug MOTIR-6346): its
  // pending read was null, so the pane has nothing to draw until the poll's FIRST
  // read settles — and until then the phase stays `loading`, the skeleton.
  const openingLiveRef = useRef<string | null>(null);
  // The ONE proposed-review read per run: the hand-over and the settle of a hosted
  // run both reach for it, and whichever comes second awaits the first's read.
  const proposalReadRef = useRef<{
    planId: string;
    read: Promise<PlanReviewDto | null>;
  } | null>(null);
  const liveAbortRef = useRef<AbortController | null>(null);

  const readProposalOnce = useCallback((planId: string, signal?: AbortSignal) => {
    const memo = proposalReadRef.current;
    if (memo && memo.planId === planId) return memo.read;
    const read = readPendingProposal(planId, signal);
    proposalReadRef.current = { planId, read };
    return read;
  }, []);

  /** A new run: its plan has not been seen generating, nor its proposal read. */
  const resetLiveRun = useCallback(() => {
    sawGeneratingRef.current = null;
    proposalReadRef.current = null;
    openingLiveRef.current = null;
  }, []);

  /** Settle a named session's open on the poll's first answer about `planId`:
   *  `true` once, when that answer is the one the open was waiting on. The caller
   *  ends `loading` in the SAME update as whatever the answer brought, so no pane
   *  is drawn in between. */
  const settlesOpen = (planId: string) => {
    if (openingLiveRef.current !== planId) return false;
    openingLiveRef.current = null;
    return true;
  };
  const endOpening = (s: PlanChangeConversationState, settles: boolean) =>
    settles && s.phase === 'loading' ? { phase: 'idle' as const } : {};

  /** The run that watched `planId` has ended: its settle has filed what it
   *  proposed, so stop watching — a plan a failed run left `generating` must not
   *  be polled forever. */
  const endLive = useCallback((planId: string | null) => {
    if (planId) setLivePlanId((cur) => (cur === planId ? null : cur));
  }, []);

  /** The plan left `generating`: the existing proposed-review path takes over,
   *  once, and the live review is done. */
  const handOver = async (planId: string) => {
    let pending: PlanReviewDto | null = null;
    try {
      pending = await readProposalOnce(planId, liveAbortRef.current?.signal);
    } catch {
      /* nothing proposed we can show — the live review still ends */
    }
    if (!mountedRef.current) return;
    setState((s) => ({
      ...s,
      liveReview: null,
      // Exactly what the mount path does with a pending proposal; a run still
      // streaming keeps its phase, and its own settle re-enters the gate.
      ...(pending ? { review: pending, phase: s.phase === 'idle' ? 'review' : s.phase } : {}),
    }));
  };

  const { failing: liveFailing } = useGeneratingPlanPoll(livePlanId, {
    onSnapshot: (snap) => {
      if (!livePlanId || !mountedRef.current) return;
      // A named session's open ends HERE, in the same update as this snapshot:
      // the skeleton hands straight to the live pane (or to the no-plan state).
      const settles = settlesOpen(livePlanId);
      if (snap.status === 'generating') {
        sawGeneratingRef.current = livePlanId;
        setState((s) => ({
          ...s,
          ...endOpening(s, settles),
          liveReview: snap,
          liveVersion: s.liveVersion + 1,
        }));
        return;
      }
      // Out of `generating` — the poll has stopped itself. Only an OBSERVED
      // change hands over: a plan first read already settled is the mount's or
      // the run's own read to file, not this one's.
      const transitioned = sawGeneratingRef.current === livePlanId;
      sawGeneratingRef.current = null;
      if (!transitioned) {
        if (settles) setState((s) => ({ ...s, ...endOpening(s, true) }));
        return;
      }
      // DISCARDED while it was being written (§23.12): nothing is proposed, so there
      // is nothing to hand over — the ended snapshot replaces the live one in ONE
      // update, so the pane that drew it stays mounted and says how it ended.
      if (snap.status === 'declined' && snap.decisionReason === 'discarded') {
        setState((s) => ({ ...s, liveReview: null, discardedReview: snap }));
        return;
      }
      void handOver(livePlanId);
    },
  });

  // A named session's open whose poll cannot read the plan (MOTIR-6346): once the
  // poll says it is FAILING the skeleton gives way to the no-plan state rather than
  // standing for ever. The poll keeps retrying, and a later snapshot still brings
  // the live pane in over it.
  useEffect(() => {
    if (!liveFailing || !livePlanId || !settlesOpen(livePlanId)) return;
    setState((s) => ({ ...s, ...endOpening(s, true) }));
  }, [liveFailing, livePlanId]);

  // Open OR RESUME the thread on mount — the project's, or the ANCHORED item's.
  // Best-effort: a failure leaves an empty thread with a recoverable error, never
  // a broken rail. An anchored item that was never planned simply has no thread
  // yet (`null`), which is an empty rail, not an error.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        // Three opens (AMENDMENT 17 §1, §3; MOTIR-6024), none of which writes:
        //  · a NAMED session (`planSession=`, a Plans row) reopens that one,
        //    whatever its age — with who started it and whether it is read-only;
        //  · otherwise the caller's RESUMABLE session for the scope (anchored or
        //    project-wide), with its still-undecided plan;
        //  · otherwise NOTHING: an empty rail, and the scope's earlier
        //    conversation for the notice. The first turn starts the session.
        const opened = sessionId
          ? await getPlanChangeSession(sessionId, controller.signal).then((named) => ({
              session: named,
              planId: named.pendingPlanId ?? null,
              earlier: null,
              // A seed's return is a RESUME (MOTIR-6210): no reopened line.
              reopened: sessionIsResume
                ? null
                : {
                    startedBy: named.startedBy ?? null,
                    mine: named.startedByViewer === true,
                    lastActivityAt: named.lastActivityAt,
                  },
              readOnly: named.viewerCanPlan === false,
            }))
          : seedGateId
            ? // A SEEDED re-plan opens EMPTY (MOTIR-6210): the first turn sits
              // unsent in the composer, and no resumable conversation is read —
              // the seeded send starts its own session, or returns to one of the
              // same seed, server-side.
              {
                session: null,
                planId: null,
                earlier: null,
                reopened: null,
                readOnly: false,
              }
            : anchorId
              ? // Mount-time resume is the ENTRANCE's single anchor: the picker's set
                // is seeded from that same item, and any target the user adds later
                // starts a differently-scoped thread anyway.
                await resumeContextualSession(anchorId, [], controller.signal).then((r) => ({
                  session: r.session,
                  planId: r.planId ?? null,
                  earlier: r.earlier ?? null,
                  reopened: null,
                  readOnly: false,
                }))
              : await findResumableSession(controller.signal).then((r) => ({
                  session: r.session,
                  planId: null,
                  earlier: r.earlier,
                  reopened: null,
                  readOnly: false,
                }));
        const { session, planId } = opened;
        if (!mountedRef.current) return;
        setState((s) => ({
          ...s,
          // ⚠️ STILL `loading` while a pending plan is left to read (bug MOTIR-6289).
          // The surface draws the roadmap for every null `review`, so an `idle` here
          // flashed the roadmap and then jumped to the plan the reader came to decide.
          // The read below settles it either way — `review`, or `idle` with nothing.
          phase: planId ? 'loading' : 'idle',
          session,
          planId: planId ?? null,
          earlier: opened.earlier,
          reopened: opened.reopened,
          readOnly: opened.readOnly,
        }));

        // A thread that left a proposal UNDECIDED comes back reviewable: read its
        // Plan and re-enter the gate, so closing the workspace mid-review is not
        // the same as discarding. Its own try: a plan that can't be read is a
        // usable thread with nothing pending, NOT an unavailable session.
        if (!planId) return;
        try {
          const pending = await readPendingProposal(planId, controller.signal);
          if (!mountedRef.current) return;
          // Nothing reviewable YET on a named session's plan may mean an agent is
          // still writing it (MOTIR-6295): watch it live. The poll's first read
          // says whether it is `generating`; one that is not stops at once.
          //
          // ⚠️ AND UNTIL THAT FIRST READ SETTLES, THE PHASE STAYS `loading` (bug
          // MOTIR-6346). A null here is exactly the MOTIR-6289 interval one read
          // later: an `idle` now would draw the roadmap, and the live pane would
          // swap in over it when the poll answered. The poll's first applied
          // snapshot ends it (`settlesOpen`), and so does the poll reporting
          // `failing`, so a plan that cannot be read never holds the skeleton.
          if (!pending) {
            if (sessionId) {
              openingLiveRef.current = planId;
              setLivePlanId(planId);
            } else {
              setState((s) => ({ ...s, phase: 'idle' }));
            }
            return;
          }
          setState((s) => ({ ...s, phase: 'review', review: pending }));
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          if (!mountedRef.current) return;
          // Nothing pending we can show — the conversation still works.
          setState((s) => ({ ...s, phase: 'idle' }));
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!mountedRef.current) return;
        setState((s) => ({ ...s, phase: 'idle', errorCode: 'SESSION_UNAVAILABLE' }));
      }
    })();
    return () => controller.abort();
  }, [anchorId, sessionId, sessionIsResume, seedGateId]);

  /**
   * STREAM a plan-edit job to its end, then file what it proposed — the tail of
   * every plan-change run.
   *
   * It is a named helper rather than the inline block it used to be because a
   * REDIRECTED ask hands off to exactly this (`docs/decisions/conversation-turn-intent.md`
   * Consequence 3): the ask job settles saying the turn was a plan change, and
   * from that moment the run must be indistinguishable from one the plan-change
   * door submitted. Re-implementing the tail beside the ask path would be two
   * settle behaviours for one outcome, and they would drift.
   */
  const finishPlanRun = useCallback(
    async (
      jobId: string,
      planId: string | undefined,
      anchor: RunAnchor | null,
      controller: AbortController,
    ) => {
      let failed = false;
      // Anchored runs subscribe through the item's own relay (which re-gates the
      // anchor on subscribe); the project thread keeps the shipped augment SSE.
      const stream = anchor
        ? (
            onError: (code: string | null) => void,
            onDone: () => void,
            onFrame: (event: string, data: unknown) => void,
          ) =>
            streamContextualPlanJob(
              anchor.anchorId,
              jobId,
              controller.signal,
              onError,
              onDone,
              onFrame,
            )
        : (
            onError: (code: string | null) => void,
            onDone: () => void,
            onFrame: (event: string, data: unknown) => void,
          ) => streamAugmentJob(jobId, controller.signal, onError, onDone, onFrame);
      await stream(
        (code) => {
          failed = true;
          if (!mountedRef.current) return;
          const gated = code !== null && OUT_OF_CREDITS_CODES.has(code);
          // The thread and any PRIOR proposal survive — recoverable in place.
          setState((s) => ({
            ...s,
            phase: s.review ? 'review' : 'idle',
            progress: null,
            liveReview: null,
            errorCode: gated ? null : (code ?? 'FAILED'),
            outOfCredits: gated,
          }));
        },
        () => {},
        (event, data) => {
          if (!mountedRef.current) return;
          const progress = narrateFrame(event, data);
          // APPEND to the rail and REPLACE the live line, in one update. A quiet
          // frame yields null and does neither, which is the decision the
          // disposition map recorded rather than a frame falling through.
          if (progress) setState((s) => ({ ...s, progress, acts: [...s.acts, progress] }));
        },
      );
      if (failed || !mountedRef.current) return;

      // SETTLED → first, let the PLANNER SPEAK (MOTIR-2226). The run's result
      // carries the findings report it owes on every turn, and the one question
      // it asks when the request was not determinate; recording it here is what
      // puts either into the persisted thread. Best-effort and non-fatal: a
      // failed recording costs the narration, never the proposals, so it must
      // not take the run down with it.
      let asked = false;
      try {
        const sessionId = stateRef.current.session?.id;
        if (!sessionId) throw new Error('no session to narrate into');
        const withTurn = await recordPlannerTurn(sessionId, jobId, anchor, controller.signal);
        if (!mountedRef.current) return;
        asked = pendingQuestion(withTurn.turns) !== null;
        setState((s) => ({ ...s, session: withTurn }));
      } catch {
        /* the run still happened; the thread simply carries no narration */
      }

      // Then read what the run actually PROPOSED, from its Plan. The job
      // result's `planDelta` is not consulted: it is empty by construction. The
      // read is the run's ONE: if the live poll already handed over, this is it.
      const pending = planId ? await readProposalOnce(planId, controller.signal) : null;
      if (!mountedRef.current) return;
      if (pending) {
        setState((s) => ({
          ...s,
          phase: 'review',
          review: pending,
          liveReview: null,
          progress: null,
          errorCode: null,
          // THE PLAN SURVIVES A STOP. A run stopped after it had appended a level
          // settles here, with `pending` holding exactly what it proposed before
          // the stop — so the review block is live and Approve / Discard are both
          // reachable from the stopped state. That is the card's whole point: if
          // stopping threw the work away, nobody would stop a run.
          ...(s.stopping ? { stopping: false, stopped: true } : {}),
        }));
        stoppingRef.current = false;
      } else {
        // Nothing came back. The thread stays; the previous proposal (if any) too.
        //
        // A turn that ASKED proposes nothing BY DESIGN — the planner is blocked
        // on the answer and the canvas stays untouched (design state B) — so
        // "nothing came back to change" would be a false error on the one turn
        // where the rail has the most to say. The question is the outcome.
        setState((s) => ({
          ...s,
          phase: s.review ? 'review' : 'idle',
          progress: null,
          liveReview: null,
          // ⚠️ A STOPPED RUN IS THE THIRD REASON NOTHING CAME BACK, and without
          // this arm it would surface as `EMPTY` — a failure banner on the one
          // outcome the user chose deliberately (MOTIR-4068). The three are:
          // the planner ASKED and is waiting (`asked`); the user STOPPED it
          // (`s.stopping`); or the run genuinely proposed nothing, which is the
          // only one that is an error.
          errorCode: asked || s.stopping ? null : 'EMPTY',
          // The interval closes HERE and only here: the stream has ended, so the
          // walk reached its boundary and read the flag. Until this moment the
          // bar says "stopping", which is the honest thing to say.
          ...(s.stopping ? { stopping: false, stopped: true } : {}),
        }));
        stoppingRef.current = false;
      }
    },
    [readProposalOnce],
  );

  /** Submit the thread's ACCUMULATED intent, then stream + settle the job. Shared
   *  by `send` (after the turn is appended) and `retry` (nothing new to append).
   *
   *  `submitter` is what actually sends: the project submit, the anchored
   *  resubmit, or — anchored — the ONE call that appends the new turn AND submits
   *  it (the MOTIR-909 contract fuses those two). Everything downstream (stream,
   *  settle, review) is identical for both threads; only the URL differs. */
  const run = useCallback(
    async (
      anchor: RunAnchor | null,
      submitter?: (
        signal: AbortSignal,
      ) => Promise<{ jobId: string; planId?: string; session: PlanChangeSessionDto }>,
    ) => {
      const controller = new AbortController();
      abortRef.current = controller;
      resetLiveRun();
      let livePlan: string | null = null;
      // Remembered before the hop, so a retry after a failure re-sends to the
      // thread this turn actually landed in.
      lastAnchorRef.current = anchor;
      const submit =
        submitter ??
        (anchor
          ? (signal: AbortSignal) =>
              resubmitContextualPlan(
                anchor.anchorId,
                anchor.targetKeys,
                signal,
                stateRef.current.session?.id ?? null,
              )
          : (signal: AbortSignal) => submitPlanChange(stateRef.current.session?.id ?? '', signal));

      try {
        const { jobId, planId, session } = await submit(controller.signal);
        if (!mountedRef.current) return;
        // The hosted run's plan is watched live from the moment it is known.
        livePlan = planId ?? null;
        setLivePlanId(livePlan);
        setState((s) => ({
          ...s,
          phase: 'streaming',
          session,
          jobId,
          // A new run supersedes whatever the resume re-attached to, so this is
          // an assignment, not a merge — `undefined` (a stub) clears it.
          planId: planId ?? null,
          // …and it supersedes a DECIDED overlay (MOTIR-3162). The review is kept
          // THROUGH the decision so the canvas can draw it; a new run is the
          // moment it stops describing anything, so a decided overlay can never
          // bleed into the next generation.
          //
          // ⚠️ Only a DECIDED one. A still-pending proposal survives a run,
          // because `retry` comes through here too and a retry CONTINUES the
          // conversation rather than restarting it — clearing unconditionally
          // would drop a proposal the user is still looking at and the server
          // still awaits a decision on.
          review: s.decided ? null : s.review,
          liveReview: null,
          discardedReview: null,
          decided: null,
          ...firstAct('submitted'),
          errorCode: null,
          outOfCredits: false,
          // A NEW run is not stopped, and neither is a retry (MOTIR-4068). Both
          // flags are per-RUN: leaving them set would carry a previous run's
          // ending onto the one just started, which is the mirror of the bug
          // this state exists to prevent.
          stopping: false,
          stopped: false,
          // The mailbox is per-RUN, so the queue is too: a new job has an empty
          // one, and carrying the last run's turns into it would show the user
          // sentences that can never be read again.
          queued: [],
        }));
        stoppingRef.current = false;

        await finishPlanRun(jobId, planId, anchor, controller);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!mountedRef.current) return;
        const gated = err instanceof PlanEditsClientError && err.isOutOfCredits;
        setState((s) => ({
          ...s,
          phase: s.review ? 'review' : 'idle',
          progress: null,
          errorCode: gated ? null : 'FAILED',
          outOfCredits: gated,
        }));
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        endLive(livePlan);
      }
    },
    [finishPlanRun, resetLiveRun, endLive],
  );

  /**
   * Run ONE turn through the ask door — the project thread's only entrance since
   * MOTIR-1343 (`docs/decisions/conversation-turn-intent.md` §2).
   *
   * The shape is deliberately NOT "ask, and separately plan": the client posts
   * text, streams the `ask_project` job, and asks the server what it produced.
   * Exactly one of three things comes back, and the third is the interesting one:
   *
   *  * `answered` — an assistant turn with its citations is on the thread.
   *  * `silent`   — the job said nothing at all. Core persists nothing for it
   *    (inventing a body would be motir-core writing the assistant's words), so
   *    the rail says so honestly rather than showing an empty bubble.
   *  * `redirected` — the turn was a plan change. From here the run hands off to
   *    {@link finishPlanRun}, the SAME tail a plan-change submit uses, so the
   *    shipped diff + confirm chrome returns in the same thread.
   *
   * ⚠️ THE WAITING STATE IS CONTINUOUS ACROSS THE HAND-OFF. `phase` stays
   * `streaming` and only `progress` changes, because a bubble that unmounts and
   * returns reads as "that failed, it is trying again" — and nothing failed.
   */
  const runAsk = useCallback(
    async (
      submitter: (signal: AbortSignal) => Promise<AskSubmitResponse | AskRedirectResponse>,
    ) => {
      const controller = new AbortController();
      abortRef.current = controller;
      resetLiveRun();
      let livePlan: string | null = null;
      // An ask is project-wide by construction, so a retry after one must not
      // re-aim at an anchor an earlier plan-change run happened to use.
      lastAnchorRef.current = null;

      try {
        const submitted = await submitter(controller.signal);
        if (!mountedRef.current) return;

        // REDIRECTED AT THE DOOR — no ask job was opened at all. Two turns reach
        // this: a reply to the planner's pending question (the affordance
        // already settled the disposition, so there was nothing to classify) and
        // a re-run the handler hands back before streaming.
        //
        // There is no hand-off to name here, because nothing was read and
        // re-read: the run IS a plan-change run from its first frame, and the
        // waiting row says what it has always said for one.
        if ('outcome' in submitted) {
          lastAskTurnRef.current = null;
          livePlan = submitted.planId ?? null;
          setLivePlanId(livePlan);
          setState((s) => ({
            ...s,
            phase: 'streaming',
            session: submitted.session,
            jobId: submitted.jobId,
            planId: submitted.planId,
            review: s.decided ? null : s.review,
            liveReview: null,
            discardedReview: null,
            decided: null,
            ...firstAct('submitted'),
            errorCode: null,
            outOfCredits: false,
            stopping: false,
            stopped: false,
            queued: [],
          }));
          stoppingRef.current = false;
          await finishPlanRun(submitted.jobId, submitted.planId, null, controller);
          return;
        }

        lastAskTurnRef.current = submitted.turnId;
        setState((s) => ({
          ...s,
          phase: 'streaming',
          session: submitted.session,
          jobId: submitted.jobId,
          planId: null,
          // The same supersede rule `run` applies: a DECIDED overlay stops
          // describing anything the moment a new run starts; a still-pending
          // proposal survives, because asking a question mid-review is a lookup
          // and not an abandonment.
          review: s.decided ? null : s.review,
          decided: null,
          ...firstAct('reading'),
          errorCode: null,
          outOfCredits: false,
          // A NEW run is not stopped, and neither is a retry (MOTIR-4068). Both
          // flags are per-RUN: leaving them set would carry a previous run's
          // ending onto the one just started, which is the mirror of the bug
          // this state exists to prevent.
          stopping: false,
          stopped: false,
          // The mailbox is per-RUN, so the queue is too: a new job has an empty
          // one, and carrying the last run's turns into it would show the user
          // sentences that can never be read again.
          queued: [],
        }));
        stoppingRef.current = false;

        let failed = false;
        await streamAskJob(
          submitted.jobId,
          controller.signal,
          (code) => {
            failed = true;
            if (!mountedRef.current) return;
            const gated = code !== null && OUT_OF_CREDITS_CODES.has(code);
            setState((s) => ({
              ...s,
              phase: s.review ? 'review' : 'idle',
              progress: null,
              errorCode: gated ? null : (code ?? 'FAILED'),
              outOfCredits: gated,
            }));
          },
          () => {},
        );
        if (failed || !mountedRef.current) return;

        const settled = await settleAskJob(
          submitted.jobId,
          controller.signal,
          submitted.session?.id ?? stateRef.current.session?.id ?? null,
        );
        if (!mountedRef.current) return;

        if (settled.outcome === 'redirected') {
          livePlan = settled.planId ?? null;
          setLivePlanId(livePlan);
          setState((s) => ({
            ...s,
            session: settled.session,
            jobId: settled.jobId,
            planId: settled.planId,
            // A plan run starts here, so an earlier discarded plan stops describing it.
            discardedReview: null,
            // The hand-off is an act like any other: it joins the record as well
            // as replacing the live line (MOTIR-4069).
            progress: { kind: 'redirected' },
            acts: [...s.acts, { kind: 'redirected' }],
          }));
          await finishPlanRun(settled.jobId, settled.planId, null, controller);
          return;
        }

        setState((s) => ({
          ...s,
          session: settled.session,
          phase: s.review ? 'review' : 'idle',
          progress: null,
          // `silent` is NOT the honest "I could not find that" — that is prose
          // the handler returns, and it lands as an ordinary answer with no
          // citations. This is the job producing nothing at all.
          errorCode: settled.outcome === 'silent' ? 'ASK_SILENT' : null,
        }));
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!mountedRef.current) return;
        const gated = err instanceof PlanEditsClientError && err.isOutOfCredits;
        setState((s) => ({
          ...s,
          phase: s.review ? 'review' : 'idle',
          progress: null,
          errorCode: gated ? null : 'FAILED',
          outOfCredits: gated,
        }));
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        endLive(livePlan);
      }
    },
    [finishPlanRun, resetLiveRun, endLive],
  );

  /**
   * Append what the user typed, then run the ACCUMULATED intent.
   *
   * `targets` is the `@`-mention picker's TARGET SET (MOTIR-1491) and, when
   * given, it is AUTHORITATIVE: its first entry is the primary anchor and the
   * rest ride as additional ones — so removing every target really does make the
   * turn project-wide, rather than silently keeping the entrance's item. Omitting
   * the argument entirely means "no opinion about targets", which falls back to
   * the entrance anchor (MOTIR-910's per-item workspace).
   */
  const send = useCallback(
    async (text: string, targets?: readonly PlanningTarget[]) => {
      const body = text.trim();
      if (!body) return;

      // ⚠️ THE RUN IS STILL WORKING → THE MAILBOX, NOT THE SUBMIT (MOTIR-4274).
      //
      // ⚠️ AND THIS SITS ABOVE THE `abortRef` BAIL DELIBERATELY. That guard —
      // `if (abortRef.current) return` — is the SECOND place the composer was
      // locked during a run, and the one that is invisible: the `disabled` prop
      // is what a reader sees, and this is what actually refused the call. It was
      // right when a run was a monologue (there was nowhere for the turn to go,
      // so a second send could only mean a second job) and it is wrong now, for
      // exactly the same reason the prop was.
      //
      // It still guards the SUBMIT path below, which is what it was written for:
      // a mid-run turn must never start a second job, and that remains true —
      // the turn goes to the mailbox instead of being dropped.
      //
      // One control, two destinations, chosen by the phase — and the user does
      // not have to know which. Both wrong answers are SILENT: a mid-run turn
      // sent down the submit path opens a SECOND planning job on a thread that
      // already has one, and a between-runs turn sent to the mailbox lands in a
      // box nothing will ever check. So the branch is here, once, before either
      // door is chosen.
      //
      // It starts nothing. The run reads this at its next phase boundary, which
      // can be a whole authoring session away, so the turn is QUEUED until it
      // does — and the surface says so rather than looking delivered.
      if (stateRef.current.phase === 'streaming') {
        const jobId = stateRef.current.jobId;
        if (!jobId) return;
        // Per SEND, never per render: a retry of this click must deliver once,
        // and the next sentence must not be swallowed as a replay of this one.
        const idempotencyKey = `turn:${jobId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        try {
          const delivery = await attachMidRunTurn(
            stateRef.current.session?.id ?? '',
            jobId,
            body,
            idempotencyKey,
          );
          if (!mountedRef.current) return;
          setState((s) => ({
            ...s,
            // The door answers with the mailbox AS IT STANDS, so this is the
            // whole pending set rather than a local append — which keeps the
            // count right when a turn was consumed between two sends.
            queued: delivery.turns.map((t) => ({ id: t.id, text: t.text, read: false })),
          }));
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          if (!mountedRef.current) return;
          // A LEGIBLE refusal, and the draft is the caller's to keep. The common
          // one is `PLAN_CHANGE_JOB_NOT_RUNNING` — the run settled between the
          // render and the click — which is a state conflict rather than a
          // failure of the thread, so the conversation is untouched.
          const code = err instanceof PlanEditsClientError ? err.code : null;
          setState((s) => ({ ...s, errorCode: code ?? 'MAILBOX_FAILED' }));
        }
        return;
      }

      // Below here is the SUBMIT path, which still refuses re-entry: a run is in
      // flight and starting a second one is the thing the guard exists to stop.
      if (abortRef.current) return;

      // Is this turn the REPLY to a question the planner is waiting on? Derived
      // from the thread the user was actually looking at when they pressed the
      // button — the same derivation the composer used to decide whether to show
      // the answer bar, so the recorded disposition and the affordance that sent
      // it can never disagree. (Not "did the words answer it" — that judgement is
      // not the code's to make.)
      const isAnswer = pendingQuestion(stateRef.current.session?.turns ?? []) !== null;

      // ANCHORED: appending and submitting are ONE call (MOTIR-909 resolves and
      // view-gates the anchors first, so the contract fuses them) — `run` does
      // the whole hop, and there is no separate append to fail on its own.
      const anchor = resolveAnchor(targets, anchorRef.current);
      if (anchor) {
        // Busy from the click, not from the response: the composer must lock
        // immediately or a second Enter fires a second turn (the project branch
        // below gets this from its own optimistic set).
        setState((s) => ({
          ...s,
          phase: 'streaming',
          ...firstAct('submitted'),
          errorCode: null,
          outOfCredits: false,
          // A NEW run is not stopped, and neither is a retry (MOTIR-4068). Both
          // flags are per-RUN: leaving them set would carry a previous run's
          // ending onto the one just started, which is the mirror of the bug
          // this state exists to prevent.
          stopping: false,
          stopped: false,
          // The mailbox is per-RUN, so the queue is too: a new job has an empty
          // one, and carrying the last run's turns into it would show the user
          // sentences that can never be read again.
          queued: [],
        }));
        stoppingRef.current = false;
        const heldSession = stateRef.current.session?.id ?? null;
        // The seed rides ONLY the send that has no session yet (MOTIR-6210).
        const seed = heldSession ? null : seedRef.current;
        await run(anchor, (signal) =>
          seed
            ? submitContextualPlan(
                anchor.anchorId,
                body,
                anchor.targetKeys,
                signal,
                isAnswer,
                heldSession,
                seed,
              ).catch((err: unknown) => {
                if (err instanceof PlanEditsClientError && err.code === 'SEED_NOT_APPLICABLE') {
                  seedRef.current = null;
                }
                throw err;
              })
            : submitContextualPlan(
                anchor.anchorId,
                body,
                anchor.targetKeys,
                signal,
                isAnswer,
                heldSession,
              ),
        );
        return;
      }

      // PROJECT: the ONE DOOR (MOTIR-1343). The composer has no switch and sends
      // no intent — `POST /api/ai/ask` appends the turn and submits it, and what
      // the turn turns out to be comes back. A plan change is handed off inside
      // `runAsk`, so this branch does not choose between two endpoints; there is
      // only one, and choosing here is exactly the mode the design does not have.
      //
      // `isAnswer` still rides along (ADR §1's wire table): it is not an intent,
      // it is which affordance sent the turn — the record that lets the thread
      // say later whether the planner's question was answered or superseded.
      setState((s) => ({
        ...s,
        phase: 'streaming',
        ...firstAct('submitted'),
        errorCode: null,
        outOfCredits: false,
        // Per-RUN, like every other start reducer (MOTIR-4068). The ONE DOOR is
        // still a new run even though it may turn out to be an ask, so a
        // previous run's ending must not be painted onto it.
        stopping: false,
        stopped: false,
        queued: [],
      }));
      stoppingRef.current = false;
      await runAsk((signal) =>
        submitAskTurn(body, signal, isAnswer, stateRef.current.session?.id ?? null),
      );
    },
    [run, runAsk],
  );

  /** Re-send the accumulated intent after a failure — no new turn, so the
   *  conversation CONTINUES rather than restarting (design panel 6, error).
   *
   *  It resubmits to the thread the FAILED run used (its target set included),
   *  not to whatever is picked now — retrying a turn must not quietly re-aim it.
   *  Before any run, that is the entrance's anchor. */
  const retry = useCallback(async () => {
    if (abortRef.current) return;
    setState((s) => ({ ...s, errorCode: null, outOfCredits: false }));
    const anchor =
      lastAnchorRef.current ??
      (anchorRef.current ? { anchorId: anchorRef.current, targetKeys: [] } : null);
    // PROJECT thread: re-run the TURN the failed ask was for, not the thread's
    // accumulated intent. No second `user` turn is appended either way — the
    // person said one thing once — but naming the turn is what keeps the retry
    // pointed at what actually failed.
    if (!anchor && lastAskTurnRef.current) {
      const turnId = lastAskTurnRef.current;
      await runAsk((signal) =>
        rerunAskTurn(turnId, { sessionId: stateRef.current.session?.id ?? null }, signal),
      );
      return;
    }
    await run(anchor);
  }, [run, runAsk]);

  /**
   * CORRECT a mis-read turn — the affordance under the assistant bubble (ADR §3).
   *
   * It re-runs the ORIGINAL user turn under the OTHER intent. Nothing is
   * re-typed, no second user turn is appended, and the superseded assistant turn
   * stays on the thread: a correction is a second answer, not an erasure.
   *
   * ⚠️ THE CLIENT NAMES THE TURN, NEVER THE DIRECTION. Which intent to flip TO is
   * derived server-side from what the turn currently ran as — so even the one
   * affordance where a person is explicitly asking for a different reading keeps
   * the intent server-resolved (§1).
   */
  const correctTurn = useCallback(
    async (turnId: string) => {
      if (abortRef.current) return;
      setState((s) => ({
        ...s,
        phase: 'streaming',
        ...firstAct('reading'),
        errorCode: null,
        outOfCredits: false,
      }));
      await runAsk((signal) =>
        rerunAskTurn(
          turnId,
          { flip: true, sessionId: stateRef.current.session?.id ?? null },
          signal,
        ),
      );
    },
    [runAsk],
  );

  /**
   * After a refused decision, re-read the review when the refusal is a fact about the
   * PLAN (MOTIR-6038): a stale stamp means the proposals moved under the reader, so the
   * next press must carry the stamp of what they are now shown. Best-effort — a failed
   * re-read leaves the review in hand, and the press is refused stale again.
   */
  const rereadAfterRefusal = useCallback(async (planId: string, err: unknown) => {
    if (!(err instanceof PlanRequestError) || err.code !== 'APPROVAL_GATE_STALE_SUBJECT') return;
    try {
      const fresh = await fetchPlanReview(planId);
      if (!mountedRef.current) return;
      setState((s) => (s.planId === planId ? { ...s, review: fresh } : s));
    } catch {
      /* keep the review in hand */
    }
  }, []);

  /**
   * PERSIST the proposal — `POST /api/plans/[id]/approve`, which decides the plan's
   * gate through the one decide door (MOTIR-6038) and `materialize`s it, behind the
   * 7.12.5 persist gate. It is the SAME operation `/plans/[id]` performs, on the same
   * Plan: two entrances, one door, no second write path. The press carries the stamp
   * of the review the reader was shown. The thread STAYS.
   */
  const approve = useCallback(async () => {
    const { planId, review } = stateRef.current;
    if (!planId) return;
    setState((s) => ({ ...s, phase: 'deciding', errorCode: null }));

    try {
      const approved = summarizePlanApproval(
        await approvePlanRequest(planId, review?.gate?.stamp ?? null),
      );
      // ⚠️ RE-READ THE DECIDED PLAN (bug MOTIR-3206). The review in hand was read
      // while the plan was `planned`, so every `add` in it is keyed by its
      // PlanItem id and carries no identifier. Keeping the overlay past the
      // decision (MOTIR-3162) therefore drew each accepted card TWICE: once as
      // the committed node the level read now returns, once as the keyless ghost
      // the stale review still describes. `getPlanReview` re-keys a materialized
      // add by the work item it became and fills in its identifier (MOTIR-3160) —
      // only the server knows those ids, so this read is the only way the canvas
      // can land the treatment ON the card.
      //
      // Best-effort by design: a failed re-read leaves the previous review in
      // place, which is the picture that shipped before — worse, never broken.
      // The approve itself has already succeeded and is not re-tried or undone.
      let decidedReview: PlanReviewDto | null = null;
      try {
        decidedReview = await fetchPlanReview(planId);
      } catch {
        /* keep the pre-decision review rather than losing the overlay entirely */
      }
      if (!mountedRef.current) return;
      setState((s) => ({
        ...s,
        phase: 'idle',
        // The review STAYS (MOTIR-3162) — it is the record of what was accepted,
        // and `decided` is what turns it into the accepted treatment.
        review: decidedReview ?? s.review,
        decided: 'accepted',
        jobId: null,
        // Decided: the plan is no longer pending, so its handle goes with the
        // job id rather than lingering as a stale confirm target.
        planId: null,
        approved,
        progress: null,
        errorCode: null,
      }));
      // THE ROW SETTLES IN PLACE (MOTIR-6037; design Part XXII §22.2, § 20's rule). The
      // To-approve list under this overlay is a client island `router.refresh()` cannot
      // reach, so an asked plan's decision travels through the decided-gates store.
      announcePlanGateDecided(review, 'approved');
      approvedCbRef.current?.(approved);
    } catch (err) {
      if (!mountedRef.current) return;
      setState((s) => ({ ...s, phase: 'review', errorCode: planDecisionErrorCode(err) }));
      await rereadAfterRefusal(planId, err);
    }
  }, [rereadAfterRefusal]);

  /**
   * DISCARD the proposal — `POST /api/plans/[id]/decline`, which drops the
   * proposed items and leaves the tree untouched. It writes to the PLAN (so the
   * run is decided rather than left orphaned at `planned`) and never to the tree.
   * The conversation stays open either way.
   */
  const discard = useCallback(
    async (noteMd?: string | null) => {
      const { planId, review } = stateRef.current;
      setState((s) => ({ ...s, phase: 'deciding', errorCode: null }));
      try {
        // The reason is OPTIONAL on a plan's decline (ADR §11.4; MOTIR-6037's confirm band).
        const stamp = review?.gate?.stamp ?? null;
        if (planId) {
          await (noteMd
            ? declinePlanRequest(planId, stamp, noteMd)
            : declinePlanRequest(planId, stamp));
        }
        if (planId) announcePlanGateDecided(review, 'declined');
        if (!mountedRef.current) return;
        setState((s) => ({
          ...s,
          phase: 'idle',
          // The review STAYS (MOTIR-3162). This is the case where nothing survived
          // at all: a discarded plan left the workspace with no trace, so somebody
          // who had just spent ten minutes shaping a tree and decided against it
          // had nothing to look back at before starting the next turn.
          decided: 'declined',
          jobId: null,
          planId: null,
          progress: null,
          errorCode: null,
        }));
      } catch (err) {
        if (!mountedRef.current) return;
        // The proposal is still pending — say so and leave it decidable, rather
        // than clearing a canvas the server still considers awaiting a decision.
        setState((s) => ({
          ...s,
          phase: 'review',
          errorCode: planDecisionErrorCode(err, 'discard'),
        }));
        if (planId) await rereadAfterRefusal(planId, err);
      }
    },
    [rereadAfterRefusal],
  );

  const dismissError = useCallback(() => {
    setState((s) => ({ ...s, errorCode: null, outOfCredits: false }));
  }, []);

  /**
   * WATCH the mailbox drain (Story MOTIR-4054 · MOTIR-4274).
   *
   * ⚠️ A POLL, AND ONLY BECAUSE THERE IS NOTHING TO PUSH. `motir-ai` consumes a
   * turn at a phase boundary and emits NO frame for it; the ids it records land
   * in a `MailboxReport` that never reaches motir-core (the handler returns
   * `{ planDelta, summary }`). So a turn's ABSENCE from the pending set is the
   * only evidence the run took it, and asking is the only way to see it.
   *
   * ⚠️ IT IS BOUNDED BY ITS OWN CONDITION, which is the thing that makes it
   * acceptable rather than a background timer nobody remembers. It runs only
   * while a run is STREAMING and something is UNREAD — so the overwhelmingly
   * common run, the one where nobody typed anything, makes zero requests, and
   * the last read stops it rather than a timeout.
   *
   * If a `folded` frame ever lands upstream, delete this effect and read the
   * frame; nothing else here changes.
   */
  useEffect(() => {
    const unread = state.queued.some((t) => !t.read);
    const jobId = state.jobId;
    if (state.phase !== 'streaming' || !unread || !jobId) return;

    const controller = new AbortController();
    const timer = setInterval(() => {
      void (async () => {
        try {
          const delivery = await peekMailbox(
            stateRef.current.session?.id ?? '',
            jobId,
            controller.signal,
          );
          if (!mountedRef.current) return;
          const stillWaiting = new Set(delivery.turns.map((t) => t.id));
          setState((s) => ({
            ...s,
            // Read = no longer waiting. Nothing is removed: the transcript is a
            // record, and a turn the run TOOK is exactly the one worth still
            // seeing — it is why the next level looks the way it does.
            queued: s.queued.map((t) => (stillWaiting.has(t.id) ? t : { ...t, read: true })),
          }));
        } catch {
          /* a failed peek is not a finding: the next tick asks again, and the
             run is unaffected either way. */
        }
      })();
    }, MAILBOX_POLL_MS);

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [state.phase, state.jobId, state.queued]);

  /**
   * WATCH the plan's gate while it waits on a decision (bug MOTIR-6151).
   *
   * ⚠️ THIS SURFACE ONLY EVER RE-READ A PLAN IT WAS WRITING. A revision lease taken
   * anywhere else left `review.gate.held` exactly as the last read found it, so Approve
   * and Decline stayed live and the press was refused by the door
   * (`PLAN_REVISION_IN_FLIGHT`) — nothing wrong was written, but the reader was offered
   * a decision the plan could not take until they navigated. The page-state contract's
   * client-island rule: this island seeds its own state, so nothing but its own read
   * reaches it.
   *
   * ⚠️ BOUNDED BY ITS OWN CONDITION, like the mailbox watch above. It runs only while a
   * reader could PRESS something — an undecided plan in `review` whose gate is
   * `awaiting` — and a run of this surface's own (`streaming`) or a decision in flight
   * (`deciding`) tears it down, aborting the read in hand, so a late answer never lands
   * over the decision. A hidden tab skips its ticks and catches up on return.
   */
  const gateAwaiting = state.review?.gate?.state === 'awaiting';
  useEffect(() => {
    const planId = state.planId;
    if (state.phase !== 'review' || state.decided !== null || !planId || !gateAwaiting) return;

    const controller = new AbortController();
    const reread = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void (async () => {
        try {
          const fresh = await fetchPlanReview(planId, controller.signal);
          if (!mountedRef.current || controller.signal.aborted) return;
          setState((s) =>
            s.planId === planId && s.phase === 'review' && s.decided === null
              ? { ...s, review: fresh }
              : s,
          );
        } catch {
          /* a failed read is not a finding: the next tick asks again. */
        }
      })();
    };
    const timer = setInterval(reread, PLAN_GATE_POLL_MS);
    window.addEventListener('focus', reread);
    document.addEventListener('visibilitychange', reread);

    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('focus', reread);
      document.removeEventListener('visibilitychange', reread);
    };
  }, [state.phase, state.decided, state.planId, gateAwaiting]);

  /**
   * END the run (Story MOTIR-4054 · MOTIR-4068).
   *
   * ⚠️ IT DOES NOT END ANYTHING BY ITSELF, and everything about this callback
   * follows from that. It raises a flag in the boundary mailbox; `runWalk` reads
   * it at its NEXT phase boundary and opens no further phase. Between the two the
   * run is still narrating, so this sets `stopping` and nothing else — the
   * terminal `stopped` is written by the SETTLE, when the stream actually ends,
   * which is the only moment the run really is over.
   *
   * The optimistic alternative — flipping straight to `stopped` — is the defect
   * the card names outright: a rail that keeps narrating under a surface that
   * says the run finished is worse than a slow stop.
   *
   * ⚠️ AND IT IS SAFE WHERE THE CLICK IS REDUNDANT. Stopping an already-finished
   * or already-stopped run is a no-op the server answers cleanly, so a run that
   * settles between render and click costs nothing. The one thing this guards is
   * a SECOND raise: `stopping` gates re-entry, and the key is minted per click so
   * a retry of the same click still delivers once.
   */
  const stop = useCallback(async () => {
    const { jobId, phase } = stateRef.current;
    // Nothing to stop, or a stop already in flight. Not an error and not
    // reported as one: the control stays reachable in both states by design.
    if (!jobId || phase !== 'streaming' || stoppingRef.current) return;

    stoppingRef.current = true;
    setState((s) => ({ ...s, stopping: true }));
    try {
      await stopPlanChangeRun(stateRef.current.session?.id ?? '', jobId, `stop:${jobId}`);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (!mountedRef.current) return;
      // The RAISE failed — the run is NOT stopping, and saying so is the honest
      // answer. Leaving the bar in its stopping state would tell the user their
      // click landed when it did not, and they would wait instead of clicking
      // again. The run itself is untouched, so nothing else changes.
      stoppingRef.current = false;
      setState((s) => ({ ...s, stopping: false }));
    }
  }, []);

  // `failing` is the poll's own, so it rides on the state it describes.
  const exposed = useMemo(
    () => (state.liveFailing === liveFailing ? state : { ...state, liveFailing }),
    [state, liveFailing],
  );

  return { state: exposed, send, retry, correctTurn, approve, discard, dismissError, stop };
}
