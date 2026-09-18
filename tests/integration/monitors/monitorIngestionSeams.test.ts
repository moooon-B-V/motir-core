import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobQueueRun } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { monitorIssueReconcileTick } from '@/lib/jobs/definitions/monitorIssueReconcile';
import { executeWithLedger, recordEngineTerminalFailure } from '@/lib/jobs/engine/ledger';
import { JobWorker } from '@/lib/jobs/engine/worker';
import type { MonitorProvider } from '@/lib/monitors/provider';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { MonitorProviderCallError } from '@/lib/monitors/errors';
import { encryptToken } from '@/lib/monitors/tokenCrypto';
import type { NormalizedMonitorIssue } from '@/lib/monitors/types';
import { bugDestinationService } from '@/lib/services/bugDestinationService';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { monitorIngestionService } from '@/lib/services/monitorIngestionService';
import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';
import { JobTestEngine } from '../../helpers/jobs';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// THE STORY'S VITEST GATE — THE WRITER → CONSUMER SEAMS (Story MOTIR-4929 ·
// Subtask MOTIR-5583). Each card's own suite mocks the half it does not own;
// these run the halves TOGETHER, on real Postgres, through the fake provider,
// with every Motir layer real:
//
//   1. tick → dispatcher → worker → poll → reconcile → the destination folder;
//   2. the same tick twice: nothing new, and the recurrence lands on the row;
//   3. two connections, one revoked credential: the healthy one still files;
//   4. the ROUTE → the next poll: a lowering through the real PATCH handler;
//   5. the terminal failure: on the connection AND in the dead-letter table;
//   6. the done-bug recurrence: a second bug `relates_to` the first.
//
// The TICK is driven through the engine's real dispatcher (its `sendEvent` writes
// real queue rows) and the per-connection runs through a worker wired exactly as
// `scripts/worker.ts` wires production's — never a direct service call.
//
// ⚠️ NO SOCKET TO SENTRY.IO. `fetch` is trapped for the whole file: any request
// whose host is sentry.io throws AND is recorded, and the last test asserts the
// record is empty — so the property is measured, not assumed from the fake.

// The route's session is the ONE stub (a route test has no cookie jar), hoisted
// so the handler under test is the real module with every layer below it real.
const session = vi.hoisted(() => ({
  ctx: null as { userId: string; workspaceId: string } | null,
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({
  requireCompliantWorkspaceContext: async () => ({ ok: true, ctx: session.ctx }),
}));

const POLL_JOB = 'monitor/connection.poll-requested';
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const sentryRequests: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (/(^|\.)sentry\.io$/.test(new URL(url).hostname)) {
      sentryRequests.push(url);
      throw new Error(`the story suite must not reach sentry.io (tried ${url})`);
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  resetFakeMonitorProvider();
  fakeMonitorState().issues = [];
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
});

afterEach(async () => {
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
  vi.restoreAllMocks();
  await truncateJobRuns();
});

let seq = 0;

interface Bound {
  fx: WorkItemFixture;
  connectionId: string;
  installationId: string;
}

async function bind(tag = 'seam'): Promise<Bound> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `${tag} ${n}`, identifier: `SEAM${n}` });
  const grant = await monitorConnectionService.completeGrant(
    {
      provider: 'sentry',
      providerInstallationId: `pi-${tag}-${n}`,
      code: 'valid-code',
      projectId: fx.projectId,
    },
    fx.ctx,
  );
  const dto = await monitorConnectionService.bindProject(
    fx.projectId,
    { externalProjectId: `ext-${tag}-${n}`, externalProjectSlug: `${tag}-${n}` },
    fx.ctx,
  );
  return { fx, connectionId: dto.id, installationId: grant.installationId };
}

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
    permalink: `https://fake.invalid/issues/${externalId}`,
    ...overrides,
  };
}

async function payloadFor(run: JobQueueRun): Promise<unknown> {
  const eventId = run.eventId;
  if (eventId === null) return {};
  const event = await withSystemContext((tx) => tx.jobEvent.findUnique({ where: { id: eventId } }));
  return event?.data ?? {};
}

const worker = () =>
  new JobWorker({
    workerId: `seam-${seq}`,
    logger: silent,
    execute: async (run) => {
      await executeWithLedger(run, await payloadFor(run));
    },
    onTerminalFailure: async (run, error) =>
      recordEngineTerminalFailure(run, error, await payloadFor(run)),
  });

