import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { publicRequestVoteRepository } from '@/lib/repositories/publicRequestVoteRepository';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { boardRepository } from '@/lib/repositories/boardRepository';
import { boardColumnRepository } from '@/lib/repositories/boardColumnRepository';
import { boardColumnStatusRepository } from '@/lib/repositories/boardColumnStatusRepository';
import { workflowsService } from '@/lib/services/workflowsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { triageService, type TriageSubmissionKind } from '@/lib/services/triageService';
import { withSystemContext, withUserContext } from '@/lib/workspaces/context';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { PublicRequestNotFoundError } from '@/lib/publicRequests/errors';
import { toCommentDto } from '@/lib/mappers/commentMappers';
import {
  toPublicProjectOverviewDto,
  toPublicRequestDetailDto,
  toPublicRequestMatchDto,
  toPublicRoadmapCardDto,
  toPublicWorkItemDetailDto,
  toPublicWorkItemDetailParentDto,
  toPublicWorkItemListItemDto,
  toPublicWorkItemTreeRowDto,
} from '@/lib/mappers/publicProjectsMappers';
import {
  MAX_PUBLIC_REQUEST_DESCRIPTION_LENGTH,
  PublicProjectIntakeUnavailableError,
  PublicRequestDescriptionTooLongError,
  PublicSubmissionRateLimitedError,
  PublicWorkItemNotFoundError,
} from '@/lib/publicProjects/errors';
import {
  decodeRoadmapCursor,
  encodeRoadmapCursor,
  InvalidRoadmapCursorError,
  PUBLIC_ROADMAP_PAGE_SIZE,
} from '@/lib/publicProjects/roadmapCursor';
import type { PublicRoadmapCursor, PublicRoadmapRow } from '@/lib/repositories/workItemRepository';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type {
  PublicBoardDto,
  PublicDuplicateMatchesDto,
  PublicProjectOverviewDto,
  PublicProjectStatsDto,
  PublicRequestMatchDto,
  PublicRoadmapBucketKey,
  PublicRoadmapColumnDto,
  PublicRoadmapColumnPageDto,
  PublicRoadmapDto,
  PublicRequestDetailDto,
  PublicTreeLevelDto,
  PublicWorkItemDetailDto,
  PublicWorkItemDetailParentDto,
  PublicWorkItemPageDto,
} from '@/lib/dto/publicProjects';
import { PUBLIC_ROADMAP_BUCKET_KEYS } from '@/lib/dto/publicProjects';
import type { TriageSubmissionResultDto } from '@/lib/dto/triage';

// publicProjectsService — the SINGLE service behind every PUBLIC project surface
// (Story 6.12). It carries two concerns over the same 6.12.3 access gate:
//
//   * READ (Subtask 6.12.4) — the anonymous, crawlable `/p/[identifier]` view.
//     Every read method resolves the project, then calls
//     `projectAccessService.assertCanBrowsePublic` (anonymous READ allowed on a
//     public project; ProjectNotFoundError → 404 on a non-public one — the
//     single auditable cross-org branch, reused not re-derived). `actorUserId`
//     is NULLABLE (a logged-out visitor / a crawler). The reads return the
//     PUBLIC PROJECTION DTOs (lib/dto/publicProjects.ts), which structurally
//     lack assignees / estimates / story points / internal comments — so an
//     internal field can never leak (absent from the shape, not DOM-hidden).
//
//   * WRITE / dedupe (Subtask 6.12.5) — the cross-account "submit a request"
//     path (reusing the 6.11.4 triage intake — no second submissions table) +
//     the deterministic duplicate-detection pre-check (Canny's "upvote this
//     instead"). These REQUIRE a signed-in `actorUserId` (sign-in-to-act — the
//     route gates the session) and key off the GLOBAL project id (ADR §2.2 — the
//     workspace-scoped "PROD" identifier collides across workspaces). Gated by
//     `assertCanSubmitToTriage` (NOT `canEdit`).
//
// 4-layer: this service orchestrates repositories + sibling services and maps to
// DTOs; the read paths own no transactions, the write path delegates to
// `triageService.createSubmission` for its transaction. Routes parse + call ONE
// method each.

// --- READ (6.12.4) helpers -------------------------------------------------

/**
 * The public board's load cap — a board-level bound (the at-scale rule: never
 * "load every row"). Smaller than the internal board cap because the public
 * projection is a lightweight crawlable read, not the full working board.
 */
const PUBLIC_BOARD_CAP = 200;

/** The Work-items tab page size (cursor-paginated, lazy — the at-scale rule). */
const PUBLIC_WORK_ITEMS_PAGE_SIZE = 30;

/**
 * The public TREE level page size (Subtask 6.14.10) — how many siblings one lazy
 * level loads at once before a "Load more children" affordance. Offset-paged per
 * level (the at-scale rule: a node's children load on expand, never the whole
 * forest up front), mirroring the authed lazy tree (2.5.13).
 */
const PUBLIC_TREE_PAGE_SIZE = 50;

/**
 * Resolve a public project by identifier + run the anonymous browse gate, AND
 * report whether the actor is a project MEMBER (Subtask 6.14.4 — the epic-privacy
 * exclusion keys off member-vs-non-member). One round-trip via
 * `projectAccessService.resolvePublicBrowse`.
 */
