# The dispatched path's run-found trigger — the shipped planner computes it, and the bug lands in Motir's planner-bug home

**Status:** proposed · **MOTIR-6226** (story MOTIR-5544) · read at `motir-core` `origin/main`
`534eca4e2` and `motir-ai` `origin/main` `6d98693`

**Extends** [`run-findings-protocol.md`](run-findings-protocol.md) **Q3** (_Where a run-filed bug
is parented_), **Q5** (_How the RUN RECORD points at the bug it filed and the plan it submitted_)
and **Q6** (_The submit is a TOOL CALL, and the agent COMPOSES the WHAT_). That file is not
edited. Every answer below keeps what those three sections decided.

## Context

MOTIR-5544 makes a run that finds its card unbuildable ask one more question: **is the card
still what the last approved plan approved?** The server computes the answer as a verdict,
`unchanged | changed | no_plan` (MOTIR-6225). Only `unchanged` files a planning bug. On the
runbook path the runbook reads the verdict itself (MOTIR-6227, MOTIR-6231). On the product
path, the dispatched agent is deliberately kept out of the question:

- **Q3** keeps the agent's bugs out of the planner-bug home, and the home is out of reach of
  `CLI_TOKEN_GRANT` anyway.
- **Q6** has the agent append one turn and call `submit_plan_session` ONCE, anchored at
  `targetKeys: [<KEY>]`, and exit. It is told not to classify: _"Q3's reasoning holds one step
  over: an agent asked to classify invents."_
- **Q5** has the SERVER record `plan_submitted` on the run's leg
  (`plansService.recordSubmittedPlanFinding`).

That leaves two questions this record settles: **(a)** who computes the verdict and files the
bug when a dispatched agent refuses its card, and **(b)** where that bug lands when the tenant
is a customer's.

## Decision

### (a) The shipped planner computes it — option 1

