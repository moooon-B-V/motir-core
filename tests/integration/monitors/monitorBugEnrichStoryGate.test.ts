import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';

// THE STORY'S GATE on the motir-core half of MOTIR-4930 (Subtask MOTIR-5852) —
// FILE → DISPATCH → LAND, read as one surface on REAL Postgres.
//
// Nothing in the pipeline is mocked by module: the real reconcile files the bug,
// the real `work-item/created` payload is captured off the job client, the real
// job function runs over it (dispatch, durable-sleep wait, apply), and motir-ai
// is reached through the SHIPPED boundary fake (`lib/test-ai-jobs-mock.ts`, an
// undici intercept on the `MOTIR_AI_URL` origin, fed by a fixture FILE re-read on
// every request). The fake monitor provider stands in for Sentry.
//
// ⚠️ One class of assertion is deliberately NOT here: anything about the model
// call, the grounding session, the tenant binding or the answer's schema belongs
// to motir-ai and is asserted by its own gate. A test here that faked motir-ai and
// then asserted one of its guarantees would be testing the fake.

const ORIGIN = 'https://motir-ai.story-gate.invalid';
let fixturePath: string;
let agent: MockAgent;
const submittedBodies: string[] = [];

/** Every outbound request that reaches `fetch` for a host that is not the fake —
 *  sentry.io above all. The story's seam must make NONE. */
const escapedRequests: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  fixturePath = join(mkdtempSync(join(tmpdir(), 'author-bug-gate-')), 'ai-jobs.json');
  vi.stubEnv('MOTIR_AI_URL', ORIGIN);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token-test');
  vi.stubEnv('MOTIR_AI_JOBS_FIXTURE_PATH', fixturePath);
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  const { installAiJobsBoundaryMock, observeAiJobSubmit } = await import('@/lib/test-ai-jobs-mock');
  installAiJobsBoundaryMock(agent);
  observeAiJobSubmit((raw) => submittedBodies.push(raw));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    // Compared as a parsed ORIGIN, not a prefix: `startsWith` would let
    // `https://motir-ai.story-gate.invalid.elsewhere.com` pass as the fake.
    const origin = URL.canParse(url) ? new URL(url).origin : null;
    if (origin !== new URL(ORIGIN).origin) escapedRequests.push(url);
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  await agent.close();
  const { db } = await import('@/lib/db');
  await db.$disconnect();
  await adminDb.$disconnect();
});

import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { captureJobEvents, JobTestEngine, type CapturedJobEvent } from '../../helpers/jobs';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import type { WorkItemCreatedData } from '@/lib/jobs/types';
import type { AiJobsFixture } from '@/lib/test-ai-jobs-mock';
import { monitorBugEnrichOnCreated } from '@/lib/jobs/definitions/monitorBugEnrich';
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
  monitorIngestionService,
  type MonitorReconcileConnection,
} from '@/lib/services/monitorIngestionService';
import { monitorBugEnrichmentService } from '@/lib/services/monitorBugEnrichmentService';
import { workItemsService } from '@/lib/services/workItemsService';

let cap: { events: CapturedJobEvent[]; restore: () => void };

const DESCRIPTION = [
  'The CSV export throws `TypeError` from `toCsv`, 17 times since 2026-09-20 in `production`.',
  '',
  '## Acceptance criteria',
  '',
  '- Exporting a board with an empty column returns a CSV file.',
  '',
  '## Context refs',
  '',
  '- `lib/services/exportService.ts`',
].join('\n');

const ANSWER = {
  descriptionMd: DESCRIPTION,
  explanationMd: 'Nobody can export a board with an empty column; it failed 17 times in a day.',
  type: 'code',
  executor: 'coding_agent',
  storyPoints: 2,
  estimateMinutes: 40,
  contextRefs: ['lib/services/exportService.ts'],
  candidateMechanisms: [],
  grounded: true,
  groundingReason: 'indexed',
};

const FRAMES = [
  { filePath: 'lib/services/exportService.ts', function: 'toCsv', lineNumber: 88, inApp: true },
];

function declare(fixture: Partial<AiJobsFixture>) {
  writeFileSync(fixturePath, JSON.stringify({ authorBug: [{ authoredBug: ANSWER }], ...fixture }));
}
const submittedKinds = () =>
  ((JSON.parse(readFileSync(fixturePath, 'utf8')) as AiJobsFixture).submitted ?? []).map(
    (s) => s.kind,
  );

