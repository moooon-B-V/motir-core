# Permission inventory — every operation, its gate today, and the permission that should govern it

> **Story MOTIR-2255 · Subtask MOTIR-2274.** Produced by walking `app/api/**/route.ts`, the
> `'use server'` actions and `lib/services/*` on `origin/main`, 2026-08-06 — read from the code,
> not from memory. Pinned to the filesystem by `tests/permissions/inventoryCoverage.test.ts`, so a
> route added without a decided policy fails the build.

## Why this document exists

`lib/permissions/catalog.ts` shipped with **eleven** keys, derived from the eleven predicates in
`lib/projects/access.ts` on the principle that _a key with no enforcement point behind it is a
promise the product cannot keep_. That principle is right and stays. What it assumed is that the
eleven predicates ARE the enforcement surface. They are not — so the catalog was honest about every
key it held and silent about most of the product, which reads, to anyone opening the Roles &
permissions page, as a complete answer.

**An operation is not required to become a permission. It is required to have an ANSWER.**

## The measured surface

|                                            |                                               |
| ------------------------------------------ | --------------------------------------------- |
| API routes                                 | **255**                                       |
| `'use server'` action files                | **22**                                        |
| Services in `lib/services`                 | **122**, of which **40** reach a project gate |
| Routes — workspace membership only         | **89**                                        |
| Routes — session only                      | **65**                                        |
| Routes — project-gated                     | **77**                                        |
| Routes — no context resolved               | **32**                                        |
| Routes — serviceAuth / internal (no actor) | **15**                                        |

> **Three routes were added on 2026-08-26 (Story 8.11 · MOTIR-1213).** The account two-factor
> surface — `status`, `backup-codes`, `trusted-devices` — takes the route total to **255** and the
> session-only count to **65**. All three are R31: they act on the signed-in user's own account, the
> user id comes from the session and is never accepted from the request, and the ownership check on
> the revoke is a `value = <session user>` clause in the repository rather than a filter — see
> `verificationRepository.deleteTrustedDeviceForUser`.
>
> **Two of these numbers were re-measured on 2026-08-06 (MOTIR-2292).** `/api/ai/coding-convention/audit-coverage`
> shipped after this document was written, so the route total is **252**, not 251. And the project-gated
> count was **52** because the walk in `tests/permissions/noUngovernedOperation.test.ts` mistook a
> parameter's inline object type (`opts: { repoKeys?: string[] } = {}`) for a method body and could not
> see the `assertCan*` on the next line — 24 gated routes read as ungoverned. The real figure was **76**.
> Nothing was gated to achieve that: the instrument was wrong, not the product.
>
> **And one route has moved between those two buckets since (MOTIR-2346).** `/api/canvas-layout` was
> `session only` and is now project-gated on `project:browse`, so the split reads **62 / 77**. That one
> IS a gate being added, not a re-measurement — the distinction the paragraph above turns on.

## The resulting catalog

**31 permissions across 16 domains — and as of MOTIR-2356, ALL 31 are enforced by
a gate. `PLANNED_PERMISSIONS` is empty.** The paragraph below records how the
`planned` tier worked while it existed, because the seam it describes is what
makes the NEXT key safe to name before it is wired.

Historically **23** were
enforced by a gate; **8** were `planned` — justified by a row below, and wired by **two**
stories: **MOTIR-2256** takes the twelve ADMINISTRATIVE keys that split out of `project:administer`
(member, board, workflow, field, estimation, repository, `ai:configure`), and **MOTIR-2291** takes the
eight MEMBER-FACING ones (`ai:plan`, `ai:view_plan`, `sprint:manage`, `report:view`,
`saved_filter:manage`, `import:run`, `work_item:triage`, `work_item:delete`) — those are governed by
nothing at all today, so wiring them takes capability away from real actors and is argued on its own.
A `planned` key is never offered in the role editor. **There are none left**: every
key in the catalog is consulted by a shipped gate, every row in the table below
carries a decided policy, and no row says `new`.

> **The enforced / planned split moves as MOTIR-2256 lands, one domain per card.** The counts above
> are read on this branch, not as of the day the document was written — `tests/permissions/catalog.test.ts`
> pins them against the code, so a key that flips without a gate behind it (or a gate that lands
> without the catalog being told) fails the build rather than drifting here. Wired so far:
> **`member:manage` · `project:manage_access`** (MOTIR-2295) · **`ai:configure`** (MOTIR-2300) ·
> **`repository:manage` · `repository:manage_access`** (MOTIR-2299) · **`board:configure`** (MOTIR-2296) ·
> **`workflow:manage` · `automation:manage`** (MOTIR-2297) ·
> **`field:manage` · `component:manage` · `label:manage` · `estimation:manage`** (MOTIR-2298) — the
> whole twelve are now wired.
>
> **MOTIR-2291's eight move the same way, one key per card.** Wired so far: **`sprint:manage`**
> (MOTIR-2350) · **`report:view`** (MOTIR-2351) · **`saved_filter:manage`** (MOTIR-2352) ·
> **`import:run`** (MOTIR-2353) · **`work_item:triage` · `work_item:delete`** (MOTIR-2354).
> **`ai:view_plan`** (MOTIR-2363) · **`ai:plan`** (MOTIR-2355 / -2357 / -2358 / -2359,
> flag flipped by MOTIR-2356) — **the whole eight are now wired, and with MOTIR-2256's
> twelve that is the entire catalog.**
>
> ✅ **The guard's two counting-down arms are DELETED, not re-pinned at zero**
> (MOTIR-2356). `PENDING` went 95 → 0 and `CLAIMED_BUT_UNVERIFIED` 38 → 0; a pin at
> zero is a slot for the next one to creep back into, and what replaces both is
> stricter: an ungated operation must now carry one of the five PERMANENTLY_UNGATED
> decisions, so a new route with a `new` or `existing` row fails immediately rather
> than waiting for a number to move. Verified by adding a deliberately ungated route
> and watching the suite go red, then removing it. `tests/permissions/catalog.test.ts` keeps its own list — deliberately separate from
> the twelve, because these keys are NOT equivalent to `project:administer` and a reader must never
> take membership of one list as evidence about the other.

> **The catalog was 32 keys, and `repository:connect` was the twenty-first `planned` one.**
> MOTIR-2294 RETIRED it rather than wiring it. Its six operations — the two GitHub OAuth legs,
> `/api/github/setup`, `/api/github/organizations`, and the two GitLab OAuth legs — were read on the
> branch and NONE resolves a project: they bind a provider installation to a WORKSPACE, and
> `app/api/gitlab/oauth/start/route.ts` says so in its own header. A project permission cannot gate an
> operation that never names a project, and the catalog's opening rule forbids a key with no operation
> behind it. Their rows below now read `workspace-scoped` / R3. The concern is NOT left ungoverned:
> attaching a repository row TO a project is `/api/projects/[key]/repositories`, which is
> `repository:manage`. Both mirrors split it the same way — Jira and Plane put the provider connection
> at the org/workspace level and repository linking at the project level.

> **NINE MORE ROWS RESOLVE NO PROJECT — the same shape, one story later (MOTIR-2346).** MOTIR-2294
> retired a whole KEY; this retires nine ROWS from two keys that survive, and the argument is
> identical: a permission pointed at an operation that never names a project is not coverage, it is
> the appearance of coverage, and it inflates every count sized off it.
>
> - **The six importer OAuth legs** — `/api/import/{jira,linear,plane}/oauth/{start,callback}` —
>   were mapped to `import:run`. Read on the branch, each resolves a WORKSPACE and nothing else
>   (`resolveWorkspaceContext(req)` for Jira and Plane, `getWorkspaceContext()` for Linear, whose
>   header states that the identity is workspace-scoped because the substrate keys on
>   `[user, source, workspace]`). The 3LO round trip binds the actor's stored provider credential to
>   a workspace; the actor's project is not a fact that exists at that point in the flow. They are
>   `workspace-scoped` / R3, exactly as the GitHub and GitLab legs above. **`import:run` is not
>   weakened** — the five project-scoped importer operations it governs (`/api/import`,
>   `/api/import/[id]`, `discover`, `preview`, `run`) keep it, and attaching an imported project's
>   work is not what an OAuth leg does.
> - **The two `/api/idea-draft` operations** were mapped to `ai:plan`. Both run BEFORE the visitor
>   has an account: the POST is the public cross-origin receiver (`no-gate` / R48), the claim leg
>   consumes a single-use draft id at sign-in (`user-scoped` / R49). A project role cannot govern an
>   operation whose actor has not signed in yet.
> - **`/api/canvas-layout` is the one row that CHANGES BEHAVIOUR, and in the safe direction.** It was
>   mapped to `ai:plan` and reached the database with no project gate at all — a small hole hiding
>   inside a mis-mapping. A per-user node arrangement is not a planning act and spends nothing, so
>   the true statement is the narrower one: it is now `project:browse` / R50, asserted in
>   `canvasLayoutService` on both the read and the save.
>
> That is eight rows leaving the pending count and one gaining a gate — nine, and the guard's pin
> falls **36 → 27** for exactly that reason. No key was added, removed or re-labelled.

| Domain               | Permissions                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `ai` (4)             | `ai:configure` · `ai:plan` ᵖ · `ai:view_plan` ᵖ · `ai:decide_plan`                                      |
| `attachment` (2)     | `attachment:create` · `attachment:delete_any`                                                           |
| `board` (1)          | `board:configure`                                                                                       |
| `comment` (2)        | `comment:add` · `comment:moderate`                                                                      |
| `estimation` (1)     | `estimation:manage`                                                                                     |
| `field` (3)          | `component:manage` · `field:manage` · `label:manage`                                                    |
| `import` (1)         | `import:run` ᵖ                                                                                          |
| `member` (2)         | `member:manage` · `project:manage_access`                                                               |
| `project` (2)        | `project:administer` · `project:browse`                                                                 |
| `public_request` (3) | `public_request:comment` · `public_request:submit` · `public_request:upvote`                            |
| `report` (2)         | `report:view` ᵖ · `saved_filter:manage` ᵖ                                                               |
| `repository` (2)     | `repository:manage` · `repository:manage_access`                                                        |
| `sprint` (1)         | `sprint:manage` ᵖ                                                                                       |
| `watcher` (1)        | `watcher:manage`                                                                                        |
| `work_item` (5)      | `project:browse` · `work_item:archive` · `work_item:delete` ᵖ · `work_item:edit` · `work_item:triage` ᵖ |
| `workflow` (2)       | `automation:manage` · `workflow:manage`                                                                 |

ᵖ = `planned` — justified here, not yet enforced.

⚠️ **This table is the MOTIR-2255 SNAPSHOT, kept per DOMAIN rather than refreshed wholesale.** The
catalog has grown since — the `lesson` keys (MOTIR-3336 / MOTIR-3553) never joined it, and
`ai:decide_plan` did — so `lib/permissions/catalog.ts` is the enumeration to read, and a domain row
here is authoritative only about the domain a later card actually touched.
`work_item` is one of those: MOTIR-3629 split `work_item:archive` out of `work_item:delete` and
updated the row in the same change.

## GATE TODAY, MEASURED (MOTIR-2304)

**⚠️ `project:administer` is NOT the tightest administrative gate in the product.** Three domains are
gated to the workspace **OWNER** — a strictly narrower actor set than the umbrella this story is
splitting. So MOTIR-2256's split is not one movement: it TIGHTENS some domains, LOOSENS others, and
leaves the rest exactly where they were. The per-domain card is where each is argued, and a card that
claims neutrality for a row in the LOOSENS column is wrong.

| Domain               | The gate that actually runs                                      | Admits today                                        | The split |
| -------------------- | ---------------------------------------------------------------- | --------------------------------------------------- | --------- |
| `board`              | `assertPermission(board:configure)` (wired, MOTIR-2296)          | was workspace OWNER only                            | LOOSENED  |
| `workflow`           | `assertPermission(workflow:manage)` (wired, MOTIR-2297)          | was workspace OWNER only                            | LOOSENED  |
| `estimation`         | `assertPermission(estimation:manage)` (wired, MOTIR-2298)        | was workspace OWNER only                            | LOOSENED  |
| `automation`         | `assertPermission(automation:manage)` (wired, MOTIR-2297)        | `project:administer`-equivalent                     | neutral   |
| `component`          | `assertPermission(component:manage)` (wired, MOTIR-2298)         | was a module-private `assertCanManage`, same answer | neutral   |
| `field`              | `assertPermission(field:manage)` (wired, MOTIR-2298)             | was a module-private `assertCanManage`, same answer | neutral   |
| `label`              | `assertPermission(label:manage)` (wired, MOTIR-2298)             | was `project:administer`                            | neutral   |
| `ai`                 | `assertPermission(ai:configure)` (wired, MOTIR-2300)             | was `project:administer`                            | neutral   |
| `member`             | `assertPermission(member:manage / project:manage_access)` (2295) | was `project:administer`                            | neutral   |
| `repository`         | `assertPermission(repository:manage / …_access)` (MOTIR-2299)    | was project MEMBER via `assertCanEdit`              | TIGHTENED |
| `sprint` (lifecycle) | `assertPermission(sprint:manage)` (wired, MOTIR-2350)            | was workspace OWNER/ADMIN only                      | LOOSENED  |
| `sprint` (grooming)  | `assertPermission(sprint:manage)` (wired, MOTIR-2350)            | was NOTHING — any workspace member                  | TIGHTENED |

**⚠️ MOTIR-2291's rows land in BOTH columns, and one card straddles them.** The table above was
written for MOTIR-2256, whose whole story was administrative keys. MOTIR-2350 is the first card in
either story where the SAME key both loosens and tightens depending on which service you look at:
`sprintsService`'s five lifecycle writes were behind a module-private `isOwnerRole` check —
invisible to the guard's walk until MOTIR-2304, and TIGHTER than the umbrella — while
`backlogService`'s ranking and sprint-assignment writes had no project gate at all. Reading the
inventory row alone ("`sprint:manage`, was `session only`") would have described half of it.

