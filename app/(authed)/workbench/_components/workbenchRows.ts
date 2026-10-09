import type { FixDetailDto, WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import type {
  GateResumeAttemptDto,
  HomeWorkItemRowDto,
  ResumeGateDto,
  ResumeRunDto,
} from '@/lib/dto/home';
import type { StatusCategoryDto, WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { WorkItemKindDto } from '@/lib/dto/workItems';
import type { OpenRepairRunDto } from '@/lib/dto/workItemRepair';

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
  /** The item's CI verdict (MOTIR-5470) — drawn through the shared badge and the
   *  shared `ciBadgeState` rule, the same pair the board and `/items` use. */
  ciState: string | null;
  /**
   * ISO-8601 moment it finished, or null on everything that has not.
   *
   * Carried on EVERY row rather than only on Recently-finished ones because the
   * five tabs share one row shape (`HOME_WORK_ITEM_SELECT`), and the read hands
   * it over already — rendering the Finished cell therefore costs no second
   * query. It is null on the other four tabs by construction.
   */
  completedAt: string | null;
  /**
   * WHY the card is stuck until something is repaired, and what the row names for it
   * (`WorkItem.fixReason` + `fixDetail`, MOTIR-6600) — the To fix tab's FIX LINE
   * (`design-notes.md` § 30, Panel 2). `null` when nothing is to fix, and on a row
   * whose stored detail did not survive the mapper (the pair is null together).
   */
  fix: { reason: WorkItemFixReasonDto; detail: FixDetailDto } | null;
  /** The row may offer Continue hosted (MOTIR-6882) — see `HomeWorkItemRowDto`. */
  canContinueHosted: boolean;
  /** The row may offer *Fix on the hosted agent* (MOTIR-6930) — see `HomeWorkItemRowDto`. */
  canFixHosted: boolean;
  /** The open repair on a sent-back row, or null (MOTIR-6930). */
  repairRun: OpenRepairRunDto | null;
  /**
   * TO FIX ONLY (MOTIR-7589; § 34): the kind of entry this row heads, and the OTHER
   * cards stuck with it, in the entry's order. `null` / empty elsewhere and for a card
   * stuck alone.
   */
  fixGroupKind: 'run' | 'prs' | 'card' | null;
  members: WorkbenchRowView[];
  /**
   * TO RESUME ONLY (MOTIR-7712; § 35.4): the gated run this entry waits on — its state,
   * the run's aside and its held gates with every person resolved to a name. `null` on
   * every other tab, and on a To resume row the read could not describe.
   */
  resume: WorkbenchResumeView | null;
  /**
   * TO DO, IN PROGRESS AND RECENTLY FINISHED ONLY (MOTIR-8016; § 36): this row heads a
   * group of the tab's items under a runnable container — `'member'` when the container is
   * itself on the tab, `'context'` when it is drawn only to name its members. `null` on a
   * standalone row and on every other tab.
   */
  groupHead: 'member' | 'context' | null;
  /** The tab's items under this head, in the service's order, the head excluded (§ 36.3). */
  groupMembers: WorkbenchRowView[];
}

/** One held gate, as the gate list draws it. */
export interface WorkbenchResumeGateView extends ResumeGateDto {
  deciderName: string | null;
  /** The person who decided it, else the recorded label (an agent, the system). */
  decidedByName: string | null;
}

/** A To resume entry's run (§ 35.4). */
export interface WorkbenchResumeView extends Omit<ResumeRunDto, 'gates'> {
  state: 'waiting_on_gate' | 'ready_to_resume';
  attempt: GateResumeAttemptDto | null;
  gates: WorkbenchResumeGateView[];
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
export type WorkbenchRole = 'assigned' | 'reported' | 'both' | 'watching' | 'none';

function resolveRole(row: HomeWorkItemRowDto, isWatchingTab: boolean): WorkbenchRole {
  if (row.viewerIsAssignee && row.viewerIsReporter) return 'both';
  if (row.viewerIsAssignee) return 'assigned';
  if (row.viewerIsReporter) return 'reported';
  // A To fix ENTRY's head or member the reader does not hold (MOTIR-7589; § 34.4): the
  // entry is on their tab because they hold SOME member, not this one — the cell reads —.
  if (row.fixGroupKind !== null) return 'none';
  // The same for a To resume entry's head (MOTIR-7712): only that read sets `resumeRun`.
  if (row.resumeRun !== undefined) return 'none';
  // A grouped work tab's CONTEXT head (MOTIR-8015; § 36.2): not on the tab, and here only
  // to name its members' container — the reader may hold neither role on it.
  if (row.groupHead === 'context') return 'none';
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
  const nameOf = (id: string | null) => (id ? (nameByUserId.get(id) ?? null) : null);
  const resumeOf = (row: HomeWorkItemRowDto): WorkbenchResumeView | null => {
    if (row.resumeState === null || !row.resumeRun) return null;
    const { gates, ...run } = row.resumeRun;
    return {
      ...run,
      state: row.resumeState,
      attempt: row.resumeAttempt ?? null,
      gates: gates.map((gate) => ({
        ...gate,
        deciderName: nameOf(gate.deciderId),
        decidedByName: nameOf(gate.decidedById) ?? gate.decidedByLabel,
      })),
    };
  };
  const view = (row: HomeWorkItemRowDto, isMember: boolean): WorkbenchRowView => {
    const status = workflow.statuses.find((s) => s.key === row.status);
    return {
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      kind: row.kind,
      role: isMember
        ? resolveRole({ ...row, fixGroupKind: 'card' }, false)
        : resolveRole(row, isWatchingTab),
      assigneeName: row.assigneeId ? (nameByUserId.get(row.assigneeId) ?? null) : null,
      agent: row.executor === 'coding_agent',
      status: row.status,
      statusLabel: status?.label ?? row.status,
      statusCategory: status?.category ?? null,
      ciState: row.ciState,
      completedAt: row.completedAt,
      fix:
        row.fixReason !== null && row.fixDetail !== null
          ? { reason: row.fixReason, detail: row.fixDetail }
          : null,
      canContinueHosted: row.canContinueHosted,
      canFixHosted: row.canFixHosted,
      repairRun: row.repairRun,
      fixGroupKind: row.fixGroupKind,
      members: [...row.fixMembers, ...row.resumeMembers].map((m) => view(m, true)),
      resume: isMember ? null : resumeOf(row),
      groupHead: row.groupHead,
      // One level only: the service never nests a group inside a group.
      groupMembers: row.groupMembers.map((m) => view(m, false)),
    };
  };
  return rows.map((row) => view(row, false));
}

/** One rendered line of a grouped work tab: a group row, or an item row. */
export type WorkbenchGroupDisplayRow =
  | { type: 'group'; head: WorkbenchRowView; open: boolean }
  | { type: 'row'; row: WorkbenchRowView; child: boolean };

/**
 * A grouped page (§ 36) as the lines it draws: each head as a group row followed, when
 * open, by its members; a standalone row as itself. `laneDisplayRows`' shape on `/ready`,
 * with one difference — the service sends WHOLE groups already nested, so this walks the
 * nesting rather than regrouping by id.
 *
 * ⚠️ IT NEVER RE-SORTS. The service ranked the groups and their members across the whole
 * tab before it cut the page; re-sorting one page on the client is what makes a page
 * boundary inexact (the note `splitWatchingGroups` carries).
 */
export function workbenchGroupDisplayRows(
  rows: readonly WorkbenchRowView[],
  expanded: ReadonlySet<string>,
): WorkbenchGroupDisplayRow[] {
  const out: WorkbenchGroupDisplayRow[] = [];
  for (const row of rows) {
    if (row.groupHead === null) {
      out.push({ type: 'row', row, child: false });
      continue;
    }
    const open = expanded.has(row.id);
    out.push({ type: 'group', head: row, open });
    if (open)
      for (const member of row.groupMembers) out.push({ type: 'row', row: member, child: true });
  }
  return out;
}

/**
 * The groups a page opens on first paint (§ 36.5): none, except when the page holds
 * exactly ONE group, which opens so the reader is not made to click into the only thing
 * there is.
 */
export function initiallyExpandedGroups(rows: readonly WorkbenchRowView[]): Set<string> {
  const heads = rows.filter((row) => row.groupHead !== null);
  return new Set(heads.length === 1 ? [heads[0]!.id] : []);
}
