import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentRunUsage } from '@/lib/ai/motirAiClient';
import { MotirAiUnauthorizedError, MotirAiUnavailableError } from '@/lib/ai/errors';

// `getAgentRunUsage` (MOTIR-689) — one hosted run's token and credit totals from
// motir-ai's `GET /v1/agent-runs/:coreRunId/usage` (MOTIR-6381). A 404 is "no
// usage yet" and never an error; every other failure throws, so "could not ask"
// can never read as "cost nothing".

const USAGE = {
  coreRunId: 'run_abc',
  coreOrganizationId: 'org_1',
  model: 'claude-opus-5-5',
  inputTokens: 1200,
  outputTokens: 340,
  cacheMissTokens: 1200,
  cacheReadTokens: 9000,
  cacheWriteTokens: 450,
  credits: 17,
  events: 4,
  startedAt: '2026-09-26T12:00:00.000Z',
  lastUsageAt: '2026-09-26T12:10:00.000Z',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('getAgentRunUsage', () => {
  it('GETs the run by its id with the service credential and returns its totals', async () => {
    const fetchMock = vi.fn(async () => json(USAGE));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getAgentRunUsage('run_abc')).toEqual({
      coreRunId: 'run_abc',
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 9000,
      cacheWriteTokens: 450,
      credits: 17,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ai.test/v1/agent-runs/run_abc/usage');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer svc-token');
  });

  it('returns null on a 404 — a run with no billed call yet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ code: 'not_found', status: 404, title: 'no usage recorded' }, 404)),
    );
    expect(await getAgentRunUsage('run_abc')).toBeNull();
  });

  it('throws the typed error on any other non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ code: 'service_unauthorized', status: 401, title: 'bad token' }, 401),
      ),
    );
    await expect(getAgentRunUsage('run_abc')).rejects.toBeInstanceOf(MotirAiUnauthorizedError);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 })),
    );
    await expect(getAgentRunUsage('run_abc')).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('throws unavailable on a transport failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(getAgentRunUsage('run_abc')).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('throws unavailable on a 200 that carries no numeric totals, or no body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ ...USAGE, credits: '17' })),
    );
    await expect(getAgentRunUsage('run_abc')).rejects.toThrow(/numeric credits/);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(null)),
    );
    await expect(getAgentRunUsage('run_abc')).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('falls back to the asked id when the body names none', async () => {
    const { coreRunId: _omit, ...rest } = USAGE;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(rest)),
    );
    expect((await getAgentRunUsage('run/odd id'))?.coreRunId).toBe('run/odd id');
  });
});
