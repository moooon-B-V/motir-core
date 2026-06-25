// The onboarding canvas LAYOUT (Subtask 7.3.11 / MOTIR-840) — the default
// positions + the read-only dependency edges for the pre-plan stations on the
// spatial canvas (`PlanningCanvas`, 7.3.76). Pure (no React/DOM) so it is
// unit-testable; `OnboardingCanvas` composes it.
//
// The auto-layout is TWO rows (Yue): row 0 reads straight across — idea → the 4
// tiers (discovery…validation) — and the last two stations (design → plan) wrap to
// row 1, with the "Your plan" preview beside them (OnboardingCanvas). Wrapping the
// tail keeps the canvas compact (a ~3.5:1 box, not ~4.7:1), so fit-to-view renders
// the cards BIGGER and the plan station stays on screen (no horizontal scroll). The
// user can drag any node; a saved position (7.3.77) overrides the default. The edges
// are the REAL pre-plan dependency chain (each tier builds on the previous) — read-only.

import { type StationKind, STATION_ORDER } from './canvasModel';

/** A canvas node is the idea seed or one of the pre-plan stations. */
export type CanvasNodeKey = 'idea' | StationKind;

/** Every canvas node in journey order (idea → the tiers → design → plan). */
export const CANVAS_NODE_KEYS: readonly CanvasNodeKey[] = ['idea', ...STATION_ORDER];

// Two rows. Row 0 (y=40): idea → the 4 tiers (discovery…validation), left→right.
// Row 1 (y=260): the last two stations design → plan, wrapped under the start of
// row 0, with the "Your plan" preview to their right (OnboardingCanvas's ROOT_X0/Y0).
// Step = NODE_W(280) + a gap, so the cards read as a clean pipeline and the four
// tiers line up horizontally; ROW1_Y clears row 0 by NODE_H(124) + a band gap.
const ROW0_Y = 40;
const ROW1_Y = 260;
const ORIGIN_X = 40;
const STEP_X = 340;
export const STATION_AUTO_LAYOUT: Record<CanvasNodeKey, { x: number; y: number }> = {
  idea: { x: ORIGIN_X, y: ROW0_Y },
  discovery: { x: ORIGIN_X + STEP_X, y: ROW0_Y },
  vision: { x: ORIGIN_X + 2 * STEP_X, y: ROW0_Y },
  feasibility: { x: ORIGIN_X + 3 * STEP_X, y: ROW0_Y },
  validation: { x: ORIGIN_X + 4 * STEP_X, y: ROW0_Y },
  design: { x: ORIGIN_X, y: ROW1_Y },
  plan: { x: ORIGIN_X + STEP_X, y: ROW1_Y },
};

/**
 * The PRE-DEFINED, READ-ONLY dependency edges — the real pre-plan chain
 * (idea → discovery → vision → feasibility → validation → design → plan). The
 * canvas draws these; there is no link create / edit / delete.
 */
export const STATION_EDGES: ReadonlyArray<readonly [CanvasNodeKey, CanvasNodeKey]> = [
  ['idea', 'discovery'],
  ['discovery', 'vision'],
  ['vision', 'feasibility'],
  ['feasibility', 'validation'],
  ['validation', 'design'],
  ['design', 'plan'],
];

/** A node's position: the user's saved one if present, else the auto-layout. */
export function positionFor(
  key: CanvasNodeKey,
  saved: Record<string, { x: number; y: number }>,
): { x: number; y: number } {
  return saved[key] ?? STATION_AUTO_LAYOUT[key];
}
