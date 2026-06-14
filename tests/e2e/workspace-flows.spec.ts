// E2E: the full workspace arc — sign-up → create workspace → rename →
// invite a second user → accept → members list → switch → leave → delete
// → cascade verified by DB query.
//
// @smoke — Story 1.2's user-facing flow. Reuses the file-outbox email
// capture from Story 1.1.6 and the db-reset helper from 1.1.7.
//
// Subtask 1.2.4 (auto-create workspace on signup) IS shipped: a fresh
// sign-up lands with one auto-created "{name}'s Workspace" already active,
// so the switcher shows that name (never the empty-state CTA). This spec
// creates an ADDITIONAL named workspace via the switcher popover and works
// against it, so every user here has ≥1 workspace at all times.

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { waitForEmail, extractInviteUrl } from './_helpers/email-capture';

const PASSWORD = 'workspace-flow-pass-123';
const OWNER_EMAIL = 'e2e-ws-owner@example.com';
const INVITEE_EMAIL = 'e2e-ws-invitee@example.com';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// Sign up a brand-new user via the two-step credentials flow, landing on
// /dashboard with a session cookie set.
//
// Better-Auth rate-limits /sign-up + /sign-in as one IP-keyed bucket
// (window 10s, max 3 — see better-auth's getDefaultSpecialRules). This
// spec signs up two users back-to-back from localhost, so the second can
// hit a 429 (surfaced in-page as "Something went wrong"). That limit is
// correct in production; here we wait out the FULL window before
// resubmitting rather than weakening the limiter. Crucially we do NOT
// retry-click rapidly — each click is another counted POST that would
// re-poison the bucket. One click, then if throttled wait > window, then
// one more click.
async function signUp(page: Page, email: string): Promise<void> {
  await page.goto('/sign-up');
  await page.getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Create a password').fill(PASSWORD);

  const createButton = page.getByRole('button', { name: /^(Create account|Creating account…)$/ });
  const rateLimitAlert = page.getByText('Something went wrong. Please try again.');

  for (let attempt = 0; attempt < 3; attempt++) {
    await createButton.click();
    const landed = await Promise.race([
      page
        .waitForURL('**/dashboard', { timeout: 9_000 })
        .then(() => true)
        .catch(() => false),
      rateLimitAlert
        .waitFor({ state: 'visible', timeout: 9_000 })
        .then(() => false)
        .catch(() => false),
    ]);
    if (landed || page.url().includes('/dashboard')) return;
    // Throttled — wait out the full 10s window (+buffer) so the bucket
    // resets before the next single click.
    await page.waitForTimeout(11_000);
  }
  await page.waitForURL('**/dashboard');
}

// Navigate to an authed route, tolerating the rare post-sign-up race
// where the freshly-set session cookie hasn't propagated to the server
// component yet and the page bounces to /sign-in. One retry clears it.
async function gotoAuthed(page: Page, path: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(path);
    if (!page.url().includes('/sign-in')) return;
    await page.waitForTimeout(500);
  }
}

