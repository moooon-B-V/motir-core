# A hosted design sent back is re-run on its own, and a project can switch design approval off

**Status:** proposed · **MOTIR-695** (the decision of Story **MOTIR-693**, 9.2) · 2026-09-29

**Amends:** [`approval-gates.md`](approval-gates.md) §5 and §10g, the two tables that leave
_"the HOSTED, AUTOMATIC re-dispatch after a refusal"_ and _"`Project.designApprovalGate`"_ to
Story 9.2. Each gets a one-line pointer to this record, which MOTIR-697 adds. Nothing else in that
file changes.

**Consumed by:** MOTIR-694 (the design) · MOTIR-697 (the switch, the system decision, and the two
pointer lines) · MOTIR-700 (the automatic re-run) · MOTIR-702 (the surfaces) · MOTIR-703 (the
integration tests) · MOTIR-6417 (the E2E spec)

## Context

[`approval-gates.md`](approval-gates.md) §10 and
[`design-refusal-verdict.md`](design-refusal-verdict.md) (MOTIR-6419) settled what a design
refusal does. **Request changes** needs a reason and a verdict. **Revise** and **Re-plan** both
return the design card to To do, and the next run's prompt carries the reason. After that, nothing
happens until somebody dispatches the card again.

§10g left two things to Story 9.2:

1. **Making that next run automatic** when the design was produced on the hosted agent.
2. **`Project.designApprovalGate`**, which lets a project stop being asked to approve designs.

This record answers both. It was read against `motir-core` `origin/main` `910e3ced9`.

### What the shipped code already fixes

- **A hosted run starts through one path.** `hostedRunService` (`lib/services/hostedRunService.ts`)
  checks, in order and before spending anything: project edit access for the caller, the CI-credit
  gate (`ciAllowanceService.assertDispatchAllowed`), the model is still offered, the
  **organization's** credits (`checkAgentRunCredits`), and every repository the run touches is
  writable. Only then does it open the run, claim the card and boot the container. **Run hosted** and
  **Continue hosted** share that list.
- **A run records who started it and with which model.** `DispatchRun.createdById`,
  `DispatchRun.origin` (`local` | `hosted`) and `DispatchRun.model`. `DispatchRunCard` ties a run to
  the cards it carried.
- **`WorkItem.implementationSource` is written by the last run.** The hosted launch stamps `hosted`
  on every leg (`recordImplementationProvenance`), and a later BYOK run overwrites it.
- **Who pays for a hosted run** is the organization, in credits
  ([`hosted-agent-machine-charge.md`](hosted-agent-machine-charge.md); MOTIR-6902). The model is
  chosen by the person who presses Run hosted
  ([`hosted-run-model-choice.md`](hosted-run-model-choice.md)).
- **The Approvals settings room is behind `workflow:manage`** (`lib/approvalGates/settingsDoor.ts`).
  It already holds the `prMergeMode` and acceptance-video cards.
- **An approved `design_result` gate is state that other code reads**, not just a record of a
  decision. `designEvidenceService` reads `findLatestApprovedByWorkItems`. Only an approval pins a
  design's retention (§6c). `list_designs` and `get_design` answer `approved` from it. A dependent's
  readiness follows the `done` status the approval writes (§3 as amended).
- **The audit columns today** are `ApprovalGateDecisionSource = ui | api | mcp | github` and
  `ApprovalGateAuthority = assignee | reporter | admin | github_review | plan_permission`. Neither has
  a member for "no person; a project setting".

## Decision

### 1 · The automatic hosted re-run after a Revise

**1a · The trigger.** A re-run is attempted when a `design_result` gate is decided
`changes_requested` with verdict **Revise**, pressed in Motir (`decisionSource` `ui`, `api` or
`mcp`), **and** the card's latest dispatch run was hosted.

- "Latest dispatch run" is the newest `DispatchRun` that carried the card (through
  `DispatchRunCard`). Its `origin` must be `hosted`. That run is the authority because it also says
  who ran it and with which model; `implementationSource` agrees with it by construction and is not
  a second test.
