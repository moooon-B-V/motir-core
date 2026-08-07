import type { Prisma } from '@prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { withWorkspaceContext, type WorkspaceContext } from '@/lib/workspaces/context';
import { InvalidAiSettingsError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  AI_AUTO_PLAN_THRESHOLD_MAX,
  AI_AUTO_PLAN_THRESHOLD_MIN,
  AI_PLANNER_MODEL_MAX_LENGTH,
  AI_PLANNER_MODEL_PATTERN,
  AI_SPRINT_LENGTH_DAYS_MAX,
  AI_SPRINT_LENGTH_DAYS_MIN,
} from '@/lib/projectAiSettings/limits';
import { toProjectAiSettingsDto } from '@/lib/mappers/projectAiSettingsMappers';
import type {
  ProjectAiSettingsDto,
  UpdateProjectAiSettingsInput,
} from '@/lib/dto/projectAiSettings';

// Project AI-planning settings service (Story 7.13 · Subtask MOTIR-915) — the
// business logic over the AI configuration COLUMNS on `project`
// (`aiAutoPlanEnabled` / `aiAutoPlanThreshold` / `aiSprintPlanningEnabled` /
// `aiSprintLengthDays` / `aiPlannerModel`, plus the Story-7.4
// `aiGenerateExplanations` the same panel surfaces).
//
// Open-core by construction: these are ordinary project-settings columns the PM
// core owns and reads (the cadence engine MOTIR-916, the sprint-packing persist
// MOTIR-918, the settings panel MOTIR-919) — NOT an AI-only table, and nothing
// here calls motir-ai. The per-project `aiPlannerModel` is an OVERRIDE only: when
// it is null the platform default applies, and that default lives in motir-ai
// (`plannerModel()` → `PLANNER_MODEL` env → `PLANNER_MODELS.default`, 7.2.2), so
// core never hardcodes or resolves a model id.
//
// 4-layer (CLAUDE.md): repositories do the single Prisma ops, this service owns
// the transaction + the gate + ALL validation, mappers produce the DTO. Reads are
// browse-scoped (any member of a browsable project may see the configuration);
// the WRITE asks for `ai:configure` via `projectAccessService.assertPermission`
// (Story MOTIR-2256 · MOTIR-2300) — changing the cadence spends the workspace's
// AI credits, so it belongs to the project-admin tier, and it now says so by
// NAME rather than through the umbrella.
//
// ⚠️ `ai:configure` IS NOT `ai:plan`, and the distance between them is the whole
// point of having two keys. This key answers "who may change the auto-plan
// cadence, the AI sprint-planning switch, the planner model and the
// drafted-explanation setting" — a settings decision with a spend consequence.
// "Who may RUN the planner" is `ai:plan`, roughly 26 routes governed by nothing
// today, and moving those takes capability away from ordinary members — a
// different kind of change, argued on its own in MOTIR-2291. A diff here that
// touches one of them is out of scope.
//
// The change is BEHAVIOUR-NEUTRAL: `ai:configure` resolves to exactly the actors
// `project:administer` resolved to, on every access level and both rails, proved
// over all 64 inputs in `tests/permissions/accessParity.test.ts`.
//
// The HTTP / Server-Action surface belongs to the AI-settings panel subtask
// (MOTIR-919); this service is its single entry point, so no route ever touches
// Prisma for these fields.

export const projectAiSettingsService = {
  /**
   * Read a project's AI-planning settings by project key. Browse-gated: a
   * missing, cross-workspace, or non-browsable project all read as
   * `ProjectNotFoundError` (404, no existence leak — finding #26).
   *
   * Throws: `ProjectNotFoundError` (404).
   */
  async getAiSettings(key: string, ctx: WorkspaceContext): Promise<ProjectAiSettingsDto> {
    return withWorkspaceContext(ctx, async (tx) => {
      const project = await resolveProjectByKeyInTx(key, ctx.workspaceId, tx);
      await projectAccessService.assertCanBrowse(project.id, ctx, tx);
      const settings = await projectRepository.findAiSettings(project.id, tx);
      // The row was just resolved inside this transaction, so a null here would
      // mean it vanished mid-transaction; treat it as not-found rather than
      // returning a half-shape.
      if (!settings) throw new ProjectNotFoundError(key);
      return toProjectAiSettingsDto(settings);
    });
  },

  /**
   * Update a project's AI-planning settings. Gated on `ai:configure`. A
   * PARTIAL patch: an ABSENT field is left untouched, so the panel can save one
   * toggle without clobbering the others.
   *
   * Every value is validated BEFORE the transaction opens (no DB touch on a
   * rejected edit) and REJECTED with a typed `InvalidAiSettingsError` rather than
   * clamped:
   *   - `aiAutoPlanThreshold` — an integer in
   *     `AI_AUTO_PLAN_THRESHOLD_MIN..MAX` (≥ 1: a 0 threshold could never fire —
   *     switching the feature off is `aiAutoPlanEnabled`).
   *   - `aiSprintLengthDays` — an integer in `AI_SPRINT_LENGTH_DAYS_MIN..MAX`.
   *   - `aiPlannerModel` — trimmed; `null` / empty CLEARS the override back to
   *     the platform default; otherwise a bounded model-id-shaped token.
   *
   * Returns the updated settings (the inline save reads the success response as
   * its confirmation — no whole-tree refresh; CLAUDE.md § page state).
   *
   * Throws: `ProjectNotFoundError` (404), `PermissionDeniedError` (403, carrying
   * `ai:configure`), `InvalidAiSettingsError` (422).
   */
  async updateAiSettings(
    key: string,
    patch: UpdateProjectAiSettingsInput,
    ctx: WorkspaceContext,
  ): Promise<ProjectAiSettingsDto> {
    const data = validateAiSettingsPatch(patch);

    return withWorkspaceContext(ctx, async (tx) => {
      const project = await resolveProjectByKeyInTx(key, ctx.workspaceId, tx);
      await projectAccessService.assertPermission(project.id, ctx, 'ai:configure', tx);
      const updated = await projectRepository.updateAiSettings(project.id, data, tx);
      return toProjectAiSettingsDto(updated);
    });
  },
};

