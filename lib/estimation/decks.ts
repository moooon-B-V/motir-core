import type { PointScaleDto } from '@/lib/dto/estimation';

// Suggested point-scale decks (Story 4.3). A project's `pointScale` selects
// which deck the estimate picker (Subtask 4.3.4) offers and the project
// Estimation settings panel (4.3.6) previews. `fibonacci` / `linear` are FIXED
// presets; `custom` reads the project's `customScaleValues`. The deck only
// SUGGESTS — story points stay a free numeric value (decimals allowed), so any
// number is still accepted. Shared here so the picker and the settings preview
// can never drift on what each scale offers.

/** Planning-poker default — the Fibonacci sequence Jira ships as its default deck. */
export const FIBONACCI_DECK: readonly number[] = [1, 2, 3, 5, 8, 13, 21];

/** The linear 1…8 deck (the second Jira preset). */
export const LINEAR_DECK: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8];

/**
 * The suggested deck values for a project's estimation config. Fibonacci /
 * linear return their fixed preset; `custom` returns the project-defined deck
 * (`project.customScaleValues`).
 */
export function deckForScale(scale: PointScaleDto, customValues: number[]): number[] {
  switch (scale) {
    case 'fibonacci':
      return [...FIBONACCI_DECK];
    case 'linear':
      return [...LINEAR_DECK];
    case 'custom':
      return customValues;
  }
}
