import type { Prisma } from '@prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { toWorkflowStatusDto, toWorkflowTransitionDto } from '@/lib/mappers/workflowMappers';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { DEFAULT_STATUSES, DEFAULT_TRANSITIONS } from '@/lib/workflows/defaultWorkflow';
import type { WorkflowDto, WorkflowPolicyModeDto, WorkflowStatusDto } from '@/lib/dto/workflows';

// The READ surface for per-project status workflows (Story 2.2 · Subtask
// 2.2.3). The only doorway to the workflow tables: repositories are single-op
// leaves, this service owns DTO shaping + the explicit tenant gate. Later
// consumers read through here — Epic 3 boards (columns), Epic 6 reports
// (group-by-category), 2.2.4's transition validator (`canTransition`), and
// 2.2.6's readiness predicate (`getTerminalStatusKeys`, resolving finding #21).
//
// TENANCY (finding #26): every public method takes `workspaceId` explicitly and
// the repository reads filter `WHERE workspaceId = $ws`. RLS (forced in 2.2.1)
// is defense-in-depth, NOT the sole gate — it is inert under the dev/CI
// superuser (BYPASSRLS), so the explicit filter is the actual gate. The
// project-scoped reads (policyMode) reuse `projectRepository.findById` + a
// service-level `workspaceId` check, mirroring `workItemsService.getWorkItem`'s
// no-existence-leak gate (a cross-tenant projectId 404s, indistinguishable
// from never-existed).

/** Resolve a project's policy mode, gated to the workspace; 404 if foreign. */
async function requirePolicyMode(
  projectId: string,
  workspaceId: string,
): Promise<WorkflowPolicyModeDto> {
  const project = await projectRepository.findById(projectId);
  if (!project || project.workspaceId !== workspaceId) {
    throw new ProjectNotFoundError(projectId);
  }
  return project.workflowPolicyMode;
}

