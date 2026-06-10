'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Hash } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { EstimationStatisticDto, ParentRollupDto } from '@/lib/dto/estimation';
import { formatStatisticTotal } from '@/lib/estimation/rollupFormat';
import { useEstimationConfig } from './EstimationConfigProvider';

// ParentRollupBadge (Story 4.3 · Subtask 4.3.5) — the epic/parent SUBTREE
// roll-up badge: the SUM of the configured estimation statistic across a
// parent's descendants (`estimationService.rollupForParent`, a bounded
// recursive-CTE aggregate — finding #57, never a load-all + client sum). Drawn
// per `design/estimation/estimation.mock.html` panel 3 (the `.rollup` badge —
// lavender tint + `--el-text-strong`, AA-safe; the muted `—` `is-empty` form
// when no descendant is estimated). It is LABELLED so it is never read as the
// parent's OWN estimate (an epic can have both).
//
// Two variants:
//   • `header`  — the issue-detail header form (`<hash> Story points 34`). The
//                 SERVER page computes the figure and passes `initialTotal`, so
//                 it renders with no fetch / no flash.
//   • `compact` — the list/tree parent-row form (`34 pts`, right-aligned). No
//                 `initialTotal` → it LAZILY fetches `GET /api/work-items/[id]/
//                 rollup` on mount (one bounded aggregate per rendered parent
//                 row — the per-parent shape Jira uses for epic roll-ups).
//
// The statistic comes from `useEstimationConfig` (the surface's provider), so
// the figure formats consistently with the per-issue `EstimateBadge`.

export interface ParentRollupBadgeProps {
  /** The parent work-item id — the `GET /api/work-items/[id]/rollup` target. */
  itemId: string;
  /**
   * The pre-computed subtree total when the surface already has it (the
   * issue-detail header reads it server-side). `undefined` (the prop omitted)
   * switches the badge to the lazy-fetch path; an explicit `number | null` is
   * used directly (`null` = unestimated subtree → the muted `—`).
   */
  initialTotal?: number | null;
  variant: 'header' | 'compact';
  className?: string;
}

const LABEL_KEY: Record<EstimationStatisticDto, 'labelStoryPoints' | 'labelTime' | 'labelIssues'> =
  {
    story_points: 'labelStoryPoints',
    time_estimate: 'labelTime',
    issue_count: 'labelIssues',
  };

export function ParentRollupBadge({
  itemId,
  initialTotal,
  variant,
  className,
}: ParentRollupBadgeProps) {
  const t = useTranslations('estimation.rollup');
  const { estimationStatistic } = useEstimationConfig();

  // `undefined` = not yet known (lazy path, still loading); `number | null` =
  // resolved (a number, or `null`/0 for an unestimated subtree).
  const [total, setTotal] = useState<number | null | undefined>(initialTotal);

  const lazy = initialTotal === undefined;
  useEffect(() => {
    if (!lazy) return;
    let active = true;
    fetch(`/api/work-items/${itemId}/rollup`, { headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`rollup ${res.status}`);
        const data = (await res.json()) as ParentRollupDto;
        if (active) setTotal(data.total);
      })
      .catch(() => {
        // Non-critical decoration — on failure leave it unrendered rather than
        // showing a misleading figure.
        if (active) setTotal(null);
      });
    return () => {
      active = false;
    };
  }, [lazy, itemId]);

  // Still loading the lazy figure → render nothing (the right-aligned cell just
  // fills in; no `—`→number flash).
  if (total === undefined) return null;

  const label = t(LABEL_KEY[estimationStatistic]);
  const empty = total === null || total === 0;
  const valueText = empty ? '—' : formatStatisticTotal(total, estimationStatistic);
  const aria = empty ? t('emptyAria') : t('filledAria', { label, value: valueText });

  const base =
    'inline-flex items-center gap-1.5 rounded-(--radius-badge) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium whitespace-nowrap';
  const tone = empty
    ? 'border border-(--el-border) bg-(--el-surface) text-(--el-text-faint)'
    : 'bg-(--el-tint-lavender) text-(--el-text-strong)';

  return (
    <span className={cn(base, tone, className)} aria-label={aria}>
      {variant === 'header' ? (
        <>
          <Hash className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{label}</span>
          <span className="font-mono font-semibold">{valueText}</span>
        </>
      ) : (
        <>
          <span className="font-mono font-semibold">{valueText}</span>
          {estimationStatistic === 'story_points' ? <span>{t('pts')}</span> : null}
        </>
      )}
    </span>
  );
}
