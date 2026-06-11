// E2E: the sprint lifecycle journey (Story 4.4 · the closing test Subtask 4.4.7),
// end-to-end over the real stack (Next routes + Postgres).
//
// The per-subtask service + component tests (tests/integration/sprints/* and
// tests/components/{start,complete}-sprint-dialog, sprint-report) already prove
// the start/complete/report state machine and the dialogs in isolation. THIS
// spec proves the whole lifecycle works for real — a signed-in user planning a
// sprint, STARTING it (the modal → "board opens" navigation), marking work done,
// COMPLETING it (the carry-over chooser), and reading the sprint REPORT — through
// the actual HTTP + DB round-trip. It also asserts the two real-product guard
// states the AC calls out: an empty planned sprint's Start button is disabled,
// and a second start while one sprint is active surfaces the "already active"
// message. The at-scale combined Scrum journey is Story 4.7's, not duplicated
// here (this story's scale proof is the bounded/paginated report asserted in the
// 4.4.3 / 4.4.4 integration tests against db:seed:large).
//
// One seeded tenant (workers=1, serial). The seed goes in-process through the
// shipped services (tests/e2e/_helpers/sprint-lifecycle-seed.ts), the same
// convention backlog-seed.ts / work-item-setup.ts use. The "mark issues done"
// step writes the workflow status directly via the shared Prisma client (the
// sanctioned cross-layer reach for E2E setup) — moving an issue to a done column
// is the Board's surface (Story 4.5), out of this lifecycle spec's scope.
// Run: `pnpm test:e2e --grep sprint-lifecycle`.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedSprintLifecycle, type LifecycleSeed } from './_helpers/sprint-lifecycle-seed';

// The in-process seed (sprints + issues, each its own create transaction) plus
// repeated real sign-ins and the start→board→backlog navigation need more than
// the 30s default.
test.describe.configure({ timeout: 120_000 });

const BACKLOG_LIST = 'Backlog issues';

// A sprint container is a <section aria-label="{name}, {state}, {count} issues">
// → an implicit `region`. Scope per-sprint controls to it; the dialogs portal to
// <body>, OUTSIDE the region, so a region-scoped button lookup never matches a
// dialog's same-named confirm button.
const sprintRegion = (page: Page, name: string): Locator =>
  page.getByRole('region', { name: new RegExp(`^${name},`) });

const backlogList = (page: Page): Locator => page.getByRole('list', { name: BACKLOG_LIST });
const backlogRow = (page: Page, identifier: string): Locator =>
  backlogList(page).getByTestId(`backlog-row-${identifier}`);

/** Sign in as the fixture owner and open /backlog. */
async function openBacklog(page: Page, seed: LifecycleSeed): Promise<void> {
  await signIn(page, seed.email, seed.password);
  await page.goto('/backlog');
  await expect(page.getByTestId('backlog-count')).toBeVisible({ timeout: 30_000 });
}

