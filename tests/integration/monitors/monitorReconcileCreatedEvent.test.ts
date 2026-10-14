import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { NormalizedMonitorIssue } from '@/lib/monitors/types';
import { encryptToken } from '@/lib/monitors/tokenCrypto';
import {
  monitorIngestionService,
  type MonitorReconcileConnection,
} from '@/lib/services/monitorIngestionService';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture } from '../../fixtures';

// THE CREATED EVENT NEVER PRECEDES THE LINK (Bug MOTIR-8512, for MOTIR-8489).
//
// `monitor-bug-enrich/created` reads the `monitor_issue` row for the bug the
// event names, and throws `MonitorLinkNotYetVisibleError` when it is not there.
// Its retry budget (~15 s) is shorter than the outer transactions the P2028
// reports show, so a link that commits after the event dead-letters the job.
// The link is now written inside the create's own transaction, and
// `work-item/created` is emitted after that commit — so at the moment of the
// emit, a separate connection already sees the link. This file captures that
// moment: the event transport is replaced with a probe that reads the row on
// its own connection, exactly as the enrichment job's first attempt would.

const seenAtEmit = vi.hoisted(() => ({ links: [] as Array<string | null> }));

vi.mock('@/lib/jobs/sendEvent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/jobs/sendEvent')>();
  const { adminDb: probe } = await import('../../helpers/adminDb');
  return {
    ...actual,
    sendEvent: async (name: string, data: { workItemId?: string }) => {
      if (name !== 'work-item/created' || !data.workItemId) return;
      const link = await probe.monitorIssue.findFirst({ where: { workItemId: data.workItemId } });
      seenAtEmit.links.push(link?.workItemId ?? null);
    },
  };
});

beforeEach(async () => {
  await truncateAuthTables();
  seenAtEmit.links = [];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedConnection(): Promise<MonitorReconcileConnection> {
  const fx = await makeWorkItemFixture({ name: 'Rec event', identifier: 'RECEV' });
  const installation = await adminDb.monitorInstallation.create({
    data: {
      provider: 'sentry',
      installationId: 'install-rec-event',
      workspaceId: fx.workspaceId,
      accessTokenEncrypted: encryptToken('a'),
      refreshTokenEncrypted: encryptToken('r'),
      tokenExpiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
    },
  });
  const row = await adminDb.monitorConnection.create({
    data: {
      installationId: installation.id,
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
      externalProjectId: 'ext-event',
      externalProjectSlug: 'web',
      boundByUserId: fx.ownerId,
    },
  });
  return {
    id: row.id,
    projectId: fx.projectId,
    workspaceId: fx.workspaceId,
    boundByUserId: fx.ownerId,
    externalProjectSlug: 'web',
  };
}

const issue = (overrides: Partial<NormalizedMonitorIssue> = {}): NormalizedMonitorIssue => ({
  externalId: 'sentry-issue-event',
  title: 'PrismaClientKnownRequestError: Transaction already closed',
  culprit: 'lib/jobs/engine/worker.ts',
  level: 'error',
  eventCount: 3,
  firstSeenAt: new Date('2026-09-18T08:00:00.000Z'),
  lastSeenAt: new Date('2026-09-18T09:00:00.000Z'),
  permalink: 'https://sentry.example/issues/event/',
  assignee: null,
  ...overrides,
});

describe('work-item/created is emitted only once the link is visible', () => {
  it('a first filing: the enrichment trigger sees the link on its first attempt', async () => {
    const connection = await seedConnection();

    const filed = await monitorIngestionService.reconcileIssue(connection, issue());

    expect(filed.outcome).toBe('filed');
    expect(seenAtEmit.links).toEqual([filed.workItemId]);
  });

  it('a re-file: the link has already moved to the new bug when the event goes out', async () => {
    const connection = await seedConnection();
    const first = await monitorIngestionService.reconcileIssue(connection, issue());
    await adminDb.workItem.update({ where: { id: first.workItemId }, data: { status: 'done' } });

    const refiled = await monitorIngestionService.reconcileIssue(
      connection,
      issue({ lastSeenAt: new Date('2026-09-19T09:00:00.000Z') }),
    );

    expect(refiled.outcome).toBe('refiled');
    expect(seenAtEmit.links).toEqual([first.workItemId, refiled.workItemId]);
  });
});
