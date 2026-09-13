import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitorProviderCallError, UnknownMonitorProviderError } from '@/lib/monitors/errors';
import {
  MONITOR_GRANT_EXCHANGE_TIMEOUT_MS,
  MONITOR_HEALTH_TIMEOUT_MS,
  MONITOR_LIST_ISSUES_TIMEOUT_MS,
  MONITOR_LIST_PROJECTS_TIMEOUT_MS,
  MONITOR_REFRESH_TIMEOUT_MS,
  MONITOR_RESOLVE_ISSUE_TIMEOUT_MS,
  MONITOR_VERIFY_INSTALL_TIMEOUT_MS,
  type MonitorProvider,
} from '@/lib/monitors/provider';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
} from '@/lib/monitors/providers/fake';
import { nextCursorFromLinkHeader, sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import {
  getMonitorProvider,
  registerMonitorProvider,
  registeredMonitorProviderIds,
} from '@/lib/monitors/registry';

// The `MonitorProvider` seam, its registry, the Sentry adapter and the fake
// (Story MOTIR-4926 · Subtask MOTIR-5259).
//
// ⚠️ NOTHING HERE OPENS A SOCKET TO SENTRY.IO, and one test asserts it rather
// than trusting it: `fetch` is replaced by a stub that RECORDS its calls, so a
// request to a real host is an assertion failure instead of a slow test on a
// good day and a red suite on a bad one. The fake path calls no `fetch` at all.
//
// The Sentry adapter's requests are driven through that stub, which is the only
// way its documented contract — the `grant_type` values, the paths, the verify
// PUT's body — can be pinned by a test that is not allowed to reach the host.

const realFetch = globalThis.fetch;

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

let calls: RecordedCall[] = [];

/** Stub `fetch` with a queue of canned responses, recording every request. */
function stubFetch(
  responses: { status?: number; body?: unknown; headers?: Record<string, string> }[],
): void {
  const queue = [...responses];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    // The property this stub exists to protect: a call to the real host is a
    // failure of THIS test, reported here rather than as a timeout later.
    if (/(^|\.)sentry\.io/.test(new URL(url).hostname)) {
      throw new Error(`the suite must not reach sentry.io (tried ${url})`);
    }
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = queue.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
  resetFakeMonitorProvider();
  process.env['SENTRY_API_BASE_URL'] = 'https://monitor-stub.invalid/api/0';
  process.env['SENTRY_APP_CLIENT_ID'] = 'test-client-id';
  process.env['SENTRY_APP_CLIENT_SECRET'] = 'test-client-secret';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  delete process.env['SENTRY_API_BASE_URL'];
  delete process.env['SENTRY_APP_CLIENT_ID'];
  delete process.env['SENTRY_APP_CLIENT_SECRET'];
});

describe('the seam is ONE interface, and every network method bounds itself', () => {
  it('declares a NAMED timeout for each network-bound operation', () => {
    // A dead host must surface as a typed error inside the invocation budget
    // rather than as a function timeout with no body — the reason
    // `lib/git/provider.ts` names each of its bounds. Asserting the constants
    // exist and are ordered is what stops one being dropped or set to zero.
    const bounds = {
      exchangeGrant: MONITOR_GRANT_EXCHANGE_TIMEOUT_MS,
      verifyInstall: MONITOR_VERIFY_INSTALL_TIMEOUT_MS,
      refreshCredential: MONITOR_REFRESH_TIMEOUT_MS,
      describeHealth: MONITOR_HEALTH_TIMEOUT_MS,
      listProjects: MONITOR_LIST_PROJECTS_TIMEOUT_MS,
      listIssuesSince: MONITOR_LIST_ISSUES_TIMEOUT_MS,
      resolveIssue: MONITOR_RESOLVE_ISSUE_TIMEOUT_MS,
    };
    for (const [operation, ms] of Object.entries(bounds)) {
      expect(ms, operation).toBeGreaterThan(0);
      expect(ms, operation).toBeLessThanOrEqual(60_000);
    }
    // The interactive bounds are tighter than the unattended one: somebody is
    // parked on a redirect for the first two and nobody is watching the third.
    expect(MONITOR_VERIFY_INSTALL_TIMEOUT_MS).toBeLessThan(MONITOR_GRANT_EXCHANGE_TIMEOUT_MS);
    expect(MONITOR_GRANT_EXCHANGE_TIMEOUT_MS).toBeLessThan(MONITOR_REFRESH_TIMEOUT_MS);
  });

  it('is implemented, method for method, by BOTH the Sentry adapter and the fake', () => {
    const methods: (keyof MonitorProvider)[] = [
      'exchangeGrant',
      'verifyInstall',
      'refreshCredential',
      'describeHealth',
      'listProjects',
      'listIssuesSince',
      'resolveIssue',
    ];
    for (const method of methods) {
      expect(typeof sentryMonitorProvider[method], `sentry.${method}`).toBe('function');
      expect(typeof fakeMonitorProvider[method], `fake.${method}`).toBe('function');
    }
  });
});

