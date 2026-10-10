'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import {
  Bot,
  Check,
  FilePenLine,
  History,
  Inbox,
  Lock,
  MessageCircleQuestionMark,
  PenLine,
  RefreshCw,
  SearchCheck,
  Sparkles,
  SquarePen,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { Spinner } from '@/components/ui/Spinner';
import { Tooltip } from '@/components/ui/Tooltip';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { WorkItemRefChip } from '@/components/markdown/WorkItemRefChip';
import { AiPaywall } from '@/components/ai/AiPaywall';
import { PlanChangeComposer } from '@/components/planning/PlanChangeComposer';
import { StalePlanNotice } from '@/components/planning/StalePlanNotice';
import { PlanActRecord, runningBarLine } from '@/components/planning/PlanActRecord';
import { PlanNarration, narrationHeadLines } from '@/components/planning/PlanNarration';
import {
  groupNarration,
  mergeNarrationEntries,
  narrationEarlierCount,
} from '@/components/planning/planNarration';
import { PlanningTargetKeyChip } from '@/components/planning/PlanningTargetChip';
import {
  AnsweredAside,
  ForwardOffer,
  ForwardRefusal,
  ForwardedMarks,
  PendingAsk,
  ProposalRef,
  QueuedLabel,
} from '@/components/planning/MidRunTurn';
import { PauseThread } from '@/components/planning/RunPause';
import { isOpenUnclear, pauseAnchorIndex, pauseOf, pauseOwnedIds } from '@/lib/planning/runPause';
import { PlanStaleBand, SeeOnlyLine } from '@/components/planning/PlanChangeConfirmBar';
import { PlanDeclineConfirm } from '@/components/planning/PlanDeclineConfirm';
import {
  PlanApproveProgress,
  type PlanApproveProgressView,
} from '@/components/planning/PlanApproveProgress';
import type { PlanGateView } from '@/lib/planning/planGateView';
import type { PlanningSeedPickDTO } from '@/lib/dto/planningSeed';
import { claimPickAutoSend } from '@/lib/planning/pickAutoSend';
import {
  dispositionMarkerFor,
  forwardOfferStale,
  pendingQuestion,
  threadOwnedMailboxIds,
  type QuestionDisposition,
} from '@/lib/planning/planChangeThread';
import type {
  DebugLandingDto,
  EarlierSessionDto,
  PlanChangeTurnDto,
  PlanChangeTurnRoleDto,
} from '@/lib/dto/planChange';
import type { WorkItemRefMap, WorkItemRefSummaryDto } from '@/lib/dto/workItems';
import type {
  PlanChangeConversationState,
  PlanChangeProgress,
  QueuedTurn,
} from '@/lib/hooks/usePlanChangeConversation';
import type { PlanChangeDiffIndex } from '@/lib/planning/planChangeDiff';
import type { PlanningLaunch, PlanningMode } from '@/lib/planning/launcher';
import type { PlanningTarget } from '@/lib/planning/planningTargets';
import { BrandMark } from '@/components/brand/BrandMark';
import {
  CarryDecidedNotice,
  carriesWaitingPlan,
  CopiedDivider,
  copiedTurnCount,
  EndedComposerSlot,
  RestartedDivider,
  SessionEndMarker,
  PlanMovedAwayLine,
  PlanMovedLine,
  TakenBackNotice,
  WaitingPlanComposerGloss,
  WaitingPlanStillWaits,
  TargetRefusal,
} from '@/components/planning/SessionEndParts';
import { workbenchTabHref } from '@/lib/workbench/tab';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

// The planning workspace's CHAT RAIL on an established project (Subtask
// MOTIR-1730; design `plan-change-conversation.mock.html` panels 3 + 6). Changing
// a plan is a CONVERSATION: each turn appends to the persisted, project-scoped
// thread (MOTIR-1728), submitting sends the ACCUMULATED intent, the run narrates
// itself into a polite live region, and the run's PROPOSALS are reviewed ON THE
// CANVAS — not in a corner dock. (What feeds that review is the run's Plan, read
// back through the plans API — MOTIR-1746; the rail's shape is unchanged.)
//
// It COMPOSES the shipped rail language from `DiscoveryChatRail` (the
// `--el-success` status dot + mono header, the avatar/bubble pair, the drafting
// spinner row, the composer) plus the shipped `AiPaywall` for the metered
// refusal. It is a SECOND consumer of that language, not a second chat widget:
// the onboarding rail drives the conductor loop and this one drives the plan-edit
// job, so the two share vocabulary, not state.
//
// Purely presentational + local draft state: every action is forwarded to the
// host, which owns `usePlanChangeConversation` (so the CANVAS can render the same
// proposal the rail is talking about).

const MODE_LABEL_KEY: Record<PlanningMode, string> = {
  project: 'mode.project',
  generation: 'mode.generation',
  replan: 'mode.replan',
  contextual: 'mode.contextual',
  roadmap: 'mode.roadmap',
  // Drawn by `GuideRail`; listed so the map stays total over the modes.
  guide: 'mode.guide',
};

const MODE_LEAD_KEY: Record<PlanningMode, string> = {
  project: 'lead.project',
  generation: 'lead.generation',
  replan: 'lead.replan',
  contextual: 'lead.contextual',
  roadmap: 'lead.roadmap',
  guide: 'lead.contextualItem',
};

/** The originating DETAIL wins over the mode's generic line when one was carried
 *  (a work item, a repo) — both resolve to the `contextual` mode. */
function leadKey(launch: PlanningLaunch): string {
  if (launch.itemKey) return 'lead.contextualItem';
  if (launch.repoKey) return 'lead.conventionRefine';
  return MODE_LEAD_KEY[launch.mode];
}

/** The three outcome-phrased starter chips (design panel 6, "empty"). They are
 *  hints that PREFILL the composer, not a mode menu — the user still edits and
 *  sends, so nothing is submitted behind their back. */
/** …and since MOTIR-1343 a QUESTION-shaped one, because the surface answers
 *  questions too. It is a STARTER and not a row-scoped seed on purpose: the
 *  callout's "Ask about this project" row shares one href with every other row,
 *  so a seed that belonged to the row would be a mode arriving through the door
 *  (`conversation-turn-intent.md` §5). Belonging to the SURFACE, it shows however
 *  the user got here — which is what "the menu only advertises" means in the one
 *  place a person actually types. */
const STARTERS = ['addWork', 'resequence', 'drop', 'blocked'] as const;

export interface PlanChangeRailProps {
  launch: PlanningLaunch;
  projectName: string;
  /**
   * THE USER HAS JUST COME BACK FROM ONBOARDING (MOTIR-4770).
   *
   * ⚠️ IT IS ACKNOWLEDGED IN THE CONVERSATION, NOT AS A TOAST OR A BANNER. The
   * rail is where the session speaks; a toast fades and a returning user can
   * miss it entirely, and a banner over the canvas would put chrome between them
   * and the thing they came back for. It sits ABOVE the opener, because it is
   * what happened before this session says anything.
   *
   * The ABANDONED path never sets it — nothing was completed to acknowledge.
   */
  justReturnedFromOnboarding?: boolean;
  /**
   * THE SEEDED FIRST TURN (story MOTIR-6068 · MOTIR-6210) — a refused decision's
   * re-plan opens with the turn already written, UNSENT, in the composer (design
   * MOTIR-6206 sheets 2–5). It is the draft's INITIAL value and nothing more:
   * nothing is sent on mount, the person may edit or clear it, and while it is in
   * the field the starter chips stay hidden — a starter `setDraft`s its own text,
   * so pressing one would silently throw the seed away.
   */
  initialDraft?: string;
  /**
   * A PICK'S FIRST TURN, SENT FOR THE PERSON (story MOTIR-6069 · MOTIR-6435;
   * `picked-option-planning-starts.md`). Where `initialDraft` pre-fills and waits,
   * this is sent ONCE, as their first message, as soon as the conversation is
   * idle with no user turn — the yes that opened the planner was the consent. It
   * never lands in the composer unless the send FAILS, and then it is put back
   * there with the rail's ordinary error, so nothing is lost.
   */
  autoSendTurn?: string;
  /** The gate the one-time send is claimed under (`claimPickAutoSend`), so a
   *  remount or a second open cannot send it again. Paired with `autoSendTurn`. */
  autoSendKey?: string | null;
  /**
   * THE WIDGET'S SEEDED SEND JOINS THE THREAD THAT IS OPEN (MOTIR-7050). A pick's
   * turn starts a conversation, so it is sent only into an EMPTY one; the report
   * widget's debug turn lands on the person's project conversation whatever it
   * already holds, so it is sent as soon as that thread is ready — idle, or
   * holding an undecided proposal — with no user-turn condition.
   */
  autoSendIntoThread?: boolean;
  /**
   * How the one-time send is SENT, when it is not an ordinary composer send —
   * the widget's turn carries its triage bug as the ask's anchor (MOTIR-7050).
   * Absent → `onSend`.
   */
  onAutoSend?: (text: string) => void;
  /** Where the caret lands in a pre-filled `initialDraft` — and that the field
   *  takes focus at all (the orb's debug template, MOTIR-7050). Absent → the
   *  shipped behaviour: no focus unless the re-plan asks for its reason. */
  initialDraftCaret?: number;
  /**
   * THE FOLLOW-UP FRAMING (design MOTIR-6432, revisions 2–3): the conversation
   * is the follow-up to a choice just made. The chip, the lead and the opener's
   * second line say so, and the *Follow-up to a choice* card sits under the
   * opener. Absent on every other launch.
   */
  followUp?: PlanningSeedPickDTO | null;
  state: PlanChangeConversationState;
  /** The indexed proposal — the rail MIRRORS the canvas bar's counts. */
  index: PlanChangeDiffIndex;
  /** The turn's TARGET SET (MOTIR-1491). Owned by the host, because the canvas
   *  highlights the same set the composer collects. */
  targets: readonly PlanningTarget[];
  onAddTarget: (target: PlanningTarget) => void;
  onRemoveTarget: (identifier: string) => void;
  onSend: (text: string) => void;
  onRetry: () => void;
  /**
   * RE-RUN the user turn `turnId` under the other intent — the correction
   * affordance under an assistant bubble (`conversation-turn-intent.md` §3).
   * Offered only from a plan change (or a debug) TO an answer: AMENDMENT 3
   * retired the flip into a planning run.
   *
   * It names the TURN and never the direction: which intent to flip to is
   * derived server-side from what the turn currently ran as, so the one
   * affordance where a person explicitly asks for a different reading still
   * leaves the intent server-resolved.
   */
  onCorrectTurn: (turnId: string) => void;
  onApprove: () => void;
  onDiscard: () => void;
  /**
   * END the run (Story MOTIR-4054 · MOTIR-4068). Optional so every shipped call
   * site that does not offer a stop keeps compiling and simply renders no bar —
   * the rail is presentational and the host owns the conversation.
   */
  onStop?: () => void;
  /**
   * THE PLAN GATE'S STATE for the plan in hand (Story MOTIR-6012 · MOTIR-6037; design
   * Part XXII §22.4–§22.5) — the SAME derivation the canvas bar reads, so the review block
   * mirrors the gate it sits beside. Absent → `ungated`: the shipped words.
   */
  gateView?: PlanGateView;
  /** Decline was pressed in THIS block — its confirm band replaces the verbs. */
  declining?: boolean;
  onRequestDecline?: () => void;
  onCancelDecline?: () => void;
  onConfirmDecline?: (noteMd: string | null) => void;
  /** A press from THIS block was refused as stale. */
  staleRefused?: boolean;
  /** The approve's progress in this block's rail form (MOTIR-5249; Part XXV): running
   *  replaces the verbs, a timeout puts the band where the stale band goes. */
  approveProgress?: PlanApproveProgressView | null;
  /**
   * THE CONVERSATION HAPPENED ELSEWHERE (MOTIR-6298; design Part XXIII §23.11 ·
   * sheet 10 B). An MCP-authored plan's session can hold no turns, because the
   * agent's conversation happened in its own harness. Set → one notice under the
   * reopened line and above the opener naming that harness, rendered AS GIVEN
   * (`authorHarness` is data, not a closed set). The opener, the starter chips and
   * the composer stay exactly as for any session: asking here changes the plan
   * like any other turn.
   *
   * The HOST decides when it is set (zero turns at the moment the plan's
   * attribution is read) and keeps it once a turn is sent, because it is still
   * true; the rail only draws it.
   */
  conversationElsewhere?: { harness: string } | null;
  /**
   * START A NEW SESSION carrying this ended one's conversation (AMENDMENT 23 §6;
   * MOTIR-7643). Optional: a host that offers no copy draws the read-only line in
   * its place.
   */
  onStartNewSession?: () => void;
  /**
   * PLAN SOMETHING NEW (MOTIR-7650; ADR AMENDMENT 3). `onRequestRestart` is the
   * rail-head control — it raises the fixed confirm on the thread; `onAnswerRestart`
   * answers that confirm. Optional: a host that offers no restart draws neither.
   */
  onRequestRestart?: () => void;
  onAnswerRestart?: (answer: 'confirm' | 'keep') => void;
  /**
   * THE CARRY (Story MOTIR-7928 · MOTIR-7932): the send of an ENDED session whose
   * plan still waits, which starts the new session carrying it. Optional: a host
   * that does not carry draws the ended slot as before.
   */
  onCarrySend?: (text: string) => void;
  /** PLAN IT AGAIN on the stale notice (MOTIR-7945's accept; design state 10). */
  onPlanAgain?: () => void;
  /**
   * SELECT a proposal on the canvas from the chip an answer names it with
   * (MOTIR-7998; design state 3b). Optional: absent, the chip is drawn as text.
   */
  onSelectProposal?: (planItemId: string) => void;
  /**
   * ANSWER the planner's mid-run pause (MOTIR-8010): *Start over* / *Keep going* on
   * a re-plan offer. Optional: absent, the offer's buttons do nothing.
   */
  onAnswerRunPause?: (choice: 'start_over' | 'apply') => void;
  /** "N earlier notes" (MOTIR-8064): page earlier narration sentences in. */
  onShowEarlierNarration?: () => void;
}

