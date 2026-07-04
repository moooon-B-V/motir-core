// Story 7.10 · MOTIR-897 — the GitHub-integration journey from a user's seat:
// connect the workspace to GitHub → a PR opens/merges → the linked work item's
// status syncs; a failing check → the verification-failed feedback on the item.
//
// GitHub itself is SIMULATED at two real seams (driving a real GitHub App
// install + a real PR in CI is impractical), so every assertion is on Motir's
// observable behavior:
//   * The identity grant runs the REAL /api/github/oauth/start → authorize →
//     callback round-trip: GitHub's leg (authorize screen → redirect back) is
//     performed explicitly by the spec (see completeGithubIdentityGrant — a
//     server-redirect hop can't be page.route-intercepted), and the
//     server-side code→token exchange + /user read are intercepted by
//     instrumentation.ts's E2E_TEST_OAUTH MockAgent (lib/test-oauth-mock.ts —
//     the synthetic `e2e-octocat` identity).
//   * PR / CI deliveries are SIGNED webhook POSTs to the real
//     /api/github/webhook (HMAC over the raw body with the same
//     GITHUB_WEBHOOK_SECRET the dev server runs with — the 7.10.4 signature
//     gate runs for real; the unsigned-POST 401 is asserted below).
//   * The App INSTALLATION binding is seeded through
//     githubInstallationService.persistInstallation — the exact call the
//     post-install setup redirect (MOTIR-1588) makes — because the install
//     round-trip runs on GitHub's servers and can't execute synthetically.
//
// Deliberately NOT asserted here: the per-item PR-state / CI-state pills of
// the work-item "Development" section — that surface is MOTIR-1579 (in
// flight, not on main). The shipped observable signals are the item's STATUS
// (the webhook's transition through workItemsService) and the CI feedback
// COMMENT + ciState flag (MOTIR-894); 1579 extends this spec with the pill
// assertions when its surface lands.
//
// Determinism (the authoritative-signal rule): the webhook route AWAITS the
// full service handling before responding, so each POST's 200 + result body
// IS the committed-state signal — the page is only loaded/reloaded after it.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';
import {
  checkSuitePayload,
  postSignedWebhook,
  pullRequestPayload,
  seedGithubInstallation,
} from './_helpers/github-seed';
import { E2E_GITHUB_USER, E2E_REPO } from './_helpers/github-const';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

/** Sign-up auto-creates the workspace; create a project server-side + pin it
 * active. Returns ids for seeding. Mirrors issue-detail-flow.spec.ts. */
async function seedActiveProject(
  email: string,
  identifier: string,
): Promise<{ projectId: string; workspaceId: string }> {
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'GitHub Sync',
    identifier,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return { projectId: project.id, workspaceId: ws!.id };
}

/** Create a work item through the `_test` route (dev-gated; the spec's data
 * prerequisite, not the surface under test). */
async function mkItem(
  page: Page,
  projectId: string,
  title: string,
): Promise<{ id: string; identifier: string }> {
  const res = await page.request.post('/api/_test/work-items', {
    data: { projectId, kind: 'task', title },
  });
  expect(res.status(), `create "${title}"`).toBe(201);
  return (await res.json()) as { id: string; identifier: string };
}

/** Move an item to a status through the `_test` route (legal transitions only). */
async function transition(page: Page, id: string, statusKey: string): Promise<void> {
  const res = await page.request.patch(`/api/_test/work-items?id=${id}&status=${statusKey}`);
  expect(res.status(), `transition → ${statusKey}`).toBe(200);
}

/** The authoritative status read-back (the committed server state). */
async function statusOf(page: Page, id: string): Promise<string> {
  const res = await page.request.get(`/api/_test/work-items?id=${id}`);
  expect(res.status(), 'read work item').toBe(200);
  return ((await res.json()) as { status: string }).status;
}

/** The detail rail's Status field card — the Pill next to the "Edit Status"
 * chevron (scoped so an activity-log mention of the same label can't match). */
function statusCard(page: Page) {
  return page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });
}

