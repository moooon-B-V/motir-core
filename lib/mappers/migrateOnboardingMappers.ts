import type { Import, MigrateOnboarding } from '@/generated/prisma/client';
import type {
  MigrateLatestImportDto,
  MigrateOnboardingDto,
  MigrateOnboardingKindDto,
  MigrateOnboardingStatusDto,
  MigrateOnboardingStepDto,
} from '@/lib/dto/migrateOnboarding';

// Prisma `MigrateOnboarding` row → API DTO (Story 7.15 · MOTIR-1499). The single
// place the persisted enums narrow to their string unions and Dates become ISO
// strings, so no Prisma row leaks past the service boundary (the 4-layer rule).
//
// `latestImport` is the project's most recent `Import` row, which the migrate
// service reads beside the run (MOTIR-8770); a caller that does not read it
// reports null.
export function toMigrateOnboardingDto(
  row: MigrateOnboarding,
  latestImport: Import | null = null,
): MigrateOnboardingDto {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as MigrateOnboardingKindDto,
    step: row.step as MigrateOnboardingStepDto,
    status: row.status as MigrateOnboardingStatusDto,
    connectedRepoRef: row.connectedRepoRef,
    codeGraphReady: row.codeGraphReady,
    conventionApprovedAt: row.conventionApprovedAt ? row.conventionApprovedAt.toISOString() : null,
    discoveryJobId: row.discoveryJobId,
    generateJobId: row.generateJobId,
    importSkipped: row.importSkipped,
    importCompleted: row.importCompleted,
    // The planner's kept set (MOTIR-4759) — `[]` for a run no verdict reached,
    // which is every run created by a door other than the routing hand-off.
    keptSteps: row.keptSteps,
    latestImport: latestImport ? toMigrateLatestImportDto(latestImport) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toMigrateLatestImportDto(row: Import): MigrateLatestImportDto {
  return {
    source: row.source,
    status: row.status,
    processedCount: row.createdCount + row.updatedCount + row.skippedCount + row.failedCount,
  };
}