/** One scheduled TICK through the dispatcher, then drain every poll run it
 *  enqueued through the worker (backed-off retries made due immediately). */
async function tickAndDrain(tickRun: string): Promise<void> {
  const outcome = await new JobTestEngine({ function: monitorIssueReconcileTick }).execute();
  expect(outcome.error, tickRun).toBeUndefined();
  const w = worker();
  for (let pass = 0; pass < 20; pass += 1) {
    await adminDb.jobQueueRun.updateMany({
      where: { jobId: POLL_JOB, state: 'pending' },
      data: { runAt: new Date(Date.now() - 1_000) },
    });
    await w.tick();
    await w.settled();
    const open = await adminDb.jobQueueRun.count({
      where: { jobId: POLL_JOB, state: { in: ['pending', 'running'] } },
    });
    if (open === 0) break;
  }
  // The next tick is a NEW tick run: its idempotency keys must not collide with
  // this one's, exactly as production's distinct run ids do not.
  await adminDb.jobQueueRun.deleteMany({ where: { jobId: POLL_JOB } });
}

const bugsIn = (projectId: string) =>
  adminDb.workItem.findMany({ where: { projectId, kind: 'bug' }, orderBy: { key: 'asc' } });
const connectionRow = (id: string) =>
  adminDb.monitorConnection.findUniqueOrThrow({ where: { id } });

describe('seam 1 — tick → dispatcher → worker → poll → reconcile → destination', () => {
  it('a fake issue becomes exactly ONE bug, in the folder the resolver names', async () => {
    const b = await bind();
    fakeMonitorState().issues = [issue('seam-1', 5)];

    await tickAndDrain('first tick');

    const destination = await withWorkspaceContext(
      { userId: b.fx.ownerId, workspaceId: b.fx.workspaceId, projectId: b.fx.projectId },
      (tx) => bugDestinationService.resolve(b.fx.projectId, tx),
    );
    const bugs = await bugsIn(b.fx.projectId);
    expect(bugs).toHaveLength(1);
    expect(bugs[0]).toMatchObject({
      folderId: destination.folderId,
      title: 'Error seam-1',
      reporterId: b.fx.ownerId,
    });
    expect(await connectionRow(b.connectionId)).toMatchObject({
      lastPollStatus: 'ok',
      lastPollFiledCount: 1,
    });
  });
});

describe('seam 2 — the same tick twice over the same issue', () => {
  it('creates nothing the second time, and the bumped count lands on the row', async () => {
    const b = await bind();
    fakeMonitorState().issues = [issue('seam-2', 5)];
    await tickAndDrain('first');

    fakeMonitorState().issues = [issue('seam-2', 20, { eventCount: 41 })];
    await tickAndDrain('second');

    expect(await bugsIn(b.fx.projectId)).toHaveLength(1);
    expect((await adminDb.monitorIssue.findFirstOrThrow()).eventCount).toBe(41);
  });
});

describe('seam 3 — two connections, one REVOKED credential', () => {
  it('the healthy connection still files; the revoked one reads degraded + failed', async () => {
    const healthy = await bind('ok');
    const revoked = await bind('gone');
    // The revoked grant holds a token the provider refuses, and its refresh is
    // refused too — a customer who uninstalled the integration.
    await adminDb.monitorInstallation.update({
      where: { id: revoked.installationId },
      data: { accessTokenEncrypted: encryptToken('revoked-token') },
    });
    const revokedInstall = await adminDb.monitorInstallation.findUniqueOrThrow({
      where: { id: revoked.installationId },
    });
    const refusing: MonitorProvider = {
      ...fakeMonitorProvider,
      async listIssuesSince(input) {
        if (input.accessToken === 'revoked-token') {
          throw new MonitorProviderCallError(
            'listIssuesSince',
            401,
            'The integration was removed.',
          );
        }
        return fakeMonitorProvider.listIssuesSince(input);
      },
      async refreshCredential(input) {
        if (input.installationId === revokedInstall.installationId) {
          throw new MonitorProviderCallError(
            'refreshCredential',
            401,
            'The integration was removed.',
          );
        }
        return fakeMonitorProvider.refreshCredential(input);
      },
    };
    registerMonitorProvider(refusing, 'sentry');
    fakeMonitorState().issues = [issue('seam-3', 5)];

    await tickAndDrain('mixed');

    expect(await bugsIn(healthy.fx.projectId)).toHaveLength(1);
    expect(await bugsIn(revoked.fx.projectId)).toHaveLength(0);
    expect(
      await adminDb.monitorInstallation.findUniqueOrThrow({
        where: { id: revoked.installationId },
      }),
    ).toMatchObject({ health: 'degraded', healthReason: 'The integration was removed.' });
    expect(await connectionRow(revoked.connectionId)).toMatchObject({
      lastPollStatus: 'failed',
      lastPollError: 'The integration was removed.',
    });
    expect((await connectionRow(healthy.connectionId)).lastPollStatus).toBe('ok');
  });
});

