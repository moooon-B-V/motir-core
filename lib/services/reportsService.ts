import type { EstimationStatistic, Sprint } from '@prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { estimationService } from '@/lib/services/estimationService';
import { toBurndownSeriesDto, toVelocityDto } from '@/lib/mappers/reportsMappers';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { SprintNotFoundError, SprintNotStartedError } from '@/lib/sprints/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { EstimationStatisticDto } from '@/lib/dto/estimation';
import type {
  BurndownSeriesDto,
  BurndownStatisticDto,
  VelocityDto,
  VelocitySprintDto,
} from '@/lib/dto/reports';

// Reports service (Story 4.6) — the read-only analytics layer over the data
// Stories 4.1 / 4.3 / 4.4 / 1.4.6 already ship: NO new write model, NO
// migration. It is the home Epic 6.3 (dashboards & reports) extends. Subtask
// 4.6.4 added the cross-sprint VELOCITY aggregate (`getVelocity`); Subtask 4.6.3
// added the in-sprint BURNDOWN (`getBurndownSeries`) to this same service.
//
// 4-layer (CLAUDE.md): reads only, so no transaction — the service composes
// bounded repository reads + the shipped `estimationService.rollupForSprint`
// aggregate, and maps to a DTO via `reportsMappers`. Repositories stay single-op
// leaves; the route is a thin HTTP transport.
//
// TENANCY (finding #26): every path carries an explicit `workspaceId` — the
// project / sprint is gated by id + workspaceId (a cross-workspace entity is an
// indistinguishable 404), and the underlying `rollupForSprint` / sprint /
// revision reads each carry the same gate. BOUNDED (finding #57): velocity is a
// `LIMIT N` sprint read + N (≤ MAX_LAST_N) bounded roll-ups; the burndown is a
// grouped per-day aggregate over the revision rows scoped to the sprint window —
// neither loads an all-sprints / all-issues / all-revisions row set.

/** Jira's default velocity window — the last 7 completed sprints. */
const DEFAULT_LAST_N = 7;
/**
 * Upper bound on the velocity window. Keeps the bounded fan-out bounded even if
 * a caller passes a large `lastN` (one rollup query per returned sprint). 52 ≈ a
 * year of weekly sprints — generous for the forecast while still O(1)-ish.
 */
const MAX_LAST_N = 52;

