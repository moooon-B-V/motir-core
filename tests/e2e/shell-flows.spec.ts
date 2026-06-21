// Story-level E2E for the app shell (Subtask 1.5.6) — the closing spec for
// Story 1.5. Same shape as the Story-closing specs for 1.2 / 1.3 / 1.4: a
// Playwright suite that drives the browser through realistic user journeys
// across the whole shell surface.
//
// Where shell-a11y.spec.ts is invariant-driven (axe + landmarks) and
// shell-keyboard.spec.ts is keyboard-only, THIS spec is journey-driven: it
// exercises the chrome AS A USER WOULD, mouse + keyboard interleaved, one
// `test()` per journey:
//
//   1. signed-in landing renders the shell chrome
//   2. sidebar navigation walks Issues / Boards / Reports / Settings
//   3. sidebar collapse persists across reload
//   4. cmd-k palette switches workspace + refreshes the project nav
//   5. cmd-k palette toggles theme + persists across reload
//   6. mobile drawer opens, navigates (auto-close) + scrim-closes
//   7. sign out via the command palette
//   8. sign out via the user menu
//   9. empty workspace shows the create-project CTA + hides project nav
//
// Reuses the browser-driven sign-up / project / workspace helpers from
// _helpers/shell-session.ts (the same real-UI path the a11y + keyboard specs
// use) and the db-reset + Prisma client from _helpers/db-reset.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp, createFirstProject, createWorkspace } from './_helpers/shell-session';

// The shell's useShortcut resolves `Mod` to ⌘ on Apple platforms and Ctrl
// elsewhere, keyed off the BROWSER's navigator.platform. Read the same signal
// so we press the right physical chord on a Linux CI runner (Ctrl) or a macOS
// dev box (⌘). Mirrors shell-keyboard.spec.ts.
async function resolveMod(page: Page): Promise<'Meta' | 'Control'> {
  const isMac = await page.evaluate(() => /mac|iphone|ipad|ipod/i.test(navigator.platform));
  return isMac ? 'Meta' : 'Control';
}

// Open the ⌘K palette, type a needle, and return its dialog locator. The
// search input auto-focuses, so typing filters immediately.
async function openPalette(page: Page, mod: 'Meta' | 'Control', needle: string) {
  await page.keyboard.press(`${mod}+k`);
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  if (needle) await page.keyboard.type(needle);
  return palette;
}

