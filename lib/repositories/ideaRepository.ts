import {
  Prisma,
  type IdeaCategory,
  type IdeaKind,
  type IdeaStatus,
  type IdeaTranslationLocale,
} from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import {
  IDEA_TRANSLATION_LOCALES,
  type IdeaTranslatableField,
  type IdeaTranslationFields,
} from '@/lib/ideas/translatableFields';

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

/**
 * An idea with its ordered evidence and its tags, and — for each of the three —
 * the translation rows of the given locales (Story MOTIR-7772 · MOTIR-7773).
 * Staff reads pass every locale; a public read passes the one it was asked for,
 * or none. ONE include shape for every list, so every read maps from the same
 * payload type and an empty list simply means "no translations loaded".
 */
export function ideaInclude(locales: readonly IdeaTranslationLocale[]) {
  const translations = { where: { locale: { in: [...locales] } } };
  return {
    translations,
    evidence: { orderBy: { position: 'asc' }, include: { translations } },
    tags: { include: { tag: { include: { translations } } } },
  } as const satisfies Prisma.IdeaInclude;
}

/** Every translation locale — what a staff read and a staff write return. */
const ALL_LOCALES = ideaInclude(IDEA_TRANSLATION_LOCALES);

export type IdeaWithRelations = Prisma.IdeaGetPayload<{ include: ReturnType<typeof ideaInclude> }>;

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

/** One locale's text to write: only the fields present are written. */
export type IdeaTranslationWrite = Partial<IdeaTranslationFields>;

/** A translatable field's column in `idea_translation` (the schema's `@map`). */
const TRANSLATION_COLUMN: Record<IdeaTranslatableField, string> = {
  title: 'title',
  pitch: 'pitch',
  capabilities: 'capabilities',
  gap: 'gap',
  whyNow: 'why_now',
  whyMotir: 'why_motir',
  whoElse: 'who_else',
};

/** A field's value in SQL, cast to its column's type. */
function translationValue(field: IdeaTranslatableField, value: unknown): Prisma.Sql {
  return field === 'capabilities'
    ? Prisma.sql`${(value as string[] | undefined) ?? []}::text[]`
    : Prisma.sql`${(value as string | null | undefined) ?? null}::text`;
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
      include: ALL_LOCALES,
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
      include: ALL_LOCALES,
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
    return dbRead.idea.findUnique({ where: { slug }, include: ALL_LOCALES });
  },

  /** The same read inside a write transaction — the row a write is about to change. */
  async findBySlugInTx(
    slug: string,
    tx: Prisma.TransactionClient,
  ): Promise<IdeaWithRelations | null> {
    return tx.idea.findUnique({ where: { slug }, include: ALL_LOCALES });
  },

  /** One page of ideas of any status, newest first, keyset on `(addedAt, id)`. */
  async findAllForStaff(query: StaffIdeaQuery): Promise<IdeaWithRelations[]> {
    return dbRead.idea.findMany({
      where: staffWhere(query),
      orderBy: [{ addedAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      include: ALL_LOCALES,
    });
  },

  /**
   * Write ONLY the supplied fields of one `(idea, locale)` translation and leave
   * the others as they are — one `INSERT … ON CONFLICT DO UPDATE SET <supplied
   * columns>`, so a merge is a single atomic statement. Not a Prisma `upsert`,
   * which is a find-then-create and races to a unique violation on a fresh pair.
   * It never touches the `idea` row, so `Idea.updatedAt` does not move.
   * Returns the rows written (always 1); a call with no fields writes nothing.
   */
  async upsertTranslations(
    ideaId: string,
    locale: IdeaTranslationLocale,
    fields: IdeaTranslationWrite,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const supplied = (Object.keys(TRANSLATION_COLUMN) as IdeaTranslatableField[]).filter(
      (f) => fields[f] !== undefined,
    );
    if (supplied.length === 0) return 0;
    const columns = supplied.map((f) => Prisma.raw(`"${TRANSLATION_COLUMN[f]}"`));
    const values = supplied.map((f) => translationValue(f, fields[f]));
    const sets = supplied.map((f) =>
      Prisma.raw(`"${TRANSLATION_COLUMN[f]}" = EXCLUDED."${TRANSLATION_COLUMN[f]}"`),
    );
    return tx.$executeRaw`
      INSERT INTO "idea_translation" ("idea_id", "locale", ${Prisma.join(columns)}, "updated_at")
      VALUES (${ideaId}, ${locale}::"idea_translation_locale", ${Prisma.join(values)}, now())
      ON CONFLICT ("idea_id", "locale") DO UPDATE
      SET ${Prisma.join(sets)}, "updated_at" = now()
    `;
  },

  /**
   * Mark these fields MISSING in every locale of the idea — null, or an empty
   * list for `capabilities`. The primitive behind the write service's
   * drop-stale-locales rule. Returns the number of locale rows touched.
   */
  async clearTranslatedFields(
    ideaId: string,
    fields: readonly IdeaTranslatableField[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (fields.length === 0) return 0;
    const data: Prisma.IdeaTranslationUpdateManyMutationInput = {};
    for (const field of fields) {
      if (field === 'capabilities') data.capabilities = [];
      else data[field] = null;
    }
    const result = await tx.ideaTranslation.updateMany({ where: { ideaId }, data });
    return result.count;
  },

  /** Replace one evidence row's claim translations wholesale (delete all, insert these). */
  async replaceEvidenceTranslations(
    evidenceId: string,
    byLocale: Partial<Record<IdeaTranslationLocale, string>>,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const create = (Object.entries(byLocale) as [IdeaTranslationLocale, string][]).map(
      ([locale, claim]) => ({ locale, claim }),
    );
    await tx.ideaEvidence.update({
      where: { id: evidenceId },
      data: { translations: { deleteMany: {}, create } },
    });
  },

  /** Write one evidence row's claim in one locale — insert, or overwrite that locale's claim. */
  async upsertEvidenceTranslation(
    evidenceId: string,
    locale: IdeaTranslationLocale,
    claim: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.$executeRaw`
      INSERT INTO "idea_evidence_translation" ("evidence_id", "locale", "claim")
      VALUES (${evidenceId}, ${locale}::"idea_translation_locale", ${claim})
      ON CONFLICT ("evidence_id", "locale") DO UPDATE SET "claim" = EXCLUDED."claim"
    `;
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
