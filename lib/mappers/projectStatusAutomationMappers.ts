import type { ProjectStatusAutomationDto } from '@/lib/dto/projectStatusAutomation';

// Prisma → DTO converter for the project status-automation settings (Story
// MOTIR-1615 · Subtask MOTIR-1618). The service calls this just before returning
// so no Prisma row shape leaks across the API boundary. Mirrors
// `lib/mappers/projectAiSettingsMappers.ts`.

/**
 * Map a project's status-automation columns to a `ProjectStatusAutomationDto`.
 * Accepts the full `Project` row OR the narrow
 * `projectRepository.findStatusAutomation` projection — both carry exactly these
 * two fields — so the read path can stay a projection while the write path maps
 * the updated row it already has.
 */
export function toProjectStatusAutomationDto(row: {
  autoRollupParentStatus: boolean;
  autoCompleteChildrenOnParentDone: boolean;
}): ProjectStatusAutomationDto {
  return {
    autoRollupParentStatus: row.autoRollupParentStatus,
    autoCompleteChildrenOnParentDone: row.autoCompleteChildrenOnParentDone,
  };
}
