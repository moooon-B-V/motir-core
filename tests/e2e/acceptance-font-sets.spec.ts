// ACCEPTANCE: per-language font sets (Story MOTIR-7733 · Subtask MOTIR-7851).
//
// The story's verification recipe, run in a real browser against a production
// build and recorded as its receipt:
//
//   1. ja, zh and ko pages draw their script in the set's default face, and 直骨
//      take a different shape on a zh page than on a ja page;
//   2. a Polish page draws ą ę ł ś ź ż ó in the pairing's own Latin face;
//   3. under every Type pairing, a ja page draws Latin in the pairing's face and
//      kana in the ja set's face, in each of sans / serif / mono;
//   4. each page fetches only its own script's faces (fresh contexts);
//   5. an anonymous Korean browser's sign-in is Korean, in the ko face, from
//      the first byte, with no switch of script;
//   6. /tokens fetches no CJK face on arrival, and every set once Font sets is
//      scrolled into view.
//
// ⚠️ THE FILE IS NAMED `acceptance-font-sets.spec.ts`, NOT THE CARD'S
// `font-sets.spec.ts`: `playwright.acceptance.config.ts` matches
// `acceptance*.spec.ts`, and that lane is the one that records the video and
// publishes it to the story. The main lane ignores this file.
//
// ⚠️ EVERY FONT ASSERTION READS WHAT THE BROWSER DREW, never what was asked
// for. `CSS.getPlatformFontsForNode` (Chrome DevTools Protocol) lists the faces
// that actually rendered a node's glyphs, by the name in the font file; the
// network log of a FRESH context lists the files a page fetched, each attributed
// to the `@font-face` rule (and so the family) that names it. A computed
// `font-family` string only says what the stylesheet asked for, and is used here
// solely to ask the browser to load the face before it is measured.
//
// Authoritative signals: a language change waits on its server action and the
// re-rendered `<html lang>` (`saveAccountLanguageInSettings`); a pairing change
// waits on `<html data-type>`; a face waits on `document.fonts.load` + `ready`
// and is then polled through CDP. The holds in `chapter()` / `beat()` are
// pacing for the viewer, never a wait.

import type { Browser, BrowserContext, CDPSession, Locator, Page } from '@playwright/test';
import {
  FONT_SET_IDS,
  FONT_SET_REGISTRY,
  FONT_SET_ROLES,
  LOCALE_FONT_SET,
  type FontSetId,
  type FontSetMember,
  type FontSetRole,
} from '../../packages/design-system/src/theme/fontSets';
// ↑ The module's source, not the package: the package's `exports` offer only
// an ESM `import` condition, which Playwright's CommonJS loader cannot resolve.
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import {
  msg,
  saveAccountLanguageInSettings,
  seedOwnProject,
  signInHere,
  signUpHere,
  SEEDED_TITLE,
  type Locale,
} from './_helpers/i18n-walk';
import { backlogService } from '@/lib/services/backlogService';

const EMAIL = 'e2e-font-sets@example.com';
const PASSWORD = 'font-sets-e2e-9';

// ── The faces ───────────────────────────────────────────────────────────────

/**
 * Each Type pairing's Latin face per role, as `packages/design-system/theme.css`
 * composes them (`[data-type]` blocks). The family name is the one in the font
 * file, which is what CDP reports.
 */
