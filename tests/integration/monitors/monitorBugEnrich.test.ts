import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE BUG ENRICHMENT TRIGGER (Story MOTIR-4930 · Subtask MOTIR-5849) — a bug the
// monitor reconciler files is handed to motir-ai's `author_bug` job, from a job
// detached from the filing commit.
//
// Everything runs for real on Postgres — the reconcile that files the bug, the
// `work-item/created` event it emits (captured off the job client), the job
// function driven over that exact payload, the link row it writes — against the
// FAKE monitor provider. The one boundary faked is motir-ai: `submitJob` and the
// tenant-org lookup. `resolveProjectCodeContext` is wrapped so a test can hand it a
// repository set without establishing a real repository.

vi.mock('@/lib/ai/motirAiClient', () => ({ submitJob: vi.fn(), getJob: vi.fn() }));
vi.mock('@/lib/ai/tenantOrg', () => ({ resolveTenantOrg: vi.fn() }));
vi.mock('@/lib/ai/codeContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/codeContext')>();
  return { ...actual, resolveProjectCodeContext: vi.fn(actual.resolveProjectCodeContext) };
});

import { db } from '@/lib/db';
import { submitJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { resolveProjectCodeContext } from '@/lib/ai/codeContext';
import { MotirAiUnavailableError } from '@/lib/ai/errors';
import type { BugAuthoringContext } from '@/lib/ai/types';
import { monitorBugEnrichOnCreated } from '@/lib/jobs/definitions/monitorBugEnrich';
import type { WorkItemCreatedData } from '@/lib/jobs/types';
import { MonitorLinkNotYetVisibleError } from '@/lib/monitors/errors';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
  type FakeMonitorIssue,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { monitorBugEnrichmentService } from '@/lib/services/monitorBugEnrichmentService';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import {
  monitorIngestionService,
  type MonitorReconcileConnection,
} from '@/lib/services/monitorIngestionService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { captureJobEvents, JobTestEngine, type CapturedJobEvent } from '../../helpers/jobs';

let cap: { events: CapturedJobEvent[]; restore: () => void };

const FRAMES = [
  { filePath: 'lib/services/exportService.ts', function: 'toCsv', lineNumber: 88, inApp: true },
  { filePath: 'node_modules/csv/index.js', function: 'write', lineNumber: 3, inApp: false },
];

beforeEach(async () => {
  await truncateAuthTables();
  resetFakeMonitorProvider();
  fakeMonitorState().issues = [];
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
  vi.clearAllMocks();
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.example');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.mocked(resolveTenantOrg).mockResolvedValue({
    organizationId: 'org_1',
    isMeta: false,
    internalBilling: false,
  });
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_author_1' });
  cap = captureJobEvents();
});

afterEach(() => {
  cap.restore();
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function seed(): Promise<{ fx: WorkItemFixture; target: MonitorReconcileConnection }> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `Enrich ${n}`, identifier: `ENR${n}` });
  await monitorConnectionService.completeGrant(
    {
      provider: 'sentry',
      providerInstallationId: `pi-enrich-${n}`,
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
    target: {
      id: dto.id,
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
      boundByUserId: fx.ctx.userId,
      externalProjectSlug: 'web',
    },
  };
}

function issue(externalId: string, overrides: Partial<FakeMonitorIssue> = {}): FakeMonitorIssue {
  return {
    externalId,
    title: `TypeError in export ${externalId}`,
    culprit: 'lib/services/exportService.ts in toCsv',
    level: 'error',
    eventCount: 17,
    firstSeenAt: new Date('2026-09-20T08:00:00.000Z'),
    lastSeenAt: new Date('2026-09-21T08:00:00.000Z'),
    permalink: `https://sentry.example/issues/${externalId}/`,
    assignee: null,
    environment: 'production',
    release: '2.4.1',
    frames: FRAMES,
    ...overrides,
  };
}

/** File ONE issue through the real reconciler; return the bug and the event it emitted. */
async function file(target: MonitorReconcileConnection, externalId: string) {
  const seeded = issue(externalId);
  fakeMonitorState().issues = [seeded];
  const from = cap.events.length;
  const result = await monitorIngestionService.reconcileIssue(target, seeded, {
    environment: 'production',
    release: '2.4.1',
    frames: [],
  });
  const created = cap.events
    .slice(from)
    .filter((e) => e.name === 'work-item/created')
    .map((e) => e.data as WorkItemCreatedData);
  expect(created).toHaveLength(1);
  return { workItemId: result.workItemId!, event: created[0]! };
}

const linkOf = (externalIssueId: string) =>
  adminDb.monitorIssue.findFirstOrThrow({ where: { externalIssueId } });

function runJob(event: WorkItemCreatedData) {
  return new JobTestEngine({
    function: monitorBugEnrichOnCreated,
    events: [{ name: 'work-item/created', data: event }],
  }).execute();
}

