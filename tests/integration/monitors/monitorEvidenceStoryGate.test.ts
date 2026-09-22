import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE STORY GATE for MOTIR-5975 (Subtask MOTIR-5984) — the ASSEMBLED evidence
// surface on real Postgres. Each child tested its own side of a seam against a
// mock of the other; this file drives the seams themselves:
//
//   (2) ONE latest-event read → the store → the three read surfaces (the page's
//       read, `get_work_item`, the dispatch prompt) agree, at the bounds, with
//       nothing user-identifying and nothing past a bound on any of them.
//   (3) A refused read keeps the evidence on all three, marked stale.
//   (4) A pre-story link is swept and enriched ONCE through the backfill JOB.
//   (5) No provider call on any read path.
//   (6) The user-tag denylist has ONE home.
//   (7) The evidence module stays a pure seam module.
//
// motir-ai is the one boundary faked (as in `monitorBugEnrichStoryGate.test.ts`).

vi.mock('@/lib/ai/motirAiClient', () => ({ submitJob: vi.fn(), getJob: vi.fn() }));
vi.mock('@/lib/ai/tenantOrg', () => ({ resolveTenantOrg: vi.fn() }));

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '@/lib/db';
import { getJob, submitJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { MONITOR_AUTHORING_POLLS } from '@/lib/jobs/definitions/monitorBugEnrich';
import { monitorBugEnrichBackfill } from '@/lib/jobs/definitions/monitorBugEnrichBackfill';
import type { MonitorEnrichmentBackfillData } from '@/lib/jobs/types';
import { runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import { MONITOR_USER_IDENTIFYING_TAG_KEYS } from '@/lib/monitors/evidence';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
  type FakeMonitorIssue,
} from '@/lib/monitors/providers/fake';
import { normalizeIssueContext, sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { MONITOR_EVIDENCE_TAGS_MAX, MONITOR_ISSUE_FRAMES_MAX } from '@/lib/monitors/types';
import { monitorIssueRepository } from '@/lib/repositories/monitorIssueRepository';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { monitorIngestionService } from '@/lib/services/monitorIngestionService';
import { monitorIssueService } from '@/lib/services/monitorIssueService';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { captureJobEvents, JobTestEngine, type CapturedJobEvent } from '../../helpers/jobs';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';

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
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_gate_1' });
  vi.mocked(getJob).mockResolvedValue({ status: 'failed' } as never);
  cap = captureJobEvents();
});

afterEach(() => {
  cap?.restore();
  cap = null;
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function seed(): Promise<{ fx: WorkItemFixture; connectionId: string }> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `Gate ${n}`, identifier: `GATE${n}` });
  await monitorConnectionService.completeGrant(
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
    { externalProjectId: 'fake-web', externalProjectSlug: 'web' },
    fx.ctx,
  );
  return { fx, connectionId: dto.id };
}

/**
 * A Sentry latest event AT and PAST the bounds — 25 frames, 35 tags including
 * user-identifying ones, a request URL with a query string — run through the
 * REAL Sentry normaliser, so the bound under test is the adapter's own cut and
 * the fake answers exactly what production would have stored.
 */
function eventAtTheBounds() {
  const frames = Array.from({ length: 25 }, (_, i) => ({
    filename: i % 5 === 0 ? `lib/services/app${i}.ts` : `node_modules/lib/f${i}.js`,
    function: `fn${i}`,
    lineNo: i + 1,
    inApp: i % 5 === 0,
  }));
  const tags = [
    { key: 'user.email', value: 'someone@example.com' },
    { key: 'ip', value: '203.0.113.9' },
    ...Array.from({ length: 33 }, (_, i) => ({ key: `tag${i}`, value: `value${i}` })),
  ];
  return normalizeIssueContext({
    eventID: 'ev-gate-1',
    dateCreated: '2026-09-20T18:04:11.000Z',
    tags,
    entries: [
      {
        type: 'exception',
        data: {
          values: [
            {
              type: 'PrismaClientKnownRequestError',
              value: 'Transaction API error: expired transaction',
              stacktrace: { frames },
            },
          ],
        },
      },
      {
        type: 'request',
        data: { method: 'POST', url: 'https://app.example/api/github/webhook?token=SECRET' },
      },
    ],
  });
}

