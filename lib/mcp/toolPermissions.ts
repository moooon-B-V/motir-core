import type { PermissionKey } from '@/lib/permissions/catalog';
import type { McpToolName } from './registry';

// The MCP tool → PERMISSION map (Story MOTIR-2572 · Subtask MOTIR-2574),
// replacing the `TOOL_SCOPES` table that lived in `lib/mcp/scopes.ts`. Decided
// in `docs/decisions/token-permissions.md` §3: each entry names the permission
// the tool's own SERVICE already asserts, read off the code and grounded in
// `docs/decisions/permission-inventory.md` — never carried over from the scope
// the tool used to declare.
//
// A LEAF module: the only imports are TYPES (erased at compile), so it loads
// identically in a server component, a client bundle and a bare test — the same
// property `lib/permissions/catalog.ts` holds and for the same reason. The token
// picker reads the grantable set derived from this map, so anything runtime it
// pulled in would be pulled into the browser with it.
//
// ── The totality guarantee, unchanged from 7.7.16 ──────────────────────────
// Typed `Record<McpToolName, PermissionKey>`, so a tool added to
// `MCP_TOOL_NAMES` without a permission is a COMPILE error here, and
// `tests/mcp/toolPermissions.test.ts` re-asserts the same at runtime so it
// survives a type-erasure refactor.

/**
 * The canonical map from EVERY MCP tool to the single permission that gates it.
 *
 * Where a tool's permission is not obvious from its name, the comment cites the
 * assertion in the service (rung 2) or the row in
 * `docs/decisions/permission-inventory.md` that decided it.
 */
