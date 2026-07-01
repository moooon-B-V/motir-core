// E2E: saved filters (Story 6.2 · Subtask 6.2.6) — the story-closing journey
// over the real stack (Next + Postgres), the Playwright half of Principle #18's
// Story-level review. The (role × visibility × action) permission matrix, the
// persist→resolve property suite, the subscription scheduler, and the
// as-subscriber delivery paths are already asserted exhaustively at the
// integration tier (tests/integration/saved-filters/*.test.ts +
// tests/savedFilters/*.test.ts) — this spec does NOT re-assert those predicates.
// It drives the user-visible journey the Story 6.2 verification recipe calls out,
// through the browser, plus the strict axe sweep over the save dialog, the
// [Saved] dropdown, the filters directory, and the subscription editor:
//
//   A. the AUTHOR builds a filter on /items → Save as (Project) → the applied
//      name chip → edits the builder → the dirty state → overwrite-Save; then
//      applies + stars it from the [Saved] dropdown;
//   B. a NON-OWNER applies the shared filter and edits it → Save-as ONLY (no
//      overwrite-Save) — the mirror's ownership split — while the author's
//      PRIVATE filter stays invisible to them (dropdown + directory);
//   C. an ADMIN manages from the directory — subscribe, change-owner, and
//      delete with the dependents warning ("1 subscription will be removed");
//   D. a VIEWER cannot publish into the project — the save dialog's Project
//      visibility is disabled under the member-role note.
//
// ── How the tenant is built (the project-access.spec precedent) ──────────────
// Saved filters are a MULTI-user, one-workspace, project-role scenario, which
// can't be reached through the sign-up UI (each sign-up mints its own
// workspace). So — exactly like tests/e2e/project-access.spec.ts — the personas
// + roles + the filters/subscriptions whose CONSUMING surface a test exercises
// are seeded through the shipped services (usersService for sign-in-able
// accounts; workspaces/projects/projectMembers for the tenant; savedFilters /
// savedFilterSubscriptions for pre-existing rows), and the active-project pin is
// the test-sanctioned direct DB reach (BYPASSRLS in dev/CI). The SAVE flow
// itself (Test A) is driven through the real UI; later tests seed the rows and
// drive the consuming surface.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { encodeFilterParam, FILTER_PARAM, type FilterAst } from '@/lib/filters/ast';

test.describe.configure({ timeout: 90_000 });

// WCAG 2.1 A + AA — the ruleset the AC names, scoped explicitly so the bar can't
// silently shift when axe-core bumps (the shell-a11y convention).
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const PWD = 'saved-filters-e2e-pass-123';
const PROJECT_NAME = 'Saved Filters';
const PROJECT_KEY = 'SF';

// A beyond-facet base AST (negation — can't down-convert to the facet bar, so
// the advanced builder owns it): Priority is none of Lowest. Priority is a fixed
// enum, so this needs no seeded workflow/labels and round-trips deterministically.
const BASE_AST: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'priority', operator: 'is_none_of', value: ['lowest'] }],
};
const BASE_PARAM = encodeFilterParam(BASE_AST);

interface Persona {
  id: string;
  email: string;
  name: string;
}

interface Tenant {
  workspaceId: string;
  projectId: string;
  projectKey: string;
  owner: Persona;
}

async function makeUser(email: string, name: string): Promise<Persona> {
  const u = await usersService.createUser({ email, password: PWD, name });
  return { id: u.id, email, name };
}

function ctxOf(p: Persona, tenant: Tenant): ServiceContext {
  return { userId: p.id, workspaceId: tenant.workspaceId };
}

// Stand up an owner + workspace + one open project. Personas are layered on per
// test (each names exactly the roles it needs).
async function seedTenant(ownerEmail: string): Promise<Tenant> {
  const owner = await makeUser(ownerEmail, 'Olivia Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Saved Filters Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: PROJECT_NAME,
    identifier: PROJECT_KEY,
  });
  return {
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    owner,
  };
}

// Enroll a persona in the workspace + project with a given project role, and pin
// the project active so /items + /filters resolve it on every render.
async function enroll(
  p: Persona,
  tenant: Tenant,
  role: 'admin' | 'member' | 'viewer',
): Promise<void> {
  await workspacesService.addMember({ userId: p.id, workspaceId: tenant.workspaceId });
  await projectMembersService.addMember({
    key: tenant.projectKey,
    actorUserId: tenant.owner.id,
    ctx: ctxOf(tenant.owner, tenant),
    targetUserId: p.id,
    role,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: p.id, workspaceId: tenant.workspaceId } },
    data: { activeProjectId: tenant.projectId },
  });
}

