import type { EstimationStatistic, Sprint } from '@prisma/client';
import { customFieldDefinitionRepository } from '@/lib/repositories/customFieldDefinitionRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { savedFilterRepository } from '@/lib/repositories/savedFilterRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { estimationService } from '@/lib/services/estimationService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { loadFilterReferents, workItemsService } from '@/lib/services/workItemsService';
import {
  toAverageAgeDto,
  toBurndownSeriesDto,
  toCreatedVsResolvedDto,
  toDistributionDto,
  toResolutionTimeDto,
  toVelocityDto,
  toWorkloadDto,
} from '@/lib/mappers/reportsMappers';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { SavedFilterNotFoundError } from '@/lib/savedFilters/errors';
import { SprintNotFoundError, SprintNotStartedError } from '@/lib/sprints/errors';
import { UnknownStatisticTypeError } from '@/lib/reports/errors';
import {
  isDistributionCfFieldType,
  parseStatisticType,
  type DistributionGroupBy,
} from '@/lib/reports/statisticTypes';
import {
  bucketAxis,
  bucketEnds,
  reportWindow,
  validateReportWindow,
  type ReportPeriod,
} from '@/lib/reports/buckets';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import type { FilterAst } from '@/lib/filters/ast';
import type { ProjectFilterReferents } from '@/lib/filters/registry';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { EstimationStatisticDto } from '@/lib/dto/estimation';
import type { PagedIssueListDto } from '@/lib/dto/workItems';
import type {
  AverageAgeDto,
  BurndownSeriesDto,
  BurndownStatisticDto,
  CreatedVsResolvedDto,
  DistributionDto,
  ReportScopeDto,
  ReportWidgetResultDto,
  ResolutionTimeDto,
  VelocityDto,
  VelocitySprintDto,
  WorkloadDto,
  WorkloadMeasureDto,
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

  /**
   * The CREATED-VS-RESOLVED read (Story 6.3 · Subtask 6.3.2) — the two-series
   * difference/area chart behind the report page (6.3.6) and the dashboard
   * widget (6.3.5). Scope = a project or a 6.2 saved filter (the verified
   * gadget pattern; resolved per-VIEWER — see {@link resolveReportScope}).
   * The CREATED series buckets `createdAt`; the RESOLVED series is the NET
   * count of transitions into a `done`-CATEGORY status derived from the
   * 1.4.6 revision trail in ONE bounded grouped query (the 4.6.3 pattern —
   * a reopen inside the window subtracts; the recorded deviation: our
   * "resolution" IS the done category, the SAME predicate the burndown /
   * velocity / rollups use). The bucket axis is generated in full (event-less
   * buckets at 0); `cumulative` running-sums both series within the window
   * server-side.
   *
   * Bounded (finding #57): two grouped aggregates over a validated window
   * (≤ 366 days, ≤ 120 buckets — `InvalidReportWindowError` → 422 beyond).
   * Degraded scopes return the typed widget states, never partial data.
   */
  async getCreatedVsResolved(
    scope: ReportScopeDto,
    config: { period: ReportPeriod; daysBack: number; cumulative: boolean },
    ctx: ServiceContext,
  ): Promise<ReportWidgetResultDto<CreatedVsResolvedDto>> {
    // Config validation FIRST (a malformed window is a 422 regardless of
    // scope state — it leaks nothing and the widget editor needs the error).
    validateReportWindow(config.period, config.daysBack);

    const resolved = await resolveReportScope(scope, ctx);
    if (resolved.state !== 'ok') return resolved;

    const { start, end } = reportWindow(new Date(), config.daysBack);
    const axis = bucketAxis(config.period, start, end);
    const filter = await scopeAstFilter(resolved, ctx);
    const [created, resolvedRows] = await Promise.all([
      workItemRepository.aggregateCreatedByBucket(
        resolved.projectId,
        ctx.workspaceId,
        config.period,
        { start, end },
        filter,
      ),
      workItemRevisionRepository.aggregateNetResolvedByBucket(
        resolved.projectId,
        ctx.workspaceId,
        config.period,
        { start, end },
        filter,
      ),
    ]);

    return {
      state: 'ok',
      data: toCreatedVsResolvedDto({
        period: config.period,
        daysBack: config.daysBack,
        cumulative: config.cumulative,
        windowStart: start,
        windowEnd: end,
        axis,
        created,
        resolved: resolvedRows,
      }),
    };
  },

  /**
   * The AVERAGE-AGE read (Story 8.8 · Subtask 8.8.13) — the point-in-time
   * vertical-bar report behind `/reports/average-age` (and the `average_age`
   * dashboard gadget). For each period bucket's END instant (capped at "now"),
   * the average age in days of issues created by then and not yet resolved at
   * that instant, reconstructed from the 1.4.6 revision trail (the SAME
   * done-category predicate every report uses). Same scope / window / typed-state
   * contract as {@link getCreatedVsResolved}: a malformed window is the typed 422
   * (regardless of scope), a degraded scope returns `no_access` / `stale`.
   * Bounded (finding #57): one grouped point-in-time query over a validated
   * window (≤ 120 buckets).
   */
  async getAverageAge(
    scope: ReportScopeDto,
    config: { period: ReportPeriod; daysBack: number },
    ctx: ServiceContext,
  ): Promise<ReportWidgetResultDto<AverageAgeDto>> {
    validateReportWindow(config.period, config.daysBack);

    const resolved = await resolveReportScope(scope, ctx);
    if (resolved.state !== 'ok') return resolved;

    const { start, end } = reportWindow(new Date(), config.daysBack);
    const axis = bucketAxis(config.period, start, end);
    const ends = bucketEnds(config.period, axis, end);
    const filter = await scopeAstFilter(resolved, ctx);
    const rows = await workItemRevisionRepository.aggregateAverageAgeByBucket(
      resolved.projectId,
      ctx.workspaceId,
      axis.map((key, i) => ({ key, end: ends[i]! })),
      filter,
    );

    return {
      state: 'ok',
      data: toAverageAgeDto({
        period: config.period,
        daysBack: config.daysBack,
        windowStart: start,
        windowEnd: end,
        axis,
        rows,
      }),
    };
  },

  /**
   * The RESOLUTION-TIME read (Story 8.8 · Subtask 8.8.13) — the vertical-bar
   * report behind `/reports/resolution-time` (and the `resolution_time` gadget).
   * Per period bucket keyed by RESOLUTION date, the average days-to-resolve over
   * issues that entered a done-category status in that period (the 1.4.6 trail;
   * same done predicate as every report). Same scope / window / typed-state
   * contract as {@link getCreatedVsResolved}.
   */
  async getResolutionTime(
    scope: ReportScopeDto,
    config: { period: ReportPeriod; daysBack: number },
    ctx: ServiceContext,
  ): Promise<ReportWidgetResultDto<ResolutionTimeDto>> {
    validateReportWindow(config.period, config.daysBack);

    const resolved = await resolveReportScope(scope, ctx);
    if (resolved.state !== 'ok') return resolved;

    const { start, end } = reportWindow(new Date(), config.daysBack);
    const axis = bucketAxis(config.period, start, end);
    const filter = await scopeAstFilter(resolved, ctx);
    const rows = await workItemRevisionRepository.aggregateResolutionTimeByBucket(
      resolved.projectId,
      ctx.workspaceId,
      config.period,
      { start, end },
      filter,
    );

    return {
      state: 'ok',
      data: toResolutionTimeDto({
        period: config.period,
        daysBack: config.daysBack,
        windowStart: start,
        windowEnd: end,
        axis,
        rows,
      }),
    };
  },

  /**
   * The WORKLOAD read (Story 8.8 · Subtask 8.8.13) — the horizontal ranked-bar
   * report behind `/reports/workload` (and the `workload` gadget). Open
   * (non-done-category, non-archived) work per assignee, ranked by the `measure`
   * (story points or issue count). No time window — it is a snapshot of the
   * CURRENT `work_item` rows (one bounded grouped query, no revision trail), so
   * the only config is the measure. Same scope / typed-state contract as the
   * other reads (`no_access` / `stale` on a degraded scope); no window to 422.
   */
  async getWorkload(
    scope: ReportScopeDto,
    config: { measure: WorkloadMeasureDto },
    ctx: ServiceContext,
  ): Promise<ReportWidgetResultDto<WorkloadDto>> {
    const resolved = await resolveReportScope(scope, ctx);
    if (resolved.state !== 'ok') return resolved;

    const filter = await scopeAstFilter(resolved, ctx);
    const rows = await workItemRepository.aggregateWorkloadByAssignee(
      resolved.projectId,
      ctx.workspaceId,
      filter,
    );

    return { state: 'ok', data: toWorkloadDto(config.measure, rows) };
  },

  /**
   * The DISTRIBUTION read (Story 6.3 · Subtask 6.3.2) — the donut behind the
   * status-distribution report page (6.3.6) and widget (6.3.5). ONE bounded
   * GROUP-BY count over the scoped items (finding #57), through the TOTAL
   * statistic-type registry (`lib/reports/statisticTypes.ts` — the verified
   * Jira "Statistic Type" vocabulary: the finite-value fields). An id outside
   * the vocabulary, or a custom field whose type is not enum-ish
   * (select/user), is the typed 422 (`UnknownStatisticTypeError` — mistake
   * #29); a DELETED / out-of-project custom field is the typed STALE state
   * (`statistic_missing` — the 6.1.2 unknown-value precedent, data not
   * error). Segments come back count-descending with counts + percentages
   * (the legend's figures); the NULL group is the designed "None" segment.
   */
  async getDistribution(
    scope: ReportScopeDto,
    statistic: string,
    ctx: ServiceContext,
  ): Promise<ReportWidgetResultDto<DistributionDto>> {
    // Statistic-id FORM validation first (typed 422; existence of a cf
    // referent is a data question, resolved after the scope below).
    const parsed = parseStatisticType(statistic);

    const resolved = await resolveReportScope(scope, ctx);
    if (resolved.state !== 'ok') return resolved;

    let groupBy: DistributionGroupBy;
    if (parsed.kind === 'builtin') {
      groupBy = parsed.def.groupBy;
    } else {
      const def = await customFieldDefinitionRepository.findById(parsed.fieldId, ctx.workspaceId);
      // A deleted — or cross-project, indistinguishable to this scope — field
      // is a stale referent: the widget degrades, the dashboard survives.
      if (!def || def.projectId !== resolved.projectId) {
        return { state: 'stale', reason: 'statistic_missing' };
      }
      if (!isDistributionCfFieldType(def.fieldType)) {
        throw new UnknownStatisticTypeError(
          statistic,
          `a ${def.fieldType} field has no finite value set to group by`,
        );
      }
      groupBy = { kind: 'customField', fieldId: def.id, fieldType: def.fieldType };
    }

    const filter = await scopeAstFilter(resolved, ctx);
    const rows = await workItemRepository.aggregateDistribution(
      resolved.projectId,
      ctx.workspaceId,
      groupBy,
      filter,
    );
    return { state: 'ok', data: toDistributionDto(statistic, rows) };
  },

  /**
   * The FILTER-RESULTS page read (Story 6.3 · Subtask 6.3.2) — the paginated
   * issue table widget. Rides the EXISTING 2.5.8/2.5.12 list read + count
   * (`workItemsService.getProjectIssuesList` with the resolved filter's
   * compiled AST — no second query path, so a widget page exactly matches
   * the /issues List for the same filter), at the default sort and the
   * verified ≤ 50/page gadget cap (clamped server-side by the list read).
   * Scope and access resolve per-VIEWER like every widget read.
   */
  async getFilterResultsPage(
    scope: ReportScopeDto,
    params: { page?: number; pageSize?: number },
    ctx: ServiceContext,
  ): Promise<ReportWidgetResultDto<PagedIssueListDto>> {
    const resolved = await resolveReportScope(scope, ctx);
    if (resolved.state !== 'ok') return resolved;
    try {
      const page = await workItemsService.getProjectIssuesList(
        resolved.projectId,
        {
          sort: DEFAULT_SORT,
          filter: resolved.ast ? { ast: resolved.ast } : undefined,
          page: params.page,
          pageSize: params.pageSize,
        },
        ctx,
      );
      return { state: 'ok', data: page };
    } catch (err) {
      // The list read re-runs the browse gate (defence in depth); a race
      // between the scope resolve and the read (project deleted / access
      // revoked mid-request) degrades to the widget state, never errors.
      /* istanbul ignore next -- defensive: only a mid-request access race reaches this */
      if (err instanceof ProjectNotFoundError || err instanceof ProjectAccessDeniedError) {
        return { state: 'no_access' };
      }
      /* istanbul ignore next -- defensive: non-access errors propagate to the route */
      throw err;
    }
  },
};

