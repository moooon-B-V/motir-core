# A design sent back is a verdict, and either verdict returns the card to To do

**Status:** proposed · **MOTIR-6419** (the decision of Story **MOTIR-6070**)

**Supersedes:** MOTIR-6072's §10h `design_result` row, §10f's open-on-press sentence, and
§10c's _"the pull-back rule still runs"_ paragraph, all in
[`approval-gates.md`](approval-gates.md).

**Consumed by:** MOTIR-6420 (the design) · MOTIR-6421 (the verdict column and the decide
door) · MOTIR-6422 (the next run is handed the reason) · MOTIR-6423 (the To-do write and
its supersede) · MOTIR-6424 (the design Re-plan seed) · MOTIR-6425 (the user doc, and the
pointer lines this record owes in `approval-gates.md`) · MOTIR-6427 (the refusal band) ·
MOTIR-6428 / MOTIR-6429 (the integration and E2E gates) · MOTIR-6071 (the acceptance
story, which reuses the To-do write)

## Context

[`approval-gates.md`](approval-gates.md) §10 (MOTIR-6072) decided what follows a refusal,
per gate kind. For `design_result` it decided a verdict at the press:

- **Revise** returns the design card to To do.
- **Re-plan** writes no status, and the planning surface opens as soon as the decision
  commits.

Since then, three things have changed or been found wrong.

1. **The requester changed the status rule** (Yue, 2026-09-26): _"the design card status
   should be sent back to to do in both cases."_ A Re-plan card left in review looks
   finished-pending-approval when it is not, and no one will claim it.
2. **The requester changed when the planner opens:** _"replan needs to be decided by the
   user too, like the decision changes requested."_ The three decision refusals already
   ASK before the planner opens (MOTIR-6211: `asksToReplanAfterPress` in
   `components/approvals/RefusalReplan.tsx`, with **Re-plan with AI** / **Not now**). So
   §10f's _"the press opens the planning surface straight after the decision commits"_
   no longer matches shipped code for ANY kind.
3. **§10c's claim about the pull-back is false against shipped code.** It says §6d's
   rule 6 supersedes the card's other `awaiting` gates when the system write moves the
   card to To do. But `applyStatusTransition` computes
   `pullsTheWorkBack = !opts.system && …` (`lib/services/workItemsService.ts`), so a
   `{ system: true }` write supersedes nothing. A sent-back design with an open pull
   request would keep a stale approve-to-merge gate waiting.

## Decision

### 1. Both verdicts return the design card to To do

On a `design_result` gate refused in Motir, **Request changes** requires a reason (§10a)
and a verdict, **Revise** or **Re-plan** (§10d, unchanged). **Either verdict** writes the
project's status that is `isInitial` AND in the `todo` category, through the gate-owned
system write §10c describes:
`applyStatusTransition(workItemId, <To do>, ctx, tx, { system: true, decidingGateId })`,
from the design handler, inside the decide door's transaction.

A project with no such status gets the refusal and its verdict recorded and no status
written (`statusDeferredReason: 'no_status_in_target_category'`), as §10c already says.

### 2. The handler withdraws the card's OTHER waiting gates itself

Because the system write supersedes nothing, the design handler supersedes every OTHER
`awaiting` gate on the card with cause `pulled_back`, in the same transaction. It must
never supersede the deciding gate.

`approvalGateRepository.supersedeAllAwaitingByWorkItem` cannot be called as it stands.
It matches every `awaiting` row on the card, and the deciding gate is still `awaiting`
while the handler runs: `decide` calls `handler.requestChanges` before its own deciding
write (`lib/services/approvalGatesService.ts`). The withdrawal therefore excludes the
deciding gate by id. How that is expressed is MOTIR-6423's to build.

The same rule governs any other gate-owned return to To do, including MOTIR-6071's
acceptance **Re-run**.

### 3. Re-plan ASKS before the planner opens

After a **Re-plan** is recorded, the decided band asks _Re-plan with Motir AI?_, exactly
as on a refused decision:

