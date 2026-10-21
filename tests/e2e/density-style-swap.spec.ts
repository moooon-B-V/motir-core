// E2E: switching the STYLE reshapes the own-box PADDING / HEIGHT of real swept
// surfaces, and the default style renders its pre-sweep values (MOTIR-8911, the
// story proof for MOTIR-2335's density axis).
//
// `tests/theme/densityScale.test.ts` pins the 21 derived steps' arithmetic,
// `tests/theme/shapeSwapLint.test.ts` pins the class names, and
// `tests/e2e/density-nested-scope.spec.ts` shows a step re-resolving on a PROBE in
// a nested scope. None of them can see a step failing to resolve on a RENDERED
// swept component, which is what this file reads: computed lengths off the
// `/tokens` page's own surfaces.
//
// ⚠️ THE ORACLE IS THE STYLESHEET, never a typed table. Case A compares each
// surface with a probe element in the SAME style that puts the named step (or
// base) token on `padding-left` / `padding-top` / `height`. The only px literals
// in this file are inside `CHANGED` (and the baseline JSON it is compared with).
//
// Surfaces are the `/tokens` style vignette's own elements plus one Sidebar row —
// all rendered by swept code, all reachable without adding a test-id. The live
// vignette follows `<html data-style>`; the gallery tiles are scoped
// (`.style-vignette[data-style=…]`), which is case C's nested scope.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

const CAPTURE = process.env['DENSITY_CAPTURE'] === '1';
const BASELINE_PATH = join(__dirname, 'fixtures', 'density-pre-sweep-baseline.json');

/** `name` is the accessible name of the `/tokens` Style control button. */
const STYLES: ReadonlyArray<readonly [id: string, name: string]> = [
  ['warm-editorial', 'Warm Editorial'],
  ['soft-playful', 'Soft / Playful'],
  ['swiss-minimal-flat', 'Swiss / Minimal-Flat'],
  ['neo-brutalism', 'Neo-Brutalism'],
] as const;
const NAMES: Record<string, string> = Object.fromEntries(STYLES);

/** Drive `<html data-style>` through the page's OWN Style control, never by injecting it. */
async function setStyle(page: Page, id: string): Promise<void> {
  await page.getByRole('button', { name: NAMES[id], exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-style', id);
}

type Prop = 'paddingLeft' | 'paddingTop' | 'height' | 'minHeight';
/** The property a probe puts the token on: min-height is oracled through `height`. */
const PROBE_PROP: Record<Prop, 'padding-left' | 'padding-top' | 'height'> = {
  paddingLeft: 'padding-left',
  paddingTop: 'padding-top',
  height: 'height',
  minHeight: 'height',
};

/** The computed box of one element: the three lengths the density axis owns. */
async function readBox(locator: Locator): Promise<Record<Prop, string>> {
  return locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      paddingLeft: cs.paddingLeft,
      paddingTop: cs.paddingTop,
      height: cs.height,
      minHeight: cs.minHeight,
    };
  });
}

/**
 * What the stylesheet says `token` is, in the style the page currently wears: a
 * probe under <body> puts `var(token)` on a real property and reads it back.
 * (An unregistered custom property's computed value is the unresolved string.)
 */
async function ladderValueFor(
  page: Page,
  token: string,
  prop: 'padding-left' | 'padding-top' | 'height',
): Promise<string> {
  return page.evaluate(
    ({ token: t, prop: p }) => {
      const probe = document.createElement('div');
      probe.style.setProperty(p, `var(${t})`);
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).getPropertyValue(p);
      probe.remove();
      return value;
    },
    { token, prop },
  );
}

interface Measure {
  prop: Prop;
  /** The step or base token the surface is written against. */
  token: string;
  /** The density family the token belongs to. */
  family: string;
}
interface Surface {
  key: string;
  /** Where to find it. `scope` is a vignette root, or the page for a page-level surface. */
  find: (scope: Locator) => Locator;
  measures: Measure[];
}