**Why this had to be written down.** The `Gate today` cells for `board`, `workflow` and `estimation`
read **`session only`** until 2026-08-06. They were produced by the guard in
`tests/permissions/noUngovernedOperation.test.ts`, whose `GATE` pattern recognised only CALLS TO
KNOWN GATE FUNCTIONS — so a service that factors its authorization into a privately-named module-local
helper and branches on `isOwnerRole(...)` was invisible twice over: the walk never entered the helper,
and would not have recognised the decision if it had. MOTIR-2304 added both limbs (a same-file call
hop, and the two role predicates), and the guard's PENDING pin fell **75 → 36**: thirty-nine
operations that were never ungoverned. No gate was added to close that gap.

It is the MOTIR-2292 failure one level up — that repair fixed WHERE the walk looks and left WHAT it
recognises alone — and it is the reason three cards under MOTIR-2256 were written claiming their
domains had _"no project gate at all"_ when the gates were there and tighter than the umbrella.

**And a THIRD correction, MOTIR-2443, found while wiring `ai:plan`.** The walk was taking a RETURN
TYPE's braces as the method body — `): Promise<{ jobId: string }> {` captures `{ jobId: string }`,
so every service method returning an object type reported UNGOVERNED however plainly it asserted —
and it could not follow a `this.siblingMethod(` hop. `PENDING` fell **16 → 13** and the
claimed-but-unverified bucket **18 → 11**. Again NO gate was added; again the instrument was wrong,
not the product. Three corrections in one epic, each on a different axis: WHERE the walk starts
(2292), WHAT it recognises (2304), WHERE it stops (2443). The pattern worth carrying forward is that
a static walk over a language it does not parse will keep being wrong in a new way, so every count it
produces is pinned and every repair carries a synthetic control.

## Reasons

Every row cites one of these. A row with no reason is the failure this card exists to prevent.

**The list is numbered, not renumbered.** A reason nothing cites is deleted, leaving its number
retired — R7 (_"connects a provider installation and triggers indexing"_) went that way in MOTIR-2294,
when its six rows moved to R3. Renumbering would silently re-point every row below it, which is a far
worse failure than a gap.

**R1.** The public REST API mirrors in-app operations. Gated by token scopes AND, once the split lands, by the same permission as its in-app twin — it inherits, it does not get its own key.

**R2.** Read paths over the project’s work items.

**R3.** Workspace/org administration — the workspace role axis, untouched by this epic.

**R4.** Governed by the shipped comment predicates.

**R5.** Submits a planning job that spends the workspace’s AI credits and proposes plan changes. Today session-only.

> ⚠️ **CORRECTED by MOTIR-2362.** The four `/api/ai/coding-convention/*` rows cited this reason and are NOT planning submissions: they read and re-run the project's convention AUDIT, a project-wide configuration artifact the planner then consumes. They were `assertCanManage` (admin-only) already, and `ai:plan` is a member key — so applying the mapping literally would have been the story's only WIDENING. They move to `ai:configure` / R17, which `admin` holds, so no actor's answer changes. A story that closes holes should not open one in passing.

**R6.** Inbound provider webhook, signature-verified. No actor.

**R8.** TEST-SUPPORT route (Next escapes the leading underscore as %5F). It creates work items with no project gate. Must be unreachable in production — verify the build excludes it, else it is an ungated write path. Logged as a finding, not a permission.

**R9.** Board configuration: columns, swimlanes, WIP limits.

**R10.** The workflow statuses a board column projects. Statuses live here, not under /projects.

**R11.** Reads a generated plan and its proposals — AND acts on it. MOTIR-2363 wired `ai:view_plan` on every method that WRITES to a plan row (approve, decline, edit a proposal, add proposals, mark planned); the READ keeps `assertCanBrowse` through `plansService.getPlan`, because a plan you may not act on is still a plan you may read.

> ⚠️ **AMENDED by MOTIR-3188 (2026-08-20) — the one key is now TWO, and the row above is what it corrects.** R11 used to end: _"The key's NAME is the misleading part: approving materializes work items, so it is a write key, which is why the decision record puts it at `member` rather than at browse."_ That was an accurate description of a conflation, and it stopped being a safe one. Two AUTHORITIES were inside one key:
>
> - **AUTHOR** — `addProposals`, `markPlanned`, `editAddProposal` (and its `updateProposal` / `deepenProposal` callers). These keep **`ai:view_plan`**.
> - **DECIDE** — `approvePlan`, the only path from a proposal to real rows, and `declinePlan`. These now assert **`ai:decide_plan`**.
>
> The conflation was invisible under the three built-in roles (`member` holds it, `viewer` does not), which is why it shipped. **MOTIR-2257's custom roles** ended that: a role grants exactly what an admin ticks off a grid, so ticking a switch whose label said _view_ conferred bulk work-item creation on a role that was deliberately not given `work_item:edit`. **MOTIR-2984 / -2988** ended it a second way, by giving the surface a machine author — a token allowed to draft a plan was a token allowed to enact one.
>
> Behaviour-neutral on the built-ins by construction: `ai:decide_plan` enters `ROLE_GATED_PERMISSIONS` and `member` and neither `viewer` nor `IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS`, so every actor who could approve before can approve after. Full argument in `docs/decisions/agent-authored-plans.md` AMENDMENT 5.
>
> ⚠️ **And the `ai:view_plan` cell on the `/api/plans/[id]` GET row below is a DESCRIPTION OF THE ROW'S SUBJECT, not of its gate.** That read is `canBrowse` — its own Gate column says so — and it is the evidence that this key never gated a view at all.

**R12.** Better-Auth endpoint — authenticates, does not authorise.

**R13.** Background job-runner callback. No actor.

**R14.** Sprint lifecycle and backlog ranking. Today workspace-only.

**R15.** Project identity + settings; already covered by the shipped predicates.

**R16.** Project-scoped saved queries. The WRITES (author / own / star / subscribe) ask `saved_filter:manage`; the READS (list / resolve / dependents) stay at `project:browse`, because running a saved query is reading the project's work items. The per-ROW rules in `lib/savedFilters/access.ts` — an owner manages their own filter, an admin any project-shared one — sit on top and are a different question from the project-level key.

**R17.** AI cadence + planner model settings. Splits out of project:administer.

**R18.** Sets the project access level (public/open/limited/private).

**R19.** Project-scoped analytics read, same class as /api/reports.

**R20.** Label / tag vocabulary.

**R21.** Connect / disconnect / move / take over the project’s repository set. Splits out of project:administer.

**R22.** Who on the team may clone the code. Its own key: a lead may grant code access without administering the project.

**R23.** Triage queue: accept / decline / promote an inbound request — a MODERATION act on work somebody outside the team submitted, the same shape as `comment:moderate`. Reading the queue rides the same key: its contents are requests nobody has accepted yet.

> ⚠️ **CORRECTED by MOTIR-2354.** `/api/projects/[key]/triage/submissions` was mapped here, and it is not triage — it is somebody SUBMITTING, which `public_request:submit` already governs. Plane draws the identical line: a Guest or Commenter submits an intake item, only Admin and Contributor accept or decline one. Its gate is unchanged (browse-shaped, so an internal member on a private project can still file one — the level-gated `public_request:submit` could not admit them); only the mapping moved.

**R24.** Components vocabulary.

**R25.** The estimation scheme.

**R26.** Custom-field definitions.

**R27.** Add/remove a project member, set their role.

**R28.** Automation + status-derivation rules.

**R29.** Service-to-service; authenticated by serviceAuth/shared secret. No end-user actor to authorise.

**R30.** Governed by API-token SCOPES, a deliberately separate axis that NARROWS the owner’s role.

**R31.** Acts on the signed-in user's OWN account or preferences. A project role must not govern it.

**R32.** Static API description; public by design.

**R33.** Public project surface; level-gated, never role-gated.

> ⚠️ **CORRECTED by MOTIR-2366.** `/api/public/categories` and `/api/public/explore` were labelled `existing` / `public_request:submit`, and BOTH halves were wrong. They are the anonymous PROJECT SQUARE — a logged-out visitor or a crawler reads them, so there is deliberately no `getSession()` call and no project to resolve; the `accessLevel = 'public'` filter lives in the repository aggregate. And the claimed key was the wrong one anyway: reading a directory of public projects is not submitting. They are `no-gate` / R33, which is the same answer their per-project siblings (`/p/[identifier]/items`, gated on `assertCanBrowsePublic`) already reach by a different route.

**R34.** DECISION: a dashboard is a WORKSPACE artifact, not a project one — it aggregates widgets across projects, and its own private/shared field governs sharing. The per-widget project reads are gated by report:view. The route already reads "any workspace member".

**R35.** The actor's own API tokens. Their SCOPES are the separate narrowing axis (lib/mcp/scopes.ts).

**R36.** Public-request thread; level-gated by accessLevel=public.

**R37.** Governed by the shipped attachment predicates.

**R38.** Workspace membership lifecycle, governed by the workspace MemberRole.

**R39.** Bulk-creates work items from an external tracker — a destructive-scale write. MOTIR-2353 moved the five PROJECT-SCOPED operations from `work_item:edit` (every project member) to `import:run` (admin only), which is where both mirrors put it: Plane allows imports to workspace admins only "to maintain governance", Linear requires a Linear Admin. The six OAuth legs left this reason for R3 in MOTIR-2346 — they resolve no project.

**R40.** The actor's own notification inbox. Per-user, never per-project.

**R41.** Governed by canEdit.

**R42.** Archive / delete cascades over a subtree — separable from editing a field. Jira grants _Delete Issues_ to the Administrators project role, so a member keeps every edit and loses the cascade.

