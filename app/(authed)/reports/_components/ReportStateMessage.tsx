'use client';

import { Lock, FilterX, BarChart3 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import type { ReportStaleReasonDto } from '@/lib/dto/reports';

// The degraded / empty states shared by both report pages (Story 6.3 · 6.3.6),
// per design/reports/dashboard.mock.html panel 7 + the widget-state vocabulary
// (panel 5). One broken scope never breaks the page — it renders one of these:
//   • no_access — the 6.4 per-VIEWER gate (a filter/project the viewer can't
//     browse): a LOCKED card, no counts or chart shape leaked.
//   • stale (filter_missing | filter_invalid) — the INHERITED 6.2.2 "filter
//     missing" card + a Reset-to-project affordance (the in-page reconfigure).
//   • stale (statistic_missing) — a deleted custom-field statistic.
//   • empty — a valid scope with zero matching issues in the window.

export type ReportMessageKind =
  | { kind: 'no_access' }
  | { kind: 'stale'; reason: ReportStaleReasonDto }
  | { kind: 'empty' };

export function ReportStateMessage({
  state,
  onReset,
}: {
  state: ReportMessageKind;
  /** Reset the scope back to the active project (the stale-filter recovery). */
  onReset?: () => void;
}) {
  const t = useTranslations('reports');

  if (state.kind === 'no_access') {
    return (
      <EmptyState
        icon={<Lock className="h-12 w-12" aria-hidden />}
        title={t('states.noAccessTitle')}
        description={t('states.noAccessBody')}
      />
    );
  }

  if (state.kind === 'empty') {
    return (
      <EmptyState
        icon={<BarChart3 className="h-12 w-12" aria-hidden />}
        title={t('states.emptyTitle')}
        description={t('states.emptyBody')}
      />
    );
  }

  // stale
  const isStatistic = state.reason === 'statistic_missing';
  return (
    <EmptyState
      icon={<FilterX className="h-12 w-12" aria-hidden />}
      title={isStatistic ? t('states.staleStatisticTitle') : t('states.staleFilterTitle')}
      description={isStatistic ? t('states.staleStatisticBody') : t('states.staleFilterBody')}
      action={
        onReset ? (
          <Button variant="secondary" onClick={onReset}>
            {t('states.resetToProject')}
          </Button>
        ) : undefined
      }
    />
  );
}
