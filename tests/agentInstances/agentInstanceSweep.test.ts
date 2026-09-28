import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePersistentOrchestrator as fleet } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { agentInstanceChargeService } from '@/lib/services/agentInstanceChargeService';
import {
  agentInstanceClock,
  agentInstanceLifecycleService as lifecycle,
} from '@/lib/services/agentInstanceLifecycleService';
import { agentInstanceSweepService as sweeper } from '@/lib/services/agentInstanceSweepService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE AGENT-INSTANCE CHARGE, IDLE TIMER AND SWEEP (Story MOTIR-6860 · MOTIR-6873)
// — over the real services and a real Postgres, the instance fleet on the FAKE
// persistent orchestrator, and motir-ai stubbed at its HTTP seam (`fetch`).
//
// ⚠️ EXACTLY ONCE is the assertion that matters for every charge: one debit
// request per interval however often the charge is asked, and the interval row
// leaves `pending` once.

const AI = 'https://ai.test';

interface Call {
  url: string;
  body: Record<string, unknown> | null;
}
let calls: Call[] = [];
let mayRun = true;
let debitAnswer: 'ok' | 'unavailable' | 'out_of_credits' = 'ok';

function stubFetch(): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, body });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url === `${AI}/v1/credits/agent-run-check`) {
        return json(200, { balanceCredits: mayRun ? 100 : 0, mayRun });
      }
      if (url === `${AI}/v1/credits/agent-machine`) {
        if (debitAnswer === 'unavailable') return json(503, { code: 'internal_error' });
        if (debitAnswer === 'out_of_credits') {
          return json(402, { code: 'out_of_credits', title: 'out of credits' });
        }
        return json(200, { idempotent: false, balanceCredits: 90 });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }),
  );
}

const debits = () => calls.filter((c) => c.url === `${AI}/v1/credits/agent-machine`);
const intervals = () => adminDb.agentInstanceInterval.findMany({ orderBy: { createdAt: 'asc' } });
const instance = async () => (await adminDb.agentInstance.findMany({}))[0]!;

let fx: WorkItemFixture;
let virtualNow = new Date('2026-09-28T10:00:00.000Z').getTime();
const MIN = 60 * 1000;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetInFlightSlot.deleteMany({});
  fleet.reset();
  fx = await makeWorkItemFixture();
  mayRun = true;
  debitAnswer = 'ok';
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_AI_URL', `${AI}/`);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubEnv('MOTIR_INSTANCE_MAX_RUNNING', '');
  vi.stubEnv('MOTIR_INSTANCE_MAX_RUNNING_PER_ORG', '');
  stubFetch();
  virtualNow = new Date('2026-09-28T10:00:00.000Z').getTime();
  vi.spyOn(agentInstanceClock, 'now').mockImplementation(() => new Date(virtualNow));
  vi.spyOn(agentInstanceClock, 'sleep').mockImplementation(async (ms: number) => {
    virtualNow += ms;
  });
  fleet.setNow(() => new Date(virtualNow));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A running instance on a project with no repositories — nothing to clone. */
const createRunning = async () => {
  const dto = await lifecycle.create(
    fx.projectIdentifier,
    { name: 'yue-claude', profileId: 'claude' },
    fx.ctx,
  );
  expect(dto.state).toBe('running');
  return dto;
};

