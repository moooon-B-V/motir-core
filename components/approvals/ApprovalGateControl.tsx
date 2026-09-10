'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Maximize2, Minimize2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill, type PillProps } from '@/components/ui/Pill';
import { PortRenderStatusProvider, usePortRenderStatus } from './portRenderStatus';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import type { GateDecision } from '@/lib/dto/approvalGate';
import type { GateRefusal } from '@/lib/approvalGates/refusals';

// THE UNIVERSAL APPROVAL FRAME (Story MOTIR-4778 · Subtask MOTIR-4792), built to
// `design/work-items/approval-control.mock.html` + `design-notes.md`
// § The UNIVERSAL APPROVAL FRAME.
//
// ⚠️ THE UNIVERSAL ELEMENT IS THE FRAME, NOT THE VERB PAIR — and that is a
// CORRECTION, recorded here because the obvious refactor undoes it. The first
// design drew the BUTTON as the shared element with the subject left as a stub,
// and was rejected on review: *"Approve button without review doesn't stand —
// the user needs to see what he is approving."* So what a person learns once is
// what REVIEWING looks like, and the button is the last band of it.
//
// THREE BANDS, and the ORDER is the whole of it:
//
//   1 · header — what you are looking at, which version, when it arrived, the state
//   2 · THE PORT — the subject, RENDERED
//   3 · the verbs — BELOW the port, because you decide after you look
//
// ⚠️ SO NEVER MOVE THE VERBS ABOVE THE PORT. The withdrawn first cut also
// carried a rule that "the control sits at the HEAD of the section, never below
// the artefact" — the right observation (a reader should not scroll to discover
// a decision is owed) answered the wrong way, by moving the button FURTHER from
// the thing it decides. The frame removes the problem instead of relocating it.
//
// PRESENTATIONAL PLUS ONE ACTION: fed a gate DTO and a decide callback, it owns
// no fetching and renders every state from the model. The PORT's contents are
// the caller's — that is the only thing a new gate kind supplies, and it is why
// the merge kind needs no second control, no second confirm and no second
// decided treatment.
//
// WHAT THIS CARD DOES NOT DRAW, each owned by a sibling it blocks:
//   · state `E`'s PINNED port and its "Files kept" line, and state `G`
//     (superseded), both of which need a read of a NON-awaiting gate — MOTIR-5033.
//
// ── ADDED BY MOTIR-5032 — THE PORT'S MECHANICS AND STATE `X` ───────────────
// The line that used to stand above ("the port's FLOOR, its
// ceiling-with-own-scroll and Expand, and the `X` state … — MOTIR-5032") is now
// BUILT, here, and is described at `PortBox` and at band 3 below. The three
// mechanics are the design's own, and `design-notes.md` insists they are not
// polish: "The port's mechanics are the design, not a detail: a floor height,
// so the subject is never a sliver; a ceiling with its own scroll, so a tall
// subject never pushes the verbs off screen; an Expand affordance, for a
// subject that deserves the whole viewport."
//
// All three protect the ONE ordering above — the verbs sit below the port. A
// port that collapses to a sliver is the button-first cut arrived at by
// accident; a port with no ceiling pushes the verbs past the fold and the
// reader approves something they have scrolled away from.

/**
 * One verb in band 3.
 *
 * ⚠️ BAND 3 IS A SLOT THE KIND FILLS, NOT A FIXED PAIR. The verb SET arrives as
 * data, so a pair is ONE CASE rather than the component's shape — ADR §1's
 * amendment registers `decision_choice`, whose set is N options rather than two
 * verbs, and the frame accommodates it without a second control. Drawing that
 * N-option band is MOTIR-4914's; making the band read from data is this card's.
 */
export interface GateVerb {
  /** The decision this verb records — the decide door's own vocabulary. */
  decision: GateDecision;
  label: string;
  variant: 'primary' | 'secondary';
  /**
   * Whether pressing it opens the confirm band first. Approving a design is
   * terminal and confirms; sending it back feeds the revise loop and does not,
   * because a reversible act asked twice is friction rather than care.
   */
  confirms: boolean;
}

