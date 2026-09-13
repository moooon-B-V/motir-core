import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import {
  WORKBENCH_TABS,
  parseWorkbenchTab,
  workbenchTabHref,
  type WorkbenchTab,
} from '@/lib/workbench/tab';
import { resolveWorkbenchLanding } from '@/lib/workbench/landing';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';

// THE STORY'S CONTRACT GUARDS (Story MOTIR-5213 · MOTIR-5219) — the invariants a
// coverage percentage cannot see, asserted over the ASSEMBLED story.
//
// Each guard names the mutation it exists to catch. The two maps that live
// unexported inside their modules (`TAB_PARAM` in `lib/workbench/tab.ts`,
// `TAB_LABEL_KEY` in the page) are reached the way the product reaches them —
// through the builder, and through the page's own source — because this card
// modifies no production file, and exporting a constant only so a test can read
// it would be exactly that.

const ROOT = resolve(__dirname, '..', '..');

/**
 * Every member of the `WorkbenchTab` union, as a TYPE-CHECKED record: a sixth tab
 * added to the union without a key here is a compile error, and the runtime
 * assertion below then catches it missing from `WORKBENCH_TABS`.
 */
const EVERY_TAB: Readonly<Record<WorkbenchTab, true>> = {
  approvals: true,
  'in-progress': true,
  todo: true,
  finished: true,
  watching: true,
};
const UNION = Object.keys(EVERY_TAB) as WorkbenchTab[];

type Catalog = Record<string, unknown>;
function lookup(catalog: Catalog, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>((node, key) => (node as Catalog | undefined)?.[key], catalog);
}

describe('GUARD · every tab is addressable, and no tab is spelled as the bare path', () => {
  it('WORKBENCH_TABS is TOTAL over the union — no tab missing, none duplicated', () => {
    // Catches: a tab added to the union but not to the strip's enumeration.
    expect([...WORKBENCH_TABS].sort()).toEqual([...UNION].sort());
    expect(new Set(WORKBENCH_TABS).size).toBe(WORKBENCH_TABS.length);
  });

  it('NO tab has a null param: every href carries a non-empty `?tab=`', () => {
    // Catches: `TAB_PARAM` regaining a `null` entry — the retired paramless
    // default. The type forbids it; this asserts the VALUE, because a type is
    // erased and every shared link depends on the value.
    for (const tab of UNION) {
      const url = new URL(workbenchTabHref(tab), 'https://motir.test');
      expect(url.pathname).toBe(AUTHED_LANDING_PATH);
      expect(url.searchParams.get('tab'), `${tab} has no param`).toBeTruthy();
      expect(workbenchTabHref(tab), `${tab} is spelled as the bare path`).not.toBe(
        AUTHED_LANDING_PATH,
      );
    }
  });

  it('ONE address per tab: five distinct hrefs, each parsing back to its own tab', () => {
    // Catches: two tabs sharing a slug, or a slug that does not round-trip — the
    // property that makes an address shareable.
    const hrefs = UNION.map((tab) => workbenchTabHref(tab));
    expect(new Set(hrefs).size).toBe(UNION.length);
    for (const tab of UNION) {
      const param = new URL(workbenchTabHref(tab), 'https://motir.test').searchParams.get('tab');
      expect(parseWorkbenchTab(param ?? undefined), `${tab} does not round-trip`).toBe(tab);
    }
  });
});