export const workflowsService = {
  /**
   * A project's full workflow — statuses (ordered by position), transitions,
   * and policy mode. Throws ProjectNotFoundError if the project doesn't exist
   * in the workspace (no-existence-leak).
   */
  async getWorkflow(projectId: string, workspaceId: string): Promise<WorkflowDto> {
    const policyMode = await requirePolicyMode(projectId, workspaceId);
    const [statuses, transitions] = await Promise.all([
      workflowsRepository.findStatuses(projectId, workspaceId),
      workflowsRepository.findTransitions(projectId, workspaceId),
    ]);
    return {
      statuses: statuses.map(toWorkflowStatusDto),
      transitions: transitions.map(toWorkflowTransitionDto),
      policyMode,
    };
  },

  /**
   * A project's statuses (ordered by position) — the convenience read board
   * columns + status pickers use. Empty array for a cross-workspace project.
   */
  async listStatusesByProject(
    projectId: string,
    workspaceId: string,
  ): Promise<WorkflowStatusDto[]> {
    const statuses = await workflowsRepository.findStatuses(projectId, workspaceId);
    return statuses.map(toWorkflowStatusDto);
  },

  /**
   * One status by its machine-stable `key` (the lookup `work_item.status`
   * resolves through), or null if no such status in this project/workspace.
   */
  async getStatusByKey(
    projectId: string,
    key: string,
    workspaceId: string,
  ): Promise<WorkflowStatusDto | null> {
    const status = await workflowsRepository.findStatusByKey(projectId, key, workspaceId);
    return status ? toWorkflowStatusDto(status) : null;
  },

  /**
   * The set of status keys whose category is `done` — the per-project terminal
   * set. This is the surface that resolves finding #21: 2.2.6 swaps
   * workItemsService.isReady / countOpenBlockers' hardcoded `'done'` literal
   * for this set, so "terminal" generalizes to every `category = done` status
   * (e.g. `done` AND `cancelled` out of the box). Empty for a foreign project.
   */
  async getTerminalStatusKeys(projectId: string, workspaceId: string): Promise<Set<string>> {
    const statuses = await workflowsRepository.findStatuses(projectId, workspaceId);
    return new Set(statuses.filter((s) => s.category === 'done').map((s) => s.key));
  },

  /**
   * Whether a status move `fromKey → toKey` is legal in the project. True when:
   *   - it's a no-op (`fromKey === toKey`) — always legal, regardless of mode;
   *   - the project's policy is `open` — any move is legal;
   *   - the policy is `restricted` AND a transition row exists for the pair.
   * False otherwise (incl. unknown status keys, or a cross-workspace project —
   * a move in a project you can't see is never legal).
   */
  async canTransition(
    projectId: string,
    fromKey: string,
    toKey: string,
    workspaceId: string,
  ): Promise<boolean> {
    if (fromKey === toKey) return true;

    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== workspaceId) return false;
    if (project.workflowPolicyMode === 'open') return true;

    // Restricted: both statuses must exist and a transition row must connect
    // them. Resolve keys → status ids (the transition table is keyed by id).
    const [fromStatus, toStatus] = await Promise.all([
      workflowsRepository.findStatusByKey(projectId, fromKey, workspaceId),
      workflowsRepository.findStatusByKey(projectId, toKey, workspaceId),
    ]);
    if (!fromStatus || !toStatus) return false;

    const transition = await workflowsRepository.findTransition(
      projectId,
      fromStatus.id,
      toStatus.id,
      workspaceId,
    );
    return transition !== null;
  },

  /**
   * Seed a project's default workflow (Subtask 2.2.2) — the 6 statuses +
   * 15 transitions from lib/workflows/defaultWorkflow (finding #45).
   * NEVER opens its own transaction: `tx` is REQUIRED and supplied by the
   * caller (createProject), so the project insert and its workflow are atomic —
   * a rollback of either rolls back both. Statuses are inserted first to
   * capture their ids, then the key-pair transition graph is resolved against
   * those ids. The rows carry the SCALAR workspaceId (not a relation connect)
   * so the writes pass the workflow RLS WITH CHECK under the active workspace
   * context (finding #33 / #44).
   */
  async seedDefaultWorkflow(
    projectId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const idByKey = new Map<string, string>();
    for (const status of DEFAULT_STATUSES) {
      const row = await workflowsRepository.createStatus(
        {
          projectId,
          workspaceId,
          key: status.key,
          label: status.label,
          category: status.category,
          position: status.position,
          isInitial: status.isInitial,
        },
        tx,
      );
      idByKey.set(status.key, row.id);
    }

    for (const [fromKey, toKey] of DEFAULT_TRANSITIONS) {
      const fromStatusId = idByKey.get(fromKey);
      const toStatusId = idByKey.get(toKey);
      // Unreachable — the transition graph only references the six seeded keys;
      // the guard turns a future typo in defaultWorkflow into a clear failure
      // instead of a Prisma null-FK error.
      if (!fromStatusId || !toStatusId) {
        throw new Error(
          `defaultWorkflow: transition references an unknown status key (${fromKey} -> ${toKey})`,
        );
      }
      await workflowsRepository.createTransition(
        { projectId, workspaceId, fromStatusId, toStatusId },
        tx,
      );
    }
  },

  /**
   * One-off backfill of the default workflow onto a project that predates this
   * Story (older test/migration rows; production has none). Admin/CLI-only —
   * `actorUserId` is required because the seed must run under withWorkspaceContext
   * (the card's bare `(projectId)` can't bind the workspace GUC the FORCE-RLS
   * writes need; rung-2 shipped-context shape over the card's illustration).
   * Idempotent: a no-op (returns false) when the project already has statuses;
   * seeds and returns true otherwise. Throws ProjectNotFoundError if absent.
   */
  async backfillDefaultWorkflow(projectId: string, actorUserId: string): Promise<boolean> {
    const project = await projectRepository.findById(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);

    const existing = await workflowsRepository.findStatuses(projectId, project.workspaceId);
    if (existing.length > 0) return false;

    await withWorkspaceContext({ userId: actorUserId, workspaceId: project.workspaceId }, (tx) =>
      workflowsService.seedDefaultWorkflow(projectId, project.workspaceId, tx),
    );
    return true;
  },
};
