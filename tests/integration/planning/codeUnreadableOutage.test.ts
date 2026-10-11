import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import {
  MALFORMED_RESULTS,
  PLAN_WRITING_KINDS,
  askAnswered,
  askAnsweredWithoutCode,
  ordinaryPlannerTurn,
  planWritingHalt,
  planWritingHaltWithdrawn,
} from '../../fixtures/codeUnreadable/envelopes';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addressOf, openTestSession } from '../../helpers/planSession';

// THE OUTAGE, MOTIR-CORE'S HALF, AS ONE CHAIN (Story MOTIR-8136 · MOTIR-8143).
//
//   job result → settle path → persisted assistant turn → DTO mapper → thread read
//
// Real Postgres end to end; the one mock is the motir-ai boundary (`submitJob` /
// `getJob`), the exception the repository's convention allows. The payloads are the
// recorded wire shapes in `tests/fixtures/codeUnreadable/`, not the sender's types.
//
// What this exists to catch is a face that is set in the settle branch and LOST in the
// row, the migration, the mapper or a reload — which no mocked-repository test can see.

const submitJobMock = vi.fn();
const jobs = new Map<string, unknown>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: async (jobId: string) =>
    jobs.get(jobId) ?? { jobId, status: 'running', result: null, error: null },
  streamJob: vi.fn(),
}));

const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { aiAskService } = await import('@/lib/services/aiAskService');

let fx: WorkItemFixture;
let ctx: ProjectContext;
let address: { sessionId: string };
let jobSeq = 0;

function settleJob(jobId: string, result: unknown) {
  jobs.set(jobId, { jobId, status: 'succeeded', result, error: null });
}

/** One planning round: a user turn, a submit that mints the next job id. */
async function plannerRound(text: string): Promise<string> {
  const jobId = `job-plan-${++jobSeq}`;
  submitJobMock.mockResolvedValueOnce({ jobId });
  await planChangeSessionsService.appendTurn(text, ctx, address);
  await planChangeSessionsService.submit(ctx, address);
  return jobId;
}

/** Read the thread back FROM THE DATABASE, never from a settle's return value. */
async function thread() {
  return (await planChangeSessionsService.getById(ctx, address.sessionId)).turns;
}
const assistants = async () => (await thread()).filter((t) => t.role === 'assistant');