describe('seam 4 — the ROUTE → the next poll', () => {
  it('a lowering through the real PATCH handler lets the next poll file the skipped warning', async () => {
    const b = await bind();
    await monitorConnectionService.setMinimumLevel(
      b.fx.projectId,
      b.connectionId,
      'error',
      b.fx.ctx,
    );
    fakeMonitorState().issues = [issue('seam-4', 5, { level: 'warning' })];
    await tickAndDrain('filtered');
    expect(await bugsIn(b.fx.projectId)).toHaveLength(0);

    // The route handler, not the service.
    session.ctx = b.fx.ctx;
    const ONE = await import('@/app/api/projects/[key]/monitors/[connectionId]/route');
    const res = await ONE.PATCH(
      new Request('https://motir.test/x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ minimumLevel: null }),
      }),
      { params: Promise.resolve({ key: b.fx.projectIdentifier, connectionId: b.connectionId }) },
    );
    expect(res.status).toBe(200);

    await tickAndDrain('lowered');
    const bugs = await bugsIn(b.fx.projectId);
    expect(bugs.map((bug) => bug.title)).toEqual(['Error seam-4']);
  });
});

describe('seam 5 — the terminal failure', () => {
  it('a poll that throws on every attempt ends failed ON the connection AND dead-lettered', async () => {
    const b = await bind();
    vi.spyOn(monitorIngestionService, 'pollConnection').mockRejectedValue(
      new Error('the database is on fire'),
    );

    await tickAndDrain('terminal');

    const row = await connectionRow(b.connectionId);
    expect(row.lastPollStatus).toBe('failed');
    expect(row.lastPollError).toContain('the database is on fire');
    expect(await adminDb.jobRunDlq.count({ where: { functionId: POLL_JOB } })).toBe(1);
  });
});

describe('seam 6 — the done-bug recurrence', () => {
  it('files a second bug relates_to the first, leaving the done one done', async () => {
    const b = await bind();
    fakeMonitorState().issues = [issue('seam-6', 5)];
    await tickAndDrain('first');
    const [first] = await bugsIn(b.fx.projectId);
    await adminDb.workItem.update({ where: { id: first!.id }, data: { status: 'done' } });

    fakeMonitorState().issues = [issue('seam-6', 45, { eventCount: 2 })];
    await tickAndDrain('recurrence');

    const bugs = await bugsIn(b.fx.projectId);
    expect(bugs).toHaveLength(2);
    const second = bugs.find((bug) => bug.id !== first!.id)!;
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: first!.id } })).status).toBe(
      'done',
    );
    expect(
      await adminDb.workItemLink.findFirst({
        where: { fromId: second.id, toId: first!.id, kind: 'relates_to' },
      }),
    ).not.toBeNull();
  });
});

describe('the DTO carries no credential — the five poll fields included', () => {
  it('exposes exactly the declared fields, none of them a token', async () => {
    const b = await bind();
    fakeMonitorState().issues = [issue('dto', 5)];
    await tickAndDrain('dto');
    const view = await monitorConnectionService.getView(b.fx.projectId, b.fx.ctx);
    const row = view.connections[0]!;
    expect(Object.keys(row).sort()).toEqual(
      [
        'createdAt',
        'externalProjectId',
        'externalProjectSlug',
        'health',
        'healthCheckedAt',
        'healthReason',
        'id',
        'lastPollError',
        'lastPollFiledCount',
        'lastPollStatus',
        'lastPollSucceededAt',
        'lastPolledAt',
        'minimumLevel',
        'orgSlug',
        'provider',
      ].sort(),
    );
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('fake-access-token');
    expect(serialized).not.toContain('fake-refresh-token');
  });
});

describe('nothing reached sentry.io', () => {
  it('the fetch trap recorded no request across the whole file', () => {
    expect(sentryRequests).toEqual([]);
  });
});
