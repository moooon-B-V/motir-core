import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformSignalDTO, PlatformSignalId } from '@/lib/dto/platformHealth';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { platformHealthService } from '@/lib/services/platformHealthService';
import { jobScheduleHealthService } from '@/lib/services/jobScheduleHealthService';
import { databaseHealthRepository } from '@/lib/repositories/databaseHealthRepository';
import { jobRunDlqRepository } from '@/lib/repositories/jobRunDlqRepository';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

/**
 * The day-1 system-health glance (MOTIR-1167 · design
 * `platform-admin/design-notes.md` Panel 8).
 *
 * ⚠️ THE LOAD-BEARING PROPERTY IS AN ABSENCE, so it is tested as one. The asset's
 * argument for the panel is a single sentence — *"an unreachable probe must never
 * read as a zero"* — and the only way to assert that is to break each probe in
 * turn and check that no NUMBER comes back, rather than checking that the happy
 * path renders. A suite that only exercised the green board would pass on an
 * implementation that answered `0` for every failure.
 */

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    // The gate reads a session, and the test environment has no cookies — the
    // one `vi.mock` `CLAUDE.md` allows, applied to the platform tier's own
    // equivalent. Everything below the gate is the real path against real
    // Postgres. `platformStaffGate.test.ts` is what tests the gate itself.
    requirePlatformStaff: vi.fn(async () => currentPrincipal),
  };
});

let currentPrincipal: PlatformPrincipal;

async function seedStaff(): Promise<PlatformPrincipal> {
  const user = await createTestUser({ email: 'ops+health@moooon.net' });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'support' } });
  return { userId: user.id, email: user.email, role: 'support' };
}

function signal(signals: PlatformSignalDTO[], id: PlatformSignalId): PlatformSignalDTO {
  const found = signals.find((s) => s.id === id);
  if (!found) throw new Error(`no ${id} signal`);
  return found;
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateJobRuns();
  await truncateAuthTables();
  currentPrincipal = await seedStaff();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the event name the "last health check" card reads', () => {
  // ⚠️ IMPORT ONCE, AND GIVE THAT ONE IMPORT A BUDGET OF ITS OWN.
  //
  // Evaluating the job definition pulls in the orchestrator and the job engine,
  // and `vitest.config.ts`'s `testTimeout` is 15 s — sized for a database test,
  // not for a module graph. It resolves in ~4 s on an idle box and times out
  // when this file shares a runner with the rest of the suite, which reads as a
  // broken guard rather than a slow one. Hoisting it into a budgeted hook is the
  // same remedy `tests/coverage-gate-globs.test.ts` took for its whole-tree glob
  // (MOTIR-2815), and it weakens no assertion: the case below is unchanged.
  let declaredId: string;
  beforeAll(async () => {
    const { dailyHealthCheck } = await import('@/lib/jobs/definitions/dailyHealthCheck');
    // ⚠️ IT USED TO READ `fn.opts.id`, NOT `fn.id` (MOTIR-3418). On the vendor's
    // constructed function object `id` was a METHOD that prefixed the app id, and
    // `opts` was what the SDK kept of the declared config — so reading the method
    // produced a passing-looking comparison against a function body. `defineJob`
    // returns the declaration now, and `id` on it is the plain string the ledger's
    // synthetic event name is built from.
    declaredId = dailyHealthCheck.id;
  }, 60_000);

  it('is the synthetic name `defineJob` records the cron under', async () => {
    // ⚠️ THE PAIR THIS PINS. `platformHealthService` carries the event name as a
    // LITERAL rather than importing the job definition, because that import is
    // an ESM cycle (`jobScheduleHealthService`'s header records why). A literal
    // in one file and a job id in another is exactly the pair that drifts, so
    // the guard lives here — the same shape `tests/monitoring/sentry-wiring.test.ts`
    // puts on its own cross-file constant. If this fails, the console's "Last
    // health check" card has silently been reading an event nothing writes, and
    // it would have rendered "never run" for ever without erroring.
    expect(declaredId).toBe('system.daily-health-check');

    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('lib/services/platformHealthService.ts', 'utf8'),
    );
    expect(source).toContain(`'scheduled.${declaredId}'`);
  });
});