/** Surfaces inside a `StyleVignette` root (live or a scoped tile). */
const VIGNETTE_SURFACES: Surface[] = [
  {
    key: 'modalPanel',
    find: (s) => s.locator('[data-surface="modal"]'),
    measures: [
      { prop: 'paddingLeft', token: '--spacing-card-padding-12', family: 'card-padding' },
      { prop: 'paddingTop', token: '--spacing-card-padding-12', family: 'card-padding' },
    ],
  },
  {
    key: 'navRow',
    find: (s) => s.locator('[data-surface="sidebar"]'),
    measures: [
      { prop: 'paddingLeft', token: '--spacing-control-x-12', family: 'control-x' },
      { prop: 'paddingTop', token: '--spacing-control-y-8', family: 'control-y' },
    ],
  },
  {
    key: 'accentChip',
    find: (s) => s.getByText('Board', { exact: true }),
    measures: [
      { prop: 'paddingLeft', token: '--spacing-control-x-8', family: 'control-x' },
      { prop: 'paddingTop', token: '--spacing-control-y-2', family: 'control-y' },
    ],
  },
  {
    key: 'listChip',
    find: (s) => s.getByText('Done', { exact: true }),
    measures: [
      { prop: 'paddingLeft', token: '--spacing-chip-x', family: 'chip-x' },
      { prop: 'paddingTop', token: '--spacing-chip-y', family: 'chip-y' },
    ],
  },
];

/** A page-level swept surface: the first row of the Sidebar specimen (min-height = the base). */
const PAGE_SURFACES: Surface[] = [
  {
    key: 'sidebarItem',
    find: (page) => page.locator('a[href="#dashboard"]').first(),
    measures: [
      { prop: 'paddingLeft', token: '--spacing-control-x', family: 'control-x' },
      { prop: 'paddingTop', token: '--spacing-control-y', family: 'control-y' },
      { prop: 'minHeight', token: '--height-control', family: 'height-control' },
    ],
  },
];

const liveVignette = (page: Page): Locator => page.locator('[aria-label^="Live preview"]');
const tile = (page: Page, id: string): Locator =>
  page.locator(`.style-vignette[data-style="${id}"]`);

interface Reading {
  /** `surface.prop` → the computed value on the element. */
  actual: Record<string, string>;
  /** `surface.prop` → what a probe reads for that token in the same style. */
  expected: Record<string, string>;
  /** `surface.prop` → family, for the families-that-differ assertion. */
  family: Record<string, string>;
}

async function readSurfaces(
  page: Page,
  list: Surface[],
  scope: Locator,
  reading: Reading,
): Promise<void> {
  for (const surface of list) {
    const box = await readBox(surface.find(scope).first());
    for (const m of surface.measures) {
      const k = `${surface.key}.${m.prop}`;
      reading.actual[k] = box[m.prop];
      reading.expected[k] = await ladderValueFor(page, m.token, PROBE_PROP[m.prop]);
      reading.family[k] = m.family;
    }
  }
}

async function readLive(page: Page): Promise<Reading> {
  const reading: Reading = { actual: {}, expected: {}, family: {} };
  await readSurfaces(page, VIGNETTE_SURFACES, liveVignette(page), reading);
  await readSurfaces(page, PAGE_SURFACES, page.locator('body'), reading);
  return reading;
}

async function open(page: Page): Promise<void> {
  await page.goto('/tokens');
  await expect(liveVignette(page)).toBeVisible();
  await expect(page.locator('a[href="#dashboard"]').first()).toBeVisible();
}

/**
 * Keys whose pre-sweep value differs from today's in `warm-editorial`, each
 * named by the sweep that moved it. Exactly asserted in both directions: a new
 * mismatch fails, and an entry that no longer mismatches fails.
 */
const CHANGED: Record<string, { old: string; new: string; pr: string }> = {
  'accentChip.paddingTop': {
    old: '3px',
    new: '2px',
    pr: 'moooon-B-V/motir-core#3659 (MOTIR-8904: py-[3px] -> --spacing-control-y-2)',
  },
};

