import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PALETTE_IDS, type PaletteId } from '../src/theme/palettes';
import { TYPE_IDS, type TypeId } from '../src/theme/typography';
import { STYLE_IDS } from '../src/theme/styles';
import { StyleVignette } from '../src/components/theme/StyleVignette';

/*
 * MOTIR-3933 — a SCOPED preview must resolve its OWN axis values, not the
 * active ones.
 *
 * ⚠️ THIS TEST RUNS IN A REAL BROWSER, and that is the point rather than an
 * indulgence. The defect it covers is a CASCADE fact: `--el-*` reference
 * `--color-*` and `var()` resolves at the DECLARING element, so whether a
 * nested `data-palette` changes anything depends on where the Tier-3 layer was
 * declared. Nothing short of a cascade can answer that. The version of this
 * bug that shipped was invisible to every assertion the package could make
 * about MARKUP — the attributes were all present and correct, and the rendered
 * result was still the ancestor's palette.
 *
 * ⚠️ AND THE ORACLE IS THE SAME STYLESHEET, not a table of expected hexes. For
 * each axis value, TRUTH is what that value resolves to when it is the ACTIVE
 * one on `<html>` — measured first, in the same browser, from the same file.
 * A hard-coded expectation would have to be re-typed every time a palette is
 * tuned, and the first person to skip that turns this into a test of a stale
 * table. Comparing scoped-against-active also states the requirement exactly:
 * a preview is correct when it looks like the thing it is previewing.
 */

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * Tailwind v4's `@theme` declares its custom properties on `:root`, but a
 * browser skips the unknown at-rule, so it is renamed for the fixture. Nothing
 * else is touched — every selector under test is loaded exactly as it ships.
 */
const THEME_CSS = readFileSync(join(PKG_ROOT, 'theme.css'), 'utf8').replace('@theme {', ':root {');

/** The colour tokens a `[data-palette]` block is responsible for re-skinning. */
const PALETTE_PROBE = [
  '--el-accent',
  '--el-page-bg',
  '--el-surface',
  '--el-text',
  '--el-border',
  // ⚠️ The last three are deliberately tokens that NOT every `[data-palette]`
  // block declares. They are the ones that would leak if `data-appearance-scope`
  // were not re-emitting the Tier-3 layer — a probe made only of tokens every
  // palette overrides would pass with the scope attribute removed.
  '--el-status-blocked',
  '--el-status-planning',
  '--el-priority-high',
] as const;

/** The three role tokens a `[data-type]` block re-points. */
const TYPE_PROBE = ['--font-sans', '--font-serif', '--font-mono'] as const;

type Probe = readonly string[];
type Resolved = Record<string, string>;

let browser: Browser;
let page: Awaited<ReturnType<Awaited<ReturnType<Browser['newContext']>>['newPage']>>;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();

  // The fixture is the SHIPPED component, server-rendered, one scoped instance
  // per registry entry — so the attributes under test are the ones the
  // component actually emits rather than ones the test wrote for it.
  const tiles = [
    ...PALETTE_IDS.map((id) =>
      renderToStaticMarkup(<StyleVignette palette={id} label={`p:${id}`} />).replace(
        '<div ',
        `<div data-probe="palette:${id}" `,
      ),
    ),
    ...TYPE_IDS.map((id) =>
      renderToStaticMarkup(<StyleVignette type={id} label={`t:${id}`} />).replace(
        '<div ',
        `<div data-probe="type:${id}" `,
      ),
    ),
    // LIVE mode — no axis prop. It must NOT carry the scope attribute.
    renderToStaticMarkup(<StyleVignette label="live" />).replace(
      '<div ',
      '<div data-probe="live" ',
    ),
  ].join('\n');

  await page.setContent(
    `<!doctype html><html><head><style>${THEME_CSS}</style></head><body>${tiles}</body></html>`,
  );
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

