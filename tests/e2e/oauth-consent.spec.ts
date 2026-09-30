// E2E SMOKE: the OAuth consent screen (Story MOTIR-6973 · Subtask MOTIR-6985)
// opens for a real pending request and its Approve completes it. A client
// registers itself (RFC 7591), a signed-in person's browser opens the authorize
// endpoint, the provider lands it on `/oauth/consent`, and Approve sends the
// browser to the client's registered redirect with a code and the state.
//
// The client's redirect is a LOOPBACK listener, the Claude Code shape; Playwright
// answers it in place of a real one, so nothing leaves the machine. The whole
// walk with its video is the story E2E (MOTIR-6988); this is the page's opener.
// Every mutation waits on its route response (the authoritative signal).

import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { createFirstProject, signUp } from './_helpers/shell-session';

test.describe.configure({ timeout: 120_000 });

const CALLBACK = 'http://127.0.0.1:53999/callback';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('a pending request opens the consent screen, and Approve returns the code', async ({
  page,
  request,
  baseURL,
}) => {
  await signUp(page, 'oauth-consent-e2e@example.com');
  await createFirstProject(page, 'Consent E2E');

  // Registered the way an app does it: anonymously, from its own HTTP client.
  // NOT `page.request`, which shares the page's session cookie — a cookie-bearing
  // POST with no Origin is refused by the auth layer's CSRF check (403).
  const registered = await request.post('/api/auth/oauth2/register', {
    data: {
      client_name: 'Claude Code',
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
  });
  expect(registered.status()).toBe(200);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };

  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: 'st-e2e',
    scope: 'offline_access',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: `${baseURL}/api/mcp`,
  });

  // Stand in for the app's loopback listener.
  await page.route(`${CALLBACK}**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: 'connected' }),
  );

  await page.goto(`/api/auth/oauth2/authorize?${authorize.toString()}`);
  await page.waitForURL(/\/oauth\/consent\?/);
  await expect(page.getByRole('heading', { name: 'Connect Claude Code to Motir?' })).toBeVisible();
  await expect(page.getByText('Unverified')).toBeVisible();
  const approve = page.getByRole('button', { name: 'Approve and connect' });
  await expect(approve).toBeEnabled();

  const approved = page.waitForResponse(
    (r) => r.url().endsWith('/api/oauth/consent') && r.request().method() === 'POST',
  );
  await approve.click();
  expect((await approved).status()).toBe(200);
  await page.waitForURL((url) => url.href.startsWith(CALLBACK));
  const back = new URL(page.url());
  expect(back.searchParams.get('code')).toBeTruthy();
  expect(back.searchParams.get('state')).toBe('st-e2e');
});
