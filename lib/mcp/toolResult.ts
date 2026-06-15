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
import { FilterValidationError } from '@/lib/filters/errors';
import {
  BulkBatchTooLargeError,
  CannotDeleteActiveSprintError,
  CannotModifyCompletedSprintError,
  CrossProjectSprintAssignmentError,
  InvalidCarryOverTargetError,
  InvalidSprintNameError,
  InvalidSprintTransitionError,
  NotSprintAdminError,
  SprintAlreadyActiveError,
  SprintNotCompletableError,
  SprintNotFoundError,
  SprintNotStartableError,
  SprintWindowInvalidError,
} from '@/lib/sprints/errors';
import type { FilterDecodeResult } from '@/lib/filters/ast';
import { McpMissingContextError } from './context';
import { InvalidSearchCursorError } from './searchCursor';

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

/** Stable codes for a {@link FilterDecodeResult} failure reason — the codec's
 * version/structure verdict surfaced to an agent (one per `reason`). */
const FILTER_DECODE_CODES: Record<Exclude<FilterDecodeResult, { ok: true }>['reason'], string> = {
  malformed: 'MALFORMED_FILTER',
  'unsupported-version': 'UNSUPPORTED_FILTER_VERSION',
  invalid: 'INVALID_FILTER',
};

/**
 * Map a non-`ok` {@link FilterDecodeResult} (a `search_work_items` envelope that
 * fails the SHARED 6.1.1 codec — a foreign version, a non-`v1` envelope, or a
 * structurally-broken shape) to a clean `isError` tool result. The codec
 * returns a typed FAILURE VALUE (it never throws), so this is the decode-path
 * analogue of {@link toToolError}'s thrown-error mapping.
 */
export function toFilterDecodeToolError(
  decoded: Exclude<FilterDecodeResult, { ok: true }>,
): CallToolResult {
  return toolError(FILTER_DECODE_CODES[decoded.reason], decoded.detail);
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
  if (err instanceof InvalidReadyCursorError || err instanceof InvalidSearchCursorError) {
    return toolError(err.code, err.message);
  }
  // Sprint tools (7.8.10): the sprint-entity + backlog-association typed errors.
  // `SprintNotFoundError` keeps the 404-not-403 contract (a foreign/unknown
  // sprint is an indistinguishable not-found); the state-machine + admin-gate +
  // window/name + carry-over + bulk-cap errors surface verbatim so an agent can
  // self-correct (e.g. "complete the active sprint first", "only a planned
  // sprint is startable").
  if (
    err instanceof SprintNotFoundError ||
    err instanceof NotSprintAdminError ||
    err instanceof InvalidSprintNameError ||
    err instanceof SprintWindowInvalidError ||
    err instanceof InvalidSprintTransitionError ||
    err instanceof CannotModifyCompletedSprintError ||
    err instanceof CannotDeleteActiveSprintError ||
    err instanceof SprintAlreadyActiveError ||
    err instanceof SprintNotStartableError ||
    err instanceof SprintNotCompletableError ||
    err instanceof InvalidCarryOverTargetError ||
    err instanceof CrossProjectSprintAssignmentError ||
    err instanceof BulkBatchTooLargeError
  ) {
    return toolError(err.code, err.message);
  }
  if (err instanceof FilterValidationError) {
    // `search_work_items` (7.8.6): the registry's typed 422 — an unknown
    // field/operator id or a value that fails its (field, operator) arity —
    // surfaced as a clean tool error, the MCP analogue of the route's 422.
    return toolError(err.code, err.message);
  }
  if (err instanceof McpMissingContextError) {
    return toolError(err.code, err.message);
  }
  throw err;
}
