import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCodeGraphRunVerdict } from '@/lib/ai/motirAiClient';

// A FAILED RUN'S REASON REACHES MOTIR-CORE (MOTIR-7129 · Story MOTIR-7092).
//
// motir-ai has stored why an index run failed since MOTIR-6786, and returns it on
// `GET /v1/code-graph/run/verdict` as `verdict.failure`. Until this card the client
// parsed only the mode, the fallback reason and the timings, and treated a body
// carrying none of the three as ABSENT. That is every failed run, because a failed
// run never publishes. So the failure never crossed the boundary.
//
// These pin the widened read: a failure-only body is a verdict, a malformed failure
// field degrades field by field, and everything that was `null` before is still
// `null` — the client's totality is what keeps the two repositories' merge order
// free.

const INPUT = {
  coreWorkspaceId: 'ws_1',
  coreProjectId: 'pj_1',
  repoRef: 'moooon/motir-core',
  runId: 'run_abc',
};

const REFUSAL = {
  failureClass: 'GRAPH_TOO_LARGE',
  message: 'm',
  httpStatus: 422,
  sizeBytes: 1500000000,
  capBytes: 1073741824,
  attempts: null,
  reportedAt: '2026-10-01T00:00:00.000Z',
};

function answer(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

beforeEach(() => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchCodeGraphRunVerdict — the failure half', () => {
  it('returns a failure-only verdict instead of collapsing it to null', async () => {
    answer({
      verdict: {
        repoRef: INPUT.repoRef,
        runId: INPUT.runId,
        commitSha: null,
        indexMode: null,
        fallbackReason: null,
        timings: null,
        failure: REFUSAL,
      },
    });

    const verdict = await fetchCodeGraphRunVerdict(INPUT);

    expect(verdict).toMatchObject({
      indexMode: null,
      fallbackReason: null,
      timings: null,
      failure: {
        failureClass: 'GRAPH_TOO_LARGE',
        message: 'm',
        httpStatus: 422,
        sizeBytes: 1500000000,
        capBytes: 1073741824,
      },
    });
  });

  it('carries null sizes for a class that has none', async () => {
    answer({
      verdict: {
        indexMode: null,
        fallbackReason: null,
        timings: null,
        failure: {
          failureClass: 'UPLOAD',
          message: 'HTTP 503',
          httpStatus: 503,
          sizeBytes: null,
          capBytes: null,
        },
      },
    });

    expect((await fetchCodeGraphRunVerdict(INPUT))?.failure).toEqual({
      failureClass: 'UPLOAD',
      message: 'HTTP 503',
      httpStatus: 503,
      sizeBytes: null,
      capBytes: null,
    });
  });

  it.each([
    ['a string', '1500000000'],
    ['a negative number', -1],
    ['an object', { n: 1 }],
  ])('parses a sizeBytes that is %s as null and keeps the rest', async (_l, sizeBytes) => {
    answer({
      verdict: { indexMode: null, failure: { ...REFUSAL, sizeBytes } },
    });

    expect((await fetchCodeGraphRunVerdict(INPUT))?.failure).toEqual({
      failureClass: 'GRAPH_TOO_LARGE',
      message: 'm',
      httpStatus: 422,
      sizeBytes: null,
      capBytes: 1073741824,
    });
  });

  it('a non-integer httpStatus becomes null', async () => {
    answer({ verdict: { failure: { ...REFUSAL, httpStatus: '422' } } });
    expect((await fetchCodeGraphRunVerdict(INPUT))?.failure?.httpStatus).toBeNull();
  });

  it.each([
    ['no class', { message: 'm' }],
    ['an empty class', { failureClass: '', message: 'm' }],
    ['no message', { failureClass: 'BUILD' }],
    ['an array', [REFUSAL]],
    ['a string', 'GRAPH_TOO_LARGE'],
  ])(
    'a failure with %s is no failure — and a body with nothing else is still null',
    async (_l, failure) => {
      answer({ verdict: { indexMode: null, fallbackReason: null, timings: null, failure } });
      expect(await fetchCodeGraphRunVerdict(INPUT)).toBeNull();
    },
  );

  it('a body with no failure key and nothing else is null, as before', async () => {
    answer({ verdict: { indexMode: null, fallbackReason: null, timings: null } });
    expect(await fetchCodeGraphRunVerdict(INPUT)).toBeNull();
  });

  it('a successful run with no failure carries failure: null beside its mode', async () => {
    answer({ verdict: { indexMode: 'sync', fallbackReason: null, timings: null } });
    expect(await fetchCodeGraphRunVerdict(INPUT)).toMatchObject({
      indexMode: 'sync',
      failure: null,
    });
  });

  it('a 404 from an older motir-ai is still null', async () => {
    answer({ code: 'not_found' }, 404);
    expect(await fetchCodeGraphRunVerdict(INPUT)).toBeNull();
  });
});
