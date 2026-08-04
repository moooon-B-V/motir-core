# ADR: Bidirectional status derivation — parent↔child

- **Status:** Accepted (2026-08-03)
- **Story / Subtask:** Bidirectional status derivation (MOTIR-1615) · Subtask MOTIR-1616
- **Supersedes / superseded by:** none
- **Consumed by:** MOTIR-1617 (design: the settings toggles), MOTIR-1618 (the two
  `Project` toggle columns + settings read/update), MOTIR-1619 (the direct-children
  status aggregate), MOTIR-1620 (`parentStatusRollupService` — the UPWARD ladder),
  MOTIR-1647 (`childStatusCascadeService` — the DOWNWARD cascade), MOTIR-1621 (the one
  `work-item/transitioned` consumer dispatching BOTH), MOTIR-1622 (settings UI),
  MOTIR-1625 (the `in_progress → done` default-workflow edge), MOTIR-1623 / MOTIR-1624
  (integration + E2E).

> Structured **Status → Context → Decision → Consequences**, with the load-bearing facts
> pinned in explicit tables so every downstream subtask implements against one
> authoritative source (the convention `work-item-type-taxonomy.md` set).

> **Filed under `docs/decisions/`, not `docs/adr/`.** The MOTIR-1616 card says
> `docs/adr/`; shipped reality is that every one of this repo's 22 ADRs lives in
> `docs/decisions/` and there is no `docs/adr/` directory. Decision-authority ladder
> rung 2 (shipped reality) outranks the card's path, so this ADR joins its siblings.

---

## Context

A work item's status and its children's statuses are, today, **completely
independent**. Closing the last child of a story leaves the story `todo`; marking a
story `done` leaves nine `todo` subtasks behind it. Both are wrong in the same way: a
parent's status is a _summary_ of its children, and a parent's completion is a _claim
about_ its children. Motir keeps neither in sync.

