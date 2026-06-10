import type { EstimationStatistic, Sprint } from '@prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { estimationService } from '@/lib/services/estimationService';
import { toVelocityDto } from '@/lib/mappers/reportsMappers';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { EstimationStatisticDto } from '@/lib/dto/estimation';
import type { VelocityDto, VelocitySprintDto } from '@/lib/dto/reports';

// Reports service (Story 4.6) — the read-only analytics layer over the data
// Stories 4.1 / 4.3 / 4.4 already ship: NO new write model, NO migration. It is
// the home Epic 6.3 (dashboards & reports) extends. This subtask (4.6.4) adds
// the cross-sprint VELOCITY aggregate; sibling 4.6.3 adds the in-sprint burndown
// (`getBurndownSeries`) to this same service.
//
// 4-layer (CLAUDE.md): reads only, so no transaction — the service composes
// bounded repository reads + the shipped `estimationService.rollupForSprint`
// aggregate, and maps to a DTO via `reportsMappers`. Repositories stay single-op
// leaves; the route is a thin HTTP transport.
//
// TENANCY (finding #26): every path carries an explicit `workspaceId` — the
// project is gated by id + workspaceId (a cross-workspace project is an
// indistinguishable 404), and the underlying `rollupForSprint` / sprint reads
// each carry the same gate. BOUNDED (finding #57): velocity is a `LIMIT N`
// sprint read + N (≤ MAX_LAST_N) bounded roll-ups — never an all-sprints or
// all-issues scan.

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
 * (the project's own tenancy gate already ran in the caller).
 */
async function resolveStatistic(projectId: string): Promise<EstimationStatistic> {
  const config = await projectRepository.findEstimationConfig(projectId);
  return config?.estimationStatistic ?? 'story_points';
}
