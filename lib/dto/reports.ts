import type { EstimationStatisticDto } from '@/lib/dto/estimation';

// DTO types for the reports domain (Story 4.6 · Subtask 4.6.4 — velocity). The
// shapes that cross the API boundary for the cross-sprint VELOCITY chart — no
// Prisma row / enum / Decimal leaks (point totals are plain `number`s, the
// statistic enum is a string union). The 4.6.6 sprint-report velocity chart
// binds to these, and Story 6.3 (dashboards) reuses the same shape.
//
// The in-sprint BURNDOWN DTO (`BurndownSeriesDto`) is added by sibling Subtask
// 4.6.3 — it shares this `lib/dto/reports.ts` home but is a distinct read.

/**
 * One completed sprint's velocity datum — a single category on the velocity
 * bar chart's X axis. `committed` is the IMMUTABLE scope-lock baseline stamped
 * by `startSprint` (4.4.2) — the Jira "Committed" line, NOT a live re-sum — and
 * `completed` is the `category = 'done'` roll-up (`rollupForSprint().completed`,
 * 4.3.3 — the same aggregate the scrum header + sprint report show, so the bars
 * match those surfaces). Both are in the project's configured estimation
 * statistic (see `VelocityDto.statistic`). An unestimated sprint contributes 0,
 * never `NaN`.
 */
export interface VelocitySprintDto {
  sprintId: string;
  name: string;
  committed: number;
  completed: number;
}

/**
 * The cross-sprint velocity read (`reportsService.getVelocity`). `sprints` is
 * the last N COMPLETED sprints ordered **oldest → newest** (the X-axis order the
 * chart draws); `averageCompleted` is the mean of `completed` over the returned
 * sprints (the planning forecast — "your average velocity is N"), `0` when there
 * is no history; `statistic` is the configured estimation statistic the bars are
 * measured in (so the UI can label the Y axis + pick the "points" vs "issues"
 * wording).
 *
 * **Low history is a first-class state, not an error:** 0 completed sprints →
 * `{ sprints: [], averageCompleted: 0, statistic }` (the UI renders "not enough
 * history yet"); 1 sprint → a single datum whose `completed` is also the
 * average. The DTO stays total; the UI owns the empty-state copy.
 */
export interface VelocityDto {
  sprints: VelocitySprintDto[];
  averageCompleted: number;
  statistic: EstimationStatisticDto;
}
