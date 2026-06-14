// E2E: the organization (root-account) tier admin — Story 6.10, Subtask 6.10.8.
//
// @smoke — proves the org tier works end-to-end from the shell, the
// customer-facing org admin path 6.10.5 ships:
//
//   Test 1 — the org admin arc: the always-present org control (panel 1),
//     org settings rename (panel 2), and cross-workspace member management
//     (panel 3) — invite an existing teammate to the org, change their role,
//     remove them, and page through the roster at scale (the at-scale rule,
//     finding #57 — a page control, never load-all). Asserts there is NO
//     active billing/credit/checkout surface (7.12.5 / Epic 8).
//
//   Test 2 — the org access gate + role composition: org membership GATES
//     workspace access (a member of a workspace but NOT of its org is denied,
//     404-not-403 — the no-leak posture), an org owner/admin spans every
//     workspace under the org (administers a member living in a workspace the
//     owner isn't in), and the multi-org switcher re-scopes the active org.
//
// Mirrors workspace-flows.spec.ts: the file-outbox email capture (1.1.6) for
// the workspace-invite accept, the db-reset helper (1.1.7), and the
// always-present org control's "New workspace" create path (6.10.5). The
// Better-Auth sign-up/sign-in rate limiter is disabled for the E2E dev server
// (E2E_DISABLE_RATE_LIMIT — playwright.config.ts), so back-to-back sign-ups
// from localhost don't flake and no wait-out loop is needed.

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { waitForEmail, extractInviteUrl } from './_helpers/email-capture';

const PASSWORD = 'org-admin-flow-pass-123';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  // Disconnect the worktree-side Prisma client so pg's pool doesn't keep the
  // Playwright runner alive past the last test (the 10s hang in CI).
  await db.$disconnect();
});

// Sign up a brand-new user via the two-step credentials flow → auto-provisioned
// org + default workspace, landing on /dashboard with a session cookie set. The
// rate limiter is gated OFF for the E2E dev server, so a single click is enough.
async function signUp(page: Page, email: string): Promise<void> {
  await page.goto('/sign-up');
  await page.getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Create a password').fill(PASSWORD);
  await page.getByRole('button', { name: /^(Create account|Creating account…)$/ }).click();
  await page.waitForURL('**/dashboard', { timeout: 30_000 });
}

// Navigate to an authed route, tolerating the rare post-sign-up race where the
// freshly-set session cookie hasn't propagated to the server component yet and
// the page bounces to /sign-in. One retry clears it.
async function gotoAuthed(page: Page, path: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(path);
    if (!page.url().includes('/sign-in')) return;
    await page.waitForTimeout(500);
  }
}

// Resolve the org a user owns (their auto-provisioned OPC org).
async function ownedOrgId(email: string): Promise<string> {
  const user = await db.user.findFirst({ where: { email } });
  expect(user, `user ${email} should exist`).not.toBeNull();
  const membership = await db.organizationMembership.findFirst({
    where: { userId: user!.id, role: 'owner' },
  });
  expect(membership, `${email} should own an org`).not.toBeNull();
  return membership!.organizationId;
}

// ── Test 1 — the org admin arc ──────────────────────────────────────────────

const T1_OWNER = 'e2e-org-owner@example.com';
const T1_DEE = 'e2e-org-dee@example.com';

