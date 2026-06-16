// DTOs for the project-tags domain (Story 6.13 · Subtask 6.13.5) — the topic
// tags a project carries + the tag-FACET categories the public-project square
// browses by. No Prisma row crosses the boundary (no `@prisma/client` import).

/**
 * One topic tag, as carried on a project — the chip shown in project settings
 * and (when public) on the square card. `slug` is the stable category-filter
 * handle (6.13.3); `label` is the display name from the curated vocabulary.
 */
export interface ProjectTagDto {
  slug: string;
  label: string;
}

/**
 * One category in the square's browse-by-topic facet (the GitLab "topics sorted
 * by number of associated projects" view) — a tag plus its PUBLIC-project count.
 * `projectCount` counts ONLY `public`, non-archived projects (the 6.13.2 filter
 * the facet respects), so a tag with only non-public projects is absent from
 * this list and never inflates the square.
 */
export interface ProjectCategoryDto {
  slug: string;
  label: string;
  /** Number of PUBLIC projects carrying this tag (the browse-axis sort key). */
  projectCount: number;
}
