# ADR: A run that dies keeps its work

- **Status:** Proposed (2026-09-27), for acceptance at MOTIR-6525's `decision_approval` gate
- **Card:** MOTIR-6525 · **Epic:** MOTIR-673 ("Hosted agent")
- **Kind:** a planner-recorded decision. The direction was settled with the person in the planning conversation that produced this card (plan `cmuiv4wdy002fhvoio4f2c2af`, approved 2026-09-26). This document writes it down; it does not re-open it.
- **Consumed by:**
  - MOTIR-6526 (the story "A run that DIES keeps its work") and its children: MOTIR-6528 (liveness on the run record), MOTIR-6529 (the _run died_ marker design), MOTIR-6530 (the CLI heartbeat), MOTIR-6531 (the CONTINUE prompt), MOTIR-6532 (the continue claim), MOTIR-6533 (`motir continue <KEY>`), MOTIR-6534 (the marker on the card), MOTIR-6535 (`motir continue <parent>`), MOTIR-6536 (the E2E), MOTIR-6537 (the story's Vitest gate), and MOTIR-6573, which brings the older records named under _What this changes in older records_ in line with this one
  - MOTIR-6527 (continuing a dead hosted run from the browser), which starts from this story
  - Story 9.1: MOTIR-683, MOTIR-690 (start: the run's timeout) and MOTIR-6450 (end: what the card becomes)
- **Supersedes:**
  - MOTIR-685 (9.1.2, `hosted-agent-run.md`): its §2 end-state column (**To Do**) and its §5 90-minute wall-clock timeout. Its 15-minute stall and its no-heartbeat-from-the-container rule stand.
  - MOTIR-683 (9.1): amended in the same plan that laid this card.
  - MOTIR-690 (9.1.7): its `timeoutSeconds` taken from 9.1.2's 90 minutes.
  - MOTIR-6450: its _move the card per 9.1.2's table_ on a non-success end.
  - MOTIR-6322 (cancelled): its fix direction returns as `motir continue <parent>`, now that a heartbeat can prove no agent is on the branch.
  - No earlier planner-recorded decision on MOTIR-673 is contradicted. MOTIR-6482 ([`hosted-run-model-choice.md`](hosted-run-model-choice.md)) stands.

> Structured **Status → Context → Decision → Consequences**, then _What this does NOT decide_, in the shape the other records here use. Code facts were read on `origin/main` of motir-core `8582775b4` (2026-09-26).

---

## Context

Two things happen today when an agent run stops part-way.

**A hosted run is ended by a clock, and its card goes backwards.** `hosted-agent-run.md` §5 stops a hosted run at 90 minutes of wall-clock time. §2's end table then sends the card to **To Do** on four of its five endings: failure, cancel, timeout and stall. The reasoning in §2 was that a failed hosted run holds no worktree and no person, so In Progress would be a claim nobody is exercising. The cost is that a long run doing fine is killed at minute 90. Whatever it had built is then presented as work that never started.

**A local run that dies is invisible.** A `motir run` whose laptop sleeps or whose terminal closes leaves its card In Progress with nothing detecting it. The run record has only `startedAt` and `endedAt`. The only reap is the daily `system.dispatch-run-sweep`, which closes a run still `running` 12 hours after it started (`DISPATCH_RUN_ABANDON_AFTER_HOURS = 12`, `lib/services/dispatchRunService.ts:110`). Until then only the same person can pick the card up (`claim_work_item` answers `mine`), and everyone else is refused as `taken` by a run that no longer exists. The work sits on a branch nobody is told about.

An earlier fix for the parent-run half of this (MOTIR-6322) was cancelled. Reusing a branch on a guess was rejected, because nothing could prove another agent was not still on it.

---

## Decision

### 1 · A run is bounded by what it is doing, not by a clock

- **A healthy run has no wall-clock limit.** The 90-minute hosted timeout is withdrawn.
- **The fleet seam's 12-hour ceiling stays, as a spend backstop only** (`HOSTED_AGENT_MAX_TIMEOUT_MS = 12 * 60 * 60_000`, `lib/services/hostedAgentContainerService.ts:141`). It is not a target and not a budget. It exists so that no run, however it fails, can hold a machine indefinitely.
- **A hosted run's timeout is therefore the 12-hour backstop.** Wherever `hosted-agent-run.md` derives a value "from the timeout", that value now derives from 12 hours. That covers §3's run-token `expiresAt` and §5's credential expiries.
- **The dispatcher's credits bound every run**, local or hosted, as they already do.

### 2 · How Motir knows a run is alive

| Run                                     | Alive while                                                                                      | Dead when                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| **local**                               | it reports a **heartbeat** on its dispatch run **every 60 seconds**                              | **5 minutes** pass with no heartbeat                                                        |
| **hosted**                              | its server-side **supervision** keeps polling the container and the agent keeps producing output | the agent is silent for **15 minutes** (the stall), or the supervision chain itself is lost |
| **local, old CLI** (sends no heartbeat) | as today                                                                                         | the existing 12-hour age reap closes it; it is never marked dead before then                |

- **The 5-minute lapse** is five missed heartbeats. One late report is never read as a death, and a run that is really gone is known within minutes, not hours.
- **A hosted run sends no heartbeat**, and `hosted-agent-run.md` §5's reason stands: a heartbeat would prove the container is alive, and the stall watchdog exists to catch an agent that is alive and stuck. The **15-minute stall** keeps its reason too. It clears the longest silent step a normal card runs (a full test file, a cold dependency install) and still ends a hung agent quickly.
- **A lost supervision chain is now an ending, not only a teardown.** Until now it settled the machine and left the run and the card alone. It now goes through the same end path as every other ending (§3).
- **A lapsed local run is closed `abandoned`, and closing writes no card status.** `dispatch-run-record.md` Q3 §2 (_"The work item's STATUS belongs to the CLI"_) holds unchanged. `close` already writes no status (`lib/services/dispatchRunService.ts`, the service header's rule 1), and `abandoned` already maps to the run status `timed_out` (`statusForStopReason`).

### 3 · No run end moves its card backwards

| How the run ended                                             | The card                                                                                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| succeeded: the agent finished and a pull request opened       | **moves forward** to Implemented, then CI and the merge move it, exactly as today                                                                          |
| failed, cancelled, stalled, hit the 12-hour backstop, or died | **keeps the status it holds**, with its branch pushed, its draft pull request intact where the run had opened one, and a **_run died_** marker on the card |

How a run ENDS never decides a card's status. Success moves the card forward because a pull request now exists, not because the run said so. Every other ending leaves the card exactly where the work left it.

**Starting over is a deliberate person's act:** set the card to To Do and `motir run` it. Nothing does it automatically.

### 4 · `motir continue` picks the work up on the dead run's branch

- **`motir continue <KEY>`** is a separate command from `motir run`.
- **Who may run it:** any member with edit rights on the project, on a card whose last run ended without success and which has no live run. It is not limited to the person who started the dead run.
- **What it does:** it takes the card over (naming who held it), checks out the dead run's branch, and starts an agent told to CONTINUE on it rather than start again.
- **`motir continue <parent>`** does the same for a parent run: it resumes on the parent's session branch and its existing draft pull request.
- The heartbeat is what makes this safe. A card whose run is still alive is never offered for continuing, so two agents cannot end up on one branch.

Continuing a dead **hosted** run from the browser, without a laptop, is its own story (MOTIR-6527).

**Rejected:**

- **A longer wall-clock timeout.** Any fixed number kills the one run that was about to finish and still says nothing about a run that died a minute in. Liveness answers the question the timeout was standing in for.
- **Sending the card back to To Do on failure** (the old §2). It makes the card lie about how far the work got, and it drops the branch out of sight.
- **Letting `motir run` resume a dead run.** A command that sometimes starts fresh and sometimes continues on someone else's branch is one a person cannot predict. Continuing is a different act with a different lock, so it gets its own name.
- **Marking a run dead by writing a status when it lapses.** Liveness is a timestamp and a rule, read when it is needed. Nothing has to run for a card to be known dead, and no new workflow status is added.

---

## Consequences

### What this changes in older records

Each clause below becomes false when this record is accepted. **None is edited here.** A decision card's pull request carries exactly one decision document (`classifyDecisionDocuments` in `lib/approvalGates/decisionDocument.ts` answers `several` otherwise, and `decisionApprovalHandler.approve` refuses that). MOTIR-6573 brings each of them in line after this merges.

| Record                                                             | Stops being true                                                                                                                                                                             | Stands                                                                                                                                                          |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`hosted-agent-run.md`](hosted-agent-run.md) §2                    | the **To Do** column of the _How it ended_ table on four rows; the paragraph after it (_"Returning to To Do rather than staying In Progress is deliberate"_); _"timed out after 90 minutes"_ | the run statuses and teardown reasons in that table; success → Implemented; the shared-vocabulary rule                                                          |
| [`hosted-agent-run.md`](hosted-agent-run.md) §3                    | the run token's `expiresAt` = boot + "the run's timeout (§5)": the timeout is now the 12-hour backstop                                                                                       | everything else about the run-bound token                                                                                                                       |
| [`hosted-agent-run.md`](hosted-agent-run.md) §5                    | _"Wall-clock timeout: 90 minutes"_ and its three reasons; credential expiries _"derived from the timeout"_ now derive from the 12-hour backstop                                              | the 15-minute stall and its reason; the no-heartbeat-from-the-container rule; the 12-hour backstop                                                              |
| [`dispatch-run-record.md`](dispatch-run-record.md)                 | nothing is contradicted. The record gains run liveness: the 60-second heartbeat, the 5-minute lapse, the `abandoned` close, and hosted liveness = supervision                                | Q3 §2: closing a run writes no card status                                                                                                                      |
| [`hosted-agent-machine-charge.md`](hosted-agent-machine-charge.md) | the Context's _"up to the 90-minute timeout"_, and the worked example _"a run that hits the 90-minute timeout is `90`"_                                                                      | the per-minute charge, the rounding, and _no allowance_. A run's machine time is now bounded by the 12-hour backstop (at most `720` credits), not by 90 minutes |

### What each consumer builds

- **The run record** gains `lastHeartbeatAt`, one rule for "is this run alive?", and a sweep that closes a lapsed local run `abandoned` without touching its card (MOTIR-6528).
- **The CLI** heartbeats every 60 seconds while a run is open (MOTIR-6530), and gains `motir continue` for a card and a parent (MOTIR-6533, MOTIR-6535).
- **The server** gains a continue claim whose lock is the open `continue` run, and which writes no status (MOTIR-6532).
- **The card** shows that its run died, when it was last heard from, who ran it and its branch, with a copyable `motir continue` (MOTIR-6529, MOTIR-6534).
- **The hosted end path** (MOTIR-6450) moves the card on success only, and a lost supervision chain goes through it. The hosted start path (MOTIR-690) starts a run with the 12-hour backstop as its timeout.

### What gets harder

- **A stuck-but-talking run can now cost up to 12 hours** of machine time and model calls, where before it was cut at 90 minutes. The 15-minute stall still ends a silent agent. An agent that keeps producing output without progress is bounded only by the backstop and the dispatcher's credits. That is the accepted trade: a clock cannot tell that run apart from one doing real work.
- **A card may sit In Progress with nobody on it**, marked _run died_, until a person continues it or sets it back to To Do. The marker is what makes that state legible. It is no longer silent.

---

## What this does NOT decide

- **A new workflow status**, or any status write when a run dies. There is none.
- **What happens to a card at Implemented whose run died.** Its pull request exists and CI decides; a red one is `motir fix`'s (MOTIR-5460). `motir continue` refuses it.
- **A runbook session** (a person driving `motir run` in a Claude Code session). It opens no dispatch run, so nothing can prove it dead, and a person moves that card by hand.
- **The exact sweep schedule, column names or refusal wording.** Those belong to the cards above.
- **Continuing a dead hosted run from the browser.** That is MOTIR-6527.
- **A spend cap below the 12-hour backstop**, per run or per organization. Nothing here adds one.
- **The hosted model choice** (MOTIR-6482), the git identity and credentials (`hosted-agent-run.md` §3–§4 apart from their expiry), or the machine charge's rate. All unchanged.
