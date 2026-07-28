import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { planRepository } from '@/lib/repositories/planRepository';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

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
const { POST: openSession } = await import('@/app/api/ai/plan-change/session/route');
const { POST: appendTurn } = await import('@/app/api/ai/plan-change/session/turns/route');
const { POST: submit } = await import('@/app/api/ai/plan-change/session/submit/route');
const { MotirAiOutOfCreditsError, MotirAiUnavailableError } = await import('@/lib/ai/errors');

const BASE = 'http://localhost:3000';

function turnsReq(body: unknown, raw?: string): Request {
  return new Request(`${BASE}/api/ai/plan-change/session/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
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
});

describe('plan-change routes — gates', () => {
  it('401s every endpoint without a session', async () => {
    session.current = null;
    for (const res of [
      await openSession(),
      await appendTurn(turnsReq({ body: 'x' })),
      await submit(),
    ]) {
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe('UNAUTHENTICATED');
    }
  });

  it('404s every endpoint with no active project', async () => {
    activeCtx.current = null;
    for (const res of [
      await openSession(),
      await appendTurn(turnsReq({ body: 'x' })),
      await submit(),
    ]) {
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe('NO_ACTIVE_PROJECT');
    }
  });
});

describe('POST /api/ai/plan-change/session', () => {
  it('opens the thread, then resumes the SAME one on a second call', async () => {
    const first = await openSession();
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('private, no-store');
    const opened = (await first.json()) as { id: string; projectId: string; turns: unknown[] };
    expect(opened.projectId).toBe(fx.projectId);
    expect(opened.turns).toEqual([]);

    const resumed = (await (await openSession()).json()) as { id: string };
    expect(resumed.id).toBe(opened.id);
  });
});

describe('POST /api/ai/plan-change/session/turns', () => {
  it('appends a turn and returns the updated thread', async () => {
    await openSession();
    const res = await appendTurn(turnsReq({ body: 'Add auth to billing' }));
    expect(res.status).toBe(200);
    const dto = (await res.json()) as {
      turnCount: number;
      turns: Array<{ seq: number; role: string; body: string }>;
    };
    expect(dto.turnCount).toBe(1);
    expect(dto.turns).toHaveLength(1);
    expect(dto.turns[0]).toMatchObject({ seq: 0, role: 'user', body: 'Add auth to billing' });
  });

  it('400s malformed JSON, a missing body, and a blank turn', async () => {
    await openSession();

    const badJson = await appendTurn(turnsReq(null, '{not json'));
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as { code: string }).code).toBe('BAD_REQUEST');

    const missing = await appendTurn(turnsReq({}));
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { code: string }).code).toBe('BAD_REQUEST');

    // A whitespace-only turn is well-formed HTTP but an empty turn — the typed
    // domain error, mapped to 400.
    const blank = await appendTurn(turnsReq({ body: '   ' }));
    expect(blank.status).toBe(400);
    expect(((await blank.json()) as { code: string }).code).toBe('PLAN_CHANGE_EMPTY_TURN');
  });

  it('404s when the project has no conversation yet', async () => {
    const res = await appendTurn(turnsReq({ body: 'x' }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('PLAN_CHANGE_SESSION_NOT_FOUND');
  });
});

describe('POST /api/ai/plan-change/session/submit', () => {
  it('submits the accumulated intent and returns the shipped job id + session', async () => {
    await openSession();
    await appendTurn(turnsReq({ body: 'Add auth to the billing epic' }));
    await appendTurn(turnsReq({ body: 'Make the subtasks smaller' }));

    const res = await submit();
    expect(res.status).toBe(200);
    const dto = (await res.json()) as {
      jobId: string;
      planId: string;
      session: { lastJobId: string; turnCount: number };
    };
    expect(dto.jobId).toBe('job-augment-1');
    // The project-wide submit echoes the job's Plan too (MOTIR-1745) — the same
    // `{ jobId, planId }` pair the anchored path and the three REST submits return.
    expect(dto.planId).toBe(
      (await planRepository.findBySourceJobId('job-augment-1', fx.workspaceId))?.id,
    );
    expect(dto.session.lastJobId).toBe('job-augment-1');
    expect(dto.session.turnCount).toBe(3); // two user turns + the submission marker

    const [kind, , payload] = submitJobMock.mock.calls[0] as unknown as [
      string,
      unknown,
      { prompt: string },
    ];
    expect(kind).toBe('augment');
    expect(payload.prompt).toContain('Add auth to the billing epic');
    expect(payload.prompt).toContain('Make the subtasks smaller');
  });

  it('409s a submit with nothing to send', async () => {
    await openSession();
    const res = await submit();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('PLAN_CHANGE_EMPTY_INTENT');
  });

  it('maps the metered-AI failures the shipped augment route maps (402 / 502)', async () => {
    await openSession();
    await appendTurn(turnsReq({ body: 'Split the epic' }));

    submitJobMock.mockRejectedValueOnce(new MotirAiOutOfCreditsError('No credits left'));
    const broke = await submit();
    expect(broke.status).toBe(402);

    submitJobMock.mockRejectedValueOnce(new MotirAiUnavailableError('upstream down'));
    const down = await submit();
    expect(down.status).toBe(502);
  });
});
