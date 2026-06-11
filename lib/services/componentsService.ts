import { Prisma, type Component, type Project, type WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { componentRepository } from '@/lib/repositories/componentRepository';
import { workItemComponentRepository } from '@/lib/repositories/workItemComponentRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { withWorkspaceContext, type WorkspaceContext } from '@/lib/workspaces/context';
import { isWorkspaceManager } from '@/lib/projects/roles';
import {
  NotProjectAdminError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import {
  ComponentNameConflictError,
  ComponentNotFoundError,
  CrossProjectComponentError,
  InvalidComponentNameError,
  InvalidDefaultAssigneeError,
  InvalidMoveTargetError,
} from '@/lib/components/errors';
import { toComponentDto, toComponentWithCountDto } from '@/lib/mappers/componentMappers';
import type {
  ComponentDto,
  ComponentWithCountDto,
  CreateComponentInput,
  DeleteComponentReceiptDto,
  UpdateComponentInput,
} from '@/lib/dto/components';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// componentsService (Story 5.4 · Subtask 5.4.3) — the taxonomy half: the
// admin-managed component CRUD (Jira company-managed "Project settings →
// Components" is the verified shape mirror), the move-or-remove delete flow,
// and the per-issue multi-valued assignment, over the 5.4.1 repositories.
// Owns validation, the permission gates, transactions, revision diffs, and
// DTO mapping. Routes are HTTP-only (CLAUDE.md). The at-create
// default-assignee rule lives in `workItemsService.createWorkItem` (it
// extends THAT transaction); this file owns everything else.
//
// AUTHORIZATION (the 6.4 two-tier shape, exactly the custom-fields pattern):
//   * Taxonomy MUTATIONS (create / update / delete) are project-admin-gated —
//     workspace owner/admin always pass (isWorkspaceManager), otherwise the
//     actor needs a project membership with role `admin`; everyone else →
//     NotProjectAdminError (403).
//   * The taxonomy READ (listComponents) is browse-gated — any member who can
//     see the project can read its components (the rail picker needs them),
//     viewers included; a hidden project reads as 404 (no existence leak).
//   * Per-ISSUE assignment (set/add/remove) is edit-gated like every other
//     issue write (`viewer` → 403; missing / cross-workspace / non-browsable
//     issue → 404, finding #44 — the labelsService matrix).
//
// The verified mirror rules enforced here:
//   * `name` is required and case-insensitively unique per project (the
//     JRACLOUD-24907 wart-fix — `@@unique([projectId, nameLower])` backstops
//     the concurrent-create race); first-typed casing is displayed.
//   * `defaultAssigneeId` must be an ASSIGNABLE member of the project (the
//     6.4.6 `assignableMembersService` scoping — you can't default work onto
//     someone who can't see the project); SetNull covers departure. Jira's
//     five-way default-assignee enum collapses to this nullable user (no
//     project-lead concept — the recorded simplification).
//   * DELETE is the move-or-remove choice: with `moveToComponentId` every
//     join row repoints to the target (skipping issues that already carry
//     it); without, the joins are removed — issues untouched either way, the
//     receipt reports the affected count. The whole flow is ONE transaction
//     behind a `FOR UPDATE` lock on the component row (the RESTRICT FK
//     backstops any missed path).
//   * Assignment changes write `{ components: { added/removed: [name] } }`
//     revision diffs (the labels/links precedent); no-op writes write
//     nothing. Later component changes never touch the issue's assignee
//     (the default applies at CREATE only — the mirror rule).

/** Longest accepted component name, in characters (the label constant's twin). */
export const COMPONENT_NAME_MAX_LENGTH = 60;

/** Trim + bound an incoming component name, or throw the typed 422. */
function normalizeComponentName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0 || name.length > COMPONENT_NAME_MAX_LENGTH) {
    throw new InvalidComponentNameError(raw, COMPONENT_NAME_MAX_LENGTH);
  }
  return name;
}

/**
 * Resolve the project by its workspace-scoped identifier ("PROD") — a
 * cross-tenant or unknown key throws ProjectNotFoundError (404, no existence
 * leak). The customFieldsService resolution.
 */
async function resolveProject(key: string, ctx: WorkspaceContext): Promise<Project> {
  const identifier = key.trim().toUpperCase();
  const project = await projectRepository.findByIdentifier(ctx.workspaceId, identifier);
  if (!project) throw new ProjectNotFoundError(key);
  return project;
}

/**
 * Assert the actor may MANAGE the project's components — the 6.4 two-tier
 * check (workspace owner/admin always pass; otherwise project role `admin`),
 * exactly the members-page / custom-fields pattern.
 */
