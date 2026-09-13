import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { commentsService } from '@/lib/services/commentsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { addCommentPayload, presentMcpComment } from '../payloads/workItems';

// `edit_comment` (MOTIR-5295) — replace the body of a comment the token's owner
// WROTE. A thin adapter over `commentsService.editComment` (5.1.2): the
// "Edited" tag, the no-op short-circuit on an identical body, the mention
// re-parse that notifies ONLY newly-added members, link-on-write and
// auto-relate all run exactly as they do from the item page.
//
// ⚠️ AUTHOR ONLY, deliberately — `ownOnly: true`. The item page lets a
// moderator edit anyone's comment, and this door does not. A token is gated on
// ONE permission per tool (`permissionGate.ts`), and `comment:moderate` is not a
// key any token can be granted, so the grant cannot tell "fix my own note" from
// "rewrite a teammate's". Letting the service's role check decide would hand a
// token granted only `comment:add` its owner's full moderation reach.

export const EDIT_COMMENT_TOOL_NAME = 'edit_comment';

/** The comment id field, shared by the edit and delete doors. */
export const commentIdField = z
  .string()
  .min(1)
  .describe(
    'The comment id — the `id` `add_comment` returned, or a comment row’s `id` from ' +
      '`get_work_item_activity`.',
  );

const inputSchema = {
  commentId: commentIdField,
  body: z
    .string()
    .min(1)
    .describe('The new comment body (Markdown). Mention a member with @[name](userId).'),
};

/** The adapter: edit the comment, then echo it back through the add payload. */
export async function runEditComment(
  args: { commentId: string; body: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const comment = await commentsService.editComment(args.commentId, { bodyMd: args.body }, ctx, {
      ownOnly: true,
    });
    const excerpt =
      comment.bodyMd.length > 280 ? comment.bodyMd.slice(0, 280) + '…' : comment.bodyMd;
    return toolOk(
      [`Comment ${comment.id} now reads:`, excerpt].join('\n'),
      derived(addCommentPayload, presentMcpComment(comment)),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerEditComment(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    EDIT_COMMENT_TOOL_NAME,
    {
      title: 'Edit comment',
      description:
        'Replace the Markdown body of a comment YOU wrote (by comment id) and mark it edited. ' +
        'An identical body changes nothing. A mention added by the edit notifies that member; ' +
        'mentions already present do not notify again. Only the comment’s author can edit it ' +
        'through this tool — another member’s comment is refused even if your role could ' +
        'moderate it. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runEditComment(args, resolveContext(extra)),
  );
}
