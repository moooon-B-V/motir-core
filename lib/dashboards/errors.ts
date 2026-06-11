// Typed errors for the dashboards domain (Story 6.3 · Subtask 6.3.1).
// Prisma-free (the lib/savedFilters/errors pattern) so routes and client
// code can import them. The route layer translates the stable `code` to
// HTTP status via lib/dashboards/errorResponse.ts:
//   DashboardNotFoundError         → 404 (missing, cross-tenant, OR a
//                                    private dashboard the actor may not
//                                    see — finding #44, no existence leak)
//   DashboardWidgetNotFoundError   → 404 (missing or cross-dashboard widget)
//   DashboardForbiddenError        → 403 (visible but the action is
//                                    owner-only — the 6.3 permission rule:
//                                    create = any member, mutate = owner)
//   InvalidDashboardNameError      → 422 (blank / over-cap name)
//   InvalidDashboardAccessError    → 422 (not `private` | `workspace`)
//   InvalidDashboardLayoutError    → 422 (not `one` | `two` | `three`)
//   UnknownDashboardWidgetTypeError→ 422 (a type outside the TOTAL registry
//                                    — mistake #29: never a silent pass)
//   InvalidDashboardWidgetConfigError → 422 (malformed per-type settings or
//                                    a broken data-source XOR)
//   DashboardWidgetSourceNotFoundError → 422 (the named saved filter /
//                                    project does not exist in this
//                                    workspace — an invalid INCOMING
//                                    referent is a rejection; only a STORED
//                                    referent degrades to stale)
//   DashboardWidgetCapError        → 422 (the 21st widget — the designed
//                                    cap state)
//   InvalidDashboardWidgetMoveError→ 422 (target column outside the layout,
//                                    or neighbour ids that don't bound a
//                                    real slot)

/** Every owner-gated dashboard action — the closed vocabulary
 * `DashboardForbiddenError` reports and the matrix tests enumerate (the
 * totality-guard pattern). */
export type DashboardAction =
  | 'rename'
  | 'change-access'
  | 'change-layout'
  | 'delete'
  | 'edit-widgets';

export class DashboardNotFoundError extends Error {
  readonly code = 'DASHBOARD_NOT_FOUND' as const;
  constructor(dashboardId: string) {
    super(`Dashboard ${dashboardId} was not found.`);
    this.name = 'DashboardNotFoundError';
  }
}

export class DashboardWidgetNotFoundError extends Error {
  readonly code = 'DASHBOARD_WIDGET_NOT_FOUND' as const;
  constructor(widgetId: string) {
    super(`Dashboard widget ${widgetId} was not found.`);
    this.name = 'DashboardWidgetNotFoundError';
  }
}

export class DashboardForbiddenError extends Error {
  readonly code = 'DASHBOARD_FORBIDDEN' as const;
  constructor(readonly action: DashboardAction) {
    super(`Only the dashboard owner may ${action.replace(/-/g, ' ')}.`);
    this.name = 'DashboardForbiddenError';
  }
}

export class InvalidDashboardNameError extends Error {
  readonly code = 'INVALID_DASHBOARD_NAME' as const;
  constructor(detail: string) {
    super(detail);
    this.name = 'InvalidDashboardNameError';
  }
}

export class InvalidDashboardAccessError extends Error {
  readonly code = 'INVALID_DASHBOARD_ACCESS' as const;
  constructor(value: string) {
    super(`Invalid dashboard access "${value}" — expected "private" or "workspace".`);
    this.name = 'InvalidDashboardAccessError';
  }
}

export class InvalidDashboardLayoutError extends Error {
  readonly code = 'INVALID_DASHBOARD_LAYOUT' as const;
  constructor(value: string) {
    super(`Invalid dashboard layout "${value}" — expected "one", "two", or "three".`);
    this.name = 'InvalidDashboardLayoutError';
  }
}

export class UnknownDashboardWidgetTypeError extends Error {
  readonly code = 'UNKNOWN_DASHBOARD_WIDGET_TYPE' as const;
  constructor(value: string) {
    super(`Unknown dashboard widget type "${value}".`);
    this.name = 'UnknownDashboardWidgetTypeError';
  }
}

export class InvalidDashboardWidgetConfigError extends Error {
  readonly code = 'INVALID_DASHBOARD_WIDGET_CONFIG' as const;
  constructor(detail: string) {
    super(detail);
    this.name = 'InvalidDashboardWidgetConfigError';
  }
}

export class DashboardWidgetSourceNotFoundError extends Error {
  readonly code = 'DASHBOARD_WIDGET_SOURCE_NOT_FOUND' as const;
  constructor(detail: string) {
    super(detail);
    this.name = 'DashboardWidgetSourceNotFoundError';
  }
}

export class DashboardWidgetCapError extends Error {
  readonly code = 'DASHBOARD_WIDGET_CAP' as const;
  constructor(cap: number) {
    super(`This dashboard already holds the maximum of ${cap} widgets.`);
    this.name = 'DashboardWidgetCapError';
  }
}

export class InvalidDashboardWidgetMoveError extends Error {
  readonly code = 'INVALID_DASHBOARD_WIDGET_MOVE' as const;
  constructor(detail: string) {
    super(detail);
    this.name = 'InvalidDashboardWidgetMoveError';
  }
}
