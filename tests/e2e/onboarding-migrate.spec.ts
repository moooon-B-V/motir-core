import type { Page, Response } from '@playwright/test';

import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp, createFirstProject } from './_helpers/shell-session';
import { stubMigrateRoutes } from './_helpers/onboarding-stubs';

// Migrate-onboarding wizard E2E + acceptance video (MOTIR-936). Runs under
// playwright.acceptance.config.ts (video: 'on') so the CI acceptance-video lane
// records a chaptered clip; the uploader resolves the subtask key up to the
// parent story MOTIR-815 server-side via authorizeAcceptancePublish.
//
// The wizard UI is exercised against stubbed migrate API routes — no live
// GitHub / code-graph / importer / AI in CI.  The stub closure holds mutable
// step state; POST advance / skip-import / start + GET index-status return
// deterministic DTOs.  The real MigrateWizard renders every panel.
//
// Per the CLAUDE.md E2E discipline: every mutation waits on the authoritative
// response signal (page.waitForResponse BEFORE the action), and the index gate
// is read from the Next control's own enabled state, never a fixed wait.
//
// The one-page wizard (MOTIR-8254, design/onboarding-migrate Revisions 1-6):
// with ONE project the run starts on arrival and opens on Connect; with several
// the Start panel offers a choice, the open project picked. Connect reads the
// connected repositories itself and offers Continue. The Import step runs the
// importer inline, Skip import in its Cancel slot (its Continue appears only on
// a finished import, which these stubs never reach).
// Plan my project now stays on this page and opens "A few questions".

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ── Driving the wizard ───────────────────────────────────────────────────────

const isStart = (r: Response) =>
  r.url().endsWith('/onboarding/migrate') && r.request().method() === 'POST';
const isAdvance = (r: Response) => r.url().includes('/advance') && r.request().method() === 'POST';
const isSkip = (r: Response) => r.url().includes('/skip-import') && r.request().method() === 'POST';

/** Two projects (the sign-up default + Invoicer): Start offers the choice; pick Invoicer. */
async function startFromChoice(page: Page): Promise<void> {
  await page.goto('/onboarding/migrate');
  await expect(page.getByRole('heading', { name: 'Migrate an existing codebase' })).toBeVisible();
  await page.getByRole('radio', { name: /Invoicer/ }).check();
  const resp = page.waitForResponse(isStart);
  await page.getByRole('button', { name: 'Start with Invoicer' }).click();
  expect((await resp).status()).toBe(200);
  await expect(
    page.getByRole('heading', { name: 'Connect the repositories in this project' }),
  ).toBeVisible();
}

