import { Prisma, type WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { assertValidParent, allowedParentKinds, type IssueType } from '@/lib/issues/parentRules';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { keyForAppend, keyBetween } from '@/lib/workItems/positioning';
import { relationshipToLink } from '@/lib/workItems/linkRelationships';
import {
  AssigneeNotInWorkspaceError,
  CrossProjectParentError,
  IllegalTransitionError,
  NoInitialStatusError,
  ReporterNotInWorkspaceError,
  StaleWorkItemError,
  UnknownStatusError,
  WorkItemNotFoundError,
} from '@/lib/workItems/errors';
import { CrossWorkspaceLinkError, WorkItemLinkNotFoundError } from '@/lib/workItems/linkErrors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  toWorkItemDto,
  toWorkItemSummaryDto,
  toWorkItemSubtreeDto,
  toWorkItemTreeNodeDto,
  toWorkItemListItemDto,
  toWorkItemTreeRowDto,
} from '@/lib/mappers/workItemMappers';
import { toWorkItemLinkDto } from '@/lib/mappers/workItemLinkMappers';
import { toWorkItemRevisionDto } from '@/lib/mappers/workItemRevisionMappers';
import type {
  WorkItemForestRow,
  WorkItemTreeRow,
  RepoIssueFilter,
} from '@/lib/repositories/workItemRepository';
import type { IssueSort } from '@/lib/issues/issueListView';
import type {
  CreateWorkItemInput,
  IssueDetailDto,
  ProjectTreeFilter,
  RelationshipLinkDto,
  UpdateWorkItemInput,
  WorkItemDto,
  WorkItemKindDto,
  WorkItemListItemDto,
  WorkItemRevisionDto,
  WorkItemSummaryDto,
  WorkItemSubtreeDto,
  WorkItemTreeNodeDto,
  TreeLevelDto,
} from '@/lib/dto/workItems';
import type {
  LinkWorkItemsInput,
  RelationshipKind,
  WorkItemLinkDto,
} from '@/lib/dto/workItemLinks';
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

// The service-layer kind-parent pre-flight is `assertValidParent` from
// lib/issues/parentRules.ts — the single source of truth for the kind-parent
// matrix (Subtask 2.1.2). It throws a friendly IllegalParentTypeError ahead of
// the DB trigger (prisma/sql/work_item_triggers.sql · enforce_work_item_kind_parent),
// which remains the structural backstop. This service used to carry a private
// `ALLOWED_PARENT_KINDS` copy of the matrix; 2.1.2 removed it so the rule lives
// in exactly one place. `WorkItemKind` and `parentRules`' `IssueType` are the
// same string union, so the kinds read off rows pass straight through.
// Convention at the call sites: assertValidParent(parentKind, childKind) — a
// null parent is top-level placement.

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

/**
 * Pair each resolved linked item (key-ASC) with the `work_item_link.id` of the
 * edge that points at it, so the 2.4.9 inline remove can target the exact link.
 * `endpoint` is which end of the edge holds the linked item: `toId` for OUT
 * edges (blocked-by / relates-to / duplicates / clones), `fromId` for the
 * reverse IN edge (blocks). The (item, endpoint, kind) triple is unique, so the
 * map is 1:1.
 */
function toRelationshipLinks(
  links: ReadonlyArray<{ id: string; fromId: string; toId: string }>,
  rows: WorkItem[],
  endpoint: 'fromId' | 'toId',
): RelationshipLinkDto[] {
  const linkIdByItem = new Map(links.map((l) => [l[endpoint], l.id]));
  return rows
    .sort(byKeyAsc)
    .map((r) => ({ linkId: linkIdByItem.get(r.id) ?? '', item: toWorkItemSummaryDto(r) }));
}

/** A revision-diff cell. */
type DiffCell = { from: unknown; to: unknown };

/**
 * The initial-state diff for a freshly-created work item: every NON-NULL
 * field of the new row recorded as `{ from: null, to: <value> }` (the row had
 * no prior state, so `from` is always null). Null/absent fields are omitted —
 * an un-set descriptionMd doesn't appear. This is the created-revision shape
 * Subtask 1.4.4 deliberately deferred to 1.4.6 (the create call site passed
 * `diff: {}` with a "1.4.6's to finalize" note); finalized here. `dueDate` is
 * serialized to ISO (matching the update path); enums/scalars pass through.
 */
