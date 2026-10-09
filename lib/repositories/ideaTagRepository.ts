import type {
  IdeaTag,
  IdeaTagTranslation,
  IdeaTranslationLocale,
  Prisma,
} from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import { IDEA_TRANSLATION_LOCALES } from '@/lib/ideas/translatableFields';

/**
 * The idea store's TAG VOCABULARY (Story MOTIR-7662 · MOTIR-7671) — Prisma
 * only. Writes, and the reads that guard them, take a required `tx` (the
 * platform write transaction); the console's list reads `dbRead`.
 *
 * A tag's `label` is translated per locale (Story MOTIR-7772 · MOTIR-7773); its
 * staff-facing `description` is not. The reads carry the label translations of
 * the locale they are given, or of every locale when given none — this is the
 * staff side, where every locale is the default.
 */

/** A vocabulary tag with its label translations. */
export type IdeaTagWithTranslations = IdeaTag & { translations: IdeaTagTranslation[] };

/** A vocabulary tag with how many ideas of ANY status carry it. */
export type IdeaTagWithCount = IdeaTagWithTranslations & { _count: { assignments: number } };

function translationsOf(locale: IdeaTranslationLocale | undefined) {
  return { where: { locale: { in: locale ? [locale] : [...IDEA_TRANSLATION_LOCALES] } } };
}

export const ideaTagRepository = {
  async create(
    data: { slug: string; label: string; description: string },
    tx: Prisma.TransactionClient,
  ): Promise<IdeaTag> {
    return tx.ideaTag.create({ data });
  },

  /** The vocabulary rows for these slugs (those that exist), with their label translations. */
  async findBySlugs(
    slugs: string[],
    tx: Prisma.TransactionClient,
    locale?: IdeaTranslationLocale,
  ): Promise<IdeaTagWithTranslations[]> {
    return tx.ideaTag.findMany({
      where: { slug: { in: slugs } },
      include: { translations: translationsOf(locale) },
    });
  },

  /** The whole vocabulary, by slug, with usage counts over every status. */
  async listAll(locale?: IdeaTranslationLocale): Promise<IdeaTagWithCount[]> {
    return dbRead.ideaTag.findMany({
      orderBy: { slug: 'asc' },
      include: {
        _count: { select: { assignments: true } },
        translations: translationsOf(locale),
      },
    });
  },

  /** Write a tag's label in one locale — insert, or overwrite that locale's label. */
  async upsertTagTranslation(
    tagId: string,
    locale: IdeaTranslationLocale,
    label: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.$executeRaw`
      INSERT INTO "idea_tag_translation" ("tag_id", "locale", "label")
      VALUES (${tagId}, ${locale}::"idea_translation_locale", ${label})
      ON CONFLICT ("tag_id", "locale") DO UPDATE SET "label" = EXCLUDED."label"
    `;
  },

  /** Drop a tag's label translations in every locale. Returns the rows deleted. */
  async clearTagLabelTranslations(tagId: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.ideaTagTranslation.deleteMany({ where: { tagId } });
    return result.count;
  },
};
