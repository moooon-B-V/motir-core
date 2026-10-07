import type { IdeaTag, Prisma } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

/**
 * The idea store's TAG VOCABULARY (Story MOTIR-7662 · MOTIR-7671) — Prisma
 * only. Writes, and the reads that guard them, take a required `tx` (the
 * platform write transaction); the console's list reads `dbRead`.
 */

/** A vocabulary tag with how many ideas of ANY status carry it. */
export type IdeaTagWithCount = IdeaTag & { _count: { assignments: number } };

export const ideaTagRepository = {
  async create(
    data: { slug: string; label: string; description: string },
    tx: Prisma.TransactionClient,
  ): Promise<IdeaTag> {
    return tx.ideaTag.create({ data });
  },

  /** The vocabulary rows for these slugs (those that exist). */
  async findBySlugs(slugs: string[], tx: Prisma.TransactionClient): Promise<IdeaTag[]> {
    return tx.ideaTag.findMany({ where: { slug: { in: slugs } } });
  },

  /** The whole vocabulary, by slug, with usage counts over every status. */
  async listAll(): Promise<IdeaTagWithCount[]> {
    return dbRead.ideaTag.findMany({
      orderBy: { slug: 'asc' },
      include: { _count: { select: { assignments: true } } },
    });
  },
};