async function resolvePublicProject(identifier: string, actorUserId: string | null) {
  // A public project lives in exactly one workspace, but the identifier alone
  // doesn't name the workspace, so we can't use the workspace-scoped
  // `findByIdentifier` here. `findPublicByIdentifier` resolves the (single)
  // PUBLIC project carrying this key; the gate then confirms it is `public` (404
  // otherwise — no existence leak), so a non-public project carrying the same
  // key in another workspace stays hidden. (ADR §2.2 prefers id-addressing for
  // the public surface to avoid the cross-workspace key collision; 6.12.4 keeps
  // the pretty `/p/PROD` URL — the proper share token is 6.12.8. The collision
  // is a documented edge for the demo; flagged in the 6.12.4 PR body.)
  const project = await projectRepository.findPublicByIdentifier(identifier);
  if (!project) throw new ProjectNotFoundError(identifier);
  // The gate is the authority on visibility (it throws ProjectNotFoundError on a
  // non-public project) — reuse it, never re-derive the public check. It also
  // reports member-vs-non-member in the same round-trip (6.14.4).
  const { isMember } = await projectAccessService.resolvePublicBrowse(project.id, actorUserId);
  return { project, isMember };
}

/**
 * The epic-privacy exclusion set for a public read (Story 6.14 · Subtask 6.14.4)
 * — the ids of every descendant of a PRIVATE epic, which the projection must drop
 * so they never cross the wire to a non-member. A MEMBER viewer (or a project
 * with no private epic) gets `[]`, so the read stays byte-for-byte the prior
 * projection. Centralised here so EVERY public read that loads work items applies
 * the SAME predicate (the no-leak guarantee is one helper, not N filters); a new
 * public item read is wired by passing `excludeIds` from this one call.
 */
async function resolveHiddenIds(
  project: { id: string; workspaceId: string },
  isMember: boolean,
): Promise<string[]> {
  if (isMember) return [];
  return workItemRepository.findPublicHiddenDescendantIds(project.id, project.workspaceId);
}

/**
 * Compute the Overview stat strip from bounded counts (no per-item N+1).
 * `excludeIds` is the epic-privacy exclusion set (6.14.4): for a non-member the
 * Planned / In progress / Shipped counts must NOT count a private epic's hidden
 * descendants (counting them would leak the hidden subtree's size — an aggregate
 * tell). The triage / upvote counts are unaffected (a triage item is parentless,
 * so never a private epic's descendant).
 */
async function computeStats(
  projectId: string,
  workspaceId: string,
  excludeIds: readonly string[],
): Promise<PublicProjectStatsDto> {
  const [byCategory, publicRequests, upvotes] = await Promise.all([
    workItemRepository.countByStatusCategory(projectId, workspaceId, { excludeIds }),
    workItemRepository.countTriageItems(projectId, workspaceId),
    publicRequestVoteRepository.countByProject(projectId),
  ]);
  return {
    publicRequests,
    upvotes,
    // "Planned" = everything not yet shipped (todo + in_progress); "Shipped" =
    // the done category. "In progress" is surfaced separately on the sidebar.
    planned: byCategory.todo + byCategory.in_progress,
    shipped: byCategory.done,
    inProgress: byCategory.in_progress,
  };
}

// --- READ · ROADMAP (6.12.7) helpers ---------------------------------------

/**
 * The default terminal "cancelled" status key — EXCLUDED from the public
 * roadmap's Done bucket. `cancelled` is a category-`done` status (a resolved
 * "won't do / duplicate"), but the card's contract is that non-public statuses
 * (cancelled / triage) are not shown — a cancelled item is sealed-not-shipped,
 * so it never appears on the public roadmap. It is a PROTECTED default key
 * (can't be renamed/recategorised — `lib/workflows/defaultWorkflow.ts`), so the
 * literal exclusion is stable; a project's CUSTOM done statuses still map to
 * Done by category (no project-specific "cancel" detection is attempted).
 */
const ROADMAP_EXCLUDED_DONE_KEY = 'cancelled';

/**
 * Map the project's real workflow statuses to the three PROMOTED roadmap
 * buckets' status-key sets (the planner's "decide the mapping" call — rung 1,
 * the Canny/Productboard status-roadmap shape): `planned` = every `todo`-
 * category status (To&nbsp;Do, Blocked); `in_progress` = every `in_progress`-
 * category status (In&nbsp;Progress, In&nbsp;Review); `done` = every `done`-
 * category status EXCEPT `cancelled`. The fourth bucket (`submitted`) is the
 * in-triage public requests — it has no status-key set (a different read).
 */
function promotedRoadmapStatusKeys(
  statuses: WorkflowStatusDto[],
): Record<'planned' | 'in_progress' | 'done', string[]> {
  return {
    planned: statuses.filter((s) => s.category === 'todo').map((s) => s.key),
    in_progress: statuses.filter((s) => s.category === 'in_progress').map((s) => s.key),
    done: statuses
      .filter((s) => s.category === 'done' && s.key !== ROADMAP_EXCLUDED_DONE_KEY)
      .map((s) => s.key),
  };
}

