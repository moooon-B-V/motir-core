// The floating Motir orb's DRAG + THROW physics (MOTIR-3208).
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
//     {@link RESTITUTION} of it. Below {@link MIN_BOUNCE_SPEED} the reflection is
//     dropped entirely, which is what stops an orb resting against an edge from
//     buzzing there forever at sub-pixel amplitude.
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
 *  1 = perpetual. 0.62 reads as "a ball", not "a superball": two or three
 *  visible bounces off a hard throw, then it settles. */
export const RESTITUTION = 0.62;

/** Air resistance, as the FRACTION of speed remaining after one second.
 *  Applied as `pow(DRAG_PER_SECOND, dt)`, so it is frame-rate independent. */
export const DRAG_PER_SECOND = 0.12;

/** Below this (px/s) a wall does not bounce the orb — it just clamps. Stops the
 *  sub-pixel jitter of an orb dying against an edge. */
export const MIN_BOUNCE_SPEED = 90;

/** Below this (px/s) the orb is at rest and the frame loop ends. */
export const REST_SPEED = 26;

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

/**
 * Advance the orb by `dt` SECONDS.
 *
 * Integrate, then resolve each wall independently: reflect the perpendicular
 * component, keep {@link RESTITUTION} of it, and place the orb exactly on the
 * wall. Resolving after integrating (rather than clamping the velocity first) is
 * what makes a corner hit bounce off both walls in the same frame instead of
 * sticking.
 *
 * `resting: true` means the loop may stop — the caller ends its animation frame
 * and leaves the orb where it is.
 */
export function stepOrb(
  state: OrbState,
  dt: number,
  bounds: OrbBounds,
): { state: OrbState; resting: boolean; bounced: boolean } {
  // A tab restored from the background can hand back a multi-second `dt`, which
  // would tunnel the orb clean through a wall. Cap it at ~4 frames.
  const step = Math.min(Math.max(dt, 0), 1 / 15);

  // ⚠️ THE DISPLACEMENT IS INTEGRATED ANALYTICALLY, NOT AS `v * dt`.
  // With an exponential decay `v(t) = v0 · k^t`, the distance covered over `dt` is
  // `v0 · (k^dt − 1) / ln k`. A Euler step (`x += v · dt`) is only an
  // approximation of that, and its error scales with `dt` — so the same throw
  // lands somewhere else at 30 fps than at 144 fps. The closed form is exact at
  // any step, which is what actually makes the behaviour frame-rate independent;
  // decaying the VELOCITY per second is necessary but on its own is not enough.
  const decay = Math.pow(DRAG_PER_SECOND, step);
  const travel = (decay - 1) / Math.log(DRAG_PER_SECOND);
  let x = state.x + state.vx * travel;
  let y = state.y + state.vy * travel;
  let vx = state.vx * decay;
  let vy = state.vy * decay;
  let bounced = false;

  if (x < bounds.minX || x > bounds.maxX) {
    x = x < bounds.minX ? bounds.minX : bounds.maxX;
    if (Math.abs(vx) >= MIN_BOUNCE_SPEED) {
      vx = -vx * RESTITUTION;
      bounced = true;
    } else {
      vx = 0;
    }
  }
  if (y < bounds.minY || y > bounds.maxY) {
    y = y < bounds.minY ? bounds.minY : bounds.maxY;
    if (Math.abs(vy) >= MIN_BOUNCE_SPEED) {
      vy = -vy * RESTITUTION;
      bounced = true;
    } else {
      vy = 0;
    }
  }

  const resting = Math.hypot(vx, vy) < REST_SPEED;
  return { state: { x, y, vx: resting ? 0 : vx, vy: resting ? 0 : vy }, resting, bounced };
}

/** Pointer travel (px) beyond which a gesture is a DRAG and the click that
 *  follows it is suppressed. Below it the orb was pressed, not moved — 4 px is
 *  the usual slop for a shaky tap and is well under the orb's 56 px. */
export const DRAG_THRESHOLD_PX = 4;
