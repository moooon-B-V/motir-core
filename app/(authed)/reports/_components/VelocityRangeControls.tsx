'use client';

import { useMemo } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Minus, Plus } from 'lucide-react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import {
  buildReportHref,
  stepVelocityCount,
  VELOCITY_COUNT_LADDER,
} from '@/lib/reports/reportPageView';

// The Velocity report's range controls (Story MOTIR-8919), per
// design/reports/reports--refined.mock.html panel 6(c): an "Ending at"
// completed-sprint Combobox and a "Sprints" stepper. Like every report control
// they NAVIGATE — the range lives in the URL (`?endingAt=&count=`), so a copied
// link reopens the same window and the Server Component re-reads the series.

export interface VelocityPickerSprint {
  id: string;
  name: string;
}

/** The Combobox value for "no end sprint" — the latest completed sprint. */
const LATEST = 'latest';

export function VelocityRangeControls({
  sprints,
  endingAt,
  count,
}: {
  /** Completed sprints, newest first (the picker's order). */
  sprints: VelocityPickerSprint[];
  /** The chosen end sprint's id, or null for the latest. */
  endingAt: string | null;
  count: number;
}) {
  const t = useTranslations('reports');
  const router = useRouter();
  const pathname = usePathname();

  const options = useMemo<ComboboxOption<string>[]>(
    () => [
      {
        value: LATEST,
        label: sprints[0]
          ? t('velocity.latestNamed', { name: sprints[0].name })
          : t('velocity.latest'),
      },
      ...sprints.map((s) => ({ value: s.id, label: s.name })),
    ],
    [sprints, t],
  );

  function go(next: { endingAt?: string | null; count?: number }) {
    router.push(buildReportHref(pathname, { endingAt, count, ...next }));
  }

  const atMin = count <= VELOCITY_COUNT_LADDER[0];
  const atMax = count >= VELOCITY_COUNT_LADDER[VELOCITY_COUNT_LADDER.length - 1]!;
  const stepClass =
    'inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:text-(--el-text) disabled:opacity-40 disabled:hover:text-(--el-text-secondary) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-(--el-text-secondary)">
          {t('velocity.endingAtLabel')}
        </span>
        <Combobox
          label={t('velocity.endingAtLabel')}
          options={options}
          value={endingAt ?? LATEST}
          onChange={(id) => go({ endingAt: id === LATEST ? null : id })}
          searchable={sprints.length > 6}
          searchPlaceholder={t('velocity.endingAtSearch')}
        />
        <span className="text-xs text-(--el-text-secondary)">{t('velocity.endingAtHint')}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-(--el-text-secondary)">
          {t('velocity.countLabel')}
        </span>
        <div className="inline-flex items-center gap-1 rounded-(--radius-btn) border border-(--el-border) bg-(--el-surface) p-0.5">
          <button
            type="button"
            aria-label={t('velocity.countFewer')}
            disabled={atMin}
            onClick={() => go({ count: stepVelocityCount(count, -1) })}
            className={stepClass}
          >
            <Minus className="h-4 w-4" aria-hidden />
          </button>
          <span
            className="min-w-12 text-center text-[13px] font-medium text-(--el-text)"
            aria-live="polite"
          >
            {count}
          </span>
          <button
            type="button"
            aria-label={t('velocity.countMore')}
            disabled={atMax}
            onClick={() => go({ count: stepVelocityCount(count, 1) })}
            className={stepClass}
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <span className="text-xs text-(--el-text-secondary)">{t('velocity.countHint')}</span>
      </div>
    </div>
  );
}
