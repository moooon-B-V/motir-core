import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  MONITOR_CONNECT_STATE_COOKIE,
  decodeMonitorConnectState,
  encodeMonitorConnectState,
} from '@/lib/monitors/connectState';
import {
  MONITOR_CONNECT_REASON_MAX,
  MONITOR_CONNECT_RESULT_COOKIE,
  decodeMonitorConnectResult,
  encodeMonitorConnectResult,
} from '@/lib/monitors/connectResult';
import { fakeMonitorProvider, resetFakeMonitorProvider } from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// The two OAuth ROUTES (Story MOTIR-4926 · Subtask MOTIR-5260) — what only the
// route layer owns: the httpOnly state cookie, the nonce check, the four named
// non-happy statuses, and the property the story asks a test for outright —
// **a forged callback stores nothing**.
//
// Real Postgres, because "stores nothing" is a claim about rows. The SESSION is
// the one thing a test environment cannot supply (no cookies), so `getSession` is
// stubbed — the single `vi.mock` CLAUDE.md sanctions — and everything below it
// runs for real: the permission gate, the service, the provider seam (through the
// FAKE, registered at runtime under the `sentry` discriminator) and the database.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const workspaceCookie = { current: null as string | null };

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/auth');
  return { ...actual, getSession: async () => session.current };
});
vi.mock('@/lib/services/twoFactorPolicyService', async () =>
  (await import('../../helpers/noTwoFactorPolicy')).noTwoFactorPolicy(),
);
vi.mock('@/lib/workspaces', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspaces');
  return {
    ...actual,
    getWorkspaceContext: async () =>
      session.current && workspaceCookie.current
        ? { userId: session.current.user.id, workspaceId: workspaceCookie.current }
        : null,
  };
});

const { GET: START } = await import('@/app/api/monitors/sentry/oauth/start/route');
const { GET: CALLBACK } = await import('@/app/api/monitors/sentry/oauth/callback/route');

/** Sign in as the fixture's owner. */
function signIn(fx: WorkItemFixture): void {
  session.current = {
    user: { id: fx.ownerId, email: fx.owner.email, name: fx.owner.name ?? 'Owner' },
  };
  workspaceCookie.current = fx.workspaceId;
}

const req = (url: string, cookies: Record<string, string> = {}): NextRequest => {
  const request = new NextRequest(url);
  for (const [name, value] of Object.entries(cookies)) request.cookies.set(name, value);
  return request;
};

/** The cookie value the START leg would have set for this project. */
const stateCookie = (projectId: string, nonce = 'n'.repeat(32), ageMs = 0): string =>
  encodeMonitorConnectState({
    nonce,
    projectId,
    returnSurfaceId: 'projectMonitoring',
    issuedAt: Date.now() - ageMs,
  });

beforeEach(async () => {
  await truncateAuthTables();
  resetFakeMonitorProvider();
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
  process.env['SENTRY_APP_SLUG'] = 'motir-monitor';
  process.env['SENTRY_WEB_BASE_URL'] = 'https://sentry-stub.invalid';
  session.current = null;
  workspaceCookie.current = null;
});

