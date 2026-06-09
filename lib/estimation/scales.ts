import type { EstimationConfigDto, PointScaleDto } from '@/lib/dto/estimation';

// Estimation scale decks (Story 4.3 · Subtask 4.3.4) — the suggested values the
// story-point picker offers as quick-pick chips. The deck SUGGESTS; it never
// constrains entry — story points stay a free numeric value (Jira allows
// decimals like 0.5) so they always roll up (see story-4.3.ts + the design
// notes). `custom` returns the project's `customScaleValues`. The mirror is
// Jira's planning-poker decks (Fibonacci / linear).

/** The classic planning-poker Fibonacci deck (the default scale). */
export const FIBONACCI_DECK: readonly number[] = [1, 2, 3, 5, 8, 13, 21];

/** A plain linear deck. */
export const LINEAR_DECK: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/**
 * Resolve the quick-pick deck a config exposes: the fixed Fibonacci / linear
 * decks, or the project's `customScaleValues` when the scale is `custom`. Custom
 * values are sorted ascending + de-duplicated so the picker shows a tidy row
 * regardless of the order they were entered in the settings panel (4.3.6).
 */
export function resolveScaleDeck(
  pointScale: PointScaleDto,
  customScaleValues: readonly number[],
): number[] {
  switch (pointScale) {
    case 'fibonacci':
      return [...FIBONACCI_DECK];
    case 'linear':
      return [...LINEAR_DECK];
    case 'custom':
      return Array.from(new Set(customScaleValues)).sort((a, b) => a - b);
  }
}

/** Convenience: resolve the deck straight from an {@link EstimationConfigDto}. */
export function deckForConfig(config: EstimationConfigDto): number[] {
  return resolveScaleDeck(config.pointScale, config.customScaleValues);
}

/**
 * Format a story-point value for display — a plain number with no trailing
 * zeros (`5`, `0.5`, `34`), so the `Decimal(6, 2)` column never renders as
 * `5.00`. `null` is the caller's "unestimated" case (rendered as the muted `—`),
 * so this only handles real numbers.
 */
export function formatStoryPoints(points: number): string {
  // Number() already drops trailing zeros for whole values; guard the rare
  // float-precision tail (e.g. 0.30000000000000004) by rounding to the 2 dp the
  // column stores, then stripping zeros via Number → String.
  return String(Number(points.toFixed(2)));
}
