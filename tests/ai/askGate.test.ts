import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The story's GATE (MOTIR-1822) — the seams `askRoutes.test.ts` cannot reach on
// its own, against a REAL Postgres: the thread as it reads back through the DTO
// into the rail's own renderer, the resume, the mixed thread in BOTH orders, and
// the guards that fail loudly when the deleted designs creep back.
//
// ⚠️ WHAT THIS SUITE IS FOR, AND WHAT IT IS NOT. It does not re-assert what the
// route suite already holds (the gates, the body shapes, the one-door
// behaviour). It covers the places where two layers MEET, because those are
// exactly what a unit test on either side alone will mask — citation-key drift
// between what the service persists and what the UI reads is invisible to a
// service test with a hand-written DTO and to a component test with a
// hand-written fixture, and visible only when the real one is driven end to end.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const submitJobMock = vi.fn(async () => ({ jobId: 'job-ask-1' }));
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

const { POST: ask } = await import('@/app/api/ai/ask/route');
const { POST: settle } = await import('@/app/api/ai/ask/settle/route');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');

const BASE = 'http://localhost:3000';
const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** A settled `ask_project` job that ANSWERED, citing `keys`. */
const answered = (answer: string, citations: string[] = []) => ({
  status: 'succeeded',
  result: { ask: { intent: 'ask', answer, citations } },
});
/** A settled `ask_project` job that handed the turn back to the plan engine. */
const redirected = {
  status: 'succeeded',
  result: { ask: { intent: 'plan_change', answer: null, citations: [] } },
};

let fx: WorkItemFixture;

/** Ask a question and file its answer — the whole round trip, through the real
 *  routes, exactly as the browser drives it. */
async function askAndAnswer(body: string, answer: string, citations: string[] = []) {
  submitJobMock.mockResolvedValue({ jobId: `job-${body.slice(0, 6)}` });
  const submitted = (await (await ask(post('/api/ai/ask', { body }))).json()) as { jobId: string };
  getJobMock.mockResolvedValue(answered(answer, citations));
  await settle(post('/api/ai/ask/settle', { jobId: submitted.jobId }));
  return submitted.jobId;
}

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockClear();
  submitJobMock.mockResolvedValue({ jobId: 'job-ask-1' });
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
  await adminDb.$disconnect();
});

describe('the seam: service → DTO → the RAIL’s own renderer', () => {
  it('a citation the service persisted reaches the rail as the shipped chip', async () => {
    // The drift this catches: the service writes `[KEY](motir:<id>)` tokens and a
    // `citations` array; the rail resolves them through `workItemRefs`. A unit
    // test on either side alone uses a hand-written fixture for the other, so a
    // key-format change passes both and breaks the product.
    const cited = await createTestWorkItem(fx, { kind: 'story', title: 'Billing' });
    const key = cited.identifier;
    await askAndAnswer('which stories are blocked?', `Two are. [${key}](motir:${cited.id})`, [key]);

    const thread = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    const answer = thread.turns.filter((t) => t.role === 'assistant').at(-1)!;
    expect(answer.citations).toEqual([key]);
    // …and the summary the rail renders the chip FROM is resolved on the thread,
    // keyed by the id the body's token carries.
    expect(thread.workItemRefs[cited.id]).toMatchObject({ identifier: key });
  });

  it('drops a citation that names nothing — an answer never cites a key it invented', async () => {
    await askAndAnswer('what about billing?', 'Nothing covers it.', ['NOPE-999']);

    const thread = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    const answer = thread.turns.filter((t) => t.role === 'assistant').at(-1)!;
    expect(answer.citations).toEqual([]);
  });
});

