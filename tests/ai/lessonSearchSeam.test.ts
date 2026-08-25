import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchLessons, type RawRankedLesson } from '@/lib/ai/motirAiClient';
import {
  MotirAiBadRequestError,
  MotirAiConfigError,
  MotirAiUnauthorizedError,
  MotirAiUnavailableError,
} from '@/lib/ai/errors';

// THE LESSON-SEARCH SEAM (Subtask MOTIR-3478 · Story MOTIR-3466) — the
// `motirAiClient` method onto the teaching read, and the `lesson:view`-asserting
// service method over it.
//
// Three properties carry this card, and none of them is visible to a status
// assertion:
//
//   1. The permission is checked BEFORE the boundary call — asserted as the
//      upstream stub's CALL COUNT, because a read that fetched and then refused
//      returns the same 403 while having already spent the round trip.
//   2. `matched`, `nothing-matched` and `unavailable` are THREE outcomes a
//      caller can tell apart. Asserted by COMPARING the last two, not merely by
//      checking one: an outage rendered as an empty result is the failure this
//      card exists to rule out, and both shapes have an empty `lessons` array.
//   3. An axis the caller omitted stays ABSENT across the hop — asserted on the
//      SERIALIZED body, because the upstream SQL depends on absent-vs-`[]` and a
//      typo or a `?? []` on either side is a runtime-only defect.

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

function rankedRow(over: Partial<RawRankedLesson> = {}): RawRankedLesson {
  return {
    id: 'les_1',
    title: 'a count taken from a working tree is not a property of the ref',
    body: 'What happened',
    howToApply: 'How to apply it',
    scope: 'global',
    kinds: [],
    types: ['code'],
    phases: ['deepen'],
    distance: 0.12,
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

function stubUpstream(rows: RawRankedLesson[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ lessons: rows }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The body the client actually put on the wire. */
function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0]![1].body as string);
}

const SEARCH = { query: 'counting a population from a working tree instead of a ref' };

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
  it('POSTs /v1/lessons/search with the core ids and the service bearer', async () => {
    const fetchMock = stubUpstream([rankedRow()]);

    const rows = await searchLessons({
      coreWorkspaceId: 'ws_1',
      coreProjectId: 'pj_1',
      query: 'q',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://ai.example.test/v1/lessons/search');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer svc-token');
    expect(sentBody(fetchMock)).toEqual({
      coreWorkspaceId: 'ws_1',
      coreProjectId: 'pj_1',
      query: 'q',
    });
    expect(rows).toHaveLength(1);
  });

  it('forwards the axes and the limit only when given', async () => {
    const fetchMock = stubUpstream([]);
    await searchLessons({
      coreWorkspaceId: 'ws_1',
      coreProjectId: 'pj_1',
      query: 'q',
      kinds: ['bug'],
      types: ['code'],
      phases: ['skeleton'],
      limit: 5,
    });
    expect(sentBody(fetchMock)).toMatchObject({
      kinds: ['bug'],
      types: ['code'],
      phases: ['skeleton'],
      limit: 5,
    });
  });

  it('names no project id and no scope on the wire — the identity is the core pair', async () => {
    const fetchMock = stubUpstream([]);
    await searchLessons({ coreWorkspaceId: 'ws_1', coreProjectId: 'pj_1', query: 'q' });
    const body = sentBody(fetchMock);
    expect(body).not.toHaveProperty('scope');
    expect(body).not.toHaveProperty('aiProjectId');
  });

  it('treats a 200 with a malformed body as UNAVAILABLE, not as a search that matched nothing', async () => {
    // The pair this card is about: an empty list is a real answer, so a shape
    // that is wrong must not be able to render as one.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ notLessons: [] })));
    await expect(
      searchLessons({ coreWorkspaceId: 'ws_1', coreProjectId: 'pj_1', query: 'q' }),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it.each([
    ['service_unauthorized', 401, MotirAiUnauthorizedError],
    ['validation_error', 400, MotirAiBadRequestError],
  ])('maps an upstream %s to its typed error', async (code, status, type) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problem(code, status)));
    await expect(
      searchLessons({ coreWorkspaceId: 'ws_1', coreProjectId: 'pj_1', query: 'q' }),
    ).rejects.toBeInstanceOf(type);
  });
});