const PAIRING_FACES: Record<string, Record<FontSetRole, string>> = {
  motir: { sans: 'Inter', serif: 'Source Serif 4', mono: 'JetBrains Mono' },
  'motir-sans': { sans: 'Inter', serif: 'Inter', mono: 'JetBrains Mono' },
  'motir-mono': { sans: 'JetBrains Mono', serif: 'JetBrains Mono', mono: 'JetBrains Mono' },
  grotesk: { sans: 'Space Grotesk', serif: 'Space Grotesk', mono: 'JetBrains Mono' },
  editorial: { sans: 'Inter', serif: 'Fraunces', mono: 'JetBrains Mono' },
  'mono-technical': { sans: 'IBM Plex Mono', serif: 'IBM Plex Mono', mono: 'IBM Plex Mono' },
};
const PAIRING_NAMES: Record<string, string> = {
  motir: 'Motir',
  'motir-sans': 'Motir Sans',
  'motir-mono': 'Motir Mono',
  grotesk: 'Grotesk',
  editorial: 'Editorial',
  'mono-technical': 'Mono-Technical',
};
const DEFAULT_PAIRING = PAIRING_FACES.motir!;
/** Every Latin face any pairing loads (every page preloads them all). */
const ALL_PAIRING_FACES = [...new Set(Object.values(PAIRING_FACES).flatMap(Object.values))];

/** A set's default face for one role, from the registry. */
function defaultFace(setId: FontSetId, role: FontSetRole): string {
  const r = FONT_SET_REGISTRY[setId].roles[role];
  const m = (r.members as readonly FontSetMember[]).find((x) => x.id === r.default);
  return m?.family ?? '';
}

/** Every face a set can load, over all its roles and members. */
function setFamilies(setId: FontSetId): string[] {
  return [
    ...new Set(
      FONT_SET_ROLES.flatMap((role) =>
        (FONT_SET_REGISTRY[setId].roles[role].members as readonly FontSetMember[])
          .map((m) => m.family)
          .filter((f): f is string => !!f),
      ),
    ),
  ];
}

const CJK_SETS = FONT_SET_IDS.filter((id) => FONT_SET_REGISTRY[id].cjk);
const ALL_CJK_FAMILIES = [...new Set(CJK_SETS.flatMap(setFamilies))];

/**
 * Does a platform font name (what CDP reports, from the font file) name this
 * family? A variable face reports its default instance (`Noto Sans JP Thin`),
 * and M PLUS Rounded 1c's file calls itself `Rounded Mplus 1c`.
 */
function isFace(platformName: string, family: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const alias: Record<string, string> = { mplusrounded1c: 'roundedmplus1c' };
  const want = norm(family);
  return norm(platformName).startsWith(alias[want] ?? want);
}

// ── Reading what the browser drew ───────────────────────────────────────────

interface PlatformFont {
  familyName: string;
  glyphCount: number;
}

let probeSeq = 0;

/** The faces that rendered `node`'s glyphs, per CDP, once its face has loaded. */
async function platformFonts(cdp: CDPSession, node: Locator): Promise<PlatformFont[]> {
  const id = `fp-${++probeSeq}`;
  await node.evaluate(async (el, probeId) => {
    el.setAttribute('data-font-probe', probeId);
    // Ask the browser to load the face for exactly this text; the measurement
    // below is CDP's, not this string's.
    // A face that fails to load rejects here; that is not this probe's verdict
    // (CDP's list below shows the fallback that drew instead), so it is swallowed.
    await document.fonts.load(getComputedStyle(el).font, el.textContent ?? '').catch(() => []);
    await document.fonts.ready;
  }, id);
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: `[data-font-probe="${id}"]`,
  });
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
  return fonts.map((f) => ({ familyName: f.familyName, glyphCount: f.glyphCount }));
}

interface Drawn {
  /** Each of these faces drew at least one glyph. */
  in: string[];
  /** Nothing else drew any (no system fallback). Defaults to `in`; `'any'` skips it. */
  only?: string[] | 'any';
  /** None of these drew a glyph. */
  never?: string[];
}

/**
 * Assert the faces that rendered `node`. Polled, because a face that finished
 * loading re-renders the node on the next frame.
 */
