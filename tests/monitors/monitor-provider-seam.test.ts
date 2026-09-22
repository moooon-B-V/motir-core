import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MonitorIssueGoneError,
  MonitorProviderCallError,
  UnknownMonitorProviderError,
} from '@/lib/monitors/errors';
import {
  MONITOR_GET_ISSUE_TIMEOUT_MS,
  MONITOR_GRANT_EXCHANGE_TIMEOUT_MS,
  MONITOR_HEALTH_TIMEOUT_MS,
  MONITOR_ISSUE_CONTEXT_TIMEOUT_MS,
  MONITOR_LIST_ISSUES_TIMEOUT_MS,
  MONITOR_LIST_PROJECTS_TIMEOUT_MS,
  MONITOR_REFRESH_TIMEOUT_MS,
  MONITOR_RESOLVE_ISSUE_TIMEOUT_MS,
  MONITOR_SEARCH_ISSUES_LIMIT,
  MONITOR_SEARCH_ISSUES_TIMEOUT_MS,
  MONITOR_VERIFY_INSTALL_TIMEOUT_MS,
  type MonitorProvider,
} from '@/lib/monitors/provider';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
} from '@/lib/monitors/providers/fake';
import {
  nextCursorFromLinkHeader,
  normalizeIssue,
  normalizeIssueContext,
  sentryMonitorProvider,
} from '@/lib/monitors/providers/sentry';
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
      getIssue: MONITOR_GET_ISSUE_TIMEOUT_MS,
      searchIssues: MONITOR_SEARCH_ISSUES_TIMEOUT_MS,
      getIssueContext: MONITOR_ISSUE_CONTEXT_TIMEOUT_MS,
    };
    for (const [operation, ms] of Object.entries(bounds)) {
      expect(ms, operation).toBeGreaterThan(0);
      expect(ms, operation).toBeLessThanOrEqual(60_000);
    }
    // The verify and the install read run AFTER the exchange has spent Sentry's
    // single-use grant code, so they are bounded by NO LESS than the exchange
    // (MOTIR-6008). This used to assert the opposite — "the interactive bounds
    // are tighter" — and that tight bound is what threw a live grant away.
    expect(MONITOR_VERIFY_INSTALL_TIMEOUT_MS).toBeGreaterThanOrEqual(
      MONITOR_GRANT_EXCHANGE_TIMEOUT_MS,
    );
    // The interactive exchange stays tighter than the unattended refresh:
    // somebody is parked on a redirect for the first and nobody watches the second.
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
      'getIssue',
      'searchIssues',
      'getIssueContext',
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
      externalProjectId: '42',
      lastSeenAfter: null,
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
      externalProjectId: 'fake-web',
      lastSeenAfter: null,
      cursor: null,
    });
    expect(page.issues[0]!.externalId).toBe('fake-issue-1');
    expect(page.nextCursor).toBeNull();

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

