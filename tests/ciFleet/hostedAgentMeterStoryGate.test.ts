import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  AGENT_MAX_POLL_INTERVAL_MS,
  HOSTED_AGENT_FLEET_TIME_BUDGETS,
  hostedAgentBootStepId,
  hostedAgentContainerService,
  type HostedAgentContainerRequest,
} from '@/lib/services/hostedAgentContainerService';
import { HostedAgentContainerUnpricedError } from '@/lib/ciFleet/errors';
import { ciFleetCostMeterService } from '@/lib/services/ciFleetCostMeterService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import {
  SUPERVISION_SETTLERS,
  supervisionSweepService,
} from '@/lib/services/supervisionSweepService';
import { SUPERVISION_KINDS, type SupervisionKind } from '@/lib/jobs/supervision/driver';
import { jobSupervisionRepository } from '@/lib/repositories/jobSupervisionRepository';
import { jobStepRepository } from '@/lib/repositories/jobStepRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { withSystemContext } from '@/lib/workspaces/context';
import {
  FLEET_CONTAINER_SIZE,
  OrchestratorImageUnpullableError,
  fakeOrchestrator,
  resolveContainerRate,
} from '@motir/orchestrator';
import { rehearseHostedAgentMeter } from '../../scripts/rehearseHostedAgentMeter';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';

// THE STORY'S VITEST GATE (Story MOTIR-4336 · MOTIR-4716) — the seams between the
// hosted-agent metering seam and the shipped meter, driver and sweep, and the
// guarantees a coverage percentage cannot see.
//
// ⚠️ THE LANE, READ BEFORE A LINE WAS WRITTEN (AC 8). This file mounts in the
// default `vitest.config.ts` project beside `tests/ciFleet/codeGraphIndexDispatch.
// test.ts`: `setupFiles` gives each worker its OWN database
// (`tests/helpers/perWorkerDb.ts`), tests within a file run sequentially on it,
// and the fake orchestrator is selected through the shipped
// `MOTIR_FLEET_ORCHESTRATOR=fake` config seam — not a module mock. The meter is a
// CLOUD meter, so `MOTIR_CLOUD=true` is what makes it write at all.
//
// ⚠️ WHAT THIS CANNOT ASSERT. The credit ledger is `motir-ai`'s; "no balance moved"
// asserted from here would assert this repository's own harness. The in-repo half
// — nothing on the agent metering path imports billing, entitlement or credit — is
// the guard below; the cross-boundary half is the platform verification task's
// (MOTIR-4715).
//
// ⚠️ Internal COGS. Nothing here is a charge.

const FAST = { pollIntervalMs: 1, maxPollIntervalMs: 1, bootDeadlineMs: 10_000 } as const;

let tenant: { organizationId: string; workspaceId: string; projectId: string };

