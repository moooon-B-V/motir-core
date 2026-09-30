import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CiRunnerProvisioningIntent } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { ciLiveChargeService, tickStartFor } from '@/lib/services/ciLiveChargeService';
import { fleetStopService } from '@/lib/services/fleetStopService';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { ciMinutesMeterService } from '@/lib/services/ciMinutesMeterService';
import { ciPeriodUsageRepository } from '@/lib/repositories/ciPeriodUsageRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { jobSchedules } from '@/lib/jobs/schedules';
import { CI_LIVE_CHARGE_CRON, ciLiveCharge } from '@/lib/jobs/definitions/ciLiveCharge';
import { JobTestEngine } from '../helpers/jobs';
import type { NormalizedWorkflowRunEvent } from '@/lib/git/types';
import { stubBothAppCredentials } from '../helpers/appCredentials';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt } from '../helpers/random';

// CI IS DEBITED WHILE IT RUNS (Story MOTIR-6906 · MOTIR-6910) against real
// Postgres — `docs/decisions/fleet-per-org-pool.md` §3.
//
// Real: the intents, the accrual rows and their unique key, the rollup, the
// charge's watermark and its motir-ai debit ref. Stubbed: the HTTP boundaries
// (motir-ai's ledger and GitHub's jobs read), through global `fetch`.

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '66601';
const PROVIDER_REPO_ID = '88001';
const RUN_ID = '9001';
const JULY_2026 = new Date('2026-07-01T00:00:00.000Z');
const STARTED = new Date('2026-07-15T12:00:00.000Z');
/** The included pool for a one-member org (`ci-minutes-allowance.md` §1). */
const POOL_MINUTES = 1_000;

function at(minutes: number, seconds = 0): Date {
  return new Date(STARTED.getTime() + minutes * 60_000 + seconds * 1000);
}

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(options: { isMeta?: boolean } = {}): Promise<Fixture> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `ci-live-${suffix}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${suffix}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `A${randomInt(100, 1000)}`,
  });
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: MOTIR_ORG,
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: PROVIDER_REPO_ID,
        owner: MOTIR_ORG,
        name: 'acme-web',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const githubRepo = await adminDb.githubRepo.findFirstOrThrow({
    where: { repoId: PROVIDER_REPO_ID },
  });
  await adminDb.projectRepo.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      role: 'web',
      name: 'acme-web',
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      position: 'a0',
      githubRepoId: githubRepo.id,
    },
  });
  if (options.isMeta) {
    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { isMeta: true },
    });
  }
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

let jobSeq = 0;

async function seedRunningIntent(
  fx: Fixture,
  overrides: { status?: string; startedAt?: Date | null } = {},
): Promise<CiRunnerProvisioningIntent> {
  jobSeq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      installationId: INSTALLATION_ID,
      runId: RUN_ID,
      runAttempt: 1,
      jobId: String(70_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: STARTED,
      status: overrides.status ?? 'running',
      startedAt: overrides.startedAt === undefined ? STARTED : overrides.startedAt,
    },
  });
}

interface Boundary {
  debits: Record<string, unknown>[];
}

/**
 * motir-ai's CI-overage debit (idempotent on `externalRef`, as the real ledger
 * is) plus GitHub's token mint and jobs read, for the completion meter.
 */
function stubBoundaries(
  options: { debitDown?: boolean; jobMinutes?: number; balances?: Record<string, number> } = {},
): Boundary & { fetchMock: ReturnType<typeof vi.fn> } {
  stubBothAppCredentials();
  const debits: Record<string, unknown>[] = [];
  const seenRefs = new Set<string>();
  const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.includes('/v1/credits/ci-overage')) {
      if (options.debitDown) throw new Error('ECONNREFUSED');
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      debits.push(body);
      const ref = String(body['externalRef']);
      const replay = seenRefs.has(ref);
      seenRefs.add(ref);
      return json({
        transactionId: `tx_${seenRefs.size}`,
        aiOrganizationId: 'ai_org',
        credits: -Number(body['credits']),
        balanceAfter: 1_000 - Number(body['credits']),
        exhausted: false,
        idempotent: replay,
      });
    }
    if (u.includes('/v1/usage')) {
      // The balance read (`getEntitlementState`), per core organisation.
      const org = new URL(u).searchParams.get('coreOrganizationId') ?? '';
      return json({ balance: options.balances?.[org] ?? 1_000 });
    }
    if (u.includes('/access_tokens')) {
      return json({ token: 'ghs_x', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (u.includes('/actions/runs/')) {
      const minutes = options.jobMinutes ?? 16;
      return json({
        total_count: 1,
        jobs: [
          {
            id: 1,
            name: 'build',
            started_at: STARTED.toISOString(),
            completed_at: at(minutes).toISOString(),
            labels: [MOTIR_RUNNER_LABEL],
            run_attempt: 1,
          },
        ],
      });
    }
    throw new Error(`unexpected fetch to ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { debits, fetchMock };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function rollup(fx: Fixture) {
  return adminDb.ciPeriodUsage.findUnique({
    where: { workspaceId_periodStart: { workspaceId: fx.workspaceId, periodStart: JULY_2026 } },
  });
}

