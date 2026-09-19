import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import type { NormalizedMonitorAssignee, NormalizedMonitorIssue } from '@/lib/monitors/types';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { monitorIngestionService } from '@/lib/services/monitorIngestionService';
import {
  assigneeKey,
  MONITOR_ASSIGNEE_REFRESH_MAX,
  monitorSyncService,
} from '@/lib/services/monitorSyncService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { captureJobEvents } from '../../helpers/jobs';
import { createTestUser, makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// ASSIGNEE FROM THE MONITOR (Story MOTIR-4931 · Subtask MOTIR-5705) — a
// provider-side assignment becomes the bug's assignee by EMAIL match, on every
// reconcile visit and through a bounded refresh of open links; a team or an
// unmatched email is a recorded no-op, and only a CHANGE on the provider side is
// ever applied.
//
// Real Postgres, the real poll, the real `updateWorkItem`; the provider is the
// fake, whose `readIssues` counts every `getIssue` — which is how "a switched-off
// connection makes zero reads" can be asserted rather than read off the code.

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

interface Seeded {
  fx: WorkItemFixture;
  connectionId: string;
  member: { id: string; email: string };
}

async function seed(): Promise<Seeded> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `Assignee ${n}`, identifier: `ASG${n}` });
  await monitorConnectionService.completeGrant(
    {
      provider: 'sentry',
      providerInstallationId: `pi-assignee-${n}`,
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
  const member = await createTestUser({ email: `ada-${n}@example.com`, name: 'Ada' });
  await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
  return { fx, connectionId: dto.id, member: { id: member.id, email: member.email } };
}

const user = (email: string | null, id = 'u1'): NormalizedMonitorAssignee => ({
  kind: 'user',
  externalId: id,
  email,
  name: 'Someone',
});
const team: NormalizedMonitorAssignee = {
  kind: 'team',
  externalId: 't1',
  email: null,
  name: 'Ops',
};

function issue(
  externalId: string,
  assignee: NormalizedMonitorAssignee | null,
  minutesAfterNow = 5,
): NormalizedMonitorIssue {
  return {
    externalId,
    title: `Error ${externalId}`,
    culprit: null,
    level: 'error',
    eventCount: 1,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(Date.now() + minutesAfterNow * 60_000),
    permalink: null,
    assignee,
  };
}

const bugOf = async (connectionId: string, externalIssueId: string) => {
  const link = await adminDb.monitorIssue.findFirstOrThrow({
    where: { connectionId, externalIssueId },
  });
  return adminDb.workItem.findUniqueOrThrow({ where: { id: link.workItemId! } });
};
const linkOf = (connectionId: string, externalIssueId: string) =>
  adminDb.monitorIssue.findFirstOrThrow({ where: { connectionId, externalIssueId } });
const assignmentEvents = () =>
  capture.events.filter(
    (e) =>
      e.name === 'work-item/field.changed' &&
      (e.data as { changedFields: string[] }).changedFields.includes('assignee'),
  );

/** The default workflow's done category — what the poll derives for a fixture. */
const doneKeys = async (_s: Seeded): Promise<Set<string>> => new Set(['done', 'cancelled']);

describe('an assignment arrives on the bug', () => {
  it('a new issue assigned to a member’s email is assigned to that member, as the binder', async () => {
    const s = await seed();
    fakeMonitorState().issues = [issue('a', user(s.member.email))];

    await monitorIngestionService.pollConnection(s.connectionId);

    const bug = await bugOf(s.connectionId, 'a');
    expect(bug.assigneeId).toBe(s.member.id);
    // Attributed to the BINDER — the identity ingestion files as.
    const events = assignmentEvents();
    expect(events).toHaveLength(1);
    expect((events[0]!.data as { actorId: string }).actorId).toBe(s.fx.ownerId);
    expect(await linkOf(s.connectionId, 'a')).toMatchObject({
      syncedAssigneeExternalId: assigneeKey(user(s.member.email)),
      assigneeSyncNote: null,
    });
  });

  it('a re-assignment WITHOUT a new event (last-seen unchanged) arrives through the refresh', async () => {
    const s = await seed();
    const quiet = issue('quiet', null);
    fakeMonitorState().issues = [quiet];
    await monitorIngestionService.pollConnection(s.connectionId);
    expect((await bugOf(s.connectionId, 'quiet')).assigneeId).toBeNull();

    // Assigned in the provider; its lastSeen does NOT move, so the watermark read
    // cannot see it.
    fakeMonitorState().issues[0]!.assignee = user(s.member.email);
    const second = await monitorIngestionService.pollConnection(s.connectionId);

    expect(second).toMatchObject({ status: 'ok', filed: 0, updated: 0 });
    expect((await bugOf(s.connectionId, 'quiet')).assigneeId).toBe(s.member.id);
    expect(fakeMonitorState().readIssues).toContain('quiet');
  });

  it('only a CHANGE is applied — re-polling unchanged writes nothing, even after a person re-assigns in Motir', async () => {
    const s = await seed();
    fakeMonitorState().issues = [issue('keep', user(s.member.email))];
    await monitorIngestionService.pollConnection(s.connectionId);
    const bug = await bugOf(s.connectionId, 'keep');
    expect(bug.assigneeId).toBe(s.member.id);

    // A person takes it over in Motir.
    await workItemsService.updateWorkItem(bug.id, { assigneeId: s.fx.ownerId }, s.fx.ctx);
    capture.events.length = 0;

    await monitorIngestionService.pollConnection(s.connectionId);
    await monitorIngestionService.pollConnection(s.connectionId);

    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: bug.id } })).assigneeId).toBe(
      s.fx.ownerId,
    );
    expect(assignmentEvents()).toHaveLength(0);
  });
});