describe('listIssuesSince reads SINCE a watermark (MOTIR-5577)', () => {
  const row = (id: string, lastSeen: string) => ({
    id,
    title: `Issue ${id}`,
    culprit: null,
    level: 'error',
    count: '1',
    firstSeen: '2026-09-01T00:00:00.000Z',
    lastSeen,
    permalink: null,
  });

  it('asks the ORGANISATION issues endpoint for the project, unresolved, by last seen, 100 a page', async () => {
    stubFetch([{ body: [] }]);
    await sentryMonitorProvider.listIssuesSince({
      accessToken: 'access-1',
      orgSlug: 'motir org',
      externalProjectId: '4501',
      lastSeenAfter: null,
      cursor: 'c-7',
    });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/0/organizations/motir%20org/issues/');
    expect(url.searchParams.get('project')).toBe('4501');
    expect(url.searchParams.get('query')).toBe('is:unresolved');
    expect(url.searchParams.get('sort')).toBe('date');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('cursor')).toBe('c-7');
    expect(calls[0]!.method).toBe('GET');
  });

  it('sends no cursor on the first page', async () => {
    stubFetch([{ body: [] }]);
    await sentryMonitorProvider.listIssuesSince({
      accessToken: 't',
      orgSlug: 'motir',
      externalProjectId: '1',
      lastSeenAfter: null,
      cursor: null,
    });
    expect(new URL(calls[0]!.url).searchParams.has('cursor')).toBe(false);
  });

  it('CUTS a page that straddles the watermark, and ends the list there', async () => {
    stubFetch([
      {
        body: [
          row('newest', '2026-09-18T12:00:00.000Z'),
          row('newer', '2026-09-18T11:00:00.000Z'),
          // Exactly AT the watermark: the bound is EXCLUSIVE, so it is cut.
          row('at', '2026-09-18T10:00:00.000Z'),
          row('older', '2026-09-18T09:00:00.000Z'),
        ],
        headers: {
          link: '<https://monitor-stub.invalid/next>; rel="next"; results="true"; cursor="c2"',
        },
      },
    ]);

    const page = await sentryMonitorProvider.listIssuesSince({
      accessToken: 't',
      orgSlug: 'motir',
      externalProjectId: '1',
      lastSeenAfter: new Date('2026-09-18T10:00:00.000Z'),
      cursor: null,
    });

    expect(page.issues.map((i) => i.externalId)).toEqual(['newest', 'newer']);
    // Everything after the cut is older still — on this page and every later
    // one — so the Link header's cursor is DROPPED.
    expect(page.nextCursor).toBeNull();
  });

  it('hands back the Link cursor when the WHOLE page is after the watermark', async () => {
    stubFetch([
      {
        body: [row('a', '2026-09-18T12:00:00.000Z'), row('b', '2026-09-18T11:00:00.000Z')],
        headers: {
          link: '<https://monitor-stub.invalid/next>; rel="next"; results="true"; cursor="c2"',
        },
      },
    ]);
    const page = await sentryMonitorProvider.listIssuesSince({
      accessToken: 't',
      orgSlug: 'motir',
      externalProjectId: '1',
      lastSeenAfter: new Date('2026-09-18T10:00:00.000Z'),
      cursor: null,
    });
    expect(page.issues.map((i) => i.externalId)).toEqual(['a', 'b']);
    expect(page.nextCursor).toBe('c2');
  });

  it('the FAKE honours the same contract — after the watermark, newest first, paged', async () => {
    const at = (h: number) => new Date(`2026-09-18T${String(h).padStart(2, '0')}:00:00.000Z`);
    const issue = (externalId: string, lastSeenAt: Date) => ({
      externalId,
      title: externalId,
      culprit: null,
      level: 'error',
      eventCount: 1,
      firstSeenAt: at(1),
      lastSeenAt,
      permalink: null,
      assignee: null,
    });
    fakeMonitorState().issues = [
      issue('old', at(8)),
      issue('mid', at(11)),
      issue('newest', at(13)),
      issue('new', at(12)),
    ];
    fakeMonitorState().pageSize = 2;

    const input = {
      accessToken: 'x',
      orgSlug: 'y',
      externalProjectId: 'fake-web',
      lastSeenAfter: at(10),
    };
    const first = await fakeMonitorProvider.listIssuesSince({ ...input, cursor: null });
    expect(first.issues.map((i) => i.externalId)).toEqual(['newest', 'new']);
    expect(first.nextCursor).not.toBeNull();

    const second = await fakeMonitorProvider.listIssuesSince({
      ...input,
      cursor: first.nextCursor,
    });
    expect(second.issues.map((i) => i.externalId)).toEqual(['mid']);
    // The LAST page says so — a poll must not loop on it.
    expect(second.nextCursor).toBeNull();

    // `old` is not after the watermark and never appears; nothing hit the wire.
    expect(calls).toEqual([]);
  });

  it('the fake can fail with a status OTHER than 401, carried on the typed error', async () => {
    fakeMonitorState().failNextStatus.set('listIssuesSince', { status: 500 });
    const err = await fakeMonitorProvider
      .listIssuesSince({
        accessToken: 'x',
        orgSlug: 'y',
        externalProjectId: 'fake-web',
        lastSeenAfter: null,
        cursor: null,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MonitorProviderCallError);
    expect((err as MonitorProviderCallError).status).toBe(500);
    expect((err as MonitorProviderCallError).providerReason).toBe('The provider answered 500.');

    // One-shot, and a plain `failNext` keeps the 401 default.
    fakeMonitorState().failNext.add('listIssuesSince');
    const revoked = await fakeMonitorProvider
      .listIssuesSince({
        accessToken: 'x',
        orgSlug: 'y',
        externalProjectId: 'fake-web',
        lastSeenAfter: null,
        cursor: null,
      })
      .catch((e: unknown) => e);
    expect((revoked as MonitorProviderCallError).status).toBe(401);
  });
});

