import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// Route-level tests for the CONTEXTUAL-PLANNING endpoints (7.12.3 · MOTIR-909) —
// `POST /api/work-items/[id]/ai/plan` and
// `GET /api/work-items/[id]/ai/plan/[jobId]/stream`.
//
// The companion service test proves the scoping + session mechanics. This file
// proves what only the ROUTE owns: the session gate (401), the active-project
// gate (404), body validation (400), the typed-error → status mapping (404 for a
// target that does not resolve in this tenant — never 403; 400 for too many
// targets; 402/502 for the metered motir-ai path), and that the SSE channel
// returns a real HTTP status when the boundary fails rather than a 200 whose body
// immediately errors.
//
// Per the motir-core convention only the boundary client + the two context
// resolvers the test env cannot supply with no cookies (`getSession`,
// `getActiveProject`) are mocked; the whole service → repository → real-Postgres
// chain runs for real underneath.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const submitJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: 'job-contextual-1' }));
const streamJobMock = vi.fn();
const getJobMock = vi.fn(async () => ({
  jobId: 'job-contextual-1',
  status: 'running',
  result: null,
  error: null,
}));
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
  streamJob: (...args: unknown[]) => streamJobMock(...(args as [])),
  getJob: (...args: unknown[]) => getJobMock(...(args as [])),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  refreshCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  indexCodeGraph: vi.fn(),
  getPreplanState: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

// Import the handlers AFTER the mocks are registered.
const { POST: plan, GET: resume } = await import('@/app/api/work-items/[id]/ai/plan/route');
const { GET: stream } = await import('@/app/api/work-items/[id]/ai/plan/[jobId]/stream/route');
const { MotirAiOutOfCreditsError, MotirAiUnavailableError, MotirAiJobNotFoundError } =
  await import('@/lib/ai/errors');
const { MAX_SCOPE_TARGETS } = await import('@/lib/planChange/scope');

const BASE = 'http://localhost:3000';

