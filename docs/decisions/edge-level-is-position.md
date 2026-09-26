# What "the same level" means for a `blocked_by`: the item's position, not its kind

**Status:** proposed · **MOTIR-6387** (the level-model decision of Story **MOTIR-6015**) ·
consumed by MOTIR-6356, MOTIR-6357, MOTIR-6360, MOTIR-6367, MOTIR-6369, MOTIR-6370

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

| case                                      | edge                                                           | same level?                              | parents' edge owed                                                                             |
| ----------------------------------------- | -------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1 · validation task T under epic E        | T `blocked_by` story S under E                                 | **yes** — both depth 1 under E, siblings | none                                                                                           |
| 2 · subtask X under task T under E1       | X `blocked_by` subtask Y under story S under E1                | **yes** — depth 2 / 2 under E1           | T `blocked_by` S                                                                               |
| 2b · the same, S under another epic E2    | X `blocked_by` Y                                               | **yes** — depth 3 / 3 under the root     | T → S and E1 → E2                                                                              |
| 3 · subtask X under task T under story S1 | X `blocked_by` subtask Y under story S2 (same epic)            | **no** — depth 3 / 2                     | — the need is T `blocked_by` Y (depth 2 / 2), or X is re-filed                                 |
| 4 · a root bug B in a folder              | B `blocked_by` subtask Y                                       | **no** — depth 1 / 3 under the root      | — per `log-bug.md` an edged bug is filed in Y's runnable container, where B and Y are siblings |
| 4b · a root task R holding subtasks       | subtask X under R `blocked_by` subtask Y under story S under E | **no** — depth 2 / 3 under the root      | — file R under E (then it is case 2)                                                           |
| 5 · a root task R (Amendment 1)           | R `blocked_by` epic E                                          | **no** — an epic pairs only with an epic | — file R under E, or wire it to the item under E it really waits on                            |

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
ahead of the depth comparison, so the plan gate (`cross_level`), `link_work_items`
(`CROSS_LEVEL_LINK`), the `cross-level-edge` advisory and `invalidEdges` all apply
it. Each end's kind comes from the reads those callers already make. Walking up
through `invalidEdges`' parents always stops at an epic ↔ epic pair.

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
