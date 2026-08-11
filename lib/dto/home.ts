import type {
  ExecutorDto,
  WorkItemKindDto,
  WorkItemPriorityDto,
  WorkItemTypeDto,
} from '@/lib/dto/workItems';

// Wire DTOs for the Home domain (Story MOTIR-2649 · Subtask MOTIR-2651) — the
// signed-in landing surface's two personal reads. `homeService` maps Prisma rows
// to these via `lib/mappers/homeMappers.ts` just before returning (CLAUDE.md —
// services never return raw Prisma models). Dates are ISO strings, matching the
// work-items / notifications DTO convention.
//
// ⚠️ This is a SEPARATE row shape from `WorkItemListItemDto`, deliberately, and
// the reason is worth stating once. Home's row is not the `/items` row: it ADDS
// the owning project (a project-scoped list never needs to say which project it
// is in) and the reader's own relation to the item, and it DROPS `hasDescription`
// and `dueDate` — the first because it exists to drive the `/items` row ⋯ menu,
// which `design/home/` does not draw, and the second because Home's column set
// has no Due cell. Widening the shared DTO instead would have put two fields on
// every tree/list/archived row in the product to serve one surface.

/** The owning project, as Home's row identifies it (the design's Project cell). */
export interface HomeProjectRefDto {
  id: string;
  /** The `MOTIR` / `ATLAS` project key — the prefix the item's identifier carries. */
  identifier: string;
  name: string;
}

/**
 * One row of My work or Watching.
 *
 * **`viewerIsAssignee` / `viewerIsReporter` are BOTH carried, and both can be
 * true.** That is the whole point of the merged read: an item where the reader
 * is assignee AND reporter comes back exactly ONCE, and these two booleans are
 * how the row still says both things about it. A renderer derives the design's
 * "Your role" cell from the pair (`Assigned` · `Reported` · `Both`); the service
 * does not pre-compute a label, so the copy stays a UI decision.
 *
 * On the WATCHING read both flags are still resolved against the same reader —
 * an item the reader watches but does not own carries `false`/`false`, and one
 * they watch AND own carries the same pair My work would give it. Watching is a
 * different audience, not a partition of My work.
 */
export interface HomeWorkItemRowDto {
  id: string;
  kind: WorkItemKindDto;
  /** The leaf's work TYPE (`code` / `design` / …); `null` on containers. */
  type: WorkItemTypeDto | null;
  key: number;
  identifier: string;
  title: string;
  /** The raw workflow status KEY (not the label) — the caller resolves display. */
  status: string;
  priority: WorkItemPriorityDto;
  assigneeId: string | null;
  reporterId: string;
  /**
   * WHO executes it — `coding_agent` | `human` | null. Carried so the row can
   * render the agent treatment `design/home/` specifies (a badge on the
   * assignee avatar). An agent-executed item is returned by these reads like
   * any other; it is never filtered out and never sectioned off.
   */
  executor: ExecutorDto | null;
  storyPoints: number | null;
  estimateMinutes: number | null;
  /** ISO-8601 last-modified stamp — also the first half of the page cursor. */
  updatedAt: string;
  project: HomeProjectRefDto;
  viewerIsAssignee: boolean;
  viewerIsReporter: boolean;
}

/**
 * One cursor-paged window of a personal read (finding #57 — never a load-all).
 * `nextCursor` is an OPAQUE token to resume after, or `null` on the last page.
 *
 * It is opaque because it encodes a KEYSET — `(updatedAt, id)`, the exact pair
 * the reads order by — rather than an offset or a bare row id. A keyset is what
 * makes the page boundary stable while items keep being updated underneath the
 * reader, which is the property the dedupe has to survive: MOTIR-2655 asserts
 * that the union of two pages repeats no id and drops none.
 */
export interface HomePageDto {
  items: HomeWorkItemRowDto[];
  nextCursor: string | null;
}
