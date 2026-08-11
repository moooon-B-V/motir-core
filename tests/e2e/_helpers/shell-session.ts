// Browser-driven session helpers shared by the shell a11y + keyboard specs
// (Subtask 1.5.5). Both specs need a *real signed-in browser page* — axe runs
// against the rendered DOM and the keyboard spec drives focus through it — so
// unlike work-item-setup.ts (which signs up over HTTP for speed), these go
// through the actual sign-up + create-project UI.

import { expect, type Page } from '@playwright/test';

export const SHELL_PASSWORD = 'shell-a11y-spec-pass-123';

// Where both credential flows land.
export const POST_AUTH_LANDING = '/dashboard';

/**
 * ── Why the URL reading /dashboard did not mean sign-in had FINISHED ──
 *
 * Signing in used to start TWO navigations to the landing route. The page ran
 * its own `router.push(callbackURL)` soft navigation, and — because the request
 * carried a `callbackURL` — Better-Auth answered with `{ redirect: true, url }`
 * (`api/routes/sign-in.mjs`) and its CLIENT redirect plugin assigned
 * `window.location.href = url` (`client/fetch-plugins.mjs`), a full DOCUMENT
 * navigation to the same place.
 *
 * `waitForURL('**​/dashboard')` resolves on whichever of the two commits, and
 * MEASURED here both orders occur: with the document fast it commits first
 * (117 ms) and the soft one follows; with it slower the soft one commits first
 * and the document request is aborted ~5 ms later. When those few milliseconds
 * fall the wrong side of the caller's next `page.goto`, the document navigation
 * commits into it instead and takes it down:
 *
 *     Error: page.goto: Navigation to "http://localhost:3200/items" is
 *     interrupted by another navigation to "http://localhost:3200/dashboard"
 *
 * Three occurrences, three different specs, two lanes, all on innocent diffs
 * (MOTIR-2645). The tell is the phrase `interrupted by another navigation`, not
 * the duration: bare, the `goto` fails in seconds; wrapped in a
 * `toPass({ timeout: 90_000 })` it reads as a 90-second hang.
 *
 * **No wait here could have closed that**, which is why the fix is not in this
 * file alone: the losing navigation is aborted at the winner's commit, so at
 * almost every instant there is nothing left to wait FOR — and the one window
 * where there is, is a few milliseconds wide. So the second navigation was
 * removed at its source (`app/(auth)/sign-in/page.tsx` no longer passes
 * `callbackURL`), which is what makes a `page.goto` straight after `signIn`
 * safe by CONSTRUCTION, and `tests/e2e/auth-post-auth-landing.spec.ts` pins
 * that there is exactly one.
 *
 * What these helpers add is the second half: they return on a RENDERED
 * dashboard rather than on a URL that merely reads right — an authoritative
 * signal, never an interval (CLAUDE.md § E2E forbids a sleep as
 * synchronisation, and this race got worse under load, which is exactly where
 * a tuned sleep would fail).
 */
async function settleOnDashboard(page: Page): Promise<void> {
  await page.waitForURL(`**${POST_AUTH_LANDING}`, { timeout: 30_000 });
  await expect(page.getByTestId('dashboard-page')).toBeVisible({ timeout: 30_000 });
}

// Sign up a fresh user → auto-workspace, zero projects → lands on /dashboard.
//
// SINGLE deterministic submit, not a click-wait-reclick retry loop: the E2E
// dev server runs with E2E_DISABLE_RATE_LIMIT=1, so there is no 429 to retry
// around, and a blind re-click races a first sign-up that already succeeded —
// the second submit on the now-existing account clears the just-set session
// and the next protected nav bounces to /sign-in (observed flake, Subtask
// 1.5.5). One click + a generous wait is both correct and reliable.
export async function signUp(page: Page, email: string): Promise<void> {
  await page.goto('/sign-up');
  await page.getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Create a password').fill(SHELL_PASSWORD);
  await page.getByRole('button', { name: /^(Create account|Creating account…)$/ }).click();
  await settleOnDashboard(page);
}

// Sign IN an EXISTING user (vs. signUp's fresh account) through the real
// sign-in UI — the two-step email→password flow, both steps submitted with the
// "Continue" button (Subtask 3.5.1). Used by the at-scale board specs to sign in
// as the server-seeded board-seed owner, who is created via usersService (not
// signed up), then land on the project board. Lands on the default `/dashboard`.
export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await settleOnDashboard(page);
}

// Create the first project via the dashboard empty-state CTA, so the
// project-scoped sidebar nav (Dashboard / Issues / Boards / Reports) renders.
export async function createFirstProject(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Create project' }).first().click();
  await expect(page.getByRole('heading', { name: 'Create project' })).toBeVisible();
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project', exact: true }).last().click();
  await expect(page.getByText('Project created', { exact: true }).first()).toBeVisible({
    timeout: 5_000,
  });
}

// Create an additional named workspace via the ALWAYS-PRESENT org control's
// "New workspace" entry and switch to it (the new workspace becomes active,
// with zero projects). Story 6.10.5's progressive disclosure HIDES the
// workspace switcher at one workspace, so "New workspace" lives in the org menu
// — the org control is the create path at any workspace count. Mirrors the
// helper in workspace-flows.spec.ts; lifted here so the shell journey spec can
// stand up two workspaces with distinct projects for the cmd-k switch path.
export async function createWorkspace(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Organization menu' }).click();
  await page.getByRole('button', { name: /New workspace/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Workspace name').fill(name);
  await dialog.getByRole('button', { name: 'New workspace', exact: true }).click();
  // Creating a second workspace reveals the switcher, which reflects the new
  // (now-active) workspace.
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText(name);
}
