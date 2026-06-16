// E2E: Story 6.17 — START / STOP "building in public" + the status badge +
// access gating (Subtask 6.17.5). The full build-in-public toggle loop in a real
// browser, proving the 6.17.3 discoverable entry + the 6.17.2 explainer/confirm +
// the 6.17.4 status badge / stop-manage path + the admin gate, end to end:
//
//   1. an ADMIN on a NON-public project sees the PRIMARY discoverable entry — the
//      project-shell header "Build in public" CTA (6.17.3) — opens the confirm
//      dialog (6.17.2), confirms "Start building in public" → the project goes
//      `public`: the header CTA disappears, the settings access row shows the
//      "Building in public" status badge + a Stop action, and the public page
//      (`/p/<key>`) is reachable with NO session (the public top bar carries the
//      same badge);
//   2. the admin STOPS via the settings manage row → confirms "Stop building in
//      public" → the project leaves `public`: the badge clears, the header CTA
//      returns, and the public page is no longer reachable (404);
//   3. a NON-admin member gets NO entry CTA on a non-public project (the header
//      action is hidden + the settings `public` radio is disabled), and on a
//      public project sees the badge READ-ONLY — no Stop action.
//
// Division of labour: the component tier (tests/components/build-in-public-*.test
// .tsx, project-members-settings.test.tsx) pins the dialog open/confirm/refresh
// wiring + the per-role affordance rendering; this spec owns the thing only a
// browser proves — the real CTA → dialog → access write, the cross-surface badge,
// the public-page reachability flip, and the admin gate, against a real Postgres
// + the shipped routes.
//
// Setup mirrors project-access.spec.ts: a multi-user one-workspace tenant can't
// be reached through the sign-up UI (each sign-up mints its OWN workspace), so the
// personas + project roles are seeded through the shipped services + the
// test-sanctioned direct DB reach (the dev/CI DB runs BYPASSRLS); the make-public
// / stop toggles and every read are then driven through the BROWSER — the surface
// under test. Going public is performed in-UI (never a DB shortcut) because the
// toggle IS what's under test; the non-admin leg flips access DIRECTLY so the
// non-admin stays a non-manager observing the gate.
//
// Per the E2E discipline (CLAUDE.md): every access mutation is awaited on the
// PATCH response (status 200) armed BEFORE the click, and each effect is asserted
// on a post-reload authoritative read (or the anon page's HTTP status) — never on
// the optimistic island alone, and with no `waitForTimeout` syncs.

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';

