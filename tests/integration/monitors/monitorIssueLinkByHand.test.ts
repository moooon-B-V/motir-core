import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  MonitorConnectionNotFoundError,
  MonitorIssueAlreadyLinkedError,
  MonitorIssueGoneError,
  MonitorIssueLinkNotFoundError,
} from '@/lib/monitors/errors';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
  type FakeMonitorIssue,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { monitorIssueRepository } from '@/lib/repositories/monitorIssueRepository';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { monitorIngestionService } from '@/lib/services/monitorIngestionService';
import { monitorIssueLinkService } from '@/lib/services/monitorIssueLinkService';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { createTestProject } from '../../fixtures/projectFixtures';
import {
  card,
  memberWithPermissions,
  monitorLinkScenario,
  plantLink,
  type MonitorLinkScenario,
} from './_monitorLinkFixtures';

// LINK and UNLINK by hand (Story MOTIR-4932 · Subtask MOTIR-5731) — search the
// project's monitored projects, link an issue to an EXISTING work item, refuse an
// issue another card holds unless the move is explicit, and unlink — all under
// `work_item:edit`, all on real Postgres against the fake provider, and the
// loop with the reconciler asserted through a REAL poll.

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

/** A fake issue, last seen `minutesAfterNow` from now (after the binding, so a
 *  poll admits it), scoped to the `fake-web` project unless told otherwise. */
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
    eventCount: 12,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(Date.now() + minutesAfterNow * 60_000),
    permalink: `https://fake.invalid/issues/${externalId}`,
    assignee: null,
    externalProjectId: 'fake-web',
    ...overrides,
  };
}

const rowsOf = (externalIssueId: string) =>
  adminDb.monitorIssue.findMany({ where: { externalIssueId } });
const bugCount = (projectId: string) =>
  adminDb.workItem.count({ where: { projectId, kind: 'bug' } });

function link(s: MonitorLinkScenario, workItemId: string, externalIssueId: string, move = false) {
  return monitorIssueLinkService.linkIssue(
    workItemId,
    { connectionId: s.webConnectionId, externalIssueId, move },
    s.fx.ctx,
  );
}

describe('link', () => {
  it('creates ONE row pointing at the card, with the facts the FAKE returned — never the caller’s', async () => {
    const s = await monitorLinkScenario();
    const item = await card(s.fx);
    fakeMonitorState().issues = [
      issue('i1', 5, { eventCount: 777, environment: 'production', release: '1.4.2' }),
    ];

    const result = await link(s, item.id, 'i1');

    expect(result.outcome).toBe('linked');
    const rows = await rowsOf('i1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workItemId: item.id,
      filedWorkItemIdentifier: item.identifier,
      eventCount: 777,
      title: 'Error i1',
      environment: 'production',
      release: '1.4.2',
    });
    // The result re-reads through the section's own read.
    expect(result.links.map((l) => l.title)).toEqual(['Error i1']);
  });

  it('twice to the same card leaves ONE row and reports success both times', async () => {
    const s = await monitorLinkScenario();
    const item = await card(s.fx);
    fakeMonitorState().issues = [issue('twice', 5)];

    expect((await link(s, item.id, 'twice')).outcome).toBe('linked');
    expect((await link(s, item.id, 'twice')).outcome).toBe('already_linked_here');
    expect(await rowsOf('twice')).toHaveLength(1);
  });

  it('a GONE issue is refused and nothing is written', async () => {
    const s = await monitorLinkScenario();
    const item = await card(s.fx);
    fakeMonitorState().issues = [issue('gone', 5)];
    fakeMonitorState().deletedIssues.add('gone');

    await expect(link(s, item.id, 'gone')).rejects.toBeInstanceOf(MonitorIssueGoneError);
    expect(await rowsOf('gone')).toHaveLength(0);
  });

  it('a failed CONTEXT read still links — with no environment or release', async () => {
    const s = await monitorLinkScenario();
    const item = await card(s.fx);
    fakeMonitorState().issues = [issue('ctx', 5, { environment: 'production' })];
    fakeMonitorState().failNextStatus.set('getIssueContext', { status: 500 });

    expect((await link(s, item.id, 'ctx')).outcome).toBe('linked');
    expect((await rowsOf('ctx'))[0]).toMatchObject({ environment: null, release: null });
  });

  it('linking a row whose card was DELETED re-points it here', async () => {
    const s = await monitorLinkScenario();
    const item = await card(s.fx);
    await plantLink(s, {
      connectionId: s.webConnectionId,
      externalIssueId: 'orphan',
      workItemId: null,
      identifier: `${s.fx.projectIdentifier}-999`,
      lastSeenAt: new Date(),
    });
    fakeMonitorState().issues = [issue('orphan', 5)];

    expect((await link(s, item.id, 'orphan')).outcome).toBe('linked');
    expect((await rowsOf('orphan'))[0]).toMatchObject({
      workItemId: item.id,
      filedWorkItemIdentifier: item.identifier,
    });
  });
});

