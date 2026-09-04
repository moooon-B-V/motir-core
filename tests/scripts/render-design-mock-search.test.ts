import { describe, expect, it } from 'vitest';
import {
  REFLOW_DELTA_RATIO,
  isReflow,
  searchRenderSettings,
} from '../../scripts/renderDesignMockSearch.mjs';

// MOTIR-4374 — the viewport search in `scripts/render-design-mock.mjs`, and the
// reason it needed a test at all.
//
// The search recovers an asset's render settings by probing viewports until one
// reproduces the committed PNG's WIDTH. A width match does not identify a
// viewport: at `deviceScaleFactor: 2` the probe is HALF the committed width and
// the scale factor doubles the output back to it, so a 1×-exported asset with an
// even width has TWO width-matching candidates — its real 1× viewport, and a 2×
// render at half of it, which REFLOWS the document. The loop remembered the
// FIRST match (`settings ??= …`) and never replaced it, and it tries `2` before
// `1`, so it took the reflowed one every time.
//
// Measured on `origin/main` @ `37b7910`, both rows of `design/ai-chat/
// target-picker.mock.html` against its committed 1200×2932 export:
//
//   DRIFT  600x900@2x    new=1200x8206   ← what the search chose (+182%)
//   DRIFT  1200x900@1x   new=1200x2872   ← what --width 1200 finds  (−2%)
//
// A DRIFT verdict is one the script's own header teaches you to expect and to
// attribute to the render environment, so nothing about that first row reads as
// wrong — and dropping `--verify` writes the 8206px image over the asset.
//
// These specs drive the selection with a fake renderer rather than a browser:
// what is under test is which candidate the search KEEPS, and that is a pure
// comparison over dimensions the search already measures.

/**
 * A PNG-shaped buffer: the search reads only the IHDR width/height at bytes
 * 16 and 20, plus the whole buffer's md5 for the EXACT verdict. `salt` is what
 * makes two same-dimension renders differ in bytes, which is the DIMS case.
 */
const png = (width: number, height: number, salt = 0): Buffer => {
  const buffer = Buffer.alloc(25);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer.writeUInt8(salt, 24);
  return buffer;
};

/** The committed export this whole file is about: `target-picker.png`. */
const COMMITTED = png(1200, 2932, 1);

/**
 * A renderer keyed on the viewport it is asked for. Every spec below passes
 * `heights: [900]` and a single-entry `standardWidths`, so the probe order is
 * exactly: `600@2x` (the half-width candidate), then `1200@1x`.
 */
const renderer = (table: Record<string, Buffer>) => {
  const calls: string[] = [];
  const shoot = (width: number, height: number, scale: number) => {
    const key = `${width}x${height}@${scale}x`;
    calls.push(key);
    const buffer = table[key];
    if (!buffer) throw new Error(`no fixture render for ${key}`);
    return Promise.resolve(buffer);
  };
  return { shoot, calls };
};

const OPTIONS = { heights: [900], standardWidths: [1200] };

