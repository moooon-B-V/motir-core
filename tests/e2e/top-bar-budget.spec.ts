// E2E: the top bar's CONTROL BUDGET below `md` (MOTIR-2373 · design/shell
// design-notes.md § *The top bar's control budget*, drawn by MOTIR-2374).
//
// ── THE DEFECT THIS OWNS ────────────────────────────────────────────────────
// The right cluster grew to eight controls, two of them labelled, and could not
// shrink — so it starved the `min-w-0` left cluster to ZERO width and painted
// over the hamburger. The hamburger stayed perfectly VISIBLE the whole time; it
// was simply not the element under the tap. That is why the assertion here is a
// HIT-TEST (`document.elementFromPoint` at the button's centre) and not a
// `toBeVisible()` — a screenshot review cannot catch this, and neither can any
// visibility assertion. It is the wrong thing being ON TOP that breaks it.
//
// ── WHY TWO VIEWPORTS ───────────────────────────────────────────────────────
// The worst band is `sm`–`md` (640–767px), NOT `< md`. At 640px every label used
// to switch on at once and the cluster jumped 350 → 656px inside a 640px
// viewport, while the hamburger was still mounted (it is `md:hidden`, so it
// lives to 767px). A fix scoped to 375px leaves a 128px-wide band broken in
// exactly the same way, and a hit-test asserted only at 375×812 passes while it
// is. So both widths are driven, and 700px is the one that fails if the label
// breakpoint is left at `sm`.
//
// ── WHY THE TWO EXISTING NARROW-WIDTH SPECS DID NOT CATCH IT ────────────────
// `shell-flows` ("mobile drawer opens…") and `settings-area` ("the settings nav
// collapses into the mobile drawer at narrow width") both drive 375px and both
// pass, because the tenants they seed have a QUIET right cluster: no public
// project, and a bell with nothing in it. The bar breaks only in the states real
// usage produces and fixtures do not. So this file seeds the CROWDED one.
//
// ── WHAT THIS FILE CANNOT SEED, AND WHERE THAT LEG IS PROVEN ────────────────
// `showPlanWithAi` is `isMotirAiConfigured() && activeProject` — a process-wide
// SERVER read of MOTIR_AI_URL + MOTIR_AI_SERVICE_TOKEN with no per-test override
// and no client seam a `page.route` could reach, and this lane deliberately
// leaves that pair UNSET (a standing decision `tests/e2e/ai-callout-gate.spec.ts`
// documents and guards — setting it here mounts the shell's AI affordances across
// every authed spec, and has already broken the mobile settings drawer once).
// The pill's leg is therefore proven in `tests/components/top-nav-control-budget
// .test.tsx`, which renders the bar from PROPS with every optional slot live and
// pins the pill to `hidden md:inline-flex` — i.e. `display: none` below `md`, so
// it contributes zero width to the geometry measured here. Between the two files
// the crowded state is covered in full; neither covers it alone.
//
// Per the E2E discipline (CLAUDE.md), nothing here waits on a timeout: the
// hit-test runs only after the shell is proven rendered, and the drawer legs
// wait on the dialog's own role state.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';

const PASSWORD = 'top-bar-budget-e2e-pass-9';
const EMAIL = 'e2e-top-bar-budget@example.com';

/** The widest state this lane can produce: an active PUBLIC project (so the
 *  build-in-public slot renders its indicator — the control whose ungated label
 *  measured 117px at 375px and made the public bar the widest surface in the
 *  product) plus unread notifications (so the bell renders with its badge).
 *  Create + palette + report all mount off the active project. */
