// Bounds for the project AI-planning settings (Story 7.13 · Subtask MOTIR-915).
// Kept in their OWN dependency-free module — exactly like
// `lib/publicProjects/limits.ts` — so BOTH the server write path
// (`projectAiSettingsService`, which validates against them and throws a typed
// error) AND the AI-settings panel (MOTIR-919, which bounds its number inputs in
// the browser) import the SAME numbers without the client bundle pulling in the
// service layer (and `db`).
//
// These are APP-LEVEL bounds, not schema mirrors: the columns are plain
// `INTEGER`/`TEXT` with defaults, and an out-of-range value is REJECTED with a
// typed 422 rather than silently clamped at the DB — the same posture every other
// project-settings column here takes (`estimationService`'s scale validation,
// `projectsService`'s public-field caps).

// The auto-expand ready-set low-water mark must be at least 1. A threshold of 0
// could never fire (a ready-set size is never negative), so it is a
// misconfiguration rather than a way to switch the feature off —
// `aiAutoPlanEnabled` is. The upper bound is generous: a large project may well
// want to keep a deep ready set, and an over-large threshold merely means
// "expand often", which the cadence engine's own run-gating (MOTIR-916) absorbs.
export const AI_AUTO_PLAN_THRESHOLD_MIN = 1;
export const AI_AUTO_PLAN_THRESHOLD_MAX = 1_000;

// The AI-packed sprint length, in days. The DEFAULT is 2 — the deliberate,
// recorded deviation from the mirror's 1–4 WEEK sprint, because Motir's executor
// is a coding agent that lands a subtask in tens of minutes, so a two-week sprint
// would hold months of throughput and make the cadence meaningless. The RANGE
// still reaches 14 so a human-paced team can stretch it to a fortnight without
// the column degenerating into a free-form integer.
export const AI_SPRINT_LENGTH_DAYS_MIN = 1;
export const AI_SPRINT_LENGTH_DAYS_MAX = 14;

// The per-project planner-model override is a model IDENTIFIER, not free text:
// bounded in length and restricted to the charset real model ids use
// (`deepseek-v4-pro`, `claude-opus-5`, `openai/gpt-5.1`, `anthropic:claude-4.5`).
// Core deliberately does NOT validate it against a fixed list — the vocabulary is
// owned by the 9.0 metering gateway + motir-ai (`PLANNER_MODELS`, 7.2.2), so an
// enum here would drift; this validates the SHAPE only, and an unknown-but-well-
// formed id fails at the gateway with its own typed error.
export const AI_PLANNER_MODEL_MAX_LENGTH = 100;
export const AI_PLANNER_MODEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:/-]*[A-Za-z0-9])?$/;
