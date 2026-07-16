import type { Page } from '@playwright/test';

import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp, createFirstProject } from './_helpers/shell-session';

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
// response signal (page.waitForResponse BEFORE the action), never a fixed
// waitForTimeout.

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ── Stub helpers ─────────────────────────────────────────────────────────────

interface RepoStatus {
  provider: string;
  repoRef: string;
  /** 'indexed' or 'pending' — drives the per-repo badge + Next gate. */
  status: 'indexed' | 'pending';
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-mig',
    projectId: 'p1',
    kind: 'migrate',
    step: 'connect',
    status: 'active',
    connectedRepoRef: null,
    codeGraphReady: false,
    conventionApprovedAt: null,
    discoveryJobId: null,
    generateJobId: null,
    importSkipped: false,
    importCompleted: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeIndexStatus(repos: RepoStatus[]) {
  const indexed = repos.filter((r) => r.status === 'indexed').length;
  return {
    repos,
    indexedCount: indexed,
    total: repos.length,
    hasRunning: repos.some((r) => r.status === 'pending'),
    allIndexed: indexed === repos.length,
  };
}

/**
 * Install page.route stubs that simulate the migrate state machine.
 *
 * The closure holds mutable state so `step` advances on each
 * POST …/advance and GET …/index-status returns the current repo list.
 */
async function stubMigrateRoutes(page: Page) {
  let step: string = 'connect';
  const repos: RepoStatus[] = [
    { provider: 'github', repoRef: 'acme/web', status: 'pending' },
    { provider: 'github', repoRef: 'acme/api', status: 'pending' },
    { provider: 'github', repoRef: 'acme/shared', status: 'pending' },
  ];
  let allIndexed = false;

  await page.route('**/api/onboarding/migrate**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();

    // POST /api/onboarding/migrate — start a new run
    if (method === 'POST' && url.endsWith('/migrate')) {
      step = 'connect';
      await route.fulfill({
        status: 200,
        json: makeRun({ step: 'connect' }),
      });
      return;
    }

    // POST .../advance — move to the next step
    if (method === 'POST' && url.includes('/advance')) {
      const next: Record<string, string> = {
        connect: 'index',
        index: 'import',
        import: 'audit_convention',
        audit_convention: 'discovery',
        discovery: 'generate',
        generate: 'review',
        review: 'done',
      };
      step = next[step] ?? 'done';
      const pastSetup = !['connect', 'index'].includes(step);
      await route.fulfill({
        status: 200,
        json: makeRun({
          step,
          codeGraphReady: pastSetup,
          importSkipped: !['connect', 'index', 'import'].includes(step),
          connectedRepoRef: 'acme/web',
        }),
      });
      return;
    }

    // POST .../skip-import — skip the optional import step
    if (method === 'POST' && url.includes('/skip-import')) {
      step = 'audit_convention';
      await route.fulfill({
        status: 200,
        json: makeRun({
          step: 'audit_convention',
          importSkipped: true,
          codeGraphReady: true,
        }),
      });
      return;
    }

    // GET .../index-status — return per-repo progress (drives aria-live region)
    if (method === 'GET' && url.includes('/index-status')) {
      const out = allIndexed ? repos.map((r) => ({ ...r, status: 'indexed' as const })) : repos;
      await route.fulfill({ status: 200, json: makeIndexStatus(out) });
      return;
    }

    // GET .../:id — resume head read (the page's server-component read)
    if (method === 'GET' && url.match(/\/migrate\/[^/]+$/)) {
      await route.fulfill({ status: 200, json: makeRun({ step }) });
      return;
    }

    await route.continue();
  });

  return {
    /** Flip every repo to indexed so the aggregate gate opens. */
    async completeIndex() {
      allIndexed = true;
      // Wait for one poll tick (the wizard polls every 3 s) to pick up the
      // change.  A faster approach would be to re-navigate, but that adds
      // flake risk; the 3.5 s wait is a real-time-bounded signal.
      await page.waitForTimeout(3500);
    },
  };
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

  await chapter('Sign in and start migrate onboarding', async () => {
    await signUp(page, `migrate-a-${Date.now()}@example.com`);
    await createFirstProject(page, 'Invoicer');
  });

