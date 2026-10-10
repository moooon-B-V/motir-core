import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectContext } from '@/lib/projects';

// THE RESUME DOOR'S ROUTE (Story MOTIR-7905 · MOTIR-7916): the gates, the body validation and
// the typed-error → status mapping — with the service mocked, because the service is proved
// against real Postgres in `tests/integration/planning/sessionResume.test.ts`.

const session = { current: null as { user: { id: string } } | null };
const activeCtx = { current: null as ProjectContext | null };
const resume = vi.fn();

vi.mock('@/lib/auth/requireCompliantSession', () => ({
  requireCompliantSession: async () =>
    session.current
      ? { ok: true as const, session: session.current }
      : {
          ok: false as const,
          response: new Response(JSON.stringify({ code: 'UNAUTHENTICATED' }), { status: 401 }),
        },
}));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));
vi.mock('@/lib/rateLimit/aiGuard', () => ({ enforceAiRateLimit: vi.fn(async () => null) }));
vi.mock('@/lib/services/planSessionResumeService', () => ({
  planSessionResumeService: { resume: (...args: unknown[]) => resume(...args) },
}));

const { POST } = await import('@/app/api/ai/plan-change/session/resume/route');
const { enforceAiRateLimit } = await import('@/lib/rateLimit/aiGuard');
const errors = await import('@/lib/planChange/errors');
const { MotirAiOutOfCreditsError, MotirAiUnavailableError } = await import('@/lib/ai/errors');

const ctx = { userId: 'u1', workspaceId: 'w1', projectId: 'p1', project: {} } as ProjectContext;
const req = (body: unknown, raw?: string) =>
  new Request('http://localhost/api/ai/plan-change/session/resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });

beforeEach(() => {
  session.current = { user: { id: 'u1' } };
  activeCtx.current = ctx;
  resume.mockReset();
  vi.mocked(enforceAiRateLimit).mockClear();
});

describe('the gates', () => {
  it('401s without a session', async () => {
    session.current = null;
    expect((await POST(req({ sessionId: 's1' }))).status).toBe(401);
    expect(resume).not.toHaveBeenCalled();
  });

  it('404s without an active project', async () => {
    activeCtx.current = null;
    expect((await POST(req({ sessionId: 's1' }))).status).toBe(404);
    expect(resume).not.toHaveBeenCalled();
  });

  it('400s a body that is not JSON, and a missing sessionId', async () => {
    expect((await POST(req(null, '{nope'))).status).toBe(400);
    expect((await POST(req({}))).status).toBeGreaterThanOrEqual(400);
    expect(resume).not.toHaveBeenCalled();
  });
});

describe('the answer', () => {
  it('200s with the service result, uncached', async () => {
    resume.mockResolvedValue({ jobId: 'job-2', planId: 'plan-1', session: { id: 's1' } });

    const res = await POST(req({ sessionId: 's1' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ jobId: 'job-2', planId: 'plan-1', session: { id: 's1' } });
    expect(resume).toHaveBeenCalledWith(ctx, 's1');
    // The `ai:generate` ceiling is drawn before the service runs (the surface guard lists this
    // door as LIMITED; the refusal itself is `tests/rateLimit`'s to prove).
    expect(enforceAiRateLimit).toHaveBeenCalledWith(ctx, 'ai:generate');
  });
});

describe('the refusals map to their codes', () => {
  it.each([
    [new errors.NotSessionOwnerError('s1'), 403, 'NOT_SESSION_OWNER'],
    [new errors.SessionNotFailedError('s1'), 409, 'SESSION_NOT_FAILED'],
    [new errors.PlanNotResumableError('s1'), 409, 'PLAN_NOT_RESUMABLE'],
    [new errors.PlanSessionAwaitingResumeError('s1'), 409, 'SESSION_AWAITING_RESUME'],
    [new errors.PlanSessionEndedError('s1'), 409, 'PLAN_SESSION_ENDED'],
    [new errors.GuideSessionNotPlannableError('s1'), 409, undefined],
    [new errors.PlanSessionNotFoundError('s1'), 404, undefined],
    [new MotirAiOutOfCreditsError('none'), 402, undefined],
    [new MotirAiUnavailableError('down'), 502, undefined],
  ])('%s → %s', async (error, status, code) => {
    resume.mockRejectedValue(error);

    const res = await POST(req({ sessionId: 's1' }));

    expect(res.status).toBe(status);
    if (code) expect((await res.json()).code).toBe(code);
  });

  it('RESUME_ALREADY_STARTED is a 409 that names the WINNING job', async () => {
    resume.mockRejectedValue(new errors.ResumeAlreadyStartedError('s1', 'job-winner'));

    const res = await POST(req({ sessionId: 's1' }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'RESUME_ALREADY_STARTED', jobId: 'job-winner' });
  });

  it('rethrows what it does not know', async () => {
    resume.mockRejectedValue(new Error('boom'));
    await expect(POST(req({ sessionId: 's1' }))).rejects.toThrow('boom');
  });
});
