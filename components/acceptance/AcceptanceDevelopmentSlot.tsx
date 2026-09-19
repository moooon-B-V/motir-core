'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { Check, Clock } from 'lucide-react';
import {
  AcceptanceReceiptPlayer,
  AcceptanceReceiptProvenance,
} from '@/components/acceptance/AcceptanceReceiptPlayer';
import type { AcceptanceEvidenceDTO } from '@/lib/dto/acceptanceEvidence';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';

// THE RECEIPT AS THE DEVELOPMENT BLOCK'S SUBJECT (Story MOTIR-4949 · Subtask MOTIR-5790;
// `design/work-items/acceptance-panel--approve-and-merge.mock.html`, panels A–C).
//
// On a STORY RUN the story's pull requests are its own, so the acceptance question
// LEADS the Development block exactly as a design does (MOTIR-5667): this slot is the
// subject, and the pull requests and How to test sit beneath it as what the one press
// merges. It takes the same slot `DesignResultPanel` takes — `designResult`, which is
// the block's "subject first" position, not a design-only one.
//
// WHAT IT SAYS ABOUT THE DECISION, driven by the server's gate, never a local flag:
//   · awaiting — nothing: the frame around it carries the question (panel A);
//   · approved, and the merge question re-asked on its own — *the video stands*
//     (panel C: the merge gate leads, and the acceptance is a line here, not a band);
//   · approved, nothing asked yet — accepted, and the merge follows the next green
//     with no second press (panel B, AMENDMENT 6 Q4).

export function AcceptanceDevelopmentSlot({
  evidence,
  gate,
  mergeAwaiting,
}: {
  evidence: AcceptanceEvidenceDTO;
  /** The story's `acceptance_result` gate, whatever its state. */
  gate: ApprovalGateDTO;
  /** Whether the story's approve-to-merge question is currently being asked. */
  mergeAwaiting: boolean;
}) {
  const t = useTranslations('approvalGate.acceptanceResult');
  const format = useFormatter();
  const approved = gate.state === 'approved';
  const who = gate.decidedByLabel ?? '';
  const when = gate.decidedAt
    ? format.dateTime(new Date(gate.decidedAt), { dateStyle: 'medium', timeStyle: 'short' })
    : '';

  return (
    <div
      className="flex flex-col gap-(--spacing-sm)"
      role="group"
      aria-label={t('kindLabel')}
      data-testid="acceptance-development-slot"
    >
      <h4 className="text-[13px] font-semibold text-(--el-text)">{t('kindLabel')}</h4>
      {approved ? (
        mergeAwaiting ? (
          <p className="flex items-center gap-1.5 text-[13px] text-(--el-text-secondary)">
            <Check className="h-3.5 w-3.5 text-(--el-success)" aria-hidden />
            {t('stands', { name: who, when })}
          </p>
        ) : (
          <div className="flex flex-col gap-1 text-[13px] text-(--el-text-secondary)">
            <p className="flex items-center gap-1.5">
              <Check className="h-3.5 w-3.5 text-(--el-success)" aria-hidden />
              {t('accepted', { name: who, when })}
            </p>
            <p className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-(--el-text-secondary)" aria-hidden />
              {t('mergeHeld')}
            </p>
          </div>
        )
      ) : null}
      <AcceptanceReceiptPlayer evidence={evidence} />
      <AcceptanceReceiptProvenance evidence={evidence} />
    </div>
  );
}