export const reportsService = {
  /**
   * The cross-sprint VELOCITY aggregate (Story 4.6.4) — the planning forecast.
   * Returns the last `lastN` COMPLETED sprints (oldest→newest for the X axis),
   * each with its IMMUTABLE committed baseline (`startSprint`, 4.4.2 — the Jira
   * "Committed" line, NOT a live re-sum) and its `category = 'done'` completed
   * roll-up (`rollupForSprint().completed`, 4.3.3 — the SAME aggregate the scrum
   * header + sprint report show, so the bars match those surfaces), plus the
   * average completed across the window.
   *
   * Bounded (finding #57): a `LIMIT N` sprint query + N (≤ {@link MAX_LAST_N})
   * bounded roll-ups — never every sprint, never every issue. Low-history is a
   * first-class state: 0 completed sprints → `{ sprints: [], averageCompleted:
   * 0 }`; 1 sprint → a single datum whose `completed` is the average.
   * Unestimated sprints contribute 0, never `NaN`.
   *
   * Throws: `ProjectNotFoundError` (404 — unknown / cross-workspace project).
   */
  async getVelocity(
    input: { projectId: string; lastN?: number },
    ctx: ServiceContext,
  ): Promise<VelocityDto> {
    // Tenancy gate (finding #26): a missing / cross-workspace project is an
    // indistinguishable 404. Mirrors `estimationService.getEstimationConfig`.
    const project = await projectRepository.findById(input.projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(input.projectId);
    }

    const limit = clampLastN(input.lastN);
    // The configured statistic, resolved ONCE for the project (the same default
    // `rollupForSprint` uses); picks which committed baseline column to read and
    // labels the chart's Y axis.
    const statistic = await resolveStatistic(input.projectId);

    // Bounded read: the last N completed sprints, newest first (LIMIT N).
    const sprints = await sprintRepository.listCompletedByProject(
      input.projectId,
      ctx.workspaceId,
      limit,
    );

    // Per sprint: committed = the O(1) stored baseline; completed = the bounded
    // 4.3.3 done-category roll-up. A bounded fan-out of N (≤ MAX_LAST_N) reads,
    // never an all-issues scan. Reads are independent → run them concurrently.
    const data: VelocitySprintDto[] = await Promise.all(
      sprints.map(async (sprint) => {
        const rollup = await estimationService.rollupForSprint(sprint.id, ctx);
        return {
          sprintId: sprint.id,
          name: sprint.name,
          committed: committedBaseline(sprint, statistic),
          completed: rollup.completed,
        };
      }),
    );

    // The read was newest-first (for the LIMIT); the chart's X axis runs
    // oldest→newest, so reverse before mapping.
    data.reverse();
    return toVelocityDto(data, statistic as EstimationStatisticDto);
  },

  /**
   * The in-sprint BURNDOWN series (Story 4.6.3) — the analytics view of how fast
   * the committed work is being completed. Returns, for a started sprint, the
   * GUIDELINE (the ideal straight descent from the committed baseline to 0 over
   * the sprint window) and the ACTUAL stepped remaining line, reconstructed from
   * the immutable 4.4.2 committed baseline + the 1.4.6 `work_item_revision`
   * trail (completions burn it down, scope-adds + reopens raise it), plus the
   * mid-sprint scope-change markers.
   *
   * The actual line's end-of-series value reconciles with
   * `estimationService.rollupForSprint().remaining` (4.3.3 — the SAME `category
   * = 'done'` predicate) — pinned to it for the points / issue-count series so
   * the chart never disagrees with the numeric remaining the scrum header +
   * sprint report show.
   *
   * Statistic: the project's configured estimation statistic, narrowed to what
   * `startSprint` actually snapshots — `story_points` (the `committedPoints`
   * baseline) when there IS point data, else `issue_count` (the
   * `committedIssueCount` baseline). A `time_estimate` project, or a wholly
   * unestimated sprint, degrades to the issue-count series, never `NaN`; an empty
   * sprint is a flat guideline at 0.
   *
   * Bounded (finding #57): one grouped per-day `$queryRaw` over the revision rows
   * + one O(1) baseline read + one bounded roll-up — never an all-revisions or
   * all-issues load. The day count is bounded by the sprint length.
   *
   * Throws: `SprintNotFoundError` (404 — unknown / cross-workspace sprint);
   * `SprintNotStartedError` (409 — a planned sprint has no window to draw).
   */
  async getBurndownSeries(sprintId: string, ctx: ServiceContext): Promise<BurndownSeriesDto> {
    // Tenancy gate (finding #26): a missing / cross-workspace sprint is an
    // indistinguishable 404. Mirrors `estimationService.rollupForSprint`.
    const sprint = await sprintRepository.findById(sprintId, ctx.workspaceId);
    if (!sprint) throw new SprintNotFoundError(sprintId);

    // A burndown needs a window: reject a not-yet-started (planned) sprint rather
    // than draw an empty axis (Jira shows none for a future sprint).
    if (sprint.state === 'planned' || sprint.startDate === null) {
      throw new SprintNotStartedError(sprintId);
    }
    const start = sprint.startDate;

    // The configured statistic (the same default `rollupForSprint` resolves),
    // narrowed to what the sprint actually snapshotted at start.
    const projectStatistic = await resolveStatistic(sprint.projectId);
    const committedPoints = sprint.committedPoints === null ? null : Number(sprint.committedPoints);
    // Points burndown only when the project measures points AND the sprint locked
    // a non-zero point baseline; otherwise (issue-count project, time-estimate
    // project — no committed-time snapshot exists — or a wholly unestimated
    // sprint) the issue-count series.
    const useCount =
      projectStatistic !== 'story_points' || committedPoints === null || committedPoints === 0;
    const statistic: BurndownStatisticDto = useCount ? 'issue_count' : 'story_points';
    const committed = useCount ? (sprint.committedIssueCount ?? 0) : (committedPoints ?? 0);

    // Window. The axis ends at the planned end (else completedAt, else now); the
    // ACTUAL line is drawn to completedAt (complete) or now (active). The axis
    // always covers the drawn actual (an overran active sprint extends it).
    const now = new Date();
    const rawAxisEnd = sprint.endDate ?? sprint.completedAt ?? now;
    const actualCutoff = sprint.state === 'complete' ? (sprint.completedAt ?? rawAxisEnd) : now;
    const axisEnd = new Date(
      Math.max(rawAxisEnd.getTime(), actualCutoff.getTime(), start.getTime()),
    );

    // The bounded per-day deltas (finding #57) — events up to the actual cutoff.
    const dailyDeltas = await workItemRevisionRepository.aggregateSprintBurndownByDay(
      sprintId,
      ctx.workspaceId,
      { start, end: actualCutoff },
      useCount,
    );

    // The authoritative present remaining (4.3.3). Anchor the last drawn actual
    // point to it ONLY when the burndown is measured in the same unit as the
    // roll-up (a degraded issue-count series over a points/time project must not
    // be pinned to a points/minutes figure).
    const rollup = await estimationService.rollupForSprint(sprintId, ctx);
    const anchorRemaining = statistic === projectStatistic ? rollup.remaining : null;

    return toBurndownSeriesDto({
      sprintId,
      state: sprint.state as 'active' | 'complete',
      statistic,
      committed,
      start,
      axisEnd,
      actualCutoff,
      dailyDeltas,
      anchorRemaining,
    });
  },
};

