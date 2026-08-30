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
// which is otherwise indistinguishable in a binary diff. Three verdicts:
//
//   EXACT  the baseline render is byte-identical to the committed PNG, so the
//          new PNG differs from it in exactly what your diff changed.
//   DIMS   same dimensions, different bytes — the committed export came from a
//          different renderer build, but nothing reflowed.
//   DRIFT  different height. The committed PNG predates an environment change
//          and has not been re-exported since; re-exporting closes that gap, and
//          the height delta belongs to the gap, not to your diff. In this tree
//          the split is by DATE: every asset exported before ~2026-06-20 drifts,
//          every one after it is EXACT.
//
// The viewport WIDTH is searched, not assumed: a full-page screenshot is as wide
// as the DOCUMENT, which for an overflowing mock is wider than the viewport that
// produced it. So the search probes at the committed width, reads how far the
// render overshot, and steps the viewport back by exactly that much — one
// correction lands most overflowing assets — before falling back to the standard
// widths.
//
// ── Usage ───────────────────────────────────────────────────────────────────
//   node scripts/render-design-mock.mjs design/<area>/<surface>.mock.html …
//   node scripts/render-design-mock.mjs --verify design/**/*.mock.html
//   node scripts/render-design-mock.mjs --width 1280 design/<area>/<s>.mock.html
//
// `--verify` reports without writing. `--width` / `--height` skip the search for
// an asset whose PNG does not exist yet (a NEW asset has no baseline, so it is
// the one case where the settings have to be stated rather than recovered).
// Run it AFTER `prettier --write` on the mock: prettier reformats the markup, so
// a PNG rendered from the pre-format source is not an export of what lands.

import { chromium } from '@playwright/test';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Widths a design asset in this tree has actually been exported at. */
const STANDARD_WIDTHS = [
  1200, 1280, 1240, 1400, 1440, 1120, 1024, 1360, 1000, 1600, 960, 1180, 1920, 1100, 1300, 1320,
  1500, 1160, 900, 820, 768, 414, 390, 375,
];
/** Viewport heights to try once the width is pinned; a mock rarely depends on one. */
const HEIGHTS = [900, 800, 1000, 1080, 720, 1024, 960, 1200];
/**
 * `2` is the tree's convention, but one asset predates it
 * (`design/onboarding-migrate/onboarding-migrate.png`, 1200×4755 — an ODD
 * dimension, which a 2× render cannot produce). So the search tries both, and
 * getting it wrong is not a subtle miss: at half the intended viewport that
 * asset reflows to three times its height.
 */
const DEVICE_SCALE_FACTORS = [2, 1];

const argv = process.argv.slice(2);
const verifyOnly = argv.includes('--verify');
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
  console.error('usage: node scripts/render-design-mock.mjs [--verify] [--width N] <mock.html…>');
  process.exit(2);
}

const md5 = (buffer) => createHash('md5').update(buffer).digest('hex');
const pngSize = (buffer) => [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];

const scratch = mkdtempSync(join(tmpdir(), 'design-mock-'));
const browser = await chromium.launch();

/** Full-page, light theme, at the design tree's `deviceScaleFactor: 2` convention. */
async function shoot(fileUrl, width, height, scale) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: scale,
    colorScheme: 'light',
  });
  await page.goto(fileUrl, { waitUntil: 'networkidle' });
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

const heightsFor = (forced) => (forced ? [forced] : HEIGHTS);

/**
 * Widths to try for an asset whose document is WIDER than its viewport.
 *
 * A full-page screenshot is `max(viewport, scrollWidth)` wide, and `scrollWidth`
 * tracks the viewport for a mock whose overflow is a fixed-width child. So one
 * probe measures the overshoot and one subtraction names the viewport that
 * produced the committed export; a second pass covers the case where the
 * overflow itself moved.
 */
