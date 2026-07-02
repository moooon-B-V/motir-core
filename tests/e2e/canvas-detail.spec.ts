// E2E — canvas DETAIL viewing (Subtask 7.20.15 / MOTIR-1356). End-to-end cover
// for the two on-canvas detail surfaces Story 7.20 ships:
//
//   • the work-item QUICK-VIEW modal (7.20.11 / MOTIR-1352) — the "View" peek the
//     roadmap canvas opens for a work-item node, fed by the REAL
//     `GET /api/work-items/peek` read;
//   • the TIER-DOC viewer modal → full page (7.20.14 / MOTIR-1355) — the on-canvas
//     viewer for a produced direction tier, with its empty (no doc) + error paths.
//
// The split mirrors the open-core boundary (the same one onboarding-discovery.spec
// draws): work items live in `motir-core`, so the quick-view flow runs on REAL
// seeded data (a tenant minted through the shipped services) against the real peek
// endpoint. The direction-tier docs live in `motir-ai` (motir-core holds zero AI
// tables — notes.html #97), reached only through the browser's `/api/ai/pre-plan`
// seam, so the tier-doc flow STUBS that seam with inline fixtures via `page.route`
// (NEVER a DB seed — the shipped onboarding canvas reads pre-plan client-side, so a
// route stub is exactly what feeds it). A mutable stub MODE drives the modal's
// ready / empty / error states deterministically: the onboarding hub hydrates
// pre-plan ONCE on mount, so flipping the stub afterwards changes only what each
// subsequent modal re-fetch sees — the hydrated station set (which tiers are
// openable) stays put.
//
// Waits on AUTHORITATIVE signals per `motir-core/CLAUDE.md` (the peek/pre-plan GET
// 200 and the rendered modal), never `waitForTimeout`.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn, signUp, createFirstProject } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';

// Service-side tenant seeding + the sign-in flow + a cold-compiled canvas route
// (/roadmap, /onboarding, /onboarding/direction) comfortably exceed the 30s default.
test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ── Flow 1 — work-item quick-view, on the real roadmap canvas ────────────────

const ROADMAP_PASSWORD = 'canvas-detail-e2e-pass-9';

/**
 * Mint a tenant (sign-in-able owner + workspace + project, project PINNED active)
 * and seed ONE root work item — all through the shipped services (the one
 * sanctioned cross-layer reach for E2E setup, exactly as plans-review-seed does).
 * The /roadmap server component gates empty-vs-populated on a real root read, so
 * the canvas only mounts when a real item exists.
 */
async function seedRoadmapTenant(email: string) {
  const owner = await usersService.createUser({
    email,
    password: ROADMAP_PASSWORD,
    name: 'Roadmap Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Canvas E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Roadmap Canvas',
    identifier: 'RDMP',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // Pin the project active so the active-project-scoped /roadmap route resolves it
  // on sign-in (the same pin plans-review-seed / backlog-seed do).
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  const ctx = { userId: owner.id, workspaceId: workspace.id };
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: 'Checkout flow' },
    ctx,
  );
  return { email, item };
}

test('roadmap canvas: a node "View" opens the work-item quick-view, then closes', async ({
  page,
}) => {
  const seed = await seedRoadmapTenant('canvas-quickview@example.com');
  await signIn(page, seed.email, ROADMAP_PASSWORD);

  await page.goto('/roadmap');
  await expect(page.getByTestId('planning-canvas')).toBeVisible();

  // Select the seeded work-item node (NOT the planning-origin cluster, which is
  // non-viewable) → its "View" button surfaces on the selected card.
  const node = page.locator('[data-node-id]').filter({ hasText: seed.item.title });
  await expect(node).toBeVisible();
  await node.click();
  const viewButton = node.getByTestId('view-button');
  await expect(viewButton).toBeVisible();

  // Open the quick-view; WAIT on the authoritative detail-fetch 200 (not the
  // optimistic skeleton the modal opens with).
  const peek = page.waitForResponse(
    (r) => /\/api\/work-items\/peek\?/.test(r.url()) && r.request().method() === 'GET',
  );
  await viewButton.click();
  expect((await peek).status()).toBe(200);

  // The peek shows the item's identifier / title / status from the real read.
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: seed.item.title })).toBeVisible();
  await expect(dialog.getByText(seed.item.identifier).first()).toBeVisible();
  // "To Do" shows in both the header status pill and the core-fields rail.
  await expect(dialog.getByText('To Do').first()).toBeVisible();

  // Close it.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

// ── Flow 2 — tier-doc viewer modal → full page (+ empty / error) ─────────────

type Tier = 'discovery' | 'vision' | 'feasibility' | 'validation';
const TIERS: Tier[] = ['discovery', 'vision', 'feasibility', 'validation'];

// The plain-language tier titles DirectionDocView renders (from TIER_META) — what
// the reader shows, mirroring onboarding-discovery.spec's reader assertions.
const TIER_LABEL: Record<Tier, string> = {
  discovery: 'Understanding your project',
  vision: "What we'll build",
  feasibility: 'Is it worth building?',
  validation: 'Will people want it?',
};

// A recognizable body sentence per tier, so we assert the actual doc body renders
// (from the stubbed pre-plan), not just the modal chrome.
const TIER_BODY: Record<Tier, string> = {
  discovery: 'Freelancers hate chasing unpaid invoices.',
  vision: 'A calm invoicing workspace that sends and tracks for you.',
  feasibility: 'The unit economics work at a low monthly price.',
  validation: 'Ten freelancers said they would switch today.',
};

