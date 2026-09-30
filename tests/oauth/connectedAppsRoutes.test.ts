import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Settings → Account → CONNECTED APPS, its two routes (Story MOTIR-6973 ·
// Subtask MOTIR-6986), against the real database and the real provider:
//
//   * GET lists ONLY the caller's connections, newest first, each with the app,
//     the unverified flag, the redirect host, the workspace, the project-or-null,
//     the grant and both dates — and a signed-out call is a 401;
//   * DELETE revokes the caller's connection so the access token it minted stops
//     resolving; another person's id, a PAT's id and a second DELETE are all a
//     404, and none of them logs an error;
//   * the tokens list (`/api/me/api-tokens`) never shows an OAuth-backed row.
//
// The one conventional mock: the routes' compliant-session gate (the test has no
// cookie jar). Everything below it is the real path.
vi.hoisted(() => {
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

const requireCompliantSession = vi.fn();
vi.mock('@/lib/auth/requireCompliantSession', () => ({
  requireCompliantSession: () => requireCompliantSession(),
}));

const { db } = await import('@/lib/db');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { createTestUser } = await import('../fixtures/userFixtures');
const { createTestWorkspace } = await import('../fixtures/workspaceFixtures');
const { oauthConnectionsService } = await import('@/lib/services/oauthConnectionsService');
const { DEFAULT_TOKEN_GRANT } = await import('@/lib/tokens/grant');
const listRoute = await import('@/app/api/account/oauth-connections/route');
const itemRoute = await import('@/app/api/account/oauth-connections/[id]/route');
const tokensRoute = await import('@/app/api/me/api-tokens/route');
const { NextResponse } = await import('next/server');
const { connect, exchange, pkce, registeredClientId } = await import('../helpers/oauthFlow');

type Listed = Awaited<ReturnType<typeof oauthConnectionsService.listForUser>>;

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

function signedInAs(user: { id: string }) {
  requireCompliantSession.mockResolvedValue({ ok: true, session: { user } });
}

function signedOut() {
  requireCompliantSession.mockResolvedValue({
    ok: false,
    response: NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 }),
  });
}

/** A plain PAT row beside the connections — written directly, since only its
 * existence matters here (the create path is `apiTokensService`'s own suite). */
async function personalToken(userId: string, workspaceId: string) {
  return adminDb.apiToken.create({
    data: {
      userId,
      workspaceId,
      label: 'ci',
      tokenHash: `pat-${userId}`,
      tokenPrefix: 'motir_pat',
      scopes: [...DEFAULT_TOKEN_GRANT],
    },
  });
}

async function list(): Promise<{ status: number; connections: Listed }> {
  const res = await listRoute.GET();
  const body = res.status === 200 ? ((await res.json()) as { connections: Listed }) : null;
  return { status: res.status, connections: body?.connections ?? [] };
}

async function revoke(id: string): Promise<Response> {
  return itemRoute.DELETE(new Request(`http://localhost/api/account/oauth-connections/${id}`), {
    params: Promise.resolve({ id }),
  });
}

describe('GET /api/account/oauth-connections', () => {
  it('is a 401 signed out', async () => {
    signedOut();
    expect((await list()).status).toBe(401);
  });

  it("lists only the caller's connections, newest first, with everything a row shows", async () => {
    const clientId = await registeredClientId();
    const first = await connect({ clientId });
    // A second grant for the same person in another workspace: two rows.
    const { workspace: second } = await createTestWorkspace({ ownerUserId: first.user.id });
    const later = await connect({ clientId, user: first.user, workspaceId: second.id });
    // Somebody else's connection must not appear.
    await connect({ clientId });

    signedInAs(first.user);
    const { status, connections } = await list();
    expect(status).toBe(200);
    expect(connections.map((c) => c.id)).toEqual([later.connectionId, first.connectionId]);

    const row = connections[1]!;
    expect(row.client).toMatchObject({
      clientId,
      name: 'Claude',
      // Registered through RFC 7591 by nobody signed in — self-registered.
      unverified: true,
      host: 'claude.ai',
    });
    expect(row.workspace.id).toBe(first.workspaceId);
    expect(row.organization.name).toBeTruthy();
    expect(row.project).toBeNull();
    expect(row.permissions).toEqual([...DEFAULT_TOKEN_GRANT]);
    expect(Date.parse(row.createdAt)).not.toBeNaN();
    expect(row.lastUsedAt).toBeNull();
  });

  it('reads a loopback redirect as localhost', async () => {
    const clientId = await registeredClientId('http://127.0.0.1:53682/callback');
    await adminDb.oauthClient.update({
      where: { clientId },
      data: { redirectUris: ['http://127.0.0.1:53682/callback'] },
    });
    const user = await createTestUser();
    const { workspace } = await createTestWorkspace({ ownerUserId: user.id });
    await adminDb.apiToken.create({
      data: {
        userId: user.id,
        workspaceId: workspace.id,
        oauthClientId: clientId,
        label: 'loopback',
        tokenHash: `h-${clientId}`,
        tokenPrefix: 'oauth',
        scopes: [...DEFAULT_TOKEN_GRANT],
      },
    });
    signedInAs(user);
    const [row] = (await list()).connections;
    expect(row!.client.host).toBe('localhost');
  });
});

describe('DELETE /api/account/oauth-connections/:id', () => {
  it("revokes the caller's connection: the row is gone and its access token stops resolving", async () => {
    const clientId = await registeredClientId();
    const keys = pkce();
    const connected = await connect({ clientId, keys });
    const { access_token } = await exchange(clientId, connected.code, keys.verifier);
    await expect(oauthConnectionsService.resolveAccessToken(access_token)).resolves.toBeTruthy();

    signedInAs(connected.user);
    const res = await revoke(connected.connectionId);
    expect(res.status).toBe(204);
    expect((await list()).connections).toEqual([]);
    await expect(oauthConnectionsService.resolveAccessToken(access_token)).rejects.toThrow();
  });

  it("is a 404, logging nothing, for another person's id, a PAT's id and a second revoke", async () => {
    const errorLog = vi.spyOn(console, 'error');
    const clientId = await registeredClientId();
    const mine = await connect({ clientId });
    const theirs = await connect({ clientId });
    const pat = { token: await personalToken(mine.user.id, mine.workspaceId) };

    signedInAs(mine.user);
    expect((await revoke(theirs.connectionId)).status).toBe(404);
    expect((await revoke(pat.token.id)).status).toBe(404);
    expect((await revoke(mine.connectionId)).status).toBe(204);
    const again = await revoke(mine.connectionId);
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ code: 'OAUTH_CONNECTION_NOT_FOUND' });

    // Neither the other person's connection nor the PAT was touched.
    expect(await adminDb.apiToken.count({ where: { id: theirs.connectionId } })).toBe(1);
    expect(await adminDb.apiToken.count({ where: { id: pat.token.id } })).toBe(1);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('is a 401 signed out, and revokes nothing', async () => {
    const clientId = await registeredClientId();
    const mine = await connect({ clientId });
    signedOut();
    expect((await revoke(mine.connectionId)).status).toBe(401);
    expect(await adminDb.apiToken.count({ where: { id: mine.connectionId } })).toBe(1);
  });
});

describe('the tokens list', () => {
  it('never shows an OAuth-backed row — a connection is listed once, under Connected apps', async () => {
    const clientId = await registeredClientId();
    const mine = await connect({ clientId });
    await personalToken(mine.user.id, mine.workspaceId);
    signedInAs(mine.user);
    const res = await tokensRoute.GET();
    const body = (await res.json()) as { tokens: Array<{ id: string; label: string }> };
    expect(body.tokens.map((t) => t.label)).toEqual(['ci']);
    expect(body.tokens.map((t) => t.id)).not.toContain(mine.connectionId);
  });
});
