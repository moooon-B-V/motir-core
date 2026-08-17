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
- **Amended:** 2026-08-17 (Yue · Story MOTIR-2888 · Subtask MOTIR-2889, settling
  MOTIR-2885) — **the UPWARD direction becomes a RECOMPUTE.** The parent's status is a
  function of its children's CURRENT statuses, applied whether the result is forward or
  backward. §3 gains a **fourth (`todo`) rung**; §5's `Forward-only` bullet is
  **replaced**, not softened; §3 records the direction-decides-the-authority split (a
  backward move is a privileged `{ system: true }` set); a new **§3a** records the
  trigger surface, because a recompute is a function of the CHILD SET and derivation
  rides `work-item/transitioned` alone today; §5's termination proof is replaced with one
  that does not appeal to forward-only. **No work item is exempt** — the rule changes for
  every parent in every project. **Amendment consumed by:** MOTIR-2890 (design: the
  four-rung settings surface), MOTIR-2891 (`parentStatusRollupService` — rung 4 + the
  recompute), MOTIR-2892 (the trigger seam), MOTIR-2893 (settings copy, en + zh),
  MOTIR-2894 (integration + E2E).

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

Motir ships **the opinion**: an upward **recompute** and a downward **cascade**, both
built-in, both **ON by default**, both riding the shared `work-item/*` events so they
cover **every** ingress (board, MCP, CLI, webhook) without a single ingress knowing they
exist. _(Amended 2026-08-17: the upward direction was a forward-only ladder riding
`work-item/transitioned` alone. It is now a recompute over the child SET, so it consumes
every event that CHANGES that set — see §3a.)_ They resolve against **each project's own workflow, by
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

**The 2026-08-17 amendment adds no third column and no new flag.** The recompute — rungs
1–4, forward and backward alike — ships under the **existing `autoRollupParentStatus`**:
no new `Project` column, no new toggle on the settings surface, and **no per-item or
per-kind exemption flag of any kind**. A user who wants the derivation gets all of it; a
user who does not turns the one switch off. (The rejected alternatives, including a
`permanentContainer` flag on the work item, are recorded in _Consequences_ 7.)

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

### 3. The UPWARD direction: a RECOMPUTE over a four-rung ladder (child → parent)

_Amended 2026-08-17 (MOTIR-2888 / MOTIR-2889). The rung set gained a fourth row, the
rung-3 condition dropped its clause about where the parent currently stands, and the
whole evaluation became a **recompute** rather than a climb — see §5's first bullet for
the semantics and the paragraph below for the mechanism._

**The parent's status is a FUNCTION of its children's current statuses.** Evaluate the
function, and set the parent to what it returns — forward if that is ahead of where the
parent stands, backward if it is behind. Evaluated against the **direct**,
non-archived, non-triaged children of the parent whose child set changed. Rungs, highest
first — **the first matching rung wins**:

| Rung            | Condition on the children's aggregate                                                          | Parent target                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **done**        | **every** child is in a `done`-category status                                                 | the `done` status (prefer key `done`, else first `done`-category)                      |
| **in-review**   | every child is in `in_review` **or** a `done`-category status, **and** ≥ 1 is in `in_review`   | the `in_review` status (prefer key `in_review`, else first `in_progress`-category)     |
| **in-progress** | ≥ 1 child is in an `in_progress`-category status (`in_review` is in that category)             | the `in_progress` status (prefer key `in_progress`, else first `in_progress`-category) |
| **todo**        | **no rung above matches** — i.e. ≥ 1 child is in a `todo`-category status and none has started | the `todo` status (prefer key `todo`, else first `todo`-category)                      |
| —               | **no children at all**                                                                         | **no derivation** — the parent is not touched                                          |

**The empty aggregate matches NOTHING, and rung 4 must not fire on it.** A parent with
zero live children (none, or every one archived / triaged) is left exactly where it
stands. This was already true of rung 1 — "every child is done" must not be vacuously
satisfied, or creating a story would instantly complete it — and rung 4 inherits the
same guard for the mirror reason: a newly created container has no children yet, and
knocking it back to `todo` on that basis would be deriving from an empty set. The rung-4
condition is therefore `total > 0` **and** no higher rung matched, never "the parent
looks unfinished".