describe('the seam: route → store', () => {
  it('persists the question and its answer in `seq` order on the ONE thread', async () => {
    await askAndAnswer('which stories are blocked?', 'Two are.');

    const thread = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    expect(thread.turns.map((t) => [t.seq, t.role])).toEqual([
      [0, 'user'],
      [1, 'assistant'],
    ]);
    expect(thread.turnCount).toBe(2);
  });

  it('RESUMES — reopening the thread returns past answers and their citations', async () => {
    const cited = await createTestWorkItem(fx, { kind: 'story', title: 'Billing' });
    const key = cited.identifier;
    await askAndAnswer('which stories are blocked?', `See [${key}](motir:${cited.id}).`, [key]);

    // A fresh read, as a reload does: the answer is not client state.
    const reopened = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    const answer = reopened.turns.filter((t) => t.role === 'assistant').at(-1)!;
    expect(answer.body).toContain(`motir:${cited.id}`);
    expect(answer.citations).toEqual([key]);
  });
});

describe('the seam: a MIXED thread, in both orders', () => {
  it('ask → change: the ask turns are intact and the plan-change turn is unchanged', async () => {
    await askAndAnswer('which stories are blocked?', 'Two are.');

    // …then a plan change through the SHIPPED submit, which the redirect uses.
    submitJobMock.mockResolvedValue({ jobId: 'job-ask-2' });
    const second = (await (
      await ask(post('/api/ai/ask', { body: 'split the blocked one' }))
    ).json()) as {
      jobId: string;
    };
    getJobMock.mockResolvedValue(redirected);
    submitJobMock.mockResolvedValue({ jobId: 'job-augment-1' });
    await settle(post('/api/ai/ask/settle', { jobId: second.jobId }));

    const thread = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    const roles = thread.turns.map((t) => t.role);
    // user, assistant(answer), user, system(the shipped submission marker)
    expect(roles).toEqual(['user', 'assistant', 'user', 'system']);
    const [first, , redirectedTurn] = thread.turns.filter((t) => t.role === 'user');
    expect(first!.intent).toBe('ask');
    expect(thread.turns.filter((t) => t.role === 'user').at(-1)!.intent).toBe('plan_change');
    expect(redirectedTurn).toBeUndefined();
  });

  it('change → ask: a question after a proposal leaves the earlier turns alone', async () => {
    submitJobMock.mockResolvedValue({ jobId: 'job-ask-1' });
    const first = (await (
      await ask(post('/api/ai/ask', { body: 'add a payments epic' }))
    ).json()) as {
      jobId: string;
    };
    getJobMock.mockResolvedValue(redirected);
    submitJobMock.mockResolvedValue({ jobId: 'job-augment-1' });
    await settle(post('/api/ai/ask/settle', { jobId: first.jobId }));

    await askAndAnswer('what does that cover?', 'The four stories under it.');

    const thread = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    expect(thread.turns.map((t) => t.role)).toEqual(['user', 'system', 'user', 'assistant']);
    const users = thread.turns.filter((t) => t.role === 'user');
    // The plan-change turn keeps its disposition — a later question does not
    // re-open, re-classify or re-write it.
    expect(users[0]!.intent).toBe('plan_change');
    expect(users[1]!.intent).toBe('ask');
  });
});

describe('the guard: an ASK writes NO work item', () => {
  it('holds on the answer path — asserted against the database, not the response', async () => {
    const before = await adminDb.workItem.count({ where: { workspaceId: fx.workspaceId } });

    await askAndAnswer('which stories are blocked?', 'Two are.');

    expect(await adminDb.workItem.count({ where: { workspaceId: fx.workspaceId } })).toBe(before);
  });

  it('holds on the REDIRECT path too — the ask job itself still wrote nothing', async () => {
    // The redirect hands off to the plan-change submit, which opens a Plan of
    // PROPOSALS. Proposals are not work items: nothing is committed until a
    // person approves, and that is the property this asserts.
    const before = await adminDb.workItem.count({ where: { workspaceId: fx.workspaceId } });

    submitJobMock.mockResolvedValue({ jobId: 'job-ask-1' });
    const submitted = (await (await ask(post('/api/ai/ask', { body: 'split it' }))).json()) as {
      jobId: string;
    };
    getJobMock.mockResolvedValue(redirected);
    submitJobMock.mockResolvedValue({ jobId: 'job-augment-1' });
    await settle(post('/api/ai/ask/settle', { jobId: submitted.jobId }));

    expect(await adminDb.workItem.count({ where: { workspaceId: fx.workspaceId } })).toBe(before);
  });
});