test('@smoke org admin: org control, settings rename, cross-workspace members + pagination', async ({
  page,
}) => {
  await signUp(page, T1_OWNER);

  // Pre-seed an EXISTING Motir user to org-invite (addMemberByEmail resolves an
  // existing account; brand-new people join via a WORKSPACE invite instead).
  await db.user.create({ data: { email: T1_DEE, name: 'Dee Member' } });

  // ── Panel 1 — the always-present org control ──
  // The org is the permanent top-left anchor (progressive disclosure: an OPC is
  // just an org of one). Open the menu and confirm its entries; with a single
  // org there is NO "Switch organization" section.
  const orgMenu = page.getByRole('button', { name: 'Organization menu' });
  await expect(orgMenu).toBeVisible();
  await orgMenu.click();
  // Scope to href: the shell sidebar also has a "Settings" link (to
  // /settings/workspace) — the org menu's entries are the /settings/organization
  // ones.
  const orgSettingsLink = page.locator('a[href="/settings/organization"]');
  await expect(orgSettingsLink).toBeVisible();
  await expect(page.locator('a[href="/settings/organization/members"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /New workspace/ })).toBeVisible();
  // The billing entry is a PASSIVE placeholder (7.12.5 / Epic 8) — present as a
  // "Coming soon" affordance, never an active control.
  await expect(page.getByText('Billing & usage')).toBeVisible();
  await expect(page.getByText('Coming soon')).toBeVisible();
  // Single org → no switch-org section.
  await expect(page.getByText('Switch organization')).toHaveCount(0);

  // ── Panel 2 — org settings: rename ──
  await orgSettingsLink.click();
  await page.waitForURL('**/settings/organization');
  await expect(page.getByRole('heading', { name: 'Organization settings' })).toBeVisible();

  // No ACTIVE billing/credit/checkout control anywhere on the settings page
  // (the passive "added in a later release" note is allowed; an actionable
  // upgrade/checkout/payment control is not — 7.12.5 / Epic 8).
  await expect(
    page.getByRole('button', { name: /upgrade|checkout|pay|subscribe|manage plan|add card/i }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: /upgrade|checkout|pay|subscribe|manage plan|add card/i }),
  ).toHaveCount(0);

  const nameInput = page.getByLabel('Organization name');
  await nameInput.fill('Acme Org');
  const renameResponse = page.waitForResponse(
    (r) => /\/api\/organizations\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect((await renameResponse).status()).toBe(200);
  await expect(page.getByText('Organization updated').first()).toBeVisible();
  // The shell org control reflects the new name after the action revalidates.
  await expect(orgMenu).toContainText('Acme Org');

  // ── Panel 3 — cross-workspace member management ──
  await gotoAuthed(page, '/settings/organization/members');
  await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
  // Single member → the first-run empty state, not a one-row roster.
  await expect(page.getByText('It’s just you so far')).toBeVisible();

  // Invite the existing teammate to the org (default role: Member). At a single
  // member the roster shows the first-run empty state, whose CTA ("Invite
  // people") opens the same invite modal as the roster header's "Invite to
  // organization…".
  await page.getByRole('button', { name: 'Invite people' }).click();
  const inviteDialog = page.getByRole('dialog');
  await inviteDialog.getByLabel('Email').fill(T1_DEE);
  const inviteResponse = page.waitForResponse(
    (r) => /\/api\/organizations\/[^/]+\/members$/.test(r.url()) && r.request().method() === 'POST',
  );
  await inviteDialog.getByRole('button', { name: 'Add to organization' }).click();
  expect((await inviteResponse).status()).toBe(201);
  await expect(page.getByText(`${T1_DEE} added to the organization`).first()).toBeVisible();

  // The roster now renders (2 people); Dee appears with org role Member and "No
  // workspaces" (org-only member — the asymmetric membership direction). Anchor
  // on Dee's unique role combobox: the success toast renders as an <li> naming
  // the same email, so an `li`/text match would collide in strict mode.
  await expect(page.getByText('2 people')).toBeVisible();
  const roleCombo = page.getByRole('combobox', { name: 'Organization role for Dee Member' });
  await expect(roleCombo).toBeVisible();
  const deeRow = page.locator('li').filter({ has: roleCombo });
  await expect(deeRow.getByText('No workspaces')).toBeVisible();

  // Change Dee's org role → Admin (inline edit; success IS the confirmation).
  await roleCombo.click();
  const roleChangeResponse = page.waitForResponse(
    (r) =>
      /\/api\/organizations\/[^/]+\/members\/[^/]+$/.test(r.url()) &&
      r.request().method() === 'PATCH',
  );
  await page.getByRole('option', { name: 'Admin', exact: true }).click();
  expect((await roleChangeResponse).status()).toBe(200);
  await expect(page.getByText('Role updated').first()).toBeVisible();

  // Remove Dee from the org → row disappears (back to the just-you empty state).
  const removeResponse = page.waitForResponse(
    (r) =>
      /\/api\/organizations\/[^/]+\/members\/[^/]+$/.test(r.url()) &&
      r.request().method() === 'DELETE',
  );
  await deeRow.getByRole('button', { name: 'Remove' }).click();
  expect((await removeResponse).status()).toBe(200);
  await expect(page.getByText('Dee Member removed from the organization').first()).toBeVisible();
  // Dee's row is gone — anchor on the (now-absent) role combobox, which never
  // appears in a toast.
  await expect(
    page.getByRole('combobox', { name: 'Organization role for Dee Member' }),
  ).toHaveCount(0);

  // ── At-scale: the roster PAGINATES (finding #57 — a page control, not
  // load-all). Seed 11 org members directly so the roster spans two pages
  // (page size 10), then drive the pager through the real UI. ──
  const orgId = await ownedOrgId(T1_OWNER);
  for (let i = 0; i < 11; i++) {
    const padded = String(i).padStart(2, '0');
    const u = await db.user.create({
      data: { email: `pg-${padded}@example.com`, name: `Pager Member ${padded}` },
    });
    await db.organizationMembership.create({
      data: { organizationId: orgId, userId: u.id, role: 'member' },
    });
  }

  await gotoAuthed(page, '/settings/organization/members');
  // Total is 12 (owner + 11), but only a single page is rendered — NOT all rows.
  await expect(page.getByText('12 people')).toBeVisible();
  await expect(page.getByText('Page 1 of 2')).toBeVisible();
  const memberRows = page.locator('li').filter({ hasText: '@example.com' });
  await expect(memberRows).toHaveCount(10);
  const prev = page.getByRole('button', { name: 'Prev' });
  const next = page.getByRole('button', { name: 'Next' });
  await expect(prev).toBeDisabled();
  await expect(next).toBeEnabled();
  // The highest-id member is on page 2 — absent from page 1 (proves not-load-all).
  await expect(page.getByText('Pager Member 10', { exact: true })).toHaveCount(0);

  // Next → page 2 (await the fetch, never race the count).
  const pageTwoResponse = page.waitForResponse(
    (r) => /\/api\/organizations\/[^/]+\/members\?/.test(r.url()) && r.request().method() === 'GET',
  );
  await next.click();
  expect((await pageTwoResponse).status()).toBe(200);
  await expect(page.getByText('Page 2 of 2')).toBeVisible();
  await expect(page.getByText('Pager Member 10', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Prev' })).toBeEnabled();
});

// ── Test 2 — the org access gate + role composition + multi-org switch ───────

const T2_OWNER = 'e2e-org-gate-owner@example.com';
const T2_C = 'e2e-org-gate-c@example.com';

// The workspace-invite accept needs a fresh browser context for the second user
// plus the email round-trip, so give this flow more than the 30s default.
test.setTimeout(75_000);

test('@smoke org gate: membership gates workspace access (404-not-403), admin spans workspaces, multi-org switch', async ({
  browser,
  page,
}) => {
  // ── Owner (org A + workspace WA) ──
  await signUp(page, T2_OWNER);
  const orgA = await ownedOrgId(T2_OWNER);
  const ownerUser = (await db.user.findFirst({ where: { email: T2_OWNER } }))!;
  const wa = (await db.workspace.findFirst({ where: { organizationId: orgA } }))!;

  // ── A second user C signs up (their own org + workspace) ──
  const ctxC: BrowserContext = await browser.newContext();
  const pageC = await ctxC.newPage();
  await signUp(pageC, T2_C);
  const cUser = (await db.user.findFirst({ where: { email: T2_C } }))!;

  // ── Owner invites C to workspace WA; C accepts → C joins WA AND org A
  // (the UPWARD auto-join invariant: you can't be in a workspace without its
  // org). This is how a brand-new person enters an org. ──
  await gotoAuthed(page, '/settings/workspace');
  await page.getByRole('button', { name: 'Invite' }).click();
  const wsInviteDialog = page.getByRole('dialog');
  await wsInviteDialog.getByLabel('Email address').fill(T2_C);
  await wsInviteDialog.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByText(`Invite sent to ${T2_C}`).first()).toBeVisible();

  const inviteEmail = await waitForEmail(T2_C);
  const acceptUrl = extractInviteUrl(inviteEmail);
  await pageC.goto(acceptUrl);
  await pageC.getByRole('button', { name: 'Accept invite' }).click();
  await pageC.waitForURL('**/dashboard');

  // C is now a member of WA and of org A (verify the auto-join wrote the row).
  const cInWa = await db.workspaceMembership.findFirst({
    where: { userId: cUser.id, workspaceId: wa.id },
  });
  expect(cInWa, 'C should be a member of workspace WA after accepting').not.toBeNull();
  const cInOrgA = await db.organizationMembership.findFirst({
    where: { userId: cUser.id, organizationId: orgA },
  });
  expect(cInOrgA, 'accepting a workspace invite auto-joins its org').not.toBeNull();

  // C's own (auto-provisioned) workspace — the deterministic fallback the gated
  // resolver lands on once C loses org A (findFirstByUserWithWorkspace orders by
  // createdAt asc, and C's own workspace predates the WA membership).
  const cOwnWorkspace = (await db.workspace.findFirst({
    where: { memberships: { some: { userId: cUser.id, role: 'owner' } } },
  }))!;

  // ── Positive: while C is in org A, the GATED shell context resolves WA as the
  // active workspace (org membership present + workspace membership present). Pin
  // the cookie to WA and read it back through the real workspace-settings surface
  // (getWorkspaceContext → resolveActiveWorkspace, the org-gated path). ──
  await pageC.context().addCookies([{ name: 'workspace_id', value: wa.id, url: pageC.url() }]);
  await gotoAuthed(pageC, '/settings/workspace');
  await expect(pageC.getByLabel('Workspace name')).toHaveValue(wa.name);

  // ── Org admin SPANS all workspaces. Build a SECOND workspace WB under org A
  // that C belongs to but the OWNER does NOT (org A's existing workspace is
  // WA, where the owner lives). The owner — an org owner — still administers
  // members across WB via the cross-workspace roster, which is "admin-equivalent
  // access to every workspace under the org" made observable. ──
  const wb = await db.workspace.create({
    data: { name: 'Side WS A', slug: `side-ws-a-${Date.now()}`, organizationId: orgA },
  });
  await db.workspaceMembership.create({
    data: { userId: cUser.id, workspaceId: wb.id, role: 'member' },
  });
  // The owner is NOT a member of WB.
  expect(
    await db.workspaceMembership.findFirst({ where: { userId: ownerUser.id, workspaceId: wb.id } }),
  ).toBeNull();

  // The owner's cross-workspace roster shows C across BOTH WA and WB — including
  // WB, a workspace the owner isn't a member of (org admin spans all workspaces).
  await gotoAuthed(page, '/settings/organization/members');
  await expect(page.getByText('2 people')).toBeVisible();
  const cRow = page.locator('li').filter({ hasText: T2_C });
  await expect(cRow).toBeVisible();
  await expect(cRow.getByText('Side WS A')).toBeVisible();

  // ── Multi-org switch: C belongs to TWO orgs (their own + org A), so the org
  // menu's "Switch organization" section is revealed and re-scopes. The active
  // org currently derives from C's active workspace WA (org A); switching to C's
  // own org flips the active org + workspace together. ──
  const orgAName = (await db.organization.findUnique({ where: { id: orgA } }))!.name;
  const cOwnOrg = (await db.organization.findFirst({
    where: { memberships: { some: { userId: cUser.id, role: 'owner' } } },
  }))!;
  await pageC.getByRole('button', { name: 'Organization menu' }).click();
  await expect(pageC.getByText('Switch organization')).toBeVisible();
  await expect(pageC.getByRole('button', { name: 'Organization menu' })).toContainText(orgAName);
  // Both orgs are listed; switch to C's own org and confirm the active org flips.
  await pageC.getByRole('button', { name: cOwnOrg.name }).click();
  await expect(pageC.getByRole('button', { name: 'Organization menu' })).toContainText(
    cOwnOrg.name,
  );

  // ── The gate: remove C from org A through the real roster UI. removeMember is
  // asymmetric — it drops the ORG membership but deliberately leaves C's
  // workspace_membership row in WA intact. ──
  const removeResponse = page.waitForResponse(
    (r) =>
      /\/api\/organizations\/[^/]+\/members\/[^/]+$/.test(r.url()) &&
      r.request().method() === 'DELETE',
  );
  await cRow.getByRole('button', { name: 'Remove' }).click();
  expect((await removeResponse).status()).toBe(200);
  await expect(page.locator('li').filter({ hasText: T2_C })).toHaveCount(0);

  // The desync is exactly "member of a workspace, NOT of its org".
  expect(
    await db.workspaceMembership.findFirst({ where: { userId: cUser.id, workspaceId: wa.id } }),
    'workspace membership row survives org removal (the asymmetry)',
  ).not.toBeNull();
  expect(
    await db.organizationMembership.findFirst({
      where: { userId: cUser.id, organizationId: orgA },
    }),
    'org membership is gone',
  ).toBeNull();

  // ── Negative: org membership GATES workspace access. C's stale WA workspace
  // membership no longer resolves WA — the gated shell context (resolveActive-
  // Workspace) denies the org-less candidate and falls back to C's OWN
  // workspace. Re-pin the cookie to WA and confirm the surface shows C's own
  // workspace, NOT WA (the gate, never a leak). ──
  await pageC.context().addCookies([{ name: 'workspace_id', value: wa.id, url: pageC.url() }]);
  await gotoAuthed(pageC, '/settings/workspace');
  await expect(pageC.getByLabel('Workspace name')).toHaveValue(cOwnWorkspace.name);
  await expect(pageC.getByLabel('Workspace name')).not.toHaveValue(wa.name);

  // And C, no longer an org member, sees org A as NOT-FOUND (404), never
  // forbidden (403) — the cross-tenant no-leak posture (404-not-403).
  const orgMembersRes = await pageC.request.get(`/api/organizations/${orgA}/members`);
  expect(orgMembersRes.status(), 'non-org-member sees the org as 404, not 403').toBe(404);

  await ctxC.close();
});
