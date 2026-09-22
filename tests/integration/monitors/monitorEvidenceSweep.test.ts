import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE STANDING BACKFILL SWEEP (Story MOTIR-5975 · Subtask MOTIR-5983) — at the end
// of every poll whose listing succeeded, read the evidence of never-read links
// from the context-read budget the page walk left, and ask the enrichment to
// author monitor-filed bugs it never reached; idempotent on the link, and
// converging to nothing.
//
// Real Postgres, the FAKE monitor provider, a real poll. The one boundary faked is
// motir-ai (`submitJob` / `getJob` / the tenant-org lookup), exactly as in
// `monitorBugEnrich.test.ts`.

vi.mock('@/lib/ai/motirAiClient', () => ({ submitJob: vi.fn(), getJob: vi.fn() }));
vi.mock('@/lib/ai/tenantOrg', () => ({ resolveTenantOrg: vi.fn() }));

import { db } from '@/lib/db';
import { getJob, submitJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { monitorBugEnrichBackfill } from '@/lib/jobs/definitions/monitorBugEnrichBackfill';
import { sendEvent } from '@/lib/jobs/sendEvent';
import type { MonitorEnrichmentBackfillData } from '@/lib/jobs/types';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
  type FakeMonitorIssue,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import {
  MONITOR_CONTEXT_READS_PER_POLL,
  monitorIngestionService,
} from '@/lib/services/monitorIngestionService';
import { monitorIssueLinkService } from '@/lib/services/monitorIssueLinkService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { captureJobEvents, JobTestEngine, type CapturedJobEvent } from '../../helpers/jobs';

let cap: { events: CapturedJobEvent[]; restore: () => void } | null = null;

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
  // The authored answer is not this suite's subject: a failed job ends the wait
  // at once, and the dispatch — what IS the subject — has already been recorded.
  vi.mocked(getJob).mockResolvedValue({ status: 'failed' } as never);
  cap = captureJobEvents();
});

