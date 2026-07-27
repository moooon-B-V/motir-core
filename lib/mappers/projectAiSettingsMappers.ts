import type { ProjectAiSettingsDto } from '@/lib/dto/projectAiSettings';

// Prisma → DTO converter for the project AI-planning settings (Story 7.13 ·
// Subtask MOTIR-915). The service calls this just before returning so no Prisma
// row shape leaks across the API boundary. Mirrors
// `lib/mappers/estimationMappers.ts`'s `toEstimationConfigDto`.

/**
 * Map a project's AI-settings columns to a `ProjectAiSettingsDto`. Accepts the
 * full `Project` row OR the narrow `projectRepository.findAiSettings` projection
 * — both carry exactly these six fields — so the read path can stay a projection
 * while the write path maps the updated row it already has.
 */
export function toProjectAiSettingsDto(row: {
  aiAutoPlanEnabled: boolean;
  aiAutoPlanThreshold: number;
  aiSprintPlanningEnabled: boolean;
  aiSprintLengthDays: number;
  aiPlannerModel: string | null;
  aiGenerateExplanations: boolean;
}): ProjectAiSettingsDto {
  return {
    aiAutoPlanEnabled: row.aiAutoPlanEnabled,
    aiAutoPlanThreshold: row.aiAutoPlanThreshold,
    aiSprintPlanningEnabled: row.aiSprintPlanningEnabled,
    aiSprintLengthDays: row.aiSprintLengthDays,
    aiPlannerModel: row.aiPlannerModel,
    aiGenerateExplanations: row.aiGenerateExplanations,
  };
}