export function PlanChangeRail({
  launch,
  projectName,
  justReturnedFromOnboarding,
  initialDraft,
  autoSendTurn,
  autoSendKey = null,
  autoSendIntoThread = false,
  onAutoSend,
  initialDraftCaret,
  followUp = null,
  state,
  index,
  targets,
  onAddTarget,
  onRemoveTarget,
  onSend,
  onRetry,
  onCorrectTurn,
  onApprove,
  onDiscard,
  onStop,
  gateView = { kind: 'ungated' },
  declining = false,
  onRequestDecline,
  onCancelDecline,
  onConfirmDecline,
  staleRefused = false,
  approveProgress = null,
  conversationElsewhere = null,
  onStartNewSession,
  onRequestRestart,
  onAnswerRestart,
  onCarrySend,
  onPlanAgain,
  onSelectProposal,
  onAnswerRunPause,
  onShowEarlierNarration,
}: PlanChangeRailProps) {
  const t = useTranslations('planningWorkspace');
  const tp = useTranslations('approvalGate.planApproval');
  const tRefusal = useTranslations('approvalGate.refusal.alreadyDecided');
  // An ASKED plan (MOTIR-6037): its gate is awaiting, so the review block is the gate's
  // mirror and speaks the gate's words.
  const gated = gateView.kind !== 'ungated';
  // …and the plan it asked about was declined HERE: the conversation stays readable,
  // and a marker says what happened (Panel 6).
  const declinedHere = state.decided === 'declined' && Boolean(state.review?.gate);
  // A PLAN RUN is writing (MOTIR-6037's hand-off, Panel 9): the planner has what it needs
  // and the run is a server job, so the reader may leave. An ASK run carries no plan id.
  const writing = state.phase === 'streaming' && state.planId !== null;
  // …and it is REWRITING the plan in hand rather than writing a first one.
  const rewritingPlan = writing && Boolean(state.review) && !state.decided;
  const tc = useTranslations('planningWorkspace.conversation');
  const ts = useTranslations('planningWorkspace.session');
  // The Planning tab's own copy (§ 36.13) — its reopened line, nothing else.
  const tWorkbenchPlanning = useTranslations('workbench.planning');
  const tr = useTranslations('planningWorkspace.restart');
  const format = useFormatter();
  const [draft, setDraft] = useState(initialDraft ?? '');
  // THE SEEDED SEND THAT FAILED keeps its words (MOTIR-6210). The composer clears
  // the field the moment it submits, and an anchored first turn has no optimistic
  // bubble — so a refused seeded send (`422 SEED_NOT_APPLICABLE`, or any failure)
  // would otherwise leave the person with nothing. The text of the seeded rail's
  // FIRST send is held here, and put back when that send comes back as an error.
  // Adjusted DURING RENDER, React's "storing information from previous renders"
  // shape, rather than in an effect: the error is a render input, not an event.
  const [seededSend, setSeededSend] = useState<string | null>(null);
  const [seenErrorCode, setSeenErrorCode] = useState(state.errorCode);
  // THE REFUSED SEND KEEPS ITS WORDS (MOTIR-7643): a send another holder's card
  // refused is put back in the — now disabled — field, so nothing typed is lost.
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [seenHeld, setSeenHeld] = useState(state.targetHeld ?? null);
  if ((state.targetHeld ?? null) !== seenHeld) {
    setSeenHeld(state.targetHeld ?? null);
    if (state.targetHeld && lastSent !== null && draft === '') setDraft(lastSent);
  }

  const busy = state.phase === 'streaming' || state.phase === 'deciding';
  const turns = state.session?.turns ?? [];
  // A forwarded change is a thread turn AND a mailbox entry: the thread draws it,
  // the standalone queued render below skips it (MOTIR-7998).
  const runPause = pauseOf(state);
  const threadOwned = threadOwnedMailboxIds(turns, pauseOwnedIds(runPause));
  const pauseReplyEntry = runPause?.mailboxEntryId
    ? (state.queued.find((q) => q.id === runPause.mailboxEntryId) ?? null)
    : null;
  const pauseBlock = runPause ? (
    <PauseThread
      pause={runPause}
      pending={Boolean(state.answeringPause)}
      onAnswer={(choice) => onAnswerRunPause?.(choice)}
      replyEntry={pauseReplyEntry}
      refusalCode={state.pauseAnswerRefusal?.code ?? null}
    />
  ) : null;
  const pauseAnchor = runPause ? pauseAnchorIndex(turns, runPause) : -1;
  // THE PAUSED STATE: an unanswered pause, or a reply the run has not read yet.
  const paused =
    runPause !== null &&
    (runPause.answer === null ||
      (runPause.answer === 'replied' && pauseReplyEntry?.read === false));
  // THE REFUSED ANSWER KEEPS ITS WORDS, once: a reply the run never read is put back
  // in the box when the box is empty.
  const pauseRefusal = state.pauseAnswerRefusal ?? null;
  const [seenPauseRefusal, setSeenPauseRefusal] = useState<typeof pauseRefusal>(null);
  if (pauseRefusal !== seenPauseRefusal) {
    setSeenPauseRefusal(pauseRefusal);
    if (pauseRefusal?.text && draft.trim() === '') setDraft(pauseRefusal.text);
  }
  const refusal = state.refusedForward ?? null;
  const [seenRefusal, setSeenRefusal] = useState<typeof refusal>(null);
  const [refusalRestored, setRefusalRestored] = useState(false);
  if (refusal !== seenRefusal) {
    // THE REFUSED CHANGE KEEPS ITS WORDS, once per refusal: the box gets them back
    // when it is empty, and a newer draft is the person's own and is left alone.
    setSeenRefusal(refusal);
    const restore = refusal !== null && draft.trim() === '';
    setRefusalRestored(restore);
    if (restore) setDraft(refusal.text);
  }
  const userTurns = turns.filter((turn) => turn.role === 'user');
  // AWAITING IS DERIVED FROM THE THREAD, never from local state — which is what
  // makes a question survive a reload and still be answerable hours later. The
  // rail, the composer and the markers all read this one derivation.
  const question = pendingQuestion(turns);
  // THE CORRECTION, derived from the thread rather than held in local state — the
  // same posture as `question` above, and for the same reason: it must survive a
  // reload and still be usable, because a person notices a mis-read whenever they
  // next look at the answer, not only in the seconds after it lands.
  //
  // It is offered only on the LATEST assistant turn, and only when that turn came
  // out of a `user` turn this thread still has. A question the planner is waiting
  // on is NOT correctable: re-running it would answer a question nobody asked
  // instead of the one the planner needs answered.
  const latest = latestAssistantTurn(turns);
  const origin = latest ? originatingUserTurn(turns, latest) : null;
  const correctable =
    latest && origin && latest.question === null
      ? {
          turnId: origin.id,
          // What the flip would PRODUCE, from what the turn last ran as. A turn
          // with no recorded intent predates the model and reads as `ask`, which
          // is also the door every turn now goes through.
          direction: ((origin.intent ?? 'ask') === 'ask' ? 'plan_change' : 'ask') as
            | 'plan_change'
            | 'ask',
          pending: busy,
          corrected: origin.intentCorrected,
          onCorrect: onCorrectTurn,
        }
      : null;
  if (state.errorCode !== seenErrorCode) {
    setSeenErrorCode(state.errorCode);
    // A pick's turn (MOTIR-6435) is restored from its prop: the rail sent it
    // itself, so the failure of that send is the one this error answers.
    const restore = seededSend ?? autoSendTurn ?? null;
    if (state.errorCode && restore !== null && userTurns.length === 0) {
      if (draft === '') setDraft(restore);
      setSeededSend(null);
    }
  }
  // THE PICK'S ONE-TIME SEND (MOTIR-6435). Fired once the conversation is idle
  // with no user turn — the first moment a send has a thread to land in. The ref
  // absorbs a StrictMode double effect; `claimPickAutoSend` a remount or a second
  // open on this page; the overlay only hands a turn over when the server has no
  // session this gate already seeded. A refused send puts the turn back in the
  // composer through the failed-send restore above.
  //
  // The WIDGET'S debug turn (MOTIR-7050) rides the same seam with two changes:
  // it joins whatever the open thread holds (`autoSendIntoThread`), and it is
  // sent through `onAutoSend`, which carries its triage bug as the ask's anchor.
  // Its claim is the triage bug's key (`debugAutoSendKey`), so the three layers
  // — the host's one-time take of the seed, this page-level claim, and the ref —
  // hold for it exactly as they do for a pick.
  const autoSentRef = useRef(false);
  const autoSendReady =
    Boolean(autoSendTurn) &&
    !state.readOnly &&
    (autoSendIntoThread
      ? state.phase === 'idle' || state.phase === 'review'
      : state.phase === 'idle' && userTurns.length === 0);
  const sendAuto = onAutoSend ?? onSend;
  useEffect(() => {
    if (!autoSendReady || !autoSendTurn || autoSentRef.current) return;
    autoSentRef.current = true;
    if (autoSendKey !== null && !claimPickAutoSend(autoSendKey)) return;
    sendAuto(autoSendTurn);
  }, [autoSendReady, autoSendTurn, autoSendKey, sendAuto]);

  // No starters while the rail HOLDS A SEED (design MOTIR-6206 sheet 2): the seed
  // is the start. Cleared, the rail is an ordinary item re-plan again. A pick's
  // follow-up never shows them: its first turn is the start, sent for the person.
  const holdsSeed = (Boolean(initialDraft) && draft.trim() !== '') || followUp !== null;
  const showStarters = userTurns.length === 0 && !busy && state.phase !== 'loading' && !holdsSeed;
  // An ITEM re-plan opens by ASKING (MOTIR-910 / design panels 2 + 4 + 5): the
  // composer is pre-focused and prompts for what's wrong, and what the user types
  // is the FIRST CHAT TURN — the reason itself, which MOTIR-908 classifies. There
  // is no pre-workspace form and no separate reason field. Plan mode has no such
  // prompt (the item's own description is the scope), and neither does a
  // PROJECT-level re-plan, whose opener + starter chips already frame the ask
  // (MOTIR-1730's shipped copy, deliberately untouched). Once the conversation
  // has started the composer returns to its ordinary placeholder.
  const askingForReason =
    launch.mode === 'replan' && launch.itemKey !== null && userTurns.length === 0;
  // A PENDING QUESTION outranks every other placeholder — including the re-plan
  // ask, which is itself a one-time prompt: the planner is blocked, and the one
  // thing the composer should be asking for is the answer that unblocks it.
  // THE ENDED SESSION (AMENDMENT 23 §1): read from the server's row, so a reload
  // draws the same end. It accepts no turn — the composer slot says so instead.
  const ended = Boolean(state.session?.endedAt);
  // PLAN SOMETHING NEW (MOTIR-7650; design panels 1 + 5): offered on the viewer's
  // OWN open `conversation` session only — never on a guide conversation (A3.5), a
  // read-only reopen, somebody else's session, or an ended one, which already
  // shows its own way forward. Disabled, with its reason, while a run streams.
  const restartable =
    Boolean(onRequestRestart) &&
    state.session !== null &&
    !ended &&
    !state.readOnly &&
    state.session.origin === 'conversation' &&
    state.session.startedByViewer !== false;
  const restartBusy = busy || Boolean(state.restarting);
  // The confirm is ANSWERABLE while it is the latest turn of an open session
  // (A3.2): a later turn leaves it as a record without its buttons.
  const lastTurn = turns.at(-1) ?? null;
  const confirmPending =
    !ended && !state.readOnly && lastTurn?.confirm === 'new_session' && Boolean(onAnswerRestart);
  // ANOTHER HOLDER'S CARD (AMENDMENT 23 §4) disables the composer while it is in
  // the tray; taking it out of the tray (other targets remaining) re-enables it.
  const held = state.targetHeld ?? null;
  const heldBlocks =
    held !== null &&
    (targets.length === 0 || targets.some((target) => target.identifier === held.target));
  const copied = copiedTurnCount(state.session);
  // THE CARRY (MOTIR-7932): the owner of an ended session whose plan still waits
  // gets the LIVE composer, with its gloss, in place of the ended slot (design
  // states 1–2). A carry refused because the plan was decided gives way to the slot.
  const carries =
    ended &&
    Boolean(onCarrySend) &&
    !state.carryDecided &&
    carriesWaitingPlan(state.session, state.readOnly);
  // The plan on screen moved here with the conversation (design state 4).
  const planMovedHere =
    Boolean(state.carriedFrom) && state.session?.copiedFromSessionId === state.carriedFrom;
  const stale = state.stalePlan ?? null;
  const staleTurnShown = stale !== null && turns.some((turn) => turn.id === stale.turnId);
  const staleNotice =
    stale !== null ? (
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-(--el-accent) text-xs font-semibold text-(--el-accent-text)"
        >
          <BrandMark variant="mark" tone="inverted" size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <StalePlanNotice
            finishedCards={stale.finishedCards}
            onPlanAgain={() => onPlanAgain?.()}
            pending={stale.pressing}
            accepted={stale.outcome === 'accepted' || stale.outcome === 'superseded'}
            refused={stale.outcome === 'refused'}
            restored={stale.outcome === 'restored'}
            writing={state.phase === 'streaming'}
          />
        </div>
      </div>
    ) : null;
  const composerPlaceholder = heldBlocks
    ? ts('refused.placeholder', { key: held.target })
    : question || isOpenUnclear(runPause)
      ? tc('composerPlaceholderAnswer')
      : askingForReason
        ? tc('composerPlaceholderReplan')
        : targets.length > 0
          ? tc('composerPlaceholderTargets')
          : tc('composerPlaceholder');

  // What the THREAD is anchored at, per the server (`PlanChangeSessionDto`) —
  // not the local tray. A sent turn is scoped by the session it landed in, so
  // the chips on the turn come from the record, not from what is picked now.
  const turnTargetKeys = state.session?.targetKeys ?? [];
  // …and what a PROJECT-thread turn sent from here was anchored on (MOTIR-7050):
  // the report widget's triage bug, drawn in the same target row. There is no
  // item header and nothing in the composer's tray — the turn is about the bug,
  // the conversation is still the project's.
  const turnAnchors = state.turnAnchors ?? {};
  const debugLandings = state.debugLandings ?? {};

  // THE RAIL FOLLOWS THE NEWEST ACT — while the reader has not scrolled away
  // (MOTIR-4069; `design/ai-chat/plan-change-run-live.mock.html` sheet 5).
  // Measured: nine act lines fit at the 1366×768 floor after the ordinary
  // opening, and a real run emits several times that, so the transcript WILL
  // scroll in its first thirty seconds. Following is what keeps the record
  // readable; NOT following once the reader has scrolled up is what makes the
  // pinned running bar (which repeats the live line) the right place to look
  // instead. `stickRef` is "was the reader at the bottom before this act
  // arrived", sampled on scroll rather than derived at append time, so an
  // append that grows the region never counts as the reader leaving.
  // What the act rail draws. The hook keeps `progress` equal to the newest act,
  // so the two agree; a caller that hands the rail a live line and no record
  // (a host that never accumulated one) still gets that line drawn rather than
  // an empty region — the rail never says LESS than it was told.
  const acts: PlanChangeProgress[] =
    state.acts.length > 0 ? state.acts : state.progress ? [state.progress] : [];
  // THE PLANNER'S NARRATION (MOTIR-8064): the stored read, grouped per session —
  // the window plus the earlier pages the reader paged in, one derivation.
  const narration = state.narration ?? null;
  const narrationEntries = narration
    ? mergeNarrationEntries(state.narrationKept?.earlier ?? [], narration.entries)
    : [];
  const narrationGroups = narration
    ? groupNarration(
        { sessions: narration.sessions, entries: narrationEntries },
        state.narrationKept?.live ?? [],
      )
    : [];
  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const actCount = acts.length + narrationEntries.length;
  useEffect(() => {
    const el = logRef.current;
    if (!el || !stickRef.current || actCount === 0) return;
    el.scrollTop = el.scrollHeight;
  }, [actCount]);

  return (
    <aside
      className="flex h-full min-h-0 flex-col border-l border-(--el-border) bg-(--el-surface)"
      aria-label={t('railLabel')}
    >
      <div className="flex items-center gap-2 border-b border-(--el-border-soft) px-4 py-3">
        <span className="size-2 rounded-full bg-(--el-success)" aria-hidden="true" />
        <span className="font-mono text-xs font-semibold tracking-wide text-(--el-text-secondary) uppercase">
          {t('railLabel')}
        </span>
        <Pill tone="neutral" className="ml-auto" data-testid="planning-mode-chip">
          {followUp ? t('mode.followUp') : t(MODE_LABEL_KEY[launch.mode])}
        </Pill>
        {restartable ? (
          <RestartControl
            disabled={restartBusy}
            streaming={busy}
            onPress={() => onRequestRestart?.()}
          />
        ) : null}
      </div>

      <div
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight <= ACT_FOLLOW_SLACK_PX;
        }}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
        role="log"
      >
        {/* THE RETURN, acknowledged (MOTIR-4770 · design panel 5). One line,
            above the opener: the round trip closed, and the session picks up
            where it left off. */}
        {justReturnedFromOnboarding ? (
          <p
            data-testid="planning-return-ack"
            className="flex items-start gap-2 rounded-(--radius-control) bg-(--el-tint-mint) px-(--spacing-control-x) py-(--spacing-control-y) text-xs leading-relaxed text-(--el-text-strong)"
          >
            <Check className="mt-px size-3.5 flex-none" aria-hidden />
            <span>{t('returnAck')}</span>
          </p>
        ) : null}

        {/* WHICH conversation this is (MOTIR-6024; design §19.8). A NAMED one
            reopened from the Plans page says where it came from; a FRESH start
            with an earlier conversation for this scope points to it — until this
            conversation has a turn, when the rail is about it instead. */}
        {state.reopened && launch.via === 'planning' ? (
          // REOPENED FROM PLANNING (MOTIR-7831; design `design/workbench/design-notes.md`
          // § 36.6): the Planning tab's row carries `planVia=planning`, so this line names
          // that entrance. Only the plan's own requester reaches that tab, so there is one
          // form and no *started by {name}* twin; the glyph is the tab's `PenLine`, in the
          // slot the `approvals` line gives `Inbox`.
          <p
            data-testid="planning-reopened-from-planning"
            className="flex items-start gap-2 rounded-(--radius-control) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) py-(--spacing-control-y) text-xs leading-relaxed text-(--el-text-strong)"
          >
            <PenLine className="mt-px size-3.5 flex-none" aria-hidden />
            <span>
              {tWorkbenchPlanning('reopened', {
                when: format.relativeTime(new Date(state.reopened.lastActivityAt)),
              })}
            </span>
          </p>
        ) : state.reopened && launch.via === 'approvals' ? (
          // REOPENED FROM TO APPROVE (MOTIR-6037; design Part XXII §22.2, §22.5): the
          // row's address carries `planVia=approvals`, so this line names the entrance
          // the reader actually used — MOTIR-6019's shape, its own glyph.
          <p
            data-testid="planning-reopened-from-approvals"
            className="flex items-start gap-2 rounded-(--radius-control) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) py-(--spacing-control-y) text-xs leading-relaxed text-(--el-text-strong)"
          >
            <Inbox className="mt-px size-3.5 flex-none" aria-hidden />
            <span>
              {state.reopened.mine
                ? tp('surface.reopenedYours', {
                    when: format.relativeTime(new Date(state.reopened.lastActivityAt)),
                  })
                : tp('surface.reopened', {
                    name: state.reopened.startedBy?.name ?? ts('someone'),
                    when: format.relativeTime(new Date(state.reopened.lastActivityAt)),
                  })}
            </span>
          </p>
        ) : state.reopened ? (
          <p
            data-testid="planning-reopened-session"
            className="flex items-start gap-2 rounded-(--radius-control) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) py-(--spacing-control-y) text-xs leading-relaxed text-(--el-text-strong)"
          >
            <History className="mt-px size-3.5 flex-none" aria-hidden />
            <span>
              {state.reopened.mine
                ? ts('reopenedYours', {
                    when: format.relativeTime(new Date(state.reopened.lastActivityAt)),
                  })
                : ts('reopened', {
                    name: state.reopened.startedBy?.name ?? ts('someone'),
                    when: format.relativeTime(new Date(state.reopened.lastActivityAt)),
                  })}
            </span>
          </p>
        ) : !state.session && state.earlier ? (
          <EarlierNotice earlier={state.earlier} projectName={projectName} />
        ) : null}

        {/* TAKEN BACK (AMENDMENT 23 §3; MOTIR-7633 sheet 4): the open landed on the
            person's own OPEN session that holds this card. Gone once they send,
            because the session the send returns carries no take-back. */}
        {state.session?.takenBack ? (
          <TakenBackNotice label={state.session.targetKeys[0] ?? null} projectName={projectName} />
        ) : null}
        {/* …and when it took back a CARRY (MOTIR-7932; design state 5), the plan
            the person opened still waits where it was, one link away. */}
        {state.session?.takenBack && state.takenBackWaitingPlanId ? (
          <WaitingPlanStillWaits
            planId={state.takenBackWaitingPlanId}
            label={state.session.targetKeys[0] ?? null}
            projectName={projectName}
          />
        ) : null}

        {/* WHERE THE CONVERSATION WAS (MOTIR-6298; design §23.11 · sheet 10 B): an
            MCP agent planned this in its own harness. The reopened line's idiom,
            led by the `bot` glyph the plan page uses for `writtenByHarness`. */}
        {conversationElsewhere ? (
          <p
            data-testid="planning-mcp-no-turns"
            className="flex items-start gap-2 rounded-(--radius-control) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) py-(--spacing-control-y) text-xs leading-relaxed text-(--el-text-strong)"
          >
            <Bot className="mt-px size-3.5 flex-none" aria-hidden />
            <span>{ts('mcpNoTurns', { harness: conversationElsewhere.harness })}</span>
          </p>
        ) : null}

        {/* THE SWAP (MOTIR-7650; design panel 4): the overlay is on the NEW session
            after Plan something new, and this one line points back at the one that
            just closed. Its live region tells a screen reader what changed. */}
        {state.restartedFrom && state.session && !ended ? (
          <>
            <RestartedDivider
              fromSessionId={state.restartedFrom}
              anchorKey={state.session.targetKeys[0] ?? null}
            />
            <p className="sr-only" aria-live="polite">
              {tr('swapped')}
            </p>
          </>
        ) : null}

        {/* The opener — the canvas already shows the plan, so "empty" is never a
            blank screen; only the conversation is empty (design panel 6). */}
        <Bubble role="assistant">
          <span>
            {followUp
              ? launch.itemKey
                ? t('lead.followUp', { choice: followUp.choiceKey, item: launch.itemKey })
                : t('lead.followUpProject', { choice: followUp.choiceKey, project: projectName })
              : t(leadKey(launch), {
                  project: projectName,
                  item: launch.itemKey ?? '',
                  repo: launch.repoKey ?? '',
                })}
          </span>{' '}
          <span>{followUp ? tc('openerFollowUp', { label: followUp.label }) : tc('opener')}</span>
        </Bubble>
        {followUp ? <FollowUpCard pick={followUp} /> : null}

        {/* REFUSED IN PLACE (AMENDMENT 23 §4; MOTIR-7633 sheet 5): another
            person's session or plan holds the card. Nothing was sent. */}
        {held ? <TargetRefusal held={held} /> : null}

        {/* The starter hints sit WITH the opener (design panel 6's `emptyhint`),
            not docked above the composer — they are a continuation of the
            opening line, and they PREFILL the composer rather than sending. */}
        {showStarters ? (
          <div className="flex flex-wrap gap-1.5 pl-9">
            {STARTERS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setDraft(tc(`starters.${key}`))}
                className="inline-flex items-center gap-1 rounded-(--radius-control) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y) text-xs font-medium text-(--el-text-secondary) hover:bg-(--el-muted) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
              >
                <Sparkles className="size-3" aria-hidden="true" />
                {tc(`starters.${key}`)}
              </button>
            ))}
          </div>
        ) : null}

        {pauseAnchor < 0 ? pauseBlock : null}
        {turns.map((turn, i) => (
          <Fragment key={turn.id}>
            <Turn
              turn={turn}
              targetKeys={
                turnTargetKeys.length > 0 ? turnTargetKeys : anchorKeysOf(turn, turnAnchors)
              }
              workItemRefs={state.session?.workItemRefs ?? {}}
              debugOutcome={debugOutcomeFor(turn, turns, debugLandings, turnAnchors)}
              disposition={dispositionMarkerFor(turns, i)}
              isPending={question?.id === turn.id}
              // Keyed on the ASSISTANT turn that carries it — `correction.turnId`
              // names the USER turn the re-run replays, which is a different turn.
              correction={latest && turn.id === latest.id ? correctable : null}
              restartConfirm={
                confirmPending && turn.id === lastTurn?.id && onAnswerRestart
                  ? { pending: restartBusy, onAnswer: onAnswerRestart }
                  : null
              }
              afterConfirm={i > 0 && turns[i - 1]?.confirm === 'new_session'}
              midRun={midRunPropsFor(turn, i, turns, state, onSelectProposal)}
            />
            {/* THE COPIED DIVIDER (AMENDMENT 23 §6; MOTIR-7633 sheet 3), under the
              last turn carried over from the ended session. */}
            {copied > 0 && i === copied - 1 && state.session?.copiedFromSessionId ? (
              <>
                <CopiedDivider
                  fromSessionId={state.session.copiedFromSessionId}
                  anchorKey={state.session.targetKeys[0] ?? null}
                />
                {planMovedHere ? <PlanMovedLine /> : null}
              </>
            ) : null}
            {i === pauseAnchor ? pauseBlock : null}
            {/* THE STALE ANSWER (design state 10), under the turn it answers. */}
            {staleTurnShown && turn.id === stale?.turnId ? staleNotice : null}
          </Fragment>
        ))}
        {stale !== null && !staleTurnShown ? staleNotice : null}

        {/* The RUN, narrated: the shipped drafting row + a polite live region fed
            by the job's real progress frames. */}
        {/* The HAND-OFF (ADR Consequence 3). An ask turn that resolved to a plan
            change streams twice; naming the re-reading is what keeps the wait
            from reading as "that failed, it is trying again". The waiting row
            below never unmounts — only its text changes. */}
        {state.progress?.kind === 'redirected' ? (
          <p
            className="text-center text-xs text-(--el-text-secondary)"
            data-testid="plan-change-handoff"
          >
            {tc('handoff')}
          </p>
        ) : null}
        {/* THE DEBUG HAND-OFF (MOTIR-7050; `debug-turn.mock.html` panel 1) — the
            same marker slot, naming the other reading. It stays up for the whole
            diagnosis rather than only while the hand-off is the live act: the
            debug job narrates its own acts under it, and the marker is what says
            what they are FOR. */}
        {state.phase === 'streaming' && acts.some((act) => act.kind === 'redirectedDebug') ? (
          <p
            className="text-center text-xs text-(--el-text-secondary)"
            data-testid="plan-change-handoff-debug"
          >
            {tc('handoffDebug')}
          </p>
        ) : null}

        {/* THE ACT RAIL (MOTIR-4069) — an accumulating record, not a replacing
            line. Three columns: glyph · mono act label · the line
            (`design/ai-chat/plan-change-run-live.mock.html` sheet 3).

            ⚠️ THE SKIM AXIS IS THE MIDDLE COLUMN, NOT COLOUR. Every act line is
            the same ink; what a reader runs their eye down is a fixed-width
            column of short mono words, with the glyph as a second, non-textual
            cue. Deliberate: the rail already carries three coloured states
            (assistant, user, the accent review block) and a fourth hue would
            compete with them rather than help.

            It keeps the shipped `aria-live="polite"` region and its test id; since
            the per-call lines (MOTIR-7975) the region holds an announcer and the
            record is its sibling (`PlanActRecord`). */}
        {/* THE HAND-OFF BEFORE GENERATION (Story MOTIR-6012 · MOTIR-6037; design
            Part XXII §22.6, Panel 9). The moment a PLAN run starts writing, the planner
            says so in its own turn — a KEYED bubble, like `lockedNote`, so the words
            are the catalogue's and never the model's — and that the reader may leave:
            the run carries on server-side and the plan will be waiting in To approve.
            A revision of the plan in hand gets its own form. The link is a real
            anchor to the tab (§22.9). */}
        {writing ? (
          <Bubble role="assistant" testId="plan-handoff">
            {tp.rich(rewritingPlan ? 'handoff.rewriting' : 'handoff.writing', {
              link: (chunks) => (
                <Link
                  href={workbenchTabHref('approvals')}
                  className="font-semibold underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                >
                  {chunks}
                </Link>
              ),
            })}
          </Bubble>
        ) : null}

        <PlanActRecord
          acts={acts}
          streaming={state.phase === 'streaming'}
          sessionHeads={narrationGroups.some((group) => group.session !== null)}
          heads={narrationHeadLines(narrationGroups, tc)}
        />
        {/* THE PLANNER'S OWN WORDS (Story MOTIR-8060 · MOTIR-8064;
            `plan-change-run-live--narration.mock.html`): one group per session
            under its stored step words, from the review read — so it is all
            here again on reopen, after the plan ends, and for a Visitor. It is
            not a turn: no thread reader sees it. */}
        <PlanNarration
          groups={narrationGroups}
          total={narration ? narration.earlierCount + narration.entries.length : 0}
          earlierCount={narrationEarlierCount(narrationEntries)}
          loadingEarlier={state.narrationKept?.loadingEarlier ?? false}
          {...(onShowEarlierNarration ? { onShowEarlier: onShowEarlierNarration } : {})}
        />

        {/* A MID-RUN QUESTION whose answer is still being written (MOTIR-7998;
            design state 1), below the act rail it does not touch. */}
        {state.midRunAsk ? (
          <PendingAsk
            text={state.midRunAsk.text}
            inThread={
              lastTurn?.role === 'user' &&
              Boolean(lastTurn.runJobId) &&
              lastTurn.body === state.midRunAsk.text
            }
          />
        ) : null}

        {/* STOPPED — a MARKER, not an alert (MOTIR-4068).
            It uses the shipped `system`-marker line verbatim: centred,
            `text-xs`, `--el-text-secondary`. Deliberately NOT the error block
            below it — no `role="alert"`, no `--el-tint-rose`, no failure glyph,
            nothing dimmed or struck through. A stopped run is a DECISION, and
            `design/ai-chat/plan-change-run-live.mock.html` sheet 4 lists the
            affordances it may not borrow, so a reviewer checks a claim rather
            than an impression.

            The review block BELOW stays live: what was proposed before the stop
            is worth exactly what it was worth a second earlier, and Approve /
            Discard are both reachable from here. That is the whole card.
            (Sheet 2's state D, top to bottom: the act record, this marker, the
            surviving proposal — which is why it sits ABOVE the review block
            since MOTIR-4069 moved the record up.) */}
        {state.stopped ? (
          <p
            className="text-center text-xs text-(--el-text-secondary)"
            data-testid="plan-change-stopped"
          >
            {tc('stopped')}
          </p>
        ) : null}

        {/* The proposal, said in words — the rail mirrors the canvas bar's counts
            so the numbers are readable without hunting the board.
            ⚠️ PENDING ONLY, and `!state.decided` is what says so (MOTIR-3206) —
            the SAME predicate `PlanningWorkspaceHost` gives the canvas bar it
            mirrors, so the two gates cannot disagree about whether one is owed.
            Before MOTIR-3162 a null `review` carried that meaning; once the
            review survived its decision, this block kept a LIVE Approve /
            Discard pair (and "nothing is saved yet") on a plan that was already
            approved or declined. */}
        {state.review && !state.decided && !index.isEmpty ? (
          <>
            <Bubble role="assistant">
              {tc('summary', {
                added: index.counts.added,
                changed: index.counts.changed,
                removed: index.counts.removed,
              })}
            </Bubble>
            <Bubble role="assistant">{tc('lockedNote')}</Bubble>
            {gated ? (
              <GatedReviewBlock
                view={gateView}
                busy={busy}
                declining={declining}
                staleRefused={staleRefused}
                approveProgress={approveProgress}
                decidedFirst={state.errorCode === 'decided'}
                onApprove={onApprove}
                onRequestDecline={onRequestDecline}
                onCancelDecline={onCancelDecline}
                onConfirmDecline={onConfirmDecline}
                deciding={state.phase === 'deciding'}
                decidedFirstLines={{ title: tRefusal('unattributed'), next: tRefusal('next') }}
              />
            ) : (
              <div
                data-testid="plan-change-review"
                className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-accent) px-3 py-2"
              >
                <span className="text-xs font-semibold text-(--el-text-strong)">
                  {tc('nothingSavedYet')}
                </span>
                {/* The gate itself lives on the canvas bar; this MIRRORS it so the
                  decision is reachable from wherever the reader is looking. While the
                  approve runs the verbs step aside for its progress (MOTIR-5249). */}
                {approveProgress ? <PlanApproveProgress {...approveProgress} place="rail" /> : null}
                {approveProgress?.state === 'running' ? null : (
                  <div className="flex items-center justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={onDiscard} disabled={busy}>
                      {tc('discard')}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      leftIcon={<Check className="size-4" aria-hidden="true" />}
                      onClick={onApprove}
                      disabled={busy}
                    >
                      {tc('approve')}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </>
        ) : null}

        {/* After an approve the thread CONTINUES — a plan change is rarely one
            change (design panel 6, "after approve").
            ⚠️ KEYED ON THE DECISION, not on the ABSENCE of a review (MOTIR-3206).
            This read `state.approved && !state.review`, which was the same fact
            while approve NULLED the review; MOTIR-3162 made the review survive
            its decision, so the second conjunct became permanently false and
            this line stopped rendering at all — the user approved and the rail
            said nothing about what landed. `decided` is what the surviving
            review no longer says, and it is also what a NEW run resets
            (`usePlanChangeConversation`'s start reducer clears `decided`, not
            `approved`), so this still clears when the next proposal opens. */}
        {state.decided === 'accepted' && state.approved ? (
          <Bubble role="assistant">
            {tc('approved', {
              created: state.approved.created.length,
              updated: state.approved.updated.length,
              removed: state.approved.removed.length,
            })}
          </Bubble>
        ) : null}

        {/* DECLINED HERE (MOTIR-6037; Panel 6) — a MARKER in the shipped `system` line,
            not a planner turn and not an alert: a person ended the question. */}
        {declinedHere ? (
          <p
            className="text-center text-xs text-(--el-text-secondary)"
            data-testid="plan-declined-marker"
          >
            {tp('surface.declined')}
          </p>
        ) : null}

        {/* QUEUED — what the user typed while the run was working (MOTIR-4274).
            Rendered from `state.queued` rather than from the thread because a
            mid-run turn lives in the MAILBOX, a different table from
            `plan_change_turn`; it is not in `session.turns` and cannot be.

            ⚠️ THE BUBBLE IS NOT RE-TINTED, deliberately. The obvious move is a
            warm tint on the pending turn and it is wrong here:
            `--el-warning-surface` already carries the planner's ASKING state on
            this exact surface, and two warm pending-ish states one scroll apart
            are less legible than one (`design/ai-chat/plan-change-run-live.mock.html`
            sheet 2). The pending fact is carried by a WORD, a GLYPH and a MARKER
            instead — and the queued/read distinction by all three changing. */}
        {state.queued
          .filter((turn) => !threadOwned.has(turn.id))
          .map((turn) => (
            <div key={turn.id} className="flex flex-col gap-1">
              <Bubble role="user" label={<QueuedLabel read={turn.read} />}>
                {turn.text}
              </Bubble>
              <p
                className="text-center text-xs text-(--el-text-secondary)"
                data-testid={turn.read ? 'plan-change-queued-read' : 'plan-change-queued'}
              >
                {turn.read ? tc('queuedReadMarker') : tc('queuedMarker')}
              </p>
            </div>
          ))}

        {/* An ASKED plan's STALE and DECIDED-FIRST refusals are said in the review block
            itself, in the design's words (MOTIR-6037; Panels 5–6), not as a failure. */}
        {/* THE ATTEMPT FAILED AND CLOSED THE SESSION (AMENDMENT 23 §2; MOTIR-7633
            sheet 1): the failure line, with NO Try again — a retry would append to
            a session that accepts no turn — then the end marker. */}
        {ended && state.session?.endReason === 'failed' ? (
          <p
            role="alert"
            data-testid="planning-failed-closed"
            className="rounded-(--radius-card) bg-(--el-tint-rose) px-3 py-2 text-sm text-(--el-text-strong)"
          >
            {tc('error.failedClosed')}
          </p>
        ) : null}
        {ended && state.session ? <SessionEndMarker session={state.session} /> : null}
        {/* The plan this ended session made was CARRIED to a newer one (design
            state 4, right) — read from the server's row, so a reload says it too. */}
        {ended && state.session?.planMovedToSessionId ? (
          <PlanMovedAwayLine
            toSessionId={state.session.planMovedToSessionId}
            anchorKey={state.session.targetKeys[0] ?? null}
          />
        ) : null}
        {/* THE CARRY IN FLIGHT (design state 3): the turn under the end marker, and
            the one act it is waiting on. */}
        {state.carrying ? (
          <>
            <Bubble role="user">{state.carrying.text}</Bubble>
            <ol
              aria-live="polite"
              data-testid="planning-carry-moving"
              className="flex flex-col gap-1.5 rounded-(--radius-card) bg-(--el-surface-soft) px-3 py-2"
            >
              <li className="flex items-start gap-2 text-xs text-(--el-text)">
                <Spinner size="sm" aria-hidden="true" />
                <span className="min-w-0 flex-1">{ts('carry.moving')}</span>
              </li>
            </ol>
          </>
        ) : null}
        {/* DECIDED WHILE TYPING (design state 6): refused in place, the words kept. */}
        {ended && state.carryDecided ? <CarryDecidedNotice text={state.carryDecided.text} /> : null}

        {state.errorCode &&
        !ended &&
        state.errorCode !== 'timedOut' &&
        !(gated && (state.errorCode === 'stale' || state.errorCode === 'decided')) ? (
          <div className="flex flex-col items-start gap-2">
            <p
              role="alert"
              className="rounded-(--radius-card) bg-(--el-tint-rose) px-3 py-2 text-sm text-(--el-text-strong)"
            >
              {tc(errorKey(state.errorCode))}
            </p>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<RefreshCw className="size-4" aria-hidden="true" />}
              onClick={onRetry}
              disabled={busy || userTurns.length === 0}
            >
              {tc('retry')}
            </Button>
          </div>
        ) : null}

        {/* Out of credits is NOT an error: nothing failed, the capability is
            cloud-gated. The shipped paywall carries the owner/member face. */}
        {state.outOfCredits ? <AiPaywall triggeredOutOfCredits /> : null}
      </div>

      {/* The composer carries the `@` TARGET picker + the tray (MOTIR-1491) — the
          message field and the target set are one control, because the targets
          scope the turn the field sends. */}
      {/* THE RUN HAS ENDED, so a change was not forwarded (MOTIR-7998; design
          state 11): the reason sits in the footer, directly above the composer. */}
      {refusal ? <ForwardRefusal refusal={refusal} restored={refusalRestored} /> : null}
      {carries ? (
        <div className="border-t border-(--el-border)" data-testid="planning-carry">
          <WaitingPlanComposerGloss />
          <PlanChangeComposer
            bare
            draft={draft}
            onDraftChange={setDraft}
            targets={targets}
            onAddTarget={onAddTarget}
            onRemoveTarget={onRemoveTarget}
            onSubmit={(text) => {
              setLastSent(text);
              onCarrySend?.(text);
            }}
            placeholder={composerPlaceholder}
            disabled={Boolean(state.carrying) || state.phase === 'deciding' || heldBlocks}
          />
        </div>
      ) : ended && state.session ? (
        <EndedComposerSlot
          {...(state.carryDecided ? { carryDecided: true } : {})}
          session={state.session}
          readOnly={state.readOnly}
          label={state.session.targetKeys[0] ?? null}
          projectName={projectName}
          {...(onStartNewSession ? { onStartNew: onStartNewSession } : {})}
          pending={busy}
        />
      ) : state.readOnly ? (
        // A member without `ai:plan` reads a reopened conversation and cannot
        // continue it — the composer is REPLACED by the reason (design §19.8,
        // panel 6), in the composer's own slot.
        <div className="border-t border-(--el-border) px-3 py-3" data-testid="planning-read-only">
          <p className="flex items-start gap-2 text-xs leading-relaxed text-(--el-text-secondary)">
            <Lock className="mt-px size-3.5 flex-none" aria-hidden />
            <span>{ts('readOnly')}</span>
          </p>
        </div>
      ) : (
        <PlanChangeComposer
          draft={draft}
          onDraftChange={setDraft}
          targets={targets}
          onAddTarget={onAddTarget}
          onRemoveTarget={onRemoveTarget}
          onSubmit={(text) => {
            if (initialDraft && userTurns.length === 0) setSeededSend(text);
            setLastSent(text);
            onSend(text);
          }}
          placeholder={composerPlaceholder}
          autoFocus={askingForReason || initialDraftCaret !== undefined}
          {...(initialDraftCaret !== undefined ? { caretAt: initialDraftCaret } : {})}
          // ⚠️ NO LONGER `busy` (MOTIR-4274). The composer stays LIVE while a run
          // works — that is the whole point of the mailbox, and it is a BEHAVIOUR
          // change rather than a styling one: `busy` put a real `disabled`
          // attribute on the `@` trigger, the input AND Send, so a user could not
          // type at all. What a mid-run send DOES is the hook's branch; what it
          // may do is here.
          //
          // `deciding` still locks it, and correctly: an approve or a discard is a
          // write against the plan, and a turn sent mid-decision would race it.
          // `loading` too — there is no thread to append to yet.
          disabled={
            state.phase === 'loading' ||
            state.phase === 'deciding' ||
            heldBlocks ||
            Boolean(state.stalePlan?.pressing)
          }
          // The pending question travels to the composer, not to a header pill:
          // measured at the rail's real 22rem the header row is already full, and
          // the bar belongs beside the control whose behaviour actually changed.
          awaitingQuestion={question?.question ?? null}
          // THE RUNNING BAR — present exactly while a run is in flight, and gone
          // the moment it is not. `onStop` is what makes it offerable: a caller
          // that does not supply one gets the shipped composer unchanged.
          running={
            state.phase === 'streaming' && onStop
              ? {
                  // The live act's OWN line, so the bar and the rail's newest row
                  // say the same thing — a note repeats the planner's words, a
                  // lookup names its family (MOTIR-4069).
                  // With per-call lines (MOTIR-7975) that is the open step's newest
                  // call, and with parallel author sessions `{line} · {title}`.
                  line: runningBarLine(acts, tc) ?? tc('progress.submitted'),
                  stopping: state.stopping,
                  onStop,
                  ...(paused && runPause ? { paused: { kind: runPause.kind } } : {}),
                }
              : null
          }
          onSeeQuestion={() => {
            // The pending question is the ONE element carrying this id (only one
            // question can be pending), so a lookup is exact — and focusing it,
            // not merely scrolling, is what makes "See it" work for a keyboard or
            // screen-reader user rather than only for a sighted mouse.
            const el = document.getElementById(PENDING_QUESTION_ID);
            el?.scrollIntoView({ block: 'center' });
            el?.focus();
          }}
        />
      )}
    </aside>
  );
}

