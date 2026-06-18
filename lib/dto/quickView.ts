import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { WorkItemKindDto, WorkItemPriorityDto } from '@/lib/dto/workItems';

// The quick-view (peek) payload (Subtask 2.5.19; bug 8.8.2). A serializable,
// already-shaped slice of the detail read that the /api/issues/peek route
// returns and the client IssueQuickViewController fetches — so the peek modal
// opens its frame + skeleton INSTANTLY (client-driven by `?peek`) and streams
// the fields in over the wire, instead of being server-rendered behind the host
// page's blocking data reads (8.8.2). Names + labels are resolved server-side so
// the panel stays purely presentational.

/** The serializable payload the peek renders (a condensed slice of the detail read). */
export interface QuickViewData {
  identifier: string;
  title: string;
  kind: WorkItemKindDto;
  statusLabel: string;
  statusCategory: StatusCategoryDto | null;
  descriptionMd: string | null;
  assigneeName: string | null;
  reporterName: string;
  priority: WorkItemPriorityDto;
  dueLabel: string | null;
  estimateLabel: string | null;
  parent: { identifier: string; title: string; kind: WorkItemKindDto } | null;
  /**
   * The ready/blocked readiness signal (Subtask 2.5.21), shaped for the shipped
   * ReadinessBadge. `ready` is the service verdict (true when the item has no
   * blockers OR every blocker is terminal — bug-ready-banner-no-deps) and
   * `blockers` names the OPEN (non-terminal) blockers; the panel maps each to a
   * `?peek=` swap-peek href (so a blocker link swaps the peeked item in-list,
   * never leaving the surface — the 2.5.20 design's justified deviation from the
   * detail-page badge, which links to `/issues/[key]`). The panel suppresses the
   * banner once the item leaves the `todo` category (see `statusCategory`):
   * "can I start this?" is moot for an item already in progress or done. `null`
   * only when the read carried no readiness verdict at all.
   */
  readiness: { ready: boolean; blockers: string[] } | null;
}