beforeEach(async () => {
  await truncateAuthTables();
  resetFakeMonitorProvider();
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
  submittedBodies.length = 0;
  escapedRequests.length = 0;
  declare({});
  cap = captureJobEvents();
});

afterEach(() => {
  cap.restore();
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
  vi.restoreAllMocks();
});

let seq = 0;

async function seed(): Promise<{ fx: WorkItemFixture; target: MonitorReconcileConnection }> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `Gate ${n}`, identifier: `GAT${n}` });
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

/** A fake-provider issue reconciled → a bug filed. Returns the bug and its event. */
async function file(target: MonitorReconcileConnection, externalId: string) {
  const issue: FakeMonitorIssue = {
    externalId,
    title: `TypeError in export ${externalId}`,
    culprit: 'lib/services/exportService.ts in toCsv',
    level: 'error',
    eventCount: 17,
    firstSeenAt: new Date('2026-09-20T08:00:00.000Z'),
    lastSeenAt: new Date('2026-09-21T08:00:00.000Z'),
    permalink: null,
    assignee: null,
    environment: 'production',
    release: '2.4.1',
    frames: FRAMES,
  };
  fakeMonitorState().issues = [issue];
  const from = cap.events.length;
  const { workItemId } = await monitorIngestionService.reconcileIssue(target, issue, null);
  const event = cap.events.slice(from).find((e) => e.name === 'work-item/created')!
    .data as WorkItemCreatedData;
  return { workItemId: workItemId!, event };
}

const runJob = (event: WorkItemCreatedData) =>
  new JobTestEngine({
    function: monitorBugEnrichOnCreated,
    events: [{ name: 'work-item/created', data: event }],
  }).execute();

const read = (id: string) => adminDb.workItem.findUniqueOrThrow({ where: { id } });
const ENRICHABLE = ['explanationMd', 'type', 'executor', 'storyPoints', 'estimateMinutes'] as const;

async function expectUnenriched(id: string, thinBody: string | null) {
  const bug = await read(id);
  expect(bug.descriptionMd).toBe(thinBody);
  for (const field of ENRICHABLE) expect(bug[field], field).toBeNull();
}