describe('the design-mock viewport search (MOTIR-4374)', () => {
  it('takes the HEIGHT-NEAREST width match, not the first one found', async () => {
    // The regression, as the reproduction measured it. Both candidates render
    // 1200px wide, so the width test — the only test the old loop applied —
    // passes on both; only the heights tell them apart.
    const { shoot } = renderer({
      '600x900@2x': png(1200, 8206),
      '1200x900@1x': png(1200, 2872),
    });

    const result = await searchRenderSettings({ shoot, committed: COMMITTED, ...OPTIONS });
    expect(result.settings).toEqual({ width: 1200, height: 900, scale: 1 });
    expect(result.verdict).toBe('DRIFT');
    expect(result.heightDelta).toBe(-60);
  });

  it('is not a re-ORDERING — the nearer candidate wins from either side', async () => {
    // The mirror case the card names as the reason `DEVICE_SCALE_FACTORS =
    // [1, 2]` would not have been a fix: here the 2× candidate is the right one,
    // and it is FIRST. A selection rule that merely preferred 1× would trade
    // this defect for its twin.
    const { shoot } = renderer({
      '600x900@2x': png(1200, 2900),
      '1200x900@1x': png(1200, 9000),
    });

    const result = await searchRenderSettings({ shoot, committed: COMMITTED, ...OPTIONS });
    expect(result.settings).toEqual({ width: 600, height: 900, scale: 2 });
    expect(result.heightDelta).toBe(-32);
  });

  it('compares on the HEIGHT axis too — the second instance the fix surfaced', async () => {
    // `design/ai-chat/canvas-spatial.png` (2560×1520) is a 2× asset, so the
    // scale-factor half of this defect cannot touch it — and the old loop
    // mis-recovered it anyway, through the viewport HEIGHT. Its export was made
    // at an 800px viewport; the loop tried 900 first, remembered it, and threw
    // 800 away. Measured on this branch:
    //
    //   --height 900 (the old behaviour)  Δbaseline=+280px (+18%)
    //   the search as it now stands        Δbaseline= +80px  (+5%)
    //
    // So the affected class is "every asset whose settings the search reaches
    // second", on either axis — wider than the 1×-export class the card names.
    const { shoot } = renderer({
      '1280x900@2x': png(2560, 1800),
      '1280x800@2x': png(2560, 1600),
    });

    const result = await searchRenderSettings({
      shoot,
      committed: png(2560, 1520, 1),
      heights: [900, 800],
      scales: [2],
      standardWidths: [1280],
    });
    expect(result.settings).toEqual({ width: 1280, height: 800, scale: 2 });
    expect(result.heightDelta).toBe(80);
  });

  it('keeps the EXACT early exit — byte-identical wins and the search STOPS', async () => {
    // AC 2's other half. The old loop's `break search` on EXACT is why the
    // defect only ever bit assets that reproduce NEITHER exactly nor at the same
    // dimensions, and widening the search must not have cost that exit.
    const { shoot, calls } = renderer({
      '600x900@2x': COMMITTED,
      '1200x900@1x': png(1200, 2932, 9),
    });

    const result = await searchRenderSettings({ shoot, committed: COMMITTED, ...OPTIONS });
    expect(result.verdict).toBe('EXACT');
    expect(result.settings).toEqual({ width: 600, height: 900, scale: 2 });
    expect(result.heightDelta).toBe(0);
    // The overflow probe at 600 plus the matching render at 600 — and nothing
    // at 1× at all, because the search stopped.
    expect(calls).toEqual(['600x900@2x', '600x900@2x']);
  });

  it('keeps the DIMS early exit — same dimensions, different bytes, and STOPS', async () => {
    const { shoot, calls } = renderer({
      '600x900@2x': png(1200, 2932, 7),
      '1200x900@1x': png(1200, 2872),
    });

    const result = await searchRenderSettings({ shoot, committed: COMMITTED, ...OPTIONS });
    expect(result.verdict).toBe('DIMS');
    expect(result.settings).toEqual({ width: 600, height: 900, scale: 2 });
    expect(calls).toEqual(['600x900@2x', '600x900@2x']);
  });

  it('reports a GROSSLY distant best candidate as REFLOW, not as an ordinary DRIFT', async () => {
    // AC 3. When every width match reflows, the search has nothing better to
    // offer — and the run that reads `DRIFT` there is being told the delta
    // belongs to the render environment, which is what let a 182% reflow land
    // on disk. The verdict has to say otherwise.
    const { shoot } = renderer({
      '600x900@2x': png(1200, 8206),
      '1200x900@1x': png(1200, 7000),
    });

    const result = await searchRenderSettings({ shoot, committed: COMMITTED, ...OPTIONS });
    expect(result.verdict).toBe('REFLOW');
    expect(result.settings).toEqual({ width: 1200, height: 900, scale: 1 });
    expect(result.heightDelta).toBe(4068);
  });

  it('leaves the documented environment gap an ordinary DRIFT', async () => {
    // The other side of the same line, and the one that matters for cost: the
    // header documents every pre-2026-06-20 export as drifting, so a threshold
    // that caught those would refuse to re-export most of the tree. 60px on
    // 2932 is 2%; the bar is 25%.
    const { shoot } = renderer({
      '600x900@2x': png(1200, 8206),
      '1200x900@1x': png(1200, 2872),
    });

    const result = await searchRenderSettings({ shoot, committed: COMMITTED, ...OPTIONS });
    expect(result.verdict).toBe('DRIFT');
    expect(isReflow(result.heightDelta, 2932)).toBe(false);
  });

  it('reports no settings at all when nothing reproduces the committed WIDTH', async () => {
    const { shoot } = renderer({
      '600x900@2x': png(900, 4000),
      '1200x900@1x': png(900, 4000),
    });

    const result = await searchRenderSettings({ shoot, committed: COMMITTED, ...OPTIONS });
    expect(result.settings).toBeNull();
    expect(result.verdict).toBeNull();
  });

  it('honours a FORCED width — the operator states the viewport, the search does not hunt', async () => {
    // `--width` is how MOTIR-4346 worked around this defect on one asset, and
    // it stays the override for a REFLOW the search cannot resolve. Forcing
    // 1200 renders it at both scales; only the 1× one is 1200px wide.
    const { shoot } = renderer({
      '1200x900@2x': png(2400, 5744),
      '1200x900@1x': png(1200, 2872),
    });

    const result = await searchRenderSettings({
      shoot,
      committed: COMMITTED,
      forcedWidth: 1200,
      ...OPTIONS,
    });
    expect(result.settings).toEqual({ width: 1200, height: 900, scale: 1 });
    expect(result.verdict).toBe('DRIFT');
  });

  it('draws the reflow line where the constant says, in both directions', () => {
    // The threshold is a number in a module, so it is worth one spec that fails
    // if it is moved without the reasoning above being revisited.
    expect(REFLOW_DELTA_RATIO).toBe(0.25);
    expect(isReflow(733, 2932)).toBe(false); // exactly 25% — still a gap
    expect(isReflow(734, 2932)).toBe(true);
    expect(isReflow(-734, 2932)).toBe(true); // shorter reflows too
    expect(isReflow(0, 2932)).toBe(false);
  });
});
