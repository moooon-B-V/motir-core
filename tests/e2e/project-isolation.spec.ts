// E2E: project isolation — the cross-tenant attack surface for projects.
//
// @smoke — the closing spec of Story 1.3 (Projects). Proves a signed-in
// user A cannot reach into a project belonging to a workspace B they're
// not a member of, across the two vectors that actually exist on `main`
// after 1.3.4:
//
//   (i)  Invoking a project-scoped Server Action with B's projectId from
//        A's session. There are NO /api/projects/* HTTP endpoints — every
//        project mutation is a Server Action in app/(authed)/_project-
//        actions.ts (setActiveProjectAction, archiveProjectAction,
//        createProjectAction). The defenses-in-depth chain:
//          - the action resolves the active workspace from A's cookie
//            (lib/workspaces/context.ts), so workspaceId is A's
//          - projectsService.{setActiveProject,archiveProject} call
//            assertProjectInWorkspaceInTx(B.projectId, A.workspaceId, tx)
//          - under prodect_app, the project RLS policy already hides B's
//            row from the read, so the assertion throws
//            ProjectNotFoundError; under the dev/CI superuser (BYPASSRLS)
//            the read returns B's row and the workspaceId mismatch path
//            throws ProjectWorkspaceMismatchError. Either typed error
//            surfaces to the client as a 500-shaped Server Action
//            response that does NOT echo any foreign-project name or
//            identifier — the error message contains only the projectId
//            (which the attacker already knows) and A's own workspaceId.
//        We assert (a) the response is non-200, (b) the response body
//        does not leak Bob's project name or identifier, (c) the DB
//        invariants hold (Bob's archivedAt stays null; Alice's
//        membership.activeProjectId is not pinned to Bob's project).
//
//   (ii) The READ-side: the project switcher renders the active
//        workspace's listProjects() result, which is membership-gated
//        in the service. Alice's switcher must list ONLY her own
//        projects, never any from a workspace she's not in.
//
// Note on shape calibration vs. multi-tenant-isolation.spec.ts: that
// spec asserts HTTP 404 (anti-enumeration) on cross-tenant
// /api/workspaces/{id}/invites POSTs. Projects don't have HTTP
// endpoints, so the durable equivalent here is "no-information-leak in
// the Server Action error body" — which IS the same anti-enumeration
// invariant, just on the Server Action transport instead of REST.
//
// Reuses resetDatabase() + the db re-export from _helpers/db-reset.
// E2E_DISABLE_RATE_LIMIT is on in the dev server (playwright.config.ts
// webServer.env + lib/auth/index.ts — PRODECT_FINDINGS #9), so back-to-
// back sign-ups don't hit Better-Auth's IP-keyed limiter; no wait-out
// loop is needed.

import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';

const PASSWORD = 'project-isolation-pass-123';
const USER_A_EMAIL = 'e2e-project-tenant-a@example.com';
const USER_B_EMAIL = 'e2e-project-tenant-b@example.com';
const PROJECT_A_NAME = 'Alice Project';
const PROJECT_A_IDENTIFIER = 'ALICE';
const PROJECT_B_NAME = 'Bob Project';
const PROJECT_B_IDENTIFIER = 'BOBSP';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  // Disconnect the worktree-side Prisma client so pg's pool doesn't keep
  // the Playwright runner alive past the last test (mirrors
  // multi-tenant-isolation.spec.ts).
  await db.$disconnect();
});

// Sign-up flow matches multi-tenant-isolation.spec.ts: single click is
// enough because E2E_DISABLE_RATE_LIMIT gates the IP-keyed limiter off
// for the E2E dev server.
async function signUp(page: Page, email: string): Promise<void> {
  await page.goto('/sign-up');
  await page.getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Create a password').fill(PASSWORD);
  await page.getByRole('button', { name: /^(Create account|Creating account…)$/ }).click();
  await page.waitForURL('**/dashboard');
}