describe('the interval charge', () => {
  it('a hibernate closes the interval and charges it ONCE, keyed on the interval', async () => {
    const dto = await createRunning();
    virtualNow += 10 * MIN;
    await lifecycle.hibernate(fx.projectIdentifier, dto.id, fx.ctx);

    const [interval] = await intervals();
    expect(interval).toMatchObject({ endReason: 'hibernated', chargeOutcome: 'charged' });
    expect(debits()).toHaveLength(1);
    expect(debits()[0]!.body).toMatchObject({
      coreOrganizationId: fx.workspace.organizationId,
      instanceIntervalId: interval!.id,
      externalRef: `agent-instance-interval:${interval!.id}`,
      billableSeconds: interval!.billableSeconds,
    });
    expect(debits()[0]!.body).not.toHaveProperty('coreRunId');

    // Asked again, directly and through the sweep's backstop: nothing moves.
    expect(await agentInstanceChargeService.chargeInterval(interval!.id)).toEqual({
      outcome: 'noop',
    });
    await sweeper.sweep();
    expect(debits()).toHaveLength(1);
  });

  it('an OPEN interval is never charged', async () => {
    await createRunning();
    const [open] = await intervals();
    expect(await agentInstanceChargeService.chargeInterval(open!.id)).toEqual({ outcome: 'noop' });
    expect(debits()).toEqual([]);
  });

  it('motir-ai unreachable leaves it pending with the attempt counted; the sweep charges it later', async () => {
    const dto = await createRunning();
    debitAnswer = 'unavailable';
    virtualNow += 5 * MIN;
    await lifecycle.hibernate(fx.projectIdentifier, dto.id, fx.ctx);
    let [interval] = await intervals();
    expect(interval).toMatchObject({ chargeOutcome: 'pending', chargeAttempts: 1 });

    debitAnswer = 'ok';
    const summary = await sweeper.sweep();
    expect(summary.charges.charged).toBe(1);
    [interval] = await intervals();
    expect(interval).toMatchObject({ chargeOutcome: 'charged', chargeAttempts: 2 });
    // Both requests carried the SAME key — the ledger debits once.
    expect(new Set(debits().map((d) => d.body!.externalRef))).toEqual(
      new Set([`agent-instance-interval:${interval!.id}`]),
    );
  });

  it('a refusal is recorded as refused and never asked again', async () => {
    const dto = await createRunning();
    debitAnswer = 'out_of_credits';
    virtualNow += 5 * MIN;
    await lifecycle.hibernate(fx.projectIdentifier, dto.id, fx.ctx);
    expect((await intervals())[0]).toMatchObject({ chargeOutcome: 'refused' });
    await sweeper.sweep();
    expect(debits()).toHaveLength(1);
  });

  it('off a billing build the interval is recorded not charged, and motir-ai is never asked', async () => {
    const dto = await createRunning();
    vi.stubEnv('MOTIR_CLOUD', '');
    virtualNow += 5 * MIN;
    await lifecycle.hibernate(fx.projectIdentifier, dto.id, fx.ctx);
    expect((await intervals())[0]).toMatchObject({ chargeOutcome: 'not_charged' });
    expect(debits()).toEqual([]);
  });
});

describe('the idle timer (checkIdle)', () => {
  it('is ARMED when an instance starts running, debounced on the instance, 30 minutes out', async () => {
    const dto = await createRunning();
    const queued = await adminDb.jobQueueRun.findMany({
      where: { jobId: 'agent-instance/idle-check' },
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ debounceKey: dto.id, state: 'pending' });
    const delayMs = queued[0]!.runAt.getTime() - queued[0]!.createdAt.getTime();
    expect(delayMs).toBeGreaterThanOrEqual(30 * MIN - 1000);
    expect(delayMs).toBeLessThanOrEqual(30 * MIN + 1000);

    // A bump re-arms the SAME debounce bucket rather than queueing a second run.
    await lifecycle.touchActivity(dto.id);
    expect(
      await adminDb.jobQueueRun.count({
        where: { jobId: 'agent-instance/idle-check', state: 'pending' },
      }),
    ).toBe(1);
  });

  it('leaves an instance active inside the window and hibernates it `idle` after 30 quiet minutes', async () => {
    const dto = await createRunning();
    virtualNow += 29 * MIN;
    expect(await sweeper.checkIdle(dto.id)).toBe('active');

    virtualNow += 2 * MIN;
    expect(await sweeper.checkIdle(dto.id)).toBe('idle');
    expect(['hibernating', 'hibernated']).toContain((await instance()).state);
    expect((await intervals())[0]).toMatchObject({ endReason: 'idle' });
  });

  it('an activity bump restarts the window', async () => {
    const dto = await createRunning();
    virtualNow += 25 * MIN;
    await lifecycle.touchActivity(dto.id);
    virtualNow += 10 * MIN;
    expect(await sweeper.checkIdle(dto.id)).toBe('active');
  });

  it('an interval that reaches 12 hours hibernates `backstop`, however busy', async () => {
    const dto = await createRunning();
    virtualNow += 12 * 60 * MIN;
    await lifecycle.touchActivity(dto.id);
    expect(await sweeper.checkIdle(dto.id)).toBe('backstop');
    expect((await intervals())[0]).toMatchObject({ endReason: 'backstop' });
  });

  it('a hibernated or deleted instance is a no-op', async () => {
    const dto = await createRunning();
    await lifecycle.hibernate(fx.projectIdentifier, dto.id, fx.ctx);
    expect(await sweeper.checkIdle(dto.id)).toBe('noop');
    expect(await sweeper.checkIdle('no-such-instance')).toBe('noop');
  });
});

