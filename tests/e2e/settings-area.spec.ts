// E2E: the project-settings AREA (Story 6.5 · Subtask 6.5.4) — the story-closing
// journey proven end-to-end over the real stack. It drives the verification
// recipe the area was built to satisfy:
//
//   1. ENTER from the app sidebar → land on Details (identity + the danger zone)
//      inside the grouped settings nav (the verified mirror "settings opens on
//      Details" rule);
//   2. WALK every section via the nav — Members & access, Workflow, Boards,
//      Estimation, Fields, Components — asserting the active state tracks and
//      every page URL is unchanged (zero deep-link breakage);
//   3. DIRECT-NAV a section in a FRESH context (`/settings/project/workflow`) —
//      the area chrome is present without any client-side navigation into it;
//   4. the COMMAND PALETTE deep-links into a section (entries generated from the
//      6.5.2 registry);
//   5. a NON-ADMIN member sees Details read-only WITHOUT the danger zone, with
//      the full nav (members VIEW every section);
//   6. the nav collapses into the mobile DRAWER at narrow width;
//   7. a11y: a strict axe sweep over the area chrome + Details + a re-housed
//      page, plus keyboard-operability of the whole nav.
//
// The browse/edit/manage POLICY matrix (level × role) is proven exhaustively at
// the integration tier (tests/settings/settings-area-access-matrix.test.ts) and
// the registry's pure totality + grouping at the unit tier
// (tests/settings/projectSettingsNav.test.ts) — this spec does NOT re-assert
// those; it drives the user-visible AREA behaviours through the browser.
//
// Tenant setup follows the project-access.spec precedent: a multi-user,
// one-workspace scenario can't be reached through the sign-up UI (each sign-up
// mints its own workspace), so personas are seeded through the shipped services
// (usersService gives each a sign-in-able credential account) and the
// active-project pin uses the test-sanctioned direct DB reach (BYPASSRLS on the
// dev/CI DB). The area chrome + nav + gating are what the browser then exercises.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';

const PWD = 'settings-area-e2e-pass-123';
const PROJECT_NAME = 'Area Project';
const PROJECT_KEY = 'AREA';

// WCAG 2.1 Level A + AA — the same ruleset the shell a11y sweep names. Scoped
// explicitly so the bar can't drift when axe-core bumps.
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// The re-housed sections, in nav order, with their preserved URLs. The journey
// clicks each nav entry and asserts the URL + the active state — the area's
// "routes preserved, only the landing moves" contract.
const SECTIONS: { label: string; path: string }[] = [
  { label: 'Members & access', path: '/settings/project/members' },
  { label: 'Workflow', path: '/settings/project/workflow' },
  { label: 'Boards', path: '/settings/project/board' },
  { label: 'Estimation', path: '/settings/project/estimation' },
  { label: 'Fields', path: '/settings/project/fields' },
  { label: 'Components', path: '/settings/project/components' },
];

interface Tenant {
  workspaceId: string;
  projectId: string;
  ownerEmail: string;
}

async function makeUser(email: string, name: string): Promise<{ id: string; email: string }> {
  const u = await usersService.createUser({ email, password: PWD, name });
  return { id: u.id, email };
}

async function pinActiveProject(userId: string, tenant: Tenant): Promise<void> {
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId, workspaceId: tenant.workspaceId } },
    data: { activeProjectId: tenant.projectId },
  });
}

// Stand up an owner + workspace + one open project, owner pinned active so the
// active-project-scoped settings routes resolve on every render.
async function seedTenant(ownerEmail: string): Promise<Tenant> {
  const owner = await makeUser(ownerEmail, 'Olivia Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Area Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: PROJECT_NAME,
    identifier: PROJECT_KEY,
  });
  const tenant: Tenant = { workspaceId: workspace.id, projectId: project.id, ownerEmail };
  await pinActiveProject(owner.id, tenant);
  return tenant;
}

