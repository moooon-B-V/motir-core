import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `POST /api/ai/ask` with `runJobId` + `planId` (MOTIR-7996) — the route half of
// the mid-run door: HTTP only, one service call, the mismatch a no-existence-leak
// 404 raised BEFORE any turn is appended or any job submitted. The service's own
// behaviour is `tests/integration/planning/midRunAsk.test.ts`; the harness is
// `askRoutes.test.ts`'s.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const submitJobMock = vi.fn(async () => ({ jobId: 'job-ask-1' }));
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
  getJob: vi.fn(),
  streamJob: vi.fn(),
}));
vi.mock('@/lib/services/planReviewService', () => ({
  planReviewService: {
    getPlanReview: async () => {
      throw Object.assign(new Error('nope'), { code: 'PLAN_NOT_FOUND' });
    },
  },
}));

const { POST: ask } = await import('@/app/api/ai/ask/route');

function askReq(body: unknown): Request {
  return new Request('http://localhost:3000/api/ai/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let fx: WorkItemFixture;
let sessionId: string;

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockClear();
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = {
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
      lastJobId: 'job-run-1',
      lastSubmittedAt: new Date(),
    },
  });
  sessionId = row.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('POST /api/ai/ask — a mid-run turn', () => {
  it('submits the turn with its run and answers the ask submit shape', async () => {
    const res = await ask(
      askReq({ body: 'how far along?', sessionId, runJobId: 'job-run-1', planId: 'plan-1' }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ jobId: 'job-ask-1' });
    // The plan could not be read: the job still ran, as an unreadable run.
    const context = (submitJobMock.mock.calls[0] as unknown as unknown[])[2] as {
      run: { readable: boolean; reason: string };
    };
    expect(context.run).toMatchObject({ readable: false, reason: 'PLAN_NOT_FOUND' });
    const turns = await adminDb.planChangeTurn.findMany({ where: { sessionId } });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ runJobId: 'job-run-1', intent: 'ask' });
  });

  it('404s a runJobId that is not the session lastJobId, before any write', async () => {
    const res = await ask(
      askReq({ body: 'hello', sessionId, runJobId: 'job-someone-elses', planId: 'plan-1' }),
    );

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('PLAN_CHANGE_MAILBOX_JOB_MISMATCH');
    expect(await adminDb.planChangeTurn.count({ where: { sessionId } })).toBe(0);
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('400s a mid-run turn that names no session', async () => {
    const res = await ask(askReq({ body: 'hello', runJobId: 'job-run-1', planId: 'plan-1' }));

    expect(res.status).toBe(400);
    expect(submitJobMock).not.toHaveBeenCalled();
  });
});
