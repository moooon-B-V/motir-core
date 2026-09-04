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
//
// ── AND THE SAME DEFECT IN FIVE MORE STYLES (MOTIR-4234) ────────────────────
// 3D / Immersive was one instance of a general defect: glassmorphism's vibrant
// wash, cybercore's tech grid, aurora's drifting ribbons, neumorphism's moulded
// field and retrofuturism's synthwave sky are all `body`-level canvases, and all
// of them were painted and then covered by the same opaque shell fill. The tests
// below walk the rest of that set against the same oracle — `body`'s own
// computed value, in the same state — plus the two dispositions the generalising
// needed beyond a second selector: aurora's canvas ANIMATES, so its
// reduced-motion arm has to still both members; and retrofuturism paints a
// `z-index: -1` grid floor BELOW content, which needs the shell to be its own
// stacking context or the layer resolves behind the shell's background.

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

/** The canvas COLOUR, which is neumorphism's whole identity rather than an image. */
async function readCanvasColours(page: Page): Promise<{ shell: string; body: string }> {
  return page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('[data-app-shell]');
    if (!shell) throw new Error('no [data-app-shell] root on this signed-in route');
    return {
      shell: getComputedStyle(shell).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
    };
  });
}

/** The page canvas's own resolved animation — the other half of the drift criterion. */
async function readBodyAnimation(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).animationName);
}

/**
 * Sign in and land on the appearance pane with its Style control mounted — the
 * one surface that can move the axes through the product's own mechanism.
 */
async function openAppearance(page: Page, email: string): Promise<void> {
  await signUp(page, email);
  await page.goto(APPEARANCE_URL);
  await expect(page.getByRole('radiogroup', { name: 'Style', exact: true })).toBeVisible();
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

test.describe('every other style canvas reaches the signed-in shell (MOTIR-4234)', () => {
  test('the shell shows the page canvas under each style that paints one', async ({ page }) => {
    await openAppearance(page, 'e2e-shell-style-canvas@example.com');

    // ── The CONTROL, same as above: the default style paints nothing, so this
    // reading is a CHANGE rather than a value that was always there.
    const flat = await readCanvases(page);
    expect(flat.body, 'the default style paints no page canvas').toBe('none');
    expect(flat.shell, 'and the shell shows the same').toBe('none');

    // The four IMAGE canvases. The oracle is `body`'s own computed value in the
    // same state — never a table of expected gradient strings, which would need
    // re-typing every time a canvas is tuned and would silently become a test of
    // a stale table the first time somebody skipped it.
    for (const [option, id] of [
      ['Glassmorphism', 'glassmorphism'],
      ['Cybercore / Y2K', 'cybercore-y2k'],
      ['Aurora', 'aurora'],
      ['Retrofuturism', 'retrofuturism'],
    ] as const) {
      await chooseAppearance(page, 'Style', option, 'data-style', id);
      const seen = await readCanvases(page);
      expect(seen.body, `${id} paints a canvas on the page`).not.toBe('none');
      expect(
        seen.shell,
        `the SHELL canvas must show ${id}'s page canvas rather than mask it behind ` +
          '`--el-page-bg` — this is the assertion that fails on the defect',
      ).toBe(seen.body);
    }

    // ── NEUMORPHISM is a canvas COLOUR, not an image: the whole illusion is that
    // panels are moulded out of the same `--el-surface` field the page is. So the
    // image assertion above would pass vacuously here (`none` on both sides) and
    // the colour is what has to agree.
    await chooseAppearance(page, 'Style', 'Neumorphism', 'data-style', 'neumorphism');
    const moulded = await readCanvasColours(page);
    const control = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--el-surface').trim(),
    );
    expect(control, 'the style declares a surface token to mould from').not.toBe('');
    expect(
      moulded.shell,
      'the shell canvas must adopt the moulded field, not keep `--el-page-bg` over it',
    ).toBe(moulded.body);
  });

  test('retrofuturism keeps its grid floor above the shell canvas and below all content', async ({
    page,
  }) => {
    await openAppearance(page, 'e2e-shell-retro-floor@example.com');
    await chooseAppearance(page, 'Style', 'Retrofuturism', 'data-style', 'retrofuturism');

    // ── The WIRING. `body::after`'s floor is `position: fixed; z-index: -1`, and
    // both shell roots are `relative` with `z-index: auto` — no stacking context —
    // so a negative-z-index descendant would paint into the ROOT context, behind
    // the shell's own background. `isolation: isolate` is what puts the layer
    // between the shell's canvas and the shell's content, and it is the one place
    // this generalising needed more than a second selector.
    const wiring = await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>('[data-app-shell]');
      if (!shell) throw new Error('no [data-app-shell] root on this signed-in route');
      const after = getComputedStyle(shell, '::after');
      return {
        isolation: getComputedStyle(shell).isolation,
        content: after.content,
        position: after.position,
        zIndex: after.zIndex,
        image: after.backgroundImage,
      };
    });
    expect(wiring.isolation, 'the shell is its own stacking context').toBe('isolate');
    expect(wiring.content, 'the shell carries the floor pseudo-element').not.toBe('none');
    expect(wiring.position).toBe('fixed');
    expect(wiring.zIndex, 'the floor is a layer BELOW content').toBe('-1');
    expect(wiring.image, 'the floor is the receding neon grid').toContain(
      'repeating-linear-gradient',
    );

    // ── The RENDERED half, because the wiring above is a restatement of the
    // stylesheet and the whole defect was a rule that was correct and invisible.
    // Two clips, and they answer the criterion's two halves separately.
    const shell = page.locator('[data-app-shell]');
    // `.filter({ visible: true })` because the mobile DRAWER renders a second
    // rail that is hidden at this viewport — `.first()` alone can pick it.
    const rail = page.locator("[data-surface='sidebar']").filter({ visible: true }).first();
    await expect(rail).toBeVisible();

    const railBox = (await rail.boundingBox())!;
    const viewport = page.viewportSize()!;
    // A patch of the rail INSIDE the floor's 42vh band. The rail is opaque
    // (`--el-sidebar-bg`), so it is app content the floor must not reach.
    const covered = {
      x: Math.round(railBox.x + railBox.width / 2 - 20),
      y: Math.round(viewport.height - viewport.height * 0.21),
      width: 40,
      height: 24,
    };

    const shot = async () => ({
      whole: await shell.screenshot({ animations: 'disabled' }),
      covered: await page.screenshot({ animations: 'disabled', clip: covered }),
    });

    const withFloor = await shot();
    await page.addStyleTag({ content: '[data-app-shell]::after{display:none!important}' });
    const withoutFloor = await shot();

    expect(
      withFloor.whole.equals(withoutFloor.whole),
      'hiding the floor must CHANGE the shell — if it does not, the layer is ' +
        'painted behind the shell canvas and nobody has ever seen it',
    ).toBe(false);
    expect(
      withFloor.covered.equals(withoutFloor.covered),
      'and it must change nothing inside an opaque app surface — the floor is a ' +
        'canvas layer, not an overlay',
    ).toBe(true);
  });
});

