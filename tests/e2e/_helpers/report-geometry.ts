// Two small pure helpers for the refined-reports acceptance spec (MOTIR-8931).
// Measurements come from the browser; the verdicts are decided here so they can
// be read (and unit-tested) without a page.

/** A text label's outline in page pixels: four corners, rotation included. */
export type Quad = Array<{ x: number; y: number }>;

/** Do two convex quads overlap? Separating-axis test, so a label angled by the
 * chart is compared by its real outline, not by its (larger) bounding box. */
function quadsOverlap(a: Quad, b: Quad): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      const axis = { x: p.y - q.y, y: q.x - p.x };
      const project = (s: Quad) => s.map((c) => c.x * axis.x + c.y * axis.y);
      const pa = project(a);
      const pb = project(b);
      if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false;
    }
  }
  return true;
}

/** Every pair of labels that overlap, as index pairs; `[]` means a clean axis. */
export function overlappingPairs(quads: Quad[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < quads.length; i++) {
    for (let j = i + 1; j < quads.length; j++) {
      if (quadsOverlap(quads[i]!, quads[j]!)) out.push([i, j]);
    }
  }
  return out;
}

/** Is the box's bottom edge on screen? `box` is a Playwright `boundingBox()`. */
export function fitsFold(
  box: { y: number; height: number } | null,
  viewportHeight: number,
): boolean {
  return box !== null && box.y + box.height <= viewportHeight;
}
