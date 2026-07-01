// E2E: editing a sprint's start/end dates from the backlog `⋯` actions menu
// (Story 4.2 · Subtask 4.2.5 — the menu was enabled + Delete wired in MOTIR-1492;
// Edit-dates wired in bug MOTIR-1494), end-to-end over the real stack (Next
// routes + Postgres).
//
// The card's gap was UI-only: the backend (`sprintsService.updateSprint`, the
// `PATCH /api/sprints/[id]` route that accepts `startDate`/`endDate`, and the
// `assertWindow` end-≥-start check) already shipped; dates were only settable
// while STARTING the sprint (`StartSprintDialog`). This spec proves the new
// standalone affordance works for real: open the menu on a PLANNED sprint (which
// seeds with NO window, so its header shows "Not started"), pick a start + end,
// Save, and see the header re-read its date range with NO manual reload (the
// `refetchSprints` client-island refresh). A second test asserts the AC's
// end-after-start gate: an end before the start disables Save and shows the
// inline window-invalid alert.
//
// The `DatePicker` is driven by KEYBOARD (the grid's roving-focus model), so the
// selection is deterministic regardless of the runner's calendar date: on open,
// focus lands on today → Enter selects today; ArrowUp moves back one week.
//
// Reuses the shipped `seedSprintLifecycle` fixture (a planned "main" sprint with
// three issues). Run: `pnpm test:e2e --grep sprint-edit-dates`.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedSprintLifecycle, type LifecycleSeed } from './_helpers/sprint-lifecycle-seed';

test.describe.configure({ timeout: 120_000 });

// A sprint container is a <section aria-label="{name}, {state}, {count} issues">
// → an implicit `region`. The edit dialog + its DatePicker calendars portal to
// <body>, OUTSIDE the region, so calendar/dialog lookups run page-scoped.
const sprintRegion = (page: Page, name: string): Locator =>
  page.getByRole('region', { name: new RegExp(`^${name},`) });

/** Today as a UTC `YYYY-MM-DD` key — matches the DatePicker's UTC date math and
 *  the UTC-midnight the window persists as. */
function todayKey(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
}

async function openBacklog(page: Page, seed: LifecycleSeed): Promise<void> {
  await signIn(page, seed.email, seed.password);
  await page.goto('/backlog');
  await expect(page.getByTestId('backlog-count')).toBeVisible({ timeout: 30_000 });
}

async function openEditDatesDialog(page: Page, seed: LifecycleSeed): Promise<Locator> {
  await page.getByTestId(`sprint-actions-${seed.mainSprintId}`).click();
  await page.getByTestId(`sprint-edit-dates-${seed.mainSprintId}`).click();
  const dialog = page.getByRole('dialog', { name: 'Edit sprint dates' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('sprint edit dates (4.2.5 / MOTIR-1494)', () => {
  let seed: LifecycleSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedSprintLifecycle('sprint-edit-dates-owner@motir.dev');
  });

  test('edit a planned sprint’s dates from the ⋯ menu → persists + header re-reads', async ({
    page,
  }) => {
    await openBacklog(page, seed);

    // The planned "main" sprint has no window yet → the header reads "Not started".
    const region = sprintRegion(page, seed.mainSprintName);
    await expect(region).toBeVisible();
    await expect(region.getByText('Not started')).toBeVisible();

    const dialog = await openEditDatesDialog(page, seed);

    // Pick start = today: open the calendar (focus lands on today) → Enter selects.
    await dialog.getByRole('button', { name: 'Start date' }).click();
    await expect(page.getByRole('dialog', { name: 'Start date' })).toBeVisible();
    await page.keyboard.press('Enter');

    // Pick end = today the same way (end ≥ start holds — equal is allowed).
    await dialog.getByRole('button', { name: 'End date' }).click();
    await expect(page.getByRole('dialog', { name: 'End date' })).toBeVisible();
    await page.keyboard.press('Enter');

    // Arm the authoritative waits BEFORE Save (the CLAUDE.md E2E rule — never lean
    // on assertion auto-retry to catch up to an async write / refetch): the PATCH
    // 200, then the `/api/sprints` metadata re-read that re-renders the header.
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
    await dialog.getByRole('button', { name: 'Save dates' }).click();
    expect((await patched).status()).toBe(200);
    await sprintsRefetched;

    // The header re-read its range (no manual reload): "Not started" is gone.
    await expect(region.getByText('Not started')).toHaveCount(0);

    // Server truth: both endpoints persisted to today's UTC date.
    const today = todayKey();
    await expect
      .poll(async () => {
        const s = await db.sprint.findUnique({ where: { id: seed.mainSprintId } });
        return s?.startDate ? s.startDate.toISOString().slice(0, 10) : null;
      })
      .toBe(today);
    const persisted = await db.sprint.findUnique({ where: { id: seed.mainSprintId } });
    expect(persisted?.endDate?.toISOString().slice(0, 10)).toBe(today);
  });

  test('an end before the start disables Save and shows the window-invalid alert', async ({
    page,
  }) => {
    await openBacklog(page, seed);
    const dialog = await openEditDatesDialog(page, seed);

    // start = today.
    await dialog.getByRole('button', { name: 'Start date' }).click();
    await expect(page.getByRole('dialog', { name: 'Start date' })).toBeVisible();
    await page.keyboard.press('Enter');

    // end = today − 7 days (ArrowUp moves the roving focus back one week) → the
    // effective window is invalid (end < start).
    await dialog.getByRole('button', { name: 'End date' }).click();
    await expect(page.getByRole('dialog', { name: 'End date' })).toBeVisible();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');

    // The inline window-invalid alert shows and Save is disabled — the client gate
    // front-runs the server's `assertWindow` (422).
    await expect(
      dialog.getByText('The end date must be on or after the start date.'),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save dates' })).toBeDisabled();

    // Nothing was written — the sprint window is still unset.
    const row = await db.sprint.findUnique({ where: { id: seed.mainSprintId } });
    expect(row?.startDate).toBeNull();
    expect(row?.endDate).toBeNull();
  });
});
