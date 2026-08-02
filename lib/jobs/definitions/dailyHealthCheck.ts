import { defineJob } from '../defineJob';
import type { ScheduleHealthReportDTO } from '@/lib/dto/jobSchedules';
import type { FleetBootableVerdict } from '@/lib/orchestrator';

// The canonical SCHEDULED job (Story 1.6 · Subtask 1.6.4) — the reference for
// the cron primitive, and the replacement for the 1.6.2 `system.ping` smoke
// job. Runs daily at 09:00 via Inngest's cron trigger, so there is no separate
// scheduler service to operate. It is still the worked example docs/jobs.md →
// "Scheduled jobs" points at, and still proves the scheduled path end-to-end
// (cron → defineJob wrapper → a `job_run` row whose `event_name` is the
// synthetic `scheduled.system.daily-health-check`).
//
// It began as a deliberate no-op. As of MOTIR-1970 it carries a real probe: the
// SCHEDULE-HEALTH CHECK, which fails the run when a cron job has stopped firing.
// That is the detection seam for a stale Inngest app registry — the fault where
// the cloud's registered function list falls behind the deployed build, so
// events for newer functions are accepted and consumed by nothing, in complete
// silence. `jobScheduleHealthService` carries the full reasoning; the part that
// matters HERE is why the probe lives in THIS job and not a new one:
//
//   this job is old (2026-06-01), so it is registered in any stale sync the
//   cloud could still be holding. A checker defined alongside the jobs it
//   watches would be stranded by the very fault it exists to report.
//
// Do not move the probe to a newer job, and do not re-declare this one under a
// new id — either would re-open the blind spot.
//
// As of MOTIR-2006 it carries a SECOND probe: the FLEET BOOT PREFLIGHT (§6.1 of
// `docs/decisions/fleet-image-pull.md`) — does the registry actually serve the
// runner image this deployment is pinned to? It is here rather than in a new job
// for the reason that governs everything below: this job already has a LOUD,
// HUMAN-VISIBLE failure surface, and the fault it now also watches for is one
// whose entire history is having had none. MOTIR-1980's fleet shipped
// code-complete and unable to boot a single container while every predicate in
// the codebase answered "configured"; the only thing that would have caught it
// is a scheduled assertion that fails somewhere a person looks.
//
// The two probes are independent faults sharing one surface, not one check: a
// stale registry strands functions, an unpullable image strands containers.
//
// `retryPolicy: 'none'` (run at most once): a health check is a point-in-time
// probe — retrying it minutes later would record a stale verdict, so a failed
// tick dead-letters immediately rather than retrying. That is also what makes
// the failure LOUD: the DLQ tab of the 1.6.5 operator dashboard gets a row
// naming every overdue job, instead of a queue that quietly consumes nothing.
// THE DLQ ROW IS THE SURFACE — `/settings/workspace/jobs` → DLQ, whose badge
// counts it and whose detail panel renders the failure message. That is why
// every error thrown here writes its diagnosis into its MESSAGE: the message is
// the whole of what a human reads, and no operator should have to open
// orchestrator logs to learn which image the registry refused.

/** The cron expression — 09:00 every day. Exported so the test asserts wiring. */
export const DAILY_HEALTH_CHECK_CRON = '0 9 * * *';

/** What the job resolves to on a healthy tick — persisted on the `job_run` row. */
export interface DailyHealthCheckResult {
  ok: true;
  check: 'daily-health-check';
  schedules: ScheduleHealthReportDTO;
  /** The fleet boot preflight's verdict (MOTIR-2006). Recorded on the healthy
   *  tick too, so the ledger answers "was the runner image pullable yesterday?"
   *  — a green run that says `not_applicable` and one that says `bootable` are
   *  very different states, and a result that only appeared on failure could not
   *  tell them apart. */
  fleet: FleetBootableVerdict;
}

