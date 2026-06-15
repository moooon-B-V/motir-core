import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { publicRequestVoteRepository } from '@/lib/repositories/publicRequestVoteRepository';
import { boardRepository } from '@/lib/repositories/boardRepository';
import { boardColumnRepository } from '@/lib/repositories/boardColumnRepository';
import { boardColumnStatusRepository } from '@/lib/repositories/boardColumnStatusRepository';
import { workflowsService } from '@/lib/services/workflowsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { triageService, type TriageSubmissionKind } from '@/lib/services/triageService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  toPublicProjectOverviewDto,
  toPublicRequestMatchDto,
  toPublicWorkItemListItemDto,
} from '@/lib/mappers/publicProjectsMappers';
import {
  MAX_PUBLIC_REQUEST_DESCRIPTION_LENGTH,
  PublicProjectIntakeUnavailableError,
  PublicRequestDescriptionTooLongError,
  PublicSubmissionRateLimitedError,
} from '@/lib/publicProjects/errors';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type {
  PublicBoardDto,
  PublicDuplicateMatchesDto,
  PublicProjectOverviewDto,
  PublicProjectStatsDto,
  PublicRequestMatchDto,
  PublicWorkItemPageDto,
} from '@/lib/dto/publicProjects';
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