async function seedCrowdedShell(): Promise<void> {
  const owner = await usersService.createUser({
    email: EMAIL,
    password: PASSWORD,
    name: 'Zhu Yue',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Budget E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Budget',
    identifier: 'BDG',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // Public → the "Building in public" indicator arm of the stateful slot.
  await db.project.update({ where: { id: project.id }, data: { accessLevel: 'public' } });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  await db.notification.createMany({
    data: [1, 2, 3].map((n) => ({
      workspaceId: workspace.id,
      recipientUserId: owner.id,
      type: 'work_item.mentioned',
      category: 'direct' as const,
      data: {},
      dedupeKey: `top-bar-budget-${n}`,
    })),
  });
}

/** What the browser says is at the CENTRE of the hamburger — the only question
 *  that distinguishes "visible" from "tappable". Returns the chain of tag +
 *  aria-label from the hit element upward, so a failure names the intruder
 *  instead of just saying `false`. */
async function hitTestHamburger(page: Page): Promise<{ hitsHamburger: boolean; chain: string }> {
  return page.evaluate(() => {
    const hamburger = document.querySelector('[aria-label="Open navigation"]');
    if (!hamburger) return { hitsHamburger: false, chain: 'hamburger not in the DOM' };
    const box = hamburger.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const chain: string[] = [];
    for (let el = hit; el && chain.length < 6; el = el.parentElement) {
      chain.push(
        `${el.tagName.toLowerCase()}${el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : ''}`,
      );
    }
    return {
      hitsHamburger: Boolean(hit && (hit === hamburger || hamburger.contains(hit))),
      chain: chain.join(' < ') || 'nothing at that point',
    };
  });
}

test.describe('the top bar’s four-slot budget below md', () => {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test.afterAll(async () => {
    await db.$disconnect();
  });

  test('the hamburger is the element AT its own centre, at 375px AND at 700px', async ({
    page,
  }) => {
    await seedCrowdedShell();
    await signIn(page, EMAIL, PASSWORD);

    // The crowded state is real before anything is measured: an absence — or a
    // hit-test — on a shell that never rendered passes vacuously.
    await expect(page.getByRole('link', { name: 'Building in public — manage' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Notifications,/ })).toBeVisible();

    for (const width of [375, 700]) {
      await page.setViewportSize({ width, height: 812 });
      const hamburger = page.getByRole('button', { name: 'Open navigation' });
      await expect(hamburger, `hamburger mounted at ${width}px`).toBeVisible();

      const { hitsHamburger, chain } = await hitTestHamburger(page);
      expect(
        hitsHamburger,
        `at ${width}px the element at the hamburger’s centre is: ${chain}`,
      ).toBe(true);
    }
  });

  // MOTIR-2556 · design/shell/design-notes.md § *The measurement*.
  //
  // The budget above computes the four-slot ceiling from a 68px floor reserved
  // for the tier nav — and the design pass MEASURED that floor and found it
  // unreachable: `OrgControl` + `WorkspaceSwitcher` cannot compress below 112px
  // between them, because their avatar, chevron and padding are all
  // `flex-none`. So the bar that shipped after this file was written still
  // overflowed by 47px at 320px, the narrowest viewport the app supports —
  // visible to nobody, because a horizontal overflow scrolls rather than
  // repaints, and every element stays "visible" throughout.
  //
  // The context row closes it by carrying ONE tier below `md`. This asserts the
  // outcome rather than the mechanism, so it keeps holding whatever the path
  // does next: at 320px the bar must not overflow AT ALL.
  test('the bar does not overflow at 320px — the narrowest viewport we support', async ({
    page,
  }) => {
    await seedCrowdedShell();
    await signIn(page, EMAIL, PASSWORD);

    // the crowded state is real before anything is measured
    await expect(page.getByRole('link', { name: 'Building in public — manage' })).toBeVisible();

    await page.setViewportSize({ width: 320, height: 812 });

    const overflow = await page.evaluate(() => {
      const nav = document.querySelector('header nav[aria-label]');
      if (!nav) return { found: false, by: 0, content: '' };
      return {
        found: true,
        by: nav.scrollWidth - nav.clientWidth,
        content: (nav.textContent ?? '').trim().slice(0, 120),
      };
    });

    expect(overflow.found, 'the top bar’s nav landmark is in the DOM').toBe(true);
    expect(
      overflow.by,
      `at 320px the bar overflows by ${overflow.by}px; it carries: ${overflow.content}`,
    ).toBeLessThanOrEqual(0);

    // and the hamburger is still the thing at its own centre — an overflow that
    // is merely scrolled off-screen would satisfy the check above alone
    const { hitsHamburger, chain } = await hitTestHamburger(page);
    expect(hitsHamburger, `at 320px the element at the hamburger’s centre is: ${chain}`).toBe(true);
  });

  test('the bar carries FOUR slots below md and the displaced controls leave it', async ({
    page,
  }) => {
    await seedCrowdedShell();
    await signIn(page, EMAIL, PASSWORD);
    await page.setViewportSize({ width: 375, height: 812 });

    const bar = page.getByRole('navigation', { name: 'Global' });
    // The four that stay. Each is icon-only here, which is why each carries an
    // aria-label rather than relying on a now-`lg`-gated visible label.
    for (const name of ['Search', 'Create work item', /^Notifications,/, 'Account menu']) {
      await expect(bar.getByRole('button', { name }), `slot: ${name}`).toBeVisible();
    }
    // The three that leave. `hidden` removes them from the a11y tree, so a role
    // query is the right instrument — and it is the same instrument that would
    // catch a control silently vanishing with nowhere to go.
    await expect(bar.getByRole('button', { name: 'Report' })).toBeHidden();
    await expect(bar.getByRole('button', { name: /^Theme:/ })).toBeHidden();
    await expect(bar.getByRole('link', { name: 'Building in public — manage' })).toBeHidden();

    // Above md the full set is back — the displacement is a budget, not a
    // deletion, and the 640–767px band is inside the range that used to break.
    await page.setViewportSize({ width: 1024, height: 812 });
    await expect(bar.getByRole('button', { name: 'Report' })).toBeVisible();
    await expect(bar.getByRole('button', { name: /^Theme:/ })).toBeVisible();
    await expect(bar.getByRole('link', { name: 'Building in public — manage' })).toBeVisible();
  });

  test('every displaced control is REACHABLE at phone width, in the drawer’s utility strip', async ({
    page,
  }) => {
    // "No control silently disappears" — and the test names WHERE. The door is
    // the hamburger the bar already carries; the room is the strip. (The fourth
    // displaced control, the Plan-with-AI pill, is DROPPED rather than re-homed,
    // because `PlanWithAIFab` already ships on every authed screen under the same
    // gate — that orb's own gate is owned by `ai-callout-gate.spec.ts` and
    // `acceptance-ai-callout.spec.ts`, in the lane where AI is configured.)
    await seedCrowdedShell();
    await signIn(page, EMAIL, PASSWORD);
    await page.setViewportSize({ width: 375, height: 812 });

    // Reaching the room requires the door to WORK — which is the bug, tested by
    // clicking rather than by hit-testing this time.
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer).toBeVisible();

    await expect(drawer.getByRole('button', { name: 'Report' })).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Building in public — manage' })).toBeVisible();

    // The theme toggle is not just present but FUNCTIONAL in its new home. The
    // control announces its own state, so the cycle is readable straight off it
    // — and asserting the NAME rather than `<html data-theme>` cannot pass
    // vacuously the way "system already resolved to light" would.
    const theme = drawer.getByRole('button', { name: /^Theme: System/ });
    await expect(theme).toBeVisible();
    await theme.click();
    await expect(drawer.getByRole('button', { name: /^Theme: Light/ })).toBeVisible();
  });
});
