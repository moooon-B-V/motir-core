// E2E: the signed-in shell owns the ONLY scroller — the document never scrolls
// (MOTIR-3208).
//
// ── The invariant ───────────────────────────────────────────────────────────
// `components/ui/AppLayout.tsx` is `flex h-dvh flex-col overflow-hidden` and its
// `<main id="main">` is `min-h-0 overflow-y-auto`. The shell is therefore exactly
// one DYNAMIC viewport tall, clips itself, and `<main>` is the only scroller on
// any signed-in surface. A document scrollbar means something OUTSIDE the shell
// is taller than `100dvh` — nothing inside it can produce one, because the root
// clips.
//
// ── Why the plain assertion is not enough, and what this spec does about it ──
// The reported defect was `app/globals.css`'s `body { min-height: 100vh }`. `vh`
// is the LARGE viewport (browser UI retracted); the shell is sized in `dvh`, the
// DYNAMIC one. Where a browser's two viewports differ, the floor exceeds the
// shell's height by exactly that difference and the document gains that many
// EMPTY scrollable pixels — the reported "empty space at the bottom of the work
// item detail page, I can see 2 scroll bars when scrolling".
//
// **Chromium resolves `100vh === 100dvh`**, headless and headed alike, so the
// bare geometry assertion PASSES on the broken source. Measured on the card:
// no document overflow at 1912×834, 1799×785, 1799×700, 1440×900, 1912×620 or
// 1280×1074, across all 11 `data-style` values. An assertion that cannot fail on
// the defect it names is not a regression test.
//
// So the middle test EMULATES the divergent browser rather than hoping for one:
// it rewrites the served stylesheet, replacing every `100vh` token with
// `calc(100dvh + 290px)` — i.e. it makes the page behave as one whose LARGE
// viewport is 290 px taller than its dynamic one, 290 px being the offset
// measured off the report's own screenshot. Nothing else changes. On the broken
// source the body floor becomes `dvh + 290` and the document overflows by
// exactly that; with the floor expressed in `dvh` the rewrite has nothing to
// match and the page is untouched. That is the test that fails on `origin/main`.
//
// The rewrite is also GENERAL: it catches any `vh`-unit length reintroduced
// anywhere on the shell path, including Tailwind's `h-screen` family, which
// compiles to `100vh`.
//
// ── The three tests ─────────────────────────────────────────────────────────
// 1. THE INVARIANT, on a detail route AND a non-detail one, at a short viewport
//    (620 px) and a tall one (1074 px) — the shell fills the viewport with no
//    gap at the bottom and the document does not scroll. The two routes are the
//    point of the third acceptance criterion: the invariant belongs to the
//    SHELL, not to one page.
// 2. THE DIVERGENT BROWSER — the same invariant under the emulation above.
// 3. TEETH — the floor forced past `100dvh` by hand, asserting the geometry
//    check DOES fail and reproduces the reported picture (a ~290 px empty band
//    below a shell whose bottom edge sits that far above the viewport bottom).
//    A guard whose failing branch was never observed is a tautology.
// 4. THE CONTAINING-BLOCK LEAK (MOTIR-3286) — the SECOND cause of the same
//    picture, and the one the report was actually about.
//
//    Tests 1–3 all rest on "nothing inside the shell can produce a document
//    scrollbar, because the root clips". `overflow` clips a descendant only when
//    that descendant's CONTAINING BLOCK is inside the clipping box, so an
//    `absolute` element with no positioned ancestor escaped the shell and its
//    static position — far down `<main>`'s flow — lengthened the DOCUMENT to
//    reach it. Measured on the live app: `scrollHeight` 1364 against a
//    `clientHeight` of 371, from one 1px `sr-only` span, on a browser where
//    `100vh === 100dvh` and test 2's mechanism cannot fire at all.
//
//    Test 1 passes on the broken source because the seeded fixture happens to
//    ship no unanchored `absolute` — so this test INJECTS one rather than
//    waiting for a component to. It asserts the invariant against the general
//    defect, not against today's offending span, and it carries its own teeth:
//    it strips the anchor and watches the same probe lengthen the document.
//
// Setup is auth (`shell-session` signUp) + the `_test` work-item harness, so this
// has no ordering dependency on any other spec.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';

