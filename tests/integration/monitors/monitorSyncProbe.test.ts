import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { monitorIngestionService } from '@/lib/services/monitorIngestionService';
import { monitorSyncProbeService } from '@/lib/services/monitorSyncProbeService';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// The monitor SYNC PROBE (Story MOTIR-4931 · Subtask MOTIR-5709) — the reads and
// the one write behind the acceptance walk's `_test` doors, on real Postgres and
// through the REAL emit path (no dispatch spy): a status change here writes the
// `job_event` and `job_queue` rows the resolve-run read looks up, which is the
// only way to prove that lookup finds the run it is waiting on.

beforeEach(async () => {
  await truncateAuthTables();
  resetFakeMonitorProvider();
  fakeMonitorState().issues = [];
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
});

afterEach(() => {
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function seed(): Promise<{ fx: WorkItemFixture; connectionId: string }> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `Probe ${n}`, identifier: `PRB${n}` });
  await monitorConnectionService.completeGrant(
    {
      provider: 'sentry',
      providerInstallationId: `pi-probe-${n}`,
      code: 'valid-code',
      projectId: fx.projectId,
    },
    fx.ctx,
  );
  const dto = await monitorConnectionService.bindProject(
    fx.projectId,
    { externalProjectId: 'fake-web', externalProjectSlug: 'web' },
    fx.ctx,
  );
  fakeMonitorState().issues = [
    {
      externalId: `probe-${n}`,
      title: 'Error probe',
      culprit: null,
      level: 'error',
      eventCount: 1,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(Date.now() + 60_000),
      permalink: null,
      assignee: null,
    },
  ];
  await monitorIngestionService.pollConnection(dto.id);
  return { fx, connectionId: dto.id };
}

const bugIn = (projectId: string) =>
  adminDb.workItem.findFirstOrThrow({ where: { projectId, kind: 'bug' } });

describe('resolveRunFor — the run the walk waits on', () => {
  it('is none before any transition, then finds the enqueued resolve run for the newest one', async () => {
    const { fx } = await seed();
    const bug = await bugIn(fx.projectId);

    expect(await monitorSyncProbeService.resolveRunFor(bug.id, 'done', fx.ctx)).toBe('none');

    await workItemsService.updateStatus(bug.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(bug.id, 'done', fx.ctx);

    // The real dispatcher wrote the event and enqueued `monitor-issue-resolve`;
    // nothing claims it in this process, so it is still pending.
    expect(await monitorSyncProbeService.resolveRunFor(bug.id, 'done', fx.ctx)).toBe('pending');
  });

  it('reads terminal once the run has finished, and running while it is held', async () => {
    const { fx } = await seed();
    const bug = await bugIn(fx.projectId);
    await workItemsService.updateStatus(bug.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(bug.id, 'done', fx.ctx);
    // Both transitions enqueued a resolve run; the probe reads the `done` one's.
    const runs = { jobId: 'monitor-issue-resolve' };

    await adminDb.jobQueueRun.updateMany({ where: runs, data: { state: 'running' } });
    expect(await monitorSyncProbeService.resolveRunFor(bug.id, 'done', fx.ctx)).toBe('running');
    await adminDb.jobQueueRun.updateMany({ where: runs, data: { state: 'succeeded' } });
    expect(await monitorSyncProbeService.resolveRunFor(bug.id, 'done', fx.ctx)).toBe('terminal');
  });

  it('is none for an event no resolve run was enqueued for', async () => {
    const { fx } = await seed();
    const bug = await bugIn(fx.projectId);
    await workItemsService.updateStatus(bug.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(bug.id, 'done', fx.ctx);
    await adminDb.jobQueueRun.deleteMany({ where: { jobId: 'monitor-issue-resolve' } });
    expect(await monitorSyncProbeService.resolveRunFor(bug.id, 'done', fx.ctx)).toBe('none');
  });

  it('never answers for another workspace’s transition', async () => {
    const mine = await seed();
    const theirs = await seed();
    const bug = await bugIn(theirs.fx.projectId);
    await workItemsService.updateStatus(bug.id, 'in_progress', theirs.fx.ctx);
    await workItemsService.updateStatus(bug.id, 'done', theirs.fx.ctx);
    expect(await monitorSyncProbeService.resolveRunFor(bug.id, 'done', mine.fx.ctx)).toBe('none');
  });
});

describe('resolveStatesFor and seedSyncFailure', () => {
  it('reports each link’s resolve record, in the caller’s workspace only', async () => {
    const { fx } = await seed();
    const bug = await bugIn(fx.projectId);
    const at = new Date('2026-09-18T12:00:00.000Z');
    await adminDb.monitorIssue.updateMany({
      data: { resolveState: 'resolved', resolvedByMotirAt: at },
    });

    expect(await monitorSyncProbeService.resolveStatesFor(bug.id, fx.ctx)).toEqual([
      expect.objectContaining({ resolveState: 'resolved', resolvedByMotirAt: at.toISOString() }),
    ]);
    const other = await seed();
    expect(await monitorSyncProbeService.resolveStatesFor(bug.id, other.fx.ctx)).toEqual([]);
  });

  it('records a sync failure on the caller’s connection, and refuses another workspace’s', async () => {
    const mine = await seed();
    const theirs = await seed();
    const input = { reason: 'Sentry said no', workItemIdentifier: 'PRB-1' };

    expect(
      await monitorSyncProbeService.seedSyncFailure(mine.connectionId, input, mine.fx.ctx),
    ).toBe(true);
    expect(
      await monitorSyncProbeService.seedSyncFailure(theirs.connectionId, input, mine.fx.ctx),
    ).toBe(false);
    expect(
      (await adminDb.monitorConnection.findUniqueOrThrow({ where: { id: mine.connectionId } }))
        .lastSyncError,
    ).toBe('Sentry said no');
    expect(
      (await adminDb.monitorConnection.findUniqueOrThrow({ where: { id: theirs.connectionId } }))
        .lastSyncError,
    ).toBeNull();
  });
});
