import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { MonitorBinderUnavailableError } from '@/lib/monitors/errors';
import type { NormalizedMonitorIssue } from '@/lib/monitors/types';
import { encryptToken } from '@/lib/monitors/tokenCrypto';
import { monitorIssueRepository } from '@/lib/repositories/monitorIssueRepository';
import {
  MONITOR_BUG_TITLE_MAX_LENGTH,
  monitorBugTitle,
  monitorIngestionService,
  releaseCommitOf,
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

// ── THE LOOP GUARD (Story MOTIR-4931 · Subtask MOTIR-5704) ───────────────────
// resolve → poll must never re-file or mutate the bug. The link's resolve fields
// are set directly (through the store's shape) — this card does not need the
// resolve job to exist; the end-to-end version is the story's vitest gate.
describe('the loop guard — an issue MOTIR resolved and nobody has seen since', () => {
  const T = new Date('2026-09-18T10:00:00.000Z');

  /** File a bug for the issue, then complete it — the state a resolve follows. */
  async function doneBug() {
    const seeded = await seedConnection();
    const first = await monitorIngestionService.reconcileIssue(seeded.connection, issue());
    await adminDb.workItem.update({ where: { id: first.workItemId }, data: { status: 'done' } });
    return { ...seeded, first };
  }

  /** Everything on the done bug a reconcile could have touched. */
  async function bugSnapshot(workItemId: string) {
    const bug = await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } });
    return {
      status: bug.status,
      updatedAt: bug.updatedAt.toISOString(),
      revisions: await adminDb.workItemRevision.count({ where: { workItemId } }),
    };
  }

  it('STALE PAGE: a resolved link with lastSeen ≤ Motir’s resolve is `updated`, writes no work item', async () => {
    const { fx, first } = await doneBug();
    await adminDb.monitorIssue.updateMany({
      data: { resolveState: 'resolved', resolveAttemptedAt: T, resolvedByMotirAt: T },
    });
    const before = await bugSnapshot(first.workItemId);

    const result = await monitorIngestionService.reconcileIssue(
      (await seedAgain(fx)).connection,
      issue({ lastSeenAt: T, eventCount: 9 }),
    );

    expect(result).toEqual({ ...first, outcome: 'updated' });
    expect(await bugsIn(fx.projectId)).toHaveLength(1);
    expect(await bugSnapshot(first.workItemId)).toEqual(before);
    // Facts still move — only the work item is left alone.
    expect((await adminDb.monitorIssue.findFirstOrThrow()).eventCount).toBe(9);
  });

  it('IN FLIGHT: a pending claim with no resolvedByMotirAt yet is `updated` too', async () => {
    const { fx, first } = await doneBug();
    await adminDb.monitorIssue.updateMany({
      data: { resolveState: 'pending', resolveAttemptedAt: T, resolvedByMotirAt: null },
    });
    const before = await bugSnapshot(first.workItemId);

    const result = await monitorIngestionService.reconcileIssue(
      (await seedAgain(fx)).connection,
      issue({ lastSeenAt: new Date(T.getTime() - 60_000) }),
    );

    expect(result.outcome).toBe('updated');
    expect(await bugsIn(fx.projectId)).toHaveLength(1);
    expect(await bugSnapshot(first.workItemId)).toEqual(before);
  });

  it('a REAL recurrence — lastSeen after Motir’s resolve — still re-files relates_to the done bug', async () => {
    const { fx, first } = await doneBug();
    await adminDb.monitorIssue.updateMany({
      data: { resolveState: 'resolved', resolveAttemptedAt: T, resolvedByMotirAt: T },
    });
    const before = await bugSnapshot(first.workItemId);

    const result = await monitorIngestionService.reconcileIssue(
      (await seedAgain(fx)).connection,
      issue({ lastSeenAt: new Date(T.getTime() + 1) }),
    );

    expect(result.outcome).toBe('refiled');
    expect(result.workItemId).not.toBe(first.workItemId);
    expect(await bugsIn(fx.projectId)).toHaveLength(2);
    expect((await bugSnapshot(first.workItemId)).status).toBe(before.status);
    const link = await adminDb.workItemLink.findFirst({
      where: {
        OR: [
          { fromId: result.workItemId, toId: first.workItemId },
          { fromId: first.workItemId, toId: result.workItemId },
        ],
      },
    });
    expect(link).not.toBeNull();
  });

  it('SWITCH OFF: a done bug whose link carries no resolve attempt re-files exactly as before', async () => {
    const { fx, first } = await doneBug();
    const result = await monitorIngestionService.reconcileIssue(
      (await seedAgain(fx)).connection,
      issue({ lastSeenAt: new Date('2026-09-18T08:30:00.000Z') }),
    );
    expect(result.outcome).toBe('refiled');
    expect(result.workItemId).not.toBe(first.workItemId);
  });
});

