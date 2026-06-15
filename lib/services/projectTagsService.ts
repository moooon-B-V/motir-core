import type { Project } from '@prisma/client';
import { db } from '@/lib/db';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectTagRepository } from '@/lib/repositories/projectTagRepository';
import { projectTagAssignmentRepository } from '@/lib/repositories/projectTagAssignmentRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { toProjectCategoryDto, toProjectTagDto } from '@/lib/mappers/projectTagMappers';
import {
  MAX_TAGS_PER_PROJECT,
  vocabularyEntry,
  type ProjectTagVocabularyEntry,
} from '@/lib/projectTags/vocabulary';
import { InvalidProjectTagError, TooManyProjectTagsError } from '@/lib/projectTags/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import type { ProjectCategoryDto, ProjectTagDto } from '@/lib/dto/projectTags';

// projectTagsService (Story 6.13 · Subtask 6.13.5) — the topic-tag half of the
// project square: per-project tagging (admin-gated) + the public tag-FACET read
// that makes the square browsable by category. Over the 6.13.5 repositories.
// Owns validation, the permission gates, the set-replace transaction, and DTO
// mapping; routes are HTTP-only (CLAUDE.md).
//
// AUTHORIZATION:
//   * Tagging WRITE (`setProjectTags`) is project-admin-gated — the 6.4 two-tier
//     check (`projectAccessService.assertCanManage`: workspace owner/admin always
//     pass; otherwise project role `admin`). A non-admin → NotProjectAdminError
//     (403); a non-browser → ProjectNotFoundError (404, no existence leak).
//   * The per-project READ (`getProjectTags`) is browse-gated (the settings
//     editor + any member surface) — a hidden / cross-tenant project reads 404.
//   * The category FACET read (`listCategories`) is FULLY PUBLIC — it feeds the
//     anonymous square (6.13.2's posture), so it takes no actor and runs no
//     gate; its `public`-only filter lives in the repository aggregate.
//
// VOCABULARY: tags are a CURATED, normalized set (lib/projectTags/vocabulary.ts)
// — the admin assigns from it, never mints free-text (the "clean browse axis"
// decision). A slug outside the vocabulary is InvalidProjectTagError (422). Tags
// are reusable across projects: the shared `ProjectTag` row is materialized by
// slug (idempotent upsert), so two projects tagged `design` point at ONE row and
// the facet counts them together.

/**
 * Resolve the project by its workspace-scoped identifier ("PROD") — a
 * cross-tenant or unknown key throws ProjectNotFoundError (404, no existence
 * leak), the componentsService resolution.
 */
async function resolveProject(key: string, ctx: WorkspaceContext): Promise<Project> {
  const identifier = key.trim().toUpperCase();
  const project = await projectRepository.findByIdentifier(ctx.workspaceId, identifier);
  if (!project) throw new ProjectNotFoundError(key);
  return project;
}

/**
 * Validate a desired tag-slug list against the curated vocabulary and the cap,
 * de-duplicating to the resolved entries. Pure (no IO) — runs before the
 * set-replace transaction. Throws InvalidProjectTagError on an off-vocabulary
 * slug, TooManyProjectTagsError over the per-project cap.
 */
function resolveDesiredTags(slugs: string[]): ProjectTagVocabularyEntry[] {
  const bySlug = new Map<string, ProjectTagVocabularyEntry>();
  for (const raw of slugs) {
    const slug = raw.trim();
    const entry = vocabularyEntry(slug);
    if (!entry) throw new InvalidProjectTagError(slug);
    bySlug.set(entry.slug, entry);
  }
  if (bySlug.size > MAX_TAGS_PER_PROJECT) {
    throw new TooManyProjectTagsError(MAX_TAGS_PER_PROJECT);
  }
  return [...bySlug.values()];
}

export const projectTagsService = {
  /**
   * The project's assigned topic tags, in label order (the settings editor's
   * current selection + any member-facing chip row). Browse-gated; a hidden /
   * cross-tenant project reads as 404.
   */
  async getProjectTags(key: string, ctx: WorkspaceContext): Promise<ProjectTagDto[]> {
    const project = await resolveProject(key, ctx);
    await projectAccessService.assertCanBrowse(project.id, ctx);
    const assignments = await projectTagAssignmentRepository.findByProject(project.id);
    return assignments.map((a) => toProjectTagDto(a.tag));
  },

  /**
   * SET a project's topic tags to exactly `slugs` (the idempotent full-replace
   * the per-project tag editor PUTs). Project-admin-gated. Validates the slugs
   * against the curated vocabulary + the cap, materializes the shared tag rows
   * (idempotent by slug — cross-project reuse), then diffs the project's current
   * assignments against the desired set and applies the add/remove inside ONE
   * transaction. Returns the resulting tags in label order.
   */
  async setProjectTags(
    key: string,
    slugs: string[],
    ctx: WorkspaceContext,
  ): Promise<ProjectTagDto[]> {
    const project = await resolveProject(key, ctx);
    const desired = resolveDesiredTags(slugs);

    return db.$transaction(async (tx) => {
      await projectAccessService.assertCanManage(project.id, ctx, tx);

      // Materialize the curated vocabulary rows (idempotent by slug → shared
      // across projects), giving each desired slug a tag id to link.
      const desiredTagIds = new Set<string>();
      for (const entry of desired) {
        const tag = await projectTagRepository.upsertBySlug(
          { slug: entry.slug, label: entry.label },
          tx,
        );
        desiredTagIds.add(tag.id);
      }

      const current = await projectTagAssignmentRepository.findByProject(project.id, tx);
      const currentTagIds = new Set(current.map((a) => a.tagId));

      const toRemove = [...currentTagIds].filter((id) => !desiredTagIds.has(id));
      const toAdd = [...desiredTagIds].filter((id) => !currentTagIds.has(id));

      await projectTagAssignmentRepository.deleteByProjectAndTags(project.id, toRemove, tx);
      await projectTagAssignmentRepository.createMany(
        toAdd.map((tagId) => ({ projectId: project.id, tagId })),
        tx,
      );

      const after = await projectTagAssignmentRepository.findByProject(project.id, tx);
      return after.map((a) => toProjectTagDto(a.tag));
    });
  },

  /**
   * The square's browse-by-topic FACET — every category that has at least one
   * PUBLIC project, with its public-project count, sorted by count desc then
   * label (the GitLab "topics sorted by number of associated projects" view).
   * FULLY PUBLIC: no actor, no gate (the `public`-only filter lives in the
   * repository aggregate). Feeds the 6.13.3 category filter + the categories
   * browse panel. A tag with only non-public projects is absent (count 0), so it
   * never inflates the square.
   */
  async listCategories(): Promise<ProjectCategoryDto[]> {
    const rows = await projectTagRepository.listWithPublicCounts();
    return rows
      .filter((r) => r.publicProjectCount > 0)
      .map((r) =>
        toProjectCategoryDto({ slug: r.slug, label: r.label, projectCount: r.publicProjectCount }),
      )
      .sort((a, b) => b.projectCount - a.projectCount || a.label.localeCompare(b.label));
  },
};
