// Browser-driven session helpers shared by the shell a11y + keyboard specs
// (Subtask 1.5.5). Both specs need a *real signed-in browser page* — axe runs
// against the rendered DOM and the keyboard spec drives focus through it — so
// unlike work-item-setup.ts (which signs up over HTTP for speed), these go
// through the actual sign-up + create-project UI.

import { expect, type Page } from '@playwright/test';

export const SHELL_PASSWORD = 'shell-a11y-spec-pass-123';

// Sign up a fresh user → auto-workspace, zero projects → lands on /dashboard.
//
// SINGLE deterministic submit, not a click-wait-reclick retry loop: the E2E
// dev server runs with E2E_DISABLE_RATE_LIMIT=1, so there is no 429 to retry
// around, and a blind re-click races a first sign-up that already succeeded —
// the second submit on the now-existing account clears the just-set session
// and the next protected nav bounces to /sign-in (observed flake, Subtask
// 1.5.5). One click + a generous waitForURL is both correct and reliable.
export async function signUp(page: Page, email: string): Promise<void> {
  await page.goto('/sign-up');
  await page.getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Create a password').fill(SHELL_PASSWORD);
  await page.getByRole('button', { name: /^(Create account|Creating account…)$/ }).click();
  await page.waitForURL('**/dashboard', { timeout: 30_000 });
}

// Create the first project via the dashboard empty-state CTA, so the
// project-scoped sidebar nav (Dashboard / Issues / Boards / Reports) renders.
export async function createFirstProject(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Create project' }).first().click();
  await expect(page.getByRole('heading', { name: 'Create project' })).toBeVisible();
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project', exact: true }).last().click();
  await expect(page.getByText('Project created').first()).toBeVisible({ timeout: 5_000 });
}

// Create an additional named workspace via the top-nav switcher and switch to
// it (the new workspace becomes active, with zero projects). Mirrors the
// helper in workspace-flows.spec.ts; lifted here so the shell journey spec can
// stand up two workspaces with distinct projects for the cmd-k switch path.
export async function createWorkspace(page: Page, name: string): Promise<void> {
  // With existing workspaces the "Create workspace" entry lives inside the
  // open switcher popover; a brand-new account's empty state surfaces it
  // directly. Handle both so callers don't have to know the current state.
  const directCreate = page.getByRole('button', { name: 'Create workspace' });
  if (await directCreate.isVisible().catch(() => false)) {
    await directCreate.click();
  } else {
    await page.getByRole('button', { name: 'Switch workspace' }).click();
    await page.getByRole('button', { name: 'Create workspace' }).click();
  }
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Workspace name').fill(name);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  // The switcher trigger reflects the new (now-active) workspace.
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText(name);
}
