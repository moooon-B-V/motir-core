import { InvalidReportScopeError, InvalidReportWindowError } from '@/lib/reports/errors';
import { isReportPeriod, type ReportPeriod } from '@/lib/reports/buckets';
import type { ReportScopeDto, WorkloadMeasureDto } from '@/lib/dto/reports';

// Query-param parsers for the 6.3.2 report/widget routes (the
// `parseSort`/`parseView` convention from lib/issues/issueListView.ts —
// pure, route-consumed, no I/O). Malformed CONFIG throws the lib/reports
// typed errors (→ 422 at the HTTP layer); the parsers never produce a value
// the service would have to re-reject on FORM (the service still re-validates
// — defence in depth).

/**
 * Parse the widget data source from `?projectId=` / `?savedFilterId=` —
 * EXACTLY ONE must be present (the verified gadget config pattern; the XOR
 * is structural in `ReportScopeDto`). Both / neither → the typed 422.
 */
export function parseReportScope(searchParams: URLSearchParams): ReportScopeDto {
  const projectId = searchParams.get('projectId');
  const savedFilterId = searchParams.get('savedFilterId');
  if (projectId && savedFilterId) {
    throw new InvalidReportScopeError('pass exactly one of projectId or savedFilterId, not both');
  }
  if (projectId) return { projectId };
  if (savedFilterId) return { savedFilterId };
  throw new InvalidReportScopeError('one of projectId or savedFilterId is required');
}

/** Parse `?period=day|week|month` (default `day`). Unknown values are a
 * typed 422 — a misconfigured widget must surface, not silently re-bucket. */
export function parsePeriod(raw: string | null): ReportPeriod {
  if (raw === null) return 'day';
  if (!isReportPeriod(raw)) {
    throw new InvalidReportWindowError(`unknown period: ${raw} (expected day, week, or month)`);
  }
  return raw;
}

/**
 * Parse `?daysBack=N` (default 30). A non-numeric value is a typed 422 here;
 * the RANGE rule (1..366, ≤120 buckets for a daily period) is the service's
 * `validateReportWindow` — one owner for the bound, not two.
 */
export function parseDaysBack(raw: string | null): number {
  if (raw === null) return 30;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new InvalidReportWindowError(`daysBack must be a number`);
  return n;
}

/** Parse `?cumulative=true|false` (default false; only the literal `true`
 * opts in — the URL-param convention for boolean toggles). */
export function parseCumulative(raw: string | null): boolean {
  return raw === 'true';
}

/** Parse the workload `?measure=story_points|issue_count` (default
 * `story_points` — Motir's workload unit). An unknown value is a typed 422,
 * matching `parsePeriod` (a misconfigured widget surfaces, never silently
 * re-defaults). */
export function parseMeasure(raw: string | null): WorkloadMeasureDto {
  if (raw === null) return 'story_points';
  if (raw !== 'story_points' && raw !== 'issue_count') {
    throw new InvalidReportWindowError(
      `unknown measure: ${raw} (expected story_points or issue_count)`,
    );
  }
  return raw;
}

/** Parse a positive-integer param (`?page=`, `?pageSize=`) — `undefined`
 * (caller defaults / clamps) on absent or malformed input, the forgiving
 * `parsePage` convention (a bad pager value degrades, never errors). */
export function parsePositiveInt(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}
