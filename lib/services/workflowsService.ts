import { Prisma } from '@prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { toWorkflowStatusDto, toWorkflowTransitionDto } from '@/lib/mappers/workflowMappers';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { isOwnerRole } from '@/lib/workspaces/roles';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { keyForAppend } from '@/lib/workItems/positioning';
import { DEFAULT_STATUSES, DEFAULT_TRANSITIONS } from '@/lib/workflows/defaultWorkflow';
import {
  CannotDeleteInitialStatusError,
  CannotDeleteLastTerminalStatusError,
  NotProjectAdminError,
  StatusInUseError,
  StatusKeyConflictError,
  WorkflowStatusNotFoundError,
  WorkflowTransitionNotFoundError,
} from '@/lib/workflows/errors';
import type {
  StatusCategoryDto,
  WorkflowDto,
  WorkflowPolicyModeDto,
  WorkflowStatusDto,
  WorkflowTransitionDto,
} from '@/lib/dto/workflows';

/**
 * Project-admin gate (Subtask 2.2.5). v1 routes "project admin" to the
 * workspace OWNER (finding #36) — full per-project RBAC is Epic 6. The gate is
 * the durable shape; only the role-set behind it widens later. Also asserts the
 * project belongs to the workspace (404 no-existence-leak) so a foreign
 * projectId can't probe membership.
 */
async function assertProjectAdmin(
  userId: string,
  projectId: string,
  workspaceId: string,
): Promise<void> {
  const project = await projectRepository.findById(projectId);
  if (!project || project.workspaceId !== workspaceId) {
    throw new ProjectNotFoundError(projectId);
  }
  const membership = await workspaceMembershipRepository.findByUserAndWorkspace(
    userId,
    workspaceId,
  );
  if (!isOwnerRole(membership?.role)) {
    throw new NotProjectAdminError();
  }
}

export interface CreateStatusInput {
  userId: string;
  workspaceId: string;
  projectId: string;
  key: string;
  label: string;
  category: StatusCategoryDto;
  color?: string | null;
  /** Optional explicit fractional position; appended to the end when omitted. */
  position?: string;
}

export interface UpdateWorkflowStatusInput {
  userId: string;
  workspaceId: string;
  statusId: string;
  label?: string;
  category?: StatusCategoryDto;
  color?: string | null;
  position?: string;
  isInitial?: boolean;
}

export interface DeleteStatusInput {
  userId: string;
  workspaceId: string;
  statusId: string;
}

export interface AddTransitionInput {
  userId: string;
  workspaceId: string;
  projectId: string;
  fromStatusId: string;
  toStatusId: string;
}

export interface RemoveTransitionInput {
  userId: string;
  workspaceId: string;
  transitionId: string;
}

export interface SetPolicyModeInput {
  userId: string;
  workspaceId: string;
  projectId: string;
  mode: WorkflowPolicyModeDto;
}