- **Re-plan with AI** opens the planning surface seeded from the gate, with an unsent
  first turn, anchored on the design card's **parent** (§10h's anchor, unchanged). The
  turn quotes the reason and names the cards `blocked_by` the design.
- **Not now** opens nothing. The decided record keeps a **Re-plan with AI** door, which
  opens the same seeded turn, or returns to a session started from it while recent
  (§10f, MOTIR-6011).

**Revise** asks nothing. The two verdicts now differ ONLY in this ask. Both write the
same status, and both hand the next run the reason (§10h note 4).

### 4. What each amended clause of `approval-gates.md` now reads

| clause                                      | what it said                                                                        | what it now reads                                                                                                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **§3**'s MOTIR-6072 pointer                 | Revise returns the card to To do; _"Re-plan opens the planner and moves nothing"_   | Both verdicts return the card to To do; Re-plan then ASKS before the planner opens                                                                                                                                 |
| **§10c**, _"The pull-back rule still runs"_ | rule 6 supersedes the other `awaiting` gates                                        | a system write supersedes nothing; the handler withdraws the other `awaiting` gates itself, as `pulled_back`, excluding the deciding gate (§2 above)                                                               |
| **§10d**, `outcomeRef`                      | _"To do's key on a Revise, NULL on a Re-plan"_                                      | To do's key on BOTH verdicts, and NULL only when no status was written. `refusal_verdict` is unchanged and is what tells the two apart                                                                             |
| **§10f**, first bullet                      | _"the press opens the planning surface straight after the decision commits"_        | after the decision commits, the decided band ASKS; the surface opens only on **Re-plan with AI**. This holds for every kind that offers the planner, and is what shipped for the three decision kinds (MOTIR-6211) |
| **§10h**, the `design_result` row           | status: **Revise** → To do, **Re-plan** → none; planner: Re-plan only, on the press | status: the design card → To do on **both** verdicts, plus the withdrawal in §2; planner: Re-plan only, **asked first**, anchored on the design card's parent                                                      |

These clauses are not rewritten here. Each gets a one-line pointer to this record,
which MOTIR-6425 adds.

## Consequences

- **A sent-back design is claimable again** under either verdict, through
  `list_ready` / `claim_next_ready`, once its own blockers allow. A revised publish on it
  raises a fresh gate. §10e (a `changes_requested` design stays open to a revised
  publish) is unchanged, and `assertDesignSettled` already refuses only over an
  APPROVED result.
- **A Re-plan card at To do can be run before any re-plan lands.** The requester chose
  To do on both verdicts, and no extra hold is added. A run on it is handed the reason
  like a Revise. Once a seeded session proposes a plan that names the card, the shipped
  plan hold parks it (`agent-authored-plans.md` AMENDMENTS 16 and 21).
- **A stale approve-to-merge gate no longer survives a design refusal.** A Workflow-B
  design card, one with an open pull request, loses its waiting merge gate when it is
  sent back. That is correct: the commits are about to change.
- **A GitHub-sourced refusal is unchanged.** It carries no verdict, writes no status and
  offers no planner (§10h's third note).
- **The hosted automatic re-run after a Revise stays Story 9.2's** (§10g, MOTIR-700). A
  Re-plan never dispatches anything.

## What this does NOT decide

- **The copy and layout of the verdict pair, the ask and the door.** Those are
  MOTIR-6420's to draw.
- **How the handler excludes the deciding gate**: a new repository method, an extra
  parameter, or a filtered call. That is MOTIR-6423's. This record fixes only the
  behaviour, which is every other `awaiting` gate withdrawn and the deciding gate never
  touched.
- **What the planner proposes once the seeded turn is sent.** That belongs to the
  planning conversation, under the shipped rules.
- **The acceptance gate's verdicts.** MOTIR-6071 decides them. It reuses §1 and §2 of
  this record for its Re-run write, and nothing else here.
- **A `done` design card.** It is closed and cannot be sent back (MOTIR-5552).
- **Any change to §10a (the required reason), §10b (GitHub review bodies), §10e or
  §10g.**
