import { Prisma } from '@/generated/prisma/client';
import {
  withSystemContext,
  withUserContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { publicRequestVoteRepository } from '@/lib/repositories/publicRequestVoteRepository';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { toCommentDto } from '@/lib/mappers/commentMappers';
import { EmptyCommentBodyError } from '@/lib/comments/errors';
import { PublicRequestNotFoundError } from '@/lib/publicRequests/errors';
import type { CommentDTO } from '@/lib/dto/comments';
import type {
  PublicRequestVoteResultDTO,
  VisitorPendingRequestPageDto,
} from '@/lib/dto/publicRequests';
import { toVisitorPendingRequestDto } from '@/lib/mappers/publicProjectsMappers';
import { PERSON_FALLBACK_LABEL, personName } from '@/lib/people/personLabel';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  decodeRoadmapCursor,
  encodeRoadmapCursor,
  InvalidRoadmapCursorError,
  PUBLIC_ROADMAP_PAGE_SIZE,
} from '@/lib/publicProjects/roadmapCursor';
import type { PublicRoadmapCursor } from '@/lib/repositories/workItemRepository';
import type { VisitorReadContext } from '@/lib/visitor/context';
import {
  VisitorConsentRequiredError,
  VisitorEntersProjectError,
  VisitorSignInRequiredError,
} from '@/lib/visitor/errors';

// publicRequestsService (Story 6.12 · Subtask 6.12.6) — the two remaining
// public-viewer WRITES: UPVOTE and COMMENT on a public request. Both are
// sign-in-to-act (the route gates on a session) and gated by the NEW narrow
// 6.12.3 grants (`canUpvotePublicRequest` / `canCommentPublicRequest`), NOT a
// `canEdit` relaxation — a public viewer is not a member. A "public request" is
// a `work_item` on a `public` project; the public projection (6.12.4) decides
// what is visible, so the write gate is simply "the project is public and the
// item belongs to it" (per the ADR §4 scope note: on a public project the items
// themselves are public; the projection hides FIELDS, not WHICH items).
//
// RLS context (6.12.3 design): the `public_request_vote` table is FORCE-RLS and
// keys on `app.user_id` for the owner's rows + `app.system_admin` for the
// cross-account COUNT. So the vote write runs under `withUserContext` (the voter
// touches only their OWN vote) and the resulting tally is read under
// `withSystemContext` (it spans every voter).
//
// MOTIR-2684 supplied the two GUCs the rest of this file was leaning on the
// app-layer gate for. The opening `work_item` read is context-less by necessity
// (the item id is all the route has, so its project — and therefore its
// workspace — is what the read is FINDING); it resolves through the
// `work_item_public_project_read` policy, which admits an unbound read of a
// public project's items and nothing else. The comment INSERT then binds the
// item's own workspace via `withWorkspaceServiceContext`. Both are still the
// secondary defence behind the app-layer `projectId`/`workspaceId` gate
// (finding #26) — what changed is that under the non-bypass `motir_app` role
// they no longer refuse the path outright.

/**
 * Resolve a public request (a `work_item` by id) and assert the caller's grant
 * on its project. Returns the work item. Throws:
 *   - PublicRequestNotFoundError (→ 404) when the id resolves to no work item;
 *   - ProjectNotFoundError (→ 404) when its project is NOT public (the
 *     404-not-403 posture — the access service hides non-public projects);
 *   - ProjectAccessDeniedError('edit') (→ 403) when the grant is denied.
 */
async function resolvePublicRequest(
  workItemId: string,
  actorUserId: string,
  assertGrant: (projectId: string, actorUserId: string) => Promise<void>,
) {
  const item = await workItemRepository.findById(workItemId);
  if (!item) throw new PublicRequestNotFoundError(workItemId);
  await assertGrant(item.projectId, actorUserId);
  return item;
}

