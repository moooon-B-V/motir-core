import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentModels } from '@/lib/ai/motirAiClient';
import { hostedRunModelService, toOpenCodeModel } from '@/lib/services/hostedRunModelService';
import { HostedModelNotOfferedError, HostedModelsUnavailableError } from '@/lib/hostedRuns/errors';

// THE MODELS A HOSTED RUN MAY USE (MOTIR-6483; `docs/decisions/hosted-agent-run.md`
// §7), over the real client with only `fetch` stubbed — the HTTP seam to motir-ai.
//
// Pinned: motir-ai's list and default arrive UNCHANGED; every failure (network,
// timeout, 5xx, a non-2xx, a body that is not a list, an unconfigured client) is
// `unavailable` and NEVER an empty list; `assertOffered` refuses an absent id and
// an unanswered question with two DIFFERENT errors; and the prefix is added once.

const LIST = {
  models: [
    { id: 'claude-opus-5-5', provider: 'anthropic' },
    { id: 'claude-sonnet-4-6', provider: 'anthropic' },
  ],
  default: 'claude-opus-5-5',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test/');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('getAgentModels (the client read)', () => {
  it('GETs /v1/agent-models with the service credential', async () => {
    const fetchMock = vi.fn(async () => json(LIST));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getAgentModels()).toEqual({ state: 'ok', ...LIST });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ai.test/v1/agent-models');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer svc-token');
  });

  it('carries a null default through as null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ models: LIST.models, default: null })),
    );
    expect(await getAgentModels()).toEqual({ state: 'ok', models: LIST.models, default: null });
  });

  it.each([
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['a 5xx', async () => json({ code: 'internal_error' }, 503)],
    ['a 404 from a motir-ai that does not serve the route', async () => json({}, 404)],
    ['a 2xx whose body is not a list', async () => json({ models: 'nope' })],
    [
      'a 2xx whose model rows are malformed',
      async () => json({ models: [{ id: 3 }], default: null }),
    ],
    ['a 2xx that is not JSON', async () => new Response('<html>', { status: 200 })],
  ])('answers unavailable — never an empty list — on %s', async (_name, impl) => {
    vi.stubGlobal('fetch', vi.fn(impl));
    const read = await getAgentModels();
    expect(read.state).toBe('unavailable');
    expect(read).not.toHaveProperty('models');
  });

  it('answers unavailable on a timeout', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        ),
      );
      const pending = getAgentModels();
      await vi.advanceTimersByTimeAsync(31_000);
      const read = await pending;
      expect(read.state).toBe('unavailable');
      expect(read.state === 'unavailable' && read.reason).toMatch(/did not respond/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers unavailable when the client is not configured', async () => {
    vi.stubEnv('MOTIR_AI_URL', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await getAgentModels()).state).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('hostedRunModelService.listOfferedModels', () => {
  it("returns motir-ai's models and default unchanged", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(LIST)),
    );
    expect(await hostedRunModelService.listOfferedModels()).toEqual({
      state: 'ok',
      models: LIST.models,
      default: LIST.default,
    });
  });

  it('returns { state: unavailable } — not an empty list — when motir-ai cannot answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({}, 500)),
    );
    expect(await hostedRunModelService.listOfferedModels()).toEqual({ state: 'unavailable' });
  });

  it('asks motir-ai on every call — there is no cache', async () => {
    const fetchMock = vi.fn(async () => json(LIST));
    vi.stubGlobal('fetch', fetchMock);
    await hostedRunModelService.listOfferedModels();
    await hostedRunModelService.listOfferedModels();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('hostedRunModelService.assertOffered', () => {
  it('resolves for an offered bare id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(LIST)),
    );
    await expect(hostedRunModelService.assertOffered('claude-sonnet-4-6')).resolves.toBeUndefined();
  });

  it('throws HostedModelNotOfferedError for an id not on the list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(LIST)),
    );
    const err = await hostedRunModelService.assertOffered('deepseek-chat').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostedModelNotOfferedError);
    expect((err as HostedModelNotOfferedError).code).toBe('hosted_model_not_offered');
  });

  it('refuses the PREFIXED spelling — the list holds bare ids only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(LIST)),
    );
    await expect(
      hostedRunModelService.assertOffered('anthropic/claude-opus-5-5'),
    ).rejects.toBeInstanceOf(HostedModelNotOfferedError);
  });

  it('throws HostedModelsUnavailableError when motir-ai cannot answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    const err = await hostedRunModelService
      .assertOffered('claude-opus-5-5')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostedModelsUnavailableError);
    expect((err as HostedModelsUnavailableError).code).toBe('hosted_models_unavailable');
  });
});

describe('toOpenCodeModel', () => {
  it('adds the anthropic/ provider prefix to a bare id', () => {
    expect(toOpenCodeModel('claude-opus-5-5')).toBe('anthropic/claude-opus-5-5');
    expect(hostedRunModelService.toOpenCodeModel('claude-opus-5-5')).toBe(
      'anthropic/claude-opus-5-5',
    );
  });
});
