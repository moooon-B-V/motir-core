/**
 * The SEARCH half of `scripts/render-design-mock.mjs` (MOTIR-4374).
 *
 * WHY IT IS SPLIT OUT. Same reason `scripts/detectStrayDesignResults.mjs` is
 * split from its runner: the runner launches chromium, writes PNGs, prints to
 * stdout and `process.exit`s at top level, so a module that imports it cannot
 * be called by a test. Everything here is pure or injected — `shoot` is an
 * `async (width, height, scale) => Buffer`, and nothing in this file opens a
 * browser, reads a file, touches the network or exits.
 *
 * WHAT THE SEARCH IS FOR. A design asset's render settings are not recorded
 * anywhere: the viewport that produced the committed `.png` lives only in that
 * PNG's own dimensions. So the search probes viewports until it finds one whose
 * render reproduces the committed WIDTH, and reports how close that render came
 * to the committed HEIGHT.
 *
 * ── THE SELECTION RULE, and the defect it replaces (MOTIR-4374) ─────────────
 * The width test alone does not identify a viewport. At `deviceScaleFactor: 2`
 * the search probes a viewport HALF the committed width and `deviceScaleFactor`
 * doubles the output back to it, so a 1×-exported asset with an even width has
 * TWO width-matching candidates: the 1× render at its real viewport, and a 2×
 * render at half of it — which reflows the document. The old loop remembered
 * the FIRST width match (`settings ??= …`) and never replaced it, and it tries
 * `2` before `1`, so it locked onto the reflowed candidate every time:
 * `design/ai-chat/target-picker.png` (1200×2932, exported at 1×) re-exported at
 * 1200×8206, a 182% reflow, under an ordinary `DRIFT` verdict.
 *
 * So: keep searching after the first width match, and choose the candidate
 * whose height is NEAREST the committed height. The `EXACT` and `DIMS` early
 * exits are unchanged — a candidate that reproduces the bytes, or the exact
 * dimensions, is the answer and the search stops on it.
 *
 * Reordering `DEVICE_SCALE_FACTORS` to `[1, 2]` is NOT the fix: it would trade
 * this case for its mirror, a 2×-exported asset whose half-width 1× render also
 * matches on width. The ordering is a preference; the missing COMPARISON was
 * the bug.
 */

import { createHash } from 'node:crypto';

/** Widths a design asset in this tree has actually been exported at. */
export const STANDARD_WIDTHS = [
  1200, 1280, 1240, 1400, 1440, 1120, 1024, 1360, 1000, 1600, 960, 1180, 1920, 1100, 1300, 1320,
  1500, 1160, 900, 820, 768, 414, 390, 375,
];

/** Viewport heights to try once the width is pinned; a mock rarely depends on one. */
export const HEIGHTS = [900, 800, 1000, 1080, 720, 1024, 960, 1200];

/**
 * `2` is the tree's convention, but one asset predates it
 * (`design/onboarding-migrate/onboarding-migrate.png`, 1200×4755 — an ODD
 * dimension, which a 2× render cannot produce). So the search tries both, and
 * getting it wrong is not a subtle miss: at half the intended viewport that
 * asset reflows to three times its height. Which is why the selection rule
 * above compares heights rather than trusting this order.
 */
export const DEVICE_SCALE_FACTORS = [2, 1];

/**
 * How far the chosen candidate's height may sit from the committed height
 * before it stops being an environment gap and starts being a REFLOW.
 *
 * The two populations are an order of magnitude apart in both directions. The
 * environment gap this script's header documents — a renderer build moving font
 * metrics under an export made before ~2026-06-20 — is a couple of percent
 * (`target-picker` at the right viewport: 60px on 2932, 2%). A wrong viewport
 * multiplies the document (the same asset at half its viewport: 5334px, 182%).
 * 25% is well above every drift measured on this tree and well below any
 * reflow, so the two never meet at the line.
 */
export const REFLOW_DELTA_RATIO = 0.25;

export const md5 = (buffer) => createHash('md5').update(buffer).digest('hex');

/** A PNG's pixel dimensions, read out of its IHDR chunk. */
export const pngSize = (buffer) => [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];

