# ADR: An agent may report its OWN run over the MCP

- **Status:** Proposed (2026-10-03), for acceptance at MOTIR-7449's decision gate.
- **Amends:** [`dispatch-run-record.md`](dispatch-run-record.md). This is that record's
  **AMENDMENT 3**, written as its own file so the question can be read on its own. Every
  `Qn` and `AMENDMENT n` below names a section of that record. It amends **Q4** for one
  event kind (§3) and **AMENDMENT 2's lapse window** for agent-reported runs (§5), and
  it overturns the ruling recorded in `motir-core`
  `lib/mcp/payloads/sharedResources.ts` (`MCP_UNREACHABLE_RESOURCES.DispatchRun`) and
  repeated in `lib/mcp/tools/workItemContinue.ts` (_"NO RUN EVENTS"_). Q1, Q2's enums,
  Q3 and AMENDMENT 1 hold exactly as written, and AMENDMENT 2 holds for every CLI-reported run.
- **Card:** MOTIR-7449 · **Story:** MOTIR-7446 (a card run from the `motir-run` skill is
  on the run record) · **Epic:** MOTIR-7445 (run provenance).
- **Consumed by:** MOTIR-7450 (the run service and `DispatchRun.reportedBy`), MOTIR-7451
  (the three MCP tools, their permissions, and the ruling text rewritten), MOTIR-7452
  (the story's integration gate), MOTIR-7453 (its E2E), MOTIR-7454 (`run.md`) and
  MOTIR-7455 (the public `motir-run` skill).

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

### 3 · Report: `touch_work_item_run { key, runId, events? }`

- **Every call is a heartbeat** (`dispatchRunService.heartbeat`), and may carry a batch of
  events.
- **An agent may send only these kinds:**

  | kind              | scope | carries                                              |
  | ----------------- | ----- | ---------------------------------------------------- |
  | `checkout_ready`  | leg   | the branch                                           |
  | `delivery_linked` | leg   | the pull request URL                                 |
  | `leg_verdict`     | leg   | the verdict, from Q2's `DispatchLegVerdict` set      |
  | `card_settled`    | leg   | the leg's disposition, from Q2's closed set          |
  | `log`             | leg   | a one-line progress note, a body of ≤ 500 characters |

- **Every other kind is refused by name.** `run_opened` and `run_closed` are written by
  the server, as `bug_filed` and `plan_submitted` already are (AMENDMENT 1). An agent
  cannot claim CI verdicts, agent exits or anything else only an observer can see.
- **This amends Q4 for `log`, and only for agent-reported runs.** Q4 keeps a local run's
  log bodies off by default because they are CAPTURED output from a machine nobody
  enrolled. An agent's `log` is not captured output: it is a note the agent composes
  for the record, in one line. So it is accepted without an opt-in, and it is bounded
  harder than Q4's 16 KiB: at most 500 characters, never a transcript, never file
  contents, diffs, prompts or secrets. The skill says so. It expires after 30 days like
  every other body. Q4 is unchanged for every CLI-reported run.

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

### 5 · Liveness: a longer window for agent-reported runs

- **The reap is AMENDMENT 2's.** A silent agent-reported run is closed `abandoned` and
  writes no card status, exactly as a silent CLI run.
- **The lapse window is 15 minutes for `reportedBy: agent`, and stays 5 minutes for
  `cli`.** The CLI heartbeats from its own timer every 60 s. An agent can call a tool
  only between its steps, so it cannot heartbeat while one of its commands is running,
  and Claude Code lets one foreground command run up to 10 minutes. Fifteen minutes
  covers that command and the turn around it; five would reap a live session in the
  middle of a long build or test run.
- **There is no heartbeat script or hook.** Anything that heartbeats outside the agent's
  own tool calls would need a credential beside the MCP's grant, which is Option 2.
- **The skill touches the run at every step boundary and immediately before any command
  that may run longer than a minute.** It also touches immediately after that command,
  so a run is never silent for longer than one command plus one turn.
- **The cost:** a dead agent session reads `running` for up to 15 minutes before the reap
  closes it, against 5 for a CLI run.

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
- The record gains one column and one writer. The v1 ingest and its five existing
  writers change only in writing `cli`.
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
- **The skill's wording.** That is MOTIR-7454's and MOTIR-7455's.
- **Any change to the CLI's v1 ingest, or to who may read a run.**
