import { InvalidEstimateError } from './errors';

// Story-point value validation (Story 4.3 · Subtask 4.3.3, shared in 7.8.21).
// Extracted from `estimationService` so EVERY write path that sets the single
// `storyPoints` Decimal(6, 2) column — the UI estimation surface
// (`estimationService.setEstimate`) AND the MCP `create_work_item` /
// `update_work_item` tools (via `workItemsService`) — validates the value the
// SAME way. Keeping the rule in one place is why the MCP surface can never be
// stricter (or looser) than the human UI: both call `validateStoryPoints`.
//
// NOTE on "scale": the column is a free Decimal(6, 2); the configured point
// SCALE (fibonacci / linear / custom deck) only powers the picker's offered
// values — the shipped server write path has never enforced deck-MEMBERSHIP,
// only the value's shape (range + precision). The MCP surface matches that
// shipped contract rather than introducing an MCP-only deck check the UI lacks.

/** The largest value `Decimal(6, 2)` can hold (4 integer + 2 fractional digits). */
export const MAX_STORY_POINTS = 9999.99;

/**
 * Validate a story-point estimate value. `null` clears (always valid). A number
 * must be finite, non-negative, within the `Decimal(6, 2)` range, and carry at
 * most two decimal places. Returns the value unchanged on success.
 *
 * Throws: `InvalidEstimateError` (→ 422 on the route layer; a typed tool error
 * on the MCP surface).
 */
export function validateStoryPoints(points: number | null): number | null {
  if (points === null) return null;
  if (typeof points !== 'number' || !Number.isFinite(points)) {
    throw new InvalidEstimateError('A story-point estimate must be a finite number.');
  }
  if (points < 0) {
    throw new InvalidEstimateError('A story-point estimate must not be negative.');
  }
  if (points > MAX_STORY_POINTS) {
    throw new InvalidEstimateError(`A story-point estimate must not exceed ${MAX_STORY_POINTS}.`);
  }
  // Two-decimal-place cap (the column is Decimal(6, 2)) — reject finer precision
  // up front rather than letting Postgres silently round it.
  if (Math.round(points * 100) !== points * 100) {
    throw new InvalidEstimateError('A story-point estimate allows at most two decimal places.');
  }
  return points;
}