/** The opaque next-page cursor for the last row of a roadmap column page. */
function nextRoadmapCursor(bucket: PublicRoadmapBucketKey, last: PublicRoadmapRow): string {
  // Submitted tiebreaks on `triagedAt` (non-null by the read's predicate);
  // every promoted bucket tiebreaks on the monotonic `key`.
  const recency =
    bucket === 'submitted' ? (last.triagedAt as Date).toISOString() : String(last.key);
  return encodeRoadmapCursor({ voteCount: last.voteCount, recency, id: last.id });
}

/** Decode + retype a column cursor for the bucket's seek-after comparison. */
function decodeRoadmapCursorForBucket(
  bucket: PublicRoadmapBucketKey,
  raw: string,
): PublicRoadmapCursor {
  const token = decodeRoadmapCursor(raw);
  if (bucket === 'submitted') {
    const d = new Date(token.recency);
    if (Number.isNaN(d.getTime())) throw new InvalidRoadmapCursorError();
    return { voteCount: token.voteCount, recency: d, id: token.id };
  }
  const n = Number(token.recency);
  if (!Number.isInteger(n)) throw new InvalidRoadmapCursorError();
  return { voteCount: token.voteCount, recency: n, id: token.id };
}

/**
 * Read ONE roadmap column's page (the at-scale `take + 1` over-fetch → derive
 * `nextCursor` without a trailing COUNT). `submitted` reads the active in-triage
 * public requests; the promoted buckets read graduated items in their mapped
 * status keys. Shared by the initial `getRoadmap` (all four) and the per-column
 * `getRoadmapColumn` "Load more". `voterUserId` (nullable) drives `voted`.
 */
async function loadRoadmapColumnPage(
  project: { id: string; workspaceId: string },
  bucket: PublicRoadmapBucketKey,
  promotedKeys: Record<'planned' | 'in_progress' | 'done', string[]>,
  actorUserId: string | null,
  excludeIds: readonly string[],
  cursor?: PublicRoadmapCursor,
): Promise<{ cards: PublicRoadmapColumnDto['cards']; nextCursor: string | null }> {
  const limit = PUBLIC_ROADMAP_PAGE_SIZE + 1;
  const rows =
    bucket === 'submitted'
      ? // Submitted = still-in-triage public requests; a triage item is parentless
        // so it can never descend from a private epic — no epic-privacy exclusion.
        await workItemRepository.findPublicRoadmapSubmitted(project.id, project.workspaceId, {
          limit,
          cursor,
          voterUserId: actorUserId,
        })
      : // Promoted buckets read graduated work items, which CAN be a private epic's
        // descendants — exclude them for a non-member (6.14.4).
        await workItemRepository.findPublicRoadmapByStatus(
          project.id,
          project.workspaceId,
          promotedKeys[bucket],
          { limit, cursor, voterUserId: actorUserId, excludeIds },
        );

  const hasMore = rows.length > PUBLIC_ROADMAP_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PUBLIC_ROADMAP_PAGE_SIZE) : rows;
  const last = page[page.length - 1];
  return {
    cards: page.map(toPublicRoadmapCardDto),
    nextCursor: hasMore && last ? nextRoadmapCursor(bucket, last) : null,
  };
}

/** The full-bucket count behind a column header (not the loaded-page length). */
async function countRoadmapColumn(
  project: { id: string; workspaceId: string },
  bucket: PublicRoadmapBucketKey,
  promotedKeys: Record<'planned' | 'in_progress' | 'done', string[]>,
  excludeIds: readonly string[],
): Promise<number> {
  return bucket === 'submitted'
    ? // Submitted bucket = parentless triage items; never a private epic's
      // descendant, so no epic-privacy exclusion (6.14.4).
      workItemRepository.countPublicRoadmapSubmitted(project.id, project.workspaceId)
    : workItemRepository.countProjectIssues(project.id, project.workspaceId, {
        statuses: promotedKeys[bucket],
        excludeIds,
      });
}

// --- WRITE / dedupe (6.12.5) helpers ---------------------------------------

// How many duplicate candidates the pre-check surfaces (bounded — never
// load-all; the UI shows the top matches as "upvote this instead").
const DUPLICATE_MATCH_LIMIT = 5;

// Per-account submission throttle (the ADR §6 abuse guard for an
// internet-facing write). In-memory sliding window keyed by the submitting
// account — same shape as `attachmentsService`'s upload throttle, and the same
// caveat: it is PER-PROCESS (pre-Epic-8), a first-line abuse guard, not a
// distributed rate limiter. A real edge/Redis limiter is a later hardening.
const SUBMISSION_RATE_LIMIT = 5;
const SUBMISSION_RATE_WINDOW_MS = 10 * 60_000; // 10 minutes
const submissionLog = new Map<string, number[]>();

/**
 * Throttle a submitting account: throw {@link PublicSubmissionRateLimitedError}
 * when it has already made {@link SUBMISSION_RATE_LIMIT} submissions inside the
 * window, otherwise record this attempt. Mirrors `attachmentsService`'s
 * `checkRateLimit`.
 */
function checkSubmissionRateLimit(userId: string): void {
  const now = Date.now();
  const recent = (submissionLog.get(userId) ?? []).filter(
    (t) => now - t < SUBMISSION_RATE_WINDOW_MS,
  );
  if (recent.length >= SUBMISSION_RATE_LIMIT) {
    const oldest = recent[0]!;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldest + SUBMISSION_RATE_WINDOW_MS - now) / 1000),
    );
    throw new PublicSubmissionRateLimitedError(retryAfterSeconds);
  }
  recent.push(now);
  submissionLog.set(userId, recent);
}

