import { defineJob } from '../defineJob';
import {
  describeLaneDrift,
  reconcileLanes,
  type LaneDrifted,
  type LaneReconciliation,
} from '../engine/census';
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
// The probes are independent faults sharing one surface, not one check: a
// stale registry strands functions, an unpullable image strands containers.
//
// As of MOTIR-3716 it carries the LANE RECONCILIATION, for the same reason and
// with the same argument: the checked-in declaration of which lane each job runs
// on (`lib/jobs/engine/census.ts`) and the live secret that actually decides it
// (`MOTIR_POSTGRES_JOB_IDS`) were kept equal BY HAND, and four jobs drifted in
// ~34 hours. The fault is invisible per job — a drifted job runs, daily, on the
// wrong lane, with every code-side signal green — so the only thing that can see
// it is a deployment-wide assertion made somewhere a person already looks. This
// job is that place.
//
// ⚠️ AND IT IS LOUD HERE AND QUIET AT BOOT, deliberately. The worker reports the
// same difference at start-up (`logLaneReconciliation()`) and cannot throw,
// because the deploy window in which the code is ahead of the secret is REQUIRED
// (`docs/jobs.md`'s image trap: routing an id whose job is not in the running
// image routes it nowhere, so deploy-then-route is the only correct order). A
// difference that is still there at 09:00 the next morning is not a deploy
// window, and by then the cheap moment to fix it has passed — which is exactly
// when this job runs.
//
// As of MOTIR-2030 the boot preflight is TWO probes, because the fleet has two
// pull paths. MOTIR-1989 added the indexer image, and §5's third constraint on
// its mirror is explicit: "It is a second pull path. The fleet then has two, and
// each needs §6's preflight independently." They are reported separately rather
// than merged for the reason the verdict is not a boolean — the operator surface
// is a MESSAGE, and a message naming the wrong image is worse than none. §5's
// second constraint is why the indexer's matters most: `registry.fly.io`
// garbage-collects unreferenced images, and a fleet whose machines are ephemeral
// by design references nothing between jobs.
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
  /** The INDEXER image's preflight verdict (MOTIR-2030) — the fleet's second
   *  pull path, recorded beside the runner's rather than merged into it. A
   *  deployment that runs CI but does not index reports `not_applicable` here
   *  while `fleet` says `bootable`, and the ledger can tell those apart. */
  indexFleet: FleetBootableVerdict;
  /** The lane reconciliation's verdict (MOTIR-3716). Recorded on the healthy
   *  tick too, and that is the point: the `in_sync` arm carries the number of
   *  ids that agreed, so a clean deployment is readable as an ASSERTION rather
   *  than as the absence of noise. `not_cut_over` and `not_applicable` are kept
   *  apart for the same reason — an unconfigured deployment reading as "nothing
   *  to see here" is the shape this probe exists to end. */
  lanes: LaneReconciliation;
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

/**
 * Thrown when the deployment's configured INDEXER image cannot be pulled
 * (MOTIR-2030) — §5's third constraint, given the loud surface §6 requires.
 *
 * A SEPARATE error from {@link FleetImageUnpullableError}, and the message is
 * the reason: it names the INDEXER's reference, the INDEXER's variable, and the
 * failure mode peculiar to that path. §5's second constraint makes the likely
 * cause a GARBAGE-COLLECTED mirror rather than a visibility mistake — Fly cleans
 * up unreferenced images and a fleet of ephemeral machines references nothing
 * between jobs — so the message says to re-run the mirror step, which is a
 * different fix from "check the package's visibility". Telling an operator to
 * check GHCR visibility for an image Fly quietly collected would send them to
 * the wrong registry entirely.
 */
export class IndexFleetImageUnpullableError extends Error {
  constructor(readonly verdict: Extract<FleetBootableVerdict, { verdict: 'unpullable' }>) {
    super(
      `The fleet's INDEXER image cannot be pulled: ${verdict.reference} — ${verdict.detail}. ` +
        `No code-graph index container can boot until this is fixed; CI is unaffected ` +
        `(it pulls a different image). Check that MOTIR_INDEXER_IMAGE names a digest that ` +
        `still exists, and suspect the mirror first: registry.fly.io garbage-collects ` +
        `UNREFERENCED images and the fleet's machines are ephemeral, so re-run the ` +
        `release lane's registry-to-registry copy (docs/decisions/fleet-image-pull.md §5).`,
    );
    this.name = 'IndexFleetImageUnpullableError';
  }
}

