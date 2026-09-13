import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type {
  AvailableMonitorProjectDto,
  MonitorConnectionDto,
  MonitorConnectionViewDto,
} from '@/lib/dto/monitors';
import { MonitorGrantNotFoundError, MonitorProviderCallError } from '@/lib/monitors/errors';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { decryptToken } from '@/lib/monitors/tokenCrypto';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { monitorCredentialService } from '@/lib/services/monitorCredentialService';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// THE STORY'S VITEST GATE — the writer → consumer SEAMS (Story MOTIR-4928 ·
// MOTIR-5263).
//
// Each code card in this story ships units against its own doubles. This file
// drives one card's REAL output through the next card's REAL consumer, on real
// Postgres, and asserts on the CONSUMING side — the DTO the room receives over
// its own routes, the token the next provider call is handed — never on the
// producing side's return value. The fake provider stands in for Sentry; every
// Motir layer between the provider and the room is real.

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

const VIEW = await import('@/app/api/projects/[key]/monitors/route');
const ONE = await import('@/app/api/projects/[key]/monitors/[connectionId]/route');
const AVAILABLE = await import('@/app/api/projects/[key]/monitors/available/route');

beforeEach(async () => {
  await truncateAuthTables();
  resetFakeMonitorProvider();
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
  session.current = null;
  workspaceCookie.current = null;
});

afterEach(() => {
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function signIn(fx: WorkItemFixture): void {
  session.current = {
    user: { id: fx.ownerId, email: fx.owner.email, name: fx.owner.name ?? 'Owner' },
  };
  workspaceCookie.current = fx.workspaceId;
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
const url = (fx: WorkItemFixture, rest = '') =>
  `https://motir.test/api/projects/${fx.projectIdentifier}/monitors${rest}`;

async function readView(fx: WorkItemFixture): Promise<MonitorConnectionViewDto> {
  const res = await VIEW.GET(new Request(url(fx)), params({ key: fx.projectIdentifier }));
  expect(res.status).toBe(200);
  return (await res.json()) as MonitorConnectionViewDto;
}

async function bind(fx: WorkItemFixture, externalProjectId: string, slug: string) {
  return VIEW.POST(
    new Request(url(fx), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ externalProjectId, externalProjectSlug: slug }),
    }),
    params({ key: fx.projectIdentifier }),
  );
}

/** The CONNECT card's writer: what the callback runs once Sentry redirects back. */
async function connect(fx: WorkItemFixture, providerInstallationId = 'provider-install-1') {
  return monitorConnectionService.completeGrant(
    { provider: 'sentry', providerInstallationId, code: 'valid-code', projectId: fx.projectId },
    fx.ctx,
  );
}

const TOKENS = ['fake-access-token', 'fake-refresh-token'];

describe('seam 1 · exchangeGrant → persist → read back → the DTO the room receives', () => {
  it('stores CIPHERTEXT, and the room’s own route returns the grant with no token at all', async () => {
    const fx = await makeWorkItemFixture({ name: 'Seam1', identifier: 'SEMA' });
    signIn(fx);
    await connect(fx);

    // The persisted row: encrypted, versioned, and decrypting to what the
    // provider exchanged — read as the OWNER, beneath the layer under test.
    const row = await adminDb.monitorInstallation.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId },
    });
    expect(row.accessTokenEncrypted.startsWith('v1.')).toBe(true);
    expect(row.accessTokenEncrypted).not.toContain('fake-access-token');
    expect(decryptToken(row.accessTokenEncrypted)).toBe('fake-access-token');
    expect(decryptToken(row.refreshTokenEncrypted)).toBe('fake-refresh-token');

    // The CONSUMER: the route the room renders from.
    const view = await readView(fx);
    expect(view.installationId).toBe(row.id);
    expect(view.orgSlug).toBe('fake-org');
    expect(view.connections).toEqual([]);
    const body = JSON.stringify(view);
    for (const secret of [...TOKENS, 'v1.']) expect(body).not.toContain(secret);
  });

  it('a bind through the room’s route appears in the room’s read, still with no token', async () => {
    const fx = await makeWorkItemFixture({ name: 'Seam1b', identifier: 'SEMB' });
    signIn(fx);
    await connect(fx);

    const created = await bind(fx, 'fake-web', 'web');
    expect(created.status).toBe(201);
    const dto = (await created.json()) as MonitorConnectionDto;

    const view = await readView(fx);
    expect(view.connections.map((c) => c.id)).toEqual([dto.id]);
    expect(JSON.stringify(view)).not.toContain('fake-access-token');
  });
});

