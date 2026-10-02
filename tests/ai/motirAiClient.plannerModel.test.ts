import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlannerModelSettings, setPlannerModel } from '@/lib/ai/motirAiClient';
import {
  MotirAiUnauthorizedError,
  MotirAiUnavailableError,
  PlannerModelNotOfferedError,
  PlannerModelUnreachableError,
} from '@/lib/ai/errors';
import type { PlannerModelSettingsRead } from '@/lib/ai/types';

// The platform planning model across the boundary (Story MOTIR-7220 ·
// MOTIR-7227; motir-ai MOTIR-7221 / MOTIR-7236). The HTTP boundary is stubbed:
// what these pin is the request each function sends and how each motir-ai answer
// becomes a motir-core value or typed error.

const SETTINGS: PlannerModelSettingsRead = {
  settings: [
    {
      audience: 'customer',
      model: 'claude-opus-5-5',
      offered: true,
      updatedAt: '2026-10-02T09:00:00.000Z',
      updatedByCoreUserId: null,
      reachable: true,
      lastProbeAt: '2026-10-02T09:05:00.000Z',
      lastProbeError: null,
    },
  ],
  offered: [{ id: 'claude-opus-5-5', provider: 'anthropic' }],
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

const INPUT = { audience: 'meta' as const, model: 'glm-5.2', actorCoreUserId: 'u_1' };

beforeEach(() => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test/';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getPlannerModelSettings', () => {
  it('GETs the settings with the service bearer and returns the body', async () => {
    const fetchMock = vi.fn(async () => json(SETTINGS));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getPlannerModelSettings()).resolves.toEqual(SETTINGS);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ai.example.test/v1/planner-model-settings');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer svc-token');
  });

  it('a 5xx is the unavailable error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => problem('internal_error', 500)),
    );
    await expect(getPlannerModelSettings()).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('a transport failure is the unavailable error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(getPlannerModelSettings()).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('a body that is not the settings shape is the unavailable error, never a guess', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ settings: 'nope' })),
    );
    await expect(getPlannerModelSettings()).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('a refused credential is the unauthorized error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => problem('service_unauthorized', 401)),
    );
    await expect(getPlannerModelSettings()).rejects.toBeInstanceOf(MotirAiUnauthorizedError);
  });
});

describe('setPlannerModel', () => {
  it('PUTs { audience, model, actorCoreUserId } and returns the write answer', async () => {
    const answer = {
      audience: 'meta',
      previousModel: 'claude-opus-5-5',
      model: 'glm-5.2',
      updatedAt: '2026-10-02T10:00:00.000Z',
    };
    const fetchMock = vi.fn(async () => json(answer));
    vi.stubGlobal('fetch', fetchMock);

    await expect(setPlannerModel(INPUT)).resolves.toEqual(answer);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ai.example.test/v1/planner-model-settings');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual(INPUT);
  });

  it('validation_error is PlannerModelNotOfferedError naming the model', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => problem('validation_error', 400, '"glm-5.2" is not offered for planning')),
    );
    const err = await setPlannerModel(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlannerModelNotOfferedError);
    expect((err as PlannerModelNotOfferedError).model).toBe('glm-5.2');
  });

  it('model_unreachable is PlannerModelUnreachableError carrying the probe reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        problem(
          'model_unreachable',
          422,
          'model "glm-5.2" is not reachable for the planner: the provider key was refused (gateway answered 401)',
        ),
      ),
    );
    const err = await setPlannerModel(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlannerModelUnreachableError);
    expect(err).toMatchObject({
      model: 'glm-5.2',
      reason: 'the provider key was refused (gateway answered 401)',
    });
  });

  it('a model_unreachable detail in another wording is kept whole', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => problem('model_unreachable', 422, 'timed out')),
    );
    await expect(setPlannerModel(INPUT)).rejects.toMatchObject({ reason: 'timed out' });
  });

  it('a 5xx is the unavailable error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => problem('internal_error', 503)),
    );
    await expect(setPlannerModel(INPUT)).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('a 2xx body that is not a write answer is the unavailable error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ ok: true })),
    );
    await expect(setPlannerModel(INPUT)).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});
