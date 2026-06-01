import { Prisma, type WorkItem, type WorkItemKind } from '@prisma/client';
import { db } from '@/lib/db';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { keyForAppend, keyBetween } from '@/lib/workItems/positioning';
import {
  AssigneeNotInWorkspaceError,
  CrossProjectParentError,
  IllegalParentTypeError,
  ReporterNotInWorkspaceError,
  WorkItemNotFoundError,
} from '@/lib/workItems/errors';
import { CrossWorkspaceLinkError, WorkItemLinkNotFoundError } from '@/lib/workItems/linkErrors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  toWorkItemDto,
  toWorkItemSummaryDto,
  toWorkItemSubtreeDto,
} from '@/lib/mappers/workItemMappers';
import { toWorkItemLinkDto } from '@/lib/mappers/workItemLinkMappers';
import type {
  CreateWorkItemInput,
  UpdateWorkItemInput,
  WorkItemDto,
  WorkItemKindDto,
  WorkItemSummaryDto,
  WorkItemSubtreeDto,
} from '@/lib/dto/workItems';
import type { LinkWorkItemsInput, WorkItemLinkDto } from '@/lib/dto/workItemLinks';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Work-items service — the business-logic surface Epic 2's route handlers
// call (Subtask 1.4.4). It owns every $transaction for the work-item +
// work-item-link domains, maps Prisma rows to DTOs, asserts membership /
// parent / workspace invariants with friendly typed errors AHEAD of the DB
// triggers (defense-in-depth: a friendlier error here, the trigger as the
// structural backstop), and records a revision call atomically with each
// write (the row's STORAGE lands in 1.4.6 — see workItemRevisionsService).
//
// Layer rules (CLAUDE.md): NO raw Prisma here — every DB touch goes through
// workItemRepository / workItemLinkRepository / projectRepository /
// workspaceMembershipRepository, with `tx` threaded into every write inside
// the enclosing transaction. The GUC the future work-item RLS policy (1.4.5)
// reads is bound by upstream middleware before any method runs; service
// methods trust the ServiceContext and never re-set it.

/**
 * The kind-parent matrix, mirrored from the DB trigger
 * (prisma/sql/work_item_triggers.sql · enforce_work_item_kind_parent). The
 * service pre-flights against this for a friendly IllegalParentTypeError; the
 * trigger is the backstop. Allowed PARENT kinds per child kind (epic is
 * always a root → empty set, any non-null parent is illegal):
 */
const ALLOWED_PARENT_KINDS: Record<WorkItemKind, readonly WorkItemKind[]> = {
  epic: [],
  story: ['epic'],
  task: ['epic', 'story'],
  bug: ['epic', 'story', 'task'],
  subtask: ['story', 'task', 'bug'],
};

/** Child kinds that MUST have a parent (cannot be a tree root). */
const KINDS_REQUIRING_PARENT: ReadonlySet<WorkItemKind> = new Set<WorkItemKind>(['subtask']);

/**
 * Cheap service-layer pre-flight of the kind-parent rule. Throws
 * IllegalParentTypeError on a violation so callers get a typed error before
 * the DB trigger fires the same rejection (with a less specific marker
 * message). `parentKind === null` means "top-level placement".
 */
function assertKindParent(childKind: WorkItemKind, parentKind: WorkItemKind | null): void {
  if (parentKind === null) {
    if (KINDS_REQUIRING_PARENT.has(childKind)) {
      throw new IllegalParentTypeError(`A ${childKind} must have a parent.`);
    }
    return;
  }
  if (!ALLOWED_PARENT_KINDS[childKind].includes(parentKind)) {
    throw new IllegalParentTypeError(`A ${childKind} may not be parented to a ${parentKind}.`);
  }
}

/** Membership gate — distinct typed error per role so routes map them apart. */
async function assertReporterMember(userId: string, workspaceId: string): Promise<void> {
  const m = await workspaceMembershipRepository.findByUserAndWorkspace(userId, workspaceId);
  if (!m) throw new ReporterNotInWorkspaceError();
}