const EMAIL = 'e2e-shell-viewport-floor@example.com';

/** Short and tall, from the card's own acceptance criterion. */
const SHORT_VIEWPORT = { width: 1280, height: 620 };
const TALL_VIEWPORT = { width: 1280, height: 1074 };

/**
 * The offset measured off the report's screenshot: the rail's nav list started
 * at its 7th row and the shell's bottom edge sat ~290 CSS px above the viewport
 * bottom. Used both as the emulated `lvh − dvh` gap and as the forced floor.
 */
const REPORTED_BAND_PX = 290;

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

/** Sign-up auto-creates the workspace; create a project server-side + pin it
 *  active, then seed one work item to open. Returns its identifier. */
async function seedSignedInItem(page: Page): Promise<string> {
  await signUp(page, EMAIL);
  const local = EMAIL.split('@')[0]!;
  const user = (await db.user.findFirst({ where: { email: EMAIL } }))!;
  const ws = (await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } }))!;
  const project = await projectsService.createProject({
    workspaceId: ws.id,
    actorUserId: user.id,
    name: 'Shell Viewport',
    identifier: 'SHV',
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user.id, workspaceId: ws.id } },
    data: { activeProjectId: project.id },
  });
  const res = await page.request.post('/api/_test/work-items', {
    data: {
      projectId: project.id,
      kind: 'task',
      title: 'A work item whose detail page must not scroll the document',
      // Long enough that `<main>` itself has something to scroll — the point is
      // that the DOCUMENT does not, however tall the content is.
      descriptionMd: Array.from(
        { length: 40 },
        (_, i) => `Paragraph ${i + 1} — body copy that makes the detail panel tall.`,
      ).join('\n\n'),
    },
  });
  expect(res.status(), 'seed work item').toBe(201);
  return ((await res.json()) as { identifier: string }).identifier;
}

interface DocumentGeometry {
  scrollHeight: number;
  clientHeight: number;
  innerHeight: number;
  mainBottom: number;
  scrollY: number;
}

async function documentGeometry(page: Page): Promise<DocumentGeometry> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const main = document.getElementById('main');
    const rect = main?.getBoundingClientRect();
    return {
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
      innerHeight: window.innerHeight,
      mainBottom: rect ? Math.round(rect.bottom) : -1,
      scrollY: Math.round(window.scrollY),
    };
  });
}

/**
 * Emulate a browser whose LARGE viewport exceeds its DYNAMIC one by `deltaPx` —
 * the class of browser `dvh` exists for, and the one Chromium is not.
 *
 * Every `100vh` token in the served CSS becomes `calc(100dvh + <delta>px)`. The
 * token cannot occur inside `100dvh` (a `d` sits between the digits and the
 * unit), so a stylesheet already written in the dynamic unit is byte-identical
 * after the rewrite — which is exactly what makes this discriminate.
 *
 * Returns a reader for how many stylesheets were intercepted, so a run where the
 * route never fired cannot pass vacuously.
 */
async function emulateDivergentViewport(page: Page, deltaPx: number): Promise<() => number> {
  let intercepted = 0;
  await page.route(
    (url) => url.pathname.endsWith('.css'),
    async (route) => {
      const response = await route.fetch();
      const css = await response.text();
      intercepted += 1;
      await route.fulfill({
        status: response.status(),
        contentType: 'text/css; charset=utf-8',
        body: css.replaceAll('100vh', `calc(100dvh + ${deltaPx}px)`),
      });
    },
  );
  return () => intercepted;
}

