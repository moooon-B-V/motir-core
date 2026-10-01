import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Client ID Metadata Documents (Story MOTIR-7170 · Subtask MOTIR-7173) — a client
// that names itself by an HTTPS URL, against the real auth route, the real
// provider and the real database. The ONE thing stubbed is the network: the
// plugin's transport is swapped for a table of canned responses
// (`setClientMetadataTransportForTests`), so no case here ever leaves the box.
// The real transport's own refusal of a non-public address is pinned in
// `tests/oauth/clientMetadataDocument.test.ts`.
vi.hoisted(() => {
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

const { db } = await import('@/lib/db');
const { adminDb } = await import('../../helpers/adminDb');
const { truncateAuthTables } = await import('../../helpers/db');
const { setClientMetadataTransportForTests } = await import('@/lib/oauth/clientMetadataDocument');
const { oauthConnectionsService } = await import('@/lib/services/oauthConnectionsService');
const { mcpResourceUrl } = await import('@/lib/oauth/config');
const wellKnown = await import('@/app/.well-known/oauth-authorization-server/[[...path]]/route');
const {
  BASE,
  CLAUDE_CALLBACK,
  authorize,
  connect,
  exchange,
  location,
  pkce,
  registeredClientId,
  signIn,
  token,
} = await import('../../helpers/oauthFlow');

type Stub = (url: string, init?: RequestInit) => Promise<Response>;
const documents = new Map<string, Stub>();
const fetched: string[] = [];

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** Each case gets its own origin: the plugin paces fetches per client and per
 * origin, and caches a good document, so cases must not share a URL. */
let originCounter = 0;
function freshOrigin(): string {
  originCounter += 1;
  return `https://client-${originCounter}.example`;
}

/** A valid hosted-Claude-shaped document, served at `url`. */
function serveDocument(url: string, over: Record<string, unknown> = {}): void {
  documents.set(url, async () =>
    json({
      client_id: url,
      client_name: 'Claude',
      client_uri: new URL(url).origin,
      redirect_uris: [CLAUDE_CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...over,
    }),
  );
}

beforeEach(async () => {
  await truncateAuthTables();
  documents.clear();
  fetched.length = 0;
  setClientMetadataTransportForTests(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    const stub = documents.get(url);
    if (!stub) throw new TypeError(`no stub for ${url}`);
    return stub(url, init);
  });
});

afterEach(() => {
  setClientMetadataTransportForTests(null);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function refusal(clientId: string): Promise<URL> {
  const { cookie } = await signIn();
  const to = location(await authorize({ clientId, scope: 'offline_access' }, cookie));
  expect(to.pathname).toBe('/oauth/error');
  return to;
}

describe('the authorization-server metadata', () => {
  it('advertises Client ID Metadata Documents beside DCR and public clients', async () => {
    const res = await wellKnown.GET(new Request(`${BASE}/.well-known/oauth-authorization-server`), {
      params: Promise.resolve({}),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['client_id_metadata_document_supported']).toBe(true);
    expect(body['token_endpoint_auth_methods_supported']).toContain('none');
    expect(body['registration_endpoint']).toBeTruthy();
  });
});

describe('a client that names itself by a metadata document', () => {
  it('reaches consent with no registration call, and is recorded as discovered', async () => {
    const clientId = `${freshOrigin()}/oauth/mcp-oauth-client-metadata`;
    serveDocument(clientId);
    const { cookie, user } = await signIn();
    const res = await authorize({ clientId, scope: 'offline_access' }, cookie);
    const consent = location(res);
    expect(consent.pathname).toBe('/oauth/consent');
    expect(fetched).toEqual([clientId]);

    const row = await adminDb.oauthClient.findUniqueOrThrow({ where: { clientId } });
    expect(row.clientDiscoveryId).toBe('cimd');
    expect(row.redirectUris).toEqual([CLAUDE_CALLBACK]);

    const described = await oauthConnectionsService.describeConsentRequest(
      user.id,
      consent.searchParams.toString(),
    );
    expect(described.client.verification).toEqual({
      kind: 'domain',
      host: new URL(clientId).host,
    });
    expect(described.client.name).toBe('Claude');
    // The sign-in hand-off reads the same verification (MOTIR-7174).
    expect(await oauthConnectionsService.clientDisplayName(clientId)).toEqual({
      name: 'Claude',
      verification: { kind: 'domain', host: new URL(clientId).host },
    });
  });

  it('connects, exchanges and refreshes like any public client', async () => {
    const clientId = `${freshOrigin()}/oauth/mcp-oauth-client-metadata`;
    serveDocument(clientId);
    const keys = pkce();
    const c = await connect({ clientId, keys });
    const tokens = await exchange(clientId, c.code, keys.verifier);
    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource: mcpResourceUrl(),
    });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);

    const [connection] = await oauthConnectionsService.listForUser(c.user.id);
    expect(connection!.client.verification).toEqual({
      kind: 'domain',
      host: new URL(clientId).host,
    });
  });

  it('matches a loopback redirect on any port (Claude Code’s document)', async () => {
    const clientId = `${freshOrigin()}/oauth/claude-code-client-metadata`;
    serveDocument(clientId, {
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    });
    const { cookie } = await signIn();
    for (const redirectUri of [
      'http://127.0.0.1:53682/callback',
      'http://localhost:61001/callback',
    ]) {
      const to = location(
        await authorize({ clientId, redirectUri, scope: 'offline_access' }, cookie),
      );
      expect(to.pathname, redirectUri).toBe('/oauth/consent');
    }
  });

  it('still requires the MCP resource, and S256 PKCE', async () => {
    const clientId = `${freshOrigin()}/oauth/mcp-oauth-client-metadata`;
    serveDocument(clientId);
    const { cookie } = await signIn();

    const noResource = location(await authorize({ clientId, resource: null }, cookie));
    expect(`${noResource.origin}${noResource.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(noResource.searchParams.get('error')).toBe('invalid_target');

    const plain = await authorize({ clientId, method: 'plain' }, cookie);
    const at = location(plain);
    expect(at.pathname).not.toBe('/oauth/consent');
  });

  it('a redirect the document does not list is refused on Motir’s page', async () => {
    const clientId = `${freshOrigin()}/oauth/mcp-oauth-client-metadata`;
    serveDocument(clientId);
    const { cookie } = await signIn();
    const to = location(
      await authorize({ clientId, redirectUri: 'https://elsewhere.example/cb' }, cookie),
    );
    expect(to.pathname).toBe('/oauth/error');
    expect(to.searchParams.get('error')).toBe('invalid_redirect');
  });

  it('a DCR client still registers and authorizes beside it', async () => {
    const clientId = await registeredClientId();
    const { cookie } = await signIn();
    expect(location(await authorize({ clientId }, cookie)).pathname).toBe('/oauth/consent');
    expect(fetched).toEqual([]);
  });
});

describe('a document Motir cannot use is refused onto /oauth/error, with a reason', () => {
  async function refusedFor(serve: Stub, clientId = `${freshOrigin()}/meta`) {
    documents.set(clientId, serve);
    const to = await refusal(clientId);
    expect(to.searchParams.get('error')).toBe('client_metadata');
    expect(to.searchParams.get('host')).toBe(new URL(clientId).host);
    expect(await adminDb.oauthClient.count({ where: { clientId } })).toBe(0);
    return to.searchParams.get('detail') ?? '';
  }

  it('unreachable', async () => {
    expect(
      await refusedFor(async () => {
        throw new TypeError('fetch failed');
      }),
    ).toMatch(/Failed to fetch/);
  });

  it('too slow', { timeout: 20_000 }, async () => {
    expect(
      await refusedFor(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    ).toMatch(/timed out/);
  });

  it('over the size cap', async () => {
    expect(
      await refusedFor(async (url) =>
        json({ client_id: url, client_name: 'x'.repeat(10_000), redirect_uris: [CLAUDE_CALLBACK] }),
      ),
    ).toMatch(/size limit/);
  });

  it('a redirect', async () => {
    expect(
      await refusedFor(
        async () =>
          new Response(null, { status: 302, headers: { location: 'https://x.example/' } }),
      ),
    ).toMatch(/HTTP 302/);
  });

  it('not JSON', async () => {
    expect(
      await refusedFor(
        async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      ),
    ).toMatch(/must be JSON/);
  });

  it('an answer at a non-public address (the transport’s refusal)', async () => {
    expect(
      await refusedFor(async () => {
        throw new TypeError('metadata hostname must resolve only to public-routable addresses');
      }),
    ).toMatch(/Failed to fetch/);
  });

  it('a client_id URL naming a private address is never fetched', async () => {
    const clientId = 'https://10.0.0.5/meta';
    const to = await refusal(clientId);
    expect(to.searchParams.get('error')).toBe('client_metadata');
    expect(to.searchParams.get('detail')).toMatch(/private or reserved/);
    expect(fetched).toEqual([]);
  });

  it('a document declaring a different client_id', async () => {
    expect(
      await refusedFor(async () =>
        json({
          client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
          client_name: 'Claude',
          redirect_uris: [CLAUDE_CALLBACK],
          token_endpoint_auth_method: 'none',
        }),
      ),
    ).toMatch(/does not match/);
  });
});
