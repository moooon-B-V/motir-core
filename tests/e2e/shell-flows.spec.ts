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
// Services seed the multi-org TOPOLOGY for the last-active-project journeys
// (Subtask 8.8.30): a single-org account has NO UI path to create org #2 — the
// org menu's "Create organization" reveals only at >=2 orgs (progressive
// disclosure, OrgControl `multiOrg`) — so the second org / its workspaces /
// projects are stood up server-side, the same pattern the other at-scale seed
// helpers use (backlog-seed, estimation-seed). The TESTED interaction (the 8.8.28
// switch points that RECORD the pointer + the 8.8.27 re-login landing that reads
// it) is still driven entirely through the real switchers in the UI.
import { organizationsService } from '@/lib/services/organizationsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';

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

// ── Last-active-project restoration helpers (Subtask 8.8.30) ──────────────
// The two per-device tier cookies: lib/workspaces/middleware.ts:24
// (WORKSPACE_COOKIE_NAME) + lib/organizations/cookie.ts:12
// (ORGANIZATION_COOKIE_NAME). A fresh login / new device carries NEITHER; the
// account-keyed `User.lastActiveProjectId` pointer is what restores the context.
const WORKSPACE_COOKIE = 'workspace_id';
const ORG_COOKIE = 'motir.org';

// Simulate a fresh login / new device: drop ONLY the two per-device tier cookies
// while keeping the session (the account stays signed in). Version-agnostic — read
// every cookie, clear, re-add all but the two — so it doesn't depend on a filtered
// clearCookies() overload.
async function clearDeviceTierCookies(page: Page) {
  const remaining = (await page.context().cookies()).filter(
    (c) => c.name !== WORKSPACE_COOKIE && c.name !== ORG_COOKIE,
  );
  await page.context().clearCookies();
  if (remaining.length) await page.context().addCookies(remaining);
}

// Switch the active ORGANIZATION through the org control's "Switch organization"
// list (revealed only at >=2 orgs). switchOrganizationAction re-points the active
// workspace into the target org AND records that workspace's active project as the
// global last-active pointer (8.8.28). The org-control trigger reflecting the new
// name is the settle signal. The org rows are buttons named by org name; the
// trigger's accessible name is its aria-label ("Organization menu"), so a
// name-match resolves only the row.
async function switchOrganization(page: Page, name: string) {
  await page.getByRole('button', { name: 'Organization menu' }).click();
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Organization menu' })).toContainText(name);
}

// Switch the active WORKSPACE through the sidebar workspace switcher (revealed
// only at >=2 workspaces in the active org). switchWorkspaceAction records the
// destination workspace's active project as the global pointer (8.8.28).
// NB: a workspace row's accessible name is `${name} ${role}` (it carries a role
// pill — "Crew member"), so match the name START-anchored, not exact. (The org +
// project rows have no pill, so those helpers can stay exact.)
async function switchWorkspace(page: Page, name: string) {
  await page.getByRole('button', { name: 'Switch workspace' }).click();
  await page.getByRole('button', { name: new RegExp(`^${name}\\b`) }).click();
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText(name);
}

