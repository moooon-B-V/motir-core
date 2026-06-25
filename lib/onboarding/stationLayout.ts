// The onboarding canvas LAYOUT (Subtask 7.3.11 / MOTIR-840) — the default
// positions + the read-only dependency edges for the pre-plan stations on the
// spatial canvas (`PlanningCanvas`, 7.3.76). Pure (no React/DOM) so it is
// unit-testable; `OnboardingCanvas` composes it.
//
// The auto-layout is THREE left-aligned rows (Yue): the idea seed on top, the 4 tiers
// (discovery…validation) across the middle, and design → plan on the bottom with the
// "Your plan" preview beside them (OnboardingCanvas). idea sits directly above
// discovery, so idea / "Understanding your idea" / "Design the look" share one clean
// left edge and the journey reads idea ↓ discovery → … → wrap ↓ design → plan. Wrapping
// the tail keeps the canvas compact, so fit-to-view renders the cards BIGGER and the
// plan station stays on screen (no horizontal scroll). The user can drag any node; a
// saved position (7.3.77) overrides the default. The edges are the REAL pre-plan
// dependency chain (each tier builds on the previous) — read-only.

import { type StationKind, STATION_ORDER } from './canvasModel';

/** A canvas node is the idea seed or one of the pre-plan stations. */
export type CanvasNodeKey = 'idea' | StationKind;

/** Every canvas node in journey order (idea → the tiers → design → plan). */
export const CANVAS_NODE_KEYS: readonly CanvasNodeKey[] = ['idea', ...STATION_ORDER];

// Three rows, all left-aligned at ORIGIN_X so the idea seed, the first tier, and the
// design step share ONE clean left edge. Row 0 (idea): the seed, a narrow lead-in card.
// Row 1 (the tiers): discovery → vision → feasibility → validation, left→right. Row 2:
// design → plan, with the "Your plan" preview to their right (OnboardingCanvas's
// ROOT_X0/Y0). The idea sits directly ABOVE discovery (the tier that understands it),
// so the journey reads idea ↓ discovery → … and "Understanding your idea" lines up at
// x=ORIGIN_X with "Design the look" two rows below. STEP_X = station card (300) + a
// 40px gap; the row Ys clear the idea card / a tier row by its height + a band gap.
const ROW_IDEA_Y = 40;
const ROW_TIER_Y = 220;
const ROW_DESIGN_Y = 440;
const ORIGIN_X = 40;
const STEP_X = 340; // station card (300) + 40px gap
export const STATION_AUTO_LAYOUT: Record<CanvasNodeKey, { x: number; y: number }> = {
  idea: { x: ORIGIN_X, y: ROW_IDEA_Y },
  discovery: { x: ORIGIN_X, y: ROW_TIER_Y },
  vision: { x: ORIGIN_X + STEP_X, y: ROW_TIER_Y },
  feasibility: { x: ORIGIN_X + 2 * STEP_X, y: ROW_TIER_Y },
  validation: { x: ORIGIN_X + 3 * STEP_X, y: ROW_TIER_Y },
  design: { x: ORIGIN_X, y: ROW_DESIGN_Y },
  plan: { x: ORIGIN_X + STEP_X, y: ROW_DESIGN_Y },
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
