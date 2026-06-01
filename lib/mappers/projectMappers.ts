import type { Project } from '@prisma/client';
import type { ProjectDTO } from '@/lib/dto/projects';

// Prisma → DTO converter for the project domain. The service calls this
// just before returning so no Prisma row shape leaks across the API
// boundary.

export function toProjectDTO(project: Project): ProjectDTO {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    identifier: project.identifier,
    archivedAt: project.archivedAt ? project.archivedAt.toISOString() : null,
  };
}
