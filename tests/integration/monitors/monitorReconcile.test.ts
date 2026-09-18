import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { MonitorBinderUnavailableError } from '@/lib/monitors/errors';
import type { NormalizedMonitorIssue } from '@/lib/monitors/types';
import { encryptToken } from '@/lib/monitors/tokenCrypto';
import {
  MONITOR_BUG_TITLE_MAX_LENGTH,
  monitorBugTitle,
  monitorIngestionService,
  type MonitorReconcileConnection,
} from '@/lib/services/monitorIngestionService';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture } from '../../fixtures';
import { seededBugsFolderId } from '../../fixtures/projectFixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// RECONCILE ONE ISSUE (Story MOTIR-4929 · Subtask MOTIR-5578) — the decision
// table, the binder's identity, the placement from the bug-destination resolver,
// and the race. Real Postgres through the REAL `bugDestinationService` and the
// REAL `workItemsService.createWorkItem`: nothing on the filing path is mocked,
// because "files exactly ONE bug where the project said" is only a claim about
// the code if the code that decides it runs.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function seedConnection(): Promise<{
  fx: WorkItemFixture;
  connection: MonitorReconcileConnection;
}> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `Rec ${n}`, identifier: `REC${n}` });
  const installation = await adminDb.monitorInstallation.create({
    data: {
      provider: 'sentry',
      installationId: `install-rec-${n}`,
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
      externalProjectId: `ext-${n}`,
      externalProjectSlug: 'web',
      boundByUserId: fx.ownerId,
    },
  });
  return {
    fx,
    connection: {
      id: row.id,
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
      boundByUserId: fx.ownerId,
      externalProjectSlug: 'web',
    },
  };
}

function issue(overrides: Partial<NormalizedMonitorIssue> = {}): NormalizedMonitorIssue {
  return {
    externalId: 'sentry-issue-1',
    title: 'TypeError: cannot read properties of undefined',
    culprit: 'app/page.tsx in render',
    level: 'error',
    eventCount: 3,
    firstSeenAt: new Date('2026-09-18T08:00:00.000Z'),
    lastSeenAt: new Date('2026-09-18T09:00:00.000Z'),
    permalink: 'https://sentry.example/issues/1/',
    assignee: null,
    ...overrides,
  };
}

const bugsIn = (projectId: string) =>
  adminDb.workItem.findMany({ where: { projectId, kind: 'bug' }, orderBy: { key: 'asc' } });

describe('a new issue files exactly ONE bug, where the project said, as the binder', () => {
  it('files into the folder the resolver returns, with the binder as reporter', async () => {
    const { fx, connection } = await seedConnection();
    const bugsFolder = await seededBugsFolderId(fx.projectId);

    const result = await monitorIngestionService.reconcileIssue(connection, issue());

    expect(result.outcome).toBe('filed');
    const bugs = await bugsIn(fx.projectId);
    expect(bugs).toHaveLength(1);
    expect(bugs[0]).toMatchObject({
      id: result.workItemId,
      identifier: result.identifier,
      folderId: bugsFolder,
      parentId: null,
      reporterId: fx.ownerId,
      title: 'TypeError: cannot read properties of undefined',
    });
    // The thin body: culprit + level, recurrence, the link back.
    expect(bugs[0]!.descriptionMd).toContain('`app/page.tsx in render`');
    expect(bugs[0]!.descriptionMd).toContain('Seen 3 times, first 2026-09-18, last 2026-09-18.');
    expect(bugs[0]!.descriptionMd).toContain('https://sentry.example/issues/1/');
    expect(bugs[0]!.descriptionMd).toContain('monitored project `web`');

    const row = await adminDb.monitorIssue.findFirstOrThrow();
    expect(row).toMatchObject({
      workItemId: result.workItemId,
      filedWorkItemIdentifier: result.identifier,
      externalIssueId: 'sentry-issue-1',
      eventCount: 3,
    });
  });

  it('files unplaced at the project ROOT when the project chose the root', async () => {
    const { fx, connection } = await seedConnection();
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { bugDestinationFolderId: null },
    });

    await monitorIngestionService.reconcileIssue(connection, issue());

    const bugs = await bugsIn(fx.projectId);
    expect(bugs).toHaveLength(1);
    expect(bugs[0]).toMatchObject({ folderId: null, parentId: null });
  });
});

