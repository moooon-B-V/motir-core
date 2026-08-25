import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// PUT /api/projects/[key]/lessons/[lessonId]/applied (Subtask MOTIR-3345) — the
// TRANSPORT half: the body contract and the typed-error → status mapping.
//
// The card's own words: "a generic 500 for a refusal the product deliberately
// makes is a design failure one layer down." So every arm is asserted by the
// STATUS AND THE CODE, because a surface can only explain a refusal it can tell
// apart from a crash.
//
// The permission and the call ORDER live one layer down and are asserted in
// tests/ai/projectLessonWrite.test.ts against the real service; this file mocks
// the service to isolate the transport, per CLAUDE.md's thin-route contract.

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: vi.fn() };
});

const setLessonApplied = vi.fn();
vi.mock('@/lib/services/projectLessonsService', () => ({
  projectLessonsService: {
    setLessonApplied: (...args: unknown[]) => setLessonApplied(...(args as [])),
  },
}));

const getByKey = vi.fn();
vi.mock('@/lib/services/projectsService', () => ({
  projectsService: { getByKey: (...args: unknown[]) => getByKey(...(args as [])) },
}));

const { PUT } = await import('@/app/api/projects/[key]/lessons/[lessonId]/applied/route');
const { getWorkspaceContext } = await import('@/lib/workspaces');
const { PermissionDeniedError, ProjectNotFoundError } = await import('@/lib/projects/errors');
const { MotirAiConfigError, MotirAiJobNotFoundError, MotirAiUnavailableError } =
  await import('@/lib/ai/errors');

const CTX = { userId: 'user_yue', workspaceId: 'ws_1' };

function req(body: unknown, raw?: string): Request {
  return new Request('http://t/api/projects/MOTIR/lessons/les_1/applied', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}

function call(body: unknown, raw?: string) {
  return PUT(req(body, raw), { params: Promise.resolve({ key: 'MOTIR', lessonId: 'les_1' }) });
}

beforeEach(() => {
  vi.mocked(getWorkspaceContext).mockResolvedValue(CTX as never);
  getByKey.mockReset().mockResolvedValue({ id: 'pj_1' });
  setLessonApplied.mockReset().mockResolvedValue({ id: 'les_1', humanOverride: 'retired' });
});

afterEach(() => vi.clearAllMocks());

describe('the body contract', () => {
  it('passes `applied` straight through to the one service method', async () => {
    const res = await call({ applied: false });

    expect(res.status).toBe(200);
    expect(setLessonApplied).toHaveBeenCalledWith('pj_1', CTX, 'les_1', false);
    expect(await res.json()).toMatchObject({ id: 'les_1', humanOverride: 'retired' });
  });

  it('accepts `applied: true` as the other direction of the same axis', async () => {
    await call({ applied: true });
    expect(setLessonApplied).toHaveBeenCalledWith('pj_1', CTX, 'les_1', true);
  });

  it('refuses a non-boolean `applied` with 400 — and calls nothing', async () => {
    for (const bad of [{ applied: 'false' }, { applied: 1 }, { applied: null }, {}]) {
      const res = await call(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect((await res.json()).code).toBe('INVALID_BODY');
    }
    expect(setLessonApplied).not.toHaveBeenCalled();
  });

  it('refuses a body that is not JSON with 400', async () => {
    const res = await call(undefined, 'not json');
    expect(res.status).toBe(400);
    expect(setLessonApplied).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller with 401, before resolving the project', async () => {
    vi.mocked(getWorkspaceContext).mockResolvedValue(null as never);

    const res = await call({ applied: false });

    expect(res.status).toBe(401);
    expect(getByKey).not.toHaveBeenCalled();
    expect(setLessonApplied).not.toHaveBeenCalled();
  });
});

describe('every refusal is distinguishable from a crash', () => {
  it('a missing permission is 403 and NAMES the key the caller lacks', async () => {
    setLessonApplied.mockRejectedValue(new PermissionDeniedError('pj_1', 'lesson:manage'));

    const res = await call({ applied: false });

    expect(res.status).toBe(403);
    // The surface has to be able to say WHICH permission — "you cannot do this"
    // with no key is not something a person can act on.
    expect(await res.json()).toMatchObject({ permission: 'lesson:manage' });
  });

  it('an unknown / cross-tenant / non-browsable project is 404', async () => {
    getByKey.mockRejectedValue(new ProjectNotFoundError('pj_1'));

    expect((await call({ applied: false })).status).toBe(404);
  });

  it('the upstream not_found is 404 — an unknown id, another project’s, AND a global one', async () => {
    setLessonApplied.mockRejectedValue(new MotirAiJobNotFoundError('nope'));

    const res = await call({ applied: false });

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
  });

  it('an unreachable motir-ai is 503 AI_UNAVAILABLE — not a silent success', async () => {
    setLessonApplied.mockRejectedValue(new MotirAiUnavailableError('down'));

    const res = await call({ applied: false });

    // ⚠️ The READ routes answer 200 with `available: false` here. A write must
    // not: reporting success for a mutation that never happened leaves the row
    // flipping back on the next read, with no error anywhere.
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('AI_UNAVAILABLE');
  });

  it('an unconfigured motir-ai is 503 AI_NOT_CONFIGURED — the self-host posture, named', async () => {
    setLessonApplied.mockRejectedValue(new MotirAiConfigError('MOTIR_AI_URL unset'));

    const res = await call({ applied: false });

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('AI_NOT_CONFIGURED');
  });

  it('rethrows anything it does not recognise, rather than dressing a crash as a refusal', async () => {
    setLessonApplied.mockRejectedValue(new Error('boom'));

    await expect(call({ applied: false })).rejects.toThrow('boom');
  });
});
