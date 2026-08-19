import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { attachmentsService } from '@/lib/services/attachmentsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { attachFilePayload, presentMcpAttachment } from '../payloads/workItems';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';

// `attach_file` (Story MOTIR-3000 · Subtask MOTIR-3058) — put a file ON a work
// item. The agent-facing door onto MOTIR-3057's `/api/v1` route: a dispatched
// agent speaks MCP, not HTTP, so a route with no tool in front of it is a route
// the consumer this story was written for cannot call.
//
// A thin adapter over `attachmentsService.attachToWorkItem` — the SAME service
// path the v1 route and the browser panel take. Size, MIME, the per-user upload
// throttle and the organization's storage cap all run there, once; nothing is
// re-implemented here.
//
// ── ⚠️ THE PERMISSION IS THE WHOLE RISK ────────────────────────────────────
// A tool that exists but that the caller who needs it cannot invoke is the same
// as no tool, and this repository has one of each. `add_comment`'s sibling
// `add_plan_items` asserts `ai:view_plan`, which `CLI_TOKEN_GRANT` does NOT
// carry, so a dispatched run opens a plan and is refused on its first append
// (MOTIR-3051). The design-publish route asserts `work_item:edit`, which the
// grant DOES carry — which is why an agent can already publish a design result.
//
// This tool takes the second road: `work_item:edit`, because attaching a file
// to a card is editing that card. `tests/mcp/attachFileTool.test.ts` asserts
// that against `CLI_TOKEN_GRANT` itself rather than leaving it to be reasoned
// about, and `CLI_TOKEN_GRANT` is unchanged by this card.
//
// ── The base64 argument ────────────────────────────────────────────────────
// MCP carries JSON, not multipart, so the bytes arrive base64-encoded. That is
// the transport's constraint rather than a second upload shape: the decoded
// bytes go into the same `File` the HTTP route hands the same service.

export const ATTACH_FILE_TOOL_NAME = 'attach_file';

const inputSchema = {
  key: workItemKeyField,
  filename: z
    .string()
    .min(1)
    .describe('The file name as a reader should see it, e.g. "findings.md" or "triage.png".'),
  contentType: z
    .string()
    .min(1)
    .describe(
      'The file’s media type, e.g. "image/png" or "text/markdown". Must be on the upload ' +
        'allowlist; "text/html" is deliberately refused (415) — an HTML design mock has its ' +
        'own publisher.',
    ),
  contentBase64: z.string().min(1).describe('The file’s bytes, base64-encoded.'),
};

/** Compact human-readable summary of a newly-attached file. */
function summarize(identifier: string, filename: string, sizeBytes: number): string {
  return `Attached ${filename} (${sizeBytes} bytes) to ${identifier}.`;
}

/**
 * Decode the base64 payload, refusing anything that is not base64 rather than
 * silently attaching whatever `Buffer.from` salvaged.
 *
 * ⚠️ `Buffer.from(s, 'base64')` NEVER throws — it discards characters outside
 * the alphabet and returns a shorter buffer. So a caller that sent a raw string
 * by mistake would get a successful upload of garbage, which is worse than an
 * error: the file lands on the card and only fails when a human opens it.
 * Re-encoding and comparing is the cheap way to make that impossible.
 */
function decodeBase64(value: string): Buffer | null {
  const normalized = value.replace(/\s+/g, '');
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== normalized) return null;
  return bytes;
}

/** The adapter: resolve project + item by key, then attach the decoded file. */
export async function runAttachFile(
  args: { key: string; filename: string; contentType: string; contentBase64: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const bytes = decodeBase64(args.contentBase64);
    if (bytes === null) {
      // A TOOL error, not a throw: the agent can fix this in one hop, and an
      // opaque internal error would tell it nothing about which argument was
      // wrong.
      return toolError(
        'INVALID_BASE64',
        '`contentBase64` is not valid base64. Encode the file’s bytes and send the result.',
      );
    }
    const identifier = normalizeIdentifier(args.key);
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);
    const file = new File([new Uint8Array(bytes)], args.filename, { type: args.contentType });
    // `'api'` — the general door, whichever transport reached it. The source
    // records the DOOR, not the actor: Motir cannot tell an agent from a person
    // holding a token (docs/decisions/attachment-api-door.md §2).
    const attachment = await attachmentsService.attachToWorkItem(item.id, file, ctx, 'api');
    return toolOk(
      summarize(item.identifier, attachment.filename, attachment.sizeBytes),
      derived(attachFilePayload, presentMcpAttachment(attachment, item.identifier)),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerAttachFile(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    ATTACH_FILE_TOOL_NAME,
    {
      title: 'Attach file',
      description:
        'Attach a file to a work item (by identifier, e.g. "ACME-7") so a reader sees the ' +
        'deliverable on the card itself instead of having to find a pull request. Use it for a ' +
        'deliverable that has no home of its own — a research findings document, a review’s ' +
        'notes, a verification’s evidence. The REPOSITORY stays the source of truth for ' +
        'anything that also lives in one: the attachment is the card’s view of that file, not a ' +
        'second home for it. ⚠️ NOT for a design asset — a design result has its own publisher ' +
        'and its own panel, and "text/html" is refused here. Honors the same access checks, ' +
        'size, media-type and storage limits as the UI.',
      inputSchema,
    },
    async (args, extra) => runAttachFile(args, resolveContext(extra)),
  );
}
