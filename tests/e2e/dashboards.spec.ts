// E2E: dashboards (Story 6.3 · Subtask 6.3.7) — the story-closing journey over
// the real stack (Next + Postgres), the Playwright half of Principle #18's
// Story-level review. The widget-type registry, the CRUD / move-ordering
// matrix, the per-VIEWER × scope × stale read matrix, and filter-results
// parity are already asserted exhaustively at the integration tier
// (tests/integration/dashboards/*.test.ts + tests/integration/reports/*.test.ts)
// and the cross-service recipe at tests/integration/dashboards/story-6.3-
// acceptance.test.ts — this spec does NOT re-assert those predicates. It drives
// the user-visible journey the Story 6.3 verification recipe calls out, through
// the browser, plus the strict axe sweep:
//
//   A. the OWNER creates a workspace dashboard → edit mode → adds all three
//      widget types (project- and filter-sourced) → switches the column layout
//      → drags a widget across columns → reloads (the move persists);
//   B. SHARING — a workspace member sees the shared dashboard READ-ONLY (no
//      edit affordances) while the owner's PRIVATE dashboard is invisible
//      (absent from the list AND a 404 on direct nav);
//   C. STALE — deleting the saved filter behind a widget degrades it to the
//      designed "Filter missing" card, never a crash;
//   D. a11y — the strict WCAG sweep over the dashboards home + the populated
//      grid (edit mode, a config panel open).
//
// ── How the tenant is built (the saved-filters.spec precedent) ───────────────
// A workspace dashboard shared to a second member is a MULTI-user, one-
// workspace scenario the sign-up UI can't reach (each sign-up mints its own
// workspace). So the personas + the project + the saved filter are seeded
// through the shipped fixtures/services (sign-in-able accounts at TEST_PASSWORD;
// the active-project pin is the test-sanctioned direct DB reach), and the
// dashboard journey itself is driven through the real UI.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { dashboardsService } from '@/lib/services/dashboardsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  createTestUser,
  createTestWorkItem,
  makeWorkItemFixture,
  TEST_PASSWORD,
} from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

test.describe.configure({ timeout: 90_000 });

// WCAG 2.1 A + AA — the ruleset the AC names, scoped explicitly so the bar can't
// silently shift when axe-core bumps (the shell-a11y convention).
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const HIGH_PRIORITY_AST: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'priority', operator: 'is_any_of', value: ['high', 'highest'] }],
};
const FILTER_NAME = 'High priority';

interface Tenant {
  fx: WorkItemFixture;
  ownerEmail: string;
  projectName: string;
  filterId: string;
}

let seq = 0;

/** Owner workspace + project + a saved filter + a few issues, the active
 * project pinned so /dashboard renders the list (not the projects-empty
 * onboarding). Returns the sign-in-able owner email. */
async function seedTenant(): Promise<Tenant> {
  seq += 1;
  const fx = await makeWorkItemFixture({ name: 'Acme', identifier: `DS${seq}` });
  await pinActiveProject(fx.ownerId, fx.workspaceId, fx.projectId);
  const filter = await savedFiltersService.create(
    fx.projectIdentifier,
    { name: FILTER_NAME, visibility: 'project', filterParam: encodeFilterParam(HIGH_PRIORITY_AST) },
    fx.ctx,
  );
  for (let i = 0; i < 3; i++) {
    await createTestWorkItem(fx, { kind: 'task', title: `Dashboard seed item ${i}` });
  }
  return { fx, ownerEmail: fx.owner.email, projectName: fx.project.name, filterId: filter.id };
}

async function pinActiveProject(
  userId: string,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId, workspaceId } },
    data: { activeProjectId: projectId },
  });
}

/** Add a fresh workspace member (an open-project browser), active project
 * pinned, returning a sign-in-able email. */
async function addMember(t: Tenant, label: string): Promise<string> {
  const user = await createTestUser({ email: `dash-${label}-${seq}@example.com`, name: label });
  await workspacesService.addMember({
    userId: user.id,
    workspaceId: t.fx.workspaceId,
    role: 'member',
  });
  await pinActiveProject(user.id, t.fx.workspaceId, t.fx.projectId);
  return user.email;
}

