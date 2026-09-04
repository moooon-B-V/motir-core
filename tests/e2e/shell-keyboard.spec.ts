// Keyboard-only navigation of the app shell (Subtask 1.5.5).
//
// Drives the entire shell with the keyboard alone — NO page.click / page.tap —
// proving every global affordance is reachable and operable without a pointer:
//   load /dashboard → Tab to the skip-link → activate it → Tab into <main> →
//   ⌘K opens the palette → type "iss" → ↓ → ↵ navigates to /items →
//   ⌘\ collapses the rail → ? opens the cheatsheet → Esc closes it.
//
// A second journey lives here for the same reason: LAYERED DISMISSAL below `md`
// (MOTIR-4326). One `Escape` must peel one surface — the drawer's Help menu —
// and leave the drawer under it standing. It is a keyboard-only path on a
// keyboard-only surface, which is exactly this file's subject, and it is
// unreachable from either surface's own component test: the drawer passes, the
// menu passes, and the COMPOSITION is what was broken.
//
// Pairs with shell-a11y.spec.ts (axe sweep + structural aria invariants).
//
// Modifier note: the shell's useShortcut resolves `Mod` to ⌘ on Apple
// platforms and Ctrl elsewhere, keyed off the BROWSER's navigator.platform. We
// read the same signal here so the spec presses the right physical chord
// whether it runs on a Linux CI runner (Ctrl) or a macOS dev box (⌘).

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp, createFirstProject } from './_helpers/shell-session';

const USER_EMAIL = 'e2e-shell-keyboard@example.com';

async function resolveMod(page: Page): Promise<'Meta' | 'Control'> {
  const isMac = await page.evaluate(() => /mac|iphone|ipad|ipod/i.test(navigator.platform));
  return isMac ? 'Meta' : 'Control';
}

