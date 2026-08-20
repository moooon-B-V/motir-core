// The shell reserves clearance under the floating Motir orb (bug MOTIR-2763).
//
// The orb (`components/planning/PlanWithAIFab.tsx`) is a `position: fixed`
// 56×56 button inset 20px from the bottom-right at `z-40`, so it owns the
// viewport rect `y ∈ [bottom−76, bottom−20]` on EVERY authed screen it mounts
// on. It participates in no page's flow, so nothing below it reserved the space
// it takes: at the end of a scrolled page the last block's bottom edge landed
// inside that band and the bottom-right control there stopped receiving its own
// clicks. Reported on `/items` (the List pager's `Next page`) and `/home` (the
// cursor pager's `Next`).
//
// ⚠️ WHY THIS RIDES THE CLOUD LANE AND NOT `home.spec.ts` /
// `issue-list-flow.spec.ts`, WHERE THE CARD ASKED FOR IT.
// The guard is only meaningful while the orb is MOUNTED, and `showPlanWithAi`
// (`app/(authed)/layout.tsx`) is `isMotirAiConfigured() && Boolean(activeProject)`
// — a SERVER-side, process-wide read of MOTIR_AI_URL + MOTIR_AI_SERVICE_TOKEN
// with no per-test override and no client seam a `page.route` could reach.
// **The main lane deliberately leaves that pair unset**, and that is a standing
// decision with its own regression guard: `tests/e2e/ai-callout-gate.spec.ts`
// asserts the absence there and goes red if the pair is ever added to
// `playwright.config.ts` (setting it mounts the shell's AI affordances across
// every authed spec and has already broken the mobile settings drawer at 375px,
// where the orb intercepted the hamburger).
//
// So a `trial: true` guard placed in those two files would pass on the PRE-fix
// code — the orb is not there to overlap anything — and would be a permanently
// vacuous green. `playwright.cloud.config.ts` sets both vars on its webServer,
// so the orb genuinely ships here and the hit test is a real one. That is why
// the FIRST assertion of every case below is that the orb is actually mounted:
// an overlap assertion on a page with no overlapping element passes by default.
//
// ⚠️ THE ASSERTION IS A HIT TEST, NOT A LOOK. An overlapped control is still
// perfectly `toBeVisible()` — visibility is a property of the element, and
// being clickable is a property of the STACK above it.
//
// ⚠️ AND `click({ trial: true })` ALONE DOES NOT CATCH IT — MEASURED, not
// assumed. The card prescribed the trial click as the assertion, on the grounds
// that it runs the "receives pointer events" actionability check. Against the
// PRE-fix build it did not fail on either surface; what failed, on both, was the
// explicit `document.elementFromPoint` check below:
//
//   /items Next page: centre (1214,667) inside the orb rect (1204,644 56×56)
//   /home  Next:      centre (1221,680) inside the same rect
//   elementFromPoint → button.fixed right-5 bottom-5 z-40 …  (the orb)
//
// So the PRIMARY assertion here is the explicit hit test, taken at the control's
// own centre with the page at its scroll end. The trial click is kept after it
// as a cheap second opinion, but it is not what makes this spec a guard — a
// spec resting on it alone would have gone green against the broken layout.

import { test, expect, type Page, type Locator } from '@playwright/test';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

/** `/items` List page size is 50 and `/home`'s cursor page size is 25
 *  (`HOME_PAGE_SIZE`), so 65 items paginate BOTH surfaces from one seed. The
 *  creator is written as REPORTER, so all 65 land in the owner's "My work".
 *  Comfortably inside the free tier's 250-work-item cap, which is LIVE on this
 *  cloud-on lane. */
const SEEDED_ITEMS = 65;

interface Seed {
  ctx: ServiceContext;
  projectId: string;
}