export interface ApprovalGateControlProps {
  gate: ApprovalGateDTO;
  /**
   * Whether THIS reader may press the verbs. The AUTHORITY answer, never the
   * routing one: a gate is SHOWN to one person and may be PRESSED by three.
   * `false` is state `B` — the port live, the verbs absent.
   */
  canDecide: boolean;
  /** Band 1's label for what is being decided (e.g. "Design result"). */
  kindLabel: string;
  /** Band 1's meta line — when it arrived and which version. */
  subjectMeta: ReactNode;
  /** BAND 2 — the subject, RENDERED. The only thing a kind supplies. */
  port: ReactNode;
  /** The verb SET this kind carries. */
  verbs: GateVerb[];
  /** Band 3's sentence: what approving will DO, beside the verbs. */
  consequence: ReactNode;
  /** The confirm band's list — what approving is about to do, per kind. */
  confirmConsequences: ReactNode[];
  /** Who the gate is waiting on, for state `B`. */
  routedToLabel?: string | null;
  /**
   * Record the decision. Resolves to a refusal the frame draws IN PLACE, or
   * null on success — at which point the caller has already reconciled.
   */
  onDecide: (decision: GateDecision) => Promise<GateRefusal | null>;
}

type Phase =
  | { kind: 'awaiting' }
  | { kind: 'confirming'; verb: GateVerb }
  | { kind: 'pending' }
  | { kind: 'refused'; refusal: GateRefusal };

/** Band 1 — the same shape for every kind; only the words change. */
function FrameHeader({
  kindLabel,
  subjectMeta,
  pillProps,
  stateLabel,
}: {
  kindLabel: string;
  subjectMeta: ReactNode;
  pillProps: PillProps;
  stateLabel: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-(--el-border-soft) px-4 py-3">
      <span className="text-sm font-semibold text-(--el-text)">{kindLabel}</span>
      <span className="text-xs text-(--el-text-secondary)">{subjectMeta}</span>
      <span className="ml-auto">
        <Pill {...pillProps}>{stateLabel}</Pill>
      </span>
    </div>
  );
}

/**
 * BAND 2's box — the port's FLOOR, its CEILING WITH ITS OWN SCROLL, and the
 * EXPAND affordance (MOTIR-5032).
 *
 * ⚠️ THE NUMBERS, AND WHY THE CEILING IS NOT THE MOCK'S. The asset's `.port`
 * rule is `min-height: 196px; max-height: 320px; overflow: auto`. The FLOOR is
 * taken from it verbatim. The CEILING is set just ABOVE the subject's own
 * shipped height instead, and that is a refinement the card asked for — "the
 * shipped `FRAME_HEIGHT` constant (32rem) and its recorded reasoning, which the
 * floor and ceiling refine rather than replace".
 *
 * The reason is that the asset's 320px is the BOARD's compressed representation
 * of a subject, not a measurement of one: the mock stacks nine frames into a
 * single 8602px export, so every port in it is drawn shorter than the real
 * thing. The real design port contains a 32rem (512px) sandboxed frame, whose
 * height `design-notes.md` § Design result panel argues for separately. A 320px
 * ceiling over a 512px subject means a NESTED scrollbar on the single-subject
 * case that is by far the most common — two scrollbars, neither of which is the
 * page's. A ceiling at 34rem clears the subject plus its header strip, so the
 * common case scrolls INSIDE the subject as it already did, and band 2's own
 * scroll engages exactly when the design says it should: when the port holds
 * MORE than one subject (a note AND a mock AND screenshots) and would otherwise
 * push the verbs off screen.
 *
 * ⚠️ HEIGHT IS THE ONE SHAPE AXIS WITH NO TOKEN TO ROUTE TO, AND THAT IS
 * RECORDED RATHER THAN ASSUMED. `tests/theme/shapeSwapLint.test.ts` guards a
 * surface's own RADIUS against the seven element-semantic roles and is
 * "deliberately silent" on padding and height, because "the token set has one
 * value per role while the code uses a scale against each … there is nothing
 * correct to route the other 140 to until MOTIR-2336 decides a density scale".
 * So the two heights below are arbitrary values behind NAMED constants — the
 * same shape as the `FRAME_HEIGHT` constant this refines — and the radius,
 * which IS guarded, flows through `--radius-card` on the frame container.
 */
const PORT_FLOOR = 'min-h-[12.25rem]';
const PORT_CEILING = 'max-h-[34rem]';

