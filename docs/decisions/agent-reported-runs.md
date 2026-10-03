# ADR: An agent may report its OWN run over the MCP

- **Status:** Proposed (2026-10-03), for acceptance at MOTIR-7449's decision gate.
- **Amends:** [`dispatch-run-record.md`](dispatch-run-record.md). This is that record's
  **AMENDMENT 3**, written as its own file so the question can be read on its own. Every
  `Qn` and `AMENDMENT n` below names a section of that record. It amends **Q4** for one
  event kind (§3) and **AMENDMENT 2's lapse window and reaped end time** for
  agent-reported runs (§5), and
  it overturns the ruling recorded in `motir-core`
  `lib/mcp/payloads/sharedResources.ts` (`MCP_UNREACHABLE_RESOURCES.DispatchRun`) and
  repeated in `lib/mcp/tools/workItemContinue.ts` (_"NO RUN EVENTS"_). Q1, Q2's enums,
  Q3 and AMENDMENT 1 hold exactly as written, and AMENDMENT 2 holds for every CLI-reported run.
- **Card:** MOTIR-7449 · **Story:** MOTIR-7446 (a card run from the `motir-run` skill is
  on the run record) · **Epic:** MOTIR-7445 (run provenance).
- **Consumed by:** MOTIR-7450 (the run service and `DispatchRun.reportedBy`), MOTIR-7451
  (the three MCP tools, their permissions, and the ruling text rewritten), MOTIR-7452
  (the story's integration gate), MOTIR-7453 (its E2E), MOTIR-7454 (`run.md`) and
  MOTIR-7455 (the public `motir-run` skill), and the card that adds the `report_action`
  instruction to the dispatched prompt (`lib/dispatch/promptTemplate.ts`).

> Structured **Status → Context → Decision → Consequences**, then _What this does NOT
> decide_. Code facts were read on `origin/main` of motir-core at `18c7e35`
> (2026-10-03).

---

## Context

**The question.** May a coding agent write the run record about its own run, through the
MCP, and on what terms?

**Today the answer is a recorded no.** `MCP_UNREACHABLE_RESOURCES.DispatchRun` says the
run ingest _"has no MCP counterpart … MCP is the AGENT's surface, and the agent is the
SUBJECT of a run rather than its reporter … one that must not be closed by adding a
tool"_. The continue tools repeat it: _"NO RUN EVENTS"_.

**The user has now asked for the opposite.** A Claude Code session following the public
`motir-run` skill claims a card, builds it, opens a pull request and moves the card to
Implemented, and leaves no `DispatchRun` and no implementer behind. There is no process
around that session to act as the reporter, so without a door these runs are never
recorded. They are the public plugin's whole lane, and every comparison of models or
ways of working leaves them out.

**What already exists, read on `origin/main`:**

- **The record already has MCP-driven writers.** `workItemRepairService` (MOTIR-6807)
  and `workItemContinueService` (MOTIR-7262) open a `DispatchRun` from an MCP claim
  (`dispatchRunService.openWithin`). What the ruling actually forbids is the agent's own
  EVENTS and its own ACCOUNT, not an MCP-opened run.
- **Every other writer:** the CLI's v1 ingest (`app/api/v1/dispatch-runs/route.ts`), the
  hosted start (`hostedRunService`, twice), the instance start
  (`agentInstanceRunService`), and the repair and continue claims.
- **Liveness:** `dispatchRunService.heartbeat`, AMENDMENT 2's 5-minute lapse window and
  its `abandoned` reap.
- **Provenance:** `workItemsService.recordImplementationProvenance` writes
  `implementationSource` / `implementationHarness` / `implementationModel`. Source
  `byok` is what the CLI stamps for a local run.
- **Permissions:** the repair and continue tools each assert `work_item:edit`
  (`lib/mcp/toolPermissions.ts`). The MCP's OAuth and PAT grants carry it.

## Options

1. **Keep the ruling; record nothing for skill runs.**
   Costs nothing to build. Not taken: it refuses the user's ask outright, and the runs
   most people make stay out of every analysis.
2. **Let the skill shell out to `/api/v1` with a PAT.**
   Not taken: the skill would carry curl recipes and a second token outside the MCP's
   OAuth grant, which breaks the plugin's _"sign in once"_ promise (MOTIR-6972). The
   resulting run would also be indistinguishable from a CLI run, because the v1 ingest
   assumes a CLI is reporting.
3. **Add an MCP door, mirroring the repair and continue families.** Three tools over a
   card the caller already holds, and every run opened through them stored as
   agent-reported. Costs one enum column, one service path and three tools. Forecloses
   nothing: the v1 ingest is untouched, and a self-reported run is labelled rather than
   mixed in.

## Decision

**Option 3.** The ruling's concern is real: analysis must be able to tell _"the CLI
observed this"_ from _"the agent said this"_. It is answered by **labelling** the run,
not by refusing it. The user's instruction is rung 3 of the decision ladder and wins over
a recorded preference.

### 1 · The label: `DispatchRun.reportedBy`

- A closed enum, `cli` · `agent`, stored on the run.
- **It is set by the door that opened the run, never by a caller.** No tool or route
  accepts it as input.
- **Every pre-existing writer writes `cli`:** the v1 ingest, the hosted start, the
  instance start, and the repair and continue claims. Existing rows are `cli`.
- **Only `start_work_item_run` writes `agent`.**

### 2 · Open: `start_work_item_run { key, harness, model? }`

- **Refused unless the caller holds the claim on `key`.** Holding it means the card is
  In Progress and assigned to the caller, which is what `claim_work_item` answering
  `claimed` or `mine` for this caller leaves behind.
- **A leaf** opens a run with one leg, `command: run`.
- **A container** opens ONE run whose legs are its children in the claim's order,
  `command: run_scope`.
- **`origin`** is `local`, or `instance` when the caller's credential belongs to a Motir
  agent instance. It is read from the credential and never sent.
- **`agent`** is the harness the caller names (e.g. `Claude Code`). **`model`** is the
  model id it is running as, or null when it does not know. A guessed model is worse
  than none.
- **A second start on the same claim answers `mine` with the same run**, so a retried or
  resumed session never opens a second one.

### 3 · Report: `report_action { key?, action?, events? }`

**Any agent reports itself through this one tool, before every step it takes.** The
`motir-run` skill and every prompt Motir dispatches (`lib/dispatch/promptTemplate.ts`, which
the CLI and hosted runs both send) tell the agent: _call `report_action` with the step you
are about to take, before you take it_. It works in any harness that speaks MCP.

- **`action` is the step, in one line**, written before the step starts: _"run the
  changed tests"_, _"open the pull request"_. At most 500 characters. It is stored as an
  event of a new kind, **`agent_action`**, on the leg of `key`. This adds one kind to
  Q2's `DispatchEventKind` (AMENDMENT 1's 21 become 22).