// The grouped settings nav landmark (the rail's `<nav aria-label="Project
// settings">`), scoped so section clicks/active-state checks never collide with
// page content.
function settingsNav(page: Page) {
  return page.getByRole('navigation', { name: 'Project settings' });
}

async function resolveMod(page: Page): Promise<'Meta' | 'Control'> {
  const isMac = await page.evaluate(() => /mac|iphone|ipad|ipod/i.test(navigator.platform));
  return isMac ? 'Meta' : 'Control';
}

test.describe('settings-area — the project-settings area journey', () => {
  // Several credential accounts hashed (argon2) + multiple real sign-ins per
  // test — generous headroom over the 30s default.
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async () => {
    await resetDatabase();
  });

  test.afterAll(async () => {
    // Release the worktree-side Prisma pool so it doesn't keep the runner alive.
    await db.$disconnect();
  });

  test('@smoke enter from the sidebar → Details + danger zone → walk every section → command-palette deep-link', async ({
    page,
  }) => {
    const tenant = await seedTenant('sa-owner-1@example.com');
    await signIn(page, tenant.ownerEmail, PWD);

    // ── 1. Enter the area from the app sidebar → lands on Details ─────────────
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.waitForURL('**/settings/project');
    await expect(page.getByRole('heading', { name: 'Details', exact: true })).toBeVisible();
    // The grouped settings nav replaced the project nav (the area chrome).
    await expect(settingsNav(page)).toBeVisible();
    // Details is the active entry (the mirror "settings opens on Details" rule).
    await expect(settingsNav(page).getByRole('link', { name: 'Details' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // The owner is an admin → the re-homed Archive danger zone is present.
    await expect(page.getByRole('heading', { name: 'Danger zone' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();

    // ── 2. Walk every section via the nav: active state tracks, URLs unchanged ─
    for (const section of SECTIONS) {
      await settingsNav(page).getByRole('link', { name: section.label, exact: true }).click();
      await page.waitForURL(`**${section.path}`);
      expect(new URL(page.url()).pathname).toBe(section.path);
      await expect(
        settingsNav(page).getByRole('link', { name: section.label, exact: true }),
      ).toHaveAttribute('aria-current', 'page');
      // The grouped nav stays mounted on every section (it owns orientation now —
      // the per-page back-crumb is gone).
      await expect(settingsNav(page)).toBeVisible();
    }
    // Details is no longer active once we've left it.
    await expect(settingsNav(page).getByRole('link', { name: 'Details' })).not.toHaveAttribute(
      'aria-current',
      'page',
    );

    // ── 4. Command palette deep-links into a section (from the registry) ──────
    const mod = await resolveMod(page);
    await page.keyboard.press(`${mod}+k`);
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await page.keyboard.type('Estimation');
    await palette.getByRole('option', { name: 'Estimation' }).first().click();
    await page.waitForURL('**/settings/project/estimation');
    await expect(
      settingsNav(page).getByRole('link', { name: 'Estimation', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
  });

  test('a section URL resolves directly in a fresh context — the area chrome is present (no link breakage)', async ({
    browser,
  }) => {
    const tenant = await seedTenant('sa-owner-2@example.com');

    // A brand-new browser context (no client-side nav into the area) signs in,
    // then hits the deep URL directly — the preserved route renders inside the
    // area chrome.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signIn(page, tenant.ownerEmail, PWD);
    await page.goto('/settings/project/workflow');
    await expect(page.getByRole('heading', { name: 'Workflow', exact: true })).toBeVisible();
    await expect(settingsNav(page)).toBeVisible();
    await expect(
      settingsNav(page).getByRole('link', { name: 'Workflow', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await ctx.close();
  });

  test('a non-admin member sees Details read-only WITHOUT the danger zone, with the full nav', async ({
    page,
  }) => {
    const tenant = await seedTenant('sa-owner-3@example.com');
    // A plain workspace member (no project admin role) on the open project: can
    // browse every settings section (members VIEW all), but cannot manage — so
    // the Details danger zone is hidden.
    const member = await makeUser('sa-member@example.com', 'Mary Member');
    await workspacesService.addMember({ userId: member.id, workspaceId: tenant.workspaceId });
    await pinActiveProject(member.id, tenant);

    await signIn(page, member.email, PWD);
    await page.goto('/settings/project');
    await expect(page.getByRole('heading', { name: 'Details', exact: true })).toBeVisible();
    // The member sees the full nav (no nav leak in either direction).
    await expect(settingsNav(page)).toBeVisible();
    await expect(
      settingsNav(page).getByRole('link', { name: 'Workflow', exact: true }),
    ).toBeVisible();
    // …but NOT the admin-only danger zone.
    await expect(page.getByRole('heading', { name: 'Danger zone' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
  });

  test('the settings nav collapses into the mobile drawer at narrow width', async ({ page }) => {
    const tenant = await seedTenant('sa-owner-4@example.com');
    await signIn(page, tenant.ownerEmail, PWD);
    await page.goto('/settings/project');
    await expect(page.getByRole('heading', { name: 'Details', exact: true })).toBeVisible();

    // Drop below md (768px): the persistent rail hides, the hamburger appears.
    await page.setViewportSize({ width: 375, height: 812 });
    const hamburger = page.getByRole('button', { name: 'Open navigation' });
    await expect(hamburger).toBeVisible();

    // Open the off-canvas drawer → it carries the SAME grouped settings nav.
    await hamburger.click();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Details' })).toBeVisible();

    // Navigate via a drawer settings entry → route changes → drawer auto-closes.
    await drawer.getByRole('link', { name: 'Workflow', exact: true }).click();
    await page.waitForURL('**/settings/project/workflow');
    await expect(drawer).toBeHidden();
  });

  test('@a11y the area chrome + Details + a re-housed page are axe-clean, and the nav is keyboard-operable', async ({
    page,
  }) => {
    const tenant = await seedTenant('sa-owner-5@example.com');
    await signIn(page, tenant.ownerEmail, PWD);

    // Details + the area chrome.
    await page.goto('/settings/project');
    await expect(page.getByRole('heading', { name: 'Details', exact: true })).toBeVisible();
    const detailsResults = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(
      detailsResults.violations,
      formatViolations('/settings/project', detailsResults.violations as AxeViolation[]),
    ).toEqual([]);

    // A re-housed page inside the same chrome.
    await page.goto('/settings/project/workflow');
    await expect(page.getByRole('heading', { name: 'Workflow', exact: true })).toBeVisible();
    const workflowResults = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(
      workflowResults.violations,
      formatViolations('/settings/project/workflow', workflowResults.violations as AxeViolation[]),
    ).toEqual([]);

    // Keyboard-operability: every settings nav entry is a real, focusable
    // control (a link in tab order) — focus each and assert it takes focus.
    const nav = settingsNav(page);
    for (const label of ['Details', ...SECTIONS.map((s) => s.label)]) {
      const link = nav.getByRole('link', { name: label, exact: true });
      await link.focus();
      await expect(link).toBeFocused();
    }
  });
});

interface AxeViolation {
  id: string;
  impact?: string | null;
  help: string;
  helpUrl: string;
  nodes: { target: unknown[] }[];
}

// Render axe violations as a readable block so a CI failure points straight at
// the rule + element (mirrors shell-a11y.spec's formatter).
function formatViolations(route: string, violations: AxeViolation[]): string {
  const lines = violations.map((v) => {
    const selectors = v.nodes.map((n) => `      - ${JSON.stringify(n.target)}`).join('\n');
    return `  [${v.impact ?? 'n/a'}] ${v.id}: ${v.help}\n    ${v.helpUrl}\n${selectors}`;
  });
  return `axe found ${violations.length} violation(s) on ${route}:\n${lines.join('\n')}`;
}
