import 'server-only';

import { deploymentIdentity } from '@/lib/deployment/identity';
import type {
  PlatformHealthDTO,
  PlatformOverdueScheduleDTO,
  PlatformQueueHealthDTO,
  PlatformSignalDTO,
} from '@/lib/dto/platformHealth';
import { serverSentryDsn } from '@/lib/monitoring/config';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { databaseHealthRepository } from '@/lib/repositories/databaseHealthRepository';
import { jobRunDlqRepository } from '@/lib/repositories/jobRunDlqRepository';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { jobScheduleHealthService } from '@/lib/services/jobScheduleHealthService';
import { platformAuditService } from '@/lib/services/platformAuditService';
import { withSystemContext } from '@/lib/workspaces/context';

/**
 * The day-1 system-health glance — design `platform-admin/design-notes.md`
 * **Panel 8**, card MOTIR-1167.
 *
 * ⚠️ THE RULE THIS SERVICE EXISTS TO KEEP: an unreachable probe must never read
 * as a zero. The asset states it in situ, on the card that demonstrates it:
 *
 * > The Errors card says "No response from Sentry" and "this is **not** an error
 * > count of zero" — a green card reading "0 errors" while the probe is down is
 * > the failure this panel exists to prevent.
 *
 * So every probe below is INDIVIDUALLY guarded, and a probe that throws yields
 * `state: 'unreachable'` with an EMPTY `values` bag. There is no `?? 0` anywhere
 * in this file, and adding one would be the whole defect.
 *
 * ⚠️ AND ONE FAILING PROBE MUST NOT TAKE THE BOARD DOWN. The design's argument
 * for putting all three tones on ONE board is that *"an operator's real screen is
 * mixed"* — which is only true if the mixed screen renders. Each probe absorbs
 * its own failure through `probe()` below, so the six run concurrently and none
 * of them can reject; that is why the gather is a plain `Promise.all` and why
 * `probe()` is the ONE place a throw becomes `unreachable`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE AUDIT ROW IS WRITTEN OUTSIDE A `withPlatformRead` TRANSACTION
 * ---------------------------------------------------------------------------
 * The ADR's §3a contract — *"the audit row is INSERTed as the first statement
 * inside the same transaction as the read"* — binds a CROSS-TENANT read to its
 * trail, so that a read cannot commit without one. This service reads no tenant
 * row at all: the six signals come from the job ledger, the dead-letter set and
 * the deployment's own environment, which is exactly why `health.read` is its
 * own action rather than an `estate.read`. The row is still written FIRST and
 * unconditionally, so the trail cannot be missing; what it is not is transacted
 * with reads that are not tenant reads and do not share its client.
 *
 * ---------------------------------------------------------------------------
 * READ AND LINK, NEVER REMEDIATE
 * ---------------------------------------------------------------------------
 * There is no replay here, no redeploy, no cancel. Every card carries a link-out
 * to the provider's own dashboard, which is 10.2's *integrate-not-rebuild* stance
 * applied one story early — and it is why nothing in this file needs a write.
 */

/**
 * The synthetic event name the daily health check's cron ticks are recorded
 * under — `defineJob` writes `scheduled.{id}` for every scheduled run.
 *
 * A LITERAL here rather than an import of the job definition, deliberately.
 * `jobScheduleHealthService`'s own header records why that module is not
 * imported from a service: `registry → definitions/dailyHealthCheck →
 * jobScheduleHealthService → registry` is an ESM cycle, and importing the
 * definition from here would evaluate the same chain for one string. The pair is
 * pinned instead by `tests/platform/platformHealthService.test.ts`, which
 * imports the definition and asserts the two agree — the same guard
 * `tests/monitoring/sentry-wiring.test.ts` puts on its own cross-file constant.
 */
const DAILY_HEALTH_CHECK_EVENT_NAME = 'scheduled.system.daily-health-check';

/** How many overdue schedules the list renders before the pager elides the rest. */
const OVERDUE_PAGE_SIZE = 10;

/** The window the "Failed jobs" card counts dead-letters over. */
const DLQ_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Above this, the database ping reads as `degraded` rather than `healthy`.
 *
 * 500ms is not a service-level objective and is not presented as one — it is the
 * point past which "reachable" stops being the useful answer to an operator
 * looking at this board during an incident. The real latency is always rendered
 * beside it, so the operator judges the number and not this constant.
 */
const DB_SLOW_MS = 500;

