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

const BACKLOG_LIST = 'Backlog work items';

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
    // baseline stamped (3 work items · 10 points: 3 + 2 + 5).
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
    await expect(completeDialog).toContainText('2 incomplete work items');

    // Constrain the viewport height so the report body (meta + 3-up points +
    // scope line + two issue lists + the burndown/velocity analytics row)
    // exceeds the modal's `max-h-[90vh]` cap — the condition under which the
    // bottom of the report was clipped with no scroll affordance
    // (bug-sprint-report-modal-clipped-burndown).
    await page.setViewportSize({ width: 1024, height: 640 });

    // The success state's burndown slot self-fetches client-side; arm the wait
    // BEFORE the confirm so the report has its FULL height (real chart, not the
    // skeleton) before we measure scrollability.
    const burndownLoaded = page.waitForResponse(
      (r) =>
        new RegExp(`/api/sprints/${seed.mainSprintId}/burndown`).test(r.url()) &&
        r.request().method() === 'GET' &&
        r.status() === 200,
    );
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

    // ── Regression: the report body scrolls; the burndown isn't clipped ──────
    // Wait on the authoritative burndown response so the chart (not the
    // skeleton) is in place before measuring.
    await burndownLoaded;
    const reportBody = reportDialog.getByTestId('sprint-report-modal-body');
    // The body's content is taller than its clip box — i.e. it genuinely
    // overflows and therefore MUST offer a scroll affordance.
    expect(await reportBody.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);
    // The burndown section, at the bottom of the report, is reachable by
    // scrolling INSIDE the modal body (Modal.Body owns the overflow-y-auto
    // recipe). Before the fix it was clipped by the panel's overflow-hidden cap
    // with nothing scrollable, so scrollIntoViewIfNeeded could not surface it.
    const burndownHeading = reportDialog.getByText('Burndown', { exact: true });
    await burndownHeading.scrollIntoViewIfNeeded();
    expect(
      await burndownHeading.evaluate((el) => {
        const dialog = el.closest('[role="dialog"]')!;
        const r = el.getBoundingClientRect();
        const d = dialog.getBoundingClientRect();
        return r.top >= d.top - 1 && r.bottom <= d.bottom + 1;
      }),
    ).toBe(true);
    // The footer (Open full report + Done) stays pinned, not scrolled away.
    await expect(reportDialog.getByRole('button', { name: 'Done' })).toBeInViewport();

    // ── Regression (bug 11): the carried items land in the LIVE backlog with NO
    //    manual reload ─────────────────────────────────────────────────────────
    // Closing the report fires the dialog's `onCompleted`, which (besides
    // re-reading `/api/sprints` metadata) bumps the shared issues-refresh signal
    // so EVERY region's issue list re-reads — here the backlog, the carry-over
    // destination. Before the fix, only the sprint metadata refetched, so the
    // already-mounted backlog list kept its pre-move rows and the carried issues
    // were invisible until a manual reload. Arm the authoritative `/api/backlog`
    // refetch wait BEFORE the close that triggers it (the CLAUDE.md E2E rule:
    // never lean on assertion auto-retry to "catch up" to an async refetch).
    const backlogRefetched = page.waitForResponse(
      (r) =>
        /\/api\/backlog(?:\?|$)/.test(r.url()) &&
        r.request().method() === 'GET' &&
        r.status() === 200,
    );
    await reportDialog.getByRole('button', { name: 'Done' }).click();
    await backlogRefetched;

    // No `page.goto` / reload — the rows appear in the backlog region that was
    // mounted behind the dialog the whole time.
    await expect(backlogRow(page, seed.mainIssues[1]!.identifier)).toBeVisible();
    await expect(backlogRow(page, seed.mainIssues[2]!.identifier)).toBeVisible();
    // The done issue did NOT return to the backlog (source side unregressed).
    await expect(backlogRow(page, seed.mainIssues[0]!.identifier)).toHaveCount(0);

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
  });
});
