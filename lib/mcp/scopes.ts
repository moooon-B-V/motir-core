import type { PermissionKey } from '@/lib/permissions/catalog';
import type { McpToolName } from './registry';

// ⚠️ THE LEGACY TABLE — read `docs/decisions/token-permissions.md`
// (Story MOTIR-2572 · Subtask MOTIR-2573/-2574, 2026-08-10).
//
// This module used to define the LIVE capability vocabulary for an API token:
// six `TokenScope` values, a `TOOL_SCOPES` map over every MCP tool, a default
// grant and the CLI's fixed grant. All four are gone. A token now GRANTS
// `PermissionKey`s from `lib/permissions/catalog.ts`; the model lives in
// `lib/tokens/grant.ts` and the tool map in `lib/mcp/toolPermissions.ts`.
//
// What remains here is the FORWARD MAP for the six strings already sitting in
// `api_token.scopes` rows, and the type that keys it. `TokenScope` is that key
// type and nothing else: it is not a live vocabulary, and NOTHING NEW may be
// typed against it.
//
// ── ⚠️ THE @deprecated BLOCK AT THE FOOT OF THIS FILE IS SCAFFOLDING ────────
// Retiring the four old exports and re-pointing their consumers cannot happen in
// one commit without collapsing MOTIR-2575 / -2576 / -2577 / -2579 / -2580 /
// -2581 / -2583 into this one — every card in the story reads one of them. So
// they survive as `@deprecated` re-exports, each naming the CARD that deletes it,
// and the tree typechecks at every commit on the way. The last card to leave
// removes the block; MOTIR-2585's guard then asserts no live import of the
// retired vocabulary survives outside this legacy table. If you are reading this
// on `main` after MOTIR-2572 merged, the block should not exist — that it does is
// a finding, not a convention.
//
// ── The superseded statement, quoted so the reversal reads as a reversal ────
// The header this file carried until MOTIR-2573 said:
//
//   Per-token SCOPES — the capability boundary for an API token (Story 7.7 ·
//   Subtask 7.7.16). A scope decides which MCP operations a given token may
//   perform; it NARROWS (never widens) the token owner's existing 6.4
//   workspace/project role. The two compose at dispatch (7.7.17): an operation
//   is allowed only if the token's role permits it AND the token carries the
//   scope it maps to.
//
//   "scopes", NOT "permissions" — the durable industry convention for API-token
//   capabilities (GitHub classic-PAT *scopes*, Linear/Slack/Atlassian-OAuth
//   *scopes*). Motir already uses "permissions" for the project access model — a
//   named catalog in `lib/permissions/catalog.ts` that each role holds a SET over
//   (MOTIR-2255) — so reusing that word here would collide. The two axes COMPOSE
//   and never merge: a permission says what the token's owner may do, a scope
//   narrows what this particular token may do on their behalf.
//
// It rested on a premise that expired — that the catalog was a project-access
// model too narrow to describe what a token reaches — and the ADR records why,
// with dates. The COMPOSITION rule in the first paragraph survives verbatim and
// is restated in `lib/tokens/grant.ts`; only the naming claim is retired. No
// card may cite the paragraph above as current.

/**
 * The six scope strings Story 7.7 minted tokens with, and that live in
 * `api_token.scopes` rows to this day.
 *
 * Kept ONLY to key {@link LEGACY_SCOPE_PERMISSIONS} and to recognise a stored
 * value. Not offered anywhere, not persisted by any new write.
 */
export const LEGACY_TOKEN_SCOPES = [
  'read',
  'work_items:write',
  'work_items:archive',
  'work_items:delete',
  'sprints:write',
  'integration',
] as const;

/** One legacy scope string — the key type of {@link LEGACY_SCOPE_PERMISSIONS}. */
export type TokenScope = (typeof LEGACY_TOKEN_SCOPES)[number];

/** Whether an untrusted stored string is one of the six legacy scopes. */
export function isLegacyTokenScope(value: unknown): value is TokenScope {
  return typeof value === 'string' && (LEGACY_TOKEN_SCOPES as readonly string[]).includes(value);
}

/**
 * The FORWARD MAP (ADR §5) — what each stored legacy scope confers, expressed
 * in the permission vocabulary. Applied when a token is READ; nothing rewrites
 * a row and no migration runs.
 *
 * Each entry is the set of permissions that scope's OPERATIONS assert, taken
 * from `lib/mcp/toolPermissions.ts`:
 *
 *   * `read` — every read bottoms out in `assertCanBrowse`.
 *   * `work_items:write` — its tools split FOUR ways once the real gates are
 *     named: the work-item writes (`work_item:edit`), `add_comment`
 *     (`comment:add`), the four planning submits (`ai:plan`), and — since
 *     MOTIR-2988 — `add_plan_items` (`ai:view_plan`). Expanding to all of them
 *     is what keeps an existing token working; the SPLIT is what lets a NEW
 *     token withhold planning, commenting or plan authoring.
 *
 *     ⚠️ `ai:view_plan` joined 2026-08-18 because `add_plan_items` is the first
 *     MCP tool to assert it, and this map must confer whatever `TOOL_SCOPES`
 *     files under a scope or a legacy row silently loses a tool
 *     (`tests/tokens/story-gate.test.ts` asserts exactly that). It confers no
 *     other reach: `approvePlan` / `declinePlan` assert the same key and are not
 *     token-reachable at all, so the widening is one tool wide.
 *   * `work_items:archive` / `work_items:delete` — both archive and delete
 *     assert `work_item:delete`, so the old two-scope split has no counterpart
 *     in the gates.
 *   * `sprints:write` — `assertCanManageSprints` / `assertCanGroom`.
 *   * `integration` — `markIntegrated` / `completeSession` reach
 *     `applyStatusTransition → assertCanEdit`, the same gate `transition_status`
 *     reaches.
 *
 * ⚠️ `integration` and `work_items:write` therefore MERGE at `work_item:edit`,
 * and that is the one place the forward map does not preserve exactly. ADR §5
 * states the direction (each gains the other's operations), why it is accepted
 * (no catalog key is added in this story, `∩ role` still caps both, and no
 * irreversible operation is reached), and that neither shipped default grant has
 * the shape that would expose it.
 */