describe('THE ORDER IS THE GUARD — the permission is checked before the fetch', () => {
  it('asserts `lesson:view`, the READ key — not `lesson:manage`', async () => {
    stubUpstream([]);
    await projectLessonsService.searchLessons(PROJECT_ID, ctx, SEARCH);
    expect(assertPermission).toHaveBeenCalledWith(PROJECT_ID, ctx, 'lesson:view');
  });

  it('makes NO upstream call at all when the caller lacks the key', async () => {
    const fetchMock = stubUpstream([rankedRow()]);
    assertPermission.mockRejectedValue(new PermissionDeniedError(PROJECT_ID, 'lesson:view'));

    await expect(
      projectLessonsService.searchLessons(PROJECT_ID, ctx, SEARCH),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    // The assertion the card names: a CALL COUNT, not a status code. A service
    // that fetched and then refused would pass every status assertion while
    // having assembled a payload for someone who may not read it.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('THREE OUTCOMES, and the last two must not be confusable', () => {
  it('MATCHED — rows come back with their text and their scope', async () => {
    stubUpstream([
      rankedRow({ id: 'g', scope: 'global' }),
      rankedRow({ id: 't', scope: 'tenant', distance: 0.3 }),
    ]);

    const res = await projectLessonsService.searchLessons(PROJECT_ID, ctx, SEARCH);

    expect(res.outcome).toBe('matched');
    expect(res.lessons.map((l) => l.scope)).toEqual(['global', 'tenant']);
    expect(res.lessons[0]).toMatchObject({
      title: 'a count taken from a working tree is not a property of the ref',
      body: 'What happened',
      howToApply: 'How to apply it',
      distance: 0.12,
    });
  });

  it('BOTH SCOPES SURVIVE — the tenant-only narrowing is NOT applied to this read', async () => {
    // `listLessons` drops any non-tenant row as a second line of defence. On the
    // teaching read the global corpus is the larger half of the correct answer,
    // so the same filter here would silently halve it.
    stubUpstream([rankedRow({ scope: 'global' })]);
    const res = await projectLessonsService.searchLessons(PROJECT_ID, ctx, SEARCH);
    expect(res.outcome).toBe('matched');
    expect(res.lessons).toHaveLength(1);
  });

  it('NOTHING MATCHED — an empty upstream result is a VALUE', async () => {
    stubUpstream([]);
    const res = await projectLessonsService.searchLessons(PROJECT_ID, ctx, SEARCH);
    expect(res).toEqual({ outcome: 'nothing-matched', lessons: [] });
  });

  it.each([
    ['a transport failure', () => vi.fn().mockRejectedValue(new TypeError('fetch failed'))],
    ['a 5xx', () => vi.fn().mockResolvedValue(problem('internal_error', 503))],
  ])('UNAVAILABLE — %s never renders as an empty result set', async (_label, makeFetch) => {
    vi.stubGlobal('fetch', makeFetch());
    const res = await projectLessonsService.searchLessons(PROJECT_ID, ctx, SEARCH);
    expect(res.outcome).toBe('unavailable');
    expect(res.lessons).toEqual([]);
  });

  it('UNAVAILABLE — motir-ai not configured at all is an outage, not an empty corpus', async () => {
    // The self-host posture: `MOTIR_AI_URL` unset. `MotirAiConfigError` must
    // reach the same arm, or a self-hosted deployment tells every agent the
    // corpus is empty.
    delete process.env['MOTIR_AI_URL'];
    const res = await projectLessonsService.searchLessons(PROJECT_ID, ctx, SEARCH);
    expect(res.outcome).toBe('unavailable');
    await expect(
      searchLessons({ coreWorkspaceId: 'ws_1', coreProjectId: 'pj_1', query: 'q' }),
    ).rejects.toBeInstanceOf(MotirAiConfigError);
  });

  it('the two empty outcomes are DISTINGUISHABLE — compared, not checked one at a time', async () => {
    // Asserted by comparing them. Checking each in isolation passes against an
    // implementation that returns the same shape for both, which is exactly the
    // defect: `nothing matched` and `the corpus is unreachable` are opposite
    // answers, and an agent that cannot tell them apart proceeds believing it
    // checked.
    stubUpstream([]);
    const empty = await projectLessonsService.searchLessons(PROJECT_ID, ctx, SEARCH);

    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const down = await projectLessonsService.searchLessons(PROJECT_ID, ctx, SEARCH);

    expect(empty.lessons).toEqual(down.lessons);
    expect(empty.outcome).not.toBe(down.outcome);
  });

  it('a REFUSAL from a reachable upstream stays LOUD — it is our bug, not an outage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problem('service_unauthorized', 401)));
    await expect(
      projectLessonsService.searchLessons(PROJECT_ID, ctx, SEARCH),
    ).rejects.toBeInstanceOf(MotirAiUnauthorizedError);
  });
});

describe('an omitted axis stays ABSENT across the hop', () => {
  it('sends no axis key at all when the caller supplied none', async () => {
    const fetchMock = stubUpstream([]);
    await projectLessonsService.searchLessons(PROJECT_ID, ctx, SEARCH);

    const body = sentBody(fetchMock);
    // Asserted on the SERIALIZED body: `{ kinds: undefined }` disappears in
    // JSON, but `{ kinds: [] }` does not — and `[]` is what the upstream SQL
    // renders as a filter matching nothing.
    for (const axis of ['kinds', 'types', 'phases']) {
      expect(body).not.toHaveProperty(axis);
    }
  });

  it('sends a supplied axis through unchanged', async () => {
    const fetchMock = stubUpstream([]);
    await projectLessonsService.searchLessons(PROJECT_ID, ctx, {
      ...SEARCH,
      kinds: ['bug'],
      limit: 3,
    });

    const body = sentBody(fetchMock);
    expect(body.kinds).toEqual(['bug']);
    expect(body.limit).toBe(3);
    // And the axes it did NOT name are still absent, not defaulted alongside.
    expect(body).not.toHaveProperty('types');
    expect(body).not.toHaveProperty('phases');
  });

  it('carries the acting project, never one the caller named', async () => {
    const fetchMock = stubUpstream([]);
    await projectLessonsService.searchLessons(PROJECT_ID, ctx, SEARCH);
    expect(sentBody(fetchMock)).toMatchObject({
      coreWorkspaceId: ctx.workspaceId,
      coreProjectId: PROJECT_ID,
    });
  });
});

describe('the DTO carries what the contract names and nothing more', () => {
  it('maps every documented field and defaults the axes to empty', async () => {
    stubUpstream([
      { id: 'x', title: 't', body: 'b', howToApply: 'h', scope: 'tenant', distance: 0.5 },
    ] as RawRankedLesson[]);

    const res = await projectLessonsService.searchLessons(PROJECT_ID, ctx, SEARCH);

    expect(res.lessons[0]).toEqual({
      id: 'x',
      title: 't',
      body: 'b',
      howToApply: 'h',
      scope: 'tenant',
      kinds: [],
      types: [],
      phases: [],
      distance: 0.5,
    });
  });

  it('carries no field the route does not return', async () => {
    stubUpstream([rankedRow()]);
    const res = await projectLessonsService.searchLessons(PROJECT_ID, ctx, SEARCH);
    expect(Object.keys(res.lessons[0]!).sort()).toEqual(
      ['body', 'distance', 'howToApply', 'id', 'kinds', 'phases', 'scope', 'title', 'types'].sort(),
    );
  });
});
