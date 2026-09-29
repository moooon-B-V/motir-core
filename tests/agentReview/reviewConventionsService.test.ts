import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawConvention, RawConventionSurface } from '@/lib/ai/motirAiClient';
import { reviewConventionsService } from '@/lib/services/reviewConventionsService';

// THE REVIEW PROMPT's convention READ (MOTIR-6904; `hosted-agent-run.md` §8.5). motir-ai is
// faked at the HTTP boundary — `MOTIR_AI_URL` / `MOTIR_AI_SERVICE_TOKEN` stubbed and `fetch`
// answering per `repoKey` — so the real `getConvention` and `aiFetch` run, and the absent
// cases are the ones production produces: `convention: null`, a 5xx
// (`MotirAiUnavailableError`), a transport failure (the same class `aiFetch` gives its own
// deadline), this read's own deadline, and motir-ai not configured (`MotirAiConfigError`).

const AI_URL = 'http://motir-ai.test';
const SCOPE = { workspaceId: 'ws_1', projectId: 'proj_1' };

// motir-ai's real `GET /v1/convention` body (see `tests/aiConventionService.test.ts`).
function rawConvention(repoKey: string, version: number, contentMd: string): RawConvention {
  return {
    id: `conv_${repoKey}`,
    aiProjectId: 'ai_1',
    repoKey,
    version,
    contentMd,
    provenance: [],
    sourceAuditId: null,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
  };
}
const surface = (convention: RawConvention | null): RawConventionSurface => ({
  convention,
  versions: convention ? [convention] : [],
  nextCursor: null,
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

type Answer = () => Promise<Response>;
let answers: Record<string, Answer>;
let calls: URL[];

function stubMotirAi(): void {
  vi.stubEnv('MOTIR_AI_URL', AI_URL);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const parsed = new URL(String(url));
      calls.push(parsed);
      const answer = answers[parsed.searchParams.get('repoKey') ?? ''];
      if (!answer) throw new Error(`unexpected motir-ai request ${parsed.pathname}`);
      return answer();
    }),
  );
}

beforeEach(() => {
  answers = {};
  calls = [];
  stubMotirAi();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('reviewConventionsService.resolveReviewConventions', () => {
  it('present, none, unavailable (5xx), unreachable, timed out: only the first is present; nothing throws', async () => {
    answers = {
      'moooon/present': async () =>
        json(200, surface(rawConvention('moooon/present', 4, '- Typed errors.'))),
      'moooon/none': async () => json(200, surface(null)),
      'moooon/down': async () =>
        json(503, { type: 'about:blank', title: 'down', status: 503, code: 'internal_error' }),
      'moooon/unreachable': async () => {
        throw new TypeError('fetch failed');
      },
      'moooon/slow': () => new Promise<Response>(() => undefined),
    };

    const result = await reviewConventionsService.resolveReviewConventions(
      SCOPE,
      ['moooon/present', 'moooon/none', 'moooon/down', 'moooon/unreachable', 'moooon/slow'],
      50,
    );

    expect(result).toEqual([
      { repoKey: 'moooon/present', state: 'present', version: 4, contentMd: '- Typed errors.' },
      { repoKey: 'moooon/none', state: 'absent' },
      { repoKey: 'moooon/down', state: 'absent' },
      { repoKey: 'moooon/unreachable', state: 'absent' },
      { repoKey: 'moooon/slow', state: 'absent' },
    ]);
  });

  it('motir-ai NOT CONFIGURED (`MotirAiConfigError`) is absent, and no request is made', async () => {
    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', '');
    const result = await reviewConventionsService.resolveReviewConventions(SCOPE, ['moooon/a']);
    expect(result).toEqual([{ repoKey: 'moooon/a', state: 'absent' }]);

    vi.stubEnv('MOTIR_AI_URL', '');
    expect(await reviewConventionsService.resolveReviewConventions(SCOPE, ['moooon/a'])).toEqual([
      { repoKey: 'moooon/a', state: 'absent' },
    ]);
    expect(calls).toHaveLength(0);
  });

  it('an error that is NOT a motir-ai error propagates — a bug is not hidden as "no convention"', async () => {
    // A 200 whose body is not JSON: `res.json()` throws a SyntaxError, not a MotirAiError.
    answers = { 'moooon/a': async () => new Response('not json', { status: 200 }) };
    await expect(
      reviewConventionsService.resolveReviewConventions(SCOPE, ['moooon/a']),
    ).rejects.toThrow(SyntaxError);
  });

  it('reads ONLY `GET /v1/convention` — once per DISTINCT repository, keyed owner/name, latest only', async () => {
    answers = {
      'moooon/a': async () => json(200, surface(null)),
      'moooon/b': async () => json(200, surface(null)),
    };
    await reviewConventionsService.resolveReviewConventions(SCOPE, [
      'moooon/a',
      'moooon/b',
      'moooon/a',
    ]);

    // No audit, no refresh, no proposal: every request is the convention read.
    expect(calls.map((u) => u.pathname)).toEqual(['/v1/convention', '/v1/convention']);
    expect(calls.map((u) => Object.fromEntries(u.searchParams))).toEqual([
      { coreWorkspaceId: 'ws_1', coreProjectId: 'proj_1', repoKey: 'moooon/a', versionsLimit: '1' },
      { coreWorkspaceId: 'ws_1', coreProjectId: 'proj_1', repoKey: 'moooon/b', versionsLimit: '1' },
    ]);
  });

  it('reads two repositories CONCURRENTLY: both requests are pending together', async () => {
    const release: Array<() => void> = [];
    const pending =
      (repoKey: string): Answer =>
      () =>
        new Promise<Response>((resolve) => {
          release.push(() => resolve(json(200, surface(rawConvention(repoKey, 1, 'rules')))));
        });
    answers = { 'moooon/a': pending('moooon/a'), 'moooon/b': pending('moooon/b') };

    const read = reviewConventionsService.resolveReviewConventions(SCOPE, ['moooon/a', 'moooon/b']);
    await vi.waitFor(() => expect(release).toHaveLength(2));
    // Neither has answered, and both were asked.
    expect(calls.map((u) => u.searchParams.get('repoKey'))).toEqual(['moooon/a', 'moooon/b']);
    release.forEach((r) => r());

    expect((await read).map((c) => c.state)).toEqual(['present', 'present']);
  });
});
