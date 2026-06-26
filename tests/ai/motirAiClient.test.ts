import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  submitJob,
  getJob,
  getPreplanState,
  parseSseFrame,
  createCheckoutSession,
  createPortalSession,
  type RequestActor,
} from '@/lib/ai/motirAiClient';
import { verifyJobToken } from '@/lib/ai/jobToken';
import {
  MotirAiConfigError,
  MotirAiBadRequestError,
  MotirAiUnavailableError,
  MotirAiJobNotFoundError,
} from '@/lib/ai/errors';

const tenant = {
  organizationId: 'org_1',
  isMeta: false,
  workspaceId: 'ws_1',
  projectId: 'pj_1',
  projectKey: 'MOTIR',
};
const actor: RequestActor = { userId: 'user_1' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

beforeEach(() => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('config fail-fast', () => {
  it('throws MotirAiConfigError when MOTIR_AI_URL is unset', async () => {
    delete process.env['MOTIR_AI_URL'];
    await expect(submitJob('noop', tenant, {}, actor)).rejects.toBeInstanceOf(MotirAiConfigError);
  });

  it('throws MotirAiConfigError when the service token is unset', async () => {
    delete process.env['MOTIR_AI_SERVICE_TOKEN'];
    await expect(getJob('job_1')).rejects.toBeInstanceOf(MotirAiConfigError);
  });
});

describe('submitJob', () => {
  it('posts a valid v1 envelope with a fresh job-scoped token and returns the jobId', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ jobId: 'job_42', status: 'queued' }, 202));
    vi.stubGlobal('fetch', fetchMock);

    const { jobId } = await submitJob('noop', tenant, { prompt: 'hi' }, actor);
    expect(jobId).toBe('job_42');

    const [reqUrl, init] = fetchMock.mock.calls[0]!;
    expect(reqUrl).toBe('https://ai.example.test/v1/jobs');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer svc-token');

    const body = JSON.parse(init.body);
    expect(body.envelopeVersion).toBe('v1');
    expect(body.jobKind).toBe('noop');
    expect(body.tenant).toEqual(tenant);
    expect(body.context).toEqual({ prompt: 'hi' });
    // the minted read-back token verifies and is scoped to the actor + project
    const claims = verifyJobToken(body.readBackToken);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('user_1');
    expect(claims!.projectId).toBe('pj_1');
  });

  it('maps a 400 problem+json to MotirAiBadRequestError', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { type: 't', title: 'bad', status: 400, code: 'validation_error', detail: 'nope' },
            400,
          ),
        ),
    );
    await expect(submitJob('noop', tenant, {}, actor)).rejects.toBeInstanceOf(
      MotirAiBadRequestError,
    );
  });

  it('maps a network failure to MotirAiUnavailableError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(submitJob('noop', tenant, {}, actor)).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
  });
});

describe('getJob', () => {
  it('returns a succeeded view with the result and no error', async () => {
    const result = {
      envelopeVersion: 'v1',
      jobKind: 'noop',
      planDelta: { operations: [] },
      summary: 'ok',
      usage: { model: null, inputTokens: 0, outputTokens: 0 },
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ jobId: 'job_1', status: 'succeeded', result, error: null }),
        ),
    );
    const view = await getJob('job_1');
    expect(view.status).toBe('succeeded');
    expect(view.result).toEqual(result);
    expect(view.error).toBeNull();
  });

  it('maps a failed job error into a typed error on the view', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          jobId: 'job_1',
          status: 'failed',
          result: null,
          error: { type: 't', title: 'failed', status: 500, code: 'ai_job_failed', detail: 'boom' },
        }),
      ),
    );
    const view = await getJob('job_1');
    expect(view.status).toBe('failed');
    expect(view.error).toBeInstanceOf(MotirAiUnavailableError);
  });

  it('throws MotirAiJobNotFoundError on a 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { type: 't', title: 'nf', status: 404, code: 'not_found', jobId: 'job_x' },
            404,
          ),
        ),
    );
    await expect(getJob('job_x')).rejects.toBeInstanceOf(MotirAiJobNotFoundError);
  });
});

