#!/usr/bin/env node
// Re-export a design asset's `.png` from its `.mock.html` (MOTIR-3054).
//
// ── Why this exists ─────────────────────────────────────────────────────────
// `CLAUDE.md` § design assets makes the `.png` a required third file: change the
// mock, re-export the PNG, or the asset is incomplete. For a card that edits ONE
// surface that is a throwaway script. For a card that edits a token across the
// whole tree it is the dominant cost — MOTIR-3054 swept 51 mocks, and MOTIR-3068
// has 101 waiting behind it — and paying it with a fresh throwaway each time is
// how the render SETTINGS get lost. They are not derivable from the asset: the
// viewport width lives only in the committed PNG's own dimensions, and half the
// tree's PNGs no longer reproduce at all (below), which is a fact worth
// measuring rather than rediscovering.
//
// ── What it does ────────────────────────────────────────────────────────────
// For each mock, before writing anything, it renders the mock AS IT IS AT `HEAD`
// and compares that to the committed `.png`. That baseline is the whole point:
// it separates a pixel change YOU made from a pixel change the ENVIRONMENT made,
// which is otherwise indistinguishable in a binary diff. Four verdicts:
//
//   EXACT  the baseline render is byte-identical to the committed PNG, so the
//          new PNG differs from it in exactly what your diff changed.
//   DIMS   same dimensions, different bytes — the committed export came from a
//          different renderer build, but nothing reflowed.
//   DRIFT  different height. The committed PNG predates an environment change
//          and has not been re-exported since; re-exporting closes that gap, and
//          the height delta belongs to the gap, not to your diff. In this tree
//          the split is by DATE: every asset exported before ~2026-06-20 drifts,
//          every one after it is EXACT. The row carries the delta (`Δbaseline=`)
//          so the size of the gap is readable rather than assumed.
//   REFLOW different height, and FURTHER from the committed one than any
//          environment gap on this tree (`REFLOW_DELTA_RATIO`, 25%). The best
//          viewport found still reflows the document, so re-exporting at it
//          would write a plausible, wrong image. NOTHING IS WRITTEN and the run
//          exits non-zero; pass `--width` if the delta is genuinely real.
//
// ── How the viewport is chosen (the SELECTION RULE — MOTIR-4374) ────────────
// The viewport WIDTH is searched, not assumed: a full-page screenshot is as wide
// as the DOCUMENT, which for an overflowing mock is wider than the viewport that
// produced it. So the search probes at the committed width, reads how far the
// render overshot, and steps the viewport back by exactly that much — one
// correction lands most overflowing assets — before falling back to the standard
// widths.
//
// ⚠️ A WIDTH MATCH DOES NOT IDENTIFY A VIEWPORT, which is why the search does
// not stop at the first one. At `deviceScaleFactor: 2` it probes a viewport HALF
// the committed width and the scale factor doubles the output back to it, so a
// 1×-exported asset with an even width has TWO width-matching candidates — its
// real 1× viewport, and a 2× render at half of it, which REFLOWS the document.
// So the search keeps going and takes the candidate whose HEIGHT is nearest the
// committed height, with `EXACT` / `DIMS` still exiting early. The rule and the
// defect it replaces are documented in `scripts/renderDesignMockSearch.mjs`,
// which holds the search and is unit-tested in
// `tests/scripts/render-design-mock-search.test.ts`. The BOARD loop is split out
// the same way, into `scripts/renderDesignMockBoards.mjs`, and unit-tested in
// `tests/scripts/render-design-mock-boards.test.ts`.
//
// ── The DARK board (MOTIR-4868) ─────────────────────────────────────────────
// Five assets in this tree ship a FOURTH file, `<name>.dark.png` — the same
// board with `data-theme="dark"` on the root. It is not decoration: it is the
// only asset-side evidence for the dark half of the palette, where
// `--el-text-inverted` flips and several ink pairings differ from light.
//
// Until this card the script exported the LIGHT board only, and said nothing at
// all about the other one. So an author who edited a mock, ran this script and
// read `EXACT` had every reason to believe the asset was current while one of
// its files still specified the design they had just removed — observed on
// `parent/MOTIR-1754-rebuild` @ `4c9526cc8`, where the light board re-exported
// to 2400x17160 and the dark board sat at the committed 2400x17392, drawing two
// page-head buttons and a connect aside that no longer existed.
//
// So: a mock with a `<name>.dark.png` beside it exports BOTH boards, and prints
// one verdict line each. The dark board gets its OWN viewport search against its
// OWN committed PNG, so the four verdicts mean exactly what they mean for the
// light board, per board — a `REFLOW` on one writes nothing for that board and
// leaves the other alone. Nothing is opt-in: an author cannot forget a file they
// did not know was there. `--dark` is for the one case the existence test cannot
// cover — CREATING a dark board that does not exist yet, which needs `--width`
// for the same reason a new light asset does.
//
// ── Usage ───────────────────────────────────────────────────────────────────
//   node scripts/render-design-mock.mjs design/<area>/<surface>.mock.html …
//   node scripts/render-design-mock.mjs --verify design/**/*.mock.html
//   node scripts/render-design-mock.mjs --width 1280 design/<area>/<s>.mock.html
//   node scripts/render-design-mock.mjs --dark --width 1200 design/<a>/<s>.mock.html
//
// `--verify` reports without writing. `--width` / `--height` skip the search for
// an asset whose PNG does not exist yet (a NEW asset has no baseline, so it is
// the one case where the settings have to be stated rather than recovered), and
// they are also the override for a REFLOW verdict: settings you STATE are
// written even when the height is far off, because you asserted them.
// `--dark` adds the dark board for a mock that has no committed one yet.
// Run it AFTER `prettier --write` on the mock: prettier reformats the markup, so
// a PNG rendered from the pre-format source is not an export of what lands.

