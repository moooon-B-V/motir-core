import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE AUTHORED ANSWER LANDS ON THE BUG (Story MOTIR-4930 · Subtask MOTIR-5851) —
// the finished `author_bug` result is read, re-validated and written onto the
// bug the reconciler filed: both bodies, the type, the executor and the sizing,
// as the binder, with `ai_draft` provenance, only while the card is still exactly
// as it was filed.
//
// Real Postgres, the real reconcile, the real write path. motir-ai is faked at its
// client (`getJob`, `submitJob`) and at the tenant-org lookup.

vi.mock('@/lib/ai/motirAiClient', () => ({ submitJob: vi.fn(), getJob: vi.fn() }));
vi.mock('@/lib/ai/tenantOrg', () => ({ resolveTenantOrg: vi.fn() }));

import { db } from '@/lib/db';
import { getJob, submitJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { MotirAiJobFailedError, MotirAiUnavailableError } from '@/lib/ai/errors';
import {
  CANDIDATE_MECHANISMS_DISCLAIMER,
  CANDIDATE_MECHANISMS_HEADING,
} from '@/lib/ai/authoredBug';
import {
  MONITOR_AUTHORING_POLLS,
  monitorBugEnrichOnCreated,
} from '@/lib/jobs/definitions/monitorBugEnrich';
import type { WorkItemCreatedData } from '@/lib/jobs/types';
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

const DESCRIPTION = [
  'The CSV export throws `TypeError` from `toCsv` at `lib/services/exportService.ts:88`, seen 17 times since 2026-09-20 in `production`.',
  '',
  '## Acceptance criteria',
  '',
  '- Exporting a board with an empty column returns a CSV file.',
  '- No new event of this issue is recorded after the fix deploys.',
  '',
  CANDIDATE_MECHANISMS_HEADING,
  '',
  CANDIDATE_MECHANISMS_DISCLAIMER,
  '',
  '- The column may be null when the board has no cards.',
  '- A card may be deleted between the read and the serialise.',
  '',
  '## Context refs',
  '',
  '- `lib/services/exportService.ts`',
].join('\n');

const ANSWER = {
  descriptionMd: DESCRIPTION,
  explanationMd: 'Nobody can export a board that has an empty column; it failed 17 times in a day.',
  type: 'code',
  executor: 'coding_agent',
  storyPoints: 3,
  estimateMinutes: 55,
  contextRefs: ['lib/services/exportService.ts'],
  candidateMechanisms: [
    'The column may be null when the board has no cards.',
    'A card may be deleted between the read and the serialise.',
  ],
  grounded: true,
  groundingReason: 'indexed',
};

function succeeds(authoredBug: unknown = ANSWER) {
  vi.mocked(getJob).mockResolvedValue({
    jobId: 'job_author_1',
    status: 'succeeded',
    result: {
      envelopeVersion: 'v1',
      jobKind: 'author_bug',
      summary: 'author_bug: authored',
      usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
      authoredBug,
    },
    error: null,
  });
}

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
  succeeds();
  cap = captureJobEvents();
});