> ⚠️ **CORRECTED by MOTIR-3629 (2026-08-26) — the cascade rationale is FALSE OF ARCHIVE, and it must not survive as the justification.** ~~Archive / delete cascades over a subtree~~: `workItemsService.archiveWorkItem` stamps `archivedAt` on ONE row and leaves the children live, which `app/api/v1/work-items/[key]/archive/route.ts` and the `archive_work_item` tool description both say unprompted. So the two operations were grouped on the single property archive does NOT have, and they differ on **both** axes that make delete dangerous — reversibility and blast radius — under a key named after the destructive one. The consequence was not theoretical: there was no way to grant the reversible operation without the irreversible one, so a planner token that archives superseded nodes had to carry the subtree delete permanently, and a **member** — who can edit every field — could not archive at all.
>
> The rule now SPLITS, and each half keeps a rationale that describes it:
>
> - **`work_item:archive`** — a REVERSIBLE, non-cascading soft-remove of one row. Separable from editing a field because it takes the item out of every active view for the whole team, and separable from deleting because nothing is destroyed. Held by **member** and above; the mirror is Linear, whose archive semantics this operation already copies (the service's own header cites "the Linear shape" for leaving children intact) and where archiving is every member's ordinary remove.
> - **`work_item:delete`** — the IRREVERSIBLE cascade over a subtree, and its dry run. The Jira sentence above is unchanged and is now about this half alone: _Delete Issues_ is the Administrators project role, so a member keeps every edit and loses the cascade.
>
> Nothing about either OPERATION changed — only the boundary of who may invoke which. Back-compatibility is by IMPLICATION rather than migration: `work_item:delete` confers `work_item:archive` at resolution (`PERMISSION_IMPLICATIONS`, `lib/permissions/catalog.ts`), so no stored token grant and no authored custom role lost an operation. `docs/decisions/token-permissions.md` §10 carries that decision in full.

> ⚠️ **CORRECTED by MOTIR-2354.** `DELETE /api/work-items/[id]` was filed under R41 / `work_item:edit` while its own DRY RUN (`/delete-preview`) was mapped here — and in the code the preview was the tighter of the two (`assertCanManage` vs the delete's `assertCanManage`, against an inventory row claiming `work_item:edit`). A destroy and its preview cannot be governed by different keys; both now ask `work_item:delete`.

**R43.** Acceptance evidence attached to a work item.

**R44.** Governed by the shipped watcher predicate (self-watch needs only browse).

**R45.** Runs BEFORE a project membership can exist; it is what creates the project.

**R46.** Scoped by ?projectId= or ?savedFilterId=, so the data IS project data. Today workspace-only: a member of project A can read project B’s distribution.

**R47.** Sets the signed-in user's own locale / appearance preference. Not a project resource.

**R48.** The PUBLIC, cross-origin PRE-AUTH receiver. The visitor has no account yet — the route says so in its own header (_"NOT session-gated … there is deliberately no `getSession()` call"_) — so there is no actor to authorise and no project to authorise them against. Its abuse surface is answered on a different axis entirely: an origin allowlist, a per-IP fixed-window rate limit, a length cap, and a TTL on the stored draft.

**R49.** The same pre-auth handoff's SAME-ORIGIN half: it consumes a single-use anonymous draft and plants it in the actor's own `motir_pending_idea` cookie at sign-in. It runs BEFORE the session exists, let alone a workspace or a project, and its subject is the one browser holding the opaque id. A forged / expired / already-claimed id is a 404, which is the whole of its access control.

**R50.** A per-user, per-project node ARRANGEMENT of the planning canvas — the actor's own view state inside a project they already have open, not a planning act and not something that spends anything. Governed by `project:browse`: you may arrange the canvas of a project you can see.

**R51.** A project's OWN roles — authoring one, re-permissioning it, deleting it with a reassignment (Story MOTIR-2257 · MOTIR-2474). Governed by **`project:manage_access`**, the SAME key that already governs add-member / set-role / set-access-level, and deliberately NOT a new catalog key: a role definition IS project access, and whoever may decide who is on a project may decide what the roles on it mean. Splitting the two would let an actor hand out a role they could not have authored, or author one they could not hand out — a distinction with no operational meaning that doubles the surface an admin has to reason about. There is no GET: the settings screens are server components reading through `getRoleCatalog`, and no client fetches a role list.

**R52.** A DESIGN RESULT attached to a work item (Story MOTIR-2664 · MOTIR-2667) — the note, the mock and the screenshot a design PR's CI publishes. Governed by **`work_item:edit`**, the same key as R43's acceptance evidence and for the same reason: attaching evidence to an item is editing that item, and the project is resolved from the ITEM rather than from the actor's active project (the gate MOTIR-2365 added after a token-minting endpoint turned out to be reachable with a session and an id).

**R53.** TEST-SUPPORT probe (MOTIR-2816): _which role is this server connected as?_ Deliberately UNGATED and deliberately not tenant-aware — it is asked BEFORE sign-in by `tests/e2e/app-role-surfaces.spec.ts`, and the answer is a property of the PROCESS, not of a session. It reads two catalogue facts about the connection (`current_user`, `pg_roles.rolbypassrls`) and nothing else: no table, no row, no tenant data — nothing an attacker could not learn from an error message. `productionGate()` 404s it in any real production build, the same mechanism that keeps its `%5Ftest` siblings out. It exists because no other vantage point can answer the question — a psql session reports ITS OWN connection, and `TEST_DB_APP_ROLE=1` speaks only for a Vitest process — and because without it the whole app-role E2E spec passes vacuously against a BYPASSRLS server. It is MOTIR-2515's step 4, made reproducible.

**R54.** PLATFORM-STAFF operator writes on ONE ACCOUNT (Story 8.5 · MOTIR-1167) — send a password reset, suspend / unsuspend an account. Governed by **`requirePlatformStaff('operator')`**, and deliberately **NOT by any permission-catalog key**, which is the one row in this table where "no key" is the decision rather than a gap.

**R55.** The signed-in reader accepting the LEGAL DOCUMENTS as they stand (Story 8.4 · MOTIR-1135) — `content/legal/terms.md` §14's affirmative act, recorded as `legal_acceptance` rows keyed on the actor's own user id. **User-scoped, like R47's locale and appearance**, and for a stronger version of the same reason: an agreement is between moooon B.V. and a PERSON. It is made at sign-up before any workspace is resolved, it does not change when they join another organization, and the row carries no `workspace_id` for a tenant key to gate on — its RLS policy keys on `app.user_id`, the `api_token` precedent.

The action takes **no arguments**, which is what makes "session only" sufficient rather than merely conventional: there is no id to authorise, and the versions recorded are the ones the SERVER reads off disk at that instant. A caller cannot name a document, a version or another person — the only thing it can do is record that the account it is already signed in as agrees to what is currently published. Granting a permission key here would make a legal agreement something one tenant member could hold on behalf of another, which is the opposite of what an agreement is.

`docs/decisions/platform-staff-auth.md` §1 argues it and this is the summary: `lib/permissions/catalog.ts` is the TENANT vocabulary — 16 domains, every key resolving against a project the actor already belongs to — and `lib/tokens/grant.ts` grants keys FROM that catalog to API tokens. A `platform:*` key would therefore be grantable, so a customer's personal access token could carry standing OUTSIDE every tenant. The ADR's load-bearing invariant is the opposite: _"no tenant role, at any tier, in any combination, produces a `PlatformRole`."_

What governs these two actions instead is a THREE-DEGREE LADDER on `User.platformRole` (`support` ⊂ `operator` ⊂ `superadmin`), asserted twice — once in the Server Action, once in `platformSupportService`, per the ADR's §2 two-layer rule — and every call writes a `platform_audit_log` row inside the same transaction, with a REASON the action refuses to proceed without. So the operation is not ungoverned; it is governed by a mechanism this catalog must not be able to reach.

Two things it deliberately does NOT inherit from R43, both recorded in `docs/decisions/design-result.md`:

- **No parent-story hop (§3).** Acceptance rolls a leaf key UP to its story because a story has exactly one end-to-end receipt. A story has MANY designs — one per design subtask — so a design result attaches to the card that PRODUCED it, and a container target is refused 422. `resolveTarget` is therefore shorter than `resolveStory`, not a copy of it.
- **No entitlement gate (§2).** Acceptance video is plan-gated because a 100 MB clip per story is a real storage cost. A design result is tens of kilobytes, and reading the design of the work you are reviewing is core project management rather than a paid AI feature — so there is no plan axis and no org toggle to consult here. Only the mechanical per-file and storage caps apply, at register.

Both routes authenticate a CI caller (keyless GitHub OIDC first, else a PAT granted the key) through the shared `authenticateCiPublisher`, so the permission above is asked of the resolved uploader, not of an interactive session.
**R56.** The REQUIRE-2FA policy, at the organization and workspace tiers (Story 8.13 · MOTIR-1215) — one switch per tier, demanding a second factor of everyone in it. Governed by the TIER ROLE (org-admin; `isWorkspaceManager`), asserted inside `twoFactorPolicyService`, and deliberately **not** by a permission-catalog key.

**R58.** The DISPATCH RUN read surface (Story MOTIR-1789 · MOTIR-1793) — the run with its set, its live SSE tail, a card's run history, and a project's live runs. Two different answers on one row, and the split is the point.

The three PROJECT-addressed reads (`…/projects/[key]/dispatch-runs`, `…/dispatch-runs/active`, `…/work-items/[id]/dispatch-runs`) resolve a project and assert **`project:browse`** through `projectAccessService`, exactly as every other project-addressed read does: a run history is project data, and whoever may see the project may see what ran in it. The first of the three (MOTIR-3922, the runs index's read) takes an optional `?scope=<KEY>` that resolves a work item INSIDE the already-authorised project and inside the same transaction, so the narrowing adds no reachable row and no second gate.

The two RUN-addressed reads (`/api/dispatch-runs/[id]`, `…/stream`) are **workspace-scoped**, and that is a decision rather than a gap. A run id is a cuid nobody can enumerate, and `dispatch_run` is RLS-gated on its own `workspace_id`, so a run in another tenant returns NOTHING and the route answers 404 — indistinguishable from one that never existed. Resolving the run's project to assert `project:browse` on it would mean READING the run first, which is the thing the gate is supposed to authorise: the tenancy check would run after the disclosure it exists to prevent. The narrower key is therefore available only at the cost of the property it is meant to protect, and RLS already answers the question the key would ask.

⚠️ **The stream asserts BEFORE the first frame**, so a refusal is a real HTTP status rather than a stream that opens and immediately errors — the ordering `app/api/ai/plan/generate/[jobId]/stream/route.ts` established and this route mirrors.

None of the four takes a WRITE key: the ingest is `/api/v1`'s, PAT-authenticated, and appears above under R1.

**R57.** The JOB-QUEUE BACKLOG probe (Story MOTIR-3758 · MOTIR-3764) — _is anything being claimed?_ Deliberately **UNGATED**, and the ungatedness is the deliverable rather than a concession. On 2026-08-28 the queue stopped being claimed for thirty-five minutes and nothing noticed: the check that would have reported it, `system.daily-health-check`, is itself a JOB, so a wedged worker takes the alarm down with the thing it is meant to alarm on. The reader that has to work is an EXTERNAL monitor, polling from outside the deployment while the app is degraded — and every credential such a monitor carries is one more thing that can be wrong at three in the morning, discovered during the incident it was configured for.

What makes that safe is the PAYLOAD, not the caller. It answers two integers about the deployment's own background queue — how many runs are claimable, and how long the oldest has waited — plus the threshold they were judged against. No workspace, no project, no job id, no event name, no row and no name: nothing that identifies a tenant, and nothing an attacker could act on. It is the same class of answer as R53's `current_user`, one tier out. The staff-gated platform-health BOARD (`/admin/monitoring`, R54's neighbour) is untouched and none of its six signals is exposed here — this is not a widening of that surface, it is the one reading that had to live outside it.

The verdict also rides the HTTP STATUS (200 healthy / 503 stalled / 503 unreadable), so a monitor that parses nothing still works, and an unreadable database reaches the caller as a failure rather than as a healthy-looking body — the _"an unreachable probe must never read as a zero"_ rule from `platformHealthService`'s own header, applied to a machine reader.

**R58.** The DEPLOYED-BUILD probe (Task MOTIR-3760) — _which commit is this deployment running?_ Deliberately **UNGATED**, on R57's argument and with a plainer payload still: a commit sha of a **public** repository, already readable by anyone at `github.com/moooon-B-V/motir-core`. It discloses nothing that is not already published, and it identifies no tenant, no workspace and no person.

The reader is again an EXTERNAL monitor — `.github/workflows/deploy-freshness.yml`, every thirty minutes — and here the externality is the whole design rather than a convenience. A deployment cannot be the thing that reports it is behind: the state being reported on is the state of the reporter, so a release that never happened and a machine still serving an old image both answer _"fine"_ to a check that lives inside them. So this route states ONE fact about itself and draws no conclusion; `main`'s head, the ancestry walk, the age arithmetic and the alarm all live outside it. On 2026-08-28 production ran a job engine the repository had already deleted for over three hours, dead-lettering a scheduled health check against it, while every dashboard stayed green — each of them correct, and each about a different relationship than the one that had broken.

The verdict rides the HTTP STATUS as R57's does (200 _I know which build I am_ / 503 _I do not_), so a monitor that parses nothing still works. The 503 arm is reachable and correct for a **self-hosted** build — `MOTIR_RELEASE` is a build argument defaulting to empty, so `docker build` with no arguments produces an image that honestly cannot name its commit — and is a FINDING for a Fly release, which is why the freshness check treats it as a blind read and goes red rather than shrugging.

**R59.** The LEGAL-CONFIGURATION probe (Story MOTIR-3909 · MOTIR-4007) — _is this deployment's legal-document manifest set, and is any of it broken?_ Deliberately **UNGATED**, on R57's and R58's argument, and it is the third member of that family rather than a new question about access.

It exists because of a failure mode with no other alarm. `motir-core` no longer ships legal documents; it reads a configured manifest (`docs/decisions/public-surface-hosts.md` AMENDMENT 2 §C), and a malformed entry is REFUSED so that an unparseable version cannot reach `isMaterialChange`, whose unparseable-is-material arm would otherwise hold every signed-in reader at `/re-consent` on a screen they cannot clear. Refusing it is right; refusing it **silently** would be the very failure the move exists to prevent, reached from the other side — a legal gate that quietly stops holding anybody looks exactly like one with nobody to hold. So the refusal is loud in three parts: an error log, this route, and a named condition when the refused entry is one of the three re-consent documents.

What makes it safe is the PAYLOAD. It answers a status word, a count, and — for entries that failed to parse — their SLUG, the FIELD that failed, and the reason. It carries no document text, no url and no version, so a reader learns that a configuration is broken and nothing whatever about what it says. No tenant, no workspace, no person. `tests/legal/legalHealthRoute.test.ts` asserts the non-disclosure directly rather than leaving it to inspection.

The verdict rides the HTTP STATUS as R57's and R58's do — but note which way. **`unconfigured` is 200, not 503**, and that is the decision rather than an oversight: an unconfigured deployment is a **self-hosted** build that has published no legal documents, which is the correct and intended state for it (§5's absent-not-hidden line). Answering 503 would page somebody about a deployment working exactly as designed, and — worse — would teach a reader to ignore the one status that means something is actually wrong. `faulted` is the 503.

**R60.** The EGRESS MANIFEST (Story MOTIR-3909 · MOTIR-4008) — _which companies does this software's own tree prove it reaches?_ Deliberately **UNGATED**, and here the ungatedness is not a concession at all: **every company it names is one we are legally obliged to disclose PUBLICLY**, on a subprocessor page written to be read by a customer's privacy reviewer without asking us for it. A document whose entire purpose is publication cannot be harmed by being readable.

It exists because the subprocessor guard's two halves ended up in different repositories. The page moved to `motir-marketing`; the EVIDENCE — this repository's `package.json` and the outbound hosts in `lib/` and `app/` — could not follow it, because measured against a marketing website's dependency tree it would pass forever and say nothing about the software the page is about. So `motir-core` keeps the measurement, commits it as `lib/legal/egressManifest.ts`, and serves it here for the other repository to assert its page against (`public-surface-hosts.md` AMENDMENT 2 §E). The transport is the one MOTIR-4046 already chose for the OpenAPI document — a served, versioned artifact the consumer FETCHES, never a committed copy that rots.

The PAYLOAD is a vendor name, how we know (a dependency name or a hostname), and for the vendors this repository cannot evidence, the reason. All of it is already visible in a public GPL-3.0 repository. No tenant, no workspace, no person, and **no transfer basis, region or processing purpose** — those are judgements about a legal relationship that no repository fact settles, and they stay on the page.

**R61.** The LEGAL-MANIFEST TEST DOOR (Story MOTIR-3909 · MOTIR-4015) — _move this running server between the configured and unconfigured arms._ A `%5Ftest` route, so `productionGate()` 404s it in any real production build and the only server that answers it is a Playwright webServer (`lib/e2eProdHarness.ts` relaxes that one seam and nothing else, and is never true for a deploy). Within that boundary it is deliberately **UNGATED**, on R53's argument rather than a new one: the state it changes is a property of the PROCESS, not of a tenant — there is no workspace to resolve it against — and the spec that drives it does so at `/sign-up`, where there is no session to resolve at all.

It is the only instrument that can put an acceptance recording through both arms of this story. `MOTIR_LEGAL_DOCUMENTS` is a process-wide server read with no per-request override and no client seam, so the alternative is two origins — and a receipt that jumps origins mid-clip shows two builds rather than one build changing. It writes nothing but that one environment variable, touches no database, and reports back through the SHIPPED reader (`legalManifestState()`), which is what makes its answer usable as a mount check rather than an echo of the request.

**It is deliberately NOT under `/api/public/*`.** That surface is a versioned contract with a deprecation policy and third-party readers (AMENDMENT 1 §D). This is an internal artifact between two repositories under one owner — AMENDMENT 2 §G says so — so it carries a plain integer `version` in its body and takes on none of those obligations.

**R62.** The DOCS-URL TEST DOOR (Story MOTIR-4237 · MOTIR-4241) — _move this running server between the configured and unconfigured arms of the Help menu's `Docs` row._ **R61's argument, unchanged and by citation rather than restated**: a `%5Ftest` route that `productionGate()` 404s in any real production build, deliberately UNGATED within that boundary because the state it changes is a property of the PROCESS rather than of a tenant, and driven by a spec whose first act is at `/sign-up`. It writes one environment variable, touches no database, and reports back through the SHIPPED resolver (`docsIndexUrl()`), which is what makes its answer a mount check rather than an echo of the request — and is why a value the resolver REFUSES (a relative `/docs`, the defect MOTIR-4167 cured the row of) reads back `null` instead of as a 200 that hid it.

It exists for the same reason R61 does, one row over: `MOTIR_DOCS_URL` is a process-wide server read resolved in `app/(authed)/layout.tsx`, with no per-request override and no client seam a `page.route()` stub can reach. **Every** Playwright lane in this repository CONFIGURES one — `acceptance-legal-manifest.spec.ts` reads the `Docs` row as its CONTROL for Legal's absence — so without this door the unconfigured arm is unreachable from any spec, and a spec asserting it would pass on unfixed code for ever. It adds a `GET` its sibling has no need of, because the legal manifest already has a shipped health route (`/api/health/legal`) to read the arm back from and the docs url has none.

The R41 argument, one tier up. `lib/permissions/catalog.ts` keys all resolve against a PROJECT the actor already belongs to, and neither of these operations resolves a project: the question is "may you set a rule for this whole tenant", which no project permission can answer without either under- or over-granting. Both rows therefore name the service method rather than an `assert*` call in the action file, because that is where the gate actually is — the action is a thin transport and the page derives `canManage` only to decide what to DRAW (pinned in `tests/permissions/storyGate.test.ts`).

READING the policy is ungated on purpose, and that is a decision rather than an omission: a member must be able to see the rule that governs them, so the pane renders the switch READ-ONLY for somebody who may not set it instead of refusing the whole surface.

**R63.** The PLATFORM-STAFF BILLING CLASSIFICATION (Story MOTIR-4337 · MOTIR-4568) — _set or remove an organization's `internal_billing` flag._ **R54's argument at a HIGHER RUNG.** Like R54 it is governed by `requirePlatformStaff` and deliberately by no permission-catalog key: a catalog key is GRANTABLE to a customer's own API token, and no customer may ever decide what their organization is billed. What differs is the degree. R54's two writes act on ONE ACCOUNT — a password reset, a session set — and sit at `operator`; this one changes what an ORGANIZATION IS CHARGED, which is the class `docs/decisions/platform-staff-auth.md` §7's allocation table puts at **`superadmin`** for every other member (credit grants, tier assignment, per-org flags). So the row reads `superadmin`, and the action and the service each assert it: the `(admin)` layout gates the PAGES, and a Server Action is a POST to a route the layout never renders.

⚠️ **It is the one platform-scoped row that also carries a REQUIRED REASON**, enforced in the audit vocabulary (`PLATFORM_AUDIT_ACTIONS`) before the transaction opens rather than in the dialog. A refused write leaves no audit row at all, and an `org.internal_billing_set` row with no reason could not answer _why is this organization not being billed?_ a year later — which is the whole point of recording it.

---

## The full table

`Gate today` is what the shipped code enforces. `Permission` is what should govern it once
MOTIR-2277 grows the catalog and MOTIR-2256 wires the enforcement.

### `ai`

| Operation                                        | Verbs     | Gate today                                                                                                                                                  | Permission           | Decision    | Why |
| ------------------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------- | --- |
| `/api/ai/access`                                 | GET       | route → `assertPermission`; degrades to `not applicable`                                                                                                    | `project:browse`     | existing    | R5  |
| `/api/ai/augment`                                | POST      | `aiPlanEditsService.submitAugment` → `assertPermission`                                                                                                     | `ai:plan`            | existing    | R5  |
| `/api/ai/augment/[jobId]/stream`                 | GET       | route → `assertPermission` before the stream opens; sends `?coreProjectId=`                                                                                 | `ai:plan`            | existing    | R5  |
| `/api/ai/chat`                                   | POST      | `aiChatService.submitDiscoveryTurn` → `assertPermission`                                                                                                    | `ai:plan`            | existing    | R5  |
| `/api/ai/chat/[jobId]/stream`                    | GET       | route → `assertPermission` before the stream opens; sends `?coreProjectId=`                                                                                 | `ai:plan`            | existing    | R5  |
| `/api/ai/coding-convention/audit`                | GET       | `aiConventionService.getAudit` → `assertPermission`                                                                                                         | `ai:configure`       | existing    | R5  |
| `/api/ai/coding-convention/audit-coverage`       | GET       | `auditCoverageService.getCoverage` → `assertPermission`                                                                                                     | `ai:configure`       | existing    | R5  |
| `/api/ai/coding-convention/convention`           | GET       | `aiConventionService.getConvention` → `assertPermission`                                                                                                    | `ai:configure`       | existing    | R5  |
| `/api/ai/coding-convention/refresh`              | POST      | `aiConventionService.reaudit` → `assertPermission`                                                                                                          | `ai:configure`       | existing    | R5  |
| `/api/ai/expand`                                 | POST      | `aiPlanEditsService.submitExpand` → `assertPermission`                                                                                                      | `ai:plan`            | existing    | R5  |
| `/api/ai/expand/[jobId]/stream`                  | GET       | route → `assertPermission` before the stream opens; sends `?coreProjectId=`                                                                                 | `ai:plan`            | existing    | R5  |
| `/api/ai/explanation`                            | POST      | `aiExplanationService.submitExplanationDraft` → `assertPermission`                                                                                          | `ai:plan`            | existing    | R5  |
| `/api/ai/explanation/[jobId]/stream`             | GET       | route → `assertPermission` before the stream opens; sends `?coreProjectId=`                                                                                 | `ai:plan`            | existing    | R5  |
| `/api/ai/jobs/[jobId]`                           | GET       | route → `assertPermission`; sends `?coreProjectId=`                                                                                                         | `ai:plan`            | existing    | R5  |
| `/api/ai/ask`                                    | POST      | `aiAskService.submitTurn` / `.resubmit` → `assertPermission` (an ask turn spends the workspace's AI credits, exactly as a plan-change submit does)          | `ai:plan`            | new         | R5  |
| `/api/ai/ask/settle`                             | POST      | `aiAskService.settle` → `planChangeSessionsService` → `assertPermission`                                                                                    | `ai:plan`            | new         | R5  |
| `/api/ai/ask/[jobId]/stream`                     | GET       | route → `assertPermission` before the stream opens; sends `?coreProjectId=`                                                                                 | `ai:plan`            | new         | R5  |
| `/api/ai/plan-change/session`                    | POST      | `planChangeSessionsService.getOrCreateForProject` → `assertPermission`                                                                                      | `ai:plan`            | existing    | R5  |
| `/api/ai/plan-change/session/planner-turn`       | POST      | `planChangeSessionsService.recordPlannerTurn` → `assertPermission`                                                                                          | `ai:plan`            | existing    | R5  |
| `/api/ai/plan-change/session/submit`             | POST      | `planChangeSessionsService.submit` → `assertPermission`                                                                                                     | `ai:plan`            | existing    | R5  |
| `/api/ai/plan-change/session/turns`              | POST      | `planChangeSessionsService.appendTurn` → `assertPermission`                                                                                                 | `ai:plan`            | existing    | R5  |
| `/api/ai/plan-change/session/mailbox`            | POST/GET  | `planChangeMailboxService.attachTurn` / `.peekForJob` → `assertPermission` (a turn attached to a RUNNING job is a plan-change write, exactly as `turns` is) | `ai:plan`            | new         | R5  |
| `/api/ai/plan-change/session/mailbox/stop`       | POST      | `planChangeMailboxService.raiseStop` → `assertPermission` (ending a run is a plan-change write)                                                             | `ai:plan`            | new         | R5  |
| `/api/ai/plan/generate`                          | POST      | `aiGenerationService.startGeneration` → `assertPermission`                                                                                                  | `ai:plan`            | existing    | R5  |
| `/api/ai/plan/generate/[jobId]/stream`           | GET       | route → `assertPermission` before the stream opens; sends `?coreProjectId=`                                                                                 | `ai:plan`            | existing    | R5  |
| `/api/ai/plan/sprint`                            | POST      | `aiSprintPlanningService.submitSprintPlan` → `assertPermission`                                                                                             | `ai:plan`            | existing    | R5  |
| `/api/ai/plan/sprint/[jobId]/review`             | GET       | `aiSprintPlanningService.reviewSprintPlan` → `assertPermission`                                                                                             | `ai:plan`            | existing    | R5  |
| `/api/ai/plan/sprint/[jobId]/stream`             | GET       | route → `assertPermission` before the stream opens; sends `?coreProjectId=`                                                                                 | `ai:plan`            | existing    | R5  |
| `/api/ai/plan/sprint/approve`                    | POST      | `aiSprintPlanningService.approveSprintPlan` → `assertPermission`                                                                                            | `ai:plan`            | existing    | R5  |
| `/api/ai/pre-plan`                               | GET/PATCH | `aiPreplanService.{getPreplanState,saveDesignChoice}` → `assertPermission` (`project:browse` on the READ, `ai:plan` on the WRITE)                           | `ai:plan`            | existing    | R5  |
| `/api/ai/replan`                                 | POST      | `aiPlanEditsService.submitReplan` → `assertPermission`                                                                                                      | `ai:plan`            | existing    | R5  |
| `/api/ai/replan/[jobId]/stream`                  | GET       | route → `assertPermission` before the stream opens; sends `?coreProjectId=`                                                                                 | `ai:plan`            | existing    | R5  |
| `/api/ai/revise`                                 | POST      | `aiPlanEditsService.submitRevise` → `assertCanPlan` → `assertPermission`; the target is a PLAN id, not a work-item key (MOTIR-3599)                         | `ai:plan`            | existing    | R5  |
| `/api/ai/revise/[jobId]/stream`                  | GET       | route → `assertPermission` before the stream opens; sends `?coreProjectId=` — the same relay every plan-edit surface uses                                   | `ai:plan`            | existing    | R5  |
| `/api/canvas-layout`                             | GET/PATCH | `canvasLayoutService.{getLayout,savePositions}` → `assertPermission`                                                                                        | `project:browse`     | existing    | R50 |
| `/api/idea-draft`                                | POST      | — none — origin-allowlisted + per-IP rate-limited, pre-auth                                                                                                 | —                    | no-gate     | R48 |
| `/api/idea-draft/[id]/claim`                     | POST      | — none — consumes a single-use draft id at sign-in                                                                                                          | —                    | user-scoped | R49 |
| `/api/plans/[id]`                                | GET       | `planReviewService.getPlanReview` → `plansService.getPlan` → `assertCanBrowse`                                                                              | `ai:view_plan`       | existing    | R11 |
| `/api/plans/[id]/approve`                        | POST      | `plansService.approvePlan` → `assertPermission`                                                                                                             | `ai:decide_plan`     | existing    | R11 |
| `/api/plans/[id]/decline`                        | POST      | `plansService.declinePlan` → `assertPermission`                                                                                                             | `ai:decide_plan`     | existing    | R11 |
| `/api/plans/[id]/items/[itemId]`                 | PATCH     | `plansService.updateProposal` → `assertPermission`                                                                                                          | `ai:view_plan`       | existing    | R11 |
| `/api/projects/[key]/ai-settings`                | GET       | `assertCanBrowse`                                                                                                                                           | `project:browse`     | existing    | R17 |
| `/api/projects/[key]/ai-settings`                | PATCH     | `assertPermission(ai:configure)`                                                                                                                            | `ai:configure`       | existing    | R17 |
| `/api/projects/[key]/public-overview`            | PATCH     | `publicProjectsService.setPublicOverview` → `NotProjectAdminError`, then the delegate's `assertCanManage` inside the write transaction                      | `project:administer` | new         | R33 |
| `/api/projects/[key]/lessons`                    | GET       | `projectLessonsService.listLessons` → `assertPermission` BEFORE the motir-ai call                                                                           | `lesson:view`        | existing    | R17 |
| `/api/projects/[key]/lessons/[lessonId]`         | GET       | `projectLessonsService.getLesson` → `assertPermission` BEFORE the motir-ai call                                                                             | `lesson:view`        | existing    | R17 |
| `/api/projects/[key]/lessons/[lessonId]/applied` | PUT       | `projectLessonsService.setLessonApplied` → `assertPermission` BEFORE the motir-ai call                                                                      | `lesson:manage`      | existing    | R17 |
| `/api/work-items/[id]/ai/plan`                   | GET/POST  | `contextualPlanningService` → `planChangeSessionsService` → `assertPermission`                                                                              | `ai:plan`            | existing    | R5  |
| `/api/work-items/[id]/ai/plan/[jobId]/stream`    | GET       | route → `assertPermission` before the stream opens; sends `?coreProjectId=`                                                                                 | `ai:plan`            | existing    | R5  |

### `api`

| Operation                                                | Verbs | Gate today                                         | Permission | Decision     | Why |
| -------------------------------------------------------- | ----- | -------------------------------------------------- | ---------- | ------------ | --- |
| `/api/v1/dispatch-runs`                                  | —     | `assertCanBrowse`, `assertCanEdit`                 | —          | token-scoped | R1  |
| `/api/v1/dispatch-runs/[id]/close`                       | —     | RLS (the run's own workspace)                      | —          | token-scoped | R1  |
| `/api/v1/dispatch-runs/[id]/events`                      | —     | RLS (the run's own workspace)                      | —          | token-scoped | R1  |
| `/api/v1/me`                                             | —     | — none —                                           | —          | token-scoped | R1  |
| `/api/v1/plans/[planId]`                                 | —     | `assertCanBrowse`                                  | —          | token-scoped | R1  |
| `/api/v1/plans/[planId]/status`                          | —     | `aiPlanEditsService.getOutcome` (transitive)       | —          | token-scoped | R1  |
| `/api/v1/projects`                                       | —     | — none —                                           | —          | token-scoped | R1  |
| `/api/v1/projects/[projectKey]`                          | —     | `assertCanBrowse`                                  | —          | token-scoped | R1  |
| `/api/v1/projects/[projectKey]/backlog`                  | —     | — none —                                           | —          | token-scoped | R1  |
| `/api/v1/projects/[projectKey]/backlog/work-items`       | —     | — none —                                           | —          | token-scoped | R1  |
| `/api/v1/projects/[projectKey]/plan-session`             | —     | `assertCanEdit`                                    | —          | token-scoped | R1  |
| `/api/v1/projects/[projectKey]/plan-session/submissions` | —     | — none —                                           | —          | token-scoped | R1  |
| `/api/v1/projects/[projectKey]/plan-session/turns`       | —     | `assertCanEdit`                                    | —          | token-scoped | R1  |
| `/api/v1/projects/[projectKey]/ready`                    | —     | — none —                                           | —          | token-scoped | R1  |
| `/api/v1/projects/[projectKey]/repositories`             | —     | `assertCanBrowse` (via `projectRepoSetService`)    | —          | token-scoped | R1  |
| `/api/v1/projects/[projectKey]/sprints`                  | —     | — none —                                           | —          | token-scoped | R1  |
| `/api/v1/projects/[projectKey]/work-items`               | —     | `assertCanBrowse`, `assertCanEdit`                 | —          | token-scoped | R1  |
| `/api/v1/projects/[projectKey]/work-items/count`         | —     | `assertCanBrowse` (via `projectsService.getByKey`) | —          | token-scoped | R1  |
| `/api/v1/scope-claims`                                   | —     | `assertCanBrowse`, `assertCanEdit`                 | —          | token-scoped | R1  |
| `/api/v1/sessions/complete`                              | —     | — none —                                           | —          | token-scoped | R1  |
| `/api/v1/sprints/[sprintId]`                             | —     | — none —                                           | —          | token-scoped | R1  |
| `/api/v1/sprints/[sprintId]/complete`                    | —     | — none —                                           | —          | token-scoped | R1  |
| `/api/v1/sprints/[sprintId]/start`                       | —     | — none —                                           | —          | token-scoped | R1  |
| `/api/v1/sprints/[sprintId]/work-items`                  | —     | — none —                                           | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]`                               | —     | `assertCanBrowse`                                  | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/activity`                      | —     | `assertCanBrowse`                                  | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/archive`                       | —     | `assertCanBrowse`, `assertCanEdit`                 | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/attachments`                   | —     | `assertCanBrowse`, `attachment:create`             | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/claim`                         | —     | `assertCanBrowse`, `assertCanEdit`                 | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/comments`                      | —     | `assertCanBrowse`                                  | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/dispatch-prompt`               | —     | — none —                                           | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/expansions`                    | —     | `assertCanBrowse`                                  | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/implementation`                | —     | `assertCanBrowse`, `assertCanEdit`                 | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/integration`                   | —     | `assertCanBrowse`                                  | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/links`                         | —     | `assertCanBrowse`, `assertCanEdit`                 | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/plan-approval`                 | —     | `assertCanBrowse`, `ai:decide_plan`                | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/restore`                       | —     | `assertCanBrowse`, `assertCanEdit`                 | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/transitions`                   | —     | `assertCanBrowse`                                  | —          | token-scoped | R1  |
| `/api/v1/workspaces`                                     | —     | — none —                                           | —          | token-scoped | R1  |

### `attachment`

| Operation                          | Verbs    | Gate today                                                                    | Permission          | Decision    | Why |
| ---------------------------------- | -------- | ----------------------------------------------------------------------------- | ------------------- | ----------- | --- |
| `/api/attachments/[id]`            | DELETE   | workspace only                                                                | `attachment:create` | existing    | R37 |
| `/api/attachments/[id]/content`    | GET      | workspace only                                                                | `attachment:create` | existing    | R37 |
| `/api/upload/avatar`               | POST     | session only — writes the SIGNED-IN user’s own avatar                         | —                   | user-scoped | R31 |
| `/api/upload/issue-attachment`     | POST     | `attachmentsService.uploadAttachment` → `assertPermission` (was session only) | `attachment:create` | existing    | R37 |
| `/api/work-items/[id]/attachments` | GET/POST | workspace only                                                                | `attachment:create` | existing    | R37 |

### `board`

| Operation                       | Verbs        | Gate today                                                  | Permission        | Decision | Why |
| ------------------------------- | ------------ | ----------------------------------------------------------- | ----------------- | -------- | --- |
| `/api/board`                    | GET          | `assertCanBrowse` (`boardsService.getBoard`)                | `project:browse`  | existing | R9  |
| `/api/board`                    | PATCH        | `assertBoardConfigAdmin` → `assertPermission` (MOTIR-2296)  | `board:configure` | existing | R9  |
| `/api/board/columns`            | POST         | `assertBoardConfigAdmin` → `assertPermission` (MOTIR-2296)  | `board:configure` | existing | R9  |
| `/api/board/columns/[columnId]` | DELETE/PATCH | `assertBoardConfigAdmin` → `assertPermission` (MOTIR-2296)  | `board:configure` | existing | R9  |
| `/api/board/move`               | POST         | `assertCanEdit`                                             | `work_item:edit`  | existing | R9  |
| `/api/boards`                   | GET          | `boardsService.listBoards` → `assertCanBrowse` (MOTIR-2296) | `project:browse`  | existing | R9  |
| `/api/boards`                   | POST         | `assertBoardConfigAdmin` → `assertPermission` (MOTIR-2296)  | `board:configure` | existing | R9  |
| `/api/boards/[id]`              | DELETE/PATCH | `assertBoardConfigAdmin` → `assertPermission` (MOTIR-2296)  | `board:configure` | existing | R9  |

### `comment`

| Operation                       | Verbs        | Gate today     | Permission    | Decision | Why |
| ------------------------------- | ------------ | -------------- | ------------- | -------- | --- |
| `/api/comments/[id]`            | DELETE/PATCH | workspace only | `comment:add` | existing | R4  |
| `/api/work-items/[id]/comments` | GET/POST     | workspace only | `comment:add` | existing | R4  |

### `estimation`

| Operation                               | Verbs | Gate today                                                       | Permission          | Decision | Why |
| --------------------------------------- | ----- | ---------------------------------------------------------------- | ------------------- | -------- | --- |
| `/api/projects/[key]/estimation-config` | GET   | browse via the service read                                      | `project:browse`    | existing | R25 |
| `/api/projects/[key]/estimation-config` | PATCH | `assertPermission(estimation:manage)` — was workspace OWNER only | `estimation:manage` | existing | R25 |

### `field`

| Operation                                  | Verbs        | Gate today                                                                    | Permission         | Decision | Why |
| ------------------------------------------ | ------------ | ----------------------------------------------------------------------------- | ------------------ | -------- | --- |
| `/api/components/[id]`                     | DELETE/PATCH | `assertPermission(component:manage)` — was a module-private `assertCanManage` | `component:manage` | existing | R24 |
| `/api/fields/[fieldId]`                    | DELETE/PATCH | `assertPermission(field:manage)` — was a module-private `assertCanManage`     | `field:manage`     | existing | R26 |
| `/api/fields/[fieldId]/options`            | POST         | `assertPermission(field:manage)`                                              | `field:manage`     | existing | R26 |
| `/api/fields/[fieldId]/options/[optionId]` | DELETE/PATCH | `assertPermission(field:manage)`                                              | `field:manage`     | existing | R26 |
| `/api/projects/[key]/components`           | GET          | `assertCanBrowse` — the create/edit FORM reads this                           | `project:browse`   | existing | R24 |
| `/api/projects/[key]/components`           | POST         | `assertPermission(component:manage)`                                          | `component:manage` | existing | R24 |
| `/api/projects/[key]/fields`               | GET          | `assertCanBrowse` — the create/edit FORM reads this                           | `project:browse`   | existing | R26 |
| `/api/projects/[key]/fields`               | POST         | `assertPermission(field:manage)`                                              | `field:manage`     | existing | R26 |
| `/api/projects/[key]/labels`               | GET          | `assertCanBrowse` — a member must be able to PICK a label                     | `project:browse`   | existing | R20 |
| `/api/projects/[key]/tags`                 | GET          | `assertCanBrowse`                                                             | `project:browse`   | existing | R20 |
| `/api/projects/[key]/tags`                 | PUT          | `assertPermission(label:manage)`                                              | `label:manage`     | existing | R20 |

### `import`

| Operation                           | Verbs | Gate today                                                                                                             | Permission   | Decision         | Why |
| ----------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------- | --- |
| `/api/import`                       | POST  | `importService.createDraft` → `assertPermission`                                                                       | `import:run` | existing         | R39 |
| `/api/import/[id]`                  | GET   | `importService.getImport` → `assertPermission`                                                                         | `import:run` | existing         | R39 |
| `/api/import/[id]/discover`         | POST  | `importService.discoverFields` → `assertPermission`                                                                    | `import:run` | existing         | R39 |
| `/api/import/[id]/preview`          | POST  | `importService.preview` → `assertPermission`                                                                           | `import:run` | existing         | R39 |
| `/api/import/[id]/run`              | POST  | `importService.run` → `assertPermission`                                                                               | `import:run` | existing         | R39 |
| `/api/import/jira/oauth/callback`   | GET   | workspace only — `resolveWorkspaceContext(req)`; binds the provider credential to a WORKSPACE, no project              | —            | workspace-scoped | R3  |
| `/api/import/jira/oauth/start`      | GET   | workspace only — `resolveWorkspaceContext(req)`; no project resolved                                                   | —            | workspace-scoped | R3  |
| `/api/import/linear/oauth/callback` | GET   | workspace only — `getWorkspaceContext()`; no project resolved                                                          | —            | workspace-scoped | R3  |
| `/api/import/linear/oauth/start`    | GET   | workspace only — the file header: the identity "is workspace-scoped (the substrate keys on [user, source, workspace])" | —            | workspace-scoped | R3  |
| `/api/import/plane/oauth/callback`  | GET   | workspace only — `resolveWorkspaceContext(req)`; no project resolved                                                   | —            | workspace-scoped | R3  |
| `/api/import/plane/oauth/start`     | GET   | workspace only — `resolveWorkspaceContext(req)`; no project resolved                                                   | —            | workspace-scoped | R3  |

### `infra`

| Operation                                    | Verbs                 | Gate today                                                                                                                      | Permission | Decision | Why |
| -------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------- | --- |
| `/api/%5Ftest/db-role`                       | GET                   | — none, deliberately —                                                                                                          | —          | no-gate  | R53 |
| `/api/%5Ftest/docs-url`                      | GET/PUT               | — none, deliberately —                                                                                                          | —          | no-gate  | R62 |
| `/api/%5Ftest/legal-manifest`                | PUT                   | — none, deliberately —                                                                                                          | —          | no-gate  | R61 |
| `/api/%5Ftest/pull-request-links`            | POST                  | `assertCanBrowse`, `assertPermission`                                                                                           | —          | finding  | R8  |
| `/api/%5Ftest/work-item-links`               | DELETE/GET/POST       | `assertCanBrowse`, `assertCanEdit`                                                                                              | —          | finding  | R8  |
| `/api/%5Ftest/work-items`                    | DELETE/GET/PATCH/POST | `assertCanBrowse`, `assertCanEdit`                                                                                              | —          | finding  | R8  |
| `/api/auth/[...all]`                         | —                     | — none —                                                                                                                        | —          | no-gate  | R12 |
| `/api/github/webhook`                        | POST                  | — none —                                                                                                                        | —          | no-gate  | R6  |
| `/api/gitlab/webhook`                        | POST                  | — none —                                                                                                                        | —          | no-gate  | R6  |
| `/api/health/legal`                          | GET                   | — none, deliberately —                                                                                                          | —          | no-gate  | R59 |
| `/api/health/queue`                          | GET                   | — none, deliberately —                                                                                                          | —          | no-gate  | R57 |
| `/api/health/release`                        | GET                   | — none, deliberately —                                                                                                          | —          | no-gate  | R58 |
| `/api/inngest`                               | —                     | — none —                                                                                                                        | —          | no-gate  | R13 |
| `/api/legal/egress-manifest`                 | GET                   | — none, deliberately —                                                                                                          | —          | no-gate  | R60 |
| `/api/internal/ai/code-scanning/analyses`    | GET                   | serviceAuth                                                                                                                     | —          | no-gate  | R29 |
| `/api/internal/ai/code-scanning/sarif`       | GET                   | serviceAuth                                                                                                                     | —          | no-gate  | R29 |
| `/api/internal/ai/dev/noop`                  | GET/POST              | serviceAuth                                                                                                                     | —          | no-gate  | R29 |
| `/api/internal/ai/get-item`                  | GET                   | serviceAuth                                                                                                                     | —          | no-gate  | R29 |
| `/api/internal/ai/get-subtree`               | GET                   | `aiBoundaryService.getSubtree` (transitive)                                                                                     | —          | no-gate  | R29 |
| `/api/internal/ai/job-token/refresh`         | POST                  | serviceAuth + a LIVE job token (`authenticateAndLimitJobRequest`)                                                               | —          | no-gate  | R29 |
| `/api/internal/ai/live-projects`             | POST                  | serviceAuth                                                                                                                     | —          | no-gate  | R29 |
| `/api/internal/ai/log-bug`                   | POST                  | serviceAuth                                                                                                                     | —          | no-gate  | R29 |
| `/api/internal/ai/org-context`               | GET                   | serviceAuth                                                                                                                     | —          | no-gate  | R29 |
| `/api/internal/ai/pending-plans`             | GET                   | `aiBoundaryService.readPendingPlans` (transitive)                                                                               | —          | no-gate  | R29 |
| `/api/internal/ai/plan-change-mailbox`       | POST                  | serviceAuth + a LIVE job token (`authenticateAndLimitJobRequest`) — the mailbox is read AS the token's user at a phase boundary | —          | no-gate  | R29 |
| `/api/internal/ai/plan-proposals`            | POST                  | serviceAuth                                                                                                                     | —          | no-gate  | R29 |
| `/api/internal/ai/plan-proposals/[itemId]`   | PATCH                 | serviceAuth                                                                                                                     | —          | no-gate  | R29 |
| `/api/internal/ai/plan-tree`                 | GET                   | `aiBoundaryService.readPlanTree` (transitive)                                                                                   | —          | no-gate  | R29 |
| `/api/internal/ai/repo-file`                 | GET                   | serviceAuth + a LIVE job token (`authenticateAndLimitJobRequest`) — the repo row is resolved in the TOKEN's own workspace       | —          | no-gate  | R29 |
| `/api/internal/ai/search-work-items`         | POST                  | serviceAuth                                                                                                                     | —          | no-gate  | R29 |
| `/api/internal/ai/similar-work-items`        | POST                  | `aiBoundaryService.findSimilarWorkItems` (transitive)                                                                           | —          | no-gate  | R29 |
| `/api/internal/ai/skeleton`                  | GET                   | `aiBoundaryService.readPlanTree` (transitive)                                                                                   | —          | no-gate  | R29 |
| `/api/internal/ai/terminal-statuses`         | GET                   | `aiBoundaryService.readTerminalStatuses` (transitive)                                                                           | —          | no-gate  | R29 |
| `/api/internal/ai/validate-plan`             | POST                  | serviceAuth                                                                                                                     | —          | no-gate  | R29 |
| `/api/internal/ai/validate-plan-forest`      | POST                  | serviceAuth                                                                                                                     | —          | no-gate  | R29 |
| `/api/internal/ai/validate-plan-sprint`      | POST                  | serviceAuth                                                                                                                     | —          | no-gate  | R29 |
| `/api/internal/ai/walk-blocking`             | GET                   | serviceAuth                                                                                                                     | —          | no-gate  | R29 |
| `/api/internal/ai/work-items`                | POST                  | `aiWorkItemsService.fileBug` (transitive)                                                                                       | —          | no-gate  | R29 |
| `/api/internal/billing/ai-included-seat`     | POST                  | serviceAuth                                                                                                                     | —          | no-gate  | R29 |
| `/api/internal/billing/scaled-tracker-state` | POST                  | serviceAuth                                                                                                                     | —          | no-gate  | R29 |
| `/api/docs/mcp-tools.json`                   | GET                   | — none —                                                                                                                        | —          | no-gate  | R32 |
| `/api/docs/cli-commands.json`                | GET                   | — none —                                                                                                                        | —          | no-gate  | R32 |
| `/api/openapi/v1.json`                       | GET                   | — none —                                                                                                                        | —          | no-gate  | R32 |
| `/api/openapi/public.json`                   | GET                   | — none —                                                                                                                        | —          | no-gate  | R32 |
| `/api/resend/webhook`                        | POST                  | — none —                                                                                                                        | —          | no-gate  | R6  |

### `integration`

| Operation                      | Verbs    | Gate today   | Permission | Decision     | Why |
| ------------------------------ | -------- | ------------ | ---------- | ------------ | --- |
| `/api/cli/device/approve`      | POST     | session only | —          | token-scoped | R30 |
| `/api/cli/device/grant`        | GET      | session only | —          | token-scoped | R30 |
| `/api/cli/device/start`        | POST     | — none —     | —          | token-scoped | R30 |
| `/api/cli/device/token`        | POST     | — none —     | —          | token-scoped | R30 |
| `/api/mcp`                     | —        | — none —     | —          | token-scoped | R30 |
| `/api/me/api-tokens`           | GET/POST | session only | —          | user-scoped  | R35 |
| `/api/me/api-tokens/[tokenId]` | DELETE   | session only | —          | user-scoped  | R35 |

### `member`

| Operation                                                  | Verbs        | Gate today                                                            | Permission              | Decision | Why |
| ---------------------------------------------------------- | ------------ | --------------------------------------------------------------------- | ----------------------- | -------- | --- |
| `/api/projects/[key]/access`                               | PATCH        | `projectMembersService.setAccessLevel` → `assertPermission`           | `project:manage_access` | existing | R18 |
| `/api/projects/[key]/members`                              | GET          | `projectMembersService.listMembers` → `assertPermission`              | `project:browse`        | existing | R27 |
| `/api/projects/[key]/members`                              | POST         | `projectMembersService.addMember` → `assertPermission`                | `member:manage`         | existing | R27 |
| `/api/projects/[key]/members/[userId]`                     | DELETE/PATCH | `projectMembersService.{removeMember,setRole}` → `assertPermission`   | `member:manage`         | existing | R27 |
| `/api/projects/[key]/roles`                                | POST         | `projectRoleDefinitionService.create` → `assertPermission`            | `project:manage_access` | existing | R51 |
| `/api/projects/[key]/roles/[roleId]`                       | PATCH/DELETE | `projectRoleDefinitionService.{update,delete}` → `assertPermission`   | `project:manage_access` | existing | R51 |
| `/api/projects/[key]/public-addresses`                     | GET          | `customDomainService.list` → `assertPermission`                       | `project:browse`        | existing | R51 |
| `/api/projects/[key]/public-addresses`                     | POST         | `customDomainService.add` → `assertPermission`                        | `project:manage_access` | existing | R51 |
| `/api/projects/[key]/public-addresses/[addressId]`         | DELETE       | `customDomainService.remove` → `assertPermission`                     | `project:manage_access` | existing | R51 |
| `/api/projects/[key]/public-addresses/[addressId]/verify`  | POST         | `customDomainService.verify` → `assertPermission`                     | `project:manage_access` | existing | R51 |
| `/api/projects/[key]/public-addresses/[addressId]/primary` | POST/DELETE  | `customDomainService.{makePrimary,clearPrimary}` → `assertPermission` | `project:manage_access` | existing | R51 |

### `project`

| Operation                             | Verbs  | Gate today                                        | Permission           | Decision | Why |
| ------------------------------------- | ------ | ------------------------------------------------- | -------------------- | -------- | --- |
| `/api/projects/[key]`                 | PATCH  | workspace only                                    | `project:administer` | existing | R15 |
| `/api/projects/[key]/aliases/[alias]` | DELETE | workspace only                                    | `project:administer` | existing | R15 |
| `/api/upload/project-image`           | POST   | `projectsService.uploadImage` → `assertCanManage` | `project:administer` | existing | R15 |

### `public_request`

| Operation                                              | Verbs  | Gate today                                                                        | Permission               | Decision | Why |
| ------------------------------------------------------ | ------ | --------------------------------------------------------------------------------- | ------------------------ | -------- | --- |
| `/api/public-requests/[id]/comments`                   | POST   | workspace only                                                                    | `public_request:comment` | existing | R36 |
| `/api/public-requests/[id]/upvote`                     | POST   | workspace only                                                                    | `public_request:comment` | existing | R36 |
| `/api/public/categories`                               | GET    | — none — anonymous; the `accessLevel = public` filter is the repository aggregate | —                        | no-gate  | R33 |
| `/api/public/explore`                                  | GET    | — none — anonymous; the `accessLevel = public` filter is the repository aggregate | —                        | no-gate  | R33 |
| `/api/public/projects`                                 | GET    | — none — anonymous; the `accessLevel = public` filter is the repository aggregate | —                        | no-gate  | R33 |
| `/api/public/hosts/[host]`                             | GET    | — none — anonymous; the CLOUD gate, then a hostname the store says is LIVE        | —                        | no-gate  | R33 |
| `/api/public/p/[identifier]`                           | GET    | `assertCanBrowsePublic`                                                           | `public_request:submit`  | existing | R33 |
| `/api/public/p/[identifier]/changelog`                 | GET    | `assertCanBrowsePublic`                                                           | `public_request:submit`  | existing | R33 |
| `/api/public/p/[identifier]/changelog.xml`             | GET    | `resolvePublicProject` → `resolvePublicBrowse`                                    | `public_request:submit`  | new      | R33 |
| `/api/public/p/[identifier]/follow`                    | POST   | session + `assertCanBrowsePublic`                                                 | `public_request:submit`  | existing | R33 |
| `/api/public/p/[identifier]/follow`                    | DELETE | session + `assertCanBrowsePublic`                                                 | `public_request:submit`  | existing | R33 |
| `/api/public/p/[identifier]/subscribe`                 | POST   | `assertCanBrowsePublic`                                                           | `public_request:submit`  | existing | R33 |
| `/api/public/p/[identifier]/items`                     | GET    | `assertCanBrowsePublic`                                                           | `public_request:submit`  | existing | R33 |
| `/api/public/p/[identifier]/items/[key]`               | GET    | `resolvePublicProject` → `resolvePublicBrowse`                                    | `public_request:submit`  | new      | R33 |
| `/api/public/p/[identifier]/board`                     | GET    | `resolvePublicProject` → `resolvePublicBrowse`                                    | `public_request:submit`  | new      | R33 |
| `/api/public/p/[identifier]/roadmap`                   | GET    | session only                                                                      | `public_request:submit`  | existing | R33 |
| `/api/public/p/[identifier]/tree`                      | GET    | session only                                                                      | `public_request:submit`  | existing | R33 |
| `/api/public/projects/[projectId]/requests`            | POST   | session only                                                                      | `public_request:submit`  | existing | R33 |
| `/api/public/projects/[projectId]/requests/duplicates` | GET    | `assertCanSubmitToTriage`                                                         | `public_request:submit`  | existing | R33 |
| `/api/public/p/[identifier]/requests/[requestKey]`     | GET    | `resolvePublicProject` → `resolvePublicBrowse`                                    | `public_request:submit`  | new      | R33 |

> **MOTIR-3877** adds six rows — five marked `new`, one `no-gate`. Five are READS
> that complete the public contract motir.co renders from, and FOUR of those five
> reach the same authority as their older siblings: `resolvePublicProject` calls
> `projectAccessService.resolvePublicBrowse`, which is `assertCanBrowsePublic`'s
> own gate — the older rows name the assertion, these name the resolver, and it is
> one code path. Each also applies the epic-privacy exclusion, so a non-member
> never receives a private epic's descendants through a NEW read either.
>
> `/api/public/projects` is `no-gate` for exactly MOTIR-2366's reason: it is the
> anonymous project INDEX a crawler walks — the same shape as `/api/public/explore`
> — so there is no `getSession()` call and no project to resolve, and the
> `accessLevel = 'public'` filter lives in the repository aggregate. Reading a
> directory of public projects is not submitting to one.
>
> ⚠️ **`/api/projects/[key]/public-overview` is the odd row, and deliberately.** It
> is a WRITE, it is `project:administer`, and it sits under `/api/projects/*`
> rather than `/api/public/*` — because `/api/public/*` is a versioned contract
> with third-party readers and a deprecation policy (`public-surface-hosts.md`
> AMENDMENT 1 §D). The in-place Edit on a public page is an application affordance
> for a project admin, not part of what motir.co may read, and putting it under the
> public prefix would have committed us to supporting it as contract. An anonymous
> caller never resolves `canManage`, so it 403s before any write.

### `report`

| Operation                                                   | Verbs            | Gate today                                                                     | Permission            | Decision         | Why |
| ----------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------ | --------------------- | ---------------- | --- |
| `/api/dispatch-runs/[id]`                                   | GET              | `requireCompliantWorkspaceContext` + RLS (the run's own workspace)             | —                     | workspace-scoped | R58 |
| `/api/dispatch-runs/[id]/stream`                            | GET              | `requireCompliantWorkspaceContext` + RLS, before the stream opens              | —                     | workspace-scoped | R58 |
| `/api/dashboards`                                           | GET/POST         | workspace only                                                                 | —                     | workspace-scoped | R34 |
| `/api/dashboards/[dashboardId]`                             | DELETE/GET/PATCH | workspace only                                                                 | —                     | workspace-scoped | R34 |
| `/api/dashboards/[dashboardId]/widgets`                     | POST             | workspace only                                                                 | —                     | workspace-scoped | R34 |
| `/api/dashboards/[dashboardId]/widgets/[widgetId]`          | DELETE/PATCH     | workspace only                                                                 | —                     | workspace-scoped | R34 |
| `/api/dashboards/[dashboardId]/widgets/[widgetId]/move`     | POST             | workspace only                                                                 | —                     | workspace-scoped | R34 |
| `/api/projects/[key]/roadmap`                               | GET              | `workItemsService.getProjectRoadmap` → `assertPermission`                      | `report:view`         | existing         | R19 |
| `/api/projects/[key]/saved-filters`                         | GET/POST         | `savedFiltersService.{list,create}` → `assertPermission`                       | `saved_filter:manage` | existing         | R16 |
| `/api/projects/[key]/saved-filters/[filterId]`              | DELETE/GET/PATCH | `savedFiltersService.{update,delete,changeOwner}` → `assertPermission`         | `saved_filter:manage` | existing         | R16 |
| `/api/projects/[key]/saved-filters/[filterId]/dependents`   | GET              | `savedFiltersService.getDependents` → `getSavedFilterCapabilities`             | `project:browse`      | existing         | R16 |
| `/api/projects/[key]/saved-filters/[filterId]/star`         | DELETE/PUT       | `savedFiltersService.{star,unstar}` → `assertPermission`                       | `saved_filter:manage` | existing         | R16 |
| `/api/projects/[key]/saved-filters/[filterId]/subscription` | DELETE/GET/PUT   | `savedFilterSubscriptionsService.{subscribe,unsubscribe}` → `assertPermission` | `saved_filter:manage` | existing         | R16 |
| `/api/projects/[key]/dispatch-runs`                         | GET              | `dispatchRunService.listRunsForProject` → `assertCanBrowse`                    | `project:browse`      | existing         | R58 |
| `/api/projects/[key]/dispatch-runs/active`                  | GET              | `dispatchRunService` → `assertCanBrowse`                                       | `project:browse`      | existing         | R58 |
| `/api/projects/[key]/velocity`                              | GET              | `reportsService.getVelocity` → `assertPermission`                              | `report:view`         | existing         | R19 |
| `/api/reports/average-age`                                  | GET              | `reportsService.*` → `resolveReportScope` → `assertPermission`                 | `report:view`         | existing         | R46 |
| `/api/reports/created-vs-resolved`                          | GET              | `reportsService.*` → `resolveReportScope` → `assertPermission`                 | `report:view`         | existing         | R46 |
| `/api/reports/distribution`                                 | GET              | `reportsService.*` → `resolveReportScope` → `assertPermission`                 | `report:view`         | existing         | R46 |
| `/api/reports/filter-results`                               | GET              | `reportsService.*` → `resolveReportScope` → `assertPermission`                 | `report:view`         | existing         | R46 |
| `/api/reports/resolution-time`                              | GET              | `reportsService.*` → `resolveReportScope` → `assertPermission`                 | `report:view`         | existing         | R46 |
| `/api/reports/workload`                                     | GET              | `reportsService.*` → `resolveReportScope` → `assertPermission`                 | `report:view`         | existing         | R46 |

### `repository`

| Operation                                           | Verbs        | Gate today                                                                                                                                                                                                                                                     | Permission                 | Decision         | Why |
| --------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------- | --- |
| `/api/github/oauth/callback`                        | GET          | session only — binds the installation to a WORKSPACE; redirects to the surface the flow STARTED from (MOTIR-4676), defaulting to `/settings/organization/git`                                                                                                  | —                          | workspace-scoped | R3  |
| `/api/github/oauth/start`                           | GET          | session only — no project; redirects to the surface the flow STARTED from (MOTIR-4676), defaulting to `/settings/organization/git`                                                                                                                             | —                          | workspace-scoped | R3  |
| `/api/github/organizations`                         | GET          | workspace only — `getWorkspaceContext()`; no project resolved                                                                                                                                                                                                  | —                          | workspace-scoped | R3  |
| `/api/github/setup`                                 | GET          | session only — binds the installation to a WORKSPACE                                                                                                                                                                                                           | —                          | workspace-scoped | R3  |
| `/api/gitlab/oauth/callback`                        | GET          | session only — no project resolved                                                                                                                                                                                                                             | —                          | workspace-scoped | R3  |
| `/api/gitlab/oauth/start`                           | GET          | workspace only — the file header: "WORKSPACE-scoped, so we resolve the acting member’s active workspace"                                                                                                                                                       | —                          | workspace-scoped | R3  |
| `/api/projects/[key]/repositories`                  | GET          | `assertCanBrowse` (`inProject('browse')`)                                                                                                                                                                                                                      | `project:browse`           | existing         | R21 |
| `/api/projects/[key]/repositories`                  | POST         | `assertPermission(repository:manage)` — was `assertCanEdit`, i.e. any project MEMBER                                                                                                                                                                           | `repository:manage`        | existing         | R21 |
| `/api/projects/[key]/repositories/[rowId]`          | DELETE/PATCH | `assertPermission(repository:manage)` — was `assertCanEdit`                                                                                                                                                                                                    | `repository:manage`        | existing         | R21 |
| `/api/projects/[key]/repositories/[rowId]/move`     | POST         | `assertPermission(repository:manage)` (`inLockedRow`)                                                                                                                                                                                                          | `repository:manage`        | existing         | R21 |
| `/api/projects/[key]/repositories/[rowId]/state`    | POST         | `assertPermission(repository:manage)` — ACTOR-initiated: the route resolves `getWorkspaceContext()`, not serviceAuth                                                                                                                                           | `repository:manage`        | existing         | R21 |
| `/api/projects/[key]/repositories/[rowId]/takeover` | POST         | `assertPermission(repository:manage)` (takeover `inLockedRow`)                                                                                                                                                                                                 | `repository:manage`        | existing         | R21 |
| `/api/projects/[key]/repositories/access`           | GET/POST     | browse, via `listByProject` — the SELF-connect path (`grantAccess` invites the actor's OWN identity). Stays open: ADR §3 Q3                                                                                                                                    | `project:browse`           | existing         | R22 |
| `/api/projects/[key]/repositories/access/team`      | GET          | browse, via `listTeamAccess` → `listByProject` — reads the matrix                                                                                                                                                                                              | `project:browse`           | existing         | R22 |
| `/api/projects/[key]/repositories/access/team`      | POST         | `assertPermission(repository:manage_access)` — was `assertCanEdit`; granting ANOTHER member's clone access                                                                                                                                                     | `repository:manage_access` | existing         | R22 |
| `/api/projects/[key]/repositories/establish`        | POST         | `assertPermission(repository:manage)` (via the set service's helpers)                                                                                                                                                                                          | `repository:manage`        | existing         | R21 |
| `/api/projects/[key]/repositories/available`        | GET          | `assertCanBrowse` (`inProjectOrg('browse')`) — the ORG's inventory, minus what this project holds. Org MEMBERSHIP, not org admin: `organization-tier.md` §6 forbids a relocation that narrows an audience, and the surface it moves from checks no role at all | `project:browse`           | existing         | R21 |
| `/api/projects/[key]/repositories/add`              | POST         | `assertPermission(repository:manage)` **plus `assertOrgAdmin` in the SERVICE** — the room's key is a PROJECT permission, so without the org check a project admin could connect a repository to an organisation they do not administer (MOTIR-4678)            | `repository:manage`        | existing         | R21 |

### `sprint`

> **MOTIR-2350 wired ten of these thirteen rows, and the split it made is not the one this
> table originally recorded.** Taking all thirteen literally would have made the backlog and a
> sprint's issue list invisible to a project `viewer` — so the three READS ask `project:browse`
> (Jira splits _Manage Sprints_ from _Browse Projects_ the same way), and `POST /api/backlog` asks
> `work_item:edit`, because authoring work is not a sprint act however the issue enters the list.
> The three ANALYTICS rows (`burndown` / `points` / `report`) are re-pointed at `report:view` and
> left for **MOTIR-2351**, so one key has one owner and two cards never flip the same
> `enforcement` flag.
>
> ⚠️ **The direction of travel differs between the two services, and the row cells alone hide it.**
> `backlogService` had NO project gate — those rows TIGHTEN. The five sprint LIFECYCLE writes ran
> through a module-private `isOwnerRole` check, i.e. the workspace OWNER or ADMIN and nobody else —
> so `sprint:manage` LOOSENS them to the project's own admins and members, exactly as MOTIR-2296 /
> -2297 / -2298 did for board, workflow and estimation. See the GATE TODAY, MEASURED table above.

| Operation                       | Verbs        | Gate today                                                           | Permission       | Decision | Why |
| ------------------------------- | ------------ | -------------------------------------------------------------------- | ---------------- | -------- | --- |
| `/api/backlog`                  | GET          | `backlogService.getBacklog` → `assertPermission`                     | `project:browse` | existing | R14 |
| `/api/backlog`                  | POST         | `backlogService.createBacklogIssue` → `assertPermission`             | `work_item:edit` | existing | R14 |
| `/api/backlog/bulk-move`        | POST         | `backlogService.bulkMoveToBacklog` → `assertPermission`              | `sprint:manage`  | existing | R14 |
| `/api/sprints`                  | GET          | `sprintsService.listByProject` → `assertPermission`                  | `project:browse` | existing | R14 |
| `/api/sprints`                  | POST         | `sprintsService.createSprint` → `assertPermission`                   | `sprint:manage`  | existing | R14 |
| `/api/sprints/[id]`             | DELETE/PATCH | `sprintsService.{deleteSprint,updateSprint}` → `assertPermission`    | `sprint:manage`  | existing | R14 |
| `/api/sprints/[id]/burndown`    | GET          | `reportsService.getSprintCycleGraph` → `assertPermission`            | `report:view`    | existing | R14 |
| `/api/sprints/[id]/complete`    | POST         | `sprintsService.completeSprint` → `assertPermission`                 | `sprint:manage`  | existing | R14 |
| `/api/sprints/[id]/issues`      | GET          | `backlogService.getSprintIssues` → `assertPermission`                | `project:browse` | existing | R14 |
| `/api/sprints/[id]/issues/bulk` | POST         | `backlogService.bulkAssignToSprint` → `assertPermission`             | `sprint:manage`  | existing | R14 |
| `/api/sprints/[id]/points`      | GET          | `estimationService.rollupForSprint` → `assertPermission`             | `report:view`    | existing | R14 |
| `/api/sprints/[id]/report`      | GET          | `sprintsService.getSprintReport` → `assertPermission`                | `report:view`    | existing | R14 |
| `/api/sprints/[id]/start`       | POST         | `sprintsService.startSprint` → `assertPermission`                    | `sprint:manage`  | existing | R14 |
| `/api/work-items/[id]/rank`     | POST         | `backlogService.rankIssue` → `assertPermission`                      | `sprint:manage`  | existing | R14 |
| `/api/work-items/[id]/sprint`   | POST         | `backlogService.{assignToSprint,moveToBacklog}` → `assertPermission` | `sprint:manage`  | existing | R14 |

### `user`

| Operation                                 | Verbs     | Gate today     | Permission | Decision    | Why |
| ----------------------------------------- | --------- | -------------- | ---------- | ----------- | --- |
| `/api/account/confirm-email-change`       | GET       | — none —       | —          | user-scoped | R31 |
| `/api/account/data-export/[id]/download`  | GET       | session only   | —          | user-scoped | R31 |
| `/api/account/two-factor/backup-codes`    | POST      | session only   | —          | user-scoped | R31 |
| `/api/account/two-factor/status`          | GET       | session only   | —          | user-scoped | R31 |
| `/api/account/two-factor/trusted-devices` | DELETE    | session only   | —          | user-scoped | R31 |
| `/api/account/request-email-change`       | POST      | workspace only | —          | user-scoped | R31 |
| `/api/appearance-preference`              | GET/PATCH | workspace only | —          | user-scoped | R31 |
| `/api/notification-preferences`           | GET/PUT   | workspace only | —          | user-scoped | R31 |
| `/api/notifications`                      | GET       | workspace only | —          | user-scoped | R40 |
| `/api/notifications/[id]/read`            | PATCH     | workspace only | —          | user-scoped | R40 |
| `/api/notifications/mark-all-read`        | POST      | workspace only | —          | user-scoped | R40 |
| `/api/notifications/unread-count`         | GET       | workspace only | —          | user-scoped | R40 |

### `watcher`

| Operation                                | Verbs      | Gate today     | Permission       | Decision | Why |
| ---------------------------------------- | ---------- | -------------- | ---------------- | -------- | --- |
| `/api/work-items/[id]/watch`             | DELETE/PUT | workspace only | `watcher:manage` | existing | R44 |
| `/api/work-items/[id]/watchers`          | GET/POST   | workspace only | `watcher:manage` | existing | R44 |
| `/api/work-items/[id]/watchers/[userId]` | DELETE     | workspace only | `watcher:manage` | existing | R44 |

### `work_item`

| Operation                                               | Verbs       | Gate today                                                                                 | Permission              | Decision | Why |
| ------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------ | ----------------------- | -------- | --- |
| `/api/projects/[key]/triage/queue`                      | GET         | `triageService.getTriageQueueByKey` → `assertPermission`                                   | `work_item:triage`      | existing | R23 |
| `/api/projects/[key]/triage/submissions`                | POST        | `triageService.createSubmission` → `assertCanBrowse`                                       | `public_request:submit` | existing | R23 |
| `/api/ready`                                            | GET         | workspace only                                                                             | `project:browse`        | existing | R2  |
| `/api/ready/next`                                       | POST        | workspace only                                                                             | `project:browse`        | existing | R2  |
| `/api/ready/nudge`                                      | GET         | `workItemsService.computeExpansionNudge` → `assertPermission` (was session only)           | `project:browse`        | existing | R2  |
| `/api/work-items/[id]`                                  | DELETE      | `workItemsService.deleteWorkItem` → `assertPermission`                                     | `work_item:delete`      | existing | R42 |
| `/api/work-items/[id]/acceptance-evidence`              | POST        | `acceptanceEvidenceService` → `resolveStory` → `assertPermission` (was — none —)           | `work_item:edit`        | existing | R43 |
| `/api/work-items/[id]/acceptance-evidence/upload-token` | POST        | `acceptanceEvidenceService` → `resolveStory` → `assertPermission` (was — none —)           | `work_item:edit`        | existing | R43 |
| `/api/work-items/[id]/activity/all`                     | GET         | workspace only                                                                             | `project:browse`        | existing | R2  |
| `/api/work-items/[id]/activity/history`                 | GET         | `activityService.listHistory` → `assertPermission` (was workspace only)                    | `project:browse`        | existing | R2  |
| `/api/work-items/[id]/archive`                          | DELETE/POST | `workItemsService.{archive,unarchive}WorkItem` → `assertPermission`                        | `work_item:archive`     | existing | R42 |
| `/api/work-items/[id]/components`                       | POST/PUT    | workspace only                                                                             | `work_item:edit`        | existing | R41 |
| `/api/work-items/[id]/components/[componentId]`         | DELETE      | workspace only                                                                             | `work_item:edit`        | existing | R41 |
| `/api/work-items/[id]/delete-preview`                   | GET         | `workItemsService.getDeletePreview` → `assertPermission`                                   | `work_item:delete`      | existing | R42 |
| `/api/work-items/[id]/dispatch-runs`                    | GET         | `dispatchRunService` → `assertCanBrowse`                                                   | `project:browse`        | existing | R58 |
| `/api/work-items/[id]/design-evidence`                  | POST        | `designEvidenceService` → `resolveTarget` → `assertPermission`                             | `work_item:edit`        | existing | R52 |
| `/api/work-items/[id]/design-evidence/upload-token`     | POST        | `designEvidenceService` → `resolveTarget` → `assertPermission`                             | `work_item:edit`        | existing | R52 |
| `/api/work-items/[id]/epic-privacy`                     | PATCH       | `assertCanManageProject`                                                                   | `work_item:edit`        | existing | R41 |
| `/api/work-items/[id]/estimate`                         | PATCH       | `estimationService.setEstimate` → `assertPermission` (was workspace only)                  | `work_item:edit`        | existing | R41 |
| `/api/work-items/[id]/labels`                           | POST/PUT    | workspace only                                                                             | `work_item:edit`        | existing | R41 |
| `/api/work-items/[id]/labels/[labelId]`                 | DELETE      | workspace only                                                                             | `work_item:edit`        | existing | R41 |
| `/api/work-items/[id]/rollup`                           | GET         | `estimationService.rollupForParent` → `assertPermission` (was workspace only)              | `project:browse`        | existing | R2  |
| `/api/work-items/[id]/triage/accept`                    | POST        | `triageService.*` → `assertPermission`                                                     | `work_item:triage`      | existing | R23 |
| `/api/work-items/[id]/triage/decline`                   | POST        | `triageService.*` → `assertPermission`                                                     | `work_item:triage`      | existing | R23 |
| `/api/work-items/[id]/triage/detail`                    | GET         | `triageService.getTriageItemDetail` → `assertPermission`                                   | `work_item:triage`      | existing | R23 |
| `/api/work-items/[id]/triage/duplicate`                 | POST        | `triageService.*` → `assertPermission`                                                     | `work_item:triage`      | existing | R23 |
| `/api/work-items/[id]/triage/promote`                   | POST        | `triageService.*` → `assertPermission`                                                     | `work_item:triage`      | existing | R23 |
| `/api/work-items/[id]/triage/snooze`                    | DELETE/POST | `triageService.*` → `assertPermission`                                                     | `work_item:triage`      | existing | R23 |
| `/api/work-items/mention-search`                        | GET         | `workItemsService.quickSearch` → `filterBrowsable` (a real gate the walk could not follow) | `project:browse`        | existing | R2  |
| `/api/work-items/peek`                                  | GET         | `assertCanBrowse`, `getCapabilities`                                                       | `project:browse`        | existing | R2  |
| `/api/work-items/planning-anchor`                       | GET         | `workItemsService.getWorkItemWithAncestors` → `assertCanBrowse`                            | `project:browse`        | existing | R2  |

### `workflow`

| Operation                                                  | Verbs            | Gate today                                                    | Permission          | Decision | Why |
| ---------------------------------------------------------- | ---------------- | ------------------------------------------------------------- | ------------------- | -------- | --- |
| `/api/board/columns/[columnId]/statuses`                   | PUT              | `assertPermission(workflow:manage)` — was ws OWNER only       | `workflow:manage`   | existing | R10 |
| `/api/board/columns/[columnId]/statuses/[statusId]`        | DELETE           | `assertPermission(workflow:manage)` — was ws OWNER only       | `workflow:manage`   | existing | R10 |
| `/api/projects/[key]/automation-rules`                     | GET/POST         | `assertPermission(automation:manage)` — was `assertCanManage` | `automation:manage` | existing | R28 |
| `/api/projects/[key]/automation-rules/[ruleId]`            | DELETE/GET/PATCH | `assertPermission(automation:manage)` — was `assertCanManage` | `automation:manage` | existing | R28 |
| `/api/projects/[key]/automation-rules/[ruleId]/enabled`    | PUT              | `assertPermission(automation:manage)` — was `assertCanManage` | `automation:manage` | existing | R28 |
| `/api/projects/[key]/automation-rules/[ruleId]/executions` | GET              | `assertPermission(automation:manage)` — was `assertCanManage` | `automation:manage` | existing | R28 |
| `/api/projects/[key]/status-automation`                    | GET              | `assertCanBrowse`                                             | `project:browse`    | existing | R28 |
| `/api/projects/[key]/status-automation`                    | PATCH            | `assertPermission(automation:manage)`                         | `automation:manage` | existing | R28 |

### `workspace`

| Operation                                        | Verbs        | Gate today                                                                                                                                                                                                                                                                                                           | Permission | Decision         | Why |
| ------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------- | --- |
| `/api/invites/[token]`                           | GET          | — none —                                                                                                                                                                                                                                                                                                             | —          | workspace-scoped | R38 |
| `/api/invites/[token]/accept`                    | POST         | session only                                                                                                                                                                                                                                                                                                         | —          | workspace-scoped | R38 |
| `/api/onboarding/migrate`                        | POST         | session only                                                                                                                                                                                                                                                                                                         | —          | workspace-scoped | R45 |
| `/api/onboarding/migrate/[id]`                   | GET          | `assertCanBrowse`                                                                                                                                                                                                                                                                                                    | —          | workspace-scoped | R45 |
| `/api/onboarding/migrate/[id]/advance`           | POST         | workspace only                                                                                                                                                                                                                                                                                                       | —          | workspace-scoped | R45 |
| `/api/onboarding/migrate/[id]/index-status`      | GET          | `assertCanBrowse`                                                                                                                                                                                                                                                                                                    | —          | workspace-scoped | R45 |
| `/api/onboarding/migrate/[id]/skip-import`       | POST         | `assertCanEdit`                                                                                                                                                                                                                                                                                                      | —          | workspace-scoped | R45 |
| `/api/organization/repositories/[githubRepoId]`  | DELETE       | `assertOrgAdmin` in `organizationRepoService.disconnectFromOrganisation`, inside the transaction — the ORG-level disconnect. GitHub is refused 409 (Motir cannot remove one; the App's install screen owns it). Same answer as `settings/organization/security/actions.ts`: an ORG-ROLE gate, not a named permission | —          | workspace-scoped | R3  |
| `/api/organizations/[orgId]`                     | PATCH        | session only                                                                                                                                                                                                                                                                                                         | —          | workspace-scoped | R3  |
| `/api/organizations/[orgId]/billing`             | GET          | session only                                                                                                                                                                                                                                                                                                         | —          | workspace-scoped | R3  |
| `/api/organizations/[orgId]/billing/checkout`    | POST         | session only                                                                                                                                                                                                                                                                                                         | —          | workspace-scoped | R3  |
| `/api/organizations/[orgId]/billing/portal`      | POST         | session only                                                                                                                                                                                                                                                                                                         | —          | workspace-scoped | R3  |
| `/api/organizations/[orgId]/members`             | GET/POST     | session only                                                                                                                                                                                                                                                                                                         | —          | workspace-scoped | R3  |
| `/api/organizations/[orgId]/members/[userId]`    | DELETE/PATCH | session only                                                                                                                                                                                                                                                                                                         | —          | workspace-scoped | R3  |
| `/api/organizations/[orgId]/usage`               | GET          | session only                                                                                                                                                                                                                                                                                                         | —          | workspace-scoped | R3  |
| `/api/workspaces/[workspaceId]/invites`          | POST         | session only                                                                                                                                                                                                                                                                                                         | —          | workspace-scoped | R3  |
| `/api/workspaces/[workspaceId]/public-subdomain` | GET/PUT      | workspace ROLE (`owner`/`admin`) → `SubdomainForbiddenError`                                                                                                                                                                                                                                                         | —          | workspace-scoped | R3  |
| `/api/workspaces/current`                        | GET          | session only                                                                                                                                                                                                                                                                                                         | —          | workspace-scoped | R3  |

### `'use server'` actions

| File                                                     | Exported actions                                                                                            | Gate today                                                         | Permission           | Decision         | Why |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------- | ---------------- | --- |
| `app/(admin)/admin/tenants/[orgId]/actions.ts`           | setInternalBillingAction                                                                                    | `requirePlatformStaff('superadmin')` (×2 — action + service)       | —                    | platform-scoped  | R63 |
| `app/(admin)/admin/users/[userId]/actions.ts`            | sendPasswordResetAction, setSuspendedAction                                                                 | `requirePlatformStaff('operator')` (×2 — action + service)         | —                    | platform-scoped  | R54 |
| `app/(auth)/re-consent/_actions.ts`                      | acceptCurrentLegalDocumentsAction                                                                           | session only                                                       | —                    | user-scoped      | R55 |
| `app/(authed)/_account-deletion-actions.ts`              | cancelAccountDeletionAction, scheduleAccountDeletionAction                                                  | session only                                                       | —                    | user-scoped      | R31 |
| `app/(authed)/_actions.ts`                               | createOrganizationAction, createWorkspaceAction, switchOrganizationAction                                   | — none —                                                           | `work_item:edit`     | existing         | R41 |
| `app/(authed)/_project-actions.ts`                       | archiveProjectAction, createProjectAction, setActiveProjectAction                                           | — none —                                                           | `project:administer` | existing         | R15 |
| `app/(authed)/items/[key]/acceptanceActions.ts`          | decideAcceptanceAction, turnOnAcceptanceVideoAction                                                         | — none —                                                           | `work_item:edit`     | existing         | R41 |
| `app/(authed)/items/[key]/actions.ts`                    | createLinkAction, linkPullRequestAction, listLinkCandidatesAction                                           | `assertCanBrowse`, `assertCanEdit`                                 | `work_item:edit`     | existing         | R41 |
| `app/(authed)/items/[key]/commentActions.ts`             | addCommentAction, deleteCommentAction, editCommentAction                                                    | — none —                                                           | `comment:add`        | existing         | R4  |
| `app/(authed)/items/[key]/customFieldActions.ts`         | setCustomFieldValueAction                                                                                   | `assertCanEdit`                                                    | `work_item:edit`     | existing         | R41 |
| `app/(authed)/items/[key]/todoActions.ts`                | addTodoAction, deleteTodoAction, moveTodoAction, setTodoDoneAction, updateTodoAction                        | — none —                                                           | `work_item:edit`     | existing         | R41 |
| `app/(authed)/items/[key]/edit/actions.ts`               | changeStatusAction, updateIssueAction                                                                       | `assertCanBrowse`                                                  | `work_item:edit`     | existing         | R41 |
| `app/(authed)/items/[key]/labelComponentActions.ts`      | addComponentAction, addLabelAction, removeComponentAction                                                   | — none —                                                           | `work_item:edit`     | existing         | R41 |
| `app/(authed)/items/[key]/watcherActions.ts`             | addWatcherAction, removeWatcherAction, toggleWatchAction                                                    | — none —                                                           | `work_item:edit`     | existing         | R41 |
| `app/(authed)/items/actions.ts`                          | createIssueAction, listArchivedWorkItemsAction, listCandidateParentsAction                                  | `assertCanEdit`                                                    | `work_item:edit`     | existing         | R41 |
| `app/(authed)/plans/_actions.ts`                         | loadMorePlansAction                                                                                         | `plansService.*` → `assertPermission` (MOTIR-2363)                 | `ai:view_plan`       | existing         | R5  |
| `app/(authed)/ready/_actions.ts`                         | loadMoreReadyAction                                                                                         | — none —                                                           | `work_item:edit`     | existing         | R41 |
| `app/(authed)/settings/account/data/actions.ts`          | requestDataExportAction                                                                                     | — none —                                                           | —                    | user-scoped      | R31 |
| `app/(authed)/settings/account/git/actions.ts`           | disconnectGitAccountAction                                                                                  | — none —                                                           | —                    | user-scoped      | R31 |
| `app/(authed)/settings/account/profile/actions.ts`       | changePasswordAction, sendSetPasswordLinkAction, updateProfileAvatarAction                                  | — none —                                                           | `work_item:edit`     | existing         | R41 |
| `app/(authed)/settings/organization/security/actions.ts` | setOrganizationRequireTwoFactorAction                                                                       | `twoFactorPolicyService.setOrganizationPolicy` → org-admin         | —                    | workspace-scoped | R56 |
| `app/(authed)/settings/workspace/security/actions.ts`    | setWorkspaceRequireTwoFactorAction                                                                          | `twoFactorPolicyService.setWorkspacePolicy` → `isWorkspaceManager` | —                    | workspace-scoped | R56 |
| `app/(authed)/settings/project/actions.ts`               | changeProjectKeyAction, releaseProjectKeyAction, updateProjectDetailsAction                                 | — none —                                                           | `project:administer` | existing         | R15 |
| `app/(authed)/settings/project/workflow/actions.ts`      | addTransitionAction, createStatusAction, deleteStatusAction                                                 | — none —                                                           | `project:administer` | existing         | R15 |
| `app/(authed)/settings/workspace/actions.ts`             | deleteWorkspaceAction, leaveWorkspaceAction, removeMemberAction                                             | — none —                                                           | `work_item:edit`     | existing         | R41 |
| `app/(authed)/settings/organization/git/actions.ts`      | connectGitlabProjectAction, disconnectGitlabAction, disconnectGitlabProjectAction, listGitlabProjectsAction | — none —                                                           | `work_item:edit`     | existing         | R41 |
| `app/(authed)/settings/workspace/jobs/actions.ts`        | replayDlqAction                                                                                             | — none —                                                           | `work_item:edit`     | existing         | R41 |
| `app/(onboarding)/onboarding/actions.ts`                 | clearPendingIdeaAction, startPlanningAction                                                                 | — none —                                                           | `work_item:edit`     | existing         | R41 |
| `app/(public)/p/[identifier]/overview-actions.ts`        | savePublicOverviewAction                                                                                    | — none —                                                           | `work_item:edit`     | existing         | R41 |
| `lib/i18n/actions.ts`                                    | setLocale                                                                                                   | — none —                                                           | —                    | user-scoped      | R47 |

---

## Handoff to the design (MOTIR-2259)

- **32 permissions** — roughly 3x the eleven the held design was drawn against.
- **16 domains** — 16 group headers plus 32 rows,
  about 48 rows in total against 17 today.
- **Largest domain: `work_item` at 4 rows.** No single group is a wall — the length is in
  the NUMBER of groups, which makes collapsing GROUPS the right density lever, not truncating rows
  inside one.
- **21 of 32 are `planned`** and must never render, so the grid shows
  11 rows the day it ships and grows as MOTIR-2256 wires each one.
