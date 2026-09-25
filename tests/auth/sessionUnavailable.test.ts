import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// MOTIR-5864 — `GET /api/notifications/unread-count` answered an UNHANDLED 500,
// `APIError: Failed to get session`, fifteen times in production between
// 2026-08-30 and 2026-09-20 (Sentry MOTIR-CORE-9).
//
// ⚠️ THE MECHANISM IS READ, NOT INFERRED. Every one of the fifteen events carries
// the same breadcrumb pair: a `PrismaClientKnownRequestError` on
// `prisma.session.findFirst()` — `P1017` *Server has closed the connection*, or
// `ECONNRESET` *Client network socket disconnected before secure TLS connection
// was established* — and then Better-Auth's own `APIError` with
// `status: INTERNAL_SERVER_ERROR`. Better-Auth's `getSession` catches ANY
// non-API error in its body and re-throws it as that 500
// (`better-auth/dist/api/routes/session.mjs`), so a dropped database connection
// on the session read left our `getSession()` by THROWING, and the route's own
// `if (!ctx) → 401` arm never ran. The bell polls this endpoint from every open
// tab, so it is the request that is always in flight when a connection drops.
//
// So the fault this suite injects is the production one, at the production
// site: the session read's Prisma call rejecting with `P1017`. Everything else —
// the sign-in, the signed cookie, Better-Auth, the gate, the route, the count —
// is the real thing against real Postgres.

const requestHeaders = { current: new Headers() };
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  headers: async () => requestHeaders.current,
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => void cookieJar.set(name, value),
    delete: (name: string) => void cookieJar.delete(name),
  }),
}));

const { Prisma } = await import('@/generated/prisma/client');
const { APIError } = await import('better-auth/api');
const { db } = await import('@/lib/db');
const { auth, getSession, SessionUnavailableError } = await import('@/lib/auth');
const { resolveWorkspaceContext } = await import('@/lib/workspaces');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { requireCompliantSession } = await import('@/lib/auth/requireCompliantSession');
const unreadCount = await import('@/app/api/notifications/unread-count/route');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  cookieJar.clear();
  requestHeaders.current = new Headers();
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A signed-in member: a real session row and the signed cookie a browser holds. */
async function signIn() {
  const email = `session-unavailable-${Date.now()}@example.com`;
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Ada' });
  await workspacesService.createWorkspace({ name: 'Acme', ownerUserId: user.id });
  const { headers } = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  const sessionCookie = headers.get('set-cookie')!.split(';')[0]!;
  requestHeaders.current = new Headers({
    cookie: sessionCookie,
    host: 'localhost:3000',
    'x-forwarded-proto': 'http',
  });
  return { user };
}

/** The production error, shaped the way Prisma raises it. */
function connectionClosed() {
  return new Prisma.PrismaClientKnownRequestError('Server has closed the connection.', {
    code: 'P1017',
    clientVersion: Prisma.prismaVersion.client,
  });
}

/** Make the session read's connection drop — `times` times, then recover. */
function dropSessionReadConnection(times: number) {
  const findFirst = db.session.findFirst.bind(db.session);
  let dropped = 0;
  return vi.spyOn(db.session, 'findFirst').mockImplementation(((
    ...args: Parameters<typeof findFirst>
  ) => {
    if (dropped < times) {
      dropped++;
      return Promise.reject(connectionClosed());
    }
    return findFirst(...args);
  }) as never);
}

describe('the session read survives a dropped connection (MOTIR-5864)', () => {
  it('answers the unread count when ONE session read loses its connection — the production event', async () => {
    await signIn();
    const spy = dropSessionReadConnection(1);

    // THE DEFECT: before the fix this rejects with
    // `APIError: Failed to get session` — the production message verbatim.
    const res = await unreadCount.GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unreadCount: 0 });
    // The session read was retried on a fresh connection, once.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('answers a HANDLED 503 when the database stays unreachable — never an unhandled APIError', async () => {
    await signIn();
    dropSessionReadConnection(Number.POSITIVE_INFINITY);

    const res = await unreadCount.GET();

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toEqual({ code: 'SESSION_UNAVAILABLE' });
  });

  it('the session-scoped gate answers the same 503', async () => {
    await signIn();
    dropSessionReadConnection(Number.POSITIVE_INFINITY);

    const gate = await requireCompliantSession();

    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.response.status).toBe(503);
    expect(await gate.response.json()).toEqual({ code: 'SESSION_UNAVAILABLE' });
  });

  it('getSession() throws the TYPED error after the retry, carrying Better-Auth’s as its cause', async () => {
    await signIn();
    dropSessionReadConnection(Number.POSITIVE_INFINITY);

    const error = await getSession().then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SessionUnavailableError);
    expect((error as Error).cause).toBeInstanceOf(APIError);
  });

  it('the Request-taking door retries too (the import OAuth routes)', async () => {
    const { user } = await signIn();
    dropSessionReadConnection(1);

    const ctx = await resolveWorkspaceContext(
      new Request('http://localhost:3000/api/import/jira/oauth/start', {
        headers: requestHeaders.current,
      }),
    );

    expect(ctx?.userId).toBe(user.id);
  });
});

describe('what the fix must NOT change', () => {
  it('no session cookie is still a 401 UNAUTHENTICATED, with no retry', async () => {
    const spy = vi.spyOn(auth.api, 'getSession');

    const res = await unreadCount.GET();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a healthy read is ONE read — the retry costs nothing when nothing failed', async () => {
    await signIn();
    const spy = vi.spyOn(db.session, 'findFirst');

    const res = await unreadCount.GET();

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('Better-Auth’s OTHER throw — the session deleted mid-refresh — is no session, not an outage', async () => {
    // `getSession` throws `UNAUTHORIZED` / FAILED_TO_GET_SESSION when the row
    // it is refreshing is gone by the time it writes (a sign-out or a revoke
    // racing the poll). That person has no session: a 401, not a 503, and not
    // worth a retry.
    await signIn();
    const spy = vi.spyOn(auth.api, 'getSession').mockRejectedValue(
      APIError.from('UNAUTHORIZED', {
        code: 'FAILED_TO_GET_SESSION',
        message: 'Failed to get session',
      }) as never,
    );

    const res = await unreadCount.GET();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
