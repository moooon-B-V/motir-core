// The floating Motir orb's DRAG + THROW physics (MOTIR-3214).
//
// Pure — no DOM, no React, no timers. The hook (`lib/hooks/useDraggableOrb.ts`)
// owns pointer capture and the animation frame; everything that decides WHERE the
// orb goes lives here, so the behaviour is unit-testable without a browser and a
// regression is a failing assertion rather than a thing someone has to feel.
//
// ── THE MODEL ───────────────────────────────────────────────────────────────
// A ball in a box. Position and velocity in CSS pixels and px/second; one
// integration step per animation frame, with the frame's real `dt` rather than an
// assumed 60 Hz, so the throw travels the same distance on a 120 Hz display as on
// a 60 Hz one.
//
// Three forces, and each is deliberately simple:
//   * DRAG (air resistance) — an exponential decay applied per SECOND, not per
//     frame. A per-frame multiplier is the classic bug here: it makes the orb
//     slide further on a slow display, because "0.98 per frame" is a different
//     decay at 30 fps than at 144 fps.
//   * RESTITUTION — a wall reflects the perpendicular component and keeps
//     {@link RESTITUTION} of it, AT THE INSTANT THE ORB REACHES THE WALL rather
//     than at the end of whichever frame overshot it. Below
//     {@link MIN_BOUNCE_SPEED} the reflection is dropped entirely, which is what
//     stops an orb resting against an edge from buzzing there forever at
//     sub-pixel amplitude.
//   * REST — under {@link REST_SPEED} the orb stops. Without a floor the decay is
//     asymptotic and the frame loop never ends.
//
// There is no gravity, on purpose: the orb is a floating control, not a toy, and
// a ball that always slides to the bottom of the screen could not be *put*
// anywhere — which is the actual request.

/** A point in viewport CSS pixels — the orb's top-left corner. */
export interface OrbPoint {
  x: number;
  y: number;
}

/** Position + velocity (px/second). */
export interface OrbState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** The rectangle the orb's top-left corner may occupy, inclusive. */
export interface OrbBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** How much of the perpendicular speed survives a wall hit. 0 = dead stop,
 *  1 = perpetual. 0.72 gives the four-or-five diminishing bounces a real ball
 *  makes; the 0.62 it shipped at killed the throw in two and read as a thud. */
export const RESTITUTION = 0.72;

/** Air resistance, as the FRACTION of speed remaining after one second.
 *  Applied as `pow(DRAG_PER_SECOND, dt)`, so it is frame-rate independent.
 *
 *  0.18, not the 0.12 this shipped at. It is a modest change and it is the whole
 *  tuning story: a hard flick now covers ~2450px before the rest floor catches it
 *  rather than ~1980, which is one more full crossing of a 1280px viewport — one
 *  more bounce to watch. Lighter than this reads well in isolation but leaves the
 *  orb rolling around for 3.5s after a flick, which is a long time to wait for a
 *  control to be where you put it. */
export const DRAG_PER_SECOND = 0.18;

/** Below this (px/s) a wall does not bounce the orb — it just clamps. Stops the
 *  sub-pixel jitter of an orb dying against an edge. Kept low enough that the
 *  LAST hop of a dying throw still happens: cutting bounces off at 90 px/s
 *  removed exactly the small, close-together ones that make a ball read as a
 *  ball. It stays above {@link REST_SPEED} / {@link RESTITUTION}, so a bounce
 *  that is allowed always leaves the wall faster than the rest floor — a
 *  reflection that lands the orb straight into "at rest" is a thud, not a hop. */
export const MIN_BOUNCE_SPEED = 60;

/** Below this (px/s) the orb is at rest and the frame loop ends. 40 px/s is two
 *  thirds of a pixel per frame: the point past which the tail of a long throw is
 *  no longer motion anyone can see, and holding the loop open for it just keeps
 *  the compositor busy. */
export const REST_SPEED = 40;

/** A throw slower than this (px/s) is not a throw — the orb stays where it was
 *  released. Keeps a slow, deliberate placement from drifting out from under the
 *  cursor. */
export const MIN_THROW_SPEED = 120;

/** Speed ceiling (px/s). A flick can otherwise produce a four-figure velocity
 *  that crosses the viewport in one frame and reads as teleporting. */
export const MAX_THROW_SPEED = 4200;

/** The gap kept between the orb and the viewport edge, in px — the same 20 px
 *  (`right-5 bottom-5`) the shipped resting position uses, so a thrown orb comes
 *  to rest on the margin it started on. */
export const EDGE_MARGIN = 20;

/** One pointer sample. The hook records these; {@link throwVelocity} reads them. */
export interface PointerSample {
  x: number;
  y: number;
  /** Milliseconds, from any monotonic clock. */
  t: number;
}

