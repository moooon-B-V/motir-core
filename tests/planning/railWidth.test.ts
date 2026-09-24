import { describe, expect, it } from 'vitest';
import {
  clampRailWidth,
  defaultRailWidth,
  isSplittable,
  railBounds,
  RAIL_DEFAULT_CROSSOVER_PX,
  RAIL_DEFAULT_FRACTION,
  RAIL_KEYBOARD_COARSE_STEP_PX,
  RAIL_KEYBOARD_STEP_PX,
  RAIL_MAX_FRACTION,
  RAIL_MIN_PX,
  RAIL_RESET_DURATION_MS,
  SPLIT_MIN_CONTAINER_PX,
} from '@/lib/planning/railWidth';

// MOTIR-6250 — the resizable planning split's GEOMETRY.
//
// Every number here is MOTIR-6249's approved design result, so these are not
// re-derivations: they pin the numbers the design settled, and the table below is
// the same table its notes carry, so a drift in either is a failure here.

describe('the design’s numbers', () => {
  it('holds the six settled values', () => {
    expect(RAIL_MIN_PX).toBe(352); // 22rem, the shipped width
    expect(RAIL_DEFAULT_FRACTION).toBeCloseTo(1 / 3, 10);
    expect(RAIL_MAX_FRACTION).toBe(0.5);
    expect(SPLIT_MIN_CONTAINER_PX).toBe(768); // Tailwind `md`, already shipping
    expect(RAIL_KEYBOARD_STEP_PX).toBe(16);
    expect(RAIL_KEYBOARD_COARSE_STEP_PX).toBe(64);
  });

  it('the reset duration matches the STATIC Tailwind class the frame uses', () => {
    // `PlanningResizableFrame` cannot interpolate this into a class — Tailwind
    // scans source text, so `duration-[${N}ms]` emits no rule at all. It uses
    // `duration-200`, and this is what stops the two drifting apart.
    expect(RAIL_RESET_DURATION_MS).toBe(200);
  });

  it('the crossover is 1056px — where a third first reaches the floor', () => {
    expect(RAIL_DEFAULT_CROSSOVER_PX).toBe(1056);
    expect(defaultRailWidth(RAIL_DEFAULT_CROSSOVER_PX)).toBe(RAIL_MIN_PX);
  });
});

describe('defaultRailWidth — the table in the design’s notes', () => {
  // viewport/container → conversation, canvas. The plan-page row is the split
  // container `lib/planning/planView.ts` measured (1440 viewport − the app shell).
  const rows: ReadonlyArray<[container: number, rail: number]> = [
    [1440, 480],
    [1280, 1280 / 3],
    [1152, 384],
    [1056, 352],
    [1024, 352], // a third is 341.33 — CLAMPED up to the floor
    [900, 352],
    [768, 352],
    [1134, 378], // the plan page's container at a 1440 viewport
  ];

  it.each(rows)('a %ipx container opens the conversation at %fpx', (container, rail) => {
    expect(defaultRailWidth(container)).toBeCloseTo(rail, 6);
  });

  it('is a no-op against the SHIPPED width for every container up to the crossover', () => {
    // The claim the design makes, asserted rather than restated: between `md` and
    // 1056px this change moves nothing, because the default clamps to 22rem.
    for (let c = SPLIT_MIN_CONTAINER_PX; c <= RAIL_DEFAULT_CROSSOVER_PX; c += 16) {
      expect(defaultRailWidth(c)).toBe(RAIL_MIN_PX);
    }
  });

  it('gives the canvas two-thirds once past the crossover', () => {
    expect(1440 - defaultRailWidth(1440)).toBe(960);
    expect(defaultRailWidth(1440) / 1440).toBeCloseTo(1 / 3, 6);
  });
});

describe('railBounds', () => {
  it('is [352, half] on a wide container', () => {
    expect(railBounds(1440)).toEqual({ min: 352, max: 720 });
  });

  it('never returns a min above its max, even where half is under the floor', () => {
    // At 600px half is 300px, under the 352px floor. A naive `min: 352` would make
    // every clamp return a width wider than the maximum.
    const { min, max } = railBounds(600);
    expect(min).toBeLessThanOrEqual(max);
    expect(max).toBe(300);
  });
});

describe('clampRailWidth — THE ONE CLAMP', () => {
  it('holds each bound', () => {
    expect(clampRailWidth(10, 1440)).toBe(352);
    expect(clampRailWidth(9999, 1440)).toBe(720);
    expect(clampRailWidth(500, 1440)).toBe(500);
  });

  it('re-clamps a width stored on a LARGER monitor into this container', () => {
    // 900px was legal on a 2560px monitor (max 1280); on a 1440px laptop it is not.
    expect(clampRailWidth(900, 2560)).toBe(900);
    expect(clampRailWidth(900, 1440)).toBe(720);
  });

  it('answers the DEFAULT for any non-finite width, not a bound', () => {
    // `NaN` and `±Infinity` are all corrupt input rather than an extreme
    // intention — a parse that went wrong, a measurement taken before layout. The
    // safe answer is the width the surface would have opened at, not the maximum:
    // clamping `Infinity` to the max would silently hand somebody the widest
    // possible conversation because a number failed to parse.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(clampRailWidth(bad, 1440)).toBe(defaultRailWidth(1440));
    }
  });
});

describe('isSplittable', () => {
  it('splits at and above `md`, and not below', () => {
    expect(isSplittable(768)).toBe(true);
    expect(isSplittable(767)).toBe(false);
  });
});
