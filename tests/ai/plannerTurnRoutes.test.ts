import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// Route-level tests for the PLANNER-TURN endpoint and the answer path
// (MOTIR-2226) — `POST /api/ai/plan-change/session/planner-turn` and the
// `isAnswer` half of `…/session/turns`.
//
// The companion service test proves the thread mechanics. This file proves what
// only the ROUTE owns — the session gate, the active-project gate, body
// validation, the motir-ai error mapping — and, in the last describe, drives the
// WHOLE loop the design's state C draws through the real handlers end to end:
// turn → submit → the planner asks → the answer → resumption. Only `getSession`
// / `getActiveProject` (no cookies in the test env) and the motir-ai boundary are
// mocked; the service → repository → real-Postgres chain runs for real.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const submitJobMock = vi.fn(async () => ({ jobId: 'job-augment-1' }));
const getJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
  getJob: (...args: unknown[]) => getJobMock(...(args as [])),
  streamJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  refreshCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getPreplanState: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

const { POST: openSession } = await import('@/app/api/ai/plan-change/session/route');
const { POST: appendTurn } = await import('@/app/api/ai/plan-change/session/turns/route');
const { POST: submit } = await import('@/app/api/ai/plan-change/session/submit/route');
const { POST: plannerTurn } = await import('@/app/api/ai/plan-change/session/planner-turn/route');
const { MotirAiJobNotFoundError, MotirAiUnavailableError } = await import('@/lib/ai/errors');

const BASE = 'http://localhost:3000';

function req(path: string, body: unknown, raw?: string): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}

const plannerReq = (body: unknown, raw?: string) =>
  req('/api/ai/plan-change/session/planner-turn', body, raw);
const turnReq = (body: unknown) => req('/api/ai/plan-change/session/turns', body);

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockClear();
  submitJobMock.mockResolvedValue({ jobId: 'job-augment-1' });
  getJobMock.mockReset();
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterAll(async () => {
  await db.$disconnect();
});

/** Open a thread, put a turn on it, and submit — the state the recording needs. */
async function submitted() {
  await openSession();
  await appendTurn(turnReq({ body: 'add payments' }));
  await submit();
}

describe('POST …/planner-turn — the gates', () => {
  it('401s with no session', async () => {
    session.current = null;
    const res = await plannerTurn(plannerReq({ jobId: 'job-augment-1' }));
    expect(res.status).toBe(401);
  });

  it('404s with no active project', async () => {
    activeCtx.current = null;
    const res = await plannerTurn(plannerReq({ jobId: 'job-augment-1' }));
    expect(res.status).toBe(404);
  });

  it('400s on invalid JSON and on a missing / non-string jobId', async () => {
    expect((await plannerTurn(plannerReq(null, '{not json'))).status).toBe(400);
    expect((await plannerTurn(plannerReq({}))).status).toBe(400);
    expect((await plannerTurn(plannerReq({ jobId: 42 }))).status).toBe(400);
    expect((await plannerTurn(plannerReq({ jobId: '' }))).status).toBe(400);
  });

  it('400s on a malformed targetKeys', async () => {
    const res = await plannerTurn(plannerReq({ jobId: 'j', anchorId: 'a', targetKeys: 'nope' }));
    expect(res.status).toBe(400);
  });
});

describe('POST …/planner-turn — motir-ai errors are MAPPED, never leaked', () => {
  it('404s an unknown job', async () => {
    await submitted();
    getJobMock.mockRejectedValue(new MotirAiJobNotFoundError('job-augment-1'));
    const res = await plannerTurn(plannerReq({ jobId: 'job-augment-1' }));
    expect(res.status).toBe(404);
  });

  it('502s a transport failure', async () => {
    await submitted();
    getJobMock.mockRejectedValue(new MotirAiUnavailableError('down'));
    const res = await plannerTurn(plannerReq({ jobId: 'job-augment-1' }));
    expect(res.status).toBe(502);
  });
});

describe('POST …/planner-turn — the happy path', () => {
  it('returns the thread with the planner’s turn on it', async () => {
    await submitted();
    getJobMock.mockResolvedValue({
      jobId: 'job-augment-1',
      status: 'succeeded',
      result: { turn: { action: 'draft', message: 'I searched the plan.', question: null } },
      error: null,
    });

    const res = await plannerTurn(plannerReq({ jobId: 'job-augment-1' }));
    expect(res.status).toBe(200);
    // Never cached: the thread is per-user state that changes on every turn.
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await res.json()) as PlanChangeSessionDto;
    expect(body.turns.map((t) => t.role)).toEqual(['user', 'system', 'assistant']);
  });
});

