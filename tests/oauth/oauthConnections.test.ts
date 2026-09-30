import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// A connection IS a grant (Story MOTIR-6973 · Subtask MOTIR-6983), against the
// real database and the real routes:
//
//   * `approveConsent` records the connection (person, client, workspace,
//     project-or-none, grant) under the token's one-arm rule, and refuses what the
//     create-token path refuses;
//   * an OAuth access token resolves to that connection and reaches the MCP as
//     the SAME actor a PAT with that grant would be — same tools, same denials;
//   * every refusal is a 401 carrying `resource_metadata`, before any tool runs;
//   * `revoke` deletes the connection and everything minted from it;
//   * two approvals racing leave ONE connection.
//
// Better-Auth's own limiter is off, as in every auth suite (hoisted before the
// auth module freezes its config).
vi.hoisted(() => {
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

const { db } = await import('@/lib/db');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { makeWorkItemFixture } = await import('../fixtures/workItemFixtures');
const { createTestUser } = await import('../fixtures/userFixtures');
const { createTestWorkspace } = await import('../fixtures/workspaceFixtures');
const { oauthConnectionsService } = await import('@/lib/services/oauthConnectionsService');
const { apiTokensService } = await import('@/lib/services/apiTokensService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { verifyMcpToken } = await import('@/lib/mcp/auth');
const mcpRoute = await import('@/app/api/mcp/route');
const { trackServerWork } = await import('../helpers/serverWork');
const { DEFAULT_TOKEN_GRANT, GRANTABLE_PERMISSIONS } = await import('@/lib/tokens/grant');
const { PERMISSIONS } = await import('@/lib/permissions/catalog');
const { InvalidTokenGrantError } = await import('@/lib/apiTokens/errors');
const { WorkspaceNotFoundError } = await import('@/lib/workspaces/errors');
const { OAuthConnectionNotFoundError, OAuthConsentRequestInvalidError } =
  await import('@/lib/oauth/errors');
const { BASE, connect, consentQuery, exchange, pkce, registeredClientId, signIn } =
  await import('../helpers/oauthFlow');

const RESOURCE_METADATA = `resource_metadata="${BASE}/.well-known/oauth-protected-resource"`;

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── helpers ────────────────────────────────────────────────────────────────

async function connectionsOf(userId: string) {
  return adminDb.apiToken.findMany({ where: { userId, oauthClientId: { not: null } } });
}

/** Connect `clientId` for the fixture's owner and hand back a live access token. */
async function connectedToken(opts: Parameters<typeof connect>[0]) {
  const keys = pkce();
  const connected = await connect({ ...opts, keys });
  const tokens = await exchange(opts.clientId, connected.code, keys.verifier);
  return { ...connected, ...tokens };
}

let rpcId = 0;
async function mcpCall(
  bearer: string | undefined,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Response> {
  rpcId += 1;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (bearer) headers['authorization'] = `Bearer ${bearer}`;
  return trackServerWork(
    mcpRoute.POST(
      new Request(`${BASE}/api/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
      }),
    ),
    'POST /api/mcp',
  );
}

/** The JSON-RPC result of a `tools/call`, whether answered as JSON or as SSE. */
async function toolResult(res: Response): Promise<CallToolResult> {
  const text = await res.text();
  const json = text.trimStart().startsWith('{')
    ? text
    : text
        .split('\n')
        .find((line) => line.startsWith('data: '))!
        .slice('data: '.length);
  return (JSON.parse(json) as { result: CallToolResult }).result;
}

function textOf(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

async function expect401(res: Response): Promise<void> {
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toContain(RESOURCE_METADATA);
}

// ── approveConsent ─────────────────────────────────────────────────────────

describe('approveConsent', () => {
  it('records a workspace-wide connection with DEFAULT_TOKEN_GRANT, whatever the request asked', async () => {
    const clientId = await registeredClientId();
    const { user, workspaceId, connectionId } = await connect({
      clientId,
      permissions: ['work_item:delete'],
    });
    const [row] = await connectionsOf(user.id);
    expect(row!.id).toBe(connectionId);
    expect(row!.oauthClientId).toBe(clientId);
    expect(row!.workspaceId).toBe(workspaceId);
    expect(row!.projectId).toBeNull();
    const [dto] = await oauthConnectionsService.listForUser(user.id);
    expect(dto!.permissions).toEqual([...DEFAULT_TOKEN_GRANT]);
    expect(dto!.permissions).not.toContain('work_item:delete');
    expect(dto!.client).toMatchObject({ clientId, name: 'Claude' });
    // The consent row and the code both carry the connection.
    expect((await adminDb.oauthConsent.findFirstOrThrow()).referenceId).toBe(connectionId);
  });

  it('refuses a workspace the person is not in with a 404 (not a 403), and records nothing', async () => {
    const clientId = await registeredClientId();
    const { workspace: elsewhere } = await createTestWorkspace();
    const { user: stranger, cookie } = await signIn(await createTestUser());
    await expect(
      oauthConnectionsService.approveConsent({
        userId: stranger.id,
        headers: new Headers({ cookie }),
        oauthQuery: await consentQuery(clientId, cookie),
        workspaceId: elsewhere.id,
      }),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    expect(await connectionsOf(stranger.id)).toHaveLength(0);
  });

  it('refuses a project grant outside grantableFor(held) with the create-token error', async () => {
    const fx = await makeWorkItemFixture();
    const clientId = await registeredClientId();
    const notGrantable = PERMISSIONS.find((key) => !GRANTABLE_PERMISSIONS.includes(key))!;
    const attempt = connect({
      clientId,
      user: fx.owner,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      permissions: ['project:browse', notGrantable],
    });
    await expect(attempt).rejects.toBeInstanceOf(InvalidTokenGrantError);
    // The PAT create path refuses the same request with the same error.
    await expect(
      apiTokensService.create(fx.ownerId, fx.workspaceId, {
        label: 'same',
        projectId: fx.projectId,
        permissions: ['project:browse', notGrantable],
      }),
    ).rejects.toBeInstanceOf(InvalidTokenGrantError);
    expect(await connectionsOf(fx.ownerId)).toHaveLength(0);
  });

  it('records a CHOSEN project grant, bound to that project', async () => {
    const fx = await makeWorkItemFixture();
    const clientId = await registeredClientId();
    await connect({
      clientId,
      user: fx.owner,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      permissions: ['project:browse'],
    });
    const [dto] = await oauthConnectionsService.listForUser(fx.ownerId);
    expect(dto!.project?.id).toBe(fx.projectId);
    expect(dto!.permissions).toEqual(['project:browse']);
  });

  it('refuses a consent request Motir did not sign, and records nothing', async () => {
    const clientId = await registeredClientId();
    const { workspace, owner } = await createTestWorkspace();
    const { cookie } = await signIn(owner);
    const signed = new URLSearchParams(await consentQuery(clientId, cookie));
    signed.set('redirect_uri', 'https://attacker.example/cb');
    await expect(
      oauthConnectionsService.approveConsent({
        userId: owner.id,
        headers: new Headers({ cookie }),
        oauthQuery: signed.toString(),
        workspaceId: workspace.id,
      }),
    ).rejects.toBeInstanceOf(OAuthConsentRequestInvalidError);
    expect(await connectionsOf(owner.id)).toHaveLength(0);
  });

  it('approving the same app for the same place again keeps ONE connection and replaces its grant', async () => {
    const fx = await makeWorkItemFixture();
    const clientId = await registeredClientId();
    const place = {
      clientId,
      user: fx.owner,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    };
    const first = await connect({ ...place, permissions: ['project:browse'] });
    const second = await connect({ ...place, permissions: ['project:browse', 'work_item:edit'] });
    expect(second.connectionId).toBe(first.connectionId);
    const rows = await connectionsOf(fx.ownerId);
    expect(rows).toHaveLength(1);
    const [dto] = await oauthConnectionsService.listForUser(fx.ownerId);
    expect(dto!.permissions).toEqual(expect.arrayContaining(['project:browse', 'work_item:edit']));
  });

  it('two SIMULTANEOUS approvals for one (person, client, workspace, project) leave exactly one connection', async () => {
    const clientId = await registeredClientId();
    const { workspace, owner } = await createTestWorkspace();
    const { cookie } = await signIn(owner);
    const [a, b] = await Promise.all([
      consentQuery(clientId, cookie),
      consentQuery(clientId, cookie),
    ]);
    const approve = (oauthQuery: string) =>
      oauthConnectionsService.approveConsent({
        userId: owner.id,
        headers: new Headers({ cookie }),
        oauthQuery,
        workspaceId: workspace.id,
      });
    const results = await Promise.all([approve(a), approve(b)]);
    // Either writer may win; both come back with the winner's row.
    expect(results[0].connectionId).toBe(results[1].connectionId);
    expect(await connectionsOf(owner.id)).toHaveLength(1);
  });
});

// ── the MCP gate ───────────────────────────────────────────────────────────

describe('an OAuth access token at the MCP', () => {
  it('resolves to the consenting person, the connection’s workspace and grant, and advances lastUsedAt', async () => {
    const clientId = await registeredClientId();
    const c = await connectedToken({ clientId });
    const info = await verifyMcpToken(new Request(`${BASE}/api/mcp`), c.access_token);
    expect(info?.extra).toMatchObject({
      userId: c.user.id,
      workspaceId: c.workspaceId,
      projectId: null,
      grant: [...DEFAULT_TOKEN_GRANT],
    });
    expect(info?.expiresAt).toBeGreaterThan(Date.now() / 1000);
    const row = await adminDb.apiToken.findUniqueOrThrow({ where: { id: c.connectionId } });
    expect(row.lastUsedAt).not.toBeNull();
  });

  it('runs a tool as the consenting person, in the connection’s workspace', async () => {
    const clientId = await registeredClientId();
    const c = await connectedToken({ clientId });
    const res = await mcpCall(c.access_token, 'tools/call', { name: 'whoami', arguments: {} });
    expect(res.status).toBe(200);
    const result = await toolResult(res);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain(c.user.email);
    const workspace = await adminDb.workspace.findUniqueOrThrow({ where: { id: c.workspaceId } });
    expect(textOf(result)).toContain(workspace.name);
  });

  it('refuses a tool outside the grant with the SAME error a narrowed PAT gets', async () => {
    const fx = await makeWorkItemFixture();
    const clientId = await registeredClientId();
    const c = await connectedToken({
      clientId,
      user: fx.owner,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      permissions: ['project:browse'],
    });
    const { token: pat } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'narrow',
      projectId: fx.projectId,
      permissions: ['project:browse'],
    });
    const call = {
      name: 'update_work_item',
      arguments: { key: `${fx.projectIdentifier}-1`, title: 'x' },
    };
    const viaOAuth = await toolResult(await mcpCall(c.access_token, 'tools/call', call));
    const viaPat = await toolResult(await mcpCall(pat, 'tools/call', call));
    expect(viaOAuth.isError).toBe(true);
    expect(textOf(viaOAuth)).toContain('work_item:edit');
    expect(textOf(viaOAuth)).toBe(textOf(viaPat));
  });

  it('answers 401 with resource_metadata when there is no bearer, or one nobody issued', async () => {
    await expect401(await mcpCall(undefined, 'tools/list'));
    await expect401(await mcpCall('not-a-token-anyone-issued', 'tools/list'));
  });

  it('refuses an EXPIRED token with 401', async () => {
    const clientId = await registeredClientId();
    const c = await connectedToken({ clientId });
    await adminDb.oauthAccessToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect401(await mcpCall(c.access_token, 'tools/list'));
  });

  it('refuses a token that carries no connection — one minted outside the consent screen', async () => {
    const clientId = await registeredClientId();
    const c = await connectedToken({ clientId });
    // Detach it: the shape a token minted for anything but a Motir consent has.
    await adminDb.oauthAccessToken.updateMany({ data: { referenceId: null } });
    await expect401(await mcpCall(c.access_token, 'tools/list'));
  });

  it('refuses a token whose person has LEFT the workspace', async () => {
    const fx = await makeWorkItemFixture();
    const member = await createTestUser();
    await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
    const clientId = await registeredClientId();
    const c = await connectedToken({ clientId, user: member, workspaceId: fx.workspaceId });
    expect((await mcpCall(c.access_token, 'tools/list')).status).toBe(200);
    await adminDb.workspaceMembership.deleteMany({ where: { userId: member.id } });
    await adminDb.organizationMembership.deleteMany({ where: { userId: member.id } });
    await expect401(await mcpCall(c.access_token, 'tools/list'));
  });

  it('refuses a REVOKED connection’s token with 401', async () => {
    const clientId = await registeredClientId();
    const c = await connectedToken({ clientId });
    expect((await mcpCall(c.access_token, 'tools/list')).status).toBe(200);
    await oauthConnectionsService.revoke(c.user.id, c.connectionId);
    await expect401(await mcpCall(c.access_token, 'tools/list'));
  });

  it('never lets a connection’s row answer the PAT door, nor appear in the PAT list', async () => {
    const clientId = await registeredClientId();
    const c = await connectedToken({ clientId });
    await expect401(await mcpCall(`motir_pat_${c.access_token}`, 'tools/list'));
    expect(await apiTokensService.listForUser(c.user.id)).toEqual([]);
  });
});

// ── revoke ─────────────────────────────────────────────────────────────────

describe('revoke', () => {
  it('deletes the connection and every token and consent minted from it, in one step', async () => {
    const clientId = await registeredClientId();
    const c = await connectedToken({ clientId });
    expect(await adminDb.oauthAccessToken.count()).toBe(1);
    expect(await adminDb.oauthRefreshToken.count()).toBe(1);
    await oauthConnectionsService.revoke(c.user.id, c.connectionId);
    expect(await connectionsOf(c.user.id)).toHaveLength(0);
    expect(await adminDb.oauthAccessToken.count()).toBe(0);
    expect(await adminDb.oauthRefreshToken.count()).toBe(0);
    expect(await adminDb.oauthConsent.count()).toBe(0);
    expect(await oauthConnectionsService.listForUser(c.user.id)).toEqual([]);
  });

  it('refuses (404) a connection that is not the caller’s, and a PAT’s id', async () => {
    const clientId = await registeredClientId();
    const c = await connectedToken({ clientId });
    const other = await createTestUser();
    await expect(oauthConnectionsService.revoke(other.id, c.connectionId)).rejects.toBeInstanceOf(
      OAuthConnectionNotFoundError,
    );
    const { dto } = await apiTokensService.create(c.user.id, c.workspaceId, {
      label: 'pat',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    await expect(oauthConnectionsService.revoke(c.user.id, dto.id)).rejects.toBeInstanceOf(
      OAuthConnectionNotFoundError,
    );
    expect(await connectionsOf(c.user.id)).toHaveLength(1);
  });
});
