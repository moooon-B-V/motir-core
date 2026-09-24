# The Approvals room lists decisions only — a withdrawn gate is not a record

**Status:** proposed · **MOTIR-6148** · read at `origin/main` `ede67c2b0`

**Consumed by:** **MOTIR-6261** — the design delta that strikes the withdrawn rows from the plan
design's Panel 3.

**Supersedes:** the two _Withdrawn_ bullets under _Decided records, in the Approvals room (Panel 3)_
in `design/ai-planning/design-notes.md` Part XXII § 22.3 (MOTIR-6033), and the two withdrawn rows
Panel 3 of `design/workbench/approvals-row--plan.mock.html` draws (published on MOTIR-6033, evidence
`cmueg6bue00kghwoikl5e6bxp`). Both are **named here as amended**. Neither file is edited by this
record; MOTIR-6261 carries the edit.

## Context

Two approved designs disagree about one screen.

- **The room's design says a withdrawn gate is never listed.**
  `design/approvals/design-notes.md` § _`superseded` is NOT in the room, in either view_
  (MOTIR-5300, merged 2026-09-15 in #2909) gives four reasons:
  1. It is not a record of a decision: nobody decided it.
  2. It is not pending either, so neither section is true for it.
  3. The question it withdrew is still in the room, as the newer gate that superseded it.
  4. Nothing records _when_ it was withdrawn: `decidedAt` is null and `updatedAt` is not an audit
     column.

  The notes add that every design republish writes one, so withdrawn rows would outnumber real
  decisions.

- **The shipped room follows it.** `approvalGateRepository` `recordsDecidedWhere`
  (`lib/repositories/approvalGateRepository.ts`) selects
  `approved · changes_requested · overturned · declined` and orders by `decidedAt desc`. Its
  docblock says `superseded` is left out on purpose, citing the design above. The `ApprovalGate`
  model has no withdrawal timestamp.

- **The plan-approval design says a withdrawn plan IS listed.** MOTIR-6033's Part XXII § 22.3 and
  its mock's Panel 3 draw two records, `plan_stale` and `plan_discarded`, each with the colourless
  _Withdrawn_ pill and its cause sentence. That design never cites the room's rule, so it neither
  follows nor amends it. MOTIR-6037, which built the plan rows, built the _Declined_ records and
  left the withdrawn ones out, because a rule about the room is not one kind's card to change.

One thing is different for plans: **reason 3 does not hold.** A design or pull-request question is
withdrawn because a newer question replaced it, and that newer gate is in the room. A plan's
question is withdrawn when the plan goes out of date (`plan_stale`) or every proposal is withdrawn
(`plan_discarded`) — `lib/services/planGateService.ts` — and nothing replaces it.

And one fact about today: the two cause sentences
(`approvalGate.withdrawn.cause.plan_stale` / `plan_discarded` in `messages/*.json`) are
**rendered nowhere a person meets a plan.** The only components that render any
`withdrawn.cause.*` sentence are `ApprovalGateControl`, `ApprovalOverlay` and
`DevelopmentGateFrame` (with `withdrawnMergeCopy`), and none of them is on `/plans`, `/plans/<id>`
or the planning surface. A plan that went stale shows as `stale` in the plan list
(`app/(authed)/plans/_components/SessionRow.tsx`).

## Decision

**The Approvals room stays a list of decisions. A withdrawn gate of any kind, a plan included, is
not listed there, in either view.** MOTIR-5300's rule stands, and MOTIR-6033's Panel 3 is amended to
match it.

**A withdrawn plan is met where the plan is**, on the planning surfaces (`/plans`,
`/plans/<id>`), not in the room. Because reason 3 fails for plans, this is not optional: the room's
rule is only safe for plans if the planning surface is where a person actually finds out. _Where_
and _how_ it says so there, and whether it uses the catalogued cause sentence, is MOTIR-6261's to
draw.

## Why

- **The room is a record of what people decided.** Its name, its two sections (_Awaiting a
  decision_, _Decided_), its read, its index and its empty states are all built on that. A withdrawn
  row beside a decision lets a reader believe something was decided when it was abandoned, which
  makes the room less trustworthy than having no room.
- **Three of the four reasons hold for plans unchanged.** Nobody decided it, it is not pending, and
  there is no true time to sort it by.
- **The one reason that fails is answered by where the plan lives, not by the room.** The person who
  needs to know a plan went stale is the one looking at plans. That is also where a re-plan starts.
- **It costs nothing that is shipped.** The room already behaves this way, so no code changes.

## The alternative rejected

**List withdrawn gates in the room, for every kind.** It cannot be done for plans alone, because the
room's rule is about the room, not a kind. So it would need:

- a withdrawal timestamp on `ApprovalGate` (a new audit column plus a backfill that cannot know the
  real time for existing rows);
- a third row state in both views, with its own words and pill;
- an amendment to MOTIR-5300's design.

It would then fill the room with rows that mostly say "a newer version was published". Rejected: it
is a lot of work to make the room noisier, and it answers a plan-only gap with a change to every
kind.

## Consequences

- **MOTIR-6261** publishes a design delta: Panel 3 without the withdrawn rows, and a notes section
  that amends Part XXII § 22.3's two _Withdrawn_ bullets and records where a withdrawn plan is met
  today. If that design places the cause sentence on a planning surface, the code for it is a card
  MOTIR-6261 proposes.
- **`recordsDecidedWhere` does not change**, and neither do its tests.
- **The `plan_stale` / `plan_discarded` copy stays catalogued.** It is not retired here: the
  consuming design decides whether it is used.

## What this does NOT decide

- **The pixels** of how a stale or discarded plan is shown on `/plans` or `/plans/<id>`: that is
  MOTIR-6261's design.
- **Whether the plan cause sentences are used or retired**: that follows from MOTIR-6261.
- **Anything about the other gate kinds' frames, tabs or overlays**, where the _Withdrawn_ pill
  already renders for a gate you can meet. Those stay as they are.
- **The To-approve row** (Part XXII's other panels), which this record does not touch.
- **The `design/workbench/design-notes.md` § 29 pointer to Part XXII**, which is MOTIR-6214's.