This was discovered as a suspected GitHub-webhook bug ("the webhook doesn't roll up
parent status when all children are done"), and debug-first showed it is not a webhook
bug at all — see _Shipped reality_, below. It is a **missing capability**, and the fix
belongs at the one seam every status change already passes through.

### Shipped reality this builds on (verified against `origin/main`, HEAD `3d7a9831`)

| Fact                                                                                                                                                                                                                                                                      | Where                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **`applyStatusTransition` is THE single choke-point for every status change** — board drag, MCP `transition_status`, the CLI, the change-request webhook. It writes **only the item's own status**: no parent read, no child write.                                       | `lib/services/workItemsService.ts:1609`                                  |
| Its sequence: `lockById` (`SELECT … FOR UPDATE`) → tenant gate → `projectAccessService.assertCanEdit` → no-op short-circuit → `getStatusByKey` (target must exist) → `canTransition` (legal-edge gate) → status write + `done ⇒ sessionBranch = null` → `recordRevision`. | same, `:1619`–`:1726`                                                    |
| **A privileged system bypass ALREADY EXISTS** — `opts.system?: boolean` skips **only** the `canTransition` check, keeping the lock, both gates, the target-exists check, the `done` invariant and the revision. Shipped for the issue importer (MOTIR-941).               | same, `:1614`, `:1675`                                                   |
| `setImportedStatus` is today's only `system: true` caller — and it deliberately **emits no event** (a bulk import must not fan out one notification per issue).                                                                                                           | same, `:1552`                                                            |
| `work-item/transitioned` is emitted **post-commit**, and **only on a real transition** (a no-op move carries `transition: null` and emits nothing).                                                                                                                       | same, `:1518`                                                            |
| `canTransition` short-circuits `true` when the project's `workflowPolicyMode` is `open`; under `restricted` it requires an explicit `workflow_transition` row.                                                                                                            | `lib/services/workflowsService.ts:283`                                   |
| The default workflow's 16 edges include `in_review → done` but **no** `in_progress → done`, **no** `todo → done`, **no** `blocked → done`.                                                                                                                                | `lib/workflows/defaultWorkflow.ts:73`                                    |
| Default statuses + categories: `todo`·`blocked` → **todo**; `in_progress`·`in_review` → **in_progress**; `done`·`cancelled` → **done**.                                                                                                                                   | `lib/workflows/defaultWorkflow.ts:27`                                    |
| **Resolve a target status BY CATEGORY, never a hard-coded key** — prefer the canonical key, fall back to the first status of the target category, else `null` (a logged no-op). Currently module-private in the change-request sync.                                      | `lib/services/changeRequestStatusSync.ts:309` (`resolveTargetStatusKey`) |
| **System-context attribution precedent**: `withSystemContext` + `workspaceMembershipRepository.findOwnerByWorkspace` — the webhook attributes its move to the change-request author when bound, else the workspace owner.                                                 | `lib/services/changeRequestStatusSync.ts:30`, `:187`                     |
| The change-request webhook already transitions a merged PR's item to `done` correctly, through that shared authority. **It does its one job** — which is why the missing rollup is not its bug.                                                                           | `lib/services/changeRequestStatusSync.ts:217`–`:278`                     |
| Direct-children reads uniformly exclude `archivedAt IS NOT NULL` **and** `triagedAt IS NOT NULL`.                                                                                                                                                                         | `lib/repositories/workItemRepository.ts:1651` (`findChildren`)           |
| The kind-parent matrix — `epic → [story, task, bug]`, `story → [task, bug, subtask]`, `task → [bug, subtask]`, `bug → [subtask]`, `subtask → []`. Parenting is **deeper than Jira's**; `bug` is not a leaf.                                                               | `lib/issues/parentRules.ts`                                              |
| Per-project boolean settings columns with an app-side service are an established pattern (`aiAutoPlanEnabled`, `aiSprintPlanningEnabled`, …).                                                                                                                             | `prisma/schema.prisma` · `model Project`                                 |
| Event consumers are `defineJob` handlers registered in one registry; several consumers of the SAME event coexist by carrying distinct job ids.                                                                                                                            | `lib/jobs/definitions/automationEngine.ts`, `lib/jobs/registry.ts`       |

### Mirror check (Jira) — rung 1

Jira has **no first-class parent↔child status derivation in either direction**. Upward
is an automation _template_ ("transition parent when all sub-tasks are done"); downward
is a rule you assemble yourself from a trigger + a branch + a transition action
([Atlassian KB](https://support.atlassian.com/jira/kb/how-to-automatically-transition-the-parent-issue-based-on-the-sub-task-status/)).
Everything Jira lets you "configure" here — the trigger, which statuses count, the
target status, the branch — is configurable **only because Jira ships no opinion**.

---

## Decision

### 1. Two opinionated, first-class behaviours on the shared event — not a rule builder

Motir ships **the opinion**: an upward **ladder** and a downward **cascade**, both
built-in, both **ON by default**, both riding the one shared `work-item/transitioned`
event so they cover **every** ingress (board, MCP, CLI, webhook) without a single
ingress knowing they exist. They resolve against **each project's own workflow, by
category**, so a team that renames or adds statuses keeps working derivation. That is
the meaningful sense of "configurable like Jira": **you configure your WORKFLOW, and the
derivation respects it.**

**Rejected — Option A: a generic automation condition-builder** (a parent branch + a
children-aggregate / parent-done condition + a transition action, extending the shipped
6.6 automation engine). With opinionated behaviours that resolve by category, every knob
such a builder would expose is _already answered_; exposing them would mainly enable
**incoherent** setups — "parent → Done when any one child starts", "close the children
when the parent merely starts". Freedom that makes no sense for the workflow is not a
feature. Recorded here so a future genuine use case for generic parent/child rules
starts from this rationale rather than re-deriving it; that would be its own story, and
it would extend the automation engine, not this ADR's services.

### 2. Toggle model — TWO independent project booleans, BOTH default ON

| Column (`Project`)                 | Governs                                  | Default |
| ---------------------------------- | ---------------------------------------- | ------- |
| `autoRollupParentStatus`           | the UPWARD ladder (child → parent)       | `true`  |
| `autoCompleteChildrenOnParentDone` | the DOWNWARD cascade (parent → children) | `true`  |

The two directions have **different risk profiles**. Upward rollup only ever reflects
work that genuinely happened, and is universally expected. Downward cascade
**auto-completes children — including UNSTARTED (`todo`) ones** — which a team may
legitimately not want (they may treat a done parent as "the parent's own work is
finished", with children tracked separately).

**Rejected — one combined toggle.** It cannot express _upward-only_, which is exactly
the commonest preference ("I want the rollup, I don't want auto-close"). A single switch
would force such a team to lose the safe half to escape the risky half.

Each toggle is read **inside its own direction's service**, so one direction being off
never suppresses the other.

### 3. The UPWARD ladder (child → parent)

Evaluated against the **direct**, non-archived, non-triaged children of the transitioned
item's parent. Rungs, highest first — **the first matching rung wins**:

| Rung            | Condition on the children's aggregate                                                          | Parent target                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **done**        | **every** child is in a `done`-category status                                                 | the `done` status (prefer key `done`, else first `done`-category)                      |
| **in-review**   | every child is in `in_review` **or** a `done`-category status, **and** ≥ 1 is in `in_review`   | the `in_review` status (prefer key `in_review`, else first `in_progress`-category)     |
| **in-progress** | parent is in a `todo`-category status **and** ≥ 1 child is in an `in_progress`-category status | the `in_progress` status (prefer key `in_progress`, else first `in_progress`-category) |

Notes that are decisions, not detail:

- **`in_review` shares the `in_progress` CATEGORY**, so the in-review rung must target
  the specific status **KEY** and only fall back to the category if a project renamed
  it. This is precisely `resolveTargetStatusKey`'s prefer-key-then-category shape, which
  MOTIR-1620 **extracts from `changeRequestStatusSync` into `workflowsService`** so both
  consumers share one implementation rather than growing a second copy.
- **A parent with no children never rolls** (an empty aggregate matches no rung — in
  particular it must _not_ vacuously satisfy "every child is done").
- **`cancelled` counts as done** (it is a `done`-category status). A story whose every
  child is `done` or `cancelled` is finished.
- **Legality-gated.** The rollup moves the parent through `applyStatusTransition`
  **without** `system` — i.e. along the project's **real** workflow edges. An illegal
  move is a **logged no-op, never a throw**: a team whose workflow has no path to the
  derived status simply gets no derivation, which is the conservative reading of "the
  derivation respects your workflow". This is why MOTIR-1625 adds the
  `in_progress → done` edge to the default workflow — without it, the commonest shape
  (a parent already `in_progress` whose children all finish) could never reach `done`.
- **One rung per event, with a FALLBACK to the next legal one.** The rollup transitions
  the parent **once**; if that moves it, the re-emitted event re-evaluates, so a parent
  can climb several rungs across successive events without any loop in the service. When
  more than one rung matches, it takes the highest that is both forward and **legal in
  this project's workflow**, falling to the next one down if the top jump has no edge.
  _(Amended after MOTIR-1623's integration test found the gap: taking only the top rung
  STRANDS a parent whose graph cannot make that jump — a `todo` parent whose only child
  goes straight to review matches the in-review rung, `todo → in_review` is not an edge,
  and no later event changes that aggregate, so it would sit in `todo` forever. The
  fallback keeps the derivation convergent while still only ever walking real edges. If NO
  matching rung is legal, the outcome names the one it wanted and nothing moves.)_

### 4. The DOWNWARD cascade (parent → children)

**Trigger:** an item transitions **into a `done`-category status** — by a user, by the
upward rollup, or by the change-request webhook when its PR merges. **Effect:** every
**not-done DIRECT child** (non-archived, non-triaged) is set to the project's `done`
status. Grandchildren are reached by re-emission, never by a subtree walk.

**Mechanism — the privileged SYSTEM set, reusing the shipped `opts.system` bypass.**
Forcing an unstarted `todo` / `blocked` child straight to `done` is **not a legal user
transition**: the default workflow has no such edge, and under `restricted`
`applyStatusTransition` throws `IllegalTransitionError`. We must **not** fix that by
adding `todo → done` / `blocked → done` transition rows — those are user-draggable
edges, and they would let anyone skip the whole workflow on the board. So the cascade
calls `applyStatusTransition(..., { system: true })`, which skips **only** the
`canTransition` check and keeps everything else: the row lock, the tenant gate, the
project-access gate, the target-status-exists check, the `done ⇒ sessionBranch = null`
invariant, and the revision row.

The card proposed _extending_ `applyStatusTransition` with `opts.system`; **it already
exists** (MOTIR-941, the issue importer). MOTIR-1647 therefore _reuses_ it and adds no
new bypass. It does **not** route through `setImportedStatus`, which is the existing
`system` caller but deliberately **emits no event** — the cascade _needs_ the event to
recurse to grandchildren. The cascade's own entry point emits `work-item/transitioned`
post-commit exactly as `updateStatus` does.

**This asymmetry with the upward direction is deliberate.** Upward _advances a parent
along the team's real workflow_ (conservative — it respects their stages). Downward
_performs a system completion no legal user path allows_, which is the honest shape of
"the parent is done, so its children are done".

### 5. Cross-cutting semantics (both directions)

- **Forward-only.** Reopening a child (`done → in_progress`) never rolls the parent
  back; a `done` parent is never un-done; an already-`done` child is never re-touched.
  This matches Jira's one-directional templates and is also what makes the recursion
  provably terminate.
- **Hierarchy and kinds.** Both directions apply across **every** parent edge in
  `parentRules.ts` — `subtask ↔ story/task/bug`, `story ↔ epic`, `task`/`bug` ↔ their
  parents — and count **all** child kinds. There is no kind-specific carve-out: the
  matrix is the authority, and a bug with subtasks rolls up exactly like a task with
  subtasks.
- **Excluded children.** `archivedAt IS NOT NULL` and `triagedAt IS NOT NULL` children
  are excluded from the aggregate **and** from the cascade — the uniform read-exclusion
  every other child read applies. An archived child must not hold its parent back from
  rolling up, and must not be resurrected into `done` by a cascade.
- **Attribution.** The job has no session, so it runs under `withSystemContext` and
  attributes the move to the **workspace owner** — the same fallback the change-request
  sync uses. It reads in the activity feed as an ordinary status change by that user
  (it _is_ one: the same `updated` revision with a `status: {from, to}` diff), so no new
  revision kind or feed renderer is needed.
- **Recursion and termination.** Each pass transitions only the **direct** neighbour(s).
  The next level derives when its own transition **re-emits** `work-item/transitioned`
  — which is emitted only on a _real_ transition. Termination is therefore structural:
  a level that does not change emits nothing, and the chain stops. **No explicit
  ancestor/descendant walk and no loop-guard flag.** Depth is bounded by the tree anyway
  (epic → story → task/bug → subtask).
- **The two directions cannot loop.** A parent that reaches `done` _by rollup_ already
  has all children done, so the cascade over it is a no-op; a parent set `done` by a
  user cascades to its children, and each child's re-emitted event rolls up to that same
  parent, which is already `done` — a no-op by forward-only. `done` being terminal for
  both directions closes the cycle.
- **Concurrency — lock the parent BEFORE reading the aggregate.** Two children
  finishing concurrently produce two rollup jobs against the same parent; if each reads
  the children aggregate before taking the parent's row lock, both can observe "not all
  done" and the parent never rolls. So the rollup opens its transaction, takes the
  parent's `lockById` **first**, and only then reads the aggregate — the racing job then
  blocks, and re-reads an aggregate that includes the winner's commit. (The standing
  read-derived-update rule; `applyStatusTransition`'s own lock is not sufficient because
  the derivation _input_ is read outside it.) The cascade needs no equivalent ordering:
  a stale "this child is not done" read is benign, because the action is an
  unconditional force-to-done that `applyStatusTransition` no-ops if the child got there
  first.
- **Derived transitions are REAL transitions.** They fire the automation engine and the
  watcher/bell notifications exactly like a board move, because that is what they are —
  a status genuinely changed and watchers asked to be told. Accepted consequence: a
  cascade over a wide parent notifies each child's watchers. They are not tagged with
  `viaAutomationRuleId`, which is automation-rule provenance and would wrongly suppress
  a user's own rules.

### 6. Rollout — existing projects backfill to ON

Both columns backfill **`true`** for existing projects. Motir is pre-GA with few live
tenants, and a uniform opinion is worth more than grandfathering. The one-time effect is
recorded here so it is not a surprise: on their **next** transition, an existing parent
whose children already satisfy a rung will advance, and an existing `done` parent with
open children will complete them. Nothing is derived retroactively at migration time —
there is no backfill job, only the column default; derivation begins at the next event.

---

## Consequences

1. **No ingress changes.** Board, MCP, CLI and webhook all keep calling
   `applyStatusTransition`; derivation is a consumer of the event they already emit.
   A new ingress gets derivation for free.
2. **`applyStatusTransition` gains one new `system: true` caller** — the cascade — and
   the bypass's blast radius grows accordingly. It remains reachable only from server
   job context, never from a user route.
3. **The default workflow gains one edge** (`in_progress → done`, MOTIR-1625), with the
   matching backfill for existing default-workflow projects. This is a user-visible
   change: the board now allows dragging `In Progress → Done` directly.
4. **`resolveTargetStatusKey` moves to `workflowsService`** and gains a second consumer;
   the change-request sync keeps identical behaviour through the shared function.
5. **A project on a custom workflow with no path to a derived status silently gets no
   derivation** for that rung. That is deliberate (rung 3's legality gate) and is why
   the outcome is _logged_, so it is diagnosable rather than invisible.
6. **A generic parent/child automation rule remains unbuilt.** If one is ever wanted,
   it extends the 6.6 engine and must reckon with these built-ins (most likely: the
   built-in toggles off, the rule on).
