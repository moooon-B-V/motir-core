// E2E: cross-device appearance sync (Story 7.3 · Subtask 7.3.63 / MOTIR-1080) —
// proves Motir's three-axis appearance preference (theme × style × palette ×
// type) follows the USER, not the device, and is isolated per user.
//
// The cluster this closes: 7.3.61 made the saved preference SERVER-applied on the
// first byte (no flash); 7.3.62 wired the Appearance pane to persist each pick via
// `PATCH /api/appearance-preference`. This spec drives the user-visible promise of
// both end-to-end across THREE browser contexts:
//
//   1. User A, device 1 — open the Appearance pane, change all four axes; each
//      pick fires a `PATCH … 200` and lands on `<html>` (the live UI).
//   2. User A, device 2 (a FRESH context = fresh storage) — sign in as the SAME
//      user, load `/dashboard` WITHOUT touching the pane: the saved appearance is
//      already on `<html>` on the first byte. Proven SERVER-side / no-flash by
//      reading the RAW document markup (the `<html …>` opening tag carries the
//      `data-*`, distinct from the init-script JSON the client would run later).
//   3. User B (a fresh context) — gets the DEFAULTS; User A's choices do NOT bleed
//      across users (the server emits no `data-*` for a user with no preference).
//
// Authoritative-signal discipline (CLAUDE.md): every wait is on a real signal —
// `waitForResponse` ARMED BEFORE the click (the optimistic pane has no whole-tree
// refresh to wait on), the committed `<html>` attribute, the raw server markup —
// never a fixed timeout. Selectors are `exact` to dodge the superstring trap
// ("Motir" ⊂ "Motir Sans"/"Motir Mono" in the Typography row; "Motir" the palette).

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signIn, signUp, SHELL_PASSWORD } from './_helpers/shell-session';

const USER_A = 'e2e-appearance-sync-a@example.com';
const USER_B = 'e2e-appearance-sync-b@example.com';
const APPEARANCE_URL = '/settings/account/appearance';

// One non-default pick per axis, each different from the documented default so a
// change is observable. `group` = the radiogroup's aria-label (the axis name);
// `option` = the radio's accessible name (the registry display name); `attr`/
// `value` = the `<html>` `data-*` it drives; `prefKey` = the DTO field the 200
// body resolves it under.
//   theme   default 'system' (NO data-theme server-side) → 'dark'
//   style   default 'warm-editorial' → 'soft-playful'
//   palette default 'motir'          → 'cobalt'
//   type    default 'motir'          → 'grotesk'  (soft-playful's default is 'motir', so this is a real change)
const AXES = [
  { group: 'Theme', option: 'Dark', attr: 'data-theme', value: 'dark', prefKey: 'pattern' },
  {
    group: 'Style',
    option: 'Soft / Playful',
    attr: 'data-style',
    value: 'soft-playful',
    prefKey: 'styleId',
  },
  {
    group: 'Palette',
    option: 'Cobalt',
    attr: 'data-palette',
    value: 'cobalt',
    prefKey: 'paletteId',
  },
  {
    group: 'Typography',
    option: 'Grotesk',
    attr: 'data-type',
    value: 'grotesk',
    prefKey: 'typeId',
  },
] as const;

// Change one axis and assert the full optimistic→persisted loop: arm
// `waitForResponse` BEFORE the click, click the radio, then assert the PATCH 200s
// with the resolved value AND `<html>` reflects it.
async function changeAxis(page: Page, axis: (typeof AXES)[number]): Promise<void> {
  const patch = page.waitForResponse(
    (r) => r.url().includes('/api/appearance-preference') && r.request().method() === 'PATCH',
  );
  await page
    .getByRole('radiogroup', { name: axis.group, exact: true })
    .getByRole('radio', { name: axis.option, exact: true })
    .click();
  const res = await patch;
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { preference: Record<string, string> };
  expect(body.preference[axis.prefKey]).toBe(axis.value);
  await expect(page.locator('html')).toHaveAttribute(axis.attr, axis.value);
}

