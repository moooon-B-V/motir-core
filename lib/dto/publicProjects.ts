// DTOs for the PUBLIC project surfaces (Story 6.12).
//
// Two concerns live here, both wire-safe (no Prisma row crosses the boundary;
// enums cross as string-literal unions so a public consumer never imports
// `@prisma/client`):
//
//   * The public READ projection (Subtask 6.12.4) — the load-bearing
//     correctness boundary. The public read MUST go through these shapes so
//     internal fields NEVER cross the wire (not fetched-then-hidden in the DOM):
//       STRIPPED: assignees, estimates (estimateMinutes), story points
//                 (storyPoints), internal work-item comments.
//       KEPT:     work item key/identifier, title, kind, status, priority, board
//                 columns + ordering, and the public-safe `publicOverviewMd`.
//     The DTOs simply DON'T HAVE the stripped fields, so a mapper/service that
//     forgets to drop one is a compile error, not a silent leak.
//   * The public WRITE/dedupe entry points (Subtask 6.12.5) — the duplicate
//     -detection shapes for "submit a request". The submission itself returns
//     the shared `TriageSubmissionResultDto` (it IS a triage submission).

import type { WorkItemKindDto, WorkItemPriorityDto } from '@/lib/dto/workItems';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { CommentDTO } from '@/lib/dto/comments';

// --- Public READ projection (6.12.4) ---------------------------------------

/**
 * A single public-safe work item, as a board/list card. NO assignee, NO
 * estimateMinutes, NO storyPoints — those fields are absent BY DESIGN (the
 * public projection). `statusCategory` lets the public UI bucket the card
 * (todo / in_progress / done) without re-reading the workflow.
 */
export interface PublicWorkItemListItemDto {
  id: string;
  /** "PROD-42" — the denormalized work-item key the public URL uses. */
  identifier: string;
  /** The per-project monotonic number (PROD-**42**). */
  key: number;
  title: string;
  kind: WorkItemKindDto;
  /** The status key (e.g. "in_progress"); a public-safe workflow label. */
  status: string;
  statusCategory: StatusCategoryDto;
  priority: WorkItemPriorityDto;
  /**
   * The "this epic is not public" MARKER (Story 6.14 · Subtask 6.14.4). Set to
   * `true` ONLY on a PRIVATE epic's row (`kind = 'epic'`, `publicChildrenHidden`)
   * as projected for a NON-MEMBER viewer — the signal the placeholder UI
   * (6.14.5 / 6.14.6) renders the badge + "not public" statement off, WITHOUT
   * ever receiving a child. Omitted (absent) otherwise: a normal card, a member
   * viewer, or a non-epic. The epic ROW itself stays visible (its key / title /
   * kind / status are present); the server has already EXCLUDED its descendants
   * from every public read (the no-leak guarantee — they are absent from the
   * payload, not DOM-hidden). The flat public projection carries no aggregate
   * tells (child count / progress / points) to strip — the marker is the ADR §4
   * surface for the board / items list.
   */
  childrenHidden?: boolean;
}

/** Alias — a public board card is exactly the same stripped projection. */
export type PublicBoardCardDto = PublicWorkItemListItemDto;

/** One public board column: its name + the cards mapped into it. */
export interface PublicBoardColumnDto {
  id: string;
  name: string;
  /** Mapped status keys (so the column header can show its statuses). */
  statusKeys: string[];
  cards: PublicBoardCardDto[];
  /** Full card count in this column (the denominator above the loaded set). */
  totalCount: number;
}

/** The public board — columns of public-safe cards. Bounded (the at-scale cap). */
export interface PublicBoardDto {
  boardId: string;
  name: string;
  columns: PublicBoardColumnDto[];
  /** The board-level load cap (the bound; never "load every row"). */
  cap: number;
  /** True when the board's total exceeds the cap (the "refine" hint). */
  truncated: boolean;
}

/** A cursor-paginated page of public-safe work items (the Work items tab). */
export interface PublicWorkItemPageDto {
  items: PublicWorkItemListItemDto[];
  /** Opaque cursor (a work-item id) for the next page, or null at the end. */
  nextCursor: string | null;
}

// --- Public TREE projection (6.14.10) --------------------------------------