async function seedPaginatedProject(page: Page, email: string): Promise<Seed> {
  await signUp(page, email);
  const local = email.split('@')[0]!;
  // SEEDING runs as the OWNER (`adminDb`), never through `@/lib/db` — MOTIR-2939.
  // `workspace` and `workspace_membership` are policy-gated and nothing binds a
  // workspace context here, so under `motir_app` this read returns `[]` and the
  // update below matches no row — neither raising. The `expect(...).not.toBeNull()`
  // guards would then fail confusingly, one layer away from the real cause.
  const user = await adminDb.user.findFirst({ where: { email } });
  const ws = await adminDb.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();

  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Orb Clearance',
    identifier: 'ORB',
  });
  // Pin it ACTIVE — `showPlanWithAi` needs an active project, so without this
  // the orb never mounts and every assertion below would be vacuous.
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });

  const ctx: ServiceContext = { userId: user!.id, workspaceId: ws!.id };
  for (let i = 1; i <= SEEDED_ITEMS; i++) {
    await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: `Clearance item ${i}` },
      ctx,
    );
  }
  return { ctx, projectId: project.id };
}

/** The orb — addressed by its OWN accessible name ("Motir AI"), never by "Plan
 *  with AI", which MOTIR-1812 moved to the TopNav pill and the menu row. */
const orb = (page: Page) => page.getByRole('button', { name: 'Motir AI' });

/** `<main>` is the shell's scroll container (`components/ui/AppLayout.tsx` —
 *  `min-h-0 overflow-y-auto`); the app does not scroll the document, so
 *  `page.mouse.wheel` / `window.scrollTo` would move nothing. */
const scroller = (page: Page) => page.locator('#main');