- **The run is found from `key` and the caller, never from a run id.** It is the open run
  with a leg on `key` that the caller opened, whoever reports it. So the same call
  works in an agent-reported run (opened by `start_work_item_run`) and in a CLI or
  hosted run, whose agent signs into the MCP as the same principal. With no such run the
  call is refused by name, and the refusal tells an agent outside any run to call
  `start_work_item_run` first.
- **Every call is a heartbeat** (`dispatchRunService.heartbeat`) on that run. **With no
  arguments it is a heartbeat only**, over every open run the caller opened. This is the
  form a hook sends (§5).
- **Every event records who reported it.** `DispatchRunEvent.reportedBy` is `agent` for an
  event written through this tool and `cli` for every other writer, beside the run's own
  `reportedBy` (§1). A CLI run can therefore carry the agent's own account of its steps
  without the two being confused.
- **`events` carries milestones.** An agent may send only these kinds:

  | kind              | scope | carries                                         |
  | ----------------- | ----- | ----------------------------------------------- |
  | `checkout_ready`  | leg   | the branch                                      |
  | `delivery_linked` | leg   | the pull request URL                            |
  | `leg_verdict`     | leg   | the verdict, from Q2's `DispatchLegVerdict` set |
  | `card_settled`    | leg   | the leg's disposition, from Q2's closed set     |

  In a CLI or hosted run these four are already written by the runner, so there the tool
  accepts `action` only, and refuses `events` by name.

- **Every other kind is refused by name.** `run_opened` and `run_closed` are written by
  the server, as `bug_filed` and `plan_submitted` already are (AMENDMENT 1). An agent
  cannot claim CI verdicts, agent exits or anything else only an observer can see.
- **This amends Q4 for `agent_action`, in every run.** Q4 keeps a local run's log bodies
  off by default because they are CAPTURED output from a machine nobody enrolled. An
  `agent_action` is not captured output: it is one line the agent composes for the
  record. So it is accepted without an opt-in, and it is bounded harder than Q4's
  16 KiB: at most 500 characters, never a transcript, never file contents, diffs,
  prompts or secrets. The skill and the dispatched prompt say so. It expires after 30
  days like every other body. Q4 is unchanged for every captured log.

### 4 · Close: `close_work_item_run { key, runId, outcome }`

- **`outcome`** is a stop reason the v1 close takes, except `abandoned`, which only the
  reap writes (Q2).
- **Idempotent on a closed run.** A close after the reap, or a second close, answers with
  the run as it stands, never an MCP error. This mirrors `close_work_item_repair`.
- **Provenance at a delivered close.** At `completed` or `drained`, the close stamps
  `implementationSource: byok`, `implementationHarness` and `implementationModel` from
  the run onto every leg card whose status is `implemented` or later, through
  `workItemsService.recordImplementationProvenance`. **Any other outcome stamps
  nothing.** A model the run does not know is left as it is on the card, not cleared.