afterEach(() => {
  cap.restore();
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function seed(): Promise<{ fx: WorkItemFixture; target: MonitorReconcileConnection }> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `Apply ${n}`, identifier: `APL${n}` });
  await monitorConnectionService.completeGrant(
    {
      provider: 'sentry',
      providerInstallationId: `pi-apply-${n}`,
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

/** File one issue through the real reconciler and dispatch its enrichment. */
async function fileAndDispatch(target: MonitorReconcileConnection, externalId: string) {
  const seeded: FakeMonitorIssue = {
    externalId,
    title: `TypeError in export ${externalId}`,
    culprit: 'lib/services/exportService.ts in toCsv',
    level: 'error',
    eventCount: 17,
    firstSeenAt: new Date('2026-09-20T08:00:00.000Z'),
    lastSeenAt: new Date('2026-09-21T08:00:00.000Z'),
    permalink: null,
    assignee: null,
  };
  fakeMonitorState().issues = [seeded];
  const from = cap.events.length;
  const result = await monitorIngestionService.reconcileIssue(target, seeded, null);
  const event = cap.events.slice(from).find((e) => e.name === 'work-item/created')!
    .data as WorkItemCreatedData;
  const dispatched = await monitorBugEnrichmentService.dispatchEnrichment(event);
  expect(dispatched).toMatchObject({ dispatched: true });
  return { workItemId: result.workItemId!, event };
}

const read = (id: string) => adminDb.workItem.findUniqueOrThrow({ where: { id } });
const PLANNED_FIELDS = [
  'descriptionMd',
  'explanationMd',
  'explanationSource',
  'type',
  'executor',
  'storyPoints',
  'estimateMinutes',
] as const;
const snapshot = async (id: string) => {
  const row = await read(id);
  return Object.fromEntries(PLANNED_FIELDS.map((k) => [k, row[k]]));
};

describe('a completed answer LANDS', () => {
  it('both bodies, type, executor and the sizing pair — each equal to the validated answer', async () => {
    const { target } = await seed();
    const { workItemId, event } = await fileAndDispatch(target, 'land-1');

    await expect(
      monitorBugEnrichmentService.applyAuthoredBug(event, 'job_author_1'),
    ).resolves.toEqual({
      status: 'applied',
    });

    const bug = await read(workItemId);
    expect(bug.descriptionMd).toBe(DESCRIPTION);
    expect(bug.explanationMd).toBe(ANSWER.explanationMd);
    expect(bug.type).toBe('code');
    expect(bug.executor).toBe('coding_agent');
    expect(Number(bug.storyPoints)).toBe(3);
    expect(bug.estimateMinutes).toBe(55);
    expect(bug.explanationSource).toBe('ai_draft');
    // Read with the job's project scope — the tenant check on the read.
    expect(getJob).toHaveBeenCalledWith('job_author_1', target.projectId);
  });

  it('the written description carries the Acceptance criteria bullets, the mechanisms WITH their not-established statement, and the refs', async () => {
    const { target } = await seed();
    const { workItemId, event } = await fileAndDispatch(target, 'shape-1');
    await monitorBugEnrichmentService.applyAuthoredBug(event, 'job_author_1');
    const md = (await read(workItemId)).descriptionMd!;
    expect(md).toMatch(/^## Acceptance criteria$/m);
    expect(md.slice(md.indexOf('## Acceptance criteria'))).toMatch(/^- \S/m);
    expect(md).toMatch(/^## Context refs$/m);
    expect(md).toContain(CANDIDATE_MECHANISMS_HEADING);
    expect(md).toContain(CANDIDATE_MECHANISMS_DISCLAIMER);
  });

  it('an UNGROUNDED answer lands with its refs section saying the refs could not be resolved', async () => {
    const { target } = await seed();
    const { workItemId, event } = await fileAndDispatch(target, 'ungrounded-1');
    succeeds({ ...ANSWER, grounded: false, groundingReason: 'not_indexed' });
    await monitorBugEnrichmentService.applyAuthoredBug(event, 'job_author_1');
    const md = (await read(workItemId)).descriptionMd!;
    expect(md.slice(md.indexOf('## Context refs'))).toMatch(/could not be resolved/);
  });

  it('writes through workItemsService.updateWorkItem AS THE BINDER', async () => {
    const { fx, target } = await seed();
    const { event } = await fileAndDispatch(target, 'binder-1');
    const spy = vi.spyOn(workItemsService, 'updateWorkItem');
    await monitorBugEnrichmentService.applyAuthoredBug(event, 'job_author_1');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![2]).toEqual({ userId: fx.ctx.userId, workspaceId: fx.workspaceId });
  });
});

describe('ONE predicate — the card is still exactly as it was filed', () => {
  it('idempotent: a second apply writes nothing and says the card changed', async () => {
    const { target } = await seed();
    const { workItemId, event } = await fileAndDispatch(target, 'twice-1');
    await monitorBugEnrichmentService.applyAuthoredBug(event, 'job_author_1');
    const after = await snapshot(workItemId);
    const spy = vi.spyOn(workItemsService, 'updateWorkItem');

    await expect(
      monitorBugEnrichmentService.applyAuthoredBug(event, 'job_author_1'),
    ).resolves.toEqual({
      status: 'skipped',
      reason: 'card-changed',
    });

    expect(spy).not.toHaveBeenCalled();
    expect(await snapshot(workItemId)).toEqual(after);
  });

  it('a HUMAN EDIT made before the answer arrived is never overwritten', async () => {
    const { fx, target } = await seed();
    const { workItemId, event } = await fileAndDispatch(target, 'edited-1');
    await workItemsService.updateWorkItem(
      workItemId,
      { descriptionMd: 'I looked into this: the export fails on empty columns.' },
      fx.ctx,
    );
    const before = await snapshot(workItemId);

    await expect(
      monitorBugEnrichmentService.applyAuthoredBug(event, 'job_author_1'),
    ).resolves.toEqual({
      status: 'skipped',
      reason: 'card-changed',
    });
    expect(await snapshot(workItemId)).toEqual(before);
  });

  it('a recurrence that moved the issue’s facts does NOT defeat the predicate — the filed body is the recorded one', async () => {
    const { target } = await seed();
    const { workItemId, event } = await fileAndDispatch(target, 'recur-1');
    // The reconciler records a recurrence: the link's facts move on, the card's
    // body does not. A recomputed thin body would now disagree with the card.
    await adminDb.monitorIssue.updateMany({
      where: { externalIssueId: 'recur-1' },
      data: { eventCount: 99, lastSeenAt: new Date('2026-09-22T00:00:00.000Z') },
    });
    await expect(
      monitorBugEnrichmentService.applyAuthoredBug(event, 'job_author_1'),
    ).resolves.toEqual({
      status: 'applied',
    });
    expect((await read(workItemId)).descriptionMd).toBe(DESCRIPTION);
  });

  describe('PER STATUS — the enum is the checklist', () => {
    it.each(['todo', 'blocked', 'in_progress', 'implemented', 'in_review', 'approved'])(
      '%s: written — the thin-body predicate alone decides',
      async (status) => {
        const { target } = await seed();
        const { workItemId, event } = await fileAndDispatch(target, `status-${status}`);
        await adminDb.workItem.update({ where: { id: workItemId }, data: { status } });
        await expect(
          monitorBugEnrichmentService.applyAuthoredBug(event, 'job_author_1'),
        ).resolves.toEqual({ status: 'applied' });
        const bug = await read(workItemId);
        expect(bug.descriptionMd).toBe(DESCRIPTION);
        expect(bug.status).toBe(status); // nothing transitions it
      },
    );

    it.each(['done', 'cancelled'])('%s: NEVER written', async (status) => {
      const { target } = await seed();
      const { workItemId, event } = await fileAndDispatch(target, `status-${status}`);
      await adminDb.workItem.update({ where: { id: workItemId }, data: { status } });
      const before = await snapshot(workItemId);
      await expect(
        monitorBugEnrichmentService.applyAuthoredBug(event, 'job_author_1'),
      ).resolves.toEqual({
        status: 'skipped',
        reason: 'terminal-status',
      });
      expect(await snapshot(workItemId)).toEqual(before);
      expect((await read(workItemId)).status).toBe(status);
    });
  });
});

describe('FOUR refusals — each a value, the bug filed and unenriched, no partial write', () => {
  it('the job FAILED', async () => {
    const { target } = await seed();
    const { workItemId, event } = await fileAndDispatch(target, 'failed-1');
    const before = await snapshot(workItemId);
    vi.mocked(getJob).mockResolvedValue({
      jobId: 'job_author_1',
      status: 'failed',
      result: null,
      error: new MotirAiJobFailedError('the model refused', {
        type: 'about:blank',
        title: 'AI job failed',
        status: 502,
        code: 'ai_job_failed',
      }),
    });
    await expect(
      monitorBugEnrichmentService.applyAuthoredBug(event, 'job_author_1'),
    ).resolves.toEqual({
      status: 'skipped',
      reason: 'job-failed',
    });
    expect(await snapshot(workItemId)).toEqual(before);
  });

  it('the answer fails re-validation', async () => {
    const { target } = await seed();
    const { workItemId, event } = await fileAndDispatch(target, 'invalid-1');
    const before = await snapshot(workItemId);
    succeeds({ ...ANSWER, executor: 'robot' });
    await expect(
      monitorBugEnrichmentService.applyAuthoredBug(event, 'job_author_1'),
    ).resolves.toEqual({
      status: 'skipped',
      reason: 'invalid-answer',
    });
    expect(await snapshot(workItemId)).toEqual(before);
  });

  it('motir-ai unreachable when the result is read', async () => {
    const { target } = await seed();
    const { workItemId, event } = await fileAndDispatch(target, 'unreachable-1');
    const before = await snapshot(workItemId);
    vi.mocked(getJob).mockRejectedValue(new MotirAiUnavailableError('down'));
    await expect(
      monitorBugEnrichmentService.applyAuthoredBug(event, 'job_author_1'),
    ).resolves.toEqual({
      status: 'skipped',
      reason: 'ai-unreachable',
    });
    expect(await snapshot(workItemId)).toEqual(before);
  });

  it('the bounded wait elapses with the job still running — driven through the job function', async () => {
    const { target } = await seed();
    const from = cap.events.length;
    const seeded: FakeMonitorIssue = {
      externalId: 'slow-1',
      title: 'Slow',
      culprit: null,
      level: 'error',
      eventCount: 1,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      permalink: null,
      assignee: null,
    };
    fakeMonitorState().issues = [seeded];
    const { workItemId } = await monitorIngestionService.reconcileIssue(target, seeded, null);
    const event = cap.events.slice(from).find((e) => e.name === 'work-item/created')!
      .data as WorkItemCreatedData;
    const before = await snapshot(workItemId!);
    vi.mocked(getJob).mockResolvedValue({
      jobId: 'job_author_1',
      status: 'running',
      result: null,
      error: null,
    });

    const outcome = await new JobTestEngine({
      function: monitorBugEnrichOnCreated,
      events: [{ name: 'work-item/created', data: event }],
    }).execute();

    expect(outcome.result).toMatchObject({
      dispatch: { dispatched: true },
      applied: { status: 'skipped', reason: 'timed-out' },
    });
    // Bounded: exactly the named number of reads, and no second dispatch.
    expect(getJob).toHaveBeenCalledTimes(MONITOR_AUTHORING_POLLS);
    expect(submitJob).toHaveBeenCalledTimes(1);
    expect(await snapshot(workItemId!)).toEqual(before);
  });

  it('ONE failing field aborts the whole apply — storyPoints: 4 writes nothing at all', async () => {
    const { target } = await seed();
    const { workItemId, event } = await fileAndDispatch(target, 'four-1');
    const before = await snapshot(workItemId);
    succeeds({ ...ANSWER, storyPoints: 4 });
    await expect(
      monitorBugEnrichmentService.applyAuthoredBug(event, 'job_author_1'),
    ).resolves.toEqual({
      status: 'skipped',
      reason: 'invalid-answer',
    });
    expect(await snapshot(workItemId)).toEqual(before);
  });
});

describe('THE WHOLE FUNCTION — dispatch, wait, land', () => {
  it('one run of the job dispatches, reads the finished job and lands the answer', async () => {
    const { target } = await seed();
    const from = cap.events.length;
    const seeded: FakeMonitorIssue = {
      externalId: 'whole-1',
      title: 'TypeError in export',
      culprit: 'lib/services/exportService.ts in toCsv',
      level: 'error',
      eventCount: 3,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      permalink: null,
      assignee: null,
    };
    fakeMonitorState().issues = [seeded];
    const { workItemId } = await monitorIngestionService.reconcileIssue(target, seeded, null);
    const event = cap.events.slice(from).find((e) => e.name === 'work-item/created')!
      .data as WorkItemCreatedData;

    const outcome = await new JobTestEngine({
      function: monitorBugEnrichOnCreated,
      events: [{ name: 'work-item/created', data: event }],
    }).execute();

    expect(outcome.result).toMatchObject({ applied: { status: 'applied' } });
    const bug = await read(workItemId!);
    expect(bug.descriptionMd).toBe(DESCRIPTION);
    expect(bug.explanationSource).toBe('ai_draft');
  });
});
