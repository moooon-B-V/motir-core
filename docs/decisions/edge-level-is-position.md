# What "the same level" means for a `blocked_by`: the item's position, not its kind

**Status:** proposed · **MOTIR-6387** (the level-model decision of Story **MOTIR-6015**) ·
consumed by MOTIR-6356, MOTIR-6357, MOTIR-6360, MOTIR-6367, MOTIR-6369, MOTIR-6370 ·
amended by MOTIR-6443 (Amendment 1) and MOTIR-6509 (Amendment 2)

## Context

Story MOTIR-6015 changes the dependency rule: a `blocked_by` joins two items on the
**same level**, wherever the dependency is real, across parents included, and a
cross-parent edge is valid only when the parents carry the same edge, up to their
common parent. Its cards defined "level" **by kind**: epic, story, and leaf, where
_"a task, a bug and a subtask are all leaves"_.

That definition does not survive the kind-parent grammar
(`lib/issues/parentRules.ts` `ALLOWED_CHILD_TYPES`):

| parent  | may hold           |
| ------- | ------------------ |
| epic    | story, task, bug   |
| story   | task, bug, subtask |
| task    | bug, subtask       |
| bug     | subtask            |
| subtask | —                  |

A task and a bug are containers whenever they hold children, and a task can sit
directly under an epic beside its stories. The story's parent run found two shapes
the kind rule cannot express:

- **The validation task.** Both planners lay a validation task under an epic,
  `blocked_by` the story it validates. By kind that is leaf → story: cross-level,
  and refused by the new tool check and plan gate.
- **A task holding subtasks.** A subtask under task T that needs a subtask under
  story S owes "T `blocked_by` S" as the parents' edge. By kind that is leaf →
  story, so the edge can never be made valid.

## Decision

**An item's level is its position, not its kind. Two items are on the same level
when they sit at the same depth below their nearest common ancestor**, where the
project root is the ancestor of every root item (a folder is a placement and adds
no depth).

This is the parents'-edge recursion stated as a definition. Walk both items up one
parent at a time; the edge is same-level exactly when both walks reach the common
ancestor in the same number of steps, and each pair of parents met on the way is
the edge the rule already owes. **Cross-level** means the walks are unequal. No
kind table is consulted.

The cases the story needs answered, each by one walk:

| case                                      | edge                                                           | same level?                              | parents' edge owed                                                             |
| ----------------------------------------- | -------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| 1 · validation task T under epic E        | T `blocked_by` story S under E                                 | **yes** — both depth 1 under E, siblings | none                                                                           |
| 2 · subtask X under task T under E1       | X `blocked_by` subtask Y under story S under E1                | **yes** — depth 2 / 2 under E1           | T `blocked_by` S                                                               |
| 2b · the same, S under another epic E2    | X `blocked_by` Y                                               | **yes** — depth 3 / 3 under the root     | T → S and E1 → E2                                                              |
| 3 · subtask X under task T under story S1 | X `blocked_by` subtask Y under story S2 (same epic)            | **no** — depth 3 / 2                     | — the need is T `blocked_by` Y (depth 2 / 2), or X is re-filed                 |
| 4 · a root bug B in a folder              | B `blocked_by` subtask Y                                       | **no** — depth 1 / 3 under the root      | — Amendment 2: the edge is accepted and reported invalid ("blocked elsewhere") |
| 4b · a root task R holding subtasks       | subtask X under R `blocked_by` subtask Y under story S under E | **no** — depth 2 / 3 under the root      | — file R under E (then it is case 2)                                           |
| 5 · a root task R (Amendment 1)           | R `blocked_by` epic E                                          | **no** — an epic pairs only with an epic | — file R under E, or wire it to the item under E it really waits on            |

Case 4b's remedy once also offered _"R `blocked_by` E"_; Amendment 1 below refuses
that edge, so the remedy is to file R under E.

**Kind still bounds what can exist** (an epic has no parent, a subtask holds
nothing), but it no longer decides an edge.

## Amendment 1 (2026-09-26, the user)

**An epic is blocked only by another epic.** For epics there is no "same level" —
there is the same KIND. The epic tier is decided by kind, ahead of any depth: an
edge with an epic at either end is legal exactly when both ends are epics. The
project root is not a common ancestor that makes an epic the peer of a root task,
bug or story, even though both sit one step below it. **Under an epic, the position
rule above stands unchanged.**

| edge                                  | legal?                                          |
| ------------------------------------- | ----------------------------------------------- |
| epic `blocked_by` epic                | **yes**                                         |
| epic `blocked_by` a root task         | **no** — an epic is blocked only by an epic     |
| root task or bug `blocked_by` an epic | **no** — the same rule, read from the other end |
| root bug `blocked_by` a root task     | **yes** — neither end is an epic; depth 0 / 0   |

In motir-core the check sits in `isCrossLevelEdge` (`lib/workItems/edgeLevel.ts`),
ahead of the depth comparison, so the plan gate (`cross_level`), the validators'
`crossLevelEdges` verdict and `invalidEdges` all apply it. Each end's kind comes
from the reads those callers already make. Walking up through `invalidEdges`'
parents always stops at an epic ↔ epic pair. (Before Amendment 2 the link door's
`CROSS_LEVEL_LINK` and a `cross-level-edge` advisory applied it too; both are
gone.)

## Amendment 2 (2026-09-26, the user; MOTIR-6509)