async function scrollToEnd(page: Page): Promise<void> {
  await scroller(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  // The scroll is synchronous, but let the browser settle a frame so the rects
  // read below are the post-scroll ones.
  await page.evaluate(() => new Promise(requestAnimationFrame));
}

/**
 * The card's real acceptance criterion: at the end of a scrolled page the
 * bottom-right control RECEIVES ITS OWN CLICK.
 *
 * Asserts the orb is mounted first (non-vacuity), then hit-tests at the
 * control's own centre. The measured rects are reported on failure because
 * "intercepts pointer events" alone does not say by HOW much — and the fix is a
 * distance, so the distance is the diagnostic.
 */
async function expectReceivesItsOwnClick(page: Page, control: Locator, label: string) {
  await expect(orb(page), `the orb must be mounted or "${label}" proves nothing`).toBeVisible();
  await scrollToEnd(page);
  await expect(control, label).toBeVisible();

  const [controlBox, orbBox] = await Promise.all([control.boundingBox(), orb(page).boundingBox()]);
  expect(controlBox, `${label}: control has a box`).not.toBeNull();
  expect(orbBox, `${label}: orb has a box`).not.toBeNull();

  // The point a user aims at.
  const centre = {
    x: controlBox!.x + controlBox!.width / 2,
    y: controlBox!.y + controlBox!.height / 2,
  };

  // ── THE PRIMARY ASSERTION ──
  // Who actually receives a click at that point? Pre-fix this resolved to the
  // orb on both surfaces; it must resolve to the control (or something inside
  // it, e.g. the chevron `<svg>`).
  const hit = await page.evaluate((p) => {
    const el = document.elementFromPoint(p.x, p.y);
    if (!el) return { desc: 'nothing', isOrb: false };
    const orbEl = el.closest('[data-orb], button.fixed.z-40');
    return {
      desc: `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 140),
      isOrb: Boolean(orbEl) || el.getAttribute('aria-label') === 'Motir AI',
    };
  }, centre);

  const insideOrb =
    centre.x >= orbBox!.x &&
    centre.x <= orbBox!.x + orbBox!.width &&
    centre.y >= orbBox!.y &&
    centre.y <= orbBox!.y + orbBox!.height;

  const rects =
    `${label}: control centre (${Math.round(centre.x)},${Math.round(centre.y)}) vs orb rect ` +
    `(${Math.round(orbBox!.x)},${Math.round(orbBox!.y)} ${Math.round(orbBox!.width)}×${Math.round(orbBox!.height)}); ` +
    `elementFromPoint → ${hit.desc}`;

  expect(hit.isOrb, `${rects} — the ORB receives the click, not the control`).toBe(false);
  expect(insideOrb, `${rects} — the control's centre sits inside the orb's rect`).toBe(false);

  // A cheap second opinion. Kept deliberately AFTER the checks above: measured
  // against the pre-fix build this did NOT fail, so it is corroboration, never
  // the guard (see the header note).
  await control.click({ trial: true, timeout: 10_000 });
}

test('the /items List pager clears the orb at the end of a scrolled page, and Next actually pages', async ({
  page,
}) => {
  await seedPaginatedProject(page, `orb-clearance-items-${Date.now()}@example.com`);

  await page.goto('/items?view=list');
  await expect(page.getByRole('table', { name: 'Work Items' })).toBeVisible();
  await expect(page.getByText(`Showing 1–50 of ${SEEDED_ITEMS}`)).toBeVisible();

  const next = page.getByRole('button', { name: 'Next page' });
  await expectReceivesItsOwnClick(page, next, '/items pager Next page');

  // AC 1 in full: the click LANDS on the pager — the page advances and the AI
  // callout does not open. (A click that reached the orb would open the dialog.)
  await next.click();
  await page.waitForURL((url) => url.searchParams.get('page') === '2');
  await expect(page.getByText(`Showing 51–${SEEDED_ITEMS} of ${SEEDED_ITEMS}`)).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Motir AI' })).toHaveCount(0);
});

test("the /home cursor pager's Next clears the orb at the end of a scrolled page", async ({
  page,
}) => {
  await seedPaginatedProject(page, `orb-clearance-home-${Date.now()}@example.com`);

  await page.goto('/home');
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();

  // The seed puts all 65 items in "My work" (creator = reporter), so the
  // 25-row cursor page has a `Next`.
  const next = page.getByRole('link', { name: 'Next', exact: true });
  await expectReceivesItsOwnClick(page, next, '/home pager Next');

  await next.click();
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Motir AI' })).toHaveCount(0);
});

/**
 * The RULE itself, asserted once and directly, so a future change to the
 * mechanism (a different property, a different consumer) is still caught even if
 * the two pager surfaces above are restyled or removed.
 *
 * The shell must reserve at least the orb's full reach — 76px = its 56px box
 * plus its 20px inset — below the content column, and it must reserve it ONLY
 * when the orb is actually mounted. The second half is the "no dead space"
 * clause: it is asserted in `tests/e2e/ai-callout-gate.spec.ts`'s lane, where
 * the orb is absent and this variable must still read 1.5rem.
 *
 * ⚠️ Deliberately NOT asserted here: `/boards` and `/plans/[id]` fitting the
 * fold. Both belong to the same criterion, but `/boards` returns a 500 on THIS
 * lane on `origin/main`, before and independently of this change — no board spec
 * rides the cloud lane, and the board page's server reads are not wired for its
 * cloud-on posture. Logged rather than absorbed; the fold measurements for both
 * surfaces, in both orb states, are quoted in the PR body instead.
 */
test("the shell reserves at least the orb's full 76px reach, and only while the orb is mounted", async ({
  page,
}) => {
  await seedPaginatedProject(page, `orb-clearance-rule-${Date.now()}@example.com`);

  await page.goto('/home');
  await expect(orb(page)).toBeVisible();

  const measured = await page.evaluate(() => {
    const main = document.querySelector('#main')!;
    const column = main.firstElementChild as HTMLElement;
    const style = getComputedStyle(column);
    return {
      variable: style.getPropertyValue('--shell-bottom-clearance').trim(),
      paddingBottomPx: parseFloat(style.paddingBottom),
    };
  });

  expect(measured.variable, 'the shell sets the clearance variable when the orb mounts').toBe(
    '6rem',
  );
  expect(
    measured.paddingBottomPx,
    `the content column reserves ${measured.paddingBottomPx}px; the orb reaches 76px up from the ` +
      `viewport bottom, so anything less leaves a control in its band`,
  ).toBeGreaterThanOrEqual(76);
});