function tierDoc(kind: Tier) {
  return {
    // DirectionDocView strips this leading `# …` title and shows TIER_LABEL.
    kind,
    currentBody: `# ${kind} (Tier)\n\n${TIER_BODY[kind]}`,
    currentVersion: 1,
    summary: [],
    versions: [
      {
        version: 1,
        changeReason: null,
        changeKind: null,
        diff: null,
        createdAt: '2026-06-21T00:00:00.000Z',
      },
    ],
  };
}

// A resumed session parked OFF any tier gate (`currentGate: null`), so the loop
// hydrates straight to the HUB canvas (not a full-screen review) with all four
// tiers produced → every tier station is openable + viewable.
const SESSION = {
  classification: 'startup',
  platform: 'web',
  designStarter: null,
  designChoice: null,
  validationTiming: 'standard',
  docSkipSet: [] as string[],
  currentGate: null,
  status: 'active',
  conversation: [],
  createdAt: '2026-06-21T00:00:00.000Z',
  updatedAt: '2026-06-21T00:00:00.000Z',
};

const FULL_PREPLAN = { session: SESSION, docs: TIERS.map(tierDoc), catalog: null };
// Same hydrated state, but the modal's re-fetch is missing the feasibility doc →
// findTierDoc returns null → the modal's EMPTY (no-doc) state.
const MISSING_FEASIBILITY = {
  session: SESSION,
  docs: TIERS.filter((k) => k !== 'feasibility').map(tierDoc),
  catalog: null,
};

type PreplanMode = 'full' | 'missing' | 'error';

/**
 * Stub the browser's pre-plan seam (the only motir-ai surface the onboarding
 * canvas reaches) + the per-level roadmap read (kept empty — this flow exercises
 * the STATIONS, not a work-item tree). `mode()` returns the current stub mode so
 * the test can flip the modal's re-fetch between ready / no-doc / upstream-error
 * AFTER the hub has hydrated.
 */
async function stubOnboarding(page: Page, mode: () => PreplanMode): Promise<void> {
  await page.route('**/api/ai/pre-plan', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (mode() === 'error') {
      return route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'MOTIR_AI_UNAVAILABLE' }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mode() === 'missing' ? MISSING_FEASIBILITY : FULL_PREPLAN),
    });
  });
  await page.route('**/api/projects/*/roadmap*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ nodes: [], edges: [], offLevelBlockers: [] }),
    }),
  );
}

/** Select a tier station and open its on-canvas viewer; WAIT on the pre-plan GET
 *  the modal fires so the assertion races nothing. Returns the dialog. */
async function openTierViewer(page: Page, tier: Tier) {
  const node = page.locator(`[data-node-id="${tier}"]`);
  await node.click();
  // The "View" affordance surfaces once the node is selected AND the hub has
  // hydrated the produced tier (its openable flag) — auto-retry rides out hydrate.
  const viewButton = node.getByTestId('view-button');
  await expect(viewButton).toBeVisible();
  const preplan = page.waitForResponse(
    (r) => /\/api\/ai\/pre-plan/.test(r.url()) && r.request().method() === 'GET',
  );
  await viewButton.click();
  await preplan;
  return page.getByRole('dialog');
}

test('onboarding canvas: tier-doc viewer → full page, plus the empty + error paths', async ({
  page,
}) => {
  let mode: PreplanMode = 'full';
  await stubOnboarding(page, () => mode);

  // Authed onboarding gates on a session + an active project; sign up + create the
  // first project through the real UI, then enter the immersive onboarding hub.
  await signUp(page, 'canvas-tierdoc@example.com');
  await createFirstProject(page, 'Invoicer');

  // The hub is at /onboarding/discovery now (/onboarding is the entrance fork,
  // MOTIR-1462); the tier-doc popup URL (/onboarding/direction/*) is unchanged.
  await page.goto('/onboarding/discovery');
  // Resume hydrates to the HUB: the tier stations render on the canvas.
  await expect(page.locator('[data-node-id="vision"]')).toBeVisible();

  // ── Ready: open a produced (past, non-current) tier → its doc renders ───────
  const dialog = await openTierViewer(page, 'vision');
  // The visible doc title is DirectionDocView's <h1>; the Modal also renders an
  // sr-only <h2> with the same name (its accessible label), so pin level 1.
  await expect(dialog.getByRole('heading', { level: 1, name: TIER_LABEL.vision })).toBeVisible();
  await expect(dialog.getByText(TIER_BODY.vision)).toBeVisible();

  // ── "Open full page" → the shell-less full-page route (a new tab) ───────────
  // The full page reads pre-plan SERVER-side (motir-ai, absent in CI), so we can't
  // assert the doc body there — but the route + its tier breadcrumb are
  // server-rendered from TIER_META, proving navigation landed on the right page.
  const popupPromise = page.waitForEvent('popup');
  await dialog.getByRole('link', { name: 'Open full page' }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  await expect(popup).toHaveURL(/\/onboarding\/direction\/vision$/);
  await expect(popup.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
    TIER_LABEL.vision,
  );
  await popup.close();
  // The modal closed as the full-page link fired (onClose).
  await expect(page.getByRole('dialog')).toBeHidden();

  // ── Empty: a station that's still openable, but its doc is gone from the read ─
  mode = 'missing';
  const emptyDialog = await openTierViewer(page, 'feasibility');
  await expect(emptyDialog.getByText(/isn't ready yet/i)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(emptyDialog).toBeHidden();

  // ── Error: the modal's pre-plan re-fetch fails upstream (motir-ai 502) ──────
  mode = 'error';
  const errorDialog = await openTierViewer(page, 'discovery');
  await expect(errorDialog.getByText(/couldn.t load this doc/i)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(errorDialog).toBeHidden();
});
