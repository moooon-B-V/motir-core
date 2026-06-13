// E2E: the Backlog / sprint-planning grooming journey (Story 4.2 · the closing
// test Subtask 4.2.6), end-to-end over the real stack (Next routes + Postgres).
//
// The per-subtask service + component tests (tests/integration/sprints/* and
// tests/components/backlog*) already prove the bulk/create composition and the
// selection / drag / create UI in isolation. THIS spec proves the same grooming
// session works for real — a signed-in user on `/backlog` reordering, assigning,
// bulk-moving, and creating issues through the actual HTTP + DB round-trip — and
// that the surface holds its bounded/virtualized/lazy-loaded shape at scale
// (finding #57). The split mirrors the board's: board-ui.spec.ts (functional) +
// board-at-scale*.spec.ts (the at-scale journey).
//
// Two describes, each owning its own seeded tenant (workers=1, serial — the
// scale beforeAll's resetDatabase wipes the grooming tenant only AFTER the
// grooming block has run). Both seed in-process through the shipped services
// (tests/e2e/_helpers/backlog-seed.ts), the same convention work-item-setup.ts /
// seedLargeBoard use. Run: `pnpm test:e2e --grep backlog`.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedGroomingBacklog, seedScaleBacklog, type BacklogSeed } from './_helpers/backlog-seed';

// The in-process seed (a sprint + N backlog issues, each its own create
// transaction) plus repeated real sign-ins need more than the 30s default.
test.describe.configure({ timeout: 120_000 });

const BACKLOG_LIST = 'Backlog issues'; // backlogListLabel — the bottom region's <ul>

// ── shared helpers ──────────────────────────────────────────────────────────

/** A real pointer drag from one element to another — mirrors board-ui.spec.ts's
 *  helper: press, nudge past dnd-kit's 8px activation constraint, glide to the
 *  target, settle so the over-target sticks, release. */
async function pointerDrag(page: Page, from: Locator, to: Locator): Promise<void> {
  await from.scrollIntoViewIfNeeded();
  const f = (await from.boundingBox())!;
  await to.scrollIntoViewIfNeeded();
  const t = (await to.boundingBox())!;
  const fx = f.x + f.width / 2;
  const fy = f.y + f.height / 2;
  const tx = t.x + t.width / 2;
  const ty = t.y + t.height / 2;
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  await page.mouse.move(fx + 14, fy + 8, { steps: 5 }); // clear the 8px activation
  await page.mouse.move(tx, ty, { steps: 18 });
  await page.mouse.move(tx, ty, { steps: 4 }); // settle so the over-target sticks
  await page.mouse.up();
}

const row = (page: Page, identifier: string): Locator =>
  page.getByTestId(`backlog-row-${identifier}`);

const backlogList = (page: Page): Locator => page.getByRole('list', { name: BACKLOG_LIST });
const sprintList = (page: Page, sprintName: string): Locator =>
  page.getByRole('list', { name: `${sprintName} issues` });

// Region-scoped row locators. dnd-kit's DragOverlay renders a CLONE of the
// lifted row carrying the SAME `backlog-row-<id>` testid, and it lingers for the
// drop animation — so a bare getByTestId can transiently match two elements. The
// overlay is portaled OUTSIDE the region <ul>s, so scoping a lookup to a list
// excludes it (and keeps backlog vs sprint copies of a moved row unambiguous).
const backlogRow = (page: Page, identifier: string): Locator =>
  backlogList(page).getByTestId(`backlog-row-${identifier}`);
const sprintRow = (page: Page, sprintName: string, identifier: string): Locator =>
  sprintList(page, sprintName).getByTestId(`backlog-row-${identifier}`);

const backlogListRows = (page: Page): Locator =>
  backlogList(page).locator('[data-testid^="backlog-row-"]');

/** Wait for the backlog region to be fully painted: the count badge AND at least
 *  one virtualized row mounted (the badge resolves before the windowed rows do). */
async function waitBacklogReady(page: Page): Promise<void> {
  await expect(page.getByTestId('backlog-count')).toBeVisible({ timeout: 30_000 });
  await expect(backlogListRows(page).first()).toBeVisible({ timeout: 30_000 });
}

/** The ordered issue identifiers currently mounted in the backlog <ul>. */
async function backlogOrder(page: Page): Promise<string[]> {
  const ids = await backlogListRows(page).evaluateAll((nodes) =>
    nodes.map((n) => (n.getAttribute('data-testid') ?? '').replace('backlog-row-', '')),
  );
  return ids;
}

/** Sign in as the fixture owner and open a fully-loaded /backlog. */
async function openBacklog(page: Page, seed: BacklogSeed): Promise<void> {
  await signIn(page, seed.email, seed.password);
  await page.goto('/backlog');
  await waitBacklogReady(page);
}

