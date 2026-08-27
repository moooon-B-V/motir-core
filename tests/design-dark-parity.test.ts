// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Window } from 'happy-dom';

// MOTIR-3592 — a design mock's "Dark parity" panel must actually render dark.
//
// ── The defect this measures ────────────────────────────────────────────────
// Every mock in `design/**` copies the same token block: Tier-0 `--color-*` and
// Tier-3 `--el-*` both on `:root`, with `--el-page-bg: var(--color-background)`
// and friends, plus a `[data-theme='dark']` block that re-declares only the
// Tier-0 half. A custom property's `var()` is substituted where the property is
// DECLARED, not where it is used — so `--el-page-bg` computes ONCE, on `:root`,
// against the LIGHT `--color-background`, and inherits down as a literal
// `#ffffff`. Putting `data-theme="dark"` on a nested `.stage` / `.panel` flips
// the Tier-0 palette for that subtree and changes nothing any element paints
// with. In the real app `data-theme` sits on `<html>`, so `:root` IS the themed
// element and the problem cannot arise — which is why nobody noticed.
//
// The result is a LIGHT panel under a caption reading "Dark parity — the resting
// pane renders correctly on data-theme='dark'". The panel is not decoration, it
// is a CHECK, and the check is what failed: the parity was asserted and never
// observed, and the committed `.png` shows a light pane where the reviewer
// expects a dark one.
//
// ── Why a MEASUREMENT and not a convention check ────────────────────────────
// `design/settings/appearance.mock.html` has carried the correct pattern for
// months and it did not stop `design/settings/profile.mock.html` shipping the
// broken one — the ordinary fate of a convention nothing measures. Asserting
// "the mock re-emits the Tier-3 block" would only restate the convention. This
// spec asks the CSS engine what the nested element actually computed, which
// turns "we followed the pattern" into "the pattern held" and is agnostic about
// WHICH fix a mock used: the `[data-theme]` re-emit that three assets use, or
// the shipped design system's own `[data-appearance-scope]` selector
// (`packages/design-system/theme.css`, MOTIR-2077) for a mock that embeds it.
//
// ── Why `--el-page-bg` and not every `--el-*` ───────────────────────────────
// Measured over the whole tree, a "no derived token may keep its light value"
// sweep flags ~56 tokens per asset on assets that are demonstrably correct,
// because a great many Tier-3 tokens resolve to the SAME hex in both themes (a
// danger red, an accent) and are theme-invariant by design. `--color-background`
// is `#ffffff` light and `#0f0f0f` dark in every asset in this tree, so
// `--el-page-bg` is the one token whose value proves the Tier-3 layer recomputed.
//
// ── Why happy-dom and not a real browser ────────────────────────────────────
// `vitest.design.config.ts` runs on EVERY branch prefix, including the ones
// where the Playwright matrix is deliberately skipped, and its `design-guards`
// job installs no browser — "an install plus a few seconds of Node" is the cost
// class the lane exists to stay inside. happy-dom is already a devDependency and
// resolves `var()` substitution, attribute-selector cascade and the nested
// `[data-palette]` case correctly.
//
// ⚠️ TWO DIVERGENCES FROM CHROMIUM, both stated because the assertions below are
// written to be insensitive to them.
//   1. On a BROKEN asset Chromium returns the inherited light value (`#ffffff`)
//      while happy-dom returns the empty string — it does not inherit a
//      `:root`-computed custom property down. Both are "not the dark value",
//      which is why the load-bearing assertion compares against the element's
//      OWN `--color-background` rather than against the light literal.
//   2. happy-dom reads NOTHING off `<html>` for an asset whose token block is a
//      `@layer theme { :root, :host { … } }` emitted by compiled Tailwind, where
//      Chromium reads the light value. So the root reading is carried for
//      reporting only and gates nothing: an earlier draft used it to decide
//      whether to walk an asset, and silently skipped a BROKEN one
//      (`design/shell/context-row.mock.html`) on that basis.
// Cross-checked in Chromium over all 151 mocks when this spec was written: the
// two engines return the same verdict for every one of the 31 nested dark
// elements, before AND after the fix. To re-check after a happy-dom upgrade, run
// the same query under `@playwright/test`'s chromium against
// `file://<repo>/design/**/*.mock.html`.

const ROOT = process.cwd();
const DESIGN_DIR = join(ROOT, 'design');

/** Every `*.mock.html` under `design/`, as a repo-relative POSIX path. */
function mockFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) mockFiles(path, out);
    else if (entry.endsWith('.mock.html')) out.push(relative(ROOT, path).split(sep).join('/'));
  }
  return out;
}

type Reading = {
  file: string;
  /** A stable handle on WHICH element in the asset, for a legible failure. */
  where: string;
  /** The Tier-3 page token as the nested element computes it. */
  pageBg: string;
  /** The Tier-0 background the nested scope declares — what `pageBg` must equal. */
  colorBg: string;
  /** The Tier-3 page token as `:root` computes it — the light value. */
  rootPageBg: string;
};