/** Drive the identity grant through the REAL start + callback routes. The CTA
 * is a same-origin <a> whose server 302s to GitHub — and Playwright's
 * page.route cannot intercept a server-redirect HOP (unlike auth-google.spec,
 * where Better-Auth navigates client-side to the authorize URL), so the spec
 * performs GitHub's leg of the round-trip explicitly: GET the start route via
 * page.request (it shares the browser cookie jar, so the httpOnly `state`
 * cookie lands where the callback checks it), assert the authorize URL it
 * minted, then land the browser on the callback exactly as GitHub's redirect
 * would — code exchanged by the MockAgent, nothing leaves localhost. */
async function completeGithubIdentityGrant(page: Page): Promise<void> {
  const start = await page.request.get('/api/github/oauth/start', { maxRedirects: 0 });
  // NextResponse.redirect defaults to 307.
  expect(start.status(), 'start route redirects to GitHub').toBe(307);
  const authorizeUrl = new URL(start.headers()['location']!);
  expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(
    'https://github.com/login/oauth/authorize',
  );
  const state = authorizeUrl.searchParams.get('state')!;
  const callback = new URL(authorizeUrl.searchParams.get('redirect_uri')!);
  callback.searchParams.set('code', 'e2e-github-code');
  callback.searchParams.set('state', state);
  await page.goto(callback.toString());
}