describe('seam 2 · a refresh’s ROTATED pair → the next provider call’s credential', () => {
  it('the picker’s read refreshes an expired token and hands the provider the NEW one', async () => {
    const fx = await makeWorkItemFixture({ name: 'Seam2', identifier: 'SEMC' });
    signIn(fx);
    const { installationId } = await connect(fx);
    // Expire the stored token — the state between two refresh sweeps.
    await adminDb.monitorInstallation.update({
      where: { id: installationId },
      data: { tokenExpiresAt: new Date(Date.now() - 60_000) },
    });
    const listProjects = vi.spyOn(fakeMonitorProvider, 'listProjects');

    const first = await AVAILABLE.GET(
      new Request(url(fx, '/available')),
      params({ key: fx.projectIdentifier }),
    );
    expect(first.status).toBe(200);

    // The CONSUMER side: the token the provider was actually handed.
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(listProjects.mock.calls[0]![0].accessToken).toBe('fake-access-token-1');
    // And the rotated pair was persisted, so the NEXT reader agrees.
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({
      where: { id: installationId },
    });
    expect(decryptToken(row.accessTokenEncrypted)).toBe('fake-access-token-1');
    expect(decryptToken(row.refreshTokenEncrypted)).toBe('fake-refresh-token-1');

    // A second read uses the SAME rotated token and does not refresh again.
    await AVAILABLE.GET(new Request(url(fx, '/available')), params({ key: fx.projectIdentifier }));
    expect(listProjects.mock.calls[1]![0].accessToken).toBe('fake-access-token-1');
    expect(fakeMonitorState().refreshCount).toBe(1);
  });

  it('a refused refresh reaches the picker as a 502 carrying Sentry’s reason', async () => {
    const fx = await makeWorkItemFixture({ name: 'Seam2b', identifier: 'SEMD' });
    signIn(fx);
    const { installationId } = await connect(fx);
    await adminDb.monitorInstallation.update({
      where: { id: installationId },
      data: { tokenExpiresAt: new Date(Date.now() - 60_000) },
    });
    fakeMonitorState().failNext.add('refreshCredential');

    const res = await AVAILABLE.GET(
      new Request(url(fx, '/available')),
      params({ key: fx.projectIdentifier }),
    );
    expect(res.status).toBe(502);
    expect(((await res.json()) as { providerReason: string }).providerReason).toBe(
      'The authorization has been revoked.',
    );
  });
});

describe('seam 3 · a `degraded` verdict → the shape the room’s read returns', () => {
  it('carries the provider’s reason VERBATIM across the DTO boundary, on the grant and every row', async () => {
    const fx = await makeWorkItemFixture({ name: 'Seam3', identifier: 'SEME' });
    signIn(fx);
    const { installationId } = await connect(fx);
    expect((await bind(fx, 'fake-web', 'web')).status).toBe(201);
    expect((await bind(fx, 'fake-worker', 'worker')).status).toBe(201);

    // The LIFECYCLE card's writer, with a reason no Motir string would produce:
    // odd spacing, punctuation and a quote — anything normalised would differ.
    const reason = '  Token revoked by owner “ops@acme” — re-install required.  ';
    vi.spyOn(fakeMonitorProvider, 'describeHealth').mockResolvedValue({
      status: 'degraded',
      reason,
      checkedAt: new Date(),
    });
    await monitorCredentialService.probeHealth(fx.projectId, installationId, fx.ctx);

    const view = await readView(fx);
    expect(view.health).toBe('degraded');
    expect(view.healthReason).toBe(reason);
    expect(view.healthCheckedAt).not.toBeNull();
    expect(view.connections).toHaveLength(2);
    for (const row of view.connections) {
      expect(row.health).toBe('degraded');
      expect(row.healthReason).toBe(reason);
    }
  });
});