- **Re-plan never re-runs anything** ([`design-refusal-verdict.md`](design-refusal-verdict.md) §3).
  A GitHub-sourced refusal carries no verdict and re-runs nothing (§10h's third note).
- **A card whose latest run was BYOK or by hand is never moved onto the hosted agent** by a refusal.
  The lane is chosen per card, at dispatch, by a person. A refusal is not that person.

**1b · Who it runs as.** The re-run is started **as the person who started that latest hosted
run** (`DispatchRun.createdById`), **with that run's model**, through the same `hostedRunService`
start path and its full pre-flight list, in `run` mode (not `continue`). It re-runs the design card
alone, even when the last hosted run was a parent run that carried it as one leg.

_Not the reviewer._ The person who presses Revise may have no hosted access and never chose to
spend on this card. The dispatcher chose the lane and the model, so they keep both.

**1c · Who pays.** The dispatcher's organization, in credits, exactly as for any hosted run. The
reviewer's press costs them nothing.

**1d · When it cannot run.** If any pre-flight refuses, the re-run is **not dispatched** and the
card says why. The cases:

- the dispatcher no longer exists or can no longer edit the project;
- the CI-credit gate refuses;
- the model is no longer offered;
- the organization is out of credits;
- a repository is not writable;
- the card is no longer ready or claimable (for example, a person claimed it first).

**A different model is never substituted.** A re-run on a model the dispatcher did not choose
changes what the run costs without anyone deciding it. The card then waits at To do like any other
sent-back card, and a person can press Run hosted with a model of their choosing.

**1e · The cap: 3.** A card gets at most **three** automatic re-runs. The count is the number of
Motir-pressed **Revise** refusals on the card's `design_result` gates. The fourth and later Revise
start nothing, and the card says _automatic re-run skipped: cap reached_. The count never resets,
including after a person re-dispatches by hand.

_Why 3, and why no reset._ Three rounds of "a small change" on one design is already a sign that
the reviewer and the agent disagree about something a sentence won't fix. At that point a person
should look before more hosted time is spent. A count derived only from gate rows needs no new
column and can't drift from the audit trail. A reset would let a disagreement loop start again
every time somebody touches the card, which is the bill the cap exists to bound.

**1f · The reason.** The re-run's prompt carries the latest refusal's reason. That is already
MOTIR-6070's contract for every next run (§10h, fourth note). This record relies on it and adds
nothing.

**1g · When it happens.** The attempt runs **after the deciding transaction commits**, never inside
it. The start path boots a container and calls other services, and a failed start must never undo a
refusal a person made. Each attempt's outcome, _re-running_ with a link to the run or _skipped_ with
its reason, is recorded against the refusal that caused it and shown on the design card. The
storage and the scheduling mechanism are MOTIR-700's.

**1h · The project's say: none beyond the press. The automatic re-run is always on for a hosted
design.** There is no per-project switch.

- **The press already chooses.** A reviewer who does not want a re-run presses **Re-plan**, which
  returns the card to To do and dispatches nothing.
- **Following the approval switch would say nothing.** With design approval off, no design gate ever
  waits for a person, so there is never a Revise to follow.
- **Spend is bounded twice:** by the cap, and by the dispatcher's own credits and model choice. A
  running hosted run can be cancelled like any other.

A third setting in the Approvals room, answering a question the press already answers, would be a
place to get the answer wrong.

### 2 · Switching design approval OFF

**2a · The setting.** `Project.designApprovalGate`, a boolean, **default `true`**. Every existing
project is migrated to `true`, so nothing changes until someone flips it. It is flipped on
**Settings → Approvals**, beside _Merge mode_ and _Acceptance video_, under the same permission:
**`workflow:manage`**.

**2b · What "off" does.** When a published design result raises its `design_result` gate and the
project's switch is off, the gate is **raised and decided `approved` in the same transaction**. The
decision goes through the design handler's own **approve** and the decide door's machinery. So its
effects are exactly a person's approval:

- the §3 status effect: `done` with no linked open pull request, `approved` with one;
- the §6c pin on the approved version;
- the readiness a dependent reads.

`subjectVersion` is written as for any approval (the evidence's `commitSha`), so the record says
which bytes were approved.

**2c · The record's shape.**

| column                  | value                                                          |
| ----------------------- | -------------------------------------------------------------- |
| `state`                 | `approved`                                                     |
| `decidedById`           | `null`                                                         |
| `decidedByLabel`        | `null`                                                         |
| `routedToId`            | `null`: nobody was asked                                       |
| `decisionSource`        | **`system`**, a NEW member of `ApprovalGateDecisionSource`     |
| `decidedUnderAuthority` | **`project_setting`**, a NEW member of `ApprovalGateAuthority` |
| `noteMd`                | `null`                                                         |

The two new enum members are the marker. Together they say that no person pressed anything and
that the authority was the project's design-approval setting. Neither column can be written with
these values from a route, a press or the MCP; only the raise path writes them, as `github_review`
is written only by the review sync.

**2d · How the decided surface words it.** _Approved automatically: design approval is off for this
project_, with the time. It never shows a blank actor and never a person's name. For a viewer who
holds `workflow:manage`, it links to the setting. The exact copy and layout are MOTIR-694's to
draw.

**2e · The §7a question, answered: a design approval is recorded as a gate row, and §7a is not
changed.** §7a withdrew a synthetic `auto_approved` gate for an `auto` merge. It relied on §6c's
principle that _the gate table records a person saying yes_, and recorded the merge's authority on
the merge instead. That was right for a merge, because nothing reads a merge gate's approval once
the merge has happened. A design approval is different: the approved row is the STATE the product
reads (see _What the shipped code already fixes_). Recording the switch anywhere else would mean
every one of those readers learns a second way of saying "approved":

- the retention pin;
- the republish guard;
- `list_designs` and `get_design` verdicts;
- the evidence service.

Every one that is missed would treat an approved design as unapproved.

**§6c's principle is kept by making the row describe itself, not by leaving it out.** "The
decisions people made" is the set of rows whose `decisionSource` is `ui`, `api`, `mcp` or
`github`. A `system` row is never in that set, it names the setting that authorised it, and it
cannot be mistaken for a person's decision or for a withdrawn question (§6b's `superseded`, which
also has a null actor). **§7a stands as written for merges.**

**2f · Flipping it.**

- **Turning it off does not decide gates already awaiting.** A person may be reviewing one right
  now, and it was raised while the project still asked.
- **Turning it back on affects only gates raised afterwards.** Automatic approvals already recorded
  stay as they are.

**2g · What it does NOT change.**

- The **planning-time design gate** (a design card must exist before UI work is planned).
- **Every other gate kind.**
- **`prMergeMode`**: with a pull request open, the design card sits at `approved` and the merge
  follows the project's merge setting as it does today.
- **The refusal rules of §10.**

With the switch off no design gate waits, so part 1's automatic re-run is never reached.

### 3 · Alternatives rejected

- **Re-run as the reviewer who pressed Revise.** Rejected: it charges a person who did not choose
  the lane or the model, and may have no hosted access at all.
- **Fall back to the offered default model when the last one is gone.** Rejected: it changes the
  cost without a decision. Skip and say so instead.
- **A per-project switch for the automatic re-run, or tying it to the approval switch.** Rejected
  (1h).
- **Off means no gate at all, with the authority recorded on the design evidence (§7a's shape).**
  Rejected (2e): the approved gate row is read as state by several readers, and each would need a
  second rule.
- **An automatic approval with only `decidedById = null`.** Rejected: §6a names a bare null as
  indistinguishable from a question nobody decided. The two enum members are the difference.

## Consequences

- **A Revise on a hosted design turns into a new hosted run without a person**, up to three times
  per card, billed to the dispatcher's organization, with the reviewer's reason in its prompt.
- **A BYOK or hand-run design is never sent to the hosted agent by a refusal.**
- **Every skipped re-run says why on the card**, so a sent-back design never just sits at To do with
  no explanation.
- **Two enum members are added** (`ApprovalGateDecisionSource.system`,
  `ApprovalGateAuthority.project_setting`). They are additive migrations, with one writer each, both
  on the raise path.
- **An auditor can separate a person's approvals from the setting's** with one filter on
  `decisionSource`.
- **A project with design approval off gets designs that unblock their dependents as soon as they
  are published**, and every one of those approvals says which setting approved it.

## What this does NOT decide

- **How the re-run is scheduled after commit** (a durable job, an after-commit hook), where each
  attempt's outcome is stored, or the enum of skip reasons. That is MOTIR-700's. This record fixes
  what each attempt must say.
- **The copy and layout** of the switch card, the system-approved state and the re-running and
  skipped lines. Those are MOTIR-694's.
- **Automatic re-runs for anything that is not a design**: a sent-back acceptance video
  (MOTIR-6071) or a code pull request.
- **Whether the cap should ever be per-project.** It is a constant here. Making it configurable is
  a new question.
- **Any change to §7a, §6c, §10a–§10f or §10h**, or to what a Revise or a Re-plan writes.
