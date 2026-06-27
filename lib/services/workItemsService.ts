import { Prisma, type WorkItem, type WorkItemKind, type WorkItemPriority } from '@prisma/client';
import { db } from '@/lib/db';
import {
  astHasEpic5Conditions,
  collectFilterReferentIds,
  resolveFilterAst,
  type CustomFieldFilterType,
  type ProjectFilterCustomField,
  type ProjectFilterReferents,
} from '@/lib/filters/registry';
import type { FilterAst } from '@/lib/filters/ast';
import { customFieldOptionRepository } from '@/lib/repositories/customFieldOptionRepository';
import { assertValidParent, allowedParentKinds, type IssueType } from '@/lib/issues/parentRules';
import { defaultExecutorForType, isTypeableKind } from '@/lib/issues/executorDefaults';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { labelRepository } from '@/lib/repositories/labelRepository';
import { watcherRepository } from '@/lib/repositories/watcherRepository';
import { componentRepository } from '@/lib/repositories/componentRepository';
import { workItemComponentRepository } from '@/lib/repositories/workItemComponentRepository';
import { customFieldDefinitionRepository } from '@/lib/repositories/customFieldDefinitionRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { entitlementsService } from '@/lib/services/entitlementsService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { watchersService } from '@/lib/services/watchersService';
import { parseMentionIds } from '@/lib/mentions/parse';
import { attachmentsService } from '@/lib/services/attachmentsService';
import { extractReferencedBlobUrlsFromBodies } from '@/lib/blob/referencedUrls';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { automationFieldsFromDiffKeys } from '@/lib/automation/fields';
import { keyForAppend, keyBetween } from '@/lib/workItems/positioning';
import {
  QUICK_SEARCH_DEFAULT_LIMIT,
  QUICK_SEARCH_MAX_LIMIT,
  QUICK_SEARCH_MIN_QUERY_LENGTH,
} from '@/lib/workItems/quickSearch';
import { relationshipToLink } from '@/lib/workItems/linkRelationships';
import {
  AssigneeNotInWorkspaceError,
  CrossProjectParentError,
  IllegalTransitionError,
  NoInitialStatusError,
  ReporterNotInWorkspaceError,
  NotEpicError,
  StaleWorkItemError,
  TypeNotAllowedOnKindError,
  UnknownStatusError,
  WorkItemNotFoundError,
} from '@/lib/workItems/errors';
import { CrossWorkspaceLinkError, WorkItemLinkNotFoundError } from '@/lib/workItems/linkErrors';
import { ComponentNotFoundError, CrossProjectComponentError } from '@/lib/components/errors';
import {
  NotProjectAdminError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { isWorkspaceManager } from '@/lib/projects/roles';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { CrossProjectSprintAssignmentError, SprintNotFoundError } from '@/lib/sprints/errors';
import { validateStoryPoints } from '@/lib/estimation/validate';
import { projectAccessService } from '@/lib/services/projectAccessService';
import {
  toWorkItemDto,
  toWorkItemSummaryDto,
  toWorkItemSubtreeDto,
  toWorkItemTreeNodeDto,
  toRoadmapNodeDto,
  toWorkItemListItemDto,
  toWorkItemTreeRowDto,
  toArchivedWorkItemDto,
} from '@/lib/mappers/workItemMappers';
import { toWorkItemLinkDto } from '@/lib/mappers/workItemLinkMappers';
import { toQuickViewData } from '@/lib/mappers/quickViewMappers';
import type { QuickViewData } from '@/lib/dto/quickView';
import type { Locale } from '@/lib/i18n/locales';
import { toLabelDto } from '@/lib/mappers/labelMappers';
import { toComponentDto } from '@/lib/mappers/componentMappers';
import { toCustomFieldWithValueDto } from '@/lib/mappers/customFieldValueMappers';
import { toWorkItemRevisionDto } from '@/lib/mappers/workItemRevisionMappers';
import type {
  WorkItemForestRow,
  WorkItemTreeRow,
  RepoIssueFilter,
  ReadyCandidateRow,
  ReadyLayerRow,
} from '@/lib/repositories/workItemRepository';
import { DEFAULT_SORT, ISSUE_LIST_PAGE_SIZE } from '@/lib/issues/issueListView';
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
  type ReadyCursor,
  clampReadyLimit,
  decodeReadyCursor,
  encodeReadyCursor,
  READY_KIND_RANK,
  READY_PRIORITY_ASC,
} from '@/lib/workItems/readyFilter';
import { extractContextRefs } from '@/lib/markdown/contextRefs';
import type {
  CompleteSessionItemResultDto,
  CompleteSessionResultDto,
  CreateWorkItemInput,
  ExecutorDto,
  IssueDetailDto,
  ProjectTreeFilter,
  RelationshipLinkDto,
  UpdateWorkItemInput,
  WorkItemDeletePreviewDto,
  WorkItemDto,
  WorkItemKindDto,
  WorkItemTypeDto,
  PagedIssueListDto,
  PagedArchivedWorkItemsDto,
  WorkItemRevisionDto,
  WorkItemSummaryDto,
  WorkItemSubtreeDto,
  WorkItemTreeNodeDto,
  TreeLevelDto,
  ProjectRoadmapDto,
  WorkItemValidityDto,
} from '@/lib/dto/workItems';
import type { SprintBlockerDto, ValidityCondition } from '@/lib/dto/sprints';
import { DEFAULT_VALIDITY_CONDITION } from '@/lib/dto/sprints';
import { gatingItemSatisfied } from '@/lib/workItems/validity';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
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

/**
 * Leaf-only enforcement for `type` / `executor` (Story 2.7 · the 2.7.2 ADR).
 * `type` is the nature of EXECUTABLE work, so only the leaf kinds
 * (task / subtask / bug — `isTypeableKind`) may carry a type or executor;
 * epics + stories are containers. A single nullable column can't express this,
 * so the service is the PRIMARY guard (no DB-trigger backstop). Throws
 * `TypeNotAllowedOnKindError` (→ 422) when a non-typeable kind would end up
 * with a non-null type or executor; clearing both to null is legal on any kind.
 * Called with the EFFECTIVE post-write values so it catches both "set a type on
 * a story" and "convert a typed leaf into a story without clearing its type".
 */
function assertTypeKindConsistent(
  kind: WorkItemKindDto,
  type: WorkItemTypeDto | null,
  executor: ExecutorDto | null,
): void {
  if ((type !== null || executor !== null) && !isTypeableKind(kind)) {
    throw new TypeNotAllowedOnKindError(kind);
  }
}

/**
 * Resolve the executor a create/update should persist, given the resulting
 * `type`, any explicitly-supplied executor, and the row's CURRENT executor.
 * SEED-IF-ABSENT (the 2.7.2 ADR "executor is seeded when a type is first
 * chosen, and overridable"): an explicit executor always wins; otherwise, when
 * a non-null `type` lands on a row that has no executor yet, seed from
 * `defaultExecutorForType`. An existing executor (a prior override) is never
 * clobbered by a bare type change, and a null type never auto-sets an executor.
 */
function resolveExecutor(
  type: WorkItemTypeDto | null,
  explicit: ExecutorDto | null | undefined,
  current: ExecutorDto | null,
): ExecutorDto | null {
  if (explicit !== undefined) return explicit;
  if (type !== null && current === null) return defaultExecutorForType(type);
  return current;
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
  // Story points (Story 4.3 · exposed on create in 7.8.21): the `set` helper
  // skips null (unestimated), so a plain create's diff is unchanged. Recorded
  // numeric, not as the raw Prisma Decimal — matching `estimationService`'s
  // own revision shape (`{ from, to }` as Numbers).
  set('storyPoints', row.storyPoints === null ? null : Number(row.storyPoints));
  // Type + executor (Story 2.7): the `set` helper skips nulls, so an untyped
  // leaf / a container leaves the diff unchanged from pre-2.7; a typed create
  // records the chosen type + (seeded or explicit) executor.
  set('type', row.type);
  set('executor', row.executor);
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
 * forest the `/items` tree-table renders (Subtask 2.5.1). Roots (parentId
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
function buildRepoFilter(
  filter: ProjectTreeFilter,
  filterReferents?: ProjectFilterReferents,
): RepoIssueFilter {
  const repoFilter: RepoIssueFilter = {};
  if (filter.kinds && filter.kinds.length > 0) repoFilter.kinds = filter.kinds;
  if (filter.types && filter.types.length > 0) repoFilter.types = filter.types;
  if (filter.includeUntyped) repoFilter.includeUntyped = true;
  if (filter.statuses && filter.statuses.length > 0) repoFilter.statuses = filter.statuses;
  if (filter.assigneeIds && filter.assigneeIds.length > 0) {
    repoFilter.assigneeIds = filter.assigneeIds;
  }
  if (filter.includeUnassigned) repoFilter.includeUnassigned = true;
  const text = filter.text?.trim();
  if (text) repoFilter.text = text;
  // The advanced-builder axis (Story 6.1 · 6.1.1): resolve at the service
  // boundary — typed FilterValidationErrors (→ 422 at the HTTP layer) on an
  // unknown field/operator id or a bad value; the repo compiler re-resolves
  // (defence in depth). Epic-5 conditions (6.1.2) resolve against the
  // referents `loadFilterReferents` fetched — stale referents are NOT errors
  // (they compile to match-nothing). An empty row set constrains nothing and
  // is dropped so it never activates tree pruning.
  if (filter.ast) {
    resolveFilterAst(filter.ast, filterReferents);
    if (filter.ast.conditions.length > 0) {
      repoFilter.ast = filter.ast;
      repoFilter.filterReferents = filterReferents;
    }
  }
  return repoFilter;
}

/**
 * Load the per-project referent set an AST's Epic-5 conditions (labels /
 * components / `cf:<fieldId>` custom fields, Subtask 6.1.2) resolve against:
 * BOUNDED reads over only the ids the filter actually references (finding
 * #57 — never load-all; the one exception is the definition list, already
 * capped at 50 by 5.3.2's service rule). Every read is tenancy-gated
 * (project + workspace), so a cross-tenant id resolves to nothing — and
 * therefore reads as a stale referent, exactly like a deleted one: the
 * condition matches nothing and surfaces the unknown-value notice instead of
 * erroring (the rule Story 6.2 saved filters depend on). Returns undefined
 * when the AST carries no Epic-5 condition (no reads spent). Exported for
 * the 6.1.4/6.1.5 page wiring, which resolves the same referents to render
 * the per-row stale notices.
 */
export async function loadFilterReferents(
  projectId: string,
  workspaceId: string,
  ast: FilterAst,
): Promise<ProjectFilterReferents | undefined> {
  if (!astHasEpic5Conditions(ast)) return undefined;
  const ids = collectFilterReferentIds(ast);
  const [definitions, options, labels, components] = await Promise.all([
    ids.customFieldIds.length > 0
      ? customFieldDefinitionRepository.listByProject(projectId, workspaceId)
      : [],
    customFieldOptionRepository.findByIds(ids.customFieldValueIds, projectId, workspaceId),
    labelRepository.findByIds(ids.labelIds, projectId),
    componentRepository.findByIds(ids.componentIds),
  ]);

  const customFields = new Map<string, ProjectFilterCustomField>();
  for (const def of definitions) {
    if (!ids.customFieldIds.includes(def.id)) continue;
    customFields.set(def.id, {
      fieldType: def.fieldType as CustomFieldFilterType,
      optionIds: new Set(options.filter((o) => o.fieldId === def.id).map((o) => o.id)),
    });
  }
  return {
    customFields,
    labelIds: new Set(labels.map((l) => l.id)),
    componentIds: new Set(
      components
        .filter((c) => c.projectId === projectId && c.workspaceId === workspaceId)
        .map((c) => c.id),
    ),
  };
}

/**
 * Clamp a requested list page size to `[1, ISSUE_LIST_PAGE_SIZE]`, defaulting
 * a missing / non-finite value to the full `ISSUE_LIST_PAGE_SIZE` (the
 * `clampLastN` convention — bad input degrades to the sensible bound, the cap
 * itself is never exceeded; the 6.3.2 filter-results widget's ≤50/page rule).
 */
function clampIssuePageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isFinite(pageSize) || pageSize < 1) {
    return ISSUE_LIST_PAGE_SIZE;
  }
  return Math.min(Math.floor(pageSize), ISSUE_LIST_PAGE_SIZE);
}

