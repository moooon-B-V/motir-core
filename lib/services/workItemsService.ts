import { Prisma, type WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { assertValidParent, allowedParentKinds, type IssueType } from '@/lib/issues/parentRules';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { labelRepository } from '@/lib/repositories/labelRepository';
import { componentRepository } from '@/lib/repositories/componentRepository';
import { workItemComponentRepository } from '@/lib/repositories/workItemComponentRepository';
import { customFieldDefinitionRepository } from '@/lib/repositories/customFieldDefinitionRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { parseMentionIds } from '@/lib/mentions/parse';
import { attachmentsService } from '@/lib/services/attachmentsService';
import { extractReferencedBlobUrlsFromBodies } from '@/lib/blob/referencedUrls';
import { sendEvent } from '@/lib/jobs/sendEvent';
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
import { ComponentNotFoundError, CrossProjectComponentError } from '@/lib/components/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { CrossProjectSprintAssignmentError, SprintNotFoundError } from '@/lib/sprints/errors';
import { projectAccessService } from '@/lib/services/projectAccessService';
import {
  toWorkItemDto,
  toWorkItemSummaryDto,
  toWorkItemSubtreeDto,
  toWorkItemTreeNodeDto,
  toWorkItemListItemDto,
  toWorkItemTreeRowDto,
} from '@/lib/mappers/workItemMappers';
import { toWorkItemLinkDto } from '@/lib/mappers/workItemLinkMappers';
import { toLabelDto } from '@/lib/mappers/labelMappers';
import { toComponentDto } from '@/lib/mappers/componentMappers';
import { toCustomFieldWithValueDto } from '@/lib/mappers/customFieldValueMappers';
import { toWorkItemRevisionDto } from '@/lib/mappers/workItemRevisionMappers';
import type {
  WorkItemForestRow,
  WorkItemTreeRow,
  RepoIssueFilter,
  ReadyCandidateRow,
} from '@/lib/repositories/workItemRepository';
import { ISSUE_LIST_PAGE_SIZE } from '@/lib/issues/issueListView';
import type { IssueSort } from '@/lib/issues/issueListView';
import type { ReadyItemDto, ReadyItemDispatchDto } from '@/lib/dto/ready';
import {
  toReadyItemDto,
  toReadyItemDispatchDto,
  type ReadyItemContext,
  type ReadyDispatchContext,
} from '@/lib/mappers/readyMappers';
import {
  type ReadyListFilter,
  clampReadyLimit,
  decodeReadyCursor,
  encodeReadyCursor,
  READY_COUNT_CAP,
  READY_COUNT_MAX_PAGES,
  READY_MAX_LIMIT,
} from '@/lib/workItems/readyFilter';
import { extractContextRefs } from '@/lib/markdown/contextRefs';
import type {
  CreateWorkItemInput,
  IssueDetailDto,
  ProjectTreeFilter,
  RelationshipLinkDto,
  UpdateWorkItemInput,
  WorkItemDto,
  WorkItemKindDto,
  PagedIssueListDto,
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
  // sprintId is null for a backlog create (the `set` helper skips nulls, so the
  // diff is unchanged from pre-4.2.2 for the common case); it is captured only
  // when the issue is born directly in a sprint (Subtask 4.2.2 create-into-
  // sprint), so the created revision records that assignment.
  set('sprintId', row.sprintId);
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

/**
 * The user ids a DESCRIPTION may validly mention — the members who can VIEW
 * the issue, exactly the commentsService scoping (the 6.4
 * `assignableMembersService` read, reused not duplicated). Reference data:
 * resolved OUTSIDE the write transaction (the member service binds its own
 * workspace context). Description mentions are notification-only (Subtask
 * 5.1.6) — no stored mention rows; the validated ids ride the post-commit
 * `work-item/mentioned` event and that's the whole substrate (recorded scope
 * line: the queryable substrate stays comment-scoped until a use case earns
 * more).
 */
async function resolveDescriptionMentionable(
  projectId: string,
  accessLevel: 'open' | 'limited' | 'private',
  ctx: ServiceContext,
): Promise<Set<string>> {
  const members = await assignableMembersService.list({ projectId, accessLevel, ctx });
  return new Set(members.map((m) => m.userId));
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

    // Workspace gate first (the project gate sits BENEATH it): the reporter
    // (the actor) must be a workspace member at all.
    await assertReporterMember(ctx.userId, workspaceId);

    // Project access gate (6.4.3): the actor must be allowed to EDIT this
    // project (open → any workspace member; limited/private → a member/admin
    // project member; workspace owner/admin always pass). Runs before the
    // key-allocation transaction — a denied create never burns a work-item key.
    await projectAccessService.assertCanEdit(input.projectId, ctx);

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

    // Sprint pre-flight (Subtask 4.2.2 — create-into-sprint): when the caller
    // targets a sprint, it must exist in this workspace and belong to the SAME
    // project as the new issue — the same-project guard
    // `backlogService.assignToSprint` enforces, pulled to create time so a
    // quick-create into a sprint container is atomic (the issue is born already
    // assigned, in the one create transaction, never created-then-orphaned by a
    // failed follow-up assign). A foreign/unknown sprint → 404; a cross-project
    // sprint → 422. Checked before the key-allocation transaction so a denied
    // create never burns a work-item key.
    if (input.sprintId != null) {
      const sprint = await sprintRepository.findById(input.sprintId, workspaceId);
      if (!sprint) throw new SprintNotFoundError(input.sprintId);
      if (sprint.projectId !== input.projectId) {
        throw new CrossProjectSprintAssignmentError('new', input.sprintId);
      }
    }

    // Component pre-flight (Subtask 5.4.3 — the create modal's Components
    // picker): every id must resolve to a component of the SAME project — an
    // unknown / cross-workspace id reads as 404 (no existence leak), a
    // same-workspace component from another project is the typed 422.
    // Checked before the key-allocation transaction (the sprint rule); the
    // join rows are written inside it.
    const componentIds = [...new Set(input.componentIds ?? [])];
    if (componentIds.length > 0) {
      const components = await componentRepository.findByIds(componentIds);
      const componentsById = new Map(components.map((c) => [c.id, c]));
      for (const id of componentIds) {
        const component = componentsById.get(id);
        if (!component || component.workspaceId !== workspaceId) {
          throw new ComponentNotFoundError(id);
        }
        if (component.projectId !== input.projectId) throw new CrossProjectComponentError(id);
      }
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

    // Description mentions (Subtask 5.1.6): parse + view-validate BEFORE the
    // transaction (reference data, the commentsService pattern); invalid /
    // non-viewable ids are silently dropped (the Jira rule). The validated set
    // rides the post-commit `work-item/mentioned` event.
    const descTokenIds = parseMentionIds(input.descriptionMd ?? '');
    let descMentionIds: string[] = [];
    if (descTokenIds.length > 0) {
      const mentionable = await resolveDescriptionMentionable(
        input.projectId,
        project.accessLevel,
        ctx,
      );
      descMentionIds = descTokenIds.filter((id) => mentionable.has(id));
    }

    const { dto, revisionId } = await db.$transaction(async (tx) => {
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

      // Global backlog rank (Subtask 4.1.4): a new issue is appended after the
      // current last rank of its STARTING scope, so the 4.1.1 backfill stays
      // total going forward and a fresh issue is never rank-less when the 4.2
      // backlog binds to it. SEPARATE ordering from `position` (which orders the
      // issue TREE under its parent) — this is the one global "Rank" the backlog
      // and a sprint share. The scope is the target sprint when creating
      // into one (Subtask 4.2.2), else the backlog (`sprintId IS NULL`); either
      // way a bounded boundary read, never a full scan.
      const targetSprintId = input.sprintId ?? null;
      const lastBacklogRank = await workItemRepository.findBoundaryBacklogRank(
        input.projectId,
        workspaceId,
        targetSprintId,
        'max',
        tx,
      );
      const backlogRank = keyForAppend(lastBacklogRank);

      // The at-create default-assignee rule (Subtask 5.4.3, the verified
      // Jira behaviour): an issue created with components and NO assignee
      // takes the default assignee of its FIRST-ALPHABETICAL component (by
      // nameLower) that has one — resolved inside the create transaction,
      // create-time only (later component changes never touch the
      // assignee). The default was validated assignable when the component
      // was configured; a deleted user is SetNull'd away. The one residual
      // gap — a default whose user has since LEFT the workspace — is
      // skipped silently (the SetNull intent: a departure never blocks a
      // create), keeping the assignee-membership invariant intact.
      let assigneeId = input.assigneeId ?? null;
      if (assigneeId === null && componentIds.length > 0) {
        const defaulted = await componentRepository.findFirstDefaultAssignee(componentIds, tx);
        if (defaulted?.defaultAssigneeId != null) {
          const stillMember = await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
            defaulted.defaultAssigneeId,
            workspaceId,
            tx,
          );
          if (stillMember) assigneeId = defaulted.defaultAssigneeId;
        }
      }

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
        assigneeId,
        reporterId: ctx.userId,
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        estimateMinutes: input.estimateMinutes ?? null,
        sprintId: targetSprintId,
        position,
        backlogRank,
      };

      const row = await workItemRepository.create(data, tx);

      // Initial revision: the created-row state as a { from: null, to: value }
      // diff (1.4.6 finalized the shape 1.4.4 deferred — see buildCreatedDiff).
      // Its id is the idempotency scope of any description-mention event below.
      const revisionId = await workItemRevisionsService.recordRevision(
        {
          workItemId: row.id,
          changedById: ctx.userId,
          changeKind: 'created',
          diff: buildCreatedDiff(row),
        },
        tx,
      );

      // Link-on-write (Subtask 5.2.3): editor uploads referenced by the
      // birth bodies link to the new issue in the SAME transaction (they were
      // written unlinked — the upload happened before the issue existed; a
      // cancelled modal leaves them unlinked for the 5.2.7 GC). No separate
      // revision: like the create-modal links above, attachments arriving
      // with the issue are part of creation, not a later edit — the
      // 'created' anchor is the History record.
      // Components picked in the create modal (Subtask 5.4.3), written in
      // the SAME transaction as the item (pre-validated same-project above —
      // issue + components commit or roll back together, the links rule).
      // Like links and birth attachments, they're part of creation, not a
      // later edit — no separate `{ components }` revision; the 'created'
      // anchor is the History record, and the defaulted assignee (if any)
      // rides the created-row diff.
      if (componentIds.length > 0) {
        await workItemComponentRepository.createMany(
          componentIds.map((componentId) => ({ workItemId: row.id, componentId })),
          tx,
        );
      }

      const birthUrls = extractReferencedBlobUrlsFromBodies(
        [row.descriptionMd, row.explanationMd],
        workspaceId,
      );
      if (birthUrls.length > 0) {
        await attachmentsService.syncEditorLinks(
          { workItem: row, previousUrls: [], nextUrls: birthUrls },
          tx,
        );
      }

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

      return { dto: toWorkItemDto(row), revisionId };
    });

    // Post-commit, never inside the tx — a rollback must not have notified
    // (the commentsService rule). Only fires when the description validly
    // mentioned someone; the mentionNotify job skips the author + re-validates
    // view access at send time.
    if (descMentionIds.length > 0) {
      await sendEvent('work-item/mentioned', {
        workspaceId,
        workItemId: dto.id,
        revisionId,
        authorId: ctx.userId,
        mentionedUserIds: descMentionIds,
      });
    }

    return dto;
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
      // Even the empty-patch no-op is an edit entry point — gate it (6.4.3) so a
      // read-only actor can't probe an item through a write route.
      await projectAccessService.assertCanEdit(current.projectId, ctx);
      return toWorkItemDto(current);
    }

    // Description mentions (Subtask 5.1.6): when the patch carries a body with
    // mention tokens, resolve the viewable-member set BEFORE the transaction
    // (reference data, the commentsService pattern). The added-mention DIFF is
    // computed INSIDE the tx against the locked current row — only ids the
    // previous body didn't already mention notify (the Jira edit rule).
    const patchDescTokenIds =
      typeof patch.descriptionMd === 'string' ? parseMentionIds(patch.descriptionMd) : [];
    let descMentionable: Set<string> | null = null;
    if (patchDescTokenIds.length > 0) {
      const pre = await workItemRepository.findById(id);
      if (pre) {
        const project = await projectRepository.findById(pre.projectId);
        if (project) {
          descMentionable = await resolveDescriptionMentionable(
            project.id,
            project.accessLevel,
            ctx,
          );
        }
      }
    }

    const result = await db.$transaction(async (tx) => {
      const locked = await workItemRepository.lockById(id, tx);
      if (!locked) throw new WorkItemNotFoundError(id);
      const current = await workItemRepository.findById(id, tx);
      if (!current) throw new WorkItemNotFoundError(id);

      // Project access gate (6.4.3): the actor must be allowed to edit this
      // item's project. Inside the tx so the gate reads share the lock's
      // snapshot + the RLS workspace context.
      await projectAccessService.assertCanEdit(current.projectId, ctx, tx);

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
      let addedDescMentionIds: string[] = [];
      if (patch.descriptionMd !== undefined && patch.descriptionMd !== current.descriptionMd) {
        update.descriptionMd = patch.descriptionMd;
        diff.descriptionMd = { from: current.descriptionMd, to: patch.descriptionMd };
        if (patchDescTokenIds.length > 0 && descMentionable !== null) {
          const mentionable = descMentionable;
          const prevIds = new Set(parseMentionIds(current.descriptionMd ?? ''));
          addedDescMentionIds = patchDescTokenIds.filter(
            (tokenId) => !prevIds.has(tokenId) && mentionable.has(tokenId),
          );
        }
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
        return { dto: toWorkItemDto(current), revisionId: null, addedDescMentionIds: [] };
      }

      const row = await workItemRepository.update(id, update, tx);

      // Link-on-write (Subtask 5.2.3): a body edit re-resolves the
      // embeds-are-attachments linkage — newly-referenced editor uploads
      // link, de-referenced editor-sourced rows unlink (panel rows and rows
      // on other issues are never touched; a URL still referenced by the
      // other body or a comment stays linked). The diff rides the SAME
      // 'updated' revision as the body edit — one write, one History entry,
      // the uniform trail that fills Jira's documented editor-add changelog
      // gap. Runs against the POST-write row so the still-referenced guard
      // sees what this transaction commits. An unchanged body never reaches
      // here (the field-diff gate above), so a no-op re-save stays a no-op.
      const bodyChanged =
        diff['descriptionMd'] !== undefined || diff['explanationMd'] !== undefined;
      const attachmentsCell = bodyChanged
        ? await attachmentsService.syncEditorLinks(
            {
              workItem: row,
              previousUrls: extractReferencedBlobUrlsFromBodies(
                [current.descriptionMd, current.explanationMd],
                current.workspaceId,
              ),
              nextUrls: extractReferencedBlobUrlsFromBodies(
                [row.descriptionMd, row.explanationMd],
                current.workspaceId,
              ),
            },
            tx,
          )
        : null;
      const revisionDiff: Record<string, unknown> = diff;
      if (attachmentsCell) revisionDiff['attachments'] = attachmentsCell;

      const revisionId = await workItemRevisionsService.recordRevision(
        { workItemId: id, changedById: ctx.userId, changeKind: 'updated', diff: revisionDiff },
        tx,
      );
      return { dto: toWorkItemDto(row), revisionId, addedDescMentionIds };
    });

    // Post-commit description-mention event (5.1.6) — same shape and rules as
    // the create path: only newly-added, view-validated ids; never inside the
    // tx; the job skips the author + re-validates view access at send time.
    if (result.revisionId !== null && result.addedDescMentionIds.length > 0) {
      await sendEvent('work-item/mentioned', {
        workspaceId: ctx.workspaceId,
        workItemId: result.dto.id,
        revisionId: result.revisionId,
        authorId: ctx.userId,
        mentionedUserIds: result.addedDescMentionIds,
      });
    }

    return result.dto;
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
    return db.$transaction((tx) =>
      workItemsService.applyStatusTransition(workItemId, toStatusKey, ctx, tx),
    );
  },

  /**
   * The transactional CORE of updateStatus — the lock → tenant-gate → no-op →
   * unknown-status → legal-transition → write-status + revision sequence,
   * factored out of `updateStatus` so it can run INSIDE a caller-supplied
   * transaction. `updateStatus` wraps it in its own `db.$transaction`; the
   * board move path (Subtask 3.1.5, `boardsService.moveCard`) calls it within
   * ITS transaction so the cross-column status change and the board rank write
   * commit atomically — one transaction, never a nested `db.$transaction`
   * (which would open a second connection and deadlock against the row this
   * method `FOR UPDATE`-locks). Either caller runs the SAME validated path; the
   * transition validation is defined once here, never re-implemented at the
   * board layer. `tx` is REQUIRED — this method never opens a transaction.
   */
  async applyStatusTransition(
    workItemId: string,
    toStatusKey: string,
    ctx: ServiceContext,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemDto> {
    const locked = await workItemRepository.lockById(workItemId, tx);
    if (!locked) throw new WorkItemNotFoundError(workItemId);
    const current = await workItemRepository.findById(workItemId, tx);
    // Tenant gate FIRST: a cross-workspace id is indistinguishable from a
    // never-existed one (404), and must not leak via a status error.
    if (!current || current.workspaceId !== ctx.workspaceId) {
      throw new WorkItemNotFoundError(workItemId);
    }

    // Project access gate (6.4.3): a status move is an edit. Gated here (not just
    // in updateStatus) so the board move path — boardsService.moveCard, which
    // calls this inside ITS transaction for a cross-column move — is covered by
    // the same check. `tx` is the caller's, so the gate shares the snapshot.
    await projectAccessService.assertCanEdit(current.projectId, ctx, tx);

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
      // Resolve + tenant-gate first so the access gate (6.4.3) has the item's
      // project, and a cross-workspace id is a 404 (no existence leak) before
      // the archive write.
      const current = await workItemRepository.findById(id, tx);
      if (!current || current.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(id);
      await projectAccessService.assertCanEdit(current.projectId, ctx, tx);

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

      // Project access gate (6.4.3): re-parent / reorder is an edit.
      await projectAccessService.assertCanEdit(current.projectId, ctx, tx);

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
    ctx: ServiceContext,
  ): Promise<WorkItemSummaryDto[]> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
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
    await projectAccessService.assertCanBrowse(projectId, ctx);

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
    params: { sort: IssueSort; filter?: ProjectTreeFilter; page?: number },
    ctx: ServiceContext,
  ): Promise<PagedIssueListDto> {
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    await projectAccessService.assertCanBrowse(projectId, ctx);

    const repoFilter = buildRepoFilter(params.filter ?? {});
    const pageSize = ISSUE_LIST_PAGE_SIZE;

    // Count the filtered set first so an out-of-range ?page CLAMPS to the last
    // page (the 2.5.10 edge spec) instead of fetching an empty offset window.
    // The count is the pager's denominator and tracks the active filter.
    const total = await workItemRepository.countProjectIssues(
      projectId,
      project.workspaceId,
      repoFilter,
    );
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, params.page ?? 1), totalPages);
    const offset = (page - 1) * pageSize;

    const rows = await workItemRepository.findProjectIssuesFlat(
      projectId,
      project.workspaceId,
      params.sort,
      repoFilter,
      { limit: pageSize, offset },
    );

    return { items: rows.map(toWorkItemListItemDto), total, page, pageSize };
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
    await projectAccessService.assertCanBrowse(projectId, ctx);
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
    await projectAccessService.assertCanBrowse(parent.projectId, ctx);
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

      // Project access gate (6.4.3): a link is an edit of the FROM item (the
      // side that owns the revision). The TO item can be cross-project; the
      // editor only needs edit rights on the item they're linking FROM.
      await projectAccessService.assertCanEdit(fromItem.projectId, ctx, tx);

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

      // Project access gate (6.4.3): removing a link is an edit of the FROM item.
      const fromItem = await workItemRepository.findById(link.fromId, tx);
      if (!fromItem || fromItem.workspaceId !== ctx.workspaceId) {
        throw new WorkItemLinkNotFoundError(linkId);
      }
      await projectAccessService.assertCanEdit(fromItem.projectId, ctx, tx);

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
   * Batch readiness (finding #21) for MANY items at once — the board projection
   * (3.1.4) needs a `ready` flag per card without a per-card N+1. Returns a Map
   * keyed by EVERY requested id (an item with no blocker, or only terminal
   * blockers, is ready). Mirrors `getReadiness`'s per-project terminal
   * classification, but over ONE batched blocker read + ONE batched terminal-set
   * read — the same shape `getReadiness` uses, scaled to a set.
   */
  async getReadinessForItems(
    itemIds: string[],
    ctx: ServiceContext,
  ): Promise<Map<string, boolean>> {
    const ready = new Map<string, boolean>(itemIds.map((id) => [id, true]));
    if (itemIds.length === 0) return ready;
    const blockers = await workItemLinkRepository.findBlockerStatesForItems(itemIds);
    if (blockers.length === 0) return ready;
    const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
      blockers.map((b) => b.projectId),
      ctx.workspaceId,
    );
    for (const b of blockers) {
      const isTerminal = terminalByProject.get(b.projectId)?.has(b.status) ?? false;
      if (!isTerminal) ready.set(b.fromId, false);
    }
    return ready;
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
    await projectAccessService.assertCanBrowse(row.projectId, ctx);
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
    await projectAccessService.assertCanBrowse(row.projectId, ctx);
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
    await projectAccessService.assertCanBrowse(item.projectId, ctx);

    const [
      ancestorRows,
      childRows,
      blockedByLinks,
      blocksLinks,
      relatesLinks,
      duplicatesLinks,
      clonesLinks,
      workflow,
      labelRows,
      componentRows,
      customFieldRows,
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
      // The issue's labels (5.4.2) — one bounded query riding the same
      // fan-out (no extra round-trip; capped per-issue by labelsService).
      labelRepository.listByWorkItem(item.id),
      // The issue's components (5.4.3) — the same bounded-slot shape as
      // labels: one query riding the fan-out, name-ordered, bounded by the
      // admin-curated taxonomy.
      componentRepository.listByWorkItem(item.id),
      // The project's custom-field definitions + THIS issue's values (5.3.3)
      // — ONE bounded query (≤50 defs by the project cap, ≤1 value row per
      // def by the pair unique), options + value relations resolved in the
      // same operation. No N+1, no second round-trip.
      customFieldDefinitionRepository.listWithValuesForWorkItem(
        item.projectId,
        ctx.workspaceId,
        item.id,
      ),
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
      labels: labelRows.map(toLabelDto),
      components: componentRows.map(toComponentDto),
      customFields: customFieldRows.map(toCustomFieldWithValueDto),
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

  /**
   * The READY SET of a project (Subtask 7.0.2) — the AI dispatch surface's list
   * read, cursor-paginated, returning the 7.0.3 `ReadyItemDto`s. A work item is
   * "ready" when (a) its own status is in the `todo` category (not-yet-started —
   * a ready item is one to START, so `in_progress` and `done` are both excluded)
   * AND (b) every one of its `is_blocked_by` blockers is terminal in ITS OWN
   * project (the 2.4.5 / finding #21 predicate, via the batched
   * `getReadinessForItems` — no N+1).
   *
   * Tenant gate first (cross-workspace / missing project → `ProjectNotFoundError`
   * → 404, no existence leak). Then ONE candidate read narrows by the cheap SQL
   * facets (kind / assignee / priority / todo-status) under the
   * `(type asc, priority desc, key asc)` sort + the cursor seek-after, fetching `limit + 1`
   * to detect a next page; readiness is applied over that bounded window. **A page
   * may be SHORTER than `limit`** when blocked candidates fall inside the window —
   * the cursor still advances past the whole window, so the agent walks the FULL
   * set deterministically across pages. A malformed cursor throws
   * `InvalidReadyCursorError` (→ 400); a valid cursor past the tail returns `[]`.
   */
  async listReady(
    projectId: string,
    filter: ReadyListFilter,
    ctx: ServiceContext,
  ): Promise<{ items: ReadyItemDto[]; nextCursor: string | null }> {
    const { rows, nextCursor } = await pageReadyCandidates(projectId, filter, ctx);
    return { items: rows.map((r) => toReadyItemDto(r, rowReadyContext(r))), nextCursor };
  },

  /**
   * Dispatch ONE ready item (Subtask 7.0.2) — the BYOK `prodect run` /
   * coding-agent consumer of `POST /api/ready/next`. Returns the FIRST ready
   * item under the `(type asc, priority desc, key asc)` sort that is NOT in `excludeIds`,
   * as the full `ReadyItemDispatchDto` (body + parsed context refs + resolved
   * blocker keys + parent key + run command), or `null` when the filtered ready
   * set is exhausted.
   *
   * It walks `listReady`'s candidate pages (SAME predicate + sort — the page and
   * the agent can never disagree) until it finds a non-excluded item or runs out
   * of cursor. In practice `excludeIds` is small and the top of the first page
   * answers. Read-only: no claim row, no audit (those land with stub 7.6).
   */
  async getNextReady(
    projectId: string,
    filter: Omit<ReadyListFilter, 'limit' | 'cursor'> & { excludeIds?: string[] },
    ctx: ServiceContext,
  ): Promise<ReadyItemDispatchDto | null> {
    const exclude = new Set(filter.excludeIds ?? []);
    let cursor: string | undefined;
    // Bounded by the finite candidate set — the cursor advances every iteration
    // and `pageReadyCandidates` returns `nextCursor: null` at the tail.
    for (;;) {
      const { rows, nextCursor }: { rows: ReadyCandidateRow[]; nextCursor: string | null } =
        await pageReadyCandidates(
          projectId,
          {
            kinds: filter.kinds,
            assigneeId: filter.assigneeId,
            priority: filter.priority,
            cursor,
          },
          ctx,
        );
      const chosen = rows.find((r) => !exclude.has(r.id));
      if (chosen) return buildReadyDispatchDto(chosen);
      if (!nextCursor) return null;
      cursor = nextCursor;
    }
  },

  /**
   * The READY COUNT for the sidebar badge (Subtask 7.0.6) — how many work items
   * are currently ready to start in the project, under the SAME predicate
   * `listReady` uses (so the badge can never disagree with the /ready page).
   * Reuses the `pageReadyCandidates` machinery: walk candidate pages, sum the
   * ready rows. Tenant-gated by `pageReadyCandidates` (cross-workspace project →
   * `ProjectNotFoundError`).
   *
   * Bounded by design (see `READY_COUNT_CAP` / `READY_COUNT_MAX_PAGES`): the
   * badge renders on every authed route and readiness is a computed predicate,
   * so the scan stops at the cap (badge shows "{cap}+") and after a fixed number
   * of candidate pages. `hasMore` makes either short-circuit visible — never a
   * silent truncation (finding #57: don't ship a "load all rows" read; here the
   * count is the only thing that must examine the set, and it's bounded).
   */
  async countReady(
    projectId: string,
    filter: Omit<ReadyListFilter, 'limit' | 'cursor'>,
    ctx: ServiceContext,
  ): Promise<{ count: number; hasMore: boolean }> {
    let count = 0;
    let cursor: string | undefined;
    for (let page = 0; page < READY_COUNT_MAX_PAGES; page++) {
      const { rows, nextCursor }: { rows: ReadyCandidateRow[]; nextCursor: string | null } =
        await pageReadyCandidates(
          projectId,
          {
            kinds: filter.kinds,
            assigneeId: filter.assigneeId,
            priority: filter.priority,
            cursor,
            limit: READY_MAX_LIMIT,
          },
          ctx,
        );
      count += rows.length;
      if (count >= READY_COUNT_CAP) return { count: READY_COUNT_CAP, hasMore: true };
      if (!nextCursor) return { count, hasMore: false };
      cursor = nextCursor;
    }
    return { count, hasMore: true };
  },
};

/** Upper bound on the link-picker candidate list (the Combobox filters it). */
const LINK_CANDIDATE_LIMIT = 50;

/**
 * Fetch ONE cursor-paginated window of READY candidate rows (Subtask 7.0.2) —
 * the shared core of `listReady` (which maps the rows to list DTOs) and
 * `getNextReady` (which needs the raw rows to build the dispatch DTO). Tenant-
 * gates the project, fetches `limit + 1` candidates under the deterministic
 * sort + cursor seek-after, then readiness-filters the bounded window via the
 * batched `getReadinessForItems` (no N+1). `nextCursor` encodes the window's
 * LAST candidate (ready or not), so paging advances past the whole window and a
 * short ready page never strands the rest of the set.
 */
async function pageReadyCandidates(
  projectId: string,
  filter: ReadyListFilter,
  ctx: ServiceContext,
): Promise<{ rows: ReadyCandidateRow[]; nextCursor: string | null }> {
  const project = await projectRepository.findById(projectId);
  if (!project || project.workspaceId !== ctx.workspaceId) {
    throw new ProjectNotFoundError(projectId);
  }
  const limit = clampReadyLimit(filter.limit);
  const cursor = filter.cursor ? decodeReadyCursor(filter.cursor) : undefined;

  const candidates = await workItemRepository.findReadyCandidates(projectId, project.workspaceId, {
    kinds: filter.kinds,
    assigneeId: filter.assigneeId,
    priority: filter.priority,
    cursor,
    limit: limit + 1,
  });

  const hasMore = candidates.length > limit;
  const windowRows = hasMore ? candidates.slice(0, limit) : candidates;
  const readyMap = await workItemsService.getReadinessForItems(
    windowRows.map((r) => r.id),
    ctx,
  );
  const rows = windowRows.filter((r) => readyMap.get(r.id) === true);

  const last = windowRows.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeReadyCursor({ kind: last.kind, priority: last.priority, key: last.key })
      : null;
  return { rows, nextCursor };
}

/** The resolved status-category + assignee bits the 7.0.3 mapper needs beyond
 *  the `WorkItem` row — both already carried on the candidate row (joined in the
 *  single read), so this is a pure projection, no DB call. */
function rowReadyContext(row: ReadyCandidateRow): ReadyItemContext {
  return {
    statusCategory: row.statusCategory,
    assignee: row.assigneeId
      ? {
          id: row.assigneeId,
          name: row.assigneeName ?? '',
          email: row.assigneeEmail ?? '',
          image: row.assigneeImage,
        }
      : null,
  };
}

/**
 * Decorate a ready candidate row with the dispatch-only payload (Subtask 7.0.2):
 * the parent key, the resolved blocker keys, and the `contextRefs` parsed from
 * the body's `## Context refs` section (finding #62 — Prodect stores refs in
 * `descriptionMd`, not a column; this supplies REAL paths into the 7.0.3
 * mapper's `contextRefs` input instead of the `[]` placeholder). For a READY
 * item the blockers are all terminal — the dependency story the agent's prompt
 * tells. The candidate row carries the full `WorkItem` body, so no re-read.
 */
async function buildReadyDispatchDto(row: ReadyCandidateRow): Promise<ReadyItemDispatchDto> {
  const [parentRow, blockerLinks] = await Promise.all([
    row.parentId ? workItemRepository.findById(row.parentId) : Promise.resolve(null),
    workItemLinkRepository.findByFromItem(row.id, 'is_blocked_by'),
  ]);
  const blockerRows = (await workItemRepository.findByIds(blockerLinks.map((l) => l.toId)))
    .slice()
    .sort(byKeyAsc);

  const ctx: ReadyDispatchContext = {
    ...rowReadyContext(row),
    parent: parentRow ? { identifier: parentRow.identifier } : null,
    contextRefs: extractContextRefs(row.descriptionMd),
  };
  return toReadyItemDispatchDto(row, blockerRows, ctx);
}
