import type { IdeaResearchRun, Prisma } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

/**
 * The `motir-ideas` skill's RESEARCH-RUN LOG (Story MOTIR-7662 · MOTIR-7671) —
 * Prisma only. The write takes a required `tx` (the platform write
 * transaction); the read falls back to `dbRead`.
 */
export const ideaResearchRunRepository = {
  async create(
    data: {
      actorUserId: string;
      areasCovered: string[];
      addedCount: number;
      retiredCount: number;
      reportMd: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<IdeaResearchRun> {
    return tx.ideaResearchRun.create({ data });
  },

  /** The most recent runs, newest first. */
  async listRecent(limit: number): Promise<IdeaResearchRun[]> {
    return dbRead.ideaResearchRun.findMany({ orderBy: { ranAt: 'desc' }, take: limit });
  },
};
