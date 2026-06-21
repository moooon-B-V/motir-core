import type { CanvasNodePosition, Prisma } from '@prisma/client';
import { db } from '@/lib/db';

// Single-op data access for `CanvasNodePosition` (CLAUDE.md 4-layer). Reads use
// the `db` singleton; the write requires a `tx` (the service owns the transaction).

export const canvasNodePositionRepository = {
  // All of a user's saved node positions for one project.
  async findByUserAndProject(userId: string, projectId: string): Promise<CanvasNodePosition[]> {
    return db.canvasNodePosition.findMany({
      where: { userId, projectId },
      orderBy: { nodeKey: 'asc' },
    });
  },

  // Upsert one node's position, keyed on the unique (userId, projectId, nodeKey)
  // — so a re-save of the same node updates in place rather than duplicating.
  async upsertPosition(
    input: { userId: string; projectId: string; nodeKey: string; x: number; y: number },
    tx: Prisma.TransactionClient,
  ): Promise<CanvasNodePosition> {
    return tx.canvasNodePosition.upsert({
      where: {
        userId_projectId_nodeKey: {
          userId: input.userId,
          projectId: input.projectId,
          nodeKey: input.nodeKey,
        },
      },
      create: input,
      update: { x: input.x, y: input.y },
    });
  },
};