function capturedEnvelope(): { context: { bugAuthoring: BugAuthoringContext; code?: unknown } } {
  const call = vi.mocked(submitJob).mock.calls[0]!;
  return { context: call[2] as { bugAuthoring: BugAuthoringContext; code?: unknown } };
}

describe('a monitor-filed bug is dispatched ONCE', () => {
  it('the reconciler’s create stamps its provenance on work-item/created; a hand-filed bug’s does not', async () => {
    const { fx, target } = await seed();
    const { event } = await file(target, 'prov-1');
    expect(event.viaMonitorConnectionId).toBe(target.id);
    expect(event.actorId).toBe(fx.ctx.userId);

    const from = cap.events.length;
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'bug', title: 'Filed by a person' },
      fx.ctx,
    );
    const hand = cap.events.slice(from).find((e) => e.name === 'work-item/created')!;
    expect((hand.data as WorkItemCreatedData).viaMonitorConnectionId).toBeUndefined();
  });

  it('exactly one author_bug job, its id written to monitor_issue.authoringJobId', async () => {
    const { target } = await seed();
    const { event } = await file(target, 'one-1');
    expect((await linkOf('one-1')).authoringJobId).toBeNull();

    await runJob(event);

    expect(submitJob).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitJob).mock.calls[0]![0]).toBe('author_bug');
    expect((await linkOf('one-1')).authoringJobId).toBe('job_author_1');
  });

  it('the envelope carries every fact, field by field — the link’s facts, ONE latest-event read, the slug and the repository set', async () => {
    const { fx, target } = await seed();
    const repoSet = { repos: [{ provider: 'github', repoRef: 'acme/web', defaultBranch: 'main' }] };
    vi.mocked(resolveProjectCodeContext).mockResolvedValueOnce(repoSet as never);
    const { event } = await file(target, 'env-1');
    fakeMonitorState().contextReads = [];

    await runJob(event);

    const { context } = capturedEnvelope();
    expect(context.bugAuthoring).toEqual({
      issue: {
        title: 'TypeError in export env-1',
        culprit: 'lib/services/exportService.ts in toCsv',
        level: 'error',
        eventCount: 17,
        firstSeenAt: '2026-09-20T08:00:00.000Z',
        lastSeenAt: '2026-09-21T08:00:00.000Z',
        permalink: 'https://sentry.example/issues/env-1/',
      },
      environment: 'production',
      release: '2.4.1',
      frames: FRAMES,
      monitoredProjectSlug: 'web',
    });
    expect(fakeMonitorState().contextReads).toEqual(['env-1']);
    expect(context.code).toEqual(repoSet);
    expect(resolveProjectCodeContext).toHaveBeenCalledWith({
      userId: fx.ctx.userId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
  });

  it('a project with no repository set sends NO code hole — the absence motir-ai reads as no_repos', async () => {
    const { target } = await seed();
    const { event } = await file(target, 'norepo-1');
    await runJob(event);
    expect(capturedEnvelope().context).not.toHaveProperty('code');
  });

  it('submits AS THE BINDER — not the system principal, not a default reporter', async () => {
    const { fx, target } = await seed();
    const { event } = await file(target, 'binder-1');
    await runJob(event);
    expect(vi.mocked(submitJob).mock.calls[0]![3]).toEqual({ userId: fx.ctx.userId });
    expect(resolveTenantOrg).toHaveBeenCalledWith({
      userId: fx.ctx.userId,
      workspaceId: fx.workspaceId,
    });
  });

  it('observes a COMMITTED bug — the item the step reads is present, with its thin body', async () => {
    const { target } = await seed();
    const { workItemId, event } = await file(target, 'commit-1');
    let seenInsideTheStep: string | null = null;
    vi.mocked(submitJob).mockImplementationOnce(async () => {
      const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
      seenInsideTheStep = row?.id ?? null;
      return { jobId: 'job_commit' };
    });
    await runJob(event);
    expect(seenInsideTheStep).toBe(workItemId);
  });
});

describe('IDEMPOTENT on the link row', () => {
  it('replaying the same event dispatches nothing the second time, and the recorded job id is unchanged', async () => {
    const { target } = await seed();
    const { event } = await file(target, 'replay-1');

    await runJob(event);
    vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_SECOND' });
    const second = await monitorBugEnrichmentService.dispatchEnrichment(event);

    expect(second).toEqual({ dispatched: false, reason: 'already-dispatched' });
    expect(submitJob).toHaveBeenCalledTimes(1);
    expect((await linkOf('replay-1')).authoringJobId).toBe('job_author_1');
  });
});