// ---------------------------------------------------------------------------
// Story 6.3 · Subtask 6.3.2 — scope resolution (the per-VIEWER 6.4 seam)
// ---------------------------------------------------------------------------

/** A resolved widget scope: the single project the read runs over (saved
 * filters are project-contained — the 6.2 recorded deviation) plus the
 * filter's AST when filter-sourced; or the typed degraded state. */
type ResolvedReportScope =
  | { state: 'ok'; projectId: string; ast: FilterAst | null }
  | { state: 'no_access' }
  | { state: 'stale'; reason: 'filter_missing' | 'filter_invalid' };

/**
 * Resolve a widget data source for the REQUESTING user (never the dashboard
 * owner — the 6.4 per-VIEWER rule):
 *
 *   • `{ projectId }` — the 6.4 browse gate decides. A missing /
 *     cross-workspace project collapses into `no_access` exactly like a
 *     non-browsable one (finding #44 — no existence leak).
 *   • `{ savedFilterId }` — rides THE 6.2.1 resolve-by-id contract
 *     (`savedFiltersService.resolve`: decode + registry-validate on every
 *     resolve, never trust-and-compile; already behind the browse gate +
 *     filter visibility for the CALLER). A deleted / cross-workspace /
 *     invisible filter (finding #44: the latter two are indistinguishable
 *     from deleted) → `stale: filter_missing` (the 6.2.2 "filter missing"
 *     card); a filter over a project the viewer can't browse →
 *     `no_access` (the locked card — the story's private-project rule); a
 *     stored envelope that no longer decodes/validates →
 *     `stale: filter_invalid` (the 6.2.1 astError state). A returned AST is
 *     guaranteed registry-valid; stale OPEN referents inside it match
 *     nothing downstream (the 6.1.2 unknown-value rule).
 */
