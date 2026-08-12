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
import type { PublicRequestVoteResultDTO } from '@/lib/dto/publicRequests';

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
};