function planReq(id: string, body: unknown, raw?: string): Request {
  return new Request(`${BASE}/api/work-items/${id}/ai/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}
const planParams = (id: string) => ({ params: Promise.resolve({ id }) });
const streamParams = (id: string, jobId: string) => ({ params: Promise.resolve({ id, jobId }) });

let fx: WorkItemFixture;
let story: Awaited<ReturnType<typeof createTestWorkItem>>;

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockClear();
  streamJobMock.mockClear();
  submitJobMock.mockResolvedValue({ jobId: 'job-contextual-1' });
  fx = await makeWorkItemFixture();
  story = await createTestWorkItem(fx, { kind: 'story', title: 'Billing' });
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

describe('POST /api/work-items/[id]/ai/plan — gates and validation', () => {
  it('401s without a session', async () => {
    session.current = null;
    const res = await plan(planReq(story.id, { prompt: 'x' }), planParams(story.id));
    expect(res.status).toBe(401);
  });

  it('404s with no active project', async () => {
    activeCtx.current = null;
    const res = await plan(planReq(story.id, { prompt: 'x' }), planParams(story.id));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NO_ACTIVE_PROJECT' });
  });

  it('400s on malformed JSON, a missing prompt, and a blank one', async () => {
    const bad = [
      await plan(planReq(story.id, null, 'not json'), planParams(story.id)),
      await plan(planReq(story.id, {}), planParams(story.id)),
      await plan(planReq(story.id, { prompt: '   ' }), planParams(story.id)),
    ];
    for (const res of bad) expect(res.status).toBe(400);
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('400s on a targetKeys that is not an array of strings', async () => {
    // Coercing instead would plan against a set the user never picked.
    for (const targetKeys of ['MOTIR-1', [1, 2], [null]]) {
      const res = await plan(planReq(story.id, { prompt: 'x', targetKeys }), planParams(story.id));
      expect(res.status).toBe(400);
    }
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('400s when more targets are named than one thread may carry', async () => {
    const targetKeys = Array.from({ length: MAX_SCOPE_TARGETS }, (_, i) => `PROD-${i + 50}`);
    const res = await plan(planReq(story.id, { prompt: 'x', targetKeys }), planParams(story.id));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'PLAN_CHANGE_TOO_MANY_TARGETS' });
  });
});

describe('POST /api/work-items/[id]/ai/plan — the happy path', () => {
  it('returns { jobId, sessionId, session } and does not cache', async () => {
    const res = await plan(
      planReq(story.id, { prompt: 'Break this into subtasks' }),
      planParams(story.id),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');

    const body = (await res.json()) as {
      jobId: string;
      sessionId: string;
      session: { targetKeys: string[]; turns: Array<{ role: string; body: string }> };
    };
    expect(body.jobId).toBe('job-contextual-1');
    expect(body.sessionId).toBeTruthy();
    expect(body.session.targetKeys).toEqual([story.identifier]);
    expect(body.session.turns.map((t) => t.role)).toEqual(['user', 'system']);
  });

  it('carries the multi-target set through to the submitted job', async () => {
    const other = await createTestWorkItem(fx, { kind: 'story', title: 'Auth' });
    const res = await plan(
      planReq(story.id, { prompt: 'Merge these', targetKeys: [other.identifier] }),
      planParams(story.id),
    );
    expect(res.status).toBe(200);
    const context = submitJobMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(context['targetKeys']).toEqual([story.identifier, other.identifier].sort());
  });

  it('404s on a target from another tenant — never 403', async () => {
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const theirs = await createTestWorkItem(rival, { kind: 'story', title: 'Theirs' });
    const res = await plan(planReq(theirs.id, { prompt: 'x' }), planParams(theirs.id));
    expect(res.status).toBe(404);
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('maps the metered-AI failures the way every plan-edit surface does', async () => {
    submitJobMock.mockRejectedValueOnce(new MotirAiOutOfCreditsError('no credits'));
    expect((await plan(planReq(story.id, { prompt: 'x' }), planParams(story.id))).status).toBe(402);

    submitJobMock.mockRejectedValueOnce(new MotirAiUnavailableError('down'));
    expect((await plan(planReq(story.id, { prompt: 'x' }), planParams(story.id))).status).toBe(502);
  });
});

describe('GET /api/work-items/[id]/ai/plan/[jobId]/stream', () => {
  it('401s without a session and 404s with no active project', async () => {
    session.current = null;
    expect((await stream(new Request(BASE), streamParams(story.id, 'j1'))).status).toBe(401);

    session.current = { user: { id: fx.ownerId, email: 'o@e.com', name: 'O' } };
    activeCtx.current = null;
    expect((await stream(new Request(BASE), streamParams(story.id, 'j1'))).status).toBe(404);
  });

  it('404s when the anchor does not resolve in this tenant, without touching motir-ai', async () => {
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const theirs = await createTestWorkItem(rival, { kind: 'story', title: 'Theirs' });
    const res = await stream(new Request(BASE), streamParams(theirs.id, 'j1'));
    expect(res.status).toBe(404);
    expect(streamJobMock).not.toHaveBeenCalled();
  });

  it('relays the job events as SSE', async () => {
    streamJobMock.mockReturnValue(
      (async function* () {
        yield { event: 'progress', data: { pct: 10 } };
        yield { event: 'status', data: { status: 'succeeded' } };
      })(),
    );

    const res = await stream(new Request(BASE), streamParams(story.id, 'job-contextual-1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    const text = await res.text();
    expect(text).toContain('event: progress');
    expect(text).toContain('"pct":10');
    expect(text).toContain('event: status');
  });

  it('surfaces a boundary failure as a real HTTP status, not a 200 that errors', async () => {
    // The reason the route pulls the FIRST event before returning the stream.
    streamJobMock.mockReturnValue(
      (async function* () {
        throw new MotirAiJobNotFoundError('nope');

        yield { event: 'progress', data: {} };
      })(),
    );
    const res = await stream(new Request(BASE), streamParams(story.id, 'missing'));
    expect(res.status).toBe(404);

    streamJobMock.mockReturnValue(
      (async function* () {
        throw new MotirAiUnavailableError('down');

        yield { event: 'progress', data: {} };
      })(),
    );
    expect((await stream(new Request(BASE), streamParams(story.id, 'j1'))).status).toBe(502);
  });
});

// ─── The two NON-submitting halves the entrance added (MOTIR-910) ─────────────
//
// `GET` resumes the item's thread on mount; `{ resubmit: true }` re-sends what
// the thread already accumulated (the rail's Retry). Both are additive: the
// shipped `{ prompt }` submit above is unchanged, and a body with neither is
// still a 400 (proved by the validation block above).

function resumeReq(id: string, targetKeys: string[] = []): Request {
  const qs = targetKeys.map((k) => `targetKey=${encodeURIComponent(k)}`).join('&');
  return new Request(`${BASE}/api/work-items/${id}/ai/plan${qs ? `?${qs}` : ''}`);
}

describe('GET /api/work-items/[id]/ai/plan — resume the item’s thread', () => {
  it('401s without a session and 404s with no active project', async () => {
    session.current = null;
    expect((await resume(resumeReq(story.id), planParams(story.id))).status).toBe(401);

    session.current = { user: { id: fx.ownerId, email: 'o@e.com', name: 'O' } };
    activeCtx.current = null;
    expect((await resume(resumeReq(story.id), planParams(story.id))).status).toBe(404);
  });

  it('returns { session: null } for an item never planned — and submits nothing', async () => {
    const res = await resume(resumeReq(story.id), planParams(story.id));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ session: null });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('returns the thread once a turn has been submitted', async () => {
    await plan(planReq(story.id, { prompt: 'Break this up' }), planParams(story.id));

    const res = await resume(resumeReq(story.id), planParams(story.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: { targetKeys: string[]; turns: Array<{ role: string; body: string }> } | null;
    };
    expect(body.session?.targetKeys).toEqual([story.identifier]);
    expect(body.session?.turns.map((t) => t.role)).toEqual(['user', 'system']);
  });

  it('400s on a repeated targetKey list that is not work-item identifiers', async () => {
    // The query form of the same defensive parse the POST body gets.
    const res = await resume(
      new Request(`${BASE}/api/work-items/${story.id}/ai/plan?targetKey=`),
      planParams(story.id),
    );
    // A blank target is dropped by the scope canonicalization, not a 400 — what
    // must never happen is adopting an unresolvable one.
    expect(res.status).toBe(200);
  });

  it('404s on an item from another tenant — never 403', async () => {
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const theirs = await createTestWorkItem(rival, { kind: 'story', title: 'Theirs' });
    const res = await resume(resumeReq(theirs.id), planParams(theirs.id));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/work-items/[id]/ai/plan — { resubmit: true }', () => {
  it('re-sends the accumulated intent with no new turn', async () => {
    await plan(planReq(story.id, { prompt: 'Break this up' }), planParams(story.id));
    submitJobMock.mockResolvedValueOnce({ jobId: 'job-contextual-2' });

    const res = await plan(planReq(story.id, { resubmit: true }), planParams(story.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jobId: string;
      session: { turns: Array<{ role: string; body: string }> };
    };
    expect(body.jobId).toBe('job-contextual-2');
    expect(body.session.turns.filter((t) => t.role === 'user').map((t) => t.body)).toEqual([
      'Break this up',
    ]);
    expect(submitJobMock).toHaveBeenCalledTimes(2);
  });

  it('still 400s when a body carries neither a prompt nor a resubmit flag', async () => {
    // The shipped contract is untouched: `resubmit` must be exactly `true`.
    for (const body of [{}, { resubmit: false }, { resubmit: 'yes' }]) {
      const res = await plan(planReq(story.id, body), planParams(story.id));
      expect(res.status).toBe(400);
    }
    expect(submitJobMock).not.toHaveBeenCalled();
  });
});
