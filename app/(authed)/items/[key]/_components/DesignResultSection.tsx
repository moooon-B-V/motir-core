'use client';

import { useTranslations } from 'next-intl';
import { ApprovalGateControl } from '@/components/approvals/ApprovalGateControl';
import { GateCallToActionBand } from '@/components/approvals/GateCallToActionBand';
import { useDecidedGate } from '@/lib/approvals/decidedGates';
import { DesignResultPanel } from './DesignResultPanel';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import type { DesignEvidenceDTO, DesignGateSubjectDTO } from '@/lib/dto/designEvidence';

// THE DESIGN RESULT SECTION — the item page's view of a design card's result and
// of the `design_result` gate raised on it.
//
// ⚠️ IT DOES NOT DECIDE, AND IT USED TO (Story MOTIR-5215 · Subtask MOTIR-5229).
// Until this story the section composed the whole approval frame with its verbs
// and its confirm band, per the placement the design had recorded as *"the frame
// IS this section"*. That placement is SUPERSEDED by
// `design/work-items/design-notes.md` § *The item page HANDS THE DECISION OVER*
// (MOTIR-5228): a decision is made in ONE place, the approval overlay, and the
// page carries the invitation and the receipt. So this file renders one of
// three things, and nothing here can submit a `GateDecision`:
//
//   · NO GATE — the shipped `DesignResultPanel`, byte for byte as before.
//   · AWAITING, AND THE READER MAY DECIDE — the CALL-TO-ACTION BAND: the
//     version, how long it has waited, the state, and ONE control that opens
//     the overlay over this page.
//   · EVERY OTHER STATE (`B` see-but-not-decide, `E` approved, `F` changes
//     requested, `G` withdrawn) — the frame's content, FLUSH in the section
//     card (`layout="section"`, MOTIR-5569), with no verbs.
//
// ⚠️ NO LOCAL COPY OF THE GATE. The section used to seed `useState(gate)` and
// update it from its own decide call. Once the decision moved to the overlay that
// copy would be set once at mount and never follow the server again — the shape
// Bug MOTIR-5118 already shipped once. The section reads its `gate` PROP, and a
// decision the overlay announced for this gate (`useDecidedGate`, MOTIR-5570)
// fills the gap only while that prop still reads `awaiting`; the moment the
// server's render arrives, the prop wins.
//
// ⚠️ THE PANEL IS NOT DELETED — IT IS THE PORT'S CONTENTS in the kept states, and
// the overlay composes the same panel for the decision itself.

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
  /** The card's `MOTIR-<n>` — the overlay's address names the card by it. */
  itemIdentifier: string;
  /**
   * WHOSE DECISION this is waiting on, named — the frame's state `B` line
   * (MOTIR-5191) and the band's routed-elsewhere sentence. Resolved by
   * `approvalGatesService.getForWorkItem`; null when the routing resolves to
   * nobody or to a user row that has gone.
   */
  routedToLabel: string | null;
  /**
   * Whether the gate is ROUTED to the reader looking at the page. Computed on
   * the server from the gate's `routedToId` and the session, never here. It
   * picks the band's sentence and nothing else: the door is the same either
   * way, because the door serves AUTHORITY (`canDecide`), not routing
   * (`docs/decisions/approval-gates.md` §2).
   */
  routedToViewer: boolean;
}

