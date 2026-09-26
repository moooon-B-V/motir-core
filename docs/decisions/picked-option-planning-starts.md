# A picked option's yes starts the follow-up planning

**Status:** proposed · **MOTIR-6455** (a decision under Epic **MOTIR-6010**, for Story
**MOTIR-6069**)

**Supersedes:** MOTIR-6431's two clauses in
[`picked-option-planning.md`](picked-option-planning.md) that keep a pick's first turn
unsent:

- §1 _A Choose asks, then hands off_: _"Yes opens the planning surface over the current
  page, seeded from the gate, with an unsent first turn"_, and its closing _"Nothing is
  automatic. Nothing is spent until the person sends the turn"_;
- §3 _The first turn is built from the stamp, never from the body_, where the turn is the
  pre-filled, unsent draft the person sends.

The rest of that record stands: the anchor (§2), what the turn is made of (§3), the session
stamp (§4), None of these (§5) and the §10h row (§6).

**Consumed by:** MOTIR-6432 (the design: the planner shown already started, with the turn
shown as sent) · MOTIR-6433 (the pick composer's follow-up line) · MOTIR-6435 (the overlay
sends the pick's turn once) · MOTIR-6436 (the ask's copy says the planning starts) ·
MOTIR-6438 (the E2E has no manual send)

## Context

[`picked-option-planning.md`](picked-option-planning.md) (MOTIR-6431) lets a **Choose** on
a `decision_choice` hand over to the planner. It copied one property from the three
refusals' hand-over (MOTIR-6068): the first turn opens in the composer pre-filled and
**unsent**, and nothing happens until the person presses Send.

For a refusal that property is right. The turn quotes the refusal's reason, which is the
person's own words, and they may want to reshape it before the planner reads it.

For a pick it is not. Every part of the turn comes from the decision the person just made:
the choice card, the option's label and its **Best if you want** line from the stamped
`chosenOption`, and the card's `## What this choice gates`. There is nothing in it for them
to add. They already confirmed twice, once by pressing **Choose** and once by pressing yes
on the ask. The unsent turn asked a third time.

The requester returned the design to that effect (MOTIR-6432's design gate, 2026-09-26):
_"The planner doesn't need more input from the user, the planning can start. The user
should not need to send an extra message."_

Today's code only knows the pre-filled case. A seeded turn reaches the composer as
`initialDraft` (`components/planning/PlanChangeRail.tsx`) and is written only when the
person sends it, through `planChangeSessionsService.startSeededWithFirstTurn`. That method
already resumes the member's recent session seeded by the same gate rather than starting a
second one, and the seed read already returns that session as `seededSessionId`.

## Decision

### 1. Yes starts the planning

After a **Choose** commits, pressed in Motir, the decided band still **asks** whether to
plan the follow-up with Motir AI. That ask stays because the requester's ruling that a person
confirms before Motir AI opens (on MOTIR-6206's design, 2026-09-25) still holds, and
the ask's yes meets it.

**Yes starts the planning.** The planning surface opens over the current page on the
resolved anchor ([`picked-option-planning.md`](picked-option-planning.md) §2). The pick's
first turn is **sent** as the person's first message, and the planner begins working on it
at once. The person is never asked to send, edit or confirm the turn.

The turn is visible in the conversation as their first message, exactly as a turn they had
typed and sent would be, so what the planner was asked stays readable.

### 2. The turn is sent once

The turn is sent only when the seed read reports no session seeded by this gate
(`seededSessionId` is null). When there is one, the surface **resumes** it and sends
nothing. A reopen, a second press of the door, or a reload never sends the turn a second
time.

### 3. The door does what yes does

**Not now** (or Esc) opens nothing, and the chosen record carries the door in place of
_"Follow-up planning owed"_. The door does exactly what yes does: it starts the planning
with the turn sent, or returns to the session the pick already started while that session
is recent (§10f, MOTIR-6011). By §2, it never sends the turn twice.

### 4. The yes is the consent to spend

The first turn costs AI credits the moment it is sent. The **yes** on the ask, or the press
of the door, is the person's consent to that spend. The ask says the planning starts right
away (its copy is MOTIR-6436's) so the consent is informed. Nothing is spent on a
**Choose** alone, on **Not now**, or on a gate decided on GitHub, which asks nothing.

What the planner then proposes is approved like any plan. Starting the conversation
approves nothing.

### 5. The refusals keep their unsent turn

**None of these**, **Request changes** on a decision and **Overturn** are unchanged. Their
first turn stays pre-filled and **unsent**, because it carries the refusal's reason, which
is the person's own input.

The discriminating question for any seeded hand-over, now and later, is whether the seeded
turn needs anything from the person that they have not already given. A refusal's does. A
pick's does not.

## Consequences

- **A pick's hand-over is one confirmation.** The person presses **Choose**, then yes, and
  the planner is working.
- **The overlay gains a send path for a seed.** It sends a `plan`-intent seed's turn itself
  when the seed read reports no seeded session, and resumes that session otherwise
  (MOTIR-6435). The pre-filled path stays for a `replan` intent.
- **The seed's intent decides the behaviour.** `plan` sends, and `replan` pre-fills. It is the
  field MOTIR-6433 put on the seed DTO, so no new signal is needed to tell the two apart.
- **The design and the E2E change with it.** The design shows the planner already started
  with the turn shown as sent (MOTIR-6432), and the E2E has no manual send (MOTIR-6438).

## What this does NOT decide

- **The copy and layout of the ask, the started planner and the door.** Those are
  MOTIR-6432's to draw and MOTIR-6436's to ship.
- **How the send-once rule is enforced.** Reading `seededSessionId` before sending is the
  expected shape. The code, and any server-side guard beside it, are MOTIR-6435's.
- **The anchor, the turn's parts and the session stamp.** Those stay as
  [`picked-option-planning.md`](picked-option-planning.md) §2–§4 decide them.
- **What the planner proposes.** That belongs to the planning conversation, under the
  shipped rules.
- **Any other seeded hand-over.** This record decides only the pick's. §5's question is
  the test a future hand-over applies, not a change to one.
