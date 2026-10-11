import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/ai/plan-change/session/resume (Story MOTIR-7905 · MOTIR-7916): HTTP only — the gate,
// the active project, the AI ceiling, the body, ONE service call and the typed refusals mapped.

const { requireSession, activeProject, rateLimit, resume } = vi.hoisted(() => ({
  requireSession: vi.fn(),
  activeProject: vi.fn(),
  rateLimit: vi.fn(),
  resume: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({
  requireCompliantSession: requireSession,
}));
vi.mock('@/lib/projects', () => ({ getActiveProject: activeProject }));
vi.mock('@/lib/rateLimit/aiGuard', () => ({ enforceAiRateLimit: rateLimit }));
vi.mock('@/lib/services/planSessionResumeService', () => ({
  planSessionResumeService: { resume },
}));

const { POST } = await import('@/app/api/ai/plan-change/session/resume/route');
const { NotSessionOwnerError } = await import('@/lib/planChange/errors');

const post = (body: unknown) =>
  new Request('http://x/api/ai/plan-change/session/resume', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  requireSession.mockResolvedValue({ ok: true });
  activeProject.mockResolvedValue({ projectId: 'p1', workspaceId: 'w1', userId: 'u1' });
  rateLimit.mockResolvedValue(null);
});

describe('the resume route', () => {
  it('answers the service result, uncached', async () => {
    resume.mockResolvedValue({ jobId: 'j2', planId: 'p', session: { id: 's1' } });
    const res = await POST(post({ sessionId: 's1' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toMatchObject({ jobId: 'j2', planId: 'p' });
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1' }), 's1');
  });
  it('returns the gate’s own response when the session is refused', async () => {
    requireSession.mockResolvedValue({ ok: false, response: new Response('no', { status: 401 }) });
    expect((await POST(post({ sessionId: 's1' }))).status).toBe(401);
    expect(resume).not.toHaveBeenCalled();
  });
  it('refuses without an active project', async () => {
    activeProject.mockResolvedValue(null);
    expect((await POST(post({ sessionId: 's1' }))).status).toBe(404);
  });
  it('answers the AI ceiling’s 429 before reading the body', async () => {
    rateLimit.mockResolvedValue(new Response('slow', { status: 429 }));
    expect((await POST(post('not json'))).status).toBe(429);
    expect(resume).not.toHaveBeenCalled();
  });
  it('400s on an unparseable body and on a missing session id', async () => {
    expect((await POST(post('not json'))).status).toBe(400);
    expect((await POST(post({}))).status).toBe(400);
  });
  it('maps a typed refusal and rethrows anything else', async () => {
    resume.mockRejectedValueOnce(new NotSessionOwnerError('s1'));
    const res = await POST(post({ sessionId: 's1' }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_SESSION_OWNER');
    resume.mockRejectedValueOnce(new Error('boom'));
    await expect(POST(post({ sessionId: 's1' }))).rejects.toThrow('boom');
  });
});