export const heightsFor = (forced) => (forced ? [forced] : HEIGHTS);

/**
 * Is this height delta a reflow rather than the documented environment gap?
 *
 * Exported so the runner can report the two distinguishably, and so the line
 * itself is assertable rather than buried in a branch.
 */
export const isReflow = (heightDelta, committedHeight) =>
  committedHeight > 0 && Math.abs(heightDelta) > committedHeight * REFLOW_DELTA_RATIO;

/**
 * Widths to try for an asset whose document is WIDER than its viewport.
 *
 * A full-page screenshot is `max(viewport, scrollWidth)` wide, and `scrollWidth`
 * tracks the viewport for a mock whose overflow is a fixed-width child. So one
 * probe measures the overshoot and one subtraction names the viewport that
 * produced the committed export; a second pass covers the case where the
 * overflow itself moved.
 */
export async function overflowCorrectedWidths(shoot, target1x, height, scale) {
  const candidates = [];
  let width = target1x;
  for (let pass = 0; pass < 2; pass += 1) {
    const buffer = await shoot(width, height, scale);
    const overshoot = pngSize(buffer)[0] / scale - target1x;
    if (overshoot <= 0) break;
    width -= overshoot;
    if (!Number.isInteger(width) || width <= 0) break;
    candidates.push(width);
  }
  return candidates;
}

/**
 * Recover the render settings that produced `committed`, by probing viewports
 * with `shoot` and keeping the closest match.
 *
 * Returns `{ settings, verdict, heightDelta }`, where `settings` is `null` when
 * no viewport reproduced the committed width at all, and `heightDelta` is the
 * chosen candidate's height MINUS the committed height (0 for `EXACT` /
 * `DIMS`). The four verdicts:
 *
 *   EXACT   byte-identical to the committed PNG.
 *   DIMS    same dimensions, different bytes — a different renderer build.
 *   DRIFT   different height, within `REFLOW_DELTA_RATIO` of the committed one.
 *   REFLOW  different height, FURTHER than that — the best viewport found still
 *           reflows the document, so these settings would write a plausible,
 *           wrong image. The runner refuses to write on this verdict.
 */
export async function searchRenderSettings({
  shoot,
  committed,
  forcedWidth = null,
  heights = HEIGHTS,
  scales = DEVICE_SCALE_FACTORS,
  standardWidths = STANDARD_WIDTHS,
}) {
  const [committedWidth, committedHeight] = pngSize(committed);
  const committedHash = md5(committed);

  let best = null;

  search: for (const scale of scales) {
    const target1x = committedWidth / scale;
    if (!Number.isInteger(target1x)) continue;
    const widths = forcedWidth
      ? [forcedWidth]
      : [
          ...new Set([
            target1x,
            ...(await overflowCorrectedWidths(shoot, target1x, heights[0], scale)),
            ...standardWidths,
          ]),
        ].filter((width) => Number.isInteger(width) && width > 0 && width <= target1x);

    for (const width of widths) {
      for (const height of heights) {
        const buffer = await shoot(width, height, scale);
        const [renderedWidth, renderedHeight] = pngSize(buffer);
        if (renderedWidth !== committedWidth) break; // wrong viewport; try the next width
        const settings = { width, height, scale };
        if (md5(buffer) === committedHash) {
          best = { settings, verdict: 'EXACT', heightDelta: 0 };
          break search;
        }
        if (renderedHeight === committedHeight) {
          best = { settings, verdict: 'DIMS', heightDelta: 0 };
          break search;
        }
        // Same width, different height. Keep the NEAREST one rather than the
        // first — the whole of MOTIR-4374 is in this comparison.
        const heightDelta = renderedHeight - committedHeight;
        if (best === null || Math.abs(heightDelta) < Math.abs(best.heightDelta)) {
          best = { settings, verdict: 'DRIFT', heightDelta };
        }
      }
    }
  }

  if (best === null) return { settings: null, verdict: null, heightDelta: null };
  if (best.verdict === 'DRIFT' && isReflow(best.heightDelta, committedHeight)) {
    return { ...best, verdict: 'REFLOW' };
  }
  return best;
}