export const publicProjectsService = {
  // --- READ (6.12.4) -------------------------------------------------------

  /**
   * Every public project's `{ identifier, updatedAt }` — the read behind
   * `app/sitemap.ts` (Subtask 6.12.4). No gate: these are public by definition
   * (the repo read constrains to `accessLevel = 'public'`). Cross-workspace
   * (the sitemap lists every public project regardless of tenant).
   */
  async listPublicForSitemap(): Promise<Array<{ identifier: string; updatedAt: Date }>> {
    return projectRepository.listPublic();
  },

  /**
   * The public Overview/README landing (Subtask 6.12.4). Resolves the project +
   * runs the anonymous gate, then returns the hero/meta + the authored
   * `publicOverviewMd` (null → the UI's slim auto-intro fallback) + the
   * at-a-glance stats + the public-safe Links. `actorUserId` nullable.
   */
  async getOverview(
    identifier: string,
    actorUserId: string | null,
  ): Promise<PublicProjectOverviewDto> {
    const { project, isMember } = await resolvePublicProject(identifier, actorUserId);
    const hiddenIds = await resolveHiddenIds(project, isMember);
    const [workspace, stats] = await Promise.all([
      workspaceRepository.findById(project.workspaceId),
      computeStats(project.id, project.workspaceId, hiddenIds),
    ]);
    return toPublicProjectOverviewDto(project, workspace?.name ?? '', stats);
  },

  /**
   * The public read-only BOARD (Subtask 6.12.4) — the project's default board
   * projected through the PUBLIC mapper: each card carries ONLY kind / key /
   * identifier / title / status / priority (NO assignee, estimate, or story
   * points). Triage + archived items are excluded by the repository read.
   * Bounded by `PUBLIC_BOARD_CAP` (the at-scale rule). Returns an empty board
   * (no columns) when the project has no default board yet — the public UI shows
   * its empty state rather than 404ing a browsable project. `actorUserId`
   * nullable.
   */
  async getBoard(identifier: string, actorUserId: string | null): Promise<PublicBoardDto> {
    const { project, isMember } = await resolvePublicProject(identifier, actorUserId);
    const { id: projectId, workspaceId } = project;
    // Epic-privacy (6.14.4): a non-member never receives a private epic's
    // descendants — the cards AND the per-column denominators exclude them; the
    // private epic card itself is marked `childrenHidden` (the mapper).
    const hiddenIds = await resolveHiddenIds(project, isMember);

    const board = await boardRepository.findDefaultForProject(projectId, workspaceId);
    if (!board) {
      return { boardId: '', name: '', columns: [], cap: PUBLIC_BOARD_CAP, truncated: false };
    }

    const [columns, mappings, statuses] = await Promise.all([
      boardColumnRepository.findByBoard(board.id, workspaceId),
      boardColumnStatusRepository.findByBoard(board.id, workspaceId),
      workflowsService.listStatusesByProject(projectId, workspaceId),
    ]);

    const statusById = new Map(statuses.map((s) => [s.id, s]));
    const categoryByKey = new Map(statuses.map((s) => [s.key, s.category]));
    const terminalKeys = new Set(statuses.filter((s) => s.category === 'done').map((s) => s.key));

    // column id → its mapped LIVE statuses (a mapping to a deleted status is
    // skipped — no live key).
    const liveByColumn = new Map<string, WorkflowStatusDto[]>();
    for (const m of mappings) {
      const s = statusById.get(m.statusId);
      if (!s) continue;
      const list = liveByColumn.get(m.columnId) ?? [];
      list.push(s);
      liveByColumn.set(m.columnId, list);
    }

    let boardTotal = 0;
    const builtColumns = await Promise.all(
      columns.map(async (col) => {
        const live = (liveByColumn.get(col.id) ?? [])
          .slice()
          .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
        const statusKeys = live.map((s) => s.key);
        if (statusKeys.length === 0) {
          return {
            id: col.id,
            name: col.name,
            statusKeys,
            cards: [],
            totalCount: 0,
          };
        }
        // A terminal (done) column ranks by recency; an active column by board
        // rank — same ordering the internal board uses, minus the Done-age
        // window (the public projection shows the most recent shipped work).
        const terminal = statusKeys.every((k) => terminalKeys.has(k));
        const [rows, totalCount] = await Promise.all([
          workItemRepository.findColumnCards(
            projectId,
            workspaceId,
            statusKeys,
            terminal ? 'recent' : 'position',
            { limit: PUBLIC_BOARD_CAP, excludeIds: hiddenIds },
          ),
          workItemRepository.countProjectIssues(projectId, workspaceId, {
            statuses: statusKeys,
            excludeIds: hiddenIds,
          }),
        ]);
        boardTotal += totalCount;
        return {
          id: col.id,
          name: col.name,
          statusKeys,
          cards: rows.map((r) =>
            toPublicWorkItemListItemDto(r, categoryByKey.get(r.status) ?? 'todo', {
              hideChildren: !isMember,
            }),
          ),
          totalCount,
        };
      }),
    );

    return {
      boardId: board.id,
      name: board.name,
      columns: builtColumns,
      cap: PUBLIC_BOARD_CAP,
      truncated: boardTotal > PUBLIC_BOARD_CAP,
    };
  },

  /**
   * The public WORK ITEMS tab (Subtask 6.12.4) — a cursor-paginated, read-only
   * list of public-safe work items (same stripped projection as the board).
   * Triage + archived items are excluded by the repository read. `cursor` is an
   * opaque work-item id; `nextCursor` is null at the end of the list.
   * `actorUserId` nullable.
   */
  async getWorkItems(
    identifier: string,
    actorUserId: string | null,
    cursor?: string,
  ): Promise<PublicWorkItemPageDto> {
    const { project, isMember } = await resolvePublicProject(identifier, actorUserId);
    const statuses = await workflowsService.listStatusesByProject(project.id, project.workspaceId);
    const categoryByKey = new Map(statuses.map((s) => [s.key, s.category]));
    // Epic-privacy (6.14.4): a non-member's list excludes a private epic's
    // descendants server-side; the private epic row stays, marked.
    const hiddenIds = await resolveHiddenIds(project, isMember);

    // Over-fetch one row to detect whether a next page exists, then trim.
    const rows = await workItemRepository.findByProject(project.id, {
      take: PUBLIC_WORK_ITEMS_PAGE_SIZE + 1,
      cursor,
      excludeIds: hiddenIds,
    });
    const hasMore = rows.length > PUBLIC_WORK_ITEMS_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PUBLIC_WORK_ITEMS_PAGE_SIZE) : rows;
    return {
      items: page.map((r) =>
        toPublicWorkItemListItemDto(r, categoryByKey.get(r.status) ?? 'todo', {
          hideChildren: !isMember,
        }),
      ),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  },

  /**
   * One lazy LEVEL of the public, expandable work-item TREE (Story 6.14 ·
   * Subtask 6.14.10) — the project's ROOTS (`parentId === null`, the SSR'd first
   * level of the Tree tab) or one parent's DIRECT children (fetched on expand).
   * The hierarchy is loaded a level at a time (the at-scale rule — never the
   * whole forest), offset-paged within each level. Returns the public projection
   * (stripped of assignee / estimate / story points) plus the lazy `hasChildren`
   * chevron flag + the level's full `total`.
   *
   * Epic-privacy (6.14.4): a non-member's level EXCLUDES every descendant of a
   * private epic — server-side, from both the rows AND the `hasChildren` probe
   * AND the `total` denominator (so the hidden subtree's size never leaks). The
   * private epic ROW itself stays, marked `childrenHidden` (the placeholder UI
   * reads that). A MEMBER (or a project with no private epic) reads the full
   * tree. Even a direct child-level fetch for a private epic returns `[]` (its
   * descendants are excluded) — defence-in-depth behind the marker-driven UI.
   * `actorUserId` nullable (a logged-out visitor / crawler).
   */
  async getProjectTreeLevel(
    identifier: string,
    parentId: string | null,
    actorUserId: string | null,
    offset = 0,
  ): Promise<PublicTreeLevelDto> {
    const { project, isMember } = await resolvePublicProject(identifier, actorUserId);
    const statuses = await workflowsService.listStatusesByProject(project.id, project.workspaceId);
    const categoryByKey = new Map(statuses.map((s) => [s.key, s.category]));
    const hiddenIds = await resolveHiddenIds(project, isMember);

    const [rows, total] = await Promise.all([
      // Over-fetch one row to detect a next page without a second COUNT.
      workItemRepository.findPublicProjectTreeLevel(
        project.id,
        project.workspaceId,
        parentId,
        { take: PUBLIC_TREE_PAGE_SIZE, offset },
        hiddenIds,
      ),
      workItemRepository.countPublicProjectTreeLevel(
        project.id,
        project.workspaceId,
        parentId,
        hiddenIds,
      ),
    ]);
    const hasMore = rows.length > PUBLIC_TREE_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PUBLIC_TREE_PAGE_SIZE) : rows;
    return {
      rows: page.map((r) =>
        toPublicWorkItemTreeRowDto(r, categoryByKey.get(r.status) ?? 'todo', {
          hideChildren: !isMember,
        }),
      ),
      hasMore,
      total,
    };
  },

  /**
   * The public ROADMAP (Subtask 6.12.7) — the project's public-facing items as
   * four status-grouped, vote-counted, per-column-paginated columns
   * (**Submitted → Planned → In progress → Done**), over the 6.12.4 public
   * projection. Resolves the project + runs the anonymous browse gate
   * (`actorUserId` nullable — a logged-out reader / crawler), then loads the
   * FIRST page + the full count of each column in parallel. The Submitted column
   * is the still-in-triage public requests (the demand-gathering bucket the ADR
   * §4 routes triage items to); the promoted columns map the project's real
   * workflow statuses to their buckets (cancelled excluded from Done). Every
   * card carries its upvote count (the demand signal the column orders by) and
   * the viewer's `voted` flag. Nothing internal leaks — the rows go through the
   * public projection mapper. `actorUserId` nullable.
   */
  async getRoadmap(identifier: string, actorUserId: string | null): Promise<PublicRoadmapDto> {
    const { project, isMember } = await resolvePublicProject(identifier, actorUserId);
    const statuses = await workflowsService.listStatusesByProject(project.id, project.workspaceId);
    const promotedKeys = promotedRoadmapStatusKeys(statuses);
    // Epic-privacy (6.14.4): a non-member's roadmap excludes a private epic's
    // descendants from both the promoted-bucket cards and their header counts.
    const hiddenIds = await resolveHiddenIds(project, isMember);

    const columns = await Promise.all(
      PUBLIC_ROADMAP_BUCKET_KEYS.map(async (bucket): Promise<PublicRoadmapColumnDto> => {
        const [page, totalCount] = await Promise.all([
          loadRoadmapColumnPage(project, bucket, promotedKeys, actorUserId, hiddenIds),
          countRoadmapColumn(project, bucket, promotedKeys, hiddenIds),
        ]);
        return { key: bucket, totalCount, cards: page.cards, nextCursor: page.nextCursor };
      }),
    );

    return { columns };
  },

  /**
   * One roadmap column's NEXT page (Subtask 6.12.7) — the per-column "Load more"
   * fetch behind the client island. Re-resolves the project + the anonymous gate
   * (a non-public project 404s here too), re-derives the bucket's status keys,
   * decodes the opaque column cursor, and returns the next page + the following
   * cursor. A malformed cursor throws `InvalidRoadmapCursorError` (→ 400). No
   * total count — the header already has it from `getRoadmap`. `actorUserId`
   * nullable.
   */
  async getRoadmapColumn(
    identifier: string,
    actorUserId: string | null,
    bucket: PublicRoadmapBucketKey,
    cursorRaw: string,
  ): Promise<PublicRoadmapColumnPageDto> {
    const { project, isMember } = await resolvePublicProject(identifier, actorUserId);
    const cursor = decodeRoadmapCursorForBucket(bucket, cursorRaw);
    // Only the promoted buckets consult the status-key map; submitted ignores it,
    // so deriving the keys only when needed avoids a status read for Submitted.
    const promotedKeys =
      bucket === 'submitted'
        ? { planned: [], in_progress: [], done: [] }
        : promotedRoadmapStatusKeys(
            await workflowsService.listStatusesByProject(project.id, project.workspaceId),
          );
    // Epic-privacy (6.14.4): the submitted bucket needs no exclusion (parentless
    // triage items); a promoted bucket excludes a non-member's hidden subtree.
    const hiddenIds = bucket === 'submitted' ? [] : await resolveHiddenIds(project, isMember);
    const page = await loadRoadmapColumnPage(
      project,
      bucket,
      promotedKeys,
      actorUserId,
      hiddenIds,
      cursor,
    );
    return { bucket, cards: page.cards, nextCursor: page.nextCursor };
  },

  // --- READ · REQUEST DETAIL (6.12.12) -------------------------------------

  /**
   * The public request DETAIL (Subtask 6.12.12 · design Panel 5) — the read
   * behind `/p/<project>/requests/<request>`. Resolves the public project + runs
   * the anonymous browse gate (a non-public / unknown project 404s, never 403),
   * then resolves the request WITHIN that project by its work-item identifier
   * (e.g. "PROD-42"). A missing / cross-project / archived item is a
   * {@link PublicRequestNotFoundError} (the 404-not-403 posture — no existence
   * leak); a still-in-triage request IS shown (a roadmap "Submitted" card links
   * here). Epic-privacy (6.14.4): a non-member NEVER reaches a private epic's
   * hidden descendant — it 404s exactly like a missing item (the same no-leak
   * predicate the list/board/roadmap reads apply). Returns the public projection
   * PLUS the body, the status label, the upvote tally + the viewer's `voted`
   * flag, the opened-by name, and the PUBLIC comment thread (the request's
   * `isPublic` comments only — the work item's internal Story-5.1 discussion
   * never crosses the projection). `actorUserId` nullable (anonymous read; only
   * `voted` and the composer need a session).
   *
   * RLS context mirrors the 6.12.6 toggle: the cross-account vote COUNT reads
   * under `withSystemContext` (it spans every voter), the viewer's own `voted`
   * probe under `withUserContext` (it touches only their row). The work-item /
   * comment / user reads ride the app-layer projectId gate the rest of the
   * public read path uses.
   */
  async getRequestDetail(
    identifier: string,
    requestIdentifier: string,
    actorUserId: string | null,
  ): Promise<PublicRequestDetailDto> {
    const { project, isMember } = await resolvePublicProject(identifier, actorUserId);

    const item = await workItemRepository.findByIdentifier(project.id, requestIdentifier);
    // 404-not-403: a missing item, an item in another project, or an archived
    // (soft-deleted) one is hidden exactly like a non-public project.
    if (!item || item.archivedAt !== null) {
      throw new PublicRequestNotFoundError(requestIdentifier);
    }
    // Epic-privacy (6.14.4): a non-member must not reach a private epic's hidden
    // descendant — treat it as not-found (no leak), consistent with the other
    // public reads' exclusion set.
    const hiddenIds = await resolveHiddenIds(project, isMember);
    if (hiddenIds.includes(item.id)) {
      throw new PublicRequestNotFoundError(requestIdentifier);
    }

    // Status label + category for the Pill — the project's live workflow.
    const statuses = await workflowsService.listStatusesByProject(project.id, project.workspaceId);
    const status = statuses.find((s) => s.key === item.status) ?? null;

    // The upvote tally spans every account (system context); the viewer's own
    // voted flag is their single row (user context), only when signed in.
    const [voteCount, voted] = await Promise.all([
      withSystemContext((tx) => publicRequestVoteRepository.countByWorkItem(item.id, tx)),
      actorUserId
        ? withUserContext(actorUserId, (tx) =>
            publicRequestVoteRepository.findByWorkItemAndUser(item.id, actorUserId, tx),
          ).then((row) => row !== null)
        : Promise.resolve(false),
    ]);

    // "Opened by" — the real submitter (a 6.12 non-member, when present) else
    // the tenant reporter. The PUBLIC comment thread (isPublic only).
    const openedById = item.submittedByUserId ?? item.reporterId;
    const commentRows = await commentRepository.listPublicByWorkItem(item.id);
    const userIds = [...new Set([openedById, ...commentRows.map((c) => c.authorId)])];
    const users = await userRepository.findByIds(userIds);
    const usersById = new Map(users.map((u) => [u.id, u]));
    // Public-request comments carry no mention scoping (6.12.6), so an empty
    // mention map is correct — never a leak of an internal mention set.
    const comments = commentRows.map((row) => toCommentDto(row, usersById, new Map()));

    return toPublicRequestDetailDto(item, {
      statusLabel: status?.label ?? item.status,
      statusCategory: status?.category ?? 'todo',
      openedByName: usersById.get(openedById)?.name ?? '',
      voteCount,
      voted,
      comments,
    });
  },

  // --- READ · WORK-ITEM DETAIL (6.14.11) -----------------------------------

  /**
   * The public read-only WORK-ITEM DETAIL (Story 6.14 · Subtask 6.14.11 · design
   * `public-item-detail.mock.html`) — the read behind `/p/<project>/items/<key>`,
   * the page a public / non-member viewer lands on from an items-list row or a
   * board card. Resolves the public project + runs the anonymous browse gate (a
   * non-public / unknown project 404s, never 403), then resolves the work item
   * WITHIN that project by its identifier (e.g. "PROD-42"). It returns the public
   * projection PLUS the body, the resolved status label, the immediate parent,
   * and the FIRST page of public-safe direct children (the rest lazy-load via the
   * public tree endpoint — the at-scale rule).
   *
   * Not-found posture (404-not-403, no existence leak): a missing /
   * cross-project / archived item, a TRIAGE item (it lives in the inbox, not the
   * planned tree — its public surface is the REQUEST detail, not this one), and a
   * private epic's HIDDEN descendant (a non-member must never reach it) all throw
   * {@link PublicWorkItemNotFoundError} — exactly like the request-detail read.
   *
   * Epic-privacy (Subtask 6.14.4): a NON-MEMBER viewing a PRIVATE epic gets the
   * `childrenHidden` marker (the child panel renders the "not public" statement,
   * the sidebar rollups read "Hidden"); its descendants are excluded server-side
   * (`children` empty, `childCount` 0) — defence-in-depth behind the marker. A
   * MEMBER (or a project with no private epic) reads the full child set.
   * `actorUserId` nullable (anonymous read / crawler).
   */
  async getWorkItemDetail(
    identifier: string,
    itemIdentifier: string,
    actorUserId: string | null,
  ): Promise<PublicWorkItemDetailDto> {
    const { project, isMember } = await resolvePublicProject(identifier, actorUserId);

    const item = await workItemRepository.findByIdentifier(project.id, itemIdentifier);
    // 404-not-403: a missing / cross-project item, an archived (soft-deleted)
    // one, or a triage item (not graduated to the planned tree) is hidden exactly
    // like a non-public project — the same exclusions the list / board / tree
    // reads apply (`triagedAt IS NULL`, `archivedAt IS NULL`).
    if (!item || item.archivedAt !== null || item.triagedAt !== null) {
      throw new PublicWorkItemNotFoundError(itemIdentifier);
    }
    // Epic-privacy (6.14.4): a non-member must not reach a private epic's hidden
    // descendant — treat it as not-found (no leak), consistent with every other
    // public read's exclusion set. (The private epic's OWN row stays reachable —
    // it is the visible placeholder; only its DESCENDANTS are in `hiddenIds`.)
    const hiddenIds = await resolveHiddenIds(project, isMember);
    if (hiddenIds.includes(item.id)) {
      throw new PublicWorkItemNotFoundError(itemIdentifier);
    }

    const statuses = await workflowsService.listStatusesByProject(project.id, project.workspaceId);
    const status = statuses.find((s) => s.key === item.status) ?? null;
    const categoryByKey = new Map(statuses.map((s) => [s.key, s.category]));

    // The placeholder marker: a non-member viewing a PRIVATE epic sees the "not
    // public" statement instead of children + "Hidden" sidebar rollups.
    const childrenHidden = !isMember && item.kind === 'epic' && item.publicChildrenHidden;

    // The immediate parent (the breadcrumb + sidebar "Parent" link). The item is
    // reachable, so its parent chain is public-safe — a parent that were a hidden
    // descendant (or the private epic itself) would have 404'd the item above.
    let parent: PublicWorkItemDetailParentDto | null = null;
    if (item.parentId) {
      const [parentRow] = await workItemRepository.findByIds([item.parentId]);
      if (parentRow) parent = toPublicWorkItemDetailParentDto(parentRow);
    }

    // The first page of public-safe direct children + the full count (the
    // at-scale rule — the panel lazily loads the rest via the public tree
    // endpoint, `?parentId=<item.id>`). For a private-epic non-member, `hiddenIds`
    // already EXCLUDES the children, so this returns []/0 behind the marker.
    const [childRows, childCount] = await Promise.all([
      workItemRepository.findPublicProjectTreeLevel(
        project.id,
        project.workspaceId,
        item.id,
        { take: PUBLIC_TREE_PAGE_SIZE, offset: 0 },
        hiddenIds,
      ),
      workItemRepository.countPublicProjectTreeLevel(
        project.id,
        project.workspaceId,
        item.id,
        hiddenIds,
      ),
    ]);
    const childrenHasMore = childRows.length > PUBLIC_TREE_PAGE_SIZE;
    const childPage = childrenHasMore ? childRows.slice(0, PUBLIC_TREE_PAGE_SIZE) : childRows;

    return toPublicWorkItemDetailDto(item, {
      statusLabel: status?.label ?? item.status,
      statusCategory: status?.category ?? 'todo',
      parent,
      childrenHidden,
      childCount,
      children: childPage.map((r) =>
        toPublicWorkItemTreeRowDto(r, categoryByKey.get(r.status) ?? 'todo', {
          hideChildren: !isMember,
        }),
      ),
      childrenHasMore,
    });
  },

  // --- WRITE / dedupe (6.12.5) ---------------------------------------------

  /**
   * Duplicate-detection pre-check (Subtask 6.12.5) — given a draft title, return
   * the matching EXISTING active public requests so the UI can offer "upvote
   * this instead" before a dupe is created (Canny's core behaviour). Gated by
   * `canSubmitToTriage` (a signed-in actor on a PUBLIC project; a non-public
   * project reads as 404, no existence leak). Deterministic (a tokenised title
   * match over the project's public requests — NOT an AI call; AI dedupe is an
   * Epic-7 enhancement) and bounded. A blank draft short-circuits to no
   * candidates.
   */
  async findDuplicateRequests(
    projectId: string,
    actorUserId: string,
    draftTitle: string,
  ): Promise<PublicDuplicateMatchesDto> {
    const title = draftTitle.trim();
    if (title.length === 0) return { candidates: [] };

    // The gate: a non-public project is 404 (no existence leak); the grant is
    // true for any signed-in account on a public project. The route has already
    // ensured a session, so `actorUserId` is a real account.
    await projectAccessService.assertCanSubmitToTriage(projectId, actorUserId);

    const rows = await workItemRepository.findPublicRequestMatches(
      projectId,
      title,
      DUPLICATE_MATCH_LIMIT,
    );
    const candidates: PublicRequestMatchDto[] = rows.map(toPublicRequestMatchDto);
    return { candidates };
  },

  /**
   * Submit a request into a PUBLIC project's triage (Subtask 6.12.5) — the
   * cross-account "report a bug / request a feature" path. Reuses the 6.11.4
   * intake authority (`triageService.createSubmission` → `workItemsService`):
   * the submission is born a triage `work_item` (kind `bug`/`task`), EXCLUDED
   * from every normal read until an admin promotes it, attributed to the
   * submitting cross-org account via `submittedByUserId` while the project's
   * workspace owner stands in as the (member) `reporterId`. Gated by
   * `canSubmitToTriage` (NOT `canEdit`); rate-limited + size-capped (an
   * internet-facing write). Returns the thin submission confirmation.
   */
  async submitPublicRequest(
    projectId: string,
    submitterUserId: string,
    input: { kind: TriageSubmissionKind; title: string; descriptionMd?: string | null },
  ): Promise<TriageSubmissionResultDto> {
    // Size cap (the abuse guard; the title bound + the kind are validated by
    // `createSubmission` downstream).
    if (
      typeof input.descriptionMd === 'string' &&
      input.descriptionMd.length > MAX_PUBLIC_REQUEST_DESCRIPTION_LENGTH
    ) {
      throw new PublicRequestDescriptionTooLongError();
    }

    // Gate FIRST (a non-public project / denied grant rejects before any quota
    // is consumed), then throttle the legit public submitter.
    await projectAccessService.assertCanSubmitToTriage(projectId, submitterUserId);
    checkSubmissionRateLimit(submitterUserId);

    // Resolve the project row for its workspace + identifier (the gate proved it
    // exists and is public). The intake reporter is the workspace OWNER — a
    // guaranteed member who passes `createWorkItem`'s `assertReporterMember`.
    const project = await projectRepository.findById(projectId);
    if (!project) throw new PublicProjectIntakeUnavailableError(projectId);
    const owner = await workspaceMembershipRepository.findOwnerByWorkspace(project.workspaceId);
    if (!owner) throw new PublicProjectIntakeUnavailableError(projectId);

    // Reuse the shared triage-create authority. `ctx` carries the intake
    // reporter (owner — a member); `submittedByUserId` carries the real
    // cross-org submitter (the 6.11.4 seam).
    return triageService.createSubmission(
      {
        projectKey: project.identifier,
        kind: input.kind,
        title: input.title,
        descriptionMd: input.descriptionMd ?? null,
        submittedByUserId: submitterUserId,
      },
      { userId: owner.userId, workspaceId: project.workspaceId },
    );
  },
};
