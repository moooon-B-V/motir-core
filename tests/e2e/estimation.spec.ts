// E2E: the story-point estimation journey (Story 4.3 · the closing test Subtask
// 4.3.7), end-to-end over the real stack (Next routes + Postgres).
//
// The per-subtask service + component tests already prove the estimate write,
// the project config CRUD, the bounded sprint/epic roll-ups (incl. the
// statistic switch), and the badge / settings UI in isolation
// (tests/integration/estimation/service.test.ts + tests/components/estimate-
// badge|rollup-displays|estimation-settings-editor). THIS spec proves the same
// estimation session works for real — a signed-in user estimating issues on
// `/backlog` + the issue detail, watching the sprint committed-points + epic
// subtree roll-ups react, and editing the project Estimation settings — and that
// the roll-ups stay BOUNDED aggregates and the surface stays virtualized at
// scale (finding #57). The split mirrors backlog.spec.ts: a functional describe
// + an at-scale describe, each owning its own seeded tenant.
//
// Run: `pnpm test:e2e --grep estimation`.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedEstimationFixture,
  seedScaleEstimation,
  type EstimationSeed,
  type ScaleEstimationSeed,
} from './_helpers/estimation-seed';

// In-process seeds (each issue its own create transaction) + repeated real
// sign-ins need more than the 30s default — same budget backlog.spec.ts uses.
test.describe.configure({ timeout: 120_000 });

const BACKLOG_LIST = 'Backlog issues'; // the bottom region's <ul> aria-label

// ── shared locators / helpers ────────────────────────────────────────────────

const row = (page: Page, identifier: string): Locator =>
  page.getByTestId(`backlog-row-${identifier}`);

const backlogList = (page: Page): Locator => page.getByRole('list', { name: BACKLOG_LIST });

const backlogListRows = (page: Page): Locator =>
  backlogList(page).locator('[data-testid^="backlog-row-"]');

/** Wait for the backlog region to paint: the count badge AND at least one
 *  virtualized row mounted (the badge resolves before the windowed rows do). */
async function waitBacklogReady(page: Page): Promise<void> {
  await expect(page.getByTestId('backlog-count')).toBeVisible({ timeout: 30_000 });
  await expect(backlogListRows(page).first()).toBeVisible({ timeout: 30_000 });
}

/** The estimate badge inside a surface: the only control whose accessible name
 *  mentions "story points" (unestimated → "Set story points"; estimated →
 *  "Story points: N — edit"). */
const estimateBadge = (scope: Locator | Page): Locator =>
  scope.getByRole('button', { name: /story points/i });

/** Open the click-to-edit picker for the badge in `scope` and return its dialog. */
async function openPicker(page: Page, scope: Locator | Page): Promise<Locator> {
  await estimateBadge(scope).first().click();
  const picker = page.getByRole('dialog', { name: 'Set story points' });
  await expect(picker).toBeVisible();
  return picker;
}

/** Estimate the badge in `scope` to a deck value, then wait for the picker to close. */
async function estimateVia(page: Page, scope: Locator | Page, value: number): Promise<void> {
  const picker = await openPicker(page, scope);
  await picker.getByRole('button', { name: `${value} story points` }).click();
  await expect(picker).toBeHidden();
}

async function openBacklog(page: Page, seed: EstimationSeed): Promise<void> {
  await signIn(page, seed.email, seed.password);
  await page.goto('/backlog');
  await waitBacklogReady(page);
}

