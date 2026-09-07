// Acceptance E2E — the "M" AI callout: the orb opens the menu, and "Plan with
// AI" reaches the planning workspace (Subtask MOTIR-1814, Story MOTIR-1342).
//
// Runs under playwright.acceptance.config.ts (video: 'on'), so the CI
// acceptance-video lane records a chaptered clip; `acceptanceStory()` pins the
// recording to Story MOTIR-1342 regardless of the PR that triggered the run.
// This is the story's `verification_recipe`, automated:
//
//   With AI configured and a project active: click the floating Motir orb
//   bottom-right → the callout menu opens anchored to it → click "Plan with AI"
//   → the planning workspace opens. Re-open the menu and dismiss it with Esc and
//   with an outside click; focus returns to the orb.
//
// ⚠️ ONE MORE CLAUSE MOVED UNDER IT (MOTIR-4730, story MOTIR-4725). The recipe
// said the workspace "opens at /planning"; it is an OVERLAY now, so it opens
// OVER the page the reader is already on and the address gains four namespaced
// parameters instead of changing. The receipt's OWN claim — the orb opens the
// callout, the row reaches the workspace, the menu dismisses — is unchanged, so
// this is a re-point of two assertions rather than a rewrite of the story.
//
// ⚠️ ONE CLAUSE OF THAT RECIPE IS NARROWER IN THE SHIPPED COMPONENT, and this
// spec asserts what ships rather than what the sentence reads like. Focus
// returns to the orb on ESC; after an OUTSIDE CLICK it deliberately does not.
// The callout is `modal={false}`, so Radix's `PopoverContentNonModal` restores
// the trigger only for an inside-originated close — an outside interaction
// leaves focus where the pointer put it. That is the correct non-modal
// behaviour (it does not yank focus back across the viewport to a corner FAB
// the user just clicked away from), so the fix here is the assertion, not the
// component. See the dismissal chapter for the full statement.
//
// ⚠️ THE SELECTOR HAZARD THIS SPEC EXISTS TO RESPECT (MOTIR-1812 moved the name).
// "Plan with AI" now names TWO things: the TopNav hero pill (always in the DOM
// on an authed screen) and the ROW inside the callout (in the DOM only while the
// menu is open). So:
//   • the ORB is addressed by its OWN accessible name — "Motir AI" — never by
//     "Plan with AI", which it no longer carries;
//   • every menu assertion is SCOPED to the open callout panel
//     (`role=dialog`, named "Motir AI"), so it can never match the pill;
//   • the spec asserts the LINK COUNTS around the open, on BOTH namings, because
//     the two names are not the same string. The pill's accessible name is
//     EXACTLY "Plan with AI" (its `aria-label`); the row's is built from its
//     contents, so it is the SUPERSTRING "Plan with AI Generate, expand or
//     re-plan the project". Hence:
//       – exact "Plan with AI" → 1, open or closed. The row can never join it,
//         and that is the referrer guard for the sibling specs that reach for
//         `getByRole('link', { name: 'Plan with AI' }).first()`
//         (`acceptance-plan-change-conversation.spec.ts`) — Playwright matches a
//         string name against the WHOLE accessible name, so `.first()` still
//         resolves to the pill and to nothing else.
//       – substring /Plan with AI/ → 1 closed, 2 open. That is the one that
//         proves the row really did appear, and it is the shape a spec written
//         with a loose regex would be exposed to.
//     Asserting only one of the two would leave the other free to drift.
//
// The gated (AI-not-configured) half of `showPlanWithAi` is NOT asserted here
// and cannot be: this lane sets MOTIR_AI_URL + MOTIR_AI_SERVICE_TOKEN on its
// webServer, so `isMotirAiConfigured()` is true for the whole process and no
// per-test override exists. It is asserted in `tests/e2e/ai-callout-gate.spec.ts`,
// which rides the MAIN lane — where those vars are deliberately unset, so the
// absence is the shipped gate's real behaviour rather than a mock.
//
// DETERMINISM (`notes.html` #37 · `motir-core/CLAUDE.md` § E2E waits on the
// authoritative signal): every wait here is a URL or a role/text landmark. The
// only stub is `/api/ai/access` — the browser→motir-ai billing probe the
// workspace's rail reads on this CLOUD-ON lane — mirroring the shipped
// `acceptance-plan-change-conversation.spec.ts`. Nothing on the callout's own
// path is faked: the orb, the menu, the href and the workspace all run real.

