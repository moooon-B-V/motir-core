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
| Routes — session only                      | **63**                                        |
| Routes — project-gated                     | **76**                                        |
| Routes — no context resolved               | **32**                                        |
| Routes — serviceAuth / internal (no actor) | **15**                                        |

> **Two of these numbers were re-measured on 2026-08-06 (MOTIR-2292).** `/api/ai/coding-convention/audit-coverage`
> shipped after this document was written, so the route total is **252**, not 251. And the project-gated
> count was **52** because the walk in `tests/permissions/noUngovernedOperation.test.ts` mistook a
> parameter's inline object type (`opts: { repoKeys?: string[] } = {}`) for a method body and could not
> see the `assertCan*` on the next line — 24 gated routes read as ungoverned. The real figure is **76**.
> Nothing was gated to achieve that: the instrument was wrong, not the product.

## The resulting catalog

**31 permissions across 16 domains.** **17** are
enforced by a gate today; **14** are `planned` — justified by a row below, and wired by **two**
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
> **`repository:manage` · `repository:manage_access`** (MOTIR-2299) · **`board:configure`** (MOTIR-2296).

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

| Domain               | Permissions                                                                       |
| -------------------- | --------------------------------------------------------------------------------- |
| `ai` (3)             | `ai:configure` · `ai:plan` ᵖ · `ai:view_plan` ᵖ                                   |
| `attachment` (2)     | `attachment:create` · `attachment:delete_any`                                     |
| `board` (1)          | `board:configure`                                                                 |
| `comment` (2)        | `comment:add` · `comment:moderate`                                                |
| `estimation` (1)     | `estimation:manage` ᵖ                                                             |
| `field` (3)          | `component:manage` ᵖ · `field:manage` ᵖ · `label:manage` ᵖ                        |
| `import` (1)         | `import:run` ᵖ                                                                    |
| `member` (2)         | `member:manage` · `project:manage_access`                                         |
| `project` (2)        | `project:administer` · `project:browse`                                           |
| `public_request` (3) | `public_request:comment` · `public_request:submit` · `public_request:upvote`      |
| `report` (2)         | `report:view` ᵖ · `saved_filter:manage` ᵖ                                         |
| `repository` (2)     | `repository:manage` · `repository:manage_access`                                  |
| `sprint` (1)         | `sprint:manage` ᵖ                                                                 |
| `watcher` (1)        | `watcher:manage`                                                                  |
| `work_item` (4)      | `project:browse` · `work_item:delete` ᵖ · `work_item:edit` · `work_item:triage` ᵖ |
| `workflow` (2)       | `automation:manage` ᵖ · `workflow:manage` ᵖ                                       |

ᵖ = `planned` — justified here, not yet enforced.

## GATE TODAY, MEASURED (MOTIR-2304)

**⚠️ `project:administer` is NOT the tightest administrative gate in the product.** Three domains are
gated to the workspace **OWNER** — a strictly narrower actor set than the umbrella this story is
splitting. So MOTIR-2256's split is not one movement: it TIGHTENS some domains, LOOSENS others, and
leaves the rest exactly where they were. The per-domain card is where each is argued, and a card that
claims neutrality for a row in the LOOSENS column is wrong.

| Domain       | The gate that actually runs                                    | Admits today                              | The split |
| ------------ | -------------------------------------------------------------- | ----------------------------------------- | --------- |
| `board`      | `assertPermission(board:configure)` (wired, MOTIR-2296)        | was workspace OWNER only                  | LOOSENED  |
| `workflow`   | `workflowsService.assertProjectAdmin` → `isOwnerRole(...)`     | workspace OWNER                           | LOOSENS   |
| `estimation` | `estimationService.assertEstimationAdmin` → `isOwnerRole(...)` | workspace OWNER                           | LOOSENS   |
| `automation` | `projectAccessService.assertCanManage`                         | `project:administer`                      | neutral   |
| `component`  | `componentsService`'s module-private `assertCanManage`         | `project:administer`-equivalent           | neutral   |
| `field`      | `customFieldsService`'s module-private `assertCanManage`       | `project:administer`-equivalent           | neutral   |
| `label`      | `projectAccessService.assertCanManage`                         | `project:administer`                      | neutral   |
| `ai`         | `projectAccessService.assertCanManage`                         | `project:administer`                      | neutral   |
| `member`     | `projectAccessService.assertPermission` (wired, MOTIR-2295)    | `member:manage` / `project:manage_access` | wired     |
| `repository` | `projectAccessService.assertCanEdit`                           | project MEMBER                            | TIGHTENS  |

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

