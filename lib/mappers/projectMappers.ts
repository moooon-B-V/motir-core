import type { Project, ProjectKeyAlias } from '@prisma/client';
import type { ProjectDTO } from '@/lib/dto/projects';

// Prisma → DTO converter for the project domain. The service calls this
// just before returning so no Prisma row shape leaks across the API
// boundary.

/**
 * Map a project row to its DTO. Pass `aliases` ONLY on the details-surface path
 * (Stories 6.5.3 / 6.8) to populate the details-only fields — `createdAt` (the
 * "Created" identity row) and `previousKeys` (newest first — the repo already
 * orders them); omit it on the hot reads (switcher list, active-project) so the
 * DTO stays a single project-row projection with no alias join AND no
 * `createdAt` (the create-path shape test enforces that the hot DTO is not a raw
 * Prisma row). Absent `aliases` ⇒ both details fields left undefined ("not
 * loaded"); an empty array ⇒ `previousKeys: []` with `createdAt` populated.
 */
export function toProjectDTO(project: Project, aliases?: ProjectKeyAlias[]): ProjectDTO {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    identifier: project.identifier,
    archivedAt: project.archivedAt ? project.archivedAt.toISOString() : null,
    accessLevel: project.accessLevel,
    avatarIcon: project.avatarIcon,
    avatarColor: project.avatarColor,
    onboardingRanAt: project.onboardingRanAt ? project.onboardingRanAt.toISOString() : null,
    aiGenerateExplanations: project.aiGenerateExplanations,
    ...(aliases
      ? {
          createdAt: project.createdAt.toISOString(),
          previousKeys: aliases.map((a) => ({
            identifier: a.identifier,
            retiredAt: a.createdAt.toISOString(),
          })),
        }
      : {}),
  };
}
