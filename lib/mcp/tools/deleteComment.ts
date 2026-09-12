import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { commentsService } from '@/lib/services/commentsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { commentIdField } from './editComment';

// `delete_comment` (MOTIR-5295) — hard-delete a comment the token's owner
// WROTE. A thin adapter over `commentsService.deleteComment` (5.1.2): a root
// takes its replies with it, a `comment_deleted` revision records the removal,
// and uploads only that thread embedded are unlinked.
//
// ⚠️ AUTHOR ONLY, for the reason `editComment.ts` gives — the grant carries no
// moderation key, so this door does not moderate.
//
// EXEMPT from payload derivation (`payloads/exemptions.ts`): no `/api/v1`
// operation deletes a comment, so there is no shared shape to derive from.

export const DELETE_COMMENT_TOOL_NAME = 'delete_comment';

const inputSchema = {
  commentId: commentIdField,
};

/** The adapter: delete, then name the work item it came off by its key. */
export async function runDeleteComment(
  args: { commentId: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const removed = await commentsService.deleteComment(args.commentId, ctx, { ownOnly: true });
    const item = await workItemsService.getWorkItem(removed.workItemId, ctx);
    const thread =
      removed.replyCount > 0
        ? ` and its ${removed.replyCount} ${removed.replyCount === 1 ? 'reply' : 'replies'}`
        : '';
    return toolOk(
      `Deleted comment ${removed.commentId}${thread} from ${item.identifier}.`,
      exempt(DELETE_COMMENT_TOOL_NAME, {
        commentId: removed.commentId,
        workItemKey: item.identifier,
        parentCommentId: removed.parentCommentId,
        replyCount: removed.replyCount,
      }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerDeleteComment(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    DELETE_COMMENT_TOOL_NAME,
    {
      title: 'Delete comment',
      description:
        'Permanently delete a comment YOU wrote (by comment id). Deleting a top-level comment ' +
        'also deletes its replies; the work item’s history records that it was deleted. This ' +
        'cannot be undone. Only the comment’s author can delete it through this tool — another ' +
        'member’s comment is refused even if your role could moderate it. Honors the same ' +
        'access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runDeleteComment(args, resolveContext(extra)),
  );
}
