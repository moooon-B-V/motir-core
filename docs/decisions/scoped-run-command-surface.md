# `motir run` takes a SCOPE: a work item, or the reserved word `sprint`

**Status:** accepted · **Story MOTIR-3001 · MOTIR-3195**

## Context

`motir auto` drains a whole project's ready set. `motir run <key>` dispatches one
card. There is nothing in between — no way to say _"work this story"_, which is
the unit a person actually plans, reviews and accepts in (Principle #18).

MOTIR-3001 adds that scope. Before any loop code exists, one thing has to be
settled: **the command a scoped run wants is a command that is already taken,
and it already means something else.**

### What `motir run <key>` does today

Read fresh on `origin/main` at `ebbfbbec`, after MOTIR-3048 rewrote the claim
half and MOTIR-3017 (#2191) added the findings flags — both of which landed
while this card was open, which is why the card asked for a fresh read rather
than trusting its own summary.

`runCommand` (`packages/cli/src/commands/dispatch.ts:513`) is:

1. `refuseAutoOnlyFlag(opts, 'run')` — `--auto-approve-replan` is refused here.
2. `client.getWorkItem(trimmed)` → `{ item, readiness }`.
3. Not ready and no `--force` → throw `notReadyError`, which names the open
   blockers and hints at `--force`. Not ready **with** `--force` → an `info`
   line and carry on.
4. `resolveOwnerId` → `pickWarning(item, ownerId)`. **ONE axis: the ASSIGNEE.**
   MOTIR-3048 removed the status warnings, because the claim below now refuses
   anything outside the to-do category and a warning for an outcome that cannot
   happen is noise.
5. `ensureInProgress(client, item.identifier)` → `claimAllowsDispatch(claim)`.
   A refusal is `info(renderClaimRefusal(claim))` and a **clean return** — not a
   throw, because `run` was handed one card and cannot substitute another.
6. `client.dispatchPrompt(...)` → `deliver(...)`.

**There is no branch on `item.kind` anywhere in it, and no read of
`item.children`.** So `motir run MOTIR-3001` today claims the _story card
itself_, fetches a prompt for it, and points an agent at it. The story's
children are never looked at.

### Why that meaning is not worth preserving

It is not a capability anyone chose; it is the absence of a check. Every other
work-loop entry point already refuses a container:

- `classifyReadyItem` (`packages/cli/src/autoLoop.ts:42`) returns
  `needs_planning` for `epic` and `story`, and `motir auto` **skips** it.
- `motir batch` classifies through the same function.
- `motir next` never picks one: a container **with** children does not enter the
  ready set at all (the childless-container rule), and a childless one is
  classified `needs_planning` before dispatch.

So `motir run` is the sole path in the CLI that will point a coding agent at a
container card, and it does so only because it is the one command that reads a
key instead of picking one. Two callers of one endpoint disagreeing about what a
`story` is, is the drift this ADR exists to stop.

### What is already decided elsewhere, and consumed here

- **MOTIR-3049** shipped `POST /api/v1/scope-claims`
  (`app/api/v1/scope-claims/route.ts`, `lib/services/scopeClaimService.ts`,
  `lib/dto/scopeClaim.ts`). It takes `{ kind: 'work_item', key }` **or**
  `{ kind: 'sprint', projectKey }`, and returns a **200 with an `outcome`**:
  `claimed` · `mine` · `taken` · `not_claimable` · `wrong_shape` ·
  `not_finishable`. The all-or-nothing transaction, the lock order, the
  severity-ordered offender, the story-only shape rule and the In-Progress-from-
  t=0 cost are settled there. This ADR does not re-litigate any of them.
- **MOTIR-3017** shipped `--disable-log-bug` / `--disable-replan` /
  `--auto-approve-replan` and the `replanned` outcome + stop reason.

### Rung 1 — what was actually checked, not recalled

No issue tracker ships a terminal work-loop, so there is no direct mirror. What
was checked is the argument-shape convention of the CLI in this box's own
`$PATH`, `gh` 2.23.0, by reading its help rather than quoting a convention from
memory:

- `gh pr checks [<number> | <url> | <branch>]` — **one positional accepting
  several reference forms**, with an omitted argument resolved from context.
  That is the precedent for a polymorphic positional under one verb.
- `gh run watch <run-id>` vs `gh pr view <number>` — gh separates **entity
  types** into different command _paths_ and does not overload one positional
  across two of them.

The two pull opposite ways, and the tie is broken by rung 2 below: a work item
and a sprint are two entity types (gh's rule says split), but here they are two
_shapes of the same request body to the same endpoint_ (gh's other rule says one
positional). The endpoint is the fact that decides it.

### Rung 2 — the record the surface lives in

`packages/cli/src/commandCatalog.ts` is a record that **imports nothing**.
`program.ts` builds every command's name, argument signature, description and
help group from it; `lib/apiDocs/cli.ts` publishes the same record at
`/docs/cli`. `packages/cli/test/commandCatalog.test.ts` walks the real
`buildProgram()` tree and asserts agreement in **both** directions, options
included. So a command surface decided here is one record edit — and a surface
decided badly is published documentation that is wrong, in a table with no
second place to correct it.

---

## Q1 — `motir run <container>` BECOMES the scoped run. The old meaning is REFUSED, by SHAPE, not removed silently

**Decision: `motir run` keeps its name and gains a scope-shaped argument. Which
run it performs is decided by the target's SHAPE, exactly as the runbook's
hand-run procedure already decides it.**

| target                                                                     | what `motir run` does                                                                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a **leaf** — no children, any kind (`subtask`, a childless `task` / `bug`) | **unchanged.** Today's single-card dispatch, byte for byte: the readiness check, `--force`, the assignee warning, `ensureInProgress`, `dispatchPrompt`, `deliver`. |
| a **container with children**, any kind (`story`, `task`, `bug`)           | **the scoped run.** `POST /api/v1/scope-claims` with `{ kind: 'work_item', key }`, then drain the claimed leaves.                                                  |
| an **`epic`**                                                              | **refused, by KIND, before any shape analysis.**                                                                                                                   |
| a **childless `story` / `epic`**                                           | **refused** — it is a planning item. `--include-planning` triggers its expansion instead (Q4).                                                                     |

**Why shape and not kind.** `lib/issues/parentRules.ts` permits
`story: ['task','bug','subtask']` and `task: ['bug','subtask']`, so a `task` and
a `bug` can both be containers. A rule keyed on kind would run a container `bug`
as a single card and a childless `task` as a scope — both wrong. "One commit per
child" is a total description of a container's work exactly when no child is
itself a container, which is a statement about shape.

**Why an `epic` is refused by kind anyway.** An epic groups _stories_. Running
one would mean a multi-story pull request nobody can review, which contradicts
Principle #18 in the same breath as invoking it. The kind is the answer, so the
check does not wait for the shape analysis to reach the same conclusion more
slowly.

**Is this a breaking change to a published surface?** Yes for exactly one input
— a container key — and the change is stated rather than absorbed:

- For a **leaf** key, which is what `docs/cli.md`'s own example uses
  (`motir run ACME-7`) and what every dispatched card is, **nothing changes.**
- For a **container** key, the command stops dispatching an agent at the
  container card. That behaviour has no defender: the other three work-loop
  commands already refuse it, and a prompt assembled for a story card describes
  work no agent can complete.
- For a **childless story/epic**, the command stops dispatching entirely. This is
  the one genuine removal, and it is the case `classifyReadyItem` has called
  `needs_planning` since MOTIR-882.

**The exact copy.** The two refusals are quoted here so the CLI card registers
them rather than inventing them. Both are `CliError` (message + `hint`), matching
`notReadyError`'s shape.

_An epic:_

```
MOTIR-2200 is an epic — an epic is never a run target.
  hint: An epic groups stories; run one of its stories instead. `motir show MOTIR-2200` lists them.
```

_A childless container:_

```
MOTIR-3001 has no children to run — it is a planning item, not work.
  hint: Expand it first (`motir plan MOTIR-3001`), or pass --include-planning to trigger the expansion now.
```

**Rejected: a new verb (`motir story`, `motir scope`, `motir drain`).** It costs
a second copy of every work-loop flag, a second close-out path, and a second
place for the two to drift — for a difference of one field in one request body.
It also leaves `motir run <story-key>` meaning the thing nobody wants, forever,
because nothing would then be forcing it to change.

**Rejected: a `--scope` flag on `run`.** `motir run --scope MOTIR-3001` says the
same thing twice: the key already tells you it is a container. A flag that is
mandatory whenever the positional has one shape and forbidden whenever it has
the other is a shape check wearing a flag's clothes.

**Rejected: deprecate first, switch later.** A deprecation cycle is owed to
users who depend on a behaviour. Here the behaviour is dispatching an agent at a
card it cannot complete; a cycle would extend the life of a defect for the sake
of the form.

---

## Q2 — a sprint run is the reserved positional `sprint`: `motir run sprint`

**Decision: `motir run`'s positional becomes `<scope>`, which is either a work
item key or the literal word `sprint`. `motir run sprint` claims and drains the
project's ACTIVE sprint.**

**Why one positional and not a second command.** `POST /api/v1/scope-claims` is
_already_ one endpoint with a discriminated body, and its route header states
why: the two scopes "share the lock, the deterministic order, the category
re-assert and every one of the six outcomes, which is to say they would share
everything except the two lines that read the request." The CLI mirroring that
with two commands would re-split what the server deliberately kept single.

**Why there is no ambiguity to resolve.** A work item key is
`<PROJECT>-<digits>` — it always contains a `-` and ends in digits. `sprint`
contains neither. The disambiguation rule is therefore a literal equality check
on the trimmed, lower-cased argument, not a heuristic:

```
scope === 'sprint'  →  { kind: 'sprint',    projectKey }
otherwise           →  { kind: 'work_item', key: scope }
```

A project whose key were literally `SPRINT` would still address its cards as
`SPRINT-7`, which is not equal to `sprint`. No collision exists.

**`motir run sprint <ref>` is REFUSED, and the reason is recorded rather than
worked around.** `motir sprint [ref]` resolves a ref by id, exact name, or
unambiguous name prefix (`resolveSprintRef`, `packages/cli/src/render.ts:403`),
so the resolver exists. The endpoint does not: the sprint arm of
`scopeClaimBodySchema` takes a `projectKey` and `scopeClaimService` resolves the
project's **active** sprint itself — there is nowhere to send a sprint id. So:

```
`motir run sprint` runs the ACTIVE sprint; it cannot take a sprint name.
  hint: Activate the sprint first (`motir sprints` shows their states), then re-run.
```

Widening the endpoint to take a sprint id is a real follow-up and belongs to
whoever wants a past or future sprint run, which nobody has asked for. Refusing
with the reason costs one line; a client-side resolve whose result the server
ignores would be a lie in the shape of a feature.

**Rejected: `motir run --sprint`.** A flag that makes the positional forbidden
is the Q1 shape-check-as-flag mistake again, and it puts the two scopes on
different grammatical footings when the server puts them on the same one.

**Rejected: `motir sprint --run`.** `motir sprint` is a READ command
(`HELP_GROUP.read`). Hanging the most destructive verb in the CLI off a flag on
a list command is where a typo becomes a claimed sprint.

---

## Q3 — the scoped run REUSES `classifyReadyItem`'s vocabulary; it invents none

**Decision: a leaf inside a claimed scope that cannot be dispatched is reported
with `autoLoop.ts`'s existing `SkipRecord` and its existing reasons —
`needs_planning`, `needs_human`, `claim_refused` — and rendered by the existing
`renderAutoSummary`.**

`classifyReadyItem` already answers exactly this question for `auto` and
`batch`, from the dispatch payload alone with no extra round trip. A scoped run
asks the same question about the same rows for the same reason. A third
vocabulary would mean an operator reading two summaries of the same project
learns two names for one state.

Two consequences worth stating:

- **`needs_human` is why a scoped run can finish without finishing the story.**
  A `type: manual` / `executor: human` leaf is skipped and NAMED, and the
  container correctly stays open. MOTIR-3001's scope boundary already says this;
  it falls out of the reuse rather than needing its own mechanism.
- **`needs_planning` inside a claimed scope cannot happen**, because a container
  child is what `wrong_shape` refuses at the claim (Q5) — the run never reaches a
  leaf-drain loop holding one. It stays in the vocabulary because the record
  shape is shared, not because this path produces it.

---

## Q4 — the flags, one decision each

The unit is now a SET, so every existing work-loop flag has to be re-asked
rather than inherited. Two flags below are registered _in order to be refused_ —
the shipped pattern `--print` on `auto` and `--auto-approve-replan` on
`run`/`next`/`batch` already use, which exists because a reasoned refusal beats
commander's `unknown option` for a flag a reader has just seen in a sibling
command's help.

| flag                    | on a SCOPE                                            | what it means over a set                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--agent <cmd>`         | **applies**                                           | The agent command for **every** leaf, exactly as in `auto`. Unchanged per card.                                                                                                                                                                                                                                                                                               |
| `--max <n>`             | **applies** (new on `run`)                            | Stop after dispatching **n leaves**, not n scopes. The claim is untouched: the run still owns the whole scope and reports the leaves it did not reach.                                                                                                                                                                                                                        |
| `--keep-going`          | **applies** (new on `run`)                            | Continue past a failed agent instead of halting on the first. Identical to `auto`'s meaning.                                                                                                                                                                                                                                                                                  |
| `--force`               | **applies to a LEAF target only; refused on a scope** | On one card it overrides a _readiness_ check. Inside a scope, per-leaf readiness is the drain ORDER, and `not_finishable` is the server's verdict that the set cannot be finished at all — neither is a thing to override. Refusal: `` `--force` applies to a single work item, not to a scope. `` hint: `A scope that cannot be finished needs a re-plan, not a forced run.` |
| `--kinds <list>`        | **refused** (registered, not silent)                  | The claim is all-or-nothing over the whole membership. A kind filter would make the claim and the run disagree: the run would hold every card and work a subset, which is the half-delivered-story failure the up-front claim exists to prevent. Refusal: `` `--kinds` filters a ready-set PICK; a scoped run drains a claimed set. ``                                        |
| `--reset`               | **not registered on `run`**                           | It clears the session EXCLUDE list, which is read only on the ranked-pick path (`nextCommand`, `claimNextNotExcluded`). `motir run` does not pick and has never registered it. A scoped run does not pick either, so nothing changes and nothing is added.                                                                                                                    |
| `--include-planning`    | **applies** (new on `run`)                            | Only on the Q1 childless-container refusal: instead of refusing, trigger that container's AI expansion and stop. Same meaning, same `PlanningRecord`, same never-waits contract as `auto` — the plan needs a human's approval. It does **not** expand anything mid-drain; there is nothing to expand inside a claimed scope.                                                  |
| `--print`               | **applies to a LEAF target only; refused on a scope** | A set has no single prompt to paste. Same reason `auto` and `batch` refuse it, quoted from `auto`'s own catalog entry: _"an unattended loop has nobody to paste a prompt."_ Refusal: `` `--print` needs one prompt; a scoped run has one per leaf. ``                                                                                                                         |
| `--disable-log-bug`     | **applies**                                           | Per leaf, unchanged. It rides each leaf's dispatch prompt (`findingsPolicyOf`).                                                                                                                                                                                                                                                                                               |
| `--disable-replan`      | **applies**                                           | Per leaf, unchanged — **and** it is read at the scope level, on `wrong_shape` (Q5). Those are two distinct effects of one flag and both are deliberate: in each case the flag means _do not submit a plan on my behalf_.                                                                                                                                                      |
| `--auto-approve-replan` | **refused** — unchanged                               | It stays a `motir auto` flag. `refuseAutoOnlyFlag(opts, 'run')` already refuses it and keeps doing so, for a scope as for a card. Approving a plan the run itself provoked is a standing grant an operator gives to an unattended loop, not to a command they typed.                                                                                                          |

`--no-log-bug` and `--no-replan` remain registered and `hidden`, as the aliases
MOTIR-3022's pattern keeps accepted-but-unpublished.

---

## Q5 — `wrong_shape` submits a re-plan of the container and STOPS. `--disable-replan` submits nothing

**Decision, both arms, both exit 0:**

|                 | without `--disable-replan` (default)                        | with `--disable-replan`           |
| --------------- | ----------------------------------------------------------- | --------------------------------- |
| what runs       | nothing — no leaf is dispatched                             | nothing                           |
| what is written | `motir plan --detach <container-key>` is submitted **once** | nothing                           |
| what is printed | the offending child, its depth, and the plan review URL     | the offending child and its depth |
| exit code       | **0**                                                       | **0**                             |

The claim already rolled back, so **nothing is held** in either arm — this is the
one refusal that needs no cleanup.

**Why a re-plan and not an error.** The server made this a 200 for exactly this
reason: `app/api/v1/scope-claims/route.ts` states that `wrong_shape` and
`not_finishable` are _"FINDINGS whose correct response is to submit a re-plan — a
client that had to parse an error body to learn its story needs re-shaping would
be reading a diagnosis out of a failure."_ A CLI that then threw would put the
error back one layer up.

**Why exit 0.** The `replanned` outcome (MOTIR-3018) is already the precedent:
_"a correct outcome and exits 0"_, deliberately distinct from `halted`. A
mis-shaped story is a fact about the plan, discovered and reported. Nothing went
wrong; something was learned.

**Why submitted ONCE, and why `--detach`.** `motir plan --detach` returns the
job and plan ids without waiting (`docs/cli.md`, the `plan` catalog entry). A
run that waited would be waiting on a human, and MOTIR-3001's boundary says a
scoped run never waits. Once, because a retry loop against a shape the server
just refused would submit the same plan repeatedly.

**What `--disable-replan` means here, precisely:** _do not write a plan._ It
does not suppress the diagnosis — the offending child and depth are printed
either way, because the operator asked not to have a plan submitted for them,
not to be kept in the dark. This is the same shape MOTIR-3017 gave the flag on
the per-card path: _"it comments and stops."_

`not_finishable` takes the **same** stop, with the blockers rendered from the
result's `blockers` array, and **no re-plan in either arm** — out-of-scope work
gating in-scope work is a fact about the rest of the tree, and re-planning the
container would be re-planning the wrong thing.

### The full outcome → CLI behaviour map

| `outcome`        | the run                                                            | exit                             |
| ---------------- | ------------------------------------------------------------------ | -------------------------------- |
| `claimed`        | drain the leaves                                                   | agent-dependent (`autoExitCode`) |
| `mine`           | **resume** — the caller already holds it                           | agent-dependent                  |
| `taken`          | stop; name the offender, its status and its holder from `offender` | 0                                |
| `not_claimable`  | stop; name the offender and its status                             | 0                                |
| `wrong_shape`    | stop; submit a re-plan unless `--disable-replan`                   | 0                                |
| `not_finishable` | stop; render `blockers`; never re-plan                             | 0                                |

Exit 0 on the four refusals matches the single-key path, whose refusal is
already _"a clean return — not a throw"_ (`runCommand` step 5, and the comment
above it). A refused claim is an ordinary state a dispatcher meets.

---

## The In-Progress-from-t=0 consequence — stated once, referenced twice

**Every card in a claimed scope reads "In Progress" for the whole run, while
only one of them is being worked.** "In Progress" stops meaning _an agent is on
this right now_ and starts meaning _this run owns it_; the board shows the run's
**footprint**, not its cursor.

This is a **decided cost**, weighed and accepted (Yue, 2026-08-18), because it is
what makes the promise keepable: a scoped run says it will take a story and
finish it, and that is only true if it owns the story when it starts. Claiming
per leaf leaves a window in which a second run takes leaf five while this one is
on leaf two, and the two integrate onto different branches — a half-delivered
story split across two pull requests, worse than either run refusing.

**It is stated once, in the API docs**, by MOTIR-3049: the `claimScope` operation
description in `lib/api/v1/workLoop/operations.ts` carries it in full, and
`lib/dto/scopeClaim.ts` carries the reasoning. **This ADR references it; it does
not restate it as a second source of truth**, and neither should `docs/cli.md` —
the CLI documentation names the consequence and points at the operation, so
there is one place for it to be corrected.

---

## The `commandCatalog.ts` change, exactly

**One record CHANGES. None is added.** `motir run sprint` is the same command
with a wider positional, which is the whole point of Q2.

```ts
{
  path: 'run',                                   // unchanged
  signature: '<scope>',                          // WAS '<key>'
  description:
    'Run a scope: one work item, a whole story, or `sprint` for the active one.',
  helpGroup: HELP_GROUP.workLoop,                // unchanged
  options: [ /* below, in registration order */ ],
}
```

Options, in the order `program.ts` must register them — the existing eight in
their existing order, then the four new ones. `test/commandCatalog.test.ts`
compares this list against the registered tree **in order**, so the order is part
of the contract, not a presentation choice:

| #   | flags                   | description                                                                                                          | status                                              |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | `--print`               | `Print the prompt to stdout instead of launching an agent (default). One work item only.`                            | **description edited** — the leaf-only limit is new |
| 2   | `--agent <cmd>`         | `Run THIS agent command on the prompt (overrides MOTIR_AGENT).`                                                      | unchanged                                           |
| 3   | `--force`               | `Dispatch even though the item is not ready (dependencies unmet). One work item only.`                               | **description edited**                              |
| 4   | `--disable-log-bug`     | `Do not let the agent file a bug for a defect it finds elsewhere; it comments instead.`                              | unchanged                                           |
| 5   | `--disable-replan`      | `Do not let the agent submit a re-plan for a wrong card; it comments and stops.`                                     | unchanged                                           |
| 6   | `--no-log-bug`          | `Hidden alias for --disable-log-bug.` (`hidden: true`)                                                               | unchanged                                           |
| 7   | `--no-replan`           | `Hidden alias for --disable-replan.` (`hidden: true`)                                                                | unchanged                                           |
| 8   | `--auto-approve-replan` | `Not supported — approving a submitted re-plan and continuing is a `motir auto` flag.`                               | unchanged                                           |
| 9   | `--max <n>`             | `Stop after dispatching n work items from the scope.`                                                                | **NEW**                                             |
| 10  | `--keep-going`          | `Continue past a failed agent instead of halting on the first one.`                                                  | **NEW**                                             |
| 11  | `--include-planning`    | `Trigger an AI expansion for an unexpanded story instead of refusing it. Never waits: the plan needs your approval.` | **NEW**                                             |
| 12  | `--kinds <list>`        | `Not supported — a scoped run drains the whole claimed set, not a filtered subset.`                                  | **NEW, refused**                                    |

The three new _working_ flags (9–11) are spelled and described to match `auto`'s
existing entries word for word where the meaning is identical, so the published
table does not describe one behaviour two ways.

**No other catalog record changes.** `next`, `auto` and `batch` are untouched:
none of them takes a key, so none of them can be handed a scope.

---

## Consequences

- **`motir run <leaf-key>` is unchanged** — the common case, and the one in
  `docs/cli.md`'s example, behaves identically after this ADR.
- **`motir run <container-key>` changes meaning**, and the change is a strict
  improvement: from _point an agent at a card it cannot complete_ to _run its
  children_. Nothing depended on the old behaviour that was not already broken.
- **`motir run <childless-story>` stops working**, and says so with a hint at the
  command that fixes it. This is the only removal.
- **The CLI gains no new command and no new vocabulary.** One signature widens,
  four options are added to one record, and `classifyReadyItem`'s two skip
  reasons are reused as they stand.
- **The published table at `/docs/cli` updates itself** from the record — that
  is what `commandCatalog.ts` is for, and it is why deciding the record here is
  the whole deliverable rather than a detail of it.
- **A `--force` escape hatch does not exist for a scope**, on purpose. The
  answers to a scope that will not claim are: wait (`taken`), re-plan
  (`wrong_shape`), or fix the tree (`not_finishable`). None of them is _do it
  anyway_, and offering a flag that implied otherwise would offer to produce the
  half-delivered story the whole design avoids.
- **The runbook's hand-run `motir run <parent>` procedure and this command now
  agree on the shape rule** — container-with-leaf-children runs, epic refuses,
  deeper-than-one-layer refuses. Reconciling the two texts is MOTIR-3203's work;
  this ADR is the side they reconcile to.

## AMENDMENT (Bug MOTIR-3268, 2026-08-20) — the CLAIM is not the only stop; the CLOSE-OUT has one too

The outcome map above is total over the **claim**, and it was read as total over
the run. It is not, and the gap is a shape this ADR could not have seen when it
was written: the claim is taken at t=0 and the pull request is opened at t=end,
and **MOTIR-3017 shipped the ability for a run to file a bug in between** — under
the in-flight card's PARENT, which on a scoped run is the container this run is
about to open a pull request for.

So the drain can finish having built every card it claimed, and the container can
still have a child that is not built. A pull request opened over that claims the
story is implemented when it is not. MOTIR-3229 made the container's own move
into `implemented` / `in_review` refusable server-side
(`CONTAINER_HAS_OPEN_CHILDREN`, 422) — which stops the false CLAIM and not the
pull request, because the run opens it FIRST and transitions after, so the
refusal lands on a pull request that already exists.

**The decision: the close-out RE-READS the container's current children — one
`get_work_item`, after the drain, before `gh pr create` — and opens nothing while
any child is below `implemented`.** Three things follow, each chosen rather than
incidental:

- **The branches are still PUSHED.** A hold is a statement about the pull
  REQUEST, not about the commits; finished work must not be left in a local
  checkout for a human to find. The summary reports the repository as `held`,
  names the branch, and is distinct from `failed` (an attempt `gh` refused).
- **The run names all THREE dispositions and picks none** — land the open
  children, re-parent them out of the container, or move the container to Done,
  which completes its children deliberately. Each is a decision about SCOPE, and
  an unattended run has no standing to make one on the operator's behalf.
- **Exit 0, like every other stop in the map above.** The run did what it was
  asked and stopped on a state it reported; a non-zero code would say something
  went wrong, and nothing did.

**It narrows the window; it does not close it.** A child can arrive between the
re-read and the transition, so the 422 remains reachable — and is therefore
rendered as a named outcome rather than allowed to escape as an unhandled throw,
which would take the run's close-out down with it and abandon work that has
nothing to do with the container.

**A SPRINT scope has no container to re-read** and is unaffected: it spans
several parents at mixed depths, and its pull request claims nothing about any
one of them.

## Context refs

- `packages/cli/src/commands/dispatch.ts` — `runCommand`, `pickWarning`,
  `ensureInProgress`, `claimAllowsDispatch`, `renderClaimRefusal`,
  `notReadyError`, `refuseAutoOnlyFlag`
- `packages/cli/src/commandCatalog.ts` — the record this ADR edits
- `packages/cli/src/scopedRun.ts` — `childrenBelowClaimBar`, `renderOpenChildrenHold`,
  `openChildrenHoldReason` (the AMENDMENT's close-out gate)
- `lib/workItems/statusLadder.ts` — the server's bar the CLI restates by key
- `packages/cli/src/program.ts` — `register()`, which builds from it
- `packages/cli/test/commandCatalog.test.ts` — the both-directions, in-order audit
- `packages/cli/src/autoLoop.ts` — `classifyReadyItem`, `SkipRecord`,
  `PlanningRecord`, `StopReason`, `autoExitCode`
- `packages/cli/src/render.ts` — `resolveSprintRef`, the resolver Q2 declines to use
- `app/api/v1/scope-claims/route.ts` · `lib/services/scopeClaimService.ts` ·
  `lib/dto/scopeClaim.ts` · `lib/api/v1/workLoop/schema.ts` — MOTIR-3049
- `lib/issues/parentRules.ts` — the kind-parent matrix behind "shape, not kind"
- `docs/cli.md` — the published surface MOTIR-3202 updates
- `docs/decisions/cli-login.md` · `docs/decisions/dispatch-prompt-assembly.md` —
  the ADR shape followed here