/** The mid-run inputs for the turn at `index` (MOTIR-7998): its matching mailbox
 *  entry, the late revision, and the answer-side flags. */
function midRunPropsFor(
  turn: PlanChangeTurnDto,
  index: number,
  turns: readonly PlanChangeTurnDto[],
  state: PlanChangeConversationState,
  onSelectProposal: ((planItemId: string) => void) | undefined,
): MidRunTurnProps {
  const entryId = turn.forwarded?.mailboxEntryId;
  const origin = turn.role === 'assistant' ? originatingUserTurn(turns, turn) : null;
  return {
    queuedEntry: entryId ? (state.queued.find((q) => q.id === entryId) ?? null) : null,
    lateRevision: state.lateRevision ?? null,
    revisedLate:
      turn.revisedLate ??
      (entryId && state.lateRevision?.entryIds?.includes(entryId)
        ? { revisionJobId: state.lateRevision.revisionJobId }
        : null),
    answeredAside: Boolean(origin?.runJobId) && !origin?.forwarded && !origin?.revisedLate,
    offerStale: Boolean(turn.forwardOffer) && forwardOfferStale(turns, index),
    onSelectProposal,
  };
}

/** `FAILED` / `EMPTY` / `immutable` / `SESSION_UNAVAILABLE` / any typed code →
 *  the copy that explains it. Anything unrecognized falls back to the generic,
 *  recoverable failure line — never a raw code on screen. */
