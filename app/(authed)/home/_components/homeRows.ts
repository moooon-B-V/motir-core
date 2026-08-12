import type { HomeWorkItemRowDto } from '@/lib/dto/home';
import type { StatusCategoryDto, WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { WorkItemKindDto } from '@/lib/dto/workItems';

// Pure view-shaping for `/home` (Story MOTIR-2649 · Subtask MOTIR-2653) — the
// same job `app/(authed)/items/_components/issueRows.ts` does for `/items`, one
// scope wider.
//
// Resolving the STATUS (key → label + category, which decides the Pill's tone)
// and the ASSIGNEE (id → display name) happens HERE, on the server, so the
// client list receives plain data rather than the whole workflow and member
// tables. Kept Prisma-free and React-free so it unit-tests in isolation.
//
// ⚠️ ONE WORKFLOW PER PROJECT, and that is the only real difference from the
// `/items` version. `/items` shapes rows against a single project's workflow
// because it IS a single project; Home spans every project the reader can
// browse, and two projects can spell the same lifecycle differently — one's
// `in_progress` may be labelled "In Progress" and another's "Doing". So the
// caller hands in a workflow PER PROJECT and each row resolves against its own.
// Falling back to a shared workflow would render the wrong label the moment a
// second project customises one, and would do it silently.

/** The row payload the client list renders. Fully serializable. */
export interface HomeRowView {
  id: string;
  identifier: string;
  title: string;
  kind: WorkItemKindDto;
  /** The owning project's display name — the Project cell. */
  projectName: string;
  /** The reader's relation to the item — the "Your role" cell. */
  role: HomeRole;
  /** Resolved assignee display name, or null when unassigned. */
  assigneeName: string | null;
  /** Whether an AGENT is executing it — the assignee-avatar badge. */
  agent: boolean;
  /** Human status label (the project's workflow label, or the raw key). */
  statusLabel: string;
  /** Lifecycle category → the Pill tone; null when unclassifiable. */
  statusCategory: StatusCategoryDto | null;
}

/**
 * How the reader relates to this row.
 *
 * `both` is the one that earns the cell: it is the only value not derivable
 * from the Assignee column, and it is the dedupe made visible — the merged
 * assigned-OR-reported read returns such an item ONCE, and this is where a
 * human can see that it did.
 *
 * `watching` is what the Watching tab shows for an item the reader does not
 * own; an item they watch AND own reads `both` there too, which is why the same
 * item legitimately appears in both tabs.
 */
export type HomeRole = 'assigned' | 'reported' | 'both' | 'watching';

function resolveRole(row: HomeWorkItemRowDto, tab: 'work' | 'watching'): HomeRole {
  if (row.viewerIsAssignee && row.viewerIsReporter) return 'both';
  if (row.viewerIsAssignee) return 'assigned';
  if (row.viewerIsReporter) return 'reported';
  // Only reachable on the Watching tab — the My work read's predicate IS
  // assignee-or-reporter, so a row there always matched one of the two above.
  return tab === 'watching' ? 'watching' : 'assigned';
}

export function toHomeRowViews(
  rows: HomeWorkItemRowDto[],
  workflowsByProjectId: ReadonlyMap<string, WorkflowDto>,
  members: WorkspaceMemberDTO[],
  tab: 'work' | 'watching',
): HomeRowView[] {
  const nameByUserId = new Map(members.map((m) => [m.userId, m.name]));
  return rows.map((row) => {
    const status = workflowsByProjectId
      .get(row.project.id)
      ?.statuses.find((s) => s.key === row.status);
    return {
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      kind: row.kind,
      projectName: row.project.name,
      role: resolveRole(row, tab),
      assigneeName: row.assigneeId ? (nameByUserId.get(row.assigneeId) ?? null) : null,
      agent: row.executor === 'coding_agent',
      statusLabel: status?.label ?? row.status,
      statusCategory: status?.category ?? null,
    };
  });
}