describe('the six signals', () => {
  it('reports the whole board, one card per signal, in the asset order', async () => {
    const health = await platformHealthService.read(currentPrincipal);
    expect(health.signals.map((s) => s.id)).toEqual([
      'database',
      'hosting',
      'schedules',
      'failedJobs',
      'errors',
      'lastHealthCheck',
    ]);
  });

  it('reads the database as reachable, with a measured latency', async () => {
    const health = await platformHealthService.read(currentPrincipal);
    const database = signal(health.signals, 'database');
    expect(database.state).toBe('healthy');
    expect(typeof database.values['ms']).toBe('number');
  });

  it('counts only NOT-yet-replayed dead letters, and only inside the window', async () => {
    const now = new Date('2026-08-26T12:00:00.000Z');
    const dlq = (over: Partial<{ lastFailedAt: Date; replayedAt: Date | null }>) => ({
      functionId: 'system.thing',
      eventName: 'scheduled.system.thing',
      eventData: {},
      failure: { message: 'boom' },
      attempts: 3,
      firstFailedAt: now,
      lastFailedAt: now,
      replayedAt: null,
      ...over,
    });
    await adminDb.jobRunDlq.createMany({
      data: [
        dlq({}),
        dlq({}),
        // Replayed — an operator has already dealt with it.
        dlq({ replayedAt: now }),
        // Older than 24h — outside the card's window.
        dlq({ lastFailedAt: new Date('2026-08-24T12:00:00.000Z') }),
      ],
    });

    const health = await platformHealthService.read(currentPrincipal, now);
    const failed = signal(health.signals, 'failedJobs');
    expect(failed.values['count']).toBe(2);
    expect(failed.state).toBe('degraded');
  });

  it('is healthy — not unreachable — when there are genuinely zero dead letters', async () => {
    // The other side of the never-render-a-zero rule, and the reason it is not
    // simply "never render a number": a MEASURED zero is the best news on the
    // board and must be reported as such. Only an unmeasured one is forbidden.
    const health = await platformHealthService.read(currentPrincipal);
    const failed = signal(health.signals, 'failedJobs');
    expect(failed.state).toBe('healthy');
    expect(failed.values['count']).toBe(0);
  });

  it('says the daily health check has NEVER RUN rather than reporting a stale time', async () => {
    const health = await platformHealthService.read(currentPrincipal);
    const last = signal(health.signals, 'lastHealthCheck');
    expect(last.state).toBe('unreachable');
    expect(last.values['reason']).toBe('never');
    expect(last.values).not.toHaveProperty('ranAt');
  });

  it('reads the latest daily-health-check run once the ledger has one', async () => {
    const ranAt = new Date('2026-08-26T09:00:00.000Z');
    await adminDb.jobRun.create({
      data: {
        functionId: 'system.daily-health-check',
        eventName: 'scheduled.system.daily-health-check',
        eventId: 'evt_1',
        lane: 'engine',
        attempt: 1,
        status: 'succeeded',
        startedAt: ranAt,
      },
    });
    const health = await platformHealthService.read(currentPrincipal);
    const last = signal(health.signals, 'lastHealthCheck');
    expect(last.state).toBe('healthy');
    expect(last.values['ranAt']).toBe(ranAt.toISOString());
  });

  it('reads a FAILED health-check tick as degraded, not as healthy', async () => {
    await adminDb.jobRun.create({
      data: {
        functionId: 'system.daily-health-check',
        eventName: 'scheduled.system.daily-health-check',
        eventId: 'evt_2',
        lane: 'engine',
        attempt: 1,
        status: 'failed',
        startedAt: new Date('2026-08-26T09:00:00.000Z'),
      },
    });
    const health = await platformHealthService.read(currentPrincipal);
    expect(signal(health.signals, 'lastHealthCheck').state).toBe('degraded');
  });
});