import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedAiAugmentReplan, markProjectOnboarded } from './_helpers/ai-augment-replan-seed';

test.describe.configure({ timeout: 120_000 });

// ── Locators ─────────────────────────────────────────────────────────────────
//
// The orb and the panel share the callout's name ("Motir AI") by design — the
// trigger is named after what it opens (MOTIR-1812) — so they are told apart by
// ROLE, never by name. The planning workspace's conversation rail is a THIRD
// element with that name (`role=complementary`); same rule keeps it distinct.

const orb = (page: Page) => page.getByRole('button', { name: 'Motir AI' });
const callout = (page: Page) => page.getByRole('dialog', { name: 'Motir AI' });
/** Scoped to the open panel — this can never resolve to the TopNav pill. */
const planRow = (page: Page) => callout(page).getByRole('link', { name: /Plan with AI/ });
/** Links whose accessible name is EXACTLY "Plan with AI" — the TopNav pill only
 *  (the menu row's name is a superstring). The sibling specs' `.first()` target. */
const pillLinks = (page: Page) => page.getByRole('link', { name: 'Plan with AI', exact: true });
/** Every link whose name CONTAINS "Plan with AI" — pill + the menu row when open. */
const planLinks = (page: Page) => page.getByRole('link', { name: /Plan with AI/ });
const canvas = (page: Page) => page.getByTestId('roadmap-canvas');
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
/**
 * The page-level heading proving the authed shell is up right after `signIn()`.
 *
 * Sign-in lands on `/home`, not `/dashboard`, since MOTIR-2654 moved the
 * `callbackURL` default. The assertion is unchanged in KIND — a page-level
 * heading proving the shell rendered — only in which page it names, exactly as
 * the non-acceptance twin `ai-callout-gate.spec.ts` was changed by that story.
 */
const landingHeading = (page: Page) => page.getByRole('heading', { name: 'Home', level: 1 });

/**
 * The `/dashboard` page's own heading — and the non-interactive point OUTSIDE
 * the panel that the outside-click dismissal uses as its target.
 *
 * DISTINCT from {@link landingHeading} and
 * deliberately still "Dashboards": the two later chapters `goto('/dashboard')`
 * explicitly, so that is the page they are on. Renaming both to Home would make
 * the spec pass for the wrong reason on the landing and fail on the dashboard.
 */
const dashboardHeading = (page: Page) =>
  page.getByRole('heading', { name: 'Dashboards', level: 1 });

const AI_ACCESS_NA = {
  applicable: false,
  organizationId: null,
  organizationName: null,
  canManageBilling: false,
  hasPaidAiPlan: false,
  balance: 0,
  tierName: null,
  tierAllotment: null,
  renewsAt: null,
};

async function stubAiAccess(page: Page): Promise<void> {
  await page.route('**/api/ai/access', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(AI_ACCESS_NA),
    });
  });
}

/** Open the callout and wait on the panel itself — the authoritative signal that
 *  Radix mounted the content, not a timeout after the click. */