function PortBox({
  children,
  expanded,
  showExpand,
  onToggleExpanded,
}: {
  children: ReactNode;
  expanded: boolean;
  /**
   * Whether to draw the EXPAND control. The floor, the ceiling and the scroll
   * are unconditional — they are the box — but the control is not.
   *
   * ⚠️ THE ASSET SCOPES IT, AND CHECKING THAT IS WHAT CORRECTED THIS CARD.
   * `approval-control.mock.html` draws `.portExpand` in exactly three frames —
   * panel 1 (the anatomy, state `A`) and panel `U`'s two frames — and all three
   * are AWAITING-YOURS with a rendered port. It is drawn in NONE of the eight
   * state frames `B`–`X`. The states panel's own note says each is "the SAME
   * frame with different props", so the mechanics are shared; the CONTROL is
   * simply not offered where there is no decision to make.
   *
   * That reading is corroborated from the other side: the frame's shipped suite
   * asserts `queryAllByRole('button')` is EMPTY in state `B` and in the decided
   * record, and this card is told not to edit it. Drawing Expand everywhere the
   * port is live broke both — the design and the test pointed the same way, and
   * the always-on version was the improvisation.
   *
   * A reader in `B` who wants the whole viewport is a real want and a DESIGN
   * AMENDMENT — its own card, not something to invent here.
   */
  showExpand: boolean;
  onToggleExpanded: () => void;
}) {
  const t = useTranslations('approvalGate.port');

  return (
    <div
      className={
        expanded
          ? // ⚠️ `min-h-0 flex-1 overflow-y-auto` IS THE LOAD-BEARING PART, AND
            // IT IS THE RECIPE `Modal.Body` OWNS. In a flex column a bare child
            // gets `min-height: auto` and cannot shrink below its content, so
            // the overflow is CLIPPED by the panel and no scrollbar appears
            // anywhere — whatever sits at the bottom becomes UNREACHABLE.
            // `tests/theme/modalScrollContainerScan.ts` exists because two
            // instances shipped past their own suites that way (MOTIR-462,
            // MOTIR-2488), and in both the thing made unreachable was the
            // footer, "i.e. the primary action".
            //
            // That is precisely the failure this card must not ship: an
            // expanded port whose verbs are clipped off the bottom is a port
            // that took the decision off screen, which is what the whole frame
            // is arranged to prevent. The floor and ceiling are DROPPED here on
            // purpose — expanded, the viewport is the ceiling.
            'relative flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4'
          : `relative ${PORT_FLOOR} ${PORT_CEILING} overflow-y-auto px-4 py-4`
      }
      // The port is a scroll container in both forms, so it must be focusable to
      // be scrollable from the keyboard alone (a scrollable region with no
      // focusable content is unreachable by keyboard otherwise).
      tabIndex={0}
      role="group"
      aria-label={t('label')}
    >
      {/* Absolutely positioned top-right, as the asset draws it (`.portExpand`).
          `sticky` rather than `absolute` so it stays in view while the port
          scrolls — the asset's own frames are short enough that the distinction
          never arises in the export, and a control that scrolls away from a
          subject tall enough to need it would be the affordance failing in
          exactly its own case. */}
      {/* `|| expanded` is not belt-and-braces: without it a port that FAILS
          while expanded would drop the only control that gets the reader back
          out, leaving them inside a viewport-sized panel with no way to close
          it. Whatever hides the affordance must never hide the way back. */}
      {showExpand || expanded ? (
        <div className="pointer-events-none sticky top-0 z-10 flex justify-end">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            className="pointer-events-auto"
            leftIcon={
              expanded ? (
                <Minimize2 className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" aria-hidden />
              )
            }
          >
            {expanded ? t('collapse') : t('expand')}
          </Button>
        </div>
      ) : null}

      {children}
    </div>
  );
}

/**
 * Band 3's decided form — the provenance strip, carried from the shipped
 * acceptance panel so the two read as one gesture rather than two features.
 */
function RecordStrip({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-(--el-border-soft) px-4 py-3 text-xs text-(--el-text-secondary)">
      {children}
    </div>
  );
}

/**
 * A refusal, drawn IN PLACE — the design's `H`. It sits between the port and the
 * verbs so the reader's eye lands on it without the subject leaving the screen,
 * and it always carries a NEXT ACTION: a refusal that only says no is a dead end
 * on the one surface built to explain itself.
 *
 * `--el-danger-on-surface` for the ink, never `--el-danger-text`, which is the
 * ink FOR a danger fill and renders white-on-white here (CLAUDE.md's danger rule).
 */