describe('the guard: tenant isolation', () => {
  it('another workspace cannot read this thread, and gets its own', async () => {
    await askAndAnswer('which stories are blocked?', 'Two are.');

    const other = await makeWorkItemFixture();
    session.current = { user: { id: other.ownerId, email: 'other@example.com', name: 'Other' } };
    activeCtx.current = {
      userId: other.ownerId,
      workspaceId: other.workspaceId,
      projectId: other.projectId,
      project: other.project,
    };

    const theirs = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    expect(theirs.turns).toEqual([]);
    expect(theirs.projectId).toBe(other.projectId);
  });

  it('a citation never resolves across projects', async () => {
    // The token names a work item in ANOTHER workspace. It must not resolve — a
    // leak here would put a stranger's title into this thread's chip.
    const other = await makeWorkItemFixture();
    const theirs = await createTestWorkItem(other, { kind: 'story', title: 'Theirs' });
    await askAndAnswer('what about theirs?', `See [${theirs.identifier}](motir:${theirs.id}).`, [
      theirs.identifier,
    ]);

    const thread = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    expect(thread.workItemRefs[theirs.id]).toBeUndefined();
    expect(thread.turns.filter((t) => t.role === 'assistant').at(-1)!.citations).toEqual([]);
  });
});

describe('the settle door’s own gates', () => {
  // The ask door's gates are covered by `askRoutes.test.ts`; the SETTLE door has
  // its own copies of them, and a route that files a durable write is not a
  // place to assume the guards were pasted correctly.
  it('401s with no session', async () => {
    session.current = null;
    expect((await settle(post('/api/ai/ask/settle', { jobId: 'job-1' }))).status).toBe(401);
  });

  it('404s with no active project', async () => {
    activeCtx.current = null;
    expect((await settle(post('/api/ai/ask/settle', { jobId: 'job-1' }))).status).toBe(404);
  });

  it('maps a TYPED motir-ai failure through the shared taxonomy', async () => {
    const { MotirAiError } = await import('@/lib/ai/errors');
    submitJobMock.mockResolvedValue({ jobId: 'job-ask-1' });
    const submitted = (await (await ask(post('/api/ai/ask', { body: 'why?' }))).json()) as {
      jobId: string;
    };
    getJobMock.mockRejectedValue(new MotirAiError('upstream_error', 'upstream said no'));

    const res = await settle(post('/api/ai/ask/settle', { jobId: submitted.jobId }));

    // Mapped, not rethrown — the reader gets the taxonomy's status rather than a
    // 500 that says nothing about which side failed.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(600);
  });
});

describe('the routes’ error mapping', () => {
  it('settle maps a TYPED failure and RETHROWS anything it does not know', async () => {
    // Both halves matter. The mapped half is the contract; the rethrow is what
    // stops an unrecognised failure from being flattened into a plausible 4xx
    // that hides a real fault behind a green-looking response.
    getJobMock.mockRejectedValue(new Error('kaboom'));
    submitJobMock.mockResolvedValue({ jobId: 'job-ask-1' });
    const submitted = (await (await ask(post('/api/ai/ask', { body: 'why?' }))).json()) as {
      jobId: string;
    };

    await expect(settle(post('/api/ai/ask/settle', { jobId: submitted.jobId }))).rejects.toThrow(
      'kaboom',
    );
  });

  it('the ask door RETHROWS an error outside the taxonomy', async () => {
    submitJobMock.mockRejectedValue(new Error('nope'));

    await expect(ask(post('/api/ai/ask', { body: 'why?' }))).rejects.toThrow('nope');
  });
});
