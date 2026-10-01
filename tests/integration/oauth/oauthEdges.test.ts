import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The OAuth story's EDGES (Story MOTIR-6973 · Subtask MOTIR-6987) — the refusals
// and fallbacks the journey suite beside this one never walks through, against
// the real database and the real provider. Each case is a branch a person or a
// client can actually reach: a request that stopped being usable between the
// authorize step and the press, an app that named itself nothing, a body a
// hand-rolled client got wrong. Together with the journey suite they hold the
// story's changed files at the per-file coverage gate.
vi.hoisted(() => {
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

const requireCompliantSession = vi.fn();
vi.mock('@/lib/auth/requireCompliantSession', () => ({
  requireCompliantSession: () => requireCompliantSession(),
}));

const { db } = await import('@/lib/db');
const { adminDb } = await import('../../helpers/adminDb');
const { truncateAuthTables } = await import('../../helpers/db');
const { createTestUser } = await import('../../fixtures/userFixtures');
const { createTestWorkspace } = await import('../../fixtures/workspaceFixtures');
const { makeWorkItemFixture } = await import('../../fixtures/workItemFixtures');
const { oauthConnectionsService } = await import('@/lib/services/oauthConnectionsService');
const { IRREVERSIBLE_PERMISSIONS } = await import('@/lib/tokens/grant');
const { OAuthAccessTokenRejectedError, OAuthConsentRequestInvalidError } =
  await import('@/lib/oauth/errors');
const { toOAuthConnectionDto } = await import('@/lib/mappers/oauthConnectionMappers');
const { oauthSweep } = await import('@/lib/jobs/definitions/oauthSweep');
const consentRoute = await import('@/app/api/oauth/consent/route');
const connectionRoute = await import('@/app/api/account/oauth-connections/[id]/route');
const {
  BASE,
  CLAUDE_CALLBACK,
  authorize,
  authorizeUrl,
  connect,
  consentQuery,
  exchange,
  location,
  pkce,
  register,
  registeredClientId,
  signIn,
} = await import('../../helpers/oauthFlow');
const { NextResponse } = await import('next/server');
const authRoute = await import('@/app/api/auth/[...all]/route');

beforeEach(async () => {
  await truncateAuthTables();
  requireCompliantSession.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function rejection(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OAuthConsentRequestInvalidError);
  return err as InstanceType<typeof OAuthConsentRequestInvalidError>;
}

// ── the consent route: what a hand-rolled client can get wrong ─────────────

describe('POST /api/oauth/consent — the request shape', () => {
  async function post(body: unknown, raw?: string): Promise<Response> {
    return consentRoute.POST(
      new Request(`${BASE}/api/oauth/consent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: raw ?? JSON.stringify(body),
      }),
    );
  }

  it('is refused signed out, before anything is read', async () => {
    requireCompliantSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 }),
    });
    expect((await post({ action: 'deny', oauthQuery: 'x' })).status).toBe(401);
  });

  it.each([
    ['a body that is not JSON', undefined, '{not json'],
    ['no oauthQuery', { action: 'deny' }, undefined],
    ['an unknown action', { action: 'maybe', oauthQuery: 'q' }, undefined],
    ['approve with no workspace', { action: 'approve', oauthQuery: 'q' }, undefined],
    [
      'a project that is not a string',
      { action: 'approve', oauthQuery: 'q', workspaceId: 'w', projectId: 7 },
      undefined,
    ],
    [
      'permissions that are not strings',
      { action: 'approve', oauthQuery: 'q', workspaceId: 'w', permissions: [1] },
      undefined,
    ],
  ])('answers 400 for %s', async (_label, body, raw) => {
    const user = await createTestUser();
    requireCompliantSession.mockResolvedValue({ ok: true, session: { user } });
    const res = await post(body, raw);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BAD_REQUEST');
  });

  it('answers 404 for a project the person cannot reach, and 422 for a grant beyond theirs', async () => {
    const fx = await makeWorkItemFixture();
    const clientId = await registeredClientId();
    const { cookie } = await signIn(fx.owner);
    requireCompliantSession.mockResolvedValue({ ok: true, session: { user: fx.owner } });
    const approve = async (extra: Record<string, unknown>) =>
      consentRoute.POST(
        new Request(`${BASE}/api/oauth/consent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie, origin: BASE },
          body: JSON.stringify({
            action: 'approve',
            oauthQuery: await consentQuery(clientId, cookie),
            workspaceId: fx.workspaceId,
            ...extra,
          }),
        }),
      );
    expect((await approve({ projectId: 'no-such-project' })).status).toBe(404);
    const beyond = await approve({ projectId: fx.projectId, permissions: ['not:a-permission'] });
    expect(beyond.status).toBe(422);
    expect(await adminDb.apiToken.count()).toBe(0);
  });

  it('lets an unexpected failure through rather than dressing it as a refusal', async () => {
    const user = await createTestUser();
    requireCompliantSession.mockResolvedValue({ ok: true, session: { user } });
    vi.spyOn(oauthConnectionsService, 'denyConsent').mockRejectedValue(new Error('db down'));
    await expect(post({ action: 'deny', oauthQuery: 'q' })).rejects.toThrow('db down');
  });
});

