import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE TWO COOKIE-API DOORS INSIDE A STAFF "VIEW AS" SESSION (Story 10.3 · MOTIR-749).
 *
 * `tests/platform/impersonation.test.ts` drives the staff-session gate itself
 * (`applyStaffSession`). This suite drives what the API answers through it — the
 * two doors every cookie-authenticated route enters by
 * (`requireCompliantSession` / `requireCompliantWorkspaceContext`) and the one
 * route that mints a credential (`POST /api/cli/device/approve`):
 *
 * - The CUSTOMER's 2FA hold is not the operator's to satisfy: inside a staff
 *   session both doors admit the target even though, signed in as themselves,
 *   the target would be held.
 * - A write inside a READ-ONLY session is refused at the session read, so both
 *   doors answer the same typed 403 `IMPERSONATION_READ_ONLY`.
 * - A FULL session still cannot mint a `motir login` credential: 403
 *   `IMPERSONATION_CREDENTIAL_REFUSED`, the grant left pending, no token.
 * - An unexpected failure behind either the workspace door or the approve route
 *   propagates — it is never dressed as a domain refusal.
 *
 * Nothing about the session is stubbed: a real superadmin signs in for real, a
 * real staff session is started through `impersonationService.start`, and the
 * request carries both real cookies. `next/headers` is the one seam faked, as
 * in `tests/auth/sessionUnavailable.test.ts` — the suite has no request scope.
 */