// The `<html …>` OPENING TAG from the raw server document — proves what the SERVER
// emitted before any client JS (the init script that would later set the same
// attrs runs only in a browser, never in this request). Asserting against this
// string is the no-flash / server-applied proof.
async function serverHtmlTag(request: APIRequestContext, path: string): Promise<string> {
  const res = await request.get(path);
  expect(res.ok()).toBe(true);
  const markup = await res.text();
  const open = markup.indexOf('<html');
  expect(open).toBeGreaterThanOrEqual(0);
  return markup.slice(open, markup.indexOf('>', open) + 1);
}

test.describe('Cross-device appearance sync (7.3.63)', () => {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test('@smoke saved appearance follows the user to a fresh device, server-applied, isolated per user', async ({
    browser,
  }) => {
    // ── 1. User A · device 1 — change every axis on the Appearance pane ──────────
    const deviceA1 = await browser.newContext();
    const pageA1 = await deviceA1.newPage();
    await signUp(pageA1, USER_A);
    await pageA1.goto(APPEARANCE_URL);
    await expect(pageA1.getByRole('heading', { name: 'Appearance' })).toBeVisible();

    for (const axis of AXES) {
      await changeAxis(pageA1, axis);
    }
    // All four now co-resident on this device's <html>.
    const htmlA1 = pageA1.locator('html');
    for (const axis of AXES) {
      await expect(htmlA1).toHaveAttribute(axis.attr, axis.value);
    }

    // ── 2. User A · device 2 — fresh context, no pane visit, appearance applies ──
    const deviceA2 = await browser.newContext();
    const pageA2 = await deviceA2.newPage();
    await signIn(pageA2, USER_A, SHELL_PASSWORD); // lands on /dashboard

    // (a) Server-applied / no-flash: the RAW /dashboard markup already carries the
    //     saved axes on the <html> tag — the bytes came from the server, not the
    //     client init script.
    const serverTagA2 = await serverHtmlTag(deviceA2.request, '/dashboard');
    for (const axis of AXES) {
      expect(serverTagA2).toContain(`${axis.attr}="${axis.value}"`);
    }
    // (b) And it's the live, committed DOM on a page the user never themed here.
    const htmlA2 = pageA2.locator('html');
    for (const axis of AXES) {
      await expect(htmlA2).toHaveAttribute(axis.attr, axis.value);
    }

    // ── 3. User B — fresh context, defaults only, NO cross-user bleed ────────────
    const deviceB = await browser.newContext();
    const pageB = await deviceB.newPage();
    await signUp(pageB, USER_B); // distinct user, never set a preference

    // (a) The server emits NO appearance data-* for a user with no preference —
    //     User A's choices cannot bleed across users at the SSR layer.
    const serverTagB = await serverHtmlTag(deviceB.request, '/dashboard');
    expect(serverTagB).not.toContain('data-style=');
    expect(serverTagB).not.toContain('data-palette=');
    expect(serverTagB).not.toContain('data-type=');
    expect(serverTagB).not.toContain('data-theme=');

    // (b) Live DOM (after the anonymous init script) shows the documented DEFAULTS,
    //     and specifically NONE of User A's picks.
    const htmlB: Locator = pageB.locator('html');
    await expect(htmlB).toHaveAttribute('data-style', 'warm-editorial');
    await expect(htmlB).toHaveAttribute('data-palette', 'motir');
    await expect(htmlB).toHaveAttribute('data-type', 'motir');
    await expect(htmlB).not.toHaveAttribute('data-style', 'soft-playful');
    await expect(htmlB).not.toHaveAttribute('data-palette', 'cobalt');
    await expect(htmlB).not.toHaveAttribute('data-type', 'grotesk');

    await deviceA1.close();
    await deviceA2.close();
    await deviceB.close();
  });
});
