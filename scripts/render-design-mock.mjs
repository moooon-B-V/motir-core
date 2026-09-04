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
// `tests/scripts/render-design-mock-search.test.ts`.
//
// ── Usage ───────────────────────────────────────────────────────────────────
//   node scripts/render-design-mock.mjs design/<area>/<surface>.mock.html …
//   node scripts/render-design-mock.mjs --verify design/**/*.mock.html
//   node scripts/render-design-mock.mjs --width 1280 design/<area>/<s>.mock.html
//
// `--verify` reports without writing. `--width` / `--height` skip the search for
// an asset whose PNG does not exist yet (a NEW asset has no baseline, so it is
// the one case where the settings have to be stated rather than recovered), and
// they are also the override for a REFLOW verdict: settings you STATE are
// written even when the height is far off, because you asserted them.
// Run it AFTER `prettier --write` on the mock: prettier reformats the markup, so
// a PNG rendered from the pre-format source is not an export of what lands.

import { chromium } from '@playwright/test';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEVICE_SCALE_FACTORS,
  HEIGHTS,
  heightsFor,
  pngSize,
  searchRenderSettings,
} from './renderDesignMockSearch.mjs';

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

/** `+5334px (+182%)` — the chosen candidate's distance from the committed height. */
const formatDelta = (heightDelta, committedHeight) => {
  const sign = heightDelta > 0 ? '+' : '';
  const percent = committedHeight > 0 ? Math.round((heightDelta / committedHeight) * 100) : 0;
  return `Δbaseline=${sign}${heightDelta}px (${sign}${percent}%)`;
};

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

  const { settings, verdict, heightDelta } = await searchRenderSettings({
    shoot: (width, height, scale) => shoot(baselineUrl, width, height, scale),
    committed,
    forcedWidth,
    heights: heightsFor(forcedHeight),
  });

  if (!settings) {
    console.log(`FAIL\t—\tno viewport reproduces ${committedWidth}px wide\t${mock}`);
    failed += 1;
    continue;
  }

  const chosen = `${settings.width}x${settings.height}@${settings.scale}x`;
  const against = `committed=${committedWidth}x${committedHeight}`;
  const delta = heightDelta === 0 ? '' : `\t${formatDelta(heightDelta, committedHeight)}`;

  // A REFLOW the search had to CHOOSE is a refusal: writing at these settings
  // produces a plausible image of a document that reflowed, which is precisely
  // the failure MOTIR-4374 was filed for. Settings the operator STATED are
  // written anyway — `--width` is an assertion, not a guess.
  if (verdict === 'REFLOW' && !forcedWidth) {
    console.log(
      `REFLOW\t${chosen}\t${against}${delta}\t${mock} — the nearest viewport still reflows ` +
        `the document; nothing written. Re-run with --width <the viewport it was exported at> ` +
        `if this delta is real.`,
    );
    failed += 1;
    continue;
  }

  const buffer = await shoot(target, settings.width, settings.height, settings.scale);
  if (!verifyOnly) writeFileSync(png, buffer);
  console.log(
    `${verdict}\t${chosen}\t${against}\tnew=${pngSize(buffer).join('x')}${delta}\t${mock}`,
  );
}

await browser.close();
process.exit(failed > 0 ? 1 : 0);
