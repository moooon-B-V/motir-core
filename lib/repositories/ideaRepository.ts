import type { IdeaCategory, IdeaKind, IdeaStatus, Prisma } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

/**
 * The idea store's STAFF data access (Story MOTIR-7662 · MOTIR-7671) — Prisma
 * only, one operation per method, no logic.
 *
 * Writes take a REQUIRED `tx`: every one runs inside the platform write
 * transaction (`withPlatformWrite`), which binds `app.platform_staff` — the only
 * thing the tables' write policies admit — and appends the audit rows. Reads
 * take an optional `tx` and fall back to `dbRead` (the tables' SELECT policy is
 * unconditional), so a guard read joins the transaction whose write it gates.
 *
 * Public reads are NOT here: `ideaPublicRepository` filters `status = 'active'`
 * on every query, and keeping the two apart is what stops a staff read from
 * ever backing a public route.
 */

/** An idea with its ordered evidence and its tags — the shape every DTO maps from. */
export const IDEA_WITH_RELATIONS = {
  evidence: { orderBy: { position: 'asc' } },
  tags: { include: { tag: true } },
} as const satisfies Prisma.IdeaInclude;

export type IdeaWithRelations = Prisma.IdeaGetPayload<{ include: typeof IDEA_WITH_RELATIONS }>;

/** The columns an idea write sets — the repository's own name for its input. */
export interface IdeaRowInput {
  slug: string;
  title: string;
  pitch: string;
  kind: IdeaKind;
  category: IdeaCategory;
  capabilities: string[];
  gap: string | null;
  whyNow: string | null;
  whyMotir: string | null;
  whoElse: string | null;
}

/** One evidence row to write, in list order (its index becomes `position`). */
export interface IdeaEvidenceRowInput {
  claim: string;
  sourceName: string;
  url: string;
  sourceDate: Date | null;
}

/** A sparse column update, plus wholesale replacements of evidence and tags. */
export interface IdeaRowUpdate extends Partial<IdeaRowInput> {
  lastReviewedAt?: Date;
  /** Replace the evidence list (delete every row, insert these). */
  evidence?: IdeaEvidenceRowInput[];
  /** Replace the tag set by tag ID. */
  tagIds?: string[];
}

/** The staff list's query — every status unless one is named. */
export interface StaffIdeaQuery {
  status?: IdeaStatus;
  kind?: IdeaKind;
  category?: IdeaCategory;
  tag?: string;
  q?: string;
  /** Keyset position: the last row of the previous page. */
  after?: { addedAt: Date; id: string } | null;
  limit: number;
}

function evidenceCreate(evidence: IdeaEvidenceRowInput[]) {
  return evidence.map((e, position) => ({
    position,
    claim: e.claim,
    sourceName: e.sourceName,
    url: e.url,
    sourceDate: e.sourceDate,
  }));
}

function staffWhere(query: Omit<StaffIdeaQuery, 'limit'>): Prisma.IdeaWhereInput {
  const and: Prisma.IdeaWhereInput[] = [];
  if (query.status) and.push({ status: query.status });
  if (query.kind) and.push({ kind: query.kind });
  if (query.category) and.push({ category: query.category });
  if (query.tag) and.push({ tags: { some: { tag: { slug: query.tag } } } });
  if (query.q) {
    const contains = { contains: query.q, mode: 'insensitive' as const };
    and.push({
      OR: [
        { title: contains },
        { pitch: contains },
        { gap: contains },
        { tags: { some: { tag: { label: contains } } } },
      ],
    });
  }
  if (query.after) {
    and.push({
      OR: [
        { addedAt: { lt: query.after.addedAt } },
        { addedAt: query.after.addedAt, id: { lt: query.after.id } },
      ],
    });
  }
  return { AND: and };
}

export const ideaRepository = {
  /** Insert one idea with its evidence (in order) and its tag assignments. */
  async create(
    data: IdeaRowInput,
    evidence: IdeaEvidenceRowInput[],
    tagIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<IdeaWithRelations> {
    return tx.idea.create({
      data: {
        ...data,
        evidence: { create: evidenceCreate(evidence) },
        tags: { create: tagIds.map((tagId) => ({ tagId })) },
      },
      include: IDEA_WITH_RELATIONS,
    });
  },

  /** Apply a sparse update; evidence and tags, when given, are replaced wholesale. */
  async updateBySlug(
    slug: string,
    update: IdeaRowUpdate,
    tx: Prisma.TransactionClient,
  ): Promise<IdeaWithRelations> {
    const { evidence, tagIds, ...columns } = update;
    return tx.idea.update({
      where: { slug },
      data: {
        ...columns,
        ...(evidence ? { evidence: { deleteMany: {}, create: evidenceCreate(evidence) } } : {}),
        ...(tagIds ? { tags: { deleteMany: {}, create: tagIds.map((tagId) => ({ tagId })) } } : {}),
      },
      include: IDEA_WITH_RELATIONS,
    });
  },

  /**
   * Retire an ACTIVE idea. A conditional update — `WHERE status = 'active'` —
   * so two concurrent retires cannot both succeed: the loser touches no row.
   * Returns the number of rows changed (0 or 1).
   */
  async retireBySlug(
    slug: string,
    reason: string,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.idea.updateMany({
      where: { slug, status: 'active' },
      data: { status: 'retired', retiredReason: reason, retiredAt: at },
    });
    return result.count;
  },

  /** Hard-delete an idea; its evidence and tag assignments cascade. */
  async deleteById(id: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.idea.delete({ where: { id } });
  },

  /** One idea of any status, or null — the staff console's and skill's read. */
  async findBySlugForStaff(slug: string): Promise<IdeaWithRelations | null> {
    return dbRead.idea.findUnique({ where: { slug }, include: IDEA_WITH_RELATIONS });
  },

  /** The same read inside a write transaction — the row a write is about to change. */
  async findBySlugInTx(
    slug: string,
    tx: Prisma.TransactionClient,
  ): Promise<IdeaWithRelations | null> {
    return tx.idea.findUnique({ where: { slug }, include: IDEA_WITH_RELATIONS });
  },

  /** One page of ideas of any status, newest first, keyset on `(addedAt, id)`. */
  async findAllForStaff(query: StaffIdeaQuery): Promise<IdeaWithRelations[]> {
    return dbRead.idea.findMany({
      where: staffWhere(query),
      orderBy: [{ addedAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      include: IDEA_WITH_RELATIONS,
    });
  },

  /** Which of these slugs are already in the store (any status) — the batch-add guard. */
  async existingSlugs(slugs: string[], tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.idea.findMany({
      where: { slug: { in: slugs } },
      select: { slug: true },
    });
    return rows.map((r) => r.slug);
  },
};
