import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { monitorIssueResolveOnTransitioned } from '@/lib/jobs/definitions/monitorIssueResolve';
import { jobDefinitions } from '@/lib/jobs/registry';
import type { WorkItemTransitionedData } from '@/lib/jobs/types';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import type { NormalizedMonitorIssue } from '@/lib/monitors/types';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { monitorIngestionService } from '@/lib/services/monitorIngestionService';
import {
  MONITOR_RESOLVE_STALE_MS,
  monitorIssueGoneComment,
  monitorSyncService,
} from '@/lib/services/monitorSyncService';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { captureJobEvents, JobTestEngine } from '../../helpers/jobs';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// RESOLVE BACK (Story MOTIR-4931 · Subtask MOTIR-5703) — a bug reaching a
// done-category status resolves each linked monitor issue EXACTLY ONCE, as a job
// off `work-item/transitioned`; a refusal lands on the connection, a deleted
// issue says so on the card, and the poll's backstop sweep catches what the
// event missed.
//
// Real Postgres, the REAL status path (`workItemsService.updateStatus`) and the
// REAL job handler through `JobTestEngine`; only the provider is faked — and
// counted, which is what "calls the provider once" can only be asserted by.

let capture: ReturnType<typeof captureJobEvents>;

beforeEach(async () => {
  await truncateAuthTables();
  resetFakeMonitorProvider();
  fakeMonitorState().issues = [];
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
  capture = captureJobEvents();
});

afterEach(() => {
  capture.restore();
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

function issue(externalId: string, minutesAfterNow = 5): NormalizedMonitorIssue {
  return {
    externalId,
    title: `Error ${externalId}`,
    culprit: `lib/${externalId}.ts`,
    level: 'error',
    eventCount: 1,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(Date.now() + minutesAfterNow * 60_000),
    permalink: `https://fake.invalid/issues/${externalId}`,
    assignee: null,
  };
}

interface Seeded {
  fx: WorkItemFixture;
  connectionId: string;
}

/** A project with a grant and ONE binding made through the real service. */
async function seed(externalProjectId = 'fake-web'): Promise<Seeded> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `Resolve ${n}`, identifier: `RSV${n}` });
  await monitorConnectionService.completeGrant(
    {
      provider: 'sentry',
      providerInstallationId: `pi-resolve-${n}`,
      code: 'valid-code',
      projectId: fx.projectId,
    },
    fx.ctx,
  );
  const dto = await monitorConnectionService.bindProject(
    fx.projectId,
    { externalProjectId, externalProjectSlug: 'web' },
    fx.ctx,
  );
  return { fx, connectionId: dto.id };
}

/** File a bug from a fake issue through a real poll; returns the bug. */
async function fileBug(s: Seeded, externalId: string) {
  fakeMonitorState().issues = [...fakeMonitorState().issues, issue(externalId)];
  await monitorIngestionService.pollConnection(s.connectionId);
  const link = await adminDb.monitorIssue.findFirstOrThrow({
    where: { connectionId: s.connectionId, externalIssueId: externalId },
  });
  return adminDb.workItem.findUniqueOrThrow({ where: { id: link.workItemId! } });
}

/** Complete the bug the way a person does — through the real status path — and
 *  return the `work-item/transitioned` events it emitted. */
async function complete(s: Seeded, workItemId: string, to = 'done') {
  capture.events.length = 0;
  await workItemsService.updateStatus(workItemId, 'in_progress', s.fx.ctx);
  await workItemsService.updateStatus(workItemId, to, s.fx.ctx);
  return capture.events
    .filter((e) => e.name === 'work-item/transitioned')
    .map((e) => e.data as WorkItemTransitionedData);
}

/** Run the resolve job for ONE transitioned event. */
function runJob(data: WorkItemTransitionedData) {
  return new JobTestEngine({
    function: monitorIssueResolveOnTransitioned,
    events: [{ name: 'work-item/transitioned', data }],
  }).execute();
}

const linkOf = (connectionId: string, externalIssueId: string) =>
  adminDb.monitorIssue.findFirstOrThrow({ where: { connectionId, externalIssueId } });