test.describe('aurora drifts on the shell exactly as it drifts on the page (MOTIR-4234)', () => {
  test('a no-preference user gets the drift on both members', async ({ page }) => {
    await openAppearance(page, 'e2e-shell-aurora-motion@example.com');
    await chooseAppearance(page, 'Style', 'Aurora', 'data-style', 'aurora');

    const seen = await readCanvases(page);
    const body = await readBodyAnimation(page);
    expect(body, 'the page canvas drifts').not.toBe('none');
    expect(seen.shellAnimation, 'and the shell drifts with it, from the same rule').toBe(body);
  });

  test.describe('under a reduced-motion preference', () => {
    // ⚠️ `contextOptions`, NOT a bare `reducedMotion` key. `reducedMotion` is a
    // `BrowserContextOptions` field, not a top-level Playwright TEST option, and
    // the bare form fails BOTH ways at once: `tsc` rejects it (TS2353) and the
    // runner silently ignores the unknown fixture key, so the context runs at
    // the DEFAULT preference and the test measures the no-preference world while
    // claiming to measure the reduced one. It went red rather than quietly green
    // only because the assertions below read `body` as well as the shell.
    test.use({ contextOptions: { reducedMotion: 'reduce' } });

    test('the drift is stilled on both members, never on one', async ({ page }) => {
      await openAppearance(page, 'e2e-shell-aurora-still@example.com');
      await chooseAppearance(page, 'Style', 'Aurora', 'data-style', 'aurora');

      // The identity holds — the ribbons are still painted; only the drift stops.
      const seen = await readCanvases(page);
      expect(seen.body, 'the aurora canvas is still painted').not.toBe('none');
      expect(seen.shell, 'and the shell still shows it').toBe(seen.body);

      expect(await readBodyAnimation(page), 'the page canvas is still').toBe('none');
      expect(
        seen.shellAnimation,
        'an arm that stilled only `body` leaves a reduced-motion user with a ' +
          'drifting frame around a still page — the defect inverted, not fixed',
      ).toBe('none');
    });
  });
});