The planning job that `submit_plan_session` starts is where the verdict gets read. That job
is motir-ai's one planning handler (`src/jobs/handlers/plan.ts` → `runPlanningJob` in
`src/jobs/planningEngine.ts`). It reads the verdict through an internal AI route (MOTIR-6228),
and on `unchanged` it files through `log_planning_bug`. That handler already starts at exactly
the moment a dispatched agent refuses a card. Every run already includes
`buildLessonCaptureSink`, which holds `log_planning_bug`. MOTIR-5543 added the rest of the
classification machinery to the same engine: the branch-carrying bug (MOTIR-6085), the
whole-corpus rule search (MOTIR-6093) and the internal record (MOTIR-6083, written by
MOTIR-6088's pass). **Plain code decides the branch, and the model decides nothing about the
verdict** (MOTIR-6230).

- **Option 2 is refused. It was a `motir-core` listener on `plan_submitted`.** It would add a
  second bug-filing path, a second resolver for the planner-bug home and a second set of
  evidence rules, one repository away from the set motir-ai already has. That gives one rule
  two homes, which `core.md` gate 19 exists to prevent. The event also arrives too late (see
  _The run-submitted discriminator_ below).
- **Option 3 is refused. It would have the dispatched agent classify or file.** That
  **reverses Q3 outright**, and Q6 too: the agent would be asked the one question both
  sections keep from it, and would need a credential Q3 says it must not hold.

### (b) The bug lands in Motir's own planner-bug home, with the plan's author recorded on it

**This departs from the card's recommendation (A).** A run-found planning bug from ANY tenant
goes where `log_planning_bug` sends every planning bug today. That is
`lessonService.filePlanningBug` → `createBug` with `projectKey: META_PROJECT_KEY` (`MOTIR`),
as the Motir system principal, `parentKey` `@planner-bug-home`. `aiWorkItemsService.fileBug`
then resolves that through `bugDestinationService.resolvePlannerBug`. The bug body is
sanitized under that tool's own mandate (_"sanitized; never the customer tenant"_). It also
carries the **approving plan's author triple**: `Plan.authorSource`, `authorHarness` and
`authorModel`, as stored (null included). A triager reads them to tell Motir's own generator
(`native`) from an agent holding a workspace PAT (`mcp`) or any other author.

**The evidence that overturned A.** The card cited `aiWorkItemsService.filePlannerBug` as
proof that the shipped code already files into the tenant's own planner-bug destination. It
does not. `filePlannerBug` is the sink for **`log_bug`**, which files a PRODUCT defect into
the job's own project, and with no parent it resolves `bugDestinationService.resolve`, the
product bug folder, not `resolvePlannerBug`. **`log_planning_bug` is the planning-bug sink,
and it files into Motir's project and never into the customer's**
(`src/jobs/lessonCaptureSink.ts`, `src/services/lessonService.ts` `filePlanningBug`, MOTIR-1460).
motir-ai's `docs/decisions/planner-files-tenant-bug.md` §2b sets the two apart on purpose:
a wrong planning bug is _"a card **we** cancel, in a click. Never seen by a customer"_. A
wrong `log_bug` is _"a false defect in **someone else's** backlog"_.

- **A is refused. It would put the bug in the tenant's own planner-bug destination.** Nothing
  shipped does that. It would need a third sink, and it would reverse the §2b split for one
  trigger. A customer cannot fix Motir's planning rules, so it would pass the triage cost to
  the one party that cannot act on the bug.
- **B is refused. It would file only when `authorSource` is `native`.** It silences every
  plan written with a workspace PAT (`mcp`), and that includes how Motir plans Motir. The
  author triple on the bug makes the same cut at triage without losing the signal.
- **C is refused as the card framed it, and the shipped channel is not C.** C was
  _"somewhere Motir can read across tenants"_. Nothing here reads across a tenant. The pass
  is already that tenant's planner. It WRITES one sanitized record outward through the single
  route MOTIR-1460 pinned to Motir's own workspace, and that route cannot target a customer
  project. The same channel already carries every trigger-1 bug from MOTIR-6088's pass. This
  record adds a trigger to it and does not widen it.

### The run-submitted discriminator — the leg that was open at SUBMIT, not at read

**The card recommended the OPEN DISPATCH LEG. That is adopted as the fact to read, but it is
corrected on WHEN to read it,** because by the time the pass reads, the leg is usually closed:

1. `submit_plan_session` returns `{ jobId, planId }` **immediately**. It opens a `generating`
   `Plan` bound to the job (`planChangeSessionsService.submit`) and does not wait for the
   planner (`lib/mcp/tools/planSession.ts`).
2. The agent then exits. The CLI settles the leg with `disposition: 'replanned'`, which stamps
   `endedAt` (`packages/cli/src/dispatchLeg.ts` → `dispatchRunService` event ingest), and
   `motir run` and `motir next` close the run (`packages/cli/src/commands/dispatch.ts`,
   `reporter.close('replanned')`).
3. `dispatchRunCardRepository.findOpenLegForWorkItem` requires `endedAt: null` AND a
   `running` run. A pass that asks it minutes later finds nothing, and would call a real run
   a person's re-plan.

**The rule the pass applies (read through MOTIR-6228's route, from shipped rows only):** a
session is RUN-SUBMITTED when all three of these hold:

- its `origin` is `conversation`;
- its `scopeKey` names exactly ONE anchor, which is Q6's `targetKeys: [<KEY>]` shape and the
  same filter `recordSubmittedPlanFinding` applies;
- a `DispatchRunCard` for that anchor was open at the instant this job's plan was created:
  `startedAt <= plan.createdAt` and (`endedAt IS NULL` or `endedAt >= plan.createdAt`).

No field is added to `PlanChangeSession`. The leg serves, once it is read against the moment
of submission rather than the moment of reading. Every value in the test is written once and
never moved: `Plan.createdAt`, and the leg's `startedAt` and `endedAt`. Q5 rejected this kind
of read-time lookup for the run RECORD because tree edits move its answer. That objection
does not reach this test.

**When it cannot tell, the answer is NOT run-submitted.** That covers no such leg, a deleted
anchor, a project-wide or multi-anchor scope, and an unreachable route. Then the pass files
nothing under this trigger and records which of these arms it took (MOTIR-6230). This is
Q5's own posture: _"No open leg means no event, and that is not an error."_ One gap is named
rather than closed. A person who submits on the same card while a run holds it is counted as
run-submitted. Q2's B1 accepts the same gap for the same reason: the card is held out of the
ready set the whole time.

The agent's own refusal writes (the comment, the move to `planning`) are not a CHANGE under
MOTIR-5544's definition, so refusing does not turn its own verdict into `changed`.

### The dispatch prompt is unchanged

The agent classifies nothing and is asked nothing new. `lib/dispatch/promptTemplate.ts`,
`cardIsWrongSteps` included, is not touched. Its own doc comment already states the reason:
_"an agent asked to classify invents"_. The classification runs on the SERVER side of the
seam, where Q5 already put the observation.

### `--auto-approve-replan` changes nothing

Q4 and Q2's B1 limit **who may APPROVE** the plan a refusal produced. They do not limit
whether a finding is recorded. The verdict is read and the bug filed inside the planning
pass, before the plan reaches `planned` and so before the `auto` loop can approve it. The
refused card is held out of the same run either way (B5). So the verdict, the filing and the
destination are identical with or without the flag.

## Consequences

- motir-ai is the only home of trigger 2's behaviour on the product path, and `motir-core`
  gains only the read route (MOTIR-6228). The rule text lives in `SHARED_PLANNING_RULES`
  (MOTIR-6229), with no `MIRROR.md` narrowing.
- Customer tenants see nothing new. Motir's planner-bug home gains run-found bugs from every
  tenant, each carrying its author triple and sanitized under `log_planning_bug`'s existing
  mandate.
- **Named as amended, not edited here:**
  - MOTIR-6230 criterion 3 (_"no open dispatch leg for the target"_) and its Approach line on
    the open leg. The test is now the open-at-submit window above.
  - MOTIR-6230's context ref to `filePlannerBug` _"and where the bug lands"_. The bug lands
    through `log_planning_bug`.
  - This card's recommendation (b) = A and its `filePlannerBug` evidence.

  Each edit rides its consuming card.

## Consumed by

- **MOTIR-5544**: criterion 3, the dispatched path behaves as this record says.
- **MOTIR-6228**: the internal AI route returns the verdict and the run-submitted answer
  above.
- **MOTIR-6229**: the run-found rule in `SHARED_PLANNING_RULES`, carried by the shipped
  planner.
- **MOTIR-6230**: the deterministic branch, `log_planning_bug` on `unchanged` with the author
  triple, and a record on every arm.
- **MOTIR-6232 / MOTIR-6233**: the gates, including _the dispatch prompt still asks the agent
  to classify nothing_ and _a person-opened re-plan takes neither branch_.

## Supersedes

None. This record **extends** `run-findings-protocol.md` Q3, Q5 and Q6 and supersedes none
of them. It also leaves motir-ai's `planner-files-tenant-bug.md` §2b and MOTIR-1460 as they
stand.

## What this does NOT decide

- **When** a run judges a card unbuildable. The existing guards and the card-is-wrong
  branch keep that.
- **What counts as a CHANGE.** MOTIR-6225's verdict owns it.
- **Whether `log_planning_bug`'s LLM-judged sanitization should become a deterministic
  scrubber.** MOTIR-1443 left that as future work, and it stays there.
- **Whether a `non-native` customer plan's bug should be routed or filtered at triage.** The
  author triple makes that possible, and doing it is the sweep's business.
- **Q5's own `plan_submitted` timing**, which has the same late-read shape. It is reported
  separately and is not fixed by this record.
