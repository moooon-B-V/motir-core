import type { StatusCategoryDto } from '@/lib/dto/workflows';

// Should a work-item surface render the ready/blocked readiness banner?
// (bug MOTIR-2050 — the ONE predicate both readiness surfaces share: the detail
// page's RelationshipsPanel and the quick-view peek.)
//
// Two gates, both about whether "can I start this?" is a live question:
//
//   1. The item is still in the TODO category — the question is moot once the
//      work is in progress or finished (2.5.21).
//   2. The item is NOT archived. Archiving is a pure soft-delete
//      (`workItemsService.archiveWorkItem` stamps `archivedAt` and deliberately
//      leaves `status` alone), so an archived item keeps its `todo` status and a
//      status-only gate still fires — which is how an archived item came to show
//      the green "Ready to start" badge right beside its own "Archived" banner.
//      The banner also CONTRADICTED the system: every ready-set read filters
//      `archivedAt IS NULL` (`workItemRepository`'s ready CTE, and so `/ready`,
//      `list_ready`, `claim_next_ready`), so an archived item can never be handed
//      out as ready. It is not startable work, whatever its status says.
//
// It lives here — one exported predicate rather than the boolean inlined at each
// call site — so the NEXT readiness surface inherits both gates instead of
// re-deriving (and re-missing) one of them.
export function showsReadiness(args: {
  /** The item's status category (`null` when the workflow can't classify it). */
  statusCategory: StatusCategoryDto | null | undefined;
  /** Is the item archived (`archivedAt != null`)? */
  archived: boolean;
}): boolean {
  return !args.archived && args.statusCategory === 'todo';
}
