import { afterAll, afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PermissionKey } from '@/lib/permissions/catalog';

// THE STORY INTEGRATION GATE for "Sign in with Motir from Claude" (Story
// MOTIR-6973 · Subtask MOTIR-6987), in motir-core.
//
// What is under test is the ASSEMBLED path — an MCP client's first
// unauthenticated request, through discovery, dynamic registration, PKCE,
// consent, the code exchange, tool calls, refresh and revoke — against the real
// Postgres and the real route handlers, with nothing mocked between the layers.
// The client is the MCP SDK's OWN (`StreamableHTTPClientTransport` + its
// `OAuthClientProvider` flow), the code Claude Code is built on, so a server
// change the SDK would not accept fails here rather than in a person's terminal.
//
// Two things stand in for what a test process has no way to be:
//
//   * the NETWORK — the SDK's `fetch` is routed, in process, to the same route
//     modules Next serves (`routeFetch` below), so every request is a real
//     `Request` answered by the real handler;
//   * the BROWSER — the person's half (open the authorize URL signed in, then
//     press Approve) is the authorize GET with their session cookie and a POST to
//     the consent route. The consent route's compliant-session gate is the one
//     conventional mock: this process has no cookie jar for `next/headers`. The
//     provider behind it reads the REAL session from the forwarded cookie.
//
// The browser walk itself — the consent page and Connected apps rendered — is
// the story E2E (MOTIR-6988).
vi.hoisted(() => {
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

const requireCompliantSession = vi.fn();
vi.mock('@/lib/auth/requireCompliantSession', () => ({
  requireCompliantSession: () => requireCompliantSession(),
}));

// The REAL Client ID Metadata Document transport must never run in this lane: a
// metadata-document client is served by the test seam instead. Every call to the
// real one is recorded and fails the test that made it (MOTIR-7175 case 7).
const realCimdCalls = vi.hoisted(() => [] as string[]);
vi.mock('@better-auth/cimd/node', () => ({
  fetchClientMetadataResource: async (url: string) => {
    realCimdCalls.push(url);
    throw new Error(`the real CIMD transport was called in the test lane: ${url}`);
  },
}));

const { db } = await import('@/lib/db');
const { adminDb } = await import('../../helpers/adminDb');
const { truncateAuthTables } = await import('../../helpers/db');
const { createTestUser } = await import('../../fixtures/userFixtures');
const { createTestWorkItem, makeWorkItemFixture } = await import('../../fixtures/workItemFixtures');
const { apiTokensService } = await import('@/lib/services/apiTokensService');
const { oauthConnectionsService } = await import('@/lib/services/oauthConnectionsService');
const { oauthSweepService, OAUTH_CLIENT_UNUSED_DAYS } =
  await import('@/lib/services/oauthSweepService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { verifyMcpToken } = await import('@/lib/mcp/auth');
const { mcpResourceUrl } = await import('@/lib/oauth/config');
const { DEFAULT_TOKEN_GRANT } = await import('@/lib/tokens/grant');
const mcpRoute = await import('@/app/api/mcp/route');
const { trackServerWork } = await import('../../helpers/serverWork');
const authRoute = await import('@/app/api/auth/[...all]/route');
const consentRoute = await import('@/app/api/oauth/consent/route');
const connectionsRoute = await import('@/app/api/account/oauth-connections/[id]/route');
const protectedResource =
  await import('@/app/.well-known/oauth-protected-resource/[[...path]]/route');
const authServerMetadata =
  await import('@/app/.well-known/oauth-authorization-server/[[...path]]/route');
const { BASE, CLAUDE_CALLBACK, authorize, freshIp, location, registeredClientId, signIn } =
  await import('../../helpers/oauthFlow');
const { setClientMetadataTransportForTests } = await import('@/lib/oauth/clientMetadataDocument');

const MCP_URL = `${BASE}/api/mcp`;
const RESOURCE_METADATA = `resource_metadata="${BASE}/.well-known/oauth-protected-resource"`;
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await truncateAuthTables();
  requireCompliantSession.mockReset();
  realCimdCalls.length = 0;
});

afterEach(() => {
  setClientMetadataTransportForTests(null);
  expect(realCimdCalls, 'the real CIMD transport must never run here').toEqual([]);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── the network, in process ────────────────────────────────────────────────

/** Every request the SDK makes, in order — so a test can say what was asked. */
const requests: Array<{ method: string; url: string; status: number }> = [];

/**
 * Answer a request with the route module Next would, so the SDK talks to the
 * real handlers without a server. Registration and token requests carry a fresh
 * client IP, so the app-level per-IP limiter never couples cases.
 */
/**
 * The transport's background GET — the SSE stream it opens, unawaited, once the
 * session is initialised. It carries the bearer too, so a test that expires the
 * token while that GET is still in flight has TWO requests refreshing at once,
 * and the provider's reuse detection then (correctly) deletes the whole refresh
 * family. `connectedClient` settles it before handing the client back.
 */
const backgroundGets = new Set<Promise<Response>>();

function routeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const pending = answer(input, init);
  const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
  if (
    method === 'GET' &&
    new URL(input instanceof Request ? input.url : input).pathname === '/api/mcp'
  ) {
    backgroundGets.add(pending);
    void pending.finally(() => backgroundGets.delete(pending));
  }
  return pending;
}

async function answer(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const path = url.pathname;
  let res: Response;
  if (path === '/api/mcp') {
    // Tracked: the SDK's SSE-stream GET is never awaited by the client (MOTIR-6324).
    const handler =
      req.method === 'GET'
        ? mcpRoute.GET
        : req.method === 'DELETE'
          ? mcpRoute.DELETE
          : mcpRoute.POST;
    res = await trackServerWork(handler(req as never), `${req.method} ${path}`);
  } else if (path.startsWith('/.well-known/oauth-protected-resource')) {
    res = await protectedResource.GET(req, wellKnownParams(path, 'oauth-protected-resource'));
  } else if (path.startsWith('/.well-known/oauth-authorization-server')) {
    res = await authServerMetadata.GET(req, wellKnownParams(path, 'oauth-authorization-server'));
  } else if (path.startsWith('/api/auth/')) {
    const headers = new Headers(req.headers);
    headers.set('x-forwarded-for', freshIp());
    const forwarded = new Request(req, { headers });
    res = req.method === 'GET' ? await authRoute.GET(forwarded) : await authRoute.POST(forwarded);
  } else {
    res = new Response(null, { status: 404 });
  }
  requests.push({ method: req.method, url: `${url.origin}${path}`, status: res.status });
  return res;
}

function wellKnownParams(path: string, doc: string) {
  const rest = path.slice(`/.well-known/${doc}`.length).split('/').filter(Boolean);
  return { params: Promise.resolve(rest.length ? { path: rest } : {}) };
}

// ── the client: the SDK's own OAuth flow, holding its state in memory ─────────

class MemoryOAuthProvider implements OAuthClientProvider {
  client: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  /** Where the SDK sent the person — the authorize URL, PKCE and all. */
  authorizationUrl: URL | undefined;

  get redirectUrl(): string {
    return CLAUDE_CALLBACK;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Claude Code',
      redirect_uris: [CLAUDE_CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state(): string {
    return 'st-sdk';
  }
  clientInformation() {
    return this.client;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.client = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

function transportFor(provider: OAuthClientProvider) {
  return new StreamableHTTPClientTransport(new URL(MCP_URL), {
    authProvider: provider,
    fetch: routeFetch,
  });
}

async function connectedClient(provider: OAuthClientProvider): Promise<Client> {
  const client = new Client({ name: 'motir-oauth-gate', version: '1.0.0' });
  await client.connect(transportFor(provider));
  // The GET starts after the connect resolves, behind an awaited header read:
  // one macrotask lets it reach `fetch`, then it is awaited to its answer.
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.allSettled([...backgroundGets]);
  return client;
}

// ── the person ─────────────────────────────────────────────────────────────

interface Person {
  user: { id: string; email: string };
  cookie: string;
}

/**
 * The person's half of the flow: open the authorize URL the SDK produced while
 * signed in, land on the consent page, and press Approve. Returns the redirect
 * the browser would follow back to the app.
 */
async function approveInBrowser(
  person: Person,
  authorizationUrl: URL,
  choice: { workspaceId: string; projectId?: string | null; permissions?: string[] },
): Promise<URL> {
  const landed = location(
    await authRoute.GET(new Request(authorizationUrl, { headers: { cookie: person.cookie } })),
  );
  expect(landed.pathname).toBe('/oauth/consent');
  requireCompliantSession.mockResolvedValue({ ok: true, session: { user: person.user } });
  const res = await consentRoute.POST(
    new Request(`${BASE}/api/oauth/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: person.cookie, origin: BASE },
      body: JSON.stringify({
        action: 'approve',
        oauthQuery: landed.searchParams.toString(),
        workspaceId: choice.workspaceId,
        projectId: choice.projectId ?? null,
        ...(choice.permissions ? { permissions: choice.permissions } : {}),
      }),
    }),
  );
  expect(res.status, await res.clone().text()).toBe(200);
  return new URL(((await res.json()) as { redirectUrl: string }).redirectUrl);
}

/**
 * The whole journey up to a working client: the SDK is refused, discovers,
 * registers and redirects; the person approves; the SDK exchanges the code.
 */
async function connectThroughSdk(
  person: Person,
  choice: { workspaceId: string; projectId?: string | null; permissions?: string[] },
  provider: MemoryOAuthProvider = new MemoryOAuthProvider(),
) {
  const first = new Client({ name: 'motir-oauth-gate', version: '1.0.0' });
  const transport = transportFor(provider);
  await expect(first.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
  expect(provider.authorizationUrl).toBeDefined();

  const back = await approveInBrowser(person, provider.authorizationUrl!, choice);
  expect(`${back.origin}${back.pathname}`).toBe(provider.redirectUrl);
  expect(back.searchParams.get('state')).toBe('st-sdk');
  await transport.finishAuth(back.searchParams.get('code')!);
  expect(provider.saved?.access_token).toBeTruthy();
  expect(provider.saved?.refresh_token).toBeTruthy();

  const connection = await adminDb.apiToken.findFirstOrThrow({
    where: { userId: person.user.id, oauthClientId: { not: null } },
    orderBy: { createdAt: 'desc' },
  });
  return { provider, client: await connectedClient(provider), connectionId: connection.id };
}

async function personIn(fx: Awaited<ReturnType<typeof makeWorkItemFixture>>): Promise<Person> {
  const { cookie, user } = await signIn(fx.owner);
  return { cookie, user };
}

function textOf(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** A raw MCP request with a bearer — what an app's next call looks like on the wire. */
async function rawMcp(bearer: string): Promise<Response> {
  return trackServerWork(
    mcpRoute.POST(
      new Request(MCP_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    ),
    'POST /api/mcp',
  );
}

function expect401(res: Response) {
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toContain(RESOURCE_METADATA);
}

// ── discovery ──────────────────────────────────────────────────────────────

describe('discovery', () => {
  it('a bare POST /api/mcp is a 401 whose resource_metadata leads to both metadata documents', async () => {
    const res = await routeFetch(MCP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect401(res);
    const pointer = /resource_metadata="([^"]+)"/.exec(res.headers.get('www-authenticate')!)![1]!;

    const prm = await routeFetch(pointer);
    expect(prm.status).toBe(200);
    const resource = (await prm.json()) as { resource: string; authorization_servers: string[] };
    expect(resource.resource).toBe(mcpResourceUrl());

    const issuer = new URL(resource.authorization_servers[0]!);
    const asm = await routeFetch(
      `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`,
    );
    expect(asm.status).toBe(200);
    const meta = (await asm.json()) as Record<string, unknown>;
    expect(meta['registration_endpoint']).toBeTruthy();
    expect(meta['code_challenge_methods_supported']).toEqual(['S256']);
  });
});

// ── the full flow, with the SDK's own client ─────────────────────────────────

describe('the MCP SDK client, end to end', () => {
  it('registers, authorizes with PKCE S256 and the MCP as resource, and calls a tool in the chosen workspace', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Wire OAuth' });
    const person = await personIn(fx);
    requests.length = 0;

    const { provider, client } = await connectThroughSdk(person, { workspaceId: fx.workspaceId });

    const asked = requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);
    // It followed the 401's resource_metadata pointer, then the issuer's
    // path-inserted metadata, then registered itself — nobody handed it a client id.
    expect(asked.slice(0, 4)).toEqual([
      'POST /api/mcp',
      'GET /.well-known/oauth-protected-resource',
      'GET /.well-known/oauth-authorization-server/api/auth',
      'POST /api/auth/oauth2/register',
    ]);
    expect(asked).toContain('POST /api/auth/oauth2/token');
    expect(provider.client?.client_id).toBeTruthy();

    // What it asked for is what the server insists on; drop either and the
    // request never reaches consent (the refusals block below).
    const url = provider.authorizationUrl!;
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('resource')).toBe(mcpResourceUrl());

    const result = await callTool(client, 'get_work_item', {
      key: `${fx.projectIdentifier}-${item.key}`,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Wire OAuth');
    await client.close();
  });

  it('an EXPIRED access token is refreshed by the client, and the next call succeeds', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Refresh me' });
    const { provider, client } = await connectThroughSdk(await personIn(fx), {
      workspaceId: fx.workspaceId,
    });
    const before = provider.saved!.access_token;

    await adminDb.oauthAccessToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect401(await rawMcp(before));

    const result = await callTool(client, 'get_work_item', {
      key: `${fx.projectIdentifier}-${item.key}`,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Refresh me');
    expect(provider.saved!.access_token).not.toBe(before);
    await client.close();
  });

  it('Revoke in Connected apps: the next tools/call is a 401 carrying resource_metadata', async () => {
    const fx = await makeWorkItemFixture();
    const person = await personIn(fx);
    const { provider, client, connectionId } = await connectThroughSdk(person, {
      workspaceId: fx.workspaceId,
    });
    const token = provider.saved!.access_token;
    expect((await rawMcp(token)).status).toBe(200);

    requireCompliantSession.mockResolvedValue({ ok: true, session: { user: person.user } });
    const revoked = await connectionsRoute.DELETE(
      new Request(`${BASE}/api/account/oauth-connections/${connectionId}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: connectionId }) },
    );
    expect(revoked.status).toBe(204);

    expect401(await rawMcp(token));
    // The refresh token went with the grant, so the client cannot quietly recover:
    // its refresh is refused, and it holds no new token.
    await expect(callTool(client, 'whoami', {})).rejects.toThrow();
    expect(provider.saved!.access_token).toBe(token);
    expect(await adminDb.oauthRefreshToken.count()).toBe(0);
    await client.close();
  });

  it('removing the person from the workspace makes the next call a 401', async () => {
    const fx = await makeWorkItemFixture();
    const member = await createTestUser();
    await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
    const { cookie } = await signIn(member);
    const { provider, client } = await connectThroughSdk(
      { user: member, cookie },
      { workspaceId: fx.workspaceId },
    );
    expect((await rawMcp(provider.saved!.access_token)).status).toBe(200);

    await workspacesService.removeMember({
      actorUserId: fx.ownerId,
      targetUserId: member.id,
      workspaceId: fx.workspaceId,
    });
    expect401(await rawMcp(provider.saved!.access_token));
    await client.close();
  });
});

// ── a client identified by its metadata document (Story MOTIR-7170 · MOTIR-7175) ──

/** Claude Code's own shape: a `client_id` that is an HTTPS URL, and a loopback
 * redirect on whatever port it listens on. */
class MetadataDocumentProvider extends MemoryOAuthProvider {
  constructor(readonly clientMetadataUrl: string) {
    super();
  }
  override get redirectUrl(): string {
    return 'http://127.0.0.1:53682/callback';
  }
  override get clientMetadata(): OAuthClientMetadata {
    return { ...super.clientMetadata, redirect_uris: [this.redirectUrl] };
  }
}

/** Serve a document at `url` through the transport seam, as Anthropic publishes
 * Claude Code's: loopback redirects matched on any port. */
function serveDocument(url: string, clientName: string): string[] {
  const fetched: string[] = [];
  setClientMetadataTransportForTests(async (input) => {
    const at = String(input instanceof Request ? input.url : input);
    fetched.push(at);
    if (at !== url) throw new TypeError(`no document at ${at}`);
    return new Response(
      JSON.stringify({
        client_id: url,
        client_name: clientName,
        redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return fetched;
}

describe('a client identified by a Client ID Metadata Document', () => {
  it('discovers, authorizes, calls a tool, refreshes and is revoked — and never registers', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Found by its document' });
    const person = await personIn(fx);
    const clientId = 'https://claude.ai/oauth/claude-code-client-metadata';
    const fetched = serveDocument(clientId, 'Claude Code');
    const provider = new MetadataDocumentProvider(clientId);
    requests.length = 0;

    const { client, connectionId } = await connectThroughSdk(
      person,
      { workspaceId: fx.workspaceId },
      provider,
    );

    const asked = requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);
    // The SDK read the advertised flag and named itself by its URL instead of
    // registering — no /oauth2/register call anywhere in the journey.
    expect(asked.slice(0, 3)).toEqual([
      'POST /api/mcp',
      'GET /.well-known/oauth-protected-resource',
      'GET /.well-known/oauth-authorization-server/api/auth',
    ]);
    expect(asked).not.toContain('POST /api/auth/oauth2/register');
    expect(provider.authorizationUrl!.searchParams.get('client_id')).toBe(clientId);
    expect(provider.authorizationUrl!.searchParams.get('code_challenge_method')).toBe('S256');
    expect(provider.authorizationUrl!.searchParams.get('resource')).toBe(mcpResourceUrl());
    expect(fetched).toContain(clientId);

    const row = await adminDb.oauthClient.findUniqueOrThrow({ where: { clientId } });
    expect(row.clientDiscoveryId).toBe('cimd');
    expect(row.userId).toBeNull();

    // case 3 — the verification it yields
    const [connection] = await oauthConnectionsService.listForUser(person.user.id);
    expect(connection!.client.verification).toEqual({ kind: 'domain', host: 'claude.ai' });
    expect(connection!.client.name).toBe('Claude Code');

    const result = await callTool(client, 'get_work_item', {
      key: `${fx.projectIdentifier}-${item.key}`,
    });
    expect(textOf(result)).toContain('Found by its document');

    // refresh
    const before = provider.saved!.access_token;
    await adminDb.oauthAccessToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await callTool(client, 'whoami', {})).isError).toBeFalsy();
    expect(provider.saved!.access_token).not.toBe(before);

    // revoke
    requireCompliantSession.mockResolvedValue({ ok: true, session: { user: person.user } });
    const revoked = await connectionsRoute.DELETE(
      new Request(`${BASE}/api/account/oauth-connections/${connectionId}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: connectionId }) },
    );
    expect(revoked.status).toBe(204);
    expect401(await rawMcp(provider.saved!.access_token));
    await client.close();
  });

  it('a document naming itself “Claude” on another host is verified as THAT host', async () => {
    const fx = await makeWorkItemFixture();
    const person = await personIn(fx);
    const clientId = 'https://claude-connector.example/oauth/client';
    serveDocument(clientId, 'Claude');
    const { client } = await connectThroughSdk(
      person,
      { workspaceId: fx.workspaceId },
      new MetadataDocumentProvider(clientId),
    );
    const [connection] = await oauthConnectionsService.listForUser(person.user.id);
    expect(connection!.client.verification).toEqual({
      kind: 'domain',
      host: 'claude-connector.example',
    });
    expect(connection!.client.name).toBe('Claude');
    await client.close();
  });

  it('a DCR client beside it still registers, and reads as self-registered', async () => {
    const fx = await makeWorkItemFixture();
    const person = await personIn(fx);
    requests.length = 0;
    const { client } = await connectThroughSdk(person, { workspaceId: fx.workspaceId });
    expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toContain(
      'POST /api/auth/oauth2/register',
    );
    const [connection] = await oauthConnectionsService.listForUser(person.user.id);
    expect(connection!.client.verification).toEqual({ kind: 'self' });
    await client.close();
  });
});

// ── the grant: narrowing, isolation, parity with a PAT ──────────────────────

describe('the grant', () => {
  it('a one-project connection with a narrowed grant is refused a tool outside it, as a narrowed PAT is', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Narrow' });
    const narrow: PermissionKey[] = ['project:browse'];
    const { client } = await connectThroughSdk(await personIn(fx), {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      permissions: narrow,
    });
    const { token: pat } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'narrow',
      projectId: fx.projectId,
      permissions: narrow,
    });
    const patClient = await patConnected(pat);

    const call = { key: `${fx.projectIdentifier}-${item.key}`, title: 'renamed' };
    const viaOAuth = await callTool(client, 'update_work_item', call);
    const viaPat = await callTool(patClient, 'update_work_item', call);
    expect(viaOAuth.isError).toBe(true);
    expect(textOf(viaOAuth)).toContain('work_item:edit');
    expect(textOf(viaOAuth)).toBe(textOf(viaPat));
    await client.close();
    await patClient.close();
  });

  it('an item in another workspace is answered exactly as a missing one — 404, not 403', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    const foreign = await createTestWorkItem(other, { kind: 'task', title: 'Not yours' });
    const { client } = await connectThroughSdk(await personIn(fx), { workspaceId: fx.workspaceId });

    const foreignKey = `${other.projectIdentifier}-${foreign.key}`;
    const missingKey = `${other.projectIdentifier}-999999`;
    const probe = await callTool(client, 'get_work_item', { key: foreignKey });
    const missing = await callTool(client, 'get_work_item', { key: missingKey });
    expect(probe.isError).toBe(true);
    expect(textOf(probe)).not.toContain('Not yours');
    expect(textOf(probe).replaceAll(foreignKey, 'KEY')).toBe(
      textOf(missing).replaceAll(missingKey, 'KEY'),
    );
    await client.close();
  });

  it('PAT parity: the same tools/call sequence answers byte-identically for the same grant', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Parity' });
    const grant: PermissionKey[] = [...DEFAULT_TOKEN_GRANT];
    const { client } = await connectThroughSdk(await personIn(fx), {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      permissions: grant,
    });
    const { token: pat } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'parity',
      projectId: fx.projectId,
      permissions: grant,
    });
    const patClient = await patConnected(pat);

    const key = `${fx.projectIdentifier}-${item.key}`;
    const sequence: Array<[string, Record<string, unknown>]> = [
      ['get_work_item', { key }],
      ['delete_work_item', { key }],
      ['search_work_items', { projectKey: fx.projectIdentifier, query: 'Parity' }],
    ];
    for (const [name, args] of sequence) {
      const viaOAuth = await callTool(client, name, args);
      const viaPat = await callTool(patClient, name, args);
      expect(JSON.stringify(viaOAuth), name).toBe(JSON.stringify(viaPat));
    }
    const [oauthTools, patTools] = await Promise.all([client.listTools(), patClient.listTools()]);
    expect(JSON.stringify(oauthTools)).toBe(JSON.stringify(patTools));
    await client.close();
    await patClient.close();
  });
});

async function patConnected(pat: string): Promise<Client> {
  const client = new Client({ name: 'motir-pat-parity', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: routeFetch,
      requestInit: { headers: { authorization: `Bearer ${pat}` } },
    }),
  );
  return client;
}

// ── refusals before consent ─────────────────────────────────────────────────

describe('refused before consent', () => {
  it.each([
    ['plain PKCE', { method: 'plain' }],
    ['no PKCE at all', { challenge: null, method: null }],
    ['a resource other than the MCP', { resource: `${BASE}/api/v1` }],
    ['no resource', { resource: null }],
    ['an unregistered redirect', { redirectUri: 'https://evil.example/callback' }],
  ] as const)('%s never reaches the consent page', async (_label, change) => {
    const clientId = await registeredClientId();
    const { cookie } = await signIn();
    const res = await authorize({ clientId, scope: 'offline_access', ...change }, cookie);
    // Refused either in place (a 4xx) or by a redirect that is not the consent page.
    if (res.status >= 300 && res.status < 400) {
      expect(location(res).pathname).not.toBe('/oauth/consent');
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect(await adminDb.oauthConsent.count()).toBe(0);
  });
});

// ── the sweep seam ─────────────────────────────────────────────────────────

describe('revoke, then the sweep', () => {
  it('leaves no token behind, and keeps the client only while another connection uses it', async () => {
    const a = await makeWorkItemFixture();
    const b = await makeWorkItemFixture({ name: 'Beta', identifier: 'BETA' });
    const first = await connectThroughSdk(await personIn(a), { workspaceId: a.workspaceId });
    const clientId = (first.provider.client as { client_id: string }).client_id;

    // A second person connects the SAME registered app.
    const second = new MemoryOAuthProvider();
    second.client = first.provider.client;
    const secondTransport = transportFor(second);
    await expect(
      new Client({ name: 'second', version: '1.0.0' }).connect(secondTransport),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    const back = await approveInBrowser(await personIn(b), second.authorizationUrl!, {
      workspaceId: b.workspaceId,
    });
    await secondTransport.finishAuth(back.searchParams.get('code')!);
    const secondConnection = await adminDb.apiToken.findFirstOrThrow({
      where: { userId: b.ownerId, oauthClientId: clientId },
    });

    await oauthConnectionsService.revoke(a.ownerId, first.connectionId);
    const later = new Date(Date.now() + (OAUTH_CLIENT_UNUSED_DAYS + 1) * DAY_MS);
    await oauthSweepService.sweep(later);
    expect(
      await adminDb.oauthAccessToken.count({ where: { referenceId: first.connectionId } }),
    ).toBe(0);
    expect(
      await adminDb.oauthRefreshToken.count({ where: { referenceId: first.connectionId } }),
    ).toBe(0);
    expect(await adminDb.oauthClient.count({ where: { clientId } })).toBe(1);

    await oauthConnectionsService.revoke(b.ownerId, secondConnection.id);
    await oauthSweepService.sweep(later);
    expect(await adminDb.oauthClient.count({ where: { clientId } })).toBe(0);
    await first.client.close();
  });
});

// ── guards ─────────────────────────────────────────────────────────────────

describe('guards', () => {
  it('both bearers resolve to ONE AuthInfo.extra shape', async () => {
    type PatResolved = Awaited<ReturnType<typeof apiTokensService.verify>>;
    type OAuthResolved = Awaited<ReturnType<typeof oauthConnectionsService.resolveAccessToken>>;
    expectTypeOf<Pick<OAuthResolved, 'workspaceId' | 'projectId' | 'grant'>>().toEqualTypeOf<
      Pick<PatResolved, 'workspaceId' | 'projectId' | 'grant'>
    >();
    expectTypeOf<OAuthResolved['user']['id']>().toEqualTypeOf<PatResolved['user']['id']>();
    expectTypeOf<OAuthResolved['user']['name']>().toEqualTypeOf<PatResolved['user']['name']>();

    const fx = await makeWorkItemFixture();
    const grant: PermissionKey[] = ['project:browse'];
    const { provider, client } = await connectThroughSdk(await personIn(fx), {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      permissions: grant,
    });
    const { token: pat } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'shape',
      projectId: fx.projectId,
      permissions: grant,
    });
    const viaOAuth = await verifyMcpToken(new Request(MCP_URL), provider.saved!.access_token);
    const viaPat = await verifyMcpToken(new Request(MCP_URL), pat);
    expect(Object.keys(viaOAuth!.extra!).sort()).toEqual(Object.keys(viaPat!.extra!).sort());
    expect(viaOAuth!.extra).toEqual(viaPat!.extra);
    await client.close();
  });

  it('no module but oauthConnectionsService writes a connection row', () => {
    const root = join(__dirname, '../../..');
    const writers: string[] = [];
    for (const dir of ['lib', 'app', 'components']) {
      for (const file of sourceFiles(join(root, dir))) {
        const rel = relative(root, file);
        if (rel === 'lib/repositories/apiTokenRepository.ts') continue;
        const text = readFileSync(file, 'utf8');
        if (/upsertOAuthConnection\s*\(/.test(text) || /INSERT INTO\s+"api_token"/i.test(text)) {
          writers.push(rel);
        }
      }
    }
    expect(writers).toEqual(['lib/services/oauthConnectionsService.ts']);
  });
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}