async function planRows() {
  return {
    plans: await adminDb.plan.count(),
    items: await adminDb.planItem.count(),
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  jobSeq = 0;
  jobs.clear();
  submitJobMock.mockReset();
  fx = await makeWorkItemFixture();
  ctx = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
  address = addressOf(await openTestSession(ctx));
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('case 1 — a plan-writing halt settles as ONE declined turn and writes nothing', () => {
  it.each(PLAN_WRITING_KINDS)('%s', async (kind) => {
    const jobId = await plannerRound('add payments');
    settleJob(jobId, planWritingHalt(kind));
    const before = await planRows();

    await planChangeSessionsService.recordPlannerTurn(jobId, ctx, address);

    const turns = await assistants();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.codeUnreadable).toBe('declined');
    expect(turns[0]!.jobId).toBe(jobId);
    expect(turns[0]!.question).toBeNull();
    // No plan and no proposal was created by the settle.
    expect(await planRows()).toEqual(before);
    // The turn is the outage face, not the failed-job body.
    expect(turns[0]!.body).not.toMatch(/didn.t go through/i);
  });

  it('is the same for a halt that took proposals back off the plan', async () => {
    const jobId = await plannerRound('add payments');
    settleJob(jobId, planWritingHaltWithdrawn('augment'));
    await planChangeSessionsService.recordPlannerTurn(jobId, ctx, address);
    expect((await assistants())[0]!.codeUnreadable).toBe('declined');
  });
});

describe('case 2 — a question answered without the code keeps its answer', () => {
  it('stores the face `answered` and leaves the answer text and citations unchanged', async () => {
    const jobId = `job-ask-${++jobSeq}`;
    submitJobMock.mockResolvedValueOnce({ jobId });
    await aiAskService.submitTurn('how is billing wired?', ctx, address);
    settleJob(jobId, askAnsweredWithoutCode('Billing runs through the invoice service.', []));

    const result = await aiAskService.settle(jobId, ctx, address);

    expect(result.outcome).toBe('answered');
    const [turn] = await assistants();
    expect(turn!.codeUnreadable).toBe('answered');
    expect(turn!.body).toBe('Billing runs through the invoice service.');
    expect(turn!.citations).toEqual([]);
  });
});

describe('case 3 — no signal, no face', () => {
  it('an ordinary plan result settles with a null face', async () => {
    const jobId = await plannerRound('add payments');
    settleJob(jobId, ordinaryPlannerTurn('I drafted a plan.'));
    await planChangeSessionsService.recordPlannerTurn(jobId, ctx, address);
    const [turn] = await assistants();
    expect(turn!.codeUnreadable).toBeNull();
    expect(turn!.body).toBe('I drafted a plan.');
  });

  it('an ordinary answer settles with a null face', async () => {
    const jobId = `job-ask-${++jobSeq}`;
    submitJobMock.mockResolvedValueOnce({ jobId });
    await aiAskService.submitTurn('how is billing wired?', ctx, address);
    settleJob(jobId, askAnswered('Billing runs through the invoice service.'));
    await aiAskService.settle(jobId, ctx, address);
    expect((await assistants())[0]!.codeUnreadable).toBeNull();
  });

  it.each(MALFORMED_RESULTS)('%s settles as it always did', async (_label, result) => {
    const jobId = await plannerRound('add payments');
    settleJob(jobId, result);
    await planChangeSessionsService.recordPlannerTurn(jobId, ctx, address);
    for (const turn of await assistants()) expect(turn.codeUnreadable).toBeNull();
  });
});

describe('case 4 — each turn carries its own state; nothing is cleared retroactively', () => {
  it('two outage turns keep their faces after an ordinary turn settles', async () => {
    const first = await plannerRound('add payments');
    settleJob(first, planWritingHalt('augment'));
    await planChangeSessionsService.recordPlannerTurn(first, ctx, address);

    const second = await plannerRound('try the refunds epic');
    settleJob(second, planWritingHalt('augment'));
    await planChangeSessionsService.recordPlannerTurn(second, ctx, address);

    const third = await plannerRound('and now?');
    settleJob(third, ordinaryPlannerTurn('Here is the plan.'));
    await planChangeSessionsService.recordPlannerTurn(third, ctx, address);

    const turns = await assistants();
    expect(turns.map((t) => t.codeUnreadable)).toEqual(['declined', 'declined', null]);
    expect(turns.map((t) => t.jobId)).toEqual([first, second, third]);
  });

  it('creates no page-level or thread-level outage flag', async () => {
    const jobId = await plannerRound('add payments');
    settleJob(jobId, planWritingHalt('augment'));
    await planChangeSessionsService.recordPlannerTurn(jobId, ctx, address);

    const session = await planChangeSessionsService.getById(ctx, address.sessionId);
    expect(Object.keys(session).filter((k) => /unreadable|outage/i.test(k))).toEqual([]);
  });
});

describe('case 7 — a redelivered result leaves one turn and one face', () => {
  it('declined', async () => {
    const jobId = await plannerRound('add payments');
    settleJob(jobId, planWritingHalt('augment'));
    await planChangeSessionsService.recordPlannerTurn(jobId, ctx, address);
    await planChangeSessionsService.recordPlannerTurn(jobId, ctx, address);
    const turns = await assistants();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.codeUnreadable).toBe('declined');
  });

  it('answered', async () => {
    const jobId = `job-ask-${++jobSeq}`;
    submitJobMock.mockResolvedValueOnce({ jobId });
    await aiAskService.submitTurn('how is billing wired?', ctx, address);
    settleJob(jobId, askAnsweredWithoutCode('Billing runs through the invoice service.'));
    await aiAskService.settle(jobId, ctx, address);
    await aiAskService.settle(jobId, ctx, address);
    const turns = await assistants();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.codeUnreadable).toBe('answered');
  });
});

describe('the persisted column', () => {
  it('is null on a turn written without a face, in the row itself', async () => {
    const jobId = await plannerRound('add payments');
    settleJob(jobId, ordinaryPlannerTurn('Ordinary.'));
    await planChangeSessionsService.recordPlannerTurn(jobId, ctx, address);
    const rows = await adminDb.planChangeTurn.findMany({ where: { role: 'assistant' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeUnreadable).toBeNull();
  });
});
