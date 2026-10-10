import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { plansService } from '@/lib/services/plansService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE PLANNER'S MID-RUN PAUSE (Story MOTIR-7990 · MOTIR-8007) — the run records a
// re-plan verdict as a START OVER offer or an unclear verdict as a question, and the
// person's answer rides the shipped mailbox. Real Postgres for the session, the
// mailbox, the plan and the pause; only the motir-ai `getJob` boundary is mocked.

const RUN_JOB = 'job-run-1';

const jobs = new Map<string, unknown>();
const submitJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: async (jobId: string) =>
    jobs.get(jobId) ?? { jobId, status: 'running', result: null, error: null },
  streamJob: vi.fn(),
}));

const { planChangeRunPauseService, PAUSE_DECLINE_INSTRUCTION } =
  await import('@/lib/services/planChangeRunPauseService');
const { planChangeMailboxService } = await import('@/lib/services/planChangeMailboxService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { pendingQuestion } = await import('@/lib/planning/planChangeThread');

let fx: WorkItemFixture;
let ctx: ProjectContext;
let sessionId: string;
let planId: string;
let changeIds: string[];

function setRun(status: 'running' | 'succeeded' | 'failed' | 'canceled') {
  jobs.set(RUN_JOB, { jobId: RUN_JOB, status, result: null, error: null });
}

async function forward(body: string, key: string): Promise<string> {
  await planChangeMailboxService.attachTurn(
    { jobId: RUN_JOB, sessionId, body, idempotencyKey: key },
    ctx,
  );
  const id = await planChangeMailboxService.entryIdForKey(RUN_JOB, sessionId, key, ctx);
  return id!;
}

function record(over: Record<string, unknown> = {}) {
  return planChangeRunPauseService.recordPause(
    {
      jobId: RUN_JOB,
      kind: 'replan',
      changeTurnIds: changeIds,
      reason: 'This reshapes the whole tree.',
      idempotencyKey: 'pk-1',
      ...over,
    } as Parameters<typeof planChangeRunPauseService.recordPause>[0],
    ctx,
  );
}

function answer(pauseId: string, choice: 'start_over' | 'apply' | 'reply', text?: string) {
  return planChangeRunPauseService.answer(
    { sessionId, jobId: RUN_JOB, pauseId, choice, text },
    ctx,
  );
}

async function entries() {
  return adminDb.planChangeMailboxEntry.findMany({ where: { sessionId }, orderBy: { seq: 'asc' } });
}

beforeEach(async () => {
  jobs.clear();
  submitJobMock.mockReset();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  ctx = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
  const row = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ownerId,
      lastJobId: RUN_JOB,
      lastSubmittedAt: new Date(),
    },
  });
  sessionId = row.id;
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'The run plan', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  planId = plan.id;
  await adminDb.plan.update({ where: { id: planId }, data: { sourceJobId: RUN_JOB, sessionId } });
  setRun('running');
  changeIds = [
    await forward('Drop the payments epic.', 'c1'),
    await forward('And rename checkout.', 'c2'),
  ];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('recording a pause', () => {
  it('records a replan with its reason, bound to the job session', async () => {
    const { outcome, pause } = await record();

    expect(outcome).toBe('recorded');
    expect(pause).toMatchObject({
      kind: 'replan',
      jobId: RUN_JOB,
      reason: 'This reshapes the whole tree.',
      question: null,
      answer: null,
      delivery: 'pending',
      changeTurnIds: changeIds,
    });
    const row = await adminDb.planChangeRunPause.findUniqueOrThrow({ where: { id: pause.id } });
    expect(row.sessionId).toBe(sessionId);
  });

  it('records an unclear with its question', async () => {
    const { outcome, pause } = await record({
      kind: 'unclear',
      reason: undefined,
      question: 'Which checkout do you mean?',
    });

    expect(outcome).toBe('recorded');
    expect(pause).toMatchObject({
      kind: 'unclear',
      question: 'Which checkout do you mean?',
      reason: null,
    });
  });

  it('the same key returns the same pause and creates no row; a different key is already_open', async () => {
    const first = await record();
    const again = await record();
    expect(again).toMatchObject({ outcome: 'recorded', pause: { id: first.pause.id } });

    const other = await record({
      kind: 'unclear',
      reason: undefined,
      question: 'Which one?',
      idempotencyKey: 'pk-2',
    });
    expect(other).toMatchObject({ outcome: 'already_open', pause: { id: first.pause.id } });
    expect(await adminDb.planChangeRunPause.count()).toBe(1);
  });

  it('a new pause is allowed once the open one is answered', async () => {
    const first = await record();
    await answer(first.pause.id, 'apply');

    const next = await record({ idempotencyKey: 'pk-2' });

    expect(next.outcome).toBe('recorded');
    expect(next.pause.id).not.toBe(first.pause.id);
  });

  it('refuses a terminal job, writing no row', async () => {
    setRun('succeeded');
    await expect(record()).rejects.toMatchObject({ code: 'PLAN_CHANGE_JOB_NOT_RUNNING' });
    expect(await adminDb.planChangeRunPause.count()).toBe(0);
  });

  it.each(['approved', 'declined'] as const)(
    'refuses a %s plan, writing no row',
    async (status) => {
      await adminDb.plan.update({ where: { id: planId }, data: { status } });
      await expect(record()).rejects.toMatchObject({ code: 'PLAN_CHANGE_RUN_PAUSE_PLAN_DECIDED' });
      expect(await adminDb.planChangeRunPause.count()).toBe(0);
    },
  );

  it('refuses a change turn from another job, writing no row', async () => {
    await adminDb.planChangeMailboxEntry.create({
      data: {
        workspaceId: fx.workspaceId,
        sessionId,
        jobId: 'job-other',
        seq: 0,
        kind: 'turn',
        body: 'elsewhere',
        disposition: 'fold',
        idempotencyKey: 'x',
      },
    });
    const foreign = (await adminDb.planChangeMailboxEntry.findFirstOrThrow({
      where: { jobId: 'job-other' },
    }))!.id;

    await expect(record({ changeTurnIds: [foreign] })).rejects.toMatchObject({
      code: 'PLAN_CHANGE_RUN_PAUSE_TURN_MISMATCH',
    });
    expect(await adminDb.planChangeRunPause.count()).toBe(0);
  });

  it('refuses a kind without its own text, or with the other kind’s', async () => {
    for (const bad of [
      { kind: 'unclear', reason: undefined, question: undefined },
      { kind: 'replan', reason: undefined },
      { kind: 'replan', question: 'both?' },
      { kind: 'unclear', reason: 'both', question: 'q' },
    ]) {
      await expect(record(bad)).rejects.toMatchObject({ code: 'PLAN_CHANGE_RUN_PAUSE_SHAPE' });
    }
    expect(await adminDb.planChangeRunPause.count()).toBe(0);
  });

  it('refuses a job with no thread on this project', async () => {
    await expect(record({ jobId: 'job-nobody' })).rejects.toMatchObject({
      code: 'PLAN_CHANGE_MAILBOX_JOB_MISMATCH',
    });
  });

  it('writes no PlanChangeTurn, no question, and submits no job', async () => {
    await record({ kind: 'unclear', reason: undefined, question: 'Which one?' });

    const session = await planChangeSessionsService.getById(ctx, sessionId);
    expect(session.turns.filter((t) => t.question)).toEqual([]);
    expect(pendingQuestion(session.turns)).toBeNull();
    expect(submitJobMock).not.toHaveBeenCalled();
  });
});

