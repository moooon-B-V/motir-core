// DTOs for the project AI-planning settings (Story 7.13 · Subtask MOTIR-915).
// The shape that crosses the API / Server-Action boundary for the AI-settings
// panel (MOTIR-919) — no Prisma row leak. Kept OFF the hot `ProjectDTO` (which
// every switcher / active-project read carries) because these are a settings
// surface's fields, read only when that surface is open; the one exception is
// `aiGenerateExplanations`, which already rides `ProjectDTO` for the generate-job
// envelope (Story 7.4) and is MIRRORED here so the panel that edits the AI
// settings group reads + writes all of them through ONE contract.

/**
 * A project's AI-planning configuration as the API returns it.
 *
 * - `aiAutoPlanEnabled` / `aiAutoPlanThreshold` — the auto-expand cadence: when
 *   enabled, the cadence engine (MOTIR-916) fires a 7.4 expand run once the ready
 *   set drains below the threshold.
 * - `aiSprintPlanningEnabled` / `aiSprintLengthDays` — the AI sprint packing
 *   (MOTIR-917/918) and the length of the sprints it creates.
 * - `aiPlannerModel` — the per-project planner-model override; `null` means "use
 *   the platform default" (motir-ai's `plannerModel()`, 7.2.2). Core never
 *   resolves the default itself, so this DTO reports the override, not an
 *   effective value.
 * - `aiGenerateExplanations` — the Story-7.4 AI-drafted-explanations opt-in,
 *   surfaced in the same panel (MOTIR-919).
 */
export interface ProjectAiSettingsDto {
  aiAutoPlanEnabled: boolean;
  aiAutoPlanThreshold: number;
  aiSprintPlanningEnabled: boolean;
  aiSprintLengthDays: number;
  aiPlannerModel: string | null;
  aiGenerateExplanations: boolean;
}

/**
 * Patch input to `projectAiSettingsService.updateAiSettings`. Every field is
 * optional — an ABSENT field is left unchanged, so the panel can save one toggle
 * in place without clobbering the rest (the `updateDetails` / `setPublicOverview`
 * idiom).
 *
 * `aiPlannerModel: null` (or an empty / whitespace-only string) CLEARS the
 * override back to the platform default — clearing the field in the panel means
 * "use the default", never "the empty model".
 */
export interface UpdateProjectAiSettingsInput {
  aiAutoPlanEnabled?: boolean;
  aiAutoPlanThreshold?: number;
  aiSprintPlanningEnabled?: boolean;
  aiSprintLengthDays?: number;
  aiPlannerModel?: string | null;
  aiGenerateExplanations?: boolean;
}