async function expectDrawnIn(cdp: CDPSession, node: Locator, want: Drawn): Promise<void> {
  const only = want.only === 'any' ? null : [...(want.only ?? []), ...want.in];
  const never = want.never ?? [];
  let last: PlatformFont[] = [];
  await expect
    .poll(
      async () => {
        last = await platformFonts(cdp, node);
        const names = last.map((f) => f.familyName);
        const ok =
          want.in.every((fam) => names.some((n) => isFace(n, fam))) &&
          (!only || names.every((n) => only.some((fam) => isFace(n, fam)))) &&
          !names.some((n) => never.some((fam) => isFace(n, fam)));
        // On a miss, the faces the browser used ARE the received value, so the
        // failure prints them.
        return ok ? 'as expected' : `drawn in: ${names.join(', ') || '(nothing)'}`;
      },
      {
        message: `drawn in ${want.in.join(' + ')}${only ? ` (allowed: ${only.join(', ')})` : ''}${never.length ? `, never ${never.join(', ')}` : ''}`,
        timeout: 20_000,
      },
    )
    .toBe('as expected');
  // Say what was drawn on the report, so a reviewer can read the faces too.
  test.info().annotations.push({
    type: 'drawn',
    description: last.map((f) => `${f.familyName} ×${f.glyphCount}`).join(', '),
  });
}

async function cdpFor(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  return cdp;
}

/** Add a node to `<main>` (inheriting the page's `lang`) and return it. */
async function inject(page: Page, html: string): Promise<Locator> {
  const id = `inj-${++probeSeq}`;
  await page.getByRole('main').evaluate(
    (main, { markup, probeId }) => {
      const box = document.createElement('div');
      box.setAttribute('data-injected', probeId);
      box.style.cssText =
        'padding:16px;margin:16px 0;border:1px dashed var(--el-border);color:var(--el-text)';
      box.innerHTML = markup;
      main.prepend(box);
    },
    { markup: html, probeId: id },
  );
  const box = page.locator(`[data-injected="${id}"]`);
  await box.scrollIntoViewIfNeeded();
  return box;
}

// ── Reading what the network fetched ────────────────────────────────────────

/**
 * Open `path` in a FRESH context (no font cache) carrying only `cookies`, and
 * return the family of every font file it fetched, each attributed to the
 * `@font-face` rule that names it. An unattributable file fails.
 */
async function familiesFetched(
  browser: Browser,
  cookies: Awaited<ReturnType<BrowserContext['cookies']>>,
  path: string,
  ready: (page: Page) => Promise<void>,
): Promise<string[]> {
  const context = await browser.newContext({ storageState: { cookies, origins: [] } });
  try {
    const page = await context.newPage();
    const files: string[] = [];
    page.on('request', (r) => {
      if (r.resourceType() === 'font') files.push(r.url());
    });
    await page.goto(path);
    await ready(page);
    await page.evaluate(() => document.fonts.ready);
    return attribute(page, files);
  } finally {
    await context.close();
  }
}

/** Map each fetched font file to the family of the `@font-face` rule naming it. */
async function attribute(page: Page, files: string[]): Promise<string[]> {
  const names = files.map((u) => new URL(u).pathname.split('/').pop() ?? u);
  const families = await page.evaluate((wanted) => {
    const out: Record<string, string> = {};
    for (const sheet of [...document.styleSheets]) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of [...rules]) {
        if (!(rule instanceof CSSFontFaceRule)) continue;
        const src = rule.style.getPropertyValue('src');
        for (const f of wanted) {
          if (src.includes(f)) {
            out[f] = rule.style.getPropertyValue('font-family').replace(/^["']|["']$/g, '');
          }
        }
      }
    }
    return out;
  }, names);
  const unknown = names.filter((n) => !families[n]);
  expect(unknown, 'every fetched font file is named by an @font-face rule').toEqual([]);
  return [...new Set(names.map((n) => families[n]!))];
}