**R16.** Project-scoped saved queries; savedFilterCapabilities already derives from canBrowse/canEdit but has no key of its own.

**R17.** AI cadence + planner model settings. Splits out of project:administer.

**R18.** Sets the project access level (public/open/limited/private).

**R19.** Project-scoped analytics read, same class as /api/reports.

**R20.** Label / tag vocabulary.

**R21.** Connect / disconnect / move / take over the project’s repository set. Splits out of project:administer.

**R22.** Who on the team may clone the code. Its own key: a lead may grant code access without administering the project.

**R23.** Triage queue: accept / decline / promote an inbound request.

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

**R39.** Bulk-creates work items from an external tracker — a destructive-scale write gated today only by workspace membership.

**R40.** The actor's own notification inbox. Per-user, never per-project.

**R41.** Governed by canEdit.

**R42.** Archive / delete cascades over a subtree — separable from editing a field.

**R43.** Acceptance evidence attached to a work item.

**R44.** Governed by the shipped watcher predicate (self-watch needs only browse).

**R45.** Runs BEFORE a project membership can exist; it is what creates the project.

**R46.** Scoped by ?projectId= or ?savedFilterId=, so the data IS project data. Today workspace-only: a member of project A can read project B’s distribution.

**R47.** Sets the signed-in user's own locale / appearance preference. Not a project resource.

---

## The full table

`Gate today` is what the shipped code enforces. `Permission` is what should govern it once
MOTIR-2277 grows the catalog and MOTIR-2256 wires the enforcement.

### `ai`