function RefusalAlert({ refusal }: { refusal: GateRefusal }) {
  const t = useTranslations('approvalGate.refusal');

  // ⚠️ EXHAUSTIVE over `GateRefusal`, which is itself total over the service's
  // `ApprovalGateErrorTag` (`lib/approvalGates/refusals.ts`). A tag added there
  // and not handled here fails the type-check at the `never` below — which is
  // the point of the union: a new server-side failure becomes a compile error on
  // the screen that has to explain it, not a blank box in production.
  let headline: string;
  switch (refusal.tag) {
    case 'APPROVAL_GATE_ALREADY_DECIDED':
      headline = refusal.decidedByLabel
        ? t('alreadyDecided.byName', { name: refusal.decidedByLabel })
        : t('alreadyDecided.unattributed');
      break;
    case 'APPROVAL_GATE_SUPERSEDED':
      headline = t('superseded.title');
      break;
    case 'APPROVAL_GATE_NOT_AUTHORISED':
      headline = t('notAuthorised.title');
      break;
    case 'APPROVAL_GATE_NOT_FOUND':
      headline = t('notFound.title');
      break;
    case 'APPROVAL_GATE_KIND_UNREGISTERED':
      headline = t('kindUnregistered.title');
      break;
    case 'APPROVAL_GATE_ALREADY_AWAITING':
      headline = t('alreadyAwaiting.title');
      break;
    case 'APPROVAL_GATE_DECIDED_IMMUTABLE':
      headline = t('decidedImmutable.title');
      break;
    case 'UNEXPECTED':
      headline = t('unexpected.title');
      break;
    default: {
      const exhaustive: never = refusal;
      throw new Error(`Unhandled gate refusal: ${JSON.stringify(exhaustive)}`);
    }
  }

  const nextActionKey = refusal.tag === 'UNEXPECTED' ? 'unexpected' : refusalKeyOf(refusal.tag);

  return (
    <div
      role="alert"
      className="flex gap-2.5 border-t border-(--el-border-soft) bg-(--el-tint-peach) px-4 py-3"
    >
      <AlertTriangle
        className="mt-0.5 h-4 w-4 flex-none text-(--el-danger-on-surface)"
        aria-hidden
      />
      <p className="text-[13px] leading-snug text-(--el-text-strong)">
        <b>{headline}</b>{' '}
        <span className="text-(--el-text-secondary)">{t(`${nextActionKey}.next`)}</span>
      </p>
    </div>
  );
}

/**
 * STATE `X` — the port failed, so there are no verbs (MOTIR-5032).
 *
 * Drawn as the asset's `X` panel draws it: the alert sits BETWEEN the port and
 * band 3, carrying the design's own sentence and a next action.
 *
 *   "⚠ You cannot approve what cannot be shown. Retry, or ask the agent to
 *    republish."
 *
 * ⚠️ THE NEXT ACTION IS TEXT HERE AND A BUTTON IN THE PORT — a DEVIATION from
 * the asset, recorded rather than silent. The asset draws a `Retry` button in
 * band 3's verb slot. The shipped design port ALREADY owns retry: `MockFrame`
 * holds the `attempt` counter that remounts the frame for a fresh signed URL,
 * and its own failure card renders that button one line above this alert. Two
 * Retry buttons is worse than the asset's one, and lifting the port's retry
 * into band 3 would mean the frame reaching into its own opaque port — the
 * thing the universal frame exists not to do — and would edit a suite this card
 * is told not to edit (`design-result-panel.test.ts` asserts that button). So
 * the ACT stays where the reader's eye already is, and this alert names it.
 *
 * Same ink rule as `RefusalAlert`: `--el-danger-on-surface`, never
 * `--el-danger-text`, which is the ink FOR a danger fill (CLAUDE.md).
 */
function PortFailedAlert() {
  const t = useTranslations('approvalGate.port.failed');

  return (
    <div
      role="alert"
      className="flex gap-2.5 border-t border-(--el-border-soft) bg-(--el-tint-peach) px-4 py-3"
    >
      <AlertTriangle
        className="mt-0.5 h-4 w-4 flex-none text-(--el-danger-on-surface)"
        aria-hidden
      />
      <p className="text-[13px] leading-snug text-(--el-text-strong)">
        <b>{t('title')}</b> <span className="text-(--el-text-secondary)">{t('next')}</span>
      </p>
    </div>
  );
}