/** How far back (ms) {@link throwVelocity} looks. Short enough that only the END
 *  of the gesture counts — a long slow drag that finishes with a flick should
 *  throw, and one that finishes stationary should not. */
export const VELOCITY_WINDOW_MS = 90;

/**
 * The bounds for an orb of `size` px inside a `width × height` viewport.
 * Returns a DEGENERATE (min === max) range on an axis too small to hold the orb
 * plus its margins rather than an inverted one, so `clampToBounds` stays sane on
 * a very small window instead of pinning to a negative maximum.
 */
export function boundsFor(
  viewport: { width: number; height: number },
  size: number,
  margin: number = EDGE_MARGIN,
): OrbBounds {
  const maxX = viewport.width - size - margin;
  const maxY = viewport.height - size - margin;
  return {
    minX: margin,
    minY: margin,
    maxX: Math.max(margin, maxX),
    maxY: Math.max(margin, maxY),
  };
}

export function clampToBounds(p: OrbPoint, b: OrbBounds): OrbPoint {
  return {
    x: Math.min(Math.max(p.x, b.minX), b.maxX),
    y: Math.min(Math.max(p.y, b.minY), b.maxY),
  };
}

/**
 * The release velocity, in px/second, from the tail of the pointer trail.
 *
 * It measures across the whole {@link VELOCITY_WINDOW_MS} window rather than
 * between the last two events, because pointer events are not evenly spaced: two
 * samples 2 ms apart turn a 3 px twitch into 1500 px/s, and that is precisely the
 * moment a user let go without meaning to throw.
 *
 * Returns a zero vector when the trail is too short or the window collapsed.
 */
export function throwVelocity(
  samples: readonly PointerSample[],
  windowMs: number = VELOCITY_WINDOW_MS,
): { vx: number; vy: number } {
  if (samples.length < 2) return { vx: 0, vy: 0 };
  const last = samples[samples.length - 1]!;
  // Walk back while still INSIDE the window and keep the oldest sample that is.
  // (Walking back until the window is EXCEEDED and keeping that one measures the
  // whole gesture instead of its tail — which silently turns a long slow drag
  // that ends in a flick into "no throw".)
  let first = last;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (last.t - samples[i]!.t > windowMs) break;
    first = samples[i]!;
  }
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return { vx: 0, vy: 0 };

  const raw = { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
  const speed = Math.hypot(raw.vx, raw.vy);
  if (speed < MIN_THROW_SPEED) return { vx: 0, vy: 0 };
  if (speed > MAX_THROW_SPEED) {
    const k = MAX_THROW_SPEED / speed;
    return { vx: raw.vx * k, vy: raw.vy * k };
  }
  return raw;
}

/** The longest frame the simulation will run in one go (seconds). A tab restored
 *  from the background hands back a multi-second `dt`. Running it would now be
 *  CORRECT — the solver below resolves walls at the instant of contact and so
 *  cannot tunnel — but it would teleport the orb across the screen in a single
 *  frame, so it is capped at ~4 frames' worth instead. */
export const MAX_STEP_S = 1 / 15;

/** The most wall impacts resolved inside one frame. A corner is two, and a very
 *  fast orb in a narrow window can be three or four; past that the step finishes
 *  with whatever time is left rather than looping. */
const MAX_IMPACTS_PER_STEP = 6;

const LN_DRAG = Math.log(DRAG_PER_SECOND);

/**
 * The displacement, per unit of velocity, over `dt` seconds.
 *
 * ⚠️ THE DISPLACEMENT IS INTEGRATED ANALYTICALLY, NOT AS `v * dt`.
 * With an exponential decay `v(t) = v0 · k^t`, the distance covered over `dt` is
 * `v0 · (k^dt − 1) / ln k`. A Euler step (`x += v · dt`) is only an approximation
 * of that and its error scales with `dt`, so the same throw lands somewhere else
 * at 30 fps than at 144 fps. The closed form is exact at any step, which is what
 * actually makes the behaviour frame-rate independent; decaying the VELOCITY per
 * second is necessary but on its own is not enough.
 *
 * Note the ceiling this implies: a body can never travel further than
 * `v0 · (−1 / ln k)` no matter how long it is left, which is why
 * {@link timeToCover} can answer "it never gets there".
 */
export function travelFactor(dt: number): number {
  return (Math.pow(DRAG_PER_SECOND, dt) - 1) / LN_DRAG;
}

/**
 * When (in seconds) a body with velocity `v` has covered `distance` — the
 * inverse of {@link travelFactor}, and the whole reason a bounce can land ON the
 * wall rather than at the end of whichever frame happened to overshoot it.
 *
 * `null` means it never gets there: it is going the wrong way, it is not moving,
 * or the decay stops it short of the wall.
 */
