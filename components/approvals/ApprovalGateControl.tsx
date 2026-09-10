'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill, type PillProps } from '@/components/ui/Pill';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import type { GateDecision } from '@/lib/services/approvalGatesService';
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
//   · the port's FLOOR, its ceiling-with-own-scroll and Expand, and the `X`
//     state whose verbs are gated on the port having RENDERED — MOTIR-5032;
//   · state `E`'s PINNED port and its "Files kept" line, and state `G`
//     (superseded), both of which need a read of a NON-awaiting gate — MOTIR-5033.

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
  const [phase, setPhase] = useState<Phase>({ kind: 'awaiting' });

  const decided = gate.state === 'approved' || gate.state === 'changes_requested';

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

  return (
    <div className="overflow-hidden rounded-(--radius-card) border border-(--el-border)">
      <FrameHeader
        kindLabel={kindLabel}
        subjectMeta={subjectMeta}
        pillProps={pillProps}
        stateLabel={stateLabel}
      />

      {/* BAND 2 — THE PORT. Present in every state this card draws. The floor,
          the ceiling and Expand are MOTIR-5032's; what is here is the subject. */}
      <div className="px-4 py-4">{port}</div>

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
            {canDecide ? consequence : t('waitingOn', { name: routedToLabel ?? t('theAssignee') })}
          </span>
          {/* ⚠️ STATE `B` RENDERS NO VERBS AT ALL — not disabled ones. A reader
              who may not decide can still SEE what is being decided; a greyed
              button would tell them the control is theirs and broken. */}
          {canDecide ? (
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
}