/**
 * How long the OLDEST claimable run may wait before the queue reads `stalled`.
 *
 * ⚠️ AGE IS THE SIGNAL AND DEPTH IS THE CONTEXT, which is the whole shape of
 * this check. A deep queue draining fast is healthy; a queue three rows deep
 * that has not moved in twenty minutes is not, and only one of those two numbers
 * can tell them apart.
 *
 * Five minutes, and the reasoning is arithmetic rather than taste. A DUE row is
 * claimable immediately: the worker's idle poll ceiling is `IDLE_MAX_MS` = 5 s
 * (`lib/jobs/engine/worker.ts`), and a `NOTIFY` normally beats even that. A row
 * that is backed off after a failure, debounced, or scheduled for later is NOT
 * due, so none of those explain a wait here — `readDueBacklog` filters on
 * `run_at <= now()` precisely so that this constant has one meaning. Five
 * minutes is therefore sixty poll intervals of slack, which is generous enough
 * that a deploy, a slow reclaim or a long claim transaction cannot reach it, and
 * tight enough that the 2026-08-28 stall — 30 minutes unclaimed, 139 rows deep
 * — would have fired twenty-five minutes before anybody asked why the tree
 * looked broken.
 */
const QUEUE_STALL_MS = 5 * 60 * 1000;

export const platformHealthService = {
  /**
   * The whole glance, for one platform principal.
   *
   * Takes the principal as its FIRST parameter and re-asserts the ladder (ADR
   * §3's layer table): the `(admin)` layout gates the PAGES, and a service that
   * trusted it would be one server action away from being reachable without it.
   * `support` is the minimum — the drill-down and the glance are read surfaces,
   * and only Panel 9's two writes ask for `operator`.
   */
  async read(principal: PlatformPrincipal, now: Date = new Date()): Promise<PlatformHealthDTO> {
    await requirePlatformStaff('support');
    await platformAuditService.record(principal, {
      action: 'health.read',
      targetKind: 'platform',
    });

    const schedules = probe(() => jobScheduleHealthService.check(now));
    const [database, hosting, scheduleSignal, failedJobs, errors, lastHealthCheck] =
      await Promise.all([
        databaseSignal(),
        Promise.resolve(hostingSignal()),
        scheduleSignalFrom(schedules),
        failedJobsSignal(now),
        Promise.resolve(errorsSignal()),
        lastHealthCheckSignal(now),
      ]);

    const report = await schedules;
    const overdue: PlatformOverdueScheduleDTO[] = (report?.overdue ?? []).map((entry) => ({
      functionId: entry.functionId,
      cron: entry.cron,
      lastRunAt: entry.lastRunAt,
      expectedAt: entry.judgedAgainst,
    }));

    return {
      checkedAt: now.toISOString(),
      signals: [database, hosting, scheduleSignal, failedJobs, errors, lastHealthCheck],
      overdue: overdue.slice(0, OVERDUE_PAGE_SIZE),
      overdueTotal: overdue.length,
      schedulesChecked: report?.entries.length ?? 0,
    };
  },

  /**
   * THE QUEUE BACKLOG (Subtask MOTIR-3764) — the one reading on this service
   * that is NOT part of {@link read}'s glance, and not gated by a staff session.
   *
   * ⚠️ IT IS COMPUTED BY A DIRECT QUERY, NOT BY A JOB, NOT FROM A CACHE, AND NOT
   * FROM A COUNTER THE WORKER HOLDS. On 2026-08-28 the queue stopped being
   * claimed at 10:15:16 and the only thing that noticed was a person wondering
   * why six work items had not moved. Nothing else could have: the check that
   * would report it, `system.daily-health-check`, is itself a job — so a wedged
   * worker takes the alarm down with the thing it is meant to alarm on. Every
   * signal above was green throughout, because a queue 139 rows deep with a
   * healthy worker, a current lease and zero failures is green on all six.
   *
   * ⚠️ AND IT THROWS RATHER THAN ABSORBING. `probe()` exists so one dead card
   * cannot take the board down, which is right for a board and wrong here: the
   * caller is a machine deciding whether to page somebody, and an unreadable
   * database must reach it as a failure rather than as a healthy-looking reading
   * with a reason in it. The route turns the throw into a 503.
   */
  async readQueueHealth(now: Date = new Date()): Promise<PlatformQueueHealthDTO> {
    const { depth, oldestRunAt } = await withSystemContext((tx) =>
      jobQueueRepository.readDueBacklog(tx),
    );
    // `max(0, …)` because `run_at` is a DUE time, and a row due one millisecond
    // ago has a negative age against a clock read a moment earlier.
    const oldestPendingAgeMs =
      oldestRunAt === null ? null : Math.max(0, now.getTime() - oldestRunAt.getTime());

    return {
      // AGE decides, never depth. An empty queue has no age and is healthy.
      state:
        oldestPendingAgeMs !== null && oldestPendingAgeMs > QUEUE_STALL_MS ? 'stalled' : 'healthy',
      depth,
      oldestPendingAgeMs,
      stallThresholdMs: QUEUE_STALL_MS,
      checkedAt: now.toISOString(),
    };
  },
};

