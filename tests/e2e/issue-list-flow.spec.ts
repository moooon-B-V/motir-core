// E2E: the Story-2.5 issue-list surface (Subtask 2.5.6) — the Story closer that
// drives the REAL stack (Next + Postgres) through the whole /items surface:
// nested render · expand/collapse · filter · inline edit · the Tree↔List
// view-switcher · cross-workspace isolation, plus the finding-#57 SCALE checks
// (List pagination + Tree lazy-load/virtualization on a large seeded project).
// The populated-route a11y sweep lives in shell-a11y.spec.ts (the strict axe
// gate the card folds 2.5.6 into); this file owns the behavioural flow.
//
// Setup mirrors issue-create-edit-flow.spec.ts: sign up through the real UI
// (shell-session.signUp → auto-workspace → /dashboard), then seed the project +
// work items SERVER-SIDE through the shipped services (projectsService /
// workItemsService) — the one sanctioned cross-layer reach for tests, the same
// path seedActiveProject + the work-item integration tests use, and the path
// `pnpm db:seed:large` (2.5.16) drives. Going through the services (not raw
// inserts) keeps the kind-parent + key-allocation invariants intact, so the
// seeded tree is exactly what Motir itself would render.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemKindDto, WorkItemPriorityDto } from '@/lib/dto/workItems';

test.describe.configure({ timeout: 90_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

interface Seed {
  ctx: ServiceContext;
  projectId: string;
}

/** Sign-up auto-creates the workspace; create a project server-side + pin it
 *  active so the project-scoped /items route resolves it. Returns the service
 *  context (for seeding work items) + the project id. */
async function seedProject(page: Page, email: string, identifier: string): Promise<Seed> {
  await signUp(page, email);
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Issue List',
    identifier,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return { ctx: { userId: user!.id, workspaceId: ws!.id }, projectId: project.id };
}

/** Create ONE work item through the service (returns its id + identifier). */
async function mk(
  seed: Seed,
  kind: WorkItemKindDto,
  title: string,
  parentId?: string,
  extra?: { priority?: WorkItemPriorityDto },
): Promise<{ id: string; identifier: string; title: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind, title, parentId: parentId ?? null, ...extra },
    seed.ctx,
  );
  return { id: dto.id, identifier: dto.identifier, title: dto.title };
}

/** Read a single work item back via the `_test` service-layer route (robust vs
 *  scraping the DOM — the same read the create-edit spec uses for round-trips). */
