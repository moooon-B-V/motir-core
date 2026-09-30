import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';
import { db } from '@/lib/db';
import { GET as protectedResourceGET } from '@/app/.well-known/oauth-protected-resource/[[...path]]/route';
import { GET as authServerGET } from '@/app/.well-known/oauth-authorization-server/[[...path]]/route';
import { authorizationServerIssuer, mcpResourceUrl } from '@/lib/oauth/config';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';

// The two OAuth discovery documents (MOTIR-6982): what they say, where they are
// answered, and that they answer without a session and cross-origin.

const BASE = resolveBaseUrlTrimmed();

afterAll(async () => {
  await db.$disconnect();
});

const params = (path?: string[]) => ({ params: Promise.resolve(path ? { path } : {}) });

describe('/.well-known/oauth-protected-resource (RFC 9728)', () => {
  it.each([[undefined], [['api', 'mcp']]])(
    'answers at %j with the MCP as the resource',
    async (path) => {
      const res = await protectedResourceGET(new Request(`${BASE}/.well-known/x`), params(path));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['resource']).toBe(`${BASE}/api/mcp`);
      expect(body['resource']).toBe(mcpResourceUrl());
      expect(body['authorization_servers']).toEqual([authorizationServerIssuer()]);
      expect(body['bearer_methods_supported']).toEqual(['header']);
      expect(body['scopes_supported']).toContain('offline_access');
    },
  );

  it('404s any other suffix, so a typo is not answered about another resource', async () => {
    for (const path of [['api', 'v1'], ['api'], ['api', 'mcp', 'x']]) {
      const res = await protectedResourceGET(new Request(`${BASE}/x`), params(path));
      expect(res.status, path.join('/')).toBe(404);
    }
  });
});

describe('/.well-known/oauth-authorization-server (RFC 8414)', () => {
  it.each([[undefined], [['api', 'auth']]])('answers at %j', async (path) => {
    const res = await authServerGET(
      new Request(`${BASE}/.well-known/oauth-authorization-server`),
      params(path),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The issuer the protected-resource document names, and the `iss` the
    // provider stamps on every authorization response (RFC 9207).
    expect(body['issuer']).toBe(authorizationServerIssuer());
    expect(body['authorization_endpoint']).toBe(`${BASE}/api/auth/oauth2/authorize`);
    expect(body['token_endpoint']).toBe(`${BASE}/api/auth/oauth2/token`);
    expect(body['registration_endpoint']).toBe(`${BASE}/api/auth/oauth2/register`);
    expect(body['revocation_endpoint']).toBe(`${BASE}/api/auth/oauth2/revoke`);
    expect(body['code_challenge_methods_supported']).toEqual(['S256']);
    expect(body['grant_types_supported']).toEqual(
      expect.arrayContaining(['authorization_code', 'refresh_token']),
    );
    expect(body['grant_types_supported']).not.toContain('client_credentials');
    expect(body['token_endpoint_auth_methods_supported']).toContain('none');
    expect(body['jwks_uri']).toBeUndefined();
  });

  it('404s any other suffix', async () => {
    const res = await authServerGET(new Request(`${BASE}/x`), params(['api', 'mcp']));
    expect(res.status).toBe(404);
  });
});

describe('the proxy answers .well-known without a session, cross-origin', () => {
  const request = (path: string, method = 'GET') =>
    new NextRequest(new URL(path, 'https://app.motir.co'), {
      method,
      headers: { origin: 'https://claude.ai' },
    });

  it.each([
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/api/mcp',
    '/.well-known/oauth-authorization-server',
  ])('forwards %s (no /sign-in bounce) with CORS for any origin', async (path) => {
    const res = await proxy(request(path));
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('answers the preflight itself', async () => {
    const res = await proxy(request('/.well-known/oauth-protected-resource', 'OPTIONS'));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });
});
