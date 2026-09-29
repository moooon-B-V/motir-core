import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineJobs } from '@/lib/jobs/engine/registry';
import { jobSchedules } from '@/lib/jobs/schedules';
import '@/lib/jobs/registry';
import { INSTANCE_STORAGE_CREDITS_PER_DAY } from '@/lib/agentInstances/config';
import {
  agentInstanceStorageChargeService as storage,
  daysExisted,
  storageChargeReference,
  utcDayStart,
} from '@/lib/services/agentInstanceStorageChargeService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE DAILY AGENT STORAGE CHARGE (Story MOTIR-6914 · MOTIR-6919) — over the real
// service and a real Postgres, with motir-ai stubbed at its HTTP seam (`fetch`).
//
// ⚠️ ONE DEBIT PER AGENT PER UTC DAY is the assertion that matters: however often
// the pass runs, and whatever motir-ai answered the last time, each (agent, day)
// is asked for once when it lands and never again after it has.

const AI = 'https://ai.test';

interface Call {
  url: string;
  body: Record<string, unknown> | null;
}
let calls: Call[] = [];
let answer: 'ok' | 'unavailable' | 'refused' = 'ok';

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
      if (url === `${AI}/v1/credits/agent-storage`) {
        if (answer === 'unavailable') return json(503, { code: 'internal_error' });
        if (answer === 'refused') return json(404, { code: 'not_found', title: 'unknown org' });
        return json(200, { idempotent: false, balanceCredits: 90 });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }),
  );
}

const debits = () => calls.filter((c) => c.url === `${AI}/v1/credits/agent-storage`);
const charges = () =>
  adminDb.agentInstanceStorageCharge.findMany({ orderBy: [{ day: 'asc' }, { createdAt: 'asc' }] });

let fx: WorkItemFixture;
let seq = 0;

async function agent(opts: {
  state?: 'running' | 'hibernated' | 'failed' | 'deleting';
  createdAt: Date;
  deletedAt?: Date | null;
}) {
  seq += 1;
  return adminDb.agentInstance.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      projectId: fx.projectId,
      ownerId: fx.ownerId,
      name: `agent-${seq}`,
      profileId: 'claude',
      imageTag: 'ghcr.io/moooon-b-v/motir-sandbox:claude',
      imageDigest: 'sha256:0',
      region: 'iad',
      state: opts.state ?? 'running',
      createdAt: opts.createdAt,
      deletedAt: opts.deletedAt ?? null,
    },
  });
}

const at = (iso: string) => new Date(iso);

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  answer = 'ok';
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_AI_URL', `${AI}/`);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('daysExisted — the UTC days an agent stood in the window', () => {
  const windowStart = at('2026-09-28T00:00:00Z');
  const today = at('2026-09-29T00:00:00Z');
  const base = { deletedAt: null } as const;

  it('an agent older than the window is charged both window days', () => {
    const days = daysExisted(
      { ...base, createdAt: at('2026-09-01T12:00:00Z') } as never,
      windowStart,
      today,
    );
    expect(days.map((d) => d.toISOString())).toEqual([
      '2026-09-28T00:00:00.000Z',
      '2026-09-29T00:00:00.000Z',
    ]);
  });

  it('an agent created late today is charged today only', () => {
    const days = daysExisted(
      { ...base, createdAt: at('2026-09-29T23:59:00Z') } as never,
      windowStart,
      today,
    );
    expect(days.map((d) => d.toISOString())).toEqual(['2026-09-29T00:00:00.000Z']);
  });

  it('an agent deleted yesterday is charged yesterday and not today', () => {
    const days = daysExisted(
      { createdAt: at('2026-09-01T00:00:00Z'), deletedAt: at('2026-09-28T00:00:01Z') } as never,
      windowStart,
      today,
    );
    expect(days.map((d) => d.toISOString())).toEqual(['2026-09-28T00:00:00.000Z']);
  });

  it('utcDayStart and the reference use the UTC calendar day', () => {
    expect(utcDayStart(at('2026-09-29T23:59:59.999Z')).toISOString()).toBe(
      '2026-09-29T00:00:00.000Z',
    );
    expect(storageChargeReference('inst1', at('2026-09-29T00:00:00Z'))).toBe(
      'agent-storage:inst1:2026-09-29',
    );
  });
});