describe('⚠️ an unreachable probe never reads as a zero', () => {
  it('the ERRORS card reports no reading, with a reason, and no count', async () => {
    // The design's own demonstration case: *"the Errors card says 'No response
    // from Sentry' and 'this is not an error count of zero'"*. It is permanently
    // unreachable in this build — Sentry reports errors (MOTIR-1162) but reading
    // the count back needs an API credential Story 10.2 provisions — so the one
    // thing to assert is that it carries no number at all.
    const health = await platformHealthService.read(currentPrincipal);
    const errors = signal(health.signals, 'errors');
    expect(errors.state).toBe('unreachable');
    expect(Object.keys(errors.values)).toEqual(['reason']);
    expect(['noReadCredential', 'notConfigured']).toContain(errors.values['reason']);
  });

  it('a THROWING schedule probe yields unreachable with no overdue count', async () => {
    vi.spyOn(jobScheduleHealthService, 'check').mockRejectedValue(new Error('ledger gone'));

    const health = await platformHealthService.read(currentPrincipal);
    const schedules = signal(health.signals, 'schedules');
    expect(schedules.state).toBe('unreachable');
    // The whole rule, in two assertions: no `overdue`, and no `total`. A `?? 0`
    // in the service would satisfy the state check above and fail these.
    expect(schedules.values).not.toHaveProperty('overdue');
    expect(schedules.values).not.toHaveProperty('total');
  });

  it('a throwing probe does not take the rest of the board down', async () => {
    // The design's argument for one mixed board is that *"an operator's real
    // screen is mixed"* — which is only true if the mixed screen renders at all.
    vi.spyOn(jobScheduleHealthService, 'check').mockRejectedValue(new Error('ledger gone'));

    const health = await platformHealthService.read(currentPrincipal);
    expect(health.signals).toHaveLength(6);
    expect(signal(health.signals, 'database').state).toBe('healthy');
    expect(signal(health.signals, 'failedJobs').values['count']).toBe(0);
  });

  it('reports an EMPTY overdue list rather than a fabricated one when the probe fails', async () => {
    vi.spyOn(jobScheduleHealthService, 'check').mockRejectedValue(new Error('ledger gone'));

    const health = await platformHealthService.read(currentPrincipal);
    expect(health.overdue).toEqual([]);
    expect(health.overdueTotal).toBe(0);
    // ⚠️ AND `schedulesChecked` IS ZERO, which is the honest reading: the foot
    // says "{checked} schedules checked", and nothing was.
    expect(health.schedulesChecked).toBe(0);
  });
});