function issueFromContext(externalId: string, minutesAfter: number): FakeMonitorIssue {
  const context = eventAtTheBounds();
  return {
    externalId,
    title: `PrismaClientKnownRequestError ${externalId}`,
    culprit: null,
    level: 'error',
    eventCount: 3,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(Date.now() + minutesAfter * 60_000),
    permalink: null,
    assignee: null,
    externalProjectId: 'fake-web',
    frames: context.frames,
    exception: context.exception,
    // The fake re-applies the same filter, so seeding the FILTERED tags back as
    // raw ones changes nothing — and the user-identifying pair is re-added to
    // prove the fake drops it too.
    rawTags: [
      { key: 'user.email', value: 'someone@example.com' },
      { key: 'ip', value: '203.0.113.9' },
      ...Array.from({ length: 33 }, (_, i) => ({ key: `tag${i}`, value: `value${i}` })),
    ],
    requestMethod: 'POST',
    requestUrl: 'https://app.example/api/github/webhook?token=SECRET',
    eventId: context.eventId,
    eventAt: context.eventAt,
  };
}

async function threeSurfaces(fx: WorkItemFixture, workItemId: string) {
  const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } });
  const page = await monitorIssueService.listForWorkItem(workItemId, fx.ctx);
  const tool = await runGetWorkItem({ key: item.identifier }, fx.ctx);
  const prompt = (
    await dispatchPromptService.getDispatchPrompt(fx.projectId, item.identifier, fx.ctx)
  ).prompt;
  const mcp = (tool.structuredContent as { errors: typeof page }).errors;
  return { page, mcp, prompt };
}

const FORBIDDEN = ['someone@example.com', '203.0.113.9', 'token=SECRET', 'SECRET'];

describe('(2) ONE read → the store → THREE surfaces that agree', () => {
  it('the same exception, the same 20 frames in order and the same 30 tags on all three — nothing user-identifying, nothing past a bound', async () => {
    const { fx, connectionId } = await seed();
    fakeMonitorState().issues = [issueFromContext('g1', 5)];
    await monitorIngestionService.pollConnection(connectionId);
    const link = await adminDb.monitorIssue.findFirstOrThrow({ where: { externalIssueId: 'g1' } });

    const { page, mcp, prompt } = await threeSurfaces(fx, link.workItemId!);

    const evidence = page[0]!.evidence;
    expect(evidence.state).toBe('present');
    expect(evidence.frames).toHaveLength(MONITOR_ISSUE_FRAMES_MAX);
    expect(evidence.tags).toHaveLength(MONITOR_EVIDENCE_TAGS_MAX);
    // In-app first — the adapter's partition survives the store.
    expect(evidence.frames.slice(0, 5).every((f) => f.inApp === true)).toBe(true);

    // The MCP payload IS the page's read, value for value.
    expect(mcp).toEqual(JSON.parse(JSON.stringify(page)));

    // The prompt renders the same exception, every frame in the same order, every tag.
    expect(prompt).toContain('Exception: PrismaClientKnownRequestError');
    let at = 0;
    for (const frame of evidence.frames) {
      const next = prompt.indexOf(`${frame.filePath}:${frame.lineNumber}`, at);
      expect(next, `${frame.filePath} in order`).toBeGreaterThan(at - 1);
      at = next;
    }
    for (const tag of evidence.tags) expect(prompt).toContain(`${tag.key} = ${tag.value}`);
    expect(prompt).toContain('Request: POST /api/github/webhook');
    // Nothing past a bound: the 21st frame and the 31st tag reach no surface.
    for (const surface of [JSON.stringify(page), JSON.stringify(mcp), prompt]) {
      for (const secret of FORBIDDEN) expect(surface).not.toContain(secret);
      expect(surface).not.toContain('tag30');
      expect(surface).not.toContain('user.email');
    }
  });
});