export const publicRequestsService = {
  /**
   * Toggle the signed-in account's upvote on a public request. One vote per
   * account is server-enforced by the `public_request_vote` unique; a second
   * call from the same account REMOVES the vote (toggle off — never a double
   * count). The toggle runs under `withUserContext` and FOR-UPDATE-locks the
   * request work_item row first (lock-before-read-derived-update), so concurrent
   * toggles on the same request serialize — no lost update, no double row. The
   * resulting count (the demand signal the 6.11.3 triage queue sorts by) is read
   * under `withSystemContext` (it spans every voter).
   */
  async toggleUpvote(
    workItemId: string,
    ctx: { userId: string },
  ): Promise<PublicRequestVoteResultDTO> {
    await resolvePublicRequest(
      workItemId,
      ctx.userId,
      projectAccessService.assertCanUpvotePublicRequest.bind(projectAccessService),
    );

    const voted = await withUserContext(ctx.userId, async (tx) => {
      // Lock the request row so two concurrent toggles from the same account
      // can't both read "no vote" and race a double insert / lost delete.
      await workItemRepository.lockById(workItemId, tx);
      const existing = await publicRequestVoteRepository.findByWorkItemAndUser(
        workItemId,
        ctx.userId,
        tx,
      );
      if (existing) {
        await publicRequestVoteRepository.deleteByWorkItemAndUser(workItemId, ctx.userId, tx);
        return false;
      }
      try {
        await publicRequestVoteRepository.create({ workItemId, userId: ctx.userId }, tx);
      } catch (err) {
        // Backstop: a unique-race (two inserts) lands here for the loser — the
        // vote already exists, so the toggle's effect is still "voted".
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          return true;
        }
        throw err;
      }
      return true;
    });

    const voteCount = await withSystemContext((tx) =>
      publicRequestVoteRepository.countByWorkItem(workItemId, tx),
    );

    return { voted, voteCount };
  },

  /**
   * Add a PUBLIC-visible comment to a public request, attributed to the
   * signed-in (cross-org) account. Gated by `canCommentPublicRequest`, NOT
   * `canEdit`. The row is written with `isPublic = true` (the 6.12.2 §4 comment
   * split): the public projection (6.12.4) returns only these, never the work
   * item's internal Story-5.1 discussion. A cross-org commenter is not a member,
   * so there is no mention-scoping / auto-watch here — this is the public
   * feedback thread, not the internal one.
   */
  async addComment(
    workItemId: string,
    input: { bodyMd: string },
    ctx: { userId: string },
  ): Promise<CommentDTO> {
    const item = await resolvePublicRequest(
      workItemId,
      ctx.userId,
      projectAccessService.assertCanCommentPublicRequest.bind(projectAccessService),
    );

    if (input.bodyMd.trim().length === 0) throw new EmptyCommentBodyError();

    // MOTIR-2684: `withWorkspaceServiceContext`, not a bare `db.$transaction`.
    // `comment_active_workspace`'s WITH CHECK is `workspaceId = app.workspace_id`,
    // and a cross-org commenter's request binds no workspace anywhere upstream —
    // so under `motir_app` the INSERT was refused outright and the public thread
    // was write-dead. The workspace is the ITEM'S, taken from the row the grant
    // above has already proved belongs to a `public` project, so it is a trusted
    // resolution and not user input — the constraint that helper documents. It is
    // also the right helper rather than `withWorkspaceContext`: the commenter is
    // by definition NOT a member, so there is no membership for an `app.user_id`
    // bind to buy, and the comment policy keys on the workspace alone.
    const row = await withWorkspaceServiceContext(item.workspaceId, (tx) =>
      commentRepository.create(
        {
          workspaceId: item.workspaceId,
          workItemId: item.id,
          authorId: ctx.userId,
          parentCommentId: null,
          bodyMd: input.bodyMd,
          isPublic: true,
        },
        tx,
      ),
    );

    const authors = await userRepository.findByIds([row.authorId]);
    return toCommentDto(row, new Map(authors.map((u) => [u.id, u])), new Map());
  },

  /**
   * A public project's PENDING requests, as its Visitor reads them in
   * Requested features (Story MOTIR-6171 · MOTIR-6768;
   * `docs/decisions/public-request-board-retired.md` Decision 2), addressed by
   * the project's public identifier.
   *
   * The reader is settled by `resolveVisitor`, in its order, and only a
   * `visitor` verdict is served:
   *   - `not_found` (cloud off, unknown, not public) → `ProjectNotFoundError`;
   *   - `sign_in` → `VisitorSignInRequiredError`;
   *   - `enter` → `VisitorEntersProjectError` — a member reads the same list in
   *     their own inbox, `/requested-features`, with its acts;
   *   - `consent` → `VisitorConsentRequiredError`.
   * `cursor` is the opaque `nextCursor` of a previous page; a malformed one is
   * `InvalidRoadmapCursorError`.
   */
  async listPendingForVisitor(
    identifier: string,
    session: { user: { id: string } } | null,
    cursor?: string,
  ): Promise<VisitorPendingRequestPageDto> {
    const verdict = await projectAccessService.resolveVisitor(identifier, session);
    switch (verdict.kind) {
      case 'not_found':
        throw new ProjectNotFoundError(identifier);
      case 'sign_in':
        throw new VisitorSignInRequiredError(verdict.identifier);
      case 'enter':
        throw new VisitorEntersProjectError(verdict.project.identifier);
      case 'consent':
        throw new VisitorConsentRequiredError(verdict.subject.identifier);
      case 'visitor':
        return this.listPendingForVisitorContext(verdict.ctx, cursor);
    }
  },

  /**
   * {@link listPendingForVisitor} for a reader ALREADY settled as the project's
   * Visitor — the page's server render (`settleVisitor`) and the "Load more"
   * door (`resolveVisitor`) both hold the context, so neither resolves twice.
   *
   * The read is the retired motir.co board's "Submitted" column, unchanged —
   * `findPublicRoadmapSubmitted` / `countPublicRoadmapSubmitted`: in triage,
   * attributed, not archived, not in a done-category status, not snoozed;
   * ordered by votes, then the most recently triaged, then id. `voted` is the
   * READING Visitor's own vote. A triage item is parentless, so it can never
   * descend from a private epic and no epic-privacy exclusion applies (the same
   * reasoning `publicProjectsService` records for that column).
   */
  async listPendingForVisitorContext(
    ctx: VisitorReadContext,
    cursor?: string,
  ): Promise<VisitorPendingRequestPageDto> {
    const { project } = ctx;
    // The public-read gate every public read asserts (the retired board's own
    // routes included). The Visitor verdict already proved the project public;
    // this re-asserts it at the read, so a project made private between the
    // verdict and the query answers not-found rather than its queue.
    await projectAccessService.assertCanBrowsePublic(project.id, ctx.actorUserId);
    const seekAfter = cursor ? decodePendingRequestCursor(cursor) : undefined;
    const [rows, total] = await Promise.all([
      workItemRepository.findPublicRoadmapSubmitted(project.id, project.workspaceId, {
        limit: PUBLIC_ROADMAP_PAGE_SIZE + 1,
        cursor: seekAfter,
        voterUserId: ctx.actorUserId,
      }),
      workItemRepository.countPublicRoadmapSubmitted(project.id, project.workspaceId),
    ]);

    const hasMore = rows.length > PUBLIC_ROADMAP_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PUBLIC_ROADMAP_PAGE_SIZE) : rows;
    // Name only (MOTIR-6646): the submitter row is read for its display name and
    // nothing else leaves this function. A submitter is usually NOT a member of
    // the project's workspace — that is who files a public request.
    const submitterIds = [
      ...new Set(page.map((r) => r.submittedByUserId).filter((id): id is string => id !== null)),
    ];
    const submitters = await userRepository.findByIds(submitterIds);
    const names = new Map(submitters.map((u) => [u.id, personName(u.name)]));

    const last = page[page.length - 1];
    return {
      items: page.map((row) =>
        toVisitorPendingRequestDto(
          row,
          names.get(row.submittedByUserId ?? '') ?? PERSON_FALLBACK_LABEL,
        ),
      ),
      total,
      nextCursor:
        hasMore && last
          ? encodeRoadmapCursor({
              voteCount: last.voteCount,
              // Non-null by the read's own predicate (`triagedAt IS NOT NULL`).
              recency: (last.triagedAt as Date).toISOString(),
              id: last.id,
            })
          : null,
    };
  },
};

/**
 * The pending-requests cursor: the public roadmap's `(voteCount, recency, id)`
 * encoding (`lib/publicProjects/roadmapCursor.ts`), reused rather than
 * re-derived, with `recency` the row's `triagedAt` — the Submitted column's
 * tiebreak. A recency that is not an instant is as malformed as a bad token.
 */
function decodePendingRequestCursor(raw: string): PublicRoadmapCursor {
  const token = decodeRoadmapCursor(raw);
  const recency = new Date(token.recency);
  if (Number.isNaN(recency.getTime())) throw new InvalidRoadmapCursorError();
  return { voteCount: token.voteCount, recency, id: token.id };
}