async function connectToIndex(page: Page): Promise<void> {
  await expect(
    page.getByRole('list', { name: 'Connected repositories' }).getByRole('listitem'),
  ).toHaveCount(3);
  const resp = page.waitForResponse(isAdvance);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  expect((await resp).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Indexing your codebase' })).toBeVisible();
}

async function indexToImport(page: Page): Promise<void> {
  const next = page.getByRole('button', { name: /Next: import your work/ });
  await expect(next).toBeEnabled({ timeout: 10_000 });
  const resp = page.waitForResponse(isAdvance);
  await next.click();
  expect((await resp).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Bring in your existing backlog' })).toBeVisible();
}

async function skipToDecision(page: Page): Promise<void> {
  const resp = page.waitForResponse(isSkip);
  await page.getByRole('button', { name: 'Skip import' }).click();
  expect((await resp).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Plan my project now' })).toBeVisible();
  await expect(page.getByRole('link', { name: "Finish — I'll plan later" })).toBeVisible();
}

// ── Branch A: finish early (the recorded acceptance-video test) ─────────────

test('migrate wizard — finish early: set up → skip import → finish later', async ({
  page,
  chapter,
  acceptanceStory,
}) => {
  // Pin the recorded video to the parent story.  The CI uploader resolves the
  // subtask key (MOTIR-936) up to MOTIR-815 server-side, so the video attaches
  // to the story's acceptance panel.
  acceptanceStory('MOTIR-815');

  await chapter('Sign up — the account has its one default project', async () => {
    await signUp(page, `migrate-a-${Date.now()}@example.com`);
  });

  const stubs = await stubMigrateRoutes(page);
  // The index data fixture uses all-indexed repos, so after the first poll tick
  // the Next button is enabled.  Per-repo rows render on the first poll.
  stubs.completeIndex();

  await chapter(
    'One project: the run starts on arrival at Connect — Connect · Index, then optional Import',
    async () => {
      const resp = page.waitForResponse(isStart);
      await page.goto('/onboarding/migrate');
      expect((await resp).status()).toBe(200);
      // No Start panel with one project (Revision 3).
      await expect(
        page.getByRole('heading', { name: 'Connect the repositories in this project' }),
      ).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Migrate an existing codebase' })).toHaveCount(
        0,
      );

      const rail = page.getByRole('navigation', { name: 'Your migration' });
      await expect(rail.getByText('Connect', { exact: true })).toBeVisible();
      await expect(rail.getByText('Index', { exact: true })).toBeVisible();
      await expect(rail.getByText('Import work items')).toBeVisible();
      await expect(rail.getByText('optional')).toBeVisible();
      // NO convention/audit step (MOTIR-1660).
      await expect(rail.getByText('Audit')).toHaveCount(0);
    },
  );

  await chapter('Connect lists the connected repositories → Continue to Index', async () => {
    const list = page.getByRole('list', { name: 'Connected repositories' });
    await expect(list).toContainText('web');
    await expect(list).toContainText('api');
    await expect(list).toContainText('shared');
    await connectToIndex(page);
  });

  await chapter('Index — per-repo rows + aggregate meter + callout', async () => {
    const indexRegion = page.locator('[aria-live][aria-busy]');
    await expect(indexRegion).toBeVisible();
    await expect(page.getByText('3 of 3 repositories done')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Indexed').first()).toBeVisible();
    await expect(page.getByText(/nothing to approve/)).toBeVisible();
  });

  await chapter('Index complete → the importer, inline (optional)', async () => {
    await indexToImport(page);
    await expect(page.getByRole('list', { name: 'Import work items' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Skip import' })).toBeVisible();
  });

  await chapter('Skip import → land on the plan-now-or-later decision', async () => {
    await skipToDecision(page);
  });

  await chapter('Finish early — lands in the project', async () => {
    await page.getByRole('link', { name: "Finish — I'll plan later" }).click();
    await expect(page).toHaveURL(/\/roadmap/, { timeout: 10_000 });
  });
});

// ── Branch B: continue to plan ──────────────────────────────────────────────

test('migrate wizard — continue to plan: set up → skip import → plan now', async ({ page }) => {
  await signUp(page, `migrate-b-${Date.now()}@example.com`);
  await createFirstProject(page, 'Invoicer');

  const stubs = await stubMigrateRoutes(page);
  stubs.completeIndex();

  await startFromChoice(page);
  await connectToIndex(page);
  await indexToImport(page);
  await skipToDecision(page);

  // Plan now stays on this page and opens "A few questions" (Revision 6).
  const resp = page.waitForResponse(isAdvance);
  await page.getByRole('button', { name: 'Plan my project now' }).click();
  expect((await resp).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'A few questions' }).first()).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/onboarding/migrate');
});

// ── Optional import — Skip ──────────────────────────────────────────────────

test('migrate wizard — optional import: Skip proceeds without importing', async ({ page }) => {
  await signUp(page, `migrate-imp-s-${Date.now()}@example.com`);
  await createFirstProject(page, 'Invoicer');

  const stubs = await stubMigrateRoutes(page);
  stubs.completeIndex();

  await startFromChoice(page);
  await connectToIndex(page);
  await indexToImport(page);

  // The importer runs in the step: its own steps list, Skip import beside it.
  const steps = page.getByRole('list', { name: 'Import work items' });
  await expect(steps).toContainText('Connect');
  await expect(page.getByRole('link', { name: 'Open the importer' })).toHaveCount(0);

  await skipToDecision(page);
});

// ── Index: Next stays disabled while repos are pending ──────────────────────

test('migrate wizard — index gate: Next stays disabled until every repo is indexed', async ({
  page,
}) => {
  await signUp(page, `migrate-idx-${Date.now()}@example.com`);
  await createFirstProject(page, 'Invoicer');

  // Stub with repos in PENDING state — allIndexed stays false.
  await stubMigrateRoutes(page);

  await startFromChoice(page);
  await connectToIndex(page);
  await expect(page.locator('[aria-live][aria-busy]')).toBeVisible();

  // Per-repo rows render after the first poll tick.
  await expect(page.getByText('Queued').first()).toBeVisible({ timeout: 10_000 });
  await expect(
    page.locator('[aria-live][aria-busy]').getByText('0 of 3 repositories done'),
  ).toBeVisible();

  // Next is DISABLED because not all repos are indexed.
  const next = page.getByRole('button', { name: /Next: import your work/ });
  await expect(next).toBeDisabled();

  // The callout explains the gate.
  await expect(page.getByText(/Next stays disabled/)).toBeVisible();
});

// ── Resume — re-open mid-way ────────────────────────────────────────────────

test('migrate wizard — resume: a real run re-opens at the saved step', async ({ page }) => {
  await signUp(page, `migrate-resume-${Date.now()}@example.com`);
  await createFirstProject(page, 'Invoicer');

  // Create a REAL run via the API (no stubs — writes to the DB).
  const resp = await page.request.post('/api/onboarding/migrate');
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  expect(body.step).toBe('connect');

  // Navigate to the wizard — the server component reads the REAL run from the
  // DB and renders Connect, not the Start choice, though there are two projects.
  await page.goto('/onboarding/migrate');
  await expect(
    page.getByRole('heading', {
      name: 'Connect the repositories in this project',
    }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Migrate an existing codebase' })).toHaveCount(0);
});
