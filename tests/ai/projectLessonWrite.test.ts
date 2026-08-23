import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { applyLesson, retireLesson, type RawLesson } from '@/lib/ai/motirAiClient';
import {
  MotirAiBadRequestError,
  MotirAiConfigError,
  MotirAiJobNotFoundError,
  MotirAiUnauthorizedError,
  MotirAiUnavailableError,
} from '@/lib/ai/errors';

// THE LESSON WRITE SEAM (Subtask MOTIR-3345 · Story MOTIR-3330) — the
// motirAiClient write pair and the permission-checked service above them.
//
// Three properties carry the card, and the first two are invisible to a status
// assertion:
//
//   1. **The permission is `lesson:manage`, not `lesson:view`.** This is the most
//      likely defect on the card and the hardest to notice: an admin holds both,
//      so every manual walk and the E2E pass either way, and it only fails for a
//      role nobody has created yet — one given read access that can then switch
//      off what the planner tells the whole project.
//   2. **It is checked BEFORE the boundary call.** Asserted as the upstream
//      stub's CALL COUNT, because a service that called upstream and then
//      refused would return the same 403.
//   3. **The acting user is SENT.** The upstream can only record who decided if
//      this side threads it, and its absence is invisible until somebody opens
//      the detail view and finds an audit line saying nothing.
//
// ⚠️ And unlike the READ seam beside it, an outage does NOT degrade here. That
// is asserted as a THROW, per class, because "the section goes quiet" applied to
// a write means telling the user their lesson was retired when nothing happened.

const assertPermission = vi.fn(async () => {});

vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: {
    assertPermission: (...args: unknown[]) => assertPermission(...(args as [])),
  },
}));

const { projectLessonsService } = await import('@/lib/services/projectLessonsService');
const { PermissionDeniedError } = await import('@/lib/projects/errors');

const ctx = { userId: 'user_yue', workspaceId: 'ws_1' };
const PROJECT_ID = 'pj_1';

function rawLesson(over: Partial<RawLesson> = {}): RawLesson {
  return {
    id: 'les_1',
    scope: 'tenant',
    aiProjectId: 'aip_1',
    mistakeType: 'regular_planning',
    title: 'A takeaway',
    body: 'What happened',
    why: 'Why it matters',
    howToApply: 'How to apply it',
    categories: [],
    kinds: ['story'],
    types: ['code'],
    phases: ['deepen'],
    sourceRef: 'MOTIR-1',
    enabled: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    lastOccurredAt: '2026-08-02T00:00:00.000Z',
    recurrenceCount: 3,
    injected: true,
    injectionBlock: null,
    retentionDays: 90,
    ...over,
  };
}

const RETIRED = rawLesson({
  injected: false,
  injectionBlock: 'disabled',
  humanOverride: 'retired',
  humanOverrideAt: '2026-08-23T12:00:00.000Z',
  humanOverrideBy: 'user_yue',
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function problem(code: string, status: number): Response {
  return jsonResponse({ code, title: code, status, detail: code }, status);
}

beforeEach(() => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  assertPermission.mockReset();
  assertPermission.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the client — the two named acts on one axis', () => {
  it('POSTs /v1/lessons/:id/retire with the core ids, the ACTOR and the service bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(RETIRED));
    vi.stubGlobal('fetch', fetchMock);

    await retireLesson({
      coreWorkspaceId: 'ws_1',
      coreProjectId: 'pj_1',
      lessonId: 'les_1',
      actorId: 'user_yue',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://ai.example.test/v1/lessons/les_1/retire');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer svc-token');
    expect(JSON.parse(init.body)).toEqual({
      coreWorkspaceId: 'ws_1',
      coreProjectId: 'pj_1',
      actorId: 'user_yue',
    });
  });

  it('POSTs /v1/lessons/:id/apply, and sends NO override value — the upstream decides it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(rawLesson()));
    vi.stubGlobal('fetch', fetchMock);

    await applyLesson({
      coreWorkspaceId: 'ws_1',
      coreProjectId: 'pj_1',
      lessonId: 'les_1',
      actorId: 'user_yue',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://ai.example.test/v1/lessons/les_1/apply');
    // Whether `apply` means "clear the retirement" or "exempt from the clock"
    // depends on the ROW, which only motir-ai can read. A value here would be a
    // state machine in the client, and would make `exempt` reachable on a row
    // that never aged out.
    expect(Object.keys(JSON.parse(init.body)).sort()).toEqual([
      'actorId',
      'coreProjectId',
      'coreWorkspaceId',
    ]);
  });

  it('percent-encodes the lesson id into the path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(rawLesson({ id: 'a/b' })));
    vi.stubGlobal('fetch', fetchMock);

    await retireLesson({
      coreWorkspaceId: 'ws_1',
      coreProjectId: 'pj_1',
      lessonId: 'a/b',
      actorId: 'user_yue',
    });

    expect(fetchMock.mock.calls[0]![0]).toBe('https://ai.example.test/v1/lessons/a%2Fb/retire');
  });

  it('maps every upstream problem to its typed error', async () => {
    const cases: [string, number, unknown][] = [
      ['not_found', 404, MotirAiJobNotFoundError],
      ['service_unauthorized', 401, MotirAiUnauthorizedError],
      ['validation_error', 400, MotirAiBadRequestError],
    ];
    for (const [code, status, type] of cases) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problem(code, status)));
      await expect(
        retireLesson({
          coreWorkspaceId: 'ws_1',
          coreProjectId: 'pj_1',
          lessonId: 'les_1',
          actorId: 'user_yue',
        }),
      ).rejects.toBeInstanceOf(type as never);
    }
  });

  it('treats a 200 of the wrong shape as an unavailable upstream, not as a lesson', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));

    await expect(
      applyLesson({
        coreWorkspaceId: 'ws_1',
        coreProjectId: 'pj_1',
        lessonId: 'les_1',
        actorId: 'user_yue',
      }),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});

