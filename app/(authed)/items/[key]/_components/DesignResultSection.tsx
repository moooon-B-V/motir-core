'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ApprovalGateControl, type GateVerb } from '@/components/approvals/ApprovalGateControl';
import { DesignResultPanel } from './DesignResultPanel';
import { decideApprovalGateAction } from '../approvalGateActions';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import type { DesignEvidenceDTO, DesignGateSubjectDTO } from '@/lib/dto/designEvidence';
import type { GateDecision } from '@/lib/dto/approvalGate';
import type { GateRefusal } from '@/lib/approvalGates/refusals';

// THE DESIGN RESULT SECTION — the approval frame's FIRST consumer (Story
// MOTIR-4778 · Subtask MOTIR-4792), per `design-notes.md`'s placement table:
// *"the frame IS this section — it REPLACES today's read-only
// `DesignResultPanel` in the late stack, same slot, same position after
// Development."*
//
// ⚠️ THE PANEL IS NOT DELETED — IT BECOMES THE PORT'S CONTENTS, and that is the
// design's own instruction rather than a shortcut: the asset COMPOSES
// `design-result.mock.html` (*"the note, the sandboxed mock at its 32rem height,
// the screenshot … composed, not redrawn"*). Everything that panel earned — the
// note strip, the sandboxed frame and its retry, the screenshot lightbox, the
// provenance chips, the nothing-published-yet state — keeps rendering, inside
// band 2. Deleting and re-drawing it would have quietly dropped a door.
//
// ⚠️ NO GATE ⇒ NO FRAME. A card with nothing awaiting a decision renders exactly
// what it renders today, so this change is invisible until there is something to
// decide. That is also why the empty and no-gate paths need no new copy.

export interface DesignResultSectionProps {
  evidence: DesignEvidenceDTO | null;
  isDesignCard: boolean;
  /** The `design_result` gate WHATEVER its state, or null when the card has
   *  never had one. */
  gate: ApprovalGateDTO | null;
  canDecide: boolean;
  /**
   * The version a DECIDED gate was decided ABOUT, and whether its files were
   * kept (Subtask MOTIR-5033). Null while the gate is awaiting or withdrawn —
   * see the port note below for why those two are null for opposite reasons.
   */
  subject: DesignGateSubjectDTO | null;
  /** The card's `MOTIR-<n>`, for the sentence saying what approving will DO. */
  itemIdentifier: string;
}