// Each journey signs up a fresh user (argon2) and often creates a project or a
// second workspace, so the 30s default is too tight for the longest paths.
test.describe.configure({ timeout: 90_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test.describe('@smoke shell journeys', () => {
  // ── 1. Signed-in landing ──────────────────────────────────────────────
  test('signed-in landing renders the sidebar nav + top-nav chrome', async ({ page }) => {
    await signUp(page, 'e2e-shell-flows-landing@example.com');
    await createFirstProject(page, 'Mobile App');
    await page.goto('/dashboard');

    // The primary rail carries the project-scoped nav.
    const rail = page.getByRole('navigation', { name: 'Primary' });
    await expect(rail).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Work Items' })).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Boards' })).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Reports' })).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Settings' })).toBeVisible();

    // The global top bar carries the org control (the always-present tenancy
    // anchor), the ⌘K search trigger, the tri-state theme toggle, and the
    // account menu. With a single workspace the workspace switcher is NOT
    // rendered (Story 6.10.5 progressive disclosure — it reveals at ws #2), so
    // the org control is the tenancy chrome here.
    const topNav = page.getByRole('navigation', { name: 'Global' });
    await expect(topNav).toBeVisible();
    await expect(topNav.getByRole('button', { name: 'Organization menu' })).toBeVisible();
    await expect(topNav.getByRole('button', { name: 'Switch workspace' })).toBeHidden();
    await expect(topNav.getByRole('button', { name: /Search/ })).toBeVisible();
    await expect(topNav.getByRole('button', { name: /^Theme:/ })).toBeVisible();
    await expect(topNav.getByRole('button', { name: 'Account menu' })).toBeVisible();
  });

  // ── 2. Sidebar navigation ─────────────────────────────────────────────
  test('sidebar navigation routes to each placeholder + marks the active item', async ({
    page,
  }) => {
    await signUp(page, 'e2e-shell-flows-nav@example.com');
    await createFirstProject(page, 'Mobile App');
    await page.goto('/dashboard');

    const rail = page.getByRole('navigation', { name: 'Primary' });

    // Each tuple: rail link → URL it routes to → the placeholder heading there.
    const stops: { link: string; url: string; heading: string }[] = [
      { link: 'Work Items', url: '**/items', heading: 'Work Items' },
      { link: 'Boards', url: '**/boards', heading: 'Boards' },
      { link: 'Reports', url: '**/reports', heading: 'Reports' },
    ];

    for (const stop of stops) {
      await rail.getByRole('link', { name: stop.link }).click();
      await page.waitForURL(stop.url);
      // exact:true — the /items empty state also renders an h2 "No issues yet",
      // and a non-exact name:'Work Items' substring-matches it, so a bare match is a
      // strict-mode violation once both headings have painted. Every stop's
      // heading text is exact, so this disambiguates without losing coverage.
      await expect(page.getByRole('heading', { name: stop.heading, exact: true })).toBeVisible();
      // The just-clicked item is current; Dashboard no longer is.
      await expect(rail.getByRole('link', { name: stop.link })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(rail.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute(
        'aria-current',
        'page',
      );
    }

    // Settings is the project-settings AREA entry (Story 6.5.2): clicking it SWAPS
    // the project nav for the grouped settings rail — it's no longer a Primary-rail
    // placeholder that merely gets an active mark. Verify the swap (the settings
    // nav landmark appears, landing on Details) instead of a Primary-rail state.
    await rail.getByRole('link', { name: 'Settings' }).click();
    await page.waitForURL('**/settings/project');
    await expect(page.getByRole('heading', { name: 'Details', exact: true })).toBeVisible();
    const settingsRail = page.getByRole('navigation', { name: 'Project settings' });
    await expect(settingsRail).toBeVisible();
    await expect(settingsRail.getByRole('link', { name: 'Details' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  // ── 3. Collapse toggle persistence ────────────────────────────────────
  test('sidebar collapse state persists across reload', async ({ page }) => {
    await signUp(page, 'e2e-shell-flows-collapse@example.com');
    await createFirstProject(page, 'Mobile App');
    await page.goto('/dashboard');

    const rail = page.getByRole('navigation', { name: 'Primary' });
    await expect(rail).toBeVisible();
    await expect(rail).not.toHaveAttribute('data-collapsed', 'true');

    // Collapse → the rail flips data-collapsed; survives a reload (localStorage).
    await rail.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(rail).toHaveAttribute('data-collapsed', 'true');
    await page.reload();
    await expect(rail).toBeVisible();
    await expect(rail).toHaveAttribute('data-collapsed', 'true');

    // Expand again → reload → stays expanded.
    await rail.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(rail).not.toHaveAttribute('data-collapsed', 'true');
    await page.reload();
    await expect(rail).toBeVisible();
    await expect(rail).not.toHaveAttribute('data-collapsed', 'true');
  });

  // ── 4. Cmd-k palette → switch workspace ───────────────────────────────
  test('cmd-k palette switches workspace and refreshes the project nav', async ({ page }) => {
    await signUp(page, 'e2e-shell-flows-ws@example.com');

    // Two named workspaces, each with its own project, so a switch is
    // observable in the sidebar project switcher.
    await createWorkspace(page, 'Apollo Team');
    await page.goto('/dashboard');
    await createFirstProject(page, 'Apollo');
    await createWorkspace(page, 'Zephyr Team');
    await page.goto('/dashboard');
    await createFirstProject(page, 'Zephyr');

    // Active = Zephyr Team → its project shows in the sidebar switcher.
    await page.goto('/dashboard');
    await expect(page.getByRole('button', { name: 'Switch project' })).toContainText('Zephyr');

    // ⌘K → type the alternate workspace's name → ↓ → ↵ switches to it.
    const mod = await resolveMod(page);
    const palette = await openPalette(page, mod, 'Apollo Team');
    await expect(palette.getByRole('option', { name: 'Switch to Apollo Team' })).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(palette).toBeHidden();

    // The workspace_id cookie now points at Apollo Team.
    const apolloWs = await db.workspace.findFirst({ where: { name: 'Apollo Team' } });
    expect(apolloWs).not.toBeNull();
    await expect
      .poll(async () => {
        const cookies = await page.context().cookies();
        return cookies.find((c) => c.name === 'workspace_id')?.value;
      })
      .toBe(apolloWs!.id);

    // The sidebar project switcher refreshes to Apollo Team's project.
    await expect(page.getByRole('button', { name: 'Switch project' })).toContainText('Apollo');
  });

  // ── 5. Cmd-k palette → toggle theme ───────────────────────────────────
  test('cmd-k palette toggles theme and persists across reload', async ({ page }) => {
    // NB: keep "theme" out of the email — the auto-workspace is named from the
    // email local part, and a workspace whose name contains "theme" would also
    // match the palette's "theme" filter, landing the Enter on that workspace
    // row instead of the "Toggle theme" action.
    await signUp(page, 'e2e-shell-flows-appearance@example.com');
    await createFirstProject(page, 'Mobile App');
    await page.goto('/dashboard');

    const mod = await resolveMod(page);
    const html = page.locator('html');

    // The palette's "Toggle theme" cycles the *pattern* (light → dark → system),
    // and the default 'system' resolves to the OS scheme (light in headless
    // Chromium) — so a single toggle can be a visual no-op on data-theme. Drive
    // the cycle to an explicit 'dark', which renders data-theme="dark"
    // regardless of OS. setPattern writes localStorage SYNCHRONOUSLY, so the
    // persisted pattern is the race-free loop signal (the data-theme attribute
    // lands one React effect later — reading it inside the loop would race).
    const readPattern = () => page.evaluate(() => localStorage.getItem('motir.theme.pattern'));
    for (let i = 0; i < 4 && (await readPattern()) !== 'dark'; i++) {
      const palette = await openPalette(page, mod, 'theme');
      await expect(palette.getByRole('option', { name: 'Toggle theme' })).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(palette).toBeHidden();
    }
    expect(await readPattern()).toBe('dark');
    // The pattern drove the DOM attribute (the web-first assertion absorbs the
    // effect's one-tick delay).
    await expect(html).toHaveAttribute('data-theme', 'dark');

    // The choice survives a full reload (the FOUC init script re-applies it).
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    expect(await readPattern()).toBe('dark');
  });

  // ── 6. Mobile drawer flow ─────────────────────────────────────────────
  test('mobile drawer opens, navigates with auto-close, and scrim-closes', async ({ page }) => {
    await signUp(page, 'e2e-shell-flows-drawer@example.com');
    await createFirstProject(page, 'Mobile App');
    await page.goto('/dashboard');

    // Drop below md (768px): the persistent rail hides, the hamburger appears.
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden();
    const hamburger = page.getByRole('button', { name: 'Open navigation' });
    await expect(hamburger).toBeVisible();

    // Open → the off-canvas drawer (a dialog) slides in.
    await hamburger.click();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer).toBeVisible();

    // Navigate via a drawer nav item → route changes → drawer auto-closes.
    await drawer.getByRole('link', { name: 'Work Items' }).click();
    await page.waitForURL('**/items');
    await expect(page.getByRole('heading', { name: 'Work Items', level: 1 })).toBeVisible();
    await expect(drawer).toBeHidden();

    // Re-open, then click the scrim (the overlay area beside the 300px panel)
    // → the drawer dismisses without navigating.
    await hamburger.click();
    await expect(drawer).toBeVisible();
    await page.mouse.click(355, 400);
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(/\/items$/);
  });

  // ── 7. Sign out via the command palette ───────────────────────────────
  test('sign out via the command palette returns to /sign-in', async ({ page }) => {
    await signUp(page, 'e2e-shell-flows-signout-palette@example.com');
    await createFirstProject(page, 'Mobile App');
    await page.goto('/dashboard');

    const mod = await resolveMod(page);
    const palette = await openPalette(page, mod, 'Sign out');
    await expect(palette.getByRole('option', { name: 'Sign out' })).toBeVisible();
    await page.keyboard.press('Enter');

    await page.waitForURL('**/sign-in');

    // The session cookie is gone — a protected route bounces back to sign-in.
    const sessionCookie = (await page.context().cookies()).find((c) => /session/i.test(c.name));
    expect(sessionCookie).toBeUndefined();
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/sign-in/);
  });

  // ── 8. Sign out via the user menu (parity path) ───────────────────────
  test('sign out via the user menu returns to /sign-in', async ({ page }) => {
    await signUp(page, 'e2e-shell-flows-signout-menu@example.com');
    await createFirstProject(page, 'Mobile App');
    await page.goto('/dashboard');

    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();

    await page.waitForURL('**/sign-in');
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/sign-in/);
  });

  // ── 9. Empty-state path ───────────────────────────────────────────────
  test('empty workspace shows the sidebar create-project CTA and hides project nav', async ({
    page,
  }) => {
    // A fresh sign-up's auto-workspace has zero projects.
    await signUp(page, 'e2e-shell-flows-empty@example.com');
    await page.goto('/dashboard');

    // The sidebar header renders the "Create your first project" CTA card
    // inline (a button) instead of the switcher — NOT the main-panel CTA.
    await expect(page.getByRole('button', { name: 'Create your first project' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Switch project' })).toHaveCount(0);

    // The project-scoped nav is hidden; Settings/Docs (bottom section) stay.
    const rail = page.getByRole('navigation', { name: 'Primary' });
    await expect(rail.getByRole('link', { name: 'Work Items' })).toHaveCount(0);
    await expect(rail.getByRole('link', { name: 'Boards' })).toHaveCount(0);
    await expect(rail.getByRole('link', { name: 'Reports' })).toHaveCount(0);
    await expect(rail.getByRole('link', { name: 'Settings' })).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Docs' })).toBeVisible();
  });
});