test('@smoke connect flow: two-grants panel → OAuth binds the identity → installed App shows the selected repo', async ({
  page,
}) => {
  const email = 'e2e-github-connect@example.com';
  await signUp(page, email);

  // Panel 1 — not connected: the two-grants explanation + the connect CTA.
  await page.goto('/settings/workspace/github');
  await expect(page.getByRole('heading', { name: 'Connect GitHub' })).toBeVisible();
  await expect(page.getByText('Step 1 · Identity')).toBeVisible();
  await expect(page.getByText('Step 2 · Repository access')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Connect GitHub' })).toBeVisible();

  // The CTA carries the real start-route href (asserted rather than clicked —
  // its server 302 to GitHub can't be route-intercepted; see the helper).
  await expect(page.getByRole('link', { name: 'Connect GitHub' })).toHaveAttribute(
    'href',
    '/api/github/oauth/start',
  );

  // Grant 1 — the identity OAuth round-trip (real start + callback routes).
  await completeGithubIdentityGrant(page);
  await page.waitForURL('**/settings/workspace/github?github=connected');
  await expect(page.getByRole('status')).toHaveText(
    'GitHub identity connected. Install the Motir GitHub App to grant repository access.',
  );

  // Identity bound, App not installed yet — the needs-access state.
  await expect(page.getByText(`@${E2E_GITHUB_USER.login}`)).toBeVisible();
  await expect(page.getByText('Action needed')).toBeVisible();
  await expect(page.getByText('Identity connected · repository access not granted')).toBeVisible();

  // Grant 2 — the App installation binding (the setup redirect's persist call),
  // then the connected panel shows identity + the selected repo with its state.
  const ws = await db.workspace.findFirst({
    where: { name: `${email.split('@')[0]}'s Workspace` },
  });
  await seedGithubInstallation(ws!.id);
  await page.reload();
  await expect(
    page.getByText(`Motir App installed on ${E2E_REPO.owner} · organization`),
  ).toBeVisible();
  await expect(page.getByText(`${E2E_REPO.owner}/`)).toBeVisible();
  await expect(page.getByText(E2E_REPO.name, { exact: true })).toBeVisible();
  await expect(page.getByText(E2E_REPO.defaultBranch, { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Manage on GitHub' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
});

test('@smoke PR opened → the linked item goes In Review; merged → Done (signed webhooks; unsigned 401s)', async ({
  page,
}) => {
  const email = 'e2e-github-sync@example.com';
  await signUp(page, email);
  const { projectId, workspaceId } = await seedActiveProject(email, 'GHE');
  await seedGithubInstallation(workspaceId);

  const item = await mkItem(page, projectId, 'Wire the status sync');
  await transition(page, item.id, 'in_progress');

  // The signature gate is REAL: an unsigned delivery is rejected before
  // processing (the acceptance criterion's 401).
  const unsigned = await page.request.post('/api/github/webhook', {
    headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request' },
    data: JSON.stringify(
      pullRequestPayload({
        action: 'opened',
        number: 4100,
        title: `feat: ${item.identifier} unsigned probe`,
        headRef: `subtask/${item.identifier.toLowerCase()}-probe`,
        state: 'open',
        merged: false,
      }),
    ),
  });
  expect(unsigned.status(), 'unsigned webhook is rejected').toBe(401);
  expect(await statusOf(page, item.id)).toBe('in_progress');

  // PR OPENED (title references the item key) → in_review. The 200 + result
  // body is the committed-state signal; the page loads after it.
  const opened = await postSignedWebhook(
    page.request,
    'pull_request',
    pullRequestPayload({
      action: 'opened',
      number: 4101,
      title: `feat: ${item.identifier} wire the status sync`,
      headRef: `subtask/${item.identifier.toLowerCase()}-wire-the-status-sync`,
      state: 'open',
      merged: false,
    }),
  );
  expect(opened.status()).toBe(200);
  expect(((await opened.json()) as { result: Record<string, unknown> }).result).toMatchObject({
    event: 'pull_request',
    outcome: 'transitioned',
    toStatus: 'in_review',
  });

  await page.goto(`/items/${item.identifier}`);
  await expect(statusCard(page).getByText('In Review', { exact: true })).toBeVisible();

  // PR MERGED → done.
  const merged = await postSignedWebhook(
    page.request,
    'pull_request',
    pullRequestPayload({
      action: 'closed',
      number: 4101,
      title: `feat: ${item.identifier} wire the status sync`,
      headRef: `subtask/${item.identifier.toLowerCase()}-wire-the-status-sync`,
      state: 'closed',
      merged: true,
    }),
  );
  expect(merged.status()).toBe(200);
  expect(((await merged.json()) as { result: Record<string, unknown> }).result).toMatchObject({
    event: 'pull_request',
    outcome: 'transitioned',
    toStatus: 'done',
  });

  await page.reload();
  await expect(statusCard(page).getByText('Done', { exact: true })).toBeVisible();
});

test('@smoke failing check on a linked PR → the verification-failed feedback shows on the item', async ({
  page,
}) => {
  const email = 'e2e-github-ci@example.com';
  await signUp(page, email);
  const { projectId, workspaceId } = await seedActiveProject(email, 'GHF');
  await seedGithubInstallation(workspaceId);

  const item = await mkItem(page, projectId, 'Verify the CI signal');
  await transition(page, item.id, 'in_progress');

  const headRef = `subtask/${item.identifier.toLowerCase()}-verify-the-ci-signal`;
  const opened = await postSignedWebhook(
    page.request,
    'pull_request',
    pullRequestPayload({
      action: 'opened',
      number: 4202,
      title: `feat: ${item.identifier} verify the CI signal`,
      headRef,
      state: 'open',
      merged: false,
    }),
  );
  expect(opened.status()).toBe(200);
  expect(((await opened.json()) as { result: Record<string, unknown> }).result).toMatchObject({
    outcome: 'transitioned',
    toStatus: 'in_review',
  });

  // A terminal FAILING check_suite for that PR → the feedback comment + the
  // failing ciState (MOTIR-894's closed loop), asserted from the user's seat
  // as the comment on the item detail.
  const failed = await postSignedWebhook(
    page.request,
    'check_suite',
    checkSuitePayload({
      conclusion: 'failure',
      headSha: 'e2e-sha-4202',
      prNumber: 4202,
      headBranch: headRef,
    }),
  );
  expect(failed.status()).toBe(200);
  expect(((await failed.json()) as { result: Record<string, unknown> }).result).toMatchObject({
    event: 'ci',
    outcome: 'failed',
    ciState: 'failing',
  });

  await page.goto(`/items/${item.identifier}`);
  await expect(page.getByText('CI failed', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('needs another pass', { exact: false }).first()).toBeVisible();
});
