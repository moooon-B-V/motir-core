'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Lock, Users } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

// The private/project visibility control (Story 6.2 · Subtask 6.2.4) — two
// stacked radio cards in the 6.4.1 access-card grammar, per
// design/work-items/saved-filters.mock.html panel 4. A labelled `radiogroup`
// with full keyboard support; the selected card carries the `--el-accent`
// border. A viewer (canShare=false) sees the Project card visible-but-disabled
// (the 6.4.6 affordance rule) under an info note — sharing is a Member write.

type Visibility = 'private' | 'project';

export function VisibilityRadioCards({
  value,
  onChange,
  canShare,
  legend,
}: {
  value: Visibility;
  onChange: (value: Visibility) => void;
  canShare: boolean;
  legend: string;
}) {
  const t = useTranslations('savedFilters');
  const name = useId();

  const cards: { value: Visibility; icon: typeof Lock; tint: string; disabled: boolean }[] = [
    { value: 'private', icon: Lock, tint: 'bg-(--el-tint-lavender)', disabled: false },
    { value: 'project', icon: Users, tint: 'bg-(--el-tint-sky)', disabled: !canShare },
  ];

  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-(--el-text)">{legend}</legend>
      <div role="radiogroup" aria-label={legend} className="flex flex-col gap-2">
        {cards.map(({ value: v, icon: Icon, tint, disabled }) => {
          const selected = value === v;
          return (
            <label
              key={v}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-(--radius-card) border p-(--spacing-card-padding)',
                selected ? 'border-(--el-accent)' : 'border-(--el-border)',
                disabled && 'cursor-not-allowed opacity-60',
              )}
            >
              <input
                type="radio"
                name={name}
                value={v}
                checked={selected}
                disabled={disabled}
                onChange={() => onChange(v)}
                className="sr-only"
                aria-describedby={`${name}-${v}-hint`}
              />
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border',
                  selected ? 'border-(--el-accent)' : 'border-(--el-border-strong)',
                )}
              >
                {selected ? <span className="size-2 rounded-full bg-(--el-accent)" /> : null}
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-sm font-medium text-(--el-text)">
                  <span
                    className={cn(
                      'inline-flex size-5 items-center justify-center rounded-(--radius-control)',
                      tint,
                    )}
                  >
                    <Icon className="size-3 text-(--el-text-strong)" aria-hidden />
                  </span>
                  {t(`visibility.${v}`)}
                </span>
                <span id={`${name}-${v}-hint`} className="text-xs text-(--el-text-muted)">
                  {t(`visibilityHint.${v}`)}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {!canShare ? (
        <p className="mt-2 rounded-(--radius-card) bg-(--el-tint-sky) px-3 py-2 text-xs text-(--el-text-strong)">
          {t('edit.viewerNote')}
        </p>
      ) : null}
    </fieldset>
  );
}
