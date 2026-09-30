import { createHash, randomBytes } from 'node:crypto';
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { adminDb } from './db-reset';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';

// Seed + app-side helpers for the "Sign in with Motir from Claude" E2E (Story
// MOTIR-6973 · Subtask MOTIR-6988).
//
// TWO SIDES, TWO TRANSPORTS — the same split `cli-connect-seed.ts` keeps, for the
// same reason. The BROWSER (`page`) is the person: signed in, reading the consent
// screen, pressing Approve. The APP is a cookie-less `APIRequestContext`, because
// that is what an MCP client is — a process that registers itself, holds a PKCE
// verifier and later a bearer, and never sees the person's session. A spec that
// registered or exchanged through the page's context would prove the browser can
// finish its own grant, which is not the claim.
//
// The app's redirect is a LOOPBACK listener (Claude Code's shape). The spec
// answers it with `page.route`, so the browser's arrival there — with `code` and
// `state` — is the authoritative signal that consent finished.

export const OAUTH_CONNECT_PASSWORD = 'oauth-connect-e2e-pass-123';
export const APP_NAME = 'Claude Code';
export const CALLBACK = 'http://127.0.0.1:53999/callback';

/**
 * The origin the running lane's server bound to, read from the lane's own
 * `use.baseURL`. The main lane serves on 3000 and the acceptance lane on 3200,
 * and the RESOURCE the app asks for must be that exact origin's `/api/mcp`, so a
 * hard-coded port would be wrong in one lane or the other.
 */
export function baseUrl(): string {
  const url = test.info().project.use.baseURL;
  if (!url) throw new Error('the Playwright project has no baseURL');
  return url.replace(/\/$/, '');
}

export interface OAuthConnectSeed {
  email: string;
  password: string;
  userId: string;
  /** `org · workspace`, as the consent picker labels it. */
  homeLabel: string;
  homeWorkspaceName: string;
  homeProjectKey: string;
  /** The SECOND workspace — the one the recording approves into. */
  targetLabel: string;
  targetWorkspaceName: string;
  targetProjectKey: string;
  targetProjectName: string;
}

/**
 * A person in TWO workspaces, each with a project of its own.
 *
 * Two, because the story's recipe picks the second workspace and then proves
 * the app sees ONLY that workspace's projects; one workspace would render the
 * picker-absent variant and prove nothing about the binding. The org is marked
 * `aiIncludedSeat` because the acceptance lane runs cloud-on, where a free org
 * is capped at one workspace — see `seedCliConnect` for the measured reason.
 */
export async function seedOAuthConnect(email: string): Promise<OAuthConnectSeed> {
  const user = await usersService.createUser({
    email,
    password: OAUTH_CONNECT_PASSWORD,
    name: 'Rowan Hale',
  });

  const home = await workspacesService.createWorkspace({ name: 'Moon Labs', ownerUserId: user.id });
  const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
    where: { id: home.workspace.id },
    select: { organizationId: true },
  });
  await adminDb.organization.update({
    where: { id: organizationId },
    data: { aiIncludedSeat: true },
  });
  const target = await workspacesService.createWorkspace({
    name: 'Ship It',
    ownerUserId: user.id,
    organizationId,
  });

  const homeProject = await projectsService.createProject({
    name: 'Lunar Base',
    identifier: 'LUN',
    workspaceId: home.workspace.id,
    actorUserId: user.id,
  });
  const targetProject = await projectsService.createProject({
    name: 'Harbour Release',
    identifier: 'HAR',
    workspaceId: target.workspace.id,
    actorUserId: user.id,
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user.id, workspaceId: home.workspace.id } },
    data: { activeProjectId: homeProject.id },
  });

  return {
    email,
    password: OAUTH_CONNECT_PASSWORD,
    userId: user.id,
    homeLabel: await workspaceLabel(home.workspace.id),
    homeWorkspaceName: home.workspace.name,
    homeProjectKey: homeProject.identifier,
    targetLabel: await workspaceLabel(target.workspace.id),
    targetWorkspaceName: target.workspace.name,
    targetProjectKey: targetProject.identifier,
    targetProjectName: targetProject.name,
  };
}

async function workspaceLabel(workspaceId: string): Promise<string> {
  const row = await adminDb.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { name: true, organization: { select: { name: true } } },
  });
  return `${row.organization.name} · ${row.name}`;
}

// ── The app side ─────────────────────────────────────────────────────────────

/** A cookie-less request context: the app, which holds no browser session. */
export async function appContext(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL: baseUrl() });
}

/** RFC 7591 dynamic registration, exactly as an MCP client does it. */
export async function registerApp(app: APIRequestContext): Promise<string> {
  const res = await app.post('/api/auth/oauth2/register', {
    data: {
      client_name: APP_NAME,
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
  });
  expect(res.status(), 'an app can register itself unauthenticated').toBe(200);
  return ((await res.json()) as { client_id: string }).client_id;
}

export interface PendingAuthorize {
  url: string;
  verifier: string;
  state: string;
}

/** The authorize URL an app opens in the person's browser: PKCE S256 + `resource`. */
export function authorizeRequest(
  clientId: string,
  opts: { resource?: string; state?: string } = {},
): PendingAuthorize {
  const verifier = randomBytes(32).toString('base64url');
  const state = opts.state ?? `st-${randomBytes(4).toString('hex')}`;
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    state,
    scope: 'offline_access',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: opts.resource ?? `${baseUrl()}/api/mcp`,
  });
  return { url: `/api/auth/oauth2/authorize?${q.toString()}`, verifier, state };
}