describe('FILE → DISPATCH → LAND', () => {
  it('a filed bug is dispatched with the full envelope, and the fixture answer lands: both axes, a type, an executor, both sizes', async () => {
    const { target } = await seed();
    const { workItemId, event } = await file(target, 'land-1');

    const outcome = await runJob(event);

    expect(outcome.result).toMatchObject({
      dispatch: { dispatched: true },
      applied: { status: 'applied' },
    });
    // The envelope, read back from the captured submit rather than inferred.
    const body = JSON.parse(submittedBodies[0]!) as {
      jobKind: string;
      context: { bugAuthoring: Record<string, unknown> };
    };
    expect(body.jobKind).toBe('author_bug');
    expect(body.context.bugAuthoring).toMatchObject({
      issue: {
        title: 'TypeError in export land-1',
        culprit: 'lib/services/exportService.ts in toCsv',
        level: 'error',
        eventCount: 17,
        firstSeenAt: '2026-09-20T08:00:00.000Z',
        lastSeenAt: '2026-09-21T08:00:00.000Z',
      },
      environment: 'production',
      release: '2.4.1',
      frames: FRAMES,
      monitoredProjectSlug: 'web',
    });
    const bug = await read(workItemId);
    expect(bug.descriptionMd).toBe(DESCRIPTION);
    expect(bug.explanationMd).toBe(ANSWER.explanationMd);
    expect(bug.type).toBe('code');
    expect(bug.executor).toBe('coding_agent');
    expect(Number(bug.storyPoints)).toBe(2);
    expect(bug.estimateMinutes).toBe(40);
    expect(bug.explanationSource).toBe('ai_draft');
  });

  it('the SAME run twice, literally: one dispatch, one write, authoringJobId unchanged', async () => {
    const { target } = await seed();
    const { workItemId, event } = await file(target, 'twice-1');

    await runJob(event);
    const jobIdAfterFirst = (
      await adminDb.monitorIssue.findFirstOrThrow({ where: { externalIssueId: 'twice-1' } })
    ).authoringJobId;
    const updatedAfterFirst = (await read(workItemId)).updatedAt;
    const second = await runJob(event);

    expect(second.result).toMatchObject({
      dispatch: { dispatched: false, reason: 'already-dispatched' },
    });
    expect(submittedKinds().filter((k) => k === 'author_bug')).toHaveLength(1);
    expect(
      (await adminDb.monitorIssue.findFirstOrThrow({ where: { externalIssueId: 'twice-1' } }))
        .authoringJobId,
    ).toBe(jobIdAfterFirst);
    expect((await read(workItemId)).updatedAt).toEqual(updatedAfterFirst);
  });

  it('a description EDITED between filing and landing survives, byte for byte', async () => {
    const { fx, target } = await seed();
    const { workItemId, event } = await file(target, 'edited-1');
    const dispatch = await monitorBugEnrichmentService.dispatchEnrichment(event);
    expect(dispatch).toMatchObject({ dispatched: true });
    const edit = 'Looked into it — the column is null on an empty board.\n\nKeep this.';
    await workItemsService.updateWorkItem(workItemId, { descriptionMd: edit }, fx.ctx);

    const applied = await monitorBugEnrichmentService.applyAuthoredBug(
      event,
      (dispatch as { jobId: string }).jobId,
    );

    expect(applied).toEqual({ status: 'skipped', reason: 'card-changed' });
    const bug = await read(workItemId);
    expect(bug.descriptionMd).toBe(edit);
    for (const field of ENRICHABLE) expect(bug[field], field).toBeNull();
  });

  it('a DONE-category bug when the result arrives: nothing written', async () => {
    const { target } = await seed();
    const { workItemId, event } = await file(target, 'done-1');
    const thin = (await read(workItemId)).descriptionMd;
    const dispatch = await monitorBugEnrichmentService.dispatchEnrichment(event);
    await adminDb.workItem.update({ where: { id: workItemId }, data: { status: 'done' } });

    await expect(
      monitorBugEnrichmentService.applyAuthoredBug(event, (dispatch as { jobId: string }).jobId),
    ).resolves.toEqual({ status: 'skipped', reason: 'terminal-status' });
    await expectUnenriched(workItemId, thin);
  });

  it('getIssueContext THROWING still dispatches, with frames: [] on the captured envelope', async () => {
    const { target } = await seed();
    const { event } = await file(target, 'noctx-1');
    fakeMonitorState().failNextStatus.set('getIssueContext', { status: 500, reason: 'down' });

    await runJob(event);

    const body = JSON.parse(submittedBodies[0]!) as {
      context: { bugAuthoring: { frames: unknown[] } };
    };
    expect(body.context.bugAuthoring.frames).toEqual([]);
  });

  it('motir-ai UNCONFIGURED: nothing dispatched, nothing thrown, the bug intact', async () => {
    const { target } = await seed();
    const { workItemId, event } = await file(target, 'unconf-1');
    const thin = (await read(workItemId)).descriptionMd;
    vi.stubEnv('MOTIR_AI_URL', '');
    try {
      const outcome = await runJob(event);
      expect(outcome.error).toBeUndefined();
      expect(outcome.result).toEqual({
        dispatch: { dispatched: false, reason: 'ai-not-configured' },
      });
    } finally {
      vi.stubEnv('MOTIR_AI_URL', ORIGIN);
    }
    expect(submittedBodies).toEqual([]);
    await expectUnenriched(workItemId, thin);
  });

  it('the job result FAILING: the bug intact and unenriched, no partial field', async () => {
    const { target } = await seed();
    const { workItemId, event } = await file(target, 'failed-1');
    const thin = (await read(workItemId)).descriptionMd;
    declare({ authorBug: [{ status: 'failed' }] });

    const outcome = await runJob(event);

    expect(outcome.result).toMatchObject({ applied: { status: 'skipped', reason: 'job-failed' } });
    await expectUnenriched(workItemId, thin);
  });

  it('the job result failing RE-VALIDATION: the bug intact and unenriched, no partial field', async () => {
    const { target } = await seed();
    const { workItemId, event } = await file(target, 'invalid-1');
    const thin = (await read(workItemId)).descriptionMd;
    declare({ authorBug: [{ authoredBug: { ...ANSWER, storyPoints: 4 } }] });

    const outcome = await runJob(event);

    expect(outcome.result).toMatchObject({
      applied: { status: 'skipped', reason: 'invalid-answer' },
    });
    await expectUnenriched(workItemId, thin);
  });

  it('NO request escaped to sentry.io or a real motir-ai across the whole seam', async () => {
    const { target } = await seed();
    const { event } = await file(target, 'escape-1');
    await runJob(event);
    // The recorded set is asserted EMPTY — measured, not assumed.
    expect(escapedRequests).toEqual([]);
  });
});