function ownerCtx(t: Tenant): ServiceContext {
  return t.fx.ctx;
}

// A REAL pointer drag from a widget grip onto a target column, clearing
// dnd-kit's 8px PointerSensor activation distance before settling, then dropping
// — and returning the widget-move POST the drop fires (mirrors board.ts's
// pointerDragForMove, retargeted at the dashboards move endpoint).
async function dragWidgetToColumn(
  page: Page,
  grip: Locator,
  column: Locator,
  targetColumn: number,
): ReturnType<Page['waitForResponse']> {
  // A synthetic pointer drag into a (here empty) column is inherently flaky
  // under dnd-kit's `closestCorners`: at the instant of release `over` can
  // resolve to a stale widget in the SOURCE column rather than the target
  // column, so the move POSTs the wrong column / neighbour ids that don't bound
  // a real slot → 422 (the dashboards-drag flake). A rejected move changes
  // nothing server-side, so retry the whole gesture until the move BOTH commits
  // (200) AND targeted the intended column (the request body's `column`). We
  // bias each attempt by releasing only once the column shows its `isOver`
  // style, then verify the actual committed move rather than trusting the drop.
  const isMove = (r: import('@playwright/test').Response) =>
    /\/widgets\/[^/]+\/move$/.test(r.url()) && r.request().method() === 'POST';
  let last: import('@playwright/test').Response | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    await grip.scrollIntoViewIfNeeded();
    await column.scrollIntoViewIfNeeded();
    const f = (await grip.boundingBox())!;
    const t = (await column.boundingBox())!;
    const fx = f.x + f.width / 2;
    const fy = f.y + f.height / 2;
    const tx = t.x + t.width / 2;
    const ty = t.y + t.height * 0.5;
    await page.mouse.move(fx, fy);
    await page.mouse.down();
    await page.mouse.move(fx + 10, fy + 10, { steps: 5 }); // clear the 8px activation
    await page.mouse.move(tx, ty, { steps: 18 });
    await page.mouse.move(tx, ty, { steps: 4 }); // settle so the over-target sticks
    // Best-effort: prefer releasing while the column is the active droppable —
    // EditColumn paints its `isOver` style as `bg-(--el-droptarget-bg)` (the
    // lavender drop-zone fill), so gate on that class, NOT `tint-lavender`: the
    // emitted class name is `bg-(--el-droptarget-bg)` and only *resolves* to
    // `var(--color-tint-lavender)` in CSS, so the old `/tint-lavender/` regex
    // never matched — the wait always timed out, was swallowed, and the pointer
    // released BEFORE dnd-kit had resolved `over` to this column, letting
    // `closestCorners` pick a stale source-column widget → a 422 move under CI
    // load (MOTIR-1350). Don't fail the attempt if it doesn't show — the
    // post-drop verification + retry is still the real guarantee.
    await expect(column)
      .toHaveClass(/droptarget-bg/, { timeout: 1_500 })
      .catch(() => {});
    const movePromise = page.waitForResponse(isMove, { timeout: 5_000 }).catch(() => null);
    await page.mouse.up();
    const res = await movePromise;
    if (res && res.status() === 200 && res.request().postDataJSON()?.column === targetColumn) {
      return res;
    }
    last = res ?? last;
    await page.mouse.move(fx, fy, { steps: 3 }); // reset the pointer before retrying
  }
  if (last) return last; // exhausted — surface the last response so the caller's assert reports it
  throw new Error('widget move never committed to the target column');
}

// Open the add-widget picker and pick a type, opening its config modal.
async function pickWidget(
  page: Page,
  type: 'filter_results' | 'distribution' | 'created_vs_resolved',
) {
  await page.getByTestId('dashboard-add-widget').click();
  const picker = page.getByRole('dialog', { name: 'Add a widget' });
  await expect(picker).toBeVisible();
  await page.getByTestId(`add-widget-${type}`).click();
  await expect(picker).toBeHidden();
}

