'use client';

import { useTranslations } from 'next-intl';
import { Pill } from '@/components/ui/Pill';
import { GateCallToActionBand } from '@/components/approvals/GateCallToActionBand';
import {
  DecisionConfirmDefectBody,
  DecisionConfirmGateFrame,
  DecisionPortBody,
  type DecisionPortView,
} from '@/components/approvals/DecisionConfirmGate';
import type { ApprovalGateDTO, DecisionConfirmationBodyDTO } from '@/lib/dto/approvalGate';

// THE ITEM PAGE'S **DECISION** SECTION (Story MOTIR-5871 · Subtask MOTIR-5960; design
// `approval-control--decision-confirm.mock.html` Panels A1, 3–6). It sits in the late
// stack in the slot the choice section takes, and — per MOTIR-5215 — the page keeps
// the RECORD and none of the verbs: a decision is confirmed or overturned in ONE place,
// the approval overlay, which the band's *Review & confirm* opens.
//
// The shapes, by what the reads say:
//   · the body is DEFECTIVE and nothing was decided — no gate, no frame: the reason,
//     then the sections as far as they parse (Panel 5);
//   · a gate AWAITS a reader who may decide — the sections read-only, then the ONE door
//     (Panel A1);
//   · a gate is decided, withdrawn, or awaits someone else — the shared frame, flush,
//     without verbs: its record band, or who it waits on (Panels 3, 4, 6);
//   · no gate yet (the decision is blocked, or already done) — the sections, read-only.

/* v8 ignore next 3 -- UNREACHABLE: the section renders the frame with `canDecide={false}`,
   so it draws no verbs and nothing can call this (MOTIR-5215). */
async function decideNothing(): Promise<null> {
  return null;
}

export function DecisionConfirmSection({
  body,
  gate,
  canDecide,
  routedToLabel,
  routedToViewer,
  itemIdentifier,
  canReplan = false,
}: {
  body: DecisionConfirmationBodyDTO;
  gate: ApprovalGateDTO | null;
  canDecide: boolean;
  routedToLabel: string | null;
  routedToViewer: boolean;
  itemIdentifier: string;
  /** May this reader open the planner on the card — `WorkItemPlanEntrance`'s condition
   *  (MOTIR-6211). The decided refusal's record carries Re-plan with AI when true;
   *  omitted, it carries none. */
  canReplan?: boolean;
}) {
  const t = useTranslations('approvalGate.decisionConfirm');
  const decided = gate !== null && (gate.state === 'approved' || gate.state === 'overturned');

  if (!body.ok && !decided) {
    return (
      <div className="flex flex-col gap-3">
        <div>
          <Pill severity="warning">{t('defect.title')}</Pill>
        </div>
        <DecisionConfirmDefectBody
          defect={body.defect}
          view={{ ...body.draft, supersedesItems: body.supersedesItems }}
        />
      </div>
    );
  }

  // A DECIDED gate's record outlives a body that stopped parsing — its bands read the
  // stamp, never the body — so the sections shown are the draft.
  const shared = body.ok ? body.port : body;
  const view: DecisionPortView = body.ok
    ? body.port
    : { ...body.draft, supersedesItems: body.supersedesItems };

  if (gate === null) {
    return <DecisionPortBody view={view} record={shared.record} recordCount={shared.recordCount} />;
  }

  if (gate.state === 'awaiting' && canDecide) {
    return (
      <div className="flex flex-col gap-3">
        <DecisionPortBody view={view} record={shared.record} recordCount={shared.recordCount} />
        <GateCallToActionBand
          kind="decision_confirmation"
          subjectLabel={t('kindLabel')}
          askedAt={gate.createdAt}
          itemIdentifier={itemIdentifier}
          routedElsewhereName={routedToViewer ? null : routedToLabel}
          body={t('cta.body')}
          buttonLabel={t('cta.button')}
        />
      </div>
    );
  }

  return (
    <DecisionConfirmGateFrame
      // FLUSH IN THE SECTION: the section card is the container and its title the label.
      layout="section"
      gate={gate}
      view={view}
      record={shared.record}
      recordCount={shared.recordCount}
      presentRecordIds={shared.presentRecordIds}
      // Nothing is pressed on the page: a decided or withdrawn gate is pressable by
      // nobody, and a reader who may not decide sees who it waits on (state B).
      canDecide={false}
      routedToLabel={routedToLabel}
      identifier={itemIdentifier}
      onDecide={decideNothing}
      replan={{ canReplan }}
    />
  );
}
