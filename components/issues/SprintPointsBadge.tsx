'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import type { SprintPointsDto } from '@/lib/dto/estimation';
import type { SprintStateDto } from '@/lib/dto/sprints';
import { formatStatisticTotal } from '@/lib/estimation/rollupFormat';
import { useEstimationConfig } from './EstimationConfigProvider';

// SprintPointsBadge (Story 4.3 · Subtask 4.3.5) — the sprint committed-points
// roll-up that FILLS the Story-4.2 backlog sprint-container header slot, drawn
// per `design/estimation/estimation.mock.html` panel 4 (the `.committed`
// segments — committed · done · left). It UPGRADES the committed-only figure
// Subtask 4.4.9 stopgapped into the seam (finding #69) to the full display the
// design specifies. PRESENTATIONAL: it takes the `SprintPointsDto` already read
// by the shared `useSprintPoints` hook (`GET /api/sprints/[id]/points` →
// `estimationService.rollupForSprint`, the bounded grouped aggregate — finding
// #57, never a client sum of loaded rows; the SUM lives in ONE place, also
// behind the scrum header via Story 4.5.2), so there is no second fetch.
//
// Presentation (matching the mock):
//   • a null read (loading / failed) or a wholly UNESTIMATED sprint
//     (committed = 0) → a muted `—` committed only (never `NaN`);
//   • a PLANNED sprint (no work done yet) → the committed figure only;
//   • an ACTIVE / COMPLETE sprint → committed · done (`category = 'done'` subset,
//     `--el-success`) · left (remaining).
// The values format under the project's configured statistic (the same
// `useEstimationConfig` the inline badge reads), so points / time / count read
// consistently across the surface.

export interface SprintPointsBadgeProps {
  /** The sprint's bounded points roll-up (from `useSprintPoints`); `null` while
   *  loading or after a failed read — the badge renders the muted `—`. */
  points: SprintPointsDto | null;
  state: SprintStateDto;
  className?: string;
}

export function SprintPointsBadge({ points, state, className }: SprintPointsBadgeProps) {
  const t = useTranslations('estimation.sprintPoints');
  const { estimationStatistic } = useEstimationConfig();

  const fmt = (n: number) => formatStatisticTotal(n, estimationStatistic);
  const container = cn(
    'inline-flex items-center gap-2 font-mono text-xs text-(--el-text-secondary)',
    className,
  );

  // Coerce the read defensively: a null/failed/partial points read degrades to
  // the muted "—" rather than rendering `NaN` (mirrors the resilience the 4.4.9
  // committed-only span had via `?? 0`). Only a finite committed > 0 shows real
  // figures.
  const committed = points && Number.isFinite(points.committed) ? points.committed : null;
  const completed = points && Number.isFinite(points.completed) ? points.completed : 0;
  const remaining = points && Number.isFinite(points.remaining) ? points.remaining : 0;

  // Unestimated (or not yet loaded) → a muted `—` committed only (never NaN).
  if (committed === null || committed === 0) {
    return (
      <span className={container} aria-label={t('emptyAria')}>
        <Segment value="—" cap={t('committed')} faint />
      </span>
    );
  }

  // Planned sprint → committed only (no work done yet, per the design).
  if (state === 'planned') {
    return (
      <span className={container} aria-label={t('committedAria', { committed: fmt(committed) })}>
        <Segment value={fmt(committed)} cap={t('committed')} />
      </span>
    );
  }

  // Active / complete → committed · done · left.
  return (
    <span
      className={container}
      aria-label={t('filledAria', {
        committed: fmt(committed),
        completed: fmt(completed),
        remaining: fmt(remaining),
      })}
    >
      <Segment value={fmt(committed)} cap={t('committed')} />
      <span className="text-(--el-text-faint)">·</span>
      <Segment value={fmt(completed)} cap={t('done')} done />
      <span className="text-(--el-text-faint)">·</span>
      <Segment value={fmt(remaining)} cap={t('left')} />
    </span>
  );
}

function Segment({
  value,
  cap,
  done,
  faint,
}: {
  value: string;
  cap: string;
  done?: boolean;
  faint?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={cn(
          'font-semibold',
          done
            ? 'text-(--el-success)'
            : faint
              ? 'text-(--el-text-faint)'
              : 'text-(--el-text-strong)',
        )}
      >
        {value}
      </span>
      <span className="font-sans text-(--el-text-faint)">{cap}</span>
    </span>
  );
}
