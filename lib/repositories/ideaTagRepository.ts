import type { IdeaTag, Prisma } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

/**
 * The idea store's TAG VOCABULARY (Story MOTIR-7662 · MOTIR-7671) — Prisma
 * only. Writes take a required `tx` (the platform write transaction); reads
 * fall back to `dbRead`.
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
  async findBySlugs(slugs: string[], tx?: Prisma.TransactionClient): Promise<IdeaTag[]> {
    const client = tx ?? dbRead;
    return client.ideaTag.findMany({ where: { slug: { in: slugs } } });
  },

  /** The whole vocabulary, by slug, with usage counts over every status. */
  async listAll(tx?: Prisma.TransactionClient): Promise<IdeaTagWithCount[]> {
    const client = tx ?? dbRead;
    return client.ideaTag.findMany({
      orderBy: { slug: 'asc' },
      include: { _count: { select: { assignments: true } } },
    });
  },
};
