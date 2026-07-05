import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type {
  ExecutorDto,
  WorkItemKindDto,
  WorkItemPriorityDto,
  WorkItemTypeDto,
  WorkItemRefMap,
} from '@/lib/dto/workItems';
import type { CustomFieldWithValueDto } from '@/lib/dto/customFieldValues';
import type { LinkedPullRequestDto } from '@/lib/dto/github';

// The quick-view (peek) payload (Subtask 2.5.19; bug 8.8.2). A serializable,
// already-shaped slice of the detail read that the /api/work-items/peek route
// returns and the client IssueQuickViewController fetches — so the peek modal
// opens its frame + skeleton INSTANTLY (client-driven by `?peek`) and streams
// the fields in over the wire, instead of being server-rendered behind the host
// page's blocking data reads (8.8.2). Names + labels are resolved server-side so
// the panel stays purely presentational.
//
// 8.8.8 (Story 8.8) widened the rail to the FULL core-field set the detail page
// carries — Type · Executor · Labels · Components · Sprint · Story points · the
// valued Custom fields · the Created/Updated audit — per the 8.8.4 design
// (design/work-items/quick-view.mock.html), reversing 2.5's curated subset.
// Still read-only (one write path: Open full page); the heavier sections
// (Explanation, children, the full relationships panel, attachments, comments)
// stay detail-only.

/** The serializable payload the peek renders (a condensed slice of the detail read). */
export interface QuickViewData {
  identifier: string;
  title: string;
  /**
   * This project's identifier prefix (e.g. `MOTIR`) — the bare-key match scope
   * for the peek header's title-linkify (Subtask 5.8.6).
   */
  projectIdentifier: string;
  kind: WorkItemKindDto;
  statusLabel: string;
  statusCategory: StatusCategoryDto | null;
  descriptionMd: string | null;
  /**
   * Resolved `motir:` references in `descriptionMd` (Subtask 5.8.6) — keyed by
   * id, so the peek's description renders the live internal-link chip.
   */
  workItemRefs: WorkItemRefMap;
  /** The NATURE of the work (Story 2.7) — null on a container kind / untyped leaf. */
  type: WorkItemTypeDto | null;
  /** WHO executes the work (Story 2.7) — null when no type is set. */
  executor: ExecutorDto | null;
  assigneeName: string | null;
  reporterName: string;
  priority: WorkItemPriorityDto;
  /** The issue's labels (id + name; the chip tint is name-hash-derived client-side). */
  labels: { id: string; name: string }[];
  /** The issue's components (id + name; neutral chips). */
  components: { id: string; name: string }[];
  dueLabel: string | null;
  /**
   * The committed sprint's display name, or `null` when the item sits in the
   * backlog (or is excluded from it). Resolved server-side from `sprintId` (not
   * part of the detail aggregate). The panel renders the status-aware empty
   * label (Backlog vs None, keyed off `statusCategory`) when this is null.
   */
  sprintName: string | null;
  /** The agile STORY-POINT estimate (Story 4.3), or null when unestimated. */
  storyPoints: number | null;
  estimateLabel: string | null;
  /**
   * The project's custom-field definitions + this issue's resolved values
   * (Story 5.3), in position order. Passed through from the detail aggregate
   * read unchanged (already display-ready + serializable). The panel renders
   * the VALUED ones read-only and hides the empty ones behind a "Show more
   * fields (N)" disclosure, mirroring the detail rail (5.3.7).
   */
  customFields: CustomFieldWithValueDto[];
  /** Read-only audit instants (ISO-8601) — the quiet line at the foot of the rail. */
  createdAt: string;
  updatedAt: string;
  parent: { identifier: string; title: string; kind: WorkItemKindDto } | null;
  /**
   * The ready/blocked readiness signal (Subtask 2.5.21), shaped for the shipped
   * ReadinessBadge. `ready` is the service verdict (true when the item has no
   * blockers OR every blocker is terminal — bug-ready-banner-no-deps) and
   * `blockers` names the OPEN (non-terminal) blockers; the panel maps each to a
   * `?peek=` swap-peek href (so a blocker link swaps the peeked item in-list,
   * never leaving the surface — the 2.5.20 design's justified deviation from the
   * detail-page badge, which links to `/items/[key]`). The panel suppresses the
   * banner once the item leaves the `todo` category (see `statusCategory`):
   * "can I start this?" is moot for an item already in progress or done. `null`
   * only when the read carried no readiness verdict at all.
   *
   * `blockedByAncestor` (Subtask 7.0.13) is the nearest blocked ANCESTOR when the
   * item's OWN blockers are clear but a blocked parent / grandparent holds it out
   * of the ready set (the readiness cascade). The banner falls back to naming it
   * so a cascade-blocked item isn't a bare "Blocked"; `null` otherwise.
   */
  readiness: {
    ready: boolean;
    blockers: string[];
    blockedByAncestor: { identifier: string; title: string } | null;
  } | null;
  /**
   * The Development section's linked PRs (Story 7.10 · MOTIR-1579),
   * newest-updated first. Empty → the section renders its EmptyState
   * (design/github Panel 4a).
   */
  pullRequests: LinkedPullRequestDto[];
}