// Every test signs in for real (operator, and sometimes the customer too);
// Better-Auth's IP-keyed sign-in bucket would 429 under vitest, where there is
// no client IP to spread them across. Production never sets it.
vi.hoisted(() => {
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

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

const { db } = await import('@/lib/db');
const { auth } = await import('@/lib/auth');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { impersonationService } = await import('@/lib/services/impersonationService');
const { cliDeviceService } = await import('@/lib/services/cliDeviceService');
const { STAFF_SESSION_COOKIE } = await import('@/lib/platform/staffSession');
const { requireCompliantSession, requireCompliantWorkspaceContext, resolveTwoFactorHold } =
  await import('@/lib/auth/requireCompliantSession');
const { POST: APPROVE } = await import('@/app/api/cli/device/approve/route');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

const PASSWORD = 'hunter2hunter2';
const ORIGIN = 'http://localhost:3000';
let seq = 0;

beforeEach(async () => {
  cookieJar.clear();
  requestHeaders.current = new Headers();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Sign in for real; the `name=value` cookie a browser would send back. */
async function signInCookie(email: string): Promise<string> {
  const { headers } = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  return headers.get('set-cookie')!.split(';')[0]!;
}

/** A fresh request — the staff-session gate memoises per `Headers` object. */
function request(cookie: string, extra: Record<string, string> = {}): Headers {
  const h = new Headers({ cookie, host: 'localhost:3000', 'x-forwarded-proto': 'http', ...extra });
  requestHeaders.current = h;
  return h;
}

/** A customer whose ORGANIZATION requires 2FA and who has not enrolled — held. */
async function seedHeldCustomer() {
  const email = `customer-doors-${++seq}@example.com`;
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Dana' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  await adminDb.organization.update({
    where: { id: workspace.organizationId },
    data: { requiresTwoFactor: true },
  });
  return { user, email, workspace };
}

/**
 * A superadmin, signed in for real, who has started a staff session as the
 * target. Returns the cookie pair a browser holds for the session.
 */
async function startStaffSession(targetUserId: string, mode: 'read_only' | 'full') {
  const email = `ops+doors-${++seq}@moooon.net`;
  const operator = await usersService.createUser({ email, password: PASSWORD, name: 'Ops' });
  await adminDb.user.update({ where: { id: operator.id }, data: { platformRole: 'superadmin' } });
  const operatorCookie = await signInCookie(email);
  const row = await adminDb.session.findFirstOrThrow({ where: { userId: operator.id } });

  // The console's own request: the operator, no staff cookie yet.
  request(operatorCookie);
  const started = await impersonationService.start(
    { userId: operator.id, email, role: 'superadmin' },
    {
      targetUserId,
      mode,
      durationMinutes: 30,
      reason: 'Ticket #4411 — board will not load',
      operator: { userId: operator.id, sessionId: row.id },
    },
  );
  return {
    operator,
    operatorCookie,
    cookie: `${operatorCookie}; ${STAFF_SESSION_COOKIE}=${started.token}`,
  };
}

describe('the customer’s 2FA hold is not the operator’s', () => {
  it('requireCompliantSession admits the TARGET inside a staff session — held when signed in as themselves', async () => {
    const { user, email } = await seedHeldCustomer();

    // The control: the customer at their own keyboard IS held.
    request(await signInCookie(email));
    const own = await requireCompliantSession();
    expect(own.ok).toBe(false);
    if (own.ok) return;
    expect(own.response.status).toBe(403);
    expect((await own.response.json()).code).toBe('TWO_FACTOR_REQUIRED');

    const { cookie, operator } = await startStaffSession(user.id, 'read_only');
    request(cookie);
    const gate = await requireCompliantSession();

    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(gate.session.user.id).toBe(user.id);
    expect(gate.session.impersonation?.operator.userId).toBe(operator.id);
  });

  it('requireCompliantWorkspaceContext admits the TARGET in their pinned workspace', async () => {
    const { user, workspace } = await seedHeldCustomer();
    expect(await resolveTwoFactorHold(user.id)).not.toBeNull();

    const { cookie } = await startStaffSession(user.id, 'read_only');
    request(cookie);
    const gate = await requireCompliantWorkspaceContext();

    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(gate.ctx).toEqual({ userId: user.id, workspaceId: workspace.id });
  });
});

describe('a READ-ONLY session refuses a write at the session read', () => {
  it('both doors answer 403 IMPERSONATION_READ_ONLY — no route needs its own arm', async () => {
    const { user } = await seedHeldCustomer();
    const { cookie } = await startStaffSession(user.id, 'read_only');

    // No method on hand: a cross-origin `fetch` with no page path is a write.
    request(cookie, { origin: ORIGIN });
    const session = await requireCompliantSession();
    expect(session.ok).toBe(false);
    if (session.ok) return;
    expect(session.response.status).toBe(403);
    expect(await session.response.json()).toEqual({ code: 'IMPERSONATION_READ_ONLY' });

    request(cookie, { origin: ORIGIN });
    const ctx = await requireCompliantWorkspaceContext();
    expect(ctx.ok).toBe(false);
    if (ctx.ok) return;
    expect(ctx.response.status).toBe(403);
    expect(await ctx.response.json()).toEqual({ code: 'IMPERSONATION_READ_ONLY' });
  });
});

describe('the workspace door does not dress an outage as a refusal', () => {
  it('re-throws an unexpected failure of the workspace access read', async () => {
    const { email } = await seedHeldCustomer();
    request(await signInCookie(email));
    vi.spyOn(organizationsService, 'resolveWorkspaceAccess').mockRejectedValue(
      new Error('db down'),
    );

    await expect(requireCompliantWorkspaceContext()).rejects.toThrow('db down');
  });
});

describe('POST /api/cli/device/approve inside a staff session', () => {
  it('a FULL session still cannot mint a `motir login` credential: 403, grant pending, no token', async () => {
    const { user, workspace } = await seedHeldCustomer();
    const { cookie } = await startStaffSession(user.id, 'full');
    const grant = await cliDeviceService.start({ hostname: 'workbox' });

    const headers = request(cookie, { origin: ORIGIN, 'content-type': 'application/json' });
    const res = await APPROVE(
      new Request(`${ORIGIN}/api/cli/device/approve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ userCode: grant.user_code, workspaceId: workspace.id }),
      }),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'IMPERSONATION_CREDENTIAL_REFUSED' });
    expect(await adminDb.apiToken.count()).toBe(0);
    const row = await db.deviceCode.findFirstOrThrow({ where: { deviceCode: grant.device_code } });
    expect(row.status).toBe('pending');
  });

  it('re-throws an unexpected approve failure rather than mapping it to a status', async () => {
    const email = `approver-doors-${++seq}@example.com`;
    const approver = await usersService.createUser({ email, password: PASSWORD, name: 'Ada' });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: approver.id,
    });
    const headers = request(await signInCookie(email), {
      origin: ORIGIN,
      'content-type': 'application/json',
    });
    vi.spyOn(cliDeviceService, 'approve').mockRejectedValue(new Error('db down'));

    await expect(
      APPROVE(
        new Request(`${ORIGIN}/api/cli/device/approve`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ userCode: 'ABCDEFGH', workspaceId: workspace.id }),
        }),
      ),
    ).rejects.toThrow('db down');
  });
});