test.describe('build-in-public — start/stop + badge + access gating', () => {
  // Several hashed credential accounts + multiple real sign-ins per test —
  // generous headroom over the 30s default, matching project-access.spec.
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async () => {
    await resetDatabase();
  });

  test.afterAll(async () => {
    // Release the worktree-side Prisma pool so it doesn't keep the runner alive
    // past the last test (mirrors project-access / multi-tenant-isolation).
    await db.$disconnect();
  });

  const PWD = 'build-in-public-e2e-pass-123';

  // The resolved copy (messages/en.json › settings.buildInPublic / access).
  const ENTRY_CTA = 'Build in public'; // header discoverable entry (entryButton)
  const START_CONFIRM = 'Start building in public'; // dialog confirm (confirmCta)
  const STOP_ACTION = 'Stop'; // manage-row danger button (stop)
  const STOP_CONFIRM = 'Stop building in public'; // stop-dialog confirm (stopConfirmCta)
  const STATUS_BADGE = 'Building in public'; // the 6.17.4 status badge
  const ACCESS_GROUP = 'Project access level'; // access.levelGroupLabel

  interface Persona {
    id: string;
    email: string;
  }
  interface Tenant {
    workspaceId: string;
    projectId: string;
    projectKey: string;
  }

  async function makeUser(email: string, name: string): Promise<Persona> {
    const u = await usersService.createUser({ email, password: PWD, name });
    return { id: u.id, email };
  }

  // Stand up an owner + workspace + one project (default `open` = non-public)
  // holding a couple of work items so the public board/list render real content
  // rather than the empty state. The owner is a workspace manager (the always-pass
  // `canManage` tier — the project admin for this flow).
  async function seedTenant(ownerEmail: string, projectKey: string): Promise<Tenant> {
    const owner = await makeUser(ownerEmail, 'Olivia Owner');
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Build-in-Public Workspace',
      ownerUserId: owner.id,
    });
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Public Portal',
      identifier: projectKey,
    });
    const ctx = { userId: owner.id, workspaceId: workspace.id };
    await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'Dark mode for the dashboard', parentId: null },
      ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'Export the board to CSV', parentId: null },
      ctx,
    );
    // Pin the project active so the active-project-scoped routes (/dashboard,
    // /settings/project/*) resolve it for the owner on every render.
    await db.workspaceMembership.update({
      where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
    return { workspaceId: workspace.id, projectId: project.id, projectKey };
  }

  // A workspace member with an explicit project role, pinned to the project —
  // the controlled, non-manager persona the gating leg needs. A workspace
  // `member` + project `member` is NOT a manager (`canManage` is false), so the
  // entry CTA + Stop must be hidden for them.
  async function addMember(
    email: string,
    name: string,
    tenant: Tenant,
    role: 'admin' | 'member' | 'viewer',
  ): Promise<Persona> {
    const p = await makeUser(email, name);
    await workspacesService.addMember({ userId: p.id, workspaceId: tenant.workspaceId });
    await db.projectMembership.create({
      data: {
        userId: p.id,
        workspaceId: tenant.workspaceId,
        projectId: tenant.projectId,
        role,
      },
    });
    await db.workspaceMembership.update({
      where: { userId_workspaceId: { userId: p.id, workspaceId: tenant.workspaceId } },
      data: { activeProjectId: tenant.projectId },
    });
    return p;
  }

  // Arm the access-write wait BEFORE the action (CLAUDE.md: never miss it). Both
  // start (→ public) and stop (→ open) PATCH the same endpoint.
  function accessWrite(page: Page, projectKey: string) {
    return page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/api/projects/${projectKey}/access` &&
        r.request().method() === 'PATCH',
    );
  }

  // The 6.17.4 status-badge / manage row (only rendered while public). The bare
  // "Building in public" string also appears on the access card (the `public`
  // radio label + the AccessSummaryPill), so the status-badge assertion MUST be
  // scoped to the manage row — the "View public page" link's parent flex row,
  // which holds the badge + the public path but NOT the access card — or it
  // trips Playwright's strict-mode multi-match. (The link is unique to this row.)
  function manageRow(page: Page) {
    return page.getByRole('link', { name: 'View public page' }).locator('..');
  }

  test('@smoke admin starts then stops building in public: the header CTA → confirm flips the project public (badge + reachable public page), and Stop flips it back (badge clears + public page 404)', async ({
    page,
    browser,
  }) => {
    const tenant = await seedTenant('bip-admin@example.com', 'BIP');
    const KEY = tenant.projectKey;
    await signIn(page, 'bip-admin@example.com', PWD);

    // ── 1. admin on a NON-public project: the discoverable header CTA shows ────
    await page.goto('/dashboard');
    const entryCta = page.getByRole('button', { name: ENTRY_CTA, exact: true });
    await expect(entryCta).toBeVisible({ timeout: 30_000 });

    // Open the explainer/confirm dialog (6.17.2) and confirm "Start building in
    // public" — the access write fires on the dialog confirm, not the CTA click.
    const goPublic = accessWrite(page, KEY);
    await entryCta.click();
    const startDialog = page.getByRole('dialog');
    await expect(startDialog).toBeVisible();
    await startDialog.getByRole('button', { name: START_CONFIRM }).click();
    expect((await goPublic).status(), 'start → public returns 200').toBe(200);

    // The header CTA is server-gated on the (now-public) access level — after the
    // write's router.refresh re-renders the shell it disappears. Reload for an
    // authoritative server read rather than trusting the refresh race.
    await page.goto('/dashboard');
    await expect(page.getByRole('button', { name: ENTRY_CTA, exact: true })).toHaveCount(0);

    // The settings access row now carries the "Building in public" status badge +
    // a Stop action (admin) + the View-public-page link (post-reload authoritative).
    // The badge is asserted INSIDE the manage card (the bare string also appears
    // on the access card — see manageCard()).
    await page.goto('/settings/project/members');
    await expect(manageRow(page).getByText(STATUS_BADGE, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('button', { name: STOP_ACTION, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'View public page' })).toHaveAttribute(
      'href',
      `/p/${KEY}`,
    );

    // The public page is reachable with NO session, and its top bar shows the same
    // status badge — the status reads identically to visitors and the team.
    const anonCtx: BrowserContext = await browser.newContext();
    const anon = await anonCtx.newPage();
    const liveRes = await anon.goto(`/p/${KEY}`);
    expect(liveRes?.status(), 'public page is 200 with no session once public').toBe(200);
    await expect(anon.getByText(STATUS_BADGE, { exact: true }).first()).toBeVisible();

    // ── 2. admin STOPS building in public via the manage row ──────────────────
    const goPrivate = accessWrite(page, KEY);
    await page.getByRole('button', { name: STOP_ACTION, exact: true }).click();
    const stopDialog = page.getByRole('dialog');
    await expect(stopDialog).toBeVisible();
    await stopDialog.getByRole('button', { name: STOP_CONFIRM }).click();
    expect((await goPrivate).status(), 'stop → leaves public returns 200').toBe(200);

    // Authoritative reload: the badge + Stop are gone (the project is no longer
    // public — the whole manage card unmounts), and the header CTA has returned.
    await page.goto('/settings/project/members');
    await expect(page.getByRole('link', { name: 'View public page' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: STOP_ACTION, exact: true })).toHaveCount(0);
    await page.goto('/dashboard');
    await expect(page.getByRole('button', { name: ENTRY_CTA, exact: true })).toBeVisible({
      timeout: 30_000,
    });

    // The public page is no longer reachable — a non-public project is 404 (the
    // public-read exception is gone the moment the project leaves `public`).
    const goneRes = await anon.goto(`/p/${KEY}`);
    expect(goneRes?.status(), 'public page is 404 once no longer public').toBe(404);

    await anonCtx.close();
  });

  test('a non-admin gets no entry CTA on a non-public project and only a read-only badge (no Stop) on a public one', async ({
    page,
  }) => {
    const tenant = await seedTenant('bip-owner-2@example.com', 'BIN');
    // A genuine non-manager: workspace member + project member (NOT admin).
    await addMember('bip-member@example.com', 'Mary Member', tenant, 'member');

    await signIn(page, 'bip-member@example.com', PWD);

    // ── 3a. NON-public project: the non-admin sees NO discoverable entry CTA ───
    await page.goto('/dashboard');
    // The shell renders (a project page loaded), but the admin-only header CTA is
    // absent — the entry point is gated server-side on `canManage`.
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('button', { name: ENTRY_CTA, exact: true })).toHaveCount(0);

    // In settings the access control renders read-only: the `public` ("Building in
    // public") radio is present but DISABLED — a non-admin cannot start either.
    await page.goto('/settings/project/members');
    const accessGroup = page.getByRole('radiogroup', { name: ACCESS_GROUP });
    await expect(accessGroup).toBeVisible({ timeout: 30_000 });
    await expect(accessGroup.getByRole('radio', { name: /^Building in public/ })).toBeDisabled();

    // ── 3b. PUBLIC project: the non-admin sees the badge READ-ONLY, no Stop ────
    // Flip access directly (the non-admin can't, and the admin make-public flow is
    // covered by test 1) so this leg isolates the per-role manage gating.
    await db.project.update({ where: { id: tenant.projectId }, data: { accessLevel: 'public' } });

    await page.goto('/settings/project/members');
    await expect(manageRow(page).getByText(STATUS_BADGE, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    // No Stop action for a non-admin — the manage gate stays legible (badge + link
    // read-only) rather than the control vanishing entirely.
    await expect(page.getByRole('button', { name: STOP_ACTION, exact: true })).toHaveCount(0);
    // The read-only "View public page" link is still offered.
    await expect(page.getByRole('link', { name: 'View public page' })).toBeVisible();
  });
});
