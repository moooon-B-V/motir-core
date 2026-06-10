import type { EstimationStatisticDto } from '@/lib/dto/estimation';
import { formatStoryPoints } from '@/lib/estimation/scales';
import { formatDurationMinutes } from '@/lib/utils/duration';

// Statistic-aware roll-up / sprint-points formatting (Story 4.3 · Subtask 4.3.5).
// The bounded aggregates `rollupForSprint` / `rollupForParent` (4.3.3) already
// SUM the field the project's configured statistic selects — story points
// (`SUM(storyPoints)`), time (`SUM(estimateMinutes)`), or issue count
// (`COUNT(*)`). The roll-up DISPLAYS (sprint committed-points, epic/parent
// subtree badge) reuse THAT statistic to format the number consistently with the
// per-issue badge: story points as a plain trimmed number (`5`, `34`, `0.5`),
// time as a duration (`5h 40m` — the value is minutes), issue count as the plain
// integer. The "—" / empty presentation stays the component's concern (the DTO
// is always a total; finding #57 keeps the figure a bounded aggregate, never a
// client sum of loaded rows).

/**
 * Format a roll-up total for display under the project's estimation statistic.
 * `value` is the already-summed aggregate (points, minutes, or a count); the
 * statistic decides how it reads. Callers own the unestimated "—" branch (this
 * only formats a real number).
 */
export function formatStatisticTotal(value: number, statistic: EstimationStatisticDto): string {
  switch (statistic) {
    case 'time_estimate':
      return formatDurationMinutes(value);
    case 'issue_count':
      return String(value);
    case 'story_points':
    default:
      return formatStoryPoints(value);
  }
}