// Sign-up + project creation + a multi-step keyboard journey; give it more than
// the 30s default so a slow argon2 sign-up or cold route compile doesn't time out.
test.describe.configure({ timeout: 90_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test.describe('@a11y shell keyboard navigation', () => {
  test('full keyboard journey: skip-link → ⌘K → navigate → ⌘\\ → ? → esc', async ({ page }) => {
    await signUp(page, USER_EMAIL);
    await createFirstProject(page, 'Mobile App');

    // Fresh load so focus starts on <body>, not a lingering toast/modal.
    await page.goto('/dashboard');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

    const mod = await resolveMod(page);

    // 1. The skip-link is the first focusable element in the shell.
    await page.keyboard.press('Tab');
    const skipLink = page.getByRole('link', { name: 'Skip to content' });
    await expect(skipLink).toBeFocused();

    // 2. Activating it sends focus to <main> (id="main", tabIndex=-1).
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();

    // 3. Tab moves on into the content region (focus leaves the <main> container).
    await page.keyboard.press('Tab');
    await expect(page.locator('#main')).not.toBeFocused();

    // 4. ⌘K / Ctrl+K opens the command palette (a modal dialog) from anywhere.
    await page.keyboard.press(`${mod}+k`);
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await expect(palette).toHaveAttribute('aria-modal', 'true');

    // 5. The search input auto-focuses; typing filters to the Work Items action.
    await page.keyboard.type('work');
    await expect(palette.getByRole('option', { name: 'Go to Work Items' })).toBeVisible();

    // 6. ↓ highlights the match, ↵ invokes it → client-navigates to /items.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForURL('**/items');
    await expect(palette).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Work Items', level: 1 })).toBeVisible();

    // 7. ⌘\ / Ctrl+\ collapses the rail (data-collapsed flips on the <nav>).
    const rail = page.getByRole('navigation', { name: 'Primary' });
    await expect(rail).not.toHaveAttribute('data-collapsed', 'true');
    await page.keyboard.press(`${mod}+Backslash`);
    await expect(rail).toHaveAttribute('data-collapsed', 'true');

    // 8. `?` opens the shortcuts cheatsheet (focus isn't in a text input, so
    //    the question mark is treated as the global shortcut, not a literal).
    await page.keyboard.press('Shift+Slash');
    const cheatsheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(cheatsheet).toBeVisible();

    // 9. Esc closes it, completing the keyboard-only loop.
    await page.keyboard.press('Escape');
    await expect(cheatsheet).toBeHidden();
  });

  // Every interactive element in the shell must paint the design-system focus
  // ring when tabbed to — the :focus-visible ring shipped in 1.0.5. We sample
  // the skip-link (first tab stop) since it's the one focusable element with a
  // deterministic, route-independent position in the tab order.
  test('focus is visible on the first tab stop', async ({ page }) => {
    await signUp(page, 'e2e-shell-keyboard-focus@example.com');
    await createFirstProject(page, 'Mobile App');
    await page.goto('/dashboard');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

    await page.keyboard.press('Tab');
    const skipLink = page.getByRole('link', { name: 'Skip to content' });
    await expect(skipLink).toBeFocused();
    // The skip-link is sr-only until focused, then `focus:not-sr-only` reveals
    // it — so visibility itself is the proof the focus state is styled.
    await expect(skipLink).toBeVisible();
  });

  // MOTIR-4326 — ONE `Escape`, ONE SURFACE.
  //
  // Below `md` the rail folds into `SidebarDrawer` (a Radix `Dialog`) and the
  // Help menu opens as a Radix `Popover` from its utility strip, so two
  // dismissable layers are stacked. Radix peels the highest one and stops; the
  // drawer used to ALSO carry a `useShortcut('esc', …)` listener on `window`,
  // outside that stack, which fired for the same key and took the drawer with
  // it. The whole defect is in the COMPOSITION, which is why this is a browser
  // spec and not a component one.
  //
  // The surface is below `md`, where the ordinary device has no `Escape` key at
  // all — so it is reached the way it is really reached, on a NARROWED window
  // that still has a keyboard, and driven with the keyboard alone (`locator
  // .press` focuses and keys the control; no pointer, in keeping with this
  // file's discipline).
  //
  // Every assertion waits on an authoritative signal: the trigger's own
  // `aria-expanded` (Radix's disclosure state) and each panel's role + name.
  // Never a timeout — CLAUDE.md § E2E discipline.
  test('below `md`, one Escape closes the Help menu and leaves the drawer open', async ({
    page,
  }) => {
    await signUp(page, 'e2e-shell-keyboard-layering@example.com');
    await createFirstProject(page, 'Mobile App');

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/dashboard');

    // The rail is `hidden md:block`, so at this width it leaves the
    // accessibility tree entirely and the drawer's dialog is unambiguous.
    await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);

    const hamburger = page.getByRole('button', { name: 'Open navigation' });
    await expect(hamburger).toBeVisible();
    await hamburger.press('Enter');

    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer).toBeVisible();

    // The Help trigger lives in the drawer's utility strip. Its PANEL is
    // portaled to the document, not into the drawer, so it is located on the
    // page — scoping it to the drawer would fail on a build where all is well.
    const help = drawer.getByRole('button', { name: 'Help' });
    await expect(help).toBeVisible();
    await help.press('Enter');
    await expect(help).toHaveAttribute('aria-expanded', 'true');
    const menu = page.getByRole('dialog', { name: 'Help' });
    await expect(menu).toBeVisible();

    // ── THE DEFECT, IF IT IS BACK, FAILS HERE ──────────────────────────────
    // One key, one layer. The drawer is asserted through its own trigger as
    // well as through the dialog, because "the drawer closed" and "the menu
    // closed" both read as a missing element otherwise — the ambiguity the
    // original observation had to be disambiguated out of by a control.
    await page.keyboard.press('Escape');
    await expect(help).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toHaveCount(0);
    await expect(drawer, 'the drawer survived dismissing the menu').toBeVisible();
    await expect(help, 'and its utility strip is still reachable').toBeVisible();

    // The second Escape closes the drawer — the behaviour the fix must not
    // trade away in order to get the first one right.
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  });
});
