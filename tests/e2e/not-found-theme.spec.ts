// E2E: a missing work item's 404 is LEGIBLE — MOTIR-4708.
//
// ## The defect
//
// `motir-core` shipped no `not-found.tsx`, so all 16 `app/(authed)` pages that
// call `notFound()` fell through to Next's BUILT-IN not-found component, whose
// markup carries its own `<style>` inside the body:
//
//     body{color:#000;background:#fff;margin:0}
//     @media (prefers-color-scheme:dark){body{color:#fff;background:#000}}
//
// It is emitted after `app/globals.css`'s `body { color: var(--el-page-text) }`
// at equal specificity, so its `color` wins. Its `background` is then masked by
// the shell, which paints its own `bg-(--el-page-bg)` div from `data-theme` on
// `<html>` — so the INK comes from the OS and the GROUND comes from the app's
// own theme, and a person who pins light or dark (two of the three states the
// top bar's tri-state toggle cycles into) can make the two disagree. Measured on
// `origin/main` 7283015c8: light theme + dark OS rendered the message white on
// white, **1.00 : 1**. The status was 404 the whole time; the page just looked
// empty.
//
// ## Why it is a browser spec and not a unit test
//
// The failure is a CSS CASCADE between a stylesheet, an inline `<style>` the
// framework injects, and a media query — three things only a browser resolves,
// and the ratio is a property of two RESOLVED colours rather than of two token
// names. `tests/navigation/not-found-boundary.test.ts` holds the half that is
// static (the boundary files exist and key on no OS media query); this spec
// measures what a reader actually sees.
//
// ## What is asserted
//
// Per cell of the FOUR theme × OS combinations:
//
//   1. the message renders at all, and the page offers a door back — a link to
//      `/items`, which is the whole reason a 404 inside the shell is survivable;
//   2. the message's ink reaches **4.5 : 1** against the ground actually
//      composited behind it, resolved from the running page and never from token
//      names (a contrast figure owes the context it was sampled in, and a matrix
//      beats a number);
//
// per OS scheme:
//
//   3. the response is still **404** — the boundary must not turn the page into
//      one that merely LOOKS like a 404 (MOTIR-3491 / MOTIR-3492 is that defect,
//      and `tests/navigation/loading-boundary-guard.test.ts` guards its cause);
//
// and over the matrix as a whole:
//
//   4. with the theme PINNED, flipping the OS colour scheme moves neither the
//      message's ink nor `body`'s by one channel. That is the defect stated as an
//      invariant, and it names no token — so it cannot go quietly true if the
//      theme layer's plumbing is renamed.
//
// Authoritative-signal discipline (CLAUDE.md § E2E): the status is read off the
// navigation response, the pin is read off the toggle's own accessible name, and
// every colour is sampled only after `document.getAnimations()` has settled —
// never on an interval and never after a sleep.
import { expect, test, type Page } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { createFirstProject, signUp } from './_helpers/shell-session';

const USER = 'e2e-not-found-theme@example.com';

/** A key no project in this database can own, so the route always 404s. */
const MISSING_KEY = 'ZZZZ-999999';

/** The `errors.notFound` copy the boundaries render (messages/en.json). */
const NOT_FOUND_TITLE = 'We couldn’t find that page';

/**
 * The matrix is walked as OS-scheme × theme rather than as four independent
 * cells, because the OS scheme is the only axis that needs a fresh document: the
 * response status is read off the navigation, and the theme is then pinned ON the
 * 404 page itself. That is not a shortcut — it is the faithful shape. The defect
 * is a CLIENT-side cascade (an inline `<style>` versus a stylesheet, arbitrated by
 * a media query), so re-resolving it in place is exactly what a reader does when
 * they flip the toggle while looking at the page.
 *
 * It also keeps the measurement out of reach of the toggle's DEBOUNCED write: the
 * preference is persisted ~250 ms after the click, and only a document navigation
 * would read it back from the server. Nothing here navigates afterwards.
 */
const OS_SCHEMES = ['dark', 'light'] as const;
const THEMES = ['light', 'dark'] as const;

