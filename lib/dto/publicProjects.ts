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
  stats: PublicProjectStatsDto;
  links: PublicProjectLinksDto;
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
