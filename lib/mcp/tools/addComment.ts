import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { CommentDTO } from '@/lib/dto/comments';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';

// `add_comment` (Story 7.8 · Subtask 7.8.5) — post a Markdown comment on a work
// item as the token's owning user. A thin adapter over `commentsService.
// addComment` (5.1.2): server-side mention parsing, `comment_mention` rows, the
// auto-watch, and the `work-item/comment.created` job event all fire EXACTLY as
// from the UI — a mention in an agent's comment emails the mentioned user
// (5.1.6) with zero MCP-specific wiring. No business logic here.

export const ADD_COMMENT_TOOL_NAME = 'add_comment';

const inputSchema = {
  key: workItemKeyField,
  body: z
    .string()
    .min(1)
    .describe('The comment body (Markdown). Mention a member with @[name](userId).'),
};

/** Compact human-readable summary of a newly-created comment. */
function summarize(identifier: string, comment: CommentDTO): string {
  const excerpt = comment.bodyMd.length > 280 ? comment.bodyMd.slice(0, 280) + '…' : comment.bodyMd;
  const mentions =
    comment.mentionedUserIds.length > 0 ? ` · mentioned ${comment.mentionedUserIds.length}` : '';
  return [`Commented on ${identifier} as ${comment.author.name}${mentions}`, excerpt].join('\n');
}

/** The adapter: resolve project + item by key, then add the comment. */
export async function runAddComment(
  args: { key: string; body: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const identifier = normalizeIdentifier(args.key);
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);
    const comment = await commentsService.addComment(item.id, { bodyMd: args.body }, ctx);
    return toolOk(
      summarize(item.identifier, comment),
      comment as unknown as Record<string, unknown>,
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerAddComment(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    ADD_COMMENT_TOOL_NAME,
    {
      title: 'Add comment',
      description:
        'Post a Markdown comment on a work item (by identifier, e.g. "PROD-7") as the token ' +
        'owner. Mentions notify the mentioned member. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runAddComment(args, resolveContext(extra)),
  );
}
