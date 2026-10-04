import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlannerModelList, updatePlannerModelList } from '@/lib/ai/motirAiClient';
import {
  MotirAiUnauthorizedError,
  MotirAiUnavailableError,
  PlannerModelListEntryInUseError,
  PlannerModelListFallbackError,
  PlannerModelListRefusedError,
  PlannerModelNotQualifiedError,
} from '@/lib/ai/errors';
import type { PlannerModelListRead } from '@/lib/ai/types';

// The planning-model list across the boundary (Story MOTIR-7521 · MOTIR-7524;
// motir-ai MOTIR-7520). The HTTP boundary is stubbed: what these pin is the
// request each function sends and how each motir-ai answer — motir-ai's own
// refusal wording included — becomes a motir-core value or typed error.

const LIST: PlannerModelListRead = {
  entries: [
    {
      model: 'claude-opus-5-5',
      provider: 'anthropic',
      offered: true,
      reason: null,
      addedByCoreUserId: null,
      createdAt: '2026-10-04T09:00:00.000Z',
    },
    {
      model: 'claude-opus-4-8',
      provider: null,
      offered: false,
      reason: 'not_servable',
      addedByCoreUserId: 'u_1',
      createdAt: '2026-10-04T09:30:00.000Z',
    },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function problem(code: string, status: number, detail?: string): Response {
  return json(
    { type: `https://motir.co/errors/${code}`, title: code, status, code, detail },
    status,
  );
}

const ADD = { action: 'add' as const, model: 'glm-5.2', actorCoreUserId: 'u_1' };
const REMOVE = { action: 'remove' as const, model: 'glm-5.2', actorCoreUserId: 'u_1' };

beforeEach(() => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test/';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getPlannerModelList', () => {
  it('GETs the list with the service bearer and returns the entries', async () => {
    const fetchMock = vi.fn(async () => json(LIST));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getPlannerModelList()).resolves.toEqual(LIST);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ai.example.test/v1/planner-model-list');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer svc-token');
  });

  it('an empty list is an answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ entries: [] })),
    );
    await expect(getPlannerModelList()).resolves.toEqual({ entries: [] });
  });

  it.each([
    ['a 5xx', () => problem('internal_error', 503)],
    ['a body that is not a list', () => json({ entries: 'nope' })],
    [
      'an entry with an unknown reason',
      () => json({ entries: [{ ...LIST.entries[1], reason: 'x' }] }),
    ],
    ['an entry missing its model', () => json({ entries: [{ ...LIST.entries[0], model: 7 }] })],
    [
      'a transport failure',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('%s is the unavailable error, never an empty list', async (_label, answer) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer()),
    );
    await expect(getPlannerModelList()).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('a refused credential is the unauthorized error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => problem('service_unauthorized', 401)),
    );
    await expect(getPlannerModelList()).rejects.toBeInstanceOf(MotirAiUnauthorizedError);
  });
});

describe('updatePlannerModelList', () => {
  it('PUTs { action, model, actorCoreUserId } and returns the list after the change', async () => {
    const fetchMock = vi.fn(async () => json(LIST));
    vi.stubGlobal('fetch', fetchMock);

    await expect(updatePlannerModelList(ADD)).resolves.toEqual(LIST);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ai.example.test/v1/planner-model-list');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual(ADD);
  });

  it.each([
    ['the gateway does not serve it', 'not_servable'],
    ['it is not a chat model', 'not_chat'],
    ['it has no planning-lane rate in force', 'unrated'],
  ] as const)(
    'an add refused because %s is PlannerModelNotQualifiedError(%s)',
    async (why, reason) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          problem(
            'validation_error',
            400,
            `model "glm-5.2" cannot be allowed for planning: ${why}`,
          ),
        ),
      );
      const err = await updatePlannerModelList(ADD).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlannerModelNotQualifiedError);
      expect(err).toMatchObject({ model: 'glm-5.2', reason, detail: why });
    },
  );

  it('a not-qualified wording it does not know keeps the detail and no reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        problem(
          'validation_error',
          400,
          'model "glm-5.2" cannot be allowed for planning: a new cause',
        ),
      ),
    );
    await expect(updatePlannerModelList(ADD)).rejects.toMatchObject({
      reason: null,
      detail: 'a new cause',
    });
  });

  it('removing the fallback is PlannerModelListFallbackError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        problem(
          'validation_error',
          400,
          `model "claude-opus-5-5" is the planner's fallback and must stay on the planning-model list`,
        ),
      ),
    );
    const err = await updatePlannerModelList({ ...REMOVE, model: 'claude-opus-5-5' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PlannerModelListFallbackError);
    expect((err as PlannerModelListFallbackError).model).toBe('claude-opus-5-5');
  });

  it('removing a model in use is PlannerModelListEntryInUseError carrying the audiences', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        problem(
          'validation_error',
          400,
          'model "glm-5.2" is the planning model of: meta, internal — set those audiences to another model first',
        ),
      ),
    );
    const err = await updatePlannerModelList(REMOVE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlannerModelListEntryInUseError);
    expect(err).toMatchObject({ model: 'glm-5.2', audiences: ['meta', 'internal'] });
  });

  it('any other validation_error is PlannerModelListRefusedError with the detail whole', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => problem('validation_error', 400, 'expected add or remove')),
    );
    const err = await updatePlannerModelList(ADD).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlannerModelListRefusedError);
    expect(err).toMatchObject({ model: 'glm-5.2', detail: 'expected add or remove' });
  });

  it('a validation_error with no detail falls back to its title', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => problem('validation_error', 400)),
    );
    await expect(updatePlannerModelList(REMOVE)).rejects.toMatchObject({
      detail: 'validation_error',
    });
  });

  it('a 5xx is the unavailable error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => problem('internal_error', 503)),
    );
    await expect(updatePlannerModelList(ADD)).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('a 2xx body that is not a list is the unavailable error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ ok: true })),
    );
    await expect(updatePlannerModelList(ADD)).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});
