// E2E: project access gating (Story 6.4 · Subtask 6.4.8) — the browse/edit gate
// proven end-to-end over the real stack. This is the focused E2E half of 6.4.8;
// the browse/edit POLICY matrix (level × role + the owner/admin bypass), the
// workspace-role migration defaults, the go-private member-seeding, the
// last-admin guard, and assignable-users scoping are already covered exhaustively
// at the unit/component tier (tests/project-access-service.test.ts,
// project-members-service.test.ts, project-membership-rls.test.ts,
// project-access-ui-gating.test.ts, components/project-{members-settings,access-
// affordances}.test.tsx). This spec does NOT re-assert those predicates — it
// drives the four user-visible behaviours the recipe calls out, through the
// browser, against a real Postgres + the shipped services/routes:
//
//   1. a PRIVATE project denies a non-member — absent from the switcher's
//      switch-target list AND the no-access state (not a crash) on direct nav to
//      its board/items — then GRANTING a project membership lets them in;
//   2. a project VIEWER can browse but cannot edit (the "New work item"
//      affordance is disabled), while a MEMBER on the same project can;
//   3. a project ADMIN can manage members + access from the settings UI (add a
//      member via the real 6.4.4 API, flip the access level).
//
// ── How the tenant is built (the board-at-scale precedent) ───────────────────
// Project-access is a MULTI-user, one-workspace scenario (an owner + several
// members with distinct project roles + a genuine non-member). That state can't
// be reached cheaply through the sign-up UI (each sign-up mints its OWN
// workspace), so — exactly like tests/e2e/board-at-scale.spec.ts — we seed the
// prerequisites through the shipped services (usersService.createUser gives each
// persona a real, sign-in-able credential account; workspacesService /
// projectsService stand up the tenant) and set the project roles / access level /
// active-project pin via the test-sanctioned direct DB reach (the same reach
// board-at-scale uses for its active-project pin). The GATE itself is never
// seeded — it's what the browser then exercises.
//
// One subtlety the setup encodes: `setAccessLevel('private')` SEEDS every current
// workspace member as a project member (the no-lockout shape), so to keep a
// genuine NON-member we set `project.accessLevel` directly and grant project
// memberships explicitly — never through go-private.

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';

// All personas share one password — they're created via usersService (a real
// credential account), so `signIn` drives the production two-step sign-in.
const PWD = 'project-access-e2e-pass-123';
const PROJECT_NAME = 'Access Project';
const PROJECT_KEY = 'ACCP';

interface Persona {
  id: string;
  email: string;
}

interface Tenant {
  workspaceId: string;
  projectId: string;
  owner: Persona; // workspace owner — the always-pass tier
}

// Create a sign-in-able user and (optionally) add them to `workspaceId`. The
// owner is created with the workspace; everyone else is a plain workspace member
// added afterwards. Returns the persona so the test can pin/role them.
async function makeUser(email: string, name: string): Promise<Persona> {
  const u = await usersService.createUser({ email, password: PWD, name });
  return { id: u.id, email };
}

async function addToWorkspace(userId: string, workspaceId: string): Promise<void> {
  await workspacesService.addMember({ userId, workspaceId });
}

// Grant an explicit project membership with a role — the controlled alternative
// to go-private's blanket seeding (so a non-member can stay a non-member). The
// dev/CI test DB runs BYPASSRLS, so a direct write is the sanctioned setup reach
// (mirrors board-at-scale's active-project pin).
async function grantProjectRole(
  userId: string,
  tenant: Tenant,
  role: 'admin' | 'member' | 'viewer',
): Promise<void> {
  await db.projectMembership.create({
    data: { userId, workspaceId: tenant.workspaceId, projectId: tenant.projectId, role },
  });
}

// Pin a project as the user's active project so the active-project-scoped routes
// (/boards, /items, /settings/project/*) resolve it on every render — the same
// direct membership write board-at-scale uses.
async function pinActiveProject(userId: string, tenant: Tenant): Promise<void> {
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId, workspaceId: tenant.workspaceId } },
    data: { activeProjectId: tenant.projectId },
  });
}