/**
 * PIN the theme with the top bar's tri-state toggle (light → dark → system).
 *
 * ⚠️ PINNED, never `system`. `system` is the one state in which the two
 * mechanisms AGREE by construction — the framework's `prefers-color-scheme` and
 * the app's `data-theme` both resolve off the OS — so it cannot exhibit the
 * defect at all. The accessible name is what tells them apart: `Theme: Light.`
 * versus `Theme: System (light).`, which is why this reads the label rather than
 * counting clicks.
 */
async function pinTheme(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  const toggle = page.getByRole('button', { name: /^Theme:/ });
  const pinned = new RegExp(`^Theme: ${theme === 'light' ? 'Light' : 'Dark'}\\.`);

  for (let i = 0; i < 3; i += 1) {
    if (pinned.test((await toggle.getAttribute('aria-label')) ?? '')) break;
    await toggle.click();
  }
  await expect(toggle, `the toggle is pinned to ${theme}`).toHaveAttribute('aria-label', pinned);
  await expect(page.locator('html'), `<html> carries data-theme=${theme}`).toHaveAttribute(
    'data-theme',
    theme,
  );
}

/** WCAG relative luminance of an `[r, g, b]` triple. */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

interface Sample {
  /** The computed colour of the element carrying the not-found message. */
  ink: [number, number, number];
  /** Every ancestor background composited down to the browser canvas. */
  ground: [number, number, number];
  /** `body`'s own computed colour — the property the framework's rule seized. */
  bodyInk: [number, number, number];
}

/**
 * Read the message's ink and the ground COMPOSITED behind it out of the running
 * page. Walking the ancestor chain and alpha-compositing is what makes this a
 * measurement rather than a token lookup: the ground is a stack of surfaces, and
 * which one you land on depends on the theme.
 */
async function sample(page: Page, heading: string): Promise<Sample> {
  return page.evaluate((headingText) => {
    type Rgba = [number, number, number, number];
    type Rgb = [number, number, number];

    const parse = (value: string): Rgba => {
      const n = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 1];
    };
    const over = (top: Rgba, under: Rgb): Rgb => [
      top[0] * top[3] + under[0] * (1 - top[3]),
      top[1] * top[3] + under[1] * (1 - top[3]),
      top[2] * top[3] + under[2] * (1 - top[3]),
    ];
    const round = (c: Rgb): Rgb => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];
    const rgbOf = (value: string): Rgb => {
      const [r, g, b] = parse(value);
      return [r, g, b];
    };

    const el = [...document.querySelectorAll('h1, h2, h3, p')].find(
      (n) => n.textContent?.trim() === headingText,
    );
    if (!el) throw new Error(`no element carries the not-found message: "${headingText}"`);

    // The ground is a STACK, not a token: composite every ancestor background
    // from the outermost inwards over the browser canvas. Which surface the ink
    // actually lands on depends on the theme, so it is measured, not looked up.
    const chain: Element[] = [];
    for (let n: Element | null = el; n; n = n.parentElement) chain.push(n);
    let ground: Rgb = [255, 255, 255];
    for (const node of chain.reverse()) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg[3] > 0) ground = over(bg, ground);
    }

    return {
      ink: rgbOf(getComputedStyle(el).color),
      ground: round(ground),
      bodyInk: rgbOf(getComputedStyle(document.body).color),
    };
  }, heading);
}

/**
 * `sample`, taken only once the theme TRANSITION has actually finished.
 *
 * `app/globals.css` transitions `body`'s colour and background over
 * `--transition-duration`, and the shell's surfaces do the same, so a reading
 * taken the instant the toggle is clicked catches the tween. Two readings that
 * merely AGREE are not enough either: the curve is `ease`, so it barely moves at
 * first and two samples 100 ms apart both round to the colour it started from —
 * `rgb(225, 226, 228)` was read that way, and it is the value the page is leaving
 * rather than the one it settles on.
 *
 * `document.getAnimations()` includes running CSS transitions and each one's
 * `finished` promise resolves when it is over, so awaiting them all is the
 * authoritative signal (CLAUDE.md § E2E: never an interval, never a sleep). The
 * agreement check stays as a second guard for anything that started late.
 */