/**
 * One row of the PUBLIC, expandable work-item TREE (Story 6.14 · Subtask
 * 6.14.10) — the same stripped public projection as a list/board card, plus the
 * two tree bits the lazy hierarchy needs:
 *
 *   - `parentId` — where the row sits (null at the root level).
 *   - `hasChildren` — whether the node has PUBLICLY-VISIBLE children (drives the
 *     expand chevron WITHOUT pre-loading the subtree — the lazy at-scale read).
 *     A PRIVATE epic reports `false` here (its descendants are excluded
 *     server-side) but still carries `childrenHidden` (inherited from the list
 *     projection) — the tree-expand placeholder (6.14.5) is driven by THAT
 *     marker, not `hasChildren`.
 *
 * No assignee / estimate / story points — absent by design (the public
 * projection), exactly like {@link PublicWorkItemListItemDto}.
 */
export interface PublicWorkItemTreeRowDto extends PublicWorkItemListItemDto {
  parentId: string | null;
  hasChildren: boolean;
}

/**
 * One lazily-loaded LEVEL of the public tree (the roots, or one parent's direct
 * children): the paged `rows` + whether a next page exists + the level's FULL
 * sibling `total` (for an honest "Showing N of M" / `aria-setsize`, independent
 * of paging). Offset-paged — the client tracks the loaded count as the next
 * offset, mirroring the authed {@link import('@/lib/dto/workItems').TreeLevelDto}.
 */
export interface PublicTreeLevelDto {
  rows: PublicWorkItemTreeRowDto[];
  hasMore: boolean;
  total: number;
}

// --- Public WORK-ITEM DETAIL projection (6.14.11) ---------------------------

/**
 * The item's parent, projected for the public DETAIL page's breadcrumb + the
 * sidebar "Parent" link (Subtask 6.14.11). Public-safe identity only — no
 * assignee / estimate / story points. `null` when the item is a root (an epic,
 * or a parentless item). A reachable detail item always has a public-safe parent
 * chain (a child of a PRIVATE epic is itself excluded from every public read, so
 * it 404s before this is read), so the parent here is never a hidden node.
 */
export interface PublicWorkItemDetailParentDto {
  identifier: string;
  key: number;
  title: string;
  kind: WorkItemKindDto;
}

/**
 * The public read-only WORK-ITEM DETAIL payload (Story 6.14 · Subtask 6.14.11 ·
 * design `public-item-detail.mock.html`) — the page a public / non-member viewer
 * lands on from an items-list row or a board card. The public projection PLUS
 * the body, the resolved status label, the immediate parent, and the FIRST page
 * of public-safe direct children (the child / sub-issue panel; the rest lazy-load
 * via the public tree endpoint — the at-scale rule). Like every public DTO it
 * physically cannot carry an internal field: NO assignee / estimate / story
 * points (absent from the shape), and a private epic's descendants never enter
 * `children` (excluded server-side).
 */
export interface PublicWorkItemDetailDto {
  id: string;
  /** "PROD-42" — the work-item identifier the public URL addresses. */
  identifier: string;
  /** The per-project monotonic number (PROD-**42**). */
  key: number;
  title: string;
  kind: WorkItemKindDto;
  /** The workflow status key (e.g. "in_progress"). */
  status: string;
  /** The status's display label for the header status `Pill`. */
  statusLabel: string;
  /** The status category — drives the `Pill` tone (todo / in_progress / done). */
  statusCategory: StatusCategoryDto;
  /** The item's public-safe body Markdown, or null when empty. */
  descriptionMd: string | null;
  /** The immediate parent (breadcrumb + sidebar Parent link), or null at a root. */
  parent: PublicWorkItemDetailParentDto | null;
  /**
   * The "this epic is not public" placeholder MARKER (Subtask 6.14.4). `true`
   * ONLY when the focal item is a PRIVATE epic (`kind = 'epic'`,
   * `publicChildrenHidden`) viewed by a NON-MEMBER — the child panel renders the
   * "not public" statement instead of children and the sidebar rollups read
   * "Hidden". The descendants are already EXCLUDED server-side (`children` is
   * empty, `childCount` is 0), so this is the display signal, not the enforcement.
   */
  childrenHidden: boolean;
  /** Total public-safe DIRECT children (the sidebar "Children = N"); 0 when hidden. */
  childCount: number;
  /** The first page of public-safe child rows (SSR'd, crawlable). */
  children: PublicWorkItemTreeRowDto[];
  /** Whether more children exist past the first page (drives "Load more children"). */
  childrenHasMore: boolean;
}