// ════════════════════════════════════════════════════════════════════════════
// Grooming session — functional (4.2.6)
// ════════════════════════════════════════════════════════════════════════════
test.describe('backlog — grooming session (4.2.6)', () => {
  let seed: BacklogSeed;

  test.beforeAll(async () => {
    await resetDatabase();
    seed = await seedGroomingBacklog('backlog-groom-owner@motir.dev');
  });

  test('renders the sprint container over the ranked backlog; the Backlog nav leads here', async ({
    page,
  }) => {
    await signIn(page, seed.email, seed.password);

    // Reach /backlog through the sidebar nav item (not a direct goto).
    await page.getByRole('link', { name: 'Backlog', exact: true }).click();
    await page.waitForURL('**/backlog');

    // Sprint container (with its count badge) sits above the backlog list.
    await expect(page.getByTestId(`sprint-count-${seed.sprintId}`)).toHaveText('1');
    await expect(page.getByTestId('backlog-count')).toContainText('5');
    // The seeded sprint issue + a backlog issue both render.
    await expect(row(page, seed.sprintIssues[0]!.identifier)).toBeVisible();
    await expect(row(page, seed.backlogIssues[0]!.identifier)).toBeVisible();
    // The "View all work items" toolbar link deep-links to the issue navigator
    // (Jira "View in Issue Navigator") — NOT a flat list rebuilt here.
    await expect(page.getByRole('link', { name: 'View all work items' })).toHaveAttribute(
      'href',
      /\/issues/,
    );
  });

  test('drag-reorder a backlog row writes a single rank and the order survives reload', async ({
    page,
  }) => {
    await openBacklog(page, seed);

    const first = seed.backlogIssues[0]!.identifier; // "Backlog one" (top)
    const third = seed.backlogIssues[2]!.identifier; // "Backlog three"

    const before = await backlogOrder(page);
    expect(before[0]).toBe(first);

    // Arm the persist-watch BEFORE the drop so we can't miss it: the reorder
    // POSTs the new rank to /api/work-items/<id>/rank. Awaiting the 200 before
    // reloading closes the flake where `page.reload()` raced the in-flight write
    // and read the pre-drag order back.
    const rankWrite = page.waitForResponse(
      (r) => /\/api\/work-items\/[^/]+\/rank$/.test(r.url()) && r.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await pointerDrag(page, backlogRow(page, first), backlogRow(page, third));

    // It left the top slot (moved down between its new neighbours).
    await expect
      .poll(async () => (await backlogOrder(page))[0], { timeout: 10_000 })
      .not.toBe(first);

    // The rank write committed (200) — only now is the reload guaranteed to read
    // the reordered list rather than racing the optimistic UI.
    expect((await rankWrite).status()).toBe(200);

    // Persisted: the new order is the same after a full reload.
    const afterDrag = await backlogOrder(page);
    await page.reload();
    await waitBacklogReady(page);
    expect(await backlogOrder(page)).toEqual(afterDrag);

    // And only the dragged row's rank changed — the count is unchanged (5).
    await expect(page.getByTestId('backlog-count')).toContainText('5');
  });

  test('drag a backlog row into the sprint (assign), then restore it via the ⋯ menu', async ({
    page,
  }) => {
    await openBacklog(page, seed);

    const moving = seed.backlogIssues[1]!.identifier; // "Backlog two"
    const sprintTarget = seed.sprintIssues[0]!.identifier; // the seeded sprint row

    await expect(page.getByTestId(`sprint-count-${seed.sprintId}`)).toHaveText('1');

    // Drop it onto a row inside the sprint → assigned to that sprint.
    await pointerDrag(
      page,
      backlogRow(page, moving),
      sprintRow(page, seed.sprintName, sprintTarget),
    );
    await expect(page.getByTestId(`sprint-count-${seed.sprintId}`)).toHaveText('2', {
      timeout: 10_000,
    });
    // It left the backlog list (the backlog count drops 5 → 4).
    await expect(page.getByTestId('backlog-count')).toContainText('4');
    await expect(backlogRow(page, moving)).toHaveCount(0);

    // Restore via the row's ⋯ menu "Move to backlog" — the deterministic
    // grooming action (also covers the ⋯ menu, an AC bullet). A sprint→backlog
    // DRAG glides downward across regions and can trip dnd-kit autoscroll near
    // the viewport edge; the assign leg above already proves the drag path, so
    // the round-trip's return leg uses the menu (which dispatches the same
    // moveToBacklog the drag would).
    await page.getByTestId(`backlog-row-actions-${moving}`).click();
    await page.getByTestId(`row-move-to-backlog-${moving}`).click();
    await expect(page.getByTestId(`sprint-count-${seed.sprintId}`)).toHaveText('1', {
      timeout: 10_000,
    });
    await expect(page.getByTestId('backlog-count')).toContainText('5');
    // Restored into the backlog list, in rank order.
    await expect(backlogRow(page, moving)).toHaveCount(1);
  });

  test('multi-select two rows and bulk-move them to the sprint in one atomic action', async ({
    page,
  }) => {
    await openBacklog(page, seed);

    const a = seed.backlogIssues[2]!.identifier; // "Backlog three"
    const b = seed.backlogIssues[3]!.identifier; // "Backlog four"

    await expect(page.getByTestId(`sprint-count-${seed.sprintId}`)).toHaveText('1');

    await page.getByTestId(`backlog-row-check-${a}`).click();
    await page.getByTestId(`backlog-row-check-${b}`).click();

    const bar = page.getByTestId('backlog-selection-bar');
    await expect(page.getByTestId('backlog-selection-count')).toContainText('2');

    // One request through the bulk path (4.2.2) — both move together.
    const bulk = page.waitForResponse(
      (r) => /\/api\/sprints\/.*\/issues\/bulk/.test(r.url()) && r.request().method() === 'POST',
    );
    await bar.getByRole('button', { name: 'Move to sprint' }).click();
    await page.getByTestId(`move-to-sprint-${seed.sprintId}`).click();
    await bulk;

    await expect(page.getByTestId(`sprint-count-${seed.sprintId}`)).toHaveText('3', {
      timeout: 10_000,
    });
    await expect(page.getByTestId('backlog-count')).toContainText('3'); // 5 → 3
    // Both DB rows now carry the sprint id (atomic, server-confirmed).
    const movedSprintIds = await db.workItem.findMany({
      where: { id: { in: [seed.backlogIssues[2]!.id, seed.backlogIssues[3]!.id] } },
      select: { sprintId: true },
    });
    expect(movedSprintIds.every((w) => w.sprintId === seed.sprintId)).toBe(true);
  });

  test('inline-create an issue into the backlog (appears in place, count grows)', async ({
    page,
  }) => {
    await openBacklog(page, seed);

    const beforeCount = await backlogListRows(page).count();

    await page.getByTestId('create-issue-backlog').click();
    const input = page.getByTestId('create-issue-input');
    await expect(input).toBeVisible();
    await input.fill('Freshly groomed issue');
    await input.press('Enter');

    // The new row appears in the backlog list without a full reload.
    await expect(
      page.getByRole('list', { name: BACKLOG_LIST }).getByText('Freshly groomed issue'),
    ).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => backlogListRows(page).count(), { timeout: 10_000 })
      .toBeGreaterThan(beforeCount);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// At scale — bounded / virtualized / lazy-loaded (finding #57, 4.2.6)
// ════════════════════════════════════════════════════════════════════════════
test.describe('backlog — at scale (finding #57, 4.2.6)', () => {
  const TOTAL = 120; // > BACKLOG_PAGE_SIZE (50) → paginates; > the window → virtualizes
  let seed: BacklogSeed;

  test.beforeAll(async () => {
    await resetDatabase();
    seed = await seedScaleBacklog('backlog-scale-owner@motir.dev', TOTAL);
  });

  test('renders a bounded count header + a virtualized list (DOM stays bounded)', async ({
    page,
  }) => {
    await openBacklog(page, seed);

    // The count header is the AGGREGATE total, not a loaded-row tally.
    await expect(page.getByTestId('backlog-count')).toContainText(String(TOTAL));

    // Only a window of rows is mounted — far fewer than the 120 total.
    const mounted = await backlogListRows(page).count();
    expect(mounted, 'some rows mounted').toBeGreaterThan(0);
    expect(mounted, 'DOM bounded by virtualization (mounted < total)').toBeLessThan(TOTAL);
  });

  test('lazy-loads further pages on scroll (never a load-all), DOM still bounded', async ({
    page,
  }) => {
    await openBacklog(page, seed);

    const list = page.getByRole('list', { name: BACKLOG_LIST });
    // Page 1 only (50 of 120) loaded → the "all loaded" footer is absent.
    await expect(list.getByText(/All .* loaded/)).toHaveCount(0);

    // Scroll the internal list container to its end repeatedly; each pass fires
    // the cursor loadMore until every page is in (finding #57: paged, not all).
    for (let i = 0; i < 12; i++) {
      const done = await list.getByText(/All .* loaded/).count();
      if (done > 0) break;
      await list.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await page.waitForTimeout(300);
    }
    await expect(list.getByText(/All .* loaded/)).toBeVisible({ timeout: 10_000 });

    // Even with all 120 loaded, the DOM stays windowed (virtualized).
    expect(await backlogListRows(page).count()).toBeLessThan(TOTAL);
  });

  test('drag still reorders out of the virtualized list and persists', async ({ page }) => {
    await openBacklog(page, seed);

    const first = seed.backlogIssues[0]!.identifier; // "Scale issue 001"
    const third = seed.backlogIssues[2]!.identifier; // "Scale issue 003"

    const before = await backlogOrder(page);
    expect(before[0]).toBe(first);

    await pointerDrag(page, backlogRow(page, first), backlogRow(page, third));

    await expect
      .poll(async () => (await backlogOrder(page))[0], { timeout: 10_000 })
      .not.toBe(first);

    // Persisted across reload — the rank write survived.
    const afterDrag = await backlogOrder(page);
    await page.reload();
    await waitBacklogReady(page);
    expect((await backlogOrder(page)).slice(0, 5)).toEqual(afterDrag.slice(0, 5));
    // Count unchanged — a reorder is not a create/delete.
    await expect(page.getByTestId('backlog-count')).toContainText(String(TOTAL));
  });
});
