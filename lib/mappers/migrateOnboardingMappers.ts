import type { MigrateOnboarding } from '@prisma/client';
import type {
  MigrateOnboardingDto,
  MigrateOnboardingKindDto,
  MigrateOnboardingStatusDto,
  MigrateOnboardingStepDto,
} from '@/lib/dto/migrateOnboarding';

// Prisma `MigrateOnboarding` row → API DTO (Story 7.15 · MOTIR-1499). The single
// place the persisted enums narrow to their string unions and Dates become ISO
// strings, so no Prisma row leaks past the service boundary (the 4-layer rule).
export function toMigrateOnboardingDto(row: MigrateOnboarding): MigrateOnboardingDto {
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
