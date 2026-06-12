import type { Project, ProjectKeyAlias } from '@prisma/client';
import type { ProjectDTO } from '@/lib/dto/projects';

// Prisma → DTO converter for the project domain. The service calls this
// just before returning so no Prisma row shape leaks across the API
// boundary.

/**
 * Map a project row to its DTO. Pass `aliases` ONLY on the details-surface path
 * (Story 6.8) to populate `previousKeys` (newest first — the repo already orders
 * them); omit it on the hot reads (switcher list, active-project) so the DTO
 * stays a single project-row fetch with no alias join. Absent `aliases` ⇒
 * `previousKeys` is left undefined ("not loaded"); an empty array ⇒ `[]`.
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
    ...(aliases
      ? {
          previousKeys: aliases.map((a) => ({
            identifier: a.identifier,
            retiredAt: a.createdAt.toISOString(),
          })),
        }
      : {}),
  };
}