describe('the service — the RIGHT permission, checked FIRST', () => {
  it('asserts `lesson:manage`, NOT `lesson:view`', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(RETIRED)));

    await projectLessonsService.setLessonApplied(PROJECT_ID, ctx, 'les_1', false);

    expect(assertPermission).toHaveBeenCalledWith(PROJECT_ID, ctx, 'lesson:manage');
    // The distinction the two keys exist for. An admin holds both, so nothing
    // else in the suite can tell these apart.
    expect(assertPermission).not.toHaveBeenCalledWith(PROJECT_ID, ctx, 'lesson:view');
  });

  it('asserts the same key for BOTH directions — apply is not the softer act', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(rawLesson())));

    await projectLessonsService.setLessonApplied(PROJECT_ID, ctx, 'les_1', true);

    expect(assertPermission).toHaveBeenCalledWith(PROJECT_ID, ctx, 'lesson:manage');
  });

  it('makes NO upstream call when the permission check fails', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    assertPermission.mockRejectedValue(new PermissionDeniedError(PROJECT_ID, 'lesson:manage'));

    await expect(
      projectLessonsService.setLessonApplied(PROJECT_ID, ctx, 'les_1', false),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    // The ORDER is the guard. A service that wrote and then refused would raise
    // the same error, having already changed what the planner is told.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('threads the acting user through to the upstream', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(RETIRED));
    vi.stubGlobal('fetch', fetchMock);

    await projectLessonsService.setLessonApplied(
      PROJECT_ID,
      { ...ctx, userId: 'user_ada' },
      'l',
      false,
    );

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).actorId).toBe('user_ada');
  });

  it('routes `applied: false` to retire and `applied: true` to apply', async () => {
    // A fresh Response per call — a single instance's body can only be read once.
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(rawLesson()));
    vi.stubGlobal('fetch', fetchMock);

    await projectLessonsService.setLessonApplied(PROJECT_ID, ctx, 'les_1', false);
    await projectLessonsService.setLessonApplied(PROJECT_ID, ctx, 'les_1', true);

    expect(fetchMock.mock.calls[0]![0]).toMatch(/\/retire$/);
    expect(fetchMock.mock.calls[1]![0]).toMatch(/\/apply$/);
  });
});

describe('the service — the DTO, and what does not cross', () => {
  it('answers with the row’s new state, carrying the actor and the moment', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(RETIRED)));

    const dto = await projectLessonsService.setLessonApplied(PROJECT_ID, ctx, 'les_1', false);

    expect(dto.humanOverride).toBe('retired');
    expect(dto.humanOverrideBy).toBe('user_yue');
    expect(dto.humanOverrideAt).toBe('2026-08-23T12:00:00.000Z');
    expect(dto.injected).toBe(false);
    expect(dto.injectionBlock).toBe('disabled');
    // The closed layer's identifiers stay behind, as on the reads.
    expect(dto as unknown as Record<string, unknown>).not.toHaveProperty('scope');
    expect(dto as unknown as Record<string, unknown>).not.toHaveProperty('aiProjectId');
  });

  it('narrows an unknown override value to null rather than passing it through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(rawLesson({ humanOverride: 'quarantined' }))),
    );

    const dto = await projectLessonsService.setLessonApplied(PROJECT_ID, ctx, 'les_1', true);

    expect(dto.humanOverride).toBeNull();
  });

  it('THROWS if the upstream answers with a non-tenant row — there is no partial answer to a write', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(rawLesson({ scope: 'global' }))));

    // The reads FILTER a stray global row, because blanking a customer's own
    // lessons over one bad row is the worse failure. A write that answered with
    // one would mean the upstream had performed a mutation it is supposed to
    // refuse, and there is nothing to render.
    await expect(
      projectLessonsService.setLessonApplied(PROJECT_ID, ctx, 'les_1', false),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});

describe('the service — a WRITE does not go quiet', () => {
  it('propagates an outage instead of degrading, unlike the reads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    // The read arm answers `{ available: false }` here, deliberately. Doing that
    // on a write would report success for a mutation that never happened, and
    // the row would flip back on the next read with no error anywhere.
    await expect(
      projectLessonsService.setLessonApplied(PROJECT_ID, ctx, 'les_1', false),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('propagates an UNCONFIGURED motir-ai rather than pretending the write landed', async () => {
    delete process.env['MOTIR_AI_URL'];

    await expect(
      projectLessonsService.setLessonApplied(PROJECT_ID, ctx, 'les_1', false),
    ).rejects.toBeInstanceOf(MotirAiConfigError);
  });

  it('propagates the upstream not_found — a global lesson, another project’s, or an unknown id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problem('not_found', 404)));

    await expect(
      projectLessonsService.setLessonApplied(PROJECT_ID, ctx, 'les_1', false),
    ).rejects.toBeInstanceOf(MotirAiJobNotFoundError);
  });
});
