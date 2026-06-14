import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { InvalidReadyCursorError } from '@/lib/workItems/readyFilter';
import { McpMissingContextError } from './context';

// Tool-result helpers (Story 7.8 · Subtask 7.8.4) — the MCP analogue of the
// route layer's typed-error → HTTP-status mapping.
//
// Two jobs:
//  1. `toolOk` builds the MCP DUAL-CONTENT result every read tool returns — a
//     compact human-readable `text` block AND `structuredContent` (the DTO).
//     Agents parse `structuredContent`; a human watching the session reads the
//     text. (We deliberately do NOT declare an `outputSchema` on the tools, so
//     `structuredContent` is free-form DTO JSON — the route layer ships these
//     exact DTOs already; re-deriving a zod mirror of every DTO would be
//     duplicate surface for no gain.)
//  2. `toToolError` maps the typed service errors to a clean `isError` tool
//     result, preserving the 404-not-403 cross-tenant contract: a missing work
//     item and a cross-tenant one both surface as the SAME "not found" message
//     (the service already throws the same `WorkItemNotFoundError` /
//     `ProjectNotFoundError` for both — no existence leak). Errors we don't
//     recognise are re-thrown so the SDK reports them as a JSON-RPC internal
//     error rather than us inventing a misleading message.

/** Build a dual-content (text + structuredContent) successful tool result. */
export function toolOk(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

/** Build an `isError` tool result carrying a stable code + message. */
function toolError(code: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    isError: true,
  };
}

/**
 * Map a thrown service error to an `isError` tool result, or re-throw if it
 * isn't one of the read tools' expected typed errors. Keep this in sync with
 * the services the 7.8.4 read tools call — write tools (7.8.5+) extend it with
 * their own typed errors.
 */
export function toToolError(err: unknown): CallToolResult {
  if (err instanceof WorkItemNotFoundError || err instanceof ProjectNotFoundError) {
    // 404-not-403: identical message whether the row is absent or cross-tenant.
    return toolError(err.code, err.message);
  }
  if (err instanceof InvalidReadyCursorError) {
    return toolError(err.code, err.message);
  }
  if (err instanceof McpMissingContextError) {
    return toolError(err.code, err.message);
  }
  throw err;
}