/**
 * Run one probe and turn a throw into `null` rather than a rejection.
 *
 * The single place a probe's failure is absorbed, so that `unreachable` is
 * produced in exactly one way and can never be confused with a measured zero.
 */
async function probe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** An unreachable card — no number, and a `reason` the copy names in words. */
function unreachable(id: PlatformSignalDTO['id'], reason: string, linkOut: string | null) {
  return { id, state: 'unreachable', values: { reason }, linkOut } satisfies PlatformSignalDTO;
}

async function databaseSignal(): Promise<PlatformSignalDTO> {
  const startedAt = Date.now();
  const ok = await probe(async () => {
    await withSystemContext((tx) => databaseHealthRepository.ping(tx));
    return true;
  });
  if (!ok) return unreachable('database', 'unreachable', neonConsoleUrl());

  const ms = Date.now() - startedAt;
  return {
    id: 'database',
    state: ms > DB_SLOW_MS ? 'degraded' : 'healthy',
    values: { ms, region: databaseRegion() },
    linkOut: neonConsoleUrl(),
  };
}

/**
 * Where the app is running.
 *
 * ⚠️ THE PROVIDER KNOWLEDGE IS NOT HERE, AND MUST NOT COME BACK.
 * `docs/decisions/ci-runner-fleet.md` §4 rule 1 keeps `lib/` provider-agnostic,
 * and `tests/ciFleet/orchestratorPortBoundary.test.ts` enforces it by scanning
 * SOURCE — so this service reads a neutral `DeploymentIdentity` and names no
 * platform, no environment variable and no dashboard host. The one file allowed
 * to know is `lib/deployment/identity.ts`, which carries the whole argument
 * including why a machine COUNT is not among the things it answers.
 *
 * (This service failed that guard on its first push, with three raw `FLY_*`
 * reads inline. The guard was right and the fix is the accessor, not an
 * exemption for a service.)
 */
function hostingSignal(): PlatformSignalDTO {
  const deployment = deploymentIdentity();
  if (!deployment.app) return unreachable('hosting', 'notManaged', null);

  return {
    id: 'hosting',
    state: 'healthy',
    values: {
      app: deployment.app,
      region: deployment.region ?? '—',
      machineId: deployment.instanceId ?? '—',
    },
    linkOut: deployment.dashboardUrl,
  };
}

async function scheduleSignalFrom(
  report: Promise<Awaited<ReturnType<typeof jobScheduleHealthService.check>> | null>,
): Promise<PlatformSignalDTO> {
  const resolved = await report;
  if (!resolved) return unreachable('schedules', 'probeFailed', null);

  return {
    id: 'schedules',
    state: resolved.overdue.length > 0 ? 'degraded' : 'healthy',
    values: { overdue: resolved.overdue.length, total: resolved.entries.length },
    linkOut: null,
  };
}

async function failedJobsSignal(now: Date): Promise<PlatformSignalDTO> {
  const since = new Date(now.getTime() - DLQ_WINDOW_MS);
  const count = await probe(() =>
    withSystemContext((tx) => jobRunDlqRepository.countActiveSince(since, tx)),
  );
  if (count === null) return unreachable('failedJobs', 'probeFailed', null);

  return {
    id: 'failedJobs',
    state: count > 0 ? 'degraded' : 'healthy',
    values: { count },
    linkOut: null,
  };
}

/**
 * The error-monitoring signal.
 *
 * ⚠️ ALWAYS `unreachable`, AND THAT IS THE HONEST ANSWER RATHER THAN A STUB.
 * The design asset (merged 2026-08-10) drew this card unreachable because Sentry
 * was not wired at all — *"`grep sentry package.json` returns nothing today"*.
 * That fact has since changed: MOTIR-1162 merged on 2026-08-26 and Sentry now
 * reports from the server, the edge and the browser. What has NOT changed is
 * that reading an error COUNT back needs a Sentry API token, which no card has
 * provisioned and which Story 10.2 owns along with every other read-only
 * provider integration.
 *
 * So the two states below are both `unreachable` and they say DIFFERENT things,
 * because an operator needs to tell "this deployment does not report errors at
 * all" from "it reports them and this console cannot read the count yet". What
 * neither of them does is render a zero.
 */