describe('DELETE /api/account/oauth-connections/:id', () => {
  it('lets an unexpected failure through rather than answering 404', async () => {
    const user = await createTestUser();
    requireCompliantSession.mockResolvedValue({ ok: true, session: { user } });
    vi.spyOn(oauthConnectionsService, 'revoke').mockRejectedValue(new Error('db down'));
    await expect(
      connectionRoute.DELETE(new Request(`${BASE}/x`), { params: Promise.resolve({ id: 'c' }) }),
    ).rejects.toThrow('db down');
  });
});

// ── the consent request, between the authorize step and the press ──────────

describe('a consent request that stopped being usable', () => {
  it('names the app refused when it was disabled or deleted after authorize', async () => {
    const clientId = await registeredClientId();
    const { cookie, user } = await signIn();
    const query = await consentQuery(clientId, cookie);
    await adminDb.oauthClient.update({ where: { clientId }, data: { disabled: true } });
    const err = await rejection(oauthConnectionsService.describeConsentRequest(user.id, query));
    expect(err.reason).toBe('invalid_client');
    await adminDb.oauthClient.delete({ where: { clientId } });
    expect(
      (await rejection(oauthConnectionsService.describeConsentRequest(user.id, query))).reason,
    ).toBe('invalid_client');
  });

  it('refuses to name a redirect the app no longer registers', async () => {
    const clientId = await registeredClientId();
    const { cookie, user } = await signIn();
    const query = await consentQuery(clientId, cookie);
    await adminDb.oauthClient.update({
      where: { clientId },
      data: { redirectUris: ['https://elsewhere.example/cb'] },
    });
    const err = await rejection(oauthConnectionsService.describeConsentRequest(user.id, query));
    expect(err.reason).toBe('invalid_redirect');
  });

  it('a press the provider refuses is `rejected`, and the connection it wrote is taken back', async () => {
    const clientId = await registeredClientId();
    const { workspace, owner } = await createTestWorkspace();
    const { cookie } = await signIn(owner);
    const query = await consentQuery(clientId, cookie);
    // No session on the provider call: the provider refuses the accept.
    const err = await rejection(
      oauthConnectionsService.approveConsent({
        userId: owner.id,
        headers: new Headers({ origin: BASE }),
        oauthQuery: query,
        workspaceId: workspace.id,
        projectId: null,
      }),
    );
    expect(err.reason).toBe('rejected');
    expect(await adminDb.apiToken.count({ where: { oauthClientId: clientId } })).toBe(0);
  });
});

// ── what the screen says about the app and the person ──────────────────────

