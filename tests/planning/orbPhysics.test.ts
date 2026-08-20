import { describe, expect, it } from 'vitest';
import {
  DRAG_PER_SECOND,
  EDGE_MARGIN,
  MAX_THROW_SPEED,
  MIN_BOUNCE_SPEED,
  MIN_THROW_SPEED,
  REST_SPEED,
  RESTITUTION,
  boundsFor,
  clampToBounds,
  stepOrb,
  throwVelocity,
  type OrbState,
} from '@/lib/planning/orbPhysics';

// The floating orb's drag + throw physics (MOTIR-3208). Pure module, so this
// asserts the BEHAVIOUR rather than a screenshot: that a throw travels, that a
// wall reflects it, that it comes to rest, and — the ones that are easy to get
// wrong and invisible in review — that it is frame-rate independent and cannot
// tunnel through a wall.

const VIEWPORT = { width: 1280, height: 800 };
const SIZE = 56;
const B = boundsFor(VIEWPORT, SIZE);

/** Run the simulation to rest, returning the final state and the frame count. */
function settle(start: OrbState, fps = 60, maxFrames = 6000) {
  let state = start;
  let frames = 0;
  let bounces = 0;
  for (; frames < maxFrames; frames++) {
    const r = stepOrb(state, 1 / fps, B);
    state = r.state;
    if (r.bounced) bounces++;
    if (r.resting) break;
  }
  return { state, frames, bounces, restedInTime: frames < maxFrames };
}

describe('boundsFor', () => {
  it('keeps the orb a margin away from every edge', () => {
    expect(B).toEqual({
      minX: EDGE_MARGIN,
      minY: EDGE_MARGIN,
      maxX: VIEWPORT.width - SIZE - EDGE_MARGIN,
      maxY: VIEWPORT.height - SIZE - EDGE_MARGIN,
    });
  });

  it('degenerates rather than inverting on a viewport too small for the orb', () => {
    // A 100px-tall window cannot hold a 56px orb plus two 20px margins. The range
    // must collapse to a point, not to max < min — which would make `clampToBounds`
    // pin the orb ABOVE the top of the screen.
    const tiny = boundsFor({ width: 60, height: 60 }, SIZE);
    expect(tiny.maxX).toBeGreaterThanOrEqual(tiny.minX);
    expect(tiny.maxY).toBeGreaterThanOrEqual(tiny.minY);
    expect(clampToBounds({ x: 999, y: 999 }, tiny)).toEqual({ x: EDGE_MARGIN, y: EDGE_MARGIN });
  });
});

describe('throwVelocity', () => {
  it('is zero without enough of a trail to measure', () => {
    expect(throwVelocity([])).toEqual({ vx: 0, vy: 0 });
    expect(throwVelocity([{ x: 0, y: 0, t: 0 }])).toEqual({ vx: 0, vy: 0 });
  });

  it('measures px per SECOND across the window', () => {
    // 90px right over 90ms = 1000 px/s.
    const v = throwVelocity([
      { x: 0, y: 0, t: 0 },
      { x: 90, y: 0, t: 90 },
    ]);
    expect(v.vx).toBeCloseTo(1000, 0);
    expect(v.vy).toBe(0);
  });

  it('IGNORES a slow release — a deliberate placement must not drift', () => {
    // 4px over 90ms ≈ 44 px/s, under the throw floor.
    const v = throwVelocity([
      { x: 0, y: 0, t: 0 },
      { x: 4, y: 0, t: 90 },
    ]);
    expect(Math.hypot(v.vx, v.vy)).toBe(0);
  });

  it('reads the TAIL of a long drag, not the whole gesture', () => {
    // Two seconds of slow travel, then a flick in the last 60ms. Measuring the
    // whole gesture would average the flick away and the orb would not throw.
    const v = throwVelocity([
      { x: 0, y: 0, t: 0 },
      { x: 100, y: 0, t: 2000 },
      { x: 220, y: 0, t: 2060 },
    ]);
    expect(v.vx).toBeGreaterThan(1000);
  });

  it('does NOT let a 2ms twitch become a throw', () => {
    // The reason the window exists: consecutive events can be milliseconds apart,
    // and a 3px jitter between them is 1500px/s if you divide by that alone.
    const trail = [
      { x: 0, y: 0, t: 0 },
      { x: 0, y: 0, t: 40 },
      { x: 0, y: 0, t: 80 },
      { x: 3, y: 0, t: 82 },
    ];
    expect(Math.hypot(...Object.values(throwVelocity(trail)))).toBeLessThan(MIN_THROW_SPEED);
  });

  it('CAPS a flick so it cannot cross the viewport in one frame', () => {
    const v = throwVelocity([
      { x: 0, y: 0, t: 0 },
      { x: 9000, y: 0, t: 20 },
    ]);
    expect(Math.hypot(v.vx, v.vy)).toBeCloseTo(MAX_THROW_SPEED, 5);
  });

  it('returns zero when the window collapsed to no elapsed time', () => {
    expect(
      throwVelocity([
        { x: 0, y: 0, t: 5 },
        { x: 50, y: 0, t: 5 },
      ]),
    ).toEqual({ vx: 0, vy: 0 });
  });
});