export const TOOL_PERMISSIONS: Record<McpToolName, PermissionKey> = {
  // ── project:browse — the reads ────────────────────────────────────────────
  // Each of these bottoms out in `assertCanBrowse` (`hasPermission(…,
  // 'project:browse')`, lib/projects/access.ts) via `projectsService.getByKey`
  // or `workItemsService.getWorkItemByIdentifier`.
  get_work_item: 'project:browse',
  // `activityService.listHistory` asserts `project:browse` by name; `listAll`
  // reaches it through `commentsService.listComments` → `assertCanBrowse`.
  get_work_item_activity: 'project:browse',
  list_ready: 'project:browse',
  next_ready: 'project:browse',
  // Reads the item and assembles text; it never claims the item or flips its
  // status (that is `claim_next_ready`'s job, which is why they differ here).
  dispatch_prompt: 'project:browse',
  search_work_items: 'project:browse',
  // `aiBoundaryService.searchSimilarWorkItemsByText` asserts `project:browse` by
  // name, BEFORE it embeds — so a caller who may not browse the project cannot
  // spend the deployment's gateway budget on a refusal. It is NOT `ai:plan`:
  // that key gates the billable planning SUBMITS, and this starts no job and
  // proposes nothing (`docs/decisions/plan-tree-embeddings.md` Amendment 2 pins
  // the spend to the `ai:chat` RATE LIMIT instead, which is a ceiling and not a
  // permission).
  search_work_items_semantic: 'project:browse',
  // The identity read, and the ONE entry not justified by a project gate the
  // operation itself runs: `whoami` resolves the token owner's profile and the
  // bound workspace's summary, touching no project. The catalog is
  // project-scoped and has no identity key (adding one is outside MOTIR-2572's
  // scope boundary), so it takes the catalog's READ FLOOR. The consequence is
  // the intended one: a grant holding nothing cannot enumerate the owner.
  whoami: 'project:browse',
  // `projectsService.listProjects` asserts workspace membership and then drops
  // every project through `projectAccessService.filterBrowsable` — i.e. it
  // evaluates `project:browse` per row. The map names what the filter asks.
  list_projects: 'project:browse',
  get_project_state: 'project:browse',
  // `aiBoundaryService.readPlanTree` calls `workItemsService.listWorkItems`,
  // which asserts `project:browse` by name, and the tool resolves its
  // `projectKey` through `projectsService.getByKey` (`assertCanBrowse`) first.
  skeleton: 'project:browse',
  // `sprintsService.listByProject` asserts `project:browse` by name.
  list_sprints: 'project:browse',
  validate_sprint: 'project:browse',
  validate_work_item: 'project:browse',
  // The PLAN-level finishability verdict (MOTIR-3095), and the entry most
  // likely to be filed under `ai:view_plan` by analogy with its neighbour
  // `add_plan_items`. It is not. `planValidityService.validateProjectedPlan`
  // reads the plan through `plansService.getPlan`, which runs
  // `projectAccessService.assertCanBrowse` — the same key its two sibling
  // validators name. `ai:view_plan` gates the plan DECISIONS (`approvePlan` /
  // `declinePlan` / `addProposals`); a projection decides nothing, writes
  // nothing and persists nothing, so filing it there would narrow a read below
  // the gate that actually runs — §3's no-fiction rule in the other direction
  // (`docs/decisions/agent-authored-plans.md` AMENDMENT 3, Q8). The same
  // reasoning is why `validate_work_item` / `validate_sprint` keep
  // `project:browse` after gaining their optional `planId`: the projected reach
  // is exactly the reach of the two browse-gated calls it replaces.
  validate_plan: 'project:browse',
  // The two plan READS resolve through `plansService.getPlan` /
  // `findPlanIdForJob`, both `assertCanBrowse`. They are NOT `ai:view_plan`:
  // that key gates the plan DECISIONS (`approvePlan` / `declinePlan` /
  // `addProposals`).
  //
  // ⚠️ AMENDED 2026-08-18 (MOTIR-2988). This comment used to end "…, none of
  // which is an MCP tool." That was true until `add_plan_items` shipped, and it
  // is exactly the sentence a later reader would use to conclude the new
  // `ai:view_plan` entry below is a mistake — so it is corrected here rather
  // than left to age. The reads are still `project:browse`; what changed is that
  // one of the DECISIONS now has a door.
  get_plan_status: 'project:browse',
  get_plan: 'project:browse',

  // ── work_item:edit — the work-item writes ────────────────────────────────
  create_work_item: 'work_item:edit',
  // OPENS a plan, and creates no work item — but `plansService.createPlan` runs
  // `projectAccessService.assertCanEdit` (→ `hasPermission(…, 'work_item:edit')`,
  // lib/projects/access.ts), so this is the key its own service asserts. §3's
  // rule is total: declaring something narrower here than the gate actually
  // applies would be a fiction, not a narrowing. Its partner `add_plan_items`
  // sits under `ai:view_plan` below, so authoring a plan needs BOTH — see
  // `docs/decisions/agent-authored-plans.md` Q2.
  create_plan: 'work_item:edit',
  update_work_item: 'work_item:edit',
  transition_status: 'work_item:edit',
  // Flips the claimed item to in_progress through `applyStatusTransition` →
  // `assertCanEdit`.
  claim_next_ready: 'work_item:edit',
  link_work_items: 'work_item:edit',
  unlink_work_items: 'work_item:edit',
  move_to_parent: 'work_item:edit',
  // `changeKind` runs through `workItemsService.updateWorkItem`.
  change_kind: 'work_item:edit',
  // The two INTEGRATION writes. Both reach `applyStatusTransition` →
  // `assertCanEdit`, which is the same gate `transition_status` reaches — so
  // the old `integration` / `work_items:write` split does not survive contact
  // with the gates. `docs/decisions/token-permissions.md` §5 records that
  // merge, its direction, and why it is accepted rather than papered over.
  mark_integrated: 'work_item:edit',
  complete_session: 'work_item:edit',

  // ── comment:add ───────────────────────────────────────────────────────────
  // `commentsService` gates the add on `getCommentCapabilities().canComment`,
  // i.e. `hasPermission(…, 'comment:add')` — a viewer is read-only and gets
  // `CommentForbiddenError`. Under the six scopes this hid inside
  // `work_items:write`; commenting is now withholdable on its own.
  add_comment: 'comment:add',

  // ── sprint:manage — the sprint lifecycle + membership ────────────────────
  // `sprintsService.assertCanManageSprints` and `backlogService.assertCanGroom`
  // both assert `sprint:manage`.
  create_sprint: 'sprint:manage',
  update_sprint: 'sprint:manage',
  delete_sprint: 'sprint:manage',
  start_sprint: 'sprint:manage',
  complete_sprint: 'sprint:manage',
  move_to_sprint: 'sprint:manage',
  move_to_backlog: 'sprint:manage',

  // ── ai:plan — the billable planning submits ──────────────────────────────
  // `aiPlanEditsService.assertCanPlan` / `planChangeSessionsService.assertCanPlan`
  // both assert `ai:plan`. These four were filed under `work_items:write`
  // because nothing narrower existed, and `lib/mcp/scopes.ts` said so in a
  // comment. They spend the owner's AI credits; a token wired to file work
  // items can no longer fire one.
  expand_item: 'ai:plan',
  // `getOrCreateForScope` asserts `ai:plan` — opening the thread is already a
  // planning act at the gate, whatever the old `read` scope implied.
  open_plan_session: 'ai:plan',
  append_plan_turn: 'ai:plan',
  submit_plan_session: 'ai:plan',

  // ── ai:view_plan — the plan DECISION that now has a door ─────────────────
  // `plansService.addProposals` (and `markPlanned`, which `final: true` also
  // reaches) assert `ai:view_plan` by name. The key's name reads as a view and
  // gates a write — the service says so itself ("a write key wearing a read's
  // name"), which is why the decision record puts it at `member` rather than at
  // browse. NOT `ai:plan`: this tool starts no job and spends no AI credits, so
  // the key that gates the billable submits would be the wrong one in both
  // directions (`docs/decisions/agent-authored-plans.md` Q2).
  add_plan_items: 'ai:view_plan',
  // The DEEPEN turn (Story MOTIR-3088 · Subtask MOTIR-3090). Same key, and by the
  // same rule rather than by family resemblance: `plansService.deepenProposal`
  // delegates to `editAddProposal`, whose FIRST act is
  // `assertPermission(plan.projectId, ctx, 'ai:view_plan')`. That the answer
  // coincides with its sibling's is a check, not the argument
  // (`docs/decisions/agent-authored-plans.md` AMENDMENT 4 D2). Not billable — it
  // starts no model job — and `CLI_TOKEN_GRANT` below is deliberately NOT widened
  // for it, exactly as it was not for `add_plan_items`.
  update_plan_item: 'ai:view_plan',

  // ── work_item:delete — the recoverable and the irreversible ──────────────
  // `archiveWorkItem` / `unarchiveWorkItem` / `deleteWorkItem` all assert
  // `work_item:delete` by name. The old `work_items:archive` /
  // `work_items:delete` split has no counterpart in the gates: the product
  // already governs both with one key (ADR §3).
  archive_work_item: 'work_item:delete',
  unarchive_work_item: 'work_item:delete',
  delete_work_item: 'work_item:delete',
};

