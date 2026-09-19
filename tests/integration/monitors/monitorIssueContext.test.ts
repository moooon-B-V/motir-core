import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { MonitorProvider } from '@/lib/monitors/provider';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
  type FakeMonitorIssue,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import {
  MONITOR_CONTEXT_READS_PER_POLL,
  monitorIngestionService,
  type MonitorReconcileConnection,
} from '@/lib/services/monitorIngestionService';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// THE LINK KEEPS ITS FACTS WHOLE (Story MOTIR-4932 · Subtask MOTIR-5729) — the
// latest event's environment and release, read OUTSIDE the reconciler's row
// lock and written on every outcome; a failed read that changes nothing but
// their freshness; the per-poll cap; and a hand-linked issue below the minimum
// level that still refreshes.
//
// Against the FAKE provider registered under `sentry` and real Postgres, with
// every outcome driven through `pollConnection` / `reconcileIssue` rather than
// by reading the code.

beforeEach(async () => {
  await truncateAuthTables();
  resetFakeMonitorProvider();
  fakeMonitorState().issues = [];
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
});

afterEach(() => {
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function seed(): Promise<{
  fx: WorkItemFixture;
  connectionId: string;
  target: MonitorReconcileConnection;
}> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `Context ${n}`, identifier: `CTX${n}` });
  await monitorConnectionService.completeGrant(
    {
      provider: 'sentry',
      providerInstallationId: `pi-context-${n}`,
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
  return {
    fx,
    connectionId: dto.id,
    target: {
      id: dto.id,
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
      boundByUserId: fx.ctx.userId,
      externalProjectSlug: 'web',
    },
  };
}

function issue(
  externalId: string,
  minutesAfterNow: number,
  overrides: Partial<FakeMonitorIssue> = {},
): FakeMonitorIssue {
  return {
    externalId,
    title: `Error ${externalId}`,
    culprit: `lib/${externalId}.ts`,
    level: 'error',
    eventCount: 1,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(Date.now() + minutesAfterNow * 60_000),
    permalink: null,
    assignee: null,
    ...overrides,
  };
}

const rowOf = (externalIssueId: string) =>
  adminDb.monitorIssue.findFirstOrThrow({ where: { externalIssueId } });
const bugCount = (projectId: string) =>
  adminDb.workItem.count({ where: { projectId, kind: 'bug' } });
const complete = (workItemId: string) =>
  adminDb.workItem.update({ where: { id: workItemId }, data: { status: 'done' } });

describe('the context is stored on EVERY outcome', () => {
  it('filed — a new issue’s environment and release land on its row', async () => {
    const { connectionId } = await seed();
    fakeMonitorState().issues = [issue('n', 5, { environment: 'production', release: '1.4.2' })];

    const summary = await monitorIngestionService.pollConnection(connectionId);

    expect(summary).toMatchObject({ status: 'ok', filed: 1 });
    expect(await rowOf('n')).toMatchObject({ environment: 'production', release: '1.4.2' });
  });

  it('updated — a recurrence rewrites them from the latest event', async () => {
    const { connectionId } = await seed();
    fakeMonitorState().issues = [issue('u', 5, { environment: 'staging', release: '1.4.1' })];
    await monitorIngestionService.pollConnection(connectionId);

    fakeMonitorState().issues = [
      issue('u', 30, { eventCount: 9, environment: 'production', release: '1.4.2' }),
    ];
    const summary = await monitorIngestionService.pollConnection(connectionId);

    expect(summary).toMatchObject({ status: 'ok', updated: 1, filed: 0 });
    expect(await rowOf('u')).toMatchObject({
      eventCount: 9,
      environment: 'production',
      release: '1.4.2',
    });
  });

  it('refiled — a recurrence after completion stores them on the re-filed row', async () => {
    const { fx, connectionId } = await seed();
    fakeMonitorState().issues = [issue('r', 5, { environment: 'staging', release: '1.0.0' })];
    await monitorIngestionService.pollConnection(connectionId);
    await complete((await rowOf('r')).workItemId!);

    fakeMonitorState().issues = [issue('r', 30, { environment: 'production', release: '1.4.2' })];
    const summary = await monitorIngestionService.pollConnection(connectionId);

    expect(summary).toMatchObject({ status: 'ok', refiled: 1 });
    expect(await bugCount(fx.projectId)).toBe(2);
    expect(await rowOf('r')).toMatchObject({ environment: 'production', release: '1.4.2' });
  });

  it('a successful read writes its NULLs — "the latest event carried none" is a fact', async () => {
    const { connectionId } = await seed();
    fakeMonitorState().issues = [issue('z', 5, { environment: 'production', release: '1.4.2' })];
    await monitorIngestionService.pollConnection(connectionId);

    fakeMonitorState().issues = [issue('z', 30)];
    await monitorIngestionService.pollConnection(connectionId);

    expect(await rowOf('z')).toMatchObject({ environment: null, release: null });
  });
});

describe('a failed context read changes NOTHING but the two columns’ freshness', () => {
  it.each([
    ['refused', () => fakeMonitorState().failNextStatus.set('getIssueContext', { status: 500 })],
    ['gone', () => fakeMonitorState().deletedIssues.add('f')],
  ] as const)(
    'a %s read leaves the stored values, still updates the facts, and records ok',
    async (_label, arm) => {
      const { fx, connectionId } = await seed();
      fakeMonitorState().issues = [issue('f', 5, { environment: 'production', release: '1.4.2' })];
      await monitorIngestionService.pollConnection(connectionId);

      // The monitor now says something different about the latest event — and
      // the read of it fails.
      fakeMonitorState().issues = [
        issue('f', 30, { eventCount: 4, environment: 'staging', release: '2.0.0' }),
      ];
      arm();
      const summary = await monitorIngestionService.pollConnection(connectionId);

      expect(summary).toMatchObject({ status: 'ok', updated: 1, filed: 0 });
      expect(await rowOf('f')).toMatchObject({
        eventCount: 4,
        environment: 'production',
        release: '1.4.2',
      });
      expect(await bugCount(fx.projectId)).toBe(1);
      const connection = await adminDb.monitorConnection.findUniqueOrThrow({
        where: { id: connectionId },
      });
      expect(connection).toMatchObject({ lastPollStatus: 'ok', lastPollError: null });
    },
  );

  it('a failed read on a NEW issue still files it — with no context, not a failure', async () => {
    const { fx, connectionId } = await seed();
    fakeMonitorState().issues = [issue('nf', 5, { environment: 'production' })];
    fakeMonitorState().failNextStatus.set('getIssueContext', { status: 503, reason: 'busy' });

    const summary = await monitorIngestionService.pollConnection(connectionId);

    expect(summary).toMatchObject({ status: 'ok', filed: 1 });
    expect(await bugCount(fx.projectId)).toBe(1);
    expect(await rowOf('nf')).toMatchObject({ environment: null, release: null });
  });

  it('a 401 on the ENRICHMENT never marks a working connection degraded', async () => {
    const { connectionId } = await seed();
    fakeMonitorState().issues = [issue('h', 5)];
    fakeMonitorState().failNext.add('getIssueContext');

    await monitorIngestionService.pollConnection(connectionId);

    const connection = await adminDb.monitorConnection.findUniqueOrThrow({
      where: { id: connectionId },
      include: { installation: true },
    });
    expect(connection.installation.health).toBe('connected');
    expect(fakeMonitorState().refreshCount).toBe(0);
  });
});

describe('the read happens OUTSIDE the row lock', () => {
  it('no getIssueContext call is made while a reconcile of the SAME issue holds its lock', async () => {
    const { connectionId } = await seed();
    fakeMonitorState().issues = [issue('o1', 5), issue('o2', 10), issue('o3', 15)];

    // Record, in the provider, whether a reconcile for the issue being read is
    // in progress — the reconciler takes the row lock inside that call, so a
    // context read made during it would be a read under the lock.
    const reconciling = new Set<string>();
    const readsUnderLock: string[] = [];
    const order: string[] = [];
    const real = monitorIngestionService.reconcileIssue.bind(monitorIngestionService);
    vi.spyOn(monitorIngestionService, 'reconcileIssue').mockImplementation(
      async (target, polled, context) => {
        reconciling.add(polled.externalId);
        order.push(`reconcile:${polled.externalId}`);
        try {
          return await real(target, polled, context);
        } finally {
          reconciling.delete(polled.externalId);
        }
      },
    );
    const recording: MonitorProvider = {
      ...fakeMonitorProvider,
      async getIssueContext(input) {
        if (reconciling.has(input.externalIssueId)) readsUnderLock.push(input.externalIssueId);
        order.push(`context:${input.externalIssueId}`);
        return fakeMonitorProvider.getIssueContext(input);
      },
    };
    registerMonitorProvider(recording, 'sentry');

    const summary = await monitorIngestionService.pollConnection(connectionId);

    expect(summary).toMatchObject({ status: 'ok', filed: 3 });
    expect(readsUnderLock).toEqual([]);
    // Each issue's context is read BEFORE its own reconcile begins.
    for (const id of ['o1', 'o2', 'o3']) {
      expect(order.indexOf(`context:${id}`)).toBeLessThan(order.indexOf(`reconcile:${id}`));
    }
  });
});

describe('the per-poll CAP', () => {
  it(
    `reads at most ${MONITOR_CONTEXT_READS_PER_POLL} contexts and still reconciles every issue`,
    { timeout: 120_000 },
    async () => {
      const { fx, connectionId } = await seed();
      const count = MONITOR_CONTEXT_READS_PER_POLL + 1;
      fakeMonitorState().issues = Array.from({ length: count }, (_, i) =>
        issue(`cap-${i}`, 5 + i, { environment: 'production', release: '1.0.0' }),
      );

      const summary = await monitorIngestionService.pollConnection(connectionId);

      expect(summary).toMatchObject({ status: 'ok', filed: count });
      expect(await bugCount(fx.projectId)).toBe(count);
      expect(fakeMonitorState().contextReads).toHaveLength(MONITOR_CONTEXT_READS_PER_POLL);
      const withContext = await adminDb.monitorIssue.count({
        where: { connectionId, environment: 'production' },
      });
      expect(withContext).toBe(MONITOR_CONTEXT_READS_PER_POLL);
    },
  );
});

describe('a LINKED issue below the minimum level still refreshes', () => {
  /** A bug linked to the issue, then the connection raised above its level. */
  async function linkedBelowMinimum(): Promise<{
    fx: WorkItemFixture;
    connectionId: string;
    workItemId: string;
  }> {
    const s = await seed();
    fakeMonitorState().issues = [issue('low', 5, { level: 'warning' })];
    await monitorIngestionService.pollConnection(s.connectionId);
    const workItemId = (await rowOf('low')).workItemId!;
    await monitorConnectionService.setMinimumLevel(
      s.fx.projectId,
      s.connectionId,
      'error',
      s.fx.ctx,
    );
    return { fx: s.fx, connectionId: s.connectionId, workItemId };
  }

  it('a live linked card gets its count, last-seen, environment and release — nothing filed, counted refreshed', async () => {
    const { fx, connectionId, workItemId } = await linkedBelowMinimum();
    const later = issue('low', 60, {
      level: 'warning',
      eventCount: 88,
      environment: 'production',
      release: '3.1.0',
    });
    fakeMonitorState().issues = [later];

    const summary = await monitorIngestionService.pollConnection(connectionId);

    expect(summary).toMatchObject({ status: 'ok', refreshed: 1, skipped: 0, filed: 0, updated: 0 });
    expect(await bugCount(fx.projectId)).toBe(1);
    const row = await rowOf('low');
    expect(row).toMatchObject({
      workItemId,
      eventCount: 88,
      environment: 'production',
      release: '3.1.0',
    });
    expect(row.lastSeenAt.toISOString()).toBe(later.lastSeenAt.toISOString());
  });

  it('the same issue linked to a DONE card is skipped and files nothing', async () => {
    const { fx, connectionId, workItemId } = await linkedBelowMinimum();
    await complete(workItemId);
    fakeMonitorState().issues = [issue('low', 60, { level: 'warning', eventCount: 88 })];

    const summary = await monitorIngestionService.pollConnection(connectionId);

    expect(summary).toMatchObject({ status: 'ok', skipped: 1, refreshed: 0, refiled: 0 });
    expect(await bugCount(fx.projectId)).toBe(1);
    expect((await rowOf('low')).eventCount).toBe(1);
  });

  it('a below-minimum issue with NO row is skipped as today, and costs no context read', async () => {
    const { fx, connectionId } = await seed();
    await monitorConnectionService.setMinimumLevel(fx.projectId, connectionId, 'error', fx.ctx);
    fakeMonitorState().issues = [issue('never', 5, { level: 'info' })];

    const summary = await monitorIngestionService.pollConnection(connectionId);

    expect(summary).toMatchObject({ status: 'ok', skipped: 1, refreshed: 0, filed: 0 });
    expect(await bugCount(fx.projectId)).toBe(0);
    expect(await adminDb.monitorIssue.count({ where: { connectionId } })).toBe(0);
    expect(fakeMonitorState().contextReads).toEqual([]);
  });

  it('a linked card DELETED since the read is not refreshed — the lock re-check decides', async () => {
    const { connectionId, workItemId } = await linkedBelowMinimum();
    await adminDb.workItem.delete({ where: { id: workItemId } });
    fakeMonitorState().issues = [issue('low', 60, { level: 'warning', eventCount: 5 })];

    const summary = await monitorIngestionService.pollConnection(connectionId);

    // The pointer is gone (ON DELETE SET NULL), so the pre-read no longer lists
    // it as linked: skipped, and never re-filed below the level.
    expect(summary).toMatchObject({ status: 'ok', skipped: 1, refreshed: 0, refiled: 0 });
    expect((await rowOf('low')).eventCount).toBe(1);
  });
});
