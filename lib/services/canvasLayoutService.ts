import { db } from '@/lib/db';
import { canvasNodePositionRepository } from '@/lib/repositories/canvasNodePositionRepository';
import { toCanvasLayoutDTO } from '@/lib/mappers/canvasLayoutMappers';
import { InvalidCanvasPositionError } from '@/lib/canvasLayout/errors';
import type { CanvasLayoutDTO, CanvasNodePositionInput } from '@/lib/dto/canvasLayout';

// The canvas-layout service (Subtask 7.3.77 / MOTIR-1237) — persists each user's
// arrangement of a project's planning canvas so a drag survives reload. Business
// logic + the transaction live here (CLAUDE.md 4-layer); the caller passes the
// already-resolved (userId, projectId) from `getActiveProject` (the project is
// the user's own active project, server-resolved — never client-supplied), so a
// user can only ever read/write their OWN positions for a project in their OWN
// workspace.

const MAX_NODE_KEY_LEN = 200;
// A generous world-coordinate bound — keeps a malformed/abusive value out of the
// store without constraining any real layout.
const COORD_LIMIT = 1_000_000;

export const canvasLayoutService = {
  // The user's saved arrangement for a project. Empty → `{ positions: [] }` (the
  // consumer falls back to its space-filling auto-layout — the empty-default AC).
  async getLayout(ctx: { userId: string; projectId: string }): Promise<CanvasLayoutDTO> {
    const rows = await canvasNodePositionRepository.findByUserAndProject(ctx.userId, ctx.projectId);
    return toCanvasLayoutDTO(rows);
  },

  // Persist the moved nodes and/or RESET (drop) others — validate every upsert
  // first (a bad one fails the whole save, atomically), then delete the `remove`
  // keys and upsert the moves inside ONE transaction. Returns the user's full
  // updated layout so the client reconciles from the committed truth.
  async savePositions(
    ctx: { userId: string; projectId: string },
    positions: CanvasNodePositionInput[],
    remove: string[] = [],
  ): Promise<CanvasLayoutDTO> {
    for (const position of positions) validatePosition(position);

    await db.$transaction(async (tx) => {
      if (remove.length > 0) {
        await canvasNodePositionRepository.deleteByKeys(ctx.userId, ctx.projectId, remove, tx);
      }
      for (const position of positions) {
        await canvasNodePositionRepository.upsertPosition(
          {
            userId: ctx.userId,
            projectId: ctx.projectId,
            nodeKey: position.nodeKey,
            x: position.x,
            y: position.y,
          },
          tx,
        );
      }
    });

    return this.getLayout(ctx);
  },
};

function validatePosition(position: CanvasNodePositionInput): void {
  if (
    typeof position.nodeKey !== 'string' ||
    position.nodeKey.length === 0 ||
    position.nodeKey.length > MAX_NODE_KEY_LEN
  ) {
    throw new InvalidCanvasPositionError('`nodeKey` must be a non-empty string.');
  }
  for (const [axis, value] of [
    ['x', position.x],
    ['y', position.y],
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > COORD_LIMIT) {
      throw new InvalidCanvasPositionError(`\`${axis}\` must be a finite coordinate.`);
    }
  }
}