/** What `<html>` resolves when it carries this axis value itself — the oracle. */
async function truthFor(
  axis: 'palette' | 'type',
  id: string,
  theme: 'light' | 'dark',
  probe: Probe,
): Promise<Resolved> {
  return page.evaluate(
    ({ axis, id, theme, probe }) => {
      const html = document.documentElement;
      html.setAttribute('data-theme', theme);
      html.setAttribute(`data-${axis}`, id);
      const cs = getComputedStyle(html);
      return Object.fromEntries(probe.map((t) => [t, cs.getPropertyValue(t).trim()]));
    },
    { axis, id, theme, probe: probe as string[] },
  );
}

/** What the SCOPED tile resolves, with `<html>` deliberately on another value. */
async function scopedFor(
  axis: 'palette' | 'type',
  id: string,
  theme: 'light' | 'dark',
  ancestor: string,
  probe: Probe,
): Promise<Resolved> {
  return page.evaluate(
    ({ axis, id, theme, ancestor, probe }) => {
      const html = document.documentElement;
      html.setAttribute('data-theme', theme);
      html.setAttribute(`data-${axis}`, ancestor);
      const el = document.querySelector(`[data-probe="${axis}:${id}"]`);
      if (!el) throw new Error(`no tile rendered for ${axis}:${id}`);
      const cs = getComputedStyle(el);
      return Object.fromEntries(probe.map((t) => [t, cs.getPropertyValue(t).trim()]));
    },
    { axis, id, theme, ancestor, probe: probe as string[] },
  );
}

describe('StyleVignette — SCOPED mode emits the scope attribute', () => {
  it('carries `data-appearance-scope` on every scoped axis, and NOT in LIVE mode', () => {
    // LIVE mode must stay unscoped: re-emitting the token layer locally would
    // pin the subtree instead of following the global selection it exists for.
    expect(renderToStaticMarkup(<StyleVignette />)).not.toContain('data-appearance-scope');
    for (const markup of [
      renderToStaticMarkup(<StyleVignette palette={PALETTE_IDS[1]} />),
      renderToStaticMarkup(<StyleVignette type={TYPE_IDS[1]} />),
      renderToStaticMarkup(<StyleVignette styleId={STYLE_IDS[1]} />),
    ]) {
      expect(markup).toContain('data-appearance-scope');
    }
  });
});

describe('the PALETTE axis resolves its own colours in a nested scope', () => {
  // The ancestor is deliberately a NON-base palette, which is the condition the
  // shipped bug needed: with `motir` on `<html>` the base tile is right by
  // accident and nine of ten are wrong.
  for (const theme of ['light', 'dark'] as const) {
    it(`every one of the ${PALETTE_IDS.length} palettes, ${theme}`, async () => {
      const wrong: string[] = [];
      for (const id of PALETTE_IDS as readonly PaletteId[]) {
        const ancestor: PaletteId = id === 'evergreen' ? 'garnet' : 'evergreen';
        const truth = await truthFor('palette', id, theme, PALETTE_PROBE);
        const scoped = await scopedFor('palette', id, theme, ancestor, PALETTE_PROBE);
        for (const token of PALETTE_PROBE) {
          if (scoped[token] !== truth[token]) {
            wrong.push(`${id} ${token}: got ${scoped[token]}, own value is ${truth[token]}`);
          }
        }
      }
      expect(wrong).toEqual([]);
    }, 60_000);
  }

  it('reports the whole matrix — every id × both themes, none skipped', async () => {
    const cells: string[] = [];
    for (const theme of ['light', 'dark'] as const) {
      for (const id of PALETTE_IDS as readonly PaletteId[]) {
        const ancestor: PaletteId = id === 'evergreen' ? 'garnet' : 'evergreen';
        const truth = await truthFor('palette', id, theme, PALETTE_PROBE);
        const scoped = await scopedFor('palette', id, theme, ancestor, PALETTE_PROBE);
        cells.push(
          `${theme.padEnd(5)} ${id.padEnd(10)} --el-accent ${scoped['--el-accent']} ${
            scoped['--el-accent'] === truth['--el-accent']
              ? '✓'
              : `✗ own is ${truth['--el-accent']}`
          }`,
        );
      }
    }
    expect(cells).toHaveLength(PALETTE_IDS.length * 2);
    // The card asks for the matrix to be REPORTED, not merely asserted: a
    // reviewer reads twenty resolved values, not a green tick.
    // eslint-disable-next-line no-console
    console.log(['', 'Scoped palette previews — resolved accent per tile:', ...cells].join('\n'));
    expect(cells.filter((c) => c.includes('✗'))).toEqual([]);
  }, 60_000);
});