export function DesignResultSection({
  evidence,
  isDesignCard,
  gate,
  canDecide,
  subject,
  itemIdentifier,
}: DesignResultSectionProps) {
  const t = useTranslations('approvalGate');
  const tDesign = useTranslations('approvalGate.designResult');
  const router = useRouter();

  // The gate as the SECTION currently knows it: the server's, until this reader
  // decides — then the decided row THIS response returned. Reconciling from the
  // response rather than from a refetch is the inline-edit half of the
  // page-state contract; the `router.refresh()` beside it is the server half.
  const [current, setCurrent] = useState<ApprovalGateDTO | null>(gate);

  // ⚠️ WHICH BYTES THE PORT SHOWS IS DECIDED HERE, AND THE ANSWER IS NOT
  // ALWAYS `evidence` (MOTIR-5033; ADR §6c).
  //
  //   · AWAITING — the CURRENT design. That is the question being asked, and
  //     the gate's subject IS the current row while it is awaiting.
  //   · DECIDED — the version that was DECIDED ON, read from the gate's own
  //     subject by the server. This is what state `E` is for: a design is a
  //     moving object, so an approval rendered over whatever is current now is
  //     a claim about nothing, and the pin that keeps the approved files has no
  //     visible purpose at all — which is the fastest way for a pin to be
  //     quietly removed by somebody tidying up storage.
  //   · WITHDRAWN — neither. The frame draws a DEAD port and ignores this prop
  //     entirely, which is why nothing here special-cases `superseded`.
  //
  // ⚠️ THE FALLBACK IS THE SUBJECT'S OWN ABSENCE, NOT THE CURRENT ROW. When a
  // decided version's bytes are gone — the ordinary outcome for one that was
  // sent back, since only an approval pins — the panel renders its own
  // nothing-published state. Falling back to `evidence` there would put the
  // CURRENT design under a decision that was never made about it.
  //
  // ⚠️ BOTH READ THE **SERVER'S** GATE (`gate`), NEVER THE LOCAL ONE
  // (`current`), AND THAT IS A PAGE-STATE RULE RATHER THAN A STYLE. `subject`
  // is a server prop: the moment this reader presses Approve, `current` flips
  // to `approved` while `subject` is still null, and a port keyed on `current`
  // would blank the design out from under them — in the exact instant the
  // whole state exists to keep it on screen. Keyed on `gate` the port keeps
  // showing the current row, which IS the row that was just approved (you can
  // only approve the current design's gate), and `router.refresh()` then swaps
  // in the server's pinned answer with nothing visibly changing.
  const decidedOnServer = gate?.state === 'approved' || gate?.state === 'changes_requested';
  const portEvidence = decidedOnServer ? (subject?.evidence ?? null) : evidence;
  const port = <DesignResultPanel evidence={portEvidence} isDesignCard={isDesignCard} />;

  if (!current) return <DesignResultPanel evidence={evidence} isDesignCard={isDesignCard} />;

  // ⚠️ THE VERB SET IS DATA, AND THIS IS WHERE `design_result` SUPPLIES ITS OWN.
  // A pair is one case, not the shape: the choice gate (MOTIR-4914) hands the
  // same band N options and needs no second control.
  const verbs: GateVerb[] = [
    {
      decision: 'request_changes',
      label: t('verb.requestChanges'),
      variant: 'secondary',
      // Sending a design back feeds the revise loop and is undone by the agent
      // republishing, so it does not confirm — a reversible act asked twice is
      // friction rather than care.
      confirms: false,
    },
    {
      decision: 'approve',
      label: t('verb.approve'),
      variant: 'primary',
      // Approving IS terminal for this kind (ADR §3 — it flips the subtask to
      // Done), which is exactly what the confirm band exists to say out loud.
      confirms: true,
    },
  ];

  async function onDecide(decision: GateDecision): Promise<GateRefusal | null> {
    const result = await decideApprovalGateAction(current!.id, decision);
    if (!result.ok) return result.refusal;
    setCurrent(result.gate);
    // The SERVER surfaces the decision also moved: the status pill above, and
    // the readiness of every card this one was blocking. `router.refresh()` is
    // the only thing that reaches them, and it cannot reach this component's own
    // state — which is why both halves are here.
    router.refresh();
    return null;
  }

  return (
    <ApprovalGateControl
      gate={current}
      canDecide={canDecide}
      kindLabel={tDesign('kindLabel')}
      subjectMeta={
        current.subjectVersion
          ? tDesign('meta.withVersion', { version: current.subjectVersion.slice(0, 8) })
          : tDesign('meta.plain')
      }
      port={port}
      verbs={verbs}
      consequence={tDesign('consequence', { key: itemIdentifier })}
      // The design's confirm list, minus its dependent COUNT — see the note in
      // this card's pull request: the count needs a readiness read this card
      // does not add, and an uncounted clause is honest where an invented number
      // would not be.
      confirmConsequences={[
        tDesign('confirm.records'),
        tDesign('confirm.keepsFiles'),
        tDesign('confirm.movesToDone', { key: itemIdentifier }),
      ]}
      routedToLabel={null}
      // The `design_result` kind's answer to *were the files kept?* —
      // `design_evidence.pinned_at`, read off the decided row. Null while
      // awaiting or withdrawn, which renders no line at all rather than a
      // guess in either direction.
      filesKept={subject ? subject.filesKept : null}
      onDecide={onDecide}
    />
  );
}