async function openCallout(page: Page): Promise<void> {
  await orb(page).click();
  await expect(callout(page)).toBeVisible();
  await expect(orb(page)).toHaveAttribute('aria-expanded', 'true');
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('the Motir orb opens the AI callout, and Plan with AI reaches the workspace', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-1342');

  const seed = await seedAiAugmentReplan(`ai-callout-${Date.now()}@example.com`);
  // The workspace host forwards a never-onboarded project to /onboarding; this
  // story's destination is the ESTABLISHED-project workspace (MOTIR-1729).
  await markProjectOnboarded(seed.projectId);
  await stubAiAccess(page);

  await signIn(page, seed.email, seed.password);

  await chapter('The floating Motir orb is on the authed shell', async () => {
    await expect(landingHeading(page)).toBeVisible();

    // The orb is present and CLOSED — a trigger, not a menu left hanging open.
    await expect(orb(page)).toBeVisible();
    await expect(orb(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(callout(page)).toHaveCount(0);

    // Closed, the ONLY "Plan with AI" link on the page is the TopNav pill —
    // under either naming (see the header note).
    await expect(pillLinks(page)).toHaveCount(1);
    await expect(planLinks(page)).toHaveCount(1);
    await beat();
  });

  await chapter('Clicking the orb opens the callout menu', async () => {
    await openCallout(page);

    // The panel is the callout — its "Motir AI" header, and the Plan row with
    // its description. Both read INSIDE the panel.
    await expect(callout(page).getByText('Motir AI')).toBeVisible();
    await expect(planRow(page)).toBeVisible();
    await expect(callout(page).getByText('Generate, expand or re-plan the project')).toBeVisible();

    // Open, TWO links carry the phrase — the pill and this row. But the row's
    // name is the superstring, so the EXACT name the sibling specs target still
    // matches the pill alone: opening the menu cannot hijack their `.first()`.
    await expect(planLinks(page)).toHaveCount(2);
    await expect(pillLinks(page)).toHaveCount(1);
    // ⚠️ RE-POINTED (MOTIR-4730). The row used to carry
    // `/planning?mode=project&from=project` — a destination. The workspace is an
    // OVERLAY now, so a row carries the CURRENT page plus the overlay's four
    // namespaced parameters. Asserted as an invariant rather than as a literal,
    // because the address is relative to wherever the reader happens to be.
    const rowHref = await planRow(page).getAttribute('href');
    expect(rowHref).toContain('plan=project');
    expect(rowHref).toContain('planFrom=project');
    expect(rowHref).not.toContain('/planning');
    // Still a real link, so ⌘-click and *Open in new tab* keep working — and a
    // full load of that address renders this page with the workspace over it.
    expect(rowHref?.startsWith(new URL(page.url()).pathname)).toBe(true);
    await beat();
  });

  await chapter('"Plan with AI" opens the workspace OVER the page', async () => {
    // ⚠️ RE-POINTED (MOTIR-4730): this used to `waitForURL(/\/planning\?/)`.
    // The click no longer navigates — it writes four query parameters onto the
    // address the reader is already at, and the workspace opens as a layer.
    const before = new URL(page.url()).pathname;

    await planRow(page).click();
    await page.waitForURL((url) => url.searchParams.get('plan') === 'project');

    // The SAME page, still. That is the whole point of the story: planning is a
    // tool you pick up, not a place you go.
    expect(new URL(page.url()).pathname).toBe(before);

    // The workspace RENDERS — its two panes, by their own landmarks: the
    // project's plan on the canvas, the conversation on the right.
    await expect(canvas(page)).toBeVisible();
    await expect(rail(page)).toBeVisible();
    await beat();
  });

  await chapter('The callout dismisses — Esc and an outside click', async () => {
    // Back on an authed screen with no workspace open. `goto` rather than a
    // close, because this chapter is about the CALLOUT and wants a clean shell —
    // the workspace's own exits are MOTIR-4734's.
    await page.goto('/dashboard');
    await expect(dashboardHeading(page)).toBeVisible();

    // ESC — the panel goes, and focus lands back on the orb that opened it. The
    // keyboard user is never dropped at the top of the document.
    await openCallout(page);
    await page.keyboard.press('Escape');
    await expect(callout(page)).toHaveCount(0);
    await expect(orb(page)).toBeFocused();
    await expect(orb(page)).toHaveAttribute('aria-expanded', 'false');
    await beat();

    // OUTSIDE CLICK — the panel goes, but focus is deliberately NOT pulled back
    // to the orb, and asserting that it were would be asserting a behaviour the
    // app does not have. The callout is `modal={false}`, so it takes Radix's
    // NON-MODAL contract: `PopoverContentNonModal.onCloseAutoFocus` restores the
    // trigger only when the close came from INSIDE (Esc, selecting a row) —
    // after an outside interaction it leaves focus where the pointer put it,
    // rather than yanking it across the viewport to a corner FAB the user just
    // clicked away from. So what is asserted is the honest pair: the panel is
    // gone and collapsed, and focus STAYED WITH THE POINTER — it is inside the
    // content region the click landed in, not pulled back to the orb and not
    // stranded on the removed panel. (The heading itself is not focusable, so
    // the browser parks focus on its nearest focusable ancestor, the `<main>`
    // the skip-link targets — hence the containment check rather than an exact
    // element.)
    await openCallout(page);
    await dashboardHeading(page).click();
    await expect(callout(page)).toHaveCount(0);
    await expect(orb(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(orb(page)).not.toBeFocused();
    expect(
      await page.evaluate(() => {
        const el = document.activeElement;
        return el !== null && document.contains(el) && el.closest('main') !== null;
      }),
    ).toBe(true);

    // And nothing of the menu is left behind for a later spec to trip over.
    await expect(planLinks(page)).toHaveCount(1);
    await expect(pillLinks(page)).toHaveCount(1);
    await beat();
  });
});