function buildCreatedDiff(row: WorkItem): Record<string, DiffCell> {
  const diff: Record<string, DiffCell> = {};
  const set = (k: string, v: unknown): void => {
    if (v !== null && v !== undefined) diff[k] = { from: null, to: v };
  };
  set('projectId', row.projectId);
  set('parentId', row.parentId);
  set('kind', row.kind);
  set('key', row.key);
  set('identifier', row.identifier);
  set('title', row.title);
  set('descriptionMd', row.descriptionMd);
  set('explanationMd', row.explanationMd);
  set('explanationSource', row.explanationSource);
  set('status', row.status);
  set('priority', row.priority);
  set('assigneeId', row.assigneeId);
  set('reporterId', row.reporterId);
  set('dueDate', row.dueDate ? row.dueDate.toISOString() : null);
  set('estimateMinutes', row.estimateMinutes);
  set('position', row.position);
  return diff;
}

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

/**
 * Nest a flat `findProjectForest` projection into the `WorkItemTreeNodeDto`
 * forest the `/issues` tree-table renders (Subtask 2.5.1). Roots (parentId
 * null) and every sibling set are ordered by `key` asc — the stable PROD-N
 * order. Every non-root row's parent is guaranteed present (the CTE walks DOWN
 * from roots), so there are no dangling parents to drop.
 *
 * When `prune` is true (a filter is active) the tree is reduced to the
 * context-preserving set: a node is kept iff it `matched` OR has a kept
 * descendant — so a deep match drags its ancestor chain along (those ancestors
 * carry `matched: false` → rendered muted), while an unmatched leaf with no
 * matched descendants is dropped. This is the standard tree-filter that keeps
 * the result navigable, NOT a flat filter that would orphan children. `prune`
 * is false when no filter is active (every row is `matched` then anyway).
 * `hasChildren` falls out of the PRUNED child set (via the mapper), so a
 * chevron only shows when there is something left to expand.
 */
/**
 * Translate the wire-level `ProjectTreeFilter` into the repository filter shape
 * shared by the tree (`getProjectTree`) and List (`getProjectIssuesList`) reads.
 * Forwards only the NON-EMPTY axes (an absent/empty facet means "don't filter
 * on this axis"); a blank `text` quick-filter is treated as absent so trailing
 * whitespace never hides the whole project. `includeUnassigned` is forwarded
 * verbatim — the "Unassigned" bucket, OR-ed with any `assigneeIds`.
 */
function buildRepoFilter(filter: ProjectTreeFilter): RepoIssueFilter {
  const repoFilter: RepoIssueFilter = {};
  if (filter.kinds && filter.kinds.length > 0) repoFilter.kinds = filter.kinds;
  if (filter.statuses && filter.statuses.length > 0) repoFilter.statuses = filter.statuses;
  if (filter.assigneeIds && filter.assigneeIds.length > 0) {
    repoFilter.assigneeIds = filter.assigneeIds;
  }
  if (filter.includeUnassigned) repoFilter.includeUnassigned = true;
  const text = filter.text?.trim();
  if (text) repoFilter.text = text;
  return repoFilter;
}

/** True when the repo filter constrains at least one axis (drives forest pruning). */
function repoFilterIsActive(f: RepoIssueFilter): boolean {
  return (
    f.kinds !== undefined ||
    f.statuses !== undefined ||
    f.assigneeIds !== undefined ||
    f.includeUnassigned === true ||
    f.text !== undefined
  );
}

function assembleProjectForest(rows: WorkItemForestRow[], prune: boolean): WorkItemTreeNodeDto[] {
  const childrenByParent = new Map<string, WorkItemForestRow[]>();
  const roots: WorkItemForestRow[] = [];
  for (const row of rows) {
    if (row.parentId === null) {
      roots.push(row);
    } else {
      const group = childrenByParent.get(row.parentId);
      if (group) group.push(row);
      else childrenByParent.set(row.parentId, [row]);
    }
  }
  const byKey = (a: WorkItemForestRow, b: WorkItemForestRow): number => a.key - b.key;
  roots.sort(byKey);
  for (const group of childrenByParent.values()) group.sort(byKey);

  const build = (row: WorkItemForestRow): WorkItemTreeNodeDto | null => {
    const children: WorkItemTreeNodeDto[] = [];
    for (const child of childrenByParent.get(row.id) ?? []) {
      const node = build(child);
      if (node) children.push(node);
    }
    // Ancestor retention: drop only an unmatched node with no surviving child.
    if (prune && !row.matched && children.length === 0) return null;
    return toWorkItemTreeNodeDto(row, children);
  };

  const forest: WorkItemTreeNodeDto[] = [];
  for (const root of roots) {
    const node = build(root);
    if (node) forest.push(node);
  }
  return forest;
}

