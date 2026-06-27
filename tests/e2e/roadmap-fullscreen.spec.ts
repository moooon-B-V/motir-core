// Roadmap full-screen E2E (Story MOTIR-1420 / Subtask MOTIR-1425) — the
// browser-level proof of the full-screen affordance (MOTIR-1424): from the
// populated roadmap, the EXPAND control takes the canvas full-viewport, the ESC
// hint appears, ESC exits, and the Exit button also collapses it.
//
// Drives the REAL stack (Next + Postgres) end to end; reuses the roadmap tenant
// seed. Waits on AUTHORITATIVE signals — the per-level roadmap GET and rendered
// DOM/attribute state (the canvas root's `data-fullscreen` flag, driven by the
// component's `expanded` state) — never fixed sleeps (the E2E discipline in
// motir-core/CLAUDE.md). The component layers a deterministic fixed overlay under
// the best-effort browser Fullscreen API, so the flag flips regardless of whether
// headless chromium grants native fullscreen — which is exactly what makes this
// flow deterministic.

import { expect, test, type Page } from '@playwright/test';

import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedRoadmap } from './_helpers/roadmap-seed';

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

const roadmapNav = (page: Page) =>
  page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Roadmap' });

const rootLevelLoad = (page: Page) =>
  page.waitForResponse(
    (r) =>
      r.url().includes('/api/projects/') &&
      r.url().includes('/roadmap') &&
      !r.url().includes('parentId') &&
      r.request().method() === 'GET' &&
      r.ok(),
  );

test('Roadmap: expand to full screen, ESC exits, and the Exit button collapses it', async ({
  page,
}) => {
  const seed = await seedRoadmap('roadmap-fullscreen@example.com');
  await signIn(page, seed.email, seed.password);

  // Reach the populated roadmap via the left-nav entry; wait on the root level.
  const nav = roadmapNav(page);
  await expect(nav).toBeVisible();
  const rootLoaded = rootLevelLoad(page);
  await nav.click();
  await page.waitForURL('**/roadmap');
  await rootLoaded;
  await expect(page.getByTestId('planning-canvas')).toBeVisible();

  const canvas = page.getByTestId('roadmap-canvas');
  const toggle = page.getByTestId('fullscreen-toggle');
  const hint = page.getByTestId('fullscreen-hint');

  // ── Collapsed default ──────────────────────────────────────────────────────
  await expect(toggle).toHaveAttribute('aria-label', 'Enter full screen');
  await expect(canvas).not.toHaveAttribute('data-fullscreen', 'true');
  await expect(hint).toHaveCount(0);

  // ── Expand ─────────────────────────────────────────────────────────────────
  await toggle.click();
  await expect(canvas).toHaveAttribute('data-fullscreen', 'true');
  await expect(toggle).toHaveAttribute('aria-label', 'Exit full screen');
  await expect(hint).toBeVisible();
  // The road stays usable while expanded — the epics are still on the canvas.
  await expect(page.getByText(seed.activeEpicTitle, { exact: true })).toBeVisible();

  // ── ESC exits ──────────────────────────────────────────────────────────────
  await page.keyboard.press('Escape');
  await expect(canvas).not.toHaveAttribute('data-fullscreen', 'true');
  await expect(toggle).toHaveAttribute('aria-label', 'Enter full screen');
  await expect(hint).toHaveCount(0);

  // ── Re-enter, then the Exit BUTTON collapses it ────────────────────────────
  await toggle.click();
  await expect(canvas).toHaveAttribute('data-fullscreen', 'true');
  await toggle.click();
  await expect(canvas).not.toHaveAttribute('data-fullscreen', 'true');
  await expect(toggle).toHaveAttribute('aria-label', 'Enter full screen');
});
