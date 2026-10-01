import { createHash, randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import type { User } from '@/generated/prisma/client';
import { auth } from '@/lib/auth';
import { GET, POST } from '@/app/api/auth/[...all]/route';
import { mcpResourceUrl } from '@/lib/oauth/config';
import { oauthConnectionsService } from '@/lib/services/oauthConnectionsService';
import { createTestUser, TEST_PASSWORD } from '../fixtures/userFixtures';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';

// The OAuth flow as a client and a person drive it, against the real auth route
// (Story MOTIR-6973 · MOTIR-6982 / MOTIR-6983). Shared by the authorization-server
// suite and the connection suites so each case reads as the step it is testing.
//
// ⚠️ Import this AFTER a suite's `vi.hoisted` env (Better-Auth freezes its rate
// limit config at import) — i.e. with `await import('../helpers/oauthFlow')`.

export const BASE = 'http://localhost:3000';
export const AUTH = `${BASE}/api/auth`;
export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

let ipCounter = 0;
/** A distinct client IP per request, so the shared limiter never couples cases. */
export function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
}

export async function register(redirectUris: string[], ip = freshIp()): Promise<Response> {
  return POST(
    new Request(`${AUTH}/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    }),
  );
}

export async function registeredClientId(redirectUri = CLAUDE_CALLBACK): Promise<string> {
  const res = await register([redirectUri]);
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface AuthorizeParams {
  clientId: string;
  redirectUri?: string;
  challenge?: string | null;
  method?: string | null;
  resource?: string | null;
  scope?: string;
}

export function authorizeUrl(p: AuthorizeParams): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri ?? CLAUDE_CALLBACK,
    state: 'st-123',
  });
  if (p.challenge !== null) q.set('code_challenge', p.challenge ?? pkce().challenge);
  if (p.method !== null) q.set('code_challenge_method', p.method ?? 'S256');
  if (p.resource !== null) q.set('resource', p.resource ?? mcpResourceUrl());
  if (p.scope) q.set('scope', p.scope);
  return `${AUTH}/oauth2/authorize?${q.toString()}`;
}

export async function authorize(p: AuthorizeParams, cookie?: string): Promise<Response> {
  return GET(new Request(authorizeUrl(p), { headers: cookie ? { cookie } : {} }));
}

export function location(res: Response): URL {
  const at = res.headers.get('location');
  expect(at, `expected a redirect, got ${res.status}`).toBeTruthy();
  return new URL(at!, BASE);
}

/** Sign `user` (a fresh one by default) in; return the session cookie. */
export async function signIn(user?: User): Promise<{ cookie: string; user: User }> {
  const person = user ?? (await createTestUser());
  const res = await auth.api.signInEmail({
    body: { email: person.email, password: TEST_PASSWORD },
    headers: new Headers({ origin: BASE }),
    asResponse: true,
  });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return { cookie, user: person };
}

export async function signedInCookie(): Promise<string> {
  return (await signIn()).cookie;
}

export async function token(form: Record<string, string>, ip = freshIp()): Promise<Response> {
  return POST(
    new Request(`${AUTH}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
      body: new URLSearchParams(form).toString(),
    }),
  );
}

/** Authorize as a signed-in person and return the consent page's signed query. */
export async function consentQuery(
  clientId: string,
  cookie: string,
  challenge = pkce().challenge,
): Promise<string> {
  const res = await authorize({ clientId, challenge, scope: 'offline_access' }, cookie);
  const consent = location(res);
  expect(consent.pathname).toBe('/oauth/consent');
  return consent.searchParams.toString();
}

export interface ConnectOptions {
  clientId: string;
  keys?: { verifier: string; challenge: string };
  /** The person; a fresh user with a fresh workspace by default. */
  user?: User;
  /** Defaults to a workspace created for a fresh user. */
  workspaceId?: string;
  projectId?: string | null;
  permissions?: string[];
}

export interface Connected {
  code: string;
  cookie: string;
  user: User;
  workspaceId: string;
  connectionId: string;
}

/** A person approves the consent screen for `clientId` through the service —
 * the path the consent page takes — and the client receives its code. */
export async function connect(opts: ConnectOptions): Promise<Connected> {
  let user = opts.user;
  let workspaceId = opts.workspaceId;
  if (!workspaceId) {
    const created = await createTestWorkspace(user ? { ownerUserId: user.id } : {});
    user = created.owner;
    workspaceId = created.workspace.id;
  }
  const { cookie } = await signIn(user);
  const keys = opts.keys ?? pkce();
  const oauthQuery = await consentQuery(opts.clientId, cookie, keys.challenge);
  const { connectionId, redirectUrl } = await oauthConnectionsService.approveConsent({
    userId: user!.id,
    headers: new Headers({ cookie, origin: BASE }),
    oauthQuery,
    workspaceId,
    projectId: opts.projectId ?? null,
    permissions: opts.permissions,
  });
  const back = new URL(redirectUrl);
  expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CALLBACK);
  expect(back.searchParams.get('state')).toBe('st-123');
  const code = back.searchParams.get('code');
  expect(code).toBeTruthy();
  return { code: code!, cookie, user: user!, workspaceId, connectionId };
}

/** Exchange a code for tokens, bound to the MCP. */
export async function exchange(
  clientId: string,
  code: string,
  verifier: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await token({
    grant_type: 'authorization_code',
    code,
    redirect_uri: CLAUDE_CALLBACK,
    client_id: clientId,
    code_verifier: verifier,
    resource: mcpResourceUrl(),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
}