describe('(3) a REFUSED read keeps the evidence standing, marked stale', () => {
  it('all three surfaces still carry the previous evidence; the DTO is stale and evidence_read_at is unchanged', async () => {
    const { fx, connectionId } = await seed();
    fakeMonitorState().issues = [issueFromContext('g2', 5)];
    await monitorIngestionService.pollConnection(connectionId);
    const before = await adminDb.monitorIssue.findFirstOrThrow({
      where: { externalIssueId: 'g2' },
    });

    fakeMonitorState().issues = [{ ...issueFromContext('g2', 10), eventCount: 9 }];
    fakeMonitorState().failNextStatus.set('getIssueContext', { status: 500 });
    await monitorIngestionService.pollConnection(connectionId);
    const after = await adminDb.monitorIssue.findFirstOrThrow({ where: { externalIssueId: 'g2' } });

    expect(after.evidenceReadAt).toEqual(before.evidenceReadAt);
    expect(after.exceptionType).toBe(before.exceptionType);
    const { page, mcp, prompt } = await threeSurfaces(fx, after.workItemId!);
    expect(page[0]!.evidence).toMatchObject({ state: 'present', stale: true });
    expect(page[0]!.evidence.lastFailedAt).not.toBeNull();
    expect(mcp).toEqual(JSON.parse(JSON.stringify(page)));
    expect(prompt).toContain('OUT OF DATE');
    expect(prompt).toContain('Exception: PrismaClientKnownRequestError');
  });
});

describe('(4) sweep → enrichment, through the real backfill JOB', () => {
  it('a pre-story link is swept and enriched ONCE; a second poll and a redelivered event submit nothing', async () => {
    const { connectionId } = await seed();
    fakeMonitorState().issues = [issueFromContext('g3', 5)];
    await monitorIngestionService.pollConnection(connectionId);
    const link = await adminDb.monitorIssue.findFirstOrThrow({ where: { externalIssueId: 'g3' } });
    // Make it PREDATE the story and the enrichment: never read, never dispatched,
    // filed two days ago — and no longer listed by the poll.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    await adminDb.monitorIssue.update({
      where: { id: link.id },
      data: {
        evidenceReadAt: null,
        evidenceCheckedAt: null,
        exceptionType: null,
        exceptionMessage: null,
        frames: undefined,
        authoringJobId: null,
        createdAt: new Date(twoDaysAgo.getTime() - 1000),
      },
    });
    await adminDb.workItem.update({
      where: { id: link.workItemId! },
      data: { createdAt: twoDaysAgo },
    });
    fakeMonitorState().issues = fakeMonitorState().issues.map((i) => ({
      ...i,
      lastSeenAt: new Date(Date.now() - 3 * 24 * 60 * 60_000),
    }));
    vi.mocked(submitJob).mockClear();

    const from = cap!.events.length;
    await monitorIngestionService.pollConnection(connectionId);
    const emitted = cap!.events
      .slice(from)
      .filter((e) => e.name === 'monitor-issue/enrichment-backfill')
      .map((e) => e.data as MonitorEnrichmentBackfillData);
    expect(emitted).toHaveLength(1);
    const swept = await adminDb.monitorIssue.findUniqueOrThrow({ where: { id: link.id } });
    expect(swept.evidenceReadAt).not.toBeNull();

    const run = () =>
      new JobTestEngine({
        function: monitorBugEnrichBackfill,
        events: [{ name: 'monitor-issue/enrichment-backfill', data: emitted[0]! }],
      }).execute();
    await run();
    expect(submitJob).toHaveBeenCalledTimes(1);
    expect(
      (await adminDb.monitorIssue.findUniqueOrThrow({ where: { id: link.id } })).authoringJobId,
    ).toBe('job_gate_1');

    // A redelivered event, and a second poll: nothing more is submitted.
    await run();
    const from2 = cap!.events.length;
    await monitorIngestionService.pollConnection(connectionId);
    expect(
      cap!.events.slice(from2).filter((e) => e.name === 'monitor-issue/enrichment-backfill'),
    ).toHaveLength(0);
    expect(submitJob).toHaveBeenCalledTimes(1);
  });

  it('the job’s poll loop waits between reads, and gives up as timed-out after its last poll', async () => {
    const { fx } = await seed();
    const data: MonitorEnrichmentBackfillData = {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: 'wi',
      actorId: fx.ctx.userId,
      viaMonitorConnectionId: 'c',
      idempotencyKey: 'monitor-enrich-backfill:gate',
    };
    const dispatched = { dispatched: true, jobId: 'j', framesRead: false };
    const pendingThenApplied = await new JobTestEngine({
      function: monitorBugEnrichBackfill,
      events: [{ name: 'monitor-issue/enrichment-backfill', data }],
      steps: [
        { id: 'backfill-dispatch-bug-authoring', handler: () => dispatched },
        { id: 'backfill-apply-authored-bug-0', handler: () => ({ status: 'pending' }) },
        { id: 'backfill-apply-authored-bug-1', handler: () => ({ status: 'applied' }) },
      ],
    }).execute();
    expect(pendingThenApplied.result).toEqual({
      dispatch: dispatched,
      applied: { status: 'applied' },
    });
    expect(pendingThenApplied.ctx.step.sleep).toHaveBeenCalledTimes(1);

    const alwaysPending = await new JobTestEngine({
      function: monitorBugEnrichBackfill,
      events: [{ name: 'monitor-issue/enrichment-backfill', data }],
      steps: [
        { id: 'backfill-dispatch-bug-authoring', handler: () => dispatched },
        ...Array.from({ length: MONITOR_AUTHORING_POLLS }, (_, poll) => ({
          id: `backfill-apply-authored-bug-${poll}`,
          handler: () => ({ status: 'pending' }),
        })),
      ],
    }).execute();
    expect(alwaysPending.result).toEqual({
      dispatch: dispatched,
      applied: { status: 'skipped', reason: 'timed-out' },
    });
  });

  it('the sweep’s two queries answer nothing for a spent budget, without reading', async () => {
    const { connectionId } = await seed();
    await db.$transaction(async (tx) => {
      await expect(
        monitorIssueRepository.listNeverReadLinked(connectionId, [], new Date(), 0, tx),
      ).resolves.toEqual([]);
      await expect(
        monitorIssueRepository.listEnrichmentBackfillCandidates(
          connectionId,
          [],
          new Date(),
          0,
          tx,
        ),
      ).resolves.toEqual([]);
    });
  });
});