async function accrualRows(intentId: string) {
  return adminDb.ciLiveAccrual.findMany({
    where: { provisioningIntentId: intentId },
    orderBy: { tickStart: 'asc' },
  });
}

function runEvent(overrides: Partial<NormalizedWorkflowRunEvent> = {}): NormalizedWorkflowRunEvent {
  return {
    providerRepoId: PROVIDER_REPO_ID,
    runId: RUN_ID,
    attempt: 1,
    repoOwner: MOTIR_ORG,
    repoName: 'acme-web',
    workflowName: 'CI',
    completedAt: at(16),
    ...overrides,
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the live charge — a run is charged while it runs (§3)', () => {
  it('charges a container across three periods, and the completion webhook adds only the remainder', async () => {
    const fx = await seedTenant();
    const intent = await seedRunningIntent(fx);
    const { debits } = stubBoundaries({ jobMinutes: 16 });

    const first = await ciLiveChargeService.tick(at(5));
    const second = await ciLiveChargeService.tick(at(10, 30));
    const third = await ciLiveChargeService.tick(at(15));

    // Three periods, three rows, whole minutes only (10½ → 10).
    const rows = await accrualRows(intent.id);
    expect(rows.map((r) => r.accruedSeconds)).toEqual([300, 300, 300]);
    expect(rows.map((r) => r.tickStart.toISOString())).toEqual([
      tickStartFor(at(5)).toISOString(),
      tickStartFor(at(10, 30)).toISOString(),
      tickStartFor(at(15)).toISOString(),
    ]);
    for (const result of [first, second, third]) {
      expect(result).toMatchObject({
        outcome: 'ticked',
        containers: 1,
        accrued: 1,
        organizations: [
          { organizationId: fx.organizationId, accruedMinutes: 5, charge: 'within_allowance' },
        ],
      });
    }
    // Inside the included minutes: the rollup rises, no credit is debited, and the
    // run is not counted as a run until it completes.
    expect(Number((await rollup(fx))!.linearEquivalentMinutes)).toBe(15);
    expect((await rollup(fx))!.runCount).toBe(0);
    expect(debits).toEqual([]);

    // The run completes. GitHub bills 16 minutes; 15 were charged live, so the
    // rollup takes 1 more, never 16.
    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: intent.id },
      data: { status: 'completed', settledAt: at(16) },
    });
    const metered = await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID);
    expect(metered).toMatchObject({
      outcome: 'metered',
      linearEquivalentMinutes: 16,
      liveChargedMinutes: 15,
    });
    const after = (await rollup(fx))!;
    expect(Number(after.linearEquivalentMinutes)).toBe(16);
    expect(after.billableMinutes).toBe(16);
    expect(after.runCount).toBe(1);
    // The audit row keeps GitHub's whole figure.
    const audit = await adminDb.ciWorkflowRunUsage.findFirstOrThrow({ where: { runId: RUN_ID } });
    expect(audit.billableMinutes).toBe(16);

    // A settled container accrues nothing more.
    const late = await ciLiveChargeService.tick(at(20));
    expect(late).toMatchObject({ containers: 0, organizations: [] });
  });

  it('a replayed tick writes no second row and adds nothing', async () => {
    const fx = await seedTenant();
    const intent = await seedRunningIntent(fx);
    stubBoundaries();

    await ciLiveChargeService.tick(at(5));
    const replay = await ciLiveChargeService.tick(at(5));
    // The same period, later in it — the checkpoint answers, not the clock.
    const lateInPeriod = await ciLiveChargeService.tick(at(5, 50));

    expect(replay).toMatchObject({ accrued: 0, organizations: [] });
    expect(lateInPeriod).toMatchObject({ accrued: 0, organizations: [] });
    expect(await accrualRows(intent.id)).toHaveLength(1);
    expect(Number((await rollup(fx))!.linearEquivalentMinutes)).toBe(5);
  });

  it('the (intent, period) key refuses a second row even if the checkpoint moved', async () => {
    const fx = await seedTenant();
    const intent = await seedRunningIntent(fx);
    stubBoundaries();

    // Six minutes in, still inside the period that started at :05.
    await ciLiveChargeService.accrueContainer(intent, {
      now: at(5),
      tickStart: tickStartFor(at(5)),
      periodStart: JULY_2026,
    });
    const again = await ciLiveChargeService.accrueContainer(intent, {
      now: at(6),
      tickStart: tickStartFor(at(5)),
      periodStart: JULY_2026,
    });

    expect(again).toBe(0);
    expect(await accrualRows(intent.id)).toHaveLength(1);
    expect(Number((await rollup(fx))!.linearEquivalentMinutes)).toBe(5);
  });

  it('two overlapping ticks never count a minute twice', async () => {
    const fx = await seedTenant();
    const intent = await seedRunningIntent(fx);
    stubBoundaries();

    // A slow tick and the next one, racing on the same container. The row lock
    // makes the second read the first one's checkpoint.
    await Promise.all([
      ciLiveChargeService.accrueContainer(intent, {
        now: at(9),
        tickStart: tickStartFor(at(9)),
        periodStart: JULY_2026,
      }),
      ciLiveChargeService.accrueContainer(intent, {
        now: at(10),
        tickStart: tickStartFor(at(10)),
        periodStart: JULY_2026,
      }),
    ]);

    const total = (await accrualRows(intent.id)).reduce((sum, r) => sum + r.accruedSeconds, 0);
    expect(total).toBe(600);
    expect(Number((await rollup(fx))!.linearEquivalentMinutes)).toBe(10);
  });

  it('charges credits once the included minutes run out mid-period', async () => {
    const fx = await seedTenant();
    await seedRunningIntent(fx);
    const { debits } = stubBoundaries();
    // The org has 3 included minutes left.
    await withSystemContext((tx) =>
      ciPeriodUsageRepository.incrementForPeriod(
        {
          workspaceId: fx.workspaceId,
          organizationId: fx.organizationId,
          periodStart: JULY_2026,
          billableMinutes: POOL_MINUTES - 3,
          rawWallClockSeconds: (POOL_MINUTES - 3) * 60,
          linearEquivalentMinutes: POOL_MINUTES - 3,
        },
        tx,
      ),
    );

    const result = await ciLiveChargeService.tick(at(5));

    expect(result).toMatchObject({
      organizations: [{ organizationId: fx.organizationId, accruedMinutes: 5, charge: 'charged' }],
    });
    // 3 minutes came from the allowance; the other 2 are credits.
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({ coreOrganizationId: fx.organizationId, credits: 2 });

    // The next period is all credits, under a new watermark ref.
    await ciLiveChargeService.tick(at(10));
    expect(debits).toHaveLength(2);
    expect(debits[1]).toMatchObject({ credits: 5 });
    expect(debits[1]!['externalRef']).not.toBe(debits[0]!['externalRef']);
  });

  it('keeps the accrual when motir-ai is down, and charges it on the next tick that can', async () => {
    const fx = await seedTenant();
    await seedRunningIntent(fx);
    await withSystemContext((tx) =>
      ciPeriodUsageRepository.incrementForPeriod(
        {
          workspaceId: fx.workspaceId,
          organizationId: fx.organizationId,
          periodStart: JULY_2026,
          billableMinutes: POOL_MINUTES,
          rawWallClockSeconds: POOL_MINUTES * 60,
          linearEquivalentMinutes: POOL_MINUTES,
        },
        tx,
      ),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    stubBoundaries({ debitDown: true });
    const down = await ciLiveChargeService.tick(at(5));
    expect(down).toMatchObject({ organizations: [{ charge: 'debit_pending' }] });
    expect(Number((await rollup(fx))!.linearEquivalentMinutes)).toBe(POOL_MINUTES + 5);

    const { debits } = stubBoundaries();
    await ciLiveChargeService.tick(at(10));
    // The pending 5 are retried under their own ref, then the new 5 are charged.
    expect(debits.map((d) => d['credits'])).toEqual([5, 5]);
  });

  it('measures the meta org and never charges it', async () => {
    const fx = await seedTenant({ isMeta: true });
    await seedRunningIntent(fx);
    const { debits } = stubBoundaries();

    const result = await ciLiveChargeService.tick(at(5));

    expect(result).toMatchObject({ organizations: [{ charge: 'bypassed' }] });
    expect(Number((await rollup(fx))!.linearEquivalentMinutes)).toBe(5);
    expect(debits).toEqual([]);
  });

  it('accrues nothing for a container still booting, or one already settled', async () => {
    const fx = await seedTenant();
    const booting = await seedRunningIntent(fx, { status: 'provisioning', startedAt: null });
    const settled = await seedRunningIntent(fx, { status: 'completed' });
    stubBoundaries();

    const result = await ciLiveChargeService.tick(at(10));

    expect(result).toMatchObject({ containers: 0, accrued: 0 });
    expect(await accrualRows(booting.id)).toEqual([]);
    expect(await accrualRows(settled.id)).toEqual([]);
    // And a container that settles between the listing and its lock is skipped.
    const live = await seedRunningIntent(fx);
    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: live.id },
      data: { status: 'failed' },
    });
    expect(
      await ciLiveChargeService.accrueContainer(live, {
        now: at(10),
        tickStart: tickStartFor(at(10)),
        periodStart: JULY_2026,
      }),
    ).toBe(0);
    // …and so is one whose record is gone altogether by the time of the lock.
    const gone = await seedRunningIntent(fx);
    await adminDb.ciRunnerProvisioningIntent.delete({ where: { id: gone.id } });
    expect(
      await ciLiveChargeService.accrueContainer(gone, {
        now: at(10),
        tickStart: tickStartFor(at(10)),
        periodStart: JULY_2026,
      }),
    ).toBe(0);
  });

  it('logs and carries on past one container that fails, and one org whose charge throws', async () => {
    const fx = await seedTenant();
    await seedRunningIntent(fx);
    stubBoundaries();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const accrue = vi
      .spyOn(ciLiveChargeService, 'accrueContainer')
      .mockRejectedValueOnce(new Error('deadlock detected'));

    const failed = await ciLiveChargeService.tick(at(5));
    expect(failed).toMatchObject({ failures: 1, accrued: 0 });
    accrue.mockRestore();

    const charge = await import('@/lib/services/ciAllowanceService');
    vi.spyOn(charge.ciAllowanceService, 'chargeForMeteredRun').mockRejectedValueOnce(
      // Not an Error: the log still carries a detail rather than throwing.
      'boom',
    );
    const result = await ciLiveChargeService.tick(at(10));
    expect(result).toMatchObject({ organizations: [{ charge: 'charge_failed' }] });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('could not charge an organization'),
      expect.objectContaining({ detail: 'unknown' }),
    );
  });

  it('is inert off-cloud', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    expect(await ciLiveChargeService.tick(at(5))).toEqual({ outcome: 'disabled' });
  });
});

