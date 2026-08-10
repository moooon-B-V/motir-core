import { expect, test, type Page } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signUp, createFirstProject, createWorkspace } from './_helpers/shell-session';

// Story MOTIR-2554 · Subtask MOTIR-2559 — the shell's CONTEXT PATH, in a browser
// (`design/shell/design-notes.md` § *The context row*).
//
// ── WHY EVERY STEP SETS ITS OWN VIEWPORT ────────────────────────────────────
// The design made the path BAND-dependent, so a step that does not pin its
// width asserts nothing reliable. What is on screen:
//
//   < 768      the PROJECT alone — the ancestors are in the drawer header
//   768–1279   `org › project`, the org as its MARK (no name, no workspace)
//   ≥ 1280     `org › workspace › project`
//
// A three-tier assertion at the runner's default viewport would pass or fail on
// what that default happens to be. Every test below sets one.
//
// ── AND WHY HALF OF IT IS ABSENCES ──────────────────────────────────────────
// A spec that checked the three tiers are present would pass just as happily on
// a build that ALSO left the old project header in the rail — which is the
// regression this story is most likely to grow later. So the absences are
// asserted as deliberately as the presences: no workspace tier at one
// workspace, none at 1024, no ancestors at 375, and no project control anywhere
// inside the navigation landmark.
//
// What this spec does NOT re-cover: the create / switch / archive FLOWS
// (`projects-flow.spec.ts`), the four-slot right-cluster budget and the
// hamburger hit-test at 375/700 (`top-bar-budget.spec.ts` — which this story
// extends with a 320px overflow assertion of its own), and the ⌘K switch path
// (`shell-flows.spec.ts`). Those specs reach the switcher by its accessible
// name, so they followed it into the bar without a change.

// ≥ xl — the full path. 1440 rather than 1280 ON PURPOSE: `xl` is 1280 and a
// media query reads the LAYOUT viewport, which a classic scrollbar shortens by
// ~15px. At exactly 1280 the run therefore straddles the boundary — headless
// CI landed at ~1265 and correctly rendered the md–xl path, so the assertion
// failed on a product that was behaving. Asserting a band AT its first pixel
// tests the scrollbar, not the ladder.
const WIDE = { width: 1440, height: 812 };
const MEDIUM = { width: 1024, height: 812 }; // md–xl — org mark + project
const PHONE = { width: 375, height: 812 };
const NARROWEST = { width: 320, height: 812 }; // the narrowest we support

/** The top bar's landmark — everything here is asserted INSIDE it, so a control
 *  that merely exists somewhere on the page cannot satisfy a claim about the
 *  bar. */
function bar(page: Page) {
  return page.locator('header nav[aria-label]');
}

function rail(page: Page) {
  return page.getByRole('navigation', { name: 'Primary' });
}

/** What the browser says is at the CENTRE of the hamburger — the only question
 *  that distinguishes "visible" from "tappable" (the assertion MOTIR-2373 was
 *  written around, re-run here because this story widens the same row). */
async function hamburgerIsHittable(page: Page): Promise<{ ok: boolean; chain: string }> {
  return page.evaluate(() => {
    const hamburger = document.querySelector('[aria-label="Open navigation"]');
    if (!hamburger) return { ok: false, chain: 'hamburger not in the DOM' };
    const box = hamburger.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const chain: string[] = [];
    for (let el = hit; el && chain.length < 6; el = el.parentElement) {
      const label = el.getAttribute('aria-label');
      chain.push(`${el.tagName.toLowerCase()}${label ? `[${label}]` : ''}`);
    }
    return {
      ok: Boolean(hit && (hit === hamburger || hamburger.contains(hit))),
      chain: chain.join(' < ') || 'nothing at that point',
    };
  });
}

/** The bar's project tier — the path's last crumb. */
function projectTier(page: Page) {
  return bar(page).getByRole('button', { name: 'Switch project' });
}

/** Create a project AND wait for the bar to say so.
 *
 *  `createFirstProject` returns on the toast, which is client-side; the bar is
 *  SERVER-rendered from the layout's `activeProject`, so it updates a beat later
 *  when the refresh lands. Asserting anything about the bar — a hit-test most of
 *  all — without waiting for this reads the PRE-create state and fails on a
 *  door that is correctly there (the CLAUDE.md rule: wait on the authoritative
 *  signal, never on the optimistic one). */