afterEach(() => {
  cap?.restore();
  cap = null;
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function seed(): Promise<{ fx: WorkItemFixture; connectionId: string }> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `Sweep ${n}`, identifier: `SWP${n}` });
  await monitorConnectionService.completeGrant(
    {
      provider: 'sentry',
      providerInstallationId: `pi-sweep-${n}`,
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

const BASE = Date.now();

function issue(
  externalId: string,
  minutesAfter: number,
  overrides: Partial<FakeMonitorIssue> = {},
): FakeMonitorIssue {
  return {
    externalId,
    title: `Error ${externalId}`,
    culprit: `lib/${externalId}.ts`,
    level: 'error',
    eventCount: 1,
    firstSeenAt: new Date(BASE),
    lastSeenAt: new Date(BASE + minutesAfter * 60_000),
    permalink: null,
    assignee: null,
    exception: { type: 'Error', message: `boom ${externalId}` },
    eventId: `ev-${externalId}`,
    eventAt: new Date(BASE),
    ...overrides,
  };
}

/** Make these links look like they predate the story: evidence never read. */
async function forgetEvidence(externalIssueIds: string[]) {
  await adminDb.monitorIssue.updateMany({
    where: { externalIssueId: { in: externalIssueIds } },
    data: {
      exceptionType: null,
      exceptionMessage: null,
      eventId: null,
      eventAt: null,
      evidenceReadAt: null,
      evidenceCheckedAt: null,
    },
  });
}

/** Make these bugs look like they predate the enrichment: filed two days ago. */
async function backdate(externalIssueIds: string[]) {
  const links = await adminDb.monitorIssue.findMany({
    where: { externalIssueId: { in: externalIssueIds } },
  });
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  await adminDb.monitorIssue.updateMany({
    where: { id: { in: links.map((l) => l.id) } },
    data: { createdAt: new Date(twoDaysAgo.getTime() - 1000) },
  });
  await adminDb.workItem.updateMany({
    where: { id: { in: links.map((l) => l.workItemId!) } },
    data: { createdAt: twoDaysAgo },
  });
}

const linkOf = (externalIssueId: string) =>
  adminDb.monitorIssue.findFirstOrThrow({ where: { externalIssueId } });

function backfillEvents(from = 0): MonitorEnrichmentBackfillData[] {
  return cap!.events
    .slice(from)
    .filter((e) => e.name === 'monitor-issue/enrichment-backfill')
    .map((e) => e.data as MonitorEnrichmentBackfillData);
}

function runBackfill(event: MonitorEnrichmentBackfillData) {
  return new JobTestEngine({
    function: monitorBugEnrichBackfill,
    events: [{ name: 'monitor-issue/enrichment-backfill', data: event }],
  }).execute();
}

describe('(a) EVIDENCE — from the budget the page walk left', () => {
  it(
    `3 never-read links, a walk that used ${MONITOR_CONTEXT_READS_PER_POLL - 2} reads: 2 this poll, 1 the next, then none`,
    { timeout: 180_000 },
    async () => {
      const { connectionId } = await seed();
      const old = ['old-1', 'old-2', 'old-3'];
      fakeMonitorState().issues = old.map((id, i) => issue(id, 1 + i));
      await monitorIngestionService.pollConnection(connectionId);
      await forgetEvidence(old);

      // The walk: exactly 48 issues listed, all since the watermark. The three
      // old issues are NOT listed any more — they have not recurred.
      const walked = Array.from({ length: MONITOR_CONTEXT_READS_PER_POLL - 2 }, (_, i) =>
        issue(`new-${i}`, 60 + i),
      );
      fakeMonitorState().issues = [...old.map((id, i) => issue(id, 1 + i)), ...walked];
      fakeMonitorState().contextReads = [];

      const first = await monitorIngestionService.pollConnection(connectionId);

      expect(first).toMatchObject({ status: 'ok', filed: walked.length, evidenceBackfilled: 2 });
      expect(fakeMonitorState().contextReads).toHaveLength(MONITOR_CONTEXT_READS_PER_POLL);
      expect(fakeMonitorState().contextReads.filter((id) => old.includes(id))).toHaveLength(2);

      fakeMonitorState().contextReads = [];
      const second = await monitorIngestionService.pollConnection(connectionId);
      expect(second).toMatchObject({ status: 'ok', evidenceBackfilled: 1 });
      expect(fakeMonitorState().contextReads).toHaveLength(1);

      fakeMonitorState().contextReads = [];
      const third = await monitorIngestionService.pollConnection(connectionId);
      expect(third).toMatchObject({ status: 'ok', evidenceBackfilled: 0 });
      expect(fakeMonitorState().contextReads).toHaveLength(0);

      for (const id of old) {
        const link = await linkOf(id);
        expect(link.evidenceReadAt).not.toBeNull();
        expect(link.exceptionMessage).toBe(`boom ${id}`);
      }
    },
  );

  it('a failed backfill read stamps the check and rotates the link behind the others', async () => {
    const { connectionId } = await seed();
    fakeMonitorState().issues = [issue('a', 1), issue('b', 2)];
    await monitorIngestionService.pollConnection(connectionId);
    await forgetEvidence(['a', 'b']);
    fakeMonitorState().deletedIssues.add('a');

    const summary = await monitorIngestionService.pollConnection(connectionId);

    expect(summary).toMatchObject({ status: 'ok', evidenceBackfilled: 1 });
    const a = await linkOf('a');
    expect(a.evidenceReadAt).toBeNull();
    expect(a.evidenceCheckedAt).not.toBeNull();
    expect((await linkOf('b')).evidenceReadAt).not.toBeNull();
  });

  it('a link to a DONE work item is not read', async () => {
    const { connectionId } = await seed();
    fakeMonitorState().issues = [issue('d', 1)];
    await monitorIngestionService.pollConnection(connectionId);
    await forgetEvidence(['d']);
    await adminDb.workItem.update({
      where: { id: (await linkOf('d')).workItemId! },
      data: { status: 'done' },
    });
    fakeMonitorState().contextReads = [];

    const summary = await monitorIngestionService.pollConnection(connectionId);

    expect(summary).toMatchObject({ evidenceBackfilled: 0 });
    expect(fakeMonitorState().contextReads).toEqual([]);
  });
});

describe('(b) ENRICHMENT — a monitor-filed bug the enrichment never reached', () => {
  it('gets exactly ONE author_bug across two consecutive polls, and its link records the job', async () => {
    const { connectionId } = await seed();
    fakeMonitorState().issues = [issue('pre', 1)];
    await monitorIngestionService.pollConnection(connectionId);
    await backdate(['pre']);
    expect((await linkOf('pre')).authoringJobId).toBeNull();

    const from = cap!.events.length;
    const first = await monitorIngestionService.pollConnection(connectionId);
    expect(first).toMatchObject({ status: 'ok', enrichmentRequested: 1 });
    const [event] = backfillEvents(from);
    expect(event).toMatchObject({
      workItemId: (await linkOf('pre')).workItemId,
      viaMonitorConnectionId: connectionId,
      idempotencyKey: `monitor-enrich-backfill:${(await linkOf('pre')).id}`,
    });
    await runBackfill(event!);

    const second = await monitorIngestionService.pollConnection(connectionId);

    expect(second).toMatchObject({ status: 'ok', enrichmentRequested: 0 });
    expect(submitJob).toHaveBeenCalledTimes(1);
    expect((await linkOf('pre')).authoringJobId).toBe('job_author_1');
  });

  it('a bug filed by THIS poll is left to its own created-trigger — the grace window', async () => {
    const { connectionId } = await seed();
    fakeMonitorState().issues = [issue('fresh', 1)];
    const summary = await monitorIngestionService.pollConnection(connectionId);
    expect(summary).toMatchObject({ filed: 1, enrichmentRequested: 0 });
  });

  it('a hand-linked card, a card edited after filing and a done bug are never emitted for', async () => {
    const { fx, connectionId } = await seed();
    fakeMonitorState().issues = [
      issue('edited', 1),
      issue('closed', 2),
      issue('byhand', 3, { lastSeenAt: new Date(BASE - 60 * 60_000) }),
    ];
    await monitorIngestionService.pollConnection(connectionId);
    await backdate(['edited', 'closed']);

    // Edited after filing — a person's words the model must not overwrite.
    const edited = await linkOf('edited');
    await workItemsService.updateWorkItem(
      edited.workItemId!,
      { descriptionMd: 'A person rewrote this.' },
      fx.ctx,
    );
    // Completed.
    await adminDb.workItem.update({
      where: { id: (await linkOf('closed')).workItemId! },
      data: { status: 'done' },
    });
    // Linked BY HAND to a card that existed first: its link records the card's
    // own identifier too, which is why the filed-ORDER check exists.
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'bug', title: 'Somebody’s own card' },
      fx.ctx,
    );
    await adminDb.workItem.update({
      where: { id: card.id },
      data: { createdAt: new Date(Date.now() - 3 * 24 * 60 * 60_000) },
    });
    await monitorIssueLinkService.linkIssue(
      card.id,
      { connectionId, externalIssueId: 'byhand', move: false },
      fx.ctx,
    );
    const byHand = await linkOf('byhand');
    expect(byHand.filedWorkItemIdentifier).toBe(card.identifier);

    const from = cap!.events.length;
    const summary = await monitorIngestionService.pollConnection(connectionId);

    expect(summary).toMatchObject({ status: 'ok', enrichmentRequested: 0 });
    expect(backfillEvents(from)).toEqual([]);
  });
});

