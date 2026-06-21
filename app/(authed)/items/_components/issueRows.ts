import type {
  WorkItemKindDto,
  WorkItemListItemDto,
  WorkItemPriorityDto,
  WorkItemTreeNodeDto,
  WorkItemTypeDto,
} from '@/lib/dto/workItems';
import type { StatusCategoryDto, WorkflowStatusDto, WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { TreeTableRow } from '@/components/ui/TreeTable';
import { formatDate } from '@/lib/utils/datetime';
import { formatDurationMinutes } from '@/lib/utils/duration';
import { formatStoryPoints } from '@/lib/estimation/scales';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';

// Pure view-shaping for the /items list route (Subtask 2.5.3): turn the
// `getProjectTree` forest (2.5.1) into the serializable nested-row model the
// client TreeTable renders. Resolving the status (key → label + category for
// the Pill tone) and the assignee (id → display name) happens HERE, on the
// server, against the project workflow + workspace members the page already
// loads — so the client receives plain data, not the whole workflow/member
// tables, and the render-props in IssueTreeTable stay trivial. Kept Prisma-free
// and React-free so it unit-tests in isolation (the AC's "page data shaping").

/** The row payload the TreeTable cells render. Fully serializable. */
export interface IssueRowData {
  /** The work-item id — the target of the inline-edit Server Actions (2.5.5). */
  id: string;
  identifier: string;
  title: string;
  /** Drives the type-hued IssueTypeIcon. */
  kind: WorkItemKindDto;
  /** The leaf's work TYPE (Story 2.7) → the Type-column `WorkItemTypeChip`
   *  (Subtask 8.8.9); `null` on containers (epic/story) → a muted em-dash. */
  type: WorkItemTypeDto | null;
  /** The raw workflow status KEY (not the label) — what the inline StatusPicker
   *  edits + `changeStatusAction` commits (2.5.5); `statusLabel` is its display. */
  status: string;
  /** Human status label (workflow label, or the raw key as a fallback). */
  statusLabel: string;
  /**
   * The status's lifecycle category → the Pill tone. `null` when the project's
   * bundled workflow can't classify the key (a defensive fallback → neutral
   * Pill showing the raw key), mirroring the detail page's ChildList.
   */
  statusCategory: StatusCategoryDto | null;
  /** The raw assignee userId (or null) — what the inline AssigneePicker edits +
   *  `updateIssueAction` commits (2.5.5); `assigneeName` is its display. */
  assigneeId: string | null;
  /** Resolved assignee display name, or null when unassigned. */
  assigneeName: string | null;
  /** ISO-8601 last-modified stamp — the `expectedUpdatedAt` the inline assignee
   *  edit submits for optimistic concurrency (2.5.5). */
  updatedAt: string;
  /** Priority value → the shared PRIORITY_META chip; the raw value the inline
   *  PriorityPicker edits (2.5.5). */
  priority: WorkItemPriorityDto;
  /** Resolved reporter display name (a reporter is always set). */
  reporterName: string;
  /** Raw due date (ISO-8601) or null — what the inline DatePicker edits (2.5.5). */
  dueDate: string | null;
  /** Pre-formatted due date ("Jun 4, 2026"), or null when none. */
  dueLabel: string | null;
  /** Raw estimate in whole minutes or null — what the inline estimate field edits (2.5.5). */
  estimateMinutes: number | null;
  /** Pre-formatted estimate ("2h 30m"), or null when unestimated. */
  estimateLabel: string | null;
  /** Raw story-point estimate or null — what the inline `EstimateBadge` edits (4.3.4). */
  storyPoints: number | null;
  /** Pre-formatted story points ("5", "0.5"), or null when unestimated. */
  storyPointsLabel: string | null;
  /**
   * Whether this row has descendants (Subtask 4.3.5) — drives the Points
   * column's epic/parent subtree roll-up badge (a parent shows the rolled-up
   * subtree total instead of its own estimate; a leaf shows its own estimate).
   * Carried by the tree DTOs; the flat List item has no hierarchy, so it
   * defaults to `false` (the roll-up is a tree-parent concept — the design's
   * `.trow` form has the expand chevron).
   */
  hasChildren: boolean;
}

/**
 * Shape the project forest into `TreeTableRow<IssueRowData>[]`, preserving the
 * tree's nesting + sibling order. `workflow` classifies each node's status key;
 * `members` resolves each `assigneeId`/`reporterId` to a display name (name,
 * falling back to email). Due date + estimate are formatted here with the same
 * helpers the detail page uses, so the client cell just renders strings. The
 * lookup maps are built once so the walk stays O(n).
 */
/** The lookups both shapers build once: status key → status, user id → name. */
function buildLookups(workflow: WorkflowDto, members: WorkspaceMemberDTO[]) {
  return {
    statusByKey: new Map<string, WorkflowStatusDto>(workflow.statuses.map((s) => [s.key, s])),
    nameById: new Map(members.map((m) => [m.userId, m.name || m.email])),
  };
}

/**
 * Shape ONE item (a tree node or a flat list item — both carry the same render
 * fields) into the `IssueRowData` the cell render-props read. Resolves the
 * status (key → label + category for the Pill tone) and the assignee/reporter
 * (id → display name); formats the due date + estimate. Shared by the Tree
 * (`toIssueRows`) and List (`toIssueListRows`) so a row renders identically in
 * either view.
 */
function shapeRowData(
  // The tree DTOs (`WorkItemTreeNodeDto` / `WorkItemTreeRowDto`) carry
  // `hasChildren`; the flat List item does not — so accept it optionally and
  // default to `false` (no roll-up in the un-nested List).
  item: WorkItemListItemDto & { hasChildren?: boolean },
  statusByKey: Map<string, WorkflowStatusDto>,
  nameById: Map<string, string>,
  locale: Locale,
): IssueRowData {
  const status = statusByKey.get(item.status);
  return {
    id: item.id,
    identifier: item.identifier,
    title: item.title,
    kind: item.kind,
    type: item.type,
    status: item.status,
    statusLabel: status?.label ?? item.status,
    statusCategory: status?.category ?? null,
    assigneeId: item.assigneeId,
    assigneeName: item.assigneeId ? (nameById.get(item.assigneeId) ?? null) : null,
    updatedAt: item.updatedAt,
    priority: item.priority,
    // The reporter always exists; fall back to its id only if the member is
    // somehow missing (e.g. left the workspace) so the cell never blanks.
    reporterName: nameById.get(item.reporterId) ?? item.reporterId,
    dueDate: item.dueDate,
    dueLabel: item.dueDate ? formatDate(item.dueDate, locale) : null,
    estimateMinutes: item.estimateMinutes,
    estimateLabel:
      item.estimateMinutes != null ? formatDurationMinutes(item.estimateMinutes) : null,
    storyPoints: item.storyPoints,
    storyPointsLabel: item.storyPoints != null ? formatStoryPoints(item.storyPoints) : null,
    hasChildren: item.hasChildren ?? false,
  };
}

/**
 * A reusable per-row shaper (Subtask 2.5.14) — builds the status/name lookups
 * ONCE, then maps each `WorkItemListItemDto` / `WorkItemTreeRowDto` to
 * `IssueRowData`. The lazy Tree (IssueTreeTable) needs this on the CLIENT to
 * shape children fetched on expand, so it's exported (the workflow + members
 * cross to the client once; the lazy levels arrive as raw DTOs).
 */
export function makeRowShaper(
  workflow: WorkflowDto,
  members: WorkspaceMemberDTO[],
  locale: Locale = defaultLocale,
): (item: WorkItemListItemDto) => IssueRowData {
  const { statusByKey, nameById } = buildLookups(workflow, members);
  return (item) => shapeRowData(item, statusByKey, nameById, locale);
}

export function toIssueRows(
  nodes: WorkItemTreeNodeDto[],
  workflow: WorkflowDto,
  members: WorkspaceMemberDTO[],
  locale: Locale = defaultLocale,
): TreeTableRow<IssueRowData>[] {
  const { statusByKey, nameById } = buildLookups(workflow, members);

  const shape = (node: WorkItemTreeNodeDto): TreeTableRow<IssueRowData> => ({
    id: node.id,
    data: shapeRowData(node, statusByKey, nameById, locale),
    children: node.children.map(shape),
  });

  return nodes.map(shape);
}

/**
 * The FLAT view-shaping for the List view (Subtask 2.5.8): map the already-
 * sorted `getProjectIssuesList` items into a flat `IssueRowData[]`, preserving
 * the read's order (the DB did the sort — no JS re-sorting). Same per-row
 * resolution as the tree, just un-nested.
 */
export function toIssueListRows(
  items: WorkItemListItemDto[],
  workflow: WorkflowDto,
  members: WorkspaceMemberDTO[],
  locale: Locale = defaultLocale,
): IssueRowData[] {
  const { statusByKey, nameById } = buildLookups(workflow, members);
  return items.map((item) => shapeRowData(item, statusByKey, nameById, locale));
}
