// E2E: renaming a sprint from the backlog `⋯` actions menu (bug MOTIR-1493 — the
// Rename sibling of the Delete action MOTIR-1492 enabled), end-to-end over the
// real stack (Next routes + Postgres).
//
// The card's gap was UI-only: the backend (`sprintsService.updateSprint`, the
// `PATCH /api/sprints/[id]` route accepting `{ name }`, with a `complete` sprint
// frozen) already shipped; the ONLY name-setting UI was the Start dialog, which
// forces planned→active, so a user could not rename a sprint without STARTING it.
// This spec proves the whole affordance works for real: open the ⋯ menu on the
// PLANNED sprint, pick Rename, type a new name, save, and see the new name
// re-render in the sprint header AND its region aria-label with NO manual reload
// (the client-island refetch the page-state contract requires — the sprint list
// re-reads `/api/sprints`). It also asserts the state gate the AC calls out: an
// ACTIVE sprint is renameable, and server truth after the write.
//
// Reuses the shipped `seedSprintLifecycle` fixture (a planned "Lifecycle Alpha"
// sprint with three issues). Run: `pnpm test:e2e --grep sprint-rename`.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedSprintLifecycle, type LifecycleSeed } from './_helpers/sprint-lifecycle-seed';

test.describe.configure({ timeout: 120_000 });

// A sprint container is a <section aria-label="{name}, {state}, {count} issues">
// → an implicit `region`. The rename dialog portals to <body>, OUTSIDE the
// region, so a region-scoped lookup never matches the dialog's controls.
const sprintRegion = (page: Page, name: string): Locator =>
  page.getByRole('region', { name: new RegExp(`^${name},`) });

async function openBacklog(page: Page, seed: LifecycleSeed): Promise<void> {
  await signIn(page, seed.email, seed.password);
  await page.goto('/backlog');
  await expect(page.getByTestId('backlog-count')).toBeVisible({ timeout: 30_000 });
}

const NEW_NAME = 'Renamed Sprint Zeta';

test.describe('sprint rename (MOTIR-1493)', () => {
  let seed: LifecycleSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedSprintLifecycle('sprint-rename-owner@motir.dev');
  });

  test('rename a planned sprint from the ⋯ menu → the new name re-renders with no reload', async ({
    page,
  }) => {
    await openBacklog(page, seed);

    // The planned sprint is present under its seeded name.
    await expect(sprintRegion(page, seed.mainSprintName)).toBeVisible();

    // Open the sprint's ⋯ actions menu and pick Rename.
    await page.getByTestId(`sprint-actions-${seed.mainSprintId}`).click();
    await page.getByTestId(`sprint-rename-${seed.mainSprintId}`).click();

    // The focus-trapped rename dialog opens; edit the name.
    const dialog = page.getByRole('dialog', { name: 'Rename sprint' });
    await expect(dialog).toBeVisible();
    const input = dialog.getByTestId(`sprint-rename-input-${seed.mainSprintId}`);
    await input.fill(NEW_NAME);

    // Arm the authoritative waits BEFORE the save click (the CLAUDE.md E2E rule —
    // never lean on assertion auto-retry to catch up to an async write / refetch):
    // the PATCH 200, then the `/api/sprints` re-read that re-renders the header.
    const patched = page.waitForResponse(
      (r) =>
        new RegExp(`/api/sprints/${seed.mainSprintId}$`).test(r.url()) &&
        r.request().method() === 'PATCH',
    );
    const sprintsRefetched = page.waitForResponse(
      (r) =>
        /\/api\/sprints(?:\?|$)/.test(r.url()) &&
        r.request().method() === 'GET' &&
        r.status() === 200,
    );
    await dialog.getByRole('button', { name: 'Save' }).click();
    expect((await patched).status()).toBe(200);
    await sprintsRefetched;

    // The header + region aria-label carry the NEW name (no manual reload); the
    // old name is gone from the planning view.
    await expect(sprintRegion(page, NEW_NAME)).toBeVisible();
    await expect(sprintRegion(page, seed.mainSprintName)).toHaveCount(0);

    // Server truth: the sprint row's name is persisted.
    await expect
      .poll(async () => (await db.sprint.findUnique({ where: { id: seed.mainSprintId } }))?.name)
      .toBe(NEW_NAME);
  });

  test('an active sprint can be renamed — the ⋯ menu Rename is enabled', async ({ page }) => {
    // Start the main sprint so it is ACTIVE, then reload the backlog.
    await openBacklog(page, seed);
    await sprintRegion(page, seed.mainSprintName)
      .getByRole('button', { name: 'Start sprint' })
      .click();
    await page
      .getByRole('dialog', { name: 'Start sprint' })
      .getByRole('button', { name: 'Start sprint' })
      .click();
    await page.waitForURL('**/boards', { timeout: 30_000 });
    await expect
      .poll(async () => (await db.sprint.findUnique({ where: { id: seed.mainSprintId } }))?.state)
      .toBe('active');

    await page.goto('/backlog');
    await expect(page.getByTestId('backlog-count')).toBeVisible({ timeout: 30_000 });

    // The active sprint's ⋯ menu offers Rename, enabled (only a COMPLETE sprint is
    // frozen) — an active sprint's name is editable, Jira-faithful.
    await page.getByTestId(`sprint-actions-${seed.mainSprintId}`).click();
    const rename = page.getByTestId(`sprint-rename-${seed.mainSprintId}`);
    await expect(rename).not.toHaveAttribute('aria-disabled', 'true');
    await rename.click();

    const dialog = page.getByRole('dialog', { name: 'Rename sprint' });
    await expect(dialog).toBeVisible();
    await dialog.getByTestId(`sprint-rename-input-${seed.mainSprintId}`).fill(NEW_NAME);

    const patched = page.waitForResponse(
      (r) =>
        new RegExp(`/api/sprints/${seed.mainSprintId}$`).test(r.url()) &&
        r.request().method() === 'PATCH',
    );
    await dialog.getByRole('button', { name: 'Save' }).click();
    expect((await patched).status()).toBe(200);

    await expect
      .poll(async () => (await db.sprint.findUnique({ where: { id: seed.mainSprintId } }))?.name)
      .toBe(NEW_NAME);
  });
});