// Drive the production create-project modal end-to-end so we exercise
// the same Server Action path (createProjectAction →
// projectsService.createProject) the UI normally takes. Opens the modal
// from whichever entry point the current surface state offers:
//   - empty-state CTA (first project: /dashboard has the "Create your
//     first project" empty state + a top-level "Create project" button)
//   - switcher's "Create project" entry (subsequent projects: the
//     empty-state CTA is gone once the workspace has any project)
async function createProject(page: Page, name: string, identifier: string): Promise<void> {
  await page.goto('/dashboard');
  const emptyStateCta = page.getByRole('button', { name: 'Create project' }).first();
  // Sync on either the empty-state CTA or the switcher being ready —
  // whichever the workspace state renders.
  await expect(page.getByRole('button', { name: 'Switch project' })).toBeVisible();
  if (await emptyStateCta.isVisible().catch(() => false)) {
    await emptyStateCta.click();
  } else {
    // Open the switcher and click its "Create project" entry. The
    // switcher itself also has a "Create project" item, distinct from
    // the disabled "Switch project" trigger.
    await page.getByRole('button', { name: 'Switch project' }).click();
    await page
      .getByRole('button', { name: /^Create project/ })
      .last()
      .click();
  }
  await expect(page.getByRole('heading', { name: 'Create project' })).toBeVisible();
  await page.getByLabel('Project name').fill(name);
  // Identifier auto-derives from the name; replace it with our explicit
  // value so the cross-tenant assertions can pin on stable handles.
  const identifierInput = page.getByLabel('Identifier');
  await identifierInput.fill(identifier);
  await page.getByRole('button', { name: 'Create project', exact: true }).last().click();
  await expect(page.getByText('Project created').first()).toBeVisible({ timeout: 5_000 });
  // Top-nav switcher reflects the new active project.
  await expect(page.getByRole('button', { name: 'Switch project' })).toContainText(name);
}

// Capture the action id + payload from a legitimate Server Action call
// so we can re-issue it with a foreign projectId in vector (i). Next 16
// transports Server Actions as POSTs to the current page URL carrying
// a `next-action` header (the action id) + a body encoding the args.
// Replaying the same POST with the same headers and a substituted body
// is exactly what an attacker with a stolen project id would do.
interface CapturedAction {
  url: string;
  actionId: string;
  headers: Record<string, string>;
  body: string;
}
async function captureSetActiveProjectAction(
  page: Page,
  ownProjectId: string,
  ownProjectName: string,
): Promise<CapturedAction> {
  // Trigger the legitimate switch action by clicking the own project
  // again from the switcher. Even if it's already active, the click
  // path POSTs (see ProjectSwitcher.handleSwitch — only no-ops on the
  // SAME id). To guarantee a POST fires we use a no-op-different click:
  // re-open the popover and click the active row; if that's the only
  // row, fall back to driving setActiveProjectAction via a dispatched
  // form submission. For the two-project setup below we create a
  // second project just for this purpose — see comment in the test.
  const captured: CapturedAction[] = [];
  const handler = (request: Request) => {
    const headers = request.headers();
    if (headers['next-action'] && request.method() === 'POST') {
      captured.push({
        url: request.url(),
        actionId: headers['next-action']!,
        headers,
        body: request.postData() ?? '',
      });
    }
  };
  page.on('request', handler);
  try {
    await page.getByRole('button', { name: 'Switch project' }).click();
    // Click an own project row inside the open popover. The active row
    // early-returns without a POST (see ProjectSwitcher.handleSwitch:
    // same-id click no-ops). To force a real POST we click the row
    // matching `ownProjectName` — caller passes the OLDER own project's
    // name (the one that is NOT currently active after both creates).
    // Scope to the popover panel (Radix portals it with
    // data-state=open) to avoid matching toast region role="list".
    const popoverPanel = page
      .locator('[data-state=open]')
      .filter({ has: page.getByText('Projects', { exact: true }) });
    await popoverPanel.locator('ul[role=list] button', { hasText: ownProjectName }).first().click();
    // Wait for the POST to land. Synchronizing on the resulting
    // re-render (active label flips) is the durable signal — never
    // waitForTimeout.
    await page.waitForResponse(
      (resp) =>
        resp.request().method() === 'POST' && resp.request().headers()['next-action'] !== undefined,
      { timeout: 10_000 },
    );
  } finally {
    page.off('request', handler);
  }
  // Pick the Server Action POST whose body contains the OWN project id —
  // that's the setActiveProjectAction call. (Other Server Action POSTs
  // can fire during the same window, e.g. router refresh fetches; we
  // disambiguate by payload content rather than position.)
  const match = captured.find((c) => c.body.includes(ownProjectId));
  if (!match) {
    throw new Error(
      `Did not capture a setActiveProjectAction POST containing own project id ${ownProjectId}. ` +
        `Captured ${captured.length} action POST(s).`,
    );
  }
  return match;
}