describe('chargeDays — one debit per agent per UTC day', () => {
  const now = at('2026-09-29T10:30:00Z');

  it('two agents in one org, one of them asleep, produce two debits for the day — and a rerun produces none', async () => {
    const awake = await agent({ state: 'running', createdAt: at('2026-09-29T08:00:00Z') });
    const asleep = await agent({ state: 'hibernated', createdAt: at('2026-09-29T09:00:00Z') });

    const first = await storage.chargeDays({ now });
    expect(first).toEqual({ written: 2, charged: 2, refused: 0, notCharged: 0, retryable: 0 });
    expect(debits()).toHaveLength(2);
    expect(debits().map((c) => c.body)).toEqual(
      expect.arrayContaining([
        {
          coreOrganizationId: fx.workspace.organizationId,
          instanceId: awake.id,
          day: '2026-09-29',
          credits: INSTANCE_STORAGE_CREDITS_PER_DAY,
          reason: 'agent instance storage',
        },
        {
          coreOrganizationId: fx.workspace.organizationId,
          instanceId: asleep.id,
          day: '2026-09-29',
          credits: INSTANCE_STORAGE_CREDITS_PER_DAY,
          reason: 'agent instance storage',
        },
      ]),
    );
    const rows = await charges();
    expect(rows.map((r) => r.chargeOutcome)).toEqual(['charged', 'charged']);
    expect(rows.every((r) => r.chargedAt !== null)).toBe(true);

    const again = await storage.chargeDays({ now: at('2026-09-29T11:30:00Z') });
    expect(again).toEqual({ written: 0, charged: 0, refused: 0, notCharged: 0, retryable: 0 });
    expect(debits()).toHaveLength(2);
  });

  it('the next day charges the new day and never re-charges yesterday', async () => {
    await agent({ createdAt: at('2026-09-28T20:00:00Z') });
    await storage.chargeDays({ now: at('2026-09-28T21:30:00Z') });
    expect(debits().map((c) => c.body?.day)).toEqual(['2026-09-28']);

    await storage.chargeDays({ now: at('2026-09-29T00:30:00Z') });
    expect(debits().map((c) => c.body?.day)).toEqual(['2026-09-28', '2026-09-29']);
    expect((await charges()).map((r) => r.chargeReference)).toHaveLength(2);
  });

  it('with motir-ai failing, the day stays pending and is charged once on the next pass', async () => {
    await agent({ createdAt: at('2026-09-29T08:00:00Z') });
    answer = 'unavailable';
    const failed = await storage.chargeDays({ now });
    expect(failed).toMatchObject({ written: 1, charged: 0, retryable: 1 });
    const [pending] = await charges();
    expect(pending!.chargeOutcome).toBe('pending');
    expect(pending!.chargeAttempts).toBe(1);
    expect(pending!.chargeDetail).toBeTruthy();

    answer = 'ok';
    const recovered = await storage.chargeDays({ now: at('2026-09-29T11:30:00Z') });
    expect(recovered).toMatchObject({ written: 0, charged: 1, retryable: 0 });
    const [settled] = await charges();
    expect(settled!.chargeOutcome).toBe('charged');
    expect(settled!.chargeAttempts).toBe(2);
    // Two asks, the same key both times: motir-ai dedupes on it, so a debit that
    // landed before the failed answer is never charged twice.
    expect(debits().map((c) => c.body?.instanceId)).toEqual([
      settled!.agentInstanceId,
      settled!.agentInstanceId,
    ]);
    expect(new Set(debits().map((c) => c.body?.day))).toEqual(new Set(['2026-09-29']));

    await storage.chargeDays({ now: at('2026-09-29T12:30:00Z') });
    expect(debits()).toHaveLength(2);
  });

  it('a definite refusal is recorded and never asked again', async () => {
    await agent({ createdAt: at('2026-09-29T08:00:00Z') });
    answer = 'refused';
    expect(await storage.chargeDays({ now })).toMatchObject({ refused: 1 });
    expect((await charges())[0]!.chargeOutcome).toBe('refused');
    answer = 'ok';
    await storage.chargeDays({ now: at('2026-09-29T11:30:00Z') });
    expect(debits()).toHaveLength(1);
  });

  it('an agent deleted today is charged today and never again', async () => {
    const gone = await agent({
      state: 'deleting',
      createdAt: at('2026-09-20T08:00:00Z'),
      deletedAt: at('2026-09-29T09:00:00Z'),
    });
    await storage.chargeDays({ now });
    // Yesterday (it existed all day) and today (the day it was deleted).
    expect(debits().map((c) => c.body?.day)).toEqual(['2026-09-28', '2026-09-29']);

    await storage.chargeDays({ now: at('2026-09-30T00:30:00Z') });
    await storage.chargeDays({ now: at('2026-10-01T00:30:00Z') });
    expect(debits()).toHaveLength(2);
    expect((await charges()).every((r) => r.agentInstanceId === gone.id)).toBe(true);
  });

  it('an agent deleted before the window is never charged', async () => {
    await agent({
      state: 'deleting',
      createdAt: at('2026-09-01T08:00:00Z'),
      deletedAt: at('2026-09-27T09:00:00Z'),
    });
    expect(await storage.chargeDays({ now })).toMatchObject({ written: 0, charged: 0 });
    expect(debits()).toHaveLength(0);
  });

  it('a failed agent is still charged — its disk still exists', async () => {
    await agent({ state: 'failed', createdAt: at('2026-09-29T08:00:00Z') });
    expect(await storage.chargeDays({ now })).toMatchObject({ charged: 1 });
  });

  it('with motir-ai unconfigured the day is recorded not_charged and not retried', async () => {
    vi.stubEnv('MOTIR_AI_URL', '');
    await agent({ createdAt: at('2026-09-29T08:00:00Z') });
    expect(await storage.chargeDays({ now })).toMatchObject({ notCharged: 1 });
    expect((await charges())[0]!.chargeOutcome).toBe('not_charged');
    expect(debits()).toHaveLength(0);
  });

  it('a self-hosted build writes nothing and charges nothing', async () => {
    vi.stubEnv('MOTIR_CLOUD', '');
    await agent({ createdAt: at('2026-09-29T08:00:00Z') });
    expect(await storage.chargeDays({ now })).toEqual({
      written: 0,
      charged: 0,
      refused: 0,
      notCharged: 0,
      retryable: 0,
    });
    expect(await charges()).toHaveLength(0);
    expect(debits()).toHaveLength(0);
  });
});

describe('the job', () => {
  it('is registered on a clustered minute', () => {
    const schedule = jobSchedules().find(
      (s) => s.functionId === 'system.agent-instance-storage-charge',
    );
    expect(schedule?.cron).toBe('30 * * * *');
    expect(engineJobs().some((j) => j.id === 'system.agent-instance-storage-charge')).toBe(true);
  });
});
