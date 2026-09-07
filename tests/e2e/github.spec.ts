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
import { linkPr } from './_helpers/pr-link';
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

test('@smoke connect flow: the two grants at their two TIERS → OAuth binds the identity → the org page shows the installed App', async ({
  page,
}) => {
  const email = 'e2e-github-connect@example.com';
  await signUp(page, email);

  // ⚠️ THE TWO GRANTS NOW SIT AT TWO TIERS (Story MOTIR-4669). Step 1 is the
  // MEMBER's own identity and lives at Settings → Account → Git accounts; step 2
  // is the ORGANISATION's App installation and lives at Settings → Organisation
  // → Git. The old single workspace page conflated them, and this walk is what
  // catches a tier move that deletes a door without rebuilding it.

  // Tier 1 — the member's own account, not connected yet.
  await page.goto('/settings/account/git');
  await expect(page.getByRole('heading', { name: 'Git accounts' })).toBeVisible();
  await expect(page.getByText('No git account connected')).toBeVisible();
  // The CTA carries the real start-route href (asserted rather than clicked —
  // its server 302 to GitHub can't be route-intercepted; see the helper), and it
  // NAMES ITS ORIGIN: MOTIR-4676 sends a flow back to the surface that started
  // it, so a member who connects from their account page returns to their
  // account page rather than to whichever surface the constant happens to say.
  await expect(page.getByRole('link', { name: 'Connect GitHub' })).toHaveAttribute(
    'href',
    '/api/github/oauth/start?from=accountGit',
  );

  // Tier 2 — the organisation has no installation, and the page OFFERS one.
  // A settings page that names a state it cannot leave is worse than no page.
  await page.goto('/settings/organization/git');
  await expect(page.getByText('Step 1 · Identity')).toBeVisible();
  await expect(page.getByText('Step 2 · Repository access')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Install the Motir GitHub App' })).toBeVisible();

  // Grant 1 — the identity OAuth round-trip (real start + callback routes). With
  // no origin recorded it lands on the DEFAULT return, which moved with the
  // surface: `/settings/organization/git`, not the deleted workspace route.
  await completeGithubIdentityGrant(page);
  await page.waitForURL('**/settings/organization/git?github=connected');
  await expect(page.getByRole('status')).toHaveText(
    'GitHub identity connected. Install the Motir GitHub App to grant repository access.',
  );

  // The account page now shows the bound identity, and says the half that is
  // still missing — the organisation's own grant.
  await page.goto('/settings/account/git');
  await expect(page.getByText(`@${E2E_GITHUB_USER.login}`)).toBeVisible();
  await expect(
    page.getByText('Your account is connected. Your organisation’s is not.'),
  ).toBeVisible();

  // Grant 2 — the App installation binding (the setup redirect's persist call),
  // then the ORG page shows the installation and the repository it selected.
  const ws = await db.workspace.findFirst({
    where: { name: `${email.split('@')[0]}'s Workspace` },
  });
  await seedGithubInstallation(ws!.id);
  await page.goto('/settings/organization/git');
  // ⚠️ SCOPED TO `#main`. The page streams its body through an in-page
  // `<Suspense>`, so before hydration the resolved chunk and its placeholder are
  // both in the document and an unscoped locator is a strict-mode violation.
  const main = page.locator('#main');
  await expect(
    main.getByText(`Motir App installed on ${E2E_REPO.owner} · organization`).first(),
  ).toBeVisible();
  await expect(main.getByText(E2E_REPO.name, { exact: true }).first()).toBeVisible();
});

test('@smoke PR opened → the linked item goes Implemented; merged → Done (signed webhooks; unsigned 401s)', async ({
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

  // ⚠️ THE LINK IS WHAT ASSOCIATES THE PULL REQUEST, not the title. MOTIR-3674
  // retired the parse, so the `feat: ${item.identifier} …` title below names the
  // card to a READER and to nothing else — delivered unlinked it resolves
  // `no_work_item` and moves nothing, which is that story's first acceptance
  // criterion. What this test is about is the lifecycle a LINKED pull request
  // drives, so the link is setup and every assertion after it is unchanged.
  const wireHeadRef = `subtask/${item.identifier.toLowerCase()}-wire-the-status-sync`;
  await linkPr(page, {
    workItemId: item.id,
    repo: E2E_REPO,
    number: 4101,
    headRef: wireHeadRef,
  });

  // PR OPENED → `implemented`. An open pull request says the code is pushed; CI
  // is what makes the card reviewable (MOTIR-2999), and no check has reported
  // here. The 200 + result body is the committed-state signal; the page loads
  // after it.
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
    toStatus: 'implemented',
  });

  await page.goto(`/items/${item.identifier}`);
  await expect(statusCard(page).getByText('Implemented', { exact: true })).toBeVisible();

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
  // Linked first — see the note in the sync test above. The CI feedback this
  // test is about reaches the card THROUGH the link, so without it there is no
  // card to give feedback on.
  await linkPr(page, { workItemId: item.id, repo: E2E_REPO, number: 4202, headRef });
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
    toStatus: 'implemented',
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
