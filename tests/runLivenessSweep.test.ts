import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { DispatchRunNotFoundError, DispatchRunTerminalError } from '@/lib/dispatchRuns/errors';
import { runLivenessSweep, RUN_LIVENESS_SWEEP_CRON } from '@/lib/jobs/definitions/runLivenessSweep';
import { engineJob } from '@/lib/jobs/engine/registry';
import { jobServices } from '@/lib/jobs/services';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { dispatchRunSweepService } from '@/lib/services/dispatchRunSweepService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures/workItemFixtures';
import { createTestUser } from './fixtures/userFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// THE LAPSE REAP (Story MOTIR-6526 · MOTIR-6528) — a LOCAL run whose heartbeat
// lapsed is closed `abandoned`, with its reason, and NO card moves. Everything
// else — a heartbeating run, a hosted run, a legacy run inside its 12 hours —
// is left alone. Two tenants throughout, for the same reason
// `dispatchRunSweep.test.ts` gives: the discovery is cross-tenant.

let a: WorkItemFixture;
let b: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  a = await makeWorkItemFixture({ name: 'Alpha', identifier: 'ALFA' });
  b = await makeWorkItemFixture({ name: 'Bravo', identifier: 'BRVO' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function openRun(fixture: WorkItemFixture, origin: 'local' | 'hosted' = 'local') {
  const item = await workItemsService.createWorkItem(
    { projectId: fixture.projectId, kind: 'task', title: 'a card' },
    fixture.ctx,
  );
  const { run } = await dispatchRunService.open(
    {
      projectKey: fixture.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      origin,
      cards: [{ key: item.identifier, disposition: 'queued' }],
    },
    fixture.ctx,
  );
  return { runId: run.id, key: item.identifier };
}

/** Set a run's last heartbeat to `minutes` ago (null = never beat). */
async function beatAgo(runId: string, minutes: number | null): Promise<void> {
  await adminDb.dispatchRun.update({
    where: { id: runId },
    data: {
      lastHeartbeatAt: minutes === null ? null : new Date(Date.now() - minutes * 60_000),
    },
  });
}

async function cardState(key: string) {
  return adminDb.workItem.findFirst({
    where: { identifier: key },
    select: { status: true, assigneeId: true, sessionBranch: true, updatedAt: true },
  });
}

describe('reapLapsed — a silent local run is closed, and nothing else is', () => {
  it('closes lapsed local runs in EVERY workspace as `timed_out` / `abandoned`, with the reason, and moves no card', async () => {
    const lapsed: { runId: string; key: string }[] = [];
    for (const f of [a, b]) {
      const run = await openRun(f);
      await beatAgo(run.runId, 6);
      lapsed.push(run);
    }
    const before = await Promise.all(lapsed.map((r) => cardState(r.key)));

    const summary = await dispatchRunSweepService.reapLapsed();

    expect(summary).toEqual({ runsReaped: 2, runsRacedByClose: 0, runsFailed: 0 });
    for (const [i, { runId, key }] of lapsed.entries()) {
      const row = await adminDb.dispatchRun.findUnique({ where: { id: runId } });
      expect(row).toMatchObject({ status: 'timed_out', stopReason: 'abandoned' });
      const events = await adminDb.dispatchRunEvent.findMany({ where: { dispatchRunId: runId } });
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe('log');
      expect((events[0]!.data as { message: string }).message).toMatch(/^no heartbeat since /);
      // ⚠️ THE CARD KEEPS ITS STATUS — the whole direction of the decision.
      expect(await cardState(key)).toEqual(before[i]);
    }
  });

  it('leaves a heartbeating run, a hosted run and a legacy run under 12 h untouched', async () => {
    const beating = await openRun(a);
    await beatAgo(beating.runId, 1);
    const hosted = await openRun(a, 'hosted');
    await beatAgo(hosted.runId, null);
    const legacy = await openRun(b);
    await beatAgo(legacy.runId, null);
    await adminDb.dispatchRun.update({
      where: { id: legacy.runId },
      data: { startedAt: new Date(Date.now() - 60 * 60_000) },
    });

    const summary = await dispatchRunSweepService.reapLapsed();

    expect(summary.runsReaped).toBe(0);
    for (const { runId } of [beating, hosted, legacy]) {
      expect((await adminDb.dispatchRun.findUnique({ where: { id: runId } }))!.status).toBe(
        'running',
      );
    }
  });

  it('a heartbeat arriving AFTER the reap closed the run is refused with 409’s error', async () => {
    const { runId } = await openRun(a);
    await beatAgo(runId, 6);
    await dispatchRunSweepService.reapLapsed();

    await expect(dispatchRunService.heartbeat(runId, a.ctx)).rejects.toBeInstanceOf(
      DispatchRunTerminalError,
    );
  });

  it('is idempotent — a second pass finds nothing', async () => {
    const { runId } = await openRun(a);
    await beatAgo(runId, 10);
    expect((await dispatchRunSweepService.reapLapsed()).runsReaped).toBe(1);
    expect(await dispatchRunSweepService.reapLapsed()).toEqual({
      runsReaped: 0,
      runsRacedByClose: 0,
      runsFailed: 0,
    });
  });
});

describe('the age reap no longer closes a HEARTBEATING run, however long it runs', () => {
  it('a 2-day-old run that beat a minute ago stays `running`; a 2-day-old silent legacy run is reaped', async () => {
    const alive = await openRun(a);
    const legacy = await openRun(b);
    for (const { runId } of [alive, legacy]) {
      await adminDb.dispatchRun.update({
        where: { id: runId },
        data: { startedAt: new Date(Date.now() - 2 * 24 * 60 * 60_000) },
      });
    }
    await beatAgo(alive.runId, 1);

    const summary = await dispatchRunSweepService.sweep();

    expect(summary.runsReaped).toBe(1);
    expect((await adminDb.dispatchRun.findUnique({ where: { id: alive.runId } }))!.status).toBe(
      'running',
    );
    expect((await adminDb.dispatchRun.findUnique({ where: { id: legacy.runId } }))!.status).toBe(
      'timed_out',
    );
  });
});

describe('heartbeat — only the run’s own operator may beat for it', () => {
  it('another user in the same workspace gets the not-found error, and nothing is written', async () => {
    const { runId } = await openRun(a);
    const stranger = await createTestUser();
    await expect(
      dispatchRunService.heartbeat(runId, { userId: stranger.id, workspaceId: a.workspaceId }),
    ).rejects.toBeInstanceOf(DispatchRunNotFoundError);
    expect((await adminDb.dispatchRun.findUnique({ where: { id: runId } }))!.lastHeartbeatAt).toBe(
      null,
    );
  });
});

describe('system.run-liveness-sweep', () => {
  it('is registered every 5 minutes, catch-up `latest`, idempotent', () => {
    expect(RUN_LIVENESS_SWEEP_CRON).toBe('*/5 * * * *');
    expect(runLivenessSweep.id).toBe('system.run-liveness-sweep');
    expect(runLivenessSweep.cron).toBe('*/5 * * * *');
    expect(runLivenessSweep.catchUp).toBe('latest');
    expect(runLivenessSweep.retryPolicy).toBe('idempotent');
  });

  it('the handler delegates to the lapse reap and returns what it counted (MOTIR-6537)', async () => {
    // Through the ENGINE registry's own handler — the function the worker invokes.
    const spy = vi
      .spyOn(dispatchRunSweepService, 'reapLapsed')
      .mockResolvedValue({ runsReaped: 2, runsRacedByClose: 1, runsFailed: 0 });
    const step = { run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn() };

    const handler = engineJob('system.run-liveness-sweep')!.handler;
    const result = await handler({ step } as never, jobServices as never);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ runsReaped: 2, runsRacedByClose: 1, runsFailed: 0 });
    spy.mockRestore();
  });
});