test('@smoke project isolation: cross-tenant Server Action is denied without leaking foreign data + switcher shows only own projects', async ({
  browser,
  page,
}) => {
  // ─── User A signs up + creates two own projects ───
  // Two projects so captureSetActiveProjectAction has a "real switch"
  // target (the same-id click path early-returns without a POST).
  await signUp(page, USER_A_EMAIL);
  await createProject(page, PROJECT_A_NAME, PROJECT_A_IDENTIFIER);
  await createProject(page, 'Alice Secondary', 'ALIC2');

  // ─── User B signs up in a fresh context + creates Bob's project ───
  const contextB: BrowserContext = await browser.newContext();
  const pageB = await contextB.newPage();
  await signUp(pageB, USER_B_EMAIL);
  await createProject(pageB, PROJECT_B_NAME, PROJECT_B_IDENTIFIER);

  // ─── Resolve project + workspace ids from the DB ───
  const aliceUser = await db.user.findFirst({ where: { email: USER_A_EMAIL } });
  const bobUser = await db.user.findFirst({ where: { email: USER_B_EMAIL } });
  expect(aliceUser, "user A's account should exist").not.toBeNull();
  expect(bobUser, "user B's account should exist").not.toBeNull();
  const aliceProject = await db.project.findFirst({
    where: { identifier: PROJECT_A_IDENTIFIER },
  });
  const bobProject = await db.project.findFirst({
    where: { identifier: PROJECT_B_IDENTIFIER },
  });
  expect(aliceProject, "Alice's project should exist").not.toBeNull();
  expect(bobProject, "Bob's project should exist").not.toBeNull();
  expect(aliceProject!.workspaceId).not.toBe(bobProject!.workspaceId);

  // ─── Vector (ii) [READ isolation via the switcher] — assert this
  //     before vector (i) so we open the popover anyway, and the
  //     vector-(i) capture step re-opens it. ───
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Switch project' }).click();
  // Scope to the popover content (Radix portals it with
  // data-state=open). The popover's <ul role="list"> is inside that
  // panel; the top-level <ol role="list"> toasts also match
  // getByRole('list'), so we anchor on the panel first.
  const popoverPanel = page.locator('[data-state=open][role=dialog], [data-state=open]').filter({
    has: page.getByText('Projects', { exact: true }),
  });
  await expect(popoverPanel).toBeVisible();
  await expect(popoverPanel).toContainText(PROJECT_A_NAME);
  await expect(popoverPanel).toContainText('Alice Secondary');
  await expect(
    popoverPanel,
    "Alice's switcher must not list Bob's project (read-side isolation)",
  ).not.toContainText(PROJECT_B_NAME);
  // Close the popover before continuing.
  await page.keyboard.press('Escape');

  // ─── Vector (i): A invokes setActiveProjectAction with B's projectId ───
  // Capture a legitimate setActiveProjectAction POST from A's session,
  // then replay it with Bob's project id substituted into the body.
  // After createProject creates Alice Project then Alice Secondary,
  // Alice Secondary is active — so switching TO Alice Project fires a
  // real POST. The captured action id/headers/body are then re-issued
  // with Bob's id swapped in.
  const captured = await captureSetActiveProjectAction(page, aliceProject!.id, PROJECT_A_NAME);

  // Snapshot pre-attack DB state so we can prove no mutation.
  const aliceMembershipBefore = await db.workspaceMembership.findFirst({
    where: { userId: aliceUser!.id, workspaceId: aliceProject!.workspaceId },
  });
  expect(aliceMembershipBefore).not.toBeNull();
  expect(aliceMembershipBefore!.activeProjectId).not.toBe(bobProject!.id);
  const bobProjectBefore = await db.project.findUnique({ where: { id: bobProject!.id } });
  expect(bobProjectBefore!.archivedAt).toBeNull();

  // Re-issue the captured POST with the foreign project id swapped in.
  // The body is React's encodeReply of the args tuple — substituting
  // the own id with the foreign id leaves the rest of the encoding
  // intact (both are CUID2 strings of identical length).
  const forgedBody = captured.body.split(aliceProject!.id).join(bobProject!.id);
  expect(
    forgedBody,
    'forged body must actually contain Bob project id (substitution should have hit)',
  ).toContain(bobProject!.id);
  expect(forgedBody).not.toContain(aliceProject!.id);

  // Strip headers that the browser sets per-request and that Playwright
  // refuses to set verbatim (content-length recomputes; host is fixed
  // by page.request). Keep next-action + the content-type so the
  // server-side router still recognizes the POST as a Server Action.
  const forgedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(captured.headers)) {
    if (k === 'content-length' || k === 'host' || k === ':authority' || k.startsWith(':')) continue;
    forgedHeaders[k] = v;
  }

  const attackResponse = await page.request.post(captured.url, {
    headers: forgedHeaders,
    data: forgedBody,
  });

  // The action should NOT succeed. Server Actions surface a throw as a
  // non-2xx response; we don't pin the exact code (Next 16 may use 500
  // or surface a 200 wrapping an error payload in future versions),
  // only that it isn't a clean success or that the body doesn't echo
  // the action having taken effect.
  const attackStatus = attackResponse.status();
  const attackText = await attackResponse.text();

  // ─── No-information-leak assertion: the response must not echo
  //     Bob's project name or identifier. Both should fail
  //     indistinguishably from "the id doesn't exist" so an attacker
  //     can't probe for foreign project existence via error contents. ───
  expect(
    attackText,
    "cross-tenant Server Action response must not leak Bob's project name",
  ).not.toContain(PROJECT_B_NAME);
  expect(
    attackText,
    "cross-tenant Server Action response must not leak Bob's project identifier",
  ).not.toContain(PROJECT_B_IDENTIFIER);

  // ─── DB invariants: no state changed as a result of the attack ───
  const aliceMembershipAfter = await db.workspaceMembership.findFirst({
    where: { userId: aliceUser!.id, workspaceId: aliceProject!.workspaceId },
  });
  expect(
    aliceMembershipAfter!.activeProjectId,
    "Alice's active-project pointer must not be pinned to Bob's project",
  ).not.toBe(bobProject!.id);
  const bobProjectAfter = await db.project.findUnique({ where: { id: bobProject!.id } });
  expect(
    bobProjectAfter!.archivedAt,
    "Bob's project must not be archived as a side effect of the cross-tenant call",
  ).toBeNull();
  expect(bobProjectAfter!.name, "Bob's project name must not be mutated").toBe(PROJECT_B_NAME);

  // Either the action threw (the production-correct shape — surfaced
  // as a 500 in Next 16) or the response body acknowledges failure.
  // The load-bearing assertions above (no-leak + DB-untouched) are
  // what proves the isolation; this is a sanity check that we didn't
  // accidentally hit a 200-success path.
  expect(
    attackStatus,
    `cross-tenant Server Action must not return a clean 200 (got ${attackStatus})`,
  ).not.toBe(200);

  await contextB.close();
});