import { chromium } from '@playwright/test';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { boardsFor, darkPngFor, exportMockBoards } from './renderDesignMockBoards.mjs';

const argv = process.argv.slice(2);
const verifyOnly = argv.includes('--verify');
const forceDark = argv.includes('--dark');
const flagValue = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? null : Number(argv[at + 1]);
};
const forcedWidth = flagValue('--width');
const forcedHeight = flagValue('--height');
const mocks = argv.filter((arg, index) => !arg.startsWith('--') && !isFlagValue(argv, index));

function isFlagValue(args, index) {
  const previous = args[index - 1];
  return previous === '--width' || previous === '--height';
}

if (mocks.length === 0) {
  console.error(
    'usage: node scripts/render-design-mock.mjs [--verify] [--dark] [--width N] <mock.html…>',
  );
  process.exit(2);
}

/** A path's content AT `HEAD`, which is what every comparison in this script is against. */
const gitShow = (path) =>
  execFileSync('git', ['show', `HEAD:${path}`], { maxBuffer: 256 * 1024 * 1024 });

const scratch = mkdtempSync(join(tmpdir(), 'design-mock-'));
const browser = await chromium.launch();

/**
 * Full-page, at the design tree's `deviceScaleFactor: 2` convention.
 *
 * ⚠️ `colorScheme` stays `'light'` for BOTH boards, and that is deliberate. The
 * notes define the dark board as *the same board with `data-theme="dark"` on the
 * root* — no asset in the tree carries a `prefers-color-scheme` query (checked:
 * zero matches across all five), so emulating the OS preference would add a
 * second, unspecified difference between the two renders (UA form-control and
 * scrollbar painting) that no design note asks for. One board, one attribute.
 */
async function shoot(fileUrl, width, height, scale, theme = 'light') {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: scale,
    colorScheme: 'light',
  });
  await page.goto(fileUrl, { waitUntil: 'networkidle' });
  if (theme === 'dark') {
    // Set rather than toggle: two of the five mocks hard-code
    // `<html data-theme="light">` and three carry no attribute at all, so the
    // one operation that is correct for every shape is an assignment.
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  }
  // ⚠️ `animations: 'disabled'` is what makes this export REPRODUCIBLE, and it
  // stopped being optional the day the tree gained its first animated asset
  // (`design/runs/run-modal.mock.html`, MOTIR-3893 — the running edge flows).
  // Playwright's default is `allow`, so a CSS animation is captured at whatever
  // frame the screenshot happens to land on: two renders of an UNCHANGED file
  // produce different bytes at identical dimensions, which this script reports
  // for ever as DIMS. That verdict means "the committed export came from a
  // different environment" — so the one signal that separates YOUR DIFF from a
  // render-environment change would have been permanently stuck on the wrong
  // answer, for every asset, as soon as one asset moved.
  //
  // `disabled` fast-forwards CSS animations and transitions to their end state
  // and pins them there, so the frame is a function of the markup alone. It is a
  // NO-OP for every asset that does not animate, which is why this does not
  // re-baseline the rest of the tree.
  const buffer = await page.screenshot({ fullPage: true, animations: 'disabled' });
  await page.close();
  return buffer;
}

let failed = 0;
for (const mock of mocks) {
  const target = 'file://' + resolve(mock);

  // The baseline source is a property of the MOCK, not of a board, so it is
  // written once and both boards render from it.
  let baselineUrl = null;
  const baseline = () => {
    if (baselineUrl === null) {
      const baselinePath = join(scratch, mock.replace(/\//g, '__'));
      writeFileSync(baselinePath, gitShow(mock));
      baselineUrl = 'file://' + baselinePath;
    }
    return baselineUrl;
  };

  const { lines, failed: mockFailed } = await exportMockBoards({
    mock,
    boards: boardsFor(mock, { darkExists: existsSync(darkPngFor(mock)), forceDark }),
    shootTarget: (width, height, scale, theme) => shoot(target, width, height, scale, theme),
    shootBaseline: (width, height, scale, theme) => shoot(baseline(), width, height, scale, theme),
    // The committed export is read from HEAD, not from the working tree: on a
    // re-run inside a sweep the working-tree PNG is one this script already
    // wrote, and comparing against it would report every asset as EXACT.
    readCommitted: (png) => (existsSync(png) ? gitShow(png) : null),
    write: (png, buffer) => {
      if (!verifyOnly) writeFileSync(png, buffer);
    },
    forcedWidth,
    forcedHeight,
  });

  for (const line of lines) console.log(line);
  failed += mockFailed;
}

await browser.close();
process.exit(failed > 0 ? 1 : 0);