async function assertCanManage(
  actorUserId: string,
  workspaceId: string,
  projectId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const wsMembership = await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
    actorUserId,
    workspaceId,
    tx,
  );
  if (wsMembership && isWorkspaceManager(wsMembership.role)) return;

  const projectMembership = await projectMembershipRepository.findByUserAndProject(
    actorUserId,
    projectId,
    tx,
  );
  if (projectMembership?.role === 'admin') return;

  throw new NotProjectAdminError(projectId);
}

/**
 * Resolve a component by id under the workspace gate (a cross-workspace id is
 * indistinguishable from a never-existed one — finding #44). Optional `tx`
 * for callers already inside a transaction.
 */
async function resolveComponent(
  componentId: string,
  ctx: { workspaceId: string },
  tx?: Prisma.TransactionClient,
): Promise<Component> {
  const component = await componentRepository.findById(componentId, tx);
  if (!component || component.workspaceId !== ctx.workspaceId) {
    throw new ComponentNotFoundError(componentId);
  }
  return component;
}

/**
 * Validate a non-null default assignee against the project's ASSIGNABLE
 * member set (the 6.4.6 scoping: open/limited → any workspace member;
 * private → project members only). Reference data — runs OUTSIDE the
 * mutation transaction, the `createWorkItem` mention-resolution pattern.
 */
async function assertDefaultAssigneeEligible(
  userId: string,
  project: Project,
  ctx: WorkspaceContext,
): Promise<void> {
  const members = await assignableMembersService.list({
    projectId: project.id,
    accessLevel: project.accessLevel,
    ctx,
  });
  if (!members.some((m) => m.userId === userId)) {
    throw new InvalidDefaultAssigneeError(userId);
  }
}

/**
 * Resolve a work item under the hide-gates and assert the actor may EDIT it
 * — the labelsService preamble, verbatim: missing / cross-workspace /
 * non-browsable → WorkItemNotFoundError (404, no existence leak); a browser
 * without edit rights keeps ProjectAccessDeniedError('edit') (403).
 */
async function resolveEditableWorkItem(
  workItemId: string,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<WorkItem> {
  const item = await workItemRepository.findById(workItemId, tx);
  if (!item || item.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(workItemId);
  try {
    await projectAccessService.assertCanEdit(item.projectId, ctx, tx);
  } catch (err) {
    if (err instanceof ProjectAccessDeniedError && err.kind === 'browse') {
      throw new WorkItemNotFoundError(workItemId);
    }
    throw err;
  }
  return item;
}

/**
 * Validate that every incoming component id resolves within the issue's
 * workspace AND project: an unknown / cross-workspace id reads as 404 (no
 * existence leak); a same-workspace component from ANOTHER project is the
 * typed 422 (it exists and the actor may know it — the precise error is the
 * useful one). Returns the resolved rows keyed by id.
 */
async function resolveSameProjectComponents(
  componentIds: string[],
  item: Pick<WorkItem, 'workspaceId' | 'projectId'>,
  tx?: Prisma.TransactionClient,
): Promise<Map<string, Component>> {
  const rows = await componentRepository.findByIds(componentIds, tx);
  const byId = new Map(rows.map((c) => [c.id, c]));
  for (const id of componentIds) {
    const component = byId.get(id);
    if (!component || component.workspaceId !== item.workspaceId) {
      throw new ComponentNotFoundError(id);
    }
    if (component.projectId !== item.projectId) throw new CrossProjectComponentError(id);
  }
  return byId;
}

/**
 * Record one `{ components: { added/removed } }` revision (the labels
 * precedent). Names are sorted so the trail entry is deterministic
 * regardless of picker order.
 */
async function recordComponentsRevision(
  workItemId: string,
  userId: string,
  added: string[],
  removed: string[],
  tx: Prisma.TransactionClient,
): Promise<void> {
  const diff: { components: { added?: string[]; removed?: string[] } } = { components: {} };
  if (added.length > 0) diff.components.added = [...added].sort();
  if (removed.length > 0) diff.components.removed = [...removed].sort();
  await workItemRevisionsService.recordRevision(
    { workItemId, changedById: userId, changeKind: 'updated', diff },
    tx,
  );
}

/** Map a P2002 on the `[projectId, nameLower]` unique to the typed 409. */
function mapNameRace(err: unknown, name: string): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new ComponentNameConflictError(name);
  }
  throw err;
}

