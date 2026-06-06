import type { Prisma } from '@prisma/client';
import { boardRepository } from '@/lib/repositories/boardRepository';
import { boardColumnRepository } from '@/lib/repositories/boardColumnRepository';
import { boardColumnStatusRepository } from '@/lib/repositories/boardColumnStatusRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { toWorkflowStatusDto } from '@/lib/mappers/workflowMappers';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { buildDefaultBoard } from '@/lib/boards/defaultBoard';
import { ProjectNotFoundError } from '@/lib/projects/errors';

// Boards service (Story 3.1) — business logic for the board entity. v1 owns
// the default-board SEED only (Subtask 3.1.2); the read projection (3.1.4) and
// the move/reorder mutation path (3.1.5) extend this same service later.
//
// Like workflowsService, every write runs under the active workspace context
// so the FORCE-RLS WITH CHECK on the board tables passes under the non-bypass
// prodect_app role (the scalar-FK `Unchecked` creates avoid a relation
// connect's parent SELECT — finding #33). TENANCY (finding #26): every repo
// read/write carries an explicit `workspaceId`; RLS is the structural backstop,
// inert under the dev/CI BYPASSRLS superuser.

export const boardsService = {
  /**
   * Seed a project's default Kanban board (Subtask 3.1.2) — the column-from-
   * workflow projection: one column per workflow status (in `status.position`
   * order), each mapped to its single status. A seeded default OVER the durable
   * many-to-one mapping (3.1.1), not a hardcoded 1:1.
   *
   * NEVER opens its own transaction: `tx` is REQUIRED and supplied by the
   * caller (createProject), so the project insert, its workflow seed (2.2.2),
   * and its board are atomic — a rollback of any rolls back all. It reads the
   * statuses through the SAME `tx` because they were just created in this
   * transaction and aren't visible outside it yet, then resolves each column's
   * status `key → id` against those rows. Rows carry the SCALAR workspaceId
   * (not a relation connect) so the writes pass the board RLS WITH CHECK under
   * the active workspace context (finding #33).
   */
  async seedDefaultBoard(
    projectId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const statuses = await workflowsRepository.findStatuses(projectId, workspaceId, tx);
    const statusIdByKey = new Map(statuses.map((s) => [s.key, s.id]));
    const spec = buildDefaultBoard(statuses.map(toWorkflowStatusDto));

    const board = await boardRepository.create(
      { workspaceId, projectId, name: spec.name, type: spec.type },
      tx,
    );

    for (const col of spec.columns) {
      const column = await boardColumnRepository.create(
        { workspaceId, projectId, boardId: board.id, name: col.name, position: col.position },
        tx,
      );
      for (const key of col.statusKeys) {
        const statusId = statusIdByKey.get(key);
        // Unreachable — buildDefaultBoard only emits keys drawn from `statuses`;
        // the guard turns a future projection bug into a clear failure instead
        // of a Prisma null-FK error (mirrors seedDefaultWorkflow's guard).
        if (!statusId) {
          throw new Error(`defaultBoard: column "${col.name}" maps an unknown status key "${key}"`);
        }
        await boardColumnStatusRepository.create(
          { workspaceId, projectId, boardId: board.id, columnId: column.id, statusId },
          tx,
        );
      }
    }
  },

  /**
   * One-off backfill of the default board onto a project that predates this
   * Story (a project with a workflow but no board). Admin/CLI-only —
   * `actorUserId` is required because the seed must run under
   * withWorkspaceContext (binding the workspace GUC the FORCE-RLS writes need;
   * rung-2 shipped-context shape, mirroring `workflowsService.backfillDefault-
   * Workflow`). Idempotent: a no-op (returns false) when the project already
   * has a board; seeds and returns true otherwise. Throws ProjectNotFoundError
   * if the project is absent. Drives the `scripts/backfill-default-boards.ts`
   * fleet sweep, one project at a time.
   */
  async backfillDefaultBoard(projectId: string, actorUserId: string): Promise<boolean> {
    const project = await projectRepository.findById(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);

    const existing = await boardRepository.findDefaultForProject(projectId, project.workspaceId);
    if (existing) return false;

    await withWorkspaceContext({ userId: actorUserId, workspaceId: project.workspaceId }, (tx) =>
      boardsService.seedDefaultBoard(projectId, project.workspaceId, tx),
    );
    return true;
  },
};
