import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobQueueRun } from '@/generated/prisma/client';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  AGENT_MAX_POLL_INTERVAL_MS,
  HOSTED_AGENT_FLEET_TIME_BUDGETS,
  HOSTED_AGENT_MAX_TIMEOUT_MS,
  INITIAL_HOSTED_AGENT_POLL_STATE,
  hostedAgentBootStepId,
  hostedAgentContainerService,
  hostedAgentPollWaitMs,
  hostedAgentSlotTtlSeconds,
  type HostedAgentContainerRequest,
  type HostedAgentSession,
} from '@/lib/services/hostedAgentContainerService';
import {
  HostedAgentContainerRequestInvalidError,
  HostedAgentContainerUnpricedError,
} from '@/lib/ciFleet/errors';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { supervisionSweepService } from '@/lib/services/supervisionSweepService';
import { SUPERVISION_KINDS, isSupervisionKind } from '@/lib/jobs/supervision/driver';
import { jobSupervisionRepository } from '@/lib/repositories/jobSupervisionRepository';
import { jobStepRepository } from '@/lib/repositories/jobStepRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { withSystemContext } from '@/lib/workspaces/context';
import { DEFAULT_FLEET_SLOT_TTL_SECONDS } from '@/lib/ciFleet/limits';
import { FLEET_CONTAINER_SIZE, fakeOrchestrator } from '@motir/orchestrator';
import { rehearseHostedAgentMeter } from '../../scripts/rehearseHostedAgentMeter';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';

// THE HOSTED-AGENT METERING SEAM (Story MOTIR-4336 · MOTIR-4713) — its own unit
// floor, against real Postgres with the fake orchestrator at the port.
//
// ⚠️ THE ROWS ARE THE ASSERTION. The meter was already proven for this workload
// with a HAND-BUILT usage record; what was missing was a writer, so every test
// here drives the seam and then reads what landed in `ci_container_usage`, its
// period rollup and `fleet_in_flight_slot`.

/** A whole supervision in milliseconds. */
const FAST = { pollIntervalMs: 1, maxPollIntervalMs: 1, bootDeadlineMs: 10_000 } as const;

let tenant: { organizationId: string; workspaceId: string; projectId: string };

function requestFor(
  overrides: Partial<HostedAgentContainerRequest> = {},
): HostedAgentContainerRequest {
  return {
    dispatchId: `dispatch-${randomToken(6)}`,
    runId: `run-${randomToken(6)}`,
    dispatchRunId: null,
    ...tenant,
    repoFullName: 'motir-projects/acme-web',
    image: 'motir/stand-in@sha256:fake',
    env: {},
    region: 'iad',
    size: FLEET_CONTAINER_SIZE,
    timeoutSeconds: 3_600,
    ...overrides,
  };
}

/** Finish whichever container is live, the way an exiting stand-in would. */
function completeWith(exitCode: number | null) {
  return async () => {
    const live = fakeOrchestrator.liveContainerIds();
    if (live[0]) fakeOrchestrator.completeJob(live[0], { exitCode });
  };
}