describe('getPreplanState', () => {
  const query = { coreWorkspaceId: 'ws_1', coreProjectId: 'pj_1' };

  it('GETs /v1/preplan with the core ids + service credential, returns the parsed state', async () => {
    const state = {
      session: {
        aiProjectId: 'ai_1',
        classification: 'startup',
        platform: 'web',
        docSkipSet: ['feasibility'],
        designStarter: 'next-prisma-vercel',
        validationTiming: 'standard',
        currentGate: 'vision',
        conversation: [{ role: 'user', content: 'hi' }],
        status: 'active',
        createdAt: '2026-06-19T00:00:00.000Z',
        updatedAt: '2026-06-19T00:00:00.000Z',
      },
      docs: [
        {
          kind: 'discovery',
          currentBody: '# Discovery (Tier 1)\n\n## 1. Audience\n\nEnterprise teams.',
          currentVersion: 2,
          summary: [],
          versions: [
            { version: 1, changeReason: null, changeKind: 'created', diff: null, createdAt: '…' },
            {
              version: 2,
              changeReason: 'enterprise audience',
              changeKind: 'direct_revision',
              diff: [{ path: 'problem.gap', kind: 'changed', before: 'a', after: 'b' }],
              createdAt: '…',
            },
          ],
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(state));
    vi.stubGlobal('fetch', fetchMock);

    const got = await getPreplanState(query);

    const [reqUrl, init] = fetchMock.mock.calls[0]!;
    const u = new URL(reqUrl as string);
    expect(u.pathname).toBe('/v1/preplan');
    expect(u.searchParams.get('coreWorkspaceId')).toBe('ws_1');
    expect(u.searchParams.get('coreProjectId')).toBe('pj_1');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer svc-token' });
    expect(got).toEqual(state);
  });

  it('returns the empty state for a not-yet-started project (not an error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ session: null, docs: [] })));
    expect(await getPreplanState(query)).toEqual({ session: null, docs: [] });
  });

  it('maps a 400 to a typed bad-request error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ type: 't', title: 'bad', status: 400, code: 'validation_error' }, 400),
        ),
    );
    await expect(getPreplanState(query)).rejects.toBeInstanceOf(MotirAiBadRequestError);
  });

  it('maps a transport failure to MotirAiUnavailableError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(getPreplanState(query)).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});

describe('createCheckoutSession', () => {
  const input = {
    coreOrganizationId: 'org_1',
    priceId: 'pro_pool_annual',
    successUrl: 'https://app.test/settings/organization/billing?checkout=success',
    cancelUrl: 'https://app.test/settings/organization/billing?checkout=cancel',
  };

  it('POSTs the input to /v1/stripe/checkout-session and returns the hosted url', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' }));
    vi.stubGlobal('fetch', fetchMock);

    const { url } = await createCheckoutSession(input);
    expect(url).toBe('https://checkout.stripe.com/c/pay/cs_test_1');

    const [reqUrl, init] = fetchMock.mock.calls[0]!;
    expect(reqUrl).toBe('https://ai.example.test/v1/stripe/checkout-session');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer svc-token');
    expect(JSON.parse(init.body)).toEqual(input);
  });

  it('maps a problem+json error to a typed error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ code: 'validation_error', title: 'bad price', status: 400 }, 400),
        ),
    );
    await expect(createCheckoutSession(input)).rejects.toBeInstanceOf(MotirAiBadRequestError);
  });

  it('throws when a 2xx response is missing the url', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 200)));
    await expect(createCheckoutSession(input)).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('maps a transport failure to MotirAiUnavailableError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(createCheckoutSession(input)).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});

describe('createPortalSession', () => {
  const input = {
    coreOrganizationId: 'org_1',
    returnUrl: 'https://app.test/settings/organization/billing',
  };

  it('POSTs to /v1/stripe/portal-session and returns the portal url', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ url: 'https://billing.stripe.com/p/session/1' }));
    vi.stubGlobal('fetch', fetchMock);

    const { url } = await createPortalSession(input);
    expect(url).toBe('https://billing.stripe.com/p/session/1');

    const [reqUrl, init] = fetchMock.mock.calls[0]!;
    expect(reqUrl).toBe('https://ai.example.test/v1/stripe/portal-session');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(input);
  });

  it('maps a 404 (no Stripe customer yet) to MotirAiJobNotFoundError', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ code: 'not_found', title: 'no customer', status: 404 }, 404),
        ),
    );
    await expect(createPortalSession(input)).rejects.toBeInstanceOf(MotirAiJobNotFoundError);
  });
});

describe('parseSseFrame', () => {
  it('parses an event + JSON data frame', () => {
    const ev = parseSseFrame('event: status\ndata: {"jobId":"job_1","status":"running"}');
    expect(ev).toEqual({ event: 'status', data: { jobId: 'job_1', status: 'running' } });
  });

  it('defaults the event name and keeps non-JSON data as a string', () => {
    expect(parseSseFrame('data: hello')).toEqual({ event: 'message', data: 'hello' });
  });

  it('returns null for a comment-only / dataless frame', () => {
    expect(parseSseFrame(': keep-alive')).toBeNull();
    expect(parseSseFrame('event: status')).toBeNull();
  });
});