describe('an issue another card holds', () => {
  async function heldByA() {
    const s = await monitorLinkScenario();
    const a = await card(s.fx, 'Card A');
    const b = await card(s.fx, 'Card B');
    fakeMonitorState().issues = [issue('held', 5)];
    await link(s, a.id, 'held');
    // A's per-link sync record, as MOTIR-4931 would have left it.
    const resolvedAt = new Date('2026-09-10T00:00:00.000Z');
    await adminDb.monitorIssue.updateMany({
      where: { externalIssueId: 'held' },
      data: {
        resolveState: 'failed',
        resolveAttemptedAt: new Date('2026-09-11T00:00:00.000Z'),
        resolveError: 'Sentry said no',
        resolvedByMotirAt: resolvedAt,
        syncedAssigneeExternalId: 'u-7',
        assigneeSyncNote: 'no_matching_member',
      },
    });
    return { s, a, b, resolvedAt };
  }

  it('is REFUSED without move, naming the holder — and the holder’s row is byte-identical', async () => {
    const { s, a, b } = await heldByA();
    const before = await rowsOf('held');

    const refused = link(s, b.id, 'held');
    await expect(refused).rejects.toBeInstanceOf(MonitorIssueAlreadyLinkedError);
    await expect(refused).rejects.toMatchObject({ holderIdentifier: a.identifier });

    expect(await rowsOf('held')).toEqual(before);
  });

  it('is MOVED with move — re-pointed, the five sync fields cleared, resolved_by_motir_at kept', async () => {
    const { s, b, resolvedAt } = await heldByA();

    expect((await link(s, b.id, 'held', true)).outcome).toBe('moved');

    const [row] = await rowsOf('held');
    expect(row).toMatchObject({
      workItemId: b.id,
      filedWorkItemIdentifier: b.identifier,
      resolveState: null,
      resolveAttemptedAt: null,
      resolveError: null,
      syncedAssigneeExternalId: null,
      assigneeSyncNote: null,
    });
    expect(row!.resolvedByMotirAt?.toISOString()).toBe(resolvedAt.toISOString());
  });

  it('under a REAL race — two cards link one NEW issue at once — ends with one row, one winner, one refusal naming it', async () => {
    const s = await monitorLinkScenario();
    const a = await card(s.fx, 'Card A');
    const b = await card(s.fx, 'Card B');
    fakeMonitorState().issues = [issue('race', 5)];

    const results = await Promise.allSettled([link(s, a.id, 'race'), link(s, b.id, 'race')]);

    const rows = await rowsOf('race');
    expect(rows).toHaveLength(1);
    const winner = rows[0]!.workItemId === a.id ? a : b;
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(MonitorIssueAlreadyLinkedError);
    expect(reason).toMatchObject({ holderIdentifier: winner.identifier });
  });
});

describe('the loop closes for a hand-made link', () => {
  it('after linking, a poll with a higher count FILES NOTHING and updates the row', async () => {
    const s = await monitorLinkScenario();
    const item = await card(s.fx, 'Reported by a customer');
    fakeMonitorState().issues = [issue('loop', 5, { eventCount: 3 })];
    await link(s, item.id, 'loop');
    const bugsBefore = await bugCount(s.fx.projectId);

    fakeMonitorState().issues = [issue('loop', 30, { eventCount: 41 })];
    const summary = await monitorIngestionService.pollConnection(s.webConnectionId);

    expect(summary).toMatchObject({ status: 'ok', filed: 0, updated: 1 });
    expect(await bugCount(s.fx.projectId)).toBe(bugsBefore);
    expect((await rowsOf('loop'))[0]).toMatchObject({ workItemId: item.id, eventCount: 41 });
  });
});

describe('unlink', () => {
  it('deletes the row (removed: true), a second press is removed: false — and a recurrence then files a NEW bug', async () => {
    const s = await monitorLinkScenario();
    const item = await card(s.fx);
    fakeMonitorState().issues = [issue('u', 5)];
    await link(s, item.id, 'u');
    const [row] = await rowsOf('u');
    const bugsBefore = await bugCount(s.fx.projectId);

    await expect(monitorIssueLinkService.unlinkIssue(item.id, row!.id, s.fx.ctx)).resolves.toEqual({
      removed: true,
    });
    await expect(monitorIssueLinkService.unlinkIssue(item.id, row!.id, s.fx.ctx)).resolves.toEqual({
      removed: false,
    });
    expect(await rowsOf('u')).toHaveLength(0);

    fakeMonitorState().issues = [issue('u', 60)];
    const summary = await monitorIngestionService.pollConnection(s.webConnectionId);

    expect(summary).toMatchObject({ status: 'ok', filed: 1 });
    expect(await bugCount(s.fx.projectId)).toBe(bugsBefore + 1);
    const [refiled] = await rowsOf('u');
    expect(refiled!.workItemId).not.toBe(item.id);
  });

  it('addressing ANOTHER card’s row is not-found, and nothing is written', async () => {
    const s = await monitorLinkScenario();
    const a = await card(s.fx, 'Card A');
    const b = await card(s.fx, 'Card B');
    fakeMonitorState().issues = [issue('theirs', 5)];
    await link(s, a.id, 'theirs');
    const [row] = await rowsOf('theirs');

    await expect(
      monitorIssueLinkService.unlinkIssue(b.id, row!.id, s.fx.ctx),
    ).rejects.toBeInstanceOf(MonitorIssueLinkNotFoundError);
    expect((await rowsOf('theirs'))[0]!.workItemId).toBe(a.id);
  });
});