/**
 * Read every nested `data-theme="dark"` element in one asset.
 *
 * "Nested" excludes `<html>` deliberately: an asset whose ROOT is dark has no
 * defect to have — `:root` is then the themed element and every `--el-*`
 * resolves against the dark palette on its own.
 */
function readNestedDarkScopes(file: string): Reading[] {
  const window = new Window({
    url: 'https://localhost/',
    // The assets' own scripts only clone specimen markup; none of them declares
    // a token. Skipping them keeps the lane in the seconds it promises.
    settings: { disableJavaScriptEvaluation: true },
  });
  try {
    const { document } = window;
    document.write(readFileSync(join(ROOT, file), 'utf8'));

    // ⚠️ READ ONLY, never a gate. happy-dom returns '' here for an asset whose
    // token block is a `@layer theme { :root, :host { … } }` from compiled
    // Tailwind — `design/shell/context-row.mock.html` is one, and Chromium reads
    // `#ffffff` for it. Gating the walk on this value silently SKIPPED that whole
    // asset, which is how a broken one passed while the spec was being written.
    // Every assertion that matters is element-local for exactly that reason.
    const rootPageBg = window
      .getComputedStyle(document.documentElement)
      .getPropertyValue('--el-page-bg')
      .trim();

    return [...document.querySelectorAll('[data-theme="dark"]')]
      .filter((element) => element !== document.documentElement)
      .map((element, index) => {
        const style = window.getComputedStyle(element);
        const className = element.getAttribute('class');
        return {
          file,
          where: `<${element.tagName.toLowerCase()}${className ? ` class="${className}"` : ''}> (#${index + 1})`,
          pageBg: style.getPropertyValue('--el-page-bg').trim(),
          colorBg: style.getPropertyValue('--color-background').trim(),
          rootPageBg,
        };
      });
  } finally {
    void window.happyDOM.close();
  }
}

const readings = mockFiles(DESIGN_DIR)
  .sort()
  // Cheap pre-filter, and it decides membership from the SOURCE rather than from
  // anything an engine computed. Two conditions: the asset spells a nested dark
  // scope at all (building a DOM for the other ~128 mocks buys nothing), and it
  // declares the Tier-3 page token somewhere — an asset that never uses
  // `--el-page-bg` has nothing to recompute and is not this spec's business.
  .filter((file) => {
    const source = readFileSync(join(ROOT, file), 'utf8');
    return (
      source.replace(/<html[^>]*>/i, '').includes('data-theme="dark"') &&
      /--el-page-bg\s*:/.test(source)
    );
  })
  .flatMap(readNestedDarkScopes);

describe("a design mock's nested dark scope (MOTIR-3592)", () => {
  it('finds nested dark scopes to rule on', () => {
    // Without this the assertions below pass vacuously the day the pre-filter
    // stops matching — a rename of the attribute, a change in how the assets
    // spell a dark panel, a walk that stops finding the tree.
    expect(readings.length).toBeGreaterThan(0);
  });

  it('can read every scope’s own Tier-0 background', () => {
    // The second half of the vacuity guard, and the one that would otherwise be
    // invisible: the assertion below compares two computed values, so an asset
    // the engine cannot read at all yields '' === '' and PASSES. Every dark
    // scope in this tree declares `--color-background`, so an empty reading here
    // means the engine lost the asset's palette, not that the asset is fine.
    const unreadable = readings
      .filter((reading) => reading.colorBg === '')
      .map((reading) => `${reading.file} ${reading.where}: --color-background is unset`);
    expect(
      unreadable,
      'a nested dark scope declares no Tier-0 background the CSS engine could read — ' +
        'check the asset against Chromium before trusting any verdict about it',
    ).toEqual([]);
  });

  it('recomputes the Tier-3 page token against the scope’s own Tier-0 palette', () => {
    // The load-bearing assertion, and the whole reason the spec renders rather
    // than parses: `--el-page-bg` on the dark element must be the Tier-0
    // background THAT ELEMENT declares, not the one `:root` resolved.
    const stale = readings
      .filter((reading) => reading.pageBg !== reading.colorBg)
      .map(
        (reading) =>
          `${reading.file} ${reading.where}: --el-page-bg is ${reading.pageBg || '(unset)'}, ` +
          `but the scope’s --color-background is ${reading.colorBg}`,
      );
    expect(
      stale,
      'a nested [data-theme="dark"] scope is painting the LIGHT page background. ' +
        'Re-emit the Tier-3 --el-* block scoped to [data-theme] (see ' +
        'design/settings/two-factor.mock.html), or put data-appearance-scope on the element ' +
        'if the asset embeds packages/design-system/theme.css. Then re-export the .png.',
    ).toEqual([]);
  });

  it('leaves no nested dark scope on the light page background', () => {
    // The card's criterion in its own words, and a second net under the first:
    // it catches an asset whose dark scope recomputed to something that merely
    // happens to equal its own light value.
    const light = readings
      .filter((reading) => reading.pageBg !== '' && reading.pageBg === reading.rootPageBg)
      .map(
        (reading) => `${reading.file} ${reading.where}: --el-page-bg is still ${reading.pageBg}`,
      );
    expect(light).toEqual([]);
  });
});
