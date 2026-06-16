import { Prisma, type ProjectTag, type ProjectTagAssignment } from '@prisma/client';
import { db } from '@/lib/db';

// projectTagAssignmentRepository (Story 6.13 · Subtask 6.13.5) — single-op
// access to the project ↔ tag join (`project_tag_assignment`). The tagging
// service orchestrates the set-replace diff across these leaves inside ONE
// transaction; per CLAUDE.md each method is one Prisma op, writes require `tx`.

/** A join row with its resolved vocabulary tag (the chip-projection source). */
export type AssignmentWithTag = ProjectTagAssignment & { tag: ProjectTag };

export const projectTagAssignmentRepository = {
  /**
   * A project's tag assignments, each with its tag, ordered by tag label (a
   * stable chip order). Used by the browse read (no `tx`) AND inside the
   * set-replace transaction (the post-write read-back), so `tx` is optional —
   * it is a read, never a guarded write.
   */
  async findByProject(
    projectId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<AssignmentWithTag[]> {
    return (tx ?? db).projectTagAssignment.findMany({
      where: { projectId },
      include: { tag: true },
      orderBy: { tag: { label: 'asc' } },
    });
  },

  /** Link a set of tags to a project; `skipDuplicates` makes it idempotent. */
  async createMany(
    rows: { projectId: string; tagId: string }[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await tx.projectTagAssignment.createMany({ data: rows, skipDuplicates: true });
    return result.count;
  },

  /** Unlink a set of tags from a project (the set-replace remove branch). */
  async deleteByProjectAndTags(
    projectId: string,
    tagIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (tagIds.length === 0) return 0;
    const result = await tx.projectTagAssignment.deleteMany({
      where: { projectId, tagId: { in: tagIds } },
    });
    return result.count;
  },
};
