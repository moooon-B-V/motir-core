import { defineJob } from '../defineJob';
import type { ScheduleHealthReportDTO } from '@/lib/dto/jobSchedules';
import type { FleetBootableVerdict } from '@/lib/orchestrator';
import type { ContainerAiAddressVerdict } from '@/lib/ai/containerAiAddress';

// The canonical SCHEDULED job (Story 1.6 · Subtask 1.6.4) — the reference for
// the cron primitive, and the replacement for the 1.6.2 `system.ping` smoke
// job. Runs daily at 09:00, enqueued by the engine's own scheduler
// (`lib/jobs/engine/scheduler.ts`). It is still the worked example docs/jobs.md →
// "Scheduled jobs" points at, and still proves the scheduled path end-to-end
// (cron → scheduler → a `job_run` row whose `event_name` is the synthetic
// `scheduled.system.daily-health-check`).
//
// It began as a deliberate no-op. As of MOTIR-1970 it carries a real probe: the
// SCHEDULE-HEALTH CHECK, which fails the run when a cron job has stopped firing.
// It was written as the detection seam for a stale vendor app registry — the
// fault where a hosted scheduler's registered function list falls behind the
// deployed build, so a cron fires for nothing, in complete silence. That
// particular fault died with the vendor (MOTIR-3418): the schedule now comes out
// of the same image as the handler. The probe SURVIVES because the question it
// asks is engine-agnostic and still worth asking daily — a job whose `cron` was
// edited to an expression that never fires, a scheduler tick that stopped, a
// worker process nobody noticed had been down — and because the answer lands
// somewhere a person looks. `jobScheduleHealthService` carries the full
// reasoning.
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
// It briefly carried a THIRD probe, the LANE RECONCILIATION (MOTIR-3716): the
// checked-in declaration of which lane each job ran on against the live
// `MOTIR_POSTGRES_JOB_IDS` that actually decided it. MOTIR-3418 removed it with
// the second lane — there is nothing left to declare and nothing left to
// reconcile. It is named here rather than deleted silently because the fault it
// caught (four jobs drifting in ~34 hours, each running on the wrong engine with
// every code-side signal green) is the argument for putting the NEXT
// deployment-wide assertion in this job too.
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
// As of MOTIR-4518 it carries a FOURTH probe, and it is the first one that is
// not about an image. Both boot preflights ask whether a container can BOOT;
// neither ever asked whether the booted container can REACH anything. For two
// weeks every index container booted from a perfectly pullable image, built a
// 45 MB graph over nineteen minutes, and then died on
// `getaddrinfo ENOTFOUND motir-ai.internal` one call before it could upload it —
// because motir-core handed it motir-core's OWN private motir-ai address, and
// the container runs in a different organization. Both preflights were green the
// whole time, correctly: they were answering the question they were asked. This
// probe asks the other one. It is here for the reason every probe in this job is
// here — the fault's entire history is having had no loud surface.
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
  /** Whether the address an index container would be GIVEN for motir-ai can work
   *  for it (MOTIR-4518) — recorded on the healthy tick too, so the ledger can
   *  answer "was the container's motir-ai address sane yesterday?". A deployment
   *  that indexes reports `reachable`, `private_address` or `indeterminate`; one
   *  that does not reports `not_applicable` beside a `not_applicable`
   *  `indexFleet`. */
  indexContainerAi: ContainerAiAddressVerdict;
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
        `Check that the worker process group is running and that its scheduler is ticking ` +
        `(\`fly status -a motir-core\`, then the worker log's \`[job-scheduler]\` lines); a cron ` +
        `expression edited to one that never fires looks identical from here (MOTIR-1970).`,
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
 * Thrown when the address this deployment would hand an index container cannot
 * work for it (MOTIR-4518) — either unset, or PRIVATE and therefore unresolvable
 * from the fleet's organization.
 *
 * A SEPARATE error from the two image ones, and the message is the reason. Those
 * two send an operator to a REGISTRY; this one sends them to a Fly secret on
 * `motir-core`, and the fix is a different command in a different place. Telling
 * someone to re-run the image mirror for a name-resolution fault would send them
 * to the wrong system entirely — which is precisely what happened for two weeks
 * while both image probes reported green.
 *
 * It is loud on the two DEFINITE arms only. `indeterminate` means this process
 * could not reach the address, which is a statement about motir-core's network
 * rather than about the address, and failing on it would teach an operator that
 * this row is noise — the failure mode every probe in this job is written to
 * avoid.
 */
export class IndexContainerAiAddressError extends Error {
  constructor(
    readonly verdict: Extract<
      ContainerAiAddressVerdict,
      { verdict: 'unconfigured' | 'private_address' }
    >,
  ) {
    super(
      `An index container cannot reach motir-ai: ${verdict.detail} ` +
        `No code-graph index can be published until this is fixed — the container will still ` +
        `boot, download the repository and build the whole graph, and then throw it away at the ` +
        `upload grant. Set MOTIR_AI_CONTAINER_URL on motir-core to an address that resolves from ` +
        `OUTSIDE motir-core's own organization (motir-ai's public ingress; its container-facing ` +
        `routes are gated on the run-scoped credential either way). It is deliberately not ` +
        `MOTIR_AI_URL, which is motir-core's own private seam and must stay that way ` +
        `(MOTIR-3277 · MOTIR-4518).`,
    );
    this.name = 'IndexContainerAiAddressError';
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
    const indexContainerAi = await ctx.step.run('index-container-ai-address', () =>
      services.fleetPreflight.checkIndexContainerAiAddress(),
    );
    // ⚠️ EVERY PROBE RUNS BEFORE ANY OF THEM THROWS. A stopped schedule, an
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

    // The REACHABILITY probe, reported last and on the same terms: only the two
    // DEFINITE arms are loud. `indeterminate` is this process failing to reach an
    // address, not the address failing; `not_applicable` is a deployment that
    // does not index. Both are recorded on the row either way.
    if (
      indexContainerAi.verdict === 'unconfigured' ||
      indexContainerAi.verdict === 'private_address'
    ) {
      throw new IndexContainerAiAddressError(indexContainerAi);
    }

    return { ...DAILY_HEALTH_CHECK_PAYLOAD, schedules, fleet, indexFleet, indexContainerAi };
  },
);