function requestFor(
  overrides: Partial<HostedAgentContainerRequest> = {},
): HostedAgentContainerRequest {
  return {
    dispatchId: `gate-${randomToken(6)}`,
    runId: `gate-run-${randomToken(6)}`,
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

beforeEach(async () => {
  fakeOrchestrator.reset();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "ci_container_usage_slice", "ci_container_usage", "ci_container_period_cost" RESTART IDENTITY CASCADE',
  );
  await adminDb.fleetInFlightSlot.deleteMany({});
  await truncateAuthTables();
  await truncateJobRuns();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');

  const email = `agent-gate-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `G${randomInt(100, 1000)}`,
  });
  tenant = {
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
    projectId: project.id,
  };
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('seam → meter → rollup, over real Postgres (AC 2)', () => {
  it('the settle’s real record reaches the real meter and the `agent` line reads back through the shipped read', async () => {
    const booted = await hostedAgentContainerService.boot(requestFor());
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    fakeOrchestrator.completeJob(booted.session.handle.id, { exitCode: 10 });
    const settled = await hostedAgentContainerService.settle(booted.session, {
      done: true,
      reason: 'job_completed',
      startedAt: booted.session.handle.createdAt,
      exitCode: 10,
      failureDetail: null,
    });
    if (settled.outcome !== 'settled') throw new Error('expected settled');

    // The FIELD that becomes the rollup key: the settle's `workload`, mapped once
    // through the registry's cost axis.
    expect(settled.usage.workload).toBe('hosted_agent');
    const lines = await ciFleetCostMeterService.getOrgPeriodCostByWorkload(
      tenant.organizationId,
      settled.usage.stoppedAt,
    );
    expect(lines).toEqual([
      {
        workload: 'agent',
        containerSeconds: settled.billableSeconds,
        costUsd: expect.any(String),
        containerCount: 1,
      },
    ]);
    expect(new Prisma.Decimal(lines[0]!.costUsd).equals(new Prisma.Decimal(settled.costUsd))).toBe(
      true,
    );
  });

  it('seam → driver → sweep: a DEAD `hosted-agent` supervision is settled through the seam with `job_timed_out`', async () => {
    const booted = await hostedAgentContainerService.boot(requestFor());
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    const { session } = booted;
    const run = await adminDb.jobQueueRun.create({
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
    const runnerSettle = vi.spyOn(
      (await import('@/lib/services/ciRunnerBootService')).ciRunnerBootService,
      'settleSupervision',
    );

    // THE REAL SWEEP, the real seam settle, the real meter — nothing stubbed.
    expect(await supervisionSweepService.sweepAbandoned()).toEqual({
      scanned: 1,
      settled: 1,
      skipped: 0,
    });

    // The case the shipped `if index … else ci-runner` would have mis-routed.
    expect(runnerSettle).not.toHaveBeenCalled();
    expect(fakeOrchestrator.teardowns).toEqual([
      { handleId: session.handle.id, reason: 'job_timed_out' },
    ]);
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row).toMatchObject({ workload: 'agent', teardownReason: 'job_timed_out' });
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
    const supervision = await withSystemContext((tx) =>
      jobSupervisionRepository.findByRunAndSubject(run.id, session.dispatchId, tx),
    );
    expect(supervision!.state).toBe('settled');
  });
});

describe('the registries are TOTAL (AC 3)', () => {
  it('every SupervisionKind has a sweep entry — asserted on the key SET, at type and at run time', () => {
    type Missing = Exclude<SupervisionKind, keyof typeof SUPERVISION_SETTLERS>;
    expectTypeOf<Missing>().toBeNever();
    expect(Object.keys(SUPERVISION_SETTLERS).sort()).toEqual([...SUPERVISION_KINDS].sort());
    // Each entry names its own boot memo; two kinds sharing one would read each
    // other's sessions back.
    const stepIds = SUPERVISION_KINDS.map((kind) => SUPERVISION_SETTLERS[kind].bootStepId('s'));
    expect(new Set(stepIds).size).toBe(stepIds.length);
  });

  // The COST axis's totality over `FleetWorkloadKind` — `hosted_agent` included —
  // is asserted by the index story's gate (MOTIR-4544,
  // `tests/ciFleet/fleetCostStoryGate.test.ts`, "the cost axis is TOTAL over the
  // fleet union"), which merged first. It is REUSED, not duplicated here.
});

describe('the unpriced refusal happens BEFORE any spend (AC 4)', () => {
  it('refuses with zero provisions recorded and no slot reserved', async () => {
    const reserve = vi.spyOn(fleetCeilingService, 'reserve');
    await expect(
      hostedAgentContainerService.boot(
        requestFor({ size: { cpuKind: 'shared', cpus: 1, memoryMb: 1024 } }),
      ),
    ).rejects.toBeInstanceOf(HostedAgentContainerUnpricedError);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(fakeOrchestrator.specs).toEqual([]);
    expect(reserve).not.toHaveBeenCalled();
  });
});

describe('the cadence bounds UNOBSERVED spend (AC 5)', () => {
  /** The seam's comment: 60 s at the `iad` row is $0.00189816294 — under $0.002 —
   *  per container per interval. */
  const STATED_CEILING_USD = '0.002';

  it('computes the per-interval exposure from the rate row, and it sits under the stated ceiling', () => {
    const rate = resolveContainerRate('fly', FLEET_CONTAINER_SIZE, 'iad', new Date());
    expect(rate).not.toBeNull();
    const exposure = new Prisma.Decimal(rate!.usdPerSecond).mul(AGENT_MAX_POLL_INTERVAL_MS / 1000);
    expect(exposure.toFixed()).toBe('0.00189816294');
    expect(exposure.lessThan(STATED_CEILING_USD)).toBe(true);
  });
});

describe('the agent metering path imports nothing from billing (AC 6)', () => {
  const FILES = [
    'lib/services/hostedAgentContainerService.ts',
    'lib/services/supervisionSweepService.ts',
    'scripts/rehearseHostedAgentMeter.ts',
  ];
  /** The modules a COGS path must never reach: the billing layer, the entitlement
   *  caps, and anything credit-shaped (the ledger lives across the boundary). */
  const FORBIDDEN = /(?:lib\/billing\/|entitlements?|credit)/i;

  it.each(FILES)('%s imports no billing / entitlement / credit module', (file) => {
    const specifiers = [...readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      (m) => m[1]!,
    );
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => FORBIDDEN.test(s))).toEqual([]);
  });
});

describe('money never becomes a float (AC 7)', () => {
  it('a 17-second container costs exactly the decimal product a float would not produce', async () => {
    const T0 = new Date('2026-09-10T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const booted = await hostedAgentContainerService.boot(requestFor());
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    vi.setSystemTime(new Date(T0.getTime() + 17_000));
    fakeOrchestrator.completeJob(booted.session.handle.id, { exitCode: 0 });
    const settled = await hostedAgentContainerService.settle(booted.session, {
      done: true,
      reason: 'job_completed',
      startedAt: T0.toISOString(),
      exitCode: 0,
      failureDetail: null,
    });
    if (settled.outcome !== 'settled') throw new Error('expected settled');

    expect(settled.billableSeconds).toBe(17);
    expect(settled.costUsd).toBe('0.000537812833');
    // The value a float round trip would have produced instead.
    expect(String(0.000031636049 * 17)).not.toBe(settled.costUsd);
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.costUsd.toFixed()).toBe('0.000537812833');
    const [line] = await ciFleetCostMeterService.getOrgPeriodCostByWorkload(
      tenant.organizationId,
      T0,
    );
    expect(new Prisma.Decimal(line!.costUsd).toFixed()).toBe('0.000537812833');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// COVERAGE FLOOR (AC 1) — the arms the seam's own units leave open. Each test is
// a behaviour the seam PROMISES, not a line to paint: a boot refused for an
// unpullable image, a deadline reached on a failed read, a supervision ended by
// its own ceiling, a poll that throws, a row of a kind no supervisor owns.
// ─────────────────────────────────────────────────────────────────────────────

describe('every way out of supervision still settles (AC 1)', () => {
  it('an UNPULLABLE image is its own terminal outcome, and the slot goes back', async () => {
    vi.spyOn(fakeOrchestrator, 'provision').mockRejectedValueOnce(
      new OrchestratorImageUnpullableError('fake', 404, 'motir/stand-in@sha256:gone', 'not found'),
    );
    const booted = await hostedAgentContainerService.boot(requestFor());
    expect(booted).toMatchObject({ phase: 'terminal', outcome: { outcome: 'image_unpullable' } });
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
  });

  it('a provision refused with a non-Error still says so', async () => {
    vi.spyOn(fakeOrchestrator, 'provision').mockRejectedValueOnce('boom');
    const booted = await hostedAgentContainerService.boot(requestFor());
    expect(booted).toMatchObject({
      phase: 'terminal',
      outcome: { outcome: 'provision_failed', detail: expect.stringContaining('unknown') },
    });
  });

  it('a container that never starts is written off at the boot deadline, as `provision_failed`', async () => {
    fakeOrchestrator.setBootBehaviour('never_start');
    const outcome = await hostedAgentContainerService.run(requestFor(), {
      ...FAST,
      bootDeadlineMs: 0,
    });
    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'provision_failed' });
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row).toMatchObject({ workload: 'agent', billableSeconds: 0 });
  });

  it('a hung container is torn down at its run timeout, measured from the memoized boot', async () => {
    fakeOrchestrator.setBootBehaviour('hang');
    const booted = await hostedAgentContainerService.boot(requestFor({ timeoutSeconds: 60 }));
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    const late = new Date(new Date(booted.session.bootedAt).getTime() + 61_000);
    const polled = await hostedAgentContainerService.poll(booted.session, undefined, {
      now: () => late,
    });
    expect(polled).toMatchObject({ done: true, reason: 'job_timed_out' });
  });

  it('a failed read is tolerated, then gives up on reading — and a failed read cannot outlive the timeout', async () => {
    const booted = await hostedAgentContainerService.boot(requestFor({ timeoutSeconds: 60 }));
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const describeSpy = vi.spyOn(fakeOrchestrator, 'describe');

    describeSpy.mockRejectedValueOnce(new Error('provider 500'));
    expect(await hostedAgentContainerService.poll(booted.session)).toEqual({
      done: false,
      startedAt: null,
      consecutiveReadFailures: 1,
    });
    expect(warn).toHaveBeenCalled();

    describeSpy.mockRejectedValueOnce(new Error('provider 500'));
    expect(
      await hostedAgentContainerService.poll(booted.session, {
        done: false,
        startedAt: null,
        consecutiveReadFailures: HOSTED_AGENT_FLEET_TIME_BUDGETS.maxConsecutiveReadFailures,
      }),
    ).toMatchObject({ done: true, reason: 'job_timed_out' });

    describeSpy.mockRejectedValueOnce(new Error('provider 500'));
    const late = new Date(new Date(booted.session.bootedAt).getTime() + 61_000);
    expect(
      await hostedAgentContainerService.poll(booted.session, undefined, { now: () => late }),
    ).toMatchObject({ done: true, reason: 'job_timed_out' });
  });

  it('the POLL CEILING ends a supervision, with a detail that says which bound fired', async () => {
    fakeOrchestrator.setBootBehaviour('hang');
    const outcome = await hostedAgentContainerService.run(requestFor(), {
      ...FAST,
      maxPollIterations: 2,
    });
    expect(outcome).toMatchObject({
      outcome: 'settled',
      reason: 'job_timed_out',
      failureDetail: expect.stringContaining('2-poll ceiling'),
    });
  });

  it('the DEADLINE ends a resumed supervision before it polls', async () => {
    fakeOrchestrator.setBootBehaviour('hang');
    let clock = Date.now();
    const outcome = await hostedAgentContainerService.run(requestFor({ timeoutSeconds: 1 }), {
      ...FAST,
      now: () => new Date(clock),
      sleep: async () => {
        clock += 5_000;
      },
    });
    expect(outcome).toMatchObject({
      outcome: 'settled',
      failureDetail: expect.stringContaining('deadline'),
    });
  });

  it('a poll that THROWS tears the container down before the failure propagates', async () => {
    fakeOrchestrator.setBootBehaviour('hang');
    vi.spyOn(hostedAgentContainerService, 'poll').mockRejectedValueOnce(new Error('poll bug'));
    await expect(hostedAgentContainerService.run(requestFor(), FAST)).rejects.toThrow('poll bug');
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.teardownReason).toBe('job_timed_out');
  });

  it('the in-process run waits on the real clock when no seam is given, and a deferred admission returns', async () => {
    vi.stubEnv('MOTIR_FAKE_CONTAINER_AUTO_EXIT_CODE', '10');
    const outcome = await hostedAgentContainerService.run(requestFor(), {
      pollIntervalMs: 1,
      maxPollIntervalMs: 1,
    });
    expect(outcome).toMatchObject({ outcome: 'settled', exitCode: 10 });

    vi.spyOn(fleetCeilingService, 'reserve').mockResolvedValue({
      outcome: 'deferred',
      reason: 'gate_unavailable',
      detail: 'count unavailable',
    });
    expect(await hostedAgentContainerService.run(requestFor(), FAST)).toMatchObject({
      outcome: 'admission_deferred',
    });
  });
});

describe('the sweep refuses a kind no supervisor owns (AC 1)', () => {
  it('leaves an unknown-kind row WATCHING and reads no session for it', async () => {
    const run = await adminDb.jobQueueRun.create({
      data: {
        jobId: 'system.future-fleet',
        eventName: 'future/run.requested',
        workspaceId: tenant.workspaceId,
        runAt: new Date(Date.now() - 60 * 60_000),
        maxAttempts: 3,
        state: 'failed',
      },
    });
    await withSystemContext((tx) =>
      jobSupervisionRepository.open(
        {
          runId: run.id,
          subject: 'x',
          kind: 'a-supervisor-this-build-has-never-heard-of',
          nextPollAt: new Date(Date.now() - 40 * 60_000),
          workspaceId: tenant.workspaceId,
        },
        tx,
      ),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await supervisionSweepService.sweepAbandoned()).toEqual({
      scanned: 1,
      settled: 0,
      skipped: 1,
    });
    expect(error).toHaveBeenCalled();
    const row = await withSystemContext((tx) =>
      jobSupervisionRepository.findByRunAndSubject(run.id, 'x', tx),
    );
    expect(row!.state).toBe('watching');
    expect(await supervisionSweepService.readSession(row!)).toBeNull();
  });
});

describe('the rehearsal command’s refusals (AC 1)', () => {
  const args = () => ({ ...tenant, repoFullName: 'motir-projects/acme-web' });

  it('boots nothing when no fleet is configured', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_APP', '');
    const rehearsal = await rehearseHostedAgentMeter(args());
    expect(rehearsal.outcome).toBeNull();
    expect(rehearsal.text).toContain('no container fleet is configured');
  });

  it('prints a non-settled outcome and the ABSENT agent line rather than a zero', async () => {
    vi.spyOn(fleetCeilingService, 'reserve').mockResolvedValue({
      outcome: 'deferred',
      reason: 'fleet_ceiling',
      detail: 'full',
    });
    const rehearsal = await rehearseHostedAgentMeter(args());
    expect(rehearsal.outcome).toMatchObject({ outcome: 'admission_deferred' });
    expect(rehearsal.agentLine).toBeNull();
    expect(rehearsal.text).toContain('outcome: admission_deferred — full');
  });
});

describe('the rehearsal command prints what the row actually carries (AC 1)', () => {
  const args = () => ({ ...tenant, repoFullName: 'motir-projects/acme-web' });

  it('a stand-in that never started prints no start and no exit code — never a made-up one', async () => {
    fakeOrchestrator.setBootBehaviour('never_start');
    const rehearsal = await rehearseHostedAgentMeter({
      ...args(),
      options: { ...FAST, bootDeadlineMs: 0 },
    });
    expect(rehearsal.outcome).toMatchObject({ outcome: 'settled', reason: 'provision_failed' });
    expect(rehearsal.text).toContain('started          —');
    expect(rehearsal.text).toContain('exit code        not observed');
    expect(rehearsal.agentLine).toMatchObject({ containerCount: 1, containerSeconds: 0 });
  });

  it('a meter disabled mid-run reports the line ABSENT rather than a zero', async () => {
    const rehearsal = await rehearseHostedAgentMeter({
      ...args(),
      options: {
        ...FAST,
        sleep: async () => {
          vi.stubEnv('MOTIR_CLOUD', 'false');
          const live = fakeOrchestrator.liveContainerIds();
          if (live[0]) fakeOrchestrator.completeJob(live[0], { exitCode: 10 });
        },
      },
    });
    expect(rehearsal.outcome).toMatchObject({ outcome: 'settled' });
    expect(rehearsal.agentLine).toBeNull();
    expect(rehearsal.text).toContain('agent line: ABSENT');
  });
});