describe('(5) GUARD — no provider call on a read path', () => {
  it('the page’s read, get_work_item and the dispatch prompt make zero provider calls', async () => {
    const { fx, connectionId } = await seed();
    fakeMonitorState().issues = [issueFromContext('g5', 5)];
    await monitorIngestionService.pollConnection(connectionId);
    const link = await adminDb.monitorIssue.findFirstOrThrow({ where: { externalIssueId: 'g5' } });
    const spies = (Object.keys(fakeMonitorProvider) as (keyof typeof fakeMonitorProvider)[])
      .filter((key) => typeof fakeMonitorProvider[key] === 'function')
      .map((key) => vi.spyOn(fakeMonitorProvider, key as never));

    await threeSurfaces(fx, link.workItemId!);

    expect(spies.length).toBeGreaterThan(5);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('(6) GUARD — the user-tag denylist has ONE home', () => {
  it('lib/dispatch, lib/mcp and app declare no filter of their own; lib/monitors/evidence.ts is the only definition', () => {
    // The keys only the denylist would name — `user` / `email` are ordinary words.
    const tells = [
      'ip_address',
      'client_ip',
      "startsWith('user.')",
      'MONITOR_USER_IDENTIFYING_TAG_KEYS',
    ];
    const offenders = ['lib/dispatch', 'lib/mcp', 'app']
      .flatMap((dir) => sourceFiles(dir))
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return tells.some((tell) => text.includes(tell));
      });
    expect(offenders).toEqual([]);
    // The one definition, and it is the one the guard above names.
    expect(readFileSync('lib/monitors/evidence.ts', 'utf8')).toContain(
      'export const MONITOR_USER_IDENTIFYING_TAG_KEYS',
    );
    expect(MONITOR_USER_IDENTIFYING_TAG_KEYS).toEqual(
      expect.arrayContaining(['user', 'ip', 'ip_address', 'client_ip', 'email', 'username']),
    );
    // And the fires-proof: the scan finds a planted copy.
    expect(tells.some((tell) => "if (key.startsWith('user.')) continue;".includes(tell))).toBe(
      true,
    );
  });
});

describe('(7) GUARD — the seam stays pure', () => {
  it('lib/monitors/evidence.ts imports no repository, service or Prisma client', () => {
    const imports = readFileSync('lib/monitors/evidence.ts', 'utf8')
      .split('\n')
      .filter((line) => /^\s*import\b|from '/.test(line));
    for (const line of imports) {
      expect(line).not.toMatch(/repositories|services|@\/lib\/db|prisma/i);
    }
  });
});