const connectionRow = (id: string) =>
  adminDb.monitorConnection.findUniqueOrThrow({ where: { id } });

describe('the job is registered and consumes work-item/transitioned', () => {
  it('is in the registry under its own id, triggered by the shared event', () => {
    expect(jobDefinitions).toContain(monitorIssueResolveOnTransitioned);
  });
});

describe('completing a bug resolves its linked issue ONCE, after the commit', () => {
  it('resolves through the provider, leaving the link resolved with Motir’s timestamp', async () => {
    const s = await seed();
    const bug = await fileBug(s, 'one');

    const events = await complete(s, bug.id);
    const done = events.find((e) => e.toStatusKey === 'done')!;
    expect(done).toBeDefined();
    await runJob(done);

    expect(fakeMonitorState().resolvedIssues).toEqual(['one']);
    const link = await linkOf(s.connectionId, 'one');
    expect(link.resolveState).toBe('resolved');
    expect(link.resolvedByMotirAt).not.toBeNull();
  });

  it('a provider FAILURE leaves the bug done — the completion is never rolled back', async () => {
    const s = await seed();
    const bug = await fileBug(s, 'fails');
    fakeMonitorState().failNextStatus.set('resolveIssue', {
      status: 500,
      reason: 'Sentry is down',
    });

    const done = (await complete(s, bug.id)).find((e) => e.toStatusKey === 'done')!;
    // The status is committed BEFORE any provider call exists to fail.
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: bug.id } })).status).toBe(
      'done',
    );
    const { result } = await runJob(done);

    expect(result).toMatchObject({ failed: 1 });
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: bug.id } })).status).toBe(
      'done',
    );
    const link = await linkOf(s.connectionId, 'fails');
    expect(link).toMatchObject({ resolveState: 'failed', resolveError: 'Sentry is down' });
    const row = await connectionRow(s.connectionId);
    expect(row).toMatchObject({
      lastSyncError: 'Sentry is down',
      lastSyncErrorWorkItemIdentifier: bug.identifier,
    });
    expect(row.lastSyncErrorAt).not.toBeNull();

    // The next sweep retries it, and a success clears the connection's failure.
    await monitorSyncService.sweepConnection(s.connectionId);
    expect(await linkOf(s.connectionId, 'fails')).toMatchObject({ resolveState: 'resolved' });
    expect(await connectionRow(s.connectionId)).toMatchObject({
      lastSyncError: null,
      lastSyncErrorAt: null,
      lastSyncErrorWorkItemIdentifier: null,
    });
    // One failed call, one successful one — never a second success.
    expect(fakeMonitorState().resolvedIssues).toEqual(['fails']);
  });
});

describe('idempotency is keyed on the link’s claim', () => {
  it('the same event twice, then the sweep, records exactly ONE provider call', async () => {
    const s = await seed();
    const bug = await fileBug(s, 'twice');
    const done = (await complete(s, bug.id)).find((e) => e.toStatusKey === 'done')!;

    await runJob(done);
    await runJob(done);
    await monitorSyncService.sweepConnection(s.connectionId);

    expect(fakeMonitorState().resolvedIssues).toEqual(['twice']);
  });

  it('moving the bug out of done and back records no second call', async () => {
    const s = await seed();
    const bug = await fileBug(s, 'reopen');
    await runJob((await complete(s, bug.id)).find((e) => e.toStatusKey === 'done')!);

    capture.events.length = 0;
    await workItemsService.updateStatus(bug.id, 'in_progress', s.fx.ctx);
    await workItemsService.updateStatus(bug.id, 'done', s.fx.ctx);
    for (const event of capture.events.filter((e) => e.name === 'work-item/transitioned')) {
      await runJob(event.data as WorkItemTransitionedData);
    }

    expect(fakeMonitorState().resolvedIssues).toEqual(['reopen']);
  });
});