// Create a named workspace under the active org via the always-present org
// control's "New workspace" entry, and wait for the switcher to show the new
// name. Story 6.10.5 progressive disclosure hides the workspace switcher at one
// workspace, so the create entry lives in the org menu (the org control is the
// create path at any workspace count); creating a 2nd workspace reveals the
// switcher.
async function createWorkspace(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Organization menu' }).click();
  await page.getByRole('button', { name: /New workspace/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Workspace name').fill(name);
  await dialog.getByRole('button', { name: 'New workspace', exact: true }).click();
  // Switcher (now revealed at ≥2 workspaces) shows the created workspace.
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText(name);
}

// The invitee sign-up may wait out a 10s Better-Auth rate-limit window
// (two sign-ups from one IP), so this flow needs more than the 30s
// default. 75s leaves comfortable headroom for one throttle + the arc.
test.setTimeout(75_000);

test('@smoke workspace lifecycle: create, rename, invite, accept, switch, leave, delete', async ({
  browser,
  page,
}) => {
  // ─── Owner signs up (auto-workspace created) and adds a named one ───
  await signUp(page, OWNER_EMAIL);
  // 1.2.4 auto-creates "e2e-ws-owner's Workspace"; create a second, named
  // one and switch to it so the rest of the flow works against it.
  await createWorkspace(page, 'Acme Co.');

  // ─── Rename the active workspace via settings ───
  await gotoAuthed(page, '/settings/workspace');
  await expect(page.getByRole('heading', { name: 'Workspace settings' })).toBeVisible();
  const nameInput = page.getByLabel('Workspace name');
  await nameInput.fill('Acme Renamed');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workspace renamed').first()).toBeVisible();
  // Top-nav switcher reflects the new name after the action revalidates.
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText(
    'Acme Renamed',
  );

  // ─── Invite the second user ───
  await page.getByRole('button', { name: 'Invite' }).click();
  const inviteDialog = page.getByRole('dialog');
  // Regression guard: the Modal primitive must render at its intended
  // width, not collapse to ~16px. (max-w-md once resolved against the
  // design system's --spacing-md token; pinned to a literal rem since.)
  const dialogBox = await inviteDialog.boundingBox();
  expect(dialogBox?.width ?? 0).toBeGreaterThan(300);
  await inviteDialog.getByLabel('Email address').fill(INVITEE_EMAIL);
  await inviteDialog.getByRole('button', { name: 'Send invite' }).click();
  // Radix Toast renders the title twice (visible toast + an aria-live
  // status announcement), so scope to the first match.
  await expect(page.getByText(`Invite sent to ${INVITEE_EMAIL}`).first()).toBeVisible();

  // Read the accept link out of the file outbox.
  const inviteEmail = await waitForEmail(INVITEE_EMAIL);
  expect(inviteEmail.subject).toContain('invited to join');
  const acceptUrl = extractInviteUrl(inviteEmail);

  // ─── Second user signs up in a fresh context and accepts ───
  const inviteeContext: BrowserContext = await browser.newContext();
  const inviteePage = await inviteeContext.newPage();
  await signUp(inviteePage, INVITEE_EMAIL);

  // Follow the invite link. The page renders "Join Acme Renamed".
  await inviteePage.goto(acceptUrl);
  await expect(inviteePage.getByRole('heading', { name: 'Join Acme Renamed' })).toBeVisible();
  await inviteePage.getByRole('button', { name: 'Accept invite' }).click();
  await inviteePage.waitForURL('**/dashboard');

  // Accepting switches the active workspace to the joined one. The invitee now
  // belongs to two orgs (their own + the owner's) with ONE workspace in each,
  // so the workspace switcher is hidden in both (Story 6.10.5 progressive
  // disclosure reveals it only at ≥2 workspaces in the active org). Confirm the
  // join switched the active workspace via the workspace-settings name field.
  await gotoAuthed(inviteePage, '/settings/workspace');
  await expect(inviteePage.getByLabel('Workspace name')).toHaveValue('Acme Renamed');

  // ─── Owner now sees the invitee in the members list ───
  await gotoAuthed(page, '/settings/workspace');
  await expect(page.getByText('2 members')).toBeVisible();
  const inviteeRowEmail = page.getByText(INVITEE_EMAIL);
  await inviteeRowEmail.scrollIntoViewIfNeeded();
  await expect(inviteeRowEmail).toBeVisible();

  // ─── Owner creates a second workspace and switches between them ───
  await createWorkspace(page, 'Side Project');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText(
    'Side Project',
  );
  // Open the switcher: both workspaces are listed.
  await page.getByRole('button', { name: 'Switch workspace' }).click();
  await expect(page.getByRole('list').getByText('Acme Renamed')).toBeVisible();
  await expect(page.getByRole('list').getByText('Side Project')).toBeVisible();
  // Switch back to Acme Renamed.
  await page.getByRole('list').getByText('Acme Renamed').click();
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText(
    'Acme Renamed',
  );

  // ─── Invitee leaves "Acme Renamed" ───
  // Ensure "Acme Renamed" is the invitee's active workspace before leaving
  // (accept switched to it; nothing has changed it since). Single workspace in
  // that org → switcher hidden, so verify via the settings name field.
  await gotoAuthed(inviteePage, '/settings/workspace');
  await expect(inviteePage.getByLabel('Workspace name')).toHaveValue('Acme Renamed');
  await inviteePage.getByRole('button', { name: 'Leave' }).click();
  // The invitee still has their own auto-created workspace, so leaving
  // falls back to it (not an empty state) and redirects to the dashboard.
  // That sole workspace lives in their own org → switcher hidden, so confirm
  // the fallback via the settings name field.
  await inviteePage.waitForURL('**/dashboard');
  await gotoAuthed(inviteePage, '/settings/workspace');
  await expect(inviteePage.getByLabel('Workspace name')).toHaveValue("e2e-ws-invitee's Workspace");

  // Owner's members list is back to just themselves.
  await gotoAuthed(page, '/settings/workspace');
  await expect(page.getByText(/^1 member$/)).toBeVisible();
  await expect(page.getByText(INVITEE_EMAIL)).toHaveCount(0);

  // ─── Owner deletes "Acme Renamed" via double-confirmation ───
  // Make sure Acme Renamed is the active workspace.
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText(
    'Acme Renamed',
  );
  const acmeWorkspace = await db.workspace.findFirst({ where: { name: 'Acme Renamed' } });
  expect(acmeWorkspace).not.toBeNull();

  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const deleteDialog = page.getByRole('dialog');
  const deleteButton = deleteDialog.getByRole('button', { name: 'Delete workspace' });
  // Disabled until the typed name matches exactly.
  await expect(deleteButton).toBeDisabled();
  await deleteDialog.getByLabel(/Type Acme Renamed to confirm/).fill('Wrong Name');
  await expect(deleteButton).toBeDisabled();
  await deleteDialog.getByLabel(/Type Acme Renamed to confirm/).fill('Acme Renamed');
  await expect(deleteButton).toBeEnabled();
  await deleteButton.click();
  await page.waitForURL('**/dashboard');

  // ─── Cascade verified by DB query ───
  expect(await db.workspace.findUnique({ where: { id: acmeWorkspace!.id } })).toBeNull();
  expect(await db.workspaceMembership.count({ where: { workspaceId: acmeWorkspace!.id } })).toBe(0);
  // Deleting the active workspace falls back to a remaining one (the
  // owner still has their auto-created workspace + "Side Project"), so the
  // switcher no longer shows the deleted name.
  await expect(page.getByRole('button', { name: 'Switch workspace' })).not.toContainText(
    'Acme Renamed',
  );
  // "Side Project" still exists in the owner's list.
  await page.getByRole('button', { name: 'Switch workspace' }).click();
  await expect(page.getByRole('list').getByText('Side Project')).toBeVisible();
  await expect(page.getByRole('list').getByText('Acme Renamed')).toHaveCount(0);

  await inviteeContext.close();
});
