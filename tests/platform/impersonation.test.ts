import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import {
  ImpersonationCredentialRefusedError,
  ImpersonationInvalidRequestError,
  ImpersonationReadOnlyError,
  ImpersonationTargetIneligibleError,
  MissingAuditReasonError,
  NotPlatformStaffError,
} from '@/lib/platform/errors';
import {
  STAFF_SESSION_COOKIE,
  applyStaffSession,
  assertNoStaffSessionCookie,
  classifyStaffRequest,
  readStaffSessionToken,
} from '@/lib/platform/staffSession';
import { impersonationService } from '@/lib/services/impersonationService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * STAFF "VIEW AS" SESSIONS (Story 10.3 · MOTIR-749).
 *
 * - The start is `superadmin`, reason-required, time-boxed (15/30/60), mode-closed,
 *   and refuses self, staff, a suspended account, a suspended organization and an
 *   account with no workspace — leaving no session row and no start row.
 * - A start writes `user.impersonation_start` with the session's facts; a second
 *   start supersedes the first (`user.impersonation_end`, `supersededBy`).
 * - The request gate: an active session substitutes the TARGET, keeps the
 *   operator for attribution, refuses a mutating request in read-only, audits it
 *   in full, audits page views; expiry / sign-out / lost superadmin / a suspended
 *   target END the session with one end row and fail closed.
 * - Exit, the stale-token settle and the expiry sweep each write exactly one end row.
 * - Minting a credential is refused while the cookie is present.
 */

let currentPrincipal: PlatformPrincipal | null = null;
let currentHeaders: Headers = new Headers();

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!currentPrincipal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
          throw new NotPlatformStaffError();
        }
        return currentPrincipal;
      },
    ),
  };
});

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => currentHeaders),
  cookies: vi.fn(async () => ({ get: () => undefined, set: () => undefined })),
}));

let seq = 0;