describe('which links resolve', () => {
  it('a bug linked from TWO connections resolves both; a switched-off connection resolves nothing', async () => {
    const s = await seed();
    const bug = await fileBug(s, 'shared');
    const second = await monitorConnectionService.bindProject(
      s.fx.projectId,
      { externalProjectId: 'fake-worker', externalProjectSlug: 'worker' },
      s.fx.ctx,
    );
    await adminDb.monitorIssue.create({
      data: {
        connectionId: second.id,
        projectId: s.fx.projectId,
        workspaceId: s.fx.workspaceId,
        externalIssueId: 'shared-2',
        title: 'the same error, seen by the worker',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        workItemId: bug.id,
        filedWorkItemIdentifier: bug.identifier,
      },
    });

    await runJob((await complete(s, bug.id)).find((e) => e.toStatusKey === 'done')!);
    expect([...fakeMonitorState().resolvedIssues].sort()).toEqual(['shared', 'shared-2']);
  });

  it('a connection with resolveOnDone OFF resolves nothing and leaves resolve_state null', async () => {
    const s = await seed();
    const bug = await fileBug(s, 'off');
    await monitorConnectionService.setSyncDirections(
      s.fx.projectId,
      s.connectionId,
      { resolveOnDone: false },
      s.fx.ctx,
    );

    await runJob((await complete(s, bug.id)).find((e) => e.toStatusKey === 'done')!);
    await monitorSyncService.sweepConnection(s.connectionId);

    expect(fakeMonitorState().resolvedIssues).toEqual([]);
    expect((await linkOf(s.connectionId, 'off')).resolveState).toBeNull();
  });

  it('a CUSTOM done-category status resolves; a non-done status resolves nothing', async () => {
    const s = await seed();
    await adminDb.workflowStatus.create({
      data: {
        workspaceId: s.fx.workspaceId,
        projectId: s.fx.projectId,
        key: 'shipped',
        label: 'Shipped',
        category: 'done',
        position: 'z9',
      },
    });
    const bug = await fileBug(s, 'custom');
    const base = {
      workspaceId: s.fx.workspaceId,
      workItemId: bug.id,
      actorId: s.fx.ownerId,
      revisionId: 'rev-x',
    };

    await runJob({ ...base, fromStatusKey: 'todo', toStatusKey: 'in_progress' });
    expect(fakeMonitorState().resolvedIssues).toEqual([]);

    await adminDb.workItem.update({ where: { id: bug.id }, data: { status: 'shipped' } });
    await runJob({ ...base, fromStatusKey: 'in_progress', toStatusKey: 'shipped' });
    expect(fakeMonitorState().resolvedIssues).toEqual(['custom']);
  });

  it('a transition on a work item no monitor filed is a no-op, before any status read', async () => {
    const s = await seed();
    const plain = await workItemsService.createWorkItem(
      { projectId: s.fx.projectId, kind: 'task', title: 'not from a monitor' },
      s.fx.ctx,
    );
    const { result } = await runJob({
      workspaceId: s.fx.workspaceId,
      workItemId: plain.id,
      actorId: s.fx.ownerId,
      fromStatusKey: 'in_progress',
      toStatusKey: 'done',
      revisionId: 'rev-plain',
    });
    expect(result).toEqual({ links: 0, resolved: 0, gone: 0, failed: 0, skipped: 0 });
  });
});