describe('the TYPE axis resolves its own faces in a nested scope', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`every one of the ${TYPE_IDS.length} pairings, ${theme}`, async () => {
      const wrong: string[] = [];
      for (const id of TYPE_IDS as readonly TypeId[]) {
        const ancestor: TypeId = id === 'mono-technical' ? 'grotesk' : 'mono-technical';
        const truth = await truthFor('type', id, theme, TYPE_PROBE);
        const scoped = await scopedFor('type', id, theme, ancestor, TYPE_PROBE);
        for (const token of TYPE_PROBE) {
          if (scoped[token] !== truth[token]) {
            wrong.push(`${id} ${token}: got ${scoped[token]}, own value is ${truth[token]}`);
          }
        }
      }
      expect(wrong).toEqual([]);
    }, 60_000);
  }
});

describe('the base blocks are COPIES, and the copy is guarded', () => {
  /*
   * `[data-palette='motir']` and `[data-type='motir']` restate base values that
   * `@theme` / the Tier-3 `:root` block already declare. Duplication is the
   * price of making the base entry re-assert like every other entry; this is
   * the guard that keeps the two from drifting apart silently.
   */
  const css = readFileSync(join(PKG_ROOT, 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  function rules(source: string): { selector: string; body: string }[] {
    const out: { selector: string; body: string }[] = [];
    let depth = 0;
    let preludeStart = 0;
    let bodyStart = 0;
    for (let i = 0; i < source.length; i += 1) {
      const c = source[i];
      if (c === '{') {
        if (depth === 0) bodyStart = i + 1;
        depth += 1;
      } else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push({
            selector: source.slice(preludeStart, bodyStart - 1).trim(),
            body: source.slice(bodyStart, i),
          });
          preludeStart = i + 1;
        }
      } else if (c === ';' && depth === 0) {
        preludeStart = i + 1;
      }
    }
    return out;
  }

  const parsed = rules(css);
  const declsOf = (body: string) =>
    Object.fromEntries(
      [...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [
        m[1] as string,
        (m[2] as string).trim(),
      ]),
    );

  const baseLight: Record<string, string> = {};
  for (const r of parsed) {
    if (r.selector === '@theme' || r.selector === ':root' || r.selector.startsWith(':root,')) {
      Object.assign(baseLight, declsOf(r.body));
    }
  }
  const baseDark: Record<string, string> = {};
  for (const r of parsed) {
    if (r.selector === "[data-theme='dark']") Object.assign(baseDark, declsOf(r.body));
  }
  /**
   * Find a rule by ONE ARM of its selector list, not by the whole joined
   * string. Arm ORDER carries no cascade meaning, and this card reordered
   * several lists so the compound arm stays LAST — the readers in
   * `tests/theme/*` identify a rule by its final line. A lookup keyed on the
   * joined string would go red on that cosmetic move alone.
   */
  const byArm = (arm: string) =>
    declsOf(
      parsed
        .filter((r) =>
          r.selector
            .split(',')
            .map((a) => a.trim())
            .includes(arm),
        )
        .map((r) => r.body)
        .join(';'),
    );

  it("every `[data-palette='motir']` declaration equals the base value for that token", () => {
    const block = byArm("[data-appearance-scope][data-palette='motir']");
    expect(Object.keys(block).length).toBeGreaterThan(0);
    const drifted = Object.entries(block)
      .filter(([token, value]) => baseLight[token] !== value)
      .map(([token, value]) => `${token}: base has ${baseLight[token]}, block has ${value}`);
    expect(drifted).toEqual([]);
  });

  it('its DARK arm equals the base dark value for every token it declares', () => {
    const block = byArm("[data-appearance-scope][data-palette='motir'][data-theme='dark']");
    expect(Object.keys(block).length).toBeGreaterThan(0);
    const drifted = Object.entries(block)
      .filter(([token, value]) => baseDark[token] !== value)
      .map(([token, value]) => `${token}: base dark has ${baseDark[token]}, block has ${value}`);
    expect(drifted).toEqual([]);
  });

  it('covers every token ANY palette overrides — a new palette cannot outgrow the base block', () => {
    /*
     * The failure this forbids: a later palette overrides a token the base
     * block does not restate, and that ONE token leaks from the ancestor into
     * a scoped `motir` tile. Nothing else would notice.
     */
    const union = new Set<string>();
    for (const r of parsed) {
      if (/^\[data-palette='[^']+'\]$/.test(r.selector)) {
        for (const token of Object.keys(declsOf(r.body))) union.add(token);
      }
    }
    const base = byArm("[data-appearance-scope][data-palette='motir']");
    expect([...union].filter((t) => !(t in base)).sort()).toEqual([]);
  });

  it('every `[data-type]` block is TOTAL over the three role tokens', () => {
    /*
     * ⚠️ THE TWO AXES NEED DIFFERENT COMPLETENESS RULES, and the difference is
     * not arbitrary — it is which layer the tokens live in.
     *
     * A `[data-palette]` block may omit a token it does not re-skin: `--el-*`
     * belong to the Tier-3 layer, `[data-appearance-scope]` re-emits that whole
     * layer onto the scoped element, and the re-emitted declaration derives
     * from the `--color-*` this subtree overrides. The omission is covered.
     *
     * `--font-*` are ROLE tokens with no such layer, so an omitted role is
     * simply inherited from the ancestor. That is invisible on `<html>` — there
     * is no ancestor — and wrong in every nested scope: `motir-sans` and
     * `editorial` do not re-point `--font-sans`, so under a mono ancestor they
     * rendered mono. Found by this file's own type case, which is why the rule
     * is asserted rather than written down.
     */
    const union = new Set<string>();
    const per = new Map<string, Set<string>>();
    for (const r of parsed) {
      const m = /^(?:\[data-appearance-scope\])?\[data-type='([^']+)'\]$/.exec(r.selector);
      if (!m) continue;
      const tokens = new Set(Object.keys(declsOf(r.body)));
      per.set(m[1] as string, tokens);
      for (const t of tokens) union.add(t);
    }
    expect(per.size).toBeGreaterThan(0);
    const incomplete = [...per.entries()]
      .map(([id, tokens]) => [id, [...union].filter((t) => !tokens.has(t))] as const)
      .filter(([, missing]) => missing.length > 0)
      .map(([id, missing]) => `${id} omits ${missing.sort().join(', ')}`);
    expect(incomplete).toEqual([]);
  });

  it('every per-palette DARK block is reachable from a NESTED scope, not just from `<html>`', () => {
    /*
     * The compound `[data-palette='X'][data-theme='dark']` needs both
     * attributes on ONE element, which a scoped tile inheriting `data-theme`
     * can never satisfy. Each therefore owes a descendant arm.
     */
    const missing = (PALETTE_IDS as readonly string[]).filter((id) => {
      // The base palette's reset is additionally scoped by
      // `[data-appearance-scope]` (it applies to nested previews only), so both
      // arms are matched with that prefix optional.
      const compound = new RegExp(`\\[data-palette='${id}'\\]\\[data-theme='dark'\\]`);
      if (!parsed.some((r) => compound.test(r.selector))) return false; // no dark block at all
      const descendant = new RegExp(
        `\\[data-theme='dark'\\] (?:\\[data-appearance-scope\\])?\\[data-palette='${id}'\\]`,
      );
      return !parsed.some((r) => descendant.test(r.selector));
    });
    expect(missing).toEqual([]);
  });
});
