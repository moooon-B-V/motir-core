# An over-gate-sized card is a warning everywhere, and never stops a run

**Status:** accepted · **MOTIR-5372** (raised by MOTIR-4276's criterion 3, from the MOTIR-5204 sweep) · implemented by **MOTIR-5950**

## Context

`validate_work_item` returns a `likely-over-gate-sizing` shape advisory when a
childless `coding_agent` card is sized over the estimation gate
(`lib/workItems/proseVsGraph.ts` `overGateSizing`). There are two arms:

- **points:** `storyPoints >= ESTIMATION_GATE_STORY_POINTS`, which is **8**;
- **minutes:** `estimateMinutes > 70`, a proxy for the one-hour agent run.

The question was whether the POINTS arm, at the scale's split value, should stop
being an advisory and become a hard refusal when a card is saved. The case for
it was MOTIR-4201. That card was saved at 13 points and 240 minutes, with a body
that said "do not dispatch it as one card". It stayed `ready: true` for a day,
and the run caught it at dispatch.

Tracing the advisory's readers showed where it actually lands:

| Surface                                                 | Reads the advisory?                                               | What it did on an over-gate card                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| motir-meta planner (`plan-procedure.md`)                | yes, via `validate_work_item`                                     | dispose of it (gate 21)                                            |
| motir-ai planner                                        | **no** (its closing check is `validate-plan`, finishability only) | nothing; its `author` tool only checks that sizing is present      |
| `motir` CLI binary                                      | no; gates on status + readiness only                              | dispatches                                                         |
| dispatch prompt (`lib/dispatch/promptTemplate.ts`)      | yes                                                               | "split it before you start… Propose the split and STOP"            |
| `dispatch_prompt` / `claim_next_ready` summaries        | yes                                                               | "Split it before starting" / "SPLIT it rather than starting a run" |
| `motir run` skill (`motir-meta/prompts/run.md` guard 4) | yes, via `validate_work_item`                                     | the replan action, and the run stops                               |

So the run side already refused, in words addressed to the agent. That is what
stopped MOTIR-4201.

## Decision

**1. At authoring: leave it as an advisory.** There's no refusal when a card is
saved, no readiness change, and no new check in the motir-ai or motir-meta
planner. The planning rules already give the size. If a planner is later shown
to break them, that evidence is the trigger for a check, not the possibility of
it. The motir-meta planner has a single user, who reports bad outcomes directly.

**2. At run time: never stop a run because of size.** An over-gate card is built.
The agent states the sizing warning in its run report and proceeds. This reverses
the run-side wording in the table above: the dispatch prompt, both MCP summaries,
and `run.md`. MOTIR-5950 carries that change.

The reason, in the product owner's words: _"I don't think we should ever stop a
run because the task is estimated too large, a non technical user won't even
understand why it's too large and that's stucked there."_ A size is an estimate.
A card that sits stuck with a sizing reason is a dead end for a lay user, and a
large pull request is recoverable while a stuck card is not.

The other shape advisories (the ordering cut, the repo straddle, the
self-blocking design) keep their remedies. They describe something wrong with
what the card says, not how big someone guessed it was.

### Containers

Containers are out of scope already, and stay out. `overGateSizing` returns
`null` for any card that has children, because a story's or epic's points are a
rollup of its children and a large total is normal. It also returns `null` for
any executor other than `coding_agent`.

### `CORPUS-MAINTENANCE.md`'s third tier

The third tier says that when a check needs no judgement, the remedy for it not
firing is to mechanize it rather than sharpen the prose. A points value compared
with a constant qualifies, so the tier **applies in principle**. It is **not
acted on**: the check already exists in code (`overGateSizing`), and what was
proposed was making it block. This decision rules out blocking on size at any
point. Adding a second mechanical check in a planner waits for evidence that the
planner breaks the rule.

## Consequences

- MOTIR-5950 rewords the three motir-core run surfaces and `run.md` to
  warn-and-build, and records this verdict beside `sizingAdvisory`, where the
  next reader of the advisory will look.
- MOTIR-5373 (an advisory for a card whose body instructs its own split) is
  cancelled. It asked for another re-check of a rule the planners already carry.
- `validate_work_item`'s planner-facing summary still says the remedy is to
  split. That's still true at planning time, where splitting costs nothing.