// Set the project's access level directly (NO go-private seeding — see the file
// header). `open` is the create-time default; we flip to `private` for the gate.
async function setAccessLevel(
  tenant: Tenant,
  level: 'open' | 'limited' | 'private',
): Promise<void> {
  await db.project.update({ where: { id: tenant.projectId }, data: { accessLevel: level } });
}

// Stand up an owner + workspace + one open project. Personas are layered on per
// test (each test names exactly the roles it needs).
async function seedTenant(ownerEmail: string): Promise<Tenant> {
  const owner = await makeUser(ownerEmail, 'Olivia Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Access Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: PROJECT_NAME,
    identifier: PROJECT_KEY,
  });
  return { workspaceId: workspace.id, projectId: project.id, owner };
}

// The switcher popover (Radix-portaled, data-state=open), scoped past the toast
// region's role="list" exactly like project-isolation.spec — and its
// switch-target list. The list can legitimately be EMPTY (a non-member with no
// browsable project), so we sync on the popover PANEL being open, never the
// (possibly zero-size) list.
function switcherPopover(page: Page) {
  return page
    .locator('[data-state=open]')
    .filter({ has: page.getByText('Projects', { exact: true }) });
}

function switcherList(page: Page) {
  return switcherPopover(page).locator('ul[role=list]');
}

async function openSwitcher(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Switch project' }).click();
  await expect(switcherPopover(page)).toBeVisible();
}

// The board/items toolbar's "New work item" button — rendered ONLY in the
// can-browse branch (the no-access branch renders the NoAccessState with no
// toolbar), so its mere presence proves browse succeeded; its disabled state
// reflects canEdit. Both the toolbar AND the empty-state CTA render it, so scope
// to the first (toolbar) one to stay single-match whether the board is empty or
// populated.
function newWorkItemButton(page: Page) {
  return page.getByRole('button', { name: 'New work item' }).first();
}