/**
 * Resolve a sprint's committed baseline in the configured statistic. The
 * scope-lock snapshot (`startSprint`, 4.4.2) stores TWO immutable figures —
 * `committedIssueCount` and `committedPoints` (a story-point sum):
 *   • `issue_count`  → `committedIssueCount`
 *   • `story_points` → `committedPoints`
 *   • `time_estimate`→ `committedPoints` (best available — there is no committed
 *     time snapshot; a `committedMinutes` baseline would need a migration, which
 *     Story 4.6 deliberately does NOT add. Documented as a future refinement.)
 * A not-yet-stamped baseline (defensive — a completed sprint always has one)
 * reads as 0, never `NaN`.
 */
function committedBaseline(sprint: Sprint, statistic: EstimationStatistic): number {
  if (statistic === 'issue_count') return sprint.committedIssueCount ?? 0;
  return sprint.committedPoints === null ? 0 : Number(sprint.committedPoints);
}

/**
 * Clamp the requested window to `[1, MAX_LAST_N]`, defaulting a missing /
 * non-finite / non-positive value to {@link DEFAULT_LAST_N}. Keeps the bounded
 * fan-out bounded regardless of caller input (a bad `?lastN=` never errors — it
 * falls back to the sensible default).
 */
function clampLastN(lastN: number | undefined): number {
  if (lastN === undefined || !Number.isFinite(lastN) || lastN < 1) return DEFAULT_LAST_N;
  return Math.min(Math.floor(lastN), MAX_LAST_N);
}

/**
 * Resolve a project's configured estimation statistic, defaulting to
 * `story_points` when (somehow) no config row exists — the same resolution
 * `estimationService`'s roll-ups use, kept here as a read-only reference lookup
 * (the project's / sprint's own tenancy gate already ran in the caller).
 */
async function resolveStatistic(projectId: string): Promise<EstimationStatistic> {
  const config = await projectRepository.findEstimationConfig(projectId);
  return config?.estimationStatistic ?? 'story_points';
}