### 5 · Liveness: any harness, with a hook where one exists

The skill is read by many harnesses, not only Claude Code: Codex, Kimi and any other agent
that speaks MCP. Liveness may therefore rest on nothing a particular harness provides.

- **The reap is AMENDMENT 2's.** A silent agent-reported run is closed `abandoned` and
  writes no card status, exactly as a silent CLI run.
- **Every Motir MCP call by the caller is a heartbeat.** The server refreshes the
  heartbeat of every open agent-reported run the caller opened whenever that caller calls
  any Motir MCP tool, not only `report_action`. The one thing every harness running
  the skill does is call the Motir MCP, so this needs no client code and no agent memory.
  The refresh writes only the heartbeat timestamp, and may skip the write when the stored
  timestamp is under a minute old.
- **The lapse window is 60 minutes for `reportedBy: agent`, and stays 5 minutes for
  `cli`.** The CLI heartbeats from its own timer every 60 s. An agent calls Motir only at
  its milestones and when the skill tells it to touch the run, and between them it may
  build, test and edit for a long stretch without any Motir call. Sixty minutes covers
  that stretch; a short window would reap live sessions in the middle of their work.
- **`report_action` before every step is the explicit heartbeat** (§3), and with no
  arguments it is a heartbeat alone. An agent following the skill or a dispatched
  prompt therefore touches its run at every step without a separate instruction.
- **Where a harness has hooks, a hook tightens the heartbeat.** It is an addition, never
  the mechanism the rule rests on. In Claude Code the `motir` plugin ships an `mcp_tool`
  hook (`hooks/hooks.json`) that calls `report_action` with no arguments on
  `PreToolUse` and `PostToolUse`. An `mcp_tool` hook uses the session's existing MCP
  connection, so it needs no second credential. Other harnesses get the same hook only
  where they can call an MCP tool from one; a hook that would need a separate token is
  Option 2 and is not shipped.
- **The cost:** a dead agent session reads `running` for up to 60 minutes before the reap
  closes it, against 5 for a CLI run.
- **A reaped agent-reported run ends at its last heartbeat, not at the reap.** Otherwise
  every abandoned agent run would carry up to an hour of time nobody spent, and the
  durations analysis compares would be wrong by the window.

### 6 · What stays the CLI's, or nobody's

Q3 holds in full:

- **Card status** is moved by the agent itself with `transition_status`, as today.
  Opening, touching and closing a run moves no status.
- **Pull requests and CI** belong to the delivery set.
- **Tokens and cost** belong to motir-ai. Nothing is recorded or estimated for a session
  on the developer's own account.

### 7 · Permissions and the ruling text

- **Each of the three tools asserts `work_item:edit`**, as the repair and continue tools
  do.
- **The ruling in `MCP_UNREACHABLE_RESOURCES.DispatchRun` is rewritten** (MOTIR-7451)
  to say the run tools answer a narrow liveness-and-receipt shape, not the v1
  `DispatchRun` resource. **The run READ stays unreachable from the MCP.**

## Consequences

- Skill-driven runs appear on `/runs`, in the run modal and in the card's run section,
  exactly as a CLI run does, and the delivered card names its implementer.
- Every stored run says who reported it, so an analysis can include or exclude
  self-reported runs instead of having them mixed in.
- The reap reads the window from `reportedBy`, so one stored field drives both the
  label and the liveness rule.
- The record gains a `reportedBy` column on the run and on each event, one event kind
  (`agent_action`), and one writer. The v1 ingest and its five existing writers change
  only in writing `cli`.
- Every run, whoever opened it, can carry the agent's own step-by-step account, because
  the skill and the dispatched prompt both tell the agent to call `report_action` before
  every step.
- `tests/api/v1/work-loop-story-gate.test.ts` and the `EXEMPT_TOOLS` entries cite the
  old ruling. Bringing them in line belongs to MOTIR-7451, which ships the tools.

## What this does NOT decide

- **The model on each LEG of a CLI run.** That is the sibling story MOTIR-7447. Here the
  agent's model is the RUN's, and the provenance stamp reads it from there.
- **Harness and model on the repair and continue claims.** Those skills open their runs
  through their own claim tools and are not changed here.
- **How the surfaces render `reportedBy`.** It is stored for analysis. Whether any page
  shows it is not decided here.
- **The exact tool schemas, error codes and payload shapes.** Those are MOTIR-7450's and
  MOTIR-7451's, inside the terms above.
- **The skill's wording and the hook files.** Those are MOTIR-7454's and MOTIR-7455's,
  including which harnesses get a hook, the MCP server name each hook targets, and how a
  runbook install that copies skills without the plugin gets one.
- **Any change to the CLI's v1 ingest, or to who may read a run.**
