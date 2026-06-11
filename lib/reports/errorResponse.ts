import { NextResponse } from 'next/server';
import {
  InvalidReportScopeError,
  InvalidReportWindowError,
  UnknownStatisticTypeError,
} from '@/lib/reports/errors';

// The shared typed-error → HTTP translation for the 6.3.2 report routes
// (the lib/savedFilters/errorResponse.ts precedent — route files stay thin
// and Next-clean: a route.ts may only export handler names).

/**
 * Map the 6.3.2 typed CONFIG errors to 422 — a malformed scope / window /
 * statistic is the widget editor's error to surface. The degraded DATA
 * states (`no_access` / `stale`) ride the 200 `ReportWidgetResultDto`
 * envelope instead (one broken widget never errors a dashboard). Anything
 * else re-throws to the framework's 500.
 */
export function reportConfigErrorResponse(err: unknown): Response {
  if (
    err instanceof InvalidReportScopeError ||
    err instanceof InvalidReportWindowError ||
    err instanceof UnknownStatisticTypeError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  throw err;
}