afterEach(() => {
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
  delete process.env['SENTRY_APP_SLUG'];
  delete process.env['SENTRY_WEB_BASE_URL'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('GET /api/monitors/sentry/oauth/start', () => {
  it('401s before anything else when nobody is signed in', async () => {
    const res = await START(req('http://localhost/api/monitors/sentry/oauth/start?project=PROD'));
    expect(res.status).toBe(401);
  });

  it('redirects to the provider and stashes the project in an httpOnly cookie', async () => {
    const fx = await makeWorkItemFixture({ name: 'Start', identifier: 'STRT' });
    signIn(fx);

    const res = await START(
      req(`http://localhost/api/monitors/sentry/oauth/start?project=${fx.projectIdentifier}`),
    );

    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location).toContain(
      'https://sentry-stub.invalid/sentry-apps/motir-monitor/external-install/',
    );
    // The nonce travels so the callback can double-submit it — and the cookie is
    // what the gate actually rests on (see `connectState.ts`).
    const echoedNonce = new URL(location).searchParams.get('state');
    expect(echoedNonce).toBeTruthy();

    const cookie = res.cookies.get(MONITOR_CONNECT_STATE_COOKIE)!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('lax');
    const state = decodeMonitorConnectState(cookie.value)!;
    // THE PROJECT IS RESOLVED HERE, where the permission was asserted — never
    // read from the callback's query string.
    expect(state.projectId).toBe(fx.projectId);
    expect(state.nonce).toBe(echoedNonce);
    expect(state.returnSurfaceId).toBe('projectMonitoring');
  });

  it('refuses a project the actor may not manage — as `forbidden`, not a 500', async () => {
    const fx = await makeWorkItemFixture({ name: 'Deny', identifier: 'DENY' });
    const viewer = await adminDb.user.create({
      data: { name: 'V', email: `sv-${Date.now()}@example.com` },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: fx.workspaceId, userId: viewer.id, role: 'member' },
    });
    await adminDb.projectMembership.create({
      data: {
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
        userId: viewer.id,
        role: 'viewer',
      },
    });
    session.current = { user: { id: viewer.id, email: 'v@x', name: 'V' } };
    workspaceCookie.current = fx.workspaceId;

    const res = await START(
      req(`http://localhost/api/monitors/sentry/oauth/start?project=${fx.projectIdentifier}`),
    );

    expect(res.headers.get('location')).toContain('monitor=forbidden');
    // And no cookie was set, so the callback cannot be reached at all.
    expect(res.cookies.get(MONITOR_CONNECT_STATE_COOKIE)).toBeUndefined();
  });

  it('says `not_configured` when the integration was never registered', async () => {
    delete process.env['SENTRY_APP_SLUG'];
    const fx = await makeWorkItemFixture({ name: 'Unconf', identifier: 'UNCF' });
    signIn(fx);

    const res = await START(
      req(`http://localhost/api/monitors/sentry/oauth/start?project=${fx.projectIdentifier}`),
    );

    // The MOTIR-5257 provisioning card is what sets it; until then the flow is
    // unreachable rather than broken.
    expect(res.headers.get('location')).toContain('monitor=not_configured');
  });

  it('says `no_project` when no project was named', async () => {
    const fx = await makeWorkItemFixture({ name: 'NoP', identifier: 'NOPX' });
    signIn(fx);
    const res = await START(req('http://localhost/api/monitors/sentry/oauth/start'));
    expect(res.headers.get('location')).toContain('monitor=no_project');
  });
});

describe('GET /api/monitors/sentry/oauth/callback', () => {
  it('completes the grant and lands on the room as `connected`', async () => {
    const fx = await makeWorkItemFixture({ name: 'Cb', identifier: 'CBOK' });
    signIn(fx);
    const nonce = 'n'.repeat(32);

    const res = await CALLBACK(
      req(
        'http://localhost/api/monitors/sentry/oauth/callback?code=valid-code&installationId=inst-1&state=' +
          nonce,
        { [MONITOR_CONNECT_STATE_COOKIE]: stateCookie(fx.projectId, nonce) },
      ),
    );

    expect(res.headers.get('location')).toContain('/settings/project/monitoring?monitor=connected');
    expect(await adminDb.monitorInstallation.count()).toBe(1);
    const row = await adminDb.monitorInstallation.findFirstOrThrow();
    expect(row.installationId).toBe('inst-1');
    expect(row.workspaceId).toBe(fx.workspaceId);
  });

  it('a FORGED callback — no state cookie at all — stores NOTHING', async () => {
    const fx = await makeWorkItemFixture({ name: 'Forged', identifier: 'FRGD' });
    signIn(fx);

    const res = await CALLBACK(
      req(
        'http://localhost/api/monitors/sentry/oauth/callback?code=valid-code&installationId=inst-attacker',
      ),
    );

    // The story's own criterion, asserted on ROWS: an install begun from the
    // provider's own directory rather than from Motir lands on the room with an
    // explanation, never a 500 — and never a GUESSED project.
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('monitor=no_state');
    expect(await adminDb.monitorInstallation.count()).toBe(0);
    expect(await adminDb.monitorConnection.count()).toBe(0);
  });

  it('rejects a MISMATCHED nonce, and stores nothing', async () => {
    const fx = await makeWorkItemFixture({ name: 'Mism', identifier: 'MISM' });
    signIn(fx);

    const res = await CALLBACK(
      req(
        'http://localhost/api/monitors/sentry/oauth/callback?code=valid-code&installationId=inst-1&state=' +
          'x'.repeat(32),
        { [MONITOR_CONNECT_STATE_COOKIE]: stateCookie(fx.projectId, 'n'.repeat(32)) },
      ),
    );

    expect(res.headers.get('location')).toContain('monitor=state_error');
    expect(await adminDb.monitorInstallation.count()).toBe(0);
  });

  it('rejects an EXPIRED cookie as `no_state`, and stores nothing', async () => {
    const fx = await makeWorkItemFixture({ name: 'Stale', identifier: 'STAL' });
    signIn(fx);

    const res = await CALLBACK(
      req(
        'http://localhost/api/monitors/sentry/oauth/callback?code=valid-code&installationId=inst-1',
        { [MONITOR_CONNECT_STATE_COOKIE]: stateCookie(fx.projectId, 'n'.repeat(32), 3_600_000) },
      ),
    );

    expect(res.headers.get('location')).toContain('monitor=no_state');
    expect(await adminDb.monitorInstallation.count()).toBe(0);
  });

  it('reads a DECLINE as `denied`, and stores nothing', async () => {
    const fx = await makeWorkItemFixture({ name: 'Deny2', identifier: 'DNY2' });
    signIn(fx);

    const res = await CALLBACK(
      req('http://localhost/api/monitors/sentry/oauth/callback?error=access_denied', {
        [MONITOR_CONNECT_STATE_COOKIE]: stateCookie(fx.projectId),
      }),
    );

    expect(res.headers.get('location')).toContain('monitor=denied');
    expect(await adminDb.monitorInstallation.count()).toBe(0);
  });

  it('carries the PROVIDER’S OWN reason when the exchange fails, and stores nothing', async () => {
    const fx = await makeWorkItemFixture({ name: 'Err', identifier: 'ERRX' });
    signIn(fx);

    const res = await CALLBACK(
      req(
        'http://localhost/api/monitors/sentry/oauth/callback?code=replayed-code&installationId=inst-1',
        { [MONITOR_CONNECT_STATE_COOKIE]: stateCookie(fx.projectId) },
      ),
    );

    expect(res.headers.get('location')).toContain('monitor=error');
    // ⚠️ THE REASON RIDES A COOKIE THE PAGE CAN READ, not a header on the redirect.
    // This assertion used to read an `x-monitor-provider-reason` header off the
    // route's own Response — which passed while no browser could ever see it,
    // because a redirect's headers never reach the page it lands on.
    const result = res.cookies.get(MONITOR_CONNECT_RESULT_COOKIE);
    expect(result?.httpOnly).toBe(true);
    expect(decodeMonitorConnectResult(result?.value)).toContain('Unknown grant code');
    expect(res.headers.get('x-monitor-provider-reason')).toBeNull();
    // And never the URL: a reason in the query string is content spoofing.
    expect(res.headers.get('location')).not.toContain('Unknown');
    expect(await adminDb.monitorInstallation.count()).toBe(0);
  });

  it('CLEARS the single-use state on every terminal outcome', async () => {
    const fx = await makeWorkItemFixture({ name: 'Once', identifier: 'ONCE' });
    signIn(fx);

    const res = await CALLBACK(
      req(
        'http://localhost/api/monitors/sentry/oauth/callback?code=valid-code&installationId=inst-1',
        { [MONITOR_CONNECT_STATE_COOKIE]: stateCookie(fx.projectId) },
      ),
    );

    // A replayed callback then finds no cookie and is refused by the `no_state`
    // arm — which is the whole reason the clear is on every path and not only on
    // the happy one.
    const cleared = res.cookies.get(MONITOR_CONNECT_STATE_COOKIE);
    expect(cleared?.value ?? '').toBe('');
  });

  it('is served at EXACTLY the path the provisioning card registers', () => {
    // The redirect URL MOTIR-5257 fixes is
    // `https://app.motir.co/api/monitors/sentry/oauth/callback`. A route moved
    // under a different segment would be a 404 the provider reports and nobody
    // here sees, so the path is pinned as a fact about the filesystem.
    expect(
      existsSync(join(process.cwd(), 'app/api/monitors/sentry/oauth/callback/route.ts')),
      'the callback must stay at the path MOTIR-5257 registers as the redirect URL',
    ).toBe(true);
  });
});

describe('the connect RESULT cookie', () => {
  it('round-trips a reason, and caps an unbounded one', () => {
    expect(decodeMonitorConnectResult(encodeMonitorConnectResult('Invalid token'))).toBe(
      'Invalid token',
    );
    const huge = 'x'.repeat(MONITOR_CONNECT_REASON_MAX * 3);
    expect(decodeMonitorConnectResult(encodeMonitorConnectResult(huge))).toHaveLength(
      MONITOR_CONNECT_REASON_MAX,
    );
  });

  it('is null for anything absent or malformed', () => {
    expect(decodeMonitorConnectResult(null)).toBeNull();
    expect(decodeMonitorConnectResult('not-json')).toBeNull();
    expect(
      decodeMonitorConnectResult(Buffer.from(JSON.stringify({ reason: 7 })).toString('base64url')),
    ).toBeNull();
  });
});