describe('answering a replan', () => {
  it('YES writes exactly one restart turn with the change bodies, delivered in the shipped shape', async () => {
    const { pause } = await record();
    const before = (await entries()).length;

    const result = await answer(pause.id, 'start_over');

    expect(result.outcome).toBe('answered');
    const written = (await entries()).slice(before);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      kind: 'turn',
      disposition: 'restart',
      restartTarget: null,
      body: 'Drop the payments epic.\n\nAnd rename checkout.',
      declinesPauseId: null,
      answersPauseId: null,
    });
    const read = await planChangeRunPauseService.latestForSession(sessionId, ctx);
    expect(read).toMatchObject({
      answer: 'start_over',
      delivery: 'delivered',
    });
    expect(
      (await adminDb.planChangeRunPause.findUniqueOrThrow({ where: { id: pause.id } }))
        .mailboxEntryId,
    ).toBe(written[0]!.id);
    // The boundary read: the restart turn carries NEITHER new key.
    const delivery = await planChangeMailboxService.readForBoundary(RUN_JOB, ctx);
    const restart = delivery.turns.find((t) => t.id === written[0]!.id)!;
    expect(Object.keys(restart).sort()).toEqual([
      'disposition',
      'id',
      'receivedAt',
      'target',
      'text',
    ]);
    expect(restart.disposition).toBe('restart');
  });

  it('NO writes one fold turn marking the decline, with the fixed instruction and the bodies', async () => {
    const { pause } = await record();

    await answer(pause.id, 'apply');

    const decline = (await entries()).find((e) => e.declinesPauseId === pause.id)!;
    expect(decline).toMatchObject({
      disposition: 'fold',
      answersPauseId: null,
      body: `${PAUSE_DECLINE_INSTRUCTION}\n\nDrop the payments epic.\n\nAnd rename checkout.`,
    });
    const delivery = await planChangeMailboxService.readForBoundary(RUN_JOB, ctx);
    expect(delivery.turns.find((t) => t.id === decline.id)).toMatchObject({
      declinesPause: pause.id,
    });
    // A plain fold turn delivers byte-identically: no marker keys.
    const plain = delivery.turns.find((t) => t.text === 'Drop the payments epic.')!;
    expect(Object.keys(plain)).not.toContain('declinesPause');
    expect(Object.keys(plain)).not.toContain('answersQuestion');
  });

  it('never carries the planner’s reason into a written body', async () => {
    const { pause } = await record({ reason: 'REASON-SENTINEL-123' });
    await answer(pause.id, 'start_over');
    const other = await record({ idempotencyKey: 'pk-2', reason: 'REASON-SENTINEL-456' });
    await answer(other.pause.id, 'apply');

    for (const e of await entries()) expect(e.body ?? '').not.toContain('REASON-SENTINEL');
  });
});

