import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  AssigneeNotInWorkspaceError,
  CrossProjectParentError,
  DepthLimitExceededError,
  IllegalParentTypeError,
  IllegalTransitionError,
  ParentCycleError,
  ReporterNotInWorkspaceError,
  TypeNotAllowedOnKindError,
  UnknownStatusError,
  UnknownTargetRepoError,
  WorkItemKeyConflictError,
  WorkItemNotFoundError,
} from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { NotAMemberError } from '@/lib/workspaces/errors';
import {
  CrossWorkspaceLinkError,
  SelfLinkError,
  WorkItemLinkCycleError,
  WorkItemLinkNotFoundError,
} from '@/lib/workItems/linkErrors';
import {
  CommentForbiddenError,
  CommentNotFoundError,
  EmptyCommentBodyError,
  InvalidParentCommentError,
  ReplyDepthExceededError,
} from '@/lib/comments/errors';
import { InvalidActivityCursorError } from '@/lib/activity/errors';
import { InvalidReadyCursorError } from '@/lib/workItems/readyFilter';
import { FilterValidationError } from '@/lib/filters/errors';
import { InvalidEstimateError } from '@/lib/estimation/errors';
import {
  BulkBatchTooLargeError,
  CannotDeleteActiveSprintError,
  CannotModifyCompletedSprintError,
  CrossProjectSprintAssignmentError,
  InvalidCarryOverTargetError,
  InvalidSprintNameError,
  InvalidSprintTransitionError,
  NoActiveSprintError,
  NotSprintAdminError,
  SprintAlreadyActiveError,
  SprintNotCompletableError,
  SprintNotFoundError,
  SprintNotStartableError,
  SprintWindowInvalidError,
} from '@/lib/sprints/errors';
import { NoPlanForJobError, PlanNotFoundError } from '@/lib/plans/errors';
import {
  EmptyPlanChangeIntentError,
  EmptyPlanChangeTurnError,
  PlanChangeSessionNotFoundError,
  PlanChangeTurnConflictError,
  TooManyPlanChangeTargetsError,
} from '@/lib/planChange/errors';
import { InvalidTargetError } from '@/lib/services/aiPlanEditsService';
import { MotirAiError } from '@/lib/ai/errors';
import { CiCreditsExhaustedError } from '@/lib/ciMetering/errors';
import type { FilterDecodeResult } from '@/lib/filters/ast';
import { McpMissingContextError } from './context';
import { InvalidSearchCursorError } from './searchCursor';