describe('at zero, the org STOPS — in the same tick (MOTIR-6911, §3–§4)', () => {
  async function exhaustPool(fx: Fixture): Promise<void> {
    await withSystemContext((tx) =>
      ciPeriodUsageRepository.incrementForPeriod(
        {
          workspaceId: fx.workspaceId,
          organizationId: fx.organizationId,
          periodStart: JULY_2026,
          billableMinutes: POOL_MINUTES,
          rawWallClockSeconds: POOL_MINUTES * 60,
          linearEquivalentMinutes: POOL_MINUTES,
        },
        tx,
      ),
    );
  }

  it('stops the org the tick drives to zero, and leaves another org running', async () => {
    const broke = await seedTenant();
    const paying = await seedTenant();
    await seedRunningIntent(broke);
    await seedRunningIntent(paying);
    await exhaustPool(broke);
    await exhaustPool(paying);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = vi
      .spyOn(fleetStopService, 'stopOrganization')
      .mockResolvedValue({ runsCancelled: 1, containersStopped: 1, failures: 0 });
    stubBoundaries({ balances: { [broke.organizationId]: 0, [paying.organizationId]: 500 } });

    const result = await ciLiveChargeService.tick(at(5));

    expect(result).toMatchObject({ outcome: 'ticked', stopped: [broke.organizationId] });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(broke.organizationId, 'credits_exhausted');
  });

  it('stops nothing while the org is inside its included minutes, whatever the balance', async () => {
    const fx = await seedTenant();
    await seedRunningIntent(fx);
    const stop = vi.spyOn(fleetStopService, 'stopOrganization');
    stubBoundaries({ balances: { [fx.organizationId]: 0 } });

    expect(await ciLiveChargeService.tick(at(5))).toMatchObject({ stopped: [] });
    expect(stop).not.toHaveBeenCalled();
  });

  it('an UNREADABLE balance stops nothing already running (§3)', async () => {
    const fx = await seedTenant();
    await seedRunningIntent(fx);
    await exhaustPool(fx);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stop = vi.spyOn(fleetStopService, 'stopOrganization');
    stubBoundaries();
    vi.spyOn(ciAllowanceService, 'getEntitlementState').mockRejectedValue(new Error('boom'));

    expect(await ciLiveChargeService.tick(at(5))).toMatchObject({ stopped: [] });
    expect(stop).not.toHaveBeenCalled();
  });

  it('a stop that throws is logged and retried next tick, never thrown out', async () => {
    const fx = await seedTenant();
    await seedRunningIntent(fx);
    await exhaustPool(fx);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fleetStopService, 'stopOrganization').mockRejectedValue('github down');
    stubBoundaries({ balances: { [fx.organizationId]: 0 } });

    expect(await ciLiveChargeService.tick(at(5))).toMatchObject({ stopped: [] });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('could not stop an organization at zero'),
      expect.objectContaining({ organizationId: fx.organizationId, detail: 'unknown' }),
    );
  });
});