**Rung 4 is what makes the recompute bite.** Rungs 1–3 are the shipped conditions and
their targets are unchanged; a ladder that can only report _started_, _in review_ or
_finished_ has no way to say **"there is open, unstarted work down here"**, which is
precisely the state a `done` parent enters the moment a fresh `todo` child is added to
it. Adding the rung without dropping the forward-only filter would change nothing at
all — the two halves of this amendment only work together.

Notes that are decisions, not detail:

- **`in_review` shares the `in_progress` CATEGORY**, so the in-review rung must target
  the specific status **KEY** and only fall back to the category if a project renamed
  it. This is precisely `resolveTargetStatusKey`'s prefer-key-then-category shape, which
  MOTIR-1620 **extracts from `changeRequestStatusSync` into `workflowsService`** so both
  consumers share one implementation rather than growing a second copy.
- **A parent with no children never rolls** (an empty aggregate matches no rung — in
  particular it must _not_ vacuously satisfy "every child is done", and _not_ fall
  through to rung 4 either).
- **`cancelled` counts as done** (it is a `done`-category status). A story whose every
  child is `done` or `cancelled` is finished.
- **THE DIRECTION DECIDES THE AUTHORITY** _(amended 2026-08-17)_. Rank the target on the
  same scale as the parent's current status, and use the comparison to pick **which call
  to make**, never to veto the move:
  - **FORWARD** (the target ranks ahead of where the parent stands) — **unchanged, and
    still legality-gated.** The move goes through the ordinary `applyStatusTransition`
    **without** `system`, i.e. along the project's **real** workflow edges, keeping the
    highest-legal-rung fallback below. An illegal move is a **logged no-op, never a
    throw**: a team whose workflow has no path to the derived status simply gets no
    derivation, which is the conservative reading of "the derivation respects your
    workflow". This is why MOTIR-1625 adds the `in_progress → done` edge to the default
    workflow — without it, the commonest shape (a parent already `in_progress` whose
    children all finish) could never reach `done`. **"You configure your workflow, the
    derivation respects it" (§1) is a promise about ADVANCEMENT, and it is kept intact.**
  - **BACKWARD** (the target ranks behind) — a **privileged SYSTEM set**:
    `applyStatusTransition(..., { system: true })`, the same shipped bypass (MOTIR-941)
    the downward cascade already uses, with **no** `canTransition` probe and **no** rung
    fallback. The reason is §4's own, applied to the other direction: **`done → todo` and
    `in_review → todo` are not edges in the default workflow, and must NOT be added as
    `workflow_transition` rows** — those rows are user-draggable board edges, and adding
    them would let anyone walk the workflow backwards by hand. `system: true` skips
    **only** `canTransition` and keeps everything else: the row lock, the tenant gate,
    the project-access gate, the target-status-exists check, the
    `done ⇒ sessionBranch = null` invariant, and the revision.
  - **Why a backward derivation may bypass a gate a user's own move may not.** A derived
    backward move is not a user's workflow step; it is a **claim about the children** —
    "there is unstarted work under this item" — and the workflow graph does not get a
    vote on whether that claim is true. A workflow says which moves a _person_ may make
    on the board.
  - **This is a SECOND asymmetry, on a different axis from §4's.** §4's asymmetry is by
    direction of travel **in the tree** (up is legality-gated, down is a system set).
    This one is by direction of travel **along the ladder**, within the upward direction
    (forward is legality-gated, backward is a system set). Both exist for the same
    underlying reason — a move no user path allows is exactly the move a derivation must
    still be able to make.
- **One move per pass, with a FALLBACK to the next legal rung — FORWARD only.** The
  recompute transitions the parent **once**; if that moves it, the re-emitted event
  re-evaluates, so a parent can travel several rungs across successive events without any
  loop in the service. When more than one rung matches, it takes the **highest**; if that
  target is forward and this project's workflow has no edge for it, it falls to the next
  matching rung down. _(Amended after MOTIR-1623's integration test found the gap: taking
  only the top rung STRANDS a parent whose graph cannot make that jump — a `todo` parent
  whose only child goes straight to review matches the in-review rung, `todo → in_review`
  is not an edge, and no later event changes that aggregate, so it would sit in `todo`
  forever. The fallback keeps the derivation convergent while still only ever walking real
  edges. If NO matching rung is legal, the outcome names the one it wanted and nothing
  moves.)_ **The fallback has no backward counterpart, and needs none:** a backward move
  is a system set that no edge can refuse, so there is nothing to fall back from. A
  target the parent is ALREADY in is a no-op that emits nothing — the fixed point that
  §5's termination argument rests on.