// Tool-result helpers (Story 7.8 · Subtask 7.8.4, extended by 7.8.5) — the MCP
// analogue of the route layer's typed-error → HTTP-status mapping.
//
// Two jobs:
//  1. `toolOk` builds the MCP DUAL-CONTENT result every tool returns — a
//     compact human-readable `text` block AND `structuredContent`. Agents parse
//     `structuredContent`; a human watching the session reads the text.
//
//     ⚠️ SUPERSEDED 2026-08-06 (MOTIR-2227 · ADR Amendment 7). This comment used
//     to say: "We deliberately do NOT declare an `outputSchema` on the tools, so
//     `structuredContent` is free-form DTO JSON — the route layer ships these
//     exact DTOs already; re-deriving a zod mirror of every DTO would be
//     duplicate surface for no gain." That was SOUND under Story 7.8's premises:
//     the only routes then were the internal cookie-authenticated ones, and they
//     do pass DTOs through. ADR Amendment 2 (2026-08-03) then pinned that a v1
//     response is a v1 SCHEMA's output and never a DTO passed through, and
//     11.2/11.3 shipped it — so the premise died, and with it the conclusion.
//     `structuredContent` now has a SECOND consumer whose shape is versioned, and
//     a schema two surfaces are checked against is not duplicate surface; it is
//     the only place they meet. (The founding defect: `list_ready` and
//     `search_work_items` carried a `dependencies` block, `get_work_item` did
//     not, invisibly — MOTIR-1849.)
//
//     What Amendment 7 decides, so this file is not read as the old rule:
//      · `structuredContent` DERIVES from the shared `lib/api/v1/*/schema.ts`
//        shapes — every field a v1 resource schema declares appears under the
//        same key with the same value, from the same `present*` mapper the route
//        calls. Extras are a declared `.extend`, omissions a declared
//        `.pick`/`.omit`; a hand-authored look-alike is what is forbidden.
//      · We still do NOT declare the SDK's `outputSchema`, for NEW reasons: it is
//        published in `tools/list` (caller-visible churn on the surface that
//        exists to churn freely) and the SDK VALIDATES against it and THROWS, so
//        a drift would surface as a runtime `McpError` in front of an agent
//        instead of a red build. The guarantee comes from deriving plus the CI
//        drift guard, not from advertising.
//      · Tool names, descriptions, argument shapes and scopes stay MCP's OWN and
//        SHOULD churn. Only the DATA SHAPE — the half with two consumers — is
//        frozen.
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
  // Split out of `invalid` by MOTIR-2042 so an over-cap filter reports the same
  // code the registry's `FilterTooLargeError` maps to, on EVERY carrier.
  'too-large': 'FILTER_TOO_LARGE',
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
    // Re-parent cycle (move_to_parent, MOTIR-1017): the DB cycle trigger's
    // backstop for an item moved under one of its own descendants. The
    // kind-parent matrix rejects most such moves first (it is strictly
    // hierarchical), but the trigger is the last line of defense, so map it to a
    // clean self-correctable tool error rather than an opaque internal error.
    err instanceof ParentCycleError ||
    err instanceof CrossProjectParentError ||
    err instanceof ReporterNotInWorkspaceError ||
    err instanceof AssigneeNotInWorkspaceError ||
    err instanceof TypeNotAllowedOnKindError ||
    // Target-repo validation (MOTIR-1804; project-scoped in MOTIR-1783): a
    // `targetRepo` naming a repo outside the item's PROJECT repository set (or,
    // for a project with no set, the workspace's connected repos) on
    // create_work_item / update_work_item. The message NAMES the repos of the
    // scope it checked, so the agent self-corrects in one hop instead of
    // guessing — the MCP analogue of the route's 422.
    err instanceof UnknownTargetRepoError ||
    // Story-point value validation (7.8.21): a malformed `storyPoints` on
    // create_work_item / update_work_item — out of the Decimal(6, 2) range,
    // negative, or > 2 decimals — surfaces as a clean 422-equivalent tool error
    // the agent can self-correct from, the MCP analogue of the route's 422.
    err instanceof InvalidEstimateError ||
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
  // `get_work_item_activity` (MOTIR-1999): a hand-edited / foreign composite
  // cursor on the All stream. The route maps it to 400; here it reads as a
  // clean INVALID_ACTIVITY_CURSOR the agent self-corrects from by dropping the
  // cursor and re-reading from the top, rather than an opaque internal error.
  if (err instanceof InvalidActivityCursorError) {
    return toolError(err.code, err.message);
  }
  // Link tools (7.8.13): the work-item-link structural guards — a self-link,
  // a dependency CYCLE, and a cross-workspace link surface verbatim so the agent
  // self-corrects (the message names the violation). `WorkItemLinkNotFoundError`
  // keeps the 404-not-403 contract. A DUPLICATE_LINK never reaches here — the
  // `link_work_items` tool treats it as an idempotent success.
  if (
    err instanceof SelfLinkError ||
    err instanceof WorkItemLinkCycleError ||
    err instanceof CrossWorkspaceLinkError ||
    err instanceof WorkItemLinkNotFoundError
  ) {
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
    // validate_sprint (7.8.15): no active sprint + no sprintId → a clean tool
    // error ("plan a sprint / pass a sprintId"), never an opaque 500.
    err instanceof NoActiveSprintError ||
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
  // AI plan-expansion tools (MOTIR-1825). `InvalidTargetError` is the leaf /
  // wrong-project rejection `submitExpand` already throws (a subtask cannot be
  // expanded); the plan-lookup misses keep the 404-not-403 contract. Every
  // motir-ai failure — out of credits, unconfigured, unreachable, a 4xx from the
  // service — is a `MotirAiError` subclass carrying its own code, so the agent
  // reads "OUT_OF_CREDITS" or "AI_UNAVAILABLE" and self-corrects (or gives up
  // honestly) instead of seeing an opaque JSON-RPC internal error.
  if (
    err instanceof InvalidTargetError ||
    err instanceof PlanNotFoundError ||
    err instanceof NoPlanForJobError ||
    err instanceof MotirAiError
  ) {
    return toolError(err.code, err.message);
  }
  // Plan-change CONVERSATION tools (MOTIR-1832) — the same typed errors the
  // cookie routes map to 404 / 400 / 409, surfaced verbatim so the agent can
  // self-correct in one hop: submit a thread that was never opened
  // (PLAN_CHANGE_SESSION_NOT_FOUND — open it and add a turn), submit one with no
  // turns yet (PLAN_CHANGE_EMPTY_INTENT — say what to change first), an empty
  // turn body, too many anchors, or a lost `seq` race (retryable). The submit
  // path's motir-ai failures are `MotirAiError`s, already mapped above.
  if (
    err instanceof PlanChangeSessionNotFoundError ||
    err instanceof EmptyPlanChangeIntentError ||
    err instanceof EmptyPlanChangeTurnError ||
    err instanceof TooManyPlanChangeTargetsError ||
    err instanceof PlanChangeTurnConflictError
  ) {
    return toolError(err.code, err.message);
  }
  // Workspace-membership gate (MOTIR-1879): `list_projects` calls a service
  // whose FIRST act is `projectsService.assertMembership` against the token's
  // bound workspace. The bearer gate already vouched for that membership, so
  // this is only reachable in the race where it was revoked mid-request — map it
  // to a clean tool error so an agent reads NOT_A_MEMBER and stops, rather than
  // an opaque JSON-RPC internal error.
  if (err instanceof NotAMemberError) {
    return toolError(err.code, err.message);
  }
  if (err instanceof McpMissingContextError) {
    return toolError(err.code, err.message);
  }
  // The CI-credit dispatch refusal (MOTIR-1901 · `ci-minutes-allowance.md`
  // §6.2–6.3). `next_ready` / `claim_next_ready` are dispatch paths, so an
  // exhausted org hits this instead of receiving work. The message already names
  // the minutes used, the pool, and the balance — §6.3 requires the surface to be
  // able to say WHY — so an agent reads CI_CREDITS_EXHAUSTED and stops honestly
  // rather than retrying against an opaque internal error. The sibling condition
  // one domain over (`MOTIR_AI_OUT_OF_CREDITS`) is mapped the same way above.
  if (err instanceof CiCreditsExhaustedError) {
    return toolError(err.code, err.message);
  }
  throw err;
}