describe('GUARD · every tab has a label, in `en` AND `zh`', () => {
  const pageSource = readFileSync(join(ROOT, 'app', '(authed)', 'workbench', 'page.tsx'), 'utf8');
  const stripSource = readFileSync(
    join(ROOT, 'app', '(authed)', 'workbench', '_components', 'WorkbenchTabs.tsx'),
    'utf8',
  );

  /** The page's `TAB_LABEL_KEY` record, read from its source. */
  function tabLabelKeys(source: string): Record<string, string> {
    const block = /const TAB_LABEL_KEY[^=]*=\s*\{([\s\S]*?)\};/.exec(source);
    if (!block) throw new Error('TAB_LABEL_KEY not found — the guard is reading the wrong file');
    return Object.fromEntries(
      [...block[1]!.matchAll(/['"]?([a-z-]+)['"]?\s*:\s*'([^']+)'/g)].map((m) => [m[1]!, m[2]!]),
    );
  }

  it('reads the record it guards — the parser is not vacuous', () => {
    // Catches: this guard silently matching nothing after a refactor renames the
    // constant, which would pass every assertion below.
    expect(tabLabelKeys(`const TAB_LABEL_KEY: X = {\n  todo: 'tabs.toDo',\n};`)).toEqual({
      todo: 'tabs.toDo',
    });
    expect(Object.keys(tabLabelKeys(pageSource)).length).toBeGreaterThan(0);
  });

  it('TAB_LABEL_KEY is TOTAL over the union', () => {
    // Catches: a sixth tab rendering a list with a blank or missing label.
    expect(Object.keys(tabLabelKeys(pageSource)).sort()).toEqual([...UNION].sort());
  });

  it('every label key the page and the strip use resolves in BOTH catalogs', () => {
    // Catches: a missing `zh` twin — a shipped English string on a localized
    // surface, or a raw key on either.
    const pageKeys = Object.values(tabLabelKeys(pageSource));
    const stripKeys = [...stripSource.matchAll(/t\('(tabs\.[A-Za-z]+)'\)/g)].map((m) => m[1]!);
    expect(stripKeys.length).toBeGreaterThanOrEqual(UNION.length);
    for (const key of new Set([...pageKeys, ...stripKeys])) {
      for (const [locale, catalog] of [
        ['en', en],
        ['zh', zh],
      ] as const) {
        const value = lookup(catalog as Catalog, `workbench.${key}`);
        expect(typeof value === 'string' && value.length > 0, `${locale}: workbench.${key}`).toBe(
          true,
        );
      }
    }
  });

  it('every `workbench.tabs.*` key exists in both catalogs', () => {
    const enTabs = Object.keys((en as Catalog as { workbench: { tabs: Catalog } }).workbench.tabs);
    const zhTabs = Object.keys((zh as Catalog as { workbench: { tabs: Catalog } }).workbench.tabs);
    expect(zhTabs.sort()).toEqual(enTabs.sort());
  });
});

describe('GUARD · the cascade is TOTAL, and its order is its own', () => {
  const SAMPLES = [0, 1, 2, 7, 1_000];

  it('resolves to one of its three rungs for EVERY point of the count space', () => {
    // Catches: an input for which the resolver returns nothing, or lands on a tab
    // that is not a rung. A property over the space, not three listed cases.
    const rungs = new Set(['approvals', 'in-progress', 'todo']);
    for (const approvals of SAMPLES)
      for (const inProgress of SAMPLES)
        for (const toDo of SAMPLES) {
          const landed = resolveWorkbenchLanding({ approvals, inProgress, toDo });
          expect(rungs.has(landed), `${approvals}/${inProgress}/${toDo} → ${landed}`).toBe(true);
        }
  });

  it('the CASCADE order is To approve → In progress → To do, derived from the resolver', () => {
    // Derived by probing, never read off `WORKBENCH_TABS`: a rung wins when it and
    // every rung after it are non-zero.
    const all = { approvals: 1, inProgress: 1, toDo: 1 };
    const order = [
      resolveWorkbenchLanding(all),
      resolveWorkbenchLanding({ ...all, approvals: 0 }),
      resolveWorkbenchLanding({ ...all, approvals: 0, inProgress: 0 }),
    ];
    expect(order).toEqual(['approvals', 'in-progress', 'todo']);
  });

  it('the STRIP order is asserted separately, from `WORKBENCH_TABS`', () => {
    // Two facts that agree today — the strip leads with the cascade's rungs — are
    // held as two assertions, so neither can silently start being computed from
    // the other.
    expect(WORKBENCH_TABS).toEqual(['approvals', 'in-progress', 'todo', 'finished', 'watching']);
  });
});
