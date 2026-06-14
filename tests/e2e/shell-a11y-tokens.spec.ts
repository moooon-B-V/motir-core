// Accessibility audit — the public /tokens design-system specimens.
//
// Split out of shell-a11y.spec.ts (Subtask 1.5.5) so Playwright's file-level
// sharding spreads the axe sweeps across CI legs. These specimen routes are
// PUBLIC and render no DB-backed state, so this file deliberately does NOT
// reset the database or open a session — keeping it the fast leg of the three
// a11y files (shell-a11y / shell-a11y-tokens / shell-a11y-detail).
//
// /tokens is where every primitive renders together, so an axe sweep here
// catches regressions before they reach a real surface.

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { WCAG_TAGS, formatViolations, type AxeViolation } from './_helpers/a11y';

// Cold-compiling a specimen route + running axe can exceed the 30s default.
test.describe.configure({ timeout: 90_000 });

test.describe('@a11y design-system specimens', () => {
  // `color-contrast` is excluded on the WHOLE-page sweep — but NOT for the Pill
  // anymore (PRODECT_FINDINGS #35 is fixed; the focused test below proves the
  // Pill matrix passes color-contrast). The exclusion now covers only genuine
  // SPECIMEN-DISPLAY artifacts that aren't product UI: tinted-surface Card demos
  // rendered with body copy to show the tint tokens, the tiny mono hex micro-
  // labels under each color swatch, and the raw `<pre>` code samples. Those are
  // documentation elements, not shipped surfaces, so they aren't held to AA
  // here. Every OTHER axe rule still guards the full page.
  test('the /tokens specimen route is axe-clean (WCAG 2.1 AA; color-contrast on specimen artifacts excluded)', async ({
    page,
  }) => {
    await page.goto('/tokens');
    await expect(page.getByRole('heading', { name: 'Tokens', level: 1 })).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .disableRules(['color-contrast'])
      .analyze();
    expect(
      results.violations,
      formatViolations('/tokens', results.violations as AxeViolation[]),
    ).toEqual([]);
  });

  // The MarkdownEditor primitive specimen (Subtask 2.3.5). Renders every
  // variant (min / full / read-only) + the MarkdownView render path. Public,
  // no session.
  //
  // The `.ProseMirror` subtree is EXCLUDED: it's the third-party Tiptap
  // contenteditable surface we don't own. Everything that IS our code stays in
  // the strict sweep: the page chrome, the editor's toolbar (labelled buttons),
  // its label + status notice, and the standalone MarkdownView render path
  // (whose links keep their underline and pass link-in-text-block). This mirrors
  // the /tokens precedent of holding specimen/third-party artifacts to a
  // narrower bar than shipped product UI.
  //
  // `color-contrast` is excluded on the same basis as the /tokens sweep (the
  // syntax-highlight tints in the rendered sample are specimen display).
  test('the /tokens/markdown-editor specimen is axe-clean (WCAG 2.1 AA; third-party editor chrome excluded)', async ({
    page,
  }) => {
    await page.goto('/tokens/markdown-editor');
    await expect(page.getByRole('heading', { name: 'Markdown editor', level: 1 })).toBeVisible();
    await expect(page.locator('.ProseMirror').first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .exclude('.ProseMirror')
      .disableRules(['color-contrast'])
      .analyze();
    expect(
      results.violations,
      formatViolations('/tokens/markdown-editor', results.violations as AxeViolation[]),
    ).toEqual([]);
  });

  // The TreeTable primitive specimen (Subtask 2.5.2). Renders the hierarchical
  // issue tree-grid (populated, depth 4) + an empty variant. Public, no session.
  //
  // STRICT — zero exclusions, color-contrast ENABLED: unlike the markdown-editor
  // specimen there is no third-party chrome and no specimen-display tint here.
  // The whole `role="treegrid"` (rows with aria-level/expanded/posinset/setsize,
  // the gridcells, the stretched row links, the AA-safe status Pills) is held to
  // full WCAG 2.1 AA, so the treegrid semantics are proven on the real markup
  // before the /issues route (2.5.3) inherits them.
  test('the /tokens/tree-table specimen is axe-clean (WCAG 2.1 AA; strict)', async ({ page }) => {
    await page.goto('/tokens/tree-table');
    await expect(page.getByRole('heading', { name: 'Tree table', level: 1 })).toBeVisible();
    await expect(page.getByRole('treegrid', { name: 'Work Items', exact: true })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(
      results.violations,
      formatViolations('/tokens/tree-table', results.violations as AxeViolation[]),
    ).toEqual([]);
  });

  // STRICT — zero exclusions, color-contrast ENABLED. The DatePicker specimen
  // renders an OPEN calendar (autoOpen), so the whole WAI-ARIA dialog + day grid
  // (the labelled trigger with aria-haspopup, role="grid" with rows/gridcells,
  // the roving day buttons carrying aria-current="date"/aria-selected, the
  // AA-safe selected/today states) is held to full WCAG 2.1 AA before the issue
  // date fields (2.3.6 edit form, 2.4.2 detail rail) rely on it.
  test('the /tokens/date-picker specimen is axe-clean (WCAG 2.1 AA; strict)', async ({ page }) => {
    await page.goto('/tokens/date-picker');
    await expect(page.getByRole('heading', { name: 'Date picker', level: 1 })).toBeVisible();
    // The autoOpen specimen → the calendar dialog (+ its month grid) is in the DOM.
    await expect(page.getByRole('dialog', { name: 'Open date' })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(
      results.violations,
      formatViolations('/tokens/date-picker', results.violations as AxeViolation[]),
    ).toEqual([]);
  });

  // The actual subject of PRODECT_FINDINGS #35: the Pill `status`/`severity`
  // matrix. Scoped color-contrast sweep over JUST the Pill specimen section,
  // with the rule ENABLED — proves every colored tone clears WCAG AA now that
  // they use adaptive charcoal text on the hued tint (~10:1 both modes), and
  // guards against a future regression to hue-on-tint text.
  test('the Pill matrix passes color-contrast (WCAG 2.1 AA) — #35 fixed', async ({ page }) => {
    await page.goto('/tokens');
    await expect(page.locator('#primitives-pill')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .include('#primitives-pill')
      .analyze();
    expect(
      results.violations,
      formatViolations('/tokens#primitives-pill', results.violations as AxeViolation[]),
    ).toEqual([]);
  });
});
