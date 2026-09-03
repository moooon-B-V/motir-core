// E2E: the 3D / Immersive atmosphere reaches the SIGNED-IN shell canvas
// (MOTIR-4230 — the rendered half of `tests/theme/immersiveShellAtmosphere.test.ts`).
//
// ── The defect ──────────────────────────────────────────────────────────────
// 3D / Immersive's identity is a whole-page atmosphere plus surface depth. The
// atmosphere was painted on `body`; the signed-in shell root
// (`components/ui/AppLayout.tsx`) is a `h-dvh overflow-hidden` box carrying
// `bg-(--el-page-bg)`, an OPAQUE fill over the whole viewport. So on every route
// a user actually works on, the atmosphere was painted and then covered: cards
// carried their 3D tokens while the frame they sit in stayed flat.
//
// ── Why this spec has to RENDER ─────────────────────────────────────────────
// The property is `background-image: <a var()-bearing gradient stack>` declared
// inside an `@scope` block. No DOM implementation available to the unit lane
// resolves either — `background: var(--x)` reads back as `rgba(0, 0, 0, 0)` and
// `@scope` is not implemented at all — so a computed-style assertion there is
// green on the broken source AND on the fixed one. The unit guard therefore
// asserts the WIRING (the hook on every shell root, one rule painting both
// members) and this spec asserts what a user sees. Neither substitutes for the
// other: the guard fails when someone adds a shell without the hook, and this
// one fails when the cascade stops delivering the paint for any reason at all.
//
// ── THE ORACLE IS THE STYLESHEET, never a table of expected values ──────────
// The requirement is not "the shell paints these three gradients" — it is "the
// shell canvas shows what the page canvas shows". So truth is `body`'s own
// computed `background-image`, read in the same state, and the shell is compared
// against it. A hard-coded gradient string would need re-typing every time the
// atmosphere is tuned, and the first person to skip that turns this into a test
// of a stale table. (Same discipline as `style-material-isolation.spec.ts`.)
//
// ── The MATRIX, not a single sample ─────────────────────────────────────────
// The card's third acceptance criterion is light AND dark, so both are read: the
// atmosphere is palette-DERIVED (`color-mix` over `--el-*`), which means its
// resolved value MUST differ between the two — a fixture that agreed across
// themes would be evidence the tokens are not being read at all. The default
// style is the control: it paints no atmosphere, so the shell shows `none`, and
// a spec that only ever ran under one style would pass on a broken page.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';

const EMAIL = 'e2e-shell-immersive-atmosphere@example.com';
const APPEARANCE_URL = '/settings/account/appearance';

/** The shell canvas and the page canvas, as the browser resolves them. */
interface Canvases {
  shell: string;
  body: string;
  /** The shell root's resolved animation — the reduced-motion criterion. */
  shellAnimation: string;
}

async function readCanvases(page: Page): Promise<Canvases> {
  return page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('[data-app-shell]');
    if (!shell) throw new Error('no [data-app-shell] root on this signed-in route');
    return {
      shell: getComputedStyle(shell).backgroundImage,
      body: getComputedStyle(document.body).backgroundImage,
      shellAnimation: getComputedStyle(shell).animationName,
    };
  });
}

/**
 * Pick one option of one appearance axis through the page's OWN control, and
 * wait on the authoritative signals: the PATCH's 200 and the committed
 * `<html data-*>`. Never inject the attribute — the ancestry has to be the
 * page's real mechanism.
 */
async function chooseAppearance(
  page: Page,
  group: string,
  option: string,
  attr: string,
  value: string,
): Promise<void> {
  const patch = page.waitForResponse(
    (r) => r.url().includes('/api/appearance-preference') && r.request().method() === 'PATCH',
  );
  await page
    .getByRole('radiogroup', { name: group, exact: true })
    .getByRole('radio', { name: option, exact: true })
    .click();
  expect((await patch).status()).toBe(200);
  await expect(page.locator('html')).toHaveAttribute(attr, value);
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test.describe('the 3D / Immersive atmosphere reaches the signed-in shell (MOTIR-4230)', () => {
  test('the shell canvas shows what the page canvas shows, in light and dark', async ({ page }) => {
    await signUp(page, EMAIL);
    await page.goto(APPEARANCE_URL);
    await expect(page.getByRole('radiogroup', { name: 'Style', exact: true })).toBeVisible();

    // ── The CONTROL. The default style paints no atmosphere, so both canvases
    // are bare. This is what makes the reading below a CHANGE rather than a
    // value that was always there.
    const flat = await readCanvases(page);
    expect(flat.body, 'the default style paints no page atmosphere').toBe('none');
    expect(flat.shell, 'and the shell shows the same').toBe('none');

    // ── LIGHT. The shell must show the body's atmosphere, not an opaque fill.
    await chooseAppearance(page, 'Style', '3D / Immersive', 'data-style', '3d-immersive');
    const light = await readCanvases(page);
    expect(light.body, 'the style paints an atmosphere on the page canvas').toContain(
      'radial-gradient',
    );
    expect(
      light.shell,
      'the SHELL canvas must show the page atmosphere rather than mask it behind ' +
        '`--el-page-bg` — this is the assertion that fails on the defect',
    ).toBe(light.body);
    expect(light.shellAnimation, 'the atmosphere is static depth — it introduces no motion').toBe(
      'none',
    );

    // ── DARK. Palette-derived means the resolved value MOVES with the theme; a
    // value that did not would be evidence the `--el-*` reads are not landing.
    await chooseAppearance(page, 'Theme', 'Dark', 'data-theme', 'dark');
    const dark = await readCanvases(page);
    expect(dark.body, 'the atmosphere is palette-derived, so dark resolves differently').not.toBe(
      light.body,
    );
    expect(dark.shell, 'and the shell tracks it there too').toBe(dark.body);
    expect(dark.shellAnimation, 'still no motion under the dark palette').toBe('none');
  });
});