// --- Public ROADMAP projection (6.12.7) ------------------------------------

/**
 * The four public roadmap buckets (Subtask 6.12.7), in display order. The
 * project's real workflow statuses map to these four PUBLIC-facing buckets
 * (the service owns the mapping): `submitted` = still-in-triage public
 * requests (the demand-gathering column); `planned` = `todo`-category
 * statuses; `in_progress` = `in_progress`-category; `done` = `done`-category
 * EXCLUDING `cancelled`. Non-public statuses (cancelled / raw triage) never
 * map to a bucket — they are not shown.
 */
export type PublicRoadmapBucketKey = 'submitted' | 'planned' | 'in_progress' | 'done';

export const PUBLIC_ROADMAP_BUCKET_KEYS: readonly PublicRoadmapBucketKey[] = [
  'submitted',
  'planned',
  'in_progress',
  'done',
] as const;

/**
 * One public roadmap card — a public-safe request/work-item projection PLUS its
 * upvote `voteCount` (the demand signal) and `voted` (whether the CURRENT viewer
 * has upvoted it, so the card paints its voted state; always `false` logged
 * out). NO assignee / estimate / story points — the public projection. `key` is
 * the per-project number behind the public `/p/<id>/items#<identifier>` link.
 */
export interface PublicRoadmapCardDto {
  id: string;
  identifier: string;
  key: number;
  title: string;
  kind: WorkItemKindDto;
  voteCount: number;
  voted: boolean;
}

/** One public roadmap column — a status bucket, its total + its loaded page. */
export interface PublicRoadmapColumnDto {
  key: PublicRoadmapBucketKey;
  /** The bucket's full card count (the header number; not the loaded length). */
  totalCount: number;
  /** The first/loaded page of cards (highest-demand first). */
  cards: PublicRoadmapCardDto[];
  /** Opaque cursor for this column's next page, or null at the end. */
  nextCursor: string | null;
}

/** The public roadmap — the four status-grouped columns, in display order. */
export interface PublicRoadmapDto {
  columns: PublicRoadmapColumnDto[];
}

/**
 * A single roadmap column's next page (the per-column "Load more" fetch). The
 * `bucket` echoes which column the page belongs to so the client island appends
 * it to the right column.
 */
export interface PublicRoadmapColumnPageDto {
  bucket: PublicRoadmapBucketKey;
  cards: PublicRoadmapCardDto[];
  nextCursor: string | null;
}

/** The at-a-glance stat strip on the Overview hero + sidebar. */
export interface PublicProjectStatsDto {
  /** Public requests submitted into triage (likely 0 until 6.12.5 ships). */
  publicRequests: number;
  /** Total upvotes across the project's public requests (6.12.6). */
  upvotes: number;
  /** Work items whose status category is todo/in_progress (the roadmap ahead). */
  planned: number;
  /** Work items shipped — status category `done`. */
  shipped: number;
  /** Work items currently in progress (sidebar "In progress" stat). */
  inProgress: number;
}

/**
 * External links derived from EXISTING project fields only — NO new schema.
 * Motir's project has no dedicated link columns today, so every field is
 * optional and may be absent; the Overview sidebar renders only the present
 * ones. (6.12.8's settings editor is where these become authorable.)
 */
export interface PublicProjectLinksDto {
  website?: string;
  repo?: string;
  docs?: string;
  changelog?: string;
}

