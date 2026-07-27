// The planner-model choices the AI-settings panel offers (Story 7.13 ·
// MOTIR-919). A dependency-free module — the client panel imports it without
// pulling in the service layer (and `db`), exactly like
// `lib/projectAiSettings/limits.ts`.
//
// ⚠️ These ids MIRROR the shipped motir-ai set (`src/llm/gatewayClient.ts`
// `PLANNER_MODELS = { default: 'deepseek-v4-pro', flash: 'deepseek-v4-flash' }`,
// selected today by the `PLANNER_MODEL` env). They are NOT invented, and core
// deliberately does NOT validate an override against them — the vocabulary is
// owned by the 9.0 metering gateway + motir-ai (7.2.2), so
// `projectAiSettingsService` validates only the model-id SHAPE
// (`AI_PLANNER_MODEL_PATTERN`). This list is a PICKER convenience: the three
// choices a project owner should have, no more. Adding a model later is one more
// entry here — no layout change.
//
// The open-core boundary holds: motir-core cannot import from motir-ai, so the
// ids are duplicated by necessity, not by preference. A project that pins a
// retired id still saves (shape-valid) and fails at the gateway with its own
// typed error, which is why this is a convenience list rather than an enum.

/**
 * The sentinel the picker uses for "no override" — the option that WRITES
 * `aiPlannerModel = null` so the project follows the deployment's
 * `PLANNER_MODEL`. It is never persisted: the editor maps it to `null` on save
 * and maps a `null` override back to it on read.
 */
export const PLANNER_MODEL_DEFAULT = 'default';

/** A planner-model picker option value: the sentinel, or a real model id. */
export type PlannerModelChoice = typeof PLANNER_MODEL_DEFAULT | (typeof PLANNER_MODEL_IDS)[number];

/** The pinnable model ids, in picker order (Thorough → Fast). */
export const PLANNER_MODEL_IDS = ['deepseek-v4-pro', 'deepseek-v4-flash'] as const;

/**
 * The picker rows, in order. `labelKey` resolves under
 * `settings.aiPlanning.planner.*`; `secondary` is the muted mono text the
 * shipped `Combobox` renders after the label — the model id itself, so a
 * non-technical owner chooses "Thorough" while an engineer still sees exactly
 * what runs. The Default row's secondary is a translated word, not an id.
 */
export const PLANNER_MODEL_OPTIONS: {
  value: PlannerModelChoice;
  labelKey: 'modelDefault' | 'modelThorough' | 'modelFast';
  /** The model id shown as secondary text; null for the Default row. */
  modelId: string | null;
}[] = [
  { value: PLANNER_MODEL_DEFAULT, labelKey: 'modelDefault', modelId: null },
  { value: 'deepseek-v4-pro', labelKey: 'modelThorough', modelId: 'deepseek-v4-pro' },
  { value: 'deepseek-v4-flash', labelKey: 'modelFast', modelId: 'deepseek-v4-flash' },
];

/** The stored override (`null` = follow the deployment) → the picker's value. */
export function plannerModelToChoice(override: string | null): PlannerModelChoice {
  if (!override) return PLANNER_MODEL_DEFAULT;
  return override as PlannerModelChoice;
}

/**
 * The picker's value → the stored override. The sentinel CLEARS the override
 * (`null`); a pinned id is sent through as-is. A choice the picker never offered
 * (a value pinned by an older release, or a hand-edited row) round-trips
 * unchanged rather than being silently reset to the default.
 */
export function choiceToPlannerModel(choice: PlannerModelChoice): string | null {
  return choice === PLANNER_MODEL_DEFAULT ? null : choice;
}