describe('the completion meter reconciles against what was charged live', () => {
  it('adds nothing when the live figure already exceeds GitHub’s, and notes it', async () => {
    const fx = await seedTenant();
    await seedRunningIntent(fx);
    stubBoundaries({ jobMinutes: 4 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await ciLiveChargeService.tick(at(5));
    const metered = await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID);

    expect(metered).toMatchObject({ linearEquivalentMinutes: 4, liveChargedMinutes: 5 });
    const after = (await rollup(fx))!;
    expect(Number(after.linearEquivalentMinutes)).toBe(5);
    expect(after.billableMinutes).toBe(5);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('live-charged minutes exceed'),
      expect.objectContaining({ runId: RUN_ID }),
    );
  });

  it('meters a run with no live rows exactly as before', async () => {
    const fx = await seedTenant();
    stubBoundaries({ jobMinutes: 16 });

    const metered = await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID);

    expect(metered).toMatchObject({ linearEquivalentMinutes: 16, liveChargedMinutes: 0 });
    expect(Number((await rollup(fx))!.linearEquivalentMinutes)).toBe(16);
  });
});

describe('the job', () => {
  it('is registered as a cron on the debit period, so schedule health watches it', () => {
    const schedule = jobSchedules().find((s) => s.functionId === 'system.ci-live-charge');
    expect(schedule).toBeDefined();
    expect(schedule!.cron).toBe('*/5 * * * *');
    expect(CI_LIVE_CHARGE_CRON).toBe('*/5 * * * *');
  });

  it('delegates one tick to the service, through its memoized step', async () => {
    const tick = vi.spyOn(ciLiveChargeService, 'tick').mockResolvedValue({ outcome: 'disabled' });

    const { result } = await new JobTestEngine({ function: ciLiveCharge }).execute();

    expect(tick).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ outcome: 'disabled' });
  });
});