describe('the ASSIGNEE, ONE-issue read and GONE answer (MOTIR-4931 · MOTIR-5702)', () => {
  const payload = (assignedTo: unknown) => ({
    id: 'issue-9',
    title: 'Boom',
    culprit: null,
    level: 'error',
    count: '2',
    firstSeen: '2026-09-01T00:00:00.000Z',
    lastSeen: '2026-09-10T00:00:00.000Z',
    permalink: null,
    assignedTo,
  });

  it('normalizes a user, a team and an unassigned issue through ONE mapping', () => {
    expect(
      normalizeIssue(payload({ type: 'user', id: '17', name: 'Ada', email: 'ada@example.com' }))
        .assignee,
    ).toEqual({ kind: 'user', externalId: '17', email: 'ada@example.com', name: 'Ada' });
    // A team carries no email, whatever the payload says.
    expect(
      normalizeIssue(payload({ type: 'team', id: 4, name: 'Backend', email: 'x@y' })).assignee,
    ).toEqual({ kind: 'team', externalId: '4', email: null, name: 'Backend' });
    expect(normalizeIssue(payload(null)).assignee).toBeNull();
    // Anything without a usable type and id is UNASSIGNED, never a guess.
    expect(normalizeIssue(payload({ type: 'robot', id: '1' })).assignee).toBeNull();
    expect(normalizeIssue(payload({ type: 'user' })).assignee).toBeNull();
    expect(normalizeIssue(payload('user:17')).assignee).toBeNull();
    // A user with no email stays a user — the sync records it as unmatched.
    expect(normalizeIssue(payload({ type: 'user', id: '8', name: '' })).assignee).toEqual({
      kind: 'user',
      externalId: '8',
      email: null,
      name: null,
    });
  });

  it('listIssuesSince and getIssue populate the SAME assignee', async () => {
    const assignedTo = { type: 'user', id: '17', name: 'Ada', email: 'ada@example.com' };
    stubFetch([{ body: [payload(assignedTo)] }, { body: payload(assignedTo) }]);
    const page = await sentryMonitorProvider.listIssuesSince({
      accessToken: 't',
      orgSlug: 'motir',
      externalProjectId: '42',
      lastSeenAfter: null,
      cursor: null,
    });
    const one = await sentryMonitorProvider.getIssue({
      accessToken: 't',
      orgSlug: 'motir',
      externalIssueId: 'issue-9',
    });
    expect(one).toEqual(page.issues[0]);
    expect(one?.assignee?.email).toBe('ada@example.com');
    expect(calls[1]!.method).toBe('GET');
    expect(calls[1]!.url).toBe(
      'https://monitor-stub.invalid/api/0/organizations/motir/issues/issue-9/',
    );
  });

  it('getIssue answers NULL on a 404 — gone is not an error', async () => {
    stubFetch([{ status: 404, body: { detail: 'The requested resource does not exist' } }]);
    await expect(
      sentryMonitorProvider.getIssue({ accessToken: 't', orgSlug: 'm', externalIssueId: 'x' }),
    ).resolves.toBeNull();
  });

  it('getIssue throws the provider’s own reason on 401 and 500, keeping the status', async () => {
    stubFetch([{ status: 401, body: { detail: 'Invalid token' } }]);
    await expect(
      sentryMonitorProvider.getIssue({ accessToken: 't', orgSlug: 'm', externalIssueId: 'x' }),
    ).rejects.toMatchObject({
      name: 'MonitorProviderCallError',
      status: 401,
      providerReason: 'Invalid token',
    });
    stubFetch([{ status: 500, body: { detail: 'Internal error' } }]);
    await expect(
      sentryMonitorProvider.getIssue({ accessToken: 't', orgSlug: 'm', externalIssueId: 'x' }),
    ).rejects.toMatchObject({ status: 500, providerReason: 'Internal error' });
  });

  it('getIssue keeps the asked id when the payload omits one', async () => {
    stubFetch([{ body: { title: 'No id here' } }]);
    const one = await sentryMonitorProvider.getIssue({
      accessToken: 't',
      orgSlug: 'm',
      externalIssueId: 'asked-id',
    });
    expect(one?.externalId).toBe('asked-id');
    expect(one?.assignee).toBeNull();
  });

  it('resolveIssue throws MonitorIssueGoneError on 404 and MonitorProviderCallError otherwise', async () => {
    stubFetch([{ status: 404, body: { detail: 'The requested resource does not exist' } }]);
    const gone = sentryMonitorProvider.resolveIssue({ accessToken: 't', externalIssueId: 'i-1' });
    await expect(gone).rejects.toBeInstanceOf(MonitorIssueGoneError);
    await expect(gone).rejects.toMatchObject({
      externalIssueId: 'i-1',
      providerReason: 'The requested resource does not exist',
    });

    for (const status of [401, 500]) {
      stubFetch([{ status, body: { detail: `answered ${status}` } }]);
      const refused = sentryMonitorProvider.resolveIssue({
        accessToken: 't',
        externalIssueId: 'i-1',
      });
      await expect(refused).rejects.toBeInstanceOf(MonitorProviderCallError);
      await expect(refused).rejects.toMatchObject({ status });
    }
  });

  it('a getIssue past its bound surfaces as the adapter’s timeout, not a hang', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ) as unknown as typeof fetch;
      const pending = sentryMonitorProvider.getIssue({
        accessToken: 't',
        orgSlug: 'm',
        externalIssueId: 'slow',
      });
      const settled = expect(pending).rejects.toMatchObject({
        status: null,
        providerReason: `No response within ${MONITOR_GET_ISSUE_TIMEOUT_MS}ms.`,
      });
      await vi.advanceTimersByTimeAsync(MONITOR_GET_ISSUE_TIMEOUT_MS + 1);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it('the FAKE honours a seeded assignee, a CHANGED assignee, a deleted id and failNext', async () => {
    const state = fakeMonitorState();
    state.issues[0]!.assignee = {
      kind: 'user',
      externalId: 'u1',
      email: 'ada@example.com',
      name: 'Ada',
    };
    const read = () =>
      fakeMonitorProvider.getIssue({
        accessToken: 'x',
        orgSlug: 'y',
        externalIssueId: 'fake-issue-1',
      });

    expect((await read())?.assignee?.externalId).toBe('u1');
    // A test may change it between two reads — the second read sees the change.
    state.issues[0]!.assignee = { kind: 'team', externalId: 't1', email: null, name: 'Ops' };
    expect((await read())?.assignee).toMatchObject({ kind: 'team', externalId: 't1' });
    expect(state.readIssues).toEqual(['fake-issue-1', 'fake-issue-1']);

    expect(
      await fakeMonitorProvider.getIssue({
        accessToken: 'x',
        orgSlug: 'y',
        externalIssueId: 'nope',
      }),
    ).toBeNull();

    state.failNextStatus.set('getIssue', { status: 500, reason: 'down' });
    await expect(read()).rejects.toMatchObject({ status: 500, providerReason: 'down' });
    state.failNext.add('getIssue');
    await expect(read()).rejects.toMatchObject({ status: 401 });
    expect((await read())?.externalId).toBe('fake-issue-1');

    state.deletedIssues.add('fake-issue-1');
    expect(await read()).toBeNull();
    await expect(
      fakeMonitorProvider.resolveIssue({ accessToken: 'x', externalIssueId: 'fake-issue-1' }),
    ).rejects.toBeInstanceOf(MonitorIssueGoneError);
    // EVERY resolve call is recorded, a gone one included, so a test can count.
    expect(state.resolvedIssues).toEqual(['fake-issue-1']);
  });
});