describe('the registry resolves by the STORED discriminator', () => {
  it('hands back the registered implementation', () => {
    expect(getMonitorProvider('sentry').id).toBe('sentry');
    expect(registeredMonitorProviderIds()).toContain('sentry');
  });

  it('THROWS on an unknown discriminator rather than defaulting to the only member', () => {
    // The whole point: one provider is registered, so "fall back to it" would
    // look harmless and be silent for ever. A row written by a future version
    // must not be read as a row from this one.
    expect(() => getMonitorProvider('datadog')).toThrow(UnknownMonitorProviderError);
    try {
      getMonitorProvider('datadog');
    } catch (err) {
      expect((err as UnknownMonitorProviderError).code).toBe('UNKNOWN_MONITOR_PROVIDER');
      expect((err as UnknownMonitorProviderError).provider).toBe('datadog');
    }
  });

  it('lets the FAKE be registered under the sentry id — the E2E switch, not a vi.mock', async () => {
    // Selection at RUNTIME is what makes the fake reachable from a
    // separately-spawned Next server, where an in-process module mock is not.
    vi.resetModules();
    process.env['MOTIR_MONITOR_FAKE_PROVIDER'] = '1';
    try {
      const monitors = await import('@/lib/monitors');
      expect(monitors.getMonitorProvider('sentry').id).toBe('fake');
    } finally {
      delete process.env['MOTIR_MONITOR_FAKE_PROVIDER'];
      vi.resetModules();
    }
  });

  it('leaves the REAL adapter registered when the switch is absent', async () => {
    vi.resetModules();
    delete process.env['MOTIR_MONITOR_FAKE_PROVIDER'];
    const monitors = await import('@/lib/monitors');
    expect(monitors.getMonitorProvider('sentry').id).toBe('sentry');
    vi.resetModules();
  });
});