/** True when the repo filter constrains at least one axis (drives forest pruning). */
function repoFilterIsActive(f: RepoIssueFilter): boolean {
  return (
    f.kinds !== undefined ||
    f.types !== undefined ||
    f.includeUntyped === true ||
    f.statuses !== undefined ||
    f.assigneeIds !== undefined ||
    f.includeUnassigned === true ||
    f.text !== undefined ||
    f.ast !== undefined
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

/**
 * The default terminal `cancelled` status — a category-`done` status that is a
 * sealed "won't do / duplicate", EXCLUDED from a roadmap progress meter's done
 * AND total counts (so a container whose only remnants are cancelled is not
 * held permanently incomplete). It is a PROTECTED default key (can't be
 * renamed / recategorised — `lib/workflows/defaultWorkflow.ts`), so the literal
 * is stable; a project's CUSTOM `done` statuses still count as done by category
 * (no project-specific cancel detection is attempted). Mirrors the public
 * roadmap's `ROADMAP_EXCLUDED_DONE_KEY` (publicProjectsService).
 */
const ROADMAP_CANCELLED_KEY = 'cancelled';

/** The status keys that count as DONE on a roadmap meter: every `done`-category
 *  status except `cancelled`. */
function roadmapDoneStatusKeys(statuses: WorkflowStatusDto[]): Set<string> {
  return new Set(
    statuses
      .filter((s) => s.category === 'done' && s.key !== ROADMAP_CANCELLED_KEY)
      .map((s) => s.key),
  );
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
  accessLevel: 'open' | 'limited' | 'private' | 'public',
  ctx: ServiceContext,
): Promise<Set<string>> {
  const members = await assignableMembersService.list({ projectId, accessLevel, ctx });
  return new Set(members.map((m) => m.userId));
}

// The default-workflow status keys the integration tools target (Subtask
// 7.8.11). `mark_integrated` moves an item to `in_review`; `complete_session`
// moves each recorded item to `done`. Both are the canonical default keys
// (lib/workflows/defaultWorkflow.ts). A project whose CUSTOM workflow lacks the
// key surfaces `UnknownStatusError` from the transition (mark_integrated → a tool
// error; complete_session → a per-item `failed` result) — the honest outcome
// rather than a silent miss.
const IN_REVIEW_STATUS_KEY = 'in_review';
const DONE_STATUS_KEY = 'done';

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

    // Type + executor (Story 2.7): leaf-only — a type/executor on an epic/story
    // is rejected here (no DB-trigger backstop). Executor is seeded from the
    // type→executor default when a type is supplied without one (seed-if-absent;
    // a new row's current executor is null). Validated BEFORE the key-allocation
    // transaction so a denied create never burns a work-item key.
    const itemType = input.type ?? null;
    const itemExecutor = resolveExecutor(itemType, input.executor, null);
    assertTypeKindConsistent(input.kind, itemType, itemExecutor);

    // Story points (Story 4.3 · exposed on create in 7.8.21): validated with the
    // SAME shared rule the UI estimation path uses (finite, non-negative,
    // ≤ 9999.99, ≤ 2 decimals). Validated BEFORE the key-allocation transaction
    // so a malformed value never burns a work-item key. Omitted/null → the
    // column default (unestimated). Throws `InvalidEstimateError` (422).
    const storyPoints = validateStoryPoints(input.storyPoints ?? null);

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
      // §4 work-item cap (8.1.11): block BEFORE burning a key when the org is at
      // its free-tier ceiling. Org resolved UP from the workspace; the assert
      // locks the org row FOR UPDATE so concurrent creates serialize (inert
      // off-cloud / for a scaled org). A null org id (workspace unresolvable
      // under RLS) skips the cap rather than blocking a legitimate create.
      const capOrgId = await workspaceRepository.findOrganizationId(workspaceId, tx);
      if (capOrgId) await entitlementsService.assertWithinWorkItemCap(capOrgId, tx);
      const key = await projectRepository.allocateWorkItemNumber(input.projectId, tx);
      // Build the identifier prefix from a FRESH in-tx read, NOT the pre-tx
      // `project` snapshot: a project key change (Story 6.8 `changeKey`) racing
      // this creation could have committed a new prefix after `project` was read
      // above. `allocateWorkItemNumber` UPDATEs (and thus row-locks) the project
      // row, so this read — and a concurrent `changeKey`'s `SELECT … FOR UPDATE`
      // on the same row — serialize: whichever grabs the lock first commits, and
      // the loser observes the winner's identifier. Without re-reading here, an
      // issue could be minted with the stale prefix mid-rename (the row the bulk
      // rewrite already passed), so the re-read is what makes the FOR-UPDATE lock
      // actually prevent a stale-prefix identifier.
      const refreshed = await projectRepository.findById(input.projectId, tx);
      /* istanbul ignore next -- allocateWorkItemNumber above already UPDATEd (and
         threw ProjectNotFoundError if absent), so the project always resolves here;
         the ?? guards a type-level null only and is never taken at runtime */
      const prefix = refreshed?.identifier ?? project.identifier;
      const identifier = `${prefix}-${key}`;

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
        // Triage intake (Story 6.11 · Subtask 6.11.4): when the caller marks
        // this a triage submission, the item is born in the inbox —
        // `triagedAt` stamped now (the read-exclusion marker, 6.11.3) and
        // `submittedByUserId` recording the real submitter (a member, or — via
        // 6.12 — a signed-in non-member; DISTINCT from the `reporterId` above,
        // which stays a member). Omitted → a normal create (`triagedAt` NULL).
        ...(input.triage
          ? { triagedAt: new Date(), submittedByUserId: input.triage.submittedByUserId }
          : {}),
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        estimateMinutes: input.estimateMinutes ?? null,
        // Story points (Story 4.3 · exposed on create in 7.8.21): the validated
        // value (null when omitted). Prisma accepts a number for the
        // Decimal(6, 2) column.
        storyPoints,
        // Work-item type + executor (Story 2.7) — leaf-only validated + executor
        // seeded above; nulls for an untyped leaf or a container kind.
        type: itemType,
        executor: itemExecutor,
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

      // Auto-watch (Subtask 5.4.4, the verified create rule, constant-on):
      // the creator watches the issue they created, in this SAME transaction
      // — born watched, or not born at all. Idempotent by the watcher unique;
      // writes NO revision (watching is not a field change). Story 5.7's
      // opt-out preference will live inside the hook, not here.
      await watchersService.autoWatch(row.id, ctx.userId, tx);

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

    // Automation `created` trigger (Story 6.6 · Subtask 6.6.2): every commit
    // emits the channel-agnostic create event the rule engine consumes. Stamps
    // provenance so a rule whose own action created the item can't loop (no
    // create action ships in 6.6.2, but the field rides through for a future
    // one).
    await sendEvent('work-item/created', {
      workspaceId,
      projectId: input.projectId,
      workItemId: dto.id,
      actorId: ctx.userId,
      ...(ctx.viaAutomationRuleId ? { viaAutomationRuleId: ctx.viaAutomationRuleId } : {}),
    });

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
      'storyPoints',
      'type',
      'executor',
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

    // Story points (Story 4.3 · exposed on this patch in 7.8.21): validate the
    // supplied value with the SAME shared rule the UI estimation path uses,
    // BEFORE the transaction so a malformed value fails fast without taking the
    // row lock. `undefined` → leave untouched; an explicit `null` clears.
    // Throws `InvalidEstimateError` (422).
    const nextStoryPoints =
      patch.storyPoints !== undefined ? validateStoryPoints(patch.storyPoints) : undefined;

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

      // Story points (Story 4.3 · exposed on this patch in 7.8.21): compare
      // NUMERICALLY — `current.storyPoints` is a Prisma Decimal, so coerce both
      // sides to Number before the change check, mirroring how
      // `estimationService.setEstimate` records its revision. Validated above
      // (pre-tx); `null` clears. The cell shares this one 'updated' revision
      // with every other field in the patch (atomic, single History entry).
      if (nextStoryPoints !== undefined) {
        const fromPoints = current.storyPoints === null ? null : Number(current.storyPoints);
        if (fromPoints !== nextStoryPoints) {
          update.storyPoints = nextStoryPoints;
          diff.storyPoints = { from: fromPoints, to: nextStoryPoints };
        }
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
      // When the patch CHANGES explanationMd and the current source is an
      // un-reviewed ai_draft, editing the explanation transitions the source
      // to user_edited — UNLESS the caller set explanationSource explicitly
      // (explicit always wins). The transition is captured in the diff so the
      // activity feed surfaces "AI draft → user edited".
      //
      // Gate on an ACTUAL change (`update.explanationMd` is set only when the
      // value differs — line above), NOT merely on the field being present:
      // the edit form always submits explanationMd, so a save that touches only
      // another field (e.g. priority) must NOT silently flip an unchanged
      // ai_draft to user_edited and drop its badge (Subtask 8.8.12).
      let effectiveSource = patch.explanationSource;
      const explanationChanged = update.explanationMd !== undefined;
      if (
        explanationChanged &&
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

      // ── Type / executor (Story 2.7) ───────────────────────────────────
      // Leaf-only with seed-if-absent for the executor (assertTypeKindConsistent
      // + resolveExecutor). Validated against the EFFECTIVE post-patch kind, so
      // converting a typed leaf into a container WITHOUT clearing its type is
      // rejected (TypeNotAllowedOnKindError → 422) just like setting a type on a
      // story. A bare `type` change seeds the executor only when the row had
      // none; an explicit executor always wins and is never clobbered.
      const nextType: WorkItemTypeDto | null = patch.type !== undefined ? patch.type : current.type;
      const nextExecutor = resolveExecutor(nextType, patch.executor, current.executor);
      assertTypeKindConsistent(nextKind, nextType, nextExecutor);

      if (patch.type !== undefined && patch.type !== current.type) {
        update.type = patch.type;
        diff.type = { from: current.type, to: patch.type };
      }
      if (nextExecutor !== current.executor) {
        update.executor = nextExecutor;
        diff.executor = { from: current.executor, to: nextExecutor };
      }

      if (Object.keys(diff).length === 0) {
        return {
          dto: toWorkItemDto(current),
          revisionId: null,
          addedDescMentionIds: [],
          changedFieldIds: [] as string[],
        };
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
      // The automatable built-in fields that actually changed (Story 6.6 ·
      // Subtask 6.6.2) — translated from the diff keys; drives the
      // `field.changed` emit below. Computed off `diff` (the field cells), so
      // the synthetic `attachments` cell on `revisionDiff` is naturally ignored.
      const changedFieldIds: string[] = automationFieldsFromDiffKeys(Object.keys(diff));
      return { dto: toWorkItemDto(row), revisionId, addedDescMentionIds, changedFieldIds };
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

    // Automation `field_changed` trigger (Story 6.6 · Subtask 6.6.2): emit only
    // when an automatable built-in field (assignee / priority / dueDate /
    // estimate) actually changed — so the event is never a no-op for the
    // engine. Carries the changed field ids (the engine narrows by its rule's
    // configured field) + provenance (a `set_field` action's own edit is
    // skipped, so it can't loop). Status moves DON'T ride this — they ride
    // `work-item/transitioned` from the typed-workflow path.
    if (result.revisionId !== null && result.changedFieldIds.length > 0) {
      await sendEvent('work-item/field.changed', {
        workspaceId: ctx.workspaceId,
        projectId: result.dto.projectId,
        workItemId: result.dto.id,
        actorId: ctx.userId,
        changedFields: result.changedFieldIds,
        revisionId: result.revisionId,
        ...(ctx.viaAutomationRuleId ? { viaAutomationRuleId: ctx.viaAutomationRuleId } : {}),
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
    const { dto, transition } = await db.$transaction((tx) =>
      workItemsService.applyStatusTransition(workItemId, toStatusKey, ctx, tx),
    );
    // Post-commit, never inside the tx — a rollback must not have notified
    // (the 5.1.2 rule). A no-op move carries no transition, so it emits
    // nothing. The 5.4.5 watcher job consumes this; 5.7's bell fans in later.
    if (transition) {
      await sendEvent('work-item/transitioned', {
        workspaceId: ctx.workspaceId,
        workItemId: dto.id,
        actorId: ctx.userId,
        fromStatusKey: transition.fromStatusKey,
        toStatusKey: transition.toStatusKey,
        revisionId: transition.revisionId,
        // Provenance (Story 6.6 · Subtask 6.6.2): set when a rule's `transition`
        // action drove this move, so the engine skips the follow-on event and
        // can't loop. Absent on a user-driven transition.
        ...(ctx.viaAutomationRuleId ? { viaAutomationRuleId: ctx.viaAutomationRuleId } : {}),
      });
    }
    return dto;
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
   *
   * Returns the updated DTO plus the applied transition's metadata (from/to
   * keys + the revision row id) — `null` on the no-op move — so each caller
   * can emit `work-item/transitioned` AFTER its own transaction commits
   * (Subtask 5.4.5; the emit can never live HERE, inside the tx, because a
   * rollback must not have notified anyone).
   */
  async applyStatusTransition(
    workItemId: string,
    toStatusKey: string,
    ctx: ServiceContext,
    tx: Prisma.TransactionClient,
    opts: { sessionBranch?: string } = {},
  ): Promise<{
    dto: WorkItemDto;
    transition: { fromStatusKey: string; toStatusKey: string; revisionId: string } | null;
  }> {
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
    // The `mark_integrated` session-branch directive (Subtask 7.8.11): set the
    // integration branch alongside the status move. A genuine write only when it
    // differs from the current value (re-marking the SAME branch is a no-op).
    const branchDirective = opts.sessionBranch;
    const wantsBranchWrite =
      branchDirective !== undefined && branchDirective !== current.sessionBranch;

    // No-op STATUS move: succeed without a revision (idempotent) and emit no
    // transition. But still honor a branch-only write — re-marking an item
    // ALREADY in `in_review` to a new session branch changes the field without a
    // status transition (no revision, since sessionBranch is dispatch bookkeeping
    // not a content edit on the activity feed).
    if (fromKey === toStatusKey) {
      if (!wantsBranchWrite) return { dto: toWorkItemDto(current), transition: null };
      const row = await workItemRepository.update(
        workItemId,
        { sessionBranch: branchDirective },
        tx,
      );
      return { dto: toWorkItemDto(row), transition: null };
    }

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

    // Build the row write. Reaching a `done`-category status CLEARS the
    // integration branch (Subtask 7.8.11 invariant: done ⇒ sessionBranch null,
    // so a merged dep never leaves a stale lineage for dependents to inherit —
    // `complete_session` rides this, as does any board drag to done). Otherwise
    // apply the explicit branch directive (`mark_integrated`'s move to in_review
    // sets it). The revision diff stays status-only — `sessionBranch` is dispatch
    // bookkeeping, not a content edit, so it never lands in the activity feed (and
    // keeping it out avoids the activity totality guard).
    const update: Prisma.WorkItemUncheckedUpdateInput = { status: toStatusKey };
    if (target.category === 'done') update.sessionBranch = null;
    else if (branchDirective !== undefined) update.sessionBranch = branchDirective;

    const row = await workItemRepository.update(workItemId, update, tx);
    const revisionId = await workItemRevisionsService.recordRevision(
      {
        workItemId,
        changedById: ctx.userId,
        changeKind: 'updated',
        diff: { status: { from: fromKey, to: toStatusKey } },
      },
      tx,
    );
    return {
      dto: toWorkItemDto(row),
      transition: { fromStatusKey: fromKey, toStatusKey, revisionId },
    };
  },

  /**
   * Integrate a work item onto a session branch (Story 7.8 · Subtask 7.8.11) —
   * the write the 7.9 CLI loop calls on agent success. ONE transaction:
   * transition the item to `in_review` (the same legal-transition validation
   * every status move runs — an item that can't legally reach `in_review` from
   * its current status throws `IllegalTransitionError` and the field is NEVER
   * touched, since the throw precedes the write) AND record `session_branch`.
   * From then on the item is integrated-awaiting-review: it unblocks dependents
   * (the field-keyed readiness rule) and the branch travels with it for prompt
   * generation. Re-marking an item already in `in_review` to a NEW branch updates
   * the field with no spurious revision (the no-op-status branch-write path).
   * Emits `work-item/transitioned` post-commit like `updateStatus`.
   */
  async markIntegrated(
    workItemId: string,
    sessionBranch: string,
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    const { dto, transition } = await db.$transaction((tx) =>
      workItemsService.applyStatusTransition(workItemId, IN_REVIEW_STATUS_KEY, ctx, tx, {
        sessionBranch,
      }),
    );
    if (transition) {
      await sendEvent('work-item/transitioned', {
        workspaceId: ctx.workspaceId,
        workItemId: dto.id,
        actorId: ctx.userId,
        fromStatusKey: transition.fromStatusKey,
        toStatusKey: transition.toStatusKey,
        revisionId: transition.revisionId,
        ...(ctx.viaAutomationRuleId ? { viaAutomationRuleId: ctx.viaAutomationRuleId } : {}),
      });
    }
    return dto;
  },

  /**
   * Bulk close-out a session branch (Story 7.8 · Subtask 7.8.11) — run after a
   * human merges the session PR. Every work item recorded on `sessionBranch`
   * (workspace-scoped) is transitioned to `done` (which CLEARS the branch via the
   * `applyStatusTransition` done-invariant) in ONE transaction. The legal-
   * transition + status-lookup checks run BEFORE any write, so a per-item
   * rejection (an illegal path to done, an unknown `done` status in a custom
   * workflow, or an access denial) is caught and surfaced as a `failed` result
   * WITHOUT aborting the transaction — the items that CAN complete still commit.
   * An item already in `done` is an idempotent no-op (`already_done`), its branch
   * cleared defensively. Emits `work-item/transitioned` for each completed item
   * post-commit. An empty branch (no recorded items) returns an empty result.
   */
  async completeSession(
    sessionBranch: string,
    ctx: ServiceContext,
  ): Promise<CompleteSessionResultDto> {
    const items = await workItemRepository.findBySessionBranch(sessionBranch, ctx.workspaceId);
    if (items.length === 0) return { sessionBranch, results: [] };

    const { results, transitions } = await db.$transaction(async (tx) => {
      const results: CompleteSessionItemResultDto[] = [];
      const transitions: Array<{
        id: string;
        fromStatusKey: string;
        toStatusKey: string;
        revisionId: string;
      }> = [];
      for (const item of items) {
        try {
          const { dto, transition } = await workItemsService.applyStatusTransition(
            item.id,
            DONE_STATUS_KEY,
            ctx,
            tx,
          );
          if (transition) {
            transitions.push({ id: dto.id, ...transition });
            results.push({ key: item.identifier, outcome: 'completed' });
          } else {
            // Already in the done status — the move was a no-op. Clear any
            // lingering branch so a dependent never re-inherits it (normally a
            // done item's branch is already null; this is the invariant guard).
            if (dto.sessionBranch !== null) {
              await workItemRepository.update(item.id, { sessionBranch: null }, tx);
            }
            results.push({ key: item.identifier, outcome: 'already_done' });
          }
        } catch (err) {
          // A per-item rejection (illegal transition / unknown done status /
          // access denial) is surfaced, not fatal — these all throw BEFORE the
          // write, so the transaction stays healthy for the remaining items.
          if (
            err instanceof IllegalTransitionError ||
            err instanceof UnknownStatusError ||
            err instanceof ProjectAccessDeniedError
          ) {
            results.push({ key: item.identifier, outcome: 'failed', reason: err.message });
          } else {
            throw err;
          }
        }
      }
      return { results, transitions };
    });

    for (const t of transitions) {
      await sendEvent('work-item/transitioned', {
        workspaceId: ctx.workspaceId,
        workItemId: t.id,
        actorId: ctx.userId,
        fromStatusKey: t.fromStatusKey,
        toStatusKey: t.toStatusKey,
        revisionId: t.revisionId,
        ...(ctx.viaAutomationRuleId ? { viaAutomationRuleId: ctx.viaAutomationRuleId } : {}),
      });
    }
    return { sessionBranch, results };
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
   * Restore (unarchive) a soft-deleted work item — the inverse of
   * {@link archiveWorkItem}, the Jira "restore" action (Subtask 7.8.14). Clears
   * `archivedAt` and records an `'unarchived'` revision, so the item returns to
   * active views (`list_ready` / search) and the History feed shows the restore
   * the same way it shows the archive. Same tenant-gate + 6.4 edit gate as
   * archive. The `from` in the revision diff is the archived timestamp the row
   * carried before the restore (null if it was already live — a no-op restore).
   */
  async unarchiveWorkItem(id: string, ctx: ServiceContext): Promise<WorkItemDto> {
    return db.$transaction(async (tx) => {
      const current = await workItemRepository.findById(id, tx);
      if (!current || current.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(id);
      await projectAccessService.assertCanEdit(current.projectId, ctx, tx);

      const wasArchivedAt = current.archivedAt?.toISOString() ?? null;
      const row = await workItemRepository.unarchive(id, tx); // throws WorkItemNotFoundError if absent
      await workItemRevisionsService.recordRevision(
        {
          workItemId: id,
          changedById: ctx.userId,
          changeKind: 'unarchived',
          diff: { archivedAt: { from: wasArchivedAt, to: null } },
        },
        tx,
      );
      return toWorkItemDto(row);
    });
  },

  /**
   * PERMANENT delete (Story 2.8 · Subtask 2.8.2) — the destructive, irreversible
   * counterpart of {@link archiveWorkItem}, Jira-parity ("Delete Issues"). Removes
   * the item AND its ENTIRE subtree (every descendant), plus their links / comments
   * / watchers / custom-field values / etc., in ONE transaction.
   *
   * Flow (lock → gate → resolve → audit → delete):
   *  1. FOR-UPDATE lock the root, then re-read + tenant-gate (a cross-workspace or
   *     already-deleted id is a 404 `WorkItemNotFoundError` — the "already-deleted"
   *     race, translated to a typed error). The lock serializes against a concurrent
   *     delete/move of the SAME root (lock-before-read-derived).
   *  2. Permission gate: delete is more privileged than edit — it is the project
   *     **manage** capability (Jira "Delete Issues" defaults to project admins;
   *     `assertCanManage` = project admin or workspace owner/admin, the 6.4 gate),
   *     NOT `assertCanEdit`.
   *  3. Resolve the full subtree id set via `findSubtree` (root + descendants).
   *  4. Write the audit record. The deleted rows — and their OWN revisions (FK
   *     `onDelete: Cascade`) — vanish, so the surviving trace is a `deleted`
   *     revision on the root's PARENT (the `comment_deleted` precedent: history
   *     records the deletion on a surviving neighbour). A TOP-LEVEL item has no
   *     surviving parent to anchor to, so its deletion leaves no per-item History
   *     entry — a project-scoped audit log is a separate capability (not in 2.8),
   *     noted for a follow-up.
   *  5. `deleteSubtree` removes the rows in one statement; every other inbound FK
   *     is `Cascade`/`SetNull` so no orphaned links or rows survive.
   *
   * Idempotent-safe: a missing id throws `WorkItemNotFoundError` (→ 404), never a
   * raw Prisma error. Returns nothing — the rows are gone, there is no DTO to map.
   */
  async deleteWorkItem(id: string, ctx: ServiceContext): Promise<void> {
    return db.$transaction(async (tx) => {
      // 1. Lock the root + tenant-gate (404 on cross-workspace / already-deleted).
      const locked = await workItemRepository.lockById(id, tx);
      if (!locked) throw new WorkItemNotFoundError(id);
      const root = await workItemRepository.findById(id, tx);
      if (!root || root.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(id);

      // 2. Permission gate — delete is the project-admin "manage" capability.
      await projectAccessService.assertCanManage(root.projectId, ctx, tx);

      // 3. Resolve the full subtree (root + every descendant) in one round-trip.
      const subtree = await workItemRepository.findSubtree(id, tx);
      const ids = subtree.map((r) => r.id);
      const descendantCount = ids.length - 1;

      // 4. Audit on the surviving parent (the deleted rows' own revisions cascade
      //    away). A top-level item has no parent anchor — see the doc-comment.
      if (root.parentId) {
        const summary =
          descendantCount > 0
            ? `${root.identifier}: ${root.title} (+${descendantCount} descendant${descendantCount === 1 ? '' : 's'})`
            : `${root.identifier}: ${root.title}`;
        await workItemRevisionsService.recordRevision(
          {
            workItemId: root.parentId,
            changedById: ctx.userId,
            changeKind: 'deleted',
            diff: { deleted: { from: summary, to: null } },
          },
          tx,
        );
      }

      // 5. Delete the subtree; links / comments / etc. cascade at the DB layer.
      await workItemRepository.deleteSubtree(ids, tx);
    });
  },

  /**
   * The cascade IMPACT of a permanent delete (Story 2.8 · Subtask 2.8.7) — the
   * READ counterpart of {@link deleteWorkItem} that the 2.8.4 confirm dialog
   * shows BEFORE the user commits, so the irreversible cascade is named in
   * words. Returns the subtree size (the "Delete N items" magnitude), the
   * descendant count, and the per-kind breakdown of the DESCENDANTS.
   *
   * It ALSO splits out the LIVE (non-archived) descendants (Story 2.9 · Subtask
   * 2.9.9): archiving is single-node (a parent's children stay live), so an
   * archived parent can still own non-archived descendants on the active
   * boards/lists that the cascade delete would ALSO destroy. `totalCount` /
   * `descendantCount` / `byKind` remain the FULL cascade count (live + archived);
   * `liveDescendantCount` / `liveByKind` are the live subset the archived-item
   * confirm modal (2.9.10) warns about.
   *
   * Gated on the SAME `assertCanManage` capability `deleteWorkItem` requires: a
   * viewer who could not perform the delete must not be able to probe the
   * subtree shape (no impact-preview leak). Tenant-gated identically — a missing
   * / cross-workspace id is a 404 `WorkItemNotFoundError`, no existence leak. A
   * pure read: no lock, no transaction (the gate + the reads are independent, and
   * a benign race just yields a slightly stale count the confirm tolerates; the
   * delete itself re-resolves the subtree under a FOR-UPDATE lock).
   */
  async getDeletePreview(id: string, ctx: ServiceContext): Promise<WorkItemDeletePreviewDto> {
    // Resolve + tenant-gate (404 on cross-workspace / missing) before the gate,
    // so the access check has the item's project and an unknown id never leaks.
    const root = await workItemRepository.findById(id);
    if (!root || root.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(id);
    await projectAccessService.assertCanManage(root.projectId, ctx);

    // One recursive-CTE round-trip: root + every descendant, each with its kind.
    const subtree = await workItemRepository.findSubtree(id);
    const byKind: Partial<Record<WorkItemKindDto, number>> = {};
    for (const row of subtree) {
      if (row.id === id) continue; // the breakdown counts DESCENDANTS only
      const kind = row.kind as WorkItemKindDto;
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
    const totalCount = subtree.length;

    // The live (non-archived) descendant slice — counted by kind in SQL (root
    // excluded). A strict subset of `byKind`: archived descendants are in the
    // full breakdown but not here.
    const liveByKind: Partial<Record<WorkItemKindDto, number>> = {};
    let liveDescendantCount = 0;
    for (const { kind, count } of await workItemRepository.countLiveDescendantsByKind(id)) {
      liveByKind[kind as WorkItemKindDto] = count;
      liveDescendantCount += count;
    }

    return { totalCount, descendantCount: totalCount - 1, byKind, liveDescendantCount, liveByKind };
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
   * `/items` list view renders (Subtask 2.5.1) — one recursive-CTE round-trip
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

    const referents = filter.ast
      ? await loadFilterReferents(projectId, project.workspaceId, filter.ast)
      : undefined;
    const repoFilter = buildRepoFilter(filter, referents);
    const rows = await workItemRepository.findProjectForest(
      projectId,
      project.workspaceId,
      repoFilter,
    );

    return assembleProjectForest(rows, repoFilterIsActive(repoFilter));
  },

  /**
   * ONE LEVEL of the project ROADMAP (Subtask 7.20.4 re-plan, MOTIR-1010) — the
   * roots (`parentId = null`) OR one parent's direct children, each carrying a
   * lazy `hasChildren` drill flag + its own `isDone`, PLUS the `is_blocked_by`
   * EDGES from those nodes. The canvas (MOTIR-1194) shows one level at a time and
   * fetches the next on drill, so this is a PER-LEVEL read (reusing
   * {@link listChildIssues}' `findProjectTreeLevel`) — NEVER a whole-tree
   * round-trip that the consumer slices client-side (mistake #91, finding #57).
   *
   * Per-container progress METERS are deliberately NOT computed here: they need
   * the whole subtree (a level read avoids it), and the per-epic meters are
   * MOTIR-1013's work. Done-ness still resolves by workflow CATEGORY (every
   * `done`-category status except `cancelled`).
   *
   * Edges: the `is_blocked_by` links FROM this level's items. The canvas draws a
   * within-level one (both ends visible) as a sibling arrow; an edge to an
   * off-level blocker marks a cross-story dependency. (Capped at the tree-level
   * page size; a level larger than that paginates in a follow-up, like the
   * `/items` tree.)
   *
   * Tenant gate (finding #26): the project must resolve AND belong to the active
   * workspace, else `ProjectNotFoundError` (→ 404). Browse-gated. An empty level
   * → `{ nodes: [], edges: [] }`.
   */
  async getProjectRoadmap(
    projectId: string,
    parentId: string | null,
    ctx: ServiceContext,
    opts: { scope?: 'project' | 'sprint' } = {},
  ): Promise<ProjectRoadmapDto> {
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    await projectAccessService.assertCanBrowse(projectId, ctx);

    // Sprint scope (MOTIR-1381): when the caller asks for the active-sprint
    // slice, resolve the one active sprint (partial-unique `state = 'active'`).
    // NO active sprint → an EMPTY roadmap (the client renders the
    // no-active-sprint state); this is not an error. The whole-project path
    // (scope absent or `'project'`) leaves `sprintId` null and is byte-for-byte
    // the shipped read.
    let sprintId: string | null = null;
    if (opts.scope === 'sprint') {
      const activeSprint = await sprintRepository.findActiveByProject(
        projectId,
        project.workspaceId,
      );
      if (!activeSprint) {
        return { nodes: [], edges: [], offLevelBlockers: [] };
      }
      sprintId = activeSprint.id;
    }

    const [rows, statuses] = await Promise.all([
      workItemRepository.findProjectTreeLevel(
        projectId,
        project.workspaceId,
        parentId,
        DEFAULT_SORT,
        {
          take: TREE_LEVEL_MAX_TAKE,
          offset: 0,
        },
        sprintId,
      ),
      workflowsService.listStatusesByProject(projectId, project.workspaceId),
    ]);
    const doneKeys = roadmapDoneStatusKeys(statuses);

    // Per-container PROGRESS meters (Subtask 7.20.6 / MOTIR-1013): one recursive
    // count over THIS level's CONTAINER nodes (leaves have no subtree, so they're
    // skipped) — done = descendants in a `done`-category status, total = every
    // descendant except the sealed `cancelled` key. A container with no live
    // descendants is absent from the result → `0 / 0`. Leaves carry `progress:
    // null`. Bounded by the level (≤ TREE_LEVEL_MAX_TAKE containers), not a
    // whole-tree load.
    // Progress is the FULL subtree rollup even in sprint scope: a shown root member
    // is the committed unit and drills to its whole subtree, so its meter reflects
    // that whole subtree (MOTIR-1381, revised) — sprint scope only re-roots the top
    // level, it does not prune progress.
    const containerIds = rows.filter((r) => r.hasChildren).map((r) => r.id);
    const progressRows = await workItemRepository.countRoadmapProgress(
      containerIds,
      [...doneKeys],
      ROADMAP_CANCELLED_KEY,
    );
    const progressById = new Map(
      progressRows.map((p) => [p.rootId, { done: p.done, total: p.total }]),
    );

    // READY-to-start (MOTIR-1417): a node is ready iff it is in a startable
    // (`todo`-category) status AND every item it is `blocked_by` is done — the
    // shipped own-blocker readiness (`computeOwnBlockerReadiness`, reused so the
    // highlight never drifts from `list_ready`: it handles archived blockers,
    // cross-project terminals, and integrated-awaiting-review). One extra blocker
    // query for the whole level (no N+1). Done / in-progress nodes are never ready.
    const startableKeys = new Set(statuses.filter((s) => s.category === 'todo').map((s) => s.key));
    const ownReady = await computeOwnBlockerReadiness(
      rows.map((r) => r.id),
      ctx,
    );
    const nodes = rows.map((r) =>
      toRoadmapNodeDto(
        r,
        doneKeys.has(r.status),
        r.hasChildren ? (progressById.get(r.id) ?? { done: 0, total: 0 }) : null,
        startableKeys.has(r.status) && (ownReady.get(r.id) ?? true),
      ),
    );

    // The `is_blocked_by` edges FROM this level's items (the canvas draws the
    // within-level ones as arrows; an off-level blocker flags a cross-story dep).
    const edges = await workItemLinkRepository.findBlockedByEdges(rows.map((r) => r.id));

    // A blocker NOT on this level needs a NAMING stub so the canvas can anchor the
    // signal to a chip (MOTIR-1331). The stub carries `isDone` + `inActiveSprint`
    // so the SPRINT-scoped view can tell a sprint-validity problem (a blocker that
    // is NOT done AND NOT in the active sprint) from a satisfied one — replacing the
    // project-scope "cross-story" framing (MOTIR-1379).
    const levelIds = new Set(rows.map((r) => r.id));
    const offLevelIds = [
      ...new Set(edges.map((e) => e.blockerId).filter((id) => !levelIds.has(id))),
    ];
    const offLevelStubs = await workItemRepository.findRoadmapBlockerStubs(offLevelIds);
    const offLevelBlockers = offLevelStubs.map((s) => ({
      id: s.id,
      identifier: s.identifier,
      title: s.title,
      parentTitle: s.parentTitle,
      isDone: doneKeys.has(s.status),
      inActiveSprint: sprintId != null && s.sprintId === sprintId,
    }));

    return { nodes, edges, offLevelBlockers };
  },

  /**
   * The flat, sorted issue list powering the List view (Subtask 2.5.8). Same
   * project + workspace gate as `getProjectTree` (a cross-workspace project id
   * is a not-found, not an empty list), the SAME filter axes (so the List
   * honours the 2.5.4 filter bar), but the rows come back UN-NESTED and ordered
   * by the active `sort` — the read does the `ORDER BY` (no JS re-nesting). An
   * empty project → `[]`. Returns wire-safe `WorkItemListItemDto`s; the route
   * shapes them into the same `IssueRowData` the tree row uses.
   *
   * `pageSize` (Story 6.3 · Subtask 6.3.2 — the filter-results widget rides
   * THIS read, no second query path) defaults to the List's
   * {@link ISSUE_LIST_PAGE_SIZE} and is clamped to `[1, ISSUE_LIST_PAGE_SIZE]`
   * server-side — the verified 50/page gadget cap (a deliberate Cloud
   * performance bound, not raisable by the caller).
   */
  async getProjectIssuesList(
    projectId: string,
    params: { sort: IssueSort; filter?: ProjectTreeFilter; page?: number; pageSize?: number },
    ctx: ServiceContext,
  ): Promise<PagedIssueListDto> {
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    await projectAccessService.assertCanBrowse(projectId, ctx);

    const referents = params.filter?.ast
      ? await loadFilterReferents(projectId, project.workspaceId, params.filter.ast)
      : undefined;
    const repoFilter = buildRepoFilter(params.filter ?? {}, referents);
    const pageSize = clampIssuePageSize(params.pageSize);

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
   * The project's ARCHIVED items, paginated (Story 2.9 · Subtask 2.9.2) — the
   * read behind the archive-management surface. The inverse of every active
   * view's `archivedAt IS NULL` filter: a FLAT, `archivedAt DESC` page of the
   * soft-deleted items, each carrying its `archivedAt` stamp + the actor who
   * archived it (resolved from the latest `'archived'` revision in the same
   * read). Same project + workspace gate as {@link getProjectIssuesList} (a
   * cross-tenant `projectId` → `ProjectNotFoundError`, no existence leak), and
   * the **read gate is `canBrowse`** (the 2.9.1 view-access decision — viewing
   * the archive is a browse, the same right as the active views; restoring is
   * the separate edit-gated `unarchiveWorkItem`). `pageSize` reuses the List's
   * {@link ISSUE_LIST_PAGE_SIZE} clamp, and an out-of-range `page` clamps to the
   * last page (count-first, like the List). An empty archive → `total: 0`,
   * `page: 1`, `items: []`.
   */
  async listArchivedWorkItems(
    projectId: string,
    params: { page?: number; pageSize?: number },
    ctx: ServiceContext,
  ): Promise<PagedArchivedWorkItemsDto> {
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    await projectAccessService.assertCanBrowse(projectId, ctx);

    const pageSize = clampIssuePageSize(params.pageSize);
    const total = await workItemRepository.countArchivedByProject(projectId, project.workspaceId);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, params.page ?? 1), totalPages);
    const offset = (page - 1) * pageSize;

    const rows = await workItemRepository.findArchivedByProject(projectId, project.workspaceId, {
      limit: pageSize,
      offset,
    });
    return { items: rows.map(toArchivedWorkItemDto), total, page, pageSize };
  },

  /**
   * The COUNT of the project's archived items (Story 2.9 · Subtask 2.9.3) — the
   * lightweight read behind the `/items` toolbar's `[Archived]` entry-point
   * badge (the design's count chip), so the navigator can show "there's
   * something there" without loading a page of rows. Same project + workspace
   * gate and `canBrowse` read gate as {@link listArchivedWorkItems} (a
   * cross-tenant `projectId` → `ProjectNotFoundError`, no existence leak); it
   * just returns the `archivedAt IS NOT NULL` count instead of a page.
   */
  async countArchivedWorkItems(projectId: string, ctx: ServiceContext): Promise<number> {
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    await projectAccessService.assertCanBrowse(projectId, ctx);
    return workItemRepository.countArchivedByProject(projectId, project.workspaceId);
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
   * Remove the directed link addressed by its ENDPOINTS (`fromId <kind> toId`)
   * rather than its opaque id — the shape the MCP `unlink_work_items` tool
   * (Subtask 7.8.13) needs, since an agent addresses a link by the two item
   * keys + relationship, not the link id it never sees. Resolves the unique
   * `(fromId, toId, kind)` row, then runs the SAME delete + reciprocal-drop +
   * revision logic as {@link unlinkWorkItems}. IDEMPOTENT: a link that's already
   * absent (or not visible to `ctx`) is a no-op returning `false` — no typed
   * error — so a retried unlink is safe (the tool's acceptance contract).
   * Returns whether a link was actually removed.
   */
  async unlinkWorkItemsByEndpoints(
    input: LinkWorkItemsInput,
    ctx: ServiceContext,
  ): Promise<boolean> {
    return db.$transaction(async (tx) => {
      const link = await workItemLinkRepository.findReciprocal(
        input.fromId,
        input.toId,
        input.kind,
        tx,
      );
      if (!link) return false;

      // Project access gate (6.4.3): removing a link is an edit of the FROM
      // item. A cross-workspace / unreadable from-item resolves as already-gone
      // (the 404-not-403 contract — no existence leak), so we return false.
      const fromItem = await workItemRepository.findById(link.fromId, tx);
      if (!fromItem || fromItem.workspaceId !== ctx.workspaceId) return false;
      await projectAccessService.assertCanEdit(fromItem.projectId, ctx, tx);

      await workItemLinkRepository.delete(link.id, tx);

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
      return true;
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
   * `is_blocked_by` blockers are still open and WHICH session branch (if any) the
   * item's integrated deps live on. A blocker is SATISFIED iff it is TERMINAL
   * (its status is in ITS OWN project's `category = done` set — 2.2.6 /
   * finding #21, so `done`/`cancelled` count and a live recategorization
   * re-judges it) OR it is INTEGRATED-awaiting-review (a recorded `sessionBranch`
   * — Subtask 7.8.11's integrated-dep rule, keyed on the field, not the status).
   * Otherwise the blocker is OPEN. `openBlockerIds` (a Set, for an O(1) filter at
   * the call site) names exactly the still-open blockers so the relationships
   * banner can highlight them. `inheritedSessionBranch` is the single branch the
   * integrated deps share (what dispatch inherits); `conflictingSessionBranches`
   * is non-empty when those deps span MORE THAN ONE branch — conflicting lineages
   * that keep the item OUT of the ready set until a human merges one session PR.
   * An item with no blockers → ready, empty sets. Two queries total, no N+1.
   */
  async getReadiness(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<{
    ready: boolean;
    openBlockerIds: Set<string>;
    blockedByAncestorId: string | null;
    inheritedSessionBranch: string | null;
    conflictingSessionBranches: string[];
  }> {
    // The node's OWN-blocker verdict + the rich open-blocker / session-branch
    // detail. (`openBlockerIds` stays the node's OWN blockers — the relationships
    // banner highlights those; the cascade cause is surfaced separately as
    // `blockedByAncestorId`, the nearest own-blocked ancestor. Card 7.0.13's "may".)
    const blockers = await workItemLinkRepository.findBlockerStates(workItemId);
    let ownReady = true;
    let openBlockerIds = new Set<string>();
    let inheritedSessionBranch: string | null = null;
    let conflictingSessionBranches: string[] = [];
    if (blockers.length > 0) {
      const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
        blockers.map((b) => b.projectId),
        ctx.workspaceId,
      );
      const cls = classifyBlockerReadiness(blockers, terminalByProject);
      ownReady = cls.ready;
      openBlockerIds = new Set(
        blockers.filter((b) => isOpenBlocker(b, terminalByProject)).map((b) => b.id),
      );
      inheritedSessionBranch = cls.inheritedSessionBranch;
      conflictingSessionBranches = cls.conflicting ? cls.sessionBranches : [];
    }
    // Cascade (Subtask 7.0.13): also gate on the ANCESTOR chain — ready only when
    // every ancestor is ready too. Checked even when the node has no own blocker,
    // because an unready ancestor still holds it out of the ready set.
    const ancestorsByItem = await workItemRepository.findAncestorIdsForItems(
      [workItemId],
      ctx.workspaceId,
    );
    const ancestors = ancestorsByItem.get(workItemId) ?? [];
    let ancestorsReady = true;
    let blockedByAncestorId: string | null = null;
    if (ancestors.length > 0) {
      const ownReadyAnc = await computeOwnBlockerReadiness(ancestors, ctx);
      ancestorsReady = ancestors.every((a) => ownReadyAnc.get(a) !== false);
      // `ancestors` is nearest-first (parent, grandparent, …), so the FIRST
      // own-blocked ancestor is the nearest one — the cause the banner names.
      blockedByAncestorId = ancestors.find((a) => ownReadyAnc.get(a) === false) ?? null;
    }
    return {
      ready: ownReady && ancestorsReady,
      openBlockerIds,
      blockedByAncestorId,
      inheritedSessionBranch,
      conflictingSessionBranches,
    };
  },

  /**
   * Batch readiness (finding #21) for MANY items at once — the board projection
   * (3.1.4) needs a `ready` flag per card without a per-card N+1, and the ready
   * set (7.0) filters candidates by it. Returns a Map keyed by EVERY requested id
   * (an item with no blocker, or only satisfied blockers, is ready). Same rule as
   * `getReadiness` (terminal OR integrated satisfies; conflicting lineages →
   * not ready — Subtask 7.8.11), over ONE batched blocker read + ONE batched
   * terminal-set read.
   */
  async getReadinessForItems(
    itemIds: string[],
    ctx: ServiceContext,
  ): Promise<Map<string, boolean>> {
    const ready = new Map<string, boolean>(itemIds.map((id) => [id, true]));
    if (itemIds.length === 0) return ready;
    // Cascade (Subtask 7.0.13): a node is ready ⟺ its OWN sibling blockers are
    // done AND every ANCESTOR is ready. Resolve the ancestor chains, compute
    // OWN-blocker readiness over the union (items + ancestors) in ONE batch
    // (no N+1), then AND the chain in. The flat per-node blocker rule still
    // holds at each level; an unready ancestor (its own open blocker, or ITS
    // ancestor unready) holds the whole subtree out of the ready set — the
    // mirror of 7.0.10 (a parent-with-children is excluded; its children wait
    // until it is ready).
    const ancestorsByItem = await workItemRepository.findAncestorIdsForItems(
      itemIds,
      ctx.workspaceId,
    );
    const union = new Set<string>(itemIds);
    for (const chain of ancestorsByItem.values()) for (const a of chain) union.add(a);
    const ownReady = await computeOwnBlockerReadiness([...union], ctx);
    for (const id of itemIds) {
      const selfReady = ownReady.get(id) !== false;
      const chainReady = (ancestorsByItem.get(id) ?? []).every((a) => ownReady.get(a) !== false);
      ready.set(id, selfReady && chainReady);
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
   * Is a work item FINISHABLE? (Subtask 7.8.23) — the single-item analogue of
   * `sprintsService.validateSprint`, with the target's SUBTREE playing the role
   * of the sprint. The target may be any non-leaf kind (epic / story / task /
   * bug — a `subtask` is the leaf). VALID ⟺ for EVERY not-`done` item in the
   * subtree (the target + every live descendant), every `blocked_by` dependency
   * is SATISFIED: it is itself IN the subtree (the target's own work — never
   * gates), or — under `condition: 'loose'` (the default) — already `done`.
   * Under `tight`, a `done` dependency OUTSIDE the subtree no longer satisfies
   * (the subtree must be self-contained). A not-done out-of-subtree dependency
   * gates under both. The parent→child completion cascade is automatic: a child
   * is always in the subtree, so it never gates — its own out-of-subtree
   * blockers surface when the child itself is checked.
   *
   * A pure READ gated like `get_work_item` (tenant gate + `assertCanBrowse` via
   * `getWorkItemByIdentifier`, throwing `WorkItemNotFoundError` for an unknown /
   * cross-workspace key). "Done" is the project's terminal set (`category =
   * 'done'`; finding #21), judged against each blocker's OWN project (blocks can
   * be cross-project). Archived/triage members and archived blockers are ignored.
   */
  async validateWorkItem(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
    condition: ValidityCondition = DEFAULT_VALIDITY_CONDITION,
  ): Promise<WorkItemValidityDto> {
    const root = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);
    return computeWorkItemValidity(root, ctx, condition);
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
      watcherCount,
      viewerIsWatching,
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
      // The header eye-count + the caller's own watch state (5.4.4) — two
      // point reads riding the same fan-out, so the watch control renders
      // from the detail read with no extra round-trip.
      watcherRepository.countByWorkItem(item.id),
      watcherRepository.existsFor(item.id, ctx.userId),
    ]);

    const [
      blockerRows,
      blockingRows,
      relatesRows,
      duplicatesRows,
      clonesRows,
      readiness,
      archivedActor,
    ] = await Promise.all([
      workItemRepository.findByIds(blockedByLinks.map((l) => l.toId)),
      workItemRepository.findByIds(blocksLinks.map((l) => l.fromId)),
      workItemRepository.findByIds(relatesLinks.map((l) => l.toId)),
      workItemRepository.findByIds(duplicatesLinks.map((l) => l.toId)),
      workItemRepository.findByIds(clonesLinks.map((l) => l.toId)),
      this.getReadiness(item.id, ctx),
      // Who archived it (2.9.6) — ONLY for an archived item; an active item
      // skips the read entirely (no extra round-trip on the common path). The
      // banner names the actor from this; the timestamp rides `item.archivedAt`.
      item.archivedAt
        ? workItemRevisionRepository.findLatestArchivedActor(item.id)
        : Promise.resolve(null),
    ]);

    const ancestors = ancestorRows.map(toWorkItemSummaryDto);
    const blockedBy = toRelationshipLinks(blockedByLinks, blockerRows, 'toId');
    const openBlockers = blockedBy
      .filter((l) => readiness.openBlockerIds.has(l.item.id))
      .map((l) => l.item);
    // The cascade cause (7.0.13): resolve the nearest own-blocked ancestor id
    // back to its summary from the breadcrumb chain we already loaded (no extra
    // read). null when the item isn't held by a blocked ancestor.
    const blockedByAncestor =
      readiness.blockedByAncestorId === null
        ? null
        : (ancestors.find((a) => a.id === readiness.blockedByAncestorId) ?? null);

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
      readiness: { ready: readiness.ready, openBlockers, blockedByAncestor },
      workflow,
      labels: labelRows.map(toLabelDto),
      components: componentRows.map(toComponentDto),
      customFields: customFieldRows.map(toCustomFieldWithValueDto),
      watcherCount,
      viewerIsWatching,
      archivedBy: archivedActor,
    };
  },

  /**
   * The condensed QUICK-VIEW (peek) payload for `?peek=<identifier>` (Subtask
   * 2.5.19; bug 8.8.2 made the peek a client-fetched island). Reuses the SAME
   * aggregate read the full detail page uses (`getIssueDetail` — inheriting its
   * workspace gate + `assertCanBrowse` + not-found path, so a stale / deleted /
   * cross-workspace / forbidden key throws `WorkItemNotFoundError` /
   * `ProjectAccessDeniedError`, which the route renders as the not-found panel —
   * never an existence leak), then resolves assignee/reporter names + status /
   * due / estimate labels server-side so the client panel stays presentational.
   * The full field set (8.8.8) rides the SAME detail read; the only extra read
   * is the committed sprint's NAME (`sprintId` is on the detail item but its
   * name is not), and only when the item is actually in a sprint.
   */
  async getQuickView(
    projectId: string,
    identifier: string,
    accessLevel: 'open' | 'limited' | 'private' | 'public',
    ctx: ServiceContext,
    locale: Locale,
  ): Promise<QuickViewData> {
    const [detail, members] = await Promise.all([
      this.getIssueDetail(projectId, identifier, ctx),
      assignableMembersService.list({ projectId, accessLevel, ctx }),
    ]);
    // Resolve the committed sprint's display name (8.8.8) — the one rail field
    // not carried by the detail aggregate. Epics span sprints, so the rail omits
    // the field for them (Jira-faithful, mirroring the detail rail); skip the
    // lookup for an epic or a backlog item.
    let sprintName: string | null = null;
    if (detail.item.sprintId && detail.item.kind !== 'epic') {
      const sprint = await sprintRepository.findById(detail.item.sprintId, ctx.workspaceId);
      sprintName = sprint?.name ?? null;
    }
    return toQuickViewData(detail, members, locale, sprintName);
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
   * Candidate target issues for the CREATE-modal link picker (Subtask 2.4.10,
   * server-search since 6.9.2). Like {@link listLinkCandidates} but there is no
   * current item yet (the issue isn't created), so nothing is excluded
   * server-side beyond tenancy + permission — the modal drops already-pending
   * targets client-side (direction-aware, per chosen relationship). Delegates to
   * the 6.9.1 {@link quickSearch}: a `query`-driven, key + title, workspace +
   * 6.4-permission-scoped, bounded read over the `pg_trgm` index — NOT the old
   * newest-50 window (finding #98). An empty / short query returns `[]` (the
   * picker prompts "type to search"); the Combobox fetches per keystroke.
   */
  async listCreateLinkCandidates(
    query: string,
    ctx: ServiceContext,
  ): Promise<WorkItemSummaryDto[]> {
    return this.quickSearch(query, ctx);
  },

  /**
   * Candidate targets for the link picker (Subtask 2.4.9; server-search since
   * 6.9.2 — closes finding #98). Tenant-gates the current item (cross-workspace /
   * missing → 404), computes the direction-aware exclusion set (the item itself +
   * any already linked to it by the chosen relationship, so the picker won't
   * offer a duplicate; the trigger still backstops a forged one), then delegates
   * to the 6.9.1 {@link quickSearch} with that exclusion set. The result is a
   * `query`-driven, key + title, workspace + 6.4-permission-scoped, bounded read
   * over the `pg_trgm` index — NOT a newest-50 window filtered client-side (which
   * left ~88% of a real tenant unreachable by search). An empty / short query
   * returns `[]`; the picker's Combobox fetches per keystroke and re-fetches when
   * the relationship changes (the exclusion set is direction-aware).
   */
  async listLinkCandidates(
    currentItemId: string,
    relationship: RelationshipKind,
    query: string,
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

    return this.quickSearch(query, ctx, { excludeIds: [currentItemId, ...linkedIds] });
  },

  /**
   * Reusable server-side issue quick-search (Subtask 6.9.1) — the shared read
   * the link pickers (6.9.2) and, later, the cmd-K palette consume. Trims and
   * guards the query (empty / whitespace / shorter than
   * {@link QUICK_SEARCH_MIN_QUERY_LENGTH} → `[]` with NO DB round-trip);
   * resolves the actor's BROWSABLE project set (the Story 6.4 gate — the SAME
   * `projectAccessService.filterBrowsable` the switcher / nav ride) so a user
   * only ever finds issues in projects they may read; then runs the bounded,
   * relevance-ordered key + title search scoped to that set, capped at
   * {@link QUICK_SEARCH_DEFAULT_LIMIT} (or a caller-supplied `limit`, itself
   * ceilinged at {@link QUICK_SEARCH_MAX_LIMIT}; finding #57 — never unbounded).
   * `opts.excludeIds` drops specific rows (6.9.2's link picker passes self +
   * already-linked). Returns the lighter {@link WorkItemSummaryDto}. No route is
   * wired by THIS subtask — 6.9.2 calls it behind the existing link action.
   */
  async quickSearch(
    query: string,
    ctx: ServiceContext,
    opts: { limit?: number; excludeIds?: string[] } = {},
  ): Promise<WorkItemSummaryDto[]> {
    const trimmed = query.trim();
    if (trimmed.length < QUICK_SEARCH_MIN_QUERY_LENGTH) return [];
    const limit = Math.min(
      QUICK_SEARCH_MAX_LIMIT,
      Math.max(1, opts.limit ?? QUICK_SEARCH_DEFAULT_LIMIT),
    );
    // The Story 6.4 gate, batched (one workspace-role + one membership query —
    // no N+1), so the search only ever spans projects the actor may browse.
    const projects = await projectRepository.findByWorkspace(ctx.workspaceId);
    const browsable = await projectAccessService.filterBrowsable(projects, ctx);
    if (browsable.length === 0) return [];
    const rows = await workItemRepository.quickSearch(
      ctx.workspaceId,
      browsable.map((p) => p.id),
      trimmed,
      limit,
      opts.excludeIds ?? [],
    );
    return rows.map(toWorkItemSummaryDto);
  },

  /**
   * The READY SET of a project (Subtask 7.0.2 + 7.0.13) — the AI dispatch
   * surface's list read, cursor-paginated, returning the 7.0.3 `ReadyItemDto`s.
   *
   * A work item is in the ready set when it is a DISPATCHABLE LEAF that is READY:
   *   - **Leaf** — it has NO children. A childed story/epic is *planned* (broken
   *     down), so it is never listed; a childless story/epic IS listed ("ready to
   *     plan"), a childless subtask/task/bug "ready to do" (Subtask 7.0.10).
   *   - **`todo` status** — a ready item is one to START (`in_progress`/`done`
   *     excluded).
   *   - **Ready (cascade, 7.0.13)** — its own `is_blocked_by` blockers are all
   *     terminal in their own project AND every ANCESTOR is ready.
   *
   * Computed TOP-DOWN, by layer (NOT a whole-table scan): start at the roots,
   * keep the ready ones, descend ONLY into ready containers, collect ready
   * childless `todo` leaves — so a not-ready or fully-planned-out branch is never
   * read (`collectReadyLeaves`). The full ready-leaf set is then sorted
   * `(type asc, priority desc, key asc)` and sliced by the cursor seek-after.
   * Tenant gate first (cross-workspace / missing → `ProjectNotFoundError` → 404).
   * A malformed cursor throws `InvalidReadyCursorError` (→ 400); a cursor past the
   * tail returns `[]`. The list is empty ONLY when the project has no ready work
   * — count and list can never disagree (the 7.0.13 empty-list-with-count fix).
   */
  async listReady(
    projectId: string,
    filter: ReadyListFilter,
    ctx: ServiceContext,
  ): Promise<{ items: ReadyItemDto[]; nextCursor: string | null }> {
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    const limit = clampReadyLimit(filter.limit);
    const cursor = filter.cursor ? decodeReadyCursor(filter.cursor) : undefined;
    const all = await collectReadyLeaves(projectId, project.workspaceId, ctx, filter);
    const start = cursor ? all.findIndex((r) => isAfterReadyCursor(r, cursor)) : 0;
    const begin = start === -1 ? all.length : start;
    const window = all.slice(begin, begin + limit);
    const more = begin + window.length < all.length;
    const last = window.at(-1);
    const nextCursor =
      more && last
        ? encodeReadyCursor({ kind: last.kind, priority: last.priority, key: last.key })
        : null;
    return { items: window.map((r) => toReadyItemDto(r, rowReadyContext(r))), nextCursor };
  },

  /**
   * Dispatch ONE ready item (Subtask 7.0.2) — the BYOK `motir run` consumer of
   * `POST /api/ready/next`. The FIRST ready leaf under `(type asc, priority desc,
   * key asc)` not in `excludeIds`, as the full `ReadyItemDispatchDto`, or `null`
   * when the filtered ready set is exhausted. Same top-down ready set as
   * `listReady` (they can never disagree).
   */
  async getNextReady(
    projectId: string,
    filter: Omit<ReadyListFilter, 'limit' | 'cursor'> & { excludeIds?: string[] },
    ctx: ServiceContext,
  ): Promise<ReadyItemDispatchDto | null> {
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    const exclude = new Set(filter.excludeIds ?? []);
    const all = await collectReadyLeaves(projectId, project.workspaceId, ctx, filter);
    const chosen = all.find((r) => !exclude.has(r.id));
    return chosen ? buildReadyDispatchDto(chosen, ctx) : null;
  },

  /**
   * `claim_next_ready` (MOTIR-1330) — the ATOMIC, race-safe dispatch claim.
   * Compute the project's ready leaves (the SAME source `listReady` /
   * `getNextReady` derive), scope them to the active `sprintId` when one is given
   * (or take the WHOLE project when `sprintId` is `null` — Motir used without
   * sprints), keep the dispatch rank, then — in ONE transaction — LOCK the best
   * still-claimable
   * candidate (`FOR UPDATE SKIP LOCKED`) and flip it `→ in_progress`. Two
   * concurrent callers therefore claim DIFFERENT items (or one gets the item and
   * the other `null`): there is no read-then-flip-later window for them to both
   * grab the same Subtask, which the old "compute ready set, then
   * `transition_status`" dispatch had. Returns the dispatch payload for the
   * claimed item (status now `in_progress`), or `null` when the active-sprint
   * ready set is empty OR every candidate was already locked — the caller RETRIES
   * on `null`. The flip records a revision and emits `work-item/transitioned`
   * AFTER commit, exactly like `updateStatus` (the 5.1.2 rule).
   */
  async claimNextReady(
    projectId: string,
    sprintId: string | null,
    ctx: ServiceContext,
  ): Promise<ReadyItemDispatchDto | null> {
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    // The project's ready leaves in dispatch rank order (priority encodes the
    // in-sprint leverage `motir plan sprint` re-ranks to — so this rank IS
    // "most-unblocking first"). When an active `sprintId` is given, scope to it
    // (sprint discipline); when `null` — Motir used WITHOUT sprints (plain
    // Kanban) — claim across the WHOLE project, since a missing sprint is not an
    // error.
    const ready = await collectReadyLeaves(projectId, project.workspaceId, ctx, {});
    const candidates = sprintId ? ready.filter((r) => r.sprintId === sprintId) : ready;
    if (candidates.length === 0) return null;
    const orderedIds = candidates.map((r) => r.id);

    const claimed = await db.$transaction(async (tx) => {
      const locked = await workItemRepository.claimNextReadyCandidate(orderedIds, tx);
      if (!locked) return null;
      // `in_progress` is the dispatch state (lib/workflows/defaultWorkflow.ts);
      // `applyStatusTransition` validates the todo|blocked → in_progress edge,
      // records the revision, and re-locks the row under the same tx.
      return workItemsService.applyStatusTransition(locked.id, 'in_progress', ctx, tx);
    });
    if (!claimed) return null;

    if (claimed.transition) {
      await sendEvent('work-item/transitioned', {
        workspaceId: ctx.workspaceId,
        workItemId: claimed.dto.id,
        actorId: ctx.userId,
        fromStatusKey: claimed.transition.fromStatusKey,
        toStatusKey: claimed.transition.toStatusKey,
        revisionId: claimed.transition.revisionId,
      });
    }

    // Build the dispatch payload from the claimed candidate row, reflecting the
    // post-claim status (now in the `in_progress` category).
    const chosen = candidates.find((r) => r.id === claimed.dto.id)!;
    const dispatch = await buildReadyDispatchDto(chosen, ctx);
    return { ...dispatch, status: { key: claimed.dto.status, category: 'in_progress' } };
  },

  /**
   * The READY COUNT (Subtask 7.0.6) — how many work items are ready to start in
   * the project, under the SAME top-down predicate `listReady` uses, so the count
   * can never disagree with the list (the bug the 7.0.13 rework fixed). Resolved
   * only when the /ready page loads — the every-authed-route sidebar badge was
   * removed (the count was a computed scan on every navigation). Exact (the
   * layered traversal is bounded by tree depth), so `hasMore` is always false.
   */
  async countReady(
    projectId: string,
    filter: Omit<ReadyListFilter, 'limit' | 'cursor'>,
    ctx: ServiceContext,
  ): Promise<{ count: number; hasMore: boolean }> {
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    const all = await collectReadyLeaves(projectId, project.workspaceId, ctx, filter);
    return { count: all.length, hasMore: false };
  },

  /**
   * Set or unset an epic's `publicChildrenHidden` privacy flag (Story 6.14 ·
   * Subtask 6.14.7 — the admin-gated write path that turns epic privacy on/off).
   * Per the epic-privacy ADR (§1, §5):
   *
   *   - **Epic-only** — the flag is meaningful ONLY on an epic-kind item; a
   *     non-epic target is REJECTED with `NotEpicError` (422), not silently
   *     coerced to a no-op, so a caller bug surfaces.
   *   - **Project-admin only** — set/unset is gated to the project admin,
   *     reusing the SAME 6.4 gate as `customFieldsService` /
   *     `projectMembersService` (workspace owner/admin always pass, else a
   *     project membership with role `admin`); everyone else → 403
   *     (`NotProjectAdminError`). No new permission is introduced.
   *
   * The write is the single `publicChildrenHidden` column. It records NO
   * activity revision — an admin visibility setting is not a content edit on the
   * issue's history feed (and keeping it out of the revision diff keeps the
   * activity totality-guard registry untouched). The 6.14.4 server-side
   * exclusion is what gives the flag its effect on public reads; this method
   * only owns the authoritative write + the gates.
   *
   * Throws: `WorkItemNotFoundError` (404 — unknown / cross-workspace item),
   * `NotProjectAdminError` (403 — non-admin), `NotEpicError` (422 — non-epic).
   */
  async setEpicPrivacy(
    id: string,
    publicChildrenHidden: boolean,
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    return db.$transaction(async (tx) => {
      // Lock + re-read under the lock (mirrors updateWorkItem): two concurrent
      // toggles serialize on the FOR UPDATE lock, and the explicit workspace
      // check is the finding-#26 tenant gate (a cross-workspace item is an
      // indistinguishable 404, primary even under the dev/CI BYPASSRLS role).
      const locked = await workItemRepository.lockById(id, tx);
      if (!locked) throw new WorkItemNotFoundError(id);
      const current = await workItemRepository.findById(id, tx);
      if (!current || current.workspaceId !== ctx.workspaceId) {
        throw new WorkItemNotFoundError(id);
      }

      // Project-admin gate (ADR §5) — the SAME 6.4 check the members / custom
      // fields admin writes use. Inside the tx so it shares the lock's snapshot.
      await assertCanManageProject(ctx.userId, ctx.workspaceId, current.projectId, tx);

      // Epic-only (ADR §1) — reject a non-epic target rather than no-op'ing it.
      if (current.kind !== 'epic') throw new NotEpicError(current.kind);

      // No-op when unchanged — skip the write (and the `updatedAt` bump) so a
      // re-set of the same value is idempotent.
      if (current.publicChildrenHidden === publicChildrenHidden) {
        return toWorkItemDto(current);
      }

      const row = await workItemRepository.update(id, { publicChildrenHidden }, tx);
      return toWorkItemDto(row);
    });
  },
};

/**
 * The project-management gate (Story 6.4) — workspace owner/admin always pass
 * (`isWorkspaceManager`), otherwise the actor needs a project membership with
 * role `admin`; everyone else → `NotProjectAdminError` (403). This is the SAME
 * decision `projectMembersService.assertCanManage` /
 * `customFieldsService.assertCanManage` enforce — replicated here (not imported)
 * to keep the small gate a leaf the work-items domain owns, the established
 * per-service pattern. Reuses no new permission.
 */
async function assertCanManageProject(
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

// Quick-search bounds (Subtask 6.9.1) live in the pure `lib/workItems/quickSearch`
// module so the client link pickers (6.9.2) can import them too; re-exported here
// (the bindings are imported at the top) for existing importers + tests that
// source them from the service.
export { QUICK_SEARCH_DEFAULT_LIMIT, QUICK_SEARCH_MAX_LIMIT, QUICK_SEARCH_MIN_QUERY_LENGTH };

/** Max layers `collectReadyLeaves` descends (Subtask 7.0.13). The kind-parent
 *  matrix caps real tree depth at 5 (epic→story→task→bug→subtask); the generous
 *  bound is a backstop against a malformed cycle, never reached normally. */
const READY_MAX_TREE_DEPTH = 8;

/**
 * The project's dispatchable ready leaves, computed TOP-DOWN by layer (Subtask
 * 7.0.13) — the single source `listReady` / `getNextReady` / `countReady` derive
 * from (so they can never disagree). Start at the ROOTS; each layer, keep the
 * OWN-ready nodes (their own blockers done — `computeOwnBlockerReadiness`),
 * DESCEND into the ready CONTAINERS (fetch their children = the next layer) and
 * COLLECT the ready, childless, `todo` leaves. Because we only ever fetch the
 * children of nodes already known ready, a not-ready or fully-planned-out branch
 * is NEVER read (the cost win over the old whole-table candidate scan), and a
 * leaf is reached only via an all-ready ancestor chain — the cascade, equivalent
 * to the bottom-up `getReadinessForItems` the board/detail use per-item. The
 * faceted axes (kind / assignee / priority) narrow the COLLECTED leaves only —
 * the traversal ignores them so a matching leaf under a non-matching ancestor is
 * still reachable. Returned sorted `(type asc, priority desc, key asc)`.
 */
async function collectReadyLeaves(
  projectId: string,
  workspaceId: string,
  ctx: ServiceContext,
  facets: { kinds?: WorkItemKind[]; assigneeId?: string | null; priority?: WorkItemPriority[] },
): Promise<ReadyLayerRow[]> {
  const leaves: ReadyLayerRow[] = [];
  let frontier = await workItemRepository.findReadyLayer(projectId, workspaceId, null);
  for (let depth = 0; depth < READY_MAX_TREE_DEPTH && frontier.length > 0; depth++) {
    const ownReady = await computeOwnBlockerReadiness(
      frontier.map((r) => r.id),
      ctx,
    );
    const descend: string[] = [];
    for (const row of frontier) {
      if (ownReady.get(row.id) === false) continue; // not ready → prune the subtree
      if (row.hasChildren)
        descend.push(row.id); // ready container → descend
      else if (row.statusCategory === 'todo') leaves.push(row); // ready, childless, to-start
    }
    frontier = descend.length
      ? await workItemRepository.findReadyLayer(projectId, workspaceId, descend)
      : [];
  }
  let out = leaves;
  if (facets.kinds && facets.kinds.length > 0) {
    const set = new Set<string>(facets.kinds);
    out = out.filter((r) => set.has(r.kind));
  }
  if (facets.priority && facets.priority.length > 0) {
    const set = new Set<string>(facets.priority);
    out = out.filter((r) => set.has(r.priority));
  }
  if (facets.assigneeId === null) out = out.filter((r) => r.assigneeId === null);
  else if (facets.assigneeId !== undefined) {
    out = out.filter((r) => r.assigneeId === facets.assigneeId);
  }
  out.sort(compareReadyRows);
  return out;
}

/** Order two ready leaves under the dispatch sort `(type asc, priority desc, key
 *  asc)`: `READY_KIND_RANK` (subtask first … epic last) is primary, priority
 *  (highest first) breaks the type tie, `key` breaks the rest. The ONE comparator
 *  the list slice and the cursor seek-after share, so they can't drift. */
function compareReadyRows(
  a: { kind: WorkItemKind; priority: WorkItemPriority; key: number },
  b: { kind: WorkItemKind; priority: WorkItemPriority; key: number },
): number {
  const dk = READY_KIND_RANK[a.kind] - READY_KIND_RANK[b.kind];
  if (dk !== 0) return dk;
  const dp = READY_PRIORITY_ASC.indexOf(b.priority) - READY_PRIORITY_ASC.indexOf(a.priority);
  if (dp !== 0) return dp;
  return a.key - b.key;
}

/** True when `row` sorts STRICTLY AFTER `cursor` under {@link compareReadyRows} —
 *  the seek-after that resumes the next page just past the cursor's
 *  (kind, priority, key). */
function isAfterReadyCursor(
  row: { kind: WorkItemKind; priority: WorkItemPriority; key: number },
  cursor: ReadyCursor,
): boolean {
  return compareReadyRows(row, cursor) > 0;
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
 * the parent key, the resolved blocker keys, the `contextRefs` parsed from the
 * body's `## Context refs` section (finding #62 — Motir stores refs in
 * `descriptionMd`, not a column; this supplies REAL paths into the 7.0.3
 * mapper's `contextRefs` input instead of the `[]` placeholder), and the
 * INHERITED `sessionBranch` (Subtask 7.8.11 — the single branch this item's
 * integrated-awaiting-review deps live on, so 7.6's GIT-WORKFLOW prompt variant
 * tells the agent to branch from / integrate into it). For a READY item the
 * blockers are all SATISFIED — terminal OR integrated on that one branch — the
 * dependency story the agent's prompt tells. `getReadiness` is the single source
 * of the inherited branch (it ignores a terminal blocker's stale branch and
 * collapses the one integrated lineage); a ready item can never span >1 branch.
 * The candidate row carries the full `WorkItem` body, so no re-read for it.
 */
async function buildReadyDispatchDto(
  row: ReadyCandidateRow,
  ctx: ServiceContext,
): Promise<ReadyItemDispatchDto> {
  const [parentRow, blockerLinks, readiness] = await Promise.all([
    row.parentId ? workItemRepository.findById(row.parentId) : Promise.resolve(null),
    workItemLinkRepository.findByFromItem(row.id, 'is_blocked_by'),
    workItemsService.getReadiness(row.id, ctx),
  ]);
  const blockerRows = (await workItemRepository.findByIds(blockerLinks.map((l) => l.toId)))
    .slice()
    .sort(byKeyAsc);

  const dispatchCtx: ReadyDispatchContext = {
    ...rowReadyContext(row),
    parent: parentRow ? { identifier: parentRow.identifier } : null,
    contextRefs: extractContextRefs(row.descriptionMd),
    sessionBranch: readiness.inheritedSessionBranch,
  };
  return toReadyItemDispatchDto(row, blockerRows, dispatchCtx);
}

/** A blocker row as the readiness classifier needs it — its status + project
 *  (for the per-project terminal check) and its integration `sessionBranch`. */
export interface BlockerReadinessState {
  status: string;
  projectId: string;
  sessionBranch: string | null;
}

/** Whether a single blocker is still OPEN — neither terminal (status in its
 *  project's `category=done` set) nor integrated-awaiting-review (a recorded
 *  `sessionBranch`). The shared open-predicate `getReadiness` reuses to name the
 *  open blocker ids and `classifyBlockerReadiness` reuses to decide readiness. */
function isOpenBlocker(
  blocker: BlockerReadinessState,
  terminalByProject: Map<string, Set<string>>,
): boolean {
  const terminal = terminalByProject.get(blocker.projectId)?.has(blocker.status) ?? false;
  return !terminal && !blocker.sessionBranch;
}

/**
 * Classify a work item's blockers under the integrated-dep readiness rule
 * (Subtask 7.8.11). A blocker is SATISFIED when it is TERMINAL (status in its
 * project's `category=done` set) OR INTEGRATED-awaiting-review (a recorded
 * `sessionBranch`); otherwise it is OPEN. Every integrated blocker contributes
 * its branch to the item's lineage set: an item whose integrated deps span MORE
 * THAN ONE session branch has CONFLICTING lineages and is NOT ready (a human
 * must merge one session PR first). The single shared lineage (when exactly one)
 * is what the dispatch payload inherits. A terminal blocker's branch is IGNORED
 * (reaching done clears it; ignoring it keeps the rule correct even if that
 * invariant were ever violated). PURE — the single source of the rule, reused by
 * `getReadiness` (single) and `getReadinessForItems` (batch).
 */
export function classifyBlockerReadiness(
  blockers: BlockerReadinessState[],
  terminalByProject: Map<string, Set<string>>,
): {
  ready: boolean;
  sessionBranches: string[];
  inheritedSessionBranch: string | null;
  conflicting: boolean;
} {
  let hasOpenBlocker = false;
  const branches = new Set<string>();
  for (const b of blockers) {
    const terminal = terminalByProject.get(b.projectId)?.has(b.status) ?? false;
    if (terminal) continue; // satisfied; a done blocker contributes no lineage
    if (b.sessionBranch) {
      branches.add(b.sessionBranch); // integrated — satisfied, carries its lineage
      continue;
    }
    hasOpenBlocker = true; // truly open
  }
  const sessionBranches = [...branches].sort();
  const conflicting = sessionBranches.length > 1;
  const inheritedSessionBranch = sessionBranches.length === 1 ? sessionBranches[0]! : null;
  return {
    ready: !hasOpenBlocker && !conflicting,
    sessionBranches,
    inheritedSessionBranch,
    conflicting,
  };
}

/**
 * OWN-blocker readiness for a set of items (Subtask 7.0.13) — `id → ready` where
 * ready means "this node's own `is_blocked_by` blockers are all satisfied"
 * (terminal or integrated-awaiting-review), with NO ancestor cascade. This is
 * the per-node leg the readiness verdict is built from: `getReadinessForItems`
 * (batch) and `getReadiness` (single) call it over the item ∪ ancestor set, then
 * AND each node with its ancestor chain to get the cascaded verdict. Extracted
 * so the two entry points share ONE blocker classification (no drift). One
 * blocker query + one terminal-set query regardless of item count (no N+1); an
 * item with no blockers stays `true`.
 */
async function computeOwnBlockerReadiness(
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
  // Group each item's blockers, then classify per item (an item is ready iff it
  // has no open blocker AND its integrated deps don't span >1 branch).
  const byItem = new Map<string, BlockerReadinessState[]>();
  for (const b of blockers) {
    const arr = byItem.get(b.fromId);
    if (arr) arr.push(b);
    else byItem.set(b.fromId, [b]);
  }
  for (const [fromId, itemBlockers] of byItem) {
    ready.set(fromId, classifyBlockerReadiness(itemBlockers, terminalByProject).ready);
  }
  return ready;
}

/**
 * Compute a work item's finishability (Subtask 7.8.23) — the engine behind
 * `validateWorkItem`, given an already-resolved root. See the method's doc for
 * the rule. The "containing set" is the root's SUBTREE (root + live
 * descendants); the structure mirrors `computeSprintValidity` with that set
 * standing in for the sprint, but is SIMPLER: a subtree is closed under
 * descendants, so a member's children are always in-set (the parent→child
 * cascade is auto-satisfied) and only `blocked_by` edges can gate. We probe the
 * not-done members' direct blockers (no ancestor walk — finishing the target's
 * subtree does not depend on work ABOVE it), and report each unsatisfied
 * out-of-subtree blocker at the in-subtree member it gates.
 */
async function computeWorkItemValidity(
  root: WorkItemDto,
  ctx: ServiceContext,
  condition: ValidityCondition,
): Promise<WorkItemValidityDto> {
  // The containing set S: the root + every non-archived descendant.
  const members = await workItemRepository.findSubtreeMembersForValidity(root.id, ctx.workspaceId);
  const memberIds = new Set(members.map((m) => m.id));
  const membersById = new Map(members.map((m) => [m.id, m]));

  // Only NOT-done members need a finishability check. Parent↔child is
  // same-project, so the root's terminal set classifies every member.
  const terminalForProject = await workflowsService.getTerminalStatusKeys(
    root.projectId,
    ctx.workspaceId,
  );
  const notDone = members.filter((m) => !terminalForProject.has(m.status));
  if (notDone.length === 0) {
    return { key: root.identifier, valid: true, blockers: [] };
  }

  const edges = await workItemLinkRepository.findBlockerEdgesForItems(notDone.map((m) => m.id));
  // Per-project terminal sets — a block can be cross-project, so each blocker's
  // done-ness is judged against its OWN project (finding #21).
  const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
    edges.map((e) => e.blockerProjectId),
    ctx.workspaceId,
  );

  const blockers: SprintBlockerDto[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    const inSubtree = memberIds.has(edge.blockerId);
    const isDone = terminalByProject.get(edge.blockerProjectId)?.has(edge.blockerStatus) ?? false;
    if (gatingItemSatisfied(inSubtree, isDone, condition)) continue;
    const member = membersById.get(edge.fromId);
    if (!member) continue;
    const key = `${member.identifier} ${edge.blockerKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    blockers.push({
      item: member.identifier,
      blockedBy: edge.blockerKey,
      blockerStatus: edge.blockerStatus,
      blockerSprintId: edge.blockerSprintId,
    });
  }
  // Deterministic order (by gated item, then blocker) for a stable wire shape.
  blockers.sort((a, b) => a.item.localeCompare(b.item) || a.blockedBy.localeCompare(b.blockedBy));
  return { key: root.identifier, valid: blockers.length === 0, blockers };
}