/** The permission that gates a given tool. */
export function toolPermission(toolName: McpToolName): PermissionKey {
  return TOOL_PERMISSIONS[toolName];
}

/**
 * The FIXED grant a `motir login` device-authorization approval mints (Story
 * MOTIR-1863 · Subtask MOTIR-1865; `docs/decisions/cli-login.md` Q2, re-expressed
 * by `docs/decisions/token-permissions.md` §7). Replaces `CLI_TOKEN_SCOPES`.
 *
 * It is the narrowest set covering exactly what the CLI calls over MCP —
 * `packages/cli/src/client.ts` (the ADR corrects the stale `mcpClient.ts` path
 * the old comment named). It deliberately EXCLUDES `sprint:manage` and
 * `work_item:delete`: a credential living unattended on a remote box must not be
 * able to delete a subtree.
 *
 * It lives HERE, beside {@link TOOL_PERMISSIONS}, because that co-location IS the
 * guardrail: adding an MCP tool now carries a second question next to its map
 * entry — does the CLI call it, and does this set already cover it? A tool gated
 * by `sprint:manage` that the CLI later calls would 403 on every device-minted
 * token.
 *
 * The approval screen SHOWS these and cannot change them — neither widen (a
 * `work_item:delete` control on a socially-engineerable screen is the one
 * affordance that turns a phishing success into a destructive one) nor narrow (a
 * hand-narrowed grant breaks `motir auto` mid-run). A different grant is minted
 * in Settings → Account → Tokens and carried by `motir auth login --token`.
 */
export const CLI_TOKEN_GRANT: readonly PermissionKey[] = [
  'project:browse',
  'work_item:edit',
  'comment:add',
  'ai:plan',
];
