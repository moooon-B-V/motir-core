import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { readOrgSlug } from '@/lib/mappers/monitorMappers';
import { decodeMonitorConnectState, encodeMonitorConnectState } from '@/lib/monitors/connectState';
import { mapMonitorError } from '@/lib/monitors/errorResponse';
import {
  MonitorConnectionAlreadyExistsError,
  MonitorConnectionNotFoundError,
  MonitorGrantNotFoundError,
  MonitorProviderCallError,
  UnknownMonitorProviderError,
} from '@/lib/monitors/errors';
import { MONITOR_HEALTH_TIMEOUT_MS } from '@/lib/monitors/provider';
import { nextCursorFromLinkHeader, sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import {
  NotProjectAdminError,
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { monitorConnectionRepository } from '@/lib/repositories/monitorConnectionRepository';

// THE STORY'S VITEST GATE — the arms the per-card units left uncovered (Story
// MOTIR-4928 · MOTIR-5263). Each describe names the PRODUCER that makes its arms
// fire; the disposition of every arm, including the few asserted unreachable, is
// on the work item and beside the thresholds in `vitest.config.ts`.

describe('mapMonitorError — every refusal the four routes can raise', () => {
  const cases: [string, unknown, number, string][] = [
    ['an unknown project', new ProjectNotFoundError('p1'), 404, 'PROJECT_NOT_FOUND'],
    [
      'a missing key',
      new PermissionDeniedError('p1', 'integration:manage'),
      403,
      'PERMISSION_DENIED',
    ],
    ['a non-admin', new NotProjectAdminError('p1'), 403, 'NOT_PROJECT_ADMIN'],
    [
      'a browse refusal',
      new ProjectAccessDeniedError('p1', 'browse'),
      403,
      'PROJECT_ACCESS_DENIED',
    ],
    [
      'an unknown binding',
      new MonitorConnectionNotFoundError('c1'),
      404,
      'MONITOR_CONNECTION_NOT_FOUND',
    ],
    ['no grant', new MonitorGrantNotFoundError('w1'), 409, 'MONITOR_GRANT_NOT_FOUND'],
    [
      'an already-bound project',
      new MonitorConnectionAlreadyExistsError('p1', 'e1'),
      409,
      'MONITOR_CONNECTION_ALREADY_EXISTS',
    ],
    [
      'a provider refusal',
      new MonitorProviderCallError('op', 401, 'revoked'),
      502,
      'MONITOR_PROVIDER_CALL_FAILED',
    ],
    [
      'an unregistered provider',
      new UnknownMonitorProviderError('x'),
      500,
      'UNKNOWN_MONITOR_PROVIDER',
    ],
  ];

  it.each(cases)('maps %s', async (_, err, status, code) => {
    const res = mapMonitorError(err)!;
    expect(res.status).toBe(status);
    expect(((await res.json()) as { code: string }).code).toBe(code);
  });

  it('carries the missing KEY on a permission refusal, and the provider’s reason on a 502', async () => {
    const denied = await mapMonitorError(
      new PermissionDeniedError('p1', 'integration:manage'),
    )!.json();
    expect(denied).toMatchObject({ permission: 'integration:manage' });
    const upstream = await mapMonitorError(
      new MonitorProviderCallError('op', 401, 'revoked'),
    )!.json();
    expect(upstream).toMatchObject({ providerReason: 'revoked' });
  });

  it('returns null for anything it does not recognise, so the route re-throws', () => {
    expect(mapMonitorError(new Error('boom'))).toBeNull();
    expect(mapMonitorError('not even an error')).toBeNull();
  });
});

describe('decodeMonitorConnectState — the cookie a provider redirect carries back', () => {
  const now = Date.now();
  const raw = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const valid = {
    nonce: 'n'.repeat(32),
    projectId: 'p1',
    returnSurfaceId: 'projectMonitoring' as const,
    issuedAt: now,
  };

  it('refuses a nonce too short to be a nonce', () => {
    expect(decodeMonitorConnectState(raw({ ...valid, nonce: 'short' }), now)).toBeNull();
  });

  it('refuses a missing or empty project id', () => {
    expect(decodeMonitorConnectState(raw({ ...valid, projectId: '' }), now)).toBeNull();
  });

  it('refuses a non-numeric or non-finite issue time', () => {
    expect(decodeMonitorConnectState(raw({ ...valid, issuedAt: 'yesterday' }), now)).toBeNull();
    expect(decodeMonitorConnectState(raw({ ...valid, issuedAt: null }), now)).toBeNull();
  });

  it('narrows a non-string return surface to the default rather than refusing', () => {
    const state = decodeMonitorConnectState(raw({ ...valid, returnSurfaceId: 42 }), now);
    expect(state).not.toBeNull();
    expect(state!.returnSurfaceId).toBe('projectMonitoring');
  });

  it('refuses a payload that parses to something other than an object', () => {
    expect(decodeMonitorConnectState(raw(42), now)).toBeNull();
    expect(decodeMonitorConnectState(raw(null), now)).toBeNull();
  });

  it('round-trips a well-formed state', () => {
    const encoded = encodeMonitorConnectState(valid);
    expect(decodeMonitorConnectState(encoded, now)).toMatchObject({ projectId: 'p1' });
  });
});

describe('readOrgSlug — provider-shaped metadata, read defensively', () => {
  it('answers null for metadata that is not an object', () => {
    expect(readOrgSlug(null)).toBeNull();
    expect(readOrgSlug('acme')).toBeNull();
    expect(readOrgSlug(7)).toBeNull();
  });

  it('answers null for an absent, empty or non-string slug', () => {
    expect(readOrgSlug({})).toBeNull();
    expect(readOrgSlug({ orgSlug: '' })).toBeNull();
    expect(readOrgSlug({ orgSlug: 3 })).toBeNull();
    expect(readOrgSlug({ orgSlug: 'acme-inc' })).toBe('acme-inc');
  });
});

describe('the binding write classifies a unique violation by the index it names', () => {
  // A `tx` whose create rejects with a constructed Prisma error — the producer of
  // each arm is the SHAPE Prisma reports, which a real Postgres under the driver
  // adapter only ever produces in one form (asserted on real Postgres by
  // `monitor-connection-store.test.ts`'s concurrent-bind test).
  const input = {
    projectId: 'p1',
    workspaceId: 'w1',
    installationId: 'i1',
    externalProjectId: 'e1',
    externalProjectSlug: 'web',
  };
  const txRejecting = (error: unknown) =>
    ({
      monitorConnection: { create: vi.fn().mockRejectedValue(error) },
    }) as unknown as Prisma.TransactionClient;
  const p2002 = (meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('unique violation', {
      code: 'P2002',
      clientVersion: 'test',
      meta,
    });

  it('the older shape: `target` as the column LIST', async () => {
    await expect(
      monitorConnectionRepository.create(
        input,
        txRejecting(p2002({ target: ['project_id', 'external_project_id'] })),
      ),
    ).rejects.toBeInstanceOf(MonitorConnectionAlreadyExistsError);
  });

  it('the older shape: `target` as the index NAME', async () => {
    await expect(
      monitorConnectionRepository.create(
        input,
        txRejecting(
          p2002({ target: 'monitor_connection_project_id_installation_id_external_proj_key' }),
        ),
      ),
    ).rejects.toBeInstanceOf(MonitorConnectionAlreadyExistsError);
  });

  it('a `target` naming some OTHER constraint is not this refusal', async () => {
    const other = p2002({ target: ['some_other_column'] });
    await expect(monitorConnectionRepository.create(input, txRejecting(other))).rejects.toBe(other);
  });

  it('a P2002 with no readable constraint falls back to the typed refusal', async () => {
    await expect(
      monitorConnectionRepository.create(input, txRejecting(p2002())),
    ).rejects.toBeInstanceOf(MonitorConnectionAlreadyExistsError);
  });

  it('a Prisma error that is NOT a unique violation passes through untouched', async () => {
    const fk = new Prisma.PrismaClientKnownRequestError('fk', {
      code: 'P2003',
      clientVersion: 'test',
    });
    await expect(monitorConnectionRepository.create(input, txRejecting(fk))).rejects.toBe(fk);
    const plain = new Error('connection reset');
    await expect(monitorConnectionRepository.create(input, txRejecting(plain))).rejects.toBe(plain);
  });
});

describe('the Sentry adapter’s refusal and fallback arms', () => {
  const realFetch = globalThis.fetch;
  const respond = (body: string | object, status = 200, headers: Record<string, string> = {}) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      statusText: status === 200 ? 'OK' : '',
      headers,
    });
  let requested: string[] = [];
  const stub = (...responses: (Response | Error | unknown)[]) => {
    requested = [];
    const queue = [...responses];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      requested.push(String(input));
      const next = queue.shift();
      if (next instanceof Response) return next;
      throw next;
    }) as unknown as typeof fetch;
  };

  beforeEach(() => {
    process.env['SENTRY_API_BASE_URL'] = 'https://monitor-stub.invalid/api/0';
    process.env['SENTRY_APP_CLIENT_ID'] = 'id';
    process.env['SENTRY_APP_CLIENT_SECRET'] = 'secret';
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    delete process.env['SENTRY_API_BASE_URL'];
    delete process.env['SENTRY_APP_CLIENT_ID'];
    delete process.env['SENTRY_APP_CLIENT_SECRET'];
  });

  it('defaults the API root to sentry.io when no region override is set', async () => {
    delete process.env['SENTRY_API_BASE_URL'];
    stub(respond([]));
    await sentryMonitorProvider.listProjects({ accessToken: 't', orgSlug: 'acme' });
    expect(requested[0]).toBe('https://sentry.io/api/0/organizations/acme/projects/');
  });

  it('reports a transport failure in its own words, and a non-Error throw as unknown', async () => {
    stub(new Error('getaddrinfo ENOTFOUND'));
    await expect(
      sentryMonitorProvider.listProjects({ accessToken: 't', orgSlug: 'a' }),
    ).rejects.toMatchObject({
      providerReason: 'getaddrinfo ENOTFOUND',
      status: null,
    });
    stub('a string, not an Error');
    await expect(
      sentryMonitorProvider.listProjects({ accessToken: 't', orgSlug: 'a' }),
    ).rejects.toMatchObject({
      providerReason: 'unknown transport failure',
    });
  });

  it('reports an operation that exceeds its bound as a timeout, not as a transport error', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ) as unknown as typeof fetch;
    const pending = sentryMonitorProvider.resolveIssue({ accessToken: 't', externalIssueId: 'i1' });
    const settled = expect(pending).rejects.toMatchObject({
      providerReason: expect.stringMatching(/^No response within \d+ms\.$/),
    });
    await vi.advanceTimersByTimeAsync(MONITOR_HEALTH_TIMEOUT_MS * 100);
    await settled;
  });

  it('reads the reason from `error_description`, from a raw non-JSON body, and from the status when empty', async () => {
    stub(respond({ error_description: ' Invalid grant ' }, 400));
    await expect(
      sentryMonitorProvider.exchangeGrant({ installationId: 'i', code: 'c' }),
    ).rejects.toMatchObject({
      providerReason: 'Invalid grant',
    });
    stub(respond('  <html>Bad Gateway</html>  ', 502));
    await expect(
      sentryMonitorProvider.listProjects({ accessToken: 't', orgSlug: 'a' }),
    ).rejects.toMatchObject({
      providerReason: '<html>Bad Gateway</html>',
    });
    stub(respond('', 503));
    await expect(
      sentryMonitorProvider.listProjects({ accessToken: 't', orgSlug: 'a' }),
    ).rejects.toMatchObject({
      providerReason: '503 no response body',
    });
    stub(respond({ detail: 42 }, 500));
    await expect(
      sentryMonitorProvider.listProjects({ accessToken: 't', orgSlug: 'a' }),
    ).rejects.toMatchObject({
      providerReason: '{"detail":42}',
    });
  });

  it('falls back to the status line when the refusal body cannot even be read', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.reject(new Error('stream destroyed')),
    })) as unknown as typeof fetch;
    await expect(
      sentryMonitorProvider.listProjects({ accessToken: 't', orgSlug: 'a' }),
    ).rejects.toMatchObject({ providerReason: '500 Internal Server Error' });
  });

  // THE INVARIANT behind `describeHealth`'s `v8 ignore`d non-provider arm: every
  // failure `call()` can produce — transport, timeout, non-2xx — is a
  // MonitorProviderCallError, so the health probe's other catch arm has no producer.
  it('call() surfaces EVERY failure as a MonitorProviderCallError', async () => {
    for (const failure of [
      new Error('ECONNRESET'),
      'not an error',
      respond({ detail: 'nope' }, 403),
    ]) {
      stub(failure);
      await expect(
        sentryMonitorProvider.listProjects({ accessToken: 't', orgSlug: 'a' }),
      ).rejects.toBeInstanceOf(MonitorProviderCallError);
    }
    stub(new Error('ECONNRESET'));
    const verdict = await sentryMonitorProvider.describeHealth({ accessToken: 't', orgSlug: 'a' });
    expect(verdict).toMatchObject({ status: 'degraded', reason: 'ECONNRESET' });
  });

  it('refuses a 200 that carries no token pair, and falls back to eight hours for an unreadable expiry', async () => {
    stub(respond({ token: 'only-access' }));
    await expect(
      sentryMonitorProvider.exchangeGrant({ installationId: 'i', code: 'c' }),
    ).rejects.toMatchObject({
      status: 200,
      providerReason: 'The authorization response carried no token pair.',
    });
    stub(respond({ token: 'a', refreshToken: 'r', expiresAt: 'not a date' }));
    const before = Date.now();
    const credential = await sentryMonitorProvider.exchangeGrant({
      installationId: 'i',
      code: 'c',
    });
    const lifeMs = credential.expiresAt.getTime() - before;
    expect(lifeMs).toBeGreaterThan(8 * 60 * 60 * 1000 - 5_000);
    expect(lifeMs).toBeLessThan(8 * 60 * 60 * 1000 + 5_000);
  });

  it('describes an installation’s organisation, and answers null for a missing slug', async () => {
    stub(respond({ organization: { slug: 'acme-inc' } }));
    expect(
      await sentryMonitorProvider.describeInstallation({ installationId: 'i', accessToken: 't' }),
    ).toEqual({
      orgSlug: 'acme-inc',
    });
    expect(requested[0]).toBe('https://monitor-stub.invalid/api/0/sentry-app-installations/i/');
    stub(respond({ organization: { slug: '' } }));
    expect(
      await sentryMonitorProvider.describeInstallation({ installationId: 'i', accessToken: 't' }),
    ).toEqual({
      orgSlug: null,
    });
    stub(respond({}));
    expect(
      await sentryMonitorProvider.describeInstallation({ installationId: 'i', accessToken: 't' }),
    ).toEqual({
      orgSlug: null,
    });
  });

  it('sends the cursor when given, and normalizes a sparse issue row without inventing values', async () => {
    stub(respond([{ id: 'i9', count: 'not-a-number', firstSeen: 'garbage' }, { id: 'i10' }]));
    const before = Date.now();
    const page = await sentryMonitorProvider.listIssuesSince({
      accessToken: 't',
      orgSlug: 'acme',
      projectSlug: 'web',
      cursor: 'c-1',
    });
    expect(new URL(requested[0]!).searchParams.get('cursor')).toBe('c-1');
    const issue = page.issues[0]!;
    expect(issue.title).toBe('i9');
    expect(issue.culprit).toBeNull();
    expect(issue.level).toBeNull();
    expect(issue.permalink).toBeNull();
    expect(issue.eventCount).toBe(0);
    // An unreadable or absent date is NOW, never an Invalid Date.
    expect(issue.firstSeenAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(issue.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(page.issues[1]!.eventCount).toBe(0);
    expect(page.nextCursor).toBeNull();
  });

  it('reads a `next` relation that names no cursor as the end', () => {
    expect(nextCursorFromLinkHeader('<https://x>; rel="next"; results="true"')).toBeNull();
    expect(
      nextCursorFromLinkHeader('<https://x>; rel="previous"; results="true"; cursor="p"'),
    ).toBeNull();
  });
});
