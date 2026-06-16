import type { ProjectTag } from '@prisma/client';
import type { ProjectCategoryDto, ProjectTagDto } from '@/lib/dto/projectTags';

// Prisma → DTO converters for the project-tags domain (Story 6.13 · Subtask
// 6.13.5). The service calls these just before returning, per CLAUDE.md (a
// service never returns a raw Prisma row).

/** A tag row → its `{ slug, label }` chip DTO (drops `id` / `createdAt`). */
export function toProjectTagDto(tag: Pick<ProjectTag, 'slug' | 'label'>): ProjectTagDto {
  return { slug: tag.slug, label: tag.label };
}

/** A tag + its public-project count → the square's browse-facet category DTO. */
export function toProjectCategoryDto(row: {
  slug: string;
  label: string;
  projectCount: number;
}): ProjectCategoryDto {
  return { slug: row.slug, label: row.label, projectCount: row.projectCount };
}
