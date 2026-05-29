// E2E: multi-tenant isolation — the cross-tenant attack surface.
//
// @smoke — the final spec of Story 1.2 (Workspaces). Proves a signed-in
// user A cannot reach into a workspace B they're not a member of, across
// the two URL/cookie vectors that actually exist on `main` after 1.2.6:
//
//   (i)  POST /api/workspaces/{B.id}/invites as user A → 404 (NOT 403:
//        a 403 would confirm B exists; 404 is indistinguishable from a
//        never-existed id, so an attacker probing ids learns nothing).
//   (ii) A FORGED workspace_id cookie pointing at B → the workspace-context
//        resolver re-validates membership and never acts on B. Demonstrated
//        via GET /api/workspaces/current with the forged cookie: it returns
//        A's OWN workspace (or 404), never B's data.
//
// There are NO PATCH/DELETE /api/workspaces/{id} REST endpoints — 1.2.6
// shipped rename/leave/delete as cookie-keyed Server Actions, not
// URL-addressable handlers — so those are not part of the attack surface.
//
// Reuses the db-reset helper (1.1.7) and the @smoke tag convention. The
// Better-Auth sign-up/sign-in rate limiter is disabled for the E2E dev
// server via E2E_DISABLE_RATE_LIMIT (playwright.config.ts webServer.env +
// lib/auth/index.ts — PRODECT_FINDINGS #9), so two back-to-back sign-ups
// from localhost no longer flake; no wait-out loop is needed here.

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';

const PASSWORD = 'multi-tenant-pass-123';
const USER_A_EMAIL = 'e2e-tenant-a@example.com';
const USER_B_EMAIL = 'e2e-tenant-b@example.com';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  // Disconnect the worktree-side Prisma client so pg's pool doesn't keep
  // the Playwright runner alive past the last test (a 10s hang in CI).
  await db.$disconnect();
});

// Sign up a brand-new user via the two-step credentials flow, landing on
// /dashboard with a session cookie set. The rate limiter is gated OFF for
// the E2E dev server (see file header), so a single click is enough.
async function signUp(page: Page, email: string): Promise<void> {
  await page.goto('/sign-up');
  await page.getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Create a password').fill(PASSWORD);
  await page.getByRole('button', { name: /^(Create account|Creating account…)$/ }).click();
  await page.waitForURL('**/dashboard');
}

test('@smoke multi-tenant isolation: cross-tenant invite is 404 + forged workspace cookie is re-validated', async ({
  browser,
  page,
}) => {
  // ─── User A signs up (1.2.4 auto-creates "e2e-tenant-a's Workspace") ───
  await signUp(page, USER_A_EMAIL);

  // ─── User B signs up in a fresh context (auto-creates B's workspace) ───
  const contextB: BrowserContext = await browser.newContext();
  const pageB = await contextB.newPage();
  await signUp(pageB, USER_B_EMAIL);

  // ─── Resolve both workspace ids from the DB ───
  // Each user's auto-created workspace is named "{local-part}'s Workspace"
  // (the sign-up page sends name = email.split('@')[0]).
  const localA = USER_A_EMAIL.split('@')[0]!;
  const localB = USER_B_EMAIL.split('@')[0]!;
  const workspaceA = await db.workspace.findFirst({ where: { name: `${localA}'s Workspace` } });
  const workspaceB = await db.workspace.findFirst({ where: { name: `${localB}'s Workspace` } });
  expect(workspaceA, "user A's auto-workspace should exist").not.toBeNull();
  expect(workspaceB, "user B's auto-workspace should exist").not.toBeNull();
  // Distinct tenants, and A is NOT a member of B.
  expect(workspaceA!.id).not.toBe(workspaceB!.id);
  // B has its owner membership…
  expect(
    await db.workspaceMembership.findFirst({ where: { workspaceId: workspaceB!.id } }),
  ).not.toBeNull();
  // …but no membership ties A's user to workspace B.
  const aUser = await db.user.findFirst({ where: { email: USER_A_EMAIL } });
  expect(aUser).not.toBeNull();
  expect(
    await db.workspaceMembership.findFirst({
      where: { userId: aUser!.id, workspaceId: workspaceB!.id },
    }),
  ).toBeNull();

  // ─── Vector (i): A invites someone to workspace B → 404, not 403/200 ───
  // page.request reuses A's session cookies, so this is an authenticated
  // cross-tenant write attempt.
  const inviteRes = await page.request.post(`/api/workspaces/${workspaceB!.id}/invites`, {
    data: { email: 'victim@example.com' },
  });
  expect(
    inviteRes.status(),
    'cross-tenant invite must return 404 (anti-enumeration), not 403 or 200',
  ).toBe(404);
  // The body must not leak B's existence/details either — just the
  // not-found shape.
  const inviteBody = (await inviteRes.json()) as { code?: string };
  expect(inviteBody.code).toBe('NOT_FOUND');
  // And no invite/verification row was created for B as a side effect.
  // (The membership table is the load-bearing assertion: A gained nothing.)
  expect(
    await db.workspaceMembership.findFirst({
      where: { userId: aUser!.id, workspaceId: workspaceB!.id },
    }),
  ).toBeNull();

  // ─── Sanity: A CAN invite to its OWN workspace (proves the 404 above is
  // membership-gated, not a blanket failure of the endpoint) ───
  const ownInviteRes = await page.request.post(`/api/workspaces/${workspaceA!.id}/invites`, {
    data: { email: 'colleague@example.com' },
  });
  expect(ownInviteRes.status(), 'inviting to your OWN workspace should succeed').toBe(200);

  // ─── Vector (ii): forge the workspace_id cookie to point at B ───
  // The resolver must re-validate membership and refuse to act on B,
  // falling back to A's own workspace (or 404), never returning B.
  await page.context().addCookies([
    {
      name: 'workspace_id',
      value: workspaceB!.id,
      url: page.url(), // same origin as the dev server
    },
  ]);

  const currentRes = await page.request.get('/api/workspaces/current');
  // Either A's own workspace (the resolver fell back) or 404 — never B.
  if (currentRes.status() === 200) {
    const current = (await currentRes.json()) as {
      workspace: { id: string; name: string };
      membership: { userId: string; workspaceId: string };
    };
    expect(current.workspace.id, 'forged cookie must NOT resolve to workspace B').not.toBe(
      workspaceB!.id,
    );
    expect(current.workspace.id).toBe(workspaceA!.id);
    expect(current.workspace.name).not.toBe(`${localB}'s Workspace`);
    expect(current.membership.userId).toBe(aUser!.id);
  } else {
    // The only other acceptable answer is 404 (no active workspace) — still
    // never a 200 carrying B.
    expect(currentRes.status()).toBe(404);
  }

  await contextB.close();
});
