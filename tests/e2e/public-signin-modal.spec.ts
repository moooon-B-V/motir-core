// E2E: in-place (modal) sign-in on the public project page (MOTIR-1558 · design
// gate MOTIR-1557). The public topbar's "Sign in" / "Start free" CTAs used to be
// full-page navigations to /sign-in · /sign-up; they now open an in-place modal
// so the visitor authenticates WITHOUT leaving the public page. This spec proves
// the thing only a browser can: the CTA opens the dialog (no navigation, URL
// unchanged), the two-step email→password flow authenticates against the
// authoritative Better-Auth POST, and on success the visitor STAYS on the public
// page while the server-rendered topbar re-reads the session and swaps the CTAs
// for the account menu.
//
// Per the E2E discipline (CLAUDE.md): the auth POST's response is armed BEFORE
// the submit and its 200 is awaited before asserting the signed-in state — never
// a waitForTimeout, never the optimistic UI alone.
//
// Setup mirrors public-project-flow.spec.ts: the admin signs up through the real
// UI, the project is created server-side through the shipped service (the one
// sanctioned cross-layer reach for tests) and flipped public directly, and the
// visitor account is created via a real sign-up (so it has a known password) in a
// throwaway context. The modal journey then runs in a FRESH, logged-out context.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp, SHELL_PASSWORD } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

const ADMIN_EMAIL = 'e2e-modal-admin@example.com';
const VISITOR_EMAIL = 'e2e-modal-visitor@example.com';
const PUBLIC_KEY = 'PUBM';

/** Sign the admin up (auto-workspace), create a project server-side, and flip it
 *  public so the /p/[key] surface renders for a logged-out visitor. */
async function seedPublicProject(page: Page): Promise<void> {
  await signUp(page, ADMIN_EMAIL);
  const local = ADMIN_EMAIL.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email: ADMIN_EMAIL } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'admin exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();

  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Public Portal',
    identifier: PUBLIC_KEY,
  });
  // Flip public directly — the make-public UI flow is exercised by
  // public-project-flow.spec.ts; here we only need a public surface to sign in on.
  await db.project.update({
    where: { id: project.id },
    data: { accessLevel: 'public', madePublicAt: new Date() },
  });
}

test('@smoke public page: the topbar "Sign in" opens the modal in place, the visitor authenticates without leaving the page, and the topbar swaps to the account menu', async ({
  page,
  browser,
}) => {
  await seedPublicProject(page);

  // The visitor account (a known password) — created via a real sign-up in a
  // throwaway context, then discarded so the modal journey starts logged out.
  const seedCtx = await browser.newContext();
  const seedPage = await seedCtx.newPage();
  await signUp(seedPage, VISITOR_EMAIL);
  await seedCtx.close();

  // ── the modal journey — a FRESH, logged-out context ────────────────────────
  const anonCtx = await browser.newContext();
  const anon = await anonCtx.newPage();
  const overviewRes = await anon.goto(`/p/${PUBLIC_KEY}`);
  expect(overviewRes?.status(), 'public overview is 200 with no session').toBe(200);

  // The logged-out CTA is a button (in-place modal), not a nav link.
  const signInCta = anon.getByRole('button', { name: 'Sign in' }).first();
  await expect(signInCta).toBeVisible();
  const urlBefore = anon.url();

  // Open the modal — no navigation, URL unchanged.
  await signInCta.click();
  const dialog = anon.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Welcome back!')).toBeVisible();
  expect(anon.url(), 'opening the modal does not navigate').toBe(urlBefore);

  // Step 1 — email. exact:true so it doesn't resolve to "Continue with Google".
  await dialog.getByPlaceholder('Email address').fill(VISITOR_EMAIL);
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();

  // Step 2 — password. Arm the authoritative auth POST BEFORE submitting.
  await dialog.getByPlaceholder('Password').fill(SHELL_PASSWORD);
  const authed = anon.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/auth/sign-in/email' && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: /^(Continue|Signing in…)$/ }).click();
  expect((await authed).status(), 'credentials sign-in returns 200').toBe(200);

  // The visitor STAYS on the public page, and the server-rendered topbar has
  // re-read the session (router.refresh) → the account menu replaces the CTAs.
  await expect(anon.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 30_000 });
  expect(new URL(anon.url()).pathname, 'still on the public project page').toBe(`/p/${PUBLIC_KEY}`);
  await expect(anon.getByRole('button', { name: 'Sign in' })).toHaveCount(0);

  await anonCtx.close();
});
