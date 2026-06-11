// Typed errors for the reports domain (Story 6.3 · Subtask 6.3.2) — the
// widget/report read-path rejections. Prisma-free (the lib/savedFilters
// pattern). The route layer translates the stable `code` to HTTP status:
//   InvalidReportScopeError    → 422 (the data source must be EXACTLY ONE of
//                                projectId / savedFilterId — the verified
//                                gadget config pattern)
//   InvalidReportWindowError   → 422 (period / days-back outside the bounded
//                                window — finding #57: the read stays a capped
//                                grouped aggregate, never an open-ended scan)
//   UnknownStatisticTypeError  → 422 (a statistic id outside the TOTAL
//                                registry vocabulary, or a custom field whose
//                                type is not enum-ish — mistake #29: unknown
//                                ids are typed rejections, never silent
//                                pass-throughs)
//
// NOTE the deliberate split (the card's rule): a malformed CONFIG is a typed
// 422 (these errors); a STALE REFERENT (deleted saved filter / project /
// statistic custom field) is NOT an error — it resolves to the typed
// `stale` widget state (lib/dto/reports.ts `ReportWidgetResultDto`), the
// 6.1.2 unknown-value precedent, so one broken widget degrades instead of
// erroring the dashboard.

export class InvalidReportScopeError extends Error {
  readonly code = 'INVALID_REPORT_SCOPE' as const;
  constructor(detail: string) {
    super(`Invalid report scope: ${detail}`);
    this.name = 'InvalidReportScopeError';
  }
}

export class InvalidReportWindowError extends Error {
  readonly code = 'INVALID_REPORT_WINDOW' as const;
  constructor(detail: string) {
    super(`Invalid report window: ${detail}`);
    this.name = 'InvalidReportWindowError';
  }
}

export class UnknownStatisticTypeError extends Error {
  readonly code = 'UNKNOWN_STATISTIC_TYPE' as const;
  constructor(statistic: string, detail?: string) {
    super(`Unknown statistic type: ${statistic}${detail ? ` (${detail})` : ''}`);
    this.name = 'UnknownStatisticTypeError';
  }
}
