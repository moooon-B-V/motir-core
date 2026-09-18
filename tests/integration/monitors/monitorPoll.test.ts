import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { MonitorProvider } from '@/lib/monitors/provider';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import type { NormalizedMonitorIssue } from '@/lib/monitors/types';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import {
  MONITOR_POLL_MAX_PAGES,
  monitorIngestionService,
} from '@/lib/services/monitorIngestionService';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// POLL ONE CONNECTION (Story MOTIR-4929 · Subtask MOTIR-5580) — a fresh
// credential, every page since the watermark, the minimum-level filter, the
// compare-and-set advance, `degraded` on a refused credential, and the outcome
// written on the connection.
//
// Against the FAKE provider (registered under the stored `sentry` discriminator,
// the same runtime switch the E2E uses — not a `vi.mock`) and real Postgres.
// Recurrence is asserted with a REAL second poll, never by reading code.

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
  installationId: string;
}> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `Poll ${n}`, identifier: `POL${n}` });
  const grant = await monitorConnectionService.completeGrant(
    {
      provider: 'sentry',
      providerInstallationId: `pi-poll-${n}`,
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
  return { fx, connectionId: dto.id, installationId: grant.installationId };
}

/** An issue last seen `minutesAfterNow` minutes from now — i.e. AFTER the
 *  binding was made, so the new-issue rule admits it. */
function issue(
  externalId: string,
  minutesAfterNow: number,
  overrides: Partial<NormalizedMonitorIssue> = {},
): NormalizedMonitorIssue {
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

const connectionRow = (id: string) =>
  adminDb.monitorConnection.findUniqueOrThrow({ where: { id } });
const bugCount = (projectId: string) =>
  adminDb.workItem.count({ where: { projectId, kind: 'bug' } });

describe('a pass files what is new, advances, and records it', () => {
  it('files two bugs, advances to the later lastSeen, records ok/2 — then a quiet pass files nothing', async () => {
    const { fx, connectionId } = await seed();
    const a = issue('a', 5);
    const b = issue('b', 10);
    fakeMonitorState().issues = [a, b];

    const first = await monitorIngestionService.pollConnection(connectionId);

    expect(first).toMatchObject({ status: 'ok', filed: 2, updated: 0, refiled: 0, skipped: 0 });
    expect(await bugCount(fx.projectId)).toBe(2);
    let row = await connectionRow(connectionId);
    expect(row.lastSeenWatermark?.toISOString()).toBe(b.lastSeenAt.toISOString());
    expect(row).toMatchObject({ lastPollStatus: 'ok', lastPollError: null, lastPollFiledCount: 2 });
    expect(row.lastPollSucceededAt).not.toBeNull();

    const second = await monitorIngestionService.pollConnection(connectionId);
    expect(second).toMatchObject({ status: 'ok', filed: 0, updated: 0 });
    expect(await bugCount(fx.projectId)).toBe(2);
    row = await connectionRow(connectionId);
    expect(row).toMatchObject({ lastPollStatus: 'ok', lastPollFiledCount: 0 });
  });

  it('a RECURRENCE after a pass is `updated` on the next pass — no second bug (a real second poll)', async () => {
    const { fx, connectionId } = await seed();
    fakeMonitorState().issues = [issue('r', 5)];
    await monitorIngestionService.pollConnection(connectionId);

    // The same provider issue, seen again later and more often.
    fakeMonitorState().issues = [issue('r', 30, { eventCount: 17 })];
    const next = await monitorIngestionService.pollConnection(connectionId);

    expect(next).toMatchObject({ status: 'ok', filed: 0, updated: 1 });
    expect(await bugCount(fx.projectId)).toBe(1);
    expect((await adminDb.monitorIssue.findFirstOrThrow()).eventCount).toBe(17);
  });

  it('writes the grant’s health `connected` — a working poll IS the health signal', async () => {
    const { connectionId, installationId } = await seed();
    await adminDb.monitorInstallation.update({
      where: { id: installationId },
      data: { health: 'degraded', healthReason: 'stale', healthCheckedAt: new Date(0) },
    });

    await monitorIngestionService.pollConnection(connectionId);

    const grant = await adminDb.monitorInstallation.findUniqueOrThrow({
      where: { id: installationId },
    });
    expect(grant).toMatchObject({ health: 'connected', healthReason: null });
    expect(grant.healthCheckedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe('the minimum level', () => {
  it('skips a `warning` under `error`; after a lowering rewinds, the next pass files it', async () => {
    const { fx, connectionId } = await seed();
    await monitorConnectionService.setMinimumLevel(fx.projectId, connectionId, 'error', fx.ctx);
    fakeMonitorState().issues = [issue('w', 5, { level: 'warning' })];

    const filtered = await monitorIngestionService.pollConnection(connectionId);
    expect(filtered).toMatchObject({ status: 'ok', filed: 0, skipped: 1 });
    expect(await bugCount(fx.projectId)).toBe(0);
    // The skipped issue was READ, so the watermark moved past it…
    expect((await connectionRow(connectionId)).lastSeenWatermark).not.toBeNull();

    // …and lowering is what brings it back.
    await monitorConnectionService.setMinimumLevel(fx.projectId, connectionId, null, fx.ctx);
    expect((await connectionRow(connectionId)).lastSeenWatermark).toBeNull();
    const refilled = await monitorIngestionService.pollConnection(connectionId);
    expect(refilled).toMatchObject({ status: 'ok', filed: 1, skipped: 0 });
    expect(await bugCount(fx.projectId)).toBe(1);
  });
});

describe('paging', () => {
  it('reconciles ALL of three issues in one pass at pageSize 1', async () => {
    const { fx, connectionId } = await seed();
    fakeMonitorState().pageSize = 1;
    fakeMonitorState().issues = [issue('p1', 3), issue('p2', 6), issue('p3', 9)];

    const summary = await monitorIngestionService.pollConnection(connectionId);

    expect(summary).toMatchObject({ status: 'ok', filed: 3, pages: 3 });
    expect(await bugCount(fx.projectId)).toBe(3);
  });

  it('stops at the page CAP, says so, files nothing and leaves the watermark alone', async () => {
    const { fx, connectionId } = await seed();
    fakeMonitorState().pageSize = 1;
    fakeMonitorState().issues = Array.from({ length: MONITOR_POLL_MAX_PAGES + 1 }, (_, i) =>
      issue(`cap-${i}`, i + 1),
    );

    const summary = await monitorIngestionService.pollConnection(connectionId);

    expect(summary).toMatchObject({ status: 'failed', filed: 0, pages: MONITOR_POLL_MAX_PAGES });
    expect(await bugCount(fx.projectId)).toBe(0);
    const row = await connectionRow(connectionId);
    expect(row.lastPollStatus).toBe('failed');
    expect(row.lastPollError).toMatch(/^More than \d+ issues/);
    expect(row.lastSeenWatermark).toBeNull();
  });
});

describe('a provider refusal is RECORDED, not thrown', () => {
  it('a 401 then a failed refresh: the grant reads degraded, the connection records the reason, no throw', async () => {
    const { connectionId, installationId } = await seed();
    fakeMonitorState().issues = [issue('x', 5)];
    fakeMonitorState().failNext.add('listIssuesSince');
    fakeMonitorState().failNext.add('refreshCredential');

    const summary = await monitorIngestionService.pollConnection(connectionId);

    expect(summary.status).toBe('failed');
    const grant = await adminDb.monitorInstallation.findUniqueOrThrow({
      where: { id: installationId },
    });
    expect(grant).toMatchObject({
      health: 'degraded',
      healthReason: 'The authorization has been revoked.',
    });
    expect(await connectionRow(connectionId)).toMatchObject({
      lastPollStatus: 'failed',
      lastPollError: 'The authorization has been revoked.',
    });
  });

  it('a NON-401 failure (500) records failed with the reason and writes no degraded', async () => {
    const { connectionId, installationId } = await seed();
    fakeMonitorState().failNextStatus.set('listIssuesSince', {
      status: 500,
      reason: 'Internal Error',
    });

    const summary = await monitorIngestionService.pollConnection(connectionId);

    expect(summary.status).toBe('failed');
    expect(await connectionRow(connectionId)).toMatchObject({
      lastPollStatus: 'failed',
      lastPollError: 'Internal Error',
    });
    expect(
      (await adminDb.monitorInstallation.findUniqueOrThrow({ where: { id: installationId } }))
        .health,
    ).toBe('connected');
  });
});

describe('one failing issue does not stop the others', () => {
  it('reconciles the rest, leaves the watermark, and names the failed issue', async () => {
    const { fx, connectionId } = await seed();
    fakeMonitorState().issues = [issue('ok-1', 3), issue('broken', 6), issue('ok-2', 9)];
    const real = monitorIngestionService.reconcileIssue.bind(monitorIngestionService);
    vi.spyOn(monitorIngestionService, 'reconcileIssue').mockImplementation(async (c, i) => {
      if (i.externalId === 'broken') throw new Error('the database said no');
      return real(c, i);
    });

    const summary = await monitorIngestionService.pollConnection(connectionId);

    expect(summary).toMatchObject({ status: 'failed', filed: 2 });
    expect(await bugCount(fx.projectId)).toBe(2);
    const row = await connectionRow(connectionId);
    expect(row.lastSeenWatermark).toBeNull();
    expect(row.lastPollStatus).toBe('failed');
    expect(row.lastPollError).toContain('broken');
    expect(row.lastPollError).toContain('the database said no');
  });

  it('a binder who can no longer file is named on the row in words that say what to do', async () => {
    const { fx, connectionId } = await seed();
    await adminDb.monitorConnection.update({
      where: { id: connectionId },
      data: { boundByUserId: null },
    });
    fakeMonitorState().issues = [issue('orphan', 5)];

    const summary = await monitorIngestionService.pollConnection(connectionId);

    expect(summary.status).toBe('failed');
    expect(await bugCount(fx.projectId)).toBe(0);
    expect((await connectionRow(connectionId)).lastPollError).toMatch(
      /bind the monitored project again/i,
    );
  });
});

describe('a lowering that lands MID-POLL is not undone by the poll finishing', () => {
  it('the advance returns applied: false and the watermark stays null', async () => {
    const { fx, connectionId } = await seed();
    const before = new Date(Date.now() - 60_000);
    await adminDb.monitorConnection.update({
      where: { id: connectionId },
      data: { minimumLevel: 'error', lastSeenWatermark: before },
    });
    fakeMonitorState().issues = [issue('mid', 5)];

    // A provider whose listing COMMITS a lowering before it answers — i.e.
    // between the poll's read of the level and its advance. A real interleaving
    // on real Postgres, not a mocked repository.
    const lowering: MonitorProvider = {
      ...fakeMonitorProvider,
      async listIssuesSince(input) {
        await monitorConnectionService.setMinimumLevel(fx.projectId, connectionId, null, fx.ctx);
        return fakeMonitorProvider.listIssuesSince(input);
      },
    };
    registerMonitorProvider(lowering, 'sentry');

    const summary = await monitorIngestionService.pollConnection(connectionId);

    expect(summary.status).toBe('ok');
    const row = await connectionRow(connectionId);
    expect(row.minimumLevel).toBeNull();
    // The rewind survived: the poll's compare-and-set saw a different level.
    expect(row.lastSeenWatermark).toBeNull();
  });
});

describe('the poll never PROBES', () => {
  it('its service file does not reference probeHealth', () => {
    const src = readFileSync(
      join(process.cwd(), 'lib', 'services', 'monitorIngestionService.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/probeHealth\s*\(/);
  });

  it('a deleted connection is a no-op, not a throw', async () => {
    const summary = await monitorIngestionService.pollConnection('no-such-connection');
    expect(summary).toMatchObject({ status: 'ok', pages: 0 });
  });
});
