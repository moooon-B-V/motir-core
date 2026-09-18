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
import { MonitorBinderUnavailableError } from '@/lib/monitors/errors';
import type { NormalizedMonitorIssue } from '@/lib/monitors/types';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import {
  monitorBugBody,
  monitorIngestionService,
  type MonitorReconcileConnection,
} from '@/lib/services/monitorIngestionService';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// THE STORY GATE'S COVERAGE TOP-UP (Story MOTIR-4929 · Subtask MOTIR-5583) —
// the arms of the ingestion surface that each card's own suite left at zero,
// found by the story's own coverage run and each given a reachability verdict
// first. Every arm below is REACHABLE, so each gets a test rather than an ignore:
// a thrown value that is not an `Error`, several failures in one pass, a grant
// that recorded no organisation, an unmapped provider failure, a binder the
// PROJECT refuses (not the workspace), and the route's own refusals.
//
// Real Postgres and the fake provider, as everywhere in this story.

const session = vi.hoisted(() => ({
  ctx: null as { userId: string; workspaceId: string } | null,
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({
  requireCompliantWorkspaceContext: async () =>
    session.ctx
      ? { ok: true, ctx: session.ctx }
      : { ok: false, response: new Response('{"code":"UNAUTHENTICATED"}', { status: 401 }) },
}));

beforeEach(async () => {
  await truncateAuthTables();
  resetFakeMonitorProvider();
  fakeMonitorState().issues = [];
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
  session.ctx = null;
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

async function bind(): Promise<{
  fx: WorkItemFixture;
  connectionId: string;
  installationId: string;
}> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `Gate ${n}`, identifier: `GAT${n}` });
  const grant = await monitorConnectionService.completeGrant(
    {
      provider: 'sentry',
      providerInstallationId: `pi-gate-${n}`,
      code: 'valid-code',
      projectId: fx.projectId,
    },
    fx.ctx,
  );
  const dto = await monitorConnectionService.bindProject(
    fx.projectId,
    { externalProjectId: `ext-gate-${n}`, externalProjectSlug: 'web' },
    fx.ctx,
  );
  return { fx, connectionId: dto.id, installationId: grant.installationId };
}

const target = (fx: WorkItemFixture, connectionId: string): MonitorReconcileConnection => ({
  id: connectionId,
  projectId: fx.projectId,
  workspaceId: fx.workspaceId,
  boundByUserId: fx.ownerId,
  externalProjectSlug: 'web',
});

function issue(
  externalId: string,
  overrides: Partial<NormalizedMonitorIssue> = {},
): NormalizedMonitorIssue {
  return {
    externalId,
    title: `Error ${externalId}`,
    culprit: `lib/${externalId}.ts`,
    level: 'error',
    eventCount: 1,
    firstSeenAt: new Date('2026-09-18T08:00:00.000Z'),
    lastSeenAt: new Date(Date.now() + 5 * 60_000),
    permalink: null,
    assignee: null,
    ...overrides,
  };
}

const connectionRow = (id: string) =>
  adminDb.monitorConnection.findUniqueOrThrow({ where: { id } });

describe('the thin body, for an issue the provider described sparsely', () => {
  it('names an unknown location and an unknown level rather than inventing either', () => {
    const body = monitorBugBody(
      issue('sparse', { culprit: null, level: null, eventCount: 1 }),
      'web',
      null,
    );
    expect(body).toContain('An unknown location · level `unknown`');
    expect(body).toContain('Seen 1 time,');
    expect(body).toContain('From monitored project `web`.');
  });
});

describe('reconcile — the refusals and failures that are not the binder’s workspace', () => {
  it('a binder the PROJECT refuses (a viewer) files nothing and names the fix', async () => {
    const { fx, connectionId } = await bind();
    const viewer = await adminDb.user.create({
      data: { name: 'Viewer', email: `viewer-gate-${Date.now()}@example.com` },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: fx.workspaceId, userId: viewer.id, role: 'member' },
    });
    await adminDb.projectMembership.create({
      data: {
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
        userId: viewer.id,
        role: 'viewer',
      },
    });
    await adminDb.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'limited' } });

    const err = await monitorIngestionService
      .reconcileIssue({ ...target(fx, connectionId), boundByUserId: viewer.id }, issue('viewer'))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MonitorBinderUnavailableError);
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId, kind: 'bug' } })).toBe(
      0,
    );
  });

  it('an UNRELATED create failure is rethrown as itself, not dressed as a binder refusal', async () => {
    const { fx, connectionId } = await bind();
    vi.spyOn(workItemsService, 'createWorkItem').mockRejectedValue(new Error('disk full'));

    await expect(
      monitorIngestionService.reconcileIssue(target(fx, connectionId), issue('disk')),
    ).rejects.toThrow('disk full');
    // The claim rolled back with it.
    expect(await adminDb.monitorIssue.count()).toBe(0);
  });

  it('a relates_to link failure that is NOT a duplicate is surfaced', async () => {
    const { fx, connectionId } = await bind();
    const first = await monitorIngestionService.reconcileIssue(
      target(fx, connectionId),
      issue('rel'),
    );
    await adminDb.workItem.update({ where: { id: first.workItemId }, data: { status: 'done' } });
    vi.spyOn(workItemsService, 'linkWorkItems').mockRejectedValue(new Error('link store down'));

    await expect(
      monitorIngestionService.reconcileIssue(target(fx, connectionId), issue('rel')),
    ).rejects.toThrow('link store down');
  });
});

