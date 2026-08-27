import 'server-only';

import type {
  PlatformHealthDTO,
  PlatformOverdueScheduleDTO,
  PlatformSignalDTO,
} from '@/lib/dto/platformHealth';
import { serverSentryDsn } from '@/lib/monitoring/config';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { databaseHealthRepository } from '@/lib/repositories/databaseHealthRepository';
import { jobRunDlqRepository } from '@/lib/repositories/jobRunDlqRepository';
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
 * Where the app is running, read from what the PLATFORM injects.
 *
 * ⚠️ THE DESIGN DRAWS A MACHINE COUNT AND THIS DELIBERATELY DOES NOT REPORT ONE.
 * `machine_count` is a reading of Fly's API, and this deployment has no runtime
 * credential that can take it: `FLY_FLEET_API_TOKEN` is scoped to the CI fleet's
 * OWN organization, which `production-service-stack.md` §7.5 requires to be
 * separate from motir-core's, so it cannot see this app. The one place the count
 * IS asserted is `ci.yml`'s deploy step, with a token that exists only there.
 *
 * The alternative — reading `fly.toml` and rendering what it PROMISES — is the
 * mistake this codebase has already paid for once: motir-ai's `fly.toml`
 * promised load spilling onto fresh machines while production ran ONE machine
 * for weeks, because *"Fly Proxy autostop/autostart never creates or destroys
 * Machines for you"*. A config file is a claim about a deployment, not a reading
 * of it, and a health board that renders the claim as the reading is worse than
 * one that renders nothing.
 *
 * So the card reports the identity of the machine ANSWERING — which is a genuine
 * reading of the platform, taken from inside it — and links out to the Fly
 * dashboard, where the count lives. The count arrives with Story 10.2, which is
 * the story that provisions a monitoring credential.
 */
function hostingSignal(): PlatformSignalDTO {
  const app = process.env['FLY_APP_NAME']?.trim();
  const region = process.env['FLY_REGION']?.trim();
  const machineId = process.env['FLY_MACHINE_ID']?.trim();
  if (!app) return unreachable('hosting', 'notManaged', null);

  return {
    id: 'hosting',
    state: 'healthy',
    values: { app, region: region ?? '—', machineId: machineId ?? '—' },
    linkOut: `https://fly.io/apps/${app}`,
  };
}

async function scheduleSignalFrom(
  report: Promise<Awaited<ReturnType<typeof jobScheduleHealthService.check>> | null>,
): Promise<PlatformSignalDTO> {
  const resolved = await report;
  if (!resolved) return unreachable('schedules', 'probeFailed', INNGEST_FUNCTIONS_URL);

  return {
    id: 'schedules',
    state: resolved.overdue.length > 0 ? 'degraded' : 'healthy',
    values: { overdue: resolved.overdue.length, total: resolved.entries.length },
    linkOut: INNGEST_FUNCTIONS_URL,
  };
}

async function failedJobsSignal(now: Date): Promise<PlatformSignalDTO> {
  const since = new Date(now.getTime() - DLQ_WINDOW_MS);
  const count = await probe(() =>
    withSystemContext((tx) => jobRunDlqRepository.countActiveSince(since, tx)),
  );
  if (count === null) return unreachable('failedJobs', 'probeFailed', INNGEST_RUNS_URL);

  return {
    id: 'failedJobs',
    state: count > 0 ? 'degraded' : 'healthy',
    values: { count },
    linkOut: INNGEST_RUNS_URL,
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
  if (read === null) return unreachable('lastHealthCheck', 'probeFailed', INNGEST_RUNS_URL);
  if (read.run === null) return unreachable('lastHealthCheck', 'never', INNGEST_RUNS_URL);

  return {
    id: 'lastHealthCheck',
    state: read.run.status === 'succeeded' ? 'healthy' : 'degraded',
    values: { ranAt: read.run.startedAt.toISOString(), status: read.run.status },
    linkOut: INNGEST_RUNS_URL,
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
 * The two Inngest link-outs, and the one deliberate inaccuracy in the design's
 * own copy, kept because it is the design's:
 *
 * > "Failed after their retries. Inngest has no literal DLQ — this is the
 * > failed-set, and replay happens there."
 *
 * `job_run_dlq` is Motir's own table, and a job routed to the Postgres engine
 * never reaches Inngest at all. The link is still the right destination for the
 * jobs that DO run there, and the per-run detail an operator actually wants is
 * one workspace deep in `/settings/workspace/jobs` — a per-WORKSPACE surface
 * this console must not fork (the asset says so, and so does the card).
 */
const INNGEST_FUNCTIONS_URL = 'https://app.inngest.com/env/production/functions';
const INNGEST_RUNS_URL = 'https://app.inngest.com/env/production/runs';
const SENTRY_ISSUES_URL = 'https://sentry.io/issues/';
