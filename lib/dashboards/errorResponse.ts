import { NextResponse } from 'next/server';
import {
  DashboardForbiddenError,
  DashboardNotFoundError,
  DashboardWidgetCapError,
  DashboardWidgetNotFoundError,
  DashboardWidgetSourceNotFoundError,
  InvalidDashboardAccessError,
  InvalidDashboardLayoutError,
  InvalidDashboardNameError,
  InvalidDashboardWidgetConfigError,
  InvalidDashboardWidgetMoveError,
  UnknownDashboardWidgetTypeError,
} from '@/lib/dashboards/errors';

/**
 * Shared typed-error → HTTP mapping for the dashboard routes (Story 6.3 ·
 * Subtask 6.3.1), the `mapSavedFilterError` pattern. Returns null for
 * errors the route should rethrow.
 *
 *   DashboardNotFoundError / DashboardWidgetNotFoundError → 404 (missing,
 *     cross-tenant, or merely invisible — finding #44, indistinguishable)
 *   DashboardForbiddenError                               → 403 (visible
 *     but mutate is owner-only)
 *   InvalidDashboardNameError / InvalidDashboardAccessError /
 *   InvalidDashboardLayoutError / UnknownDashboardWidgetTypeError /
 *   InvalidDashboardWidgetConfigError /
 *   DashboardWidgetSourceNotFoundError / DashboardWidgetCapError /
 *   InvalidDashboardWidgetMoveError                       → 422 (an invalid
 *     INCOMING name / enum / widget type / config / source referent / move,
 *     or the 21st widget — each a rejection; only a STORED filter referent
 *     degrades instead, to the stale widget state)
 */
export function mapDashboardError(err: unknown): NextResponse | null {
  if (err instanceof DashboardNotFoundError || err instanceof DashboardWidgetNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof DashboardForbiddenError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (
    err instanceof InvalidDashboardNameError ||
    err instanceof InvalidDashboardAccessError ||
    err instanceof InvalidDashboardLayoutError ||
    err instanceof UnknownDashboardWidgetTypeError ||
    err instanceof InvalidDashboardWidgetConfigError ||
    err instanceof DashboardWidgetSourceNotFoundError ||
    err instanceof DashboardWidgetCapError ||
    err instanceof InvalidDashboardWidgetMoveError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  return null;
}