### 3a. The TRIGGER SURFACE — every edit to the CHILD SET recomputes _(added 2026-08-17)_

A ladder climb could ride the one event that moves a child along it. **A recompute
cannot: it is a function of the child SET, so every edit to that set must run it.**
Derivation today consumes `work-item/transitioned` alone
(`lib/jobs/definitions/statusDerivation.ts`), which is exactly why _adding_ a child to a
`done` parent currently fires nothing at all — the case this amendment exists for.

| Child-set edit                                           | Shipped today                                                                                                                                                                       | In scope for the recompute                                                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a child **transitions**                                  | ✅ `work-item/transitioned` → `statusDerivationOnTransitioned`                                                                                                                      | unchanged                                                                                                                                                                                 |
| a child is **created** under the parent                  | `work-item/created` is emitted post-commit by `workItemsService` (Story 6.6.2) but has **no derivation consumer**                                                                   | add a consumer. The payload carries `workItemId` and the service re-reads the item and its parent, so **no payload change is needed**                                                     |
| a child is **re-parented**                               | ✗ **`workItemsService.moveWorkItem` emits NO EVENT AT ALL** — verified on `origin/main`: the function contains no `sendEvent` call, so a `move_to_parent` is invisible to every job | emit post-commit on a real parent change, carrying the **PREVIOUS and the NEW** parent id, and recompute **BOTH** — the old parent may now be finished, the new one may need to come back |
| a child is **archived / unarchived / triaged / deleted** | ✗ nothing                                                                                                                                                                           | recompute the affected parent — these rows ENTER and LEAVE the aggregate, because every child read excludes `archivedAt IS NOT NULL` and `triagedAt IS NOT NULL`                          |

Three constraints that are decisions, not detail:

