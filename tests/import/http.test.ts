import { describe, expect, it, vi } from 'vitest';
import {
  backoffDelay,
  fetchWithRetry,
  paginate,
  parseLinkHeader,
  parseRetryAfter,
  queryParam,
  type RetryOptions,
} from '@/lib/import/connectors/http';
import { ConnectorAuthError, ConnectorHttpError } from '@/lib/import/connectors/errors';

// Unit tests for the shared paginate + rate-limit/retry scaffolding (MOTIR-1501).
// `sleep` and `random` are injected so retries are instant + deterministic.

const noSleep = () => Promise.resolve();
const noJitter = () => 0;

function res(status: number, body = '', headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function opts(fetchImpl: typeof fetch, extra: Partial<RetryOptions> = {}): RetryOptions {
  return { fetchImpl, sleep: noSleep, random: noJitter, baseDelayMs: 1, ...extra };
}

describe('fetchWithRetry', () => {
  it('returns the first 2xx without retrying', async () => {
    const fetchImpl = vi.fn(async () => res(200, 'ok'));
    const r = await fetchWithRetry('https://x/a', {}, opts(fetchImpl as unknown as typeof fetch));
    expect(await r.text()).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx then succeeds', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200, 'ok'));
    const r = await fetchWithRetry('https://x/a', {}, opts(fetchImpl as unknown as typeof fetch));
    expect(r.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('waits the Retry-After on a 429 then succeeds', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(429, '', { 'retry-after': '2' }))
      .mockResolvedValueOnce(res(200, 'ok'));
    const r = await fetchWithRetry(
      'https://x/a',
      {},
      { fetchImpl: fetchImpl as unknown as typeof fetch, sleep, random: noJitter },
    );
    expect(r.status).toBe(200);
    expect(sleep).toHaveBeenCalledWith(2000); // 2s honoured
  });

  it('throws ConnectorAuthError on 401 without retrying', async () => {
    const fetchImpl = vi.fn(async () => res(401));
    await expect(
      fetchWithRetry('https://x/a', {}, opts(fetchImpl as unknown as typeof fetch)),
    ).rejects.toBeInstanceOf(ConnectorAuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws ConnectorHttpError on a 404 without retrying', async () => {
    const fetchImpl = vi.fn(async () => res(404));
    await expect(
      fetchWithRetry('https://x/a', {}, opts(fetchImpl as unknown as typeof fetch)),
    ).rejects.toMatchObject({ code: 'CONNECTOR_HTTP', status: 404 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries on persistent 5xx and throws ConnectorHttpError', async () => {
    const fetchImpl = vi.fn(async () => res(500));
    await expect(
      fetchWithRetry(
        'https://x/a',
        {},
        opts(fetchImpl as unknown as typeof fetch, { maxAttempts: 3 }),
      ),
    ).rejects.toBeInstanceOf(ConnectorHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries a network throw then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(res(200, 'ok'));
    const r = await fetchWithRetry('https://x/a', {}, opts(fetchImpl as unknown as typeof fetch));
    expect(r.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a 403 secondary-rate-limit (has retry-after) rather than failing as auth', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(403, '', { 'retry-after': '1' }))
      .mockResolvedValueOnce(res(200, 'ok'));
    const r = await fetchWithRetry('https://x/a', {}, opts(fetchImpl as unknown as typeof fetch));
    expect(r.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats a plain 403 (no rate-limit signal) as auth', async () => {
    const fetchImpl = vi.fn(async () => res(403));
    await expect(
      fetchWithRetry('https://x/a', {}, opts(fetchImpl as unknown as typeof fetch)),
    ).rejects.toBeInstanceOf(ConnectorAuthError);
  });
});

describe('parseRetryAfter', () => {
  it('parses a numeric seconds value', () => {
    expect(parseRetryAfter('5')).toBe(5000);
  });
  it('parses an HTTP-date relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:03 GMT', now)).toBe(3000);
  });
  it('returns null for absent/garbage', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

describe('backoffDelay', () => {
  it('grows exponentially and caps at maxDelay', () => {
    expect(backoffDelay(1, 100, 10_000, () => 1 - 1e-9)).toBeLessThan(100);
    // attempt 5 → 100 * 16 = 1600, jitter 0.5 → 800
    expect(backoffDelay(5, 100, 10_000, () => 0.5)).toBe(800);
    // huge attempt caps at maxDelay before jitter
    expect(backoffDelay(20, 100, 1000, () => 0.5)).toBe(500);
  });
});

describe('parseLinkHeader / queryParam', () => {
  it('parses rel links', () => {
    const h = '<https://api/x?page=2>; rel="next", <https://api/x?page=9>; rel="last"';
    expect(parseLinkHeader(h)).toEqual({
      next: 'https://api/x?page=2',
      last: 'https://api/x?page=9',
    });
  });
  it('returns {} for null', () => {
    expect(parseLinkHeader(null)).toEqual({});
  });
  it('extracts a query param', () => {
    expect(queryParam('https://api/x?page=2&per_page=100', 'page')).toBe('2');
    expect(queryParam('https://api/x?page=2', 'missing')).toBeNull();
  });
});

describe('paginate', () => {
  it('drives pages to exhaustion', async () => {
    const pages: Record<string, { page: number[]; nextCursor: string | null }> = {
      START: { page: [1, 2], nextCursor: 'b' },
      b: { page: [3], nextCursor: null },
    };
    const collected: number[] = [];
    for await (const p of paginate<number[]>(async (cursor) => pages[cursor ?? 'START']!)) {
      collected.push(...p);
    }
    expect(collected).toEqual([1, 2, 3]);
  });

  it('terminates on a repeated cursor (never loops forever)', async () => {
    let calls = 0;
    const gen = paginate<number[]>(async () => {
      calls += 1;
      return { page: [calls], nextCursor: 'same' };
    });
    const collected: number[] = [];
    for await (const p of gen) collected.push(...p);
    expect(calls).toBe(2); // first yields nextCursor 'same', second sees it repeated → stop
    expect(collected).toEqual([1, 2]);
  });
});
