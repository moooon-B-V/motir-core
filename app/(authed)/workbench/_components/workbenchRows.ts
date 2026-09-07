import type { HomeWorkItemRowDto } from '@/lib/dto/home';
import type { StatusCategoryDto, WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { WorkItemKindDto } from '@/lib/dto/workItems';

// Pure view-shaping for `/workbench` (Story MOTIR-2649 · MOTIR-2653, renamed
// and widened by Story MOTIR-4777 · MOTIR-4782) — the
// same job `app/(authed)/items/_components/issueRows.ts` does for `/items`, over
// the same scope: one project, the active one.
//
// Resolving the STATUS (key → label + category, which decides the Pill's tone)
// and the ASSIGNEE (id → display name) happens HERE, on the server, so the
// client list receives plain data rather than the whole workflow and member
// tables. Kept Prisma-free and React-free so it unit-tests in isolation.
//
// ⚠️ THE `tab` ARGUMENT IS A ROLE QUESTION AND NOTHING ELSE. Five tabs read
// through this module and only ONE of them changes what it returns: on Watching
// a row the reader neither assigned nor filed reads `watching`, and on every
// work tab that row cannot occur, because those reads' own predicate IS
// assignee-or-reporter. So the parameter narrows to the one bit that matters —
// `isWatchingTab` — rather than carrying a five-member union whose other four
// members would all take the same branch.
//
// ⚠️ ONE WORKFLOW, and it used to be a MAP keyed by project id (MOTIR-2761).
// While Home spanned every browsable project, two projects could spell the same
// status key differently — one's `in_progress` labelled "In Progress" and
// another's "Doing" — so each row had to resolve against its own project's
// workflow. Home now reads one project, so the rows share its workflow the way
// `/items` rows share theirs, and the PROJECT cell went with the map: a column
// whose every row reads the same value is not information.

/** The row payload the client list renders. Fully serializable. */
export interface WorkbenchRowView {
  id: string;
  identifier: string;
  title: string;
  kind: WorkItemKindDto;
  /** The reader's relation to the item — the "Your role" cell. */
  role: WorkbenchRole;
  /** Resolved assignee display name, or null when unassigned. */
  assigneeName: string | null;
  /** Whether an AGENT is executing it — the assignee-avatar badge. */
  agent: boolean;
  /** The workflow status KEY — what the chip resolves its per-status tone from
   *  (MOTIR-3103); the category below is the fallback. */
  status: string;
  /** Human status label (the project's workflow label, or the raw key). */
  statusLabel: string;
  /** Lifecycle category → the Pill tone; null when unclassifiable. */
  statusCategory: StatusCategoryDto | null;
  /**
   * ISO-8601 moment it finished, or null on everything that has not.
   *
   * Carried on EVERY row rather than only on Recently-finished ones because the
   * five tabs share one row shape (`HOME_WORK_ITEM_SELECT`), and the read hands
   * it over already — rendering the Finished cell therefore costs no second
   * query. It is null on the other four tabs by construction.
   */
  completedAt: string | null;
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
export type WorkbenchRole = 'assigned' | 'reported' | 'both' | 'watching';

function resolveRole(row: HomeWorkItemRowDto, isWatchingTab: boolean): WorkbenchRole {
  if (row.viewerIsAssignee && row.viewerIsReporter) return 'both';
  if (row.viewerIsAssignee) return 'assigned';
  if (row.viewerIsReporter) return 'reported';
  // Only reachable on the Watching tab — every WORK read's predicate IS
  // assignee-or-reporter, so a row there always matched one of the two above.
  return isWatchingTab ? 'watching' : 'assigned';
}

export function toWorkbenchRowViews(
  rows: HomeWorkItemRowDto[],
  workflow: WorkflowDto,
  members: WorkspaceMemberDTO[],
  isWatchingTab: boolean,
): WorkbenchRowView[] {
  const nameByUserId = new Map(members.map((m) => [m.userId, m.name]));
  return rows.map((row) => {
    const status = workflow.statuses.find((s) => s.key === row.status);
    return {
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      kind: row.kind,
      role: resolveRole(row, isWatchingTab),
      assigneeName: row.assigneeId ? (nameByUserId.get(row.assigneeId) ?? null) : null,
      agent: row.executor === 'coding_agent',
      status: row.status,
      statusLabel: status?.label ?? row.status,
      statusCategory: status?.category ?? null,
      completedAt: row.completedAt,
    };
  });
}
