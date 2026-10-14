import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPendingPlanChange,
  previewPlanDowngrade,
  previewPlanUpgrade,
  schedulePlanDowngrade,
  upgradePlan,
} from '@/lib/ai/motirAiClient';
import {
  MotirAiBadRequestError,
  MotirAiPlanChangeRefusedError,
  MotirAiUnavailableError,
  PLAN_CHANGE_REFUSAL_REASONS,
  planChangeRefusalOf,
} from '@/lib/ai/errors';

// The motir-ai plan-change leaf (Story MOTIR-8387 · MOTIR-8399): the four POSTs
// and the pending-downgrade read, over a stubbed `fetch` (the external network
// call). What only this layer owns: each call's path and body, and turning a
// `<reason>:` refusal into the typed error the service maps by reason.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function problem(code: string, detail: string, status: number) {
  return jsonResponse({ type: 'about:blank', title: code, status, code, detail }, status);
}

beforeEach(() => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the plan-change calls', () => {
  it.each([
    [
      'previewPlanUpgrade',
      () => previewPlanUpgrade({ coreOrganizationId: 'org_1', toPlanKey: 'max' }),
      '/v1/stripe/upgrade/preview',
      { coreOrganizationId: 'org_1', toPlanKey: 'max' },
    ],
    [
      'upgradePlan',
      () =>
        upgradePlan({ coreOrganizationId: 'org_1', toPlanKey: 'max', prorationDate: 1792238400 }),
      '/v1/stripe/upgrade',
      { coreOrganizationId: 'org_1', toPlanKey: 'max', prorationDate: 1792238400 },
    ],
    [
      'previewPlanDowngrade',
      () => previewPlanDowngrade({ coreOrganizationId: 'org_1', toPlanKey: 'pro' }),
      '/v1/stripe/downgrade/preview',
      { coreOrganizationId: 'org_1', toPlanKey: 'pro' },
    ],
    [
      'schedulePlanDowngrade',
      () => schedulePlanDowngrade({ coreOrganizationId: 'org_1', toPlanKey: 'pro' }),
      '/v1/stripe/downgrade',
      { coreOrganizationId: 'org_1', toPlanKey: 'pro' },
    ],
  ] as const)('%s POSTs its body to %s and returns the answer', async (_n, call, path, body) => {
    const answer = { status: 'whatever-motir-ai-says' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(answer));
    vi.stubGlobal('fetch', fetchMock);

    expect(await call()).toEqual(answer);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://ai.example.test${path}`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer svc-token');
    expect(JSON.parse(init.body)).toEqual(body);
  });

  it.each([
    ['validation_error', 'payment_failed: the card was declined', 400, 'payment_failed'],
    ['validation_error', 'same_plan: organization is already on max', 400, 'same_plan'],
    ['validation_error', 'preview_expired: preview it again', 400, 'preview_expired'],
    ['conflict', 'org_closing: organization org_1 is closing', 409, 'org_closing'],
  ])('turns a %s "%s" into a refusal carrying its reason', async (code, detail, status, reason) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problem(code, detail, status)));
    const err = await upgradePlan({
      coreOrganizationId: 'org_1',
      toPlanKey: 'max',
      prorationDate: 1,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MotirAiPlanChangeRefusedError);
    expect(err).toMatchObject({ reason, code: 'MOTIR_AI_PLAN_CHANGE_REFUSED' });
  });

  it('maps a problem with no known reason through the shared taxonomy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(problem('validation_error', 'toPlanKey is required', 400)),
    );
    await expect(
      previewPlanUpgrade({ coreOrganizationId: 'org_1', toPlanKey: '' }),
    ).rejects.toBeInstanceOf(MotirAiBadRequestError);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problem('internal_error', 'boom', 500)));
    await expect(
      previewPlanDowngrade({ coreOrganizationId: 'org_1', toPlanKey: 'pro' }),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});

describe('planChangeRefusalOf', () => {
  it('knows every reason motir-ai answers, and nothing else', () => {
    expect([...PLAN_CHANGE_REFUSAL_REASONS].sort()).toEqual(
      [
        'no_live_plan',
        'not_a_downgrade',
        'not_an_upgrade',
        'org_closing',
        'payment_failed',
        'preview_expired',
        'same_plan',
        'second_plan',
        'unknown_plan',
      ].sort(),
    );
    const base = { type: 'about:blank', title: 't', status: 400 };
    expect(planChangeRefusalOf({ ...base, code: 'validation_error', detail: 'gold: x' })).toBe(
      null,
    );
    expect(planChangeRefusalOf({ ...base, code: 'not_found', detail: 'same_plan: x' })).toBe(null);
    expect(planChangeRefusalOf({ ...base, code: 'validation_error' })).toBe(null);
  });
});

describe('getPendingPlanChange', () => {
  it('GETs the pending downgrade for the org', async () => {
    const pending = { planKey: 'pro', effectiveDate: '2026-11-01T00:00:00.000Z' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ pendingDowngrade: pending }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getPendingPlanChange({ coreOrganizationId: 'org 1' })).toEqual({
      pendingDowngrade: pending,
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://ai.example.test/v1/stripe/pending-plan-change?coreOrganizationId=org+1',
    );
  });

  it('reads an absent field as nothing scheduled, and throws on a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})));
    expect(await getPendingPlanChange({ coreOrganizationId: 'org_1' })).toEqual({
      pendingDowngrade: null,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problem('internal_error', 'stripe', 500)));
    await expect(getPendingPlanChange({ coreOrganizationId: 'org_1' })).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
  });
});
