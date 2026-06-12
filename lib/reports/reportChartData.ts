import { niceMax, niceTicks } from '@/components/ui/charts/scale';
import type { CreatedVsResolvedDto } from '@/lib/dto/reports';

// Pure numeric shaping for the Story-6.3 report charts (Subtask 6.3.6) — the
// DTO → chart-geometry transform, kept free of React + i18n so it is unit-
// testable and the client report components only add labels (locale-formatted
// bucket ticks, translated legends). No I/O.

/** A point on a created/resolved series — bucket index → count (the chart's
 * `DiffSeriesPoint` shape: x = bucket index, y = count). */
export interface SeriesPoint {
  x: number;
  y: number;
}

/** The numeric form of a created-vs-resolved read, ready for the
 * `DifferenceAreaChart` (the client wraps it with axis labels + legend). */
export interface DifferenceSeries {
  created: SeriesPoint[];
  resolved: SeriesPoint[];
  /** Per-bucket NET (created − resolved) — the data table's "Net" column. */
  nets: number[];
  /** The ISO bucket-start days, oldest → newest (the client formats them). */
  bucketDates: string[];
  /** Window totals (the legend's "N total"): for the cumulative series the
   * last running-sum IS the total; for the per-period series it is the sum. */
  createdTotal: number;
  resolvedTotal: number;
  /** A nice Y-axis ceiling ≥ 1 (so a flat-zero window still draws an axis). */
  yMax: number;
  /** Nice Y tick values (0 … yMax). */
  yTicks: number[];
}

/**
 * Shape a `CreatedVsResolvedDto` into series points + axis scaffolding. The DTO
 * buckets already reflect the cumulative running-sum (applied server-side in
 * `toCreatedVsResolvedDto`), so this is a straight index map; the only branch is
 * deriving the window totals from the cumulative-vs-per-period series.
 */
export function differenceSeries(dto: CreatedVsResolvedDto): DifferenceSeries {
  const created: SeriesPoint[] = dto.buckets.map((b, i) => ({ x: i, y: b.created }));
  const resolved: SeriesPoint[] = dto.buckets.map((b, i) => ({ x: i, y: b.resolved }));
  const nets = dto.buckets.map((b) => b.created - b.resolved);
  const bucketDates = dto.buckets.map((b) => b.date);

  const last = dto.buckets[dto.buckets.length - 1];
  const createdTotal = dto.cumulative
    ? (last?.created ?? 0)
    : dto.buckets.reduce((s, b) => s + b.created, 0);
  const resolvedTotal = dto.cumulative
    ? (last?.resolved ?? 0)
    : dto.buckets.reduce((s, b) => s + b.resolved, 0);

  // The resolved per-period series can dip negative on a reopen-heavy bucket; the
  // axis still anchors at 0 (the lines cross it) and tops at the data ceiling.
  const dataMax = Math.max(1, ...dto.buckets.map((b) => Math.max(b.created, b.resolved)));

  return {
    created,
    resolved,
    nets,
    bucketDates,
    createdTotal,
    resolvedTotal,
    yMax: niceMax(dataMax) || 1,
    yTicks: niceTicks(dataMax),
  };
}

/**
 * Pick ~`target` evenly-spaced tick indices for an `n`-bucket X axis (always
 * including the first + last), so a long daily window labels a handful of ticks
 * rather than every day. `n ≤ target` shows them all.
 */
export function pickTickIndices(n: number, target = 6): number[] {
  if (n <= 0) return [];
  if (n <= target) return Array.from({ length: n }, (_, i) => i);
  const step = (n - 1) / (target - 1);
  const set = new Set<number>();
  for (let i = 0; i < target; i++) set.add(Math.round(i * step));
  set.add(0);
  set.add(n - 1);
  return [...set].sort((a, b) => a - b);
}