/** A locale page fetched only its own set's faces (and at least one of them). */
function expectOwnFacesOnly(fetched: string[], locale: Locale): void {
  const setId = LOCALE_FONT_SET[locale as keyof typeof LOCALE_FONT_SET] as FontSetId;
  const own = FONT_SET_REGISTRY[setId].cjk ? setFamilies(setId) : [];
  const foreign = ALL_CJK_FAMILIES.filter((f) => !own.includes(f));
  expect(
    fetched.filter((f) => foreign.includes(f)),
    `${locale} fetched no other script's face`,
  ).toEqual([]);
  expect(
    fetched.filter((f) => !own.includes(f) && !ALL_PAIRING_FACES.includes(f)),
    `${locale} fetched nothing but its set and the pairing faces`,
  ).toEqual([]);
  if (own.length) {
    expect(
      fetched.some((f) => own.includes(f)),
      `${locale} fetched its own set's face`,
    ).toBe(true);
  }
}

// ── The account ─────────────────────────────────────────────────────────────

/** One work item per CJK locale, its title in that script, so its heading has glyphs to measure. */
const ITEM_TITLES = {
  ja: 'Fonts: 書体の確認',
  zh: 'Fonts: 字体检查',
  ko: 'Fonts: 글꼴 확인',
} as const;
const itemKeys: Partial<Record<keyof typeof ITEM_TITLES, string>> = {};

