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
  // validators name. `ai:view_plan` gates the plan AUTHOR writes (`addProposals`
  // / `markPlanned` / `editAddProposal`) and `ai:decide_plan` the two DECISIONS
  // (`approvePlan` / `declinePlan`, split out by MOTIR-3188); a projection
  // decides nothing, writes
  // nothing and persists nothing, so filing it there would narrow a read below
  // the gate that actually runs — §3's no-fiction rule in the other direction
  // (`docs/decisions/agent-authored-plans.md` AMENDMENT 3, Q8). The same
  // reasoning is why `validate_work_item` / `validate_sprint` keep
  // `project:browse` after gaining their optional `planId`: the projected reach
  // is exactly the reach of the two browse-gated calls it replaces.
  validate_plan: 'project:browse',
  // The two plan READS resolve through `plansService.getPlan` /
  // `findPlanIdForJob`, both `assertCanBrowse`. They are NOT `ai:view_plan`:
  // that key gates the plan AUTHOR writes (`addProposals` / `markPlanned` /
  // `editAddProposal`). Nor are they `ai:decide_plan`, which MOTIR-3188 split
  // off for `approvePlan` / `declinePlan` — neither of which is an MCP tool.
  //
  // ⚠️ AMENDED 2026-08-18 (MOTIR-2988). This comment used to end "…, none of
  // which is an MCP tool." That was true until `add_plan_items` shipped, and it
  // is exactly the sentence a later reader would use to conclude the new
  // `ai:view_plan` entry below is a mistake — so it is corrected here rather
  // than left to age. The reads are still `project:browse`; what changed is that
  // one of the DECISIONS now has a door.
  //
  // ⚠️ AMENDED AGAIN 2026-08-19 (MOTIR-3021), for the same reason: a SECOND
  // decision now has a door. `approvePlan` is reachable by a bearer token
  // through `POST /api/v1/work-items/{key}/plan-approval`, BOUNDED to the plan a
  // run's own refused card produced (`docs/decisions/run-findings-protocol.md`
  // Q2). It is deliberately NOT an MCP tool — MCP is the agent's surface and an
  // agent must never approve its own re-plan — so this MAP is unchanged; only
  // the claim that the decisions are unreachable would now be wrong.
  // `declinePlan` still has no door of any kind.
  //
  // ⚠️ AND AMENDED ONCE MORE 2026-08-20 (MOTIR-3188), where the two met at a
  // merge. The paragraph above said that route was gated by "this same
  // `ai:view_plan` key", and it no longer is: the DECISIONS were split onto
  // `ai:decide_plan`, so the route declares that. The bound the paragraph ends on
  // is unchanged and now rests on something stronger than an omission —
  // `CLI_TOKEN_GRANT` omits the decide key too, AND no tool in this map asserts
  // it, so a token minted FOR a dispatched agent is out of the route by
  // construction (MOTIR-3051). Do not widen that grant. The key IS grantable to
  // an operator's token, through that one v1 operation and no other:
  // `lib/tokens/grant.ts`'s `V1_ONLY_PERMISSIONS` carries it, which is the first
  // entry that array has ever held.
  get_plan_status: 'project:browse',
  get_plan: 'project:browse',

  // ── lesson:reinforce — recording that a lesson's mistake recurred ─────────
  // Its own key, not `lesson:manage`: this changes nothing a lesson SAYS, and
  // the service asserts exactly what is declared here (§3's rule).
  reinforce_lesson: 'lesson:reinforce',

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
  // The KEYED claim (MOTIR-2961). It assigns AND transitions, which is exactly
  // what `work_item:edit` gates — and it is already in `CLI_TOKEN_GRANT`, so a
  // dispatched agent can actually call it (the MOTIR-3051 shape, avoided).
  claim_work_item: 'work_item:edit',
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
  // `add_lesson` (Story MOTIR-3331 · MOTIR-3361) — the SAME key retiring a
  // lesson takes. `lesson:manage` is named for the LIBRARY rather than for
  // retiring precisely so this caller does not have to widen its meaning
  // (MOTIR-3336): adding a lesson and retiring one are both edits to the
  // standing instructions the planner receives.
  add_lesson: 'lesson:manage',

  // `search_lessons` (Story MOTIR-3466 · MOTIR-3480) — the READ key, not the
  // manage key. `lesson:view` and `lesson:manage` were separated in MOTIR-3336
  // precisely so a role that may READ the library without editing it is
  // expressible, and gating a read on the manage key would quietly undo that at
  // the first call site: an admin holds both, so a manual walk and every E2E
  // would pass while the distinction failed for the role nobody has created yet.
  search_lessons: 'lesson:view',
  // Attaching a file to a card is EDITING that card — the same permission both
  // evidence publishers assert, and one CLI_TOKEN_GRANT carries, so a
  // dispatched agent can actually call it (MOTIR-3058; MOTIR-3051 is the
  // counter-example this deliberately avoids).
  attach_file: 'work_item:edit',
  // `publish_design_result` (MOTIR-3782) — the SAME key, and the comment above
  // is the reason it needed no argument of its own: the design-publish route has
  // asserted `work_item:edit` since MOTIR-2667, and `CLI_TOKEN_GRANT` has
  // carried it the whole time. Moving the publish from CI to the agent
  // therefore adds no credential and no trust; it only stops requiring a script
  // to be present in the repository. `CLI_TOKEN_GRANT` is NOT widened here.
  publish_design_result: 'work_item:edit',
  // The ACCEPTANCE publish pair (MOTIR-4704) — the SAME key again, and not by
  // analogy: `ACCEPTANCE_PUBLISH_PERMISSION` in `lib/tokens/grant.ts` IS
  // `work_item:edit`, and the service's own `resolveStory` asserts it on the
  // story's project (MOTIR-2365 put it there after `createUploadTokens` was
  // found reachable with a session and a story id alone). §3's rule is
  // satisfied by construction: what is declared here is what the gate applies.
  // ⚠️ `create_acceptance_upload` MINTS a presigned write against the
  // workspace's object store, so it is a WRITE key even though it persists no
  // row — declaring it a read would hand out object-store grants on a browse
  // permission.
  create_acceptance_upload: 'work_item:edit',
  publish_acceptance_result: 'work_item:edit',
  // `link_pull_request` (Story MOTIR-3525 · MOTIR-3526) — declaring which work
  // item a pull request delivers is EDITING that work item, so it takes the same
  // key the picker's own write path sits behind, and the SERVICE asserts it too
  // rather than leaning on this gate alone.
  //
  // ⚠️ `CLI_TOKEN_GRANT` ALREADY CARRIES `work_item:edit` and is NOT widened by
  // this card — the whole point of choosing this key over a new one. That is
  // recorded here rather than reasoned about at the call site, because the
  // opposite failure ships GREEN: a tool that registers, passes every suite
  // against a workspace PAT, and refuses the sandboxed agent it was built for
  // (MOTIR-3058 and MOTIR-3051, twice on this same constant).
  link_pull_request: 'work_item:edit',
  // `unlink_pull_request` (MOTIR-3756) — THE SAME KEY, deliberately. Undoing a
  // link is editing the card the link was made against, exactly as making it was;
  // and a correction door a token cannot reach while it CAN reach the door that
  // creates the mistake is strictly worse than no door at all. `CLI_TOKEN_GRANT`
  // already carries `work_item:edit`, so nothing is widened here either.
  unlink_pull_request: 'work_item:edit',

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

  // ── ai:view_plan — the plan AUTHOR write that has a door ─────────────────
  // `plansService.addProposals` (and `markPlanned`, which `final: true` also
  // reaches) assert `ai:view_plan` by name. The key's name reads as a view and
  // gates a write, which is why the decision record puts it at `member` rather
  // than at browse.
  //
  // ⚠️ AMENDED BY MOTIR-3188. This heading used to say "the plan DECISION that
  // now has a door", and the paragraph cited the service's own "a write key
  // wearing a read's name". The DECISIONS have since moved to `ai:decide_plan`
  // (`approvePlan` / `declinePlan`), and neither of them is an MCP tool — so
  // what has a door here is the AUTHOR half, and only that. Left corrected
  // rather than deleted: the sentence about the misleading name is exactly what
  // a later reader would use to conclude these two rows belong on the decide
  // key. They do not — the rule is still that a row names the key its own
  // service asserts, and `editAddProposal` asserts `ai:view_plan`.
  //
  // NOT `ai:plan`: this tool starts no job and spends no AI credits, so
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
  // The CORRECTION door (Story MOTIR-3533 · Subtask MOTIR-3541). Same key, and
  // again by the rule rather than by family resemblance: both
  // `plansService.correctProposal` and `.withdrawProposal` assert
  // `ai:view_plan` themselves, as their FIRST act, exactly as `editAddProposal`
  // does (`agent-authored-plans.md` AMENDMENT 8).
  //
  // ⚠️ AND `CLI_TOKEN_GRANT` IS DELIBERATELY NOT WIDENED FOR THEM — read this
  // before "fixing" a sandboxed run that gets refused here. A dispatched agent
  // holds `['project:browse', 'work_item:edit', 'comment:add', 'ai:plan']`, so
  // it can `create_plan` and is refused on its first `add_plan_items`; these two
  // are refused for the same reason and it is the SAME reason as MOTIR-3051's.
  // That is the grant working: a run executing a card does not get to reshape
  // the plan it was handed, and the missing key is the mechanism enforcing it.
  // Widening it here would hand a sandboxed run the whole plan-authoring
  // surface through the back door. These tools serve the WORKSPACE-PAT author —
  // the caller that actually hits the un-repairable-typo failure — and
  // `tests/mcp/correct-plan-proposal.test.ts` asserts the CLI-token REFUSAL off
  // this very constant, so a later widening of it fails that test rather than
  // silently changing what a sandboxed agent may do to a plan.
  update_plan_proposal: 'ai:view_plan',
  withdraw_plan_proposal: 'ai:view_plan',
  // The PLAN'S OWN title / summary (MOTIR-4637). Same key, and again by the rule
  // rather than by family resemblance: `plansService.correctPlanBrief` asserts
  // `ai:view_plan` itself, as its FIRST act, exactly as its three siblings do.
  // `CLI_TOKEN_GRANT` is deliberately NOT widened for it either — a sandboxed run
  // that may not reshape the plan it was handed may not rewrite what that plan
  // says about itself, and `tests/mcp/update-plan.test.ts` asserts that refusal
  // off the constant.
  update_plan: 'ai:view_plan',

  // ── removal — the RECOVERABLE and the IRREVERSIBLE, now two keys ─────────
  // ⚠️ CORRECTED (MOTIR-3629). This block used to read: "`archiveWorkItem` /
  // `unarchiveWorkItem` / `deleteWorkItem` all assert `work_item:delete` by name.
  // The old `work_items:archive` / `work_items:delete` split has no counterpart
  // in the gates: the product already governs both with one key (ADR §3)."
  //
  // That was an accurate reading of the gates and a false thing to keep. The
  // grouping came from `permission-inventory.md` R42 — "archive / delete cascades
  // over a subtree" — and archive does not cascade: it stamps `archivedAt` on ONE
  // row and leaves the children live. So one key spanned a reversible single-row
  // hide and an irreversible subtree destroy, and no grantor could confer the
  // first without the second. `work_item:archive` is that missing term
  // (`docs/decisions/token-permissions.md` §10); the services moved with it, and
  // this map still names exactly what each tool's service asserts (§3).
  //
  // A grant holding `work_item:delete` alone still reaches these two, because
  // `PERMISSION_IMPLICATIONS` confers archive from delete at resolution — so no
  // minted token and no authored role lost an operation on the day this shipped.
  archive_work_item: 'work_item:archive',
  unarchive_work_item: 'work_item:archive',
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
 * ⚠️ AND IT EXCLUDES `work_item:archive` TOO (MOTIR-3629), which is a decision
 * rather than an omission — the split made archive separately grantable for the
 * first time, so the question "should the device grant take it?" now has to be
 * answered instead of being settled by delete's absence. It should not: this set
 * covers exactly what the CLI CALLS, and the CLI calls neither
 * `archive_work_item` nor `unarchive_work_item`. The workflow that wants archive
 * routinely — the re-plan procedure's *archive the superseded nodes* — runs under
 * the WORKSPACE PAT, which chooses its own grant, and that PAT is what the split
 * was filed for. §7's rule is that this set is widened only where a card argues
 * for it (as `lesson:view` and `lesson:reinforce` do, directly below); nothing
 * here argues for archive, so it stays out.
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
  // ⚠️ CATALOG ORDER, NOT APPEND ORDER — and this is load-bearing, not tidiness.
  // The device flow returns the minted token's scope string NORMALIZED to
  // `lib/permissions/catalog.ts`'s `PERMISSIONS` order, and `cliDeviceService`'s
  // and the token route's specs compare that wire string to this array joined.
  // The two agree only while this list is DECLARED in catalog order; appending a
  // key at the end instead breaks both, far from here and with no type error.
  // (`lesson:view` sits beside `project:browse` in the catalog because placement
  // there follows the DOMAIN — MOTIR-3361 records why that is deliberate.)
  //
  // ⚠️ It cannot be `sortByCatalogOrder(...)`: that is a VALUE import, and this
  // module's header pins it as a LEAF whose only imports are types. Hand-order it.
  'project:browse',
  // ⚠️ `lesson:view` — WIDENED DELIBERATELY for `search_lessons` (Story
  // MOTIR-3466 · MOTIR-3480), and the argument is made here rather than assumed,
  // because `docs/decisions/token-permissions.md` §3 and MOTIR-3051's AC 4 both
  // say this set stays fixed UNLESS a card argues explicitly for widening it.
  // MOTIR-3051's own option (3) was rejected on exactly that basis.
  //
  // The argument: a sandboxed `motir run` agent is THE caller this capability
  // exists for — the runbook instructs every run to consult the mistakes corpus
  // before it builds, and until this tool that corpus was reachable only by
  // grepping a seed FILE, which sees the global half and misses the project's
  // own entirely. The key being added is a READ over guidance the agent is
  // already told to read. It grants no write, opens no new scope, spends no
  // credits beyond the embedding the tool's own rate limit already bounds, and
  // the approval screen shows it.
  //
  // This is the failure that ships GREEN, which is why it is a criterion with a
  // test and not a line to remember: the tool registers, every suite passes
  // against a workspace PAT, and the one caller the feature was built for gets a
  // refusal it will read as an outage. That has happened twice on this same
  // constant — MOTIR-3058 (the attach tool) and MOTIR-3051 (a CLI token that
  // could open a plan and never fill it, because this grant held one key of the
  // pair).
  'lesson:view',
  // ⚠️ `lesson:reinforce` — WIDENED DELIBERATELY for `reinforce_lesson` (Bug
  // MOTIR-3547 · MOTIR-3553), and argued here rather than assumed, on the same
  // terms `lesson:view` was. It sits AFTER `lesson:view` because that is catalog
  // order, which this list is declared in (see the note at the top).
  //
  // The argument: a sandboxed `motir run` agent is again THE caller this exists
  // for. The runbook already instructs every run to consult the mistakes corpus
  // before it builds; what it could not do until now is say that a lesson it
  // consulted described the thing that just went wrong. Without that, the corpus
  // decays on a timer no amount of use resets — every hit invisible, so the
  // lessons being relied on most look identical to the ones nobody has read
  // since they were seeded.
  //
  // What it grants is deliberately small: an ADDITIVE, IDEMPOTENT record, keyed
  // on an occurrence ref so a replay writes nothing. It cannot change what a
  // lesson says, cannot retire one, and cannot create one. That is exactly why
  // it is not `lesson:manage` — granting THAT to reach this would hand every
  // device-minted token the ability to retire a lesson, trading a policy
  // capability for a bookkeeping one in a grant that is deliberately narrow.
  'lesson:reinforce',
  'work_item:edit',
  'comment:add',
  'ai:plan',
];