/** The app's half after the redirect: exchange the code for tokens. */
export async function exchangeCode(
  app: APIRequestContext,
  clientId: string,
  code: string,
  verifier: string,
): Promise<string> {
  const res = await app.post('/api/auth/oauth2/token', {
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${baseUrl()}/api/mcp`,
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

export type ToolCall = { kind: 'ok'; text: string } | { kind: 'unauthorized' };

/**
 * One `tools/call` through the MCP SDK's own client, carrying the bearer the
 * way an app does. A 401 from the gate is a RESULT (`unauthorized`); anything
 * else that fails rethrows, so "revoked" and "the endpoint broke" never share
 * an assertion.
 */
export async function callTool(
  accessToken: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolCall> {
  const client = new Client({ name: 'motir-oauth-connect-e2e', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/api/mcp', baseUrl()), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  try {
    await client.connect(transport);
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    expect(result.isError, 'the tool call itself succeeded').toBeFalsy();
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    return { kind: 'ok', text };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === 401 || /\b401\b|unauthor/i.test(message)) return { kind: 'unauthorized' };
    throw err;
  } finally {
    await client.close().catch(() => {});
  }
}

// ── The person's side ────────────────────────────────────────────────────────

/**
 * The page the app's loopback listener serves once it has the code — what an
 * MCP client like Claude Code shows the person before they switch back. It is
 * the APP's page, not Motir's, so it borrows nothing from Motir's design system:
 * system fonts and the browser's own `Canvas` / `CanvasText` colours, which a
 * real client's minimal page would use too.
 */
const LOOPBACK_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${APP_NAME} — connected</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: Canvas; color: CanvasText;
    font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
  }
  main {
    max-width: 26rem; padding: 2.5rem 2rem; text-align: center;
    border: 1px solid color-mix(in srgb, CanvasText 15%, Canvas);
    border-radius: 16px;
    box-shadow: 0 8px 30px color-mix(in srgb, CanvasText 8%, transparent);
  }
  .tick {
    width: 3rem; height: 3rem; margin: 0 auto 1.25rem; border-radius: 50%;
    display: grid; place-items: center;
    background: color-mix(in srgb, CanvasText 8%, Canvas);
  }
  h1 { margin: 0 0 0.5rem; font-size: 1.375rem; font-weight: 600; }
  p { margin: 0; opacity: 0.75; }
</style>
</head>
<body>
<main>
  <div class="tick" aria-hidden="true">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>
  </div>
  <h1>Back in ${APP_NAME}</h1>
  <p>Authorization finished. You can close this window and return to ${APP_NAME}.</p>
</main>
</body>
</html>`;

/** Stand in for the app's loopback listener, so the browser has somewhere to land. */
export async function answerLoopback(page: Page): Promise<void> {
  await page.route(`${CALLBACK}**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: LOOPBACK_PAGE }),
  );
}

/**
 * Open the app's authorize URL and wait for the consent screen to be MOUNTED —
 * its Approve button visible — before anything about it is asserted, so a page
 * that never renders cannot pass by asserting nothing.
 */
export async function openConsent(page: Page, pending: PendingAuthorize): Promise<void> {
  await page.goto(pending.url);
  await page.waitForURL(/\/oauth\/consent\?/);
  await expect(page.getByRole('button', { name: 'Approve and connect' })).toBeVisible();
}

/** Pick a workspace in the consent screen's picker. */
export async function pickWorkspace(page: Page, label: string): Promise<void> {
  await page.getByRole('combobox', { name: `Workspace ${APP_NAME} can act in` }).click();
  await page.getByRole('option', { name: label }).click();
  await expect(
    page.getByRole('combobox', { name: `Workspace ${APP_NAME} can act in` }),
  ).toContainText(label.split(' · ').pop()!);
}

/**
 * Press a consent button and follow the browser back to the app. The consent
 * route's 200 and the arrival at the loopback redirect are the two
 * authoritative signals; the returned URL carries what the app receives.
 */
export async function pressAndReturn(
  page: Page,
  button: 'Approve and connect' | 'Deny',
): Promise<URL> {
  const pressed = page.waitForResponse(
    (r) => r.url().endsWith('/api/oauth/consent') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: button, exact: true }).click();
  expect((await pressed).status()).toBe(200);
  await page.waitForURL((url) => url.href.startsWith(CALLBACK));
  return new URL(page.url());
}

/** Settings → Account → Tokens, scrolled to Connected apps once its read has answered. */
export async function openConnectedApps(page: Page): Promise<void> {
  await page.goto('/settings/account/tokens#connected-apps');
  await expect(page.getByRole('heading', { name: 'Connected apps' })).toBeVisible();
}