describe('the SENTRY adapter, against a stubbed HTTP layer', () => {
  it('exchanges a grant with grant_type=authorization_code', async () => {
    stubFetch([
      {
        body: {
          token: 'access-1',
          refreshToken: 'refresh-1',
          expiresAt: '2026-09-12T20:00:00.000Z',
        },
      },
    ]);

    const credential = await sentryMonitorProvider.exchangeGrant({
      installationId: 'inst-1',
      code: 'code-1',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/sentry-app-installations/inst-1/authorizations/');
    // The documented parameter, pinned: a silently wrong grant_type is a
    // refusal that only appears against the real host.
    expect(calls[0]!.body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code-1',
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
    });
    expect(credential.accessToken).toBe('access-1');
    expect(credential.refreshToken).toBe('refresh-1');
    expect(credential.expiresAt.toISOString()).toBe('2026-09-12T20:00:00.000Z');
  });

  it('refreshes with grant_type=refresh_token on the SAME endpoint', async () => {
    stubFetch([{ body: { token: 'access-2', refreshToken: 'refresh-2' } }]);

    const credential = await sentryMonitorProvider.refreshCredential({
      installationId: 'inst-1',
      refreshToken: 'refresh-1',
    });

    expect(calls[0]!.body).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
    });
    expect(calls[0]!.url).toContain('/sentry-app-installations/inst-1/authorizations/');
    // No stated expiry: the documented eight-hour life, never "never expires",
    // because a credential believed permanent is one nothing refreshes.
    expect(credential.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(credential.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 8 * 60 * 60 * 1000);
  });

  it('verifies the install with { status: "installed" }', async () => {
    stubFetch([{ body: {} }]);
    await sentryMonitorProvider.verifyInstall({
      installationId: 'inst-1',
      accessToken: 'access-1',
    });

    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toContain('/sentry-app-installations/inst-1/');
    expect(calls[0]!.body).toEqual({ status: 'installed' });
    expect(calls[0]!.headers['authorization']).toBe('Bearer access-1');
  });

  it('CARRIES the provider’s own reason out of a non-2xx', async () => {
    stubFetch([
      { status: 403, body: { detail: 'You do not have permission to perform this action.' } },
    ]);

    await expect(
      sentryMonitorProvider.listProjects({ accessToken: 'access-1', orgSlug: 'motir' }),
    ).rejects.toBeInstanceOf(MonitorProviderCallError);

    stubFetch([
      { status: 403, body: { detail: 'You do not have permission to perform this action.' } },
    ]);
    try {
      await sentryMonitorProvider.listProjects({ accessToken: 'access-1', orgSlug: 'motir' });
    } catch (err) {
      const failure = err as MonitorProviderCallError;
      // The credential-lifecycle card renders this string to a person, so it may
      // not be swallowed or re-worded here.
      expect(failure.providerReason).toBe('You do not have permission to perform this action.');
      expect(failure.status).toBe(403);
      expect(failure.operation).toBe('listProjects');
    }
  });

  it('answers describeHealth with a VERDICT, not a throw, when the credential is revoked', async () => {
    stubFetch([{ status: 401, body: { detail: 'Invalid token' } }]);

    const health = await sentryMonitorProvider.describeHealth({
      accessToken: 'revoked',
      orgSlug: 'motir',
    });

    // `degraded` is the fact this epic exists to make visible — a value to store
    // and render, never an exception whose answer gets logged and lost.
    expect(health.status).toBe('degraded');
    expect(health.reason).toBe('Invalid token');
    expect(health.checkedAt).toBeInstanceOf(Date);
  });

  it('answers describeHealth "connected" on a cheap authenticated read', async () => {
    stubFetch([{ body: { slug: 'motir' } }]);
    const health = await sentryMonitorProvider.describeHealth({
      accessToken: 'access-1',
      orgSlug: 'motir',
    });
    expect(health.status).toBe('connected');
    expect(health.reason).toBeNull();
    expect(calls[0]!.url).toContain('/organizations/motir/');
  });

  it('normalizes the project list and drops a row it cannot key', async () => {
    stubFetch([
      {
        body: [
          { id: '1', slug: 'web', name: 'Web' },
          { id: '2', slug: 'worker' },
          { slug: 'no-id-at-all' },
        ],
      },
    ]);

    const projects = await sentryMonitorProvider.listProjects({
      accessToken: 'access-1',
      orgSlug: 'motir',
    });

    expect(projects).toEqual([
      { externalId: '1', slug: 'web', name: 'Web' },
      // Name falls back to the slug rather than to empty — a picker row with no
      // label is a row nobody can choose.
      { externalId: '2', slug: 'worker', name: 'worker' },
    ]);
  });

  it('normalizes an issue page and reads the next cursor from the Link header', async () => {
    stubFetch([
      {
        body: [
          {
            id: 'issue-1',
            title: 'TypeError: x is not a function',
            culprit: 'lib/foo.ts in bar',
            level: 'error',
            count: '7',
            firstSeen: '2026-09-01T00:00:00.000Z',
            lastSeen: '2026-09-10T00:00:00.000Z',
            permalink: 'https://monitor-stub.invalid/issues/issue-1',
          },
        ],
        headers: {
          link: '<https://monitor-stub.invalid/next>; rel="next"; results="true"; cursor="c2"',
        },
      },
    ]);

    const page = await sentryMonitorProvider.listIssuesSince({
      accessToken: 'access-1',
      orgSlug: 'motir',
      projectSlug: 'web',
      cursor: null,
    });

    expect(page.issues).toHaveLength(1);
    expect(page.issues[0]).toMatchObject({
      externalId: 'issue-1',
      culprit: 'lib/foo.ts in bar',
      level: 'error',
      eventCount: 7,
    });
    expect(page.nextCursor).toBe('c2');
  });

  it('reads results="false" as the END of the list, cursor present or not', () => {
    // A poll that reads the cursor anyway loops for ever on the last page.
    expect(
      nextCursorFromLinkHeader('<https://x/next>; rel="next"; results="false"; cursor="c9"'),
    ).toBeNull();
    expect(nextCursorFromLinkHeader(null)).toBeNull();
    expect(nextCursorFromLinkHeader('<https://x/prev>; rel="previous"; cursor="c0"')).toBeNull();
  });

  it('resolves an issue with { status: "resolved" } (MOTIR-4931’s future caller)', async () => {
    stubFetch([{ body: {} }]);
    await sentryMonitorProvider.resolveIssue({
      accessToken: 'access-1',
      externalIssueId: 'issue-1',
    });

    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toContain('/issues/issue-1/');
    expect(calls[0]!.body).toEqual({ status: 'resolved' });
  });

  it('refuses to call at all when the integration is not configured', async () => {
    delete process.env['SENTRY_APP_CLIENT_ID'];
    stubFetch([{ body: {} }]);

    await expect(
      sentryMonitorProvider.exchangeGrant({ installationId: 'inst-1', code: 'code-1' }),
    ).rejects.toBeInstanceOf(MonitorProviderCallError);
    // Read at CALL time, and refused BEFORE the request: a deployment that never
    // registered the integration cannot reach the flow, and does not crash on
    // boot either.
    expect(calls).toHaveLength(0);
  });
});