describe('answering an unclear pause', () => {
  it('a reply writes one fold turn with the text verbatim, marked as the answer', async () => {
    const { pause } = await record({
      kind: 'unclear',
      reason: undefined,
      question: 'QUESTION-SENTINEL which one?',
    });

    const result = await answer(pause.id, 'reply', '  The new checkout, not the old.  ');

    expect(result.outcome).toBe('answered');
    const reply = (await entries()).find((e) => e.answersPauseId === pause.id)!;
    expect(reply).toMatchObject({ disposition: 'fold', body: 'The new checkout, not the old.' });
    expect(reply.body).not.toContain('QUESTION-SENTINEL');
    // Not read yet: the read door says so, for a rail that holds no live poll.
    expect(await planChangeRunPauseService.latestForSession(sessionId, ctx)).toMatchObject({
      entryRead: false,
    });
    const delivery = await planChangeMailboxService.readForBoundary(RUN_JOB, ctx);
    expect(delivery.turns.find((t) => t.id === reply.id)).toMatchObject({
      answersQuestion: pause.id,
    });
    expect(await planChangeRunPauseService.latestForSession(sessionId, ctx)).toMatchObject({
      answer: 'replied',
      replyText: 'The new checkout, not the old.',
      delivery: 'delivered',
      // The boundary read above consumed the entry: the run has read the answer.
      entryRead: true,
    });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('refuses a blank reply', async () => {
    const { pause } = await record({ kind: 'unclear', reason: undefined, question: 'Which?' });
    await expect(answer(pause.id, 'reply', '   ')).rejects.toMatchObject({
      code: 'PLAN_CHANGE_RUN_PAUSE_SHAPE',
    });
  });
});

describe('shapes stay apart', () => {
  it('refuses reply on a replan and start_over / apply on an unclear, writing nothing', async () => {
    const replan = await record();
    const before = (await entries()).length;
    await expect(answer(replan.pause.id, 'reply', 'hello')).rejects.toMatchObject({
      code: 'PLAN_CHANGE_RUN_PAUSE_SHAPE',
    });
    await adminDb.planChangeRunPause.delete({ where: { id: replan.pause.id } });
    const unclear = await record({
      kind: 'unclear',
      reason: undefined,
      question: 'Which?',
      idempotencyKey: 'pk-2',
    });
    for (const choice of ['start_over', 'apply'] as const) {
      await expect(answer(unclear.pause.id, choice)).rejects.toMatchObject({
        code: 'PLAN_CHANGE_RUN_PAUSE_SHAPE',
      });
    }
    expect((await entries()).length).toBe(before);
    expect(
      (await adminDb.planChangeRunPause.findUniqueOrThrow({ where: { id: unclear.pause.id } }))
        .answer,
    ).toBeNull();
  });
});

describe('replay and race', () => {
  it('replaying the same answer writes no second entry and returns the same pause', async () => {
    const { pause } = await record();
    await answer(pause.id, 'apply');
    const count = (await entries()).length;

    const again = await answer(pause.id, 'apply');

    expect(again).toMatchObject({ outcome: 'answered', pause: { id: pause.id, answer: 'apply' } });
    expect((await entries()).length).toBe(count);
  });

  it('a different answer after an answer is a 409 carrying the stored answer, writing nothing', async () => {
    const { pause } = await record();
    await answer(pause.id, 'apply');
    const count = (await entries()).length;

    await expect(answer(pause.id, 'start_over')).rejects.toMatchObject({
      code: 'PLAN_CHANGE_RUN_PAUSE_ANSWERED',
      answer: 'apply',
    });
    expect((await entries()).length).toBe(count);
  });

  it('two concurrent different answers produce one mailbox entry and one recorded answer', async () => {
    const { pause } = await record();
    const before = (await entries()).length;

    const settled = await Promise.allSettled([
      answer(pause.id, 'start_over'),
      answer(pause.id, 'apply'),
    ]);

    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(1);
    expect((await entries()).length - before).toBe(1);
    const row = await adminDb.planChangeRunPause.findUniqueOrThrow({ where: { id: pause.id } });
    expect(['start_over', 'apply']).toContain(row.answer);
  });
});

describe('after the run ended', () => {
  it('records the answer, writes no entry, and returns the typed refusal with the choice and text', async () => {
    const { pause } = await record({ kind: 'unclear', reason: undefined, question: 'Which?' });
    setRun('succeeded');
    const before = (await entries()).length;

    const result = await answer(pause.id, 'reply', 'The new one.');

    expect(result).toMatchObject({
      outcome: 'refused',
      code: 'PLAN_CHANGE_JOB_NOT_RUNNING',
      jobStatus: 'succeeded',
      choice: 'reply',
      text: 'The new one.',
    });
    expect((await entries()).length).toBe(before);
    expect(await planChangeRunPauseService.latestForSession(sessionId, ctx)).toMatchObject({
      answer: 'replied',
      replyText: 'The new one.',
      delivery: 'refused',
      refusedCode: 'PLAN_CHANGE_JOB_NOT_RUNNING',
    });
  });
});

describe('no existence leak', () => {
  it('404s a pauseId from another job, and a session that is not the job’s thread, before any write', async () => {
    const { pause } = await record();
    const other = await adminDb.planChangeSession.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        createdById: fx.ownerId,
        lastJobId: 'job-other',
        lastSubmittedAt: new Date(),
      },
    });
    const before = (await entries()).length;

    await expect(
      planChangeRunPauseService.answer(
        { sessionId: other.id, jobId: 'job-other', pauseId: pause.id, choice: 'apply' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'PLAN_CHANGE_RUN_PAUSE_NOT_FOUND' });
    await expect(
      planChangeRunPauseService.answer(
        { sessionId: other.id, jobId: RUN_JOB, pauseId: pause.id, choice: 'apply' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'PLAN_CHANGE_MAILBOX_JOB_MISMATCH' });
    expect((await entries()).length).toBe(before);
    expect(
      (await adminDb.planChangeRunPause.findUniqueOrThrow({ where: { id: pause.id } })).answer,
    ).toBeNull();
  });
});

describe('the session DTO', () => {
  it('carries runPause: null, then unanswered, then answered with its delivery state', async () => {
    expect((await planChangeSessionsService.getById(ctx, sessionId)).runPause).toBeNull();

    const { pause } = await record();
    const open = (await planChangeSessionsService.getById(ctx, sessionId)).runPause;
    expect(open).toMatchObject({
      id: pause.id,
      kind: 'replan',
      reason: 'This reshapes the whole tree.',
      answer: null,
      delivery: 'pending',
    });
    expect(await planChangeRunPauseService.latestForSession(sessionId, ctx)).toEqual(open);

    await answer(pause.id, 'apply');
    expect((await planChangeSessionsService.getById(ctx, sessionId)).runPause).toMatchObject({
      answer: 'apply',
      delivery: 'delivered',
    });
  });
});
