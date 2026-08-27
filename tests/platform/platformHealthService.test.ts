import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformSignalDTO, PlatformSignalId } from '@/lib/dto/platformHealth';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { platformHealthService } from '@/lib/services/platformHealthService';
import { jobScheduleHealthService } from '@/lib/services/jobScheduleHealthService';
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
    // ⚠️ `fn.opts.id`, NOT `fn.id`. `id` on the constructed function is a METHOD
    // (it prefixes the app id); `opts` is what Inngest KEPT of the config the
    // definition declared, which is the string `defineJob` builds the synthetic
    // event name from. Reading the method would have produced a passing-looking
    // comparison against a function body.
    declaredId = (dailyHealthCheck as unknown as { opts: { id: string } }).opts.id;
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