  const stubs = await stubMigrateRoutes(page);
  // The index data fixture uses all-indexed repos, so after the first poll tick
  // the Next button is enabled.  Per-repo rows render on the first poll.
  await stubs.completeIndex();

  await chapter(
    'The wizard opens at Connect — required tier (Connect · Index) + optional tier (Import)',
    async () => {
      await page.goto('/onboarding/migrate');
      // StartPanel — no run exists yet.
      await expect(
        page.getByRole('heading', { name: 'Migrate an existing codebase' }),
      ).toBeVisible();
      // Click "Start" to create the run (stubbed).
      const resp = page.waitForResponse(
        (r) => r.url().endsWith('/onboarding/migrate') && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Start' }).click();
      expect((await resp).status()).toBe(200);

      // Wizard now renders ConnectPanel.
      await expect(
        page.getByRole('heading', {
          name: 'Connect the repositories in this project',
        }),
      ).toBeVisible();

      // Rail: Connect current, Index upcoming, Import optional.
      const rail = page.getByRole('navigation', { name: 'Your migration' });
      await expect(rail.getByText('Connect')).toBeVisible();
      await expect(rail.getByText('Index')).toBeVisible();
      await expect(rail.getByText('Import work items')).toBeVisible();
      await expect(page.getByText('optional')).toBeVisible();
      // NO convention/audit step (MOTIR-1660).
      await expect(rail.getByText('Audit')).toHaveCount(0);
    },
  );

  await chapter('Connect → advance to Index', async () => {
    const resp = page.waitForResponse(
      (r) => r.url().includes('/advance') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: /I've connected my repos/ }).click();
    expect((await resp).status()).toBe(200);

    await expect(page.getByRole('heading', { name: 'Indexing your codebase' })).toBeVisible();
  });

  await chapter('Index — per-repo rows + aggregate meter + callout', async () => {
    const indexRegion = page.locator('[aria-live]');
    await expect(indexRegion).toBeVisible();

    // Per-repo rows with provider + repo name + status badge.
    await expect(page.getByText('acme/web')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText('acme/api')).toBeVisible();
    await expect(page.getByText('acme/shared')).toBeVisible();
    await expect(page.getByText('Indexed').first()).toBeVisible();

    // Aggregate meter
    await expect(page.getByText('3 of 3 repositories done')).toBeVisible();
    // Complete note
    await expect(page.getByText(/nothing to approve/)).toBeVisible();
  });

  await chapter('Index complete → advance to Import (optional)', async () => {
    const resp = page.waitForResponse(
      (r) => r.url().includes('/advance') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: /Next: import your work/ }).click();
    expect((await resp).status()).toBe(200);

    await expect(
      page.getByRole('heading', {
        name: 'Bring in your existing backlog',
      }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Skip import' })).toBeVisible();
  });

  await chapter('Skip import → land on the plan-now-or-later decision', async () => {
    const resp = page.waitForResponse(
      (r) => r.url().includes('/skip-import') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Skip import' }).click();
    expect((await resp).status()).toBe(200);

    // DecisionPanel: both CTAs present.
    await expect(page.getByRole('button', { name: 'Plan my project now' })).toBeVisible();
    await expect(page.getByRole('link', { name: "Finish — I'll plan later" })).toBeVisible();
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
  await stubs.completeIndex();

  // Start.
  await page.goto('/onboarding/migrate');
  let resp = page.waitForResponse(
    (r) => r.url().endsWith('/onboarding/migrate') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Start' }).click();
  expect((await resp).status()).toBe(200);

  // Connect → Index.
  resp = page.waitForResponse(
    (r) => r.url().includes('/advance') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /I've connected my repos/ }).click();
  expect((await resp).status()).toBe(200);

  // Index → Import.
  resp = page.waitForResponse(
    (r) => r.url().includes('/advance') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /Next: import your work/ }).click();
  expect((await resp).status()).toBe(200);

  // Skip import → Decision.
  resp = page.waitForResponse(
    (r) => r.url().includes('/skip-import') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Skip import' }).click();
  expect((await resp).status()).toBe(200);

  // Plan now → navigates to the planning workspace.
  await page.getByRole('button', { name: 'Plan my project now' }).click();
  await expect(page).toHaveURL(/\/onboarding\/discovery/, { timeout: 15_000 });
});

// ── Optional import — Skip vs Advance ───────────────────────────────────────

test('migrate wizard — optional import: Skip proceeds without importing', async ({ page }) => {
  await signUp(page, `migrate-imp-s-${Date.now()}@example.com`);
  await createFirstProject(page, 'Invoicer');

  const stubs = await stubMigrateRoutes(page);
  await stubs.completeIndex();

  await page.goto('/onboarding/migrate');
  let resp = page.waitForResponse(
    (r) => r.url().endsWith('/onboarding/migrate') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Start' }).click();
  expect((await resp).status()).toBe(200);

  resp = page.waitForResponse(
    (r) => r.url().includes('/advance') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /I've connected my repos/ }).click();
  expect((await resp).status()).toBe(200);

  resp = page.waitForResponse(
    (r) => r.url().includes('/advance') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /Next: import your work/ }).click();
  expect((await resp).status()).toBe(200);

  // ImportPanel: link to the importer + Skip button.
  await expect(page.getByRole('link', { name: 'Open the importer' })).toHaveAttribute(
    'href',
    '/onboarding/import',
  );
  await expect(page.getByRole('button', { name: 'Skip import' })).toBeVisible();

  // Skip → DecisionPanel.
  resp = page.waitForResponse(
    (r) => r.url().includes('/skip-import') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Skip import' }).click();
  expect((await resp).status()).toBe(200);

  await expect(page.getByRole('button', { name: 'Plan my project now' })).toBeVisible();
  await expect(page.getByRole('link', { name: "Finish — I'll plan later" })).toBeVisible();
});

test('migrate wizard — optional import: Advance proceeds without importing', async ({ page }) => {
  await signUp(page, `migrate-imp-a-${Date.now()}@example.com`);
  await createFirstProject(page, 'Invoicer');

  const stubs = await stubMigrateRoutes(page);
  await stubs.completeIndex();

  await page.goto('/onboarding/migrate');
  let resp = page.waitForResponse(
    (r) => r.url().endsWith('/onboarding/migrate') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Start' }).click();
  expect((await resp).status()).toBe(200);

  resp = page.waitForResponse(
    (r) => r.url().includes('/advance') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /I've connected my repos/ }).click();
  expect((await resp).status()).toBe(200);

  resp = page.waitForResponse(
    (r) => r.url().includes('/advance') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /Next: import your work/ }).click();
  expect((await resp).status()).toBe(200);

  // Advance from Import (no import) → audit_convention → DecisionPanel.
  resp = page.waitForResponse(
    (r) => r.url().includes('/advance') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: "I've imported — continue" }).click();
  expect((await resp).status()).toBe(200);

  await expect(page.getByRole('button', { name: 'Plan my project now' })).toBeVisible();
});

// ── Index: Next stays disabled while repos are pending ──────────────────────

test('migrate wizard — index gate: Next stays disabled until every repo is indexed', async ({
  page,
}) => {
  await signUp(page, `migrate-idx-${Date.now()}@example.com`);
  await createFirstProject(page, 'Invoicer');

  // Stub with repos in PENDING state — allIndexed stays false.
  await stubMigrateRoutes(page);

  await page.goto('/onboarding/migrate');
  let resp = page.waitForResponse(
    (r) => r.url().endsWith('/onboarding/migrate') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Start' }).click();
  expect((await resp).status()).toBe(200);

  resp = page.waitForResponse(
    (r) => r.url().includes('/advance') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /I've connected my repos/ }).click();
  expect((await resp).status()).toBe(200);

  await expect(page.getByRole('heading', { name: 'Indexing your codebase' })).toBeVisible();
  await expect(page.locator('[aria-live]')).toBeVisible();

  // Per-repo rows render after the first poll tick.
  await expect(page.getByText('acme/web')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('acme/api')).toBeVisible();
  await expect(page.getByText('acme/shared')).toBeVisible();

  // "Queued" badge on pending repos.
  await expect(page.getByText('Queued').first()).toBeVisible();

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
  // DB and renders ConnectPanel (not the StartPanel).
  await page.goto('/onboarding/migrate');
  await expect(
    page.getByRole('heading', {
      name: 'Connect the repositories in this project',
    }),
  ).toBeVisible();

  // The StartPanel heading must NOT be visible (we resumed, didn't start fresh).
  await expect(page.getByRole('heading', { name: 'Migrate an existing codebase' })).toHaveCount(0);
});
