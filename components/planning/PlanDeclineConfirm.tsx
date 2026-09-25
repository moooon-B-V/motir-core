'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { Textarea } from '@/components/ui/Textarea';
import { cn } from '@/lib/utils/cn';

// DECLINE ASKS ONCE (Story MOTIR-6012 · MOTIR-6037; `design/ai-planning/design-notes.md`
// Part XXII §22.4, `plan-review--decide.mock.html` Panels 3, 8 and 10).
//
// It is the approve language's own `confirming` band, composed from
// `ApprovalGateControl` rather than invented here: an inline band over the verbs, NEVER a
// modal, with the plan's three consequences and the shipped `FormField` + `Textarea`.
//
// ⚠️ THE REASON IS OPTIONAL — a stated departure from §10a (ADR `approval-gates.md`
// §11.4). *Yes, decline* is live with the field empty, there is no required-error state,
// and the textarea never goes `aria-invalid`. A note, when given, is stored as the
// decision's `noteMd`.
//
// The same band serves all three places the design draws it: stacked above the canvas
// bar, replacing the planning rail's review-block verbs, and in the plan page's footer.

export interface PlanDeclineConfirmProps {
  /** A decision is in flight — both buttons hold. */
  deciding: boolean;
  onCancel: () => void;
  /** Decline, with the reader's reason when they gave one (null when the field is blank). */
  onConfirm: (noteMd: string | null) => void;
  /** Extra classes for the band's outer box (the plan page bleeds it with `-mx-5`). */
  className?: string;
}

export function PlanDeclineConfirm({
  deciding,
  onCancel,
  onConfirm,
  className,
}: PlanDeclineConfirmProps) {
  const t = useTranslations('approvalGate.planApproval.declineConfirm');
  const tGate = useTranslations('approvalGate.confirm');
  const [note, setNote] = useState('');
  const fieldId = `plan-decline-note-${useId().replace(/:/g, '')}`;

  return (
    <div
      data-testid="plan-decline-confirm"
      className={cn(
        'border-t border-(--el-border-soft) bg-(--el-surface-soft) px-4 py-3',
        className,
      )}
    >
      <p className="text-[13px] font-semibold text-(--el-text)">{t('title')}</p>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[13px] text-(--el-text-secondary)">
        <li>{t('end')}</li>
        <li>{t('untouched')}</li>
        <li>{t('leaves')}</li>
      </ul>
      <FormField className="mt-3" htmlFor={fieldId} label={t('label')} helperText={t('helper')}>
        <Textarea
          id={fieldId}
          rows={3}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          aria-describedby={`${fieldId}-helper`}
          disabled={deciding}
        />
      </FormField>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" type="button" onClick={onCancel} disabled={deciding}>
          {tGate('cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          type="button"
          onClick={() => onConfirm(note.trim() === '' ? null : note)}
          disabled={deciding}
        >
          {t('proceed')}
        </Button>
      </div>
    </div>
  );
}