// Switch the active PROJECT through the sidebar project switcher.
// setActiveProjectAction records it as the global last-active pointer (8.8.28).
async function switchProject(page: Page, name: string) {
  await page.getByRole('button', { name: 'Switch project' }).click();
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Switch project' })).toContainText(name);
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

  // ── 10. Re-login lands on the LAST working project (+ its workspace/org) ───
  // The user-visible promise of Story 8.8 (8.8.27 resolver + 8.8.28 recording):
  // log back in / open on a fresh device and land where you LEFT OFF — the last
  // project you worked in, with its workspace and org active — not the first.
  test('re-login restores the last working project (and its workspace + org), not the first', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const email = 'e2e-shell-flows-last-active@example.com';

    // The DEFAULT (first-by-createdAt) tier-context: the auto-workspace from
    // sign-up + a project in it. This is what a NULL pointer would fall back to,
    // so landing here later would mean restoration FAILED.
    await signUp(page, email);
    await createFirstProject(page, 'Aurora');
    await page.goto('/dashboard');

    // Seed a SECOND org with two workspaces (so the workspace switcher reveals)
    // and the target workspace with two projects (so "switch the active project"
    // is a real choice, not the only option) — server-side, since a single-org
    // account can't create org #2 in the UI.
    const user = await db.user.findFirstOrThrow({ where: { email } });
    const beacon = await organizationsService.createOrganization({
      name: 'Beacon',
      actorUserId: user.id,
    });
    const { workspace: crew } = await workspacesService.createWorkspace({
      name: 'Crew',
      ownerUserId: user.id,
      organizationId: beacon.id,
    });
    await workspacesService.createWorkspace({
      name: 'Depot',
      ownerUserId: user.id,
      organizationId: beacon.id,
    });
    await projectsService.createProject({
      workspaceId: crew.id,
      actorUserId: user.id,
      name: 'Pinnacle',
    });
    await projectsService.createProject({
      workspaceId: crew.id,
      actorUserId: user.id,
      name: 'Quartz',
    });
    const pinnacle = await db.project.findFirstOrThrow({
      where: { name: 'Pinnacle', workspaceId: crew.id },
    });

    // The account now spans two orgs → the org switcher reveals. Drive the REAL
    // switch points (org → workspace → project), each of which 8.8.28 wired to
    // record the global last-active pointer. Ending on project Pinnacle makes IT
    // the last-worked project.
    await page.reload();
    await switchOrganization(page, 'Beacon');
    await switchWorkspace(page, 'Crew');
    await switchProject(page, 'Pinnacle');

    // The pointer 8.8.27 reads is the authoritative committed signal that the
    // switches recorded — assert it before simulating the fresh session.
    await expect
      .poll(
        async () =>
          (await db.user.findUniqueOrThrow({ where: { id: user.id } })).lastActiveProjectId,
      )
      .toBe(pinnacle.id);

    // Fresh login / new device: drop the per-device tier cookies, keep the
    // session, reload the authed shell.
    await clearDeviceTierCookies(page);
    await page.goto('/dashboard');

    // Restored to the LAST WORKING context — project Pinnacle, workspace Crew,
    // org Beacon — NOT the first-by-createdAt workspace/org (Aurora in the
    // auto-workspace). Authoritative signals: the resolved names the switchers
    // render.
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Organization menu' })).toContainText('Beacon');
    await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('Crew');
    const projectSwitcher = page.getByRole('button', { name: 'Switch project' });
    await expect(projectSwitcher).toContainText('Pinnacle');
    await expect(projectSwitcher).not.toContainText('Aurora');
  });

  // ── 11. Edge: a never-switched account lands on its first project ──────────
  test('a brand-new account that never switched lands on its first workspace + project', async ({
    page,
  }) => {
    const email = 'e2e-shell-flows-last-active-newuser@example.com';
    await signUp(page, email);
    await createFirstProject(page, 'Homestead');
    await page.goto('/dashboard');

    // A genuinely never-switched account: null the pointer the create-project
    // flow set, so the resolver takes its NO-HISTORY branch (returns null →
    // first-by-createdAt default) — the new-device path for a single-tenant user.
    const user = await db.user.findFirstOrThrow({ where: { email } });
    await db.user.update({ where: { id: user.id }, data: { lastActiveProjectId: null } });

    await clearDeviceTierCookies(page);
    await page.goto('/dashboard');

    // No regression: lands on the sole workspace + its sole project. (One
    // workspace → the workspace switcher stays hidden by progressive disclosure,
    // so the project switcher is the load-bearing signal.)
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Switch project' })).toContainText('Homestead');
  });

  // ── 12. Edge: an archived last-active project falls back cleanly ───────────
  // SHIPPED REALITY (not the card's "pointer clears" prose): the 8.8.27 resolver
  // reads the project by id WITHOUT filtering archived, so the WORKSPACE + ORG
  // still resolve from the (soft-archived, never hard-deleted) row. The real
  // archiveProject service NULLS the membership's active-project pointer when the
  // archived project was active, so getActiveProject then RECOVERS to a live
  // sibling project. Net: re-login still restores the workspace/org and lands on
  // a working project — a clean, crash-free fallback.
  test('an archived last-active project still restores its workspace/org and recovers a live project', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const email = 'e2e-shell-flows-last-active-archived@example.com';
    await signUp(page, email);
    await createFirstProject(page, 'Origin');
    await page.goto('/dashboard');

    const user = await db.user.findFirstOrThrow({ where: { email } });
    const lighthouse = await organizationsService.createOrganization({
      name: 'Lighthouse',
      actorUserId: user.id,
    });
    const { workspace: vanguard } = await workspacesService.createWorkspace({
      name: 'Vanguard',
      ownerUserId: user.id,
      organizationId: lighthouse.id,
    });
    // Two projects so that, once the last-active one is archived, a live sibling
    // remains for getActiveProject to recover to.
    await projectsService.createProject({
      workspaceId: vanguard.id,
      actorUserId: user.id,
      name: 'Keystone',
    });
    await projectsService.createProject({
      workspaceId: vanguard.id,
      actorUserId: user.id,
      name: 'Relay',
    });
    const keystone = await db.project.findFirstOrThrow({
      where: { name: 'Keystone', workspaceId: vanguard.id },
    });

    // Work last in Vanguard/Lighthouse; end on Keystone so it's the pointer.
    // (switchProject('Relay') first guarantees the final switch to Keystone is a
    // real transition that records — not a no-op same-project click.)
    await page.reload();
    await switchOrganization(page, 'Lighthouse');
    await switchProject(page, 'Relay');
    await switchProject(page, 'Keystone');
    await expect
      .poll(
        async () =>
          (await db.user.findUniqueOrThrow({ where: { id: user.id } })).lastActiveProjectId,
      )
      .toBe(keystone.id);

    // Archive the last-active project out-of-band (between sessions) through the
    // REAL service — it stamps archivedAt AND nulls Vanguard's active pointer.
    await projectsService.archiveProject({
      projectId: keystone.id,
      workspaceId: vanguard.id,
      actorUserId: user.id,
    });

    await clearDeviceTierCookies(page);
    await page.goto('/dashboard');

    // Workspace/org still restored (Lighthouse); the project area recovers to the
    // live sibling (Relay) and never surfaces the archived Keystone — no crash.
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Organization menu' })).toContainText(
      'Lighthouse',
    );
    const projectSwitcher = page.getByRole('button', { name: 'Switch project' });
    await expect(projectSwitcher).toContainText('Relay');
    await expect(projectSwitcher).not.toContainText('Keystone');
  });
});
