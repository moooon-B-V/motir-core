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
  // dispatch_prompt only READS the item and assembles text — it never claims it
  // or flips its status (that is claim_next_ready's job).
  dispatch_prompt: 'read',
  search_work_items: 'read',
  whoami: 'read',
  // list_projects enumerates the token workspace's browsable projects — a pure
  // read, and the narrowest one: it takes no arguments and cannot leave the
  // token's own workspace.
  list_projects: 'read',
  list_sprints: 'read',
  validate_sprint: 'read',
  validate_work_item: 'read',
  // get_plan_status only READS a plan's status + proposal count — it neither
  // submits a job nor spends a credit.
  get_plan_status: 'read',
  // get_plan READS the same plan WITH its proposals. Still a pure read: a
  // proposal is not a work item, and approving the plan (the only thing that
  // creates one) does not happen on this surface at all.
  get_plan: 'read',
  // open_plan_session is the planning conversation's MOUNT read — "show me the
  // thread for this scope". It get-or-creates an empty conversation row, which
  // is a write in the narrow sense, but it is idempotent, spends no credit,
  // opens no Plan and changes nothing about the plan or the tree; the acts that
  // do — accumulating intent and sending it — are the two below. Opening the
  // door is not starting a conversation.
  open_plan_session: 'read',
  // work_items:write
  create_work_item: 'work_items:write',
  update_work_item: 'work_items:write',
  transition_status: 'work_items:write',
  // claim_next_ready flips the claimed item to in_progress — a status write
  claim_next_ready: 'work_items:write',
  add_comment: 'work_items:write',
  // expand_item writes no work item — the Plan approval gate stands between its
  // proposals and the tree — but it is emphatically not a read: it submits a
  // job that spends the owner's AI credits and opens a Plan row. `work_items:write`
  // is the narrowest shipped scope that admits a plan-mutating, billable submit,
  // so a read-only token cannot fire one.
  expand_item: 'work_items:write',
  // append_plan_turn writes the user's intent onto a persisted thread that a
  // later submit sends to the planner; submit_plan_session spends the owner's
  // AI credits and opens a Plan row. Same reasoning as expand_item: neither
  // writes a work item (the Plan approval gate stands in the way), and neither
  // is a read. `work_items:write` is the narrowest shipped scope that admits
  // them, so a read-only token can look at a thread but never extend or fire one.
  append_plan_turn: 'work_items:write',
  submit_plan_session: 'work_items:write',
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

/**
 * The FIXED grant a `motir login` device-authorization approval mints (Story
 * MOTIR-1863 · Subtask MOTIR-1865; decided in `docs/decisions/cli-login.md` Q2).
 * Deliberately NARROWER than {@link DEFAULT_TOKEN_SCOPES}: every one of the
 * sixteen tools `packages/cli/src/mcpClient.ts` calls maps through
 * {@link TOOL_SCOPES} into exactly these three, and the CLI calls nothing gated by
 * `work_items:archive`, `work_items:delete` or `sprints:write` — so the default
 * set would over-grant three scopes to a credential that lives unattended on a
 * remote box.
 *
 * It lives HERE, beside `TOKEN_SCOPES` / `DEFAULT_TOKEN_SCOPES` and the tool→scope
 * map, because that co-location is the guardrail: adding an MCP tool now carries a
 * third question next to its `TOOL_SCOPES` entry — does the CLI call it, and if so
 * does this set already cover it? A tool gated by `sprints:write` that the CLI
 * later calls would 403 on every device-minted token.
 *
 * The approval screen SHOWS these and cannot change them (neither widen — a
 * `work_items:delete` control on a socially-engineerable screen is the one
 * affordance that turns a phishing success into a destructive one — nor narrow: a
 * hand-narrowed grant breaks `motir auto` mid-run). A different grant is minted in
 * Settings → Account → API tokens and carried by `motir auth login --token`.
 */
export const CLI_TOKEN_SCOPES: TokenScope[] = ['read', 'work_items:write', 'integration'];
