// Browser-driven session helpers shared by the shell a11y + keyboard specs
// (Subtask 1.5.5). Both specs need a *real signed-in browser page* — axe runs
// against the rendered DOM and the keyboard spec drives focus through it — so
// unlike work-item-setup.ts (which signs up over HTTP for speed), these go
// through the actual sign-up + create-project UI.

import { expect, type Page } from '@playwright/test';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';

export const SHELL_PASSWORD = 'shell-a11y-spec-pass-123';

// ⚠️ ONE LANDING FOR BOTH CREDENTIAL FLOWS — sign-IN and sign-UP alike settle
// here, so there is a single answer to "where does authenticating put me".
//
// Sign-in moved to `/home` first (Story MOTIR-2649 · Subtask MOTIR-2654) and
// sign-up stayed on `/dashboard` for a season, because a brand-new account has
// nothing waiting on it and Home's My-work empty state pointed at `/ready`,
// which needs a project. MOTIR-2761 closed that: Home resolves the ACTIVE
// PROJECT and renders the shipped create-first door when there is none, so the
// project-less first screen is the same one `/dashboard` used to give. MOTIR-2921
// then moved sign-up (`docs/decisions/home-scope.md` §2.3).
//
// `tests/e2e/auth-post-auth-landing.spec.ts` pins BOTH flows against this
// constant — that is what stops them diverging again unnoticed.
//
// Since MOTIR-3373 it is the APP's constant, re-exported rather than retyped:
// the specs then assert against the value the product actually ships, so a
// destination change is a red spec instead of two constants that agree by
// coincidence until they do not.
export const POST_AUTH_LANDING = AUTHED_LANDING_PATH;

/**
 * ── Why the URL reading right did not mean sign-in had FINISHED ──
 *
 * (The route named below was `/dashboard` when this was measured; MOTIR-2654
 * and MOTIR-2921 have since moved both flows to `/home`. The mechanism is the
 * landing route's, not that route's, so the paths are left as observed.)
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
 * where there is, is a few milliseconds wide. So the SECOND navigation was
 * removed at its source: `app/(auth)/sign-in/page.tsx` dropped its
 * `router.push` and leaves the document load the redirect plugin performs as
 * the only one. That is what makes a `page.goto` straight after `signIn` safe
 * by CONSTRUCTION, and `tests/e2e/auth-post-auth-landing.spec.ts` pins that
 * there is exactly one. (It had to be the SOFT one that went: the saved
 * appearance is server-applied to the root layout's `<html>`, which an RSC
 * navigation cannot rewrite — `tests/e2e/appearance-sync.spec.ts` fails if a
 * returning user reaches the dashboard without a fresh document render.)
 *
 * What these helpers add is the second half: they return on a RENDERED landing
 * page rather than on a URL that merely reads right — an authoritative signal,
 * never an interval (CLAUDE.md § E2E forbids a sleep as synchronisation, and
 * this race got worse under load, which is exactly where a tuned sleep would
 * fail).
 *
 * ONE settle serves both flows, because both land on `/home`, and `home-page`
 * is carried by BOTH of that page's branches — the create-first door a fresh
 * sign-up sees and the list an existing account sees.
 */
async function settleOnHome(page: Page): Promise<void> {
  await page.waitForURL(`**${POST_AUTH_LANDING}`, { timeout: 30_000 });
  await expect(page.getByTestId('home-page')).toBeVisible({ timeout: 30_000 });
}

// Sign up a fresh user → auto-workspace, zero projects → lands on /home, whose
// no-project branch is the shipped "create your first project" door
// (MOTIR-2761); `createFirstProject` below drives it from there.
//
// SINGLE deterministic submit, not a click-wait-reclick retry loop: the E2E
// dev server runs with E2E_DISABLE_RATE_LIMIT=1, so there is no 429 to retry
// around, and a blind re-click races a first sign-up that already succeeded —
// the second submit on the now-existing account clears the just-set session
// and the next protected nav bounces to /sign-in (observed flake, Subtask
// 1.5.5). One click + a generous wait is both correct and reliable.
// The Better-Auth session cookies (the library prefixes every one of them), as
// opposed to the per-device tier cookies `workspace_id` / `motir.org`, which are
// deliberately KEPT below.
const SESSION_COOKIE_MARKER = 'better-auth';

/**
 * Drop the SESSION, keep everything else — the state a person is in when they
 * arrive at a credential form.
 *
 * ⚠️ Required since MOTIR-3372: `/sign-in` and `/sign-up` are server shells that
 * REDIRECT a reader who is already signed in (to `?next=`, else `/home`), so a
 * spec that authenticates as a second identity mid-test no longer reaches the
 * form at all — `getByPlaceholder('Email address').fill(…)` times out on a page
 * that has already navigated to `/home`. That is the product behaving correctly:
 * a credential form is for somebody who needs credentials, and switching
 * accounts means leaving the first one, exactly as it does in the browser.
 *
 * It drops ONLY the session so the switch stays behaviour-identical to what
 * these specs did before: Better-Auth already replaced the session cookie on the
 * second sign-up, while the per-device `workspace_id` / `motir.org` cookies
 * survived. Clearing everything would change what those specs exercise.
 * (`shell-flows.spec.ts` does the mirror-image trick for the same reason.)
 */
export async function startSignedOut(page: Page): Promise<void> {
  const cookies = await page.context().cookies();
  if (!cookies.some((c) => c.name.includes(SESSION_COOKIE_MARKER))) return;
  const keep = cookies.filter((c) => !c.name.includes(SESSION_COOKIE_MARKER));
  await page.context().clearCookies();
  if (keep.length) await page.context().addCookies(keep);
}

export async function signUp(page: Page, email: string): Promise<void> {
  await startSignedOut(page);
  await page.goto('/sign-up');
  await page.getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Create a password').fill(SHELL_PASSWORD);
  await page.getByRole('button', { name: /^(Create account|Creating account…)$/ }).click();
  await settleOnHome(page);
}

// Sign IN an EXISTING user (vs. signUp's fresh account) through the real
// sign-in UI — the two-step email→password flow, both steps submitted with the
// "Continue" button (Subtask 3.5.1). Used by the at-scale board specs to sign in
// as the server-seeded board-seed owner, who is created via usersService (not
// signed up), then land on the project board. Lands on the default `/home` —
// the same place `signUp` lands (MOTIR-2654, then MOTIR-2921); callers that
// need a different surface `goto` it afterwards, which is safe because sign-in
// performs exactly ONE navigation (MOTIR-2645).
export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await startSignedOut(page);
  await page.goto('/sign-in');
  await page.getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await settleOnHome(page);
}

// Create the first project via the projects-empty-state CTA, so the
// project-scoped sidebar nav (Dashboard / Issues / Boards / Reports) renders.
// The CTA is the same `ProjectsEmptyState` component wherever it is reached —
// `/home`'s no-project branch (where `signUp` now lands) and `/dashboard`'s
// alike — so this works without knowing which page the caller is on.
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