function errorKey(code: string): string {
  switch (code) {
    case 'EMPTY':
      return 'error.empty';
    case 'immutable':
      return 'error.immutable';
    // Someone (or another tab) already approved or declined this plan — there is
    // nothing left to confirm, and nothing was written twice.
    case 'decided':
      return 'error.decided';
    case 'discard':
      return 'error.discard';
    // The decide door's refusals of a plan (MOTIR-6038): a revision holds it, the
    // reader's version moved, or nobody has been asked about it yet.
    case 'held':
      return 'error.held';
    case 'stale':
      return 'error.stale';
    case 'notDecidable':
      return 'error.notDecidable';
    case 'SESSION_UNAVAILABLE':
      return 'error.session';
    // The ask job ran and produced nothing at all. NOT the honest "I could not
    // find that" — that is prose the handler returns, and it lands as an ordinary
    // answer bubble with no citations. This is the empty case, and core writes
    // nothing for it rather than inventing a body for the assistant.
    case 'ASK_SILENT':
      return 'error.askSilent';
    default:
      return 'error.body';
  }
}

/**
 * The `user` turn an ASSISTANT turn came out of — the turn a correction re-runs.
 *
 * They are joined by `jobId`, which both carry for the same run: the ask service
 * binds the user turn to its job at submit, and files the answer against the
 * same id at settle. Position in the thread is deliberately NOT used: a
 * correction appends a SECOND assistant turn beside the superseded one, so
 * "the turn just above" stops being the answer to anything the moment the
 * affordance is used once.
 */
