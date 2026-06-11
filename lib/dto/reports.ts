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

// ---------------------------------------------------------------------------
// Story 6.3 · Subtask 6.3.2 — the widget / report-page data reads
// ---------------------------------------------------------------------------

/**
 * A widget/report data source — EXACTLY ONE of a project or a 6.2 saved
 * filter (the verified Jira gadget config pattern). Saved filters are
 * project-contained (the 6.2 recorded deviation), so either form resolves to
 * a single project scope; a dashboard aggregates cross-project
 * widget-by-widget, never via a cross-project filter.
 */
export type ReportScopeDto = { projectId: string } | { savedFilterId: string };

/** The period bucket of the created-vs-resolved read (the verified config). */
export type ReportPeriodDto = 'day' | 'week' | 'month';

/**
 * Why a widget read degraded to the STALE state (the 6.1.2 unknown-value
 * precedent — a deleted/broken referent is data, not an error):
 *   `filter_missing`     — the saved filter behind the widget was deleted
 *                          (or is invisible to the viewer — finding #44, the
 *                          two are indistinguishable by design), the 6.2.2
 *                          "filter missing" card.
 *   `filter_invalid`     — the stored envelope no longer decodes/validates
 *                          (malformed / future-versioned), the degraded
 *                          astError state 6.2.1 records.
 *   `statistic_missing`  — a distribution's `cf:<id>` statistic references a
 *                          deleted (or out-of-project) custom field.
 */
export type ReportStaleReasonDto = 'filter_missing' | 'filter_invalid' | 'statistic_missing';

/**
 * The per-viewer result envelope EVERY widget/report read returns (Subtask
 * 6.3.2). `no_access` is the 6.4 per-VIEWER gate — the scoped project (or
 * the filter's project) is one the REQUESTING user may not browse, so the
 * widget renders the designed locked state with NO counts, rows, or chart
 * shapes (the mirror behaviour: a gadget shows only what the viewer can
 * see). A missing project collapses into `no_access` (no existence leak —
 * finding #44). `stale` is the degraded-referent family above. Both are
 * 200-level DATA states (one broken widget never errors the dashboard);
 * malformed CONFIG (bad scope/window/statistic) is the typed 422 instead.
 */
export type ReportWidgetResultDto<T> =
  | { state: 'ok'; data: T }
  | { state: 'no_access' }
  | { state: 'stale'; reason: ReportStaleReasonDto };

/** One X-axis bucket of the created-vs-resolved chart. `resolved` is the NET
 * count (a reopen inside the window subtracts), so it can be negative on a
 * reopen-heavy bucket of the non-cumulative series. */
export interface CreatedVsResolvedBucketDto {
  /** The bucket's UTC start day, `YYYY-MM-DD` (`date_trunc` semantics —
   * weeks start on the ISO Monday, months on the 1st). */
  date: string;
  created: number;
  resolved: number;
}

/**
 * The created-vs-resolved read (`reportsService.getCreatedVsResolved`) — the
 * two-series difference/area chart's data. `created` buckets `createdAt`;
 * `resolved` buckets NET transitions into a done-CATEGORY status derived
 * from the 1.4.6 revision trail (the recorded deviation: our "resolution" IS
 * the done category — the SAME predicate the burndown/velocity/rollups use).
 * `buckets` is the FULL axis (event-less buckets present at 0), oldest →
 * newest; with `cumulative` the two series are running-summed within the
 * window server-side.
 */
export interface CreatedVsResolvedDto {
  period: ReportPeriodDto;
  daysBack: number;
  cumulative: boolean;
  /** Window start (ISO 8601, UTC midnight `daysBack - 1` days before `end`). */
  windowStart: string;
  /** Window end (ISO 8601 — the read instant). */
  windowEnd: string;
  buckets: CreatedVsResolvedBucketDto[];
}

/** One donut segment. A NULL `id` is the "None" bucket (unassigned / no
 * sprint / no label / no value — the designed None segment); `label` is the
 * referent's display name where one exists (status label, member/sprint/
 * label/component/option name) and null for self-describing enum ids
 * (kind / priority), which the UI translates. */
export interface DistributionSegmentDto {
  id: string | null;
  label: string | null;
  count: number;
  /** Percentage of the segment-count total, rounded to one decimal — the
   * legend's figure (sums to 100 ± rounding). */
  percentage: number;
}

/**
 * The distribution read (`reportsService.getDistribution`) — the donut's
 * data. ONE bounded GROUP-BY over the scoped items (finding #57), through
 * the TOTAL statistic-type registry (`lib/reports/statisticTypes.ts`).
 * Segments come back count-descending. NOTE the join-backed statistics
 * (label / component) count an item once PER join row (the verified Jira
 * multi-count behaviour), so `total` is the segment-count total — the
 * percentage denominator — not necessarily the item count.
 */
export interface DistributionDto {
  /** The statistic id (`status`, `assignee`, …, or `cf:<fieldId>`). */
  statistic: string;
  total: number;
  segments: DistributionSegmentDto[];
}
