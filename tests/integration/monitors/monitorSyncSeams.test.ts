import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { MonitorConnectionDto } from '@/lib/dto/monitors';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { monitorIssueResolveOnTransitioned } from '@/lib/jobs/definitions/monitorIssueResolve';
import type { WorkItemTransitionedData } from '@/lib/jobs/types';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import type { NormalizedMonitorAssignee, NormalizedMonitorIssue } from '@/lib/monitors/types';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { monitorIngestionService } from '@/lib/services/monitorIngestionService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { captureJobEvents, JobTestEngine } from '../../helpers/jobs';
import { createTestUser, makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// The story's VITEST gate (Story MOTIR-4931 · Subtask MOTIR-5708) — § 2, the
// SEAMS the feature cards' own units mock, and § 3, the GUARDS coverage cannot
// see. Real services on real Postgres throughout; the error monitor is the FAKE
// provider (registered under the stored `sentry` id, not a `vi.mock`), and GitHub
// is a stubbed `fetch` only where the pull-request merge path needs a host. No
// test here can reach `*.sentry.io` — the fake opens no socket, and the stub
// below refuses that host by name.
//
// The route is driven with a stubbed session exactly as the connection-surface
// suites do: a route test has no cookie jar.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const workspaceCookie = { current: null as string | null };

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/auth');
  return { ...actual, getSession: async () => session.current };
});
vi.mock('@/lib/services/twoFactorPolicyService', async () =>
  (await import('../../helpers/noTwoFactorPolicy')).noTwoFactorPolicy(),
);
vi.mock('@/lib/workspaces', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspaces');
  return {
    ...actual,
    getWorkspaceContext: async () =>
      session.current && workspaceCookie.current
        ? { userId: session.current.user.id, workspaceId: workspaceCookie.current }
        : null,
  };
});
vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

const ONE = await import('@/app/api/projects/[key]/monitors/[connectionId]/route');

const HEAD_SHA = 'd'.repeat(40);
const sentryRequests: string[] = [];

let capture: ReturnType<typeof captureJobEvents>;

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  resetFakeMonitorProvider();
  fakeMonitorState().issues = [];
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
  session.current = null;
  workspaceCookie.current = null;
  // A GitHub host for the merge path, and a TRAP for the error monitor's.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (/(^|\.)sentry\.io/.test(new URL(url).hostname)) {
        sentryRequests.push(url);
        throw new Error(`the suite must not reach sentry.io (tried ${url})`);
      }
      if (url.includes('/check-runs')) {
        return new Response(
          JSON.stringify((init?.method ?? 'GET') === 'GET' ? { check_runs: [] } : { id: 1 }),
          { status: 200 },
        );
      }
      if (/\/pulls\/\d+$/.test(url)) {
        return new Response(JSON.stringify({ head: { sha: HEAD_SHA } }), { status: 200 });
      }
      if (url.includes('/files')) return new Response('[]', { status: 200 });
      return new Response('{}', { status: 404 });
    }),
  );
  capture = captureJobEvents();
});

afterEach(() => {
  capture.restore();
  vi.unstubAllGlobals();
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
}

async function seed(): Promise<Seeded> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `Seam ${n}`, identifier: `SEM${n}` });
  await monitorConnectionService.completeGrant(
    {
      provider: 'sentry',
      providerInstallationId: `pi-seam-${n}`,
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
  return { fx, connectionId: dto.id };
}

function issue(
  externalId: string,
  minutesAfterNow = 5,
  assignee: NormalizedMonitorAssignee | null = null,
): NormalizedMonitorIssue {
  return {
    externalId,
    title: `Error ${externalId}`,
    culprit: `lib/${externalId}.ts`,
    level: 'error',
    eventCount: 1,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(Date.now() + minutesAfterNow * 60_000),
    permalink: `https://fake.invalid/issues/${externalId}`,
    assignee,
  };
}

const bugsIn = (projectId: string) =>
  adminDb.workItem.findMany({ where: { projectId, kind: 'bug' } });
const linkOf = (connectionId: string, externalIssueId: string) =>
  adminDb.monitorIssue.findFirstOrThrow({ where: { connectionId, externalIssueId } });

/** Everything on a bug a second poll could have touched. */
async function snapshot(workItemId: string) {
  const bug = await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } });
  return {
    status: bug.status,
    updatedAt: bug.updatedAt.toISOString(),
    revisions: await adminDb.workItemRevision.count({ where: { workItemId } }),
  };
}

/** Run the resolve job for every `work-item/transitioned` the capture holds. */
async function drainTransitioned() {
  const events = capture.events.filter((e) => e.name === 'work-item/transitioned');
  capture.events.length = 0;
  for (const event of events) {
    await new JobTestEngine({
      function: monitorIssueResolveOnTransitioned,
      events: [{ name: 'work-item/transitioned', data: event.data as WorkItemTransitionedData }],
    }).execute();
  }
  return events.length;
}