// ── THE FIX-RELEASE GUARD (Bug MOTIR-8330) ───────────────────────────────────
// A done bug's issue sighted on a release that does not yet carry the merge that
// completed it is the old build still serving, not a regression. The answer is
// handed in the way the poll hands it (read outside the lock); the poll-level
// version, through a doubled host, is in monitorPoll.test.ts.
describe('the fix-release guard — an event from a release that predates the fix', () => {
  async function doneBug() {
    const seeded = await seedConnection();
    const first = await monitorIngestionService.reconcileIssue(seeded.connection, issue());
    await adminDb.workItem.update({ where: { id: first.workItemId }, data: { status: 'done' } });
    return { ...seeded, first };
  }

  const later = { lastSeenAt: new Date('2026-09-19T09:00:00.000Z'), eventCount: 11 };

  it('MISSING: files no work item, leaves the done bug alone, and moves the link’s facts', async () => {
    const { fx, first } = await doneBug();
    const bugBefore = await adminDb.workItem.findUniqueOrThrow({
      where: { id: first.workItemId },
    });

    const result = await monitorIngestionService.reconcileIssue(
      (await seedAgain(fx)).connection,
      issue(later),
      null,
      { workItemId: first.workItemId, release: 'abc1234', containment: 'missing' },
    );

    expect(result).toEqual({ ...first, outcome: 'updated' });
    expect(await bugsIn(fx.projectId)).toHaveLength(1);
    const bugAfter = await adminDb.workItem.findUniqueOrThrow({ where: { id: first.workItemId } });
    expect(bugAfter.status).toBe('done');
    expect(bugAfter.updatedAt).toEqual(bugBefore.updatedAt);
    const link = await adminDb.monitorIssue.findFirstOrThrow();
    expect(link).toMatchObject({ workItemId: first.workItemId, eventCount: 11 });
    expect(link.lastSeenAt.toISOString()).toBe(later.lastSeenAt.toISOString());
  });

  it('CONTAINS: re-files exactly as today, relates_to the done bug', async () => {
    const { fx, first } = await doneBug();

    const result = await monitorIngestionService.reconcileIssue(
      (await seedAgain(fx)).connection,
      issue(later),
      null,
      { workItemId: first.workItemId, release: 'abc1234', containment: 'contains' },
    );

    expect(result.outcome).toBe('refiled');
    expect(result.workItemId).not.toBe(first.workItemId);
    expect(await bugsIn(fx.projectId)).toHaveLength(2);
    const link = await adminDb.workItemLink.findFirst({
      where: {
        OR: [
          { fromId: result.workItemId, toId: first.workItemId },
          { fromId: first.workItemId, toId: result.workItemId },
        ],
      },
    });
    expect(link).not.toBeNull();
  });

  it('UNKNOWN: a host that could not place the release re-files as today', async () => {
    const { fx, first } = await doneBug();
    const result = await monitorIngestionService.reconcileIssue(
      (await seedAgain(fx)).connection,
      issue(later),
      null,
      { workItemId: first.workItemId, release: 'abc1234', containment: 'unknown' },
    );
    expect(result.outcome).toBe('refiled');
    expect(await bugsIn(fx.projectId)).toHaveLength(2);
  });

  it('an answer about a bug the link no longer names changes nothing', async () => {
    const { fx, first } = await doneBug();
    const result = await monitorIngestionService.reconcileIssue(
      (await seedAgain(fx)).connection,
      issue(later),
      null,
      { workItemId: 'some-other-bug', release: 'abc1234', containment: 'missing' },
    );
    expect(result.outcome).toBe('refiled');
    expect(result.workItemId).not.toBe(first.workItemId);
  });

  it('a LIVE bug is `updated` whatever the answer — the guard only ever holds a re-file', async () => {
    const { fx, connection } = await seedConnection();
    const first = await monitorIngestionService.reconcileIssue(connection, issue());
    const result = await monitorIngestionService.reconcileIssue(
      (await seedAgain(fx)).connection,
      issue(later),
      null,
      { workItemId: first.workItemId, release: 'abc1234', containment: 'contains' },
    );
    expect(result).toEqual({ ...first, outcome: 'updated' });
    expect(await bugsIn(fx.projectId)).toHaveLength(1);
  });
});