describe('cross-tenant isolation, through the room’s own routes', () => {
  it('the actor sees their workspace’s grant and bindings while the table holds MORE', async () => {
    const a = await makeWorkItemFixture({ name: 'TenantA', identifier: 'TENA' });
    const b = await makeWorkItemFixture({ name: 'TenantB', identifier: 'TENB' });
    signIn(b);
    const grantB = await connect(b, 'provider-install-b');
    expect((await bind(b, 'fake-web', 'web')).status).toBe(201);
    expect((await bind(b, 'fake-worker', 'worker')).status).toBe(201);
    signIn(a);
    const grantA = await connect(a, 'provider-install-a');
    expect((await bind(a, 'fake-web', 'web')).status).toBe(201);

    // The TRUE population, read as the owner.
    expect(await adminDb.monitorInstallation.count()).toBe(2);
    expect(await adminDb.monitorConnection.count()).toBe(3);

    // What actor A is shown — a strict subset, and not the other tenant's rows.
    const view = await readView(a);
    expect(view.installationId).toBe(grantA.installationId);
    expect(view.installationId).not.toBe(grantB.installationId);
    expect(view.connections).toHaveLength(1);
    expect(view.connections.length).not.toBe(await adminDb.monitorConnection.count());

    // The picker's `bound` flag is THIS project's, not tenant B's two bindings.
    const res = await AVAILABLE.GET(
      new Request(url(a, '/available')),
      params({ key: a.projectIdentifier }),
    );
    const available = (await res.json()) as AvailableMonitorProjectDto[];
    expect(available.filter((p) => p.bound).map((p) => p.externalId)).toEqual(['fake-web']);
  });

  it('refuses to disconnect another tenant’s binding by id', async () => {
    const a = await makeWorkItemFixture({ name: 'TenantC', identifier: 'TENC' });
    const b = await makeWorkItemFixture({ name: 'TenantD', identifier: 'TEND' });
    signIn(b);
    await connect(b, 'provider-install-d');
    const theirs = (await (await bind(b, 'fake-web', 'web')).json()) as MonitorConnectionDto;
    signIn(a);
    await connect(a, 'provider-install-c');

    const res = await ONE.DELETE(
      new Request(url(a, `/${theirs.id}`), { method: 'DELETE' }),
      params({ key: a.projectIdentifier, connectionId: theirs.id }),
    );
    expect(res.status).toBe(404);
    expect(await adminDb.monitorConnection.count({ where: { id: theirs.id } })).toBe(1);
  });
});

describe('the routes map each refusal to what the room renders', () => {
  it('422 names the missing field; 409 carries the already-bound code; 404 for an unknown binding', async () => {
    const fx = await makeWorkItemFixture({ name: 'Codes', identifier: 'CODE' });
    signIn(fx);
    await connect(fx);

    const missing = await VIEW.POST(
      new Request(url(fx), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ externalProjectId: 'fake-web' }),
      }),
      params({ key: fx.projectIdentifier }),
    );
    expect(missing.status).toBe(422);

    expect((await bind(fx, 'fake-web', 'web')).status).toBe(201);
    const again = await bind(fx, 'fake-web', 'web');
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe(
      'MONITOR_CONNECTION_ALREADY_EXISTS',
    );

    const unknown = await ONE.DELETE(
      new Request(url(fx, '/nope'), { method: 'DELETE' }),
      params({ key: fx.projectIdentifier, connectionId: 'nope' }),
    );
    expect(unknown.status).toBe(404);
  });

  it('the picker’s read with NO grant is a 409 carrying the grant-missing code', async () => {
    const fx = await makeWorkItemFixture({ name: 'NoGrant', identifier: 'NOGR' });
    signIn(fx);
    const res = await AVAILABLE.GET(
      new Request(url(fx, '/available')),
      params({ key: fx.projectIdentifier }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('MONITOR_GRANT_NOT_FOUND');
  });
});

describe('the credential lifecycle’s refusal arms', () => {
  it('getAccessToken on a grant that does not exist is a typed refusal, not a crash', async () => {
    await expect(monitorCredentialService.getAccessToken('no-such-grant')).rejects.toBeInstanceOf(
      MonitorGrantNotFoundError,
    );
  });

  it('a refresh that fails with something OTHER than a provider refusal still writes `degraded`', async () => {
    const fx = await makeWorkItemFixture({ name: 'Boom', identifier: 'BOOM' });
    signIn(fx);
    const { installationId } = await connect(fx);
    await adminDb.monitorInstallation.update({
      where: { id: installationId },
      data: { tokenExpiresAt: new Date(Date.now() - 60_000) },
    });
    vi.spyOn(fakeMonitorProvider, 'refreshCredential').mockRejectedValue(
      new Error('socket hang up'),
    );

    await expect(monitorCredentialService.getAccessToken(installationId)).rejects.toThrow();
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({
      where: { id: installationId },
    });
    expect(row.health).toBe('degraded');
    expect(row.healthReason).toBe('The refresh failed.');
  });
});