describe('a recorded no-op, never a guess', () => {
  it('a TEAM and an UNMATCHED email leave the assignee alone and say why on the link', async () => {
    const s = await seed();
    fakeMonitorState().issues = [
      issue('team', team),
      issue('stranger', user('nobody@elsewhere.test', 'u9'), 6),
      issue('no-email', user(null, 'u8'), 7),
    ];

    await monitorIngestionService.pollConnection(s.connectionId);

    for (const id of ['team', 'stranger', 'no-email']) {
      expect((await bugOf(s.connectionId, id)).assigneeId).toBeNull();
    }
    expect(await linkOf(s.connectionId, 'team')).toMatchObject({
      syncedAssigneeExternalId: 'team:t1',
      assigneeSyncNote: 'team_assignee',
    });
    expect((await linkOf(s.connectionId, 'stranger')).assigneeSyncNote).toBe('no_matching_member');
    expect((await linkOf(s.connectionId, 'no-email')).assigneeSyncNote).toBe('no_matching_member');
  });

  it('a user who exists but is NOT a workspace member is no_matching_member', async () => {
    const s = await seed();
    const outsider = await createTestUser({ email: `outsider-${seq}@example.com`, name: 'Out' });
    fakeMonitorState().issues = [issue('outsider', user(outsider.email, 'u7'))];

    await monitorIngestionService.pollConnection(s.connectionId);

    expect((await bugOf(s.connectionId, 'outsider')).assigneeId).toBeNull();
    expect((await linkOf(s.connectionId, 'outsider')).assigneeSyncNote).toBe('no_matching_member');
  });

  it('a provider UNASSIGN leaves the Motir assignee in place', async () => {
    const s = await seed();
    fakeMonitorState().issues = [issue('unassign', user(s.member.email))];
    await monitorIngestionService.pollConnection(s.connectionId);

    fakeMonitorState().issues[0]!.assignee = null;
    await monitorIngestionService.pollConnection(s.connectionId);

    expect((await bugOf(s.connectionId, 'unassign')).assigneeId).toBe(s.member.id);
    expect((await linkOf(s.connectionId, 'unassign')).syncedAssigneeExternalId).toBeNull();
  });

  it('a DONE bug and a DELETED bug are never assigned', async () => {
    const s = await seed();
    fakeMonitorState().issues = [issue('done', null), issue('gone', null, 6)];
    await monitorIngestionService.pollConnection(s.connectionId);
    const done = await bugOf(s.connectionId, 'done');
    await adminDb.workItem.update({ where: { id: done.id }, data: { status: 'done' } });
    const gone = await bugOf(s.connectionId, 'gone');
    await adminDb.workItem.delete({ where: { id: gone.id } });

    const connection = {
      id: s.connectionId,
      projectId: s.fx.projectId,
      workspaceId: s.fx.workspaceId,
      boundByUserId: s.fx.ownerId,
    };
    const keys = await doneKeys(s);
    expect(
      await monitorSyncService.applyAssignee(connection, 'done', user(s.member.email), keys),
    ).toBe('not_assignable');
    expect(
      await monitorSyncService.applyAssignee(connection, 'gone', user(s.member.email), keys),
    ).toBe('not_assignable');
    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: done.id } })).assigneeId,
    ).toBeNull();
  });

  it('a missing binder records a NAMED failure and assigns nothing', async () => {
    const s = await seed();
    fakeMonitorState().issues = [issue('nobinder', null)];
    await monitorIngestionService.pollConnection(s.connectionId);

    const outcome = await monitorSyncService.applyAssignee(
      {
        id: s.connectionId,
        projectId: s.fx.projectId,
        workspaceId: s.fx.workspaceId,
        boundByUserId: null,
      },
      'nobinder',
      user(s.member.email),
      await doneKeys(s),
    );

    expect(outcome).toBe('binder_unavailable');
    expect((await bugOf(s.connectionId, 'nobinder')).assigneeId).toBeNull();
    const row = await adminDb.monitorConnection.findUniqueOrThrow({
      where: { id: s.connectionId },
    });
    expect(row.lastSyncError).toContain('no binder');
  });
});