export const LEGACY_SCOPE_PERMISSIONS: Record<TokenScope, readonly PermissionKey[]> = {
  read: ['project:browse'],
  'work_items:write': ['work_item:edit', 'comment:add', 'ai:plan', 'ai:view_plan'],
  'work_items:archive': ['work_item:delete'],
  'work_items:delete': ['work_item:delete'],
  'sprints:write': ['sprint:manage'],
  integration: ['work_item:edit'],
};

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ DEPRECATED SCAFFOLDING — see the header. Each export below is read by a
// consumer a LATER card in MOTIR-2572 re-points, and is deleted by that card.
// Nothing new may import from this block.
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated Use `GRANTABLE_PERMISSIONS` (`lib/tokens/grant.ts`). Removed by MOTIR-2581. */
export const TOKEN_SCOPES = LEGACY_TOKEN_SCOPES;

/** @deprecated Use `isGrantable` / `isLegacyTokenScope`. Removed by MOTIR-2575. */
export const isTokenScope = isLegacyTokenScope;

/** @deprecated Use `DEFAULT_TOKEN_GRANT` (`lib/tokens/grant.ts`). Removed by MOTIR-2580. */
export const DEFAULT_TOKEN_SCOPES: TokenScope[] = LEGACY_TOKEN_SCOPES.filter(
  (scope) => scope !== 'work_items:delete',
);

/** @deprecated Use `CLI_TOKEN_GRANT` (`lib/mcp/toolPermissions.ts`). Removed by MOTIR-2579. */
export const CLI_TOKEN_SCOPES: TokenScope[] = ['read', 'work_items:write', 'integration'];

/**
 * @deprecated Use `TOOL_PERMISSIONS` (`lib/mcp/toolPermissions.ts`). Removed by
 * MOTIR-2581, which re-points the last reader (the published `/docs` MCP page).
 *
 * The 7.7.16 table, verbatim. It is NOT re-derived from `TOOL_PERMISSIONS`: the
 * two disagree by design (`add_comment` and the four planning submits move out
 * of `work_items:write`, archive joins delete), and a shim that pretended
 * otherwise would make the docs page render the new split under the old names —
 * the exact drift this story removes.
 */
export const TOOL_SCOPES: Record<McpToolName, TokenScope> = {
  get_work_item: 'read',
  get_work_item_activity: 'read',
  list_ready: 'read',
  next_ready: 'read',
  dispatch_prompt: 'read',
  search_work_items: 'read',
  whoami: 'read',
  list_projects: 'read',
  get_project_state: 'read',
  list_sprints: 'read',
  validate_sprint: 'read',
  validate_work_item: 'read',
  // The plan-level validity verdict (MOTIR-3095), mapped into the RETIRED
  // six-scope vocabulary only because this table is total over the registry and
  // a new tool would not compile without a row. `read` is honest here in a way
  // `create_plan`'s `work_items:write` is not: it is a pure read, and its REAL
  // gate (`TOOL_PERMISSIONS` → `project:browse`) is the same class. This row
  // governs nothing but the deprecated docs rendering.
  validate_plan: 'read',
  get_plan_status: 'read',
  get_plan: 'read',
  open_plan_session: 'read',
  // The plan-AUTHORING door (MOTIR-2988), mapped into the RETIRED six-scope
  // vocabulary only because this table is total over the registry and a new tool
  // would not compile without a row. Both are writes, and `work_items:write` is
  // the nearest thing the legacy set has — it is the scope the four planning
  // submits above already sit under here, and the reason it is wrong in the same
  // way for all of them is exactly what `docs/decisions/token-permissions.md` §3
  // replaced this table to fix. The REAL gates are in `TOOL_PERMISSIONS`
  // (`create_plan` → `work_item:edit`, `add_plan_items` → `ai:view_plan`); this
  // row governs nothing but the deprecated docs rendering.
  create_plan: 'work_items:write',
  add_plan_items: 'work_items:write',
  update_plan_item: 'work_items:write',
  create_work_item: 'work_items:write',
  update_work_item: 'work_items:write',
  transition_status: 'work_items:write',
  claim_next_ready: 'work_items:write',
  add_comment: 'work_items:write',
  expand_item: 'work_items:write',
  append_plan_turn: 'work_items:write',
  submit_plan_session: 'work_items:write',
  link_work_items: 'work_items:write',
  unlink_work_items: 'work_items:write',
  move_to_parent: 'work_items:write',
  change_kind: 'work_items:write',
  archive_work_item: 'work_items:archive',
  unarchive_work_item: 'work_items:archive',
  delete_work_item: 'work_items:delete',
  create_sprint: 'sprints:write',
  update_sprint: 'sprints:write',
  delete_sprint: 'sprints:write',
  start_sprint: 'sprints:write',
  complete_sprint: 'sprints:write',
  move_to_sprint: 'sprints:write',
  move_to_backlog: 'sprints:write',
  mark_integrated: 'integration',
  complete_session: 'integration',
};

/** @deprecated Use `toolPermission` (`lib/mcp/toolPermissions.ts`). Removed with `TOOL_SCOPES`. */
export function toolScope(toolName: McpToolName): TokenScope {
  return TOOL_SCOPES[toolName];
}
