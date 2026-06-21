// The canvas-layout DTOs (Subtask 7.3.77 / MOTIR-1237) — what `GET/PATCH
// /api/canvas-layout` exchange with the browser: a user's saved node arrangement
// for the active project's planning canvas. `nodeKey` is the consumer's stable id
// for a node (a work-item id or a pre-plan station key); `x`/`y` are WORLD
// coordinates (the same space `PlanningCanvas` positions nodes in).

export interface CanvasNodePositionDTO {
  nodeKey: string;
  x: number;
  y: number;
}

/** The user's whole saved arrangement for a project (empty → auto-layout). */
export interface CanvasLayoutDTO {
  positions: CanvasNodePositionDTO[];
}

/** One node's new position, sent on a PATCH save (debounced from the client). */
export interface CanvasNodePositionInput {
  nodeKey: string;
  x: number;
  y: number;
}