// ── THE SHELL CHROME (MOTIR-4253) ──────────────────────────────────────────
// The rendered half of `tests/theme/immersiveShellChrome.test.ts`, and the same
// division of labour the two blocks above use: the unit lane asserts the WIRING
// (the rules exist, they match the design asset declaration for declaration, the
// fallbacks touch no layout property) and this asserts what a user SEES. Neither
// substitutes for the other — `box-shadow: var(--shadow-card)` inside an
// `@scope` block resolves in neither of the DOM implementations the unit lane
// has, so only a browser can tell a treated frame from an untreated one.
//
// THE ORACLE IS THE DEFAULT STYLE'S OWN COMPUTED VALUE, never a hard-coded
// expectation. The card's first criterion says so outright, and it is the same
// discipline as `body`'s computed canvas above: a table of expected shadow
// strings would need re-typing every time the depth is tuned.

/** Both chrome hosts, as the browser resolves them. */
interface Chrome {
  rail: {
    boxShadow: string;
    borderRadius: string;
    borderRightColor: string;
    backgroundColor: string;
    // ⚠️ `outlineStyle` is the discriminator, NOT `outlineWidth`. `outline-width`
    // computes INDEPENDENTLY of `outline-style`, so an element with no outline
    // at all reads back the UA's initial `medium` — measured as `3px` in
    // chromium — while `outline-style` is `none` and nothing is painted. Reading
    // the width alone says "there is an outline here" on every element in the
    // document. Both are kept because once the style IS `solid`, the width is
    // the half that says the hairline is 1px rather than some other line.
    outlineStyle: string;
    outlineWidth: string;
    outlineColor: string;
  };
  bar: {
    boxShadow: string;
    backgroundColor: string;
    backgroundImage: string;
    borderBottomColor: string;
    position: string;
  };
}

async function readChrome(page: Page): Promise<Chrome> {
  return page.evaluate(() => {
    // `.filter({ visible: true })`'s DOM equivalent: the mobile DRAWER renders a
    // second rail that is hidden at this viewport, and picking it would measure
    // a box the user never sees.
    const rails = [...document.querySelectorAll<HTMLElement>("[data-surface='sidebar']")];
    const rail = rails.find((el) => el.offsetParent !== null);
    const bar = document.querySelector<HTMLElement>("[data-surface='header']");
    if (!rail) throw new Error('no visible [data-surface=sidebar] on this signed-in route');
    if (!bar) throw new Error('no [data-surface=header] on this signed-in route');
    const r = getComputedStyle(rail);
    const b = getComputedStyle(bar);
    return {
      rail: {
        boxShadow: r.boxShadow,
        borderRadius: r.borderRadius,
        borderRightColor: r.borderRightColor,
        backgroundColor: r.backgroundColor,
        outlineStyle: r.outlineStyle,
        outlineWidth: r.outlineWidth,
        outlineColor: r.outlineColor,
      },
      bar: {
        boxShadow: b.boxShadow,
        backgroundColor: b.backgroundColor,
        backgroundImage: b.backgroundImage,
        borderBottomColor: b.borderBottomColor,
        position: b.position,
      },
    };
  });
}

/** Both chrome boxes, rounded — the geometry an a11y fallback must not move. */
async function readChromeBoxes(page: Page) {
  return page.evaluate(() => {
    const rails = [...document.querySelectorAll<HTMLElement>("[data-surface='sidebar']")];
    const rail = rails.find((el) => el.offsetParent !== null)!;
    const bar = document.querySelector<HTMLElement>("[data-surface='header']")!;
    const box = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100) / 100);
    };
    return { rail: box(rail), bar: box(bar) };
  });
}

