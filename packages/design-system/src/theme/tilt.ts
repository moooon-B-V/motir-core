/**
 * Pointer-parallax tilt math for the 3D / Immersive style (Subtask 7.3.39).
 *
 * The standard "3D card" effect (vanilla-tilt.js / react-parallax-tilt /
 * Atropos): a tile tips toward the cursor. Given a tile's bounding rect and the
 * pointer position, this maps the cursor to a pair of rotations:
 *
 *   - `ry` (rotateY) follows the HORIZONTAL position: pointer on the right edge
 *     rotates the tile's right side AWAY (negative is toward the viewer on the
 *     left), so the face turns to follow the cursor.
 *   - `rx` (rotateX) follows the VERTICAL position: pointer near the top tips
 *     the top toward the viewer.
 *
 * Output degrees are clamped to ±`maxDeg`. Pure + DOM-free so it is unit-tested
 * directly; the DOM wiring lives in components/theme/ImmersiveTilt.tsx.
 */

export interface TiltRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Tilt {
  /** rotateX degrees (vertical axis of the cursor). */
  rx: number;
  /** rotateY degrees (horizontal axis of the cursor). */
  ry: number;
  /** Pointer X within the tile, 0..1 (left→right). */
  px: number;
  /** Pointer Y within the tile, 0..1 (top→bottom). */
  py: number;
}

/** Clamp `n` to the inclusive range [min, max]. */
export function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}

/**
 * Map a pointer position over a tile to a tilt. `maxDeg` is the rotation at the
 * tile's edge (the centre is flat, 0°). A zero-area rect returns a flat tilt.
 */
export function tiltFromPointer(
  rect: TiltRect,
  clientX: number,
  clientY: number,
  maxDeg: number,
): Tilt {
  if (rect.width <= 0 || rect.height <= 0) {
    return { rx: 0, ry: 0, px: 0.5, py: 0.5 };
  }
  // 0..1 within the tile, clamped so a pointer just outside the rect (a hover
  // straddling the edge) can't over-rotate past the edge value.
  const px = clamp((clientX - rect.left) / rect.width, 0, 1);
  const py = clamp((clientY - rect.top) / rect.height, 0, 1);
  // Re-centre to -1..1, scale to ±maxDeg.
  const ry = (px - 0.5) * 2 * maxDeg;
  const rx = -(py - 0.5) * 2 * maxDeg;
  return { rx, ry, px, py };
}