describe('a deleted issue says so ON THE CARD, once, and is never retried', () => {
  it('404 → gone, ONE comment by the binder, and a later sweep does not call again', async () => {
    const s = await seed();
    const bug = await fileBug(s, 'deleted');
    fakeMonitorState().deletedIssues.add('deleted');

    await runJob((await complete(s, bug.id)).find((e) => e.toStatusKey === 'done')!);
    await monitorSyncService.sweepConnection(s.connectionId);

    expect(await linkOf(s.connectionId, 'deleted')).toMatchObject({ resolveState: 'gone' });
    const comments = await adminDb.comment.findMany({ where: { workItemId: bug.id } });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorId: s.fx.ownerId });
    expect(comments[0]!.bodyMd).toBe(
      monitorIssueGoneComment({
        externalIssueId: 'deleted',
        permalink: 'https://fake.invalid/issues/deleted',
      }),
    );
    // ONE call — the gone one — and no retry.
    expect(fakeMonitorState().resolvedIssues).toEqual(['deleted']);
  });

  it('a missing binder leaves the link gone and records a NAMED failure instead', async () => {
    const s = await seed();
    const bug = await fileBug(s, 'orphan');
    await adminDb.monitorConnection.update({
      where: { id: s.connectionId },
      data: { boundByUserId: null },
    });
    fakeMonitorState().deletedIssues.add('orphan');

    await runJob((await complete(s, bug.id)).find((e) => e.toStatusKey === 'done')!);

    expect(await linkOf(s.connectionId, 'orphan')).toMatchObject({ resolveState: 'gone' });
    expect(await adminDb.comment.count({ where: { workItemId: bug.id } })).toBe(0);
    expect((await connectionRow(s.connectionId)).lastSyncError).toContain('no binder');
  });

  it('the permalink-less comment names the issue by its provider id', () => {
    expect(monitorIssueGoneComment({ externalIssueId: 'abc', permalink: null })).toContain('`abc`');
  });
});

describe('the backstop sweep', () => {
  it('re-claims a pending link past MONITOR_RESOLVE_STALE_MS, and not a younger one', async () => {
    const s = await seed();
    const staleBug = await fileBug(s, 'stale');
    const freshBug = await fileBug(s, 'fresh');
    await adminDb.workItem.updateMany({
      where: { id: { in: [staleBug.id, freshBug.id] } },
      data: { status: 'done' },
    });
    const now = Date.now();
    await adminDb.monitorIssue.updateMany({
      where: { externalIssueId: 'stale' },
      data: {
        resolveState: 'pending',
        resolveAttemptedAt: new Date(now - MONITOR_RESOLVE_STALE_MS - 60_000),
      },
    });
    await adminDb.monitorIssue.updateMany({
      where: { externalIssueId: 'fresh' },
      data: { resolveState: 'pending', resolveAttemptedAt: new Date(now - 60_000) },
    });

    await monitorSyncService.sweepConnection(s.connectionId);

    expect(fakeMonitorState().resolvedIssues).toEqual(['stale']);
    expect((await linkOf(s.connectionId, 'fresh')).resolveState).toBe('pending');
  });

  it('the next POLL resolves a done bug whose status writer emitted no event', async () => {
    const s = await seed();
    const bug = await fileBug(s, 'silent');
    // Written without `sendEvent` — the shape of a status writer that does not
    // announce itself.
    await adminDb.workItem.update({ where: { id: bug.id }, data: { status: 'done' } });

    const summary = await monitorIngestionService.pollConnection(s.connectionId);

    expect(summary.status).toBe('ok');
    expect(fakeMonitorState().resolvedIssues).toEqual(['silent']);
    expect((await linkOf(s.connectionId, 'silent')).resolveState).toBe('resolved');
  });

  it('a sweep that THROWS does not change the poll’s recorded ingestion outcome', async () => {
    const s = await seed();
    fakeMonitorState().issues = [issue('ok-issue')];
    vi.spyOn(monitorSyncService, 'sweepConnection').mockRejectedValueOnce(new Error('kaboom'));

    const summary = await monitorIngestionService.pollConnection(s.connectionId);

    expect(summary).toMatchObject({ status: 'ok', filed: 1 });
    const row = await connectionRow(s.connectionId);
    expect(row).toMatchObject({ lastPollStatus: 'ok', lastPollError: null });
    expect(row.lastSyncError).toContain('kaboom');
  });

  it('an UNEXPECTED error throws out of the job, leaving the claim pending for the sweep', async () => {
    const s = await seed();
    const bug = await fileBug(s, 'boom');
    vi.spyOn(fakeMonitorProvider, 'resolveIssue').mockRejectedValueOnce(new Error('not a refusal'));

    const done = (await complete(s, bug.id)).find((e) => e.toStatusKey === 'done')!;
    await expect(
      monitorSyncService.resolveLinkedIssues(done.workItemId, done.toStatusKey),
    ).rejects.toThrow('not a refusal');
    expect((await linkOf(s.connectionId, 'boom')).resolveState).toBe('pending');
  });
});
