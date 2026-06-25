// The onboarding canvas LAYOUT (Subtask 7.3.11 / MOTIR-840) — the default
// positions + the read-only dependency edges for the pre-plan stations on the
// spatial canvas (`PlanningCanvas`, 7.3.76). Pure (no React/DOM) so it is
// unit-testable; `OnboardingCanvas` composes it.
//
// The auto-layout is a single LEFT-TO-RIGHT row (Yue): the journey reads straight
// across — idea → the 4 tiers → design → plan — so the four tier docs line up
// left-to-right, and the "Your plan" preview sits just BELOW the row (OnboardingCanvas)
// so it lands in the SAME fit-to-view (no scroll). The user can drag any node; a
// saved position (7.3.77) overrides the default. The edges are the REAL pre-plan
// dependency chain (each tier builds on the previous) — read-only.

import { type StationKind, STATION_ORDER } from './canvasModel';

/** A canvas node is the idea seed or one of the pre-plan stations. */
export type CanvasNodeKey = 'idea' | StationKind;

/** Every canvas node in journey order (idea → the tiers → design → plan). */
export const CANVAS_NODE_KEYS: readonly CanvasNodeKey[] = ['idea', ...STATION_ORDER];

// One row, left→right: idea → discovery → vision → feasibility → validation →
// design → plan. Step = NODE_W(280) + a gap, so the cards read as a clean pipeline
// and the four tiers (discovery…validation) line up horizontally.
const ROW_Y = 40;
const STEP_X = 340;
export const STATION_AUTO_LAYOUT: Record<CanvasNodeKey, { x: number; y: number }> = {
  idea: { x: 40, y: ROW_Y },
  discovery: { x: 40 + STEP_X, y: ROW_Y },
  vision: { x: 40 + 2 * STEP_X, y: ROW_Y },
  feasibility: { x: 40 + 3 * STEP_X, y: ROW_Y },
  validation: { x: 40 + 4 * STEP_X, y: ROW_Y },
  design: { x: 40 + 5 * STEP_X, y: ROW_Y },
  plan: { x: 40 + 6 * STEP_X, y: ROW_Y },
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
