import type {
  WorkItemKindDto,
  WorkItemPriorityDto,
  WorkItemTreeNodeDto,
} from '@/lib/dto/workItems';
import type { StatusCategoryDto, WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { TreeTableRow } from '@/components/ui/TreeTable';
import { formatDate } from '@/lib/utils/datetime';
import { formatDurationMinutes } from '@/lib/utils/duration';

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
export function toIssueRows(
  nodes: WorkItemTreeNodeDto[],
  workflow: WorkflowDto,
  members: WorkspaceMemberDTO[],
): TreeTableRow<IssueRowData>[] {
  const statusByKey = new Map(workflow.statuses.map((s) => [s.key, s]));
  const nameById = new Map(members.map((m) => [m.userId, m.name || m.email]));

  const shape = (node: WorkItemTreeNodeDto): TreeTableRow<IssueRowData> => {
    const status = statusByKey.get(node.status);
    return {
      id: node.id,
      data: {
        identifier: node.identifier,
        title: node.title,
        kind: node.kind,
        statusLabel: status?.label ?? node.status,
        statusCategory: status?.category ?? null,
        assigneeName: node.assigneeId ? (nameById.get(node.assigneeId) ?? null) : null,
        priority: node.priority,
        // The reporter always exists; fall back to its id only if the member is
        // somehow missing (e.g. left the workspace) so the cell never blanks.
        reporterName: nameById.get(node.reporterId) ?? node.reporterId,
        dueLabel: node.dueDate ? formatDate(node.dueDate) : null,
        estimateLabel:
          node.estimateMinutes != null ? formatDurationMinutes(node.estimateMinutes) : null,
      },
      children: node.children.map(shape),
    };
  };

  return nodes.map(shape);
}
