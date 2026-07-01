// E2E: deleting a sprint from the backlog `⋯` actions menu (Story 4.2 · Subtask
// 4.2.5 — enabled + Delete wired in bug MOTIR-1492), end-to-end over the real
// stack (Next routes + Postgres).
//
// The card's gap was UI-only: the backend (`sprintsService.deleteSprint`, the
// `DELETE /api/sprints/[id]` route) and the SetNull FK that returns a deleted
// sprint's issues to the backlog already shipped; the sprint header `⋯` menu was
// hard-disabled, so a user could not delete a backlog sprint from the UI. This
// spec proves the whole affordance works for real: open the menu on a PLANNED
// sprint, confirm Delete, and see the sprint gone AND its three issues live in
// the backlog with NO manual reload (the same client-island refresh the complete
// flow needs — the sprint list + the backlog list both re-read). It also asserts
// the state gate the AC calls out: on the ACTIVE sprint the Delete item is
// disabled (an active sprint is ended via the complete flow, not deleted).
//
// Reuses the shipped `seedSprintLifecycle` fixture (a planned "main" sprint with
// three issues + an "empty" + a "second" sprint, in one active-pinned project).
// Run: `pnpm test:e2e --grep sprint-delete`.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedSprintLifecycle, type LifecycleSeed } from './_helpers/sprint-lifecycle-seed';

test.describe.configure({ timeout: 120_000 });

const BACKLOG_LIST = 'Backlog work items';

// A sprint container is a <section aria-label="{name}, {state}, {count} issues">
// → an implicit `region`. The confirm dialog portals to <body>, OUTSIDE the
// region, so a region-scoped lookup never matches the dialog's confirm button.
const sprintRegion = (page: Page, name: string): Locator =>
  page.getByRole('region', { name: new RegExp(`^${name},`) });

const backlogList = (page: Page): Locator => page.getByRole('list', { name: BACKLOG_LIST });
const backlogRow = (page: Page, identifier: string): Locator =>
  backlogList(page).getByTestId(`backlog-row-${identifier}`);

async function openBacklog(page: Page, seed: LifecycleSeed): Promise<void> {
  await signIn(page, seed.email, seed.password);
  await page.goto('/backlog');
  await expect(page.getByTestId('backlog-count')).toBeVisible({ timeout: 30_000 });
}

test.describe('sprint delete (4.2.5 / MOTIR-1492)', () => {
  let seed: LifecycleSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedSprintLifecycle('sprint-delete-owner@motir.dev');
  });

  test('delete a planned sprint from the ⋯ menu → sprint gone, its items fall back to the backlog', async ({
    page,
  }) => {
    await openBacklog(page, seed);

    // The planned "main" sprint is present with its three committed issues.
    await expect(sprintRegion(page, seed.mainSprintName)).toBeVisible();
    await expect(page.getByTestId(`sprint-count-${seed.mainSprintId}`)).toHaveText('3');

    // Open the sprint's ⋯ actions menu and pick Delete.
    await page.getByTestId(`sprint-actions-${seed.mainSprintId}`).click();
    await page.getByTestId(`sprint-delete-${seed.mainSprintId}`).click();

    // The focus-trapped confirm dialog opens; confirm.
    const dialog = page.getByRole('dialog', { name: 'Delete sprint?' });
    await expect(dialog).toBeVisible();

    // Arm the authoritative waits BEFORE the confirm click (the CLAUDE.md E2E
    // rule — never lean on assertion auto-retry to catch up to an async write /
    // refetch): the DELETE 204, then the backlog re-read that surfaces the
    // returned items in the already-mounted client-island list.
    const deleted = page.waitForResponse(
      (r) =>
        new RegExp(`/api/sprints/${seed.mainSprintId}$`).test(r.url()) &&
        r.request().method() === 'DELETE',
    );
    const backlogRefetched = page.waitForResponse(
      (r) =>
        /\/api\/backlog(?:\?|$)/.test(r.url()) &&
        r.request().method() === 'GET' &&
        r.status() === 200,
    );
    await dialog.getByRole('button', { name: 'Delete sprint' }).click();
    expect((await deleted).status()).toBe(204);
    await backlogRefetched;

    // The sprint card is gone from the planning view (no manual reload).
    await expect(sprintRegion(page, seed.mainSprintName)).toHaveCount(0);
    await expect(page.getByTestId(`sprint-count-${seed.mainSprintId}`)).toHaveCount(0);

    // Its three issues are live in the backlog list.
    for (const issue of seed.mainIssues) {
      await expect(backlogRow(page, issue.identifier)).toBeVisible();
    }

    // Server truth: the sprint row is deleted and every issue's sprint_id is null.
    await expect
      .poll(async () => db.sprint.findUnique({ where: { id: seed.mainSprintId } }))
      .toBeNull();
    for (const issue of seed.mainIssues) {
      expect((await db.workItem.findUnique({ where: { id: issue.id } }))?.sprintId).toBeNull();
    }
  });

  test('an active sprint cannot be deleted — the ⋯ menu Delete is disabled', async ({ page }) => {
    // Start the main sprint so it is ACTIVE, then reload the backlog.
    await openBacklog(page, seed);
    await sprintRegion(page, seed.mainSprintName)
      .getByRole('button', { name: 'Start sprint' })
      .click();
    await page
      .getByRole('dialog', { name: 'Start sprint' })
      .getByRole('button', {
        name: 'Start sprint',
      })
      .click();
    await page.waitForURL('**/boards', { timeout: 30_000 });
    await expect
      .poll(async () => (await db.sprint.findUnique({ where: { id: seed.mainSprintId } }))?.state)
      .toBe('active');

    await page.goto('/backlog');
    await expect(page.getByTestId('backlog-count')).toBeVisible({ timeout: 30_000 });

    // The active sprint's ⋯ menu offers Delete, but disabled (aria-disabled) — an
    // active sprint is ended via the complete flow, not deleted.
    await page.getByTestId(`sprint-actions-${seed.mainSprintId}`).click();
    await expect(page.getByTestId(`sprint-delete-${seed.mainSprintId}`)).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
