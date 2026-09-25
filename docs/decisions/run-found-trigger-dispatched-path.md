# The dispatched path's run-found trigger — the runner reports to a motir-core endpoint, and only a motir-ai plan files a planning bug

**Status:** proposed, rewritten to the reviewer's direction (decision gate `changes_requested`,
2026-09-25) · **MOTIR-6226** (story MOTIR-5544) · read at `motir-core` `origin/main` `e1aeac8ac`
and `origin/parent/MOTIR-5544-run-found-verdict` for the verdict (MOTIR-6225, not yet on main)

**Extends** [`run-findings-protocol.md`](run-findings-protocol.md) **Q3** (_Where a run-filed bug
is parented_), **Q5** (_How the RUN RECORD points at the bug it filed and the plan it submitted_)
and **Q6** (_The submit is a TOOL CALL, and the agent COMPOSES the WHAT_). That file is not edited.

## Context

MOTIR-5544 makes a run that finds its target unbuildable ask one more question: **is the target
still what the last approved plan approved?** The server answers it as a verdict,
`unchanged | changed | no_plan` (`plansService.resolveApprovedShapeVerdict`, MOTIR-6225). Only
`unchanged` blames the planner. On the product path the dispatched agent is kept out of that
question on purpose: **Q3** keeps its bugs out of the planner-bug home, **Q6** has it compose
what is wrong with the CARD and submit once without classifying (_"an agent asked to classify
invents"_), and **Q5** has the SERVER record `plan_submitted` on the run's leg.

The first version of this record gave the question to the shipped planner (motir-ai), read
through an internal route. The reviewer rejected that and set the direction below.

> 1. there's a precondition, the plan needs to be made by motir-ai, the plan made by MCP planner
>    will never fire a planning bug
> 2. the shipped planner -- motir-ai won't be involved in this process. We change the runner
>    prompt to let the runner call an endpoint when stop the run -- unbuildable, the endpoint
>    will collect the data -- the plan, the run target (sent by the runner), why can't not run
>    (sent by the runner) then compose the planning bug, we will debug using those information
>    later

Two findings from the first version still hold. They are kept because the direction depends on
them:

- **Planning bugs file into Motir's own planner-bug home, never into the customer's project.**
  motir-ai's `log_planning_bug` files through `lessonService.filePlanningBug` into
  `META_PROJECT_KEY` with `parentKey` `@planner-bug-home` (MOTIR-1460; motir-ai
  `planner-files-tenant-bug.md` §2b: a wrong planning bug is _"a card **we** cancel … Never seen
  by a customer"_). `aiWorkItemsService.filePlannerBug` is `log_bug`'s sink, which files a
  product defect into the job's own project, so it does not serve here.
- **The leg is closed before anything downstream reads it.** `submit_plan_session` returns at
  once, the agent exits, and the CLI settles the leg `replanned` and closes the run
  (`packages/cli/src/dispatchLeg.ts`, `commands/dispatch.ts`). A reader that comes later finds no
  open leg (`dispatchRunCardRepository.findOpenLegForWorkItem` needs `endedAt: null` on a
  `running` run). That is reported separately as MOTIR-6279.

## Decision

### (a) The actor: a motir-core endpoint the runner calls once, when it stops on an unbuildable target

**The dispatched runner calls one new motir-core endpoint at the moment it stops because its
target is unbuildable. The runner sends the target key and why it cannot run it. The server
resolves the plan, reads the verdict, and composes and files the planning bug. motir-ai takes no
part.** Option 1 (the shipped planner reads the verdict and files) is not taken, because the
reviewer directed otherwise. MOTIR-6228's internal route and the motir-ai pass have no job left
to do.

- **Where it lives.** It is an MCP tool on motir-core's `/api/mcp`, working name
  `report_unbuildable_target`, over one new service method. The runner reaches motir-core only
  through that MCP server, and every other step of the card-is-wrong lane is already a tool call.
  Q6 point 1 chose the MCP tool as the door for the same reason. A `/api/v1` mirror is not needed
  because nothing but the runner calls it.
- **Its key: `work_item:edit`.** `CLI_TOKEN_GRANT` (`lib/mcp/toolPermissions.ts`) already carries
  that key, so **the grant is not widened**. `POST /api/v1/dispatch-runs/{id}/events` asserts the
  same key for the same kind of write, which is a run recording what happened on its leg. It is
  deliberately not `ai:view_plan`. The runner reads nothing back: the tool returns an
  acknowledgement only, never the verdict, the plan or a bug key. The service computes the verdict
  beneath `resolveApprovedShapeVerdict`'s `ai:view_plan` assertion, so that gate is not
  laundered: what the gate protects never reaches the caller.
- **Timing fixes the leg.** The runner calls while it is still running, so the leg is open. The
  server resolves it with `findOpenLegForWorkItem` in the caller's own tenant. If there is no open
  leg (a call from outside a dispatch), the server records and files nothing and says so in the
  acknowledgement. MOTIR-6279's late-read problem cannot reach this trigger.

### The precondition: only a plan motir-ai made fires a bug

**The server reads `Plan.authorSource` (`prisma/schema.prisma`, enum `WorkItemPlanningSource`
`native | mcp | manual | api`) on the approving plan. A bug is composed only when it is
`native`.** This field is written by the server and never taken from the caller. `native`
(with `authorHarness: 'Motir'`) is written only on the two paths that hand the tree to motir-ai
to write: `aiGenerationService` (`lib/services/aiGenerationService.ts`) and `aiPlanEditsService`
(expand, augment, replan and contextual submits, plus the cadence watcher). `mcp` is written by
the `create_plan` MCP tool (`lib/mcp/tools/authorPlan.ts`). **A plan with `mcp`, or any value
other than `native`, never fires a bug.** A `null` from before MOTIR-2996 does not fire either.
This is the strict reading, and the reviewer can relax it to `sourceJobId != null`.

**The verdict (recommended, the reviewer can overrule): file only on `unchanged`.** That is the
story's premise: a target edited after approval (`changed`) or never shaped by a plan
(`no_plan`) is not the planner's defect. The verdict and its diverging revision are recorded on
every arm, on the leg and on the bug when one is filed. The order is: no open leg → nothing;
`no_plan` → record; approving plan not `native` → record; `changed` → record; `native` and
`unchanged` → record and file.

### Which plan, and where the bug lands

**"The plan" is the last approved plan that shaped the target, and the server resolves it.** It
is the verdict's approving plan (the latest `approved` entry of `listPlanHistoryForWorkItem`).
The runner never names a plan.

**There is one destination: Motir's planner-bug home.** A defect in Motir's planner is Motir's
defect in every tenant. The service resolves the system principal (`resolveSystemPrincipal`,
`lib/ai/serviceAuth.ts`) and calls `aiWorkItemsService.fileBug` with
`projectKey: metaProjectKey()` and `parentKey: PLANNER_BUG_HOME_MARKER` (`@planner-bug-home`,
`lib/ai/plannerBugHome.ts`). That call resolves `bugDestinationService.resolvePlannerBug`, and
the bug is filed into the `Bugs / Planning bugs` folder. It is the same in-process pattern
`dlqStandingDepthService.fileOne` already uses to file into the meta project as the system
principal.

**When the tenant is a customer's, no tenant is read from another.** Every read runs in the
caller's own workspace under its own request context: the target, the leg, the plan and the
verdict. Then ONE record is written outward to Motir's project, which is the direction MOTIR-1460
and §2b already allow. No LLM takes part, so sanitizing is a fixed allowlist rather than a
judgement:

- **Motir's own workspace** (the caller's workspace is the system principal's). The bug carries
  everything verbatim.
- **A customer's workspace.** The bug carries only ids, enums, timestamps and field names. It
  carries no titles, no card keys and no runner text. The runner's reason and the plan title stay
  in the customer's tenant, on the leg's finding event. The bug points at them by workspace id
  and leg id.

**What the bug carries:** the plan id and title; the shaping proposal id (the verdict's
`proposalId`); the run target key; the runner's stated reason, verbatim; the verdict, and on
`changed` the diverging revision (id, `changeKind`, `changedKeys`) or the container's child-set
delta; the plan's author triple (`authorSource`, `authorHarness`, `authorModel`); and the
dispatch run id and leg (`DispatchRunCard`) id. In a customer tenant, the title, key and reason
are replaced by the pointer described above.

**Idempotency: one bug per stopped leg, keyed by the `DispatchRunCard` id.** A filing row that is
unique on the leg id is inserted and locked before the create, following the
`job_dlq_standing_filing` pattern. A retried call finds the row and returns its first outcome.

### The prompt change, and why it does not reopen Q3

**In `lib/dispatch/promptTemplate.ts`, `cardIsWrongSteps` gains one call, placed right after
step 3's comment. It is added in both lanes (with and without re-planning), because the lane
changes what the runner does next, not what it found:**

```text
report_unbuildable_target  projectKey: <PROJECT>  targetKey: <KEY>
                           reason: the SAME text as your step-3 comment
```

The prompt tells the runner that the call spends nothing, that it is safe to repeat (the server
keeps one record per run), and that it returns no answer to act on.

**This does not reopen Q3.** The runner still reports only what is wrong with the CARD. That is
the text it already composes for the comment and for Q6's WHAT, and it still never says why the
card was PLANNED that way. The server does the classifying, from the approving plan's author and
from a verdict computed off recorded rows.

### `--auto-approve-replan` changes nothing

The report is made before `submit_plan_session` and does not depend on it. Q4 and Q2's B1 limit
who may APPROVE the plan that follows. They do not limit what a finding records. The verdict is
read against the plan that shaped the target before the refusal, not against the re-plan, so
the filing and the destination are the same with or without the flag.

## Consequences

- motir-core owns trigger 2 on the product path end to end. motir-ai gains nothing, and
  `SHARED_PLANNING_RULES` does not carry this trigger. MOTIR-5544's fourth criterion (the shipped
  home carries the rule) needs re-planning with the story.
- Motir's own tenant plans through the MCP, so its dispatched runs will rarely fire this trigger.
  That is the precondition working as intended, not a gap.
- A customer-tenant bug cannot be fully debugged from Motir's project alone. The reason is read
  in the customer's tenant, under that tenant's access rules.
- **Named as amended, not edited here (`run-findings-protocol.md`):**
  - **Q3, _Why not the planner-bug home_.** Its claim that a dispatched agent cannot produce a
    planning defect through the card-is-wrong branch, and that the home is unreachable, stays
    true of the agent. It no longer holds of the run: the server now files into the home on the
    runner's report.
  - **Q6, _"Run it ONCE" now has two parts_.** It now has three. The report is free and safe to
    repeat, and the submit is still the only act that spends credits and is never retried.
- The comment on `get_approved_shape_verdict` in `lib/mcp/toolPermissions.ts` (on the parent
  branch) says the shipped planner reads the verdict through its internal AI route. That becomes
  false and is corrected by the endpoint's card.

## Consumed by

- **MOTIR-5544**: criterion 3, the dispatched path behaves as this record says. Its body is
  re-planned to this direction.
- **New work owed** (to be planned under MOTIR-5544): the endpoint (the MCP tool, the service,
  the leg-keyed filing row and a new `DispatchEventKind` member for the finding); the bug
  composition and allowlist; the `cardIsWrongSteps` prompt change.
- **MOTIR-6232**: re-scoped. Its gate covers the verdict, the runbook door and this endpoint,
  with one case per arm of the precondition and the verdict, instead of MOTIR-6228's route.
- **No longer needed:** **MOTIR-6228** (the internal AI route), **MOTIR-6229**, **MOTIR-6230**
  and **MOTIR-6233** (the motir-ai rule, the pass and its gate).

## Supersedes

None. This record **extends** `run-findings-protocol.md` Q3, Q5 and Q6 and amends the two
clauses named above. motir-ai's `planner-files-tenant-bug.md` §2b and MOTIR-1460 stand
unchanged.

## What this does NOT decide

- **Whether the motir-ai-only precondition also binds the RUNBOOK path (MOTIR-6231).** The
  runbook plans through the MCP, so under the precondition it would never fire. This record
  decides the dispatched path only. That question stays with MOTIR-5544.
- **The leg-timing bug MOTIR-6279** (Q5's `plan_submitted` read after the leg closes). This
  trigger avoids it by calling early. It does not fix it.
- **When** a run judges a target unbuildable, and **what counts as a CHANGE**. The existing
  guards own the first, and MOTIR-6225's verdict owns the second.
- **How Motir staff read a customer's verbatim reason** when they debug a customer-tenant bug.
  That is a support-access question, not a filing question.