// ════════════════════════════════════════════════════════════════════════════
// Functional estimation session (4.3.7)
// ════════════════════════════════════════════════════════════════════════════
test.describe('estimation — estimate & roll-up session (4.3.7)', () => {
  let seed: EstimationSeed;

  test.beforeAll(async () => {
    await resetDatabase();
    seed = await seedEstimationFixture('estimation-fn-owner@prodect.dev');
  });

  test('estimate a backlog story via the inline picker — the badge updates and survives reload', async ({
    page,
  }) => {
    await openBacklog(page, seed);

    const storyRow = row(page, seed.backlogStory.identifier);
    // Starts unestimated — the badge reads "Set story points"; the picker offers
    // the project's default Fibonacci deck.
    await expect(estimateBadge(storyRow)).toHaveAccessibleName('Set story points');
    await estimateVia(page, storyRow, 5);

    // The badge now reads the committed value (optimistic write → server write).
    await expect(estimateBadge(storyRow)).toHaveAccessibleName(/Story points: 5/, {
      timeout: 10_000,
    });

    // Persisted: the estimate is still there after a full reload (the real
    // PATCH /api/work-items/[id]/estimate round-trip, not just optimistic UI).
    await page.reload();
    await waitBacklogReady(page);
    await expect(estimateBadge(row(page, seed.backlogStory.identifier))).toHaveAccessibleName(
      /Story points: 5/,
    );
  });

  test('the sprint committed-points roll-up fills the header slot after an estimate (reload)', async ({
    page,
  }) => {
    await openBacklog(page, seed);

    // The sprint container header roll-up starts at the muted "—" (no estimated
    // points yet) — the bounded `rollupForSprint` returns {0,0,0}, never NaN.
    await expect(page.getByLabel('Sprint has no estimated points')).toBeVisible();

    // Estimate the issue that lives INSIDE the sprint.
    await estimateVia(page, row(page, seed.sprintIssue.identifier), 5);
    await expect(estimateBadge(row(page, seed.sprintIssue.identifier))).toHaveAccessibleName(
      /Story points: 5/,
      { timeout: 10_000 },
    );

    // The committed-points figure is read once on mount (the shared
    // useSprintPoints bounded read), so it reflects the estimate after a reload —
    // a planned sprint shows the committed segment only.
    await page.reload();
    await waitBacklogReady(page);
    await expect(page.getByLabel('Points: 5 committed')).toBeVisible({ timeout: 10_000 });
  });

  test('estimating a child rolls up to the epic header total + shows on the detail story-points field', async ({
    page,
  }) => {
    await signIn(page, seed.email, seed.password);

    // Estimate the epic's child on the issue-detail story-points field — the
    // dedicated agile field, DISTINCT from the time "Estimate" field below it.
    // The child is a leaf (no header roll-up), so the story-points badge is the
    // page's only "story points" control.
    await page.goto(`/issues/${seed.childStory.identifier}`);
    await expect(page.getByText('Story points', { exact: true })).toBeVisible();
    await estimateVia(page, page, 8);
    await expect(estimateBadge(page)).toHaveAccessibleName(/Story points: 8/, {
      timeout: 10_000,
    });

    // The epic's header roll-up badge is the SUBTREE sum (one bounded recursive
    // aggregate, server-computed) — labelled so it never reads as the epic's own
    // estimate.
    await page.goto(`/issues/${seed.epic.identifier}`);
    await expect(page.getByLabel('Rolled-up Story points: 8')).toBeVisible({ timeout: 10_000 });

    // …and the same roll-up decorates the epic's row in the issues tree (the
    // compact variant lazily fetches GET /api/work-items/[id]/rollup per parent).
    await page.goto('/issues');
    await expect(page.getByLabel('Rolled-up Story points: 8').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('an admin switches the point scale to custom and the picker deck reflects it', async ({
    page,
  }) => {
    await signIn(page, seed.email, seed.password);
    await page.goto('/settings/project/estimation');

    // Switch the scale to Custom → the custom-value editor appears.
    await page.getByRole('button', { name: 'Custom' }).click();
    await expect(page.getByTestId('estimation-custom')).toBeVisible();

    // Add a single custom value (7) and save through the real PATCH endpoint.
    await page.getByTestId('estimation-add').click();
    await page.getByTestId('estimation-add-input').fill('7');
    await page.getByTestId('estimation-add-input').press('Enter');
    await expect(page.getByTestId('estimation-custom')).toContainText('7');

    const saved = page.waitForResponse(
      (r) =>
        /\/api\/projects\/.*\/estimation-config/.test(r.url()) &&
        r.request().method() === 'PATCH' &&
        r.ok(),
    );
    await page.getByTestId('estimation-save').click();
    await saved;

    // Back on the backlog, the estimate picker now offers the CUSTOM deck (the
    // single "7" chip) instead of the Fibonacci default.
    await page.goto('/backlog');
    await waitBacklogReady(page);
    const picker = await openPicker(page, row(page, seed.backlogStory.identifier));
    await expect(picker.getByRole('button', { name: '7 story points' })).toBeVisible();
    await expect(picker.getByRole('button', { name: '8 story points' })).toHaveCount(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// At scale — bounded roll-ups + virtualized DOM (finding #57)
// ════════════════════════════════════════════════════════════════════════════
test.describe('estimation — at scale (finding #57)', () => {
  let seed: ScaleEstimationSeed;

  test.beforeAll(async () => {
    await resetDatabase();
    seed = await seedScaleEstimation('estimation-scale-owner@prodect.dev');
  });

  test('the sprint + epic roll-ups come from one bounded aggregate each, and the backlog DOM stays bounded', async ({
    page,
  }) => {
    await signIn(page, seed.email, seed.password);

    // The sprint container reads its committed-points roll-up once on mount —
    // capture that response: it is a SINGLE aggregate object (committed /
    // completed / remaining), NOT a dump of the sprint's rows. The committed
    // figure equals the bounded SUM over many estimated issues, proving it is
    // the server aggregate, not a client sum of the loaded page.
    const pointsResp = page.waitForResponse(
      (r) => r.url().includes(`/api/sprints/${seed.sprintId}/points`) && r.ok(),
    );
    await page.goto('/backlog');
    const body = (await (await pointsResp).json()) as {
      committed: number;
      completed: number;
      remaining: number;
    };
    expect(Array.isArray(body)).toBe(false);
    expect(body.committed).toBe(seed.sprintCommitted);

    // The virtualized backlog list mounts only its window — far fewer DOM rows
    // than the seeded backlog count (the finding-#57 "no load-all render" shape).
    await waitBacklogReady(page);
    const mounted = await backlogListRows(page).count();
    expect(mounted).toBeLessThan(seed.backlogCount);

    // The epic subtree roll-up is ONE bounded recursive-CTE aggregate returning
    // a single {total}, not the descendant set — assert it over the real route
    // (page.request shares the signed-in cookie jar).
    const rollupResp = await page.request.get(`/api/work-items/${seed.epic.id}/rollup`, {
      headers: { accept: 'application/json' },
    });
    expect(rollupResp.ok()).toBe(true);
    const rollup = (await rollupResp.json()) as { total: number };
    expect(rollup).toMatchObject({ total: seed.epicTotal });

    // And it renders on the epic header (server-computed, no flash).
    await page.goto(`/issues/${seed.epic.identifier}`);
    await expect(page.getByLabel(`Rolled-up Story points: ${seed.epicTotal}`)).toBeVisible({
      timeout: 10_000,
    });
  });
});