function errorsSignal(): PlatformSignalDTO {
  const reason = serverSentryDsn() ? 'noReadCredential' : 'notConfigured';
  return unreachable('errors', reason, SENTRY_ISSUES_URL);
}

/**
 * When the daily health check last ran, and whether that tick passed.
 *
 * ⚠️ THREE OUTCOMES, NOT TWO, and collapsing the last two is the bug this card
 * is about. "The probe threw" and "the ledger holds no such run" are BOTH absent
 * numbers and they mean opposite things: the first says this console cannot see
 * the ledger, the second says the check has never fired — which is itself the
 * loudest thing this board could tell an operator. `probe()` returns `null` for
 * a throw and the read returns `null` for no row, so the two are wrapped to keep
 * them distinguishable rather than compared against the same literal.
 */
async function lastHealthCheckSignal(now: Date): Promise<PlatformSignalDTO> {
  void now;
  const read = await probe(async () => ({
    run: await withSystemContext((tx) =>
      jobRunRepository.findLatestByEventName(DAILY_HEALTH_CHECK_EVENT_NAME, tx),
    ),
  }));
  if (read === null) return unreachable('lastHealthCheck', 'probeFailed', null);
  if (read.run === null) return unreachable('lastHealthCheck', 'never', null);

  return {
    id: 'lastHealthCheck',
    state: read.run.status === 'succeeded' ? 'healthy' : 'degraded',
    values: { ranAt: read.run.startedAt.toISOString(), status: read.run.status },
    linkOut: null,
  };
}

/**
 * The Neon project the app talks to, named from `DATABASE_URL`'s HOST rather
 * than from a decision record.
 *
 * The host is the one identifier that is true of the connection actually open —
 * an ADR records where the project was created, and a deployment pointed
 * somewhere else would still read `iad` out of it. Neon encodes the region in
 * the hostname (`…-<region>.aws.neon.tech`), so the substring is a reading and
 * not a lookup; anything else renders as the raw host, which is still the truth.
 */
function databaseRegion(): string {
  const url = process.env['DATABASE_URL'];
  if (!url) return '—';
  try {
    const host = new URL(url).hostname;
    const match = /-([a-z]{2}-[a-z]+-\d)\.aws\.neon\.tech$/.exec(host);
    return match?.[1] ?? host;
  } catch {
    return '—';
  }
}

/**
 * The Neon console, or null when this deployment is not on Neon.
 *
 * There is no project id in the connection string, so the link is to the
 * console's project list rather than to this project — a deliberate under-claim.
 * A constructed deep link that 404s during an incident is worse than a list.
 */
function neonConsoleUrl(): string | null {
  const url = process.env['DATABASE_URL'];
  return url?.includes('neon.tech') ? 'https://console.neon.tech/app/projects' : null;
}

/**
 * ⚠️ THE JOB SIGNALS HAVE NO LINK-OUT, AND THAT IS THE CORRECTION MOTIR-3418
 * MAKES RATHER THAN AN OMISSION.
 *
 * They used to point at a vendor dashboard —
 * `app.inngest.com/env/production/{functions,runs}` — carrying the design's own
 * deliberate inaccuracy, kept because it was the design's:
 *
 * > "Failed after their retries. Inngest has no literal DLQ — this is the
 * > failed-set, and replay happens there."
 *
 * That was already half wrong when it was written (`job_run_dlq` is Motir's own
 * table, and a job on the Postgres engine never reached the vendor at all), and
 * it is wholly wrong now: the account is being closed, so the link would take an
 * operator mid-incident to a page with nothing on it — or to a login for a
 * product this company no longer uses.
 *
 * ⚠️ AND THE REPLACEMENT IS NOT A DIFFERENT URL. The per-run detail an operator
 * actually wants is one workspace deep in `/settings/workspace/jobs`, and that is
 * a per-WORKSPACE surface this console must not fork — the asset says so and so
 * does the card. A link-out this console cannot honestly construct is `null`,
 * which the DTO already models (`hostingSignal` returns one on a deployment that
 * is not managed) and which the card renders as text without an affordance.
 */
const SENTRY_ISSUES_URL = 'https://sentry.io/issues/';