describe('the FULL interface, driven through the FAKE', () => {
  it('exercises every method without opening a socket', async () => {
    // `fetch` is left as the recording stub, so any network call would be
    // recorded — and the assertion at the end is that none was.
    stubFetch([]);

    const credential = await fakeMonitorProvider.exchangeGrant({
      installationId: 'inst-fake',
      code: 'valid-code',
    });
    expect(credential.accessToken).toBe('fake-access-token');

    await fakeMonitorProvider.verifyInstall({
      installationId: 'inst-fake',
      accessToken: credential.accessToken,
    });
    expect(fakeMonitorState().verifiedInstallations).toEqual(['inst-fake']);

    const refreshed = await fakeMonitorProvider.refreshCredential({
      installationId: 'inst-fake',
      refreshToken: credential.refreshToken,
    });
    // ROTATING, like the real provider's — a fake that returns the same pair
    // forever cannot exhibit the double-refresh hazard MOTIR-5261 serializes on.
    expect(refreshed.refreshToken).not.toBe(credential.refreshToken);

    expect(
      (await fakeMonitorProvider.describeHealth({ accessToken: 'x', orgSlug: 'y' })).status,
    ).toBe('connected');
    expect(await fakeMonitorProvider.listProjects({ accessToken: 'x', orgSlug: 'y' })).toHaveLength(
      2,
    );

    const page = await fakeMonitorProvider.listIssuesSince({
      accessToken: 'x',
      orgSlug: 'y',
      projectSlug: 'web',
      cursor: null,
    });
    expect(page.issues[0]!.externalId).toBe('fake-issue-1');
    expect(page.nextCursor).toBeNull();
    // A cursor means "resume", and the fake's one page is then exhausted.
    expect(
      (
        await fakeMonitorProvider.listIssuesSince({
          accessToken: 'x',
          orgSlug: 'y',
          projectSlug: 'web',
          cursor: 'anything',
        })
      ).issues,
    ).toEqual([]);

    await fakeMonitorProvider.resolveIssue({ accessToken: 'x', externalIssueId: 'fake-issue-1' });
    expect(fakeMonitorState().resolvedIssues).toEqual(['fake-issue-1']);

    // THE PROPERTY: the suite does not depend on Sentry being reachable.
    expect(calls).toEqual([]);
  });

  it('refuses an unknown grant code, as a replayed one is refused', async () => {
    await expect(
      fakeMonitorProvider.exchangeGrant({ installationId: 'inst-fake', code: 'replayed' }),
    ).rejects.toBeInstanceOf(MonitorProviderCallError);
  });

  it('can be made to fail ONE operation, carrying a provider reason', async () => {
    fakeMonitorState().failNext.add('listProjects');
    try {
      await fakeMonitorProvider.listProjects({ accessToken: 'x', orgSlug: 'y' });
      expect.unreachable('listProjects should have failed');
    } catch (err) {
      expect((err as MonitorProviderCallError).providerReason).toBe(
        'The authorization has been revoked.',
      );
    }
    // One-shot: the next call succeeds, so a test cannot accidentally poison the
    // rest of its own run.
    expect(await fakeMonitorProvider.listProjects({ accessToken: 'x', orgSlug: 'y' })).toHaveLength(
      2,
    );
  });

  it('drives the DEGRADED verdict from seeded state, not from a throw', async () => {
    fakeMonitorState().health = {
      status: 'degraded',
      reason: 'The authorization has been revoked.',
      checkedAt: new Date(),
    };
    const health = await fakeMonitorProvider.describeHealth({ accessToken: 'x', orgSlug: 'y' });
    expect(health.status).toBe('degraded');
    expect(health.reason).toBe('The authorization has been revoked.');
  });

  it('is registered under its own id as well, so a test can resolve it explicitly', () => {
    registerMonitorProvider(fakeMonitorProvider);
    expect(getMonitorProvider('fake').id).toBe('fake');
  });
});
