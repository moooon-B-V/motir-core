// Story 7.23 · MOTIR-1480 — the GitLab-integration journey from a user's seat, the
// GitLab mirror of github.spec.ts (7.10.9 · MOTIR-897): connect a GitLab project →
// a merge request opens/merges → the linked work item's status syncs; the connect
// UI reflects the connection.
//
// GitLab itself is SIMULATED at two real seams (driving a real GitLab OAuth grant +
// a real MR in CI is impractical), so every assertion is on Motir's observable
// behavior:
//   * The connect grant runs the REAL /api/gitlab/oauth/start → authorize →
//     callback round-trip: GitLab's leg (authorize screen → redirect back) is
//     performed explicitly by the spec (see completeGitlabConnectGrant — a
//     server-redirect hop can't be page.route-intercepted), and the server-side
//     code→token exchange + /api/v4/user read are intercepted by
//     instrumentation.ts's E2E_TEST_OAUTH MockAgent (lib/test-oauth-mock.ts — the
//     synthetic `e2e-glcat` identity). Project SELECTION is a separately
//     vitest-covered surface (gitlabProjectSelection.test.ts); here the selected
//     project is seeded through the shipped repository and the connected panel is
//     asserted to reflect it (the 897 "seed the binding, assert the UI" move).
//   * MR deliveries are token-authed POSTs to the real /api/gitlab/webhook (the
//     X-Gitlab-Token GitLab echoes, compared against the same GITLAB_WEBHOOK_SECRET
//     the dev server runs with — the MOTIR-1475 token gate runs for real; the
//     missing-token 401 is asserted below). Unlike GitHub there is no body HMAC.
//
// Scope: this card is connect + MR → work-item status sync. GitLab's pipeline (CI)
// feedback is a sibling card (MOTIR-1477), not asserted here.
//
// Determinism (the authoritative-signal rule): the webhook route AWAITS the full
// service handling before responding, so each POST's 200 + result body IS the
// committed-state signal — the page is only loaded/reloaded after it.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';
import {
  mergeRequestPayload,
  postGitlabWebhook,
  seedGitlabConnection,
  seedGitlabProject,
} from './_helpers/gitlab-seed';
import { E2E_GITLAB_PROJECT, E2E_GITLAB_USER } from './_helpers/gitlab-const';

// GitLab's real merge-request webhook header value; the service keys off the body's
// `object_kind`, so this is for realism, not resolution.
const MR_EVENT = 'Merge Request Hook';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

/** The auto-created workspace id for a signed-up email (sign-up names it
 *  `<local>'s Workspace`). */
async function workspaceIdFor(email: string): Promise<string> {
  const local = email.split('@')[0]!;
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(ws, 'auto workspace exists after sign-up').not.toBeNull();
  return ws!.id;
}

/** Sign-up auto-creates the workspace; create a project server-side + pin it
 *  active. Returns ids for seeding. Mirrors github.spec.ts. */
async function seedActiveProject(
  email: string,
  identifier: string,
): Promise<{ projectId: string; workspaceId: string }> {
  const user = await db.user.findFirst({ where: { email } });
  expect(user, 'user exists after sign-up').not.toBeNull();
  const workspaceId = await workspaceIdFor(email);
  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: user!.id,
    name: 'GitLab Sync',
    identifier,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId } },
    data: { activeProjectId: project.id },
  });
  return { projectId: project.id, workspaceId };
}

/** Create a work item through the `_test` route (dev-gated; a data prerequisite,
 *  not the surface under test). */
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
 *  chevron (scoped so an activity-log mention of the same label can't match). */
function statusCard(page: Page) {
  return page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });
}

/** The `result` body of a /api/gitlab/webhook delivery (the route wraps it as
 *  `{ ok, result }`). */
async function webhookResult(res: {
  json: () => Promise<unknown>;
}): Promise<Record<string, unknown>> {
  return ((await res.json()) as { result: Record<string, unknown> }).result;
}

/** Drive the GitLab connect grant through the REAL start + callback routes. Like
 *  github.spec's helper, GitLab's leg is a server 302 that page.route cannot
 *  intercept, so the spec GETs the start route via page.request (sharing the
 *  browser cookie jar, so the httpOnly nonce cookie lands where the callback checks
 *  it), asserts the authorize URL it minted, then lands the browser on the callback
 *  exactly as GitLab's redirect would — code exchanged by the MockAgent, nothing
 *  leaves localhost. */
async function completeGitlabConnectGrant(page: Page): Promise<void> {
  const start = await page.request.get('/api/gitlab/oauth/start', { maxRedirects: 0 });
  // NextResponse.redirect defaults to 307.
  expect(start.status(), 'start route redirects to GitLab').toBe(307);
  const authorizeUrl = new URL(start.headers()['location']!);
  expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(
    'https://gitlab.com/oauth/authorize',
  );
  const state = authorizeUrl.searchParams.get('state')!;
  const callback = new URL(authorizeUrl.searchParams.get('redirect_uri')!);
  callback.searchParams.set('code', 'e2e-gitlab-code');
  callback.searchParams.set('state', state);
  await page.goto(callback.toString());
}