test.beforeAll(async ({ browser }) => {
  await resetDatabase();
  const context = await browser.newContext({ locale: 'en-US' });
  await signUpHere(await context.newPage(), EMAIL, PASSWORD);
  await context.close();
  await seedOwnProject(EMAIL);

  // Work content is user data; these three titles exist only to put each
  // script on a work item page's heading.
  const user = await adminDb.user.findUniqueOrThrow({ where: { email: EMAIL } });
  const membership = await adminDb.workspaceMembership.findFirstOrThrow({
    where: { userId: user.id },
  });
  const ctx = { userId: user.id, workspaceId: membership.workspaceId };
  for (const [locale, title] of Object.entries(ITEM_TITLES) as [
    keyof typeof ITEM_TITLES,
    string,
  ][]) {
    const item = await backlogService.createBacklogIssue(
      membership.activeProjectId!,
      { kind: 'task', title },
      ctx,
    );
    itemKeys[locale] = item.identifier;
  }
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

/**
 * Save the account's language through Settings → Language. The tests share one
 * account, so it may already be `locale` (the helper re-picks a language the
 * page already shows only for a non-English one).
 */
async function setAccountLanguage(page: Page, locale: Locale): Promise<void> {
  await page.goto('/settings/account/language');
  if ((await page.locator('html').getAttribute('lang')) === locale) return;
  await saveAccountLanguageInSettings(page, locale);
}

/** The board's heading, once the board has loaded its seeded card. */
async function openBoard(page: Page, locale: Locale): Promise<Locator> {
  await page.goto('/boards');
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  const heading = page.getByRole('main').getByRole('heading', { level: 1 });
  await expect(heading).toHaveText(msg(locale, 'boards.heading'), { timeout: FIRST_PAINT_MS });
  await expect(
    page.getByRole('main').getByText(SEEDED_TITLE, { exact: true }).first(),
  ).toBeVisible();
  return heading;
}

// ── 1 + 4 ───────────────────────────────────────────────────────────────────

test.describe('ja, zh and ko pages', () => {
  test.use({ locale: 'en-US' });

  test('each CJK page draws its script in its own set, and fetches only that set', async ({
    page,
    browser,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7733');
    test.setTimeout(240_000);
    const cdp = await cdpFor(page);
    const regionShots: Partial<Record<'ja' | 'zh', Buffer>> = {};

    await chapter('Signed in, in English', async () => {
      await signInHere(page, EMAIL, PASSWORD);
    });

    for (const locale of ['ja', 'zh', 'ko'] as const) {
      const setId = LOCALE_FONT_SET[locale] as FontSetId;
      const sans = defaultFace(setId, 'sans');
      const serif = defaultFace(setId, 'serif');

      await chapter(
        `${locale}: the board and a work item in ${serif}, 直骨 in ${sans}`,
        async () => {
          await setAccountLanguage(page, locale);

          const board = await openBoard(page, locale);
          // The app sets its headings in the serif role (`font-serif`).
          await expectDrawnIn(cdp, board, { in: [serif], only: [DEFAULT_PAIRING.serif] });

          await page.goto(`/items/${itemKeys[locale]}`);
          const title = page.getByRole('main').getByRole('heading', { level: 1 });
          await expect(title).toHaveText(ITEM_TITLES[locale], { timeout: FIRST_PAINT_MS });
          await expectDrawnIn(cdp, title, { in: [serif, DEFAULT_PAIRING.serif] });

          if (locale !== 'ko') {
            // Region forms: the same two code points, drawn by the page's own set.
            const glyphs = (await inject(page, '<span style="font-size:96px">直骨</span>')).locator(
              'span',
            );
            await expectDrawnIn(cdp, glyphs, { in: [sans] });
            regionShots[locale] = await glyphs.screenshot();
          }
          await beat();
        },
      );

      await chapter(`${locale}: a fresh browser fetches only the ${locale} faces`, async () => {
        const fetched = await familiesFetched(
          browser,
          await page.context().cookies(),
          '/boards',
          (p) => openBoard(p, locale).then(() => undefined),
        );
        expectOwnFacesOnly(fetched, locale);
        test
          .info()
          .annotations.push({ type: `fetched (${locale})`, description: fetched.join(', ') });
      });
    }

    expect(regionShots.zh, 'the zh 直骨 was captured').toBeDefined();
    expect(regionShots.ja, 'the ja 直骨 was captured').toBeDefined();
    expect(regionShots.zh!.equals(regionShots.ja!), '直骨 differ between zh and ja').toBe(false);
  });
});

// ── 2 + 4 (English) ─────────────────────────────────────────────────────────

test.describe('Latin pages', () => {
  test.use({ locale: 'en-US' });

  test('English fetches no CJK face, and Polish accents stay in the pairing face', async ({
    page,
    browser,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7733');
    test.setTimeout(150_000);
    const cdp = await cdpFor(page);

    await chapter('An English board fetches no CJK face', async () => {
      await signInHere(page, EMAIL, PASSWORD);
      await setAccountLanguage(page, 'en');
      await openBoard(page, 'en');
      const fetched = await familiesFetched(
        browser,
        await page.context().cookies(),
        '/boards',
        (p) => openBoard(p, 'en').then(() => undefined),
      );
      expectOwnFacesOnly(fetched, 'en');
      test.info().annotations.push({ type: 'fetched (en)', description: fetched.join(', ') });
    });

    await chapter('Polish: ą ę ł ś ź ż ó in Inter, with no fallback', async () => {
      await setAccountLanguage(page, 'pl');
      // Shipped copy first: the Language pane's subtitle carries ę ł ż ó.
      const subtitle = page
        .getByRole('main')
        .getByText(msg('pl', 'settings.language.subtitle'), { exact: true });
      await expect(subtitle).toBeVisible();
      await expectDrawnIn(cdp, subtitle, { in: [DEFAULT_PAIRING.sans] });
      // No single string on a reachable surface carries all seven letters, so
      // the pangram is injected — the one injected node in this test.
      const pangram = (
        await inject(page, '<p style="font-size:32px">Zażółć gęślą jaźń · ĄĘŁŚŹŻÓ</p>')
      ).locator('p');
      await expectDrawnIn(cdp, pangram, { in: [DEFAULT_PAIRING.sans] });
      await beat();
    });
  });
});

// ── 3 ───────────────────────────────────────────────────────────────────────

test.describe('every pairing on a ja page', () => {
  test.use({ locale: 'en-US' });

  test('Latin in the pairing face, kana in the ja set, in every role', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7733');
    test.setTimeout(240_000);
    const cdp = await cdpFor(page);

    await chapter('Signed in, in Japanese, on Appearance', async () => {
      await signInHere(page, EMAIL, PASSWORD);
      await setAccountLanguage(page, 'ja');
      await page.goto('/settings/account/appearance');
      await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    });

    const picker = page.getByRole('radiogroup', {
      name: msg('ja', 'settings.appearance.type.name'),
      exact: true,
    });
    // Two pairings are paced for the camera; the other four run at speed.
    const onCamera = new Set(['motir', 'editorial']);

    for (const typeId of Object.keys(PAIRING_FACES)) {
      const body = async () => {
        await picker.getByRole('radio', { name: PAIRING_NAMES[typeId], exact: true }).click();
        await expect(page.locator('html')).toHaveAttribute('data-type', typeId);
        const probe = await inject(
          page,
          FONT_SET_ROLES.map(
            (role) =>
              `<div data-role="${role}" style="font-family:var(--font-${role});font-size:24px">` +
              `<span data-run="latin">${role} Hamburgefonstiv</span> ` +
              `<span data-run="ja">いろはにほへと</span></div>`,
          ).join(''),
        );
        for (const role of FONT_SET_ROLES) {
          const row = probe.locator(`[data-role="${role}"]`);
          await expectDrawnIn(cdp, row.locator('[data-run="latin"]'), {
            in: [PAIRING_FACES[typeId]![role]],
          });
          await expectDrawnIn(cdp, row.locator('[data-run="ja"]'), {
            in: [defaultFace('ja', role)],
          });
        }
        if (onCamera.has(typeId)) await beat();
        await probe.evaluate((el) => el.remove());
      };
      if (onCamera.has(typeId)) await chapter(`${PAIRING_NAMES[typeId]} on a ja page`, body);
      else await body();
    }
  });
});

// ── 5 ───────────────────────────────────────────────────────────────────────

test.describe('an anonymous Korean browser', () => {
  test.use({ locale: 'ko-KR' });

  test('the sign-in page is Korean, in the ko face, from the first byte', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7733');
    const cdp = await cdpFor(page);
    // Record every change to <html lang>, from the first script on.
    await page.addInitScript(() => {
      const w = window as unknown as { __langChanges: string[] };
      w.__langChanges = [];
      // `document`, not `<html>`: an init script runs before `<html>` exists.
      new MutationObserver((records) => {
        for (const r of records) {
          if (r.target === document.documentElement)
            w.__langChanges.push(document.documentElement.lang);
        }
      }).observe(document, { attributes: true, subtree: true, attributeFilter: ['lang'] });
    });

    await chapter('A Korean browser opens the sign-in page', async () => {
      expect(await page.context().cookies(), 'nothing chosen, nothing saved').toEqual([]);
      const response = await page.goto('/sign-in', { waitUntil: 'domcontentloaded' });
      const html = (await response!.text()).match(/<html[^>]*>/)?.[0] ?? '';
      expect(html, 'the server sent lang="ko"').toMatch(/\slang="ko"/);
      await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
      await beat();

      const headline = page.getByRole('main').getByRole('heading', { level: 1 });
      await expect(headline).toHaveText(msg('ko', 'auth.welcomeBack'), { timeout: FIRST_PAINT_MS });
      const ko = FONT_SET_ROLES.map((r) => defaultFace('ko', r));
      await expectDrawnIn(cdp, headline, {
        in: [defaultFace('ko', 'serif')],
        only: [...ko, ...ALL_PAIRING_FACES],
      });
      expect(
        await page.evaluate(() => (window as unknown as { __langChanges: string[] }).__langChanges),
        'the page never switched language after the server rendered it',
      ).toEqual([]);
      await beat();
    });

    await chapter('The sign-in form reads in Korean, in the ko sans face', async () => {
      const button = page
        .getByRole('main')
        .getByRole('button', { name: msg('ko', 'auth.continue'), exact: true });
      await expect(button).toBeVisible();
      await expectDrawnIn(cdp, button, {
        in: [defaultFace('ko', 'sans')],
        only: [...FONT_SET_ROLES.map((r) => defaultFace('ko', r)), ...ALL_PAIRING_FACES],
      });
      await beat();
    });
  });
});

// ── 6 ───────────────────────────────────────────────────────────────────────

test.describe('/tokens', () => {
  test.use({ locale: 'en-US' });

  test('Font sets fetch nothing until they are on screen, then every set', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7733');
    test.setTimeout(150_000);
    const cdp = await cdpFor(page);
    const files: string[] = [];
    page.on('request', (r) => {
      if (r.resourceType() === 'font') files.push(r.url());
    });
    const section = page.locator('#font-sets');

    await chapter('/tokens on arrival: no CJK face fetched, no CJK glyph drawn', async () => {
      await page.goto('/tokens');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      // The section is in the page (its mounted state is what the checks
      // below judge, by what was fetched and drawn, not by this attribute).
      await expect(page.locator('[data-font-sets-mounted]')).toBeAttached({
        timeout: FIRST_PAINT_MS,
      });
      await page.evaluate(() => document.fonts.ready);
      const arrived = await attribute(page, files);
      expect(
        arrived.filter((f) => ALL_CJK_FAMILIES.includes(f)),
        'no CJK face on arrival',
      ).toEqual([]);
      expect(
        await page.evaluate(() => /[぀-鿿가-힯]/.test(document.body.innerText)),
        'no CJK glyph in the page before Font sets is on screen',
      ).toBe(false);
      await beat();
    });

    await chapter('Scrolled to Font sets: every set fetched, every member drawn', async () => {
      await section.scrollIntoViewIfNeeded();
      await expect(page.locator('[data-font-sets-mounted="true"]')).toBeAttached();
      // The request log is the signal: every CJK face is eventually fetched.
      await expect
        .poll(async () => {
          const fetched = await attribute(page, files);
          return ALL_CJK_FAMILIES.filter((f) => !fetched.includes(f));
        })
        .toEqual([]);

      for (const setId of CJK_SETS) {
        for (const role of FONT_SET_ROLES) {
          for (const m of FONT_SET_REGISTRY[setId].roles[role]
            .members as readonly FontSetMember[]) {
            const sample = page.locator(
              `[data-font-set-member="${setId}/${role}/${m.id}"] [data-font-set-sample]`,
            );
            const def = FONT_SET_REGISTRY[setId].roles[role].default;
            // A default draws in itself alone. A non-default member draws in
            // itself and never in the default, whatever its own face lacks.
            await expectDrawnIn(
              cdp,
              sample,
              m.id === def
                ? { in: [m.family!], only: ALL_PAIRING_FACES }
                : { in: [m.family!], only: 'any', never: [defaultFace(setId, role)] },
            );
          }
        }
      }
      await beat();
    });

    await chapter('Region forms in the three defaults; a member applied by name', async () => {
      await page.locator('[data-font-set-region]').first().scrollIntoViewIfNeeded();
      for (const setId of ['zh-Hans', 'ja', 'ko'] as const) {
        const glyphs = page.locator(`[data-font-set-region="${setId}"] > div:first-child`);
        await expectDrawnIn(cdp, glyphs, {
          in: [defaultFace(setId, 'sans')],
          only: ALL_PAIRING_FACES,
        });
      }
      const byName = page.locator('[data-font-set-apply-by-name]');
      await byName.scrollIntoViewIfNeeded();
      const member = (FONT_SET_REGISTRY.ja.roles.sans.members as readonly FontSetMember[]).find(
        (m) => m.id === 'm-plus-rounded-1c',
      )!;
      // Its member, never the role's default. (Glyphs the member's face lacks fall
      // to the generic, which is the composition's documented chain, so no
      // `only` here.)
      await expectDrawnIn(cdp, byName, {
        in: [member.family!],
        only: 'any',
        never: [defaultFace('ja', 'sans')],
      });
      await beat();
    });
  });
});
