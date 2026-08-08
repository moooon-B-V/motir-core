import { db } from '@/lib/db';
import { canvasNodePositionRepository } from '@/lib/repositories/canvasNodePositionRepository';
import { toCanvasLayoutDTO } from '@/lib/mappers/canvasLayoutMappers';
import { InvalidCanvasPositionError } from '@/lib/canvasLayout/errors';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { CanvasLayoutDTO, CanvasNodePositionInput } from '@/lib/dto/canvasLayout';

// The canvas-layout service (Subtask 7.3.77 / MOTIR-1237) — persists each user's
// arrangement of a project's planning canvas so a drag survives reload. Business
// logic + the transaction live here (CLAUDE.md 4-layer); the caller passes the
// already-resolved (userId, workspaceId, projectId) from `getActiveProject` (the
// project is the user's own active project, server-resolved — never
// client-supplied), so a user can only ever read/write their OWN positions for a
// project in their OWN workspace.
//
// ⚠️ AND THE PROJECT GATE RUNS HERE (Subtask MOTIR-2346). Server-resolving the
// project keeps a FOREIGN project unreachable; it says nothing about whether the
// actor may see the project the server resolved. Until this card, `/api/canvas-layout`
// reached the database with no project gate at all, and the inventory mapped it to
// `ai:plan` — a key for operations that SPEND the workspace's AI credits, which a
// per-user node arrangement plainly is not. The true statement is the narrower one:
// you may arrange the canvas of a project you can BROWSE. Both methods assert it,
// not just the write — a saved layout is per-user, but reading one still names a
// project, and a viewer-less actor must not learn it resolved.
const MAX_NODE_KEY_LEN = 200;
// A generous world-coordinate bound — keeps a malformed/abusive value out of the
// store without constraining any real layout.
const COORD_LIMIT = 1_000_000;

/**
 * The already-resolved actor + project a canvas-layout call acts for. It satisfies
 * `AccessActorContext` (userId + workspaceId), which is what lets the gate below
 * run on the SAME object the repository keys on — no second resolve, no chance of
 * the gate and the write disagreeing about who is acting.
 */
export interface CanvasLayoutContext {
  userId: string;
  workspaceId: string;
  projectId: string;
}

export const canvasLayoutService = {
  // The user's saved arrangement for a project. Empty → `{ positions: [] }` (the
  // consumer falls back to its space-filling auto-layout — the empty-default AC).
  async getLayout(ctx: CanvasLayoutContext): Promise<CanvasLayoutDTO> {
    await projectAccessService.assertPermission(ctx.projectId, ctx, 'project:browse');
    return readLayout(ctx);
  },

  // Persist the moved nodes and/or RESET (drop) others — validate every upsert
  // first (a bad one fails the whole save, atomically), then delete the `remove`
  // keys and upsert the moves inside ONE transaction. Returns the user's full
  // updated layout so the client reconciles from the committed truth.
  async savePositions(
    ctx: CanvasLayoutContext,
    positions: CanvasNodePositionInput[],
    remove: string[] = [],
  ): Promise<CanvasLayoutDTO> {
    await projectAccessService.assertPermission(ctx.projectId, ctx, 'project:browse');
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

    // The committed truth, read back WITHOUT re-asserting: the gate above already
    // ran for this call, and `getLayout` would resolve the actor's membership a
    // second time to answer the identical question.
    return readLayout(ctx);
  },
};

/** The user's committed positions for the project. Gate-free — every caller above asserts first. */
async function readLayout(ctx: CanvasLayoutContext): Promise<CanvasLayoutDTO> {
  const rows = await canvasNodePositionRepository.findByUserAndProject(ctx.userId, ctx.projectId);
  return toCanvasLayoutDTO(rows);
}

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