describe('IDEMPOTENCY on the link', () => {
  async function eligibleEvent(): Promise<MonitorEnrichmentBackfillData> {
    const { connectionId } = await seed();
    fakeMonitorState().issues = [issue('idem', 1)];
    await monitorIngestionService.pollConnection(connectionId);
    await backdate(['idem']);
    const from = cap!.events.length;
    await monitorIngestionService.pollConnection(connectionId);
    const [event] = backfillEvents(from);
    return event!;
  }

  it('two emits before either handler runs land ONE queue row — one author_bug', async () => {
    const event = await eligibleEvent();
    cap!.restore();
    cap = null;

    await sendEvent('monitor-issue/enrichment-backfill', event);
    await sendEvent('monitor-issue/enrichment-backfill', event);

    const rows = await adminDb.jobQueueRun.findMany({
      where: { jobId: 'monitor-bug-enrich/backfill' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idempotencyKey).toBe(event.idempotencyKey);
  });

  it('two handler runs in sequence submit ONE author_bug; the second answers already-dispatched', async () => {
    const event = await eligibleEvent();

    await runBackfill(event);
    const second = await runBackfill(event);

    expect(submitJob).toHaveBeenCalledTimes(1);
    expect(second.result).toEqual({
      dispatch: { dispatched: false, reason: 'already-dispatched' },
    });
  });
});

describe('a poll whose credential is REFUSED', () => {
  it('runs no sweep, and records the same failure as before', async () => {
    const { connectionId } = await seed();
    fakeMonitorState().issues = [issue('r', 1)];
    await monitorIngestionService.pollConnection(connectionId);
    await forgetEvidence(['r']);
    await backdate(['r']);
    fakeMonitorState().contextReads = [];
    fakeMonitorState().failNextStatus.set('listIssuesSince', { status: 500, reason: 'down' });
    const from = cap!.events.length;

    const summary = await monitorIngestionService.pollConnection(connectionId);

    expect(summary).toMatchObject({
      status: 'failed',
      evidenceBackfilled: 0,
      enrichmentRequested: 0,
    });
    expect(fakeMonitorState().contextReads).toEqual([]);
    expect(backfillEvents(from)).toEqual([]);
    const connection = await adminDb.monitorConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    expect(connection.lastPollError).toBe('down');
  });
});