/**
 * Resolve a project by its workspace-unique key inside the caller's transaction.
 * Deliberately alias-BLIND, mirroring `projectsService`'s write-path resolver: a
 * settings surface addresses the live project, never a retired key. A key naming
 * a project in another workspace and a never-existed key are indistinguishable —
 * both `ProjectNotFoundError` (no existence leak).
 */
async function resolveProjectByKeyInTx(
  key: string,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<{ id: string }> {
  const identifier = key.trim().toUpperCase();
  const project = await projectRepository.findByIdentifier(workspaceId, identifier, tx);
  if (!project) throw new ProjectNotFoundError(key);
  return project;
}

/**
 * Validate the patch and return the Prisma update payload (only the supplied
 * fields). Each field is checked independently — there is no cross-field rule
 * here: a threshold is meaningful whether or not auto-plan is currently enabled
 * (a project may configure the cadence before switching it on), so validating a
 * threshold only when `aiAutoPlanEnabled` is true would let a bad number persist
 * and fire later.
 */
function validateAiSettingsPatch(patch: UpdateProjectAiSettingsInput): {
  aiAutoPlanEnabled?: boolean;
  aiAutoPlanThreshold?: number;
  aiSprintPlanningEnabled?: boolean;
  aiSprintLengthDays?: number;
  aiPlannerModel?: string | null;
  aiGenerateExplanations?: boolean;
} {
  const data: {
    aiAutoPlanEnabled?: boolean;
    aiAutoPlanThreshold?: number;
    aiSprintPlanningEnabled?: boolean;
    aiSprintLengthDays?: number;
    aiPlannerModel?: string | null;
    aiGenerateExplanations?: boolean;
  } = {};

  if (patch.aiAutoPlanEnabled !== undefined) data.aiAutoPlanEnabled = patch.aiAutoPlanEnabled;
  if (patch.aiSprintPlanningEnabled !== undefined) {
    data.aiSprintPlanningEnabled = patch.aiSprintPlanningEnabled;
  }
  if (patch.aiGenerateExplanations !== undefined) {
    data.aiGenerateExplanations = patch.aiGenerateExplanations;
  }

  if (patch.aiAutoPlanThreshold !== undefined) {
    data.aiAutoPlanThreshold = validateBoundedInteger(
      patch.aiAutoPlanThreshold,
      'aiAutoPlanThreshold',
      AI_AUTO_PLAN_THRESHOLD_MIN,
      AI_AUTO_PLAN_THRESHOLD_MAX,
      'The auto-plan threshold',
    );
  }

  if (patch.aiSprintLengthDays !== undefined) {
    data.aiSprintLengthDays = validateBoundedInteger(
      patch.aiSprintLengthDays,
      'aiSprintLengthDays',
      AI_SPRINT_LENGTH_DAYS_MIN,
      AI_SPRINT_LENGTH_DAYS_MAX,
      'The AI sprint length (days)',
    );
  }

  if (patch.aiPlannerModel !== undefined) {
    data.aiPlannerModel = validatePlannerModel(patch.aiPlannerModel);
  }

  return data;
}

/**
 * A whole number within `[min, max]`. A non-finite / fractional value is a
 * rejection, not a rounding opportunity — silently rounding a threshold the admin
 * typed would make the persisted cadence differ from the configured one.
 */
function validateBoundedInteger(
  value: number,
  field: 'aiAutoPlanThreshold' | 'aiSprintLengthDays',
  min: number,
  max: number,
  label: string,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new InvalidAiSettingsError(field, `${label} must be a whole number.`);
  }
  if (value < min || value > max) {
    throw new InvalidAiSettingsError(field, `${label} must be between ${min} and ${max}.`);
  }
  return value;
}

/**
 * A planner-model override: trimmed; `null` / empty / whitespace-only clears it
 * (back to the platform default), otherwise a bounded model-id-shaped token. Only
 * the SHAPE is checked — the model vocabulary belongs to the gateway + motir-ai
 * (7.2.2), so core validating against a fixed list would drift from the real
 * registry; a well-formed but unknown id fails at the gateway with its own typed
 * error.
 */
function validatePlannerModel(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new InvalidAiSettingsError('aiPlannerModel', 'The planner model must be a string.');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > AI_PLANNER_MODEL_MAX_LENGTH) {
    throw new InvalidAiSettingsError(
      'aiPlannerModel',
      `The planner model must be at most ${AI_PLANNER_MODEL_MAX_LENGTH} characters.`,
    );
  }
  if (!AI_PLANNER_MODEL_PATTERN.test(trimmed)) {
    throw new InvalidAiSettingsError(
      'aiPlannerModel',
      `"${trimmed}" is not a valid model id (use letters, digits and . _ : / -).`,
    );
  }
  return trimmed;
}
