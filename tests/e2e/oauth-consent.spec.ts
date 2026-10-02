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
//
// The second test is the page's LAYOUT at the viewports that matter (MOTIR-7380,
// `design/auth/oauth-consent--sticky-actions.mock.html`): Approve and connect is
// on screen the moment the page lands, stays there while the grant scrolls, and
// the grant's last row ends above the pinned bar. Only a real browser lays out.

import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { createFirstProject, signUp } from './_helpers/shell-session';
import { CALLBACK, answerLoopback } from './_helpers/oauth-connect-seed';

test.describe.configure({ timeout: 120_000 });

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
  expect(registered.status()).toBe(201);
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

  await answerLoopback(page);

  await page.goto(`/api/auth/oauth2/authorize?${authorize.toString()}`);
  await page.waitForURL(/\/oauth\/consent\?/);
  await expect(page.getByRole('heading', { name: 'Connect Claude Code to Motir?' })).toBeVisible();
  await expect(page.getByRole('main').getByText('Unverified')).toBeVisible();
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

/** Register a loopback app and open its authorize URL; resolves on the consent page. */
async function openConsent(page: Page, request: APIRequestContext, baseURL: string | undefined) {
  const registered = await request.post('/api/auth/oauth2/register', {
    data: {
      client_name: 'Claude Code',
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
  });
  expect(registered.status()).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const authorize = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: 'st-layout',
    scope: 'offline_access',
    code_challenge: createHash('sha256')
      .update(randomBytes(32).toString('base64url'))
      .digest('base64url'),
    code_challenge_method: 'S256',
    resource: `${baseURL}/api/mcp`,
  });
  await page.goto(`/api/auth/oauth2/authorize?${authorize.toString()}`);
  await page.waitForURL(/\/oauth\/consent\?/);
  await expect(page.getByRole('heading', { name: 'Connect Claude Code to Motir?' })).toBeVisible();
}

test('Approve and connect is on screen on landing, while the grant scrolls, and at phone width', async ({
  page,
  request,
  baseURL,
}) => {
  await signUp(page, 'oauth-consent-layout-e2e@example.com');
  await createFirstProject(page, 'Consent Layout E2E');

  await page.setViewportSize({ width: 1440, height: 800 });
  await openConsent(page, request, baseURL);
  const approve = page.getByRole('button', { name: 'Approve and connect' });
  const bar = page.locator('[data-consent-bar]');

  // Landing, All projects: the decision is in view with no scroll at all.
  await expect(approve).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Deny' })).toBeInViewport({ ratio: 1 });

  // One project: switches with descriptions make the card taller than 800px,
  // and the bar rides the viewport's bottom edge rather than the card's foot.
  await page.getByRole('button', { name: 'One project' }).click();
  await expect(page.getByRole('switch', { name: 'Approve or decline AI plans' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(800);
  await expect(approve).toBeInViewport({ ratio: 1 });

  // Scrolled to the end: Approve is still in view, and the grant's last row has
  // come fully clear of the bar — nothing sits behind it.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect
    .poll(() => page.evaluate(() => window.scrollY + window.innerHeight))
    .toBe(await page.evaluate(() => document.documentElement.scrollHeight));
  await expect(approve).toBeInViewport({ ratio: 1 });
  const grant = await page.getByRole('group', { name: 'What it can do' }).boundingBox();
  const barBox = await bar.boundingBox();
  expect(grant && barBox).toBeTruthy();
  expect(grant!.y + grant!.height).toBeLessThanOrEqual(barBox!.y);
  await expect(page.getByRole('switch', { name: 'Approve or decline AI plans' })).toBeInViewport({
    ratio: 1,
  });

  // The scroller is padded by the bar's height, so a focused switch scrolls
  // into view above the stuck bar rather than under it.
  const padding = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom),
  );
  expect(padding).toBeGreaterThanOrEqual(Math.floor(barBox!.height));

  // Phone width: the bar is reachable on landing and the page never scrolls
  // sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(approve).toBeInViewport({ ratio: 1 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});