describe('describing the request', () => {
  it('an app that named itself nothing reads as unnamed, and its connection gets a label anyway', async () => {
    const clientId = await registeredClientId();
    await adminDb.oauthClient.update({ where: { clientId }, data: { name: '  ' } });
    const { workspace, owner } = await createTestWorkspace();
    const { cookie } = await signIn(owner);
    const described = await oauthConnectionsService.describeConsentRequest(
      owner.id,
      await consentQuery(clientId, cookie),
    );
    expect(described.client.name).toBeNull();
    expect(described.client.unverified).toBe(true);
    expect(await oauthConnectionsService.clientDisplayName(clientId)).toBeNull();

    const { connectionId } = await connect({ clientId, user: owner, workspaceId: workspace.id });
    const row = await adminDb.apiToken.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row.label.length).toBeGreaterThan(0);
  });

  it('a workspace with nothing to grant is named as unusable, not offered', async () => {
    const clientId = await registeredClientId();
    const { owner } = await createTestWorkspace({ name: 'Empty' });
    const { cookie } = await signIn(owner);
    const described = await oauthConnectionsService.describeConsentRequest(
      owner.id,
      await consentQuery(clientId, cookie),
    );
    expect(described.workspaces).toEqual([]);
    expect(described.unusableWorkspaces).toHaveLength(1);
    expect(described.unusableWorkspaces[0]).toContain('Empty');
  });

  it('a loopback redirect is marked as this computer', async () => {
    const callback = 'http://127.0.0.1:53682/callback';
    const clientId = await registeredClientId(callback);
    const { cookie, user } = await signIn();
    const res = await authorize(
      { clientId, redirectUri: callback, challenge: pkce().challenge, scope: 'offline_access' },
      cookie,
    );
    const described = await oauthConnectionsService.describeConsentRequest(
      user.id,
      location(res).searchParams.toString(),
    );
    expect(described.loopback).toBe(true);
    expect(described.redirectHost).toBe('127.0.0.1:53682');
  });

  it('clientDisplayName: the registered name, and nothing for an unknown or disabled app', async () => {
    const clientId = await registeredClientId();
    expect(await oauthConnectionsService.clientDisplayName(clientId)).toBe('Claude');
    expect(await oauthConnectionsService.clientDisplayName('nobody')).toBeNull();
    await adminDb.oauthClient.update({ where: { clientId }, data: { disabled: true } });
    expect(await oauthConnectionsService.clientDisplayName(clientId)).toBeNull();
  });
});

// ── the grant ──────────────────────────────────────────────────────────────