async function seedOperator(role: 'support' | 'operator' | 'superadmin' = 'superadmin') {
  const user = await createTestUser({ email: `ops+imp-${role}-${++seq}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

async function seedCustomer(name = 'Acme') {
  const user = await createTestUser({
    email: `customer-imp-${++seq}@example.com`,
    name: 'Dana Customer',
  });
  const { workspace } = await workspacesService.createWorkspace({ name, ownerUserId: user.id });
  return { user, workspace, organizationId: workspace.organizationId };
}

function signIn(principal: PlatformPrincipal, sessionId = 'operator-session-1') {
  return { userId: principal.userId, sessionId };
}

async function startSession(
  targetUserId: string,
  overrides: Partial<{ mode: string; durationMinutes: number; reason: string }> = {},
) {
  return impersonationService.start(currentPrincipal!, {
    targetUserId,
    mode: overrides.mode ?? 'read_only',
    durationMinutes: overrides.durationMinutes ?? 30,
    reason: overrides.reason ?? 'Ticket #4411 — board will not load',
    operator: signIn(currentPrincipal!),
  });
}

async function auditRows(action?: string) {
  return adminDb.platformAuditLog.findMany({
    where: action ? { action } : undefined,
    orderBy: { createdAt: 'asc' },
  });
}

/** The operator's own raw session, the shape `readSession` hands the gate. */
function rawOperatorSession(principal: PlatformPrincipal, sessionId = 'operator-session-1') {
  return {
    session: { id: sessionId, userId: principal.userId },
    user: { id: principal.userId, email: principal.email, name: 'Ops Person' },
  };
}

function requestHeaders(token: string, extra: Record<string, string> = {}) {
  return new Headers({ cookie: `other=1; ${STAFF_SESSION_COOKIE}=${token}`, ...extra });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  currentPrincipal = await seedOperator();
  currentHeaders = new Headers();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('starting a session', () => {
  it('writes the session row and ONE user.impersonation_start row with the facts', async () => {
    const { user, workspace, organizationId } = await seedCustomer();
    const started = await startSession(user.id, { mode: 'full', durationMinutes: 15 });

    expect(started.token.length).toBeGreaterThan(30);
    expect(started.session).toMatchObject({
      mode: 'full',
      operatorUserId: currentPrincipal!.userId,
      targetUserId: user.id,
      organizationId,
      workspaceId: workspace.id,
      endedAt: null,
    });
    const box =
      new Date(started.session.expiresAt).getTime() - new Date(started.session.startedAt).getTime();
    expect(box).toBe(15 * 60_000);

    const rows = await adminDb.impersonationSession.findMany();
    expect(rows).toHaveLength(1);
    // Only the hash is stored, never the token.
    expect(rows[0]!.tokenHash).not.toBe(started.token);
    expect(rows[0]!.operatorSessionId).toBe('operator-session-1');

    const [start] = await auditRows('user.impersonation_start');
    expect(start).toMatchObject({
      actorUserId: currentPrincipal!.userId,
      targetKind: 'user',
      targetId: user.id,
      organizationId,
      reason: 'Ticket #4411 — board will not load',
    });
    expect(start!.metadata).toMatchObject({
      mode: 'full',
      durationMinutes: 15,
      targetUserId: user.id,
      organizationId,
      workspaceId: workspace.id,
    });
  });

  it('refuses a blank reason, an unknown mode and an off-menu duration — no rows', async () => {
    const { user } = await seedCustomer();
    await expect(startSession(user.id, { reason: '   ' })).rejects.toBeInstanceOf(
      MissingAuditReasonError,
    );
    await expect(startSession(user.id, { mode: 'god' })).rejects.toBeInstanceOf(
      ImpersonationInvalidRequestError,
    );
    await expect(startSession(user.id, { durationMinutes: 600 })).rejects.toBeInstanceOf(
      ImpersonationInvalidRequestError,
    );
    expect(await adminDb.impersonationSession.count()).toBe(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('is superadmin only', async () => {
    const { user } = await seedCustomer();
    currentPrincipal = await seedOperator('operator');
    await expect(startSession(user.id)).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(await adminDb.impersonationSession.count()).toBe(0);
  });

  it.each([
    ['self', async () => currentPrincipal!.userId],
    [
      'platform_staff',
      async () => {
        const { user } = await seedCustomer();
        await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'support' } });
        return user.id;
      },
    ],
    [
      'suspended_account',
      async () => {
        const { user } = await seedCustomer();
        await adminDb.user.update({ where: { id: user.id }, data: { suspendedAt: new Date() } });
        return user.id;
      },
    ],
    [
      'suspended_organization',
      async () => {
        const { user, organizationId } = await seedCustomer();
        await adminDb.organization.update({
          where: { id: organizationId },
          data: { suspendedAt: new Date(), suspendedReason: 'Fraud review' },
        });
        return user.id;
      },
    ],
    [
      'no_workspace',
      async () => (await createTestUser({ email: `loner-${++seq}@example.com` })).id,
    ],
  ])('refuses an ineligible target (%s) with no session row', async (why, target) => {
    const targetUserId = await target();
    await expect(startSession(targetUserId)).rejects.toMatchObject({
      constructor: ImpersonationTargetIneligibleError,
      ineligibility: why,
    });
    expect(await adminDb.impersonationSession.count()).toBe(0);
    expect(await auditRows('user.impersonation_start')).toHaveLength(0);
  });

  it('a second start supersedes the first: one end row, one open session', async () => {
    const a = await seedCustomer('A');
    const b = await seedCustomer('B');
    const first = await startSession(a.user.id);
    await startSession(b.user.id);

    const sessions = await adminDb.impersonationSession.findMany({ orderBy: { startedAt: 'asc' } });
    expect(sessions.map((s) => s.endedAt === null)).toEqual([false, true]);
    expect(sessions[0]!.endedBy).toBe('operator');
    const ends = await auditRows('user.impersonation_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.metadata).toMatchObject({
      sessionId: first.session.id,
      endedBy: 'operator',
      supersededBy: 'new_session',
    });
  });
});

describe('the request gate', () => {
  it('substitutes the TARGET and keeps the operator for attribution; audits the page view', async () => {
    const { user } = await seedCustomer();
    const { token, session } = await startSession(user.id);
    const raw = rawOperatorSession(currentPrincipal!);

    const result = await applyStaffSession(
      raw,
      requestHeaders(token, { 'x-current-path': '/dashboard' }),
    );
    expect(result.kind).toBe('active');
    if (result.kind !== 'active') return;
    expect(result.session.user.id).toBe(user.id);
    expect(result.session.user.email).toBe(user.email);
    expect(result.session.session.userId).toBe(user.id);
    expect(result.context.operator.userId).toBe(currentPrincipal!.userId);
    expect(result.context.session.id).toBe(session.id);

    const views = await auditRows('user.impersonation_view');
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ actorUserId: currentPrincipal!.userId, targetId: user.id });
    expect(views[0]!.metadata).toMatchObject({ sessionId: session.id, path: '/dashboard' });
  });

  it('is memoised per request — one resolution, one audit row', async () => {
    const { user } = await seedCustomer();
    const { token } = await startSession(user.id);
    const h = requestHeaders(token, { 'x-current-path': '/items' });
    const raw = rawOperatorSession(currentPrincipal!);
    await applyStaffSession(raw, h);
    await applyStaffSession(raw, h);
    expect(await auditRows('user.impersonation_view')).toHaveLength(1);
  });

  it('READ-ONLY refuses a mutating request before anything runs, and writes no action row', async () => {
    const { user } = await seedCustomer();
    const { token } = await startSession(user.id);
    const raw = rawOperatorSession(currentPrincipal!);

    await expect(
      applyStaffSession(
        raw,
        requestHeaders(token, { 'next-action': 'abc123', 'x-current-path': '/items/X-1' }),
      ),
    ).rejects.toBeInstanceOf(ImpersonationReadOnlyError);
    await expect(applyStaffSession(raw, requestHeaders(token), 'PATCH')).rejects.toBeInstanceOf(
      ImpersonationReadOnlyError,
    );
    // A safe-method API read passes.
    const read = await applyStaffSession(raw, requestHeaders(token), 'GET');
    expect(read.kind).toBe('active');
    expect(await auditRows('user.impersonation_action')).toHaveLength(0);
  });

  it('FULL audits each mutating request BEFORE it runs, with the session reason', async () => {
    const { user } = await seedCustomer();
    const { token, session } = await startSession(user.id, { mode: 'full' });
    const raw = rawOperatorSession(currentPrincipal!);

    const result = await applyStaffSession(
      raw,
      requestHeaders(token, { 'next-action': 'abc123', 'x-current-path': '/items/X-1' }),
    );
    expect(result.kind).toBe('active');
    const actions = await auditRows('user.impersonation_action');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      actorUserId: currentPrincipal!.userId,
      targetId: user.id,
      reason: 'Ticket #4411 — board will not load',
    });
    expect(actions[0]!.metadata).toMatchObject({
      sessionId: session.id,
      mode: 'full',
      method: 'POST',
      path: '/items/X-1',
      serverAction: 'abc123',
    });
  });

  it('an EXPIRED session fails closed and writes one end row (expiry)', async () => {
    const { user } = await seedCustomer();
    const { token, session } = await startSession(user.id);
    await adminDb.impersonationSession.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const raw = rawOperatorSession(currentPrincipal!);

    const result = await applyStaffSession(raw, requestHeaders(token));
    expect(result).toMatchObject({ kind: 'ended', sessionId: session.id, operatorMatches: true });
    // A second request: still ended, no second end row.
    await applyStaffSession(raw, requestHeaders(token));
    const ends = await auditRows('user.impersonation_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.metadata).toMatchObject({ endedBy: 'expiry' });
  });

  it.each([
    ['operator_signed_out', 'revoked'],
    ['operator_lost_superadmin', 'revoked'],
    ['account_suspended', 'revoked'],
  ])('REVOKES the session (%s)', async (why) => {
    const { user } = await seedCustomer();
    const { token } = await startSession(user.id);
    let sessionId = 'operator-session-1';
    if (why === 'operator_signed_out') sessionId = 'a-different-sign-in';
    if (why === 'operator_lost_superadmin') {
      await adminDb.user.update({
        where: { id: currentPrincipal!.userId },
        data: { platformRole: 'operator' },
      });
    }
    if (why === 'account_suspended') {
      await adminDb.user.update({ where: { id: user.id }, data: { suspendedAt: new Date() } });
    }
    const result = await impersonationService.resolveForRequest(
      signIn(currentPrincipal!, sessionId),
      token,
    );
    expect(result.kind).toBe('ended');
    const ends = await auditRows('user.impersonation_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.metadata).toMatchObject({ endedBy: 'revoked', revokedBecause: why });
  });

  it('an unknown token is ended, and nothing is written', async () => {
    const result = await impersonationService.resolveForRequest(
      signIn(currentPrincipal!),
      'not-a-token',
    );
    expect(result).toEqual({ kind: 'ended', sessionId: null, operatorMatches: false });
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('classifying a request', () => {
  it('reads the three signals in order', () => {
    const tenantAction = new Headers({ 'next-action': 'x', 'x-current-path': '/a' });
    expect(classifyStaffRequest(tenantAction).mutating).toBe(true);
    // A console action (no proxy header) is not a tenant write.
    expect(classifyStaffRequest(new Headers({ 'next-action': 'x' })).mutating).toBe(false);
    expect(classifyStaffRequest(new Headers(), 'DELETE').mutating).toBe(true);
    expect(classifyStaffRequest(new Headers(), 'HEAD').mutating).toBe(false);
    expect(classifyStaffRequest(new Headers({ origin: 'https://x' })).mutating).toBe(true);
    expect(classifyStaffRequest(new Headers()).mutating).toBe(false);
    const page = classifyStaffRequest(new Headers({ 'x-current-path': '/a' }));
    expect(page).toMatchObject({ mutating: false, pageView: true });
    const prefetch = classifyStaffRequest(
      new Headers({ 'x-current-path': '/a', 'next-router-prefetch': '1' }),
    );
    expect(prefetch.pageView).toBe(false);
  });

  it('finds the token among other cookies', () => {
    expect(readStaffSessionToken(requestHeaders('tok'))).toBe('tok');
    expect(readStaffSessionToken(new Headers({ cookie: 'a=1' }))).toBeNull();
    expect(readStaffSessionToken(new Headers())).toBeNull();
  });
});

describe('ending a session', () => {
  it('Exit ends the operator’s own session once (endedBy operator)', async () => {
    const { user } = await seedCustomer();
    const { token, session } = await startSession(user.id);
    const ended = await impersonationService.endByToken(signIn(currentPrincipal!), token);
    expect(ended).toMatchObject({ id: session.id, endedBy: 'operator' });
    expect(ended!.endedAt).not.toBeNull();
    await impersonationService.endByToken(signIn(currentPrincipal!), token);
    const ends = await auditRows('user.impersonation_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.reason).toBe('Ticket #4411 — board will not load');
  });

  it('Exit ignores a token naming somebody else’s session', async () => {
    const { user } = await seedCustomer();
    const { token } = await startSession(user.id);
    const other = await seedOperator();
    expect(await impersonationService.endByToken(signIn(other), token)).toBeNull();
    expect(await auditRows('user.impersonation_end')).toHaveLength(0);
  });

  it('the stale-token settle never cuts a LIVE session short', async () => {
    const { user } = await seedCustomer();
    const { token, session } = await startSession(user.id);
    const live = await impersonationService.settleStaleToken(token, currentPrincipal!.userId);
    expect(live).toEqual({ sessionId: session.id, operatorMatches: true });
    expect(await auditRows('user.impersonation_end')).toHaveLength(0);
  });

  it('the sweep closes every session past its box, once', async () => {
    const a = await seedCustomer('A');
    const { session } = await startSession(a.user.id);
    await adminDb.impersonationSession.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    expect(await impersonationService.closeExpiredSessions()).toEqual({ closed: 1, scanned: 1 });
    expect(await impersonationService.closeExpiredSessions()).toEqual({ closed: 0, scanned: 0 });
    const ends = await auditRows('user.impersonation_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.metadata).toMatchObject({ sessionId: session.id, endedBy: 'expiry' });
  });

  it('the ended page reads only the operator’s own session', async () => {
    const { user } = await seedCustomer();
    const { session } = await startSession(user.id);
    expect(await impersonationService.getOwnSession(currentPrincipal!, session.id)).toMatchObject({
      id: session.id,
    });
    const other = await seedOperator();
    expect(await impersonationService.getOwnSession(other, session.id)).toBeNull();
  });
});

describe('minting a credential inside a session', () => {
  it('is refused while the staff-session cookie is present, and allowed without it', async () => {
    currentHeaders = requestHeaders('anything');
    await expect(assertNoStaffSessionCookie()).rejects.toBeInstanceOf(
      ImpersonationCredentialRefusedError,
    );
    currentHeaders = new Headers({ cookie: 'a=1' });
    await expect(assertNoStaffSessionCookie()).resolves.toBeUndefined();
  });
});