export const componentsService = {
  /**
   * The admin-page / picker read: the project's components in name order,
   * each with its in-use item count and its default assignee resolved to a
   * renderable user (ONE batched user read — no N+1). Browse-gated (any
   * member who can see the project, viewers included); a hidden /
   * cross-tenant project reads as 404. Bounded by the taxonomy's
   * admin-curated nature (the recorded finding-#57 call).
   */
  async listComponents(key: string, ctx: WorkspaceContext): Promise<ComponentWithCountDto[]> {
    const project = await resolveProject(key, ctx);
    try {
      await projectAccessService.assertCanBrowse(project.id, ctx);
    } catch (err) {
      if (err instanceof ProjectAccessDeniedError && err.kind === 'browse') {
        throw new ProjectNotFoundError(key);
      }
      throw err;
    }
    const rows = await componentRepository.listByProject(project.id);
    const assigneeIds = [...new Set(rows.flatMap((r) => r.defaultAssigneeId ?? []))];
    const users = assigneeIds.length > 0 ? await userRepository.findByIds(assigneeIds) : [];
    const usersById = new Map(users.map((u) => [u.id, u]));
    return rows.map((row) => toComponentWithCountDto(row, usersById));
  },

  /**
   * Create a component (project-admin-gated). Name is trimmed, bounded, and
   * case-insensitively unique within the project — the in-tx probe gives the
   * friendly 409 and the DB unique backstops the concurrent race (also 409).
   * A non-null default assignee must be assignable on the project.
   */
  async createComponent(input: CreateComponentInput, ctx: WorkspaceContext): Promise<ComponentDto> {
    const name = normalizeComponentName(input.name);
    const project = await resolveProject(input.key, ctx);
    if (input.defaultAssigneeId != null) {
      await assertDefaultAssigneeEligible(input.defaultAssigneeId, project, ctx);
    }

    try {
      return await withWorkspaceContext(ctx, async (tx) => {
        await assertCanManage(ctx.userId, ctx.workspaceId, project.id, tx);

        const existing = await componentRepository.findByNameLower(
          project.id,
          name.toLowerCase(),
          tx,
        );
        if (existing) throw new ComponentNameConflictError(name);

        const row = await componentRepository.create(
          {
            workspaceId: ctx.workspaceId,
            projectId: project.id,
            name,
            nameLower: name.toLowerCase(),
            description: input.description?.trim() || null,
            defaultAssigneeId: input.defaultAssigneeId ?? null,
          },
          tx,
        );
        return toComponentDto(row);
      });
    } catch (err) {
      mapNameRace(err, name);
    }
  },

  /**
   * Edit a component (project-admin-gated): rename (case-insensitively
   * unique, excluding itself), set/clear the description, set/clear the
   * default assignee (validated assignable when non-null). An empty patch is
   * a no-op returning the current row.
   */
  async updateComponent(
    componentId: string,
    patch: UpdateComponentInput,
    ctx: WorkspaceContext,
  ): Promise<ComponentDto> {
    const name = patch.name !== undefined ? normalizeComponentName(patch.name) : undefined;

    const pre = await resolveComponent(componentId, ctx);
    if (patch.defaultAssigneeId != null) {
      const project = await projectRepository.findById(pre.projectId);
      if (!project) throw new ProjectNotFoundError(pre.projectId);
      await assertDefaultAssigneeEligible(patch.defaultAssigneeId, project, ctx);
    }

    try {
      return await withWorkspaceContext(ctx, async (tx) => {
        const component = await resolveComponent(componentId, ctx, tx);
        await assertCanManage(ctx.userId, ctx.workspaceId, component.projectId, tx);

        const update: Prisma.ComponentUncheckedUpdateInput = {};
        if (name !== undefined && name.toLowerCase() !== component.nameLower) {
          const conflict = await componentRepository.findByNameLower(
            component.projectId,
            name.toLowerCase(),
            tx,
          );
          if (conflict) throw new ComponentNameConflictError(name);
        }
        if (name !== undefined) {
          update.name = name;
          update.nameLower = name.toLowerCase();
        }
        if (patch.description !== undefined) {
          update.description = patch.description?.trim() || null;
        }
        if (patch.defaultAssigneeId !== undefined) {
          update.defaultAssigneeId = patch.defaultAssigneeId;
        }
        if (Object.keys(update).length === 0) return toComponentDto(component);

        const row = await componentRepository.update(componentId, update, tx);
        return toComponentDto(row);
      });
    } catch (err) {
      mapNameRace(err, name ?? pre.name);
    }
  },

  /**
   * Delete a component — the verified move-or-remove flow (project-admin-
   * gated), ONE transaction: lock the component row (`FOR UPDATE` — the
   * delete serializes against a concurrent rename/edit and the count is
   * re-derived inside the same transaction), then either repoint every join
   * row to `moveToComponentId` (skipping issues that already carry the
   * target, whose leftover joins are swept) or drop the joins; issues are
   * untouched either way. The RESTRICT FK backstops any missed path. The
   * receipt reports how many issues were affected and where they went.
   */
  async deleteComponent(
    componentId: string,
    opts: { moveToComponentId?: string | null },
    ctx: WorkspaceContext,
  ): Promise<DeleteComponentReceiptDto> {
    const moveToId = opts.moveToComponentId ?? null;
    return withWorkspaceContext(ctx, async (tx) => {
      const component = await resolveComponent(componentId, ctx, tx);
      await assertCanManage(ctx.userId, ctx.workspaceId, component.projectId, tx);

      if (moveToId != null) {
        if (moveToId === componentId) throw new InvalidMoveTargetError('self');
        const target = await componentRepository.findById(moveToId, tx);
        if (!target || target.workspaceId !== ctx.workspaceId) {
          throw new InvalidMoveTargetError('missing');
        }
        if (target.projectId !== component.projectId) {
          throw new InvalidMoveTargetError('cross_project');
        }
      }

      const locked = await componentRepository.lockById(componentId, tx);
      if (!locked) throw new ComponentNotFoundError(componentId);

      const affectedCount = await workItemComponentRepository.countByComponent(componentId, tx);
      if (moveToId != null) {
        await workItemComponentRepository.reassignItems(componentId, moveToId, tx);
        // Issues already carrying the target kept their old join — sweep it.
        await workItemComponentRepository.deleteByComponent(componentId, tx);
      } else {
        await workItemComponentRepository.deleteByComponent(componentId, tx);
      }
      await componentRepository.delete(componentId, tx);

      return { deletedId: componentId, affectedCount, movedToComponentId: moveToId };
    });
  },

  /**
   * Replace the issue's component set (the picker's bulk form). Edit-gated;
   * every incoming id must resolve to a SAME-project component (unknown /
   * cross-workspace → 404, other-project → 422). One transaction: bulk add +
   * bulk remove + one `{ components: { added, removed } }` revision when
   * anything changed. Idempotent: a no-change set writes nothing. Returns
   * the resulting set, name-ordered.
   */
  async setComponents(
    workItemId: string,
    componentIds: string[],
    ctx: ServiceContext,
  ): Promise<ComponentDto[]> {
    const ids = [...new Set(componentIds)];
    return db.$transaction(async (tx) => {
      const item = await resolveEditableWorkItem(workItemId, ctx, tx);
      const byId = await resolveSameProjectComponents(ids, item, tx);
      const current = await componentRepository.listByWorkItem(workItemId, tx);
      const currentIds = new Set(current.map((c) => c.id));

      const toAdd = ids.filter((id) => !currentIds.has(id));
      const toRemove = current.filter((c) => !ids.includes(c.id));

      await workItemComponentRepository.createMany(
        toAdd.map((componentId) => ({ workItemId, componentId })),
        tx,
      );
      await workItemComponentRepository.removeMany(
        workItemId,
        toRemove.map((c) => c.id),
        tx,
      );

      if (toAdd.length > 0 || toRemove.length > 0) {
        await recordComponentsRevision(
          workItemId,
          ctx.userId,
          toAdd.map((id) => byId.get(id)!.name),
          toRemove.map((c) => c.name),
          tx,
        );
      }

      const rows = await componentRepository.listByWorkItem(workItemId, tx);
      return rows.map(toComponentDto);
    });
  },

  /**
   * Attach one component (the picker's single-add path). Edit-gated,
   * same-project validated; re-adding an attached component is an idempotent
   * no-op (no revision). Returns the resulting set.
   */
  async addComponent(
    workItemId: string,
    componentId: string,
    ctx: ServiceContext,
  ): Promise<ComponentDto[]> {
    return db.$transaction(async (tx) => {
      const item = await resolveEditableWorkItem(workItemId, ctx, tx);
      const byId = await resolveSameProjectComponents([componentId], item, tx);
      const current = await componentRepository.listByWorkItem(workItemId, tx);
      if (current.some((c) => c.id === componentId)) return current.map(toComponentDto);

      await workItemComponentRepository.create({ workItemId, componentId }, tx);
      await recordComponentsRevision(workItemId, ctx.userId, [byId.get(componentId)!.name], [], tx);

      const rows = await componentRepository.listByWorkItem(workItemId, tx);
      return rows.map(toComponentDto);
    });
  },

  /**
   * Detach one component. Edit-gated; removing a component the issue does
   * not carry — including another project's id, which can never be attached
   * here — is an idempotent no-op (no revision). Returns the resulting set.
   */
  async removeComponent(
    workItemId: string,
    componentId: string,
    ctx: ServiceContext,
  ): Promise<ComponentDto[]> {
    return db.$transaction(async (tx) => {
      await resolveEditableWorkItem(workItemId, ctx, tx);
      const current = await componentRepository.listByWorkItem(workItemId, tx);
      const target = current.find((c) => c.id === componentId);
      if (!target) return current.map(toComponentDto);

      await workItemComponentRepository.remove(workItemId, componentId, tx);
      await recordComponentsRevision(workItemId, ctx.userId, [], [target.name], tx);

      return current.filter((c) => c.id !== componentId).map(toComponentDto);
    });
  },
};