/** The stable half of the resolved payload. Exported for the test. */
export const DAILY_HEALTH_CHECK_PAYLOAD = { ok: true, check: 'daily-health-check' } as const;

/**
 * Thrown when at least one cron job has missed more than one consecutive tick.
 * Its message names the offenders because that message is what lands in the DLQ
 * row's `failure` — an operator should not have to open a database to learn
 * WHICH job stopped.
 */
export class ScheduledJobsOverdueError extends Error {
  constructor(readonly report: ScheduleHealthReportDTO) {
    const detail = report.overdue
      .map((e) => `${e.functionId} (cron ${e.cron}; last run ${e.lastRunAt ?? 'never'})`)
      .join(', ');
    super(
      `${report.overdue.length} scheduled job(s) have not run since their previous tick: ${detail}. ` +
        `Suspect a stale Inngest app registration — re-sync with PUT /api/inngest and check that the ` +
        `sync is happening on deploy (MOTIR-1970).`,
    );
    this.name = 'ScheduledJobsOverdueError';
  }
}

/**
 * Thrown when the deployment's configured runner image cannot be pulled — §6.1
 * of `docs/decisions/fleet-image-pull.md`, and the assertion MOTIR-1980 lacked.
 *
 * Its message names the IMAGE REFERENCE and the REGISTRY'S OWN WORDS, because
 * that message is the DLQ row's `failure` and therefore the entire thing an
 * operator reads. "The fleet is unhealthy" would be true and useless; "ghcr.io
 * refused an anonymous pull token for <ref>" is a fix.
 */
export class FleetImageUnpullableError extends Error {
  constructor(readonly verdict: Extract<FleetBootableVerdict, { verdict: 'unpullable' }>) {
    super(
      `The fleet's runner image cannot be pulled: ${verdict.reference} — ${verdict.detail}. ` +
        `No CI container can boot until this is fixed. Check the image's registry visibility ` +
        `and that MOTIR_RUNNER_IMAGE names a digest that still exists ` +
        `(docs/decisions/fleet-image-pull.md §1 makes the CI runner image PUBLIC on GHCR; ` +
        `a closed image mirrors into registry.fly.io per §5).`,
    );
    this.name = 'FleetImageUnpullableError';
  }
}

export const dailyHealthCheck = defineJob(
  { id: 'system.daily-health-check', cron: DAILY_HEALTH_CHECK_CRON, retryPolicy: 'none' },
  async (ctx, services): Promise<DailyHealthCheckResult> => {
    // `step.run` memoizes the read, so the verdict is captured once per run
    // rather than re-derived on every replay of the handler body.
    const schedules = await ctx.step.run('schedule-health', () =>
      services.jobScheduleHealth.check(),
    );
    const fleet = await ctx.step.run('fleet-boot-preflight', () => services.fleetPreflight.check());

    // ⚠️ BOTH PROBES RUN BEFORE EITHER THROWS. A stale registry and an unpullable
    // image are independent faults, and a run that reported only the first would
    // hide the second for as many days as the first took to fix. So the reads
    // are both taken above and only the reporting is ordered.
    //
    // This job's own ledger row is written by `recordStart` BEFORE the handler
    // body runs, so the check always sees a fresh run for
    // `system.daily-health-check` itself and can never flag itself as overdue.
    if (schedules.overdue.length > 0) throw new ScheduledJobsOverdueError(schedules);

    // ⚠️ ONLY `unpullable` IS LOUD. `indeterminate` means the probe could not
    // REACH the registry — a network statement, not an image one — and failing
    // on it would page an operator about ghcr.io's uptime and, worse, teach them
    // that this row is usually noise. The verdict is still recorded on the
    // `job_run` row either way, so a run of consecutive indeterminates is
    // readable; it is just not an alarm.
    if (fleet.verdict === 'unpullable') throw new FleetImageUnpullableError(fleet);

    return { ...DAILY_HEALTH_CHECK_PAYLOAD, schedules, fleet };
  },
);
