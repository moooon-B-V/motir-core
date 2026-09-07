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
import { withWorkspaceContext } from '@/lib/workspaces/context';

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

// ── MOTIR-1725: the existing-item router is INBOUND-only ─────────────────────
//
// Failing-first repro for the migrate-wizard dead end. The gate above is correct
// on the way IN, but it also fired on the way OUT: the wizard's "Plan my project
// now" hands off to the planning surface, the router saw the non-empty tree and
// bounced the user back into the wizard — which, past `audit_convention`, renders
// only its resume panel, whose CTA hands off again. Planning was unreachable for
// exactly the projects the wizard serves (they imported a backlog, or the gate
// above routed them here BECAUSE the tree was non-empty).
//
// This is asserted at the GATE, not through the wizard UI: the acceptance spec
// drives the wizard against STUBBED migrate routes, so no server-side run exists
// there and the gate could never observe the hand-off. Here the run is real.
test('never-onboarded project mid-hand-off: an active migrate run past set-up lets BOTH onboarding routes through (MOTIR-1725)', async ({
  page,
}) => {
  const seed = await seedRoadmap('migrate-handoff-gate@example.com', { onboarded: false });
  await signIn(page, seed.email, seed.password);

  // `migrate_onboarding` is FORCE-RLS'd on the active-workspace GUC, so the run
  // is written through `withWorkspaceContext` — a bare `db.` insert is denied.
  const wsCtx = { userId: seed.userId, workspaceId: seed.workspaceId };
  const setStep = (step: 'index' | 'discovery', status: 'active' | 'completed' = 'active') =>
    withWorkspaceContext(wsCtx, (tx) =>
      tx.migrateOnboarding.upsert({
        where: { projectId: seed.projectId },
        create: { workspaceId: seed.workspaceId, projectId: seed.projectId, step, status },
        update: { step, status },
      }),
    );

  // Before the hand-off the router still applies — the run is mid-set-up, so the
  // user belongs in the wizard (and this proves the seed really does trip the gate).
  await setStep('index');
  await page.goto('/onboarding/discovery');
  await page.waitForURL('**/onboarding/migrate');

  // Advance the run past set-up — exactly what "Plan my project now" does.
  await setStep('discovery');

  // …now BOTH onboarding routes must let the user through to plan. `/onboarding`
  // matters as much as `/onboarding/discovery`: it was the planning workspace's
  // own entry path until MOTIR-1729 gave it a route of its own (retired in turn
  // by MOTIR-4732, which made the workspace an overlay),
  // the universal "Plan with AI" target.
  await page.goto('/onboarding/discovery');
  await expect(page).toHaveURL(/\/onboarding\/discovery/);

  await page.goto('/onboarding');
  await expect(page).toHaveURL(/\/onboarding(\?|$)/);

  // A COMPLETED run must not keep the router disarmed — once the migrate flow is
  // finished the tree is again the project's understanding. The observable end
  // state is `/roadmap`, not `/onboarding/migrate`: the router DOES re-arm and
  // redirect to the wizard, but the wizard immediately forwards a completed run
  // onward (migrate/page.tsx — "onboarding is done"), so the browser never rests
  // on the intermediate URL. Landing anywhere other than `/onboarding/discovery`
  // is what proves the re-arm — a still-disarmed router would have rendered the
  // discovery loop and stayed put.
  await setStep('discovery', 'completed');
  await page.goto('/onboarding/discovery');
  await page.waitForURL('**/roadmap');
});

// ── MOTIR-2090: the marker closes the SIDE door too ──────────────────────────
//
// `/onboarding/migrate` used to gate only on `run.status === 'completed'`. The
// marker and the run are written by different things — `markOnboardingRan` at
// plan approve+materialize (or the seed / the MOTIR-1799 operator stamp), the run
// only by the wizard walking `review → done` — so an established project could
// hold a permanently `active` run and resume the set-up wizard over a shipped tree
// just by typing the URL. That is the live MOTIR project's exact state
// (`onboarding_ran_at` set, run `active` at `index`), reproduced here.
test('onboarded project with a lingering ACTIVE migrate run: /onboarding/migrate is unreachable by URL (MOTIR-2090)', async ({
  page,
}) => {
  const seed = await seedRoadmap('onboarded-migrate-gate@example.com', { onboarded: true });
  await signIn(page, seed.email, seed.password);

  // `migrate_onboarding` is FORCE-RLS'd on the active-workspace GUC, so the run is
  // written through `withWorkspaceContext` — a bare `db.` insert is denied.
  await withWorkspaceContext({ userId: seed.userId, workspaceId: seed.workspaceId }, (tx) =>
    tx.migrateOnboarding.upsert({
      where: { projectId: seed.projectId },
      create: {
        workspaceId: seed.workspaceId,
        projectId: seed.projectId,
        step: 'index',
        status: 'active',
      },
      update: { step: 'index', status: 'active' },
    }),
  );

  await page.goto('/onboarding/migrate');
  await page.waitForURL('**/roadmap');
});