async function settledSample(page: Page, heading: string): Promise<Sample> {
  const settle = () =>
    page.evaluate(() =>
      Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))).then(
        () => undefined,
      ),
    );

  await settle();
  let current = JSON.stringify(await sample(page, heading));
  await expect(async () => {
    const previous = current;
    await settle();
    current = JSON.stringify(await sample(page, heading));
    expect(current, 'the theme transition has settled').toBe(previous);
  }).toPass({ timeout: 10_000, intervals: [150, 150, 300, 500] });
  return JSON.parse(current) as Sample;
}

test.describe('A missing work item’s 404 (MOTIR-4708)', () => {
  // One sign-up, one project, two document navigations and four themed
  // measurements. The config's 30 s default is a budget for a single-surface
  // spec; this one is a matrix, and the ceiling is raised for the whole describe
  // rather than per assertion so a slow box stretches the budget instead of
  // failing the third cell.
  test.describe.configure({ timeout: 180_000 });

  test.beforeEach(async () => {
    await resetDatabase();
  });

  test('@smoke is legible in every theme × OS combination, and still answers 404', async ({
    page,
  }) => {
    await signUp(page, USER);
    await createFirstProject(page, 'Not Found Ink');

    // The matrix, measured — never one reading generalised to "the theme"
    // (a contrast figure owes the context it was sampled in).
    const measured: string[] = [];
    const inkByCell = new Map<string, string>();
    const bodyInkByCell = new Map<string, string>();

    for (const colorScheme of OS_SCHEMES) {
      await page.emulateMedia({ colorScheme });

      // ONE navigation per OS scheme: the status is a property of the RESPONSE,
      // so it is read here, and both themes are then pinned in place below.
      const res = await page.goto(`/items/${MISSING_KEY}`);
      expect(res?.status(), `OS ${colorScheme}: the status is still a real 404`).toBe(404);

      for (const theme of THEMES) {
        const cell = `${theme} theme / ${colorScheme} OS`;
        await pinTheme(page, theme);

        await expect(
          page.getByRole('heading', { name: NOT_FOUND_TITLE }),
          `${cell}: the message renders`,
        ).toBeVisible();

        const s = await settledSample(page, NOT_FOUND_TITLE);
        // Both are recorded: the message is what the card is about, and `body`
        // is what the framework's rule actually seized — it leaked into the shell
        // chrome too, visibly dimming the rail labels. They are DIFFERENT tokens
        // (`--el-text` on the heading, `--el-page-text` on the document), so they
        // are compared against themselves across the OS flip, never to each other.
        inkByCell.set(cell, `${s.ink}`);
        bodyInkByCell.set(cell, `${s.bodyInk}`);

        const ratio = contrast(s.ink, s.ground);
        const reading = `${cell}: rgb(${s.ink}) on rgb(${s.ground}) = ${ratio.toFixed(2)}:1`;
        measured.push(reading);
        expect(ratio, reading).toBeGreaterThanOrEqual(4.5);

        // A door back — the whole reason a 404 inside the shell is survivable.
        await expect(
          page.getByRole('link', { name: 'Go to work items' }),
          `${cell}: the way back is a real link`,
        ).toHaveAttribute('href', '/items');
      }
    }

    // ⚠️ THE DEFECT, STATED AS AN INVARIANT AND WITHOUT NAMING A TOKEN. With the
    // theme PINNED, the OS colour scheme is not an authority over anything: it is
    // a setting on a different machine's preferences pane. So flipping it must
    // not move the ink by one channel. That is precisely what used to happen —
    // and asserting it this way needs no knowledge of which token the theme layer
    // happens to resolve the ink from, so it cannot go quietly true if that
    // plumbing is renamed.
    for (const theme of THEMES) {
      expect(
        inkByCell.get(`${theme} theme / dark OS`),
        `${theme} theme: the message's ink is the same whatever the OS says`,
      ).toBe(inkByCell.get(`${theme} theme / light OS`));
      expect(
        bodyInkByCell.get(`${theme} theme / dark OS`),
        `${theme} theme: the document's ink is the same whatever the OS says`,
      ).toBe(bodyInkByCell.get(`${theme} theme / light OS`));
    }

    // eslint-disable-next-line no-console -- the matrix belongs in the run log.
    console.log(`MOTIR-4708 contrast matrix\n  ${measured.join('\n  ')}`);
  });
});
