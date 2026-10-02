import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SENTRY_ERROR_COUNT_TIMEOUT_MS,
  httpErrorCountReader,
  readErrorCount24h,
  resetSentryProjectIdCache,
} from '@/lib/monitoring/sentryErrorCount';
import { errorCountReader, usingFakeErrorCount } from '@/lib/monitoring/errorCountProvider';

// THE PLATFORM'S SENTRY ERROR COUNT CLIENT (MOTIR-740). `fetch` is the seam
// stubbed here, as for every outbound HTTP client in this repository; the bodies
// are Sentry's documented shapes for *Retrieve a Project* and *Retrieve Event
// Counts for an Organization (v2)*, trimmed to the fields the client reads.

const PROJECT = { id: '4508123456789', slug: 'motir-core', name: 'motir-core' };

function stats(...totals: number[]) {
  return {
    start: '2026-10-01T18:00:00Z',
    end: '2026-10-02T18:00:00Z',
    intervals: ['2026-10-01T18:00:00Z'],
    groups: totals.map((t) => ({ by: {}, totals: { 'sum(quantity)': t }, series: {} })),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Route by path: the project read, then the stats read. */
function sentry(statsBody: unknown, statsStatus = 200, projectBody: unknown = PROJECT) {
  return vi.fn(async (url: string) =>
    url.includes('/stats_v2/') ? json(statsBody, statsStatus) : json(projectBody),
  );
}

beforeEach(() => {
  resetSentryProjectIdCache();
  vi.stubEnv('SENTRY_READ_TOKEN', 'read-token');
  vi.stubEnv('SENTRY_ORG', 'motir');
  vi.stubEnv('SENTRY_PROJECT', 'motir-core');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('readErrorCount24h', () => {
  it('resolves the project id, then sums the accepted errors over 24h', async () => {
    const fetchMock = sentry(stats(12));
    vi.stubGlobal('fetch', fetchMock);

    const reading = await readErrorCount24h();

    expect(reading).toEqual({ count: 12, projectId: '4508123456789', org: 'motir' });
    const urls = (fetchMock.mock.calls as unknown as [string][]).map(([u]) => u);
    expect(urls[0]).toBe('https://sentry.io/api/0/projects/motir/motir-core/');
    const statsUrl = new URL(urls[1]!);
    expect(statsUrl.pathname).toBe('/api/0/organizations/motir/stats_v2/');
    expect(Object.fromEntries(statsUrl.searchParams)).toEqual({
      field: 'sum(quantity)',
      category: 'error',
      outcome: 'accepted',
      statsPeriod: '24h',
      project: '4508123456789',
    });
  });

  it('sends GET only, with the read token as a bearer', async () => {
    const fetchMock = sentry(stats(1));
    vi.stubGlobal('fetch', fetchMock);
    await readErrorCount24h();
    for (const [, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer read-token');
    }
  });

  it('resolves the project id ONCE per process', async () => {
    const fetchMock = sentry(stats(3));
    vi.stubGlobal('fetch', fetchMock);
    await readErrorCount24h();
    await readErrorCount24h();
    const projectReads = (fetchMock.mock.calls as unknown as [string][]).filter(
      ([u]) => !u.includes('/stats_v2/'),
    );
    expect(projectReads).toHaveLength(1);
  });

  it('sums every group Sentry returns', async () => {
    vi.stubGlobal('fetch', sentry(stats(4, 5)));
    expect((await readErrorCount24h()).count).toBe(9);
  });

  it('an EMPTY groups array is a measured zero', async () => {
    vi.stubGlobal('fetch', sentry(stats()));
    expect((await readErrorCount24h()).count).toBe(0);
  });

  it('throws on a 401 rather than answering zero', async () => {
    vi.stubGlobal('fetch', sentry({ detail: 'Invalid token' }, 401));
    await expect(readErrorCount24h()).rejects.toThrow(/answered 401/);
  });

  it('throws on a 5xx', async () => {
    vi.stubGlobal('fetch', sentry({}, 503));
    await expect(readErrorCount24h()).rejects.toThrow(/answered 503/);
  });

  it.each([
    ['no groups', { start: 'x' }, /no groups/],
    ['a group with no total', { groups: [{ totals: {} }] }, /no total/],
    ['a negative total', { groups: [{ totals: { 'sum(quantity)': -1 } }] }, /no total/],
    ['a non-object body', [1], /no groups/],
  ])('throws on a malformed stats body — %s', async (_label, body, message) => {
    vi.stubGlobal('fetch', sentry(body));
    await expect(readErrorCount24h()).rejects.toThrow(message);
  });

  it('throws when the project read carries no numeric id', async () => {
    vi.stubGlobal('fetch', sentry(stats(1), 200, { slug: 'motir-core' }));
    await expect(readErrorCount24h()).rejects.toThrow(/no numeric id/);
  });

  it('throws on a timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );
    const pending = readErrorCount24h();
    const assertion = expect(pending).rejects.toThrow(/did not answer within 3000ms/);
    await vi.advanceTimersByTimeAsync(SENTRY_ERROR_COUNT_TIMEOUT_MS);
    await assertion;
  });

  it('rethrows a network failure as itself', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(readErrorCount24h()).rejects.toThrow('fetch failed');
  });

  it('refuses to read without the credential', async () => {
    vi.stubEnv('SENTRY_READ_TOKEN', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(readErrorCount24h()).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the real reader', () => {
  it.each(['SENTRY_READ_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT'])(
    'is not configured without %s',
    (name) => {
      vi.stubEnv(name, '  ');
      expect(httpErrorCountReader.configured()).toBe(false);
    },
  );

  it('links out to the project-scoped issues view over the same window', () => {
    expect(httpErrorCountReader.configured()).toBe(true);
    expect(httpErrorCountReader.issuesUrl({ count: 1, projectId: '42', org: 'motir' })).toBe(
      'https://motir.sentry.io/issues/?project=42&statsPeriod=24h',
    );
  });
});

describe('the E2E fake binding', () => {
  it('is used when the flag is set outside production', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MOTIR_E2E_FAKE_ERROR_COUNT', '1');
    expect(usingFakeErrorCount()).toBe(true);
    const reader = errorCountReader();
    expect(reader).not.toBe(httpErrorCountReader);
    expect(reader.configured()).toBe(true);
    const reading = await reader.read();
    expect(reading.count).toBeLessThan(100);
    expect(reader.issuesUrl(reading)).toBeNull();
  });

  it('⚠️ is IGNORED in a production build without the E2E harness', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('E2E_PROD_HARNESS', '');
    vi.stubEnv('MOTIR_E2E_FAKE_ERROR_COUNT', '1');
    expect(usingFakeErrorCount()).toBe(false);
    expect(errorCountReader()).toBe(httpErrorCountReader);
  });

  it('arms in a production build only when the E2E harness is ALSO set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('E2E_PROD_HARNESS', '1');
    vi.stubEnv('MOTIR_E2E_FAKE_ERROR_COUNT', '1');
    expect(usingFakeErrorCount()).toBe(true);
  });
});
