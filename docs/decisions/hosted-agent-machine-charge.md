# ADR: A hosted run's machine time is charged per run, in credits

- **Status:** Proposed (2026-09-26), for acceptance at this card's `decision_approval` gate
- **Card:** MOTIR-6512 · **Story:** MOTIR-683 (9.1, "A card runs on the hosted agent")
- **Decided by:** Yue, 2026-09-26, in the planning conversation that produced this card (_"agent
  machine time is charged"_, then _"1, no allowance"_). This record writes that direction down; it
  does not re-open it.
- **Consumed by:**
  - MOTIR-6513 (motir-ai: the `agent_machine` debit and the run's machine totals)
  - MOTIR-6514 (motir-core: the rate constant and the charge at settle)
  - MOTIR-4483 (the agent-lane calibration, re-scoped to token cost only)
  - MOTIR-691 (the run panel's cost block: credits as model calls + machine time)
- **Supersedes:**
  - MOTIR-4331 — the two-lane decision's clause that the agent-lane margin covers _"provider tokens +
    agent HOSTING"_ (`billing-tiering.md` §2). The token half stands; the hosting half moves here.
  - MOTIR-4336 — its premise that agent hosting is COGS only, _"never a billed line"_. The meter it
    built stands unchanged; a separate reader now charges from it.
  - MOTIR-4483 — re-scoped by the plan that laid this card: it calibrates the lane on token cost alone.
  - MOTIR-685 (`hosted-agent-run.md`) — which shows a run's machine time but decides no charge for it.
    This record adds one.

> **AMENDED 2026-09-27 by [MOTIR-6525](run-death-keeps-work.md) — [`run-death-keeps-work.md`](run-death-keeps-work.md) §1.**
> The 90-minute hosted timeout is withdrawn: a healthy run has no wall-clock limit, and a hosted run's
> timeout is the **12-hour backstop** (`HOSTED_AGENT_MAX_TIMEOUT_MS`). So a run's machine time is now
> bounded by the backstop — at most `720` credits — rather than by 90 minutes. The per-minute rate, the
> rounding and _no allowance_ are unchanged.

---

## Context

A hosted run keeps one Fly machine alive for as long as its agent works: up to ~~the 90-minute timeout~~
the 12-hour backstop `hosted-agent-run.md` §5 sets (as amended 2026-09-27). Motir pays for every second of it, and the meter already records every
second against the run: `ci_container_usage` rows under the `hosted_agent` workload (MOTIR-4336),
keyed to the dispatch run by MOTIR-6448.

What the customer paid for that machine was, until now, **nothing directly**. `billing-tiering.md` §2
sized the agent-lane token margin at ~20% over _"provider tokens + agent HOSTING"_, so the machine was
meant to be paid for inside the per-token rate, calibrated later against measured hosting cost
(MOTIR-4483). Two consequences made that the wrong shape for a hosted run:

- **A run's price did not follow what it cost.** Two runs with the same tokens cost the same credits
  even when one kept its machine up five times longer, so short runs paid for long ones.
- **The run panel could not explain a bill.** It showed machine time as a figure that cost nothing,
  which is what the design reviewer asked about on MOTIR-684: _"Why machine time is billed as $, should
  it be credits too?"_ and then _"Is the credits for machine time too?"_

Motir already charges machine time elsewhere. **CI minutes** are metered in motir-core, counted
against a per-seat pool, and the overage is debited in credits through motir-ai
(`ci-minutes-allowance.md` §2, §8). **Preview machine seconds** are converted into the same pool
(MOTIR-5777). **Code-indexing** machine time is not charged, and stays that way.

## Decision

**A hosted run's machine time is charged to the dispatching organization's credits, every minute,
with no free allowance, as its own charge beside the run's model-call credits.**

1. **When.** Once per run, when the run's container **settles**, from the settled billable seconds
   the meter records for that run. Not per checkpoint: one run is one charge, rounded once.
2. **The rate: 1 credit per minute — CI's rate, one price for a Motir machine minute.** A hosted
   agent runs on the same fleet machine CI runs on (`FLEET_CONTAINER_SIZE` in
   `packages/orchestrator/src/rates.ts`: Fly, `performance`, 2 CPUs, 8 GB), and CI prices that
   machine's minute as one Linux-equivalent minute (`lib/ciMetering/runnerRates.ts`, the
   `motir_fleet` family at multiplier `1.0` — _"parity with the Linux 2-core numéraire — a PRODUCT
   decision"_) at **1 credit per minute** (`ci-minutes-allowance.md` §2). A hosted-agent minute is
   charged exactly the same. **Rejected: a cost-plus agent rate** (the machine's own cost at CI
   overage's margin, ≈0.32 credits a minute). It would price the same machine, for the same minute,
   three times cheaper when an agent uses it than when CI does, and CI's price is deliberately anchored
   to the market (GitHub's and GitLab's per-minute prices), not to Motir's cost. Margin figures stay in
   the private `margin-analysis.md`.
3. **Rounding: whole credits, rounded up once per run.** `credits = ⌈billableSeconds ÷ 60⌉`, and `0`
   for a run with `0` billable seconds. A run that never booted a container is charged nothing for
   machine time. Worked: a 30-minute run is `30` credits; 26 min 32 s is `⌈26.53⌉ = 27`; ~~a run that
   hits the 90-minute timeout is `90`~~ a run that reaches the 12-hour backstop is `720`. **This is the one place the agent charge differs from CI's:**
   CI overage carries an under-a-credit remainder to the next charge; a hosted run is one charge, so it
   rounds up once — at most one credit per run — as the credit model rounds every model call
   (`motir-ai` `credit-model.md` §3).
4. **No allowance.** Unlike CI's per-seat pool, no minute is free. Hosted runs have no free predecessor
   to replace, which is the reason CI's pool exists, and they already need credits for their model
   calls.
5. **The division of labour is CI overage's** (`ci-minutes-allowance.md` §8.6). motir-core owns the
   seconds, the rate and the conversion to whole credits (MOTIR-6514). motir-ai is handed whole credits
   and applies them (MOTIR-6513).
6. **A new ledger kind, `agent_machine`.** The charge does not reuse `ci_overage` (a different product
   with its own pool) or `debit` (a model call's). motir-ai's `CREDIT_TRANSACTION_KINDS` is a closed
   list, so adding it is an explicit motir-ai change.
7. **Exactly once, keyed on the run.** The debit's idempotency key is the dispatch run id: a retried
   settle, a replayed call or a second supervision pass charges nothing more.
8. **Never refused for balance at settle.** The machine has already run; the charge is incurred and
   may take a balance below zero, exactly as a `ci_overage` debit may. The gate is the credit check
   before the run boots (MOTIR-6447).
9. **An internal organization is charged and offset**, as every charge is (MOTIR-4337).
10. **Hosting LEAVES the agent-lane token margin.** Charging the machine directly and pricing it into
    the per-token rate as well would bill hosting twice. The agent-lane margin now covers provider
    tokens only. **This record AMENDS `billing-tiering.md` §2's "~20% over provider tokens + agent
    HOSTING" clause** (the token half stands); the text edit to that file rides the consuming card,
    MOTIR-6514, so this decision stays one document.

## Consequences

- **The run panel shows credits as model calls + machine time**, with their total, and machine time as
  a duration (MOTIR-691, drawn by MOTIR-684). The customer's bill and the panel agree.
- **MOTIR-4483 calibrates the agent lane over token cost only**: the hosting input `h` is zero, and the
  MOTIR-4336 rollup is no longer one of its inputs. The rollup is still read — by the charge.
- **The meter stays COGS.** `ciFleetCostMeterService` and `hostedAgentContainerService` still never
  bill; the charge is a separate reader of the same seconds (MOTIR-6514), so Motir's cost never becomes
  a price and a price never feeds back into the meter.
- **The index hard gate's headroom moves.** MOTIR-5280 (and MOTIR-5277, which sizes the allowance it
  guards) reserve indexing headroom as _the agent-lane margin × period revenue_. That margin now covers
  tokens only, so the reserve is computed over a different base. This record names the effect; those
  cards decide what to do about it.
- **A long-running agent now costs its dispatcher more than a short one.** That is intended, and the
  model picker and the cost block are where a dispatcher sees it coming.
- **Owed on acceptance:** nothing beyond the two build cards above and MOTIR-4483's re-scope, which the
  same approved plan already carries.

## What this does NOT decide

- **An allowance of any kind** — per seat, per tier or per organization. Rejected (Decision 4).
- **Charging code-indexing machine time.** It stays free (`code-graph-index-fleet.md`).
- **A price list per machine size or region.** There is one priced agent machine class today; a
  second one gets its own rate when it exists.
- **The agent-lane token multiplier itself.** That is MOTIR-4483's, against measured token cost.
- **CI's pool or its 1-credit-per-minute rate.** Unchanged.
- **What a user sees in the organization's usage view**, beyond the existing credits-spent total. A
  per-kind breakdown there is not decided here.