test.describe('the shell owns the only scroller', () => {
  test('@smoke no document scrollbar on a detail OR a list surface, short viewport and tall', async ({
    page,
  }) => {
    const key = await seedSignedInItem(page);

    for (const route of [`/items/${key}`, '/items']) {
      for (const viewport of [SHORT_VIEWPORT, TALL_VIEWPORT]) {
        await page.setViewportSize(viewport);
        await page.goto(route);
        await expect(page.locator('main#main')).toBeVisible();

        const geometry = await documentGeometry(page);
        expect(
          geometry.scrollHeight,
          `${route} at ${viewport.width}x${viewport.height}: the DOCUMENT must not ` +
            'scroll — the shell is one dynamic viewport tall and clips itself, so ' +
            'any document overflow comes from outside it and is empty',
        ).toBe(geometry.clientHeight);

        // ...and the shell reaches the bottom edge: the fix must not trade the
        // empty band for a short page that leaves a gap instead.
        expect(
          geometry.mainBottom,
          `${route} at ${viewport.width}x${viewport.height}: the shell fills the viewport`,
        ).toBe(geometry.innerHeight);
      }
    }
  });

  test('no document scrollbar on a browser whose `vh` and `dvh` DISAGREE', async ({ page }) => {
    const readIntercepted = await emulateDivergentViewport(page, REPORTED_BAND_PX);
    const key = await seedSignedInItem(page);

    for (const route of [`/items/${key}`, '/items']) {
      await page.setViewportSize(TALL_VIEWPORT);
      await page.goto(route);
      await expect(page.locator('main#main')).toBeVisible();

      const geometry = await documentGeometry(page);
      expect(
        geometry.scrollHeight - geometry.clientHeight,
        `${route}: with the large viewport ${REPORTED_BAND_PX}px taller than the ` +
          'dynamic one, a shell-path length written in `vh` lengthens the DOCUMENT ' +
          'by exactly that much and the extra pixels are empty. Every ' +
          'viewport-sized length on the shell path must be `dvh`.',
      ).toBe(0);
    }

    // The emulation is only evidence if it actually ran: a route that never
    // fired would let this test pass on the very source it exists to fail on.
    expect(
      readIntercepted(),
      'the stylesheet rewrite intercepted at least one CSS response',
    ).toBeGreaterThan(0);
  });

  test('the geometry check has TEETH — a floor past `100dvh` reproduces the report', async ({
    page,
  }) => {
    const key = await seedSignedInItem(page);
    await page.setViewportSize(TALL_VIEWPORT);
    await page.goto(`/items/${key}`);
    await expect(page.locator('main#main')).toBeVisible();

    const clean = await documentGeometry(page);
    expect(clean.scrollHeight).toBe(clean.clientHeight);

    // Force the body floor past the shell's height — the same thing a `vh` floor
    // does on a browser with retractable UI — and scroll to the end.
    await page.evaluate((band) => {
      document.body.style.minHeight = `calc(100dvh + ${band}px)`;
      window.scrollTo(0, document.documentElement.scrollHeight);
    }, REPORTED_BAND_PX);

    const forced = await documentGeometry(page);
    expect(
      forced.scrollHeight - forced.clientHeight,
      'the document gains exactly the forced overflow',
    ).toBe(REPORTED_BAND_PX);
    expect(forced.scrollY, 'the whole shell has scrolled up as one block').toBe(REPORTED_BAND_PX);
    expect(
      forced.mainBottom,
      "the shell's bottom edge now sits that far above the viewport bottom — the " +
        'empty band the report photographed',
    ).toBe(forced.innerHeight - REPORTED_BAND_PX);

    // And it recovers, so the assertion is measuring the floor and not some
    // permanent property of the page.
    await page.evaluate(() => {
      document.body.style.minHeight = '';
      window.scrollTo(0, 0);
    });
    const restored = await documentGeometry(page);
    expect(restored.scrollHeight).toBe(restored.clientHeight);
    expect(restored.mainBottom).toBe(restored.innerHeight);
  });

  test('an `absolute` descendant with no offsets cannot lengthen the document (MOTIR-3286)', async ({
    page,
  }) => {
    const key = await seedSignedInItem(page);
    await page.setViewportSize(SHORT_VIEWPORT);
    await page.goto(`/items/${key}`);
    await expect(page.locator('main#main')).toBeVisible();

    const clean = await documentGeometry(page);
    expect(clean.scrollHeight, 'the page starts with no document overflow').toBe(
      clean.clientHeight,
    );

    // INJECT the defect: a filler that pushes `<main>`'s flow well past the
    // fold, then a 1px `absolute` element with NO offsets — the exact shape of a
    // Tailwind `sr-only` span, which is what the live report turned out to be.
    // The filler is an ordinary in-flow block, so it can only lengthen `<main>`;
    // only the probe can reach the document, and only if it escapes the clip.
    const probe = await page.evaluate((fillerPx) => {
      const main = document.getElementById('main')!;
      const filler = document.createElement('div');
      filler.dataset.floorProbe = 'filler';
      filler.style.height = `${fillerPx}px`;
      const span = document.createElement('span');
      span.dataset.floorProbe = 'span';
      // Tailwind's `sr-only`, verbatim apart from the clip path.
      span.style.cssText =
        'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;white-space:nowrap';
      main.append(filler, span);
      return {
        // Proof the probe really is below the fold — an injection that landed
        // inside the viewport would make this test pass for the wrong reason.
        staticOffsetTop: filler.offsetTop + fillerPx,
        mainScrollHeight: main.scrollHeight,
      };
    }, 3000);

    expect(
      probe.mainScrollHeight,
      "the filler made `<main>`'s own content taller than the viewport",
    ).toBeGreaterThan(clean.clientHeight);
    expect(
      probe.staticOffsetTop,
      "the probe's static position sits below the fold, where an escapee does damage",
    ).toBeGreaterThan(clean.clientHeight);

    const injected = await documentGeometry(page);
    expect(
      injected.scrollHeight,
      '`<main>` is a containing block as well as a clipping box, so an `absolute` ' +
        'descendant that sets no offsets is clipped by it and the DOCUMENT is ' +
        'untouched. Without that, the element anchors to the INITIAL containing ' +
        'block, escapes the shell, and drags the whole shell up over an empty ' +
        'band of body canvas.',
    ).toBe(injected.clientHeight);
    expect(injected.mainBottom, 'the shell still reaches the viewport bottom').toBe(
      injected.innerHeight,
    );

    // TEETH, in the same browser and on the same probe: strip the anchors and
    // the document grows by the escape. This is what makes the assertion above
    // evidence rather than a restatement of something the page does anyway.
    //
    // BOTH anchors come off, and that they must is itself the finding: with the
    // root still `relative` the probe merely re-anchors one level up and is
    // clipped there, so the document never grows and this branch reads green on
    // a `<main>` that lost its own anchor. The two classes are deliberately
    // redundant for the DOCUMENT invariant — the root is what stops the page
    // scrolling, `<main>` is what keeps an escapee scrolling with the content it
    // was written beside — so a teeth test that removes one proves nothing.
    const unanchored = await page.evaluate(() => {
      const main = document.getElementById('main')!;
      // The clipping root: the nearest ancestor that clips its overflow. Found
      // by walking rather than by class name, so the probe measures the box that
      // actually does the clipping.
      let clipper: HTMLElement | null = main.parentElement;
      while (clipper && getComputedStyle(clipper).overflowY !== 'hidden') {
        clipper = clipper.parentElement;
      }
      const before = { main: main.style.position, clipper: clipper?.style.position ?? '' };
      main.style.position = 'static';
      if (clipper) clipper.style.position = 'static';
      const root = document.documentElement;
      const geometry = {
        scrollHeight: root.scrollHeight,
        clientHeight: root.clientHeight,
        foundClipper: Boolean(clipper),
      };
      main.style.position = before.main;
      if (clipper) clipper.style.position = before.clipper;
      return geometry;
    });
    expect(unanchored.foundClipper, 'the walk found the shell\u2019s clipping root').toBe(true);
    expect(
      unanchored.scrollHeight,
      'with both anchors removed the SAME probe lengthens the document — the ' +
        'assertion above is measuring the fix, not a property the page has anyway',
    ).toBeGreaterThan(unanchored.clientHeight);

    // And it recovers once the injection is gone.
    await page.evaluate(() => {
      document.querySelectorAll('[data-floor-probe]').forEach((el) => el.remove());
    });
    const cleaned = await documentGeometry(page);
    expect(cleaned.scrollHeight).toBe(cleaned.clientHeight);
  });
});
