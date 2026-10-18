'use client';

import { useTranslations } from 'next-intl';
import { Minus, Plus } from 'lucide-react';
import type { ReportPeriodDto } from '@/lib/dto/reports';
import {
  clampDaysBack,
  daysBackLadder,
  stepDaysBack,
  PERIOD_LABEL_KEY,
} from '@/lib/reports/reportPageView';
import { Segmented } from '@/components/ui/Segmented';

// The Period segmented control and the Days-back stepper (Story MOTIR-8919),
// lifted from `AverageAgeReport` with the same markup and the same i18n keys, so
// Workload's window controls look and move exactly like Average age's. A period
// change clamps days back to that period's ladder, so the pair can never name a
// window the read would 422.

export function ReportWindowControls({
  period,
  daysBack,
  onChange,
}: {
  period: ReportPeriodDto;
  daysBack: number;
  onChange: (next: { period?: ReportPeriodDto; daysBack?: number }) => void;
}) {
  const t = useTranslations('reports');
  const ladder = daysBackLadder(period);
  const atMin = daysBack <= ladder[0]!;
  const atMax = daysBack >= ladder[ladder.length - 1]!;

  return (
    <>
      <Field label={t('controls.periodLabel')}>
        <Segmented
          label={t('controls.periodLabel')}
          value={period}
          onChange={(p) => onChange({ period: p, daysBack: clampDaysBack(p, daysBack) })}
          options={(['day', 'week', 'month'] as const).map((p) => ({
            value: p,
            label: t(PERIOD_LABEL_KEY[p]),
          }))}
        />
      </Field>
      <Field label={t('controls.daysBackLabel')}>
        <div className="inline-flex items-center gap-1 rounded-(--radius-btn) border border-(--el-border) bg-(--el-surface) p-0.5">
          <button
            type="button"
            aria-label={t('controls.daysBackFewer')}
            disabled={atMin}
            onClick={() => onChange({ daysBack: stepDaysBack(period, daysBack, -1) })}
            className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:text-(--el-text) disabled:opacity-40 disabled:hover:text-(--el-text-secondary) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            <Minus className="h-4 w-4" aria-hidden />
          </button>
          <span
            className="min-w-12 text-center text-[13px] font-medium text-(--el-text)"
            aria-live="polite"
          >
            {t('cvr.daysBackValue', { days: daysBack })}
          </span>
          <button
            type="button"
            aria-label={t('controls.daysBackMore')}
            disabled={atMax}
            onClick={() => onChange({ daysBack: stepDaysBack(period, daysBack, 1) })}
            className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:text-(--el-text) disabled:opacity-40 disabled:hover:text-(--el-text-secondary) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </Field>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-(--el-text-muted)">{label}</span>
      {children}
    </div>
  );
}