test.describe('project-access — gating end-to-end', () => {
  // Heavy per-test setup (several credential accounts hashed + multiple real
  // sign-ins per test) — generous headroom over the 30s default.
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async () => {
    await resetDatabase();
  });

  test.afterAll(async () => {
    // Release the worktree-side Prisma pool so it doesn't keep the runner alive
    // past the last test (mirrors project-isolation / multi-tenant-isolation).
    await db.$disconnect();
  });

  test('@smoke a private project denies a non-member (no-access + hidden in switcher); granting membership lets them in', async ({
    page,
  }) => {
    const tenant = await seedTenant('pa-owner-1@example.com');
    // A genuine non-member: a workspace member with NO project membership. Pin
    // the (soon-private) project active so the active-project routes resolve it
    // — the "made private while pinned" path 6.4.6 renders the no-access state
    // for, rather than a crash.
    const outsider = await makeUser('pa-outsider@example.com', 'Nora Nonmember');
    await addToWorkspace(outsider.id, tenant.workspaceId);
    await pinActiveProject(outsider.id, tenant);
    // Set private DIRECTLY (not go-private) so the outsider stays a non-member.
    await setAccessLevel(tenant, 'private');

    await signIn(page, outsider.email, PWD);

    // ── Denied: the board renders the no-access state, not the board ──────────
    await page.goto('/boards');
    await expect(page.getByText(/access to this project/i)).toBeVisible();
    await expect(page.getByText(/this project is private/i)).toBeVisible();
    await expect(page.getByTestId('board')).toHaveCount(0);

    // ── Denied: the issue list also renders the no-access state ──────────────
    await page.goto('/items');
    await expect(page.getByText(/access to this project/i)).toBeVisible();

    // ── Hidden: the private project is not a switch target ────────────────────
    await openSwitcher(page);
    await expect(
      switcherList(page),
      "a non-member's switcher must not list the private project",
    ).not.toContainText(PROJECT_NAME);
    await page.keyboard.press('Escape');

    // ── Grant a project membership → the gate opens ───────────────────────────
    await grantProjectRole(outsider.id, tenant, 'member');

    await page.goto('/boards');
    // Browse now succeeds (the toolbar renders, NOT the no-access state) and the
    // member can edit — the create affordance is live.
    await expect(page.getByText(/access to this project/i)).toHaveCount(0);
    await expect(newWorkItemButton(page)).toBeEnabled({ timeout: 30_000 });

    // And the project is now a switch target.
    await openSwitcher(page);
    await expect(switcherList(page)).toContainText(PROJECT_NAME);
  });

  test('a project viewer can browse but cannot edit, while a member can', async ({ browser }) => {
    const tenant = await seedTenant('pa-owner-2@example.com');
    const viewer = await makeUser('pa-viewer@example.com', 'Vic Viewer');
    const member = await makeUser('pa-member@example.com', 'Mary Member');
    for (const p of [viewer, member]) {
      await addToWorkspace(p.id, tenant.workspaceId);
      await pinActiveProject(p.id, tenant);
    }
    await grantProjectRole(viewer.id, tenant, 'viewer');
    await grantProjectRole(member.id, tenant, 'member');
    await setAccessLevel(tenant, 'private');

    // ── Viewer: browses the board, but the create affordance is disabled ──────
    const viewerCtx: BrowserContext = await browser.newContext();
    const viewerPage = await viewerCtx.newPage();
    await signIn(viewerPage, viewer.email, PWD);
    await viewerPage.goto('/boards');
    // Browse succeeds (no no-access state), but the create affordance is disabled.
    await expect(viewerPage.getByText(/access to this project/i)).toHaveCount(0);
    await expect(
      newWorkItemButton(viewerPage),
      'a viewer must not be able to create work items',
    ).toBeDisabled({ timeout: 30_000 });
    await viewerCtx.close();

    // ── Member: same project, edit affordance is live ─────────────────────────
    const memberCtx: BrowserContext = await browser.newContext();
    const memberPage = await memberCtx.newPage();
    await signIn(memberPage, member.email, PWD);
    await memberPage.goto('/boards');
    await expect(memberPage.getByText(/access to this project/i)).toHaveCount(0);
    await expect(
      newWorkItemButton(memberPage),
      'a member must be able to create work items',
    ).toBeEnabled({ timeout: 30_000 });
    await memberCtx.close();
  });

  test('a project admin can manage members + access from the settings UI', async ({ page }) => {
    const tenant = await seedTenant('pa-owner-3@example.com');
    const admin = await makeUser('pa-admin@example.com', 'Ada Admin');
    const recruit = await makeUser('pa-recruit@example.com', 'Rita Recruit');
    for (const p of [admin, recruit]) {
      await addToWorkspace(p.id, tenant.workspaceId);
    }
    // The admin manages from the project-admin tier (a project role, not a
    // workspace-manager bypass), with the project active so /settings resolves it.
    await grantProjectRole(admin.id, tenant, 'admin');
    await pinActiveProject(admin.id, tenant);

    await signIn(page, admin.email, PWD);
    await page.goto('/settings/project/members');

    // The members panel + access controls render.
    await expect(page.getByRole('heading', { name: 'Access & members' })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Private/ })).toBeVisible();
    // The admin's own row is present (read-only self row → a role Pill, no select).
    await expect(page.getByText('Ada Admin')).toBeVisible();

    // ── Add the recruit through the real add-member combobox (6.4.4 POST) ─────
    const addPicker = page.getByRole('combobox', { name: 'Add a project member' });
    await addPicker.click();
    await page.getByRole('option', { name: /Rita Recruit/ }).click();
    // Once added, the recruit is a manageable member row — its per-row role
    // select (only rendered for project members the admin can manage) appears.
    await expect(page.getByRole('combobox', { name: 'Role for Rita Recruit' })).toBeVisible();

    // ── Flip the access level to Private (6.4.4 PATCH, optimistic) ────────────
    await page.getByRole('radio', { name: /Private/ }).click();
    await expect(page.getByRole('radio', { name: /Private/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});