function originatingUserTurn(
  turns: readonly PlanChangeTurnDto[],
  assistant: PlanChangeTurnDto,
): PlanChangeTurnDto | null {
  if (!assistant.jobId) return null;
  return turns.find((t) => t.role === 'user' && t.jobId === assistant.jobId) ?? null;
}

/** A stable empty key list, so a turn with no targets re-renders nothing. */
const EMPTY_KEYS: readonly string[] = [];

/**
 * The work item a turn was anchored on (MOTIR-7050), or null. The PERSISTED
 * anchor first (MOTIR-7064) — it is what a reloaded thread has — and the
 * hook's send-time seed only for a turn the server has not echoed one on.
 */
function anchorOf(
  turn: PlanChangeTurnDto,
  anchors: Readonly<Record<string, string>>,
): string | null {
  return turn.anchorKey ?? anchors[turn.id] ?? null;
}

/** A project-thread turn's target row: its anchor, or nothing. */
function anchorKeysOf(
  turn: PlanChangeTurnDto,
  anchors: Readonly<Record<string, string>>,
): readonly string[] {
  const key = anchorOf(turn, anchors);
  return key ? [key] : EMPTY_KEYS;
}

/**
 * What a DEBUG turn landed, for the assistant turn that carries its diagnosis
 * (MOTIR-7050) — or null for every other turn.
 *
 * The landing is read off the reply turn itself (`debugLanding`, persisted with
 * it — MOTIR-7064), so a reloaded thread draws the same line; the settle's
 * in-memory landing, joined by the `debug_bug` job id the reply carries, is only
 * the fallback. The anchor is read off the USER turn the reply came out of
 * (joined by the same job id, `originatingUserTurn`), because the
 * enriched-anchor copy names that triage bug as the card left as it is.
 */