export interface RestoreDefaultsInput {
  userId: string;
  workspaceId: string;
  projectId: string;
}

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
   * set. The surface that resolved finding #21: `workItemsService.isReady`
   * classifies blockers against this set (via the batched
   * `getTerminalStatusKeysByProjects` below) instead of a hardcoded `'done'`
   * literal, so "terminal" generalizes to every `category = done` status (e.g.
   * `done` AND `cancelled` out of the box). Empty for a foreign project.
   */
  async getTerminalStatusKeys(projectId: string, workspaceId: string): Promise<Set<string>> {
    const statuses = await workflowsRepository.findStatuses(projectId, workspaceId);
    return new Set(statuses.filter((s) => s.category === 'done').map((s) => s.key));
  },

  /**
   * The terminal-status-key set for MANY projects at once (Subtask 2.2.6) —
   * the batched form of `getTerminalStatusKeys`, returning
   * `Map<projectId, Set<terminalKey>>` from ONE query (no N+1). Used by
   * `workItemsService.isReady` to classify each blocker against ITS OWN
   * project's terminal set when blockers span projects. Every requested
   * projectId is present in the map (empty set when it has no terminal statuses
   * or isn't in the workspace), so callers can `.get(pid)` without a null gap.
   */
  async getTerminalStatusKeysByProjects(
    projectIds: string[],
    workspaceId: string,
  ): Promise<Map<string, Set<string>>> {
    const unique = [...new Set(projectIds)];
    const map = new Map<string, Set<string>>(unique.map((pid) => [pid, new Set<string>()]));
    const statuses = await workflowsRepository.findStatusesByProjects(unique, workspaceId);
    for (const s of statuses) {
      if (s.category === 'done') map.get(s.projectId)?.add(s.key);
    }
    return map;
  },

  /**
   * The `key` of the project's initial status (the one a freshly-created work
   * item lands in), or null if the project has none (no workflow / corrupt
   * seed). The schema's partial unique index guarantees AT MOST one initial
   * status per project, so `find` is unambiguous. Used by
   * workItemsService.createWorkItem to seed `work_item.status` (2.2.4).
   */
  async getInitialStatusKey(projectId: string, workspaceId: string): Promise<string | null> {
    const statuses = await workflowsRepository.findStatuses(projectId, workspaceId);
    return statuses.find((s) => s.isInitial)?.key ?? null;
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

  // ── Management writes (Subtask 2.2.5) ──────────────────────────────────────
  // Every method is project-admin-gated (owner v1) and runs its writes under
  // withWorkspaceContext so the FORCE-RLS WITH CHECK passes.

  /** Add a status to a project's workflow. Appends to the end unless a position is given. */
  async createStatus(input: CreateStatusInput): Promise<WorkflowStatusDto> {
    await assertProjectAdmin(input.userId, input.projectId, input.workspaceId);

    const existing = await workflowsRepository.findStatusByKey(
      input.projectId,
      input.key,
      input.workspaceId,
    );
    if (existing) throw new StatusKeyConflictError(input.key);

    let position = input.position;
    if (position == null) {
      const statuses = await workflowsRepository.findStatuses(input.projectId, input.workspaceId);
      const last = statuses.length ? statuses[statuses.length - 1]!.position : null;
      position = keyForAppend(last);
    }

    return withWorkspaceContext(
      { userId: input.userId, workspaceId: input.workspaceId },
      async (tx) => {
        try {
          const row = await workflowsRepository.createStatus(
            {
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              key: input.key,
              label: input.label,
              category: input.category,
              color: input.color ?? null,
              position: position!,
              isInitial: false,
            },
            tx,
          );
          return toWorkflowStatusDto(row);
        } catch (err) {
          // Backstop the pre-check against a concurrent insert of the same key.
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw new StatusKeyConflictError(input.key);
          }
          throw err;
        }
      },
    );
  },

  /**
   * Edit a status. Flipping `isInitial` to true unsets the previous initial in
   * the SAME transaction, so the partial unique index never sees two true rows.
   */
  async updateStatus(input: UpdateWorkflowStatusInput): Promise<WorkflowStatusDto> {
    const pre = await workflowsRepository.findStatusById(input.statusId, input.workspaceId);
    if (!pre) throw new WorkflowStatusNotFoundError(input.statusId);
    await assertProjectAdmin(input.userId, pre.projectId, input.workspaceId);

    return withWorkspaceContext(
      { userId: input.userId, workspaceId: input.workspaceId },
      async (tx) => {
        if (input.isInitial === true) {
          await workflowsRepository.clearInitialForProject(pre.projectId, input.workspaceId, tx);
        }
        const data: Prisma.WorkflowStatusUncheckedUpdateInput = {};
        if (input.label !== undefined) data.label = input.label;
        if (input.category !== undefined) data.category = input.category;
        if (input.color !== undefined) data.color = input.color;
        if (input.position !== undefined) data.position = input.position;
        if (input.isInitial !== undefined) data.isInitial = input.isInitial;
        const row = await workflowsRepository.updateStatus(input.statusId, data, tx);
        return toWorkflowStatusDto(row);
      },
    );
  },

  /**
   * Delete a status. Refuses (typed 422s) when it's the initial status, still
   * referenced by a work item, or the project's last terminal (`category=done`)
   * status. Same-tx cleanup removes every transition touching it.
   */
  async deleteStatus(input: DeleteStatusInput): Promise<void> {
    const pre = await workflowsRepository.findStatusById(input.statusId, input.workspaceId);
    if (!pre) throw new WorkflowStatusNotFoundError(input.statusId);
    await assertProjectAdmin(input.userId, pre.projectId, input.workspaceId);

    await withWorkspaceContext(
      { userId: input.userId, workspaceId: input.workspaceId },
      async (tx) => {
        const status = await workflowsRepository.findStatusById(
          input.statusId,
          input.workspaceId,
          tx,
        );
        if (!status) throw new WorkflowStatusNotFoundError(input.statusId);
        if (status.isInitial) throw new CannotDeleteInitialStatusError(status.key);

        const inUse = await workItemRepository.countByProjectAndStatusKey(
          status.projectId,
          status.key,
          tx,
        );
        if (inUse > 0) throw new StatusInUseError(status.key, inUse);

        if (status.category === 'done') {
          const all = await workflowsRepository.findStatuses(
            status.projectId,
            input.workspaceId,
            tx,
          );
          const terminals = all.filter((s) => s.category === 'done').length;
          if (terminals <= 1) throw new CannotDeleteLastTerminalStatusError(status.key);
        }

        await workflowsRepository.deleteTransitionsForStatus(status.id, tx);
        await workflowsRepository.deleteStatus(status.id, tx);
      },
    );
  },

  /** Add a legal transition. Duplicate inserts are idempotent (return existing). */
  async addTransition(input: AddTransitionInput): Promise<WorkflowTransitionDto> {
    await assertProjectAdmin(input.userId, input.projectId, input.workspaceId);

    const existing = await workflowsRepository.findTransition(
      input.projectId,
      input.fromStatusId,
      input.toStatusId,
      input.workspaceId,
    );
    if (existing) return toWorkflowTransitionDto(existing);

    return withWorkspaceContext(
      { userId: input.userId, workspaceId: input.workspaceId },
      async (tx) => {
        try {
          const row = await workflowsRepository.createTransition(
            {
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              fromStatusId: input.fromStatusId,
              toStatusId: input.toStatusId,
            },
            tx,
          );
          return toWorkflowTransitionDto(row);
        } catch (err) {
          // Concurrent duplicate insert → re-read and return it (idempotent).
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            const row = await workflowsRepository.findTransition(
              input.projectId,
              input.fromStatusId,
              input.toStatusId,
              input.workspaceId,
              tx,
            );
            if (row) return toWorkflowTransitionDto(row);
          }
          throw err;
        }
      },
    );
  },

  /** Remove a transition. */
  async removeTransition(input: RemoveTransitionInput): Promise<void> {
    const pre = await workflowsRepository.findTransitionById(input.transitionId, input.workspaceId);
    if (!pre) throw new WorkflowTransitionNotFoundError(input.transitionId);
    await assertProjectAdmin(input.userId, pre.projectId, input.workspaceId);

    await withWorkspaceContext({ userId: input.userId, workspaceId: input.workspaceId }, (tx) =>
      workflowsRepository.deleteTransition(input.transitionId, tx),
    );
  },

  /** Flip the project's transition-enforcement policy mode. */
  async setPolicyMode(input: SetPolicyModeInput): Promise<WorkflowPolicyModeDto> {
    await assertProjectAdmin(input.userId, input.projectId, input.workspaceId);

    await withWorkspaceContext({ userId: input.userId, workspaceId: input.workspaceId }, (tx) =>
      projectRepository.updateWorkflowPolicyMode(input.projectId, input.mode, tx),
    );
    return input.mode;
  },

  /**
   * Restore the default workflow ADDITIVELY (Subtask 2.2.9): re-add any default
   * statuses (matched by `key`) and default transitions that are MISSING —
   * WITHOUT touching the admin's customizations. Idempotent (a second call is a
   * no-op), never deletes or duplicates rows, never reverts a renamed default's
   * label/color. Admin-gated. A destructive "reset to factory" is out of scope.
   * Returns how many rows were added.
   */
  async restoreDefaultWorkflow(
    input: RestoreDefaultsInput,
  ): Promise<{ statusesAdded: number; transitionsAdded: number }> {
    await assertProjectAdmin(input.userId, input.projectId, input.workspaceId);

    return withWorkspaceContext(
      { userId: input.userId, workspaceId: input.workspaceId },
      async (tx) => {
        const current = await workflowsRepository.findStatuses(
          input.projectId,
          input.workspaceId,
          tx,
        );
        const byKey = new Map(current.map((s) => [s.key, s]));
        const hadInitial = current.some((s) => s.isInitial);
        // Append-anchor: re-added statuses go AFTER the project's current last
        // one (custom statuses keep their place), each its own fractional key.
        let lastPosition = current.length ? current[current.length - 1]!.position : null;

        let statusesAdded = 0;
        for (const def of DEFAULT_STATUSES) {
          if (byKey.has(def.key)) continue; // present (or renamed) → leave it
          lastPosition = keyForAppend(lastPosition);
          const row = await workflowsRepository.createStatus(
            {
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              key: def.key,
              label: def.label,
              category: def.category,
              position: lastPosition,
              isInitial: false, // never on insert — the initial rule runs below
            },
            tx,
          );
          byKey.set(row.key, row);
          statusesAdded += 1;
        }

        // Initial-status rule: only if the project has NO initial status, make
        // `todo` the initial (the partial-unique index is never at risk — an
        // existing initial is left untouched).
        if (!hadInitial) {
          const todo = byKey.get('todo');
          if (todo) await workflowsRepository.updateStatus(todo.id, { isInitial: true }, tx);
        }

        // Re-add missing default transitions whose BOTH endpoints now exist.
        const existing = await workflowsRepository.findTransitions(
          input.projectId,
          input.workspaceId,
          tx,
        );
        const seen = new Set(existing.map((t) => `${t.fromStatusId}|${t.toStatusId}`));
        let transitionsAdded = 0;
        for (const [fromKey, toKey] of DEFAULT_TRANSITIONS) {
          const from = byKey.get(fromKey);
          const to = byKey.get(toKey);
          if (!from || !to) continue;
          const pair = `${from.id}|${to.id}`;
          if (seen.has(pair)) continue;
          await workflowsRepository.createTransition(
            {
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              fromStatusId: from.id,
              toStatusId: to.id,
            },
            tx,
          );
          seen.add(pair);
          transitionsAdded += 1;
        }

        return { statusesAdded, transitionsAdded };
      },
    );
  },
};