function signInAs(user: { id: string; email: string; name: string | null }, workspaceId: string) {
  session.current = { user: { id: user.id, email: user.email, name: user.name ?? 'Someone' } };
  workspaceCookie.current = workspaceId;
}

function patch(fx: WorkItemFixture, connectionId: string, body: unknown) {
  return ONE.PATCH(
    new Request(
      `https://motir.test/api/projects/${fx.projectIdentifier}/monitors/${connectionId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ key: fx.projectIdentifier, connectionId }) },
  );
}

describe('§2 · THE STORY’S LOOP, end to end — file → complete → resolve → poll changes nothing', () => {
  it('ONE resolveIssue, no new work item, and the bug untouched by the second poll', async () => {
    const s = await seed();
    // Last seen just AFTER the binding (so the new-issue rule admits it) and
    // BEFORE the resolve — the real ordering. An issue "seen" in the future would
    // be a genuine recurrence to the guard, which is the clock-skew window its
    // comment documents, not the loop this test is about.
    await new Promise((resolve) => setTimeout(resolve, 5));
    fakeMonitorState().issues = [issue('loop', 0)];
    await monitorIngestionService.pollConnection(s.connectionId);
    const [bug] = await bugsIn(s.fx.projectId);

    await workItemsService.updateStatus(bug!.id, 'in_progress', s.fx.ctx);
    await workItemsService.updateStatus(bug!.id, 'done', s.fx.ctx);
    expect(await drainTransitioned()).toBe(2);
    const before = await snapshot(bug!.id);

    // The fake still serves the issue's PRE-resolve page, and the watermark is
    // rewound so the poll reads it again — the stale-page ordering.
    await adminDb.monitorConnection.update({
      where: { id: s.connectionId },
      data: { lastSeenWatermark: null },
    });
    const second = await monitorIngestionService.pollConnection(s.connectionId);

    expect(fakeMonitorState().resolvedIssues).toEqual(['loop']);
    expect(second).toMatchObject({ status: 'ok', filed: 0, refiled: 0 });
    expect(await bugsIn(s.fx.projectId)).toHaveLength(1);
    expect(await snapshot(bug!.id)).toEqual(before);
  });

  it('a REAL regression after the resolve still re-files relates_to the done bug', async () => {
    const s = await seed();
    fakeMonitorState().issues = [issue('regress')];
    await monitorIngestionService.pollConnection(s.connectionId);
    const [bug] = await bugsIn(s.fx.projectId);
    await workItemsService.updateStatus(bug!.id, 'in_progress', s.fx.ctx);
    await workItemsService.updateStatus(bug!.id, 'done', s.fx.ctx);
    await drainTransitioned();
    const before = await snapshot(bug!.id);

    // Seen AGAIN, after Motir's resolve.
    fakeMonitorState().issues = [issue('regress', 60)];
    const next = await monitorIngestionService.pollConnection(s.connectionId);

    expect(next).toMatchObject({ refiled: 1 });
    const bugs = await bugsIn(s.fx.projectId);
    expect(bugs).toHaveLength(2);
    const refiled = bugs.find((b) => b.id !== bug!.id)!;
    expect(
      await adminDb.workItemLink.count({
        where: {
          OR: [
            { fromId: refiled.id, toId: bug!.id },
            { fromId: bug!.id, toId: refiled.id },
          ],
        },
      }),
    ).toBeGreaterThan(0);
    expect((await snapshot(bug!.id)).status).toBe(before.status);
  });

  it('the BACKSTOP: a done bug whose writer emitted no event is resolved by the next poll', async () => {
    const s = await seed();
    fakeMonitorState().issues = [issue('quiet-writer')];
    await monitorIngestionService.pollConnection(s.connectionId);
    const [bug] = await bugsIn(s.fx.projectId);
    await adminDb.workItem.update({ where: { id: bug!.id }, data: { status: 'done' } });

    await monitorIngestionService.pollConnection(s.connectionId);

    expect(fakeMonitorState().resolvedIssues).toEqual(['quiet-writer']);
    expect((await linkOf(s.connectionId, 'quiet-writer')).resolveState).toBe('resolved');
  });
});

describe('§2 · THE PR-MERGE PATH — the commonest real completion', () => {
  it('merging the pull request linked to the bug resolves its issue', async () => {
    const s = await seed();
    const INSTALLATION_ID = `inst-seam-${seq}`;
    const REPO_ID = String(97_100 + seq);
    await githubInstallationService.persistInstallation({
      workspaceId: s.fx.workspaceId,
      installation: {
        installationId: INSTALLATION_ID,
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: REPO_ID,
          owner: 'moooon',
          name: 'seam',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
    const repoRow = await adminDb.githubRepo.findFirstOrThrow({ where: { repoId: REPO_ID } });
    await adminDb.projectRepo.create({
      data: {
        workspaceId: s.fx.workspaceId,
        projectId: s.fx.projectId,
        role: 'web',
        name: 'seam',
        seedSource: 'starter',
        state: 'connected',
        position: 'a0',
        githubRepoId: repoRow.id,
      },
    });
    fakeMonitorState().issues = [issue('merged')];
    await monitorIngestionService.pollConnection(s.connectionId);
    const [bug] = await bugsIn(s.fx.projectId);
    await workItemsService.updateStatus(bug!.id, 'in_progress', s.fx.ctx);

    const delivery = (action: string, merged: boolean) => ({
      action,
      installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
      repository: { id: Number(REPO_ID) },
      pull_request: {
        number: 501,
        state: merged ? 'closed' : 'open',
        merged,
        draft: false,
        title: 'fix: the error the monitor filed',
        head: { ref: 'fix/merged', sha: HEAD_SHA },
        base: { ref: 'main' },
        user: { id: 4242, type: 'User' },
        labels: [],
      },
    });
    await githubWebhookService.handleEvent('pull_request', delivery('opened', false));
    await githubPullRequestService.linkPullRequestByCoordinates(
      {
        workItemId: bug!.id,
        projectId: s.fx.projectId,
        owner: 'moooon',
        name: 'seam',
        number: 501,
        headRef: 'fix/merged',
        baseRef: 'main',
        title: 'linked by a run',
      },
      s.fx.ctx,
    );
    capture.events.length = 0;
    const merged = await githubWebhookService.handleEvent('pull_request', delivery('closed', true));

    expect(merged).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await drainTransitioned()).toBeGreaterThan(0);
    expect(fakeMonitorState().resolvedIssues).toEqual(['merged']);
  });
});

describe('§2 · ASSIGNEE, writer → consumer', () => {
  it('a fake assignment reaches the bug through the poll; the notification fires ONCE, and never again unchanged', async () => {
    const s = await seed();
    const member = await createTestUser({ email: `seam-member-${seq}@example.com`, name: 'M' });
    await workspacesService.addMember({ userId: member.id, workspaceId: s.fx.workspaceId });
    fakeMonitorState().issues = [
      issue('assigned', 5, { kind: 'user', externalId: 'u1', email: member.email, name: 'M' }),
    ];
    const assignmentEvents = () =>
      capture.events.filter(
        (e) =>
          e.name === 'work-item/field.changed' &&
          (e.data as { changedFields: string[] }).changedFields.includes('assignee'),
      );

    await monitorIngestionService.pollConnection(s.connectionId);
    const [bug] = await bugsIn(s.fx.projectId);
    expect(bug!.assigneeId).toBe(member.id);
    expect(assignmentEvents()).toHaveLength(1);

    capture.events.length = 0;
    await monitorIngestionService.pollConnection(s.connectionId);
    expect(assignmentEvents()).toHaveLength(0);
  });
});

describe('§2 · SWITCH → BEHAVIOUR, through the route', () => {
  it('PATCH resolveOnDone:false, then completing a bug resolves nothing', async () => {
    const s = await seed();
    signInAs(s.fx.owner, s.fx.workspaceId);
    fakeMonitorState().issues = [issue('off')];
    await monitorIngestionService.pollConnection(s.connectionId);
    const [bug] = await bugsIn(s.fx.projectId);

    expect((await patch(s.fx, s.connectionId, { resolveOnDone: false })).status).toBe(200);
    await workItemsService.updateStatus(bug!.id, 'in_progress', s.fx.ctx);
    await workItemsService.updateStatus(bug!.id, 'done', s.fx.ctx);
    await drainTransitioned();
    await monitorIngestionService.pollConnection(s.connectionId);

    expect(fakeMonitorState().resolvedIssues).toEqual([]);
  });

  it('PATCH syncAssignee:false, then polling calls getIssue ZERO times', async () => {
    const s = await seed();
    signInAs(s.fx.owner, s.fx.workspaceId);
    expect((await patch(s.fx, s.connectionId, { syncAssignee: false })).status).toBe(200);
    fakeMonitorState().issues = [issue('no-read')];

    await monitorIngestionService.pollConnection(s.connectionId);
    await monitorIngestionService.pollConnection(s.connectionId);

    expect(fakeMonitorState().readIssues).toEqual([]);
  });
});

describe('§2 · FAILURE → the room’s DTO', () => {
  it('a fake 500 on resolve surfaces through the view read with the bug’s key', async () => {
    const s = await seed();
    fakeMonitorState().issues = [issue('fails')];
    await monitorIngestionService.pollConnection(s.connectionId);
    const [bug] = await bugsIn(s.fx.projectId);
    fakeMonitorState().failNextStatus.set('resolveIssue', {
      status: 500,
      reason: 'Sentry is down',
    });

    await workItemsService.updateStatus(bug!.id, 'in_progress', s.fx.ctx);
    await workItemsService.updateStatus(bug!.id, 'done', s.fx.ctx);
    await drainTransitioned();

    const view = await monitorConnectionService.getView(s.fx.projectId, s.fx.ctx);
    const row = view.connections.find((c) => c.id === s.connectionId) as MonitorConnectionDto;
    expect(row).toMatchObject({
      lastSyncError: 'Sentry is down',
      lastSyncErrorWorkItemIdentifier: bug!.identifier,
    });
    expect(row.lastSyncErrorAt).not.toBeNull();
  });
});

describe('§3 · the guards coverage cannot see', () => {
  it('CROSS-TENANT: completing a bug in workspace A never touches B’s link on the same issue id', async () => {
    const a = await seed();
    const b = await seed();
    fakeMonitorState().issues = [issue('shared-id')];
    await monitorIngestionService.pollConnection(a.connectionId);
    await monitorIngestionService.pollConnection(b.connectionId);
    const [bugA] = await bugsIn(a.fx.projectId);

    await workItemsService.updateStatus(bugA!.id, 'in_progress', a.fx.ctx);
    await workItemsService.updateStatus(bugA!.id, 'done', a.fx.ctx);
    await drainTransitioned();

    const linkA = await linkOf(a.connectionId, 'shared-id');
    const linkB = await linkOf(b.connectionId, 'shared-id');
    expect(linkA.resolveState).toBe('resolved');
    expect(linkB).toMatchObject({ resolveState: null, resolveAttemptedAt: null });
    // One call, for A. B's bug is open, so B's link has nothing to resolve.
    expect(fakeMonitorState().resolvedIssues).toEqual(['shared-id']);
  });

  it('COMMIT-THEN-EFFECT: a transition whose transaction rolls back emits nothing and resolves nothing', async () => {
    const s = await seed();
    fakeMonitorState().issues = [issue('rolled-back')];
    await monitorIngestionService.pollConnection(s.connectionId);
    const [bug] = await bugsIn(s.fx.projectId);
    await workItemsService.updateStatus(bug!.id, 'in_progress', s.fx.ctx);
    capture.events.length = 0;

    await expect(
      workItemsService.updateStatus(bug!.id, 'done', s.fx.ctx, {
        inTransaction: async () => {
          throw new Error('force the transition to roll back');
        },
      }),
    ).rejects.toThrow('force the transition to roll back');

    expect(capture.events.filter((e) => e.name === 'work-item/transitioned')).toHaveLength(0);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: bug!.id } })).status).toBe(
      'in_progress',
    );
    await drainTransitioned();
    await monitorIngestionService.pollConnection(s.connectionId);
    expect(fakeMonitorState().resolvedIssues).toEqual([]);
  });

  it('NO SECRET LEAKS: the credential is in no DTO, no gone comment and no sync failure', async () => {
    const s = await seed();
    fakeMonitorState().issues = [issue('gone'), issue('refused', 6)];
    await monitorIngestionService.pollConnection(s.connectionId);
    const bugs = await bugsIn(s.fx.projectId);
    fakeMonitorState().deletedIssues.add('gone');
    fakeMonitorState().failNextStatus.set('resolveIssue', { status: 500, reason: 'nope' });
    for (const bug of bugs) {
      await workItemsService.updateStatus(bug.id, 'in_progress', s.fx.ctx);
      await workItemsService.updateStatus(bug.id, 'done', s.fx.ctx);
    }
    await drainTransitioned();

    const secrets = ['fake-access-token', 'fake-refresh-token'];
    const view = JSON.stringify(await monitorConnectionService.getView(s.fx.projectId, s.fx.ctx));
    const comments = JSON.stringify(
      await adminDb.comment.findMany({ where: { workItemId: { in: bugs.map((b) => b.id) } } }),
    );
    const stored = JSON.stringify([
      await adminDb.monitorConnection.findUniqueOrThrow({ where: { id: s.connectionId } }),
      await adminDb.monitorIssue.findMany({ where: { connectionId: s.connectionId } }),
    ]);
    expect(comments).toContain('no longer exists there');
    expect(stored).toContain('nope');
    for (const secret of secrets) {
      expect(view).not.toContain(secret);
      expect(comments).not.toContain(secret);
      expect(stored).not.toContain(secret);
    }
  });
});

describe('nothing reached sentry.io', () => {
  it('the fetch trap recorded no request across the whole file', () => {
    expect(sentryRequests).toEqual([]);
  });
});