async function resolveReportScope(
  scope: ReportScopeDto,
  ctx: ServiceContext,
): Promise<ResolvedReportScope> {
  if ('projectId' in scope) {
    try {
      const caps = await projectAccessService.getCapabilities(scope.projectId, ctx);
      if (!caps.canBrowse) return { state: 'no_access' };
    } catch (err) {
      /* istanbul ignore else -- defensive: getCapabilities throws nothing else */
      if (err instanceof ProjectNotFoundError) return { state: 'no_access' };
      /* istanbul ignore next -- defensive: see above */
      throw err;
    }
    return { state: 'ok', projectId: scope.projectId, ast: null };
  }

  // The filter row locates its project (filters are addressed per-project in
  // 6.2's routes; a widget holds only the id). A missing or cross-workspace
  // row reads as deleted — the stale card, no cross-tenant leak.
  const row = await savedFilterRepository.findByIdWithStars(scope.savedFilterId, ctx.userId);
  if (!row) return { state: 'stale', reason: 'filter_missing' };
  const project = await projectRepository.findById(row.projectId);
  if (!project || project.workspaceId !== ctx.workspaceId) {
    return { state: 'stale', reason: 'filter_missing' };
  }

  let resolvedFilter;
  try {
    resolvedFilter = await savedFiltersService.resolve(
      project.identifier,
      scope.savedFilterId,
      ctx,
    );
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return { state: 'no_access' };
    /* istanbul ignore else -- defensive: the 6.2.1 resolve throws nothing else */
    if (err instanceof SavedFilterNotFoundError)
      return { state: 'stale', reason: 'filter_missing' };
    /* istanbul ignore next -- defensive: see above */
    throw err;
  }
  if (!resolvedFilter.ast) return { state: 'stale', reason: 'filter_invalid' };
  return { state: 'ok', projectId: project.id, ast: resolvedFilter.ast };
}

/** Load the Epic-5 referents a filter-scoped read's AST needs (bounded reads
 * over only the ids the filter references — `loadFilterReferents`), shaped
 * for the repository aggregates. A project scope (no AST) spends no reads. */
async function scopeAstFilter(
  resolved: { projectId: string; ast: FilterAst | null },
  ctx: ServiceContext,
): Promise<{ ast: FilterAst; referents?: ProjectFilterReferents } | undefined> {
  if (!resolved.ast) return undefined;
  const referents = await loadFilterReferents(resolved.projectId, ctx.workspaceId, resolved.ast);
  return { ast: resolved.ast, referents };
}

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
