import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSETS,
  EASE_START,
  assetContents,
  easeToVertical,
  segments,
} from '../../scripts/brand/generate-wave-band.mjs';

// MOTIR-3181 — the artwork is GENERATED, so the committed files must equal what
// the generator currently emits. Same guard shape as `iconAssets.test.ts` puts on
// the rasters, and the reason is the same: the path is ~180 bytes of coordinates,
// so a hand-edit renders something plausible rather than nothing and no visual
// review would catch a digit.
//
// It also pins the two PROPERTIES the refinement exists for, as properties rather
// than as fixtures — a coordinate assertion would pass a regenerated file that had
// silently lost them.

const REPO = process.cwd();

describe('the committed artwork is the generator’s output', () => {
  for (const spec of ASSETS) {
    it(`${spec.file} is byte-identical to what the generator emits`, () => {
      expect(readFileSync(join(REPO, spec.file), 'utf8')).toBe(assetContents(spec));
    });
  }
});

describe('the eased tail meets the cap tangent-vertically', () => {
  it('places the tail’s control ON the cap line, which is what makes it vertical', () => {
    // A quadratic's end tangent is `E - C`. The tail is constructed by intersecting
    // the split point's tangent with the cap's vertical line, so this is the
    // construction's defining property, not a measured coincidence.
    const right = easeToVertical(
      [
        [416, 134],
        [608, -228],
        [768, 384],
      ],
      768,
    );
    expect(right.tail[1][0]).toBe(768);
    expect(right.tail[2]).toEqual([768, 384]);
  });

  it('keeps the split point ON the original curve, so the head is unchanged', () => {
    // The head is the de Casteljau restriction of the original quadratic: the
    // silhouette before the ease must not move at all.
    const q = [
      [416, 134],
      [608, -228],
      [768, 384],
    ] as const;
    const { head, tail } = easeToVertical(q, 768);
    expect(head[0]).toEqual(q[0]);
    expect(head[2]).toEqual(tail[0]);
    const u = 1 - EASE_START;
    const onCurve = [
      u * u * q[0][0] + 2 * u * EASE_START * q[1][0] + EASE_START ** 2 * q[2][0],
      u * u * q[0][1] + 2 * u * EASE_START * q[1][1] + EASE_START ** 2 * q[2][1],
    ];
    expect(head[2][0]).toBeCloseTo(onCurve[0]!, 9);
    expect(head[2][1]).toBeCloseTo(onCurve[1]!, 9);
  });

  it('is TANGENT-CONTINUOUS at every join — no corner anywhere but the two terminals', () => {
    const segs = segments();
    const endT = (s: (typeof segs)[number]) => [s[2][0] - s[1][0], s[2][1] - s[1][1]] as const;
    const startT = (s: (typeof segs)[number]) => [s[1][0] - s[0][0], s[1][1] - s[0][1]] as const;
    const angle = (a: readonly number[], b: readonly number[]) =>
      Math.abs(
        (Math.atan2(a[0]! * b[1]! - a[1]! * b[0]!, a[0]! * b[0]! + a[1]! * b[1]!) * 180) / Math.PI,
      );

    for (let i = 0; i < segs.length - 1; i++) {
      // Skip the pair that straddles the right cap — that terminal IS a corner.
      if (segs[i]![2][0] !== segs[i + 1]![0][0] || segs[i]![2][1] !== segs[i + 1]![0][1]) continue;
      expect(angle(endT(segs[i]!), startT(segs[i + 1]!)), `join ${i}`).toBeLessThan(0.001);
    }
  });

  it('arrives at BOTH caps exactly vertical', () => {
    const segs = segments();
    const vertical = segs.filter((s) => s[2][0] === 768 || s[2][0] === 0);
    expect(vertical).toHaveLength(2);
    for (const s of vertical) {
      expect(s[1][0], 'control on the cap line').toBe(s[2][0]);
      expect(s[2][1], 'the junction is the frame’s vertical midpoint').toBe(384);
    }
  });
});