test.describe('3D / Immersive treats the shell chrome (MOTIR-4253)', () => {
  test('the rail floats and the bar becomes a lid — neither does under the default style', async ({
    page,
  }) => {
    await openAppearance(page, 'e2e-shell-chrome-treatment@example.com');

    // ── The CONTROL. This is what "renders byte-identically to the default
    // style" meant, and it is what makes every reading below a CHANGE rather
    // than a value that was always there.
    const flat = await readChrome(page);
    expect(flat.rail.boxShadow, 'the default style leaves the rail flat').toBe('none');
    expect(flat.bar.boxShadow, 'and the bar flat').toBe('none');

    await chooseAppearance(page, 'Style', '3D / Immersive', 'data-style', '3d-immersive');
    const deep = await readChrome(page);

    // ── AC 1, against the default style's own computed values.
    expect(
      deep.rail.boxShadow,
      'the RAIL must take a treatment the default style does not',
    ).not.toBe(flat.rail.boxShadow);
    expect(deep.bar.boxShadow, 'and so must the BAR — this is the defect itself').not.toBe(
      flat.bar.boxShadow,
    );

    // ── The RAIL is a floating PANEL: a shadow instead of a shared edge, and a
    // radius, so it reads as an object at a distance.
    expect(deep.rail.boxShadow).not.toBe('none');
    expect(deep.rail.borderRadius, 'a floating panel has corners').not.toBe(flat.rail.borderRadius);
    expect(deep.rail.borderRightColor, 'the shared edge goes transparent').toBe('rgba(0, 0, 0, 0)');

    // ── The BAR is the LID: no fill, no hairline, one contact shadow — and it
    // keeps its `sticky`, which is BOTH the containing block a positional
    // override would break and the stacking context that makes the shadow paint
    // (AC 8's rendered half; the unit lane asserts no rule declares `position`).
    expect(deep.bar.backgroundColor, 'the atmosphere runs UNDER the lid').toBe('rgba(0, 0, 0, 0)');
    expect(deep.bar.borderBottomColor).toBe('rgba(0, 0, 0, 0)');
    expect(deep.bar.boxShadow).not.toBe('none');
    expect(deep.bar.position, 'the lid never overrides the host’s sticky').toBe('sticky');

    // ── AC 13. A transparent fill is only half the claim: the thing behind it
    // has to be the atmosphere. Painting an opaque fill here is exactly the
    // shape MOTIR-4230 fixed one surface over.
    expect(deep.bar.backgroundImage, 'the lid paints no canvas of its own').toBe('none');
    const canvases = await readCanvases(page);
    expect(canvases.shell, 'and what shows through it is the shell atmosphere').toContain(
      'radial-gradient',
    );
  });

  test('is palette-derived where it is a COLOUR and theme-invariant where it is a SHADOW', async ({
    page,
  }) => {
    await openAppearance(page, 'e2e-shell-chrome-themes@example.com');
    await chooseAppearance(page, 'Style', '3D / Immersive', 'data-style', '3d-immersive');

    const light = await readChrome(page);
    await chooseAppearance(page, 'Theme', 'Dark', 'data-theme', 'dark');
    const dark = await readChrome(page);

    // ── AC 5, first half. The rail's fill is `--el-sidebar-bg`, so it MOVES
    // with the palette — a value that agreed across themes would be evidence
    // the token reads are not landing at all.
    expect(
      dark.rail.backgroundColor,
      'the rail fill is palette-derived, so dark resolves differently',
    ).not.toBe(light.rail.backgroundColor);

    // ── AC 5, second half, and it is asserted POSITIVELY rather than skipped.
    // §2 builds the shadows from a fixed near-ink `rgba` on purpose — a shadow
    // is not a palette colour — so they are theme-INVARIANT, and the criterion
    // as originally written (that the treatment's resolved value must differ
    // between themes) would have failed here by construction. Pinning the
    // invariance is what makes a future palette-derived shadow a deliberate
    // change rather than a silent one.
    expect(dark.rail.boxShadow, 'the rail depth is theme-invariant, by design').toBe(
      light.rail.boxShadow,
    );
    expect(dark.bar.boxShadow, 'and so is the lid’s contact shadow').toBe(light.bar.boxShadow);
  });

  test('the a11y fallbacks restore a line and MOVE NOTHING', async ({ page }) => {
    await openAppearance(page, 'e2e-shell-chrome-fallbacks@example.com');
    await chooseAppearance(page, 'Style', '3D / Immersive', 'data-style', '3d-immersive');

    const before = await readChromeBoxes(page);
    const resting = await readChrome(page);
    expect(resting.rail.outlineStyle, 'no outline is DRAWN at rest').toBe('none');

    // ── `prefers-contrast: more`. The rail's hairline comes back as an OUTLINE
    // at `outline-offset: -1px` — drawn outside the box, following the radius —
    // and the bar's border-bottom already has its width, so only its colour is
    // given back. The geometry assertion is the criterion's own words: identical
    // WITH and WITHOUT the media condition, not merely "a line appeared".
    await page.emulateMedia({ contrast: 'more' });
    const contrast = await readChrome(page);
    expect(contrast.rail.outlineStyle, 'the rail hairline is drawn').toBe('solid');
    expect(contrast.rail.outlineWidth, 'and it is a hairline').toBe('1px');
    expect(contrast.bar.borderBottomColor, 'and the bar’s').not.toBe('rgba(0, 0, 0, 0)');
    expect(contrast.rail.boxShadow, 'a high-contrast user keeps the depth').toBe(
      resting.rail.boxShadow,
    );
    expect(await readChromeBoxes(page), 'the contrast fallback moved the box').toEqual(before);

    // ── `forced-colors: active` additionally drops the shadow, because the
    // platform is repainting every colour and a multi-layer shadow is noise
    // there. Still no layout change.
    await page.emulateMedia({ contrast: null, forcedColors: 'active' });
    const forced = await readChrome(page);
    expect(forced.rail.outlineStyle, 'the rail hairline is drawn here too').toBe('solid');
    expect(forced.rail.outlineWidth, 'and it is a hairline').toBe('1px');
    expect(await readChromeBoxes(page), 'the forced-colors fallback moved the box').toEqual(before);

    await page.emulateMedia({ forcedColors: null });
  });
});
