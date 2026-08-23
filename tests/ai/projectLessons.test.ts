import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLessons, getLesson, type RawLesson } from '@/lib/ai/motirAiClient';
import {
  MotirAiBadRequestError,
  MotirAiJobNotFoundError,
  MotirAiUnauthorizedError,
  MotirAiUnavailableError,
} from '@/lib/ai/errors';

// THE LESSON SEAM (Subtask MOTIR-3337 · Story MOTIR-3329) — the motirAiClient
// reads and the permission-checked service above them.
//
// Two properties carry the card, and both are ORDER properties that a status
// assertion cannot see:
//
//   1. The permission is checked BEFORE the boundary call. Asserted as the
//      upstream stub's CALL COUNT, because a service that fetched and then
//      refused would return the same 403 while having already assembled the
//      payload — which is the implementation this card exists to rule out.
//   2. An outage DEGRADES rather than throwing, so the section goes quiet and
//      the rest of the AI-planning settings page keeps working. Asserted per
//      error class, because only the unavailable class may be swallowed: a
//      mis-configured service token must stay loud.

const assertPermission = vi.fn(async () => {});

vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: {
    assertPermission: (...args: unknown[]) => assertPermission(...(args as [])),
  },
}));

const { projectLessonsService } = await import('@/lib/services/projectLessonsService');
const { PermissionDeniedError } = await import('@/lib/projects/errors');

const ctx = { userId: 'user_1', workspaceId: 'ws_1' };
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

describe('the client — same envelope, auth and error conventions as its neighbours', () => {
  it('GETs /v1/lessons with the core ids and the service bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        lessons: [rawLesson()],
        nextCursor: null,
        staleCutoff: 'X',
        retentionDays: 90,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const page = await getLessons({ coreWorkspaceId: 'ws_1', coreProjectId: 'pj_1' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://ai.example.test/v1/lessons?coreWorkspaceId=ws_1&coreProjectId=pj_1');
    expect(init.headers.Authorization).toBe('Bearer svc-token');
    expect(page.lessons).toHaveLength(1);
    expect(page.retentionDays).toBe(90);
  });

  it('forwards cursor and limit only when given', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ lessons: [], nextCursor: null, staleCutoff: 'X', retentionDays: 90 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await getLessons({
      coreWorkspaceId: 'ws_1',
      coreProjectId: 'pj_1',
      cursor: 'les_9',
      limit: 10,
    });
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain('cursor=les_9');
    expect(url).toContain('limit=10');
  });

  it('percent-encodes the lesson id on the detail read', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(rawLesson({ id: 'a/b' })));
    vi.stubGlobal('fetch', fetchMock);

    await getLesson({ coreWorkspaceId: 'ws_1', coreProjectId: 'pj_1', lessonId: 'a/b' });
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/v1/lessons/a%2Fb?');
  });

  it('maps a problem+json refusal to the shared typed error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problem('not_found', 404)));
    await expect(
      getLesson({ coreWorkspaceId: 'ws_1', coreProjectId: 'pj_1', lessonId: 'les_x' }),
    ).rejects.toBeInstanceOf(MotirAiJobNotFoundError);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problem('service_unauthorized', 401)));
    await expect(
      getLessons({ coreWorkspaceId: 'ws_1', coreProjectId: 'pj_1' }),
    ).rejects.toBeInstanceOf(MotirAiUnauthorizedError);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problem('validation_error', 400)));
    await expect(
      getLessons({ coreWorkspaceId: 'ws_1', coreProjectId: 'pj_1' }),
    ).rejects.toBeInstanceOf(MotirAiBadRequestError);
  });

  it('treats a 200 with a MALFORMED body as unavailable, not as an empty page', async () => {
    // The distinction that matters: an empty list is a legitimate answer from a
    // project whose planner has never recorded anything, so `body.lessons ?? []`
    // would render an upstream version skew as "you have no lessons".
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [] })));
    await expect(
      getLessons({ coreWorkspaceId: 'ws_1', coreProjectId: 'pj_1' }),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});

describe('the guard — refused BEFORE anything crosses the boundary', () => {
  it('makes NO upstream call when the actor lacks lesson:view', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    assertPermission.mockRejectedValue(new PermissionDeniedError(PROJECT_ID, 'lesson:view'));

    await expect(projectLessonsService.listLessons(PROJECT_ID, ctx)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    // THE assertion of this card. A route that fetched and then refused would
    // pass an assertion on the thrown error and fail this one.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('makes NO upstream call on the DETAIL read either', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    assertPermission.mockRejectedValue(new PermissionDeniedError(PROJECT_ID, 'lesson:view'));

    await expect(projectLessonsService.getLesson(PROJECT_ID, ctx, 'les_1')).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for `lesson:view` specifically — not project:administer in disguise', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ lessons: [], nextCursor: null, staleCutoff: 'X', retentionDays: 90 }),
        ),
    );
    await projectLessonsService.listLessons(PROJECT_ID, ctx);
    expect(assertPermission).toHaveBeenCalledWith(PROJECT_ID, ctx, 'lesson:view');
  });
});