describe('the switch and the bound', () => {
  it('syncAssignee OFF: ZERO getIssue calls and no assignee change', async () => {
    const s = await seed();
    await monitorConnectionService.setSyncDirections(
      s.fx.projectId,
      s.connectionId,
      { syncAssignee: false },
      s.fx.ctx,
    );
    fakeMonitorState().issues = [issue('off', user(s.member.email))];

    await monitorIngestionService.pollConnection(s.connectionId);
    fakeMonitorState().issues[0]!.assignee = user(s.member.email, 'u2');
    await monitorIngestionService.pollConnection(s.connectionId);

    expect(fakeMonitorState().readIssues).toEqual([]);
    expect((await bugOf(s.connectionId, 'off')).assigneeId).toBeNull();
    expect((await linkOf(s.connectionId, 'off')).syncedAssigneeExternalId).toBeNull();
  });

  it('the refresh visits at most MONITOR_ASSIGNEE_REFRESH_MAX links, oldest-checked first', async () => {
    const s = await seed();
    const total = MONITOR_ASSIGNEE_REFRESH_MAX + 3;
    fakeMonitorState().issues = Array.from({ length: total }, (_, i) =>
      issue(`cap-${i}`, null, 5 + i),
    );
    await monitorIngestionService.pollConnection(s.connectionId);
    // The first poll's refresh already read MAX of them; those are now the
    // NEWEST-checked, so the next refresh starts with the three it skipped.
    const firstRead = [...fakeMonitorState().readIssues];
    expect(firstRead).toHaveLength(MONITOR_ASSIGNEE_REFRESH_MAX);
    fakeMonitorState().readIssues = [];

    await monitorIngestionService.pollConnection(s.connectionId);

    const secondRead = fakeMonitorState().readIssues;
    expect(secondRead).toHaveLength(MONITOR_ASSIGNEE_REFRESH_MAX);
    const skipped = Array.from({ length: total }, (_, i) => `cap-${i}`).filter(
      (id) => !firstRead.includes(id),
    );
    expect(skipped).toHaveLength(3);
    expect(secondRead.slice(0, 3).sort()).toEqual(skipped.sort());
  });

  it('a getIssue REFUSAL on one link does not stop the rest, nor change the poll’s outcome', async () => {
    const s = await seed();
    fakeMonitorState().issues = [issue('r1', null), issue('r2', null, 6)];
    await monitorIngestionService.pollConnection(s.connectionId);
    fakeMonitorState().issues[0]!.assignee = user(s.member.email);
    fakeMonitorState().issues[1]!.assignee = user(s.member.email);
    fakeMonitorState().failNextStatus.set('getIssue', { status: 500, reason: 'flaky' });

    const summary = await monitorIngestionService.pollConnection(s.connectionId);

    expect(summary.status).toBe('ok');
    const row = await adminDb.monitorConnection.findUniqueOrThrow({
      where: { id: s.connectionId },
    });
    expect(row).toMatchObject({ lastPollStatus: 'ok', lastPollError: null });
    const assigned = [
      (await bugOf(s.connectionId, 'r1')).assigneeId,
      (await bugOf(s.connectionId, 'r2')).assigneeId,
    ].filter(Boolean);
    // One read was refused; the other still went through.
    expect(assigned).toHaveLength(1);
  });
});

describe('two simultaneous decisions about one new assignee', () => {
  it('produce exactly ONE assignee write — the loser reads the synced key under the lock', async () => {
    const s = await seed();
    fakeMonitorState().issues = [issue('race', null)];
    await monitorIngestionService.pollConnection(s.connectionId);
    const update = vi.spyOn(workItemsService, 'updateWorkItem');

    const connection = {
      id: s.connectionId,
      projectId: s.fx.projectId,
      workspaceId: s.fx.workspaceId,
      boundByUserId: s.fx.ownerId,
    };
    const keys = await doneKeys(s);
    const outcomes = await Promise.all([
      monitorSyncService.applyAssignee(connection, 'race', user(s.member.email), keys),
      monitorSyncService.applyAssignee(connection, 'race', user(s.member.email), keys),
    ]);

    expect(outcomes.sort()).toEqual(['assigned', 'unchanged']);
    expect(update).toHaveBeenCalledTimes(1);
    expect((await bugOf(s.connectionId, 'race')).assigneeId).toBe(s.member.id);
  });
});