describe('poll — the arms each card’s suite left at zero', () => {
  it('a grant that recorded NO organisation still lists (an empty org slug, not a crash)', async () => {
    const { fx, connectionId, installationId } = await bind();
    await adminDb.monitorInstallation.update({
      where: { id: installationId },
      data: { metadata: {} },
    });
    const seen: string[] = [];
    const recording: MonitorProvider = {
      ...fakeMonitorProvider,
      async listIssuesSince(input) {
        seen.push(input.orgSlug);
        return fakeMonitorProvider.listIssuesSince(input);
      },
    };
    registerMonitorProvider(recording, 'sentry');
    fakeMonitorState().issues = [issue('noorg')];

    expect((await monitorIngestionService.pollConnection(connectionId)).status).toBe('ok');
    expect(seen).toEqual(['']);
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId, kind: 'bug' } })).toBe(
      1,
    );
  });

  it('a listing failure that is NOT a provider refusal is thrown, for the job’s retry path', async () => {
    const { connectionId } = await bind();
    registerMonitorProvider(
      {
        ...fakeMonitorProvider,
        async listIssuesSince() {
          throw new TypeError('the response was not JSON');
        },
      },
      'sentry',
    );

    await expect(monitorIngestionService.pollConnection(connectionId)).rejects.toThrow(
      'the response was not JSON',
    );
  });

  it('two failed issues are counted in one line; a thrown non-Error is still named', async () => {
    const { connectionId } = await bind();
    fakeMonitorState().issues = [issue('a'), issue('b')];
    vi.spyOn(monitorIngestionService, 'reconcileIssue').mockRejectedValue('a bare string');

    await monitorIngestionService.pollConnection(connectionId);

    const error = (await connectionRow(connectionId)).lastPollError!;
    expect(error).toContain('was not filed: a bare string');
    expect(error).toMatch(/\(and 1 more issue\)$/);
  });

  it('three failed issues pluralise the tail', async () => {
    const { connectionId } = await bind();
    fakeMonitorState().issues = [issue('a'), issue('b'), issue('c')];
    vi.spyOn(monitorIngestionService, 'reconcileIssue').mockRejectedValue(new Error('no'));

    await monitorIngestionService.pollConnection(connectionId);

    expect((await connectionRow(connectionId)).lastPollError).toMatch(/\(and 2 more issues\)$/);
  });
});

describe('the terminal write', () => {
  it('names a thrown non-Error, and skips a connection deleted in the meantime', async () => {
    const { connectionId } = await bind();
    await monitorIngestionService.recordTerminalFailure(connectionId, 'the worker died');
    expect((await connectionRow(connectionId)).lastPollError).toBe(
      'The check stopped after repeated failures: the worker died',
    );

    await expect(
      monitorIngestionService.recordTerminalFailure('gone-connection', new Error('x')),
    ).resolves.toBeUndefined();
  });
});

describe('PATCH /api/projects/[key]/monitors/[connectionId] — its own refusals', () => {
  async function patch(fx: WorkItemFixture, connectionId: string, body: string) {
    const ONE = await import('@/app/api/projects/[key]/monitors/[connectionId]/route');
    return ONE.PATCH(
      new Request('https://motir.test/x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      { params: Promise.resolve({ key: fx.projectIdentifier, connectionId }) },
    );
  }

  it('answers the compliance gate’s own response when there is no session', async () => {
    const { fx, connectionId } = await bind();
    const res = await patch(fx, connectionId, '{"minimumLevel":"error"}');
    expect(res.status).toBe(401);
  });

  it('a body that is not JSON carries no level: 400, nothing stored', async () => {
    const { fx, connectionId } = await bind();
    session.ctx = fx.ctx;
    const res = await patch(fx, connectionId, 'not json at all');
    expect(res.status).toBe(400);
    expect((await connectionRow(connectionId)).minimumLevel).toBeNull();
  });

  it('an error the monitor mapper does not know is rethrown, never flattened into a status', async () => {
    const { fx, connectionId } = await bind();
    session.ctx = fx.ctx;
    vi.spyOn(monitorConnectionService, 'setMinimumLevel').mockRejectedValue(new Error('boom'));
    await expect(patch(fx, connectionId, '{"minimumLevel":"error"}')).rejects.toThrow('boom');
  });
});

describe('DELETE on the same route file — its two arms the connect story left at zero', () => {
  async function del(fx: WorkItemFixture, connectionId: string) {
    const ONE = await import('@/app/api/projects/[key]/monitors/[connectionId]/route');
    return ONE.DELETE(new Request('https://motir.test/x', { method: 'DELETE' }), {
      params: Promise.resolve({ key: fx.projectIdentifier, connectionId }),
    });
  }

  it('answers the compliance gate’s response with no session', async () => {
    const { fx, connectionId } = await bind();
    expect((await del(fx, connectionId)).status).toBe(401);
  });

  it('rethrows an error the monitor mapper does not know', async () => {
    const { fx, connectionId } = await bind();
    session.ctx = fx.ctx;
    vi.spyOn(monitorConnectionService, 'disconnect').mockRejectedValue(new Error('kaboom'));
    await expect(del(fx, connectionId)).rejects.toThrow('kaboom');
  });
});