describe('the sweep', () => {
  it('hibernates an idle instance whose timer was lost, and leaves an active one alone', async () => {
    await createRunning();
    virtualNow += 5 * MIN;
    expect((await sweeper.sweep()).hibernated.idle).toBe(0);
    expect((await instance()).state).toBe('running');

    virtualNow += 30 * MIN;
    const summary = await sweeper.sweep();
    expect(summary.hibernated.idle).toBe(1);
    expect((await intervals())[0]).toMatchObject({ endReason: 'idle', chargeOutcome: 'charged' });
  });

  it('stops a running instance whose organisation the credit pre-flight now refuses', async () => {
    await createRunning();
    mayRun = false;
    const summary = await sweeper.sweep();
    expect(summary.hibernated.credits).toBe(1);
    expect((await intervals())[0]).toMatchObject({ endReason: 'credits' });
  });

  it('reconciles a machine that stopped behind Motir’s back, and one that vanished', async () => {
    await createRunning();
    const row = await instance();
    virtualNow += 3 * MIN;
    fleet.stopOutside(row.machineId!);
    expect((await sweeper.sweep()).reconciled).toBe(1);
    expect((await instance()).state).toBe('hibernated');
    expect((await intervals())[0]).toMatchObject({
      endReason: 'hibernated',
      chargeOutcome: 'charged',
    });

    await lifecycle.wake(fx.projectIdentifier, row.id, fx.ctx);
    fleet.destroyOutside(row.machineId!);
    expect((await sweeper.sweep()).reconciled).toBe(1);
    expect((await instance()).state).toBe('failed');
    expect((await intervals())[1]).toMatchObject({ endReason: 'lost' });
  });

  it('finishes a delete the provider refused the first time', async () => {
    const dto = await createRunning();
    fleet.failNextDestroy();
    await lifecycle.delete(fx.projectIdentifier, dto.id, fx.ctx);
    expect((await instance()).state).toBe('deleting');

    expect((await sweeper.sweep()).settled).toBe(1);
    expect((await instance()).deletedAt).not.toBeNull();
    expect(fleet.liveMachineIds()).toEqual([]);
    expect(fleet.liveVolumeIds()).toEqual([]);
  });

  it('destroys an orphan machine no live record owns once it is 15 minutes old, and its volume once detached', async () => {
    await createRunning();
    const row = await instance();
    const orphan = await fleet.provisionPersistent({
      ...fleet.persistentSpecs[0]!,
      instanceId: 'orphan-instance',
      env: { MOTIR_INSTANCE_ID: 'orphan-instance' },
    });
    await fleet.stop(orphan);
    expect(fleet.liveMachineIds()).toHaveLength(2);

    virtualNow += 5 * MIN;
    await lifecycle.touchActivity(row.id);
    expect((await sweeper.sweep()).orphans).toEqual({ machines: 0, volumes: 0 });

    virtualNow += 15 * MIN;
    await lifecycle.touchActivity(row.id);
    // The volume was attached in this pass's inventory, so it waits one pass —
    // never a volume delete racing its machine's destroy.
    expect((await sweeper.sweep()).orphans).toEqual({ machines: 1, volumes: 0 });
    expect(fleet.liveMachineIds()).toEqual([row.machineId]);
    expect((await sweeper.sweep()).orphans).toEqual({ machines: 0, volumes: 1 });
    expect(fleet.liveVolumeIds()).toEqual([row.volumeId]);
    expect((await instance()).state).toBe('running');
  });
});