| Operation                                     | Verbs     | Gate today                                                     | Permission       | Decision | Why |
| --------------------------------------------- | --------- | -------------------------------------------------------------- | ---------------- | -------- | --- |
| `/api/ai/access`                              | GET       | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/augment`                             | POST      | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/augment/[jobId]/stream`              | GET       | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/chat`                                | POST      | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/chat/[jobId]/stream`                 | GET       | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/coding-convention/audit`             | GET       | `aiConventionService.getAudit` → `assertCanManage`             | `ai:plan`        | new      | R5  |
| `/api/ai/coding-convention/audit-coverage`    | GET       | `auditCoverageService.getCoverage` → `assertCanManage`         | `ai:plan`        | new      | R5  |
| `/api/ai/coding-convention/convention`        | GET       | `aiConventionService.getConvention` → `assertCanManage`        | `ai:plan`        | new      | R5  |
| `/api/ai/coding-convention/refresh`           | POST      | `aiConventionService.reaudit` → `assertCanManage`              | `ai:plan`        | new      | R5  |
| `/api/ai/expand`                              | POST      | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/expand/[jobId]/stream`               | GET       | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/explanation`                         | POST      | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/explanation/[jobId]/stream`          | GET       | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/jobs/[jobId]`                        | GET       | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/plan-change/session`                 | POST      | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/plan-change/session/planner-turn`    | POST      | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/plan-change/session/submit`          | POST      | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/plan-change/session/turns`           | POST      | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/plan/generate`                       | POST      | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/plan/generate/[jobId]/stream`        | GET       | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/plan/sprint`                         | POST      | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/plan/sprint/[jobId]/review`          | GET       | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/plan/sprint/[jobId]/stream`          | GET       | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/plan/sprint/approve`                 | POST      | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/pre-plan`                            | GET/PATCH | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/replan`                              | POST      | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/ai/replan/[jobId]/stream`               | GET       | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/canvas-layout`                          | GET/PATCH | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/idea-draft`                             | POST      | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/idea-draft/[id]/claim`                  | POST      | session only                                                   | `ai:plan`        | new      | R5  |
| `/api/plans/[id]`                             | GET       | `planReviewService.getPlanReview` (transitive)                 | `ai:view_plan`   | new      | R11 |
| `/api/plans/[id]/approve`                     | POST      | workspace only                                                 | `ai:view_plan`   | new      | R11 |
| `/api/plans/[id]/decline`                     | POST      | `assertCanEdit`                                                | `ai:view_plan`   | new      | R11 |
| `/api/plans/[id]/items/[itemId]`              | PATCH     | workspace only                                                 | `ai:view_plan`   | new      | R11 |
| `/api/projects/[key]/ai-settings`             | GET       | `assertCanBrowse`                                              | `project:browse` | existing | R17 |
| `/api/projects/[key]/ai-settings`             | PATCH     | `assertPermission(ai:configure)`                               | `ai:configure`   | existing | R17 |
| `/api/work-items/[id]/ai/plan`                | GET/POST  | `contextualPlanningService.getSessionForWorkItem` (transitive) | `ai:plan`        | new      | R5  |
| `/api/work-items/[id]/ai/plan/[jobId]/stream` | GET       | `contextualPlanningService.streamPlanJob` (transitive)         | `ai:plan`        | new      | R5  |

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

| Operation                               | Verbs | Gate today                                     | Permission          | Decision | Why |
| --------------------------------------- | ----- | ---------------------------------------------- | ------------------- | -------- | --- |
| `/api/projects/[key]/estimation-config` | GET   | none on the read                               | `project:browse`    | new      | R25 |
| `/api/projects/[key]/estimation-config` | PATCH | `assertEstimationAdmin` — workspace OWNER only | `estimation:manage` | new      | R25 |

### `field`

| Operation                                  | Verbs        | Gate today                           | Permission         | Decision | Why |
| ------------------------------------------ | ------------ | ------------------------------------ | ------------------ | -------- | --- |
| `/api/components/[id]`                     | DELETE/PATCH | `assertCanManage`                    | `component:manage` | new      | R24 |
| `/api/fields/[fieldId]`                    | DELETE/PATCH | workspace only                       | `field:manage`     | new      | R26 |
| `/api/fields/[fieldId]/options`            | POST         | workspace only                       | `field:manage`     | new      | R26 |
| `/api/fields/[fieldId]/options/[optionId]` | DELETE/PATCH | workspace only                       | `field:manage`     | new      | R26 |
| `/api/projects/[key]/components`           | GET/POST     | `assertCanBrowse`, `assertCanManage` | `component:manage` | new      | R24 |
| `/api/projects/[key]/fields`               | GET/POST     | `assertCanBrowse`                    | `field:manage`     | new      | R26 |
| `/api/projects/[key]/labels`               | GET          | `assertCanBrowse`                    | `label:manage`     | new      | R20 |
| `/api/projects/[key]/tags`                 | GET/PUT      | `assertCanBrowse`, `assertCanManage` | `label:manage`     | new      | R20 |

### `import`

| Operation                           | Verbs | Gate today      | Permission   | Decision | Why |
| ----------------------------------- | ----- | --------------- | ------------ | -------- | --- |
| `/api/import`                       | POST  | `assertCanEdit` | `import:run` | new      | R39 |
| `/api/import/[id]`                  | GET   | workspace only  | `import:run` | new      | R39 |
| `/api/import/[id]/discover`         | POST  | workspace only  | `import:run` | new      | R39 |
| `/api/import/[id]/preview`          | POST  | workspace only  | `import:run` | new      | R39 |
| `/api/import/[id]/run`              | POST  | workspace only  | `import:run` | new      | R39 |
| `/api/import/jira/oauth/callback`   | GET   | — none —        | `import:run` | new      | R39 |
| `/api/import/jira/oauth/start`      | GET   | — none —        | `import:run` | new      | R39 |
| `/api/import/linear/oauth/callback` | GET   | workspace only  | `import:run` | new      | R39 |
| `/api/import/linear/oauth/start`    | GET   | workspace only  | `import:run` | new      | R39 |
| `/api/import/plane/oauth/callback`  | GET   | — none —        | `import:run` | new      | R39 |
| `/api/import/plane/oauth/start`     | GET   | — none —        | `import:run` | new      | R39 |

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

| Operation                                                   | Verbs            | Gate today        | Permission            | Decision         | Why |
| ----------------------------------------------------------- | ---------------- | ----------------- | --------------------- | ---------------- | --- |
| `/api/dashboards`                                           | GET/POST         | workspace only    | —                     | workspace-scoped | R34 |
| `/api/dashboards/[dashboardId]`                             | DELETE/GET/PATCH | workspace only    | —                     | workspace-scoped | R34 |
| `/api/dashboards/[dashboardId]/widgets`                     | POST             | workspace only    | —                     | workspace-scoped | R34 |
| `/api/dashboards/[dashboardId]/widgets/[widgetId]`          | DELETE/PATCH     | workspace only    | —                     | workspace-scoped | R34 |
| `/api/dashboards/[dashboardId]/widgets/[widgetId]/move`     | POST             | workspace only    | —                     | workspace-scoped | R34 |
| `/api/projects/[key]/roadmap`                               | GET              | workspace only    | `report:view`         | new              | R19 |
| `/api/projects/[key]/saved-filters`                         | GET/POST         | workspace only    | `saved_filter:manage` | new              | R16 |
| `/api/projects/[key]/saved-filters/[filterId]`              | DELETE/GET/PATCH | `getCapabilities` | `saved_filter:manage` | new              | R16 |
| `/api/projects/[key]/saved-filters/[filterId]/dependents`   | GET              | workspace only    | `saved_filter:manage` | new              | R16 |
| `/api/projects/[key]/saved-filters/[filterId]/star`         | DELETE/PUT       | workspace only    | `saved_filter:manage` | new              | R16 |
| `/api/projects/[key]/saved-filters/[filterId]/subscription` | DELETE/GET/PUT   | workspace only    | `saved_filter:manage` | new              | R16 |
| `/api/projects/[key]/velocity`                              | GET              | workspace only    | `report:view`         | new              | R19 |
| `/api/reports/average-age`                                  | GET              | workspace only    | `report:view`         | new              | R46 |
| `/api/reports/created-vs-resolved`                          | GET              | workspace only    | `report:view`         | new              | R46 |
| `/api/reports/distribution`                                 | GET              | workspace only    | `report:view`         | new              | R46 |
| `/api/reports/filter-results`                               | GET              | workspace only    | `report:view`         | new              | R46 |
| `/api/reports/resolution-time`                              | GET              | workspace only    | `report:view`         | new              | R46 |
| `/api/reports/workload`                                     | GET              | workspace only    | `report:view`         | new              | R46 |

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

| Operation                       | Verbs        | Gate today                                       | Permission      | Decision | Why |
| ------------------------------- | ------------ | ------------------------------------------------ | --------------- | -------- | --- |
| `/api/backlog`                  | GET/POST     | `backlogService.createBacklogIssue` (transitive) | `sprint:manage` | new      | R14 |
| `/api/backlog/bulk-move`        | POST         | workspace only                                   | `sprint:manage` | new      | R14 |
| `/api/sprints`                  | GET/POST     | session only                                     | `sprint:manage` | new      | R14 |
| `/api/sprints/[id]`             | DELETE/PATCH | session only                                     | `sprint:manage` | new      | R14 |
| `/api/sprints/[id]/burndown`    | GET          | workspace only                                   | `sprint:manage` | new      | R14 |
| `/api/sprints/[id]/complete`    | POST         | session only                                     | `sprint:manage` | new      | R14 |
| `/api/sprints/[id]/issues`      | GET          | workspace only                                   | `sprint:manage` | new      | R14 |
| `/api/sprints/[id]/issues/bulk` | POST         | workspace only                                   | `sprint:manage` | new      | R14 |
| `/api/sprints/[id]/points`      | GET          | workspace only                                   | `sprint:manage` | new      | R14 |
| `/api/sprints/[id]/report`      | GET          | workspace only                                   | `sprint:manage` | new      | R14 |
| `/api/sprints/[id]/start`       | POST         | session only                                     | `sprint:manage` | new      | R14 |
| `/api/work-items/[id]/rank`     | POST         | workspace only                                   | `sprint:manage` | new      | R14 |
| `/api/work-items/[id]/sprint`   | POST         | workspace only                                   | `sprint:manage` | new      | R14 |

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

| Operation                                               | Verbs       | Gate today                           | Permission         | Decision | Why |
| ------------------------------------------------------- | ----------- | ------------------------------------ | ------------------ | -------- | --- |
| `/api/projects/[key]/triage/queue`                      | GET         | workspace only                       | `work_item:triage` | new      | R23 |
| `/api/projects/[key]/triage/submissions`                | POST        | `assertCanBrowse`                    | `work_item:triage` | new      | R23 |
| `/api/ready`                                            | GET         | workspace only                       | `project:browse`   | existing | R2  |
| `/api/ready/next`                                       | POST        | workspace only                       | `project:browse`   | existing | R2  |
| `/api/ready/nudge`                                      | GET         | session only                         | `project:browse`   | existing | R2  |
| `/api/work-items/[id]`                                  | DELETE      | `assertCanManage`                    | `work_item:edit`   | existing | R41 |
| `/api/work-items/[id]/acceptance-evidence`              | POST        | — none —                             | `work_item:edit`   | existing | R43 |
| `/api/work-items/[id]/acceptance-evidence/upload-token` | POST        | — none —                             | `work_item:edit`   | existing | R43 |
| `/api/work-items/[id]/activity/all`                     | GET         | workspace only                       | `project:browse`   | existing | R2  |
| `/api/work-items/[id]/activity/history`                 | GET         | workspace only                       | `project:browse`   | existing | R2  |
| `/api/work-items/[id]/archive`                          | DELETE/POST | `assertCanEdit`                      | `work_item:delete` | new      | R42 |
| `/api/work-items/[id]/components`                       | POST/PUT    | workspace only                       | `work_item:edit`   | existing | R41 |
| `/api/work-items/[id]/components/[componentId]`         | DELETE      | workspace only                       | `work_item:edit`   | existing | R41 |
| `/api/work-items/[id]/delete-preview`                   | GET         | `assertCanManage`                    | `work_item:delete` | new      | R42 |
| `/api/work-items/[id]/epic-privacy`                     | PATCH       | `assertCanManageProject`             | `work_item:edit`   | existing | R41 |
| `/api/work-items/[id]/estimate`                         | PATCH       | workspace only                       | `work_item:edit`   | existing | R41 |
| `/api/work-items/[id]/labels`                           | POST/PUT    | workspace only                       | `work_item:edit`   | existing | R41 |
| `/api/work-items/[id]/labels/[labelId]`                 | DELETE      | workspace only                       | `work_item:edit`   | existing | R41 |
| `/api/work-items/[id]/rollup`                           | GET         | workspace only                       | `project:browse`   | existing | R2  |
| `/api/work-items/[id]/triage/accept`                    | POST        | workspace only                       | `work_item:edit`   | existing | R41 |
| `/api/work-items/[id]/triage/decline`                   | POST        | workspace only                       | `work_item:edit`   | existing | R41 |
| `/api/work-items/[id]/triage/detail`                    | GET         | `assertCanBrowse`                    | `work_item:edit`   | existing | R41 |
| `/api/work-items/[id]/triage/duplicate`                 | POST        | workspace only                       | `work_item:edit`   | existing | R41 |
| `/api/work-items/[id]/triage/promote`                   | POST        | workspace only                       | `work_item:edit`   | existing | R41 |
| `/api/work-items/[id]/triage/snooze`                    | DELETE/POST | workspace only                       | `work_item:edit`   | existing | R41 |
| `/api/work-items/mention-search`                        | GET         | workspace only                       | `project:browse`   | existing | R2  |
| `/api/work-items/peek`                                  | GET         | `assertCanBrowse`, `getCapabilities` | `project:browse`   | existing | R2  |

### `workflow`

| Operation                                                  | Verbs            | Gate today                               | Permission          | Decision | Why |
| ---------------------------------------------------------- | ---------------- | ---------------------------------------- | ------------------- | -------- | --- |
| `/api/board/columns/[columnId]/statuses`                   | PUT              | `assertBoardConfigAdmin` — ws OWNER only | `workflow:manage`   | new      | R10 |
| `/api/board/columns/[columnId]/statuses/[statusId]`        | DELETE           | `assertBoardConfigAdmin` — ws OWNER only | `workflow:manage`   | new      | R10 |
| `/api/projects/[key]/automation-rules`                     | GET/POST         | workspace only                           | `automation:manage` | new      | R28 |
| `/api/projects/[key]/automation-rules/[ruleId]`            | DELETE/GET/PATCH | workspace only                           | `automation:manage` | new      | R28 |
| `/api/projects/[key]/automation-rules/[ruleId]/enabled`    | PUT              | workspace only                           | `automation:manage` | new      | R28 |
| `/api/projects/[key]/automation-rules/[ruleId]/executions` | GET              | workspace only                           | `automation:manage` | new      | R28 |
| `/api/projects/[key]/status-automation`                    | GET/PATCH        | `assertCanBrowse`, `assertCanManage`     | `automation:manage` | new      | R28 |

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
