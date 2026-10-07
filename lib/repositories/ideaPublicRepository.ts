import type { IdeaCategory, IdeaKind, Prisma } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import { IDEA_WITH_RELATIONS, type IdeaWithRelations } from './ideaRepository';

/**
 * The idea store's PUBLIC data access (Story MOTIR-7662 · MOTIR-7672) — what an
 * anonymous reader may see. Prisma only, reads only.
 *
 * ⚠️ EVERY query here carries `status = 'active'`. That predicate is the whole
 * difference between this file and `ideaRepository`'s staff reads, so it is
 * written into each method rather than left to a caller: a retired idea must
 * never reach a public route, whoever calls this.
 */

/** The public list's query. `tags` are AND-combined: an idea must carry every one. */
export interface PublicIdeaQuery {
  category?: IdeaCategory;
  tags?: string[];
  q?: string;
  kind?: IdeaKind;
}

/** A category and how many active ideas match in it. */
export interface IdeaCategoryCountRow {
  category: IdeaCategory;
  count: number;
}

/** A tag and how many ACTIVE ideas carry it. */
export interface IdeaTagCountRow {
  slug: string;
  label: string;
  count: number;
}

function activeWhere(query: PublicIdeaQuery): Prisma.IdeaWhereInput {
  const and: Prisma.IdeaWhereInput[] = [{ status: 'active' }];
  if (query.category) and.push({ category: query.category });
  if (query.kind) and.push({ kind: query.kind });
  for (const slug of query.tags ?? []) and.push({ tags: { some: { tag: { slug } } } });
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
  return { AND: and };
}

export const ideaPublicRepository = {
  /**
   * Active ideas matching the query — `motir_buys` first (the enum's order),
   * then newest first. `take` is the caller's cap (+1 so it can tell it hit it).
   */
  async listActive(query: PublicIdeaQuery, take: number): Promise<IdeaWithRelations[]> {
    return dbRead.idea.findMany({
      where: activeWhere(query),
      orderBy: [{ kind: 'asc' }, { addedAt: 'desc' }, { id: 'desc' }],
      take,
      include: IDEA_WITH_RELATIONS,
    });
  },

  /** Active ideas per category for the query (the caller drops `category` itself). */
  async categoryCounts(query: PublicIdeaQuery): Promise<IdeaCategoryCountRow[]> {
    const rows = await dbRead.idea.groupBy({
      by: ['category'],
      where: activeWhere(query),
      _count: { _all: true },
    });
    return rows.map((r) => ({ category: r.category, count: r._count._all }));
  },

  /** Every tag carried by at least one ACTIVE idea, with that count. */
  async tagCounts(): Promise<IdeaTagCountRow[]> {
    const rows = await dbRead.ideaTag.findMany({
      where: { assignments: { some: { idea: { status: 'active' } } } },
      select: {
        slug: true,
        label: true,
        _count: { select: { assignments: { where: { idea: { status: 'active' } } } } },
      },
      orderBy: { slug: 'asc' },
    });
    return rows.map((r) => ({ slug: r.slug, label: r.label, count: r._count.assignments }));
  },

  /** One ACTIVE idea by slug, or null — a retired slug reads exactly like an unknown one. */
  async findActiveBySlug(slug: string): Promise<IdeaWithRelations | null> {
    return dbRead.idea.findFirst({
      where: { slug, status: 'active' },
      include: IDEA_WITH_RELATIONS,
    });
  },
};