describe('the remaining probe arms (coverage floor, MOTIR-3766)', () => {
  // The story gate adopts this file into the per-file coverage gate, so the arms
  // the happy board never reaches get fixtures. Every one of them is a real
  // reading an operator can meet, and each is driven the way this file already
  // drives the schedule probe — a spy on the collaborator, or a stubbed env var,
  // never a mock of the service under test.

  it('an unreachable DATABASE reports no latency and no region', async () => {
    vi.spyOn(databaseHealthRepository, 'ping').mockRejectedValue(new Error('connection refused'));

    const database = signal(
      (await platformHealthService.read(currentPrincipal)).signals,
      'database',
    );
    expect(database.state).toBe('unreachable');
    expect(Object.keys(database.values)).toEqual(['reason']);
    expect(database.values).not.toHaveProperty('ms'); // never a zero-millisecond ping
  });

  it('an unreachable DLQ probe reports no failure COUNT', async () => {
    vi.spyOn(jobRunDlqRepository, 'countActiveSince').mockRejectedValue(new Error('gone'));

    const failed = signal(
      (await platformHealthService.read(currentPrincipal)).signals,
      'failedJobs',
    );
    expect(failed.state).toBe('unreachable');
    expect(failed.values).not.toHaveProperty('count');
  });

  it('dead letters in the window read DEGRADED, with the count', async () => {
    vi.spyOn(jobRunDlqRepository, 'countActiveSince').mockResolvedValue(3);

    const failed = signal(
      (await platformHealthService.read(currentPrincipal)).signals,
      'failedJobs',
    );
    expect(failed).toMatchObject({ state: 'degraded', values: { count: 3 } });
  });

  it('an unreachable LEDGER read is distinguishable from a check that never ran', async () => {
    // ⚠️ THREE OUTCOMES, NOT TWO — the service's own header. This is the first:
    // the probe threw. `never` (the read returned null) is the ordinary state of
    // a fresh database and is covered by the six-signals block above.
    vi.spyOn(jobRunRepository, 'findLatestByEventName').mockRejectedValue(new Error('gone'));

    const last = signal(
      (await platformHealthService.read(currentPrincipal)).signals,
      'lastHealthCheck',
    );
    expect(last).toMatchObject({ state: 'unreachable', values: { reason: 'probeFailed' } });
  });

  it('overdue crons read DEGRADED and the list carries them', async () => {
    const judgedAgainst = new Date('2026-08-28T09:00:00.000Z');
    vi.spyOn(jobScheduleHealthService, 'check').mockResolvedValue({
      entries: [
        {
          functionId: 'system.daily-health-check',
          cron: '0 9 * * *',
          lastRunAt: null,
          judgedAgainst,
          overdue: true,
        },
      ],
      overdue: [
        {
          functionId: 'system.daily-health-check',
          cron: '0 9 * * *',
          lastRunAt: null,
          judgedAgainst,
          overdue: true,
        },
      ],
    } as unknown as Awaited<ReturnType<typeof jobScheduleHealthService.check>>);

    const health = await platformHealthService.read(currentPrincipal);
    expect(signal(health.signals, 'schedules')).toMatchObject({
      state: 'degraded',
      values: { overdue: 1, total: 1 },
    });
    expect(health.overdue[0]).toMatchObject({
      functionId: 'system.daily-health-check',
      lastRunAt: null,
    });
  });

  it('a deployment the platform does not manage reports notManaged, not a blank card', async () => {
    vi.stubEnv('FLY_APP_NAME', '');

    const hosting = signal((await platformHealthService.read(currentPrincipal)).signals, 'hosting');
    expect(hosting).toMatchObject({ state: 'unreachable', values: { reason: 'notManaged' } });
    expect(hosting.linkOut).toBeNull(); // a self-hosted instance has no console to link to
  });

  it('a managed deployment missing its region or machine renders an em-dash, never an empty string', async () => {
    vi.stubEnv('FLY_APP_NAME', 'motir-core-test');
    vi.stubEnv('FLY_REGION', '');
    vi.stubEnv('FLY_MACHINE_ID', '');

    const hosting = signal((await platformHealthService.read(currentPrincipal)).signals, 'hosting');
    expect(hosting).toMatchObject({
      state: 'healthy',
      values: { app: 'motir-core-test', region: '—', machineId: '—' },
      linkOut: 'https://fly.io/apps/motir-core-test',
    });
  });

  it('a build with NO Sentry DSN says notConfigured — a different sentence from noReadCredential', async () => {
    // The two `unreachable` reasons mean opposite things to an operator: this
    // deployment does not report errors at all, versus it reports them and this
    // console cannot read the count yet.
    vi.stubEnv('SENTRY_DSN', '');

    const errors = signal((await platformHealthService.read(currentPrincipal)).signals, 'errors');
    expect(errors).toMatchObject({ state: 'unreachable', values: { reason: 'notConfigured' } });
  });

  it('a NEON url yields the region out of the HOST and the console link', async () => {
    // The region is a READING of the connection actually open, not a lookup in a
    // decision record — a deployment pointed elsewhere would still say `iad` if
    // this came from an ADR.
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@ep-cool-1234-us-east-1.aws.neon.tech/db');

    const database = signal(
      (await platformHealthService.read(currentPrincipal)).signals,
      'database',
    );
    expect(database.values['region']).toBe('us-east-1');
    expect(database.linkOut).toBe('https://console.neon.tech/app/projects');
  });

  it('a Neon host the region pattern does not match renders the RAW HOST, still the truth', async () => {
    // ⚠️ ASSERTED AS THE BEHAVIOUR, NOT AS A WISH. `databaseRegion`'s pattern
    // wants the region joined by a DASH (`…-us-east-1.aws.neon.tech`); a host
    // that separates it with a DOT does not match, and the accessor falls back to
    // the host — which its own comment calls "still the truth". Asserting a region
    // here would be asserting a regex this file does not own.
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@ep-cool-1234-pooler.us-east-1.aws.neon.tech/db');

    const database = signal(
      (await platformHealthService.read(currentPrincipal)).signals,
      'database',
    );
    expect(database.values['region']).toBe('ep-cool-1234-pooler.us-east-1.aws.neon.tech');
    expect(database.linkOut).toBe('https://console.neon.tech/app/projects');
  });

  it('a MALFORMED or absent DATABASE_URL degrades to an em-dash rather than throwing', async () => {
    vi.stubEnv('DATABASE_URL', 'not-a-url-at-all');
    const malformed = signal(
      (await platformHealthService.read(currentPrincipal)).signals,
      'database',
    );
    expect(malformed.values['region']).toBe('—');

    vi.stubEnv('DATABASE_URL', '');
    const absent = signal((await platformHealthService.read(currentPrincipal)).signals, 'database');
    expect(absent.values['region']).toBe('—');
    expect(absent.linkOut).toBeNull();
  });

  it('a SLOW database ping reads DEGRADED, with the real latency beside it', async () => {
    // 500ms is not an SLO and is not presented as one — it is the point past
    // which "reachable" stops being the useful answer during an incident, so the
    // measured number is rendered beside the verdict and the operator judges it.
    vi.spyOn(databaseHealthRepository, 'ping').mockImplementation(
      async () => new Promise((r) => setTimeout(r, 520)) as Promise<never>,
    );

    const database = signal(
      (await platformHealthService.read(currentPrincipal)).signals,
      'database',
    );
    expect(database.state).toBe('degraded');
    expect(Number(database.values['ms'])).toBeGreaterThan(500);
  });

  it('a non-Neon (or absent) DATABASE_URL yields no region and no console link', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pw@db.example.com:5432/app');

    const database = signal(
      (await platformHealthService.read(currentPrincipal)).signals,
      'database',
    );
    expect(database.values['region']).toBe('db.example.com'); // the raw host is still the truth
    expect(database.linkOut).toBeNull(); // never a console that is not this deployment's
  });
});
describe('the audit trail', () => {
  it('records ONE `health.read` row per read, against the operator', async () => {
    await platformHealthService.read(currentPrincipal);

    const rows = await adminDb.platformAuditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('health.read');
    expect(rows[0]!.targetKind).toBe('platform');
    expect(rows[0]!.actorUserId).toBe(currentPrincipal.userId);
    // A read, so no reason — the ADR's §3b rule, from the read side.
    expect(rows[0]!.reason).toBeNull();
  });

  it('records the read even when every probe fails', async () => {
    // The trail is about WHO LOOKED, not about what they found. An operator who
    // opened the board during an outage looked at it just as much as one who
    // opened it on a green day.
    vi.spyOn(jobScheduleHealthService, 'check').mockRejectedValue(new Error('ledger gone'));

    await platformHealthService.read(currentPrincipal);
    const rows = await adminDb.platformAuditLog.findMany();
    expect(rows.map((r) => r.action)).toEqual(['health.read']);
  });
});
