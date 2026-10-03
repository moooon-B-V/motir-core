import type { Prisma } from '@/generated/prisma/client';

// Decision-page publication repository — single operations on
// `decision_page_publication` (Story MOTIR-5761 · MOTIR-7428;
// `docs/decisions/approval-gates.md` §8 NINTH AMENDMENT, clause 1). One row per
// publish, append-only; the NEWEST row for a work item is its published page.
//
// ⚠️ EVERY METHOD TAKES A REQUIRED `tx`, reads included — `pageVersionRepository`'s
// reasoning: the table carries the workspace policy pair and no system arm, so an
// UNBOUND read returns nothing and raises nothing.

/** One publication, as every read returns it. */
export interface DecisionPagePublicationRecord {
  id: string;
  workItemId: string;
  pageId: string;
  pageVersionId: string;
  publishedById: string;
  publishedAt: Date;
}

/** What `insert` writes. */
export interface DecisionPagePublicationInsert {
  workspaceId: string;
  projectId: string;
  workItemId: string;
  pageId: string;
  pageVersionId: string;
  publishedById: string;
  publishedAt: Date;
}

const PUBLICATION_SELECT = {
  id: true,
  workItemId: true,
  pageId: true,
  pageVersionId: true,
  publishedById: true,
  publishedAt: true,
} as const;

export const decisionPagePublicationRepository = {
  async insert(
    data: DecisionPagePublicationInsert,
    tx: Prisma.TransactionClient,
  ): Promise<DecisionPagePublicationRecord> {
    return tx.decisionPagePublication.create({ data, select: PUBLICATION_SELECT });
  },

  /** The work item's published page — its newest publication — or `null`. */
  async latestForWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<DecisionPagePublicationRecord | null> {
    return tx.decisionPagePublication.findFirst({
      where: { workItemId },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      select: PUBLICATION_SELECT,
    });
  },
};
