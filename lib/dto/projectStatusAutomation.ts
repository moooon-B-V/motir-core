// DTOs for the project STATUS-AUTOMATION settings (Story MOTIR-1615 · Subtask
// MOTIR-1618) — the two on/off switches for bidirectional parent↔child status
// derivation (`docs/decisions/status-derivation.md`). The shape that crosses the
// API / Server-Action boundary for the settings panel (MOTIR-1622); no Prisma row
// leak. Kept OFF the hot `ProjectDTO` (which every switcher / active-project read
// carries) for the same reason the AI-settings group is: these are a settings
// surface's fields, read when that surface is open — and read again by the
// derivation services themselves, which take the project id, not a DTO.

/**
 * A project's status-derivation configuration as the API returns it.
 *
 * - `autoRollupParentStatus` — the UPWARD ladder. A child's transition rolls its
 *   parent up: any child in progress ⇒ parent in progress; the last open child
 *   reaching review ⇒ parent in review; every child done ⇒ parent done. Only ever
 *   along the project's real workflow edges.
 * - `autoCompleteChildrenOnParentDone` — the DOWNWARD cascade. An item reaching a
 *   done-category status completes its not-done direct children (grandchildren
 *   follow by re-emission).
 *
 * Both default ON — two-way sync is Motir's opinion, and each switch turns its
 * own direction off. They are independent precisely so a team can keep the rollup
 * while declining the cascade.
 */
export interface ProjectStatusAutomationDto {
  autoRollupParentStatus: boolean;
  autoCompleteChildrenOnParentDone: boolean;
}

/**
 * Patch input to `projectStatusAutomationService.updateStatusAutomation`. Both
 * fields are optional — an ABSENT field is left unchanged, so the panel can save
 * one toggle in place without clobbering the other (the `updateAiSettings` /
 * `updateDetails` idiom).
 */
export interface UpdateProjectStatusAutomationInput {
  autoRollupParentStatus?: boolean;
  autoCompleteChildrenOnParentDone?: boolean;
}