describe('the DTO — only what the surface needs', () => {
  it('drops the closed layer’s identifiers and keeps the reasoning', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          lessons: [rawLesson()],
          nextCursor: 'les_2',
          staleCutoff: 'CUT',
          retentionDays: 90,
        }),
      ),
    );
    const page = await projectLessonsService.listLessons(PROJECT_ID, ctx);
    expect(page.available).toBe(true);
    expect(page.nextCursor).toBe('les_2');
    expect(page.staleCutoff).toBe('CUT');
    const lesson = page.lessons[0]!;
    expect(lesson).toMatchObject({
      id: 'les_1',
      title: 'A takeaway',
      why: 'Why it matters',
      howToApply: 'How to apply it',
      recurrenceCount: 3,
      injected: true,
      injectionBlock: null,
    });
    // Nothing about the closed layer's own identity travels to a browser, and
    // nothing about another project is reachable through the shape.
    expect(lesson).not.toHaveProperty('aiProjectId');
    expect(lesson).not.toHaveProperty('scope');
    expect(lesson).not.toHaveProperty('mistakeType');
    expect(lesson).not.toHaveProperty('embedding');
  });

  it('carries the retirement label through, and narrows an unknown one to null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          lessons: [
            rawLesson({ id: 'a', injected: false, injectionBlock: 'not_recurred' }),
            rawLesson({ id: 'b', injected: false, injectionBlock: 'disabled' }),
            rawLesson({ id: 'c', injected: false, injectionBlock: 'something-new' }),
          ],
          nextCursor: null,
          staleCutoff: 'CUT',
          retentionDays: 90,
        }),
      ),
    );
    const page = await projectLessonsService.listLessons(PROJECT_ID, ctx);
    expect(page.lessons.map((l) => l.injectionBlock)).toEqual(['not_recurred', 'disabled', null]);
  });
});

describe('the counts travel, and a missing one falls back to what is VISIBLE', () => {
  it('carries `total` and `applied` through to the DTO', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          lessons: [rawLesson()],
          nextCursor: null,
          total: 12,
          applied: 11,
          staleCutoff: 'CUT',
          retentionDays: 90,
        }),
      ),
    );
    const page = await projectLessonsService.listLessons(PROJECT_ID, ctx);
    expect(page.total).toBe(12);
    expect(page.applied).toBe(11);
  });

  it('falls back to the PAGE LENGTH, not to zero, when an older upstream omits them', async () => {
    // Zero would contradict the rows rendered beside it — a screen showing two
    // lessons above the words "0 lessons". Wrong by at most a page beats wrong
    // in a way the reader can see.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          lessons: [rawLesson({ id: 'a' }), rawLesson({ id: 'b' })],
          nextCursor: null,
          staleCutoff: 'CUT',
          retentionDays: 90,
        }),
      ),
    );
    const page = await projectLessonsService.listLessons(PROJECT_ID, ctx);
    expect(page.total).toBe(2);
    expect(page.applied).toBe(2);
  });

  it('carries each row’s OWN retention window', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          lessons: [rawLesson({ retentionDays: 60 })],
          nextCursor: null,
          total: 1,
          applied: 1,
          staleCutoff: 'CUT',
          retentionDays: 60,
        }),
      ),
    );
    const page = await projectLessonsService.listLessons(PROJECT_ID, ctx);
    expect(page.lessons[0]!.retentionDays).toBe(60);
  });
});

describe('the second line of defence — a non-tenant row never reaches a browser', () => {
  it('drops a `global` row from a mixed page, keeping the project’s own', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          lessons: [
            rawLesson({ id: 'ours', scope: 'tenant', title: 'ours' }),
            rawLesson({ id: 'theirs', scope: 'global', aiProjectId: null, title: 'the corpus' }),
          ],
          nextCursor: null,
          staleCutoff: 'CUT',
          retentionDays: 90,
        }),
      ),
    );
    const page = await projectLessonsService.listLessons(PROJECT_ID, ctx);
    expect(page.lessons.map((l) => l.id)).toEqual(['ours']);
  });

  it('answers null for a `global` lesson asked for by id — the same answer an unknown id gets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(rawLesson({ scope: 'global', aiProjectId: null }))),
    );
    await expect(projectLessonsService.getLesson(PROJECT_ID, ctx, 'les_1')).resolves.toBeNull();
  });

  it('does NOT ask the upstream for anything wider — the request carries the two core ids only', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ lessons: [], nextCursor: null, staleCutoff: 'CUT', retentionDays: 90 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await projectLessonsService.listLessons(PROJECT_ID, ctx);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect([...url.searchParams.keys()].sort()).toEqual(['coreProjectId', 'coreWorkspaceId']);
  });
});

describe('degradation — the section goes quiet, the page does not', () => {
  it('returns an UNAVAILABLE page when motir-ai is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const page = await projectLessonsService.listLessons(PROJECT_ID, ctx);
    expect(page).toEqual({
      available: false,
      lessons: [],
      nextCursor: null,
      total: 0,
      applied: 0,
      staleCutoff: null,
      retentionDays: null,
    });
  });

  it('degrades on an upstream 5xx too', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problem('internal_error', 500)));
    const page = await projectLessonsService.listLessons(PROJECT_ID, ctx);
    expect(page.available).toBe(false);
  });

  it('does NOT swallow a mis-configured credential — that is our bug, and it stays loud', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problem('service_unauthorized', 401)));
    await expect(projectLessonsService.listLessons(PROJECT_ID, ctx)).rejects.toBeInstanceOf(
      MotirAiUnauthorizedError,
    );
  });

  it('does NOT swallow a request motir-ai rejects as malformed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problem('validation_error', 400)));
    await expect(projectLessonsService.listLessons(PROJECT_ID, ctx)).rejects.toBeInstanceOf(
      MotirAiBadRequestError,
    );
  });

  it('answers null for an unknown OR a foreign lesson id, indistinguishably', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problem('not_found', 404)));
    await expect(projectLessonsService.getLesson(PROJECT_ID, ctx, 'les_x')).resolves.toBeNull();
  });

  it('answers null on an outage rather than half a lesson', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(projectLessonsService.getLesson(PROJECT_ID, ctx, 'les_1')).resolves.toBeNull();
  });
});