test.describe('capture the pre-sweep baseline', () => {
  test.skip(!CAPTURE, 'set DENSITY_CAPTURE=1 on a checkout where no sweep has merged');

  test('write tests/e2e/fixtures/density-pre-sweep-baseline.json', async ({ page }) => {
    await open(page);
    await setStyle(page, 'warm-editorial');
    const { actual } = await readLive(page);
    const commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(
        {
          _meta: {
            commit,
            command:
              'DENSITY_CAPTURE=1 pnpm exec playwright test tests/e2e/density-style-swap.spec.ts',
            capturedOn: new Date().toISOString().slice(0, 10),
            style: 'warm-editorial',
          },
          values: actual,
        },
        null,
        2,
      )}\n`,
    );
  });
});

test.describe('density: switching the style reshapes real surfaces', () => {
  test.skip(CAPTURE, 'capture mode runs only the baseline writer');

  for (const [id] of STYLES) {
    test(`A. under ${id} every surface equals its stylesheet step`, async ({ page }) => {
      await open(page);
      await setStyle(page, id);
      const { actual, expected } = await readLive(page);
      expect(actual).toEqual(expected);
    });
  }

  test('A. every family is covered, and the swap reshapes each of them', async ({ page }) => {
    await open(page);
    await setStyle(page, 'warm-editorial');
    const warm = await readLive(page);
    await setStyle(page, 'soft-playful');
    const soft = await readLive(page);

    const families = new Set(Object.values(warm.family));
    expect([...families].sort()).toEqual(
      ['card-padding', 'chip-x', 'chip-y', 'control-x', 'control-y', 'height-control'].sort(),
    );
    const differing = new Set(
      Object.keys(warm.actual)
        .filter((k) => warm.actual[k] !== soft.actual[k])
        .map((k) => warm.family[k]!),
    );
    // Every family differs, so an element that silently fell back to a raw
    // literal would drop its family from this list and fail here by name.
    expect([...differing].sort()).toEqual([...families].sort());
  });

  test('B. warm-editorial renders its pre-sweep values, except the swept ones', async ({
    page,
  }) => {
    await open(page);
    await setStyle(page, 'warm-editorial');
    const { actual } = await readLive(page);
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as {
      _meta: Record<string, string>;
      values: Record<string, string>;
    };
    expect(Object.keys(actual).sort()).toEqual(Object.keys(baseline.values).sort());
    const mismatching = Object.keys(actual)
      .filter((k) => actual[k] !== baseline.values[k])
      .sort();
    expect(mismatching).toEqual(Object.keys(CHANGED).sort());
    for (const [k, c] of Object.entries(CHANGED)) {
      expect({ key: k, old: baseline.values[k], now: actual[k] }).toEqual({
        key: k,
        old: c.old,
        now: c.new,
      });
      expect(c.pr).not.toBe('');
    }
  });

  test('C. a scoped tile computes its OWN style under a warm-editorial root', async ({ page }) => {
    await open(page);
    const scoped = STYLES.map(([id]) => id).filter((id) => id !== 'warm-editorial');

    // Truth: the live vignette's reading while <html> carries the tile's style.
    const truth = new Map<string, Record<string, string>>();
    for (const id of scoped) {
      await setStyle(page, id);
      const reading: Reading = { actual: {}, expected: {}, family: {} };
      await readSurfaces(page, VIGNETTE_SURFACES, liveVignette(page), reading);
      truth.set(id, reading.actual);
    }

    await setStyle(page, 'warm-editorial');
    const warm: Reading = { actual: {}, expected: {}, family: {} };
    await readSurfaces(page, VIGNETTE_SURFACES, liveVignette(page), warm);

    for (const id of scoped) {
      const got: Reading = { actual: {}, expected: {}, family: {} };
      await readSurfaces(page, VIGNETTE_SURFACES, tile(page, id), got);
      expect(got.actual, `tile ${id} under a warm-editorial root`).toEqual(truth.get(id));
    }
    // Not vacuous: soft-playful's tile really differs from the root's style.
    const soft: Reading = { actual: {}, expected: {}, family: {} };
    await readSurfaces(page, VIGNETTE_SURFACES, tile(page, 'soft-playful'), soft);
    expect(soft.actual).not.toEqual(warm.actual);
  });
});