- **One recompute implementation, reached from more triggers.** Every trigger routes to
  the same `parentStatusRollupService` entry point; a trigger that knows a PARENT rather
  than a child (the re-parent's old parent, a delete) passes the parent directly. The
  ladder is never forked.
- **A recompute must NOT trigger the downward cascade.** The cascade fires only on an
  item ENTERING a `done`-category status, and that is load-bearing here: it is what stops
  a parent which has just come BACK to `todo` from force-closing the child that brought
  it there.
- **The toggle governs all of them.** `autoRollupParentStatus` gates every trigger in
  this table exactly as it gates the transition one, and a create with no parent or a
  move that does not actually change the parent is a cheap no-op — these events fire on
  every item creation in the workspace.

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

_(Amended 2026-08-17: the upward direction is no longer wholly legality-gated. It is
gated **when it advances** and a system set **when it comes back**, for the identical
reason given here — the backward edges it needs are absent from the default workflow and
must not be added as user-draggable rows. See §3's "the direction decides the authority".
The tree-direction asymmetry this paragraph describes is unchanged; there are now two
asymmetries on two axes.)_

### 5. Cross-cutting semantics (both directions)

- **The upward direction is a RECOMPUTE, not a ratchet** _(replaced 2026-08-17;
  MOTIR-2888 / MOTIR-2889, settling MOTIR-2885 — this bullet previously read
  "Forward-only" and asserted the opposite of every clause below)_. The parent's status
  is a **function of its children's current statuses**, and the result is applied whether
  it is ahead of or behind where the parent stands. **Reopening a child brings its parent
  back with it. A `done` parent given a fresh `todo` child returns to `todo`. A `done`
  parent is not permanently done.** What survives from the old bullet: an
  already-`done` child is still never re-touched by the DOWNWARD cascade (§4), which is a
  separate mechanism with its own trigger.

  **Why the change.** A ratchet is right only while a plan can shrink and never grow,
  which is not how plans behave. A parent is a summary of the work underneath it, and a
  summary that can only ever improve stops being a summary the first time work is added.
  The concrete failure this settles: the planner-bug home MOTIR-1465 was carried to
  `done` twice by rollup and then given new children, and MOTIR-1464 sat `done` while its
  own child MOTIR-1465 sat `todo` — the tracker contradicting itself, in two places, from
  one rule.

  **No item is exempt.** The rule changes for every parent, of every kind, in every
  project. There is no per-item, per-kind or per-container carve-out — see
  _Consequences_ 7 for the three exemption-shaped alternatives that were rejected.

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
- **Recursion and termination** _(proof replaced 2026-08-17 — the old one appealed to
  forward-only, which no longer holds; the shape of the mechanism is unchanged)_. Each
  pass transitions only the **direct** neighbour(s). The next level derives when its own
  transition **re-emits** `work-item/transitioned` — emitted only on a _real_ transition.
  **No explicit ancestor/descendant walk and no loop-guard flag**, and depth is bounded
  by the tree anyway (epic → story → task/bug → subtask). The argument, in two parts:
  1. **A level cannot oscillate while its children hold still.** Each pass sets a level
     to a target that is a **pure function of that level's children**. Run it twice on an
     unchanged child set and it computes the same target both times — and the second pass
     finds the level already there, which is a no-op that **emits nothing**. So an
     unchanging child set produces at most one transition per level, and the chain up the
     tree is finite because the tree is.
  2. **The two directions still cannot loop, without leaning on forward-only.** A parent
     _entering_ a `done`-category status cascades down; each completed child re-emits;
     each re-emission recomputes the parent, whose children are now all done, so rung 1
     returns `done` again — the parent is already there, a **fixed point**, and it emits
     nothing. A parent _leaving_ `done` triggers **no cascade at all**, because the
     cascade fires only on **entry into** a done-category status (§4), never on exit. So
     the one new motion this amendment introduces — a parent coming back — starts no
     downward wave that could push it forward again.

  What the old proof got from forward-only, the fixed point now gets from
  _already-there emits nothing_, which is a property of `applyStatusTransition` itself
  and does not depend on which way the derivation is travelling.

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

_Consequences 7–9 added 2026-08-17 with the recompute amendment._

7. **A parent can now move BACKWARD with nobody touching it — including out of `done`.**
   This is the amendment's whole point and its main user-visible surprise, so it is
   stated here rather than left to be discovered: add an unstarted child to a finished
   story and the story returns to To Do; reopen a child and its parent reopens with it.
   **The settings copy changes with the behaviour.** The shipped
   `settings.statusAutomation.rollup.hint` promises the opposite in writing — _"It only
   ever moves a parent forward … reopening a child never moves a parent back"_ — and the
   surface's ladder read-out shows three rungs; both are now false, and MOTIR-2890 /
   MOTIR-2893 redraw and rewrite them (four rungs, a both-ways promise, `en` + `zh`).
   A behaviour change that leaves its own settings page asserting the old rule is not
   finished.

8. **`applyStatusTransition` gains a second `system: true` caller** — the backward arm of
   the upward recompute, alongside the downward cascade (Consequence 2). The bypass's
   blast radius grows by one call site and by nothing else: it remains reachable only
   from server job context, never from a user route, and it still skips only
   `canTransition`.

9. **Three exemption-shaped alternatives were REJECTED** (tabled on MOTIR-2885). Each
   answers "this one container should not close itself"; the recompute answers the
   general question — _a parent's status should tell the truth about its children_ — and
   the home stops closing itself as a **consequence of the rule**, with nothing about it
   named anywhere in the code.
   - **Exempt the marker-resolved planner-bug home (MOTIR-1465) from rollup** — rejected:
     it special-cases one row, and owes a second special case to the next permanent
     container.
   - **A general `permanentContainer` flag on the work item, honoured by rollup** —
     rejected: a schema column, a UI affordance and an admin story, to describe something
     the recompute makes moot.
   - **Declare the home's status meaningless and document it** — rejected: it leaves a
     `done` mistake log reading "no planning bugs", and owes a manual revert after every
     sweep.