describe('SEARCH and the latest event’s CONTEXT (MOTIR-4932 · MOTIR-5728)', () => {
  /** ONE Sentry issue row — the fixture BOTH the search and the poll map, so the
   *  "one mapper" criterion is asserted by reading the same bytes twice. */
  const ROW = {
    id: '4501',
    title: 'RangeError: Invalid time value',
    culprit: 'lib/dates.ts in format',
    level: 'error',
    count: '40211',
    firstSeen: '2026-09-01T10:00:00.000Z',
    lastSeen: '2026-09-18T12:00:00.000Z',
    permalink: 'https://m.sentry.io/issues/4501/',
    assignedTo: { type: 'user', id: '7', name: 'Ada', email: 'ada@example.com' },
  };
  const searchArgs = { accessToken: 't', orgSlug: 'my org', externalProjectId: '42' };

  it('searchIssues sends ONE request to the organisation issues path — project, shortIdLookup, query, limit, and NO is:unresolved', async () => {
    stubFetch([{ body: [ROW] }]);
    await sentryMonitorProvider.searchIssues({ ...searchArgs, query: ' MY-PROJECT-1A ', limit: 5 });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/0/organizations/my%20org/issues/');
    expect(url.searchParams.get('project')).toBe('42');
    expect(url.searchParams.get('shortIdLookup')).toBe('1');
    expect(url.searchParams.get('query')).toBe('MY-PROJECT-1A');
    expect(url.searchParams.get('limit')).toBe('5');
    // A person may be linking an issue somebody already resolved in the monitor.
    expect(url.search).not.toContain('is%3Aunresolved');
    expect(url.search).not.toContain('is:unresolved');
    expect(url.searchParams.get('cursor')).toBeNull();
    expect(calls[0]!.headers['authorization']).toBe('Bearer t');
  });

  it('caps the limit at MONITOR_SEARCH_ISSUES_LIMIT and never asks for fewer than one', async () => {
    stubFetch([{ body: [] }, { body: [] }]);
    await sentryMonitorProvider.searchIssues({ ...searchArgs, query: '', limit: 500 });
    await sentryMonitorProvider.searchIssues({ ...searchArgs, query: '', limit: 0 });
    expect(new URL(calls[0]!.url).searchParams.get('limit')).toBe(
      String(MONITOR_SEARCH_ISSUES_LIMIT),
    );
    expect(new URL(calls[1]!.url).searchParams.get('limit')).toBe('1');
  });

  it('an EMPTY query still asks — the picker has rows before the first keystroke', async () => {
    stubFetch([{ body: [ROW] }]);
    const found = await sentryMonitorProvider.searchIssues({ ...searchArgs, query: '', limit: 20 });
    expect(new URL(calls[0]!.url).searchParams.get('query')).toBe('');
    expect(found.map((issue) => issue.externalId)).toEqual(['4501']);
  });

  it('maps each result through the SAME mapper listIssuesSince uses', async () => {
    stubFetch([{ body: [ROW, { title: 'no id — dropped' }] }, { body: [ROW] }]);
    const searched = await sentryMonitorProvider.searchIssues({
      ...searchArgs,
      query: 'range',
      limit: 20,
    });
    const polled = await sentryMonitorProvider.listIssuesSince({
      ...searchArgs,
      lastSeenAfter: null,
      cursor: null,
    });
    expect(searched).toEqual([normalizeIssue(ROW)]);
    expect(searched).toEqual(polled.issues);
    expect(searched[0]).toMatchObject({ eventCount: 40211, assignee: { kind: 'user' } });
  });

  it('getIssueContext reads events/latest/ and returns the environment TAG and release.version', async () => {
    stubFetch([
      {
        body: {
          id: 'e1',
          tags: [
            { key: 'level', value: 'error' },
            { key: 'environment', value: 'production' },
          ],
          release: { version: '1.4.2' },
        },
      },
    ]);
    const context = await sentryMonitorProvider.getIssueContext({
      accessToken: 't',
      orgSlug: 'm',
      externalIssueId: '4501',
    });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe(
      '/api/0/organizations/m/issues/4501/events/latest/',
    );
    expect(context).toEqual({
      environment: 'production',
      release: '1.4.2',
      frames: [],
      exception: null,
      // Every tag that names no person is carried, `environment` included.
      tags: [
        { key: 'level', value: 'error' },
        { key: 'environment', value: 'production' },
      ],
      request: null,
      eventId: null,
      eventAt: null,
    });
  });

  it('answers NULL for each fact the latest event does not carry', async () => {
    stubFetch([{ body: { id: 'e1', tags: [{ key: 'level', value: 'error' }], release: null } }]);
    await expect(
      sentryMonitorProvider.getIssueContext({
        accessToken: 't',
        orgSlug: 'm',
        externalIssueId: '1',
      }),
    ).resolves.toEqual({
      environment: null,
      release: null,
      frames: [],
      exception: null,
      tags: [{ key: 'level', value: 'error' }],
      request: null,
      eventId: null,
      eventAt: null,
    });
    // Malformed shapes are absence, never a guess.
    expect(normalizeIssueContext({})).toEqual({
      environment: null,
      release: null,
      frames: [],
      exception: null,
      tags: [],
      request: null,
      eventId: null,
      eventAt: null,
    });
    expect(
      normalizeIssueContext({
        tags: [null, 'x', { key: 'environment', value: '' }],
        release: { version: 7 },
      }),
    ).toEqual({
      environment: null,
      release: null,
      frames: [],
      exception: null,
      // Only the well-formed entry survives the tag filter; an empty value is
      // still a stated value.
      tags: [{ key: 'environment', value: '' }],
      request: null,
      eventId: null,
      eventAt: null,
    });
  });

  it('a 404 from events/latest/ is the typed GONE answer; a 500 is the provider’s reason verbatim', async () => {
    stubFetch([
      { status: 404, body: { detail: 'The requested resource does not exist' } },
      { status: 500, body: { detail: 'Internal Error' } },
    ]);
    const gone = sentryMonitorProvider.getIssueContext({
      accessToken: 't',
      orgSlug: 'm',
      externalIssueId: '9',
    });
    await expect(gone).rejects.toBeInstanceOf(MonitorIssueGoneError);
    await expect(gone).rejects.toMatchObject({
      operation: 'getIssueContext',
      externalIssueId: '9',
      providerReason: 'The requested resource does not exist',
    });
    const refused = sentryMonitorProvider.getIssueContext({
      accessToken: 't',
      orgSlug: 'm',
      externalIssueId: '9',
    });
    await expect(refused).rejects.toBeInstanceOf(MonitorProviderCallError);
    await expect(refused).rejects.toMatchObject({ status: 500, providerReason: 'Internal Error' });
  });

  it('a refused SEARCH is MonitorProviderCallError with the provider’s reason — a 404 there is a refusal, not a gone issue', async () => {
    // "Gone" is a fact about ONE addressed issue; a search addresses none, so a
    // 404 on it (an unknown project, say) is an ordinary refusal to show.
    stubFetch([
      { status: 500, body: { detail: 'Internal Error' } },
      { status: 404, body: { detail: 'Project not found' } },
    ]);
    for (const [status, reason] of [
      [500, 'Internal Error'],
      [404, 'Project not found'],
    ] as const) {
      const refused = sentryMonitorProvider.searchIssues({ ...searchArgs, query: 'x', limit: 5 });
      await expect(refused).rejects.toBeInstanceOf(MonitorProviderCallError);
      await expect(refused).rejects.not.toBeInstanceOf(MonitorIssueGoneError);
      await expect(refused).rejects.toMatchObject({ status, providerReason: reason });
    }
  });

  it.each([
    ['searchIssues', MONITOR_SEARCH_ISSUES_TIMEOUT_MS],
    ['getIssueContext', MONITOR_ISSUE_CONTEXT_TIMEOUT_MS],
  ] as const)('%s aborts at its NAMED timeout rather than hanging', async (operation, ms) => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ) as unknown as typeof fetch;
      const pending =
        operation === 'searchIssues'
          ? sentryMonitorProvider.searchIssues({ ...searchArgs, query: 'x', limit: 5 })
          : sentryMonitorProvider.getIssueContext({
              accessToken: 't',
              orgSlug: 'm',
              externalIssueId: 'slow',
            });
      const settled = expect(pending).rejects.toMatchObject({
        operation,
        status: null,
        providerReason: `No response within ${ms}ms.`,
      });
      await vi.advanceTimersByTimeAsync(ms + 1);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it('the FAKE returns seeded context, matches a title substring and a short id, honours limit, records calls and fails when armed', async () => {
    const state = fakeMonitorState();
    state.issues = [
      {
        ...state.issues[0]!,
        externalId: 'a',
        title: 'TypeError: x is undefined',
        shortId: 'WEB-1A',
        environment: 'production',
        release: '1.4.2',
        lastSeenAt: new Date('2026-09-18T00:00:00.000Z'),
      },
      {
        ...state.issues[0]!,
        externalId: 'b',
        title: 'TypeError: y is undefined',
        lastSeenAt: new Date('2026-09-17T00:00:00.000Z'),
      },
      {
        ...state.issues[0]!,
        externalId: 'c',
        title: 'TypeError in the worker',
        externalProjectId: 'fake-worker',
        lastSeenAt: new Date('2026-09-19T00:00:00.000Z'),
      },
    ];
    const search = (query: string, limit = 20, externalProjectId = 'fake-web') =>
      fakeMonitorProvider.searchIssues({
        accessToken: 'x',
        orgSlug: 'y',
        externalProjectId,
        query,
        limit,
      });

    expect((await search('typeerror')).map((issue) => issue.externalId)).toEqual(['a', 'b']);
    expect((await search('web-1a')).map((issue) => issue.externalId)).toEqual(['a']);
    expect((await search('', 1)).map((issue) => issue.externalId)).toEqual(['a']);
    expect((await search('worker', 20, 'fake-worker')).map((i) => i.externalId)).toEqual(['c']);
    // The fake-only fields never leak through the seam.
    expect(Object.keys((await search('web-1a'))[0]!)).not.toContain('shortId');
    expect(state.searches).toHaveLength(5);
    expect(state.searches[2]).toEqual({ externalProjectId: 'fake-web', query: '', limit: 1 });

    const context = (externalIssueId: string) =>
      fakeMonitorProvider.getIssueContext({ accessToken: 'x', orgSlug: 'y', externalIssueId });
    expect(await context('a')).toEqual({
      environment: 'production',
      release: '1.4.2',
      frames: [],
      exception: null,
      tags: [],
      request: null,
      eventId: null,
      eventAt: null,
    });
    expect(await context('b')).toEqual({
      environment: null,
      release: null,
      frames: [],
      exception: null,
      tags: [],
      request: null,
      eventId: null,
      eventAt: null,
    });
    await expect(context('nope')).rejects.toBeInstanceOf(MonitorIssueGoneError);
    state.deletedIssues.add('a');
    await expect(context('a')).rejects.toBeInstanceOf(MonitorIssueGoneError);
    expect(state.contextReads).toEqual(['a', 'b', 'nope', 'a']);

    state.failNextStatus.set('getIssueContext', { status: 500, reason: 'down' });
    await expect(context('b')).rejects.toMatchObject({ status: 500, providerReason: 'down' });
    state.failNext.add('searchIssues');
    await expect(search('x')).rejects.toMatchObject({ status: 401 });
    state.failSearchForProject.set('fake-worker', { status: 503, reason: 'busy' });
    await expect(search('x', 20, 'fake-worker')).rejects.toMatchObject({
      status: 503,
      providerReason: 'busy',
    });
    // Not consumed: a fan-out can fail the same project on every call.
    await expect(search('x', 20, 'fake-worker')).rejects.toMatchObject({ status: 503 });
    await expect(search('typeerror')).resolves.toHaveLength(1);
  });
});