function debugOutcomeFor(
  turn: PlanChangeTurnDto,
  turns: readonly PlanChangeTurnDto[],
  landings: Readonly<Record<string, DebugLandingDto>>,
  anchors: Readonly<Record<string, string>>,
): DebugOutcome | null {
  if (turn.role !== 'assistant' || !turn.jobId) return null;
  const landing = turn.debugLanding ?? landings[turn.jobId];
  if (!landing) return null;
  const origin = originatingUserTurn(turns, turn);
  return { landing, anchorKey: origin ? anchorOf(origin, anchors) : null };
}

/** The LAST assistant turn on the thread, or null. Only that one carries the
 *  correction marker — a superseded answer keeps its bubble but loses its
 *  affordance, so a thread never offers two ways to re-run one user turn. */
function latestAssistantTurn(turns: readonly PlanChangeTurnDto[]): PlanChangeTurnDto | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn && turn.role === 'assistant') return turn;
  }
  return null;
}

interface TurnProps {
  turn: PlanChangeTurnDto;
  /** The thread's anchor set — rendered on a user turn so the reader SEES what
   *  the planner was pointed at (design panel 3). Empty on the project thread. */
  targetKeys: readonly string[];
  /** Resolved `motir:` reference summaries for the whole thread — an assistant
   *  turn's findings report renders its references as the shipped chip. */
  workItemRefs: WorkItemRefMap;
  /** The DEBUG turn's landing, on the assistant turn carrying its diagnosis
   *  (MOTIR-7050) — its OUTCOME LINE. Null on every other turn. */
  debugOutcome: DebugOutcome | null;
  /** How the question preceding this turn was disposed of, when this turn is what
   *  disposed of it (design states C and E). Null on every other turn. */
  disposition: QuestionDisposition | null;
  /** This turn IS the question the thread is currently waiting on. */
  isPending: boolean;
  /**
   * The CORRECTION this assistant turn offers — null on every other turn, and
   * null on an assistant turn that is not the latest one.
   *
   * `direction` is what the flip would produce, and it decides the label alone:
   * the server derives the real direction from the turn's own recorded intent,
   * so a stale label can mislabel a button but can never run the wrong thing.
   */
  correction: {
    turnId: string;
    direction: 'plan_change' | 'ask';
    /** The re-run is in flight — the marker stays, disabled, rather than
     *  vanishing and taking the affordance with it mid-wait. */
    pending: boolean;
    /** This turn IS the result of a correction — the passive line above it says
     *  why a second assistant turn exists. */
    corrected: boolean;
    onCorrect: (turnId: string) => void;
  } | null;
  /** The Plan something new confirm's two answers (MOTIR-7650), on the confirm
   *  turn while it is still answerable. Null on every other turn. */
  restartConfirm: {
    pending: boolean;
    onAnswer: (answer: 'confirm' | 'keep') => void;
  } | null;
  /** This system turn sits right after a confirm — it is the Keep planning
   *  marker (A3.3), which the decision identifies by position. */
  afterConfirm: boolean;
  /** The MID-RUN conversation's per-turn inputs (MOTIR-7998). */
  midRun: MidRunTurnProps;
}

/** What a turn needs to draw the mid-run conversation: the mailbox entry its
 *  forward went down as, the late revision, and the answer-side flags. */
interface MidRunTurnProps {
  /** The `state.queued` entry matching this turn's `forwarded.mailboxEntryId`. */
  queuedEntry: QueuedTurn | null;
  lateRevision: { planId: string } | null;
  /** The turn's late revision: its own persisted mark, or — for a change the
   *  end-of-run claim revised — the revision that carried its mailbox entry. */
  revisedLate: PlanChangeTurnDto['revisedLate'];
  /** This answer was given on the side — it owes the passive line. */
  answeredAside: boolean;
  /** This answer's forward offer has gone stale. */
  offerStale: boolean;
  onSelectProposal: ((planItemId: string) => void) | undefined;
}

/** The one pending question's DOM id — the composer's "See it" jump target.
 *  A constant is exact because at most one question is ever pending. */
const PENDING_QUESTION_ID = 'plan-change-pending-question';

/**
 * One persisted turn, by ROLE — a TOTAL `Record` over the role union, not a chain
 * of branches with a fall-through (MOTIR-2226).
 *
 * The totality is the point, and it is a bug fix rather than a style preference.
 * Before this card the component branched `system` → marker and fell through to a
 * numbered USER bubble for everything else, so the very first `assistant` turn to
 * exist would have rendered as if the person had typed it — the wrong speaker, in
 * a thread whose entire purpose is who said what. A `Record` keyed on the union
 * makes the next role a COMPILE error instead of a silent mis-attribution, so
 * this cannot ship twice.
 */