// ── A DUPLICATE IS NOT A COMPLETION (Bug MOTIR-8512) ─────────────────────────
// A bug a person closed as a duplicate sits in the done category, but its work
// lives on in the card it duplicates. A recurrence belongs to that card: the link
// moves there and nothing is filed — otherwise every consolidation re-arms a
// re-file per duplicate (24 cancelled duplicates → 24 new bugs, 2026-10-13).
describe('a done bug closed as a DUPLICATE', () => {
  const recurrence = { lastSeenAt: new Date('2026-09-19T09:00:00.000Z'), eventCount: 12 };

  /** File issue 1's bug and a second, live bug to consolidate it into. */
  async function consolidated() {
    const seeded = await seedConnection();
    const duplicate = await monitorIngestionService.reconcileIssue(seeded.connection, issue());
    const canonical = await monitorIngestionService.reconcileIssue(
      seeded.connection,
      issue({ externalId: 'sentry-issue-2', title: 'The tracking card' }),
    );
    return { ...seeded, duplicate, canonical };
  }

  async function markDuplicate(fx: WorkItemFixture, fromId: string, toId: string, status: string) {
    await adminDb.workItem.update({ where: { id: fromId }, data: { status } });
    await adminDb.workItemLink.create({
      data: {
        workspaceId: fx.workspaceId,
        fromId,
        toId,
        kind: 'duplicates',
        createdById: fx.ownerId,
      },
    });
  }

  const linkOf = (externalIssueId: string) =>
    adminDb.monitorIssue.findFirstOrThrow({ where: { externalIssueId } });

  it('recurring MOVES the link to the open card it duplicates and files nothing', async () => {
    const { fx, connection, duplicate, canonical } = await consolidated();
    await markDuplicate(fx, duplicate.workItemId, canonical.workItemId, 'cancelled');
    // The resolve-back already ran for the cancelled duplicate.
    await adminDb.monitorIssue.updateMany({
      where: { externalIssueId: 'sentry-issue-1' },
      data: { resolveState: 'resolved', resolveAttemptedAt: new Date('2026-09-18T10:00:00.000Z') },
    });

    const result = await monitorIngestionService.reconcileIssue(connection, issue(recurrence));

    expect(result).toEqual({
      outcome: 'updated',
      workItemId: canonical.workItemId,
      identifier: canonical.identifier,
    });
    expect(await bugsIn(fx.projectId)).toHaveLength(2);
    const link = await linkOf('sentry-issue-1');
    expect(link).toMatchObject({
      workItemId: canonical.workItemId,
      filedWorkItemIdentifier: canonical.identifier,
      eventCount: 12,
      // The resolve-back starts over for the card that now carries the issue.
      resolveState: null,
      resolveAttemptedAt: null,
    });
    // The cancelled duplicate is left exactly as the person closed it.
    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: duplicate.workItemId } })).status,
    ).toBe('cancelled');
  });

  it('follows a CHAIN of done duplicates to the live card at its end', async () => {
    const { fx, connection, duplicate, canonical } = await consolidated();
    const middle = await monitorIngestionService.reconcileIssue(
      connection,
      issue({ externalId: 'sentry-issue-3', title: 'An earlier consolidation' }),
    );
    await markDuplicate(fx, duplicate.workItemId, middle.workItemId, 'cancelled');
    await markDuplicate(fx, middle.workItemId, canonical.workItemId, 'cancelled');

    const result = await monitorIngestionService.reconcileIssue(connection, issue(recurrence));

    expect(result).toMatchObject({ outcome: 'updated', workItemId: canonical.workItemId });
    expect(await bugsIn(fx.projectId)).toHaveLength(3);
    expect((await linkOf('sentry-issue-1')).workItemId).toBe(canonical.workItemId);
  });

  it('whose target is itself DONE re-files as today, relates_to the old bug', async () => {
    const { fx, connection, duplicate, canonical } = await consolidated();
    await markDuplicate(fx, duplicate.workItemId, canonical.workItemId, 'cancelled');
    await adminDb.workItem.update({
      where: { id: canonical.workItemId },
      data: { status: 'done' },
    });

    const result = await monitorIngestionService.reconcileIssue(connection, issue(recurrence));

    expect(result.outcome).toBe('refiled');
    expect(result.workItemId).not.toBe(canonical.workItemId);
    expect(await bugsIn(fx.projectId)).toHaveLength(3);
    const relates = await adminDb.workItemLink.findFirst({
      where: { fromId: result.workItemId, toId: duplicate.workItemId, kind: 'relates_to' },
    });
    expect(relates).not.toBeNull();
    expect((await linkOf('sentry-issue-1')).workItemId).toBe(result.workItemId);
  });

  it('a duplicate CYCLE of done cards ends the walk and re-files', async () => {
    const { fx, connection, duplicate, canonical } = await consolidated();
    await markDuplicate(fx, duplicate.workItemId, canonical.workItemId, 'cancelled');
    await markDuplicate(fx, canonical.workItemId, duplicate.workItemId, 'cancelled');

    const result = await monitorIngestionService.reconcileIssue(connection, issue(recurrence));

    expect(result.outcome).toBe('refiled');
    expect(await bugsIn(fx.projectId)).toHaveLength(3);
  });
});

