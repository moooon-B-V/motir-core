import type { EstimationStatisticDto } from '@/lib/dto/estimation';
import type {
  BurndownDayDto,
  BurndownScopeChangeDto,
  BurndownSeriesDto,
  BurndownStatisticDto,
  CreatedVsResolvedBucketDto,
  CreatedVsResolvedDto,
  DistributionDto,
  DistributionSegmentDto,
  ReportPeriodDto,
  VelocityDto,
  VelocitySprintDto,
} from '@/lib/dto/reports';

// Pure assemblers for the reports domain (Story 4.6). The service composes the
// raw figures (committed baselines + done-category roll-ups; the committed
// baseline + the per-day revision-trail deltas + the authoritative current
// remaining) then calls these to derive the wire shapes — no Prisma enum /
// Decimal leaks across the API boundary, no I/O, so they are unit-testable in
// isolation. Mirrors `lib/mappers/estimationMappers.ts`.
//
// Subtask 4.6.4 added the VELOCITY assembler (`toVelocityDto`); Subtask 4.6.3
// added the BURNDOWN assembler (`toBurndownSeriesDto`) to this same file.

/**
 * Build a `VelocityDto` from the per-sprint `{ committed, completed }` data
 * (already ordered oldest→newest for the X axis) + the configured statistic.
 * `averageCompleted` is the mean of `completed` over the returned sprints — the
 * planning forecast — rounded to two decimals to avoid float-noise display, and
 * `0` when there is no history (the low-history state; the UI renders "not
 * enough history yet"). PURE: no I/O, unit-testable in isolation.
 */
export function toVelocityDto(
  sprints: VelocitySprintDto[],
  statistic: EstimationStatisticDto,
): VelocityDto {
  const averageCompleted =
    sprints.length === 0
      ? 0
      : Math.round((sprints.reduce((sum, s) => sum + s.completed, 0) / sprints.length) * 100) / 100;
  return { sprints, averageCompleted, statistic };
}

/** Round to 2 decimals — kills float-sum noise in the wire numbers. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The UTC calendar-day key (`YYYY-MM-DD`) for a `Date`. */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** UTC midnight of a `Date` (so day iteration is timezone-stable). */
function utcMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The raw inputs the service hands the burndown assembler. Everything I/O — the
 * sprint window, the configured baseline, the per-day deltas read from the
 * 1.4.6 revision trail, and the authoritative present remaining — is resolved
 * upstream; this function is pure math over them.
 */
export interface BurndownSeriesInput {
  sprintId: string;
  state: 'active' | 'complete';
  statistic: BurndownStatisticDto;
  /** The t=0 committed baseline in `statistic` (≥ 0). */
  committed: number;
  /** Sprint window start (the guideline's first day + the actual's origin). */
  start: Date;
  /** Axis end — the guideline reaches 0 here (planned `endDate`, else `completedAt`/now). */
  axisEnd: Date;
  /** Last day the actual line is drawn (now for active, `completedAt` for complete). */
  actualCutoff: Date;
  /** Per-UTC-day signed deltas from `workItemRevisionRepository.aggregateSprintBurndownByDay`. */
  dailyDeltas: Array<{ day: string; remainingDelta: number; scopeDelta: number }>;
  /**
   * The authoritative current remaining (`rollupForSprint().remaining`) to anchor
   * the last drawn actual point to, so the chart agrees with the numeric remaining
   * the scrum header / sprint report show — `null` when the rollup is measured in a
   * different unit than the burndown (a degraded series) and so cannot anchor.
   */
  anchorRemaining: number | null;
}

/**
 * Assemble a `BurndownSeriesDto` from the committed baseline + the per-day
 * revision-trail deltas. The **guideline** is the straight ideal descent from
 * `committed` at the first day to 0 at the last (`axisEnd`). The **actual** is a
 * stepped line: it starts at `committed` and, day by day, applies that day's net
 * `remainingDelta` (completions burn it down, scope-adds + reopens raise it),
 * floored at 0; days AFTER `actualCutoff` are `null` (the future of a live
 * sprint). The last drawn actual point is anchored to `anchorRemaining` (the
 * authoritative `rollupForSprint().remaining`) when units match, so the chart
 * and the numeric remaining never disagree. `scopeChanges` are the days with a
 * net association change (the chart's scope markers). PURE — no I/O.
 */