// Seed a saved filter directly through the service (the consuming surface, not
// the save flow, is the test's subject). Returns the created summary DTO.
async function seedFilter(
  tenant: Tenant,
  author: Persona,
  name: string,
  visibility: 'private' | 'project',
) {
  return savedFiltersService.create(
    tenant.projectKey,
    { name, visibility, filterParam: BASE_PARAM },
    ctxOf(author, tenant),
  );
}

async function signInAt(browser: Browser, p: Persona): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, p.email, PWD);
  return page;
}

// Add a Text-contains condition in the open advanced builder so the URL AST
// diverges from the saved envelope — the deterministic way to dirty an applied
// filter (a soft router.push that keeps the applied-session state mounted).
// Count-based + `.last()` rather than a hard-coded "Condition N": the row count
// depends on how the filter was applied, and we assert the row actually grew so
// a non-add fails fast instead of hanging on a never-appearing group.
async function dirtyViaBuilder(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Advanced/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Advanced filter' });
  await expect(dialog).toBeVisible();
  const rows = dialog.getByRole('group', { name: /^Condition / });
  const before = await rows.count();
  await dialog.getByRole('button', { name: 'Add condition' }).click();
  await expect(rows).toHaveCount(before + 1);
  const row = rows.last();
  await row.getByRole('combobox', { name: 'Field' }).click();
  await page.getByRole('option', { name: 'Text title + description' }).click();
  await row.getByRole('textbox', { name: 'Text values' }).fill('urgent');
  // The text row debounces 300ms before it live-applies to the URL.
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test.describe('saved filters', () => {
  test('@smoke author saves a filter, sees the applied chip + dirty state, overwrites, applies + stars', async ({
    page,
  }) => {
    const tenant = await seedTenant('sf-author-1@example.com');
    const author = await makeUser('sf-author-acct-1@example.com', 'Mara Member');
    await enroll(author, tenant, 'member');

    await signIn(page, author.email, PWD);

    // ── Build a beyond-facet filter via the URL (the 6.1.4 builder round-trip is
    //    proven in filter-builder.spec; here the filter is the SAVE flow's input).
    await page.goto(`/items?view=list&${FILTER_PARAM}=${encodeURIComponent(BASE_PARAM)}`);

    // ── Save as (Project): the applied bar's Save-as opens the dialog. ─────────
    await page.getByRole('button', { name: 'Save as' }).click();
    const saveDialog = page.getByRole('dialog', { name: 'Save filter' });
    await expect(saveDialog).toBeVisible();

    // axe sweep — the save dialog (strict).
    await expectNoAxe(page, '[role="dialog"]', 'save dialog');

    await saveDialog.getByLabel('Name').fill('Sprint blockers');
    // Pick Project visibility — the radio input is sr-only, so click its card
    // label (matched by the unique Project hint copy) to select it.
    await saveDialog
      .getByText('Everyone who can browse this project can see and apply it.')
      .click();
    await expect(saveDialog.getByRole('radio', { name: /Project/ })).toBeChecked();
    await saveDialog.getByRole('button', { name: 'Save filter' }).click();
    await expect(saveDialog).not.toBeVisible();

    // The applied name chip appears (shared-with-project variant).
    const chip = page.getByRole('button', {
      name: /Applied filter: Sprint blockers \(shared with project\)/,
    });
    await expect(chip).toBeVisible();
    // Freshly saved → not dirty.
    await expect(page.getByRole('status').filter({ hasText: 'Edited' })).toHaveCount(0);

    // ── Edit the builder → dirty marker + owner's overwrite-Save. ──────────────
    await dirtyViaBuilder(page);
    await expect(page.getByRole('status').filter({ hasText: 'Edited' })).toBeVisible();
    const saveBtn = page.getByRole('button', { name: 'Save', exact: true });
    await expect(saveBtn, 'the owner gets the overwrite-Save').toBeVisible();
    await saveBtn.click();
    await expect(page.getByText('Filter updated', { exact: true }).first()).toBeVisible();
    // Overwrite reconciled the row to the current URL → clean again.
    await expect(page.getByRole('status').filter({ hasText: 'Edited' })).toHaveCount(0);

    // ── Apply + star from the [Saved] dropdown. ───────────────────────────────
    await page.getByRole('button', { name: /^Saved filters/ }).click();
    await expect(page.getByRole('textbox', { name: 'Find filters' })).toBeVisible();
    // The apply control is a real button named for the filter (anchored ^ to
    // disambiguate from the "Star …" toggle in the same row).
    await expect(page.getByRole('button', { name: /^Sprint blockers/ })).toBeVisible();

    // axe sweep — the whole dropdown (search + all groups + footer).
    await expectNoAxe(page, '[aria-label="Saved"]', 'saved dropdown');

    // Star it (a sibling focusable button, never nested in the apply control).
    await page.getByRole('button', { name: 'Star Sprint blockers' }).click();
    await expect(page.getByRole('button', { name: 'Unstar Sprint blockers' })).toBeVisible();
  });

  test('a non-owner gets Save-as only, and a private filter stays invisible to them', async ({
    browser,
  }) => {
    const tenant = await seedTenant('sf-owner-2@example.com');
    const author = await makeUser('sf-author-2@example.com', 'Mara Member');
    const other = await makeUser('sf-other-2@example.com', 'Nate Nonowner');
    await enroll(author, tenant, 'member');
    await enroll(other, tenant, 'member');

    // The author owns a SHARED filter + a PRIVATE one (seeded; the save flow is
    // Test A's subject).
    await seedFilter(tenant, author, 'Team triage', 'project');
    await seedFilter(tenant, author, 'My secret', 'private');

    const otherPage = await signInAt(browser, other);
    await otherPage.goto('/items?view=list');

    // ── The dropdown shows the shared filter, NOT the private one. ─────────────
    await otherPage.getByRole('button', { name: /^Saved filters/ }).click();
    await expect(otherPage.getByRole('textbox', { name: 'Find filters' })).toBeVisible();
    await expect(otherPage.getByRole('button', { name: /^Team triage/ })).toBeVisible();
    await expect(
      otherPage.getByRole('button', { name: /^My secret/ }),
      "another user's private filter must never surface",
    ).toHaveCount(0);

    // Apply the shared filter; wait for the `?filter=` nav to settle before
    // editing (the builder re-syncs its rows from the URL on a client apply).
    await otherPage.getByRole('button', { name: /^Team triage/ }).click();
    await expect(
      otherPage.getByRole('button', {
        name: /Applied filter: Team triage \(shared with project\)/,
      }),
    ).toBeVisible();
    await expect(otherPage).toHaveURL(/filter=v1/);

    // ── Edit it → Save-as only (non-owner never gets overwrite-Save). ──────────
    await dirtyViaBuilder(otherPage);
    await expect(otherPage.getByRole('status').filter({ hasText: 'Edited' })).toBeVisible();
    await expect(otherPage.getByRole('button', { name: 'Save as' })).toBeVisible();
    await expect(
      otherPage.getByRole('button', { name: 'Save', exact: true }),
      'a non-owner must not see the overwrite-Save',
    ).toHaveCount(0);

    // ── The directory mirrors the visibility gate. ────────────────────────────
    await otherPage.goto('/filters');
    await expect(
      otherPage.getByRole('button', { name: 'Apply Team triage on Work Items' }),
    ).toBeVisible();
    await expect(
      otherPage.getByRole('button', { name: 'Apply My secret on Work Items' }),
    ).toHaveCount(0);

    await otherPage.context().close();
  });

  test('an admin subscribes, changes owner, and deletes with the dependents warning', async ({
    browser,
  }) => {
    const tenant = await seedTenant('sf-owner-3@example.com');
    const author = await makeUser('sf-author-3@example.com', 'Mara Member');
    const admin = await makeUser('sf-admin-3@example.com', 'Ada Admin');
    await enroll(author, tenant, 'member');
    await enroll(admin, tenant, 'admin');

    await seedFilter(tenant, author, 'Release gate', 'project');

    const adminPage = await signInAt(browser, admin);
    await adminPage.goto('/filters');

    const row = adminPage.getByRole('row', { name: /Release gate/ });
    await expect(row).toBeVisible();

    // Park the pointer in the top-left corner so NO name row is in `:hover`
    // during the whole-page sweep. The name link only switches to its link
    // colour on `group-hover`, so a sweep run with the cursor resting on a row
    // would otherwise pass/fail based on cursor position
    // (bug-filters-directory-name-link-hover-aa-contrast) — normalise it.
    await adminPage.mouse.move(0, 0);

    // axe sweep — the directory table + pager.
    await expectNoAxe(adminPage, null, 'filters directory');

    // ── Subscribe daily via the row's ⋯ menu. ─────────────────────────────────
    await row.getByRole('button', { name: 'Actions for Release gate' }).click();
    await adminPage.getByRole('menuitem', { name: /^Subscribe/ }).click();
    const subDialog = adminPage.getByRole('dialog', { name: /Subscribe to/ });
    await expect(subDialog).toBeVisible();
    // Default schedule is Daily — the subscribe editor is fully rendered.
    await expect(subDialog.getByRole('button', { name: 'Subscribe', exact: true })).toBeVisible();

    // axe sweep — the subscription editor.
    await expectNoAxe(adminPage, '[role="dialog"]', 'subscription editor');

    await subDialog.getByRole('button', { name: 'Subscribe', exact: true }).click();
    await expect(adminPage.getByText(/Subscribed to/).first()).toBeVisible();

    // ── Change owner (admin power) to the author's owner → another member. ─────
    const member2 = await makeUser('sf-member2-3@example.com', 'Quinn Member');
    await enroll(member2, tenant, 'member');
    await adminPage.reload();
    const row2 = adminPage.getByRole('row', { name: /Release gate/ });
    await row2.getByRole('button', { name: 'Actions for Release gate' }).click();
    await adminPage.getByRole('menuitem', { name: 'Change owner' }).click();
    const ownerDialog = adminPage.getByRole('dialog', { name: /Change owner of/ });
    await expect(ownerDialog).toBeVisible();
    await ownerDialog.getByRole('combobox', { name: 'New owner' }).click();
    await adminPage.getByRole('option', { name: /Quinn Member/ }).click();
    await ownerDialog.getByRole('button', { name: 'Change owner' }).click();
    await expect(adminPage.getByText(/Owner changed to/).first()).toBeVisible();

    // ── Delete → the dependents warning NAMES the subscription, then cascades. ─
    const row3 = adminPage.getByRole('row', { name: /Release gate/ });
    await row3.getByRole('button', { name: 'Actions for Release gate' }).click();
    await adminPage.getByRole('menuitem', { name: 'Delete' }).click();
    const delDialog = adminPage.getByRole('dialog', { name: 'Delete filter?' });
    await expect(delDialog).toBeVisible();
    await expect(
      delDialog.getByText('1 subscription will be removed.'),
      'the Cloud-style warning enumerates the dependents',
    ).toBeVisible();
    await delDialog.getByRole('button', { name: 'Delete filter' }).click();
    await expect(adminPage.getByText('Filter deleted', { exact: true }).first()).toBeVisible();
    await expect(
      adminPage.getByRole('button', { name: 'Apply Release gate on Work Items' }),
    ).toHaveCount(0);

    await adminPage.context().close();
  });

  test('a viewer cannot publish a project-shared filter (Project visibility is disabled)', async ({
    browser,
  }) => {
    const tenant = await seedTenant('sf-owner-4@example.com');
    const viewer = await makeUser('sf-viewer-4@example.com', 'Vic Viewer');
    await enroll(viewer, tenant, 'viewer');

    const viewerPage = await signInAt(browser, viewer);
    await viewerPage.goto(`/items?view=list&${FILTER_PARAM}=${encodeURIComponent(BASE_PARAM)}`);

    await viewerPage.getByRole('button', { name: 'Save as' }).click();
    const saveDialog = viewerPage.getByRole('dialog', { name: 'Save filter' });
    await expect(saveDialog).toBeVisible();

    // The viewer may still save PRIVATE filters — the Private card is live, the
    // Project card is visible-but-disabled under the member-role note.
    await expect(saveDialog.getByRole('radio', { name: /Private/ })).toBeEnabled();
    await expect(
      saveDialog.getByRole('radio', { name: /Project/ }),
      'sharing into the project needs the Member role',
    ).toBeDisabled();
    await expect(saveDialog.getByText(/Sharing needs the Member role/)).toBeVisible();

    await viewerPage.context().close();
  });
});

// Render axe violations as a readable block so a CI failure points straight at
// the rule + node (the shell-a11y convention).
interface AxeViolation {
  id: string;
  help: string;
  nodes: { target: unknown[] }[];
}
function formatViolations(label: string, violations: AxeViolation[]): string {
  if (violations.length === 0) return `no violations on ${label}`;
  const lines = violations.map(
    (v) =>
      `  • ${v.id} — ${v.help} (${v.nodes.length} node(s): ${JSON.stringify(v.nodes[0]?.target)})`,
  );
  return `axe found ${violations.length} violation(s) on ${label}:\n${lines.join('\n')}`;
}

// Strict WCAG 2.1 AA sweep, optionally scoped to a selector (transient overlays
// — dialog/listbox — scope to themselves; the directory sweeps the whole page).
async function expectNoAxe(page: Page, include: string | null, label: string): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  expect(results.violations, formatViolations(label, results.violations as AxeViolation[])).toEqual(
    [],
  );
}
