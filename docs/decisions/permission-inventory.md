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
| API routes                                 | **252**                                       |
| `'use server'` action files                | **22**                                        |
| Services in `lib/services`                 | **122**, of which **40** reach a project gate |
| Routes — workspace membership only         | **89**                                        |
| Routes — session only                      | **62**                                        |
| Routes — project-gated                     | **77**                                        |
| Routes — no context resolved               | **32**                                        |
| Routes — serviceAuth / internal (no actor) | **15**                                        |

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

**31 permissions across 16 domains.** **29** are
enforced by a gate today; **2** are `planned` — justified by a row below, and wired by **two**
stories: **MOTIR-2256** takes the twelve ADMINISTRATIVE keys that split out of `project:administer`
(member, board, workflow, field, estimation, repository, `ai:configure`), and **MOTIR-2291** takes the
eight MEMBER-FACING ones (`ai:plan`, `ai:view_plan`, `sprint:manage`, `report:view`,
`saved_filter:manage`, `import:run`, `work_item:triage`, `work_item:delete`) — those are governed by
nothing at all today, so wiring them takes capability away from real actors and is argued on its own.
A `planned` key is never offered in the grid or the role editor.

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
> **`import:run`** (MOTIR-2353) · **`work_item:triage` · `work_item:delete`** (MOTIR-2354). `tests/permissions/catalog.test.ts` keeps its own list — deliberately separate from
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

| Domain               | Permissions                                                                       |
| -------------------- | --------------------------------------------------------------------------------- |
| `ai` (3)             | `ai:configure` · `ai:plan` ᵖ · `ai:view_plan` ᵖ                                   |
| `attachment` (2)     | `attachment:create` · `attachment:delete_any`                                     |
| `board` (1)          | `board:configure`                                                                 |
| `comment` (2)        | `comment:add` · `comment:moderate`                                                |
| `estimation` (1)     | `estimation:manage`                                                               |
| `field` (3)          | `component:manage` · `field:manage` · `label:manage`                              |
| `import` (1)         | `import:run` ᵖ                                                                    |
| `member` (2)         | `member:manage` · `project:manage_access`                                         |
| `project` (2)        | `project:administer` · `project:browse`                                           |
| `public_request` (3) | `public_request:comment` · `public_request:submit` · `public_request:upvote`      |
| `report` (2)         | `report:view` ᵖ · `saved_filter:manage` ᵖ                                         |
| `repository` (2)     | `repository:manage` · `repository:manage_access`                                  |
| `sprint` (1)         | `sprint:manage` ᵖ                                                                 |
| `watcher` (1)        | `watcher:manage`                                                                  |
| `work_item` (4)      | `project:browse` · `work_item:delete` ᵖ · `work_item:edit` · `work_item:triage` ᵖ |
| `workflow` (2)       | `automation:manage` · `workflow:manage`                                           |

ᵖ = `planned` — justified here, not yet enforced.

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

**R6.** Inbound provider webhook, signature-verified. No actor.

**R8.** TEST-SUPPORT route (Next escapes the leading underscore as %5F). It creates work items with no project gate. Must be unreachable in production — verify the build excludes it, else it is an ungated write path. Logged as a finding, not a permission.

**R9.** Board configuration: columns, swimlanes, WIP limits.

**R10.** The workflow statuses a board column projects. Statuses live here, not under /projects.

**R11.** Reads a generated plan and its proposals. Today workspace-only — any workspace member can read any project’s plan.

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

**R34.** DECISION: a dashboard is a WORKSPACE artifact, not a project one — it aggregates widgets across projects, and its own private/shared field governs sharing. The per-widget project reads are gated by report:view. The route already reads "any workspace member".

**R35.** The actor's own API tokens. Their SCOPES are the separate narrowing axis (lib/mcp/scopes.ts).

**R36.** Public-request thread; level-gated by accessLevel=public.

**R37.** Governed by the shipped attachment predicates.

**R38.** Workspace membership lifecycle, governed by the workspace MemberRole.

**R39.** Bulk-creates work items from an external tracker — a destructive-scale write. MOTIR-2353 moved the five PROJECT-SCOPED operations from `work_item:edit` (every project member) to `import:run` (admin only), which is where both mirrors put it: Plane allows imports to workspace admins only "to maintain governance", Linear requires a Linear Admin. The six OAuth legs left this reason for R3 in MOTIR-2346 — they resolve no project.

**R40.** The actor's own notification inbox. Per-user, never per-project.

**R41.** Governed by canEdit.

**R42.** Archive / delete cascades over a subtree — separable from editing a field. Jira grants _Delete Issues_ to the Administrators project role, so a member keeps every edit and loses the cascade.

