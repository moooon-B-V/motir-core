// E2E — the immutable onboarding-ran marker gates BOTH onboarding surfaces off
// ONE source of truth (Subtask 7.4 / MOTIR-1264).
//
// The marker is set ONCE, when a project's first plan is approved + materialized,
// then never cleared (the plansService integration test, MOTIR-1336, proves the
// WRITE — set-once + immutable). THIS spec proves the two READS off it, end to end
// against the real stack:
//   • Gate 1 — `/onboarding`: marker set ⇒ redirect to the project's real surface;
//     marker null ⇒ render the onboarding surface (a never-onboarded project still
//     enters onboarding). Since MOTIR-1462, `/onboarding` is the entrance fork and
//     the discovery hub moved to `/onboarding/discovery`; the gate applies to both.
//     MOTIR-1259: a never-onboarded project WITH existing work items redirects to
//     `/onboarding/migrate` (the migrate wizard) instead of the start-fresh entrance
//     — existing items ARE the project's understanding.
//   • Gate 2 — the roadmap planning-origin cluster (MOTIR-1013): marker set ⇒ the
//     "Idea → Discover · Shape · Validate → Plan" cluster is pinned at the road's
//     start; marker null ⇒ it is omitted (the cluster would otherwise assert a
//     planning journey a never-onboarded project never had).
//
// The marker is SEEDED directly (`seedRoadmap({ onboarded })`) — decoupled from the
// heavy plan-approval flow the integration test already covers. motir-ai has no
// presence in CI, so the onboarding hub's single browser-reachable read
// (`/api/ai/pre-plan`) is stubbed for the render case, exactly as the other
// onboarding specs do.

import { expect, test, type Page } from '@playwright/test';

import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedRoadmap } from './_helpers/roadmap-seed';

// Service-side tenant seeding + sign-in + a cold-compiled /onboarding + /roadmap +
// the canvas render comfortably exceed the 30s default.
test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// The root roadmap LEVEL fetch (no `parentId`) — the authoritative signal the
// canvas has loaded its root nodes, so an "origin omitted" assertion can't pass
// merely because nothing has rendered yet.
const rootLevelLoad = (page: Page) =>
  page.waitForResponse(
    (r) =>
      r.url().includes('/api/projects/') &&
      r.url().includes('/roadmap') &&
      !r.url().includes('parentId') &&
      r.request().method() === 'GET' &&
      r.ok(),
  );

test('onboarded project: /onboarding redirects AND the roadmap shows the planning-origin cluster', async ({
  page,
}) => {
  const seed = await seedRoadmap('onboarded-gate@example.com', { onboarded: true });
  await signIn(page, seed.email, seed.password);

  // ── Gate 1 — /onboarding redirects away (the project already onboarded) ──────
  await page.goto('/onboarding');
  await page.waitForURL('**/roadmap');

  // ── Gate 2 — the SAME marker shows the planning-origin cluster on the road ───
  // The redirect lands on /roadmap; the canvas mounts and the cluster is pinned.
  // `toBeVisible` auto-waits for the canvas's root-level read + render (a READ —
  // the rendered node IS the authoritative signal).
  await expect(page.getByTestId('planning-canvas')).toBeVisible();
  await expect(page.getByTestId('planning-origin')).toBeVisible();
  await expect(page.getByText(seed.activeEpicTitle, { exact: true })).toBeVisible();
});

test('never-onboarded project with existing items: /onboarding redirects to /onboarding/migrate AND the roadmap omits the planning-origin cluster', async ({
  page,
}) => {
  const seed = await seedRoadmap('never-onboarded-gate@example.com', { onboarded: false });
  await signIn(page, seed.email, seed.password);

  // ── Gate 1 — MOTIR-1259: a never-onboarded project WITH existing work items
  //    redirects /onboarding → /onboarding/migrate (the migrate wizard) instead of
  //    showing the start-fresh entrance. Existing items ARE the understanding.
  //    Both /onboarding (entrance fork) and /onboarding/discovery (discovery loop)
  //    detect the non-empty tree and redirect. ───────────────────────────────────
  await page.goto('/onboarding');
  await page.waitForURL('**/onboarding/migrate');

  await page.goto('/onboarding/discovery');
  await page.waitForURL('**/onboarding/migrate');

  // ── Gate 2 — the roadmap mounts the canvas but OMITS the planning-origin ─────
  // Wait on the root-level read so the canvas has rendered its nodes BEFORE we
  // assert the cluster's absence (otherwise "absent" is just "not loaded yet").
  const rootLoaded = rootLevelLoad(page);
  await page.goto('/roadmap');
  await rootLoaded;
  await expect(page.getByTestId('planning-canvas')).toBeVisible();
  await expect(page.getByText(seed.activeEpicTitle, { exact: true })).toBeVisible();
  await expect(page.getByTestId('planning-origin')).toHaveCount(0);
});