describe('not-a-candidate outcomes are VALUES, and leave the tree untouched', () => {
  it('motir-ai unconfigured', async () => {
    const { target } = await seed();
    const { event } = await file(target, 'unconf-1');
    vi.stubEnv('MOTIR_AI_URL', '');
    await expect(monitorBugEnrichmentService.dispatchEnrichment(event)).resolves.toEqual({
      dispatched: false,
      reason: 'ai-not-configured',
    });
    expect(submitJob).not.toHaveBeenCalled();
    expect((await linkOf('unconf-1')).authoringJobId).toBeNull();
  });

  it('the created item is not a bug', async () => {
    const { fx } = await seed();
    const from = cap.events.length;
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'A story' },
      fx.ctx,
    );
    const event = cap.events.slice(from).find((e) => e.name === 'work-item/created')!
      .data as WorkItemCreatedData;
    await expect(monitorBugEnrichmentService.dispatchEnrichment(event)).resolves.toEqual({
      dispatched: false,
      reason: 'not-a-bug',
    });
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('no monitor link points at it — a bug filed by hand', async () => {
    const { fx } = await seed();
    const from = cap.events.length;
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'bug', title: 'Filed by a person' },
      fx.ctx,
    );
    const event = cap.events.slice(from).find((e) => e.name === 'work-item/created')!
      .data as WorkItemCreatedData;
    await expect(monitorBugEnrichmentService.dispatchEnrichment(event)).resolves.toEqual({
      dispatched: false,
      reason: 'no-monitor-link',
    });
    expect(submitJob).not.toHaveBeenCalled();
    expect(await adminDb.monitorIssue.count()).toBe(0);
  });

  it('the row already carries an authoringJobId', async () => {
    const { target } = await seed();
    const { event } = await file(target, 'taken-1');
    await adminDb.monitorIssue.updateMany({
      where: { externalIssueId: 'taken-1' },
      data: { authoringJobId: 'job_earlier' },
    });
    await expect(monitorBugEnrichmentService.dispatchEnrichment(event)).resolves.toEqual({
      dispatched: false,
      reason: 'already-dispatched',
    });
    expect(submitJob).not.toHaveBeenCalled();
    expect((await linkOf('taken-1')).authoringJobId).toBe('job_earlier');
  });

  it('a binding with no binder has no identity to submit as', async () => {
    const { target } = await seed();
    const { event } = await file(target, 'nobinder-1');
    await adminDb.monitorConnection.update({
      where: { id: target.id },
      data: { boundByUserId: null },
    });
    await expect(monitorBugEnrichmentService.dispatchEnrichment(event)).resolves.toEqual({
      dispatched: false,
      reason: 'no-binder',
    });
    expect(submitJob).not.toHaveBeenCalled();
  });
});

describe('the FILING stands whatever the enrichment does', () => {
  it('a dispatch that THROWS leaves the reconciled bug present, thin body intact', async () => {
    const { target } = await seed();
    const { workItemId, event } = await file(target, 'throw-1');
    const bodyBefore = (await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } }))
      .descriptionMd;
    vi.mocked(submitJob).mockRejectedValueOnce(new MotirAiUnavailableError('motir-ai is down'));

    // A transport failure THROWS, so the idempotent retry budget absorbs it.
    await expect(monitorBugEnrichmentService.dispatchEnrichment(event)).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );

    const bug = await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } });
    expect(bug.kind).toBe('bug');
    expect(bug.descriptionMd).toBe(bodyBefore);
    expect(bodyBefore).toBeTruthy();
    // Nothing recorded — so the retry dispatches.
    expect((await linkOf('throw-1')).authoringJobId).toBeNull();
    await expect(monitorBugEnrichmentService.dispatchEnrichment(event)).resolves.toMatchObject({
      dispatched: true,
    });
  });

  it('a latest-event read that FAILS still dispatches, with frames: [] and the stored facts', async () => {
    const { target } = await seed();
    const { event } = await file(target, 'degrade-1');
    fakeMonitorState().failNextStatus.set('getIssueContext', { status: 500, reason: 'down' });

    const outcome = await monitorBugEnrichmentService.dispatchEnrichment(event);

    expect(outcome).toEqual({ dispatched: true, jobId: 'job_author_1', framesRead: false });
    const { context } = capturedEnvelope();
    expect(context.bugAuthoring.frames).toEqual([]);
    // The link's stored environment / release stand in for the unread event.
    expect(context.bugAuthoring.environment).toBe('production');
    expect(context.bugAuthoring.release).toBe('2.4.1');
  });

  it('a provenance-stamped bug whose link is not visible yet THROWS, so the retry waits for it', async () => {
    const { fx, target } = await seed();
    const from = cap.events.length;
    // The ordering window, made deterministic: a committed bug, a stamped event,
    // and no link pointing at it.
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'bug', title: 'Link not committed yet' },
      { ...fx.ctx, viaMonitorConnectionId: target.id },
    );
    const event = cap.events.slice(from).find((e) => e.name === 'work-item/created')!
      .data as WorkItemCreatedData;
    expect(event.viaMonitorConnectionId).toBe(target.id);

    await expect(monitorBugEnrichmentService.dispatchEnrichment(event)).rejects.toBeInstanceOf(
      MonitorLinkNotYetVisibleError,
    );
    expect(submitJob).not.toHaveBeenCalled();
  });
});
