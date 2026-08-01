// DTO for the schedule-health check (MOTIR-1970) — the shape
// `system.daily-health-check` resolves to, and therefore what lands on its
// `job_run.output` and renders in the operator dashboard. Dates cross the
// boundary as ISO strings, matching `lib/dto/jobs.ts`.

/** One scheduled job's verdict. */
export interface ScheduleHealthEntryDTO {
  /** The Inngest function id, e.g. `system.ci-actions-gate-sweep`. */
  functionId: string;
  /** Its cron expression, as declared on `defineJob`. */
  cron: string;
  /** When it last actually ran, or null if the ledger has never seen it. */
  lastRunAt: string | null;
  /**
   * The tick it is judged against: the fire BEFORE the most recent one, so a
   * single missed tick is tolerated and two are not. Null when the expression
   * has no second fire inside the search horizon (a brand-new schedule), in
   * which case the job is not judged at all.
   */
  judgedAgainst: string | null;
}

/**
 * The whole check. `overdue` is the actionable part — a non-empty list is what
 * makes the health check FAIL, and each entry names a job whose registration is
 * the first thing to suspect.
 */
export interface ScheduleHealthReportDTO {
  checkedAt: string;
  /** Every scheduled job, healthy or not — so the report also proves coverage. */
  entries: ScheduleHealthEntryDTO[];
  /** The subset that has missed more than one consecutive tick. */
  overdue: ScheduleHealthEntryDTO[];
}