/**
 * Thrown when the checked-in lane declaration and the live `MOTIR_POSTGRES_JOB_IDS`
 * disagree (MOTIR-3716) — the difference nothing in the system had ever compared.
 *
 * Its message names BOTH directions and every id in each, because that message
 * is the DLQ row's `failure` and therefore the entire thing an operator reads.
 * "The lanes have drifted" would be true and useless; a list of ids and which
 * secret to edit is a fix. The two directions are stated even when one is empty —
 * "nothing in the other direction" is itself what a reader is checking for.
 */
export class JobLaneDriftError extends Error {
  constructor(readonly reconciliation: LaneDrifted) {
    super(describeLaneDrift(reconciliation));
    this.name = 'JobLaneDriftError';
  }
}

export const dailyHealthCheck = defineJob(
  {
    id: 'system.daily-health-check',
    cron: DAILY_HEALTH_CHECK_CRON,
    // `latest` — and this job is the one where the disposition feeds back into
    // the probe it carries (`docs/decisions/job-queue-foundation.md` §11.7).
    // `judge()` forgives exactly one missed tick, so catching up on restart
    // stamps `lastRunAt` and keeps that tolerance meaning what it was designed to
    // mean. Under `skip`, a routine worker restart spanning 09:00 would leave this
    // job two ticks stale and its own first act the next day would be to report
    // ITSELF overdue and dead-letter — a fault manufactured by the schedule
    // rather than observed.
    catchUp: 'latest',
    retryPolicy: 'none',
  },
  async (ctx, services): Promise<DailyHealthCheckResult> => {
    // `step.run` memoizes the read, so the verdict is captured once per run
    // rather than re-derived on every replay of the handler body.
    const schedules = await ctx.step.run('schedule-health', () =>
      services.jobScheduleHealth.check(),
    );
    const fleet = await ctx.step.run('fleet-boot-preflight', () => services.fleetPreflight.check());
    const indexFleet = await ctx.step.run('index-fleet-boot-preflight', () =>
      services.fleetPreflight.checkIndexFleet(),
    );
    // ⚠️ IMPORTED DIRECTLY, NOT THROUGH `services` — and the ESLint boundary is
    // what settles it. `lib/jobs/engine/**` is internal to the jobs runtime and
    // is importable only from `lib/jobs/**` and `scripts/worker.ts`, so a
    // `lib/services/*` wrapper for it would be a rule violation dressed as a
    // seam. This is the same call `defineJob` and the scheduler make of
    // `routedToEngine`, one file over. The probe is a pure set difference over a
    // module constant and one environment variable, so a test seeds it by
    // setting `MOTIR_POSTGRES_JOB_IDS` rather than by stubbing anything.
    const lanes = await ctx.step.run('lane-reconciliation', async () => reconcileLanes());

    // ⚠️ EVERY PROBE RUNS BEFORE ANY OF THEM THROWS. A stale registry, an
    // unpullable runner image and an unpullable indexer image are independent
    // faults, and a run that reported only the first would hide the rest for as
    // many days as the first took to fix. So all the reads are taken above and
    // only the reporting is ordered. This is why MOTIR-2030's probe is a second
    // `step.run` rather than a branch inside the first one.
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

    // The INDEXER path, reported after the runner's and on exactly the same
    // terms: only a DEFINITE refusal is loud, and `not_applicable` — a deployment
    // that runs CI but has not wired `MOTIR_INDEXER_IMAGE` — is a green state,
    // not a fault. Runner first only because a deployment that cannot boot CI has
    // the larger outage; both verdicts are on the row either way.
    if (indexFleet.verdict === 'unpullable') throw new IndexFleetImageUnpullableError(indexFleet);

    // ⚠️ ONLY `drifted` IS LOUD, and the quiet arms are quiet for reasons that
    // are not the same as each other. `not_applicable` means the test-only file
    // override is armed, so there is no deployment to compare against.
    // `not_cut_over` means the secret names nothing — every job on Inngest,
    // which is the switch's safety default and a legitimate steady state for an
    // install that never started the migration; dead-lettering daily over a
    // migration somebody chose not to run would teach an operator that this row
    // is noise. Both are still RECORDED on the `job_run` row above, which is what
    // keeps an unconfigured deployment from reading as a clean one.
    if (lanes.verdict === 'drifted') throw new JobLaneDriftError(lanes);

    return { ...DAILY_HEALTH_CHECK_PAYLOAD, schedules, fleet, indexFleet, lanes };
  },
);
