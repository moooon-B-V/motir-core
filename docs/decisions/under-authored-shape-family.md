# A leaf with no criteria and no sizing is an advisory, and a childless leaf is the only thing it can fire on

**Status:** accepted · **MOTIR-5427** (raised by plan-rules gate 20 and the MOTIR-4956 finding)

## Context

Plan-rules gate 20 says a work item with no acceptance criteria is unsealable,
because every criterion-level gate passes an empty list vacuously. It also names
its own mechanical gap: `overGateSizing` returns at its `executor` guard,
`likely-repo-straddle` reads the criteria for foreign paths, and a leaf that has
no executor, no numbers and no criteria is invisible to both. MOTIR-4956 sealed
`ready: true` / `valid: true` in exactly that state.

`validate_work_item` now returns a `severity: 'under-authored'` member of
`WorkItemProseShapeAdvisoryDto` for that card, from `underAuthored()` in
`lib/workItems/proseVsGraph.ts`.

## Why this is a null check and not the rejected sizing advisory

`CORPUS-MAINTENANCE.md` (the sizing-axis section, MOTIR-3566) measured a detector
for a card sized for its diagnosis and rejected it: the input was a plausible
number, and deciding whether that number was right for the card's real work is a
reading, not a match. Every candidate it tried either missed the cases or fired
on cards that were fine. This family reads no number. Its inputs are the absence
of five fields: `storyPoints`, `estimateMinutes`, `type`, `executor`, and an
enumerated criterion under an `## Acceptance criteria` heading. A column is null
or it is not, and a heading has a bullet under it or it does not. There is no
threshold to tune, no wording to match, and no plausible-but-wrong value to
judge, so the property that sank the sizing candidate (a judgement) is absent by
construction. That is also why the tier-3 rule in `CORPUS-MAINTENANCE.md` applies
here without argument: the check needs no judgement, so it is mechanised.

## Decision

**1. The family is defined over a childless typeable leaf only.** It returns
`null` when any of these hold, each pinned by a test in
`tests/workItems/proseVsGraph.test.ts`:

- the card has children (`hasChildren`): a container's points and criteria are a
  rollup of its children, so it is never under-authored in this sense;
- its kind is not typeable (`isTypeableKind`: epic and story): type and executor
  are leaf-only, and `TypeNotAllowedOnKindError` already refuses them there, so
  a bare story could never satisfy the check;
- it has `storyPoints` or `estimateMinutes`, zero included (zero is a value);
- it has a `type` or an `executor`;
- it has at least one enumerated acceptance criterion.

It fires when none of those hold, and says which half of the criteria is missing:
`no-heading` or `no-criterion` (the heading exists with nothing under it).

**2. Severity: an advisory, never a gate.** The same argument as
`over-gate-sizing-never-stops-a-run.md` applies, and the scratchpad case is
stronger here. The card is still buildable: a run can read the title and the
body, write its own criteria in the pull request, and ship. Refusing at save time
would block a person who is mid-way through writing a card, and refusing at
dispatch would turn a missing field into a stopped run for no information the
agent lacks. The advisory lands where it can be acted on: the planner sees it
through `validate_work_item`, the dispatch prompt tells the agent to proceed and
state the criteria it worked to, and the `dispatch_prompt` / `claim_next_ready`
summaries carry one line. No readiness change, no new refusal.

**3. The contract grows by an additive member.** `V1_CONTRACT_VERSION` moves to
`1.71.0` and the CLI API artifacts are regenerated, so a client that does not
know `under-authored` still parses the rest of the payload.

## Measurement: the `done` corpus

Run against the live tenant on 2026-10-18:

| Slice                                                         | Count |
| ------------------------------------------------------------- | ----: |
| `done` items                                                  | 7 906 |
| of which task / bug / subtask (typeable)                      | 7 383 |
| typeable `done` leaves with null type, points and estimate    |   181 |
| null on all three, any kind (mostly exempt epics and stories) |   698 |

The 181 is the upper bound of what could fire, because the criteria condition
cuts it further. A hand-read of six of them (MOTIR-761, 764, 775, 776, 781,
784):

- **Fire (2 of 6):** MOTIR-761 and MOTIR-764. Both are prose-only cards written
  before the criteria convention, with no `## Acceptance criteria` heading
  (`no-heading`). MOTIR-761 is a "claim" card asking for a decision; MOTIR-764
  lists what to specify under "Must specify". The advisory is correct on both: a
  reviewer could not seal either against a criterion.
- **Silent (4 of 6):** MOTIR-775, 776, 781, 784 carry the heading with enumerated
  bullets and only lack the numeric columns. They are the cards the check was
  not meant to catch, and it leaves them alone.

Extrapolating the one-in-three rate gives roughly 60 of 7 383 done typeable
leaves (0.8%). That is an estimate from a six-card sample, not a count. Nothing
evaluates a `done` card with this advisory (it is read for open work), so those
cards are unaffected; the figure only says the false-positive surface is small
and that what fires is a card with a real gap.

## Consequences

- Every bare fixture in the tests now fires the advisory, so fixtures that assert
  `advisories: []` carry `type: 'code'` on typeable kinds. This is the intended
  behaviour, and the fixture edit is the cost.
- A planner that wants the advisory silent adds a criterion, a sizing, or an
  executor, any one of which is something gate 20 already asks for.
- If a later measurement shows the 0.8% is wrong, the remedy is to narrow the
  conditions in `underAuthored()`, not to reclassify the severity.