> ⚠️ **CORRECTED by MOTIR-2354.** `DELETE /api/work-items/[id]` was filed under R41 / `work_item:edit` while its own DRY RUN (`/delete-preview`) was mapped here — and in the code the preview was the tighter of the two (`assertCanManage` vs the delete's `assertCanManage`, against an inventory row claiming `work_item:edit`). A destroy and its preview cannot be governed by different keys; both now ask `work_item:delete`.

**R43.** Acceptance evidence attached to a work item.

**R44.** Governed by the shipped watcher predicate (self-watch needs only browse).

**R45.** Runs BEFORE a project membership can exist; it is what creates the project.

**R46.** Scoped by ?projectId= or ?savedFilterId=, so the data IS project data. Today workspace-only: a member of project A can read project B’s distribution.

**R47.** Sets the signed-in user's own locale / appearance preference. Not a project resource.

**R48.** The PUBLIC, cross-origin PRE-AUTH receiver. The visitor has no account yet — the route says so in its own header (_"NOT session-gated … there is deliberately no `getSession()` call"_) — so there is no actor to authorise and no project to authorise them against. Its abuse surface is answered on a different axis entirely: an origin allowlist, a per-IP fixed-window rate limit, a length cap, and a TTL on the stored draft.

**R49.** The same pre-auth handoff's SAME-ORIGIN half: it consumes a single-use anonymous draft and plants it in the actor's own `motir_pending_idea` cookie at sign-in. It runs BEFORE the session exists, let alone a workspace or a project, and its subject is the one browser holding the opaque id. A forged / expired / already-claimed id is a 404, which is the whole of its access control.

**R50.** A per-user, per-project node ARRANGEMENT of the planning canvas — the actor's own view state inside a project they already have open, not a planning act and not something that spends anything. Governed by `project:browse`: you may arrange the canvas of a project you can see.

---

## The full table

`Gate today` is what the shipped code enforces. `Permission` is what should govern it once
MOTIR-2277 grows the catalog and MOTIR-2256 wires the enforcement.

### `ai`

| Operation                                     | Verbs     | Gate today                                                                     | Permission       | Decision    | Why |
| --------------------------------------------- | --------- | ------------------------------------------------------------------------------ | ---------------- | ----------- | --- |
| `/api/ai/access`                              | GET       | session only                                                                   | `ai:plan`        | new         | R5  |
| `/api/ai/augment`                             | POST      | `aiPlanEditsService.submitAugment` → `assertPermission`                        | `ai:plan`        | existing    | R5  |
| `/api/ai/augment/[jobId]/stream`              | GET       | session only                                                                   | `ai:plan`        | new         | R5  |
| `/api/ai/chat`                                | POST      | `aiChatService.submitDiscoveryTurn` → `assertPermission`                       | `ai:plan`        | existing    | R5  |
| `/api/ai/chat/[jobId]/stream`                 | GET       | session only                                                                   | `ai:plan`        | new         | R5  |
| `/api/ai/coding-convention/audit`             | GET       | `aiConventionService.getAudit` → `assertCanManage`                             | `ai:plan`        | new         | R5  |
| `/api/ai/coding-convention/audit-coverage`    | GET       | `auditCoverageService.getCoverage` → `assertCanManage`                         | `ai:plan`        | new         | R5  |
| `/api/ai/coding-convention/convention`        | GET       | `aiConventionService.getConvention` → `assertCanManage`                        | `ai:plan`        | new         | R5  |
| `/api/ai/coding-convention/refresh`           | POST      | `aiConventionService.reaudit` → `assertCanManage`                              | `ai:plan`        | new         | R5  |
| `/api/ai/expand`                              | POST      | `aiPlanEditsService.submitExpand` → `assertPermission`                         | `ai:plan`        | existing    | R5  |
| `/api/ai/expand/[jobId]/stream`               | GET       | session only                                                                   | `ai:plan`        | new         | R5  |
| `/api/ai/explanation`                         | POST      | `aiExplanationService.submitExplanationDraft` → `assertPermission`             | `ai:plan`        | existing    | R5  |
| `/api/ai/explanation/[jobId]/stream`          | GET       | session only                                                                   | `ai:plan`        | new         | R5  |
| `/api/ai/jobs/[jobId]`                        | GET       | session only                                                                   | `ai:plan`        | new         | R5  |
| `/api/ai/plan-change/session`                 | POST      | `planChangeSessionsService.getOrCreateForProject` → `assertPermission`         | `ai:plan`        | existing    | R5  |
| `/api/ai/plan-change/session/planner-turn`    | POST      | `planChangeSessionsService.recordPlannerTurn` → `assertPermission`             | `ai:plan`        | existing    | R5  |
| `/api/ai/plan-change/session/submit`          | POST      | `planChangeSessionsService.submit` → `assertPermission`                        | `ai:plan`        | existing    | R5  |
| `/api/ai/plan-change/session/turns`           | POST      | `planChangeSessionsService.appendTurn` → `assertPermission`                    | `ai:plan`        | existing    | R5  |
| `/api/ai/plan/generate`                       | POST      | session only                                                                   | `ai:plan`        | new         | R5  |
| `/api/ai/plan/generate/[jobId]/stream`        | GET       | session only                                                                   | `ai:plan`        | new         | R5  |
| `/api/ai/plan/sprint`                         | POST      | session only                                                                   | `ai:plan`        | new         | R5  |
| `/api/ai/plan/sprint/[jobId]/review`          | GET       | session only                                                                   | `ai:plan`        | new         | R5  |
| `/api/ai/plan/sprint/[jobId]/stream`          | GET       | session only                                                                   | `ai:plan`        | new         | R5  |
| `/api/ai/plan/sprint/approve`                 | POST      | session only                                                                   | `ai:plan`        | new         | R5  |
| `/api/ai/pre-plan`                            | GET/PATCH | session only                                                                   | `ai:plan`        | new         | R5  |
| `/api/ai/replan`                              | POST      | `aiPlanEditsService.submitReplan` → `assertPermission`                         | `ai:plan`        | existing    | R5  |
| `/api/ai/replan/[jobId]/stream`               | GET       | session only                                                                   | `ai:plan`        | new         | R5  |
| `/api/canvas-layout`                          | GET/PATCH | `canvasLayoutService.{getLayout,savePositions}` → `assertPermission`           | `project:browse` | existing    | R50 |
| `/api/idea-draft`                             | POST      | — none — origin-allowlisted + per-IP rate-limited, pre-auth                    | —                | no-gate     | R48 |
| `/api/idea-draft/[id]/claim`                  | POST      | — none — consumes a single-use draft id at sign-in                             | —                | user-scoped | R49 |
| `/api/plans/[id]`                             | GET       | `planReviewService.getPlanReview` (transitive)                                 | `ai:view_plan`   | new         | R11 |
| `/api/plans/[id]/approve`                     | POST      | workspace only                                                                 | `ai:view_plan`   | new         | R11 |
| `/api/plans/[id]/decline`                     | POST      | `assertCanEdit`                                                                | `ai:view_plan`   | new         | R11 |
| `/api/plans/[id]/items/[itemId]`              | PATCH     | workspace only                                                                 | `ai:view_plan`   | new         | R11 |
| `/api/projects/[key]/ai-settings`             | GET       | `assertCanBrowse`                                                              | `project:browse` | existing    | R17 |
| `/api/projects/[key]/ai-settings`             | PATCH     | `assertPermission(ai:configure)`                                               | `ai:configure`   | existing    | R17 |
| `/api/work-items/[id]/ai/plan`                | GET/POST  | `contextualPlanningService` → `planChangeSessionsService` → `assertPermission` | `ai:plan`        | existing    | R5  |
| `/api/work-items/[id]/ai/plan/[jobId]/stream` | GET       | `contextualPlanningService.streamPlanJob` (transitive)                         | `ai:plan`        | new         | R5  |

### `api`

| Operation                                                | Verbs | Gate today                                   | Permission | Decision     | Why |
| -------------------------------------------------------- | ----- | -------------------------------------------- | ---------- | ------------ | --- |
| `/api/v1/me`                                             | —     | — none —                                     | —          | token-scoped | R1  |
| `/api/v1/plans/[planId]`                                 | —     | `assertCanBrowse`                            | —          | token-scoped | R1  |
| `/api/v1/plans/[planId]/status`                          | —     | `aiPlanEditsService.getOutcome` (transitive) | —          | token-scoped | R1  |
| `/api/v1/projects`                                       | —     | — none —                                     | —          | token-scoped | R1  |
| `/api/v1/projects/[projectKey]`                          | —     | `assertCanBrowse`                            | —          | token-scoped | R1  |
| `/api/v1/projects/[projectKey]/backlog`                  | —     | — none —                                     | —          | token-scoped | R1  |
| `/api/v1/projects/[projectKey]/backlog/work-items`       | —     | — none —                                     | —          | token-scoped | R1  |
| `/api/v1/projects/[projectKey]/plan-session`             | —     | `assertCanEdit`                              | —          | token-scoped | R1  |
| `/api/v1/projects/[projectKey]/plan-session/submissions` | —     | — none —                                     | —          | token-scoped | R1  |
| `/api/v1/projects/[projectKey]/plan-session/turns`       | —     | `assertCanEdit`                              | —          | token-scoped | R1  |
| `/api/v1/projects/[projectKey]/ready`                    | —     | — none —                                     | —          | token-scoped | R1  |
| `/api/v1/projects/[projectKey]/sprints`                  | —     | — none —                                     | —          | token-scoped | R1  |
| `/api/v1/projects/[projectKey]/work-items`               | —     | `assertCanBrowse`, `assertCanEdit`           | —          | token-scoped | R1  |
| `/api/v1/sessions/complete`                              | —     | — none —                                     | —          | token-scoped | R1  |
| `/api/v1/sprints/[sprintId]`                             | —     | — none —                                     | —          | token-scoped | R1  |
| `/api/v1/sprints/[sprintId]/complete`                    | —     | — none —                                     | —          | token-scoped | R1  |
| `/api/v1/sprints/[sprintId]/start`                       | —     | — none —                                     | —          | token-scoped | R1  |
| `/api/v1/sprints/[sprintId]/work-items`                  | —     | — none —                                     | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]`                               | —     | `assertCanBrowse`                            | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/activity`                      | —     | `assertCanBrowse`                            | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/archive`                       | —     | `assertCanBrowse`, `assertCanEdit`           | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/comments`                      | —     | `assertCanBrowse`                            | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/dispatch-prompt`               | —     | — none —                                     | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/expansions`                    | —     | `assertCanBrowse`                            | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/integration`                   | —     | `assertCanBrowse`                            | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/links`                         | —     | `assertCanBrowse`, `assertCanEdit`           | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/restore`                       | —     | `assertCanBrowse`, `assertCanEdit`           | —          | token-scoped | R1  |
| `/api/v1/work-items/[key]/transitions`                   | —     | `assertCanBrowse`                            | —          | token-scoped | R1  |
| `/api/v1/workspaces`                                     | —     | — none —                                     | —          | token-scoped | R1  |

### `attachment`

| Operation                          | Verbs    | Gate today     | Permission          | Decision | Why |
| ---------------------------------- | -------- | -------------- | ------------------- | -------- | --- |
| `/api/attachments/[id]`            | DELETE   | workspace only | `attachment:create` | existing | R37 |
| `/api/attachments/[id]/content`    | GET      | workspace only | `attachment:create` | existing | R37 |
| `/api/upload/avatar`               | POST     | session only   | `attachment:create` | existing | R37 |
| `/api/upload/issue-attachment`     | POST     | session only   | `attachment:create` | existing | R37 |
| `/api/work-items/[id]/attachments` | GET/POST | workspace only | `attachment:create` | existing | R37 |

### `board`

| Operation                       | Verbs        | Gate today                                      | Permission        | Decision | Why |
| ------------------------------- | ------------ | ----------------------------------------------- | ----------------- | -------- | --- |
| `/api/board`                    | GET          | `assertCanBrowse` (`boardsService.getBoard`)    | `project:browse`  | existing | R9  |
| `/api/board`                    | PATCH        | `assertBoardConfigAdmin` — workspace OWNER only | `board:configure` | new      | R9  |
| `/api/board/columns`            | POST         | `assertBoardConfigAdmin` — workspace OWNER only | `board:configure` | new      | R9  |
| `/api/board/columns/[columnId]` | DELETE/PATCH | `assertBoardConfigAdmin` — workspace OWNER only | `board:configure` | new      | R9  |
| `/api/board/move`               | POST         | `assertCanEdit`                                 | `work_item:edit`  | existing | R9  |
| `/api/boards`                   | GET          | none (`listBoards` has no gate)                 | `project:browse`  | new      | R9  |
| `/api/boards`                   | POST         | `assertBoardConfigAdmin` — workspace OWNER only | `board:configure` | new      | R9  |
| `/api/boards/[id]`              | DELETE/PATCH | `assertBoardConfigAdmin` — workspace OWNER only | `board:configure` | new      | R9  |

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

| Operation                                    | Verbs                 | Gate today                                    | Permission | Decision | Why |
| -------------------------------------------- | --------------------- | --------------------------------------------- | ---------- | -------- | --- |
| `/api/%5Ftest/work-item-links`               | DELETE/GET/POST       | `assertCanBrowse`, `assertCanEdit`            | —          | finding  | R8  |
| `/api/%5Ftest/work-items`                    | DELETE/GET/PATCH/POST | `assertCanBrowse`, `assertCanEdit`            | —          | finding  | R8  |
| `/api/auth/[...all]`                         | —                     | — none —                                      | —          | no-gate  | R12 |
| `/api/github/webhook`                        | POST                  | — none —                                      | —          | no-gate  | R6  |
| `/api/gitlab/webhook`                        | POST                  | — none —                                      | —          | no-gate  | R6  |
| `/api/inngest`                               | —                     | — none —                                      | —          | no-gate  | R13 |
| `/api/internal/ai/code-scanning/analyses`    | GET                   | serviceAuth                                   | —          | no-gate  | R29 |
| `/api/internal/ai/code-scanning/sarif`       | GET                   | serviceAuth                                   | —          | no-gate  | R29 |
| `/api/internal/ai/dev/noop`                  | GET/POST              | serviceAuth                                   | —          | no-gate  | R29 |
| `/api/internal/ai/get-item`                  | GET                   | serviceAuth                                   | —          | no-gate  | R29 |
| `/api/internal/ai/get-subtree`               | GET                   | `aiBoundaryService.getSubtree` (transitive)   | —          | no-gate  | R29 |
| `/api/internal/ai/live-projects`             | POST                  | serviceAuth                                   | —          | no-gate  | R29 |
| `/api/internal/ai/org-context`               | GET                   | serviceAuth                                   | —          | no-gate  | R29 |
| `/api/internal/ai/plan-proposals`            | POST                  | serviceAuth                                   | —          | no-gate  | R29 |
| `/api/internal/ai/plan-proposals/[itemId]`   | PATCH                 | serviceAuth                                   | —          | no-gate  | R29 |
| `/api/internal/ai/plan-tree`                 | GET                   | `aiBoundaryService.readPlanTree` (transitive) | —          | no-gate  | R29 |
| `/api/internal/ai/search-work-items`         | POST                  | serviceAuth                                   | —          | no-gate  | R29 |
| `/api/internal/ai/skeleton`                  | GET                   | `aiBoundaryService.readPlanTree` (transitive) | —          | no-gate  | R29 |
| `/api/internal/ai/validate-plan`             | POST                  | serviceAuth                                   | —          | no-gate  | R29 |
| `/api/internal/ai/validate-plan-forest`      | POST                  | serviceAuth                                   | —          | no-gate  | R29 |
| `/api/internal/ai/validate-plan-sprint`      | POST                  | serviceAuth                                   | —          | no-gate  | R29 |
| `/api/internal/ai/walk-blocking`             | GET                   | serviceAuth                                   | —          | no-gate  | R29 |
| `/api/internal/ai/work-items`                | POST                  | `aiWorkItemsService.fileBug` (transitive)     | —          | no-gate  | R29 |
| `/api/internal/billing/ai-included-seat`     | POST                  | serviceAuth                                   | —          | no-gate  | R29 |
| `/api/internal/billing/scaled-tracker-state` | POST                  | serviceAuth                                   | —          | no-gate  | R29 |
| `/api/openapi/v1.json`                       | GET                   | — none —                                      | —          | no-gate  | R32 |

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

| Operation                              | Verbs        | Gate today                                                          | Permission              | Decision | Why |
| -------------------------------------- | ------------ | ------------------------------------------------------------------- | ----------------------- | -------- | --- |
| `/api/projects/[key]/access`           | PATCH        | `projectMembersService.setAccessLevel` → `assertPermission`         | `project:manage_access` | existing | R18 |
| `/api/projects/[key]/members`          | GET          | `projectMembersService.listMembers` → `assertPermission`            | `project:browse`        | existing | R27 |
| `/api/projects/[key]/members`          | POST         | `projectMembersService.addMember` → `assertPermission`              | `member:manage`         | existing | R27 |
| `/api/projects/[key]/members/[userId]` | DELETE/PATCH | `projectMembersService.{removeMember,setRole}` → `assertPermission` | `member:manage`         | existing | R27 |

### `project`

| Operation                             | Verbs  | Gate today     | Permission           | Decision | Why |
| ------------------------------------- | ------ | -------------- | -------------------- | -------- | --- |
| `/api/projects/[key]`                 | PATCH  | workspace only | `project:administer` | existing | R15 |
| `/api/projects/[key]/aliases/[alias]` | DELETE | workspace only | `project:administer` | existing | R15 |

### `public_request`

| Operation                                              | Verbs | Gate today                | Permission               | Decision | Why |
| ------------------------------------------------------ | ----- | ------------------------- | ------------------------ | -------- | --- |
| `/api/public-requests/[id]/comments`                   | POST  | workspace only            | `public_request:comment` | existing | R36 |
| `/api/public-requests/[id]/upvote`                     | POST  | workspace only            | `public_request:comment` | existing | R36 |
| `/api/public/categories`                               | GET   | session only              | `public_request:submit`  | existing | R33 |
| `/api/public/explore`                                  | GET   | session only              | `public_request:submit`  | existing | R33 |
| `/api/public/p/[identifier]/items`                     | GET   | `assertCanBrowsePublic`   | `public_request:submit`  | existing | R33 |
| `/api/public/p/[identifier]/roadmap`                   | GET   | session only              | `public_request:submit`  | existing | R33 |
| `/api/public/p/[identifier]/tree`                      | GET   | session only              | `public_request:submit`  | existing | R33 |
| `/api/public/projects/[projectId]/requests`            | POST  | session only              | `public_request:submit`  | existing | R33 |
| `/api/public/projects/[projectId]/requests/duplicates` | GET   | `assertCanSubmitToTriage` | `public_request:submit`  | existing | R33 |

### `report`

| Operation                                                   | Verbs            | Gate today                                                                     | Permission            | Decision         | Why |
| ----------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------ | --------------------- | ---------------- | --- |
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
| `/api/projects/[key]/velocity`                              | GET              | `reportsService.getVelocity` → `assertPermission`                              | `report:view`         | existing         | R19 |
| `/api/reports/average-age`                                  | GET              | `reportsService.*` → `resolveReportScope` → `assertPermission`                 | `report:view`         | existing         | R46 |
| `/api/reports/created-vs-resolved`                          | GET              | `reportsService.*` → `resolveReportScope` → `assertPermission`                 | `report:view`         | existing         | R46 |
| `/api/reports/distribution`                                 | GET              | `reportsService.*` → `resolveReportScope` → `assertPermission`                 | `report:view`         | existing         | R46 |
| `/api/reports/filter-results`                               | GET              | `reportsService.*` → `resolveReportScope` → `assertPermission`                 | `report:view`         | existing         | R46 |
| `/api/reports/resolution-time`                              | GET              | `reportsService.*` → `resolveReportScope` → `assertPermission`                 | `report:view`         | existing         | R46 |
| `/api/reports/workload`                                     | GET              | `reportsService.*` → `resolveReportScope` → `assertPermission`                 | `report:view`         | existing         | R46 |

### `repository`

| Operation                                           | Verbs        | Gate today                                                                                                                  | Permission                 | Decision         | Why |
| --------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------- | --- |
| `/api/github/oauth/callback`                        | GET          | session only — binds the installation to a WORKSPACE; redirects to `/settings/workspace/github`                             | —                          | workspace-scoped | R3  |
| `/api/github/oauth/start`                           | GET          | session only — no project; redirects to `/settings/workspace/github`                                                        | —                          | workspace-scoped | R3  |
| `/api/github/organizations`                         | GET          | workspace only — `getWorkspaceContext()`; no project resolved                                                               | —                          | workspace-scoped | R3  |
| `/api/github/setup`                                 | GET          | session only — binds the installation to a WORKSPACE                                                                        | —                          | workspace-scoped | R3  |
| `/api/gitlab/oauth/callback`                        | GET          | session only — no project resolved                                                                                          | —                          | workspace-scoped | R3  |
| `/api/gitlab/oauth/start`                           | GET          | workspace only — the file header: "WORKSPACE-scoped, so we resolve the acting member’s active workspace"                    | —                          | workspace-scoped | R3  |
| `/api/projects/[key]/repositories`                  | GET          | `assertCanBrowse` (`inProject('browse')`)                                                                                   | `project:browse`           | existing         | R21 |
| `/api/projects/[key]/repositories`                  | POST         | `assertPermission(repository:manage)` — was `assertCanEdit`, i.e. any project MEMBER                                        | `repository:manage`        | existing         | R21 |
| `/api/projects/[key]/repositories/[rowId]`          | DELETE/PATCH | `assertPermission(repository:manage)` — was `assertCanEdit`                                                                 | `repository:manage`        | existing         | R21 |
| `/api/projects/[key]/repositories/[rowId]/move`     | POST         | `assertPermission(repository:manage)` (`inLockedRow`)                                                                       | `repository:manage`        | existing         | R21 |
| `/api/projects/[key]/repositories/[rowId]/state`    | POST         | `assertPermission(repository:manage)` — ACTOR-initiated: the route resolves `getWorkspaceContext()`, not serviceAuth        | `repository:manage`        | existing         | R21 |
| `/api/projects/[key]/repositories/[rowId]/takeover` | POST         | `assertPermission(repository:manage)` (takeover `inLockedRow`)                                                              | `repository:manage`        | existing         | R21 |
| `/api/projects/[key]/repositories/access`           | GET/POST     | browse, via `listByProject` — the SELF-connect path (`grantAccess` invites the actor's OWN identity). Stays open: ADR §3 Q3 | `project:browse`           | existing         | R22 |
| `/api/projects/[key]/repositories/access/team`      | GET          | browse, via `listTeamAccess` → `listByProject` — reads the matrix                                                           | `project:browse`           | existing         | R22 |
| `/api/projects/[key]/repositories/access/team`      | POST         | `assertPermission(repository:manage_access)` — was `assertCanEdit`; granting ANOTHER member's clone access                  | `repository:manage_access` | existing         | R22 |
| `/api/projects/[key]/repositories/establish`        | POST         | `assertPermission(repository:manage)` (via the set service's helpers)                                                       | `repository:manage`        | existing         | R21 |

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

| Operation                           | Verbs     | Gate today     | Permission | Decision    | Why |
| ----------------------------------- | --------- | -------------- | ---------- | ----------- | --- |
| `/api/account/confirm-email-change` | GET       | — none —       | —          | user-scoped | R31 |
| `/api/account/request-email-change` | POST      | workspace only | —          | user-scoped | R31 |
| `/api/appearance-preference`        | GET/PATCH | workspace only | —          | user-scoped | R31 |
| `/api/notification-preferences`     | GET/PUT   | workspace only | —          | user-scoped | R31 |
| `/api/notifications`                | GET       | workspace only | —          | user-scoped | R40 |
| `/api/notifications/[id]/read`      | PATCH     | workspace only | —          | user-scoped | R40 |
| `/api/notifications/mark-all-read`  | POST      | workspace only | —          | user-scoped | R40 |
| `/api/notifications/unread-count`   | GET       | workspace only | —          | user-scoped | R40 |

### `watcher`

| Operation                                | Verbs      | Gate today     | Permission       | Decision | Why |
| ---------------------------------------- | ---------- | -------------- | ---------------- | -------- | --- |
| `/api/work-items/[id]/watch`             | DELETE/PUT | workspace only | `watcher:manage` | existing | R44 |
| `/api/work-items/[id]/watchers`          | GET/POST   | workspace only | `watcher:manage` | existing | R44 |
| `/api/work-items/[id]/watchers/[userId]` | DELETE     | workspace only | `watcher:manage` | existing | R44 |

### `work_item`

| Operation                                               | Verbs       | Gate today                                                          | Permission              | Decision | Why |
| ------------------------------------------------------- | ----------- | ------------------------------------------------------------------- | ----------------------- | -------- | --- |
| `/api/projects/[key]/triage/queue`                      | GET         | `triageService.getTriageQueueByKey` → `assertPermission`            | `work_item:triage`      | existing | R23 |
| `/api/projects/[key]/triage/submissions`                | POST        | `triageService.createSubmission` → `assertCanBrowse`                | `public_request:submit` | existing | R23 |
| `/api/ready`                                            | GET         | workspace only                                                      | `project:browse`        | existing | R2  |
| `/api/ready/next`                                       | POST        | workspace only                                                      | `project:browse`        | existing | R2  |
| `/api/ready/nudge`                                      | GET         | session only                                                        | `project:browse`        | existing | R2  |
| `/api/work-items/[id]`                                  | DELETE      | `workItemsService.deleteWorkItem` → `assertPermission`              | `work_item:delete`      | existing | R42 |
| `/api/work-items/[id]/acceptance-evidence`              | POST        | — none —                                                            | `work_item:edit`        | existing | R43 |
| `/api/work-items/[id]/acceptance-evidence/upload-token` | POST        | — none —                                                            | `work_item:edit`        | existing | R43 |
| `/api/work-items/[id]/activity/all`                     | GET         | workspace only                                                      | `project:browse`        | existing | R2  |
| `/api/work-items/[id]/activity/history`                 | GET         | workspace only                                                      | `project:browse`        | existing | R2  |
| `/api/work-items/[id]/archive`                          | DELETE/POST | `workItemsService.{archive,unarchive}WorkItem` → `assertPermission` | `work_item:delete`      | existing | R42 |
| `/api/work-items/[id]/components`                       | POST/PUT    | workspace only                                                      | `work_item:edit`        | existing | R41 |
| `/api/work-items/[id]/components/[componentId]`         | DELETE      | workspace only                                                      | `work_item:edit`        | existing | R41 |
| `/api/work-items/[id]/delete-preview`                   | GET         | `workItemsService.getDeletePreview` → `assertPermission`            | `work_item:delete`      | existing | R42 |
| `/api/work-items/[id]/epic-privacy`                     | PATCH       | `assertCanManageProject`                                            | `work_item:edit`        | existing | R41 |
| `/api/work-items/[id]/estimate`                         | PATCH       | workspace only                                                      | `work_item:edit`        | existing | R41 |
| `/api/work-items/[id]/labels`                           | POST/PUT    | workspace only                                                      | `work_item:edit`        | existing | R41 |
| `/api/work-items/[id]/labels/[labelId]`                 | DELETE      | workspace only                                                      | `work_item:edit`        | existing | R41 |
| `/api/work-items/[id]/rollup`                           | GET         | workspace only                                                      | `project:browse`        | existing | R2  |
| `/api/work-items/[id]/triage/accept`                    | POST        | `triageService.*` → `assertPermission`                              | `work_item:triage`      | existing | R23 |
| `/api/work-items/[id]/triage/decline`                   | POST        | `triageService.*` → `assertPermission`                              | `work_item:triage`      | existing | R23 |
| `/api/work-items/[id]/triage/detail`                    | GET         | `triageService.getTriageItemDetail` → `assertPermission`            | `work_item:triage`      | existing | R23 |
| `/api/work-items/[id]/triage/duplicate`                 | POST        | `triageService.*` → `assertPermission`                              | `work_item:triage`      | existing | R23 |
| `/api/work-items/[id]/triage/promote`                   | POST        | `triageService.*` → `assertPermission`                              | `work_item:triage`      | existing | R23 |
| `/api/work-items/[id]/triage/snooze`                    | DELETE/POST | `triageService.*` → `assertPermission`                              | `work_item:triage`      | existing | R23 |
| `/api/work-items/mention-search`                        | GET         | workspace only                                                      | `project:browse`        | existing | R2  |
| `/api/work-items/peek`                                  | GET         | `assertCanBrowse`, `getCapabilities`                                | `project:browse`        | existing | R2  |

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

| Operation                                     | Verbs        | Gate today        | Permission | Decision         | Why |
| --------------------------------------------- | ------------ | ----------------- | ---------- | ---------------- | --- |
| `/api/invites/[token]`                        | GET          | — none —          | —          | workspace-scoped | R38 |
| `/api/invites/[token]/accept`                 | POST         | session only      | —          | workspace-scoped | R38 |
| `/api/onboarding/migrate`                     | POST         | session only      | —          | workspace-scoped | R45 |
| `/api/onboarding/migrate/[id]`                | GET          | `assertCanBrowse` | —          | workspace-scoped | R45 |
| `/api/onboarding/migrate/[id]/advance`        | POST         | workspace only    | —          | workspace-scoped | R45 |
| `/api/onboarding/migrate/[id]/index-status`   | GET          | `assertCanBrowse` | —          | workspace-scoped | R45 |
| `/api/onboarding/migrate/[id]/skip-import`    | POST         | `assertCanEdit`   | —          | workspace-scoped | R45 |
| `/api/organizations/[orgId]`                  | PATCH        | session only      | —          | workspace-scoped | R3  |
| `/api/organizations/[orgId]/billing`          | GET          | session only      | —          | workspace-scoped | R3  |
| `/api/organizations/[orgId]/billing/checkout` | POST         | session only      | —          | workspace-scoped | R3  |
| `/api/organizations/[orgId]/billing/portal`   | POST         | session only      | —          | workspace-scoped | R3  |
| `/api/organizations/[orgId]/members`          | GET/POST     | session only      | —          | workspace-scoped | R3  |
| `/api/organizations/[orgId]/members/[userId]` | DELETE/PATCH | session only      | —          | workspace-scoped | R3  |
| `/api/organizations/[orgId]/usage`            | GET          | session only      | —          | workspace-scoped | R3  |
| `/api/workspaces/[workspaceId]/invites`       | POST         | session only      | —          | workspace-scoped | R3  |
| `/api/workspaces/current`                     | GET          | session only      | —          | workspace-scoped | R3  |

### `'use server'` actions

| File                                                | Exported actions                                                                  | Gate today                         | Permission           | Decision    | Why |
| --------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------- | -------------------- | ----------- | --- |
| `app/(authed)/_actions.ts`                          | createOrganizationAction, createWorkspaceAction, switchOrganizationAction         | — none —                           | `work_item:edit`     | existing    | R41 |
| `app/(authed)/_project-actions.ts`                  | archiveProjectAction, createProjectAction, setActiveProjectAction                 | — none —                           | `project:administer` | existing    | R15 |
| `app/(authed)/items/[key]/acceptanceActions.ts`     | decideAcceptanceAction, turnOnAcceptanceVideoAction                               | — none —                           | `work_item:edit`     | existing    | R41 |
| `app/(authed)/items/[key]/actions.ts`               | createLinkAction, linkPullRequestAction, listLinkCandidatesAction                 | `assertCanBrowse`, `assertCanEdit` | `work_item:edit`     | existing    | R41 |
| `app/(authed)/items/[key]/commentActions.ts`        | addCommentAction, deleteCommentAction, editCommentAction                          | — none —                           | `comment:add`        | existing    | R4  |
| `app/(authed)/items/[key]/customFieldActions.ts`    | setCustomFieldValueAction                                                         | `assertCanEdit`                    | `work_item:edit`     | existing    | R41 |
| `app/(authed)/items/[key]/edit/actions.ts`          | changeStatusAction, updateIssueAction                                             | `assertCanBrowse`                  | `work_item:edit`     | existing    | R41 |
| `app/(authed)/items/[key]/labelComponentActions.ts` | addComponentAction, addLabelAction, removeComponentAction                         | — none —                           | `work_item:edit`     | existing    | R41 |
| `app/(authed)/items/[key]/watcherActions.ts`        | addWatcherAction, removeWatcherAction, toggleWatchAction                          | — none —                           | `work_item:edit`     | existing    | R41 |
| `app/(authed)/items/actions.ts`                     | createIssueAction, listArchivedWorkItemsAction, listCandidateParentsAction        | `assertCanEdit`                    | `work_item:edit`     | existing    | R41 |
| `app/(authed)/plans/_actions.ts`                    | loadMorePlansAction                                                               | `getCapabilities`                  | `ai:plan`            | new         | R5  |
| `app/(authed)/ready/_actions.ts`                    | loadMoreReadyAction                                                               | — none —                           | `work_item:edit`     | existing    | R41 |
| `app/(authed)/settings/account/profile/actions.ts`  | changePasswordAction, sendSetPasswordLinkAction, updateProfileAvatarAction        | — none —                           | `work_item:edit`     | existing    | R41 |
| `app/(authed)/settings/project/actions.ts`          | changeProjectKeyAction, releaseProjectKeyAction, updateProjectDetailsAction       | — none —                           | `project:administer` | existing    | R15 |
| `app/(authed)/settings/project/workflow/actions.ts` | addTransitionAction, createStatusAction, deleteStatusAction                       | — none —                           | `project:administer` | existing    | R15 |
| `app/(authed)/settings/workspace/actions.ts`        | deleteWorkspaceAction, leaveWorkspaceAction, removeMemberAction                   | — none —                           | `work_item:edit`     | existing    | R41 |
| `app/(authed)/settings/workspace/github/actions.ts` | disconnectGithubAction                                                            | — none —                           | `work_item:edit`     | existing    | R41 |
| `app/(authed)/settings/workspace/gitlab/actions.ts` | connectGitlabProjectAction, disconnectGitlabAction, disconnectGitlabProjectAction | — none —                           | `work_item:edit`     | existing    | R41 |
| `app/(authed)/settings/workspace/jobs/actions.ts`   | replayDlqAction                                                                   | — none —                           | `work_item:edit`     | existing    | R41 |
| `app/(onboarding)/onboarding/actions.ts`            | clearPendingIdeaAction, startPlanningAction                                       | — none —                           | `work_item:edit`     | existing    | R41 |
| `app/(public)/p/[identifier]/overview-actions.ts`   | savePublicOverviewAction                                                          | — none —                           | `work_item:edit`     | existing    | R41 |
| `lib/i18n/actions.ts`                               | setLocale                                                                         | — none —                           | —                    | user-scoped | R47 |

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