test('@smoke connect flow: not-connected panel → OAuth binds the identity → connected panel shows the selected project', async ({
  page,
}) => {
  const email = 'e2e-gitlab-connect@example.com';
  await signUp(page, email);

  // Panel 1 — not connected: the single-grant explanation + the connect CTA.
  await page.goto('/settings/workspace/gitlab');
  await expect(page.getByRole('heading', { name: 'Connect GitLab' })).toBeVisible();
  await expect(page.getByText('Step 1 · Authorize')).toBeVisible();
  await expect(page.getByText('Step 2 · Projects')).toBeVisible();

  // The CTA carries the real start-route href (asserted rather than clicked — its
  // server 302 to GitLab can't be route-intercepted; see the helper).
  await expect(page.getByRole('link', { name: 'Connect GitLab' })).toHaveAttribute(
    'href',
    '/api/gitlab/oauth/start',
  );

  // The connect grant — the OAuth round-trip (real start + callback routes).
  await completeGitlabConnectGrant(page);
  await page.waitForURL('**/settings/workspace/gitlab?gitlab=connected');
  await expect(page.getByRole('status')).toHaveText(
    'GitLab connected. Choose projects below to sync merge requests and pipelines.',
  );

  // Identity bound to the synthetic GitLab user; no projects connected yet.
  await expect(page.getByText(`@${E2E_GITLAB_USER.username}`)).toBeVisible();
  await expect(
    page.getByText(`GitLab identity · connected as ${E2E_GITLAB_USER.username}`),
  ).toBeVisible();
  await expect(page.getByText('No projects connected yet.', { exact: false })).toBeVisible();

  // Seed the selected project on the just-created connection (project selection is
  // vitest-covered — gitlabProjectSelection.test.ts), then the connected panel
  // reflects it: owner/name, default branch, the Synced pill, and Disconnect.
  const workspaceId = await workspaceIdFor(email);
  await seedGitlabProject(workspaceId);
  await page.reload();
  await expect(page.getByText(`${E2E_GITLAB_PROJECT.owner}/`)).toBeVisible();
  await expect(page.getByText(E2E_GITLAB_PROJECT.name, { exact: true })).toBeVisible();
  await expect(page.getByText(E2E_GITLAB_PROJECT.defaultBranch, { exact: true })).toBeVisible();
  await expect(page.getByText('Synced', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
});

test('@smoke MR opened → the linked item goes In Review; merged → Done (token-authed webhooks; missing token 401s)', async ({
  page,
}) => {
  const email = 'e2e-gitlab-sync@example.com';
  await signUp(page, email);
  const { projectId, workspaceId } = await seedActiveProject(email, 'GLE');
  await seedGitlabConnection(workspaceId);
  await seedGitlabProject(workspaceId);

  const item = await mkItem(page, projectId, 'Wire the GitLab status sync');
  await transition(page, item.id, 'in_progress');
  const sourceBranch = `subtask/${item.identifier.toLowerCase()}-wire-the-gitlab-status-sync`;

  // The token gate is REAL: a delivery with NO X-Gitlab-Token is rejected before
  // processing (the acceptance criterion's 401).
  const unauthed = await postGitlabWebhook(
    page.request,
    MR_EVENT,
    mergeRequestPayload({
      action: 'open',
      iid: 5100,
      title: `${item.identifier} unauthenticated probe`,
      sourceBranch,
      state: 'opened',
    }),
    { token: null },
  );
  expect(unauthed.status(), 'unauthenticated webhook is rejected').toBe(401);
  expect(await statusOf(page, item.id)).toBe('in_progress');

  // MR OPENED (source branch references the item key) → in_review. The 200 + result
  // body is the committed-state signal; the page loads after it.
  const opened = await postGitlabWebhook(
    page.request,
    MR_EVENT,
    mergeRequestPayload({
      action: 'open',
      iid: 5101,
      title: `Draft: ${item.identifier} wire the GitLab status sync`,
      sourceBranch,
      state: 'opened',
    }),
  );
  expect(opened.status()).toBe(200);
  expect(await webhookResult(opened)).toMatchObject({
    event: 'pull_request',
    outcome: 'transitioned',
    toStatus: 'in_review',
  });

  await page.goto(`/items/${item.identifier}`);
  await expect(statusCard(page).getByText('In Review', { exact: true })).toBeVisible();

  // MR MERGED → done.
  const merged = await postGitlabWebhook(
    page.request,
    MR_EVENT,
    mergeRequestPayload({
      action: 'merge',
      iid: 5101,
      title: `${item.identifier} wire the GitLab status sync`,
      sourceBranch,
      state: 'merged',
    }),
  );
  expect(merged.status()).toBe(200);
  expect(await webhookResult(merged)).toMatchObject({
    event: 'pull_request',
    outcome: 'transitioned',
    toStatus: 'done',
  });

  await page.reload();
  await expect(statusCard(page).getByText('Done', { exact: true })).toBeVisible();
});
