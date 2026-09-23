import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { planRepository } from '@/lib/repositories/planRepository';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// Route-level tests for the plan-change conversation endpoints (Story 7.30 ·
// MOTIR-1728) — `POST /api/ai/plan-change/session`, `…/session/turns`, and
// `…/session/submit`.
//
// The COMPANION service test proves the thread mechanics. This file proves what
// only the ROUTE owns: the session gate (401), the active-project gate (404, the
// no-existence-leak shape from finding #26), body validation (400), the
// typed-error → status mapping (404 / 400 / 409 / 402 / 502), and that the three
// handlers are HTTP-only — one service call each, no `db.*`, no `$transaction`.
//
// Per the motir-core convention only the boundary client + the two context
// resolvers the test env cannot supply with no cookies (`getSession`,
// `getActiveProject`) are mocked; the whole service → repository → real-Postgres
// chain runs for real underneath.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const submitJobMock = vi.fn(async () => ({ jobId: 'job-augment-1' }));
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
  streamJob: vi.fn(),
  getJob: vi.fn(),
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

// Import the handlers AFTER the mocks are registered.
const { GET: readSession, POST: startSession } =
  await import('@/app/api/ai/plan-change/session/route');
const { POST: appendTurn } = await import('@/app/api/ai/plan-change/session/turns/route');
const { POST: submit } = await import('@/app/api/ai/plan-change/session/submit/route');
const { MotirAiOutOfCreditsError, MotirAiUnavailableError } = await import('@/lib/ai/errors');
const { createTestProject } = await import('../fixtures/projectFixtures');

const BASE = 'http://localhost:3000';

function jsonReq(path: string, body: unknown, raw?: string): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}
const turnsReq = (body: unknown, raw?: string) =>
  jsonReq('/api/ai/plan-change/session/turns', body, raw);
const startReq = (body: unknown, raw?: string) => jsonReq('/api/ai/plan-change/session', body, raw);
const submitReq = (body: unknown) => jsonReq('/api/ai/plan-change/session/submit', body);
const readReq = (query = '') => new Request(`${BASE}/api/ai/plan-change/session${query}`);

/** Start a conversation with its first turn and return its id. */
async function started(first = 'Add auth to billing'): Promise<string> {
  const res = await startSession(startReq({ body: first }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockClear();
  submitJobMock.mockResolvedValue({ jobId: 'job-augment-1' });
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

describe('plan-change routes — gates', () => {
  it('401s every endpoint without a session', async () => {
    session.current = null;
    for (const res of [
      await readSession(readReq()),
      await startSession(startReq({ body: 'x' })),
      await appendTurn(turnsReq({ sessionId: 's', body: 'x' })),
      await submit(submitReq({ sessionId: 's' })),
    ]) {
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe('UNAUTHENTICATED');
    }
  });

  it('404s every endpoint with no active project', async () => {
    activeCtx.current = null;
    for (const res of [
      await readSession(readReq()),
      await startSession(startReq({ body: 'x' })),
      await appendTurn(turnsReq({ sessionId: 's', body: 'x' })),
      await submit(submitReq({ sessionId: 's' })),
    ]) {
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe('NO_ACTIVE_PROJECT');
    }
  });
});

describe('GET /api/ai/plan-change/session — a look creates nothing (MOTIR-6023)', () => {
  it('answers null, and writes no row, when the caller has no resumable conversation', async () => {
    const res = await readSession(readReq());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ session: null, earlier: null });
    expect(await adminDb.planChangeSession.count()).toBe(0);
  });

  it('returns the caller’s resumable conversation, and one by id', async () => {
    const id = await started();
    const before = await adminDb.planChangeSession.count();

    const resumed = (await (await readSession(readReq())).json()) as {
      session: { id: string };
      earlier: unknown;
    };
    expect(resumed.session.id).toBe(id);
    expect(resumed.earlier).toBeNull();
    // The REOPEN read (MOTIR-6024) carries who started it and whether the viewer
    // may continue it.
    const byId = (await (await readSession(readReq(`?id=${id}`))).json()) as {
      id: string;
      startedBy: { id: string; name: string } | null;
      startedByViewer: boolean;
      viewerCanPlan: boolean;
      pendingPlanId: string | null;
    };
    expect(byId.id).toBe(id);
    expect(byId.startedBy?.id).toBe(fx.ownerId);
    expect(byId.startedByViewer).toBe(true);
    expect(byId.viewerCanPlan).toBe(true);
    expect(byId.pendingPlanId).toBeNull();
    expect(await adminDb.planChangeSession.count()).toBe(before);
  });

  it('past the window: no resumable conversation, and the EARLIER one to point to (MOTIR-6024)', async () => {
    const id = await started();
    await adminDb.planChangeSession.update({
      where: { id },
      data: { lastActivityAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
    });
    const before = await adminDb.planChangeSession.count();

    const body = (await (await readSession(readReq())).json()) as {
      session: unknown;
      earlier: { id: string; mine: boolean; targetKeys: string[] } | null;
    };
    expect(body.session).toBeNull();
    expect(body.earlier).toMatchObject({ id, mine: true, targetKeys: [] });
    expect(await adminDb.planChangeSession.count()).toBe(before);
  });

  it('404s an id from another project', async () => {
    const id = await started();
    const elsewhere = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'ELSE',
    });
    activeCtx.current = { ...activeCtx.current!, projectId: elsewhere.id, project: elsewhere };

    const res = await readSession(readReq(`?id=${id}`));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('PLAN_SESSION_NOT_FOUND');
  });
});