async function getItem(page: Page, id: string): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/_test/work-items?id=${id}`);
  expect(res.status(), 'get work item').toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** The identifiers of every issue ROW currently mounted in the DOM (Tree or
 *  List) — the windowing-aware row set (synthetic loading / load-more rows carry
 *  no testid, so they're excluded). */
async function renderedRowIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="issue-row-"]')
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-testid')!.replace('issue-row-', '')),
    );
}

// ───────────────────────────── render · expand · navigate ─────────────────────

test('@smoke nested tree renders project-scoped + lazily expands/collapses, row → peek', async ({
  page,
}) => {
  const seed = await seedProject(page, 'e2e-issue-list-render@example.com', 'REN');
  // epic → story → task → sub-task, plus a top-level bug (the multi-level fixture
  // the card names). Capture the identifiers to assert nesting + lazy loading.
  const epic = await mk(seed, 'epic', 'Platform epic');
  const story = await mk(seed, 'story', 'Auth story', epic.id);
  const task = await mk(seed, 'task', 'Login task', story.id);
  const sub = await mk(seed, 'subtask', 'Wire the form', task.id);
  const bug = await mk(seed, 'bug', 'Crash on submit');

  await page.goto('/items');

  // The treegrid renders, project-scoped: the two ROOTS (epic + bug) are present,
  // the descendants are NOT yet in the DOM (lazy — only the first level loads).
  const grid = page.getByRole('treegrid', { name: 'Work Items', exact: true });
  await expect(grid).toBeVisible();
  await expect(page.getByTestId(`issue-row-${epic.identifier}`)).toBeVisible();
  await expect(page.getByTestId(`issue-row-${bug.identifier}`)).toBeVisible();
  await expect(page.getByTestId(`issue-row-${story.identifier}`)).toHaveCount(0);

  // Roots are level 1; the epic shows a status Pill + its identifier (nested
  // render with identifiers + status).
  const epicRow = page.getByTestId(`issue-row-${epic.identifier}`);
  await expect(epicRow).toHaveAttribute('aria-level', '1');
  await expect(epicRow).toContainText(epic.identifier);
  await expect(epicRow).toContainText('To Do');

  // Expand/collapse via the treegrid's keyboard model (focus row → ArrowRight to
  // expand, ArrowLeft to collapse, Enter to activate the row link). This is the
  // documented WAI-ARIA treegrid interaction and is robust against pointer
  // hit-testing — the tiny chevron sits among same-row z-10 inline-edit controls,
  // so a coordinate click on it is interception-prone in a dense row. Enter fires
  // an unmodified click on the row's stretched link, which now opens the
  // quick-view peek (MOTIR-1306) rather than navigating.

  // Expand the epic → the story streams in at level 2 (lazy fetch on expand).
  await epicRow.press('ArrowRight');
  const storyRow = page.getByTestId(`issue-row-${story.identifier}`);
  await expect(storyRow).toBeVisible();
  await expect(storyRow).toHaveAttribute('aria-level', '2');

  // Drill deeper: story → task → sub-task, each one level appearing on expand.
  await storyRow.press('ArrowRight');
  const taskRow = page.getByTestId(`issue-row-${task.identifier}`);
  await expect(taskRow).toBeVisible();
  await taskRow.press('ArrowRight');
  const subRow = page.getByTestId(`issue-row-${sub.identifier}`);
  await expect(subRow).toBeVisible();
  await expect(subRow).toHaveAttribute('aria-level', '4');

  // Collapse the epic → all descendants disappear again.
  await epicRow.press('ArrowLeft');
  await expect(page.getByTestId(`issue-row-${story.identifier}`)).toHaveCount(0);
  await expect(page.getByTestId(`issue-row-${sub.identifier}`)).toHaveCount(0);

  // Activating the row (Enter) opens the quick-view peek over the list — a plain
  // activation of the whole-row link, intercepted to set ?peek (MOTIR-1306). The
  // full detail page stays reachable via the peek's "Open full page" affordance
  // and ⌘/ctrl/middle-click (asserted in the List view test below).
  await page.getByTestId(`issue-row-${bug.identifier}`).press('Enter');
  const peek = page.getByRole('dialog');
  await expect(peek).toBeVisible();
  await expect(peek.getByTestId('quick-view-open-full')).toHaveAttribute(
    'href',
    `/items/${bug.identifier}`,
  );
  await expect(page).toHaveURL(new RegExp(`[?&]peek=${bug.identifier}`));
  expect(new URL(page.url()).pathname).toBe('/items');
});

// ─────────────────────────── quick-view peek (8.8.2) ───────────────────────────

// Bug 8.8.2 — the quick-view (peek) modal opens its frame INSTANTLY (a client
// island driven by `?peek`, no server round-trip) and closing is a pure shallow
// URL clear that stays on /items with the list intact (no underlying-list
// refetch / navigation away). Frame-before-content is pinned deterministically
// at the unit level (issue-quick-view-controller.test.tsx — a pending fetch);
// this is the real-stack open→stream→close round-trip on the primary surface.
test('@smoke quick-view peek opens over the list and closes back to it (bug 8.8.2)', async ({
  page,
}) => {
  const seed = await seedProject(page, 'e2e-issue-list-peek@example.com', 'PEK');
  const epic = await mk(seed, 'epic', 'Peekable epic');

  await page.goto('/items');
  const row = page.getByTestId(`issue-row-${epic.identifier}`);
  await expect(row).toBeVisible();

  // Open the peek by activating the whole-row link (Enter — MOTIR-1306 removed
  // the per-row eye; a plain row activation now opens the peek): the modal frame
  // appears, "Open full page" is live, and the item's fields stream in (client
  // fetch of /api/work-items/peek). The URL gains ?peek WITHOUT leaving /items.
  await row.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('quick-view-open-full')).toHaveAttribute(
    'href',
    `/items/${epic.identifier}`,
  );
  await expect(dialog.getByRole('heading', { name: epic.title })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`[?&]peek=${epic.identifier}`));
  expect(new URL(page.url()).pathname).toBe('/items');

  // Close (Esc): dismisses immediately, clears ?peek, stays on /items with the
  // list still rendered (the close is a shallow URL change — no nav, no refetch).
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]peek=/);
  expect(new URL(page.url()).pathname).toBe('/items');
  await expect(row).toBeVisible();
});

// ───────────────────────────── empty state ────────────────────────────────────

test('@smoke a project with no work items renders the empty state', async ({ page }) => {
  await seedProject(page, 'e2e-issue-list-empty@example.com', 'EMP');
  await page.goto('/items');
  await expect(page.getByRole('heading', { name: 'No work items yet' })).toBeVisible();
  await expect(page.getByText('Create your first work item to start tracking work.')).toBeVisible();
});

// ───────────── create refreshes the list without a reload (regression) ─────────
//
// bug-issue-list-not-refreshed-after-create: the unfiltered lazy Tree
// (IssueTreeTable) seeds its ROOTS level into client state ONCE on mount, so a
// create from the "+ New work item" toolbar trigger — which commits through the
// shell CreateIssueProvider + router.refresh() — re-ran the Server Component but
// could NOT reach the stale client state, so the new row stayed invisible until a
// full page reload. The fix watches the provider's `issuesChangedAt` tick and
// refetches the roots. This drives the REAL repro: create via the toolbar and
// assert the new row appears with NO page.reload(), in BOTH the Tree and List
// views. (poll the row link with a tight timeout; never call page.reload()).

test('@smoke a toolbar create appears in the Tree + List without a manual reload', async ({
  page,
}) => {
  const seed = await seedProject(page, 'e2e-issue-list-create-refresh@example.com', 'CRF');
  const existing = await mk(seed, 'task', 'Pre-existing root');

  // ── Tree view (the default + the lazy surface that had the bug) ─────────────
  await page.goto('/items');
  const grid = page.getByRole('treegrid', { name: 'Work Items', exact: true });
  await expect(grid).toBeVisible();
  await expect(page.getByTestId(`issue-row-${existing.identifier}`)).toBeVisible();
  await expect(page.getByRole('link', { name: /Created in tree/ })).toHaveCount(0);

  // Create through the SAME entry point the bug was reported on.
  await page.getByRole('button', { name: 'New work item' }).click();
  await page.getByLabel('Title').fill('Created in tree');
  await page.getByRole('button', { name: 'Create' }).click();

  // The new ROOT row appears in the tree WITHOUT a reload (the regression assert).
  await expect(page.getByRole('link', { name: /Created in tree/ })).toBeVisible();

  // ── List view (props-driven; guard it stays fresh too) ──────────────────────
  await page.getByRole('button', { name: 'View: Tree' }).click();
  await page.getByRole('menuitemradio', { name: 'List' }).click();
  await page.waitForURL((url) => url.searchParams.get('view') === 'list');
  await expect(page.getByRole('table', { name: 'Work Items' })).toBeVisible();
  // The tree-created item is present in the freshly-read list.
  await expect(page.getByRole('link', { name: /Created in tree/ })).toBeVisible();

  // A second create from the List toolbar also shows up with no reload.
  await page.getByRole('button', { name: 'New work item' }).click();
  await page.getByLabel('Title').fill('Created in list');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('link', { name: /Created in list/ })).toBeVisible();
});

// ───────────────────────────── filter ─────────────────────────────────────────

test('@smoke filtering narrows the tree while keeping matched nodes’ ancestors', async ({
  page,
}) => {
  const seed = await seedProject(page, 'e2e-issue-list-filter@example.com', 'FIL');
  // Three epics: A + B carry STORY children; C carries only a TASK. Filtering by
  // kind=Story must keep A + B (as retained ancestors of their matched stories)
  // and prune C entirely. Also seed a distinctly-titled story for the text test.
  const epicA = await mk(seed, 'epic', 'Epic Alpha');
  const a1 = await mk(seed, 'story', 'Story Alpha One', epicA.id);
  const a2 = await mk(seed, 'story', 'Story Alpha Two', epicA.id);
  const epicB = await mk(seed, 'epic', 'Epic Bravo');
  const b1 = await mk(seed, 'story', 'Story Bravo One', epicB.id);
  const epicC = await mk(seed, 'epic', 'Epic Charlie');
  await mk(seed, 'task', 'Task Charlie One', epicC.id);

  await page.goto('/items');
  await expect(page.getByRole('treegrid', { name: 'Work Items' })).toBeVisible();

  // ── kind facet: keep ancestors, prune non-matching branches ────────────────
  // The filter popover stays OPEN across selections (multi-select) — open it
  // once and drive every facet from the same open panel.
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByRole('listbox', { name: 'Kind' }).getByRole('option', { name: 'Story' }).click();
  await page.waitForURL((url) => url.searchParams.get('kind') === 'story');
  // The matched stories + their retained ancestors (epics A, B) are shown; epic C
  // (no story descendant) is pruned along with its task.
  await expect(page.getByTestId(`issue-row-${a1.identifier}`)).toBeVisible();
  await expect(page.getByTestId(`issue-row-${a2.identifier}`)).toBeVisible();
  await expect(page.getByTestId(`issue-row-${b1.identifier}`)).toBeVisible();
  await expect(page.getByTestId(`issue-row-${epicA.identifier}`)).toBeVisible();
  await expect(page.getByTestId(`issue-row-${epicB.identifier}`)).toBeVisible();
  await expect(page.getByTestId(`issue-row-${epicC.identifier}`)).toHaveCount(0);

  // Clear → the full tree is back (and the trigger drops its active count).
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.waitForURL((url) => url.pathname.endsWith('/items') && url.search === '');
  await expect(page.getByTestId(`issue-row-${epicC.identifier}`)).toBeVisible();

  // ── text facet: by ID/title, ancestor retained ─────────────────────────────
  // (the popover is still open from above — fill the text field directly).
  await page.getByRole('textbox', { name: 'Filter by text' }).fill('Alpha One');
  await page.waitForURL((url) => url.searchParams.get('q') === 'Alpha One');
  await expect(page.getByTestId(`issue-row-${a1.identifier}`)).toBeVisible();
  await expect(page.getByTestId(`issue-row-${epicA.identifier}`)).toBeVisible(); // ancestor kept
  await expect(page.getByTestId(`issue-row-${a2.identifier}`)).toHaveCount(0);
  await expect(page.getByTestId(`issue-row-${b1.identifier}`)).toHaveCount(0);
});

test('@smoke status + assignee facets narrow the list and serialize to the URL', async ({
  page,
}) => {
  const seed = await seedProject(page, 'e2e-issue-list-filter2@example.com', 'FLT');
  const a = await mk(seed, 'task', 'Move me to in progress');
  await mk(seed, 'task', 'Leave me as todo');
  // Drive the gated transition so `a` is in_progress (todo → in_progress is a
  // default-workflow edge).
  await workItemsService.updateStatus(a.id, 'in_progress', seed.ctx);

  await page.goto('/items');

  // status=in_progress → only `a` survives (the todo sibling is pruned).
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page
    .getByRole('listbox', { name: 'Status' })
    .getByRole('option', { name: 'In Progress' })
    .click();
  await page.waitForURL((url) => url.searchParams.get('status') === 'in_progress');
  await expect(page.getByTestId(`issue-row-${a.identifier}`)).toBeVisible();
  await expect(page.locator('[data-testid^="issue-row-"]')).toHaveCount(1);

  // Add the Unassigned assignee facet → still matches (nothing is assigned), and
  // the trigger reflects 2 active filters; the assignee token serializes too.
  await page
    .getByRole('listbox', { name: 'Assignee' })
    .getByRole('option', { name: 'Unassigned' })
    .click();
  await page.waitForURL((url) => url.searchParams.getAll('assignee').includes('unassigned'));
  await expect(page.getByRole('button', { name: 'Filter — 2 active' })).toBeVisible();
  await expect(page.getByTestId(`issue-row-${a.identifier}`)).toBeVisible();
});

// ───────────────────────────── inline edit ────────────────────────────────────

test('@smoke inline status edit: a legal transition persists; illegal targets are not offered', async ({
  page,
}) => {
  const seed = await seedProject(page, 'e2e-issue-list-status@example.com', 'IST');
  const task = await mk(seed, 'task', 'Inline status target'); // root task → todo

  await page.goto('/items?view=list');
  const row = page.getByTestId(`issue-row-${task.identifier}`);
  await row.getByRole('button', { name: 'Edit Status' }).click();

  // The picker offers the LEGAL targets from todo (In Progress) but NOT the
  // unreachable ones (Done) — restricted policy pre-filters, like the edit form.
  const listbox = page.getByRole('listbox');
  await expect(listbox.getByRole('option', { name: 'In Progress' })).toBeVisible();
  await expect(listbox.getByRole('option', { name: 'Done' })).toHaveCount(0);

  await listbox.getByRole('option', { name: 'In Progress' }).click();
  // The change persisted through the gated path.
  await expect(async () => {
    expect((await getItem(page, task.id)).status).toBe('in_progress');
  }).toPass();
});

test('@smoke inline assignee edit: reassign then unassign both persist', async ({ page }) => {
  const email = 'e2e-issue-list-assignee@example.com';
  const seed = await seedProject(page, email, 'IAS');
  const task = await mk(seed, 'task', 'Inline assignee target');

  await page.goto('/items?view=list');
  const row = page.getByTestId(`issue-row-${task.identifier}`);

  // Reassign: open the picker, search the member by email, pick it.
  await row.getByRole('button', { name: 'Edit Assignee' }).click();
  await page.getByRole('option', { name: new RegExp(email.split('@')[0]!) }).click();
  await expect(async () => {
    expect((await getItem(page, task.id)).assigneeId).toBe(seed.ctx.userId);
  }).toPass();

  // Unassign: reopen, pick "Unassigned".
  await row.getByRole('button', { name: 'Edit Assignee' }).click();
  await page.getByRole('option', { name: 'Unassigned' }).click();
  await expect(async () => {
    expect((await getItem(page, task.id)).assigneeId).toBeNull();
  }).toPass();
});

// ───────────────────────────── view switcher + list sort ──────────────────────

test('@smoke the [Tree ▾] switcher round-trips Tree↔List through ?view=, list sort through ?sort=', async ({
  page,
}) => {
  const seed = await seedProject(page, 'e2e-issue-list-switch@example.com', 'SWT');
  // Two distinct priorities so sorting by Priority visibly re-orders the rows.
  await mk(seed, 'task', 'Low priority task', undefined, { priority: 'low' });
  const urgent = await mk(seed, 'bug', 'Urgent bug', undefined, { priority: 'highest' });

  await page.goto('/items');
  await expect(page.getByRole('treegrid', { name: 'Work Items' })).toBeVisible();

  // Switch Tree → List: the tree flattens (no treegrid) into the role=table List.
  await page.getByRole('button', { name: 'View: Tree' }).click();
  await page.getByRole('menuitemradio', { name: 'List' }).click();
  await page.waitForURL((url) => url.searchParams.get('view') === 'list');
  await expect(page.getByRole('table', { name: 'Work Items' })).toBeVisible();
  await expect(page.getByRole('treegrid')).toHaveCount(0);

  // The choice is reload/share-safe (it lives in the URL).
  await page.reload();
  await expect(page.getByRole('table', { name: 'Work Items' })).toBeVisible();

  // Sort by the Priority header: round-trips through ?sort=, flips asc↔desc, and
  // re-orders the rows (the active column carries aria-sort). The header button's
  // accessible name is its text ("Priority"); the "Sort by …" string is its title.
  const priorityHeader = page.getByRole('columnheader', { name: 'Priority' });
  await priorityHeader.getByRole('button', { name: 'Priority' }).click();
  await page.waitForURL((url) => url.searchParams.get('sort') === 'priority:asc');
  await expect(priorityHeader).toHaveAttribute('aria-sort', 'ascending');
  const ascFirst = (await renderedRowIds(page))[0];

  await priorityHeader.getByRole('button', { name: 'Priority' }).click();
  await page.waitForURL((url) => url.searchParams.get('sort') === 'priority:desc');
  await expect(priorityHeader).toHaveAttribute('aria-sort', 'descending');
  const descFirst = (await renderedRowIds(page))[0];
  expect(ascFirst).not.toBe(descFirst); // the order genuinely flipped

  // A PLAIN click on the whole-row link opens the quick-view peek over the list
  // (MOTIR-1306) — it does NOT navigate; the URL gains ?peek and stays on /items.
  const rowLink = page.getByRole('link', { name: `${urgent.identifier} ${urgent.title}` });
  await rowLink.click();
  const peek = page.getByRole('dialog');
  await expect(peek).toBeVisible();
  await expect(peek.getByTestId('quick-view-open-full')).toHaveAttribute(
    'href',
    `/items/${urgent.identifier}`,
  );
  await expect(page).toHaveURL(new RegExp(`[?&]peek=${urgent.identifier}`));
  expect(new URL(page.url()).pathname).toBe('/items');
  await page.keyboard.press('Escape');
  await expect(peek).toBeHidden();

  // A ⌘/ctrl-click does NOT hijack into the peek — the row link keeps its real
  // href, so the browser opens the full detail page (natively, in a new tab)
  // rather than peeking. We assert the app-owned contract: the href still points
  // at the detail page, and the modified click neither opens the peek nor adds
  // ?peek. (The new-tab open itself is the browser's native handling of a
  // modified click on an <a href>, not app code — and not deterministic to
  // observe in headless chromium, so we don't assert on a popup.)
  await expect(rowLink).toHaveAttribute('href', `/items/${urgent.identifier}`);
  await rowLink.click({ modifiers: ['ControlOrMeta'] });
  await expect(peek).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]peek=/);
  expect(new URL(page.url()).pathname).toBe('/items');

  // Switch back to Tree → the view param drops to its canonical form.
  await page.getByRole('button', { name: 'View: List' }).click();
  await page.getByRole('menuitemradio', { name: 'Tree' }).click();
  await page.waitForURL((url) => url.searchParams.get('view') !== 'list');
  await expect(page.getByRole('treegrid', { name: 'Work Items' })).toBeVisible();
});

// ───────────────────────────── cross-workspace isolation ──────────────────────

test('@smoke cross-workspace isolation: /items never shows another workspace’s items', async ({
  page,
}) => {
  // Workspace A owns an issue.
  const seedA = await seedProject(page, 'e2e-issue-list-tenant-a@example.com', 'AAA');
  const aItem = await mk(seedA, 'task', 'A-only task');

  // Workspace B (fresh sign-up → switches the browser session) owns a different one.
  const seedB = await seedProject(page, 'e2e-issue-list-tenant-b@example.com', 'BBB');
  const bItem = await mk(seedB, 'task', 'B-only task');

  await page.goto('/items');
  await expect(page.getByTestId(`issue-row-${bItem.identifier}`)).toBeVisible();
  await expect(page.getByTestId(`issue-row-${aItem.identifier}`)).toHaveCount(0);
});

// ───────────────────────────── SCALE (finding #57) ────────────────────────────
//
// The pagination + lazy-load/virtualization work (2.5.12/2.5.14/2.5.15) only
// DOES anything at real size — a 7-node fixture can't show a second page or an
// unmounted row. This seeds a large project (the shape `pnpm db:seed:large`
// builds, scaled to just past the 50-row boundaries to stay fast) and asserts
// the scale behaviour holds on the real route.

const SCALE_ROOTS = 5; // a handful of root epics (all load — < the 50/level page)
const SCALE_BIG_CHILDREN = 60; // > the per-level page of 50 → "Load more children"

/** Seed a large single-project tree: the FIRST epic is the "big" one (60
 *  children, so it pages); four more small root epics. Total = 65 items > the
 *  50 List page size. Returns the big epic + its (key-ordered) child ids. */
async function seedLarge(
  page: Page,
): Promise<{ seed: Seed; bigEpic: string; firstChild: string; lastLoadedChild: string }> {
  const seed = await seedProject(page, 'e2e-issue-list-scale@example.com', 'BIG');
  const bigEpic = await mk(seed, 'epic', 'Big epic');
  const children: string[] = [];
  for (let c = 0; c < SCALE_BIG_CHILDREN; c++) {
    const child = await mk(seed, 'story', `Child story ${c + 1}`, bigEpic.id);
    children.push(child.identifier);
  }
  for (let r = 1; r < SCALE_ROOTS; r++) await mk(seed, 'epic', `Small epic ${r}`);
  return {
    seed,
    bigEpic: bigEpic.identifier,
    firstChild: children[0]!, // BIG-2 — first child, loaded on expand
    lastLoadedChild: children[49]!, // BIG-51 — the 50th (last) child of page 1
  };
}

test('@smoke SCALE — the List paginates (page size, range, Next/Prev/page-jump)', async ({
  page,
}) => {
  await seedLarge(page);

  await page.goto('/items?view=list');
  await expect(page.getByRole('table', { name: 'Work Items' })).toBeVisible();

  // Page 1 shows the page size (50), NOT all 65 rows, with the honest range.
  await expect(page.getByText('Showing 1–50 of 65')).toBeVisible();
  await expect(page.locator('[data-testid^="issue-row-"]')).toHaveCount(50);

  // Next → page 2: the URL carries ?page=, the range + the row count update.
  await page.getByRole('button', { name: 'Next page' }).click();
  await page.waitForURL((url) => url.searchParams.get('page') === '2');
  await expect(page.getByText('Showing 51–65 of 65')).toBeVisible();
  await expect(page.locator('[data-testid^="issue-row-"]')).toHaveCount(15);

  // Page-jump back to 1 (canonical URL drops the page param), 50 rows again.
  await page.getByRole('button', { name: 'Page 1' }).click();
  await page.waitForURL((url) => url.searchParams.get('page') === null);
  await expect(page.locator('[data-testid^="issue-row-"]')).toHaveCount(50);
});

test('@smoke SCALE — the Tree lazy-loads children and virtualizes (DOM stays bounded)', async ({
  page,
}) => {
  const { bigEpic, firstChild, lastLoadedChild } = await seedLarge(page);

  await page.goto('/items');
  const grid = page.getByRole('treegrid', { name: 'Work Items' });
  await expect(grid).toBeVisible();

  // LAZY: a collapsed parent's children are NOT in the DOM until it is expanded.
  // Expand via the keyboard model (ArrowRight on the focused row) — robust vs a
  // coordinate click on the chevron among same-row z-10 controls.
  await expect(page.getByTestId(`issue-row-${firstChild}`)).toHaveCount(0);
  await page.getByTestId(`issue-row-${bigEpic}`).press('ArrowRight');
  await expect(page.getByTestId(`issue-row-${firstChild}`)).toBeVisible();

  // VIRTUALIZATION: expanding loads the first level page (50 children). With 5
  // roots + 50 children visible, the DOM stays bounded WELL below the 55 visible
  // rows — a windowed slice, not the whole forest.
  const atTop = await renderedRowIds(page);
  expect(atTop.length).toBeGreaterThan(0);
  expect(atTop.length).toBeLessThan(50);
  expect(atTop).toContain(firstChild);
  // The 50th loaded child is off-window — loaded into the model, but not mounted.
  expect(atTop).not.toContain(lastLoadedChild);

  // Scroll the shell viewport to the bottom → the window slides: the off-window
  // rows mount (the "Load more children" affordance for the >page-size parent +
  // the last loaded child), and the top rows unmount. That sliding set IS the
  // virtualization signature (a non-windowed table's DOM wouldn't change).
  await page.locator('#main').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(page.getByText('Load more children')).toBeVisible();
  await expect(page.getByText('Showing 50 of 60')).toBeVisible();
  await expect(page.getByTestId(`issue-row-${lastLoadedChild}`)).toBeVisible();

  const atBottom = await renderedRowIds(page);
  expect(atBottom.length).toBeLessThan(50); // still bounded after the slide
  expect(atBottom).not.toContain(firstChild); // the first child unmounted

  // "Load more children" pulls the next page (children 51–60); once the whole
  // level is loaded the affordance disappears (hasMore → false).
  await page.getByText('Load more children').click();
  await expect(page.getByText('Load more children')).toHaveCount(0);
});