async function createProjectAndSettle(page: Page, name: string): Promise<void> {
  await createFirstProject(page, name);
  await expect(projectTier(page)).toContainText(name);
}

test.describe('the shell’s context path', () => {
  test.beforeEach(async ({ page }) => {
    await resetDatabase();
    await page.setViewportSize(WIDE);
  });

  test('one workspace reads org › project, and the project switches from the bar', async ({
    page,
  }) => {
    await signUp(page, `context-path-${Date.now()}@example.com`);
    await createProjectAndSettle(page, 'Mobile App');

    // ── 1 · two tiers ────────────────────────────────────────────────────────
    const org = bar(page).getByRole('button', { name: 'Organization menu' });
    const project = projectTier(page);
    await expect(org).toBeVisible();
    await expect(project).toContainText('Mobile App');
    // the middle tier stays implicit at one workspace — Story 6.10.5's rule,
    // which this story kept rather than replaced
    await expect(bar(page).getByRole('button', { name: 'Switch workspace' })).toHaveCount(0);

    // ── 2 · switch, from the bar ─────────────────────────────────────────────
    // a second project to switch TO, made through the switcher's own door
    await project.click();
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('heading', { name: 'Create project' })).toBeVisible();
    await page.getByLabel('Project name').fill('Marketing Site');
    await page.getByRole('button', { name: 'Create project', exact: true }).last().click();
    await expect(page.getByText('Project created', { exact: true }).first()).toBeVisible();
    await expect(project).toContainText('Marketing Site');

    await project.click();
    await page.getByRole('button', { name: 'Mobile App' }).click();
    // the authoritative signal the switch itself uses: it lands on the
    // work-items surface rather than refreshing in place
    await page.waitForURL('**/items**');
    await expect(project).toContainText('Mobile App');
  });

  test('a second workspace reveals the middle tier — and only from xl', async ({ page }) => {
    await signUp(page, `context-path-3tier-${Date.now()}@example.com`);
    await createProjectAndSettle(page, 'Mobile App');
    await createWorkspace(page, 'Engineering');
    await page.goto('/dashboard');
    await createProjectAndSettle(page, 'Platform');

    // ── 3 · three tiers at xl ────────────────────────────────────────────────
    await expect(bar(page).getByRole('button', { name: 'Organization menu' })).toBeVisible();
    await expect(bar(page).getByRole('button', { name: 'Switch workspace' })).toContainText(
      'Engineering',
    );
    await expect(bar(page).getByRole('button', { name: 'Switch project' })).toContainText(
      'Platform',
    );

    // ── 4 · the md band — the middle tier goes, the org keeps its mark ───────
    await page.setViewportSize(MEDIUM);
    await expect(bar(page).getByRole('button', { name: 'Switch workspace' })).toBeHidden();
    await expect(bar(page).getByRole('button', { name: 'Switch project' })).toBeVisible();
    // the org CONTROL is still there and still reachable — only its NAME goes
    const org = bar(page).getByRole('button', { name: 'Organization menu' });
    await expect(org).toBeVisible();
    await expect(org).not.toContainText('workspace');

    // ── 5 · the rail gave the project up ─────────────────────────────────────
    await expect(rail(page).getByRole('button', { name: 'Switch project' })).toHaveCount(0);
    await expect(rail(page).getByRole('button', { name: /Create your first project/ })).toHaveCount(
      0,
    );
    // …and it kept its own job
    await expect(rail(page).getByRole('link', { name: 'Work Items' })).toBeVisible();
  });

  test('a workspace with no project shows the create-first door IN the bar', async ({ page }) => {
    await signUp(page, `context-path-empty-${Date.now()}@example.com`);
    await createProjectAndSettle(page, 'Mobile App');
    // a fresh workspace has no projects, and lands active
    await createWorkspace(page, 'Empty');

    // ── 6 · empty ────────────────────────────────────────────────────────────
    await expect(bar(page).getByRole('button', { name: 'Switch project' })).toHaveCount(0);
    const createFirst = bar(page).getByRole('button', { name: 'Create your first project' });
    await expect(createFirst).toBeVisible();

    await createFirst.click();
    await expect(page.getByRole('heading', { name: 'Create project' })).toBeVisible();
    await page.getByLabel('Project name').fill('Docs');
    await page.getByRole('button', { name: 'Create project', exact: true }).last().click();
    await expect(page.getByText('Project created', { exact: true }).first()).toBeVisible();
    await expect(bar(page).getByRole('button', { name: 'Switch project' })).toContainText('Docs');
  });

  // ── 7 · the ARCHIVED tier — covered at the component level, on purpose ────
  //
  // The design draws it and `shell-tier-nav.test.tsx` asserts it against the
  // real component: an archived active project renders its name AND the pill,
  // the pill being `shrink-0` so the NAME truncates around it. It is NOT
  // asserted here, and that is a decision rather than an omission.
  //
  // Reaching the state in a browser needs a SECOND actor. `projectsService`'s
  // archive deliberately moves the ARCHIVING actor on — their active pointer
  // drops and recovers to the next non-archived project, or to null — so a
  // one-actor spec that archives its only project lands on the create-first
  // door, which is the correct behaviour and not the state under test. The
  // archived-ACTIVE case (PRODECT_FINDINGS #29.2) is what a DIFFERENT member
  // sees, and standing up a second signed-in member here would be re-testing
  // `projects-flow.spec.ts`'s archive flow to reach a rendering claim the unit
  // test already makes directly.

  test('at phone width the bar carries the project and the drawer carries the rest', async ({
    page,
  }) => {
    await signUp(page, `context-path-phone-${Date.now()}@example.com`);
    await createProjectAndSettle(page, 'Mobile App');
    await createWorkspace(page, 'Engineering');
    await page.goto('/dashboard');
    await createProjectAndSettle(page, 'Platform');

    // ── 8 · 375px ────────────────────────────────────────────────────────────
    await page.setViewportSize(PHONE);
    await expect(bar(page).getByRole('button', { name: 'Switch project' })).toContainText(
      'Platform',
    );
    // the ancestors are NOT in the bar here — that is the whole below-md rule
    await expect(bar(page).getByRole('button', { name: 'Organization menu' })).toBeHidden();
    await expect(bar(page).getByRole('button', { name: 'Switch workspace' })).toBeHidden();

    const hit = await hamburgerIsHittable(page);
    expect(hit.ok, `at 375px the element at the hamburger’s centre is: ${hit.chain}`).toBe(true);

    // …and they are one tap away, in the drawer's header, where they always are
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('button', { name: 'Organization menu' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Switch workspace' })).toContainText(
      'Engineering',
    );
    // the drawer carries the ANCESTORS only — the project has exactly one host
    await expect(drawer.getByRole('button', { name: 'Switch project' })).toHaveCount(0);
  });

  test('the bar does not overflow at 320px', async ({ page }) => {
    await signUp(page, `context-path-320-${Date.now()}@example.com`);
    await createProjectAndSettle(page, 'A project with a deliberately long name');
    await createWorkspace(page, 'Engineering');
    await page.goto('/dashboard');
    await createProjectAndSettle(page, 'Another deliberately long project name');

    // ── 9 · the narrowest viewport we support ───────────────────────────────
    // This is what the design measured at 47px of overflow on `main`, and the
    // one-tier band is what closes it. Asserted as an OUTCOME so it keeps
    // holding whatever the path does next.
    await page.setViewportSize(NARROWEST);
    const overflow = await page.evaluate(() => {
      const nav = document.querySelector('header nav[aria-label]');
      if (!nav) return { found: false, by: 0, content: '' };
      return {
        found: true,
        by: nav.scrollWidth - nav.clientWidth,
        content: (nav.textContent ?? '').trim().slice(0, 120),
      };
    });
    expect(overflow.found).toBe(true);
    expect(
      overflow.by,
      `at 320px the bar overflows by ${overflow.by}px; it carries: ${overflow.content}`,
    ).toBeLessThanOrEqual(0);

    const hit = await hamburgerIsHittable(page);
    expect(hit.ok, `at 320px the element at the hamburger’s centre is: ${hit.chain}`).toBe(true);
  });
});