const TURN_RENDERERS: Record<PlanChangeTurnRoleDto, (props: TurnProps) => React.ReactNode> = {
  // The submission MARKER — its body is the accumulated intent that went out,
  // which is provenance, not conversation, so it renders as a quiet divider.
  system: function SystemTurn({ afterConfirm }: TurnProps) {
    const tc = useTranslations('planningWorkspace.conversation');
    const tr = useTranslations('planningWorkspace.restart');
    return (
      <p
        className="text-center text-xs text-(--el-text-secondary)"
        data-testid={afterConfirm ? 'planning-restart-kept' : 'plan-change-marker'}
      >
        {afterConfirm ? tr('kept') : tc('submitted')}
      </p>
    );
  },

  // The PLANNER speaking. A findings report is an ORDINARY assistant bubble —
  // same fill, ink, avatar and width as the opener and the proposal summary,
  // because the design's whole finding is that no new treatment is needed to read
  // as the planner. A QUESTION is that same bubble with two token values swapped
  // and the existing label slot filled: the distinction never rests on wording,
  // and never on colour alone (a word, a glyph, and the composer's own change).
  assistant: function AssistantTurn({
    turn,
    workItemRefs,
    isPending,
    correction,
    debugOutcome,
    restartConfirm,
    midRun,
  }: TurnProps) {
    const tc = useTranslations('planningWorkspace.conversation');
    const tr = useTranslations('planningWorkspace.restart');
    const asking = turn.question !== null;
    // THE PLAN SOMETHING NEW CONFIRM (MOTIR-7650; A3.2): a planner bubble with the
    // fixed question, read from the CATALOGUE so it speaks the viewer's locale —
    // never the stored body. Not a question: no asking tint, no label.
    if (turn.confirm === 'new_session') {
      return (
        <div data-testid="planning-restart-confirm-turn">
          <Bubble role="assistant">
            <span>{tr('confirm.body')}</span>
            {restartConfirm ? (
              <span role="group" aria-label={tr('control')} className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => restartConfirm.onAnswer('confirm')}
                  disabled={restartConfirm.pending}
                  data-testid="planning-restart-confirm"
                >
                  {tr('confirm.yes')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => restartConfirm.onAnswer('keep')}
                  disabled={restartConfirm.pending}
                  data-testid="planning-restart-keep"
                >
                  {tr('confirm.keep')}
                </Button>
              </span>
            ) : null}
          </Bubble>
        </div>
      );
    }
    return (
      <>
        {/* Why a SECOND assistant turn exists, in the passive marker voice. It
            sits above the new turn rather than replacing the superseded one:
            a correction is a second answer, not an erasure. */}
        {correction?.corrected ? (
          <p
            className="text-center text-xs text-(--el-text-secondary)"
            data-testid="plan-change-corrected"
          >
            {tc(correction.direction === 'ask' ? 'correctedToPlan' : 'correctedToAsk')}
          </p>
        ) : null}
        <Bubble
          role="assistant"
          tone={asking ? 'asking' : 'default'}
          testId={asking ? 'plan-change-question' : 'plan-change-report'}
          // Only the PENDING question is the "See it" target, and it is
          // programmatically focusable so the jump lands for a keyboard user too.
          anchorId={isPending ? PENDING_QUESTION_ID : undefined}
          label={
            asking ? (
              <>
                <MessageCircleQuestionMark className="size-3" aria-hidden="true" />
                {tc('asking')}
              </>
            ) : undefined
          }
        >
          {/* The shipped render path, so a report's `[KEY](motir:<id>)` references
              become the same live `WorkItemRefChip` they are everywhere else —
              never a second inline treatment invented for this surface. THIS IS
              ALSO HOW AN ANSWER CITES: a citation is that chip, in the sentence
              that rests on it, and there is no trailing source list. */}
          <MarkdownView
            value={turn.body}
            workItemRefs={workItemRefs}
            renderProposalRef={(planItemId, label) => (
              <ProposalRef
                planItemId={planItemId}
                label={label}
                {...(midRun.onSelectProposal ? { onSelect: midRun.onSelectProposal } : {})}
              />
            )}
          />
          {/* The size of the evidence base — a NUMBER, not a second chip list.
              An answer may rest on items its prose never names, and `citations`
              is the grounding contract; saying how many keeps that checkable
              without re-rendering what the body already showed. */}
          {/* A DEBUG result's foot is its OUTCOME LINE instead (MOTIR-7050): the
              one card the turn wrote, built from the settle's result rather than
              the model's words — so it names the card even when the prose does
              not. Its citation IS that card, so a count beside it says nothing. */}
          {debugOutcome ? (
            <DebugOutcomeLine outcome={debugOutcome} workItemRefs={workItemRefs} />
          ) : turn.citations.length > 0 ? (
            <p
              className="mt-1.5 border-t border-(--el-border-soft) pt-1.5 text-xs text-(--el-text-secondary)"
              data-testid="plan-change-citation-count"
            >
              {tc('answeredFrom', { count: turn.citations.length })}
            </p>
          ) : null}
          {turn.forwardOffer ? <ForwardOffer turn={turn} stale={midRun.offerStale} /> : null}
        </Bubble>
        {midRun.answeredAside ? <AnsweredAside /> : null}
        {/* The CORRECTION (ADR §3, as amended by AMENDMENT 3) — an interactive
            line in the shipped marker vocabulary, distinguished from the passive
            markers by ink AND underline rather than by colour alone.

            ⚠️ ONLY TOWARDS AN ANSWER. Under an answer there is NO "Propose
            changes instead": whether a turn becomes a planning run is the
            planner's call alone, never a button (MOTIR-7924). A person who wants
            changes says so in the composer, and the planner decides.

            As wide as its label, not as the transcript: the log is a flex
            column, and a stretched button caught clicks anywhere on its row. */}
        {correction && correction.direction === 'ask' ? (
          <button
            type="button"
            onClick={() => correction.onCorrect(correction.turnId)}
            disabled={correction.pending}
            data-testid="plan-change-correct"
            data-direction={correction.direction}
            className="w-fit self-center rounded-(--radius-control) text-center text-xs font-semibold text-(--el-link) underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-not-allowed disabled:text-(--el-text-secondary) disabled:no-underline"
          >
            {correction.pending ? tc('correcting') : tc('correctToAsk')}
          </button>
        ) : null}
      </>
    );
  },

  // What the person typed — just the message, with NO label (MOTIR-7497): the
  // turn number, `refine` and `answer` were internal bookkeeping shown to the
  // person. An answer to a question is still marked, by the disposition line
  // below, never by a label on the bubble.
  user: function UserTurn({ turn, targetKeys, disposition, midRun }: TurnProps) {
    const tc = useTranslations('planningWorkspace.conversation');
    const tt = useTranslations('planningWorkspace.targets');
    return (
      <>
        <Bubble
          role="user"
          testId="conversation-user-turn"
          {...(turn.forwarded && midRun.queuedEntry
            ? { label: <QueuedLabel read={midRun.queuedEntry.read} /> }
            : {})}
        >
          {targetKeys.length > 0 ? (
            <span className="mb-1 flex flex-wrap items-center gap-1">
              <span className="text-[10px] font-semibold tracking-wide uppercase opacity-80">
                {tt('turnLabel', { count: targetKeys.length })}
              </span>
              {targetKeys.map((key) => (
                <PlanningTargetKeyChip key={key} identifier={key} tone="on-accent" />
              ))}
            </span>
          ) : null}
          {turn.body}
        </Bubble>
        {/* The question's disposition, in the shipped marker vocabulary. A
            superseded question is MARKED, never dimmed, struck through or
            removed: the transcript does not rewrite itself, and the reader has to
            be able to see later WHY a plan rests on an assumption they never
            confirmed. */}
        {disposition ? (
          <p
            className="text-center text-xs text-(--el-text-secondary)"
            data-testid={`plan-change-${disposition}`}
          >
            {tc(disposition === 'answered' ? 'answeredMarker' : 'supersededMarker')}
          </p>
        ) : null}
        {/* A question typed mid-run is UNLABELLED (state 2); a forwarded change
            carries its queued / read marks, a late one its revision note. */}
        {turn.forwarded || midRun.revisedLate ? (
          <ForwardedMarks
            entry={midRun.queuedEntry}
            acknowledge
            revisedLate={midRun.revisedLate}
            lateRevision={midRun.lateRevision}
          />
        ) : null}
      </>
    );
  },
};

/** THE PLAN SOMETHING NEW CONTROL (MOTIR-7650; design panel 1) — the rail head's
 *  last item. While a run streams it stays in place, disabled, and names why in
 *  its tooltip (panel 5). */
function RestartControl({
  disabled,
  streaming,
  onPress,
}: {
  disabled: boolean;
  streaming: boolean;
  onPress: () => void;
}) {
  const tr = useTranslations('planningWorkspace.restart');
  const button = (
    <Button
      variant="secondary"
      size="sm"
      leftIcon={<SquarePen className="size-3.5" aria-hidden="true" />}
      onClick={onPress}
      disabled={disabled}
      data-testid="planning-restart-control"
    >
      {tr('control')}
    </Button>
  );
  if (!streaming) return button;
  // A disabled button gets no pointer events, so the tooltip hangs off a wrapper.
  return (
    <Tooltip content={tr('disabledStreaming')} delayMs={300}>
      <span className="inline-flex" tabIndex={0} aria-label={tr('disabledStreaming')}>
        {button}
      </span>
    </Tooltip>
  );
}

function Turn(props: TurnProps) {
  const Render = TURN_RENDERERS[props.turn.role];
  return <Render {...props} />;
}

/** The ASKING variant swaps exactly two token values on the shipped bubble — the
 *  design's own finding, measured against the real emitted markup: the
 *  assistant/user contrast already reads, so a question needs a tint and a label,
 *  not a new component. Charcoal `--el-warning-text` on `--el-warning-surface` is
 *  the tint-background recipe (finding #35), ~10:1 in both themes. */
const BUBBLE_FILL: Record<'default' | 'asking', string> = {
  default: 'bg-(--el-chat-bubble-ai) text-(--el-text)',
  asking: 'bg-(--el-warning-surface) text-(--el-warning-text)',
};

/**
 * How close to the bottom (px) still counts as "reading along" for the
 * follow-the-newest-act scroll. A line and a half: a reader who nudged the
 * wheel is still following; one who scrolled up to re-read is not.
 */
const ACT_FOLLOW_SLACK_PX = 48;

/** A debug turn's landing, as its outcome line reads it. */
interface DebugOutcome {
  landing: DebugLandingDto;
  /** The triage bug the turn was anchored on (the widget path), or null (the orb). */
  anchorKey: string | null;
}

/**
 * THE OUTCOME LINE (MOTIR-7050; `design/ai-chat/debug-turn.mock.html` panels 2–4,
 * `design-notes.md` § "⭐ Debug with Motir AI" §4) — the one new element a debug
 * turn adds to the rail. It sits in the `answeredFrom` foot slot (hairline
 * `--el-border-soft`, 12px `--el-text`) with a leading glyph in
 * `--el-text-secondary`: `FilePenLine` for a write, `SearchCheck` for none.
 *
 * One sentence per A1.4 row, chosen from the landing — never from the prose:
 *
 *  · `diagnose` onto the anchored bug → `wroteAnchor` ("It stays in Triage");
 *  · `diagnose` with no anchor (the orb) → `filed`, the bug it filed;
 *  · `enrich_existing` → `enrichedAnchor` / `enriched`, the card that already
 *    covers it — and, on the widget path, the anchor named as left as it is, in
 *    plain text, because the turn did not touch it;
 *  · `ungrounded` → nothing was written, and no card is named.
 *
 * The card is the shipped `WorkItemRefChip` (its click opens the shipped peek).
 * Its summary is the thread's own resolved reference when there is one — the
 * reply cites the card, so the session read resolved it — and otherwise the
 * landing's own key and title, so a card the thread could not resolve still
 * reads as the card it is rather than as a deleted one.
 */
function DebugOutcomeLine({
  outcome,
  workItemRefs,
}: {
  outcome: DebugOutcome;
  workItemRefs: WorkItemRefMap;
}) {
  const tc = useTranslations('planningWorkspace.conversation');
  const { landing, anchorKey } = outcome;
  const key = landing.workItemKey;
  const wrote = landing.outcome !== 'ungrounded' && key !== null;
  const Glyph = wrote ? FilePenLine : SearchCheck;

  let body: React.ReactNode;
  if (!wrote) {
    body = tc('debug.ungrounded');
  } else {
    const summary = outcomeChipSummary(key, landing.title, workItemRefs);
    const chip = () => <WorkItemRefChip summary={summary} fallbackLabel={key} />;
    const messageKey =
      landing.outcome === 'enrich_existing'
        ? anchorKey && anchorKey.toUpperCase() !== key.toUpperCase()
          ? 'debug.enrichedAnchor'
          : 'debug.enriched'
        : landing.createdInTriage || !anchorKey
          ? 'debug.filed'
          : 'debug.wroteAnchor';
    body = tc.rich(messageKey, { key, anchorKey: anchorKey ?? '', chip });
  }

  return (
    <p
      className="mt-1.5 flex items-start gap-1.5 border-t border-(--el-border-soft) pt-1.5 text-xs text-(--el-text)"
      data-testid="plan-change-debug-outcome"
      data-outcome={landing.outcome}
    >
      <Glyph className="mt-px size-3.5 flex-none text-(--el-text-secondary)" aria-hidden="true" />
      {/* `wi-chip-host` — the chip's own rules reach it outside MarkdownView (MOTIR-7068). */}
      <span className="wi-chip-host min-w-0">{body}</span>
    </p>
  );
}

