import type { McpToolName } from './registry';

// Per-token SCOPES — the capability boundary for an API token (Story 7.7 ·
// Subtask 7.7.16). A scope decides which MCP operations a given token may
// perform; it NARROWS (never widens) the token owner's existing 6.4
// workspace/project role. The two compose at dispatch (7.7.17): an operation is
// allowed only if the token's role permits it AND the token carries the scope
// it maps to.
//
// "scopes", NOT "permissions" — the durable industry convention for API-token
// capabilities (GitHub classic-PAT *scopes*, Linear/Slack/Atlassian-OAuth
// *scopes*). Motir already uses "permissions" for the 6.4 role model
// (`lib/services` role gates), so reusing that word here would collide.
//
// This module is the MODEL + the canonical tool→scope map only — no enforcement
// (7.7.17), no UI (7.7.19). The map is TOTAL over `MCP_TOOL_NAMES` by
// construction: `TOOL_SCOPES` is typed `Record<McpToolName, TokenScope>`, so a
// future tool added to the registry without a scope FAILS typecheck here, and a
// Vitest guard (`tests/mcp/scopes.test.ts`) asserts the same at runtime.

/** The named capability scopes, grouped by the operations they gate. */
export const TOKEN_SCOPES = [
  /** Read-only reads — get/list/search/identity. Never mutates. */
  'read',
  /** Mutating writes on work items — create/update/transition/comment/link. */
  'work_items:write',
  /** Soft-remove + restore a work item (recoverable). */
  'work_items:archive',
  /** Irreversible, subtree-cascade delete — the ONLY destructive op, OFF by default. */
  'work_items:delete',
  /** Sprint lifecycle + membership writes. */
  'sprints:write',
  /** External-agent integration writes — mark-integrated / complete-session. */
  'integration',
] as const;

/** One granted capability on an API token. */
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** Membership test usable on an untrusted string (a persisted/posted value). */
export function isTokenScope(value: string): value is TokenScope {
  return (TOKEN_SCOPES as readonly string[]).includes(value);
}

/**
 * The canonical map from EVERY MCP tool to the single scope that gates it.
 * Typed `Record<McpToolName, TokenScope>`, so adding a tool to
 * `MCP_TOOL_NAMES` without a scope here is a compile error — the totality
 * guarantee the acceptance criteria require, enforced by the type system and
 * re-asserted at runtime by the scope-map totality test.
 */
export const TOOL_SCOPES: Record<McpToolName, TokenScope> = {
  // read
  get_work_item: 'read',
  list_ready: 'read',
  next_ready: 'read',
  search_work_items: 'read',
  whoami: 'read',
  list_sprints: 'read',
  // work_items:write
  create_work_item: 'work_items:write',
  update_work_item: 'work_items:write',
  transition_status: 'work_items:write',
  // claim_next_ready flips the claimed item to in_progress — a status write
  claim_next_ready: 'work_items:write',
  add_comment: 'work_items:write',
  link_work_items: 'work_items:write',
  unlink_work_items: 'work_items:write',
  move_to_parent: 'work_items:write',
  change_kind: 'work_items:write',
  // work_items:archive
  archive_work_item: 'work_items:archive',
  unarchive_work_item: 'work_items:archive',
  // work_items:delete — the only irreversible, subtree-cascade op (off by default)
  delete_work_item: 'work_items:delete',
  // sprints:write
  create_sprint: 'sprints:write',
  update_sprint: 'sprints:write',
  delete_sprint: 'sprints:write',
  start_sprint: 'sprints:write',
  complete_sprint: 'sprints:write',
  move_to_sprint: 'sprints:write',
  move_to_backlog: 'sprints:write',
  // integration
  mark_integrated: 'integration',
  complete_session: 'integration',
};

/** The scope that gates a given tool. */
export function toolScope(toolName: McpToolName): TokenScope {
  return TOOL_SCOPES[toolName];
}

/**
 * The default grant set for a token minted WITHOUT an explicit scope choice:
 * every scope EXCEPT `work_items:delete`. This is the user's requirement —
 * "enable all by default but disable delete". Archive stays on (it is
 * recoverable); only `delete_work_item` cascades to the whole subtree
 * (`lib/mcp/tools/deleteWorkItem.ts`), so it alone is opt-in.
 */
export const DEFAULT_TOKEN_SCOPES: TokenScope[] = TOKEN_SCOPES.filter(
  (scope) => scope !== 'work_items:delete',
);