async function seedTenant() {
  const email = `agent-meter-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `A${randomInt(100, 1000)}`,
  });
  return {
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
    projectId: project.id,
  };
}

beforeEach(async () => {
  fakeOrchestrator.reset();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "ci_container_usage_slice", "ci_container_usage", "ci_container_period_cost" RESTART IDENTITY CASCADE',
  );
  await adminDb.fleetInFlightSlot.deleteMany({});
  await truncateAuthTables();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  tenant = await seedTenant();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // Fleet-wide and FK-less, so nothing else cleans it up for the next file.
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a settled container leaves a priced `agent` row and rollup line', () => {
  it('boot → poll → settle writes `workload = agent`, no workflow job, a real rate, and the line', async () => {
    const outcome = await hostedAgentContainerService.run(requestFor(), {
      ...FAST,
      sleep: completeWith(10),
    });

    if (outcome.outcome !== 'settled') throw new Error(`expected settled, got ${outcome.outcome}`);
    expect(outcome.exitCode).toBe(10);
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row).toMatchObject({
      handleId: outcome.containerId,
      workload: 'agent',
      workflowJobId: null,
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      repoFullName: 'motir-projects/acme-web',
      teardownReason: 'job_completed',
    });
    expect(row.rateEffectiveFrom).not.toBeNull();
    expect(fakeOrchestrator.specs[0]).toMatchObject({
      workload: 'hosted_agent',
      workflowJobId: null,
    });

    const rollup = await adminDb.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup).toMatchObject({ workload: 'agent', containerCount: 1 });
    expect(rollup.containerSeconds).toBe(row.billableSeconds);
    // The container is gone and its slot went back after the row was written.
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
  });
});

describe('checkpoints while the container runs', () => {
  it('records a partial figure, a replayed poll adds nothing, and a settle BELOW it reconciles downward', async () => {
    const booted = await hostedAgentContainerService.boot(requestFor());
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    const session = booted.session;
    const observedAt = new Date(new Date(session.handle.createdAt).getTime() + 90_000);
    const options = { ...FAST, now: () => observedAt };

    const first = await hostedAgentContainerService.poll(
      session,
      INITIAL_HOSTED_AGENT_POLL_STATE,
      options,
    );
    expect(first.done).toBe(false);
    const partial = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(partial.billableSeconds).toBe(90);
    expect(partial.containerStoppedAt).toBeNull();

    await hostedAgentContainerService.poll(session, INITIAL_HOSTED_AGENT_POLL_STATE, options);
    const afterReplay = await adminDb.ciContainerPeriodCost.findFirstOrThrow();
    expect(afterReplay).toMatchObject({ containerSeconds: 90, containerCount: 1 });

    // The container really stopped a moment after boot, far below the checkpoint
    // the injected clock produced — so the settle's delta is NEGATIVE.
    fakeOrchestrator.completeJob(session.handle.id, { exitCode: 0 });
    const settled = await hostedAgentContainerService.settle(session, {
      done: true,
      reason: 'job_completed',
      startedAt: session.handle.createdAt,
      exitCode: 0,
      failureDetail: null,
    });
    if (settled.outcome !== 'settled') throw new Error('expected settled');
    expect(settled.billableSeconds).toBeLessThan(90);
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    const rollup = await adminDb.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup.containerSeconds).toBe(row.billableSeconds);
    expect(rollup.containerCount).toBe(1);
  });
});

describe('the cadence is this workload’s own', () => {
  it('backs off to a minute, never past it, and never faster than the index loop’s ceiling', () => {
    const waits = Array.from({ length: 12 }, (_, i) => hostedAgentPollWaitMs(i + 1));
    expect(waits[0]).toBe(HOSTED_AGENT_FLEET_TIME_BUDGETS.pollIntervalMs);
    expect(Math.max(...waits)).toBe(AGENT_MAX_POLL_INTERVAL_MS);
    expect(waits.at(-1)).toBe(AGENT_MAX_POLL_INTERVAL_MS);
    expect(AGENT_MAX_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(
      HOSTED_AGENT_FLEET_TIME_BUDGETS.indexLoopMaxPollIntervalMs,
    );
    // A test seam may shorten the ceiling but not lengthen it.
    expect(hostedAgentPollWaitMs(20, { maxPollIntervalMs: 10 * 60_000 })).toBe(
      AGENT_MAX_POLL_INTERVAL_MS,
    );
  });

  it('the poll ceiling clears the longest legal run at the backed-off cadence', () => {
    expect(HOSTED_AGENT_FLEET_TIME_BUDGETS.maxPollIterations).toBeGreaterThan(
      HOSTED_AGENT_MAX_TIMEOUT_MS / AGENT_MAX_POLL_INTERVAL_MS,
    );
  });
});

describe('the fleet slot is held for exactly as long as a container exists', () => {
  it('sizes its TTL from the run timeout, never the fleet-wide default', async () => {
    const reserve = vi.spyOn(fleetCeilingService, 'reserve');
    const request = requestFor({ timeoutSeconds: 8 * 60 * 60 });
    const booted = await hostedAgentContainerService.boot(request);
    expect(booted.phase).toBe('supervising');

    expect(reserve.mock.calls[0]![0]).toMatchObject({
      workload: 'hosted_agent',
      ref: request.dispatchId,
      ownerRef: request.runId,
      ttlSeconds: hostedAgentSlotTtlSeconds(8 * 60 * 60),
    });
    expect(hostedAgentSlotTtlSeconds(8 * 60 * 60)).toBeGreaterThan(DEFAULT_FLEET_SLOT_TTL_SECONDS);
    const slot = await adminDb.fleetInFlightSlot.findFirstOrThrow();
    expect(slot).toMatchObject({ workload: 'hosted_agent', ref: request.dispatchId });
  });

  it('gives the slot back when the provision is refused', async () => {
    fakeOrchestrator.failNextProvision('no capacity');
    const booted = await hostedAgentContainerService.boot(requestFor());
    expect(booted).toMatchObject({ phase: 'terminal', outcome: { outcome: 'provision_failed' } });
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
  });

  it('keeps the slot when teardown fails — the container may still be spending', async () => {
    const booted = await hostedAgentContainerService.boot(requestFor());
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    fakeOrchestrator.failNextTeardown();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await hostedAgentContainerService.settle(booted.session, {
      done: true,
      reason: 'job_completed',
      startedAt: booted.session.handle.createdAt,
      exitCode: 0,
      failureDetail: null,
    });

    expect(outcome.outcome).toBe('teardown_failed');
    expect(error).toHaveBeenCalled();
    expect(await adminDb.fleetInFlightSlot.count()).toBe(1);
  });

  it('defers without booting when the fleet is at its ceiling', async () => {
    vi.spyOn(fleetCeilingService, 'reserve').mockResolvedValue({
      outcome: 'deferred',
      reason: 'fleet_ceiling',
      detail: 'full',
    });
    const booted = await hostedAgentContainerService.boot(requestFor());
    expect(booted).toMatchObject({
      phase: 'terminal',
      outcome: { outcome: 'admission_deferred', reason: 'fleet_ceiling' },
    });
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });
});

describe('an unpriced machine class is refused BEFORE anything is spent', () => {
  it('throws the typed error with no slot taken and nothing provisioned', async () => {
    const unpriced = { cpuKind: 'performance' as const, cpus: 4, memoryMb: 16_384 };
    await expect(
      hostedAgentContainerService.boot(requestFor({ size: unpriced })),
    ).rejects.toBeInstanceOf(HostedAgentContainerUnpricedError);
    await expect(
      hostedAgentContainerService.boot(requestFor({ region: 'syd' })),
    ).rejects.toBeInstanceOf(HostedAgentContainerUnpricedError);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
  });

  it('refuses a timeout outside the seam’s bounds', async () => {
    for (const timeoutSeconds of [0, -1, HOSTED_AGENT_MAX_TIMEOUT_MS / 1000 + 1]) {
      await expect(
        hostedAgentContainerService.boot(requestFor({ timeoutSeconds })),
      ).rejects.toBeInstanceOf(HostedAgentContainerRequestInvalidError);
    }
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });
});

describe('a run over a card set attributes across repository slices', () => {
  const T0 = new Date('2026-09-10T12:00:00.000Z');

  async function runLasting(seconds: number, request: HostedAgentContainerRequest) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const booted = await hostedAgentContainerService.boot(request);
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    vi.setSystemTime(new Date(T0.getTime() + seconds * 1000));
    fakeOrchestrator.completeJob(booted.session.handle.id, { exitCode: 0 });
    const outcome = await hostedAgentContainerService.settle(booted.session, {
      done: true,
      reason: 'job_completed',
      startedAt: T0.toISOString(),
      exitCode: 0,
      failureDetail: null,
    });
    if (outcome.outcome !== 'settled') throw new Error('expected settled');
    return outcome;
  }

  it('two slices plus idle sum to the handle’s billable seconds, and the row names no single repo', async () => {
    const outcome = await runLasting(
      600,
      requestFor({
        slices: [
          {
            sliceRef: 'card-1',
            projectId: tenant.projectId,
            repoFullName: 'acme/web',
            seconds: 200,
          },
          {
            sliceRef: 'card-2',
            projectId: tenant.projectId,
            repoFullName: 'acme/api',
            seconds: 300,
          },
        ],
      }),
    );

    expect(outcome.billableSeconds).toBe(600);
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.repoFullName).toBeNull();
    const slices = await adminDb.ciContainerUsageSlice.findMany({ orderBy: { sliceRef: 'asc' } });
    expect(slices.reduce((sum, s) => sum + s.seconds, 0)).toBe(row.billableSeconds);
    expect(slices.find((s) => s.kind === 'idle')?.seconds).toBe(100);
    // Slices divide the total; the line is unchanged by the split.
    const rollup = await adminDb.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup.containerSeconds).toBe(600);
  });

  it('a one-repo run writes the one-repo row and no slices', async () => {
    await runLasting(120, requestFor());
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.repoFullName).toBe('motir-projects/acme-web');
    expect(await adminDb.ciContainerUsageSlice.count()).toBe(0);
    // Money stays decimal: 120 s at the fake's iad rate, exactly.
    expect(
      new Prisma.Decimal(row.costUsd).equals(new Prisma.Decimal('0.000031636049').mul(120)),
    ).toBe(true);
  });
});

describe('the abandoned-supervision sweep routes a `hosted-agent` row to THIS service', () => {
  it('registers the kind, and settles an abandoned one here with `job_timed_out`', async () => {
    expect(SUPERVISION_KINDS).toContain('hosted-agent');
    expect(isSupervisionKind('hosted-agent')).toBe(true);
    await truncateJobRuns();

    const booted = await hostedAgentContainerService.boot(requestFor());
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    const session: HostedAgentSession = booted.session;
    const run: JobQueueRun = await adminDb.jobQueueRun.create({
      data: {
        jobId: 'system.hosted-agent',
        eventName: 'hosted-agent/run.requested',
        workspaceId: tenant.workspaceId,
        runAt: new Date(Date.now() - 60 * 60_000),
        maxAttempts: 3,
        state: 'failed',
      },
    });
    await withSystemContext(async (tx) => {
      await jobSupervisionRepository.open(
        {
          runId: run.id,
          subject: session.dispatchId,
          kind: 'hosted-agent',
          nextPollAt: new Date(Date.now() - 40 * 60_000),
          workspaceId: tenant.workspaceId,
        },
        tx,
      );
      await jobStepRepository.create(
        {
          runId: run.id,
          stepId: hostedAgentBootStepId(session.dispatchId),
          kind: 'run',
          result: { phase: 'supervising', session } as unknown as Prisma.InputJsonValue,
          workspaceId: tenant.workspaceId,
        },
        tx,
      );
    });
    const settle = vi.spyOn(hostedAgentContainerService, 'settle');

    expect(await supervisionSweepService.sweepAbandoned()).toEqual({
      scanned: 1,
      settled: 1,
      skipped: 0,
    });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]![1]).toMatchObject({ done: true, reason: 'job_timed_out' });
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row).toMatchObject({ workload: 'agent', teardownReason: 'job_timed_out' });
    await truncateJobRuns();
  });
});

describe('the rehearsal command', () => {
  const args = () => ({ ...tenant, repoFullName: 'motir-projects/acme-web' });

  it('off-cloud it prints that the meter is disabled and provisions nothing', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    const rehearsal = await rehearseHostedAgentMeter(args());
    expect(rehearsal.outcome).toBeNull();
    expect(rehearsal.text).toContain('disabled');
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });

  it('boots the stand-in with an EMPTY env and prints its usage row and the `agent` line', async () => {
    const rehearsal = await rehearseHostedAgentMeter({
      ...args(),
      options: { ...FAST, sleep: completeWith(10) },
    });

    expect(fakeOrchestrator.specs).toHaveLength(1);
    expect(fakeOrchestrator.specs[0]!.env).toEqual({});
    if (rehearsal.outcome?.outcome !== 'settled') throw new Error('expected settled');
    expect(rehearsal.agentLine).toMatchObject({ workload: 'agent', containerCount: 1 });
    // Money reaches the output as the repository's decimal string, verbatim.
    expect(rehearsal.text).toContain(`cost usd         ${rehearsal.outcome.usage.costUsd}`);
    expect(rehearsal.text).toContain(`$${rehearsal.agentLine!.costUsd}`);
    expect(rehearsal.text).toContain('workload         hosted_agent');
  });
});
