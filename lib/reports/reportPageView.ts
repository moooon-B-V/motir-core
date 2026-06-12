import {
  type ReportPeriod,
  MAX_REPORT_WINDOW_DAYS,
  MAX_REPORT_BUCKETS,
} from '@/lib/reports/buckets';

// Client-safe view helpers for the Story-6.3 report PAGES (Subtask 6.3.6) — the
// `?period`/`?daysBack`/`?cumulative`/`?savedFilterId`/`?statistic` URL state and
// the days-back ladder the stepper steps through. Pure (no I/O, no React), so the
// report pages' controls and their tests share one source of truth, the
// `lib/issues/issueListView.ts` precedent. The server param parsers in
// `lib/reports/params.ts` throw on malformed input (the strict widget-route
// contract); these page helpers instead coerce-with-fallback (a hand-edited /
// shared report URL degrades to a sensible default, never a 422 the user can't
// recover from) and build canonical hrefs that OMIT defaults (clean URLs).

/** The report-page defaults — kept 1:1 with the `lib/reports/params.ts`
 * parser defaults (period `day`, daysBack `30`, cumulative `false`) so a
 * default-config URL is the bare path, and the distribution default statistic
 * (`status` — the verified Jira Pie-Chart default + the design's example). */
export const REPORT_DEFAULTS = {
  period: 'day' as ReportPeriod,
  daysBack: 30,
  cumulative: false,
  statistic: 'status',
} as const;

/**
 * The discrete days-back windows the stepper moves through (the design's
 * "− 90 +" control). A ladder rather than a free ±N keeps every value a clean,
 * shareable window AND valid-by-construction (the daily period caps at
 * {@link MAX_REPORT_BUCKETS} buckets, so 365 days is never offered for `day`) —
 * the control can never produce the window the service would 422.
 */
export const DAYS_BACK_LADDER = [7, 14, 30, 60, 90, 180, 365] as const;

/** The max days-back a period can request without exceeding the bucket cap: a
 * DAILY window is bounded by {@link MAX_REPORT_BUCKETS} (one bucket per day),
 * week/month by the overall {@link MAX_REPORT_WINDOW_DAYS}. */
export function maxDaysBackForPeriod(period: ReportPeriod): number {
  return period === 'day'
    ? Math.min(MAX_REPORT_BUCKETS, MAX_REPORT_WINDOW_DAYS)
    : MAX_REPORT_WINDOW_DAYS;
}

/** The ladder values valid for a period (≤ its max). Never empty — the
 * smallest rung (7) is always ≤ every period's cap. */
export function daysBackLadder(period: ReportPeriod): number[] {
  return DAYS_BACK_LADDER.filter((d) => d <= maxDaysBackForPeriod(period));
}

/**
 * Snap an arbitrary days-back into the period's ladder: clamp to
 * `[min rung, period max]`, then round to the NEAREST rung (so a shared
 * `?daysBack=120` daily URL lands on 90, the nearest valid rung, not an
 * off-ladder value the stepper couldn't then move from).
 */
export function clampDaysBack(period: ReportPeriod, daysBack: number): number {
  const ladder = daysBackLadder(period);
  const min = ladder[0]!;
  const max = ladder[ladder.length - 1]!;
  if (!Number.isFinite(daysBack) || daysBack <= min) return min;
  if (daysBack >= max) return max;
  // Nearest rung (ties → the larger, a slightly wider window).
  return ladder.reduce((best, rung) =>
    Math.abs(rung - daysBack) < Math.abs(best - daysBack) ? rung : best,
  );
}

/** Step the days-back one rung along its period's ladder (the stepper's −/+). A
 * value mid-ladder snaps in first, so the move is always to a real rung. */
export function stepDaysBack(period: ReportPeriod, current: number, dir: -1 | 1): number {
  const ladder = daysBackLadder(period);
  const snapped = clampDaysBack(period, current);
  const i = ladder.indexOf(snapped);
  const next = ladder[Math.min(Math.max(i + dir, 0), ladder.length - 1)];
  return next ?? snapped;
}

/** Coerce a raw `?period` to a valid period, defaulting (never throwing — the
 * page-level forgiving parse; the widget route keeps the strict thrower). */
export function coercePeriod(raw: string | null): ReportPeriod {
  return raw === 'day' || raw === 'week' || raw === 'month' ? raw : REPORT_DEFAULTS.period;
}

/** Coerce a raw `?daysBack` to a valid, in-ladder window for the period. */
export function coerceDaysBack(period: ReportPeriod, raw: string | null): number {
  const n = raw === null ? REPORT_DEFAULTS.daysBack : Number(raw);
  return clampDaysBack(period, Number.isFinite(n) ? n : REPORT_DEFAULTS.daysBack);
}

/** The report-page URL state (a subset per page — the created-vs-resolved page
 * uses period/daysBack/cumulative, the distribution page uses statistic; both
 * may carry a saved-filter scope). */
export interface ReportPageParams {
  /** A saved-filter scope, or null/undefined for the default project scope. */
  savedFilterId?: string | null;
  period?: ReportPeriod;
  daysBack?: number;
  cumulative?: boolean;
  statistic?: string;
}

/**
 * Build a canonical report-page href, OMITTING any param equal to its default
 * (clean, shareable URLs — the `buildIssueListHref` convention). The default
 * project scope drops `savedFilterId`; a default period/window/cumulative/
 * statistic drops its param, so the bare path always means "default config".
 */
export function buildReportHref(pathname: string, params: ReportPageParams): string {
  const sp = new URLSearchParams();
  if (params.savedFilterId) sp.set('savedFilterId', params.savedFilterId);
  if (params.period && params.period !== REPORT_DEFAULTS.period) sp.set('period', params.period);
  if (params.daysBack !== undefined && params.daysBack !== REPORT_DEFAULTS.daysBack) {
    sp.set('daysBack', String(params.daysBack));
  }
  if (params.cumulative) sp.set('cumulative', 'true');
  if (params.statistic && params.statistic !== REPORT_DEFAULTS.statistic) {
    sp.set('statistic', params.statistic);
  }
  const qs = sp.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/** The i18n key (under the `reports` namespace) for a period's control label. */
export const PERIOD_LABEL_KEY: Record<ReportPeriod, string> = {
  day: 'period.day',
  week: 'period.week',
  month: 'period.month',
};

/** The i18n key (under `reports`) for a period's axis/bucket noun (e.g. "Week"). */
export const PERIOD_AXIS_KEY: Record<ReportPeriod, string> = {
  day: 'periodAxis.day',
  week: 'periodAxis.week',
  month: 'periodAxis.month',
};