**The level rule is a VALIDITY rule on a committed edge, and a REFUSAL only at the
plan gate.** A `blocked_by` may join any two levels. The link doors write it, and
`validate_work_item` declares the item INVALID, with the reason _"blocked
elsewhere"_. The planner should not author such an edge, but the tool must not
make a real dependency unrecordable.

**Why.** A dependency is a fact about the work, and the tree's shape does not
change it. When the link door refused an edge because its ends sat at different
depths, the fact was not prevented; it was only left unrecorded. The card then
read `ready: true`, both claim doors handed it out, and the dependency survived as
prose in a comment. The run that found this (MOTIR-6497, a root bug in `Bugs`
that could not be built until a subtask under another epic's story merged) had
no legal edge at all:

- The only depth-0 item on the blocker's side was an epic, and Amendment 1 lets
  only an epic block an epic.
- Case 4's remedy, re-filing the bug in the blocker's runnable container, makes it
  that story's child. When the story merges, `childStatusCascadeService` closes
  every child, so the bug would close unfixed.

Parked at Blocked with no edge, the card was claimable and invisible to readiness.

**What changed, in motir-core:**

| surface                                                    | before                                           | after                                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `link_work_items`, the REST link route, create-with-links  | refused `CROSS_LEVEL_LINK`, nothing written      | **written**; the edge holds the item out of the ready set like any `blocked_by`                                                          |
| `validate_work_item` (committed and `planId`-projected)    | a `cross-level-edge` ADVISORY, `valid` unmoved   | a `crossLevelEdges` entry `{ item, blockedBy, itemDepth, blockedByDepth, reason: "blocked_elsewhere", explanation }`, and `valid: false` |
| `validate_plan`                                            | not reported                                     | the same `crossLevelEdges` entry for a COMMITTED cross-level edge the plan leaves in place, and `valid: false`                           |
| the plan gate (`add_plan_items`, `validate_plan`, approve) | refused `INVALID_PLAN_REF_GRAPH` / `cross_level` | **unchanged** — the planner still may not author one                                                                                     |

`crossLevelEdges` is a sibling of `invalidEdges`, not a member of it, because the
two carry different remedies: an `invalidEdges` entry names the parents' edge
that is owed, and a cross-level edge has no such edge to owe. A cross-level edge
is never reported in both. An edge to a blocker in another project is judged on
the committed verdict only; a projection carries such a blocker without its
ancestors, so it would read a false depth.

**Case 4 changes** from _"no — re-file"_ to _"accepted, reported invalid"_. The
table above still says which edges are same-level. What moved is what happens to
an edge that is not: it is recorded and flagged, never refused, outside a plan.

**The proposal/commit asymmetry is deliberate.** A plan may not propose what the
link door accepts. The plan gate is where _"the planner should not do that"_ is
enforced, and a person linking two cards by hand, or a run recording a real
dependency it found, is not planning. The verdict keeps every such edge visible
until somebody re-wires it or accepts it. What a planner does when its own
validation reports a committed cross-level edge it cannot re-wire is not decided
here; the edge-check in the motir-ai planner (MOTIR-6412) is out of this
amendment's scope.

## Options rejected

- **(A) By kind** — the story's text. It refuses case 1 and makes case 2
  uncoverable, both shapes the grammar allows and both planners lay today. Keeping
  it means narrowing the grammar or rewriting the planners' walks around it.
- **(B) By tier of the parent** — "a child of an epic is story-level, a child of a
  story-level item is leaf-level". It answers cases 1 and 2 but needs a table for
  root items and for depth three (story → task → subtask), and each row is a new
  place for the two planners and motir-core to disagree. The position rule answers
  every row with one walk.
- **(C) By shape** — "a childless item is a leaf". An item's level would change
  when somebody gives it a child, silently turning valid edges invalid. The position
  rule changes an edge's validity only when an endpoint is **moved**, which is
  already a re-seal.

## Consequences

- **motir-core** — `lib/workItems/edgeLevel.ts` (MOTIR-6367) stops mapping kinds and
  compares the two parent chains; the plan gate, `link_work_items` (MOTIR-6369) and
  `invalidEdges` (MOTIR-6370) read that one predicate. The plan gate compares chains
  over the **projected** tree (live ⊕ proposals), which it already builds.
- **motir-ai** — `levelOfKind` / `crossLevelEdgeRefusal` (MOTIR-6357) take the two
  parent chains instead of two kinds. Where a chain is not in the session's
  grounding, the tool accepts and leaves the refusal to motir-core, as it already
  does for an unknown kind.
- **Both planners' rule text** (MOTIR-6356, MOTIR-6360) — replace _"a task, a bug
  and a subtask are all leaves"_ with the position rule and the four worked cases;
  the validation-task edge (case 1) stays as the walks already state it.
- **Story MOTIR-6015's criteria** — _"a bug `blocked_by` a subtask is accepted"_ holds
  when the two share a depth below their common ancestor (a bug under a story beside
  its subtasks, or filed per `log-bug.md` in the blocker's container); _"a subtask
  `blocked_by` a story is refused"_ holds unchanged.
- **A moved item** re-reads its edges' validity. A `move_to_parent` or a plan's
  `parentRef` change is already a re-seal (`phase-lay.md`), so no new obligation.

## What this does NOT decide

- Whether an **uncovered** cross-parent edge is refused at append or approve. It
  stays a validation verdict, as Story MOTIR-6015 scoped it.
- **Readiness** — the hard/soft block split is Story MOTIR-6354's.
- Whether the **kind-parent grammar** should be narrowed (e.g. a task never under
  an epic). This record works with the grammar as shipped.
- How the **roadmap** draws a cross-parent edge (Story MOTIR-6352).