/** The chip's summary for the one card a debug turn wrote. */
function outcomeChipSummary(
  key: string,
  title: string | null,
  workItemRefs: WorkItemRefMap,
): WorkItemRefSummaryDto | undefined {
  const resolved = workItemRefs[key] ?? workItemRefs[key.toUpperCase()];
  if (resolved) return resolved;
  if (title === null) return undefined;
  // A debug turn writes to a BUG — a triage bug, a bug it filed, or the card
  // that already covers the report. Only the key and title crossed the settle,
  // so no status dot is drawn rather than a guessed one.
  return {
    accessible: true,
    id: key,
    identifier: key,
    title,
    kind: 'bug',
    archived: false,
    status: null,
  };
}

export function Bubble({
  role,
  label,
  tone = 'default',
  testId,
  anchorId,
  children,
}: {
  role: 'user' | 'assistant';
  label?: React.ReactNode;
  /** Assistant only — `asking` is the question variant (design state B). */
  tone?: 'default' | 'asking';
  testId?: string;
  /** A DOM id + programmatic focusability, for a control that jumps here. */
  anchorId?: string;
  children: React.ReactNode;
}) {
  const isUser = role === 'user';
  return (
    <div
      className={`flex items-start gap-2 ${isUser ? 'flex-row-reverse' : ''}`}
      {...(testId ? { 'data-testid': testId } : {})}
      {...(anchorId ? { id: anchorId, tabIndex: -1 } : {})}
    >
      <span
        aria-hidden="true"
        className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
          isUser
            ? 'bg-(--el-muted) text-(--el-text-secondary)'
            : 'bg-(--el-accent) text-(--el-accent-text)'
        }`}
      >
        {isUser ? '·' : <BrandMark variant="mark" tone="inverted" size={13} />}
      </span>
      {/* ⚠️ THE USER BUBBLE KEEPS ITS LINE BREAKS, and until MOTIR-6238 it did
          not: `{turn.body}` is a bare text child here, with no `white-space`
          rule, so every newline in a typed or pasted message collapsed to a
          single space and a ten-line list arrived as one run-on sentence. Three
          classes, and each answers something the others do not
          (`design/ai-chat/planning-workspace--multiline-composer.mock.html`
          sheets 9 and 10):

            • `whitespace-pre-wrap` honours the newlines — and only that. A long
              unbroken token (a URL, a key) then overflows, because pre-wrap
              still refuses to break inside a word.
            • `wrap-anywhere` breaks it. The same class the shipped rail already
              uses for exactly this on the revision-held title
              (`PlanReviewRail.tsx:308`) — the surface's own treatment, not a
              new one.
            • `min-w-0` is what lets the flex item shrink at all, so the break
              happens inside the bubble instead of widening it past the rail.

          ASSISTANT bubbles are untouched: they render Markdown through
          `MarkdownView`, which blocks its own paragraphs. Only the user bubble
          renders raw typed text. */}
      <div
        className={
          isUser
            ? 'min-w-0 rounded-(--radius-card) bg-(--el-chat-bubble-user) px-3 py-2 text-sm whitespace-pre-wrap text-(--el-accent-text) wrap-anywhere'
            : `rounded-(--radius-card) px-3 py-2 text-sm ${BUBBLE_FILL[tone]}`
        }
      >
        {label ? (
          <span className="mb-0.5 flex items-center gap-1 font-mono text-[10px] font-semibold tracking-wide uppercase opacity-80">
            {label}
          </span>
        ) : null}
        {children}
      </div>
    </div>
  );
}

/**
 * The FRESH-START pointer (MOTIR-6024; design §19.8, panel 3): nothing resumed,
 * and this scope has an earlier conversation. One line above the opener, on
 * the information notice tint, linking to that conversation's row on the Plans
 * page. Not dismissible and not persisted — it goes once this conversation has
 * a turn.
 */
function EarlierNotice({
  earlier,
  projectName,
}: {
  earlier: EarlierSessionDto;
  projectName: string;
}) {
  const ts = useTranslations('planningWorkspace.session');
  const routes = useReaderRoutes();
  const [first, ...rest] = earlier.targetKeys;
  const link = (chunks: React.ReactNode) => (
    <Link
      href={routes.view(`/plans?session=${encodeURIComponent(earlier.id)}`)}
      className="font-semibold underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    >
      {chunks}
    </Link>
  );
  const mono = (chunks: React.ReactNode) => <span className="font-mono">{chunks}</span>;
  // The anchor's own words: the first key in mono, "and N more" for the rest,
  // or the project's name when the conversation was project-wide.
  const anchorNode: React.ReactNode = first
    ? rest.length > 0
      ? ts.rich('anchorMore', { first, count: rest.length, key: mono })
      : mono(first)
    : projectName;
  const label = first ?? projectName;
  const anchor = () => anchorNode;
  const body = !earlier.mine
    ? ts.rich('earlierOther', {
        label,
        anchor,
        name: earlier.startedBy?.name ?? ts('someone'),
        link,
      })
    : first
      ? ts.rich('earlierAnchored', { label, anchor, link })
      : ts.rich('earlierProject', { project: projectName, link });
  return (
    <p
      data-testid="planning-earlier-session"
      className="flex items-start gap-2 rounded-(--radius-control) bg-(--el-notice-info-bg) px-(--spacing-control-x) py-(--spacing-control-y) text-xs leading-relaxed text-(--el-text-strong)"
    >
      <History className="mt-px size-3.5 flex-none" aria-hidden />
      <span>{body}</span>
    </p>
  );
}

/**
 * THE REVIEW BLOCK OF AN ASKED PLAN (Story MOTIR-6012 · MOTIR-6037; design Part XXII
 * §22.4–§22.5, `plan-review--decide.mock.html` Panels 2–7, 10). The rail's mirror of the
 * canvas bar, speaking the gate's words: *Nothing saved yet*, the consequence line (or
 * the held reason in its place), and Decline · Approve. Decline confirms once in the
 * approve language's band, which REPLACES the verbs here. A reader who may not decide
 * sees the question and who it waits on, and no verbs at all.
 */
function GatedReviewBlock({
  view,
  busy,
  deciding,
  declining,
  staleRefused,
  approveProgress = null,
  decidedFirst,
  decidedFirstLines,
  onApprove,
  onRequestDecline,
  onCancelDecline,
  onConfirmDecline,
}: {
  view: PlanGateView;
  busy: boolean;
  deciding: boolean;
  declining: boolean;
  staleRefused: boolean;
  approveProgress?: PlanApproveProgressView | null;
  /** The door answered *already decided*: somebody else pressed first (Panel 6). */
  decidedFirst: boolean;
  decidedFirstLines: { title: string; next: string };
  onApprove: () => void;
  onRequestDecline?: () => void;
  onCancelDecline?: () => void;
  onConfirmDecline?: (noteMd: string | null) => void;
}) {
  const tc = useTranslations('planningWorkspace.conversation');
  const tp = useTranslations('approvalGate.planApproval.surface');

  if (decidedFirst) {
    // SOMEBODY DECIDED FIRST — `approvalGate.refusal.alreadyDecided`, verbatim. The
    // refusal names no decider, so the unattributed sentence is the honest one.
    return (
      <div
        data-testid="plan-change-review"
        className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) px-3 py-2"
      >
        <p role="alert" className="text-xs font-medium text-(--el-text)">
          {decidedFirstLines.title}
        </p>
        <p className="text-xs text-(--el-text-secondary)">{decidedFirstLines.next}</p>
      </div>
    );
  }

  if (declining && onCancelDecline && onConfirmDecline) {
    return (
      <div
        data-testid="plan-change-review"
        className="flex shrink-0 flex-col overflow-hidden rounded-(--radius-card) border border-(--el-accent)"
      >
        <div className="px-3 py-2">
          <span className="text-xs font-semibold text-(--el-text-strong)">
            {tc('nothingSavedYet')}
          </span>
        </div>
        <PlanDeclineConfirm
          deciding={deciding}
          onCancel={onCancelDecline}
          onConfirm={onConfirmDecline}
        />
      </div>
    );
  }

  const held = view.kind === 'held';
  return (
    <div
      data-testid="plan-change-review"
      className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-accent) px-3 py-2"
    >
      <span className="text-xs font-semibold text-(--el-text-strong)">{tc('nothingSavedYet')}</span>
      {view.kind === 'seeOnly' ? (
        <span
          data-testid="plan-decide-see-only"
          className="flex items-start gap-1.5 text-xs text-(--el-text-secondary)"
        >
          <Lock className="mt-px size-3.5 flex-none" aria-hidden="true" />
          <SeeOnlyLine waitingOn={view.waitingOn} />
        </span>
      ) : approveProgress?.state === 'running' ? (
        // The approve is running: its progress stands where the verbs were, so there
        // is no Approve left to press twice (MOTIR-5249; Part XXV §25.4).
        <PlanApproveProgress {...approveProgress} place="rail" />
      ) : (
        <>
          {approveProgress?.state === 'timedOut' ? (
            <PlanApproveProgress {...approveProgress} place="rail" />
          ) : staleRefused ? (
            <PlanStaleBand place="rail" />
          ) : (
            <span id="plan-change-review-line" className="text-xs text-(--el-text-secondary)">
              {view.kind === 'held'
                ? view.heldBy
                  ? tp('heldBy', { harness: view.heldBy })
                  : tp('held')
                : tp('consequence')}
            </span>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onRequestDecline}
              disabled={busy || held}
              aria-describedby={held ? 'plan-change-review-line' : undefined}
            >
              {tp('decline')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Check className="size-4" aria-hidden="true" />}
              onClick={onApprove}
              disabled={busy || held}
              aria-describedby={held ? 'plan-change-review-line' : undefined}
            >
              {tp('approve')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * THE *FOLLOW-UP TO A CHOICE* CARD (design MOTIR-6432, revision 2; MOTIR-6435) —
 * what the conversation is ABOUT, pinned under the opener: the choice's key and
 * title, what was chosen and its best-if line (the chosen record's own chips),
 * and who chose it when, in the chosen record's own words. `--el-text-secondary`
 * on `--el-surface-soft` clears AA; the label and best-for sit in mint / sky tint
 * chips with `--el-text-strong` ink.
 */
function FollowUpCard({ pick }: { pick: PlanningSeedPickDTO }) {
  const t = useTranslations('planningWorkspace');
  const tc = useTranslations('approvalGate.choice');
  const format = useFormatter();
  const when = pick.decidedAt ? format.relativeTime(new Date(pick.decidedAt)) : '';
  return (
    <div
      data-testid="pick-followup-card"
      className="rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) px-3 py-2"
    >
      <p className="text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase">
        {t('followUpCard.label')}
      </p>
      <p className="mt-1.5 text-[13px] font-medium text-(--el-text)">
        <span className="font-mono">{pick.choiceKey}</span> · {pick.choiceTitle}
      </p>
      <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-(--el-text-secondary)">
        <span className="text-(--el-text)">{tc('record.chose')}</span>
        <span className="inline-flex items-center rounded-(--radius-badge) bg-(--el-tint-mint) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-strong)">
          {pick.label}
        </span>
        <span>{tc('bestIfYouWant')}</span>
        <span className="inline-flex items-center rounded-(--radius-badge) bg-(--el-tint-sky) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-strong)">
          {pick.bestFor}
        </span>
      </p>
      {pick.decidedByLabel ? (
        <p className="mt-1.5 text-xs text-(--el-text-secondary)">
          {tc('record.lead', { name: pick.decidedByLabel, when })}
        </p>
      ) : null}
    </div>
  );
}
