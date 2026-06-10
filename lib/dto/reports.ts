import type { EstimationStatisticDto } from '@/lib/dto/estimation';

// DTO types for the reports domain (Story 4.6). The shapes that cross the API
// boundary for the iteration-measurement charts — no Prisma row / enum / Decimal
// leaks (point totals are plain `number`s, the statistic enum is a string union).
// Story 6.3 (dashboards & reports) reuses these shapes.
//
// This file is the shared `reports` DTO home: Subtask 4.6.4 added the cross-sprint
// VELOCITY read (`VelocityDto` / `VelocitySprintDto`); Subtask 4.6.3 added the
// in-sprint BURNDOWN read (`BurndownSeriesDto`). The two are distinct reads
// sharing one module.

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

/**
 * Which statistic the burndown series is measured in. The burndown supports
 * only `story_points` (the `committedPoints` baseline + the `storyPoints`
 * per-issue deltas) and `issue_count` (the `committedIssueCount` baseline +
 * 1-per-issue deltas) — the two figures `startSprint` (4.4.2) actually
 * snapshots. A project configured for `time_estimate`, or a sprint with no
 * committed point data (wholly unestimated), degrades to the `issue_count`
 * series (there is no committed-time baseline to anchor a time burndown — a
 * future refinement when a committed-minutes snapshot lands). So the wire form
 * narrows the three-value `EstimationStatisticDto` to the two the chart can
 * draw — the UI labels the Y axis ("points" vs "issues") off this.
 */
export type BurndownStatisticDto = 'story_points' | 'issue_count';

/**
 * One calendar day on the burndown's X axis. `guideline` is the ideal-line value
 * for the day (a straight descent from the committed baseline at the sprint's
 * first day to 0 at its last). `remaining` is the ACTUAL remaining reconstructed
 * from the 1.4.6 revision trail — `null` for days AFTER the actual cutoff (the
 * future days of a live sprint, or days past `completedAt`), so the chart draws
 * the actual line only up to "today" / completion and leaves the rest to the
 * guideline.
 */
export interface BurndownDayDto {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  guideline: number;
  remaining: number | null;
}

/**
 * A mid-sprint scope change the chart marks on the actual line — a day on which
 * issues were added to (`delta > 0`) or removed from (`delta < 0`) the sprint
 * after it started, measured in the series statistic. The burndown's actual line
 * RISES on a positive-delta day and DROPS on a negative one (distinct from a
 * completion drop). One entry per day that had a net scope change.
 */
export interface BurndownScopeChangeDto {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  delta: number;
}

/**
 * The in-sprint burndown read (`reportsService.getBurndownSeries`). A pure read
 * over data Stories 4.1 / 4.3 / 4.4 / 1.4.6 already ship — NO new write model,
 * NO migration.
 *
 * `committed` is the t=0 baseline (the immutable `startSprint` snapshot in the
 * `statistic`); `days` is one row per calendar day from `startDate` to the axis
 * end (the guideline spans them all; the actual line stops at the cutoff with
 * `null`s after); `scopeChanges` are the mid-sprint add/remove markers. The
 * end-of-actual value reconciles with `estimationService.rollupForSprint(...)
 * .remaining` (4.3.3 — the SAME `category = 'done'` predicate), so the chart and
 * the numeric remaining the scrum header / sprint report show always agree.
 *
 * Degraded / edge states are first-class (never `NaN` / a broken axis): a wholly
 * unestimated sprint comes back as the `issue_count` series; an empty sprint as a
 * flat guideline at 0. A planned (not-started) sprint is rejected upstream
 * (`SprintNotStartedError`) — it has no window to draw.
 */
export interface BurndownSeriesDto {
  sprintId: string;
  /** `active` (actual drawn to "today") or `complete` (drawn to `completedAt`). */
  state: 'active' | 'complete';
  statistic: BurndownStatisticDto;
  committed: number;
  /** Sprint window start (ISO 8601). */
  startDate: string;
  /** Burndown axis end (ISO 8601) — the planned `endDate`, else `completedAt`/now. */
  endDate: string;
  days: BurndownDayDto[];
  scopeChanges: BurndownScopeChangeDto[];
}