describe('the gate is work_item:edit on the card’s project', () => {
  it('an item-read-only custom role is refused on search, link and unlink', async () => {
    const s = await monitorLinkScenario();
    const item = await card(s.fx);
    fakeMonitorState().issues = [issue('g', 5)];
    await link(s, item.id, 'g');
    const [row] = await rowsOf('g');
    const reader = await memberWithPermissions(s.fx, ['project:browse'], 'reader@ex.com');

    await expect(
      monitorIssueLinkService.searchCandidates(item.id, '', reader),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      monitorIssueLinkService.linkIssue(
        item.id,
        { connectionId: s.webConnectionId, externalIssueId: 'g', move: true },
        reader,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      monitorIssueLinkService.unlinkIssue(item.id, row!.id, reader),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(fakeMonitorState().searches).toEqual([]);
    expect(await rowsOf('g')).toHaveLength(1);
  });

  it('a connection from ANOTHER project in the same workspace is not-found, and nothing is written', async () => {
    const s = await monitorLinkScenario();
    const item = await card(s.fx);
    const otherProject = await createTestProject({
      workspaceId: s.fx.workspaceId,
      actorUserId: s.fx.ownerId,
      name: 'Other',
      identifier: 'OTH',
    });
    await monitorConnectionService.completeGrant(
      {
        provider: 'sentry',
        providerInstallationId: 'pi-other-project',
        code: 'valid-code',
        projectId: otherProject.id,
      },
      s.fx.ctx,
    );
    const foreign = await monitorConnectionService.bindProject(
      otherProject.id,
      { externalProjectId: 'fake-web', externalProjectSlug: 'web' },
      s.fx.ctx,
    );
    fakeMonitorState().issues = [issue('x', 5)];

    await expect(
      monitorIssueLinkService.linkIssue(
        item.id,
        { connectionId: foreign.id, externalIssueId: 'x', move: false },
        s.fx.ctx,
      ),
    ).rejects.toBeInstanceOf(MonitorConnectionNotFoundError);
    expect(await rowsOf('x')).toHaveLength(0);
    expect(fakeMonitorState().readIssues).toEqual([]);
  });
});

describe('search', () => {
  it('across two connections, one failing: the other’s candidates plus ONE failure with the provider’s reason', async () => {
    const s = await monitorLinkScenario();
    const item = await card(s.fx);
    fakeMonitorState().issues = [
      issue('w1', 5, { title: 'TypeError in web' }),
      issue('k1', 5, { title: 'TypeError in worker', externalProjectId: 'fake-worker' }),
    ];
    fakeMonitorState().failSearchForProject.set('fake-worker', {
      status: 503,
      reason: 'Search is temporarily unavailable',
    });

    const result = await monitorIssueLinkService.searchCandidates(item.id, 'typeerror', s.fx.ctx);

    expect(result.noConnection).toBe(false);
    expect(result.candidates.map((c) => [c.externalIssueId, c.projectSlug])).toEqual([
      ['w1', 'web'],
    ]);
    expect(result.failures).toEqual([
      {
        connectionId: s.workerConnectionId,
        orgSlug: 'fake-org',
        projectSlug: 'worker',
        reason: 'Search is temporarily unavailable',
      },
    ]);
    expect(fakeMonitorState().searches).toHaveLength(2);
  });

  it('a project with no connection answers noConnection and makes no provider call', async () => {
    const s = await monitorLinkScenario();
    const item = await card(s.fx);
    await adminDb.monitorConnection.deleteMany({ where: { projectId: s.fx.projectId } });

    await expect(
      monitorIssueLinkService.searchCandidates(item.id, 'anything', s.fx.ctx),
    ).resolves.toEqual({ candidates: [], failures: [], noConnection: true, truncated: false });
    expect(fakeMonitorState().searches).toEqual([]);
  });

  it('marks each candidate unlinked, linked HERE or linked ELSEWHERE — read in ONE query', async () => {
    const s = await monitorLinkScenario();
    const here = await card(s.fx, 'Here');
    const elsewhere = await card(s.fx, 'Elsewhere');
    fakeMonitorState().issues = [
      issue('free', 3, { title: 'Crash free' }),
      issue('mine', 2, { title: 'Crash mine' }),
      issue('theirs', 1, { title: 'Crash theirs' }),
    ];
    await link(s, here.id, 'mine');
    await link(s, elsewhere.id, 'theirs');
    const holders = vi.spyOn(monitorIssueRepository, 'listHoldersForIssues');

    const result = await monitorIssueLinkService.searchCandidates(here.id, 'crash', s.fx.ctx);

    expect(holders).toHaveBeenCalledTimes(1);
    expect(
      Object.fromEntries(result.candidates.map((c) => [c.externalIssueId, c.linkedTo])),
    ).toEqual({
      free: null,
      mine: 'this',
      theirs: { identifier: elsewhere.identifier },
    });
  });
});