// Pick the seeded project as the (default) data source in the open config modal.
async function chooseProjectSource(page: Page, dialog: Locator, projectName: string) {
  await dialog.getByRole('combobox', { name: 'Select a project…' }).click();
  await page.getByRole('option', { name: projectName }).click();
}

// Save the config modal and wait for the widget POST to land.
async function saveWidget(page: Page) {
  const created = page.waitForResponse(
    (r) => /\/dashboards\/[^/]+\/widgets$/.test(r.url()) && r.request().method() === 'POST',
  );
  await page.getByTestId('widget-config-save').click();
  expect((await created).status()).toBe(201);
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test.describe('dashboards @smoke', () => {
  test('A — create a workspace dashboard, add three widgets, switch layout, drag, reload persists', async ({
    page,
  }) => {
    const t = await seedTenant();
    await signIn(page, t.ownerEmail, TEST_PASSWORD);

    // The dashboards home renders (empty — first run).
    await expect(page.getByRole('heading', { name: 'Dashboards' })).toBeVisible();

    // Create "Team overview" with Workspace access → lands on its grid.
    await page.getByTestId('new-dashboard').click();
    const createModal = page.getByRole('dialog', { name: 'New dashboard' });
    await createModal.getByTestId('create-dashboard-name').fill('Team overview');
    await createModal.getByTestId('access-card-workspace').click();
    await createModal.getByTestId('create-dashboard-submit').click();
    await page.waitForURL(/\/dashboard\/[^/]+$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Team overview' })).toBeVisible();

    // Enter edit mode.
    await page.getByRole('button', { name: 'Edit' }).click();

    // Widget 1 — distribution by Status (project-sourced; project is the default).
    await pickWidget(page, 'distribution');
    let cfg = page.getByRole('dialog');
    await chooseProjectSource(page, cfg, t.projectName);
    await cfg.getByRole('combobox', { name: 'Statistic type' }).click();
    await page.getByRole('option', { name: 'Status' }).click();
    await saveWidget(page);

    // Widget 2 — created vs resolved (project-sourced).
    await pickWidget(page, 'created_vs_resolved');
    cfg = page.getByRole('dialog');
    await chooseProjectSource(page, cfg, t.projectName);
    await saveWidget(page);

    // Widget 3 — filter results sourced by the saved filter (the filter path).
    await pickWidget(page, 'filter_results');
    cfg = page.getByRole('dialog');
    await cfg.getByRole('button', { name: 'Saved filter' }).click();
    await cfg.getByRole('combobox', { name: 'Select a saved filter…' }).click();
    await page.getByRole('option', { name: new RegExp(FILTER_NAME) }).click();
    await saveWidget(page);

    // All three widget cards are present (one drag grip per card in edit mode).
    await expect(page.locator('[data-testid^="dashboard-widget-grip-"]')).toHaveCount(3);

    // Switch the column layout: one → three columns (the picker reflows).
    await page.getByTestId('layout-one').click();
    await expect(page.getByTestId('dashboard-column-0')).toBeVisible();
    await page.getByTestId('layout-three').click();
    await expect(page.getByTestId('dashboard-column-2')).toBeVisible();

    // All three widgets appended into column 0; drag the first across to column 1.
    const dashId = page.url().split('/').pop()!;
    const firstGrip = page.locator('[data-testid^="dashboard-widget-grip-"]').first();
    const grip = firstGrip;
    const movedWidgetId = (await grip.getAttribute('data-testid'))!.replace(
      'dashboard-widget-grip-',
      '',
    );
    const moveResp = await dragWidgetToColumn(
      page,
      grip,
      page.getByTestId('dashboard-column-1'),
      1,
    );
    expect((await moveResp).status()).toBe(200);

    // Reload — the move persists (assert through the authoritative read).
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Team overview' })).toBeVisible();
    const detail = await page.request
      .get(`/api/dashboards/${dashId}`, { headers: { accept: 'application/json' } })
      .then((r) => r.json());
    const moved = detail.dashboard.widgets.find((w: { id: string }) => w.id === movedWidgetId);
    expect(moved.column).toBe(1);
  });

  test('B — a shared dashboard is read-only to a member; a private one is invisible', async ({
    page,
  }) => {
    const t = await seedTenant();
    const memberEmail = await addMember(t, 'viewer');

    // Owner seeds two dashboards: one shared to the workspace, one private.
    const shared = await dashboardsService.create(
      { name: 'Team overview', access: 'workspace' },
      ownerCtx(t),
    );
    await dashboardsService.addWidget(
      shared.id,
      { type: 'distribution', projectId: t.fx.projectId, config: { statisticType: 'status' } },
      ownerCtx(t),
    );
    const priv = await dashboardsService.create(
      { name: 'Owner secret', access: 'private' },
      ownerCtx(t),
    );

    // The member sees ONLY the shared dashboard, marked View only.
    await signIn(page, memberEmail, TEST_PASSWORD);
    await expect(page.getByTestId(`dashboard-row-${shared.id}`)).toBeVisible();
    await expect(page.getByText('View only')).toBeVisible();
    await expect(page.getByTestId(`dashboard-row-${priv.id}`)).toHaveCount(0);
    await expect(page.getByText('Owner secret')).toHaveCount(0);

    // Opening the shared dashboard: no owner-only edit affordance.
    await page.getByTestId(`dashboard-row-${shared.id}`).click();
    await page.waitForURL(new RegExp(`/dashboard/${shared.id}$`));
    await expect(page.getByRole('heading', { name: 'Team overview' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);

    // The private dashboard is a 404 on direct nav (the route's access gate).
    const resp = await page.goto(`/dashboard/${priv.id}`);
    expect(resp?.status()).toBe(404);
  });

  test('C — deleting the saved filter behind a widget renders the stale "Filter missing" card', async ({
    page,
  }) => {
    const t = await seedTenant();
    const dash = await dashboardsService.create(
      { name: 'Filter dash', access: 'private' },
      ownerCtx(t),
    );
    await dashboardsService.addWidget(
      dash.id,
      { type: 'filter_results', savedFilterId: t.filterId, config: { pageSize: 10 } },
      ownerCtx(t),
    );

    // Delete the backing filter, then open the grid as the owner.
    await savedFiltersService.delete(t.fx.projectIdentifier, t.filterId, ownerCtx(t));

    await signIn(page, t.ownerEmail, TEST_PASSWORD);
    await page.goto(`/dashboard/${dash.id}`);
    await expect(page.getByRole('heading', { name: 'Filter dash' })).toBeVisible();

    // The widget degrades to the designed stale card — never a crash.
    await expect(page.getByText('Filter missing').first()).toBeVisible({ timeout: 15_000 });
  });

  test('D — a11y: the dashboards home and the populated grid pass the strict axe sweep', async ({
    page,
  }) => {
    const t = await seedTenant();
    const dash = await dashboardsService.create(
      { name: 'Team overview', access: 'workspace' },
      ownerCtx(t),
    );
    await dashboardsService.addWidget(
      dash.id,
      { type: 'distribution', projectId: t.fx.projectId, config: { statisticType: 'status' } },
      ownerCtx(t),
    );
    await dashboardsService.addWidget(
      dash.id,
      { type: 'filter_results', savedFilterId: t.filterId, config: { pageSize: 10 } },
      ownerCtx(t),
    );

    await signIn(page, t.ownerEmail, TEST_PASSWORD);

    // Dashboards home.
    await expect(page.getByRole('heading', { name: 'Dashboards', exact: true })).toBeVisible();
    const home = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(home.violations).toEqual([]);

    // The populated grid in EDIT mode with a config panel open (every chrome
    // affordance + a dialog visible — the AC's "every widget state visible").
    await page.getByTestId(`dashboard-row-${dash.id}`).click();
    await page.waitForURL(new RegExp(`/dashboard/${dash.id}$`));
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByTestId('dashboard-add-widget')).toBeVisible();
    // Let the widget bodies settle (loading skeleton → data/empty) before the sweep.
    await expect(page.getByLabel('Loading widget…')).toHaveCount(0, { timeout: 15_000 });
    const grid = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(grid.violations).toEqual([]);
  });
});
