'use client';

import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';
import { Segmented, type SegmentedOption } from '@/components/ui/Segmented';
import type { WorkItemObsolescenceDto } from '@/lib/dto/workItems';
import { WORK_ITEM_OBSOLESCENCES } from '@/lib/issues/obsolescence';

// The OBSOLESCENCE editor (Story MOTIR-6575 · MOTIR-6674), per
// `design/work-items/core-fields--obsolescence.mock.html` panels 1b and 4. The same
// `Segmented` Difficulty uses, in its `fill` variant (MOTIR-6200), with CURRENT
// (= `null`) as its first member ahead of `WORK_ITEM_OBSOLESCENCES` — so clearing
// the mark is a segment press, and there is no separate Clear (Difficulty needs
// one; its scale has no word for "none").
//
// ⚠️ LOCKED ON AN UNFINISHED CARD (panel 4): both marks are the Segmented's own
// per-option `disabled`, each with the reason as its `title`, and the reason is
// ALSO one visible line under the control — a tooltip alone is invisible on touch.
// The line is a reason, never a door. The server (MOTIR-6672) stays the authority.

type Member = 'current' | WorkItemObsolescenceDto;

export interface ObsolescencePickerProps {
  /** `null` = Current. */
  value: WorkItemObsolescenceDto | null;
  onChange: (value: WorkItemObsolescenceDto | null) => void;
  /** The card is not finished: both marks are disabled with the hint. */
  locked?: boolean;
  disabled?: boolean;
}

export function ObsolescencePicker({ value, onChange, locked, disabled }: ObsolescencePickerProps) {
  const t = useTranslations('workItems.obsolescence');
  const hint = t('lockedHint');
  const options: SegmentedOption<Member>[] = [
    { value: 'current', label: t('value.current') },
    ...WORK_ITEM_OBSOLESCENCES.map((mark) => ({
      value: mark as Member,
      label: t(`value.${mark}`),
      ...(locked ? { disabled: true, title: hint } : {}),
    })),
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <Segmented
        fill
        options={options}
        value={value ?? 'current'}
        onChange={(next) => {
          const mark = next === 'current' ? null : next;
          if (mark !== value) onChange(mark);
        }}
        label={t('label')}
        disabled={disabled}
      />
      {locked ? (
        <p
          className="flex items-start gap-1.5 text-xs leading-snug text-(--el-text-secondary)"
          data-obsolescence-locked-hint=""
        >
          <Lock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span>{hint}</span>
        </p>
      ) : null}
    </div>
  );
}