describe('a grant whose provider reported NO organisation', () => {
  it('stores no metadata, reads a null org, and hands the provider an empty slug rather than a guess', async () => {
    const fx = await makeWorkItemFixture({ name: 'NoOrg', identifier: 'NORG' });
    signIn(fx);
    fakeMonitorState().orgSlug = null;
    const { installationId } = await connect(fx);

    expect((await readView(fx)).orgSlug).toBeNull();

    const listProjects = vi.spyOn(fakeMonitorProvider, 'listProjects');
    await AVAILABLE.GET(new Request(url(fx, '/available')), params({ key: fx.projectIdentifier }));
    expect(listProjects.mock.calls[0]![0].orgSlug).toBe('');

    const describeHealth = vi.spyOn(fakeMonitorProvider, 'describeHealth');
    await monitorCredentialService.probeHealth(fx.projectId, installationId, fx.ctx);
    expect(describeHealth.mock.calls[0]![0].orgSlug).toBe('');
  });
});

describe('the credential lifecycle’s remaining arms', () => {
  it('a retry that fails with something other than a provider refusal is re-thrown and writes NO verdict', async () => {
    const fx = await makeWorkItemFixture({ name: 'Retry', identifier: 'RETR' });
    const { installationId } = await connect(fx);
    let attempt = 0;
    await expect(
      monitorCredentialService.withFreshCredential(installationId, async () => {
        attempt += 1;
        if (attempt === 1) throw new MonitorProviderCallError('listProjects', 401, 'expired');
        throw new Error('bug in the caller');
      }),
    ).rejects.toThrow('bug in the caller');
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({
      where: { id: installationId },
    });
    expect(row.health).toBe('connected');
  });

  it('probeHealth re-throws a refusal that is not the provider’s — a missing grant', async () => {
    const fx = await makeWorkItemFixture({ name: 'Probe', identifier: 'PROB' });
    await expect(
      monitorCredentialService.probeHealth(fx.projectId, 'no-such-grant', fx.ctx),
    ).rejects.toBeInstanceOf(MonitorGrantNotFoundError);
  });

  // THE INVARIANT behind `probeHealth`'s `v8 ignore`d read-back fallbacks: the
  // refused refresh writes all three health fields under its own lock BEFORE it
  // throws, so the read-back finds a row with none of them null.
  it('a refused refresh has written all three health fields before probeHealth reads them back', async () => {
    const fx = await makeWorkItemFixture({ name: 'Fields', identifier: 'FLDS' });
    const { installationId } = await connect(fx);
    await adminDb.monitorInstallation.update({
      where: { id: installationId },
      data: { tokenExpiresAt: new Date(Date.now() - 60_000) },
    });
    fakeMonitorState().failNext.add('refreshCredential');
    await expect(monitorCredentialService.getAccessToken(installationId)).rejects.toBeInstanceOf(
      MonitorProviderCallError,
    );
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({
      where: { id: installationId },
    });
    expect(row.health).toBe('degraded');
    expect(row.healthReason).not.toBeNull();
    expect(row.healthCheckedAt).not.toBeNull();
  });

  // THE INVARIANT behind `bindProject`'s `v8 ignore`d read-back miss: the bind
  // reads back, inside its own transaction and context, the row its write created.
  it('a bind reads back the row it created, inside the same transaction', async () => {
    const fx = await makeWorkItemFixture({ name: 'ReadBack', identifier: 'RDBK' });
    await connect(fx);
    const dto = await monitorConnectionService.bindProject(
      fx.projectId,
      { externalProjectId: 'fake-worker', externalProjectSlug: 'worker' },
      fx.ctx,
    );
    const stored = await adminDb.monitorConnection.findUniqueOrThrow({ where: { id: dto.id } });
    expect(stored.externalProjectId).toBe('fake-worker');
  });
});

describe('no plaintext escapes into a LOG line, on the success or the failure path', () => {
  it('logs nothing carrying a token while connecting, binding, reading and failing a refresh', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(
          args
            .map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a)))
            .join(' '),
        );
      });
    }

    const fx = await makeWorkItemFixture({ name: 'Logs', identifier: 'LOGS' });
    signIn(fx);
    const { installationId } = await connect(fx);
    await bind(fx, 'fake-web', 'web');
    await readView(fx);
    // The failure path: an expired token whose refresh is refused.
    await adminDb.monitorInstallation.update({
      where: { id: installationId },
      data: { tokenExpiresAt: new Date(Date.now() - 60_000) },
    });
    fakeMonitorState().failNext.add('refreshCredential');
    await AVAILABLE.GET(new Request(url(fx, '/available')), params({ key: fx.projectIdentifier }));

    const row = await adminDb.monitorInstallation.findUniqueOrThrow({
      where: { id: installationId },
    });
    const all = lines.join('\n');
    for (const secret of [...TOKENS, row.accessTokenEncrypted, row.refreshTokenEncrypted]) {
      expect(all).not.toContain(secret);
    }
  });
});
