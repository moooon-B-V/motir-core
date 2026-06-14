import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  AssigneeNotInWorkspaceError,
  CrossProjectParentError,
  DepthLimitExceededError,
  IllegalParentTypeError,
  IllegalTransitionError,
  ReporterNotInWorkspaceError,
  TypeNotAllowedOnKindError,
  UnknownStatusError,
  WorkItemKeyConflictError,
  WorkItemNotFoundError,
} from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  CommentForbiddenError,
  CommentNotFoundError,
  EmptyCommentBodyError,
  InvalidParentCommentError,
  ReplyDepthExceededError,
} from '@/lib/comments/errors';
import { InvalidReadyCursorError } from '@/lib/workItems/readyFilter';
import { McpMissingContextError } from './context';

// Tool-result helpers (Story 7.8 · Subtask 7.8.4, extended by 7.8.5) — the MCP
// analogue of the route layer's typed-error → HTTP-status mapping.
//
// Two jobs:
//  1. `toolOk` builds the MCP DUAL-CONTENT result every tool returns — a
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
//
// The write tools (7.8.5) add their services' typed errors here so a structural
// failure (bad parent/kind pair, illegal status move, empty comment body, …)
// reads as a clean tool error the agent can self-correct from, never an opaque
// JSON-RPC internal error. `transition_status` catches `IllegalTransitionError`
// at the tool BEFORE `toToolError` so it can enrich the message with the legal
// targets; the entry here is the plain-message fallback.

/** Build a dual-content (text + structuredContent) successful tool result. */
export function toolOk(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

/**
 * Build an `isError` tool result carrying a stable code + message. Exported so a
 * tool that enriches an error before returning (e.g. `transition_status`'s
 * allowed-targets message) builds the same shape `toToolError` does.
 */
export function toolError(code: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    isError: true,
  };
}

/**
 * Map a thrown service error to an `isError` tool result, or re-throw if it
 * isn't one of the tools' expected typed errors. Every branch surfaces the
 * service's own `code` + `message`, so the contract the routes enforce (and the
 * 404-not-403 cross-tenant rule) carries to the MCP surface unchanged.
 */
export function toToolError(err: unknown): CallToolResult {
  // 404-not-403: identical message whether the row is absent or cross-tenant.
  if (err instanceof WorkItemNotFoundError || err instanceof ProjectNotFoundError) {
    return toolError(err.code, err.message);
  }
  // 6.4 access gate: a non-browser sees a project-level denial; a read-only
  // member sees the edit denial on a write tool. Both carry their own message.
  if (err instanceof ProjectAccessDeniedError) {
    return toolError(err.code, err.message);
  }
  // Write-tool structural / validation errors (7.8.5): create-path kind/parent
  // + membership + key, status transitions, and the comment service's guards.
  if (
    err instanceof UnknownStatusError ||
    err instanceof IllegalTransitionError ||
    err instanceof IllegalParentTypeError ||
    err instanceof DepthLimitExceededError ||
    err instanceof CrossProjectParentError ||
    err instanceof ReporterNotInWorkspaceError ||
    err instanceof AssigneeNotInWorkspaceError ||
    err instanceof TypeNotAllowedOnKindError ||
    err instanceof WorkItemKeyConflictError ||
    err instanceof CommentForbiddenError ||
    err instanceof EmptyCommentBodyError ||
    err instanceof InvalidParentCommentError ||
    err instanceof ReplyDepthExceededError ||
    err instanceof CommentNotFoundError
  ) {
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