describe('stepOrb — a thrown orb travels, bounces and settles', () => {
  it('carries a hard throw across the screen and comes to rest inside the bounds', () => {
    const r = settle({ x: B.minX, y: 400, vx: 2600, vy: 0 });
    expect(r.restedInTime).toBe(true);
    expect(r.state.x).toBeGreaterThanOrEqual(B.minX);
    expect(r.state.x).toBeLessThanOrEqual(B.maxX);
    expect(Math.hypot(r.state.vx, r.state.vy)).toBe(0);
  });

  it('BOUNCES off a wall — the perpendicular component reverses and loses energy', () => {
    // One frame that would overshoot the right wall.
    const before = { x: B.maxX - 5, y: 300, vx: 1800, vy: 0 };
    const r = stepOrb(before, 1 / 60, B);
    expect(r.bounced).toBe(true);
    expect(r.state.vx).toBeLessThan(0); // reversed
    expect(Math.abs(r.state.vx)).toBeLessThan(1800 * RESTITUTION + 1); // and damped
    // ⚠️ AND IT IS ALREADY ON ITS WAY BACK (MOTIR-3214). It hits the wall 5px in,
    // ~3ms into a 16ms frame, and spends the other 13ms travelling away from it —
    // so it ends the frame well INSIDE the box, not pinned to the wall. The
    // version that clamped x to `maxX` here deleted that travel at every hit, and
    // the orb visibly stuck to the edge for a frame before setting off.
    expect(r.state.x).toBeLessThan(B.maxX - 5);
    expect(r.state.x).toBeGreaterThan(B.minX);
  });

  it('DELETES NO TRAVEL at a bounce — one big step equals 64 small ones', () => {
    // The invariant the frame-boundary clamp broke, stated as the thing a
    // continuous solver is FOR: the answer must not depend on where the frame
    // boundaries fall. Sixty-four sub-steps put a boundary practically on the
    // impact, so they are the reference the single step has to match.
    //
    // This is the assertion that fails loudest on the old code: clamping pinned
    // the single step to `maxX` and threw its remaining 13ms of travel away, while
    // the 64-step run bounced properly and ended ~19px back inside the box.
    const dt = 1 / 60;
    const start: OrbState = { x: B.maxX - 5, y: 300, vx: 1800, vy: 0 };

    const one = stepOrb(start, dt, B).state;
    let many: OrbState = start;
    for (let i = 0; i < 64; i++) many = stepOrb(many, dt / 64, B).state;

    expect(one.x).toBeCloseTo(many.x, 3);
    expect(one.vx).toBeCloseTo(many.vx, 3);
    // And it really did bounce in there, rather than both agreeing on "stuck".
    expect(one.vx).toBeLessThan(0);
    expect(one.x).toBeLessThan(B.maxX - 5);
  });

  it('bounces off BOTH walls in one frame at a corner', () => {
    // Resolving the earliest impact first — and then the next one — is what makes
    // a corner work; clamping the velocity first would make it stick.
    const r = stepOrb({ x: B.maxX - 2, y: B.maxY - 2, vx: 1500, vy: 1500 }, 1 / 60, B);
    expect(r.bounced).toBe(true);
    expect(r.state.vx).toBeLessThan(0);
    expect(r.state.vy).toBeLessThan(0);
    // Both axes turned round and both are travelling back into the box.
    expect(r.state.x).toBeLessThan(B.maxX - 2);
    expect(r.state.y).toBeLessThan(B.maxY - 2);
  });

  it('GIVES UP GRACEFULLY on a frame with more impacts than it will solve', () => {
    // A 40px-wide slot at 4200px/s is ~7 crossings in a 1/15s frame, past the
    // solver's per-step budget. The orb must still end up inside its bounds and
    // still be moving sanely; what it must NOT do is loop, or exit the box.
    const slot = { minX: 20, maxX: 60, minY: 20, maxY: 720 };
    const r = stepOrb({ x: 40, y: 400, vx: MAX_THROW_SPEED, vy: 0 }, 1 / 15, slot);
    expect(r.state.x).toBeGreaterThanOrEqual(slot.minX);
    expect(r.state.x).toBeLessThanOrEqual(slot.maxX);
    expect(Number.isFinite(r.state.vx)).toBe(true);
  });

  it('does not invent an impact the orb can never reach — the decay runs out first', () => {
    // A nudge, not a throw, aimed at a wall 1000px away. The exponential decay
    // caps total travel at `v / -ln(DRAG_PER_SECOND)`, so this one dies in free
    // flight — and the solver must say "no impact" rather than solve for a
    // crossing that never happens.
    const r = stepOrb({ x: 200, y: 400, vx: 50, vy: 0 }, 1 / 60, B);
    expect(r.bounced).toBe(false);
    expect(r.state.x).toBeGreaterThan(200);
    expect(r.state.x).toBeLessThan(B.maxX);
  });

  it('RECOVERS an orb the walls moved past — a resize does not strand it outside', () => {
    // Nothing collides on the way OUT, because it was already out: the window got
    // narrower under a resting orb. The step has no impact to solve and must fall
    // back to putting it back inside and killing the axis that was stranded.
    const r = stepOrb({ x: B.maxX + 300, y: B.maxY + 120, vx: 0, vy: 0 }, 1 / 60, B);
    expect(r.state.x).toBe(B.maxX);
    expect(r.state.y).toBe(B.maxY);
    expect(r.state.vx).toBe(0);
    expect(r.state.vy).toBe(0);

    // And the same orb still DRIFTING further out: the wall it would be tested
    // against is behind it, so there is no crossing to solve for — it must be
    // recovered by the same fallback rather than by an impact.
    const moving = stepOrb({ x: B.maxX + 300, y: 400, vx: 200, vy: 0 }, 1 / 60, B);
    expect(moving.state.x).toBe(B.maxX);
    expect(moving.state.vx).toBe(0);
    expect(moving.bounced).toBe(false);
  });

  it('resolves SEVERAL impacts inside one frame — a slow display is not a different game', () => {
    // 1/15s at 3800px/s is 250px of travel in a 200px-wide box: the orb must cross
    // it, turn, cross back and turn again within the single step. The clamping
    // version resolved at most one wall per axis per frame and simply lost the
    // rest, which is why the same throw landed somewhere else at 30fps.
    const narrow = { minX: 20, maxX: 220, minY: 20, maxY: 720 };
    const r = stepOrb({ x: 100, y: 400, vx: 3800, vy: 0 }, 1 / 15, narrow);
    expect(r.bounced).toBe(true);
    expect(r.state.x).toBeGreaterThanOrEqual(narrow.minX);
    expect(r.state.x).toBeLessThanOrEqual(narrow.maxX);
  });

  it('does NOT bounce a slow drift into the wall — it stops there, so nothing buzzes', () => {
    const r = stepOrb({ x: B.maxX - 0.5, y: 300, vx: MIN_BOUNCE_SPEED - 10, vy: 0 }, 1 / 60, B);
    expect(r.state.x).toBe(B.maxX);
    expect(r.state.vx).toBe(0);
    expect(r.bounced).toBe(false);
  });

  it('applies the same slow-drift rule on the VERTICAL axis', () => {
    // The two axes are resolved by separate blocks, so "x is right" is not
    // evidence that y is — and a copy-paste slip between them would be invisible
    // in a horizontal-only suite.
    const r = stepOrb({ x: 400, y: B.maxY - 0.5, vx: 0, vy: MIN_BOUNCE_SPEED - 10 }, 1 / 60, B);
    expect(r.state.y).toBe(B.maxY);
    expect(r.state.vy).toBe(0);
    expect(r.bounced).toBe(false);
  });

  it('NEVER leaves the bounds, at any speed or frame rate', () => {
    for (const speed of [400, 2000, MAX_THROW_SPEED]) {
      for (const fps of [15, 30, 60, 144]) {
        for (const dir of [-1, 1]) {
          let s: OrbState = { x: 400, y: 400, vx: speed * dir, vy: speed * -dir };
          for (let i = 0; i < 900; i++) {
            const r = stepOrb(s, 1 / fps, B);
            s = r.state;
            expect(s.x).toBeGreaterThanOrEqual(B.minX);
            expect(s.x).toBeLessThanOrEqual(B.maxX);
            expect(s.y).toBeGreaterThanOrEqual(B.minY);
            expect(s.y).toBeLessThanOrEqual(B.maxY);
            if (r.resting) break;
          }
        }
      }
    }
  });

  it('CANNOT TUNNEL through a wall on a huge dt — a backgrounded tab is capped', () => {
    // A restored tab hands back seconds, not milliseconds. Uncapped, the orb
    // would integrate straight past the far wall and be clamped to the WRONG side.
    const r = stepOrb({ x: B.minX, y: 400, vx: MAX_THROW_SPEED, vy: 0 }, 12, B);
    expect(r.state.x).toBeLessThanOrEqual(B.maxX);
    expect(r.state.x).toBeGreaterThanOrEqual(B.minX);
  });

  it('is FRAME-RATE INDEPENDENT for a free throw — 30 fps and 144 fps land together', () => {
    // The classic bug is a per-FRAME drag multiplier; the subtler one is a Euler
    // step, whose error scales with dt even when the decay is per-second. This
    // throw never reaches a wall, so it isolates the INTEGRATION.
    //
    // SUB-PIXEL, not exact, and the residue is honest: the loop stops when the
    // speed crosses REST_SPEED, and that crossing lands at a frame boundary — so
    // the final partial step differs slightly by frame rate. With the Euler step
    // the gap was ~19px; with the closed form it is ~0.3px, which is the
    // difference between "depends on your display" and "does not".
    const start: OrbState = { x: 500, y: 400, vx: 900, vy: -200 };
    const a = settle(start, 30).state;
    const b = settle(start, 144).state;
    expect(a.x).toBeCloseTo(b.x, 0);
    expect(a.y).toBeCloseTo(b.y, 0);
  });

  it('lands a BOUNCING throw in the same place at 30 and 144 fps', () => {
    // ⚠️ THIS TOLERANCE USED TO BE 24px (MOTIR-3214). A collision resolved at the
    // FRAME BOUNDARY deletes however much overshoot that frame happened to have,
    // and a 30fps frame overshoots four times as far as a 144fps one — so the
    // display genuinely changed where the orb ended up. Resolving at the instant
    // of contact removes the frame rate from the answer, and the residue left is
    // the same sub-pixel rest cut-off the free-throw case above measures.
    const start: OrbState = { x: 300, y: 300, vx: 2400, vy: -1500 };
    const a = settle(start, 30).state;
    const b = settle(start, 144).state;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(2);
  });

  it('always reaches rest — the decay has a floor, so the loop terminates', () => {
    const r = settle({ x: 500, y: 500, vx: MAX_THROW_SPEED, vy: MAX_THROW_SPEED });
    expect(r.restedInTime).toBe(true);
    // And it settles quickly enough to feel like a throw, not a drift.
    expect(r.frames).toBeLessThan(60 * 4);
  });

  it('reports rest exactly when the speed drops under the floor', () => {
    const moving = stepOrb({ x: 400, y: 400, vx: REST_SPEED * 8, vy: 0 }, 1 / 60, B);
    expect(moving.resting).toBe(false);
    const dying = stepOrb({ x: 400, y: 400, vx: REST_SPEED - 1, vy: 0 }, 1 / 60, B);
    expect(dying.resting).toBe(true);
    expect(dying.state.vx).toBe(0);
  });

  it('treats a negative or zero dt as no time passing', () => {
    const s: OrbState = { x: 400, y: 400, vx: 800, vy: 0 };
    expect(stepOrb(s, 0, B).state.x).toBe(400);
    expect(stepOrb(s, -5, B).state.x).toBe(400);
  });

  it('decays toward the documented per-second fraction', () => {
    // One second of pure drag from 1000px/s, integrated at 60fps, should leave
    // about DRAG_PER_SECOND of the speed. (Not exact: the orb also stops at REST.)
    let s: OrbState = { x: 400, y: 400, vx: 1000, vy: 0 };
    for (let i = 0; i < 60; i++) s = stepOrb(s, 1 / 60, B).state;
    expect(Math.abs(s.vx)).toBeLessThan(1000 * DRAG_PER_SECOND + 1);
  });
});