describe('a KNOWN issue', () => {
  it('recurring while its bug is open updates the facts, files nothing, rewrites no body', async () => {
    const { fx, connection } = await seedConnection();
    const first = await monitorIngestionService.reconcileIssue(connection, issue());
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: first.workItemId } });

    const later = new Date('2026-09-18T11:00:00.000Z');
    const second = await monitorIngestionService.reconcileIssue(
      connection,
      issue({ eventCount: 40, lastSeenAt: later, level: 'fatal' }),
    );

    expect(second).toEqual({ ...first, outcome: 'updated' });
    expect(await bugsIn(fx.projectId)).toHaveLength(1);
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: first.workItemId } });
    expect(after.descriptionMd).toBe(before.descriptionMd);
    const row = await adminDb.monitorIssue.findFirstOrThrow();
    expect(row).toMatchObject({ eventCount: 40, level: 'fatal' });
    expect(row.lastSeenAt.toISOString()).toBe(later.toISOString());
  });

  it('recurring after its bug is DONE files a new bug relates_to the done one, never re-opening it', async () => {
    const { fx, connection } = await seedConnection();
    const first = await monitorIngestionService.reconcileIssue(connection, issue());
    await adminDb.workItem.update({ where: { id: first.workItemId }, data: { status: 'done' } });

    const second = await monitorIngestionService.reconcileIssue(
      connection,
      issue({ eventCount: 5, lastSeenAt: new Date('2026-09-19T09:00:00.000Z') }),
    );

    expect(second.outcome).toBe('refiled');
    expect(second.workItemId).not.toBe(first.workItemId);
    expect(await bugsIn(fx.projectId)).toHaveLength(2);
    // The done card is untouched.
    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: first.workItemId } })).status,
    ).toBe('done');
    const link = await adminDb.workItemLink.findFirst({
      where: { fromId: second.workItemId, toId: first.workItemId, kind: 'relates_to' },
    });
    expect(link).not.toBeNull();
    const refiled = await adminDb.workItem.findUniqueOrThrow({ where: { id: second.workItemId } });
    // The create path turns a bare key into a mention link, so assert the key
    // and the reason rather than one exact rendering of the pair.
    expect(refiled.descriptionMd).toContain(first.identifier);
    expect(refiled.descriptionMd).toMatch(/the earlier bug .+ was completed/);
    expect((await adminDb.monitorIssue.findFirstOrThrow()).workItemId).toBe(second.workItemId);
  });

  it('whose bug was DELETED files a new bug that names the deleted key', async () => {
    const { fx, connection } = await seedConnection();
    const first = await monitorIngestionService.reconcileIssue(connection, issue());
    await adminDb.workItem.delete({ where: { id: first.workItemId } });

    const second = await monitorIngestionService.reconcileIssue(connection, issue());

    expect(second.outcome).toBe('refiled');
    const bugs = await bugsIn(fx.projectId);
    expect(bugs.map((b) => b.id)).toEqual([second.workItemId]);
    expect(bugs[0]!.descriptionMd).toContain(`the earlier bug ${first.identifier} was deleted.`);
    const row = await adminDb.monitorIssue.findFirstOrThrow();
    expect(row).toMatchObject({
      workItemId: second.workItemId,
      filedWorkItemIdentifier: second.identifier,
    });
  });

  it('whose bug is ARCHIVED is still live: updated, not re-filed', async () => {
    const { fx, connection } = await seedConnection();
    const first = await monitorIngestionService.reconcileIssue(connection, issue());
    await adminDb.workItem.update({
      where: { id: first.workItemId },
      data: { archivedAt: new Date() },
    });

    const second = await monitorIngestionService.reconcileIssue(
      connection,
      issue({ eventCount: 9 }),
    );

    expect(second.outcome).toBe('updated');
    expect(await bugsIn(fx.projectId)).toHaveLength(1);
  });
});

describe('the race', () => {
  it('two SIMULTANEOUS reconciles of one new issue file ONE bug: {filed, updated}', async () => {
    const { fx, connection } = await seedConnection();

    const results = await Promise.all([
      monitorIngestionService.reconcileIssue(connection, issue()),
      monitorIngestionService.reconcileIssue(connection, issue()),
    ]);

    expect(results.map((r) => r.outcome).sort()).toEqual(['filed', 'updated']);
    expect(await bugsIn(fx.projectId)).toHaveLength(1);
    expect(results[0]!.workItemId).toBe(results[1]!.workItemId);
    expect(await adminDb.monitorIssue.count()).toBe(1);
  });
});

describe('the binder', () => {
  it('a connection with NO binder files nothing and names the fix', async () => {
    const { fx, connection } = await seedConnection();

    const err = await monitorIngestionService
      .reconcileIssue({ ...connection, boundByUserId: null }, issue())
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MonitorBinderUnavailableError);
    expect((err as MonitorBinderUnavailableError).reason).toMatch(
      /bind the monitored project again/i,
    );
    expect(await bugsIn(fx.projectId)).toHaveLength(0);
    expect(await adminDb.monitorIssue.count()).toBe(0);
  });

  it('a binder no longer in the workspace files nothing — the claim is rolled back too', async () => {
    const { fx, connection } = await seedConnection();
    const leaver = await adminDb.user.create({
      data: { name: 'Leaver', email: `leaver-${Date.now()}@example.com` },
    });

    const err = await monitorIngestionService
      .reconcileIssue({ ...connection, boundByUserId: leaver.id }, issue())
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MonitorBinderUnavailableError);
    expect((err as MonitorBinderUnavailableError).reason).toMatch(
      /Bind the monitored project again/,
    );
    expect(await bugsIn(fx.projectId)).toHaveLength(0);
    expect(await adminDb.monitorIssue.count()).toBe(0);
  });
});

describe('the title', () => {
  it('is held to the create path’s bound, and never empty', () => {
    const long = 'x'.repeat(MONITOR_BUG_TITLE_MAX_LENGTH + 50);
    expect(monitorBugTitle(long)).toHaveLength(MONITOR_BUG_TITLE_MAX_LENGTH);
    expect(monitorBugTitle(long).endsWith('…')).toBe(true);
    expect(monitorBugTitle('   ')).toBe('Untitled monitor issue');
    expect(monitorBugTitle('  short  ')).toBe('short');
  });
});
