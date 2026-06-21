// The onboarding canvas LAYOUT (Subtask 7.3.11 / MOTIR-840) — the default
// positions + the read-only dependency edges for the pre-plan stations on the
// spatial canvas (`PlanningCanvas`, 7.3.76). Pure (no React/DOM) so it is
// unit-testable; `OnboardingCanvas` composes it.
//
// The auto-layout is a space-filling SERPENTINE (the approved design): the chain
// runs across the top, drops and reverses, then to plan — using the canvas width,
// not a single column. The user can drag any node; a saved position (7.3.77)
// overrides the default. The edges are the REAL pre-plan dependency chain (each
// tier builds on the previous) — read-only; the canvas renders them, never edits.

import { type StationKind, STATION_ORDER } from './canvasModel';

/** A canvas node is the idea seed or one of the pre-plan stations. */
export type CanvasNodeKey = 'idea' | StationKind;

/** Every canvas node in journey order (idea → the tiers → design → plan). */
export const CANVAS_NODE_KEYS: readonly CanvasNodeKey[] = ['idea', ...STATION_ORDER];

/** Default (auto) world positions — the serpentine that fills the canvas width. */
export const STATION_AUTO_LAYOUT: Record<CanvasNodeKey, { x: number; y: number }> = {
  idea: { x: 40, y: 40 },
  discovery: { x: 380, y: 40 },
  vision: { x: 720, y: 40 },
  feasibility: { x: 720, y: 360 },
  validation: { x: 380, y: 360 },
  design: { x: 40, y: 360 },
  plan: { x: 40, y: 680 },
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