// ── THE BUG AND ITS LINK COMMIT TOGETHER (Bug MOTIR-8512) ────────────────────
// The create used to commit on its own while the link waited on an outer
// transaction; when that one expired (P2028) the bug stood unlinked and every
// later poll filed another. The failure is injected at the link write itself —
// the last statement of the filing — so everything before it has run.
describe('a link write that fails after the bug is created', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const expired = () =>
    new Error('Transaction API error: A commit cannot be executed on an expired transaction.');

  it('a FIRST filing rolls the bug back, and the next reconcile files exactly one', async () => {
    const { fx, connection } = await seedConnection();
    vi.spyOn(monitorIssueRepository, 'markFiled').mockRejectedValueOnce(expired());

    await expect(monitorIngestionService.reconcileIssue(connection, issue())).rejects.toThrow(
      /expired transaction/,
    );
    expect(await bugsIn(fx.projectId)).toHaveLength(0);
    expect(await adminDb.monitorIssue.count()).toBe(0);

    const retried = await monitorIngestionService.reconcileIssue(connection, issue());
    const again = await monitorIngestionService.reconcileIssue(connection, issue());

    expect(retried.outcome).toBe('filed');
    expect(again).toEqual({ ...retried, outcome: 'updated' });
    const bugs = await bugsIn(fx.projectId);
    expect(bugs.map((b) => b.id)).toEqual([retried.workItemId]);
    expect((await adminDb.monitorIssue.findFirstOrThrow()).workItemId).toBe(retried.workItemId);
  });

  it('a RE-FILE leaves the link on the done bug, and the next reconcile files exactly one', async () => {
    const { fx, connection } = await seedConnection();
    const first = await monitorIngestionService.reconcileIssue(connection, issue());
    await adminDb.workItem.update({ where: { id: first.workItemId }, data: { status: 'done' } });
    const recurred = issue({ lastSeenAt: new Date('2026-09-19T09:00:00.000Z') });
    vi.spyOn(monitorIssueRepository, 'markFiled').mockRejectedValueOnce(expired());

    await expect(monitorIngestionService.reconcileIssue(connection, recurred)).rejects.toThrow(
      /expired transaction/,
    );
    expect((await bugsIn(fx.projectId)).map((b) => b.id)).toEqual([first.workItemId]);
    expect((await adminDb.monitorIssue.findFirstOrThrow()).workItemId).toBe(first.workItemId);

    const retried = await monitorIngestionService.reconcileIssue(connection, recurred);
    const again = await monitorIngestionService.reconcileIssue(connection, recurred);

    expect(retried.outcome).toBe('refiled');
    expect(again).toEqual({ ...retried, outcome: 'updated' });
    const open = (await bugsIn(fx.projectId)).filter((b) => b.status !== 'done');
    expect(open.map((b) => b.id)).toEqual([retried.workItemId]);
    expect((await adminDb.monitorIssue.findFirstOrThrow()).workItemId).toBe(retried.workItemId);
  });
});

describe('releaseCommitOf — which releases name a commit a host can place', () => {
  it.each([
    ['abc1234', 'abc1234'],
    ['web@0123456789abcdef0123456789abcdef01234567', '0123456789abcdef0123456789abcdef01234567'],
    ['my-app@deadbeef', 'deadbeef'],
    ['2.4.1', null],
    ['web@2.4.1', null],
    ['abc12', null],
    ['', null],
    [null, null],
  ])('%s → %s', (release, expected) => {
    expect(releaseCommitOf(release)).toBe(expected);
  });
});

/** The SAME connection, re-read — the guard reads the link row, not the input. */
async function seedAgain(fx: WorkItemFixture): Promise<{ connection: MonitorReconcileConnection }> {
  const row = await adminDb.monitorConnection.findFirstOrThrow({
    where: { projectId: fx.projectId },
  });
  return {
    connection: {
      id: row.id,
      projectId: row.projectId,
      workspaceId: row.workspaceId,
      boundByUserId: row.boundByUserId,
      externalProjectSlug: row.externalProjectSlug,
    },
  };
}
