# ADR: An MCP-authored plan is reviewed like a hosted one

- **Status:** Accepted (2026-09-24)
- **Decided by:** the requester (Yue), in the planning conversation
- **Work item:** MOTIR-6157 (`type: decision`)
- **Amends:** `approval-gates.md` §11.5b — see _What this amends elsewhere_
- **Consumed by:** MOTIR-6043 (where a plan row opens) · MOTIR-6044 (the row's copy) · MOTIR-6045 (the destination rule) · MOTIR-6158 (the plan drawn as it is written)

---

## Context

Motir has two planners. **Motir AI** holds its conversation inside the product, so its turns are on
the planning surface. **An agent using the MCP** — a runbook session, an external CLI — holds its
conversation in its own harness, and Motir never sees those turns.

The product read that absence as _this plan has nobody to talk to_, and sent an agent-authored plan
to its own read-only page instead of the planning surface (`approval-gates.md` §11.5b, and the
design result of MOTIR-6033 §20.2). The requester has changed that.

## Decision

**A plan an agent writes through the MCP is watched and decided in the PLANNING PHASE exactly as a
Motir AI plan is.** The door the plan was written through changes who typed, not what the planning
phase is.

The absent turns are a fact about the TRANSCRIPT, not about the plan. What a person wants to watch
and decide is the planning phase itself — cards arriving as they are written, the tree readable as a
List or a Canvas, and Motir AI still there to change it. None of that depends on who wrote the plan.

So an MCP plan is a first-class planning session, and the planning surface is where it is read while
it is being made and once it is proposed.

### The mechanism it rests on — a session exists from the FIRST PROPOSAL

`create_plan` opens a session of origin `mcp` in the same call that opens the plan
(`lib/mcp/tools/authorPlan.ts`, `session: { origin: 'mcp' }` — `agent-authored-plans.md`
AMENDMENT 17 §4–§5). There is a conversation surface to open from the plan's first proposal onward,
before any turn exists.

**An empty transcript is not an absent conversation, and no reader may treat the two as the same.**
AMENDMENT 17 §5 makes `Plan.sessionId` universal — every plan belongs to exactly one session, the
backfill included — so _has a session_ and _has turns_ are different questions, and it is the first
that says whether there is a planning phase to watch.

## What the decision REQUIRES of the MCP surface — and what already ships

The decision is only keepable if an MCP planner can do, in the planning phase, what the hosted one
does. It can. The surface is **SIX tools**, not the four-step walk a short reading suggests, and two
of them answer questions that reading leaves open.

| the planner wants to                       | the door                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| open the plan                              | `create_plan` — and its session, origin `mcp`                                   |
| lay a level's titles and edges             | `add_plan_items`                                                                |
| author one card's bodies and sizing        | `update_plan_item`                                                              |
| **revise the plan's own TITLE or SUMMARY** | **`update_plan`** (MOTIR-4637)                                                  |
| correct or withdraw a proposal             | `update_plan_proposal` / `withdraw_plan_proposal`                               |
| **move the plan to PROPOSED**              | **`final: true` on `add_plan_items`**, which reaches `plansService.markPlanned` |

- **The brief is NOT write-once.** `create_plan` describes `summary` as _"shown to the reviewer above
  the tree"_, and a planner rarely knows the right sentence until the tree exists. `update_plan`
  patches `title` and `summary` sparsely (omit = untouched, `null` = clear) and is refused only on a
  FROZEN plan — `approved` / `declined` — so **an agent may correct the brief after the tree is
  written and before it proposes**, which is what the hosted planner does.
- **Closing does not require inventing a last proposal.** `final: true` rides on `add_plan_items`,
  and **an EMPTY batch carrying it is legal**: the close is over what the plan ALREADY holds, so
  `add_plan_items({ planId, proposals: [], final: true })` is the plain _submit_ door after a last
  correction. **The one refusal to know:** `markPlanned` DISCARDS a plan holding **zero proposals in
  total** — `declined` / `discarded`, never queued — because _"`planned` means somebody is being
  asked to decide, and there is nothing here to decide"_ (MOTIR-4124). An empty CALL is fine; an
  empty PLAN is not.

**On the word _proposed_.** The enum is `generating → planned` (`PlanStatus`); the surfaces label
those _Writing_ and _Waiting for approval_, and _Proposed_ is the review vocabulary for the same
state. Closing moves the plan to `planned`.

## What this amends elsewhere

**`approval-gates.md` §11.5b's third bullet**, insofar as it sends _"an agent-authored MCP plan whose
session has no turns"_ to the plan page. That clause is superseded by this decision.

**The edit to that file belongs to Story MOTIR-6043**, which owns where a plan row opens, and is
deliberately not made here: a decision record states the direction, and the surface that consumes it
carries its own change. The same holds for the copy MOTIR-6033's published design attaches to the
no-conversation state, which is MOTIR-6044's.

## Consequences

- An undecided MCP-authored plan opens the **planning surface** at its session, turns or no turns.
- `approvalGate.planApproval.noConversation.agent` — _"{harness} wrote this plan outside a
  conversation, so it opened on its own page"_ — can no longer be true, and MOTIR-6044 retires it.
- The planning surface must be legible for a session with **no turns**: the transcript is empty and
  the plan is the content. MOTIR-6158 (the plan drawn as it is written) is where that is built.
- Nothing about DECIDING a plan changes. The plan-approval gate, its verbs, its routing and its
  authority are `approval-gates.md` §11, untouched.

## What this does NOT decide

- **Where a row opens for any OTHER plan** — a cadence plan, a backfilled plan, a plan with no
  session row at all. Story MOTIR-6043 and `approval-gates.md` §11.5b own the destination rule in
  full.
- **The copy** on any row or notice (MOTIR-6044).
- **What the planning surface SHOWS once open** — the level it lands on (MOTIR-6154) and the cards
  arriving with their edges and motion (MOTIR-6158).
- **Whether the close deserves a door of its own** rather than a flag on `add_plan_items`, and
  whether the three vocabularies for one status should be reconciled. Both are recorded above as
  facts, not settled here.