describe('POST …/planner-turn — the ANCHORED thread', () => {
  it('routes to the item’s conversation when an anchor is given', async () => {
    const { contextualPlanningService } = await import('@/lib/services/contextualPlanningService');
    const { workItemsService } = await import('@/lib/services/workItemsService');
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Billing' },
      fx.ctx,
    );
    const run = await contextualPlanningService.planFromWorkItem(
      { anchorId: story.id, prompt: 'add payments' },
      activeCtx.current!,
    );
    getJobMock.mockResolvedValue({
      jobId: run.jobId,
      status: 'succeeded',
      result: { turn: { action: 'draft', message: 'I searched Billing.', question: null } },
      error: null,
    });

    const res = await plannerTurn(
      plannerReq({ jobId: run.jobId, anchorId: story.id, targetKeys: [] }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as PlanChangeSessionDto;
    // The ITEM's thread, not the project-wide one — the route hands the anchor
    // set to the service that owns scope resolution and its view gate.
    expect(body.id).toBe(run.sessionId);
    expect(body.turns.filter((t) => t.role === 'assistant')).toHaveLength(1);
  });
});

describe('the ANSWER loop, end to end through the real routes', () => {
  it('a question, its answer, and planning resuming — as design state C draws it', async () => {
    // 1. The user asks for something underdetermined, and it is submitted.
    await submitted();

    // 2. The planner ASKS rather than guessing (MOTIR-2222's Gate 2).
    getJobMock.mockResolvedValue({
      jobId: 'job-augment-1',
      status: 'succeeded',
      result: {
        turn: {
          action: 'ask',
          message: 'When you say “add payments” — which direction?',
          question: 'Taking money in, or paying suppliers out?',
        },
      },
      error: null,
    });
    const asked = (await (
      await plannerTurn(plannerReq({ jobId: 'job-augment-1' }))
    ).json()) as PlanChangeSessionDto;

    const question = asked.turns.at(-1)!;
    expect(question.role).toBe('assistant');
    expect(question.question).toBe('Taking money in, or paying suppliers out?');

    // 3. The user ANSWERS through the ordinary turn route, from the answer bar.
    const answered = (await (
      await appendTurn(turnReq({ body: 'Taking money from customers.', isAnswer: true }))
    ).json()) as PlanChangeSessionDto;

    const reply = answered.turns.at(-1)!;
    // A normal user turn — not a paired or nested element — flagged as the reply.
    expect(reply.role).toBe('user');
    expect(reply.isAnswer).toBe(true);
    expect(reply.body).toBe('Taking money from customers.');

    // 4. Planning RESUMES: the answer joins the accumulated intent and goes out
    //    as an ordinary submit, on the same thread.
    submitJobMock.mockResolvedValue({ jobId: 'job-augment-2' });
    const resumed = (await (await submit()).json()) as { jobId: string };
    expect(resumed.jobId).toBe('job-augment-2');

    // The ACCUMULATED intent is what goes out — the answer joins the original
    // ask rather than replacing it, which is the whole point of a thread.
    const sentIntent = JSON.stringify(submitJobMock.mock.calls.at(-1) ?? []);
    expect(sentIntent).toContain('add payments');
    expect(sentIntent).toContain('Taking money from customers.');

    // 5. And the planner's SECOND turn lands without disturbing the first.
    getJobMock.mockResolvedValue({
      jobId: 'job-augment-2',
      status: 'succeeded',
      result: {
        turn: { action: 'draft', message: 'Understood — checkout it is.', question: null },
      },
      error: null,
    });
    const final = (await (
      await plannerTurn(plannerReq({ jobId: 'job-augment-2' }))
    ).json()) as PlanChangeSessionDto;

    expect(final.turns.map((t) => t.role)).toEqual([
      'user',
      'system',
      'assistant',
      'user',
      'system',
      'assistant',
    ]);
    // The question is still in the transcript exactly as it was asked — the
    // thread never rewrites itself.
    expect(final.turns[2]!.question).toBe('Taking money in, or paying suppliers out?');
    expect(final.turns.at(-1)!.question).toBeNull();
  });

  it('a turn that CHANGED THE SUBJECT is not recorded as an answer (state E)', async () => {
    await submitted();
    getJobMock.mockResolvedValue({
      jobId: 'job-augment-1',
      status: 'succeeded',
      result: { turn: { action: 'ask', message: 'Which direction?', question: 'in, or out?' } },
      error: null,
    });
    await plannerTurn(plannerReq({ jobId: 'job-augment-1' }));

    // No `isAnswer` — this is what every other entrance to the thread sends (the
    // MCP append tool, a second tab that never saw the question).
    const after = (await (
      await appendTurn(turnReq({ body: 'Actually — re-sequence Billing first.' }))
    ).json()) as PlanChangeSessionDto;

    expect(after.turns.at(-1)!.isAnswer).toBe(false);
    // Superseded, never dropped: the question is still there to be seen.
    expect(after.turns.some((t) => t.question === 'in, or out?')).toBe(true);
  });

  it('reads `isAnswer` STRICTLY — anything but true is not an answer', async () => {
    await openSession();
    const body = (await (
      await appendTurn(turnReq({ body: 'hello', isAnswer: 'yes' }))
    ).json()) as PlanChangeSessionDto;
    expect(body.turns[0]!.isAnswer).toBe(false);
  });
});