/** Tag → its copy namespace. Kept beside the switch it mirrors. */
function refusalKeyOf(tag: Exclude<GateRefusal['tag'], 'UNEXPECTED'>): string {
  switch (tag) {
    case 'APPROVAL_GATE_ALREADY_DECIDED':
      return 'alreadyDecided';
    case 'APPROVAL_GATE_SUPERSEDED':
      return 'superseded';
    case 'APPROVAL_GATE_NOT_AUTHORISED':
      return 'notAuthorised';
    case 'APPROVAL_GATE_NOT_FOUND':
      return 'notFound';
    case 'APPROVAL_GATE_KIND_UNREGISTERED':
      return 'kindUnregistered';
    case 'APPROVAL_GATE_ALREADY_AWAITING':
      return 'alreadyAwaiting';
    case 'APPROVAL_GATE_DECIDED_IMMUTABLE':
      return 'decidedImmutable';
  }
}

export function ApprovalGateControl({
  gate,
  canDecide,
  kindLabel,
  subjectMeta,
  port,
  verbs,
  consequence,
  confirmConsequences,
  routedToLabel,
  onDecide,
}: ApprovalGateControlProps) {
  const t = useTranslations('approvalGate');
  const tPort = useTranslations('approvalGate.port');
  const [phase, setPhase] = useState<Phase>({ kind: 'awaiting' });
  const [expanded, setExpanded] = useState(false);

  // MOTIR-5032 — the port's own report, and the gate on band 3 that follows from
  // it. `usePortRenderStatus` defaults to `'rendered'` when NOTHING reports, so
  // a static port and every state MOTIR-4792 shipped are untouched.
  const { reporter, status: portStatus } = usePortRenderStatus();

  const decided = gate.state === 'approved' || gate.state === 'changes_requested';

  // ⚠️ THE GATE LIVES HERE, IN THE FRAME'S OWN RENDER PATH — not in a consumer,
  // and not in the port. A consumer that passes a verb set and a failing port
  // gets no verbs, because the decision is taken from the port's report on this
  // line rather than from anything the call site remembered to do.
  //
  // `'rendering'` withholds the verbs too: you cannot approve what is not yet on
  // screen. Only `'failed'` is state `X` — only it owes the reader the alert and
  // a next action, which is why the two are separate rather than one boolean.
  const portShown = portStatus === 'rendered';
  const portFailed = portStatus === 'failed';

  async function run(verb: GateVerb) {
    setPhase({ kind: 'pending' });
    const refusal = await onDecide(verb.decision);
    // On success the CALLER has reconciled and re-rendered us with the decided
    // gate, so there is no success branch to draw here — which is what keeps
    // this component free of the write's own state.
    setPhase(refusal ? { kind: 'refused', refusal } : { kind: 'awaiting' });
  }

  const stateLabel = decided
    ? gate.state === 'approved'
      ? t('state.approved')
      : t('state.changesRequested')
    : phase.kind === 'pending'
      ? t('state.recording')
      : canDecide
        ? t('state.awaitingYou')
        : t('state.awaiting');

  // The four chips a reader must tell apart at a glance. `tone="awaiting"` is
  // the frame's own (added to the primitive by this card); the other three reuse
  // the shipped severities the design's tints already name.
  const pillProps: PillProps = decided
    ? gate.state === 'approved'
      ? { severity: 'success' }
      : { severity: 'warning' }
    : phase.kind === 'pending'
      ? { severity: 'info' }
      : { tone: 'awaiting' };

  const frame = (
    <div
      className={
        expanded
          ? // The expanded form is dialog-SHAPED and is deliberately not a
            // `Modal`: it holds no focus trap and steals nothing, because the
            // frame is still the page's own content — just given the viewport.
            // The recipe (scrim token, panel token, the `max-h`/flex column)
            // mirrors `Modal` so the two read as one language.
            'fixed top-1/2 left-1/2 z-50 flex max-h-[90vh] w-[90vw] max-w-[72rem] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-(--radius-modal) border border-(--el-border) bg-(--el-page-bg)'
          : 'overflow-hidden rounded-(--radius-card) border border-(--el-border)'
      }
      onKeyDown={(event) => {
        if (expanded && event.key === 'Escape') setExpanded(false);
      }}
    >
      <FrameHeader
        kindLabel={kindLabel}
        subjectMeta={subjectMeta}
        pillProps={pillProps}
        stateLabel={stateLabel}
      />

      {/* BAND 2 — THE PORT, with the three mechanics MOTIR-5032 adds. The
          provider is what lets the subject INSIDE report whether it rendered;
          the box is the floor, the ceiling-with-own-scroll and Expand. */}
      <PortRenderStatusProvider reporter={reporter}>
        <PortBox
          expanded={expanded}
          // Drawn where the asset draws it: a decision that is YOURS to make,
          // not yet made, over a subject that actually rendered.
          showExpand={canDecide && !decided && portShown}
          onToggleExpanded={() => setExpanded((v) => !v)}
        >
          {port}
        </PortBox>
      </PortRenderStatusProvider>

      {/* STATE `X` — between the port and the verbs, as the asset draws it. */}
      {portFailed ? <PortFailedAlert /> : null}

      {phase.kind === 'refused' ? <RefusalAlert refusal={phase.refusal} /> : null}

      {/* BAND 3 — decided: the record. Awaiting: the verbs, or who it waits on. */}
      {decided ? (
        <RecordStrip>
          <span className="font-medium text-(--el-text)">
            {gate.decidedByLabel ?? t('record.unattributed')}
          </span>
          {gate.decidedAt ? <span>{new Date(gate.decidedAt).toLocaleString()}</span> : null}
          {gate.state === 'changes_requested' ? <span>{t('record.willRepublish')}</span> : null}
        </RecordStrip>
      ) : phase.kind === 'confirming' ? (
        // ⚠️ AN INLINE BAND OVER THE VERBS, NEVER A MODAL — a modal would take
        // the port off screen at exactly the moment the reader wants one last
        // look, which is the thing the whole frame is arranged to prevent.
        <div className="border-t border-(--el-border-soft) bg-(--el-surface-soft) px-4 py-3">
          <p className="text-[13px] font-semibold text-(--el-text)">{t('confirm.title')}</p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[13px] text-(--el-text-secondary)">
            {confirmConsequences.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPhase({ kind: 'awaiting' })}
              type="button"
            >
              {t('confirm.cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={() => run(phase.verb)} type="button">
              {t('confirm.proceed', { verb: phase.verb.label })}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-(--el-border-soft) px-4 py-3">
          <span className="text-[13px] text-(--el-text-secondary)">
            {!canDecide
              ? t('waitingOn', { name: routedToLabel ?? t('theAssignee') })
              : portShown
                ? consequence
                : // The asset's `X` footer, verbatim in intent: "The verbs
                  // return when the subject renders." It replaces the
                  // consequence sentence because there is no consequence to
                  // state — nothing is pressable.
                  tPort('verbsReturn')}
          </span>
          {/* ⚠️ STATE `B` RENDERS NO VERBS AT ALL — not disabled ones. A reader
              who may not decide can still SEE what is being decided; a greyed
              button would tell them the control is theirs and broken.
              ⚠️ AND STATE `X` (MOTIR-5032) IS THE SAME ABSENCE FOR THE SAME
              REASON, one axis over: `portShown` is false, so the verbs are not
              rendered at all. A `disabled` button here would say the decision is
              yours and the control is broken, when the truth is that the SUBJECT
              is missing — "you cannot approve what cannot be shown". */}
          {canDecide && portShown ? (
            <span className="ml-auto flex flex-wrap gap-2">
              {verbs.map((verb) => (
                <Button
                  key={verb.decision}
                  variant={verb.variant}
                  size="sm"
                  type="button"
                  disabled={phase.kind === 'pending'}
                  onClick={() =>
                    verb.confirms ? setPhase({ kind: 'confirming', verb }) : void run(verb)
                  }
                >
                  {verb.label}
                </Button>
              ))}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );

  // ⚠️ BOTH FORMS RENDER THE SAME TWO CHILDREN IN THE SAME ORDER, and that is
  // load-bearing rather than tidy. React reconciles by position, so wrapping the
  // frame in an extra element only when expanded would UNMOUNT the port on every
  // toggle — re-running the design port's probe, spending a fresh signed URL and
  // throwing away the reader's scroll position, each time they expand. The scrim
  // is therefore always present and merely hidden.
  return (
    <>
      <div
        aria-hidden
        className={expanded ? 'fixed inset-0 z-40 bg-(--el-overlay-scrim)' : 'hidden'}
        onClick={() => setExpanded(false)}
      />
      {frame}
    </>
  );
}
