import { Prisma, type ProjectTag } from '@prisma/client';
import { db } from '@/lib/db';

// projectTagRepository (Story 6.13 · Subtask 6.13.5) — single-op access to the
// SHARED topic vocabulary (`project_tag`). A tag is system-level reference data
// (no tenant scope): one row per topic, reused across every project via
// `project_tag_assignment`. Per CLAUDE.md each method is one Prisma op; writes
// require `tx`.

/** A vocabulary tag plus the count of PUBLIC projects carrying it (facet read). */
export interface ProjectTagWithPublicCount {
  slug: string;
  label: string;
  /** Public, non-archived projects assigned this tag (the browse-axis count). */
  publicProjectCount: number;
}

export const projectTagRepository = {
  /**
   * Materialize a vocabulary tag by its stable `slug` — idempotent, so a topic
   * shared across projects resolves to ONE row. `update: {}` makes a re-assign a
   * no-op write (the label is owned by the curated vocabulary, not patched here).
   */
  async upsertBySlug(
    input: { slug: string; label: string },
    tx: Prisma.TransactionClient,
  ): Promise<ProjectTag> {
    return tx.projectTag.upsert({
      where: { slug: input.slug },
      create: { slug: input.slug, label: input.label },
      update: {},
    });
  },

  /** The tag rows for a set of slugs (empty in → empty out, no query). */
  async findBySlugs(slugs: string[]): Promise<ProjectTag[]> {
    if (slugs.length === 0) return [];
    return db.projectTag.findMany({ where: { slug: { in: slugs } } });
  },

  /**
   * Every tag with its PUBLIC-project assignment count — the tag-FACET read that
   * backs the square's category browse (6.13.3 + the categories panel). The
   * filtered `_count` runs the `access_level = 'public'` (and `archivedAt: null`)
   * predicate INSIDE the relation aggregate, so a non-public or archived
   * project's assignment never inflates a tag's count. Pure read (no `tx`).
   */
  async listWithPublicCounts(): Promise<ProjectTagWithPublicCount[]> {
    const rows = await db.projectTag.findMany({
      select: {
        slug: true,
        label: true,
        _count: {
          select: {
            assignments: { where: { project: { accessLevel: 'public', archivedAt: null } } },
          },
        },
      },
    });
    return rows.map((r) => ({
      slug: r.slug,
      label: r.label,
      publicProjectCount: r._count.assignments,
    }));
  },
};