export function DesignResultSection({
  evidence,
  isDesignCard,
  gate,
  canDecide,
  subject,
  itemIdentifier,
  routedToLabel,
  routedToViewer,
}: DesignResultSectionProps) {
  const tDesign = useTranslations('approvalGate.designResult');

  // A decision made in the OVERLAY for this gate, while the server's render has
  // not yet caught up. A hook must run unconditionally, and no gate id is empty.
  const announced = useDecidedGate(gate?.id ?? '');
  const shown = gate?.state === 'awaiting' && announced ? announced.gate : gate;

  // ⚠️ WHICH BYTES THE PORT SHOWS IS DECIDED HERE, AND THE ANSWER IS NOT
  // ALWAYS `evidence` (MOTIR-5033; ADR §6c).
  //
  //   · AWAITING — the CURRENT design. That is the question being asked, and
  //     the gate's subject IS the current row while it is awaiting.
  //   · DECIDED — the version that was DECIDED ON, read from the gate's own
  //     subject by the server, so an approval is never rendered over whatever
  //     is current now.
  //   · WITHDRAWN — neither. The frame draws a DEAD port and ignores this prop.
  //
  // ⚠️ THE FALLBACK IS THE SUBJECT'S OWN ABSENCE, NOT THE CURRENT ROW. When a
  // decided version's bytes are gone — the ordinary outcome for one that was
  // sent back — the panel renders its own nothing-published state. Falling back
  // to `evidence` would put the CURRENT design under a decision never made
  // about it.
  //
  // ⚠️ BOTH READ THE **SERVER'S** GATE (`gate`), NEVER THE ANNOUNCED ONE.
  // `subject` is a server prop: while an announced decision is drawn it is
  // still null, and a port keyed on the announcement would blank the design.
  // Keyed on `gate` the port keeps showing the current row — which IS the row
  // that was just decided, since only the current design's gate can be — and
  // the server's render then swaps in its pinned answer with nothing changing.
  // An OVERTURN is a decision too (MOTIR-5956). The decide door refuses the verb on a
  // design gate, so a design never carries one — but a fold that forgot it would draw
  // the awaiting door over a decided row, which is the defect a total fold prevents.
  const decidedOnServer =
    gate?.state === 'approved' ||
    gate?.state === 'changes_requested' ||
    gate?.state === 'overturned' ||
    // A DECLINE is a decision (MOTIR-6032; ADR §11.4) — offered on a `plan_approval`
    // gate alone, so a design never carries one; listed for the same total-fold reason.
    gate?.state === 'declined';
  const portEvidence = decidedOnServer ? (subject?.evidence ?? null) : evidence;

  if (!shown) return <DesignResultPanel evidence={evidence} isDesignCard={isDesignCard} />;

  // ⚠️ THE BAND INVITES A REVIEW ONLY WHEN THERE IS SOMETHING TO REVIEW.
  // `evidence` is the CURRENT result, null once withdrawn. Since MOTIR-5574 a
  // withdrawal retires its awaiting gate in the same transaction, so this case
  // should no longer arise from the withdraw route — the guard stays because an
  // invitation to review a design that is gone would be a door to nothing, and a
  // stale read or any future path that leaves the two out of step must not draw
  // one. It keeps the frame, flush, whose port draws the panel's own empty state
  // and whose port-failed alert says why nothing is pressable.
  if (shown.state === 'awaiting' && canDecide && evidence !== null) {
    return (
      <GateCallToActionBand
        kind="design_result"
        subjectLabel={
          shown.subjectVersion
            ? tDesign('meta.withVersion', { version: shown.subjectVersion.slice(0, 8) })
            : tDesign('meta.plain')
        }
        askedAt={shown.createdAt}
        itemIdentifier={itemIdentifier}
        routedElsewhereName={routedToViewer ? null : routedToLabel}
      />
    );
  }

  return (
    <ApprovalGateControl
      // FLUSH IN THE SECTION (MOTIR-5569): `ContentSectionCard` already carries
      // the border and the title *Design result*. One container, one label.
      layout="section"
      gate={shown}
      // ⚠️ `canDecide` IS PASSED THROUGH FOR WHAT IT SAYS, NOT FOR WHAT IT
      // ENABLES. Every state that reaches this frame is one the frame draws
      // without verbs — a decided or withdrawn gate is not pressable by anyone,
      // and an awaiting one reaches here only when this reader may NOT decide
      // (state `B`) — and the verb set is empty besides.
      canDecide={canDecide}
      kindLabel={tDesign('kindLabel')}
      subjectMeta={
        shown.subjectVersion
          ? tDesign('meta.withVersion', { version: shown.subjectVersion.slice(0, 8) })
          : tDesign('meta.plain')
      }
      port={<DesignResultPanel evidence={portEvidence} isDesignCard={isDesignCard} />}
      // ⚠️ NO VERBS ON THE ITEM PAGE. The overlay is the one place a
      // `GateDecision` is submitted from; `decideApprovalGateAction` is not
      // imported by this file, and `approval-overlay-story-gate.test.tsx` holds
      // that caller list to the overlay alone.
      verbs={[]}
      consequence={null}
      confirmConsequences={[]}
      routedToLabel={routedToLabel}
      // The `design_result` kind's answer to *were the files kept?* — the
      // server's `design_evidence.pinned_at`, or what the overlay's decide
      // response said until that render arrives (MOTIR-5265's in-browser half).
      filesKept={subject ? subject.filesKept : (announced?.filesKept ?? null)}
      onDecide={noDecisionHere}
    />
  );
}

/** The frame's `onDecide` slot is required, and on this page nothing can call it:
 *  the verb set is empty. It answers nothing rather than pretending to decide.
 *
 *  ⚠️ UNREACHABLE BY CONSTRUCTION, SO ITS COVERAGE IS AN IGNORE THAT NAMES ITS
 *  INVARIANT. The invariant — no approve and no request-changes control exists in
 *  this section for ANY gate state × `canDecide` — is asserted over the whole
 *  enum by `tests/components/design-result-section-story-gate.test.tsx`
 *  (MOTIR-5230). A test that could call this would be a test that found a verb. */
/* v8 ignore next 3 */
async function noDecisionHere(): Promise<null> {
  return null;
}