/** Default + max children fetched per lazy tree level (Subtask 2.5.13). The
 * design pins 50 per node; the max caps a forged `?take`. */
const TREE_LEVEL_PAGE_SIZE = 50;
const TREE_LEVEL_MAX_TAKE = 200;

/** Clamp the caller's paging into the safe range (a forged ?take/?offset can't
 * blow the read up). */
function clampTreePage(params: { take?: number; offset?: number }): {
  take: number;
  offset: number;
} {
  const take = Math.min(
    Math.max(1, Math.trunc(params.take ?? TREE_LEVEL_PAGE_SIZE)),
    TREE_LEVEL_MAX_TAKE,
  );
  const offset = Math.max(0, Math.trunc(params.offset ?? 0));
  return { take, offset };
}

/** Turn a `take + 1` fetch + the level's total into one level page: `hasMore`
 * iff the extra row came back, then map the first `take` rows to DTOs. */
function buildTreeLevel(rows: WorkItemTreeRow[], take: number, total: number): TreeLevelDto {
  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  return { rows: page.map(toWorkItemTreeRowDto), hasMore, total };
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
      assertValidParent(parent.kind, input.kind);
    } else {
      assertValidParent(null, input.kind);
    }

    // Initial status (Subtask 2.2.4): a new item lands in the project's
    // workflow initial status — there's no "from" status to validate against
    // on a brand-new row, so this bypasses transition validation. The pre-2.2.4
    // schema `@default("open")` no longer governs the created status; the
    // default now comes from the workflow's initial-status row (2.2.2 seeds
    // exactly one per project). A corrupt/missing seed is a server invariant
    // violation → NoInitialStatusError (500).
    const statusKey = await workflowsService.getInitialStatusKey(input.projectId, workspaceId);
    if (statusKey == null) throw new NoInitialStatusError(input.projectId);

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
        status: statusKey,
        ...(input.explanationSource ? { explanationSource: input.explanationSource } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
        assigneeId: input.assigneeId ?? null,
        reporterId: ctx.userId,
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        estimateMinutes: input.estimateMinutes ?? null,
        position,
      };

      const row = await workItemRepository.create(data, tx);

      // Initial revision: the created-row state as a { from: null, to: value }
      // diff (1.4.6 finalized the shape 1.4.4 deferred — see buildCreatedDiff).
      await workItemRevisionsService.recordRevision(
        {
          workItemId: row.id,
          changedById: ctx.userId,
          changeKind: 'created',
          diff: buildCreatedDiff(row),
        },
        tx,
      );

      // Links collected in the create modal (Subtask 2.4.10), written in the
      // SAME transaction as the item — so the issue + its links commit or roll
      // back together (a bad link aborts the whole create; the item is never
      // born half-linked). Each pending entry is a (relationship, target) pair;
      // the new row's id now exists, so `relationshipToLink` resolves the
      // directed edge (the single source of the `blocks` from/to flip). The DB
      // trigger backstops cycle/self-link/workspace-consistency at insert (the
      // repo translates them to typed errors); a missing or cross-workspace
      // target is pre-checked here for a precise typed error rather than a raw
      // FK violation. `relates_to` gets its reciprocal row, mirroring
      // linkWorkItems (1.4.4). The links ride in the created-row state, so no
      // separate link revision is recorded — they're part of creation, not a
      // later edit.
      if (input.links?.length) {
        for (const pending of input.links) {
          const target = await workItemRepository.findById(pending.targetId, tx);
          if (!target) throw new WorkItemNotFoundError(pending.targetId);
          if (target.workspaceId !== workspaceId) throw new CrossWorkspaceLinkError();

          const directed = relationshipToLink(pending.relationship, row.id, pending.targetId);
          await workItemLinkRepository.create(
            {
              workspaceId,
              fromId: directed.fromId,
              toId: directed.toId,
              kind: directed.kind,
              createdById: ctx.userId,
            },
            tx,
          );

          if (directed.kind === 'relates_to') {
            const existingReciprocal = await workItemLinkRepository.findReciprocal(
              directed.toId,
              directed.fromId,
              'relates_to',
              tx,
            );
            if (!existingReciprocal) {
              await workItemLinkRepository.create(
                {
                  workspaceId,
                  fromId: directed.toId,
                  toId: directed.fromId,
                  kind: 'relates_to',
                  createdById: ctx.userId,
                },
                tx,
              );
            }
          }
        }
      }

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
    opts: { expectedUpdatedAt?: string } = {},
  ): Promise<WorkItemDto> {
    const PATCH_KEYS: readonly (keyof UpdateWorkItemInput)[] = [
      'parentId',
      'kind',
      'title',
      'descriptionMd',
      'explanationMd',
      'explanationSource',
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

      // Optimistic concurrency (2.3.6): the edit form submits the `updatedAt`
      // it read at render; if the row moved since (someone else edited), reject
      // with a 409 the UI turns into a "refresh and retry" banner. Checked
      // under the FOR UPDATE lock so the compare-then-write is race-free.
      if (
        opts.expectedUpdatedAt !== undefined &&
        current.updatedAt.toISOString() !== opts.expectedUpdatedAt
      ) {
        throw new StaleWorkItemError();
      }

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

      // ── Kind / parent re-validation ───────────────────────────────────
      // `kind` is mutable (user directive). A kind OR parent change must keep
      // BOTH sides of the kind-parent matrix legal: (1) the effective
      // (parent, kind) pair, and (2) the new kind must legally parent every
      // existing child. (DB trigger backstops cycle/depth/kind on the write;
      // cross-project parenting has no trigger, so it's checked here.)
      const nextKind = patch.kind !== undefined ? patch.kind : current.kind;
      const nextParentId = patch.parentId !== undefined ? patch.parentId : current.parentId;
      const kindChanged = patch.kind !== undefined && patch.kind !== current.kind;
      const parentChanged = patch.parentId !== undefined && patch.parentId !== current.parentId;

      if (kindChanged || parentChanged) {
        if (nextParentId === null) {
          assertValidParent(null, nextKind);
        } else {
          const parent = await workItemRepository.findById(nextParentId, tx);
          if (!parent) throw new WorkItemNotFoundError(nextParentId);
          if (parent.projectId !== current.projectId) throw new CrossProjectParentError();
          assertValidParent(parent.kind, nextKind);
        }
      }

      if (kindChanged) {
        const children = await workItemRepository.findChildren(id, tx);
        for (const child of children) {
          assertValidParent(nextKind, child.kind); // new kind must parent each child
        }
        update.kind = patch.kind;
        diff.kind = { from: current.kind, to: patch.kind };
      }

      if (parentChanged) {
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
   * Move a work item to a new status THROUGH the per-project workflow gate
   * (Subtask 2.2.4) — the typed-workflow entry point for `work_item.status`,
   * distinct from updateWorkItem's free-form status patch. Order matters:
   *   1. tenant gate (cross-workspace id → 404, BEFORE any status check — no
   *      existence leak, and the AC's "404 not UNKNOWN_STATUS" ordering);
   *   2. no-op (`toStatusKey === current`) → return WITHOUT a revision row,
   *      the same idempotency rule updateWorkItem follows;
   *   3. target must be a real status in this project's workflow → UnknownStatusError;
   *   4. the move must be legal under the workflow → IllegalTransitionError;
   *   5. status write + the 'updated' revision in ONE transaction (atomic — a
   *      revision-insert failure rolls back the status change).
   * The validation reads (getStatusByKey / canTransition) are workspace-scoped
   * via the explicit workspaceId the workflow service already enforces.
   */
  async updateStatus(
    workItemId: string,
    toStatusKey: string,
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    return db.$transaction(async (tx) => {
      const locked = await workItemRepository.lockById(workItemId, tx);
      if (!locked) throw new WorkItemNotFoundError(workItemId);
      const current = await workItemRepository.findById(workItemId, tx);
      // Tenant gate FIRST: a cross-workspace id is indistinguishable from a
      // never-existed one (404), and must not leak via a status error.
      if (!current || current.workspaceId !== ctx.workspaceId) {
        throw new WorkItemNotFoundError(workItemId);
      }

      const fromKey = current.status;
      // No-op move: succeed without writing a revision (idempotent).
      if (fromKey === toStatusKey) return toWorkItemDto(current);

      const target = await workflowsService.getStatusByKey(
        current.projectId,
        toStatusKey,
        ctx.workspaceId,
      );
      if (!target) throw new UnknownStatusError(toStatusKey);

      const legal = await workflowsService.canTransition(
        current.projectId,
        fromKey,
        toStatusKey,
        ctx.workspaceId,
      );
      if (!legal) throw new IllegalTransitionError(fromKey, toStatusKey);

      const row = await workItemRepository.update(workItemId, { status: toStatusKey }, tx);
      await workItemRevisionsService.recordRevision(
        {
          workItemId,
          changedById: ctx.userId,
          changeKind: 'updated',
          diff: { status: { from: fromKey, to: toStatusKey } },
        },
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
          assertValidParent(null, current.kind);
        } else {
          const parent = await workItemRepository.findById(targetParentId, tx);
          if (!parent) throw new WorkItemNotFoundError(targetParentId);
          if (parent.projectId !== current.projectId) throw new CrossProjectParentError();
          assertValidParent(parent.kind, current.kind);
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
   * The project's WHOLE non-archived issue forest, nested into the tree the
   * `/issues` list view renders (Subtask 2.5.1) — one recursive-CTE round-trip
   * (no N+1), then in-memory nesting. Roots and siblings come back `key`-asc.
   *
   * Tenant gate (finding #26): the project must resolve AND belong to the active
   * workspace, else `ProjectNotFoundError` (→ 404, no existence leak — a
   * cross-tenant `projectId` is indistinguishable from a never-existed one). The
   * forest read ALSO carries an explicit `workspaceId` on its anchor + recursive
   * step, so a stray cross-workspace row can't enter even with RLS inert under
   * the dev/CI superuser.
   *
   * The optional `filter` (kind / status / assignee / text) is CONTEXT-
   * PRESERVING: matching nodes keep their ancestor chain (rendered muted) so the
   * tree stays navigable. `assigneeId: null` filters to UNASSIGNED; a blank
   * `text` is ignored. An empty project → `[]`; a no-filter call → the full
   * forest with every node `matched`.
   */
  async getProjectTree(
    projectId: string,
    filter: ProjectTreeFilter,
    ctx: ServiceContext,
  ): Promise<WorkItemTreeNodeDto[]> {
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }

    const repoFilter = buildRepoFilter(filter);
    const rows = await workItemRepository.findProjectForest(
      projectId,
      project.workspaceId,
      repoFilter,
    );

    return assembleProjectForest(rows, repoFilterIsActive(repoFilter));
  },

  /**
   * The flat, sorted issue list powering the List view (Subtask 2.5.8). Same
   * project + workspace gate as `getProjectTree` (a cross-workspace project id
   * is a not-found, not an empty list), the SAME filter axes (so the List
   * honours the 2.5.4 filter bar), but the rows come back UN-NESTED and ordered
   * by the active `sort` — the read does the `ORDER BY` (no JS re-nesting). An
   * empty project → `[]`. Returns wire-safe `WorkItemListItemDto`s; the route
   * shapes them into the same `IssueRowData` the tree row uses.
   */
  async getProjectIssuesList(
    projectId: string,
    params: { sort: IssueSort; filter?: ProjectTreeFilter },
    ctx: ServiceContext,
  ): Promise<WorkItemListItemDto[]> {
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }

    const repoFilter = buildRepoFilter(params.filter ?? {});
    const rows = await workItemRepository.findProjectIssuesFlat(
      projectId,
      project.workspaceId,
      params.sort,
      repoFilter,
    );

    return rows.map(toWorkItemListItemDto);
  },

  /**
   * The project's ROOT issues for the LAZY tree (Subtask 2.5.13, finding #57) —
   * one sorted, paged level (`parentId IS NULL`), each row carrying
   * `hasChildren` so the client renders an expand chevron without loading the
   * subtree. Same project + workspace gate as `getProjectTree` (a cross-tenant
   * `projectId` → `ProjectNotFoundError`, no existence leak). `hasMore` is
   * derived from a `take + 1` fetch (no COUNT). This is the UNfiltered tree's
   * read; a filtered tree still uses `getProjectTree` (context-preserving over
   * the already-bounded result).
   */
  async listRootIssues(
    projectId: string,
    params: { sort: IssueSort; take?: number; offset?: number },
    ctx: ServiceContext,
  ): Promise<TreeLevelDto> {
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    const { take, offset } = clampTreePage(params);
    const [rows, total] = await Promise.all([
      workItemRepository.findProjectTreeLevel(projectId, project.workspaceId, null, params.sort, {
        take,
        offset,
      }),
      workItemRepository.countProjectTreeLevel(projectId, project.workspaceId, null),
    ]);
    return buildTreeLevel(rows, take, total);
  },

  /**
   * One parent's DIRECT children for the LAZY tree (Subtask 2.5.13) — a sorted,
   * paged level (`parentId = <id>`), each child carrying `hasChildren`. The
   * parent is gated by workspace (finding #26): a missing or cross-workspace
   * `parentId` → `WorkItemNotFoundError` (never a leak), NOT an empty list.
   */
  async listChildIssues(
    parentId: string,
    params: { sort: IssueSort; take?: number; offset?: number },
    ctx: ServiceContext,
  ): Promise<TreeLevelDto> {
    const parent = await workItemRepository.findById(parentId);
    if (!parent || parent.workspaceId !== ctx.workspaceId) {
      throw new WorkItemNotFoundError(parentId);
    }
    const { take, offset } = clampTreePage(params);
    const [rows, total] = await Promise.all([
      workItemRepository.findProjectTreeLevel(
        parent.projectId,
        parent.workspaceId,
        parentId,
        params.sort,
        { take, offset },
      ),
      workItemRepository.countProjectTreeLevel(parent.projectId, parent.workspaceId, parentId),
    ]);
    return buildTreeLevel(rows, take, total);
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
   * reached a TERMINAL status (Subtask 2.2.6, resolving finding #21). "Terminal"
   * is per-project — a status whose `category = done` in ITS OWN project's
   * workflow (so `done` AND `cancelled` count out of the box, and an admin who
   * recategorizes a status changes readiness live). Blockers can span projects,
   * so each is classified against its own project's terminal set.
   *
   * Two queries total, no N+1: one for the blocker `(status, projectId)` rows,
   * one batched `getTerminalStatusKeysByProjects` for every blocker-project's
   * terminal set. A blocker is OPEN unless its status is in its project's set.
   *
   * Thin boolean projection of {@link getReadiness} — the single source of the
   * per-project terminal logic. Callers that only need the yes/no (the Epic-7
   * ready-set engine — finding #42) use this; callers that must NAME the open
   * blockers (the 2.4.5 banner) use `getReadiness`.
   */
  async isReady(workItemId: string, ctx: ServiceContext): Promise<boolean> {
    return (await this.getReadiness(workItemId, ctx)).ready;
  },

  /**
   * The full readiness verdict: not just WHETHER the item is ready, but WHICH
   * `is_blocked_by` blockers are still open (non-terminal). Same per-project
   * terminal classification as `isReady` (2.2.6 / finding #21) — a blocker is
   * resolved iff its status is in ITS OWN project's `category = done` set, so
   * `done` and `cancelled` both count and a live recategorization re-judges it.
   * Returns `openBlockerIds` (a Set, for an O(1) membership filter at the call
   * site) so the relationships surface can highlight exactly the open blockers
   * without re-running the classification. An item with no blockers → ready,
   * empty set. Two queries total, no N+1 (see `isReady`).
   */
  async getReadiness(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<{ ready: boolean; openBlockerIds: Set<string> }> {
    const blockers = await workItemLinkRepository.findBlockerStates(workItemId);
    if (blockers.length === 0) return { ready: true, openBlockerIds: new Set() };
    const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
      blockers.map((b) => b.projectId),
      ctx.workspaceId,
    );
    const openBlockerIds = new Set(
      blockers
        .filter((b) => !(terminalByProject.get(b.projectId)?.has(b.status) ?? false))
        .map((b) => b.id),
    );
    return { ready: openBlockerIds.size === 0, openBlockerIds };
  },

  /**
   * Fetch ONE work item by id, scoped to the caller's active workspace. Returns
   * the full DTO, or throws WorkItemNotFoundError when the row is absent OR
   * belongs to a DIFFERENT workspace — the 404-not-403 no-existence-leak
   * contract (a cross-tenant id is indistinguishable from a never-existed one).
   *
   * This is the explicit application-layer tenancy gate that the work_item RLS
   * policy (1.4.5) backstops structurally. It exists because the other read
   * methods (listWorkItems / getWorkItemSubtree / getBlockers …) trust RLS for
   * tenant scoping, but RLS is INERT on the dev/CI connection (the `prodect`
   * superuser has BYPASSRLS) — so an explicit `workspaceId` check is the
   * PRIMARY gate there. Route handlers also reuse this as a pre-flight guard
   * before a mutation (PATCH/DELETE/link), so a cross-tenant write 404s before
   * the unguarded mutation method runs.
   */
  async getWorkItem(id: string, ctx: ServiceContext): Promise<WorkItemDto> {
    const row = await workItemRepository.findById(id);
    if (!row || row.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(id);
    return toWorkItemDto(row);
  },

  /**
   * Resolve a work item by its human identifier (e.g. "PROD-7") within a
   * project — the read backing the edit route (Subtask 2.3.6), whose URL is
   * keyed by identifier. Cross-workspace (or missing) → WorkItemNotFoundError so
   * the route renders 404 without leaking another tenant's existence.
   */
  async getWorkItemByIdentifier(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    const row = await workItemRepository.findByIdentifier(projectId, identifier);
    if (!row || row.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(identifier);
    return toWorkItemDto(row);
  },

  /**
   * The aggregate read backing the issue DETAIL page (Subtask 2.4.1, grown by
   * 2.4.5): one service call assembling the item + its immediate parent +
   * direct children + ALL of its relationship links (resolved to summaries,
   * grouped by kind) + a readiness verdict + the project's workflow. Tenant gate
   * FIRST (cross-workspace / missing identifier → WorkItemNotFoundError → 404,
   * no existence leak), then the rest fans out in parallel.
   *
   * Link groups: `blockedBy` = items this item `is_blocked_by` (its OUT edges of
   * that kind); `blocks` = items blocked by it (the IN edges); `relatesTo` /
   * `duplicates` / `clones` = its OUT edges of those kinds (`relates_to` persists
   * a reciprocal row, so its OUT set already covers both directions). Each group
   * is `key ASC`-ordered. `readiness` is the 2.4.5 ready/blocked verdict —
   * `getReadiness` classifies each blocker against ITS OWN project's terminal set
   * (2.2.6 / finding #21), and `openBlockers` re-projects the open ids back onto
   * the resolved `blockedBy` summaries so the banner can name them without a
   * second pass. Link targets can be cross-project; they're resolved by id and
   * rendered read-only here (link MANAGEMENT is a later surface — Epic 5).
   */
  async getIssueDetail(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
  ): Promise<IssueDetailDto> {
    const item = await workItemRepository.findByIdentifier(projectId, identifier);
    if (!item || item.workspaceId !== ctx.workspaceId) {
      throw new WorkItemNotFoundError(identifier);
    }

    const [
      ancestorRows,
      childRows,
      blockedByLinks,
      blocksLinks,
      relatesLinks,
      duplicatesLinks,
      clonesLinks,
      workflow,
    ] = await Promise.all([
      // The breadcrumb chain (root→self, item excluded) — one CTE, workspace-
      // scoped. The immediate parent is `ancestors`' last element; we surface it
      // separately too so the 2.4.2 rail's Parent field need not re-derive it.
      workItemRepository.findAncestors(item.id, ctx.workspaceId),
      workItemRepository.findChildren(item.id),
      workItemLinkRepository.findByFromItem(item.id, 'is_blocked_by'),
      workItemLinkRepository.findByToItem(item.id, 'is_blocked_by'),
      workItemLinkRepository.findByFromItem(item.id, 'relates_to'),
      workItemLinkRepository.findByFromItem(item.id, 'duplicates'),
      workItemLinkRepository.findByFromItem(item.id, 'clones'),
      workflowsService.getWorkflow(projectId, ctx.workspaceId),
    ]);

    const [blockerRows, blockingRows, relatesRows, duplicatesRows, clonesRows, readiness] =
      await Promise.all([
        workItemRepository.findByIds(blockedByLinks.map((l) => l.toId)),
        workItemRepository.findByIds(blocksLinks.map((l) => l.fromId)),
        workItemRepository.findByIds(relatesLinks.map((l) => l.toId)),
        workItemRepository.findByIds(duplicatesLinks.map((l) => l.toId)),
        workItemRepository.findByIds(clonesLinks.map((l) => l.toId)),
        this.getReadiness(item.id, ctx),
      ]);

    const ancestors = ancestorRows.map(toWorkItemSummaryDto);
    const blockedBy = toRelationshipLinks(blockedByLinks, blockerRows, 'toId');
    const openBlockers = blockedBy
      .filter((l) => readiness.openBlockerIds.has(l.item.id))
      .map((l) => l.item);

    return {
      item: toWorkItemDto(item),
      ancestors,
      parent: ancestors.at(-1) ?? null,
      children: childRows.map(toWorkItemSummaryDto),
      blockedBy,
      blocks: toRelationshipLinks(blocksLinks, blockingRows, 'fromId'),
      relatesTo: toRelationshipLinks(relatesLinks, relatesRows, 'toId'),
      duplicates: toRelationshipLinks(duplicatesLinks, duplicatesRows, 'toId'),
      clones: toRelationshipLinks(clonesLinks, clonesRows, 'toId'),
      readiness: { ready: readiness.ready, openBlockers },
      workflow,
    };
  },

  /**
   * Candidate PARENTS for a new/edited issue of `childType` in a project: every
   * non-archived work item whose kind may legally hold a `childType`, by the
   * inverted kind-parent matrix (`allowedParentKinds` — the single source of
   * truth from 2.1.2, derived not re-encoded). The parent picker (Subtask
   * 2.3.4) renders exactly this set, so an illegal (parent, child) pair is never
   * CONSTRUCTIBLE in the UI; `createWorkItem`/`updateWorkItem` + the DB trigger
   * stay the backstops for a forged payload. Returns [] for a childType with no
   * legal parent (`epic`) or an empty project. Explicit `workspaceId` gate per
   * finding #26 (the primary tenant filter — RLS is inert under the dev/CI
   * superuser).
   */
  async listCandidateParents(
    projectId: string,
    childType: IssueType,
    workspaceId: string,
  ): Promise<WorkItemSummaryDto[]> {
    const kinds = allowedParentKinds(childType);
    const rows = await workItemRepository.findByProjectAndKinds(projectId, kinds, workspaceId);
    return rows.map(toWorkItemSummaryDto);
  },

  /**
   * The revision history of one work item (newest-first), scoped to the
   * caller's active workspace: the work item must belong to the active
   * workspace, or we throw WorkItemNotFoundError — so a cross-tenant probe of
   * another workspace's revision feed yields 404, never the diffs. Maps each
   * row to a WorkItemRevisionDto at the read boundary.
   */
  async listRevisions(workItemId: string, ctx: ServiceContext): Promise<WorkItemRevisionDto[]> {
    const row = await workItemRepository.findById(workItemId);
    if (!row || row.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(workItemId);
    const revisions = await workItemRevisionRepository.listByWorkItem(workItemId);
    return revisions.map(toWorkItemRevisionDto);
  },

  /**
   * Fetch ONE link by id, scoped to the caller's active workspace. Returns the
   * DTO, or throws WorkItemLinkNotFoundError when absent OR in a different
   * workspace (404 no-existence-leak). Routes use this as the cross-tenant
   * guard before unlinkWorkItems — a member of W1 can't delete a link in W2.
   */
  async getLink(linkId: string, ctx: ServiceContext): Promise<WorkItemLinkDto> {
    const link = await workItemLinkRepository.findById(linkId);
    if (!link || link.workspaceId !== ctx.workspaceId) throw new WorkItemLinkNotFoundError(linkId);
    return toWorkItemLinkDto(link);
  },

  /**
   * Candidate targets for the link picker (Subtask 2.4.9): non-archived items in
   * the caller's WORKSPACE (cross-project — the link model allows it), excluding
   * the current item itself AND any already linked to it by the chosen
   * relationship (direction-aware, so the picker won't offer a duplicate; the
   * trigger still backstops a forged one). Tenant-gated on the current item
   * (cross-workspace / missing → 404). Bounded to LINK_CANDIDATE_LIMIT; the
   * picker's Combobox filters by identifier/title client-side (full server
   * search is Epic 6).
   */
  /**
   * Candidate target issues for the CREATE-modal link picker (Subtask 2.4.10).
   * Like {@link listLinkCandidates} but there is no current item yet (the issue
   * isn't created), so there's nothing to exclude server-side beyond tenancy:
   * every non-archived item in the caller's WORKSPACE (cross-project — the link
   * model allows it). The modal excludes already-pending targets client-side
   * (direction-aware, per chosen relationship) and the Combobox filters by
   * identifier/title. Bounded to LINK_CANDIDATE_LIMIT; explicit `workspaceId`
   * gate (finding #26 — the primary tenant filter, RLS is defense-in-depth).
   */
  async listCreateLinkCandidates(ctx: ServiceContext): Promise<WorkItemSummaryDto[]> {
    const rows = await workItemRepository.findLinkCandidates(
      ctx.workspaceId,
      [],
      LINK_CANDIDATE_LIMIT,
    );
    return rows.map(toWorkItemSummaryDto);
  },

  async listLinkCandidates(
    currentItemId: string,
    relationship: RelationshipKind,
    ctx: ServiceContext,
  ): Promise<WorkItemSummaryDto[]> {
    const item = await workItemRepository.findById(currentItemId);
    if (!item || item.workspaceId !== ctx.workspaceId) {
      throw new WorkItemNotFoundError(currentItemId);
    }

    const linkedIds =
      relationship === 'blocks'
        ? (await workItemLinkRepository.findByToItem(currentItemId, 'is_blocked_by')).map(
            (l) => l.fromId,
          )
        : (
            await workItemLinkRepository.findByFromItem(
              currentItemId,
              relationship === 'blocked_by' ? 'is_blocked_by' : relationship,
            )
          ).map((l) => l.toId);

    const rows = await workItemRepository.findLinkCandidates(
      ctx.workspaceId,
      [currentItemId, ...linkedIds],
      LINK_CANDIDATE_LIMIT,
    );
    return rows.map(toWorkItemSummaryDto);
  },
};

/** Upper bound on the link-picker candidate list (the Combobox filters it). */
const LINK_CANDIDATE_LIMIT = 50;
