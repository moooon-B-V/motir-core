import type {
  IdeaCategory,
  IdeaKind,
  IdeaTranslationLocale,
  Prisma,
} from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import { ideaInclude, type IdeaWithRelations } from './ideaRepository';

/**
 * The idea store's PUBLIC data access (Story MOTIR-7662 · MOTIR-7672) — what an
 * anonymous reader may see. Prisma only, reads only.
 *
 * ⚠️ EVERY query here carries `status = 'active'`. That predicate is the whole
 * difference between this file and `ideaRepository`'s staff reads, so it is
 * written into each method rather than left to a caller: a retired idea must
 * never reach a public route, whoever calls this.
 *
 * The reads take an optional `locale` (Story MOTIR-7772 · MOTIR-7773): given,
 * they carry that locale's translation rows for the idea, its evidence and its
 * tags; omitted, they carry none, and read exactly as they did before.
 */

function includeFor(locale: IdeaTranslationLocale | undefined) {
  return ideaInclude(locale ? [locale] : []);
}

/** The public list's query. `tags` are AND-combined: an idea must carry every one. */
export interface PublicIdeaQuery {
  category?: IdeaCategory;
  tags: string[];
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
  /** The label in the requested locale, when one was requested and is stored. */
  translatedLabel: string | null;
  count: number;
}

function activeWhere(
  query: PublicIdeaQuery,
  locale: IdeaTranslationLocale | undefined,
): Prisma.IdeaWhereInput {
  const and: Prisma.IdeaWhereInput[] = [{ status: 'active' }];
  if (query.category) and.push({ category: query.category });
  if (query.kind) and.push({ kind: query.kind });
  for (const slug of query.tags) and.push({ tags: { some: { tag: { slug } } } });
  if (query.q) {
    const contains = { contains: query.q, mode: 'insensitive' as const };
    const or: Prisma.IdeaWhereInput[] = [
      { title: contains },
      { pitch: contains },
      { gap: contains },
      { tags: { some: { tag: { label: contains } } } },
    ];
    // MOTIR-7775: under a locale, the same substring match over that locale's
    // text too — substring, so CJK text (no word boundaries, no case) matches.
    if (locale) {
      or.push(
        {
          translations: {
            some: { locale, OR: [{ title: contains }, { pitch: contains }, { gap: contains }] },
          },
        },
        { tags: { some: { tag: { translations: { some: { locale, label: contains } } } } } },
      );
    }
    and.push({ OR: or });
  }
  return { AND: and };
}

export const ideaPublicRepository = {
  /**
   * Active ideas matching the query — `motir_buys` first (the enum's order),
   * then newest first. `take` is the caller's cap (+1 so it can tell it hit it).
   */
  async listActive(
    query: PublicIdeaQuery,
    take: number,
    locale?: IdeaTranslationLocale,
  ): Promise<IdeaWithRelations[]> {
    return dbRead.idea.findMany({
      where: activeWhere(query, locale),
      orderBy: [{ kind: 'asc' }, { addedAt: 'desc' }, { id: 'desc' }],
      take,
      include: includeFor(locale),
    });
  },

  /**
   * Active ideas per category for the query (the caller drops `category`
   * itself), under the same `locale` as the list so `q` counts the same ideas.
   */
  async categoryCounts(
    query: PublicIdeaQuery,
    locale?: IdeaTranslationLocale,
  ): Promise<IdeaCategoryCountRow[]> {
    const rows = await dbRead.idea.groupBy({
      by: ['category'],
      where: activeWhere(query, locale),
      _count: { _all: true },
    });
    return rows.map((r) => ({ category: r.category, count: r._count._all }));
  },

  /** Every tag carried by at least one ACTIVE idea, with that count. */
  async tagCounts(locale?: IdeaTranslationLocale): Promise<IdeaTagCountRow[]> {
    const rows = await dbRead.ideaTag.findMany({
      where: { assignments: { some: { idea: { status: 'active' } } } },
      select: {
        slug: true,
        label: true,
        translations: {
          where: { locale: { in: locale ? [locale] : [] } },
          select: { label: true },
        },
        _count: { select: { assignments: { where: { idea: { status: 'active' } } } } },
      },
      orderBy: { slug: 'asc' },
    });
    return rows.map((r) => ({
      slug: r.slug,
      label: r.label,
      translatedLabel: r.translations[0]?.label ?? null,
      count: r._count.assignments,
    }));
  },

  /** One ACTIVE idea by slug, or null — a retired slug reads exactly like an unknown one. */
  async findActiveBySlug(
    slug: string,
    locale?: IdeaTranslationLocale,
  ): Promise<IdeaWithRelations | null> {
    return dbRead.idea.findFirst({
      where: { slug, status: 'active' },
      include: includeFor(locale),
    });
  },
};