async function overflowCorrectedWidths(baselineUrl, target1x, height, scale) {
  const candidates = [];
  let width = target1x;
  for (let pass = 0; pass < 2; pass += 1) {
    const buffer = await shoot(baselineUrl, width, height, scale);
    const overshoot = pngSize(buffer)[0] / scale - target1x;
    if (overshoot <= 0) break;
    width -= overshoot;
    if (!Number.isInteger(width) || width <= 0) break;
    candidates.push(width);
  }
  return candidates;
}

let failed = 0;
for (const mock of mocks) {
  const png = mock.replace(/\.mock\.html$/, '.png');
  const target = 'file://' + resolve(mock);

  if (!existsSync(png)) {
    if (!forcedWidth) {
      console.log(`NEW\t—\t${mock} — no committed .png; pass --width to export a new asset`);
      failed += 1;
      continue;
    }
    const buffer = await shoot(
      target,
      forcedWidth,
      forcedHeight ?? HEIGHTS[0],
      DEVICE_SCALE_FACTORS[0],
    );
    if (!verifyOnly) writeFileSync(png, buffer);
    console.log(`NEW\t${forcedWidth}\t${pngSize(buffer).join('x')}\t${mock}`);
    continue;
  }

  // The committed export is read from HEAD, not from the working tree: on a
  // re-run inside a sweep the working-tree PNG is one this script already wrote,
  // and comparing against it would report every asset as EXACT.
  const committed = execFileSync('git', ['show', `HEAD:${png}`], { maxBuffer: 256 * 1024 * 1024 });
  const [committedWidth, committedHeight] = pngSize(committed);

  // The baseline: the same mock as it stands at HEAD. Anything this render does
  // NOT reproduce is the environment's doing, not the working tree's.
  const baselinePath = join(scratch, mock.replace(/\//g, '__'));
  writeFileSync(
    baselinePath,
    execFileSync('git', ['show', `HEAD:${mock}`], { maxBuffer: 256 * 1024 * 1024 }),
  );
  const baselineUrl = 'file://' + baselinePath;

  const heights = heightsFor(forcedHeight);

  let settings = null;
  let verdict = null;
  search: for (const scale of DEVICE_SCALE_FACTORS) {
    const target1x = committedWidth / scale;
    if (!Number.isInteger(target1x)) continue;
    const widths = forcedWidth
      ? [forcedWidth]
      : [
          ...new Set([
            target1x,
            ...(await overflowCorrectedWidths(baselineUrl, target1x, heights[0], scale)),
            ...STANDARD_WIDTHS,
          ]),
        ].filter((width) => Number.isInteger(width) && width > 0 && width <= target1x);

    for (const width of widths) {
      for (const height of heights) {
        const buffer = await shoot(baselineUrl, width, height, scale);
        const [renderedWidth, renderedHeight] = pngSize(buffer);
        if (renderedWidth !== committedWidth) break; // wrong viewport; try the next width
        if (md5(buffer) === md5(committed)) {
          settings = { width, height, scale };
          verdict = 'EXACT';
          break search;
        }
        if (renderedHeight === committedHeight) {
          settings = { width, height, scale };
          verdict = 'DIMS';
          break search;
        }
        // Same width, different height: remember it and keep looking for better.
        settings ??= { width, height, scale };
        verdict ??= 'DRIFT';
      }
    }
  }

  if (!settings) {
    console.log(`FAIL\t—\tno viewport reproduces ${committedWidth}px wide\t${mock}`);
    failed += 1;
    continue;
  }

  const buffer = await shoot(target, settings.width, settings.height, settings.scale);
  if (!verifyOnly) writeFileSync(png, buffer);
  console.log(
    `${verdict}\t${settings.width}x${settings.height}@${settings.scale}x\t` +
      `committed=${committedWidth}x${committedHeight}\tnew=${pngSize(buffer).join('x')}\t${mock}`,
  );
}

await browser.close();
process.exit(failed > 0 ? 1 : 0);
