import { Prisma } from '@prisma/client';
import { createTranslator } from 'next-intl';
import { getMessagesFor } from '@/lib/i18n/messages';
import { currentLocale } from '@/lib/i18n/serverLocale';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { toWorkflowStatusDto, toWorkflowTransitionDto } from '@/lib/mappers/workflowMappers';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { isOwnerRole } from '@/lib/workspaces/roles';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { keyForAppend } from '@/lib/workItems/positioning';
import {
  DEFAULT_STATUSES,
  DEFAULT_STATUS_KEYS,
  DEFAULT_TRANSITIONS,
} from '@/lib/workflows/defaultWorkflow';
import {
  CannotDeleteInitialStatusError,
  CannotDeleteLastTerminalStatusError,
  DefaultStatusProtectedError,
  InvalidReassignTargetError,
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
  /**
   * Delete-with-reassign (Subtask 2.3.1): when the status is in use, migrate
   * every referencing work item to this target status (same project) in the
   * same transaction, then delete. Omit it to keep the strict behaviour —
   * deleting an in-use status throws {@link StatusInUseError}.
   */
  reassignToStatusId?: string;
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
   * 16 transitions from lib/workflows/defaultWorkflow (finding #45 + 7.8.11).
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
    // Seed the protected-default labels in the CREATOR's locale. The labels are
    // persisted, user-editable rows (not live-translated): the status `key`
    // stays the stable join target, only the human label is localized at
    // creation. Off-request callers (the unit suite) fall back to the base
    // locale via currentLocale(), so the English seed (byte-identical to
    // DEFAULT_STATUSES) is preserved there.
    const locale = await currentLocale();
    const tStatus = createTranslator({
      locale,
      messages: getMessagesFor(locale),
      namespace: 'labels.defaultStatus',
    }) as (key: string) => string;

    const idByKey = new Map<string, string>();
    for (const status of DEFAULT_STATUSES) {
      const row = await workflowsRepository.createStatus(
        {
          projectId,
          workspaceId,
          key: status.key,
          label: tStatus(status.key),
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
      /* istanbul ignore next -- defensive: DEFAULT_TRANSITIONS only references the six DEFAULT_STATUSES keys just seeded above, so this typo-guard is unreachable */
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
      /* istanbul ignore next -- defensive: a project always carries its seeded statuses, so the empty-list (`: null`) ternary branch is unreachable here */
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
          /* istanbul ignore next -- defensive: P2002 only fires when a concurrent insert wins the same key between the pre-check and this write; not deterministically testable (mirrors the work-item repos' P2002 guards) */
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw new StatusKeyConflictError(input.key);
          }
          /* istanbul ignore next -- defensive rethrow: createStatus's only expected write error is the P2002 handled above */
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

    // A default status is protected (2.2.10 / finding #49): only its color may
    // change. Any label / category / isInitial / position edit is rejected.
    if (
      DEFAULT_STATUS_KEYS.has(pre.key) &&
      (input.label !== undefined ||
        input.category !== undefined ||
        input.isInitial !== undefined ||
        input.position !== undefined)
    ) {
      throw new DefaultStatusProtectedError(pre.key);
    }

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
   * Delete a status. Default statuses are protected (2.2.10), so this only ever
   * applies to CUSTOM statuses. The initial-status and last-terminal guards fire
   * FIRST and can't be reassigned past (a target doesn't unlock them). When the
   * status is in use:
   *   - no `reassignToStatusId` → throws {@link StatusInUseError} (the UI's cue
   *     to re-prompt with the delete-with-reassign modal);
   *   - with a valid target → migrates every referencing work item (INCLUDING
   *     archived ones) to the target's key, writing one status-change revision
   *     per item, then deletes — all in ONE transaction (Subtask 2.3.1).
   * Same-tx cleanup removes every transition touching the status.
   */
  async deleteStatus(input: DeleteStatusInput): Promise<void> {
    const pre = await workflowsRepository.findStatusById(input.statusId, input.workspaceId);
    if (!pre) throw new WorkflowStatusNotFoundError(input.statusId);
    await assertProjectAdmin(input.userId, pre.projectId, input.workspaceId);

    // Default statuses are protected — non-deletable (2.2.10 / finding #49).
    // The initial / last-terminal / in-use guards below still apply to CUSTOM
    // statuses (a custom status can be the initial or last terminal).
    if (DEFAULT_STATUS_KEYS.has(pre.key)) throw new DefaultStatusProtectedError(pre.key);

    await withWorkspaceContext(
      { userId: input.userId, workspaceId: input.workspaceId },
      async (tx) => {
        /* istanbul ignore next -- defensive re-read: the status was just read outside the tx; it can only be missing here if a concurrent tx deleted it in the window, which isn't deterministically testable */
        const status = await workflowsRepository.findStatusById(
          input.statusId,
          input.workspaceId,
          tx,
        );
        /* istanbul ignore next -- defensive: paired with the re-read above */
        if (!status) throw new WorkflowStatusNotFoundError(input.statusId);

        // Protections fire FIRST and unconditionally — a reassign target can't
        // buy a path past the initial or the last-terminal status.
        if (status.isInitial) throw new CannotDeleteInitialStatusError(status.key);
        if (status.category === 'done') {
          const all = await workflowsRepository.findStatuses(
            status.projectId,
            input.workspaceId,
            tx,
          );
          const terminals = all.filter((s) => s.category === 'done').length;
          // Unreachable in practice: the two default terminals (`done`,
          // `cancelled`) are protected (2.2.10), so a project always keeps ≥2
          // category=done statuses — a deletable custom terminal is never the
          // last one. Kept as a defensive guard (see management.test.ts note).
          /* istanbul ignore next -- unreachable: protected default terminals keep the count ≥2, so a deletable status is never the last terminal */
          if (terminals <= 1) throw new CannotDeleteLastTerminalStatusError(status.key);
        }

        const inUse = await workItemRepository.countByProjectAndStatusKey(
          status.projectId,
          status.key,
          tx,
        );
        if (inUse > 0) {
          // Strict mode (no target): refuse, carrying the count for the UI.
          if (!input.reassignToStatusId) throw new StatusInUseError(status.key, inUse);

          // The target must be a DIFFERENT status in the SAME project. A
          // cross-workspace id won't resolve under the workspace filter →
          // InvalidReassignTarget (no existence leak).
          const target = await workflowsRepository.findStatusById(
            input.reassignToStatusId,
            input.workspaceId,
            tx,
          );
          if (!target || target.projectId !== status.projectId || target.id === status.id) {
            throw new InvalidReassignTargetError();
          }

          // Migrate every referencing item (incl. archived) + one revision each,
          // reusing 2.2.4's status-change revision shape.
          const items = await workItemRepository.findByProjectAndStatusKey(
            status.projectId,
            status.key,
            tx,
          );
          for (const item of items) {
            await workItemRepository.update(item.id, { status: target.key }, tx);
            await workItemRevisionsService.recordRevision(
              {
                workItemId: item.id,
                changedById: input.userId,
                changeKind: 'updated',
                diff: { status: { from: status.key, to: target.key } },
              },
              tx,
            );
          }
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
          /* istanbul ignore next -- defensive: P2002 only fires when a concurrent insert wins the same (from,to) edge between the pre-check and this write; not deterministically testable */
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
          /* istanbul ignore next -- defensive rethrow: addTransition's only expected write error is the P2002 handled above */
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
  async restoreDefaultTransitions(
    input: RestoreDefaultsInput,
  ): Promise<{ transitionsAdded: number }> {
    await assertProjectAdmin(input.userId, input.projectId, input.workspaceId);

    return withWorkspaceContext(
      { userId: input.userId, workspaceId: input.workspaceId },
      async (tx) => {
        // Default STATUSES can't go missing now (protected — 2.2.10), so the
        // only thing to restore is missing default transition EDGES. ADDITIVE +
        // idempotent: re-add each default edge whose both endpoints exist and
        // isn't already present; never delete or duplicate.
        const statuses = await workflowsRepository.findStatuses(
          input.projectId,
          input.workspaceId,
          tx,
        );
        const byKey = new Map(statuses.map((s) => [s.key, s]));

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
          /* istanbul ignore next -- unreachable: default statuses are protected (2.2.10), so every DEFAULT_TRANSITIONS endpoint key is always present; the missing-endpoint skip can't fire */
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

        return { transitionsAdded };
      },
    );
  },
};
