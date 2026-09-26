# A picked option asks to plan what the choice gates, on the choice's parent

**Status:** proposed · **MOTIR-6431** (the decision of Story **MOTIR-6069**)

**Supersedes:** MOTIR-6072's §10h `decision_choice · an option chosen` row in
[`approval-gates.md`](approval-gates.md): its anchor (_"anchored on the choice card"_) and
its offer without an ask.

**Consumed by:** MOTIR-6432 (the design) · MOTIR-6433 (the pick seed read and the anchor
resolver) · MOTIR-6434 (the pick-seeded session and its Plans row) · MOTIR-6435 (the
overlay opens a pick seed) · MOTIR-6436 (the ask, the door, the copy, the user doc, and the
§10h pointer line this record owes in `approval-gates.md`) · MOTIR-6437 / MOTIR-6438 (the
integration and E2E gates)

## Context

A choice exists because the planner stopped. The level could not be laid until a person
picked between options, so the planner laid a `type: choice` card instead, and a follow-up
planning pass is owed once the option is known.

Picking an option is shipped (§1's MOTIR-5887 amendment). **Choose {option}** runs
`decisionChoiceGateHandler.approve` (`lib/approvalGates/decisionChoiceHandler.ts`), which
writes the choice card `done` (point 6) and stamps the gate's `chosenOption`: the option's
`label`, its **Best if you want** line as `bestFor`, the body's `## What this choice gates`
as `followUp`, and the `situation` (`lib/approvalGates/choiceOptions.ts`, `ChosenOption`).

After that, nothing opens the planner. The UI says a pass is owed and stops there: the
confirm band reads _"Leave a follow-up planning pass owed: {gates}"_ and the chosen record
reads _"Follow-up planning owed — {gates}"_.

[`approval-gates.md`](approval-gates.md) §10h already promises more. Its
`decision_choice · an option chosen` row says the planner is **offered**, _"anchored on the
choice card, seeded to plan `## What this choice gates` with the chosen option"_. Two
things about that row are wrong.

1. **The anchor cannot work.** The choice card is `done` the moment the pick commits, and a
   `done` card may not be given children. The owed pass lays the next level under the
   container the planner stopped at, which is the choice card's parent.
2. **It predates the ask.** The requester ruled that a person confirms before Motir AI
   opens (on MOTIR-6206's design, 2026-09-25: _"Let the user confirm he wants to go to
   motir AI to replan the work item"_). The three decision refusals ship that ask
   (MOTIR-6211), and [`design-refusal-verdict.md`](design-refusal-verdict.md) §4 already
   amended §10f to say the band ASKS for every kind that offers the planner.

## Decision

### 1. A Choose asks, then hands off

After a **Choose** commits on a `decision_choice` gate, pressed in Motir, the decided band
asks whether to plan the follow-up with Motir AI. It is the same mechanism the refusals
ship, with its own words, because a pick plans FORWARD rather than re-planning.

- **Yes** opens the planning surface over the current page, seeded from the gate, with an
  unsent first turn.
- **Not now** (or Esc) opens nothing. The chosen record then carries a door in place of
  _"Follow-up planning owed"_. The door opens the same seeded turn, or returns to a session
  started from it while that session is recent (§10f, MOTIR-6011).
- The confirm band and the consequence line stop promising a passive owed pass.

Nothing is automatic. Nothing is spent until the person sends the turn, and what the
planner then proposes is approved like any plan.

### 2. The anchor is the choice card's parent, with two fall-backs

The server resolves the anchor when the seed is read, in this order:

1. the choice card's **parent**, when it is not in a `done`-category status;
2. else the **nearest ancestor** above it that is not `done`;
3. else the **project**, and the first turn says the choice had no open container.

Case 3 covers a root choice, a folder-filed choice, and a chain whose every ancestor is
`done`. An archived ancestor is skipped like a `done` one, and "done" means the status
**category**, never the literal key.

### 3. The first turn is built from the stamp, never from the body

The turn is composed on the server from the gate's stamped `chosenOption`, so it says
what the person actually chose even if the card's options are edited afterwards. It:

- names the choice card (key and title);
- quotes the chosen option's `label` and its `bestFor` line;
- quotes `followUp`, the card's `## What this choice gates`, verbatim;
- on a project anchor, says the choice had no open container;
- asks the planner to plan that work with this option.

It is a **plan** turn, not a re-plan. The seed is carried as a gate reference and never as
text in a URL, and a gate the viewer cannot read opens the surface unseeded, as §10f
already requires for every seed.

### 4. The session stamp accepts the resolved anchor

A session started from the turn is stamped `PlanChangeSession.seedGateId`, like a
refusal's. Today the stamp requires the gate's own work item to be one of the session's
target keys (`assertSeedApplicableWithin`, `lib/services/planChangeSessionsService.ts`).
For a pick, it accepts instead a session whose scope is the **anchor from §2**, or the
project scope (`PROJECT_SCOPE`, no target keys) in case 3.

The Plans row names the choice card as the **pick** the session came from, never as a
refusal.

### 5. None of these is unchanged

**None of these** stays a refusal. It is anchored on the choice card, re-planned from the
reason, and keeps MOTIR-6068's composer, ask and door exactly as shipped.

### 6. What the amended clause of `approval-gates.md` now reads

| clause                                                 | what it said                                                                                                              | what it now reads                                                                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **§10h**, the `decision_choice · an option chosen` row | planner: **offered** — _"anchored on the choice card, seeded to plan `## What this choice gates` with the chosen option"_ | planner: **offered, asked first** (§1) — anchored on the choice card's PARENT, else the nearest not-`done` ancestor, else the project (§2); seeded from the stamped `chosenOption` (§3); a PLAN turn |

The row's other cells (no refusal verb, no verdict, status `done`) are unchanged.

§10f needs no amendment here. Its first bullet already reads, through
[`design-refusal-verdict.md`](design-refusal-verdict.md) §4, that the band ASKS for every
kind that offers the planner. This record applies that to the pick. §10g's row
(_"opening the planner, seeded, … on a picked option"_) is unchanged.

The §10h row is not rewritten here. It gets a one-line pointer to this record, which
MOTIR-6436 adds.

## Consequences

- **A pick is followed by an offer, not a sentence.** The work a choice unblocks no longer
  waits for someone to notice the grey line, open the planner and retell the choice.
- **The seed read and the session stamp both widen, and the refusals must not.** The ask's
  and the door's refusal predicate (`isRefusalSeedGate`, read by `asksToReplanAfterPress`)
  keeps meaning _refusal_; a pick needs its own predicate beside it. How that is expressed
  is MOTIR-6433's and MOTIR-6434's.
- **The seed carries an intent.** A seed now plans or re-plans, and the overlay opens a
  forward planning launch on the anchor for a pick, or a project launch carrying the unsent
  turn (MOTIR-6435).
- **The anchor rule is per kind.** This record decides only the pick's; every other kind
  keeps the anchor §10h gives it.

## What this does NOT decide

- **The copy and layout of the ask, the door, the confirm band and the composer turn.**
  Those are MOTIR-6432's to draw.
- **What the planner proposes once the turn is sent.** That belongs to the planning
  conversation, under the shipped rules.
- **The choice gate's own mechanics** — its options, its stamp, its `done` write. Those are
  MOTIR-4914's and do not change.
- **None of these, and the three refusals.** Their seed, ask and door are MOTIR-6068's
  and are unchanged.
- **§10f's general wording.** It is MOTIR-6419's, and this record cites it rather than
  re-deciding it.
- **How the anchor walk is queried.** One ancestor read resolved through the project
  workflow is the expected shape; the resolver's code is MOTIR-6433's.