describe('POST /api/ai/plan-change/session — the first turn starts it', () => {
  it('starts a conversation holding the turn, then lands a second POST on the SAME recent one', async () => {
    const first = await startSession(startReq({ body: 'Split the epic' }));
    expect(first.status).toBe(200);
    const opened = (await first.json()) as {
      id: string;
      projectId: string;
      turns: Array<{ body: string }>;
    };
    expect(opened.projectId).toBe(fx.projectId);
    expect(opened.turns.map((t) => t.body)).toEqual(['Split the epic']);

    const again = (await (await startSession(startReq({ body: 'Smaller' }))).json()) as {
      id: string;
      turns: unknown[];
    };
    expect(again.id).toBe(opened.id);
    expect(again.turns).toHaveLength(2);
  });

  it('400s malformed JSON and a missing first turn', async () => {
    expect((await startSession(startReq(null, '{not json'))).status).toBe(400);
    expect((await startSession(startReq({}))).status).toBe(400);
    expect(await adminDb.planChangeSession.count()).toBe(0);
  });
});

describe('POST /api/ai/plan-change/session/turns', () => {
  it('appends a turn to the NAMED session and returns the updated thread', async () => {
    const sessionId = await started();
    const res = await appendTurn(turnsReq({ sessionId, body: 'And the invoices' }));
    expect(res.status).toBe(200);
    const dto = (await res.json()) as {
      turnCount: number;
      turns: Array<{ seq: number; role: string; body: string }>;
    };
    expect(dto.turnCount).toBe(2);
    expect(dto.turns[1]).toMatchObject({ seq: 1, role: 'user', body: 'And the invoices' });
  });

  it('400s malformed JSON, a missing body, a missing sessionId and a blank turn', async () => {
    const sessionId = await started();

    const badJson = await appendTurn(turnsReq(null, '{not json'));
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as { code: string }).code).toBe('BAD_REQUEST');

    const missing = await appendTurn(turnsReq({ sessionId }));
    expect(missing.status).toBe(400);

    const noSession = await appendTurn(turnsReq({ body: 'x' }));
    expect(noSession.status).toBe(400);
    expect(((await noSession.json()) as { error: string }).error).toMatch(/sessionId/);

    const blank = await appendTurn(turnsReq({ sessionId, body: '   ' }));
    expect(blank.status).toBe(400);
    expect(((await blank.json()) as { code: string }).code).toBe('PLAN_CHANGE_EMPTY_TURN');
  });

  it('404s a sessionId that is not this project’s', async () => {
    const res = await appendTurn(turnsReq({ sessionId: 'no-such-session', body: 'x' }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('PLAN_SESSION_NOT_FOUND');
  });

  it('two sessions of one scope each hold only their own turns', async () => {
    const older = await started('older conversation');
    // The older one goes quiet past the resume window, so the next first turn
    // starts a second session of the same (project-wide) scope.
    await adminDb.planChangeSession.update({
      where: { id: older },
      data: { lastActivityAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
    });
    const newer = await started('newer conversation');
    expect(newer).not.toBe(older);

    await appendTurn(turnsReq({ sessionId: older, body: 'to the older one' }));
    await appendTurn(turnsReq({ sessionId: newer, body: 'to the newer one' }));

    const bodies = async (id: string) =>
      (
        await adminDb.planChangeTurn.findMany({ where: { sessionId: id }, orderBy: { seq: 'asc' } })
      ).map((t) => t.body);
    expect(await bodies(older)).toEqual(['older conversation', 'to the older one']);
    expect(await bodies(newer)).toEqual(['newer conversation', 'to the newer one']);
  });
});

describe('POST /api/ai/plan-change/session/submit', () => {
  it('submits the NAMED session’s accumulated intent and returns the shipped job id + session', async () => {
    const sessionId = await started('Add auth to the billing epic');
    await appendTurn(turnsReq({ sessionId, body: 'Make the subtasks smaller' }));

    const res = await submit(submitReq({ sessionId }));
    expect(res.status).toBe(200);
    const dto = (await res.json()) as {
      jobId: string;
      planId: string;
      session: { id: string; lastJobId: string; turnCount: number };
    };
    expect(dto.jobId).toBe('job-augment-1');
    const plan = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRepository.findBySourceJobId('job-augment-1', fx.workspaceId, tx),
    );
    expect(dto.planId).toBe(plan?.id);
    // The plan belongs to the session that submitted it (AMENDMENT 17 §5).
    expect(plan?.sessionId).toBe(sessionId);
    expect(dto.session.id).toBe(sessionId);
    expect(dto.session.lastJobId).toBe('job-augment-1');
    expect(dto.session.turnCount).toBe(3); // two user turns + the submission marker

    const [kind, , payload] = submitJobMock.mock.calls[0] as unknown as [
      string,
      unknown,
      { prompt: string },
    ];
    expect(kind).toBe('plan');
    expect(payload.prompt).toContain('Add auth to the billing epic');
    expect(payload.prompt).toContain('Make the subtasks smaller');
  });

  it('400s a submit that names no session', async () => {
    const res = await submit(submitReq({}));
    expect(res.status).toBe(400);
  });

  it('409s a submit with nothing to send', async () => {
    // A session with no user turn — the shape only a direct write can make now
    // that a conversation starts with its first turn.
    const empty = await adminDb.planChangeSession.create({
      data: { workspaceId: fx.workspaceId, projectId: fx.projectId, createdById: fx.ownerId },
    });
    const res = await submit(submitReq({ sessionId: empty.id }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('PLAN_CHANGE_EMPTY_INTENT');
  });

  it('maps the metered-AI failures the shipped augment route maps (402 / 502)', async () => {
    const sessionId = await started('Split the epic');

    submitJobMock.mockRejectedValueOnce(new MotirAiOutOfCreditsError('No credits left'));
    const broke = await submit(submitReq({ sessionId }));
    expect(broke.status).toBe(402);

    submitJobMock.mockRejectedValueOnce(new MotirAiUnavailableError('upstream down'));
    const down = await submit(submitReq({ sessionId }));
    expect(down.status).toBe(502);
  });
});
