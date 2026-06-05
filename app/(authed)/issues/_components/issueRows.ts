import type {
  WorkItemKindDto,
  WorkItemListItemDto,
  WorkItemPriorityDto,
  WorkItemTreeNodeDto,
} from '@/lib/dto/workItems';
import type { StatusCategoryDto, WorkflowStatusDto, WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { TreeTableRow } from '@/components/ui/TreeTable';
import { formatDate } from '@/lib/utils/datetime';
import { formatDurationMinutes } from '@/lib/utils/duration';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';

// Pure view-shaping for the /issues list route (Subtask 2.5.3): turn the
// `getProjectTree` forest (2.5.1) into the serializable nested-row model the
// client TreeTable renders. Resolving the status (key → label + category for
// the Pill tone) and the assignee (id → display name) happens HERE, on the
// server, against the project workflow + workspace members the page already
// loads — so the client receives plain data, not the whole workflow/member
// tables, and the render-props in IssueTreeTable stay trivial. Kept Prisma-free
// and React-free so it unit-tests in isolation (the AC's "page data shaping").

/** The row payload the TreeTable cells render. Fully serializable. */
export interface IssueRowData {
  identifier: string;
  title: string;
  /** Drives the type-hued IssueTypeIcon. */
  kind: WorkItemKindDto;
  /** Human status label (workflow label, or the raw key as a fallback). */
  statusLabel: string;
  /**
   * The status's lifecycle category → the Pill tone. `null` when the project's
   * bundled workflow can't classify the key (a defensive fallback → neutral
   * Pill showing the raw key), mirroring the detail page's ChildList.
   */
  statusCategory: StatusCategoryDto | null;
  /** Resolved assignee display name, or null when unassigned. */
  assigneeName: string | null;
  /** Priority value → the shared PRIORITY_META chip in the cell. */
  priority: WorkItemPriorityDto;
  /** Resolved reporter display name (a reporter is always set). */
  reporterName: string;
  /** Pre-formatted due date ("Jun 4, 2026"), or null when none. */
  dueLabel: string | null;
  /** Pre-formatted estimate ("2h 30m"), or null when unestimated. */
  estimateLabel: string | null;
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
  item: WorkItemListItemDto,
  statusByKey: Map<string, WorkflowStatusDto>,
  nameById: Map<string, string>,
  locale: Locale,
): IssueRowData {
  const status = statusByKey.get(item.status);
  return {
    identifier: item.identifier,
    title: item.title,
    kind: item.kind,
    statusLabel: status?.label ?? item.status,
    statusCategory: status?.category ?? null,
    assigneeName: item.assigneeId ? (nameById.get(item.assigneeId) ?? null) : null,
    priority: item.priority,
    // The reporter always exists; fall back to its id only if the member is
    // somehow missing (e.g. left the workspace) so the cell never blanks.
    reporterName: nameById.get(item.reporterId) ?? item.reporterId,
    dueLabel: item.dueDate ? formatDate(item.dueDate, locale) : null,
    estimateLabel:
      item.estimateMinutes != null ? formatDurationMinutes(item.estimateMinutes) : null,
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
): (item: WorkItemListItemDto) => IssueRowData {
  const { statusByKey, nameById } = buildLookups(workflow, members);
  return (item) => shapeRowData(item, statusByKey, nameById);
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