describe('the FAKE honours the latest event’s EVIDENCE (MOTIR-5975 · MOTIR-5977)', () => {
  const seedIssue = {
    title: 'Error',
    culprit: null,
    level: 'error',
    eventCount: 1,
    firstSeenAt: new Date('2026-09-20T00:00:00.000Z'),
    lastSeenAt: new Date('2026-09-20T00:00:00.000Z'),
    permalink: null,
    assignee: null,
  };
  const read = (externalIssueId: string) =>
    fakeMonitorProvider.getIssueContext({ accessToken: 'x', orgSlug: 'y', externalIssueId });

  it('filters its RAW tags and its request URL exactly as the Sentry adapter would', async () => {
    const eventAt = new Date('2026-09-20T18:04:11.000Z');
    fakeMonitorState().issues = [
      {
        ...seedIssue,
        externalId: 'seeded',
        exception: { type: 'PrismaClientKnownRequestError', message: 'expired transaction' },
        rawTags: [
          { key: 'environment', value: 'production' },
          { key: 'user.email', value: 'someone@example.com' },
          { key: 'route', value: '/api/github/webhook' },
        ],
        requestMethod: 'post',
        requestUrl: 'https://app.example/api/github/webhook?x=1',
        eventId: 'ev-1',
        eventAt,
      },
    ];
    const context = await read('seeded');
    expect(context).toMatchObject({
      exception: { type: 'PrismaClientKnownRequestError', message: 'expired transaction' },
      tags: [
        { key: 'environment', value: 'production' },
        { key: 'route', value: '/api/github/webhook' },
      ],
      request: { method: 'POST', path: '/api/github/webhook' },
      eventId: 'ev-1',
      eventAt,
    });
    expect(JSON.stringify(context)).not.toContain('someone@example.com');
    expect(JSON.stringify(context)).not.toContain('x=1');
  });

  it('an unseeded issue answers every evidence field as null / []', async () => {
    fakeMonitorState().issues = [{ ...seedIssue, externalId: 'bare' }];
    expect(await read('bare')).toMatchObject({
      exception: null,
      tags: [],
      request: null,
      eventId: null,
      eventAt: null,
    });
  });
});