function timeToCover(distance: number, v: number): number | null {
  if (v === 0) return null;
  const ratio = distance / v;
  if (ratio <= 0) return null; // behind it, or already exactly on the wall
  const inner = 1 + ratio * LN_DRAG;
  if (inner <= 0) return null; // the decay runs out first
  const t = Math.log(inner) / LN_DRAG;
  return Number.isFinite(t) && t >= 0 ? t : null;
}

/** Reflect one axis off a wall it has just reached. Under {@link MIN_BOUNCE_SPEED}
 *  the reflection is dropped and the axis is killed, which is what stops an orb
 *  dying against an edge from buzzing there at sub-pixel amplitude forever. */
function reflect(v: number): { v: number; bounced: boolean } {
  return Math.abs(v) >= MIN_BOUNCE_SPEED
    ? { v: -v * RESTITUTION, bounced: true }
    : { v: 0, bounced: false };
}

/**
 * Advance the orb by `dt` SECONDS.
 *
 * ⚠️ WALLS ARE RESOLVED AT THE INSTANT OF CONTACT, NOT AT THE FRAME BOUNDARY.
 * The obvious implementation — integrate the whole frame, then clamp whatever
 * overshot back onto the wall and reverse it — throws away every pixel of travel
 * between the wall and the overshoot. At 4200 px/s and 60 fps that is up to 70 px
 * of motion deleted at each hit, and the orb visibly STICKS to the edge for a
 * frame before setting off again: the bounce reads as a stutter rather than as a
 * ball. So instead: find the earliest time inside this frame at which an axis
 * reaches its wall ({@link timeToCover}), advance exactly that far, reflect, and
 * spend what is left of the frame on the way back. A corner resolves as two
 * impacts in the same step, in the order they actually happen.
 *
 * `resting: true` means the loop may stop — the caller ends its animation frame
 * and leaves the orb where it is.
 */
export function stepOrb(
  state: OrbState,
  dt: number,
  bounds: OrbBounds,
): { state: OrbState; resting: boolean; bounced: boolean } {
  let remaining = Math.min(Math.max(dt, 0), MAX_STEP_S);
  let { x, y, vx, vy } = state;
  let bounced = false;

  for (let i = 0; i < MAX_IMPACTS_PER_STEP && remaining > 0; i++) {
    const tx = timeToCover((vx < 0 ? bounds.minX : bounds.maxX) - x, vx);
    const ty = timeToCover((vy < 0 ? bounds.minY : bounds.maxY) - y, vy);
    const hit = Math.min(tx ?? Infinity, ty ?? Infinity);
    if (!(hit < remaining)) break; // nothing reaches a wall inside this frame

    const factor = travelFactor(hit);
    const decay = Math.pow(DRAG_PER_SECOND, hit);
    x += vx * factor;
    y += vy * factor;
    vx *= decay;
    vy *= decay;
    remaining -= hit;

    // Whichever axis got there first — both, at a corner. Snapping the axis onto
    // its wall keeps the floating-point residue from re-triggering the same
    // impact with a zero-length step on the next pass.
    if (tx !== null && tx <= hit) {
      x = vx < 0 ? bounds.minX : bounds.maxX;
      const r = reflect(vx);
      vx = r.v;
      bounced ||= r.bounced;
    }
    if (ty !== null && ty <= hit) {
      y = vy < 0 ? bounds.minY : bounds.maxY;
      const r = reflect(vy);
      vy = r.v;
      bounced ||= r.bounced;
    }
  }

  // The rest of the frame, in free flight.
  const factor = travelFactor(remaining);
  const decay = Math.pow(DRAG_PER_SECOND, remaining);
  x += vx * factor;
  y += vy * factor;
  vx *= decay;
  vy *= decay;

  // Belt and braces: a body that started outside its bounds (a resize moved the
  // walls under it) has no impact to solve for and would otherwise stay out.
  const inside = clampToBounds({ x, y }, bounds);
  if (inside.x !== x) vx = 0;
  if (inside.y !== y) vy = 0;

  const resting = Math.hypot(vx, vy) < REST_SPEED;
  return {
    state: { x: inside.x, y: inside.y, vx: resting ? 0 : vx, vy: resting ? 0 : vy },
    resting,
    bounced,
  };
}

/** Pointer travel (px) beyond which a gesture is a DRAG and the click that
 *  follows it is suppressed. Below it the orb was pressed, not moved — 4 px is
 *  the usual slop for a shaky tap and is well under the orb's 56 px. */
export const DRAG_THRESHOLD_PX = 4;