describe('the grant a connection records', () => {
  it('one project with no chosen grant: everything the person can confer there but the irreversible', async () => {
    const fx = await makeWorkItemFixture();
    const clientId = await registeredClientId();
    const { connectionId } = await connect({
      clientId,
      user: fx.owner,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    const [dto] = await oauthConnectionsService.listForUser(fx.ownerId);
    expect(dto!.id).toBe(connectionId);
    expect(dto!.project?.id).toBe(fx.projectId);
    expect(dto!.permissions.length).toBeGreaterThan(0);
    for (const key of IRREVERSIBLE_PERMISSIONS) expect(dto!.permissions).not.toContain(key);
  });

  it('a stored value nobody recognises is ignored, with a warning, rather than refusing the app', async () => {
    const clientId = await registeredClientId();
    const keys = pkce();
    const c = await connect({ clientId, keys });
    const { access_token } = await exchange(clientId, c.code, keys.verifier);
    const row = await adminDb.apiToken.findUniqueOrThrow({ where: { id: c.connectionId } });
    await adminDb.apiToken.update({
      where: { id: c.connectionId },
      data: { scopes: [...row.scopes, 'retired:permission'] },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const resolved = await oauthConnectionsService.resolveAccessToken(access_token);
    expect(resolved.grant).not.toContain('retired:permission');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unrecognised grant'));
  });

  it('an access token the provider stamped revoked is refused, though its row remains', async () => {
    // better-auth 1.7 stamps `revoked` on a signed-out session's access tokens
    // rather than deleting them (MOTIR-7171); the gate must read the stamp.
    const clientId = await registeredClientId();
    const keys = pkce();
    const c = await connect({ clientId, keys });
    const { access_token } = await exchange(clientId, c.code, keys.verifier);
    await adminDb.oauthAccessToken.updateMany({
      where: { clientId },
      data: { revoked: new Date() },
    });
    const refused = await oauthConnectionsService
      .resolveAccessToken(access_token)
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(OAuthAccessTokenRejectedError);
    expect((refused as InstanceType<typeof OAuthAccessTokenRejectedError>).reason).toBe('revoked');
  });
});

// ── the authorize and register hooks ───────────────────────────────────────

describe('the authorize policy', () => {
  it('an authorize with no client, or a disabled one, is refused on Motir’s own page', async () => {
    const { cookie } = await signIn();
    const noClient = location(await authorize({ clientId: '' }, cookie));
    expect(noClient.pathname).toBe('/oauth/error');
    expect(noClient.searchParams.get('error')).toBe('invalid_client');

    const clientId = await registeredClientId();
    await adminDb.oauthClient.update({ where: { clientId }, data: { disabled: true } });
    const disabled = location(await authorize({ clientId }, cookie));
    expect(disabled.pathname).toBe('/oauth/error');
    expect(disabled.searchParams.get('error')).toBe('invalid_client');
  });

  it('an unparseable redirect is refused without naming a host', async () => {
    const clientId = await registeredClientId();
    const { cookie } = await signIn();
    const res = await authorize({ clientId, redirectUri: 'not a url' }, cookie);
    const to = location(res);
    expect(to.pathname).toBe('/oauth/error');
    expect(to.searchParams.get('error')).toBe('invalid_redirect');
    expect(to.searchParams.get('host')).toBeNull();
  });

  it('an authorize with no redirect at all is refused on Motir’s own page, naming no host', async () => {
    const clientId = await registeredClientId();
    const { cookie } = await signIn();
    const to = location(await authorize({ clientId, redirectUri: '' }, cookie));
    expect(to.pathname).toBe('/oauth/error');
    expect(to.searchParams.get('error')).toBe('invalid_redirect');
    expect(to.searchParams.get('host')).toBeNull();
  });

  it('a refused resource with no state goes back to the app without inventing one', async () => {
    const clientId = await registeredClientId();
    const { cookie } = await signIn();
    const url = new URL(authorizeUrl({ clientId, resource: null }));
    url.searchParams.delete('state');
    const res = await authRoute.GET(new Request(url, { headers: { cookie } }));
    const to = location(res);
    expect(to.origin + to.pathname).toBe(CLAUDE_CALLBACK);
    expect(to.searchParams.get('error')).toBe('invalid_target');
    expect(to.searchParams.has('state')).toBe(false);
  });

  it('a registration that sends no redirect list is left to the provider’s own schema', async () => {
    const res = await register('https://claude.ai/cb' as unknown as string[]);
    expect(res.status).toBe(400);
    // better-auth 1.7's own schema answers a malformed `redirect_uris` with the
    // same RFC 7591 code Motir's policy uses, so the CODE no longer says whose
    // refusal it is — the description does. Motir's names the allowed schemes.
    const body = (await res.json()) as { error_description?: string };
    expect(body.error_description ?? '').not.toMatch(/must use https/);
  });

  it('a registration with no body at all is left to the provider’s own schema', async () => {
    const res = await authRoute.POST(
      new Request(`${BASE}/api/auth/oauth2/register`, {
        method: 'POST',
        headers: { 'x-forwarded-for': '10.9.9.9' },
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('a registration whose redirect list is not a list of strings is refused', async () => {
    const res = await register([42 as unknown as string]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
  });
});

// ── leaves ─────────────────────────────────────────────────────────────────

describe('the mapper', () => {
  const base = {
    id: 't1',
    oauthClientId: 'cl',
    projectId: null,
    project: null,
    scopes: ['project:browse'],
    createdAt: new Date('2026-09-01T00:00:00Z'),
    lastUsedAt: null,
    workspace: { id: 'w', name: 'W', organization: { id: 'o', name: 'O' } },
  };

  it('reads a missing client as an unverified app with no name or host', () => {
    const dto = toOAuthConnectionDto({ ...base, oauthClient: null } as never);
    expect(dto.client).toEqual({
      clientId: 'cl',
      name: null,
      uri: null,
      icon: null,
      unverified: true,
      host: null,
    });
  });

  it('takes the host from the first redirect, reading loopback as localhost and junk as none', () => {
    const client = (redirectUris: string[], userId: string | null = 'u') =>
      toOAuthConnectionDto({
        ...base,
        oauthClient: { clientId: 'cl', name: 'App', uri: null, icon: null, userId, redirectUris },
      } as never).client;
    expect(client(['https://claude.ai/cb']).host).toBe('claude.ai');
    expect(client(['http://[::1]:5000/cb']).host).toBe('localhost');
    expect(client(['not a url']).host).toBeNull();
    expect(client([]).host).toBeNull();
    expect(client([], 'u').unverified).toBe(false);
    expect(client([], null).unverified).toBe(true);
  });
});

describe('the sweep job', () => {
  it('runs the sweep as one retryable step', async () => {
    const sweep = vi.fn(async () => ({
      refreshTokens: 0,
      accessTokens: 0,
      authorizationCodes: 0,
      clients: 0,
    }));
    const steps: string[] = [];
    const ctx = {
      step: {
        run: async (name: string, fn: () => Promise<unknown>) => {
          steps.push(name);
          return fn();
        },
      },
    };
    await oauthSweep.handler(ctx as never, { oauthSweep: { sweep } } as never);
    expect(steps).toEqual(['sweep-oauth-leftovers']);
    expect(sweep).toHaveBeenCalledOnce();
  });
});