async function assertAssigneeMember(userId: string, workspaceId: string): Promise<void> {
  const m = await workspaceMembershipRepository.findByUserAndWorkspace(userId, workspaceId);
  if (!m) throw new AssigneeNotInWorkspaceError();
}

/** Stable, deterministic ordering for summary lists resolved via findByIds. */
function byKeyAsc(a: WorkItem, b: WorkItem): number {
  return a.key - b.key;
}

/** A revision-diff cell. */
type DiffCell = { from: unknown; to: unknown };

export interface MoveWorkItemInput {
  /** Target parent. Omit to keep the current parent; `null` moves to top-level. */
  newParentId?: string | null;
  /** The sibling the moved item should sort AFTER (null → move to start). */
  beforeId?: string | null;
  /** The sibling the moved item should sort BEFORE (null → move to end). */
  afterId?: string | null;
}

export interface ListWorkItemsFilter {
  kind?: WorkItemKindDto;
  status?: string;
  assigneeId?: string | null;
}

export const workItemsService = {
  /**
   * Create a work item: allocate the per-project key + insert the row + emit
   * the initial revision, all in ONE transaction (the key allocation and the
   * insert MUST be atomic, so concurrent creates against the same project get
   * non-overlapping keys). Pre-flight (outside the tx): reporter and assignee
   * are workspace members, the parent (if any) is same-project and a
   * kind-legal parent. The work item's workspaceId is the project's — the
   * authoritative tenant of the row.
   */
  async createWorkItem(input: CreateWorkItemInput, ctx: ServiceContext): Promise<WorkItemDto> {
    const project = await projectRepository.findById(input.projectId);
    if (!project) throw new ProjectNotFoundError(input.projectId);
    const workspaceId = project.workspaceId;

    await assertReporterMember(ctx.userId, workspaceId);
    if (input.assigneeId != null) {
      await assertAssigneeMember(input.assigneeId, workspaceId);
    }

    // Parent pre-flight: same project + kind-legal parent (the DB trigger
    // backstops kind/depth/cycle; cross-project parenting has no trigger, so
    // this assertion is the primary guard for it).
    if (input.parentId != null) {
      const parent = await workItemRepository.findById(input.parentId);
      if (!parent) throw new WorkItemNotFoundError(input.parentId);
      if (parent.projectId !== input.projectId) throw new CrossProjectParentError();
      assertKindParent(input.kind, parent.kind);
    } else {
      assertKindParent(input.kind, null);
    }

    return db.$transaction(async (tx) => {
      const key = await projectRepository.allocateWorkItemNumber(input.projectId, tx);
      const identifier = `${project.identifier}-${key}`;

      // Append after the last sibling. Siblings are project-scoped and
      // parent-scoped (top-level when parentId is null) so the position only
      // orders true peers.
      const siblings = await workItemRepository.findSiblings(
        input.projectId,
        input.parentId ?? null,
        tx,
      );
      const lastPosition = siblings.length ? siblings[siblings.length - 1]!.position : null;
      const position = keyForAppend(lastPosition);

      const data: Prisma.WorkItemUncheckedCreateInput = {
        workspaceId,
        projectId: input.projectId,
        parentId: input.parentId ?? null,
        kind: input.kind,
        key,
        identifier,
        title: input.title,
        descriptionMd: input.descriptionMd ?? null,
        explanationMd: input.explanationMd ?? null,
        ...(input.explanationSource ? { explanationSource: input.explanationSource } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
        assigneeId: input.assigneeId ?? null,
        reporterId: ctx.userId,
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        estimateMinutes: input.estimateMinutes ?? null,
        position,
      };

      const row = await workItemRepository.create(data, tx);

      // Initial revision. The created-row diff shape is 1.4.6's to finalize
      // (it owns the table); the call-site + changeKind are locked here.
      await workItemRevisionsService.recordRevision(
        { workItemId: row.id, changedById: ctx.userId, changeKind: 'created', diff: {} },
        tx,
      );

      return toWorkItemDto(row);
    });
  },

  /**
   * Patch a work item. An empty patch (no fields supplied) is a no-op that
   * returns the current DTO WITHOUT opening a transaction or writing a
   * revision. Otherwise: lock the row, compute the diff (fields that actually
   * change), apply the explanation-source state machine, validate a re-parent,
   * write, and record one 'updated' revision — all in one transaction. A diff
   * that turns out empty (every supplied field already equals current) still
   * skips the write.
   */
  async updateWorkItem(
    id: string,
    patch: UpdateWorkItemInput,
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    const PATCH_KEYS: readonly (keyof UpdateWorkItemInput)[] = [
      'parentId',
      'title',
      'descriptionMd',
      'explanationMd',
      'explanationSource',
      'status',
      'assigneeId',
      'priority',
      'dueDate',
      'estimateMinutes',
    ];
    const anyFieldProvided = PATCH_KEYS.some((k) => patch[k] !== undefined);
    if (!anyFieldProvided) {
      const current = await workItemRepository.findById(id);
      if (!current) throw new WorkItemNotFoundError(id);
      return toWorkItemDto(current);
    }

    return db.$transaction(async (tx) => {
      const locked = await workItemRepository.lockById(id, tx);
      if (!locked) throw new WorkItemNotFoundError(id);
      const current = await workItemRepository.findById(id, tx);
      if (!current) throw new WorkItemNotFoundError(id);

      const update: Prisma.WorkItemUncheckedUpdateInput = {};
      const diff: Record<string, DiffCell> = {};

      // Plain scalar fields (string / nullable-string / number / enum):
      // include only when supplied AND different from current.
      if (patch.title !== undefined && patch.title !== current.title) {
        update.title = patch.title;
        diff.title = { from: current.title, to: patch.title };
      }
      if (patch.descriptionMd !== undefined && patch.descriptionMd !== current.descriptionMd) {
        update.descriptionMd = patch.descriptionMd;
        diff.descriptionMd = { from: current.descriptionMd, to: patch.descriptionMd };
      }
      if (patch.explanationMd !== undefined && patch.explanationMd !== current.explanationMd) {
        update.explanationMd = patch.explanationMd;
        diff.explanationMd = { from: current.explanationMd, to: patch.explanationMd };
      }
      if (patch.status !== undefined && patch.status !== current.status) {
        update.status = patch.status;
        diff.status = { from: current.status, to: patch.status };
      }
      if (patch.priority !== undefined && patch.priority !== current.priority) {
        update.priority = patch.priority;
        diff.priority = { from: current.priority, to: patch.priority };
      }
      if (
        patch.estimateMinutes !== undefined &&
        patch.estimateMinutes !== current.estimateMinutes
      ) {
        update.estimateMinutes = patch.estimateMinutes;
        diff.estimateMinutes = { from: current.estimateMinutes, to: patch.estimateMinutes };
      }

      // Assignee: validate workspace membership on a change to a non-null
      // member; un-assign (null) skips the check.
      if (patch.assigneeId !== undefined && patch.assigneeId !== current.assigneeId) {
        if (patch.assigneeId !== null) {
          await assertAssigneeMember(patch.assigneeId, current.workspaceId);
        }
        update.assigneeId = patch.assigneeId;
        diff.assigneeId = { from: current.assigneeId, to: patch.assigneeId };
      }

      // Due date: compare by instant (Date vs ISO string), record ISO in diff.
      if (patch.dueDate !== undefined) {
        const newDate = patch.dueDate === null ? null : new Date(patch.dueDate);
        const currentMs = current.dueDate ? current.dueDate.getTime() : null;
        const newMs = newDate ? newDate.getTime() : null;
        if (currentMs !== newMs) {
          update.dueDate = newDate;
          diff.dueDate = {
            from: current.dueDate ? current.dueDate.toISOString() : null,
            to: newDate ? newDate.toISOString() : null,
          };
        }
      }

      // ── Explanation-source state machine ──────────────────────────────
      // When the patch carries explanationMd and the current source is an
      // un-reviewed ai_draft, editing the explanation transitions the source
      // to user_edited — UNLESS the caller set explanationSource explicitly
      // (explicit always wins). The transition is captured in the diff so the
      // activity feed surfaces "AI draft → user edited".
      let effectiveSource = patch.explanationSource;
      const explanationProvided = patch.explanationMd !== undefined;
      if (
        explanationProvided &&
        current.explanationSource === 'ai_draft' &&
        patch.explanationSource === undefined
      ) {
        effectiveSource = 'user_edited';
      }
      if (effectiveSource !== undefined && effectiveSource !== current.explanationSource) {
        update.explanationSource = effectiveSource;
        diff.explanationSource = { from: current.explanationSource, to: effectiveSource };
      }

      // Re-parent: same-project + kind pre-flight (DB trigger backstops
      // cycle/depth/kind on the write).
      if (patch.parentId !== undefined && patch.parentId !== current.parentId) {
        if (patch.parentId === null) {
          assertKindParent(current.kind, null);
        } else {
          const parent = await workItemRepository.findById(patch.parentId, tx);
          if (!parent) throw new WorkItemNotFoundError(patch.parentId);
          if (parent.projectId !== current.projectId) throw new CrossProjectParentError();
          assertKindParent(current.kind, parent.kind);
        }
        update.parentId = patch.parentId;
        diff.parentId = { from: current.parentId, to: patch.parentId };
      }

      if (Object.keys(diff).length === 0) {
        return toWorkItemDto(current);
      }

      const row = await workItemRepository.update(id, update, tx);
      await workItemRevisionsService.recordRevision(
        { workItemId: id, changedById: ctx.userId, changeKind: 'updated', diff },
        tx,
      );
      return toWorkItemDto(row);
    });
  },

  /**
   * Assign (or un-assign, with null) a work item. Thin specialization of
   * updateWorkItem for the common case — the membership check on a non-null
   * assignee happens inside updateWorkItem against the item's own workspace,
   * so this stays a one-field patch.
   */
  async assignWorkItem(
    id: string,
    assigneeId: string | null,
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    return workItemsService.updateWorkItem(id, { assigneeId }, ctx);
  },

  /**
   * Soft-delete (archive) a work item: stamp archivedAt + record the
   * revision, in one transaction. Children are deliberately LEFT INTACT (the
   * Linear shape): archiving a node hides only that node from active views;
   * its descendants stay live (and simply drop out of any subtree filtered to
   * non-archived ancestors). A destructive tree-delete is a separate,
   * explicit action — never a side effect of archive.
   */
  async archiveWorkItem(id: string, ctx: ServiceContext): Promise<WorkItemDto> {
    return db.$transaction(async (tx) => {
      const row = await workItemRepository.archive(id, tx); // throws WorkItemNotFoundError if absent
      await workItemRevisionsService.recordRevision(
        {
          workItemId: id,
          changedById: ctx.userId,
          changeKind: 'archived',
          diff: { archivedAt: { from: null, to: row.archivedAt?.toISOString() ?? null } },
        },
        tx,
      );
      return toWorkItemDto(row);
    });
  },

  /**
   * Re-parent and/or reorder a work item atomically. Position is minted by
   * fractional indexing between the named neighbors, so a reorder is a single
   * O(1) write with no sibling cascade:
   *   - beforeId + afterId → keyBetween(before, after)
   *   - beforeId only (afterId null)  → append after beforeId
   *   - afterId only  (beforeId null) → prepend before afterId
   *   - neither → keep the current position (same parent) or take the first
   *     key (moved into an otherwise-empty new parent).
   * A move that changes nothing (same parent, same resulting position) is a
   * no-op: no write, no revision.
   */
  async moveWorkItem(
    id: string,
    input: MoveWorkItemInput,
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    return db.$transaction(async (tx) => {
      const locked = await workItemRepository.lockById(id, tx);
      if (!locked) throw new WorkItemNotFoundError(id);
      const current = await workItemRepository.findById(id, tx);
      if (!current) throw new WorkItemNotFoundError(id);

      const targetParentId = input.newParentId !== undefined ? input.newParentId : current.parentId;
      const parentChanged = targetParentId !== current.parentId;

      if (parentChanged) {
        if (targetParentId === null) {
          assertKindParent(current.kind, null);
        } else {
          const parent = await workItemRepository.findById(targetParentId, tx);
          if (!parent) throw new WorkItemNotFoundError(targetParentId);
          if (parent.projectId !== current.projectId) throw new CrossProjectParentError();
          assertKindParent(current.kind, parent.kind);
        }
      }

      // Resolve neighbor positions to bracket the new slot.
      const beforePos = input.beforeId
        ? ((await workItemRepository.findById(input.beforeId, tx))?.position ?? null)
        : null;
      const afterPos = input.afterId
        ? ((await workItemRepository.findById(input.afterId, tx))?.position ?? null)
        : null;

      let newPosition: string;
      if (input.beforeId == null && input.afterId == null) {
        // No neighbors given: keep position when the parent is unchanged;
        // otherwise the item lands first in its new (assumed-empty) parent.
        newPosition = parentChanged ? keyForAppend(null) : current.position;
      } else {
        newPosition = keyBetween(beforePos, afterPos);
      }

      if (!parentChanged && newPosition === current.position) {
        return toWorkItemDto(current); // true no-op
      }

      const update: Prisma.WorkItemUncheckedUpdateInput = {
        parentId: targetParentId,
        position: newPosition,
      };
      const diff: Record<string, DiffCell> = {};
      if (parentChanged) diff.parentId = { from: current.parentId, to: targetParentId };
      if (newPosition !== current.position) {
        diff.position = { from: current.position, to: newPosition };
      }

      const row = await workItemRepository.update(id, update, tx);
      await workItemRevisionsService.recordRevision(
        { workItemId: id, changedById: ctx.userId, changeKind: 'updated', diff },
        tx,
      );
      return toWorkItemDto(row);
    });
  },

  /**
   * Non-archived work items in a project, optionally filtered by
   * kind / status / assignee, as lighter summary DTOs (no Markdown blobs).
   * Read-only; `ctx` is reserved for the workspace-scoped RLS read landing in
   * 1.4.5.
   */
  async listWorkItems(
    projectId: string,
    filter: ListWorkItemsFilter,
    _ctx: ServiceContext,
  ): Promise<WorkItemSummaryDto[]> {
    const rows = await workItemRepository.findByProjectFiltered(projectId, {
      ...(filter.kind ? { kind: filter.kind } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.assigneeId !== undefined ? { assigneeId: filter.assigneeId } : {}),
    });
    return rows.map(toWorkItemSummaryDto);
  },

  /**
   * The full subtree rooted at `rootId` (one recursive-CTE round-trip),
   * mapped to subtree-row DTOs with depth metadata. Read-only; `ctx` reserved
   * for 1.4.5 RLS.
   */
  async getWorkItemSubtree(rootId: string, _ctx: ServiceContext): Promise<WorkItemSubtreeDto[]> {
    const rows = await workItemRepository.findSubtree(rootId);
    return rows.map(toWorkItemSubtreeDto);
  },

  /**
   * Create a link "fromId <kind> toId". Asserts both items exist and share a
   * workspace (the trigger backstops with CrossWorkspaceLinkError), writes the
   * row with the from-item's workspaceId, and for `relates_to` ALSO persists
   * the reciprocal toId→fromId row in the same transaction. The reciprocal is
   * idempotent: we check for an existing mirror first and skip when present —
   * a pre-existence check rather than catch-P2002, because a unique violation
   * would ABORT the enclosing Postgres transaction (the same reason
   * projectsService opens a fresh tx per retry), which would also lose the
   * revision write. One revision is recorded on the FROM item — the reciprocal
   * is bookkeeping, not a separate user action.
   */
  async linkWorkItems(input: LinkWorkItemsInput, ctx: ServiceContext): Promise<WorkItemLinkDto> {
    return db.$transaction(async (tx) => {
      const fromItem = await workItemRepository.findById(input.fromId, tx);
      if (!fromItem) throw new WorkItemNotFoundError(input.fromId);
      const toItem = await workItemRepository.findById(input.toId, tx);
      if (!toItem) throw new WorkItemNotFoundError(input.toId);
      if (fromItem.workspaceId !== toItem.workspaceId) throw new CrossWorkspaceLinkError();

      const link = await workItemLinkRepository.create(
        {
          workspaceId: fromItem.workspaceId,
          fromId: input.fromId,
          toId: input.toId,
          kind: input.kind,
          createdById: ctx.userId,
        },
        tx,
      );

      if (input.kind === 'relates_to') {
        const existingReciprocal = await workItemLinkRepository.findReciprocal(
          input.toId,
          input.fromId,
          'relates_to',
          tx,
        );
        if (!existingReciprocal) {
          await workItemLinkRepository.create(
            {
              workspaceId: fromItem.workspaceId,
              fromId: input.toId,
              toId: input.fromId,
              kind: 'relates_to',
              createdById: ctx.userId,
            },
            tx,
          );
        }
      }

      await workItemRevisionsService.recordRevision(
        {
          workItemId: input.fromId,
          changedById: ctx.userId,
          changeKind: 'updated',
          diff: { links: { added: [{ toId: input.toId, kind: input.kind }] } },
        },
        tx,
      );

      return toWorkItemLinkDto(link);
    });
  },

  /**
   * Remove a link by id (+ its reciprocal for `relates_to`) and record the
   * removal revision on the from item, in one transaction. A missing link is
   * a typed WorkItemLinkNotFoundError; a missing reciprocal is NOT an error
   * (forward-compat with legacy half-pairs).
   */
  async unlinkWorkItems(linkId: string, ctx: ServiceContext): Promise<void> {
    await db.$transaction(async (tx) => {
      const link = await workItemLinkRepository.findById(linkId);
      if (!link) throw new WorkItemLinkNotFoundError(linkId);

      await workItemLinkRepository.delete(linkId, tx);

      if (link.kind === 'relates_to') {
        const reciprocal = await workItemLinkRepository.findReciprocal(
          link.toId,
          link.fromId,
          'relates_to',
          tx,
        );
        if (reciprocal) {
          await workItemLinkRepository.delete(reciprocal.id, tx);
        }
      }

      await workItemRevisionsService.recordRevision(
        {
          workItemId: link.fromId,
          changedById: ctx.userId,
          changeKind: 'updated',
          diff: { links: { removed: [{ toId: link.toId, kind: link.kind }] } },
        },
        tx,
      );
    });
  },

  /**
   * The blockers of `workItemId`: the items it `is_blocked_by`. One link-table
   * query yields the toIds, one findByIds resolves them all (N+0 — no N+1).
   * Sorted by key for a stable order. Read-only; `ctx` reserved for 1.4.5 RLS.
   */
  async getBlockers(workItemId: string, _ctx: ServiceContext): Promise<WorkItemSummaryDto[]> {
    const links = await workItemLinkRepository.findByFromItem(workItemId, 'is_blocked_by');
    const rows = await workItemRepository.findByIds(links.map((l) => l.toId));
    return rows.sort(byKeyAsc).map(toWorkItemSummaryDto);
  },

  /**
   * The items `workItemId` is blocking: those that are `is_blocked_by` it. One
   * reverse link-table query (the @@index([toId, kind]) lookup) yields the
   * fromIds, one findByIds resolves them. Read-only; `ctx` reserved for 1.4.5.
   */
  async getBlocking(workItemId: string, _ctx: ServiceContext): Promise<WorkItemSummaryDto[]> {
    const links = await workItemLinkRepository.findByToItem(workItemId, 'is_blocked_by');
    const rows = await workItemRepository.findByIds(links.map((l) => l.fromId));
    return rows.sort(byKeyAsc).map(toWorkItemSummaryDto);
  },

  /**
   * Whether `workItemId` is ready to start: every `is_blocked_by` blocker has
   * reached the terminal status. Backed by a SINGLE counting query in the
   * repository (countOpenBlockers) — no fetch-then-filter — so Epic 7's
   * ready-set engine can call it across many items cheaply. v1 hardcodes
   * 'done' as the terminal status (see countOpenBlockers' note); Epic 2's
   * workflow Story generalizes to per-project terminal-status sets. Read-only;
   * `ctx` reserved for 1.4.5 RLS.
   */
  async isReady(workItemId: string, _ctx: ServiceContext): Promise<boolean> {
    const openBlockers = await workItemLinkRepository.countOpenBlockers(workItemId);
    return openBlockers === 0;
  },
};