test.describe('sprint lifecycle (4.4.7)', () => {
  let seed: LifecycleSeed;

  test.beforeAll(async () => {
    await resetDatabase();
    seed = await seedSprintLifecycle('sprint-lifecycle-owner@motir.dev');
  });

  test('an empty planned sprint cannot be started; a sprint with issues can', async ({ page }) => {
    await openBacklog(page, seed);

    // The empty sprint shows its Start button, but disabled (the 4.2.1 rule).
    const emptyStart = sprintRegion(page, seed.emptySprintName).getByRole('button', {
      name: 'Start sprint',
    });
    await expect(emptyStart).toBeVisible();
    await expect(emptyStart).toBeDisabled();

    // The main sprint (three committed issues) has an ENABLED Start button.
    const mainStart = sprintRegion(page, seed.mainSprintName).getByRole('button', {
      name: 'Start sprint',
    });
    await expect(mainStart).toBeEnabled();
  });

  test('plan → start → mark done → complete (carry-over to backlog) → report', async ({ page }) => {
    await openBacklog(page, seed);

    // ── Start the main sprint via the modal ──────────────────────────────────
    await sprintRegion(page, seed.mainSprintName)
      .getByRole('button', { name: 'Start sprint' })
      .click();

    const startDialog = page.getByRole('dialog', { name: 'Start sprint' });
    await expect(startDialog).toBeVisible();
    // The name is prefilled from the planned sprint; the default 2-week duration
    // derives a valid window, so the confirm is ready immediately.
    await expect(startDialog.getByLabel('Sprint name')).toHaveValue(seed.mainSprintName);
    await startDialog.getByLabel('Sprint goal').fill('Land the lifecycle E2E');

    // Confirm → the start POST flips the sprint active and "the board opens"
    // (the flow navigates to /boards).
    await startDialog.getByRole('button', { name: 'Start sprint' }).click();
    await page.waitForURL('**/boards', { timeout: 30_000 });

    // The sprint is active in the DB (real round-trip), with its scope-lock
    // baseline stamped (3 issues · 10 points: 3 + 2 + 5).
    await expect
      .poll(async () => (await db.sprint.findUnique({ where: { id: seed.mainSprintId } }))?.state)
      .toBe('active');
    const startedRow = await db.sprint.findUnique({ where: { id: seed.mainSprintId } });
    expect(startedRow?.committedIssueCount).toBe(3);

    // ── A second start while one sprint is active is blocked up front ─────────
    await page.goto('/backlog');
    await expect(page.getByTestId('backlog-count')).toBeVisible({ timeout: 30_000 });

    await sprintRegion(page, seed.secondSprintName)
      .getByRole('button', { name: 'Start sprint' })
      .click();
    const blockedDialog = page.getByRole('dialog', { name: 'Start sprint' });
    // The up-front "already active" alert names the running sprint, and the
    // confirm is disabled (no second active sprint per project).
    await expect(blockedDialog.getByRole('alert')).toContainText(seed.mainSprintName);
    await expect(blockedDialog.getByRole('button', { name: 'Start sprint' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(blockedDialog).toBeHidden();

    // ── Mark one issue done (the Board's status surface is Story 4.5; here we
    //    set the workflow status directly to set up the done/incomplete split) ─
    await db.workItem.update({
      where: { id: seed.mainIssues[0]!.id },
      data: { status: 'done' },
    });

    // ── Complete the sprint via the carry-over modal ─────────────────────────
    await page.getByTestId(`complete-sprint-${seed.mainSprintId}`).click();
    const completeDialog = page.getByRole('dialog', { name: 'Complete sprint' });
    await expect(completeDialog).toBeVisible();
    // 1 done · 2 incomplete — the chooser offers where the 2 unfinished go.
    await expect(completeDialog).toContainText('2 incomplete issues');
    // Backlog is the default carry-over destination; confirm.
    await completeDialog.getByRole('button', { name: 'Complete sprint' }).click();

    // ── The sprint report renders as the success state ───────────────────────
    const reportDialog = page.getByRole('dialog', {
      name: new RegExp(`${seed.mainSprintName} report`),
    });
    await expect(reportDialog).toBeVisible({ timeout: 30_000 });
    // The points rollup (committed baseline + completed + not-completed) and the
    // two done/incomplete sections are present.
    await expect(reportDialog).toContainText('Committed');
    await expect(reportDialog).toContainText('Completed');
    await expect(reportDialog).toContainText('Not completed');
    // The completed section lists the done issue; the not-completed lists the rest.
    await expect(
      reportDialog.getByTestId(`report-row-${seed.mainIssues[0]!.identifier}`),
    ).toBeVisible();
    await expect(
      reportDialog.getByTestId(`report-row-${seed.mainIssues[1]!.identifier}`),
    ).toBeVisible();

    // Close the report (the "Done" button).
    await reportDialog.getByRole('button', { name: 'Done' }).click();

    // ── Post-conditions: the sprint is complete; the unfinished work carried
    //    back to the backlog; the done issue stayed on the sprint ─────────────
    await expect
      .poll(async () => (await db.sprint.findUnique({ where: { id: seed.mainSprintId } }))?.state)
      .toBe('complete');
    expect(
      (await db.workItem.findUnique({ where: { id: seed.mainIssues[0]!.id } }))?.sprintId,
    ).toBe(seed.mainSprintId); // done issue stays on the completed sprint
    expect(
      (await db.workItem.findUnique({ where: { id: seed.mainIssues[1]!.id } }))?.sprintId,
    ).toBeNull(); // unfinished carried back to the backlog
    expect(
      (await db.workItem.findUnique({ where: { id: seed.mainIssues[2]!.id } }))?.sprintId,
    ).toBeNull();

    // And the carried issues are visible in the backlog list after a reload.
    await page.goto('/backlog');
    await expect(page.getByTestId('backlog-count')).toBeVisible({ timeout: 30_000 });
    await expect(backlogRow(page, seed.mainIssues[1]!.identifier)).toBeVisible();
    await expect(backlogRow(page, seed.mainIssues[2]!.identifier)).toBeVisible();
    // The done issue did NOT return to the backlog.
    await expect(backlogRow(page, seed.mainIssues[0]!.identifier)).toHaveCount(0);
  });
});