export function toBurndownSeriesDto(input: BurndownSeriesInput): BurndownSeriesDto {
  const deltaByDay = new Map<string, { remainingDelta: number; scopeDelta: number }>();
  for (const row of input.dailyDeltas) {
    deltaByDay.set(row.day, { remainingDelta: row.remainingDelta, scopeDelta: row.scopeDelta });
  }

  const startMs = utcMidnight(input.start);
  // The axis spans whole days from start to axisEnd inclusive (≥ 1 day). A
  // misconfigured end before start collapses to the single start day.
  const endMs = Math.max(startMs, utcMidnight(input.axisEnd));
  const cutoffMs = Math.max(startMs, utcMidnight(input.actualCutoff));
  const dayCount = Math.round((endMs - startMs) / DAY_MS) + 1;

  const days: BurndownDayDto[] = [];
  let running = input.committed;
  let lastDrawn: BurndownDayDto | null = null;

  for (let i = 0; i < dayCount; i++) {
    const dayMs = startMs + i * DAY_MS;
    const key = dayKey(new Date(dayMs));
    // Guideline: linear committed → 0 across [0, dayCount-1]; a single-day axis
    // sits at committed (no descent to draw).
    const guideline = dayCount === 1 ? input.committed : input.committed * (1 - i / (dayCount - 1));

    let remaining: number | null;
    if (dayMs <= cutoffMs) {
      running += deltaByDay.get(key)?.remainingDelta ?? 0;
      remaining = round2(Math.max(0, running));
    } else {
      remaining = null;
    }
    const day: BurndownDayDto = { date: key, guideline: round2(Math.max(0, guideline)), remaining };
    if (remaining !== null) lastDrawn = day;
    days.push(day);
  }

  // Anchor the present: the last drawn actual point IS "now" / completion, whose
  // remaining is authoritatively the 4.3.3 roll-up — pin it there so the chart
  // matches the numeric remaining exactly (covers the floor + any historical
  // points-edit drift). Skipped when the rollup unit differs (degraded series).
  if (input.anchorRemaining !== null && lastDrawn !== null) {
    lastDrawn.remaining = round2(Math.max(0, input.anchorRemaining));
  }

  const scopeChanges: BurndownScopeChangeDto[] = input.dailyDeltas
    .filter((r) => r.scopeDelta !== 0)
    .map((r) => ({ date: r.day, delta: round2(r.scopeDelta) }));

  return {
    sprintId: input.sprintId,
    state: input.state,
    statistic: input.statistic,
    committed: round2(input.committed),
    startDate: input.start.toISOString(),
    endDate: input.axisEnd.toISOString(),
    days,
    scopeChanges,
  };
}

// ---------------------------------------------------------------------------
// Story 6.3 · Subtask 6.3.2 — the widget / report-page read assemblers
// ---------------------------------------------------------------------------

/**
 * Assemble a `CreatedVsResolvedDto` from the two grouped repository series.
 * `axis` is the FULL bucket-key list (`lib/reports/buckets.ts` — generated by
 * the service so event-less buckets render at 0, oldest → newest); the two
 * sparse series fill into it by key. With `cumulative` the created and (net)
 * resolved series are running-summed across the axis — server-side, so the
 * wire data IS the drawable series either way. PURE — no I/O.
 */
export function toCreatedVsResolvedDto(input: {
  period: ReportPeriodDto;
  daysBack: number;
  cumulative: boolean;
  windowStart: Date;
  windowEnd: Date;
  axis: string[];
  created: Array<{ bucket: string; count: number }>;
  resolved: Array<{ bucket: string; resolved: number }>;
}): CreatedVsResolvedDto {
  const createdByBucket = new Map(input.created.map((r) => [r.bucket, r.count]));
  const resolvedByBucket = new Map(input.resolved.map((r) => [r.bucket, r.resolved]));

  let createdRunning = 0;
  let resolvedRunning = 0;
  const buckets: CreatedVsResolvedBucketDto[] = input.axis.map((date) => {
    const created = createdByBucket.get(date) ?? 0;
    const resolved = resolvedByBucket.get(date) ?? 0;
    if (!input.cumulative) return { date, created, resolved };
    createdRunning += created;
    resolvedRunning += resolved;
    return { date, created: createdRunning, resolved: resolvedRunning };
  });

  return {
    period: input.period,
    daysBack: input.daysBack,
    cumulative: input.cumulative,
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
    buckets,
  };
}

/**
 * Assemble a `DistributionDto` from the grouped segment counts (already
 * count-descending from the repository). `total` is the segment-count sum —
 * the percentage denominator (join-backed statistics count an item once per
 * join row, the verified Jira multi-count behaviour). Percentages round to
 * one decimal (sum 100 ± rounding); an empty scope yields `{ total: 0,
 * segments: [] }` — never `NaN`. PURE — no I/O.
 */
export function toDistributionDto(
  statistic: string,
  rows: Array<{ id: string | null; label: string | null; count: number }>,
): DistributionDto {
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const segments: DistributionSegmentDto[] = rows.map((r) => ({
    id: r.id,
    label: r.label,
    count: r.count,
    percentage: total === 0 ? 0 : Math.round((r.count / total) * 1000) / 10,
  }));
  return { statistic, total, segments };
}