/** The public Overview/README landing payload. */
export interface PublicProjectOverviewDto {
  /**
   * The project's GLOBAL id — the address the public WRITE endpoints take
   * (`/api/public/projects/[projectId]/requests` + `…/duplicates`, ADR §2.2).
   * Public-safe: it is already the public write-URL segment. The READ surfaces
   * key off the workspace-scoped `identifier`; the signed-in submit form (6.12.11)
   * keys off this id.
   */
  id: string;
  /** The project's display name (the hero `<h1>`). */
  name: string;
  /** The project key (e.g. "PROD") — the public URL segment + a hero meta. */
  identifier: string;
  /** The owning workspace's name (top-bar "key · workspace"). */
  workspaceName: string;
  /** The authored README Markdown, or null → the slim auto-intro fallback. */
  publicOverviewMd: string | null;
  /**
   * The authored public hero TAGLINE (Story 6.16 · Subtask 6.16.3) — the short
   * one-liner under the project name; `null` when never authored (the hero then
   * falls back to its i18n default). Public-safe — it rides this projection only
   * because `getOverview` ran the public gate first.
   */
  publicTagline: string | null;
  /**
   * The authored public hero TAGS (Story 6.16 · Subtask 6.16.3) — the topic
   * chips on the hero, in author order. Empty array when none authored (never
   * `null` — the column defaults to `[]`).
   */
  publicTags: string[];
  stats: PublicProjectStatsDto;
  links: PublicProjectLinksDto;
  /**
   * Whether the CURRENT viewer may MANAGE this project (Story 6.16 · Subtask
   * 6.16.3) — drives the on-page admin "Edit" affordance server-side. `true`
   * only for a project admin (or workspace owner/admin) viewing the public page;
   * an anonymous reader, a crawler, and a cross-org account all read `false`, so
   * the edit ability never leaks to a non-admin.
   */
  viewerCanManage: boolean;
}

// --- Public REQUEST DETAIL (6.12.12) ---------------------------------------

/**
 * The public request DETAIL payload (Subtask 6.12.12 · design Panel 5) — the
 * full read behind `/p/<project>/requests/<request>`. It is the public
 * projection PLUS the request body, the upvote demand signal, and the PUBLIC
 * comment thread. Like every public DTO it physically cannot carry an internal
 * field: NO assignee / estimate / story points (absent from the shape), and the
 * `comments` are ONLY the request's `isPublic` thread — a work item's internal
 * Story-5.1 discussion never enters this read.
 */
export interface PublicRequestDetailDto {
  id: string;
  /** "PROD-42" — the work-item identifier the public URL addresses. */
  identifier: string;
  /** The per-project monotonic number (PROD-**42**). */
  key: number;
  title: string;
  kind: WorkItemKindDto;
  /** The workflow status key (e.g. "in_progress"). */
  status: string;
  /** The status's display label for the status `Pill`. */
  statusLabel: string;
  /** The status category — drives the `Pill` tone (todo / in_progress / done). */
  statusCategory: StatusCategoryDto;
  /** The request body Markdown (public-safe), or null when empty. */
  descriptionMd: string | null;
  /** The submitter's display name — the "opened by {name}" meta. */
  openedByName: string;
  /** ISO timestamp the request was opened (the meta-row age). */
  createdAt: string;
  /** Upvote tally across every account (the demand signal). */
  voteCount: number;
  /** Whether the CURRENT viewer has upvoted it (always false logged out). */
  voted: boolean;
  /**
   * The PUBLIC comment thread (the request's `isPublic` comments only), oldest
   * first. The shared {@link CommentDTO} shape — the same shape the comment
   * POST route returns, so the composer's optimistic append matches the wire.
   */
  comments: CommentDTO[];
}

// --- Public WRITE / duplicate detection (6.12.5) ---------------------------

/**
 * One duplicate-detection candidate — an existing PUBLIC REQUEST that matches a
 * draft submission's title, surfaced so the submitter can **upvote this
 * instead** of creating a dupe (Canny's behaviour). Carries just what the
 * "upvote this instead" affordance renders: the identity + the current
 * status/vote-count demand signal. The full body lives behind the request's own
 * public detail (6.12.4 / 6.12.6).
 */
export interface PublicRequestMatchDto {
  id: string;
  /** A request is `bug` (bug report) or `task` (feature request). */
  kind: WorkItemKindDto;
  /** The allocated work-item identifier (e.g. "PROD-42"). */
  identifier: string;
  title: string;
  /** The request's workflow status key (e.g. "open", "in_progress"). */
  status: string;
  /** Current upvote count — the demand signal (zero until 6.12.6 lands votes). */
  voteCount: number;
}

/**
 * The duplicate-detection result for a draft title — the matching existing
 * public requests, ordered highest-demand first. An empty `candidates` array
 * means "no match — submit as new". The list is bounded (never load-all).
 */
export interface PublicDuplicateMatchesDto {
  candidates: PublicRequestMatchDto[];
}
