# ADR: Hosting an agent needs a paid AI plan, and every agent's storage is charged from the organisation's monthly credits

- **Status:** Proposed (2026-09-29), for acceptance at MOTIR-6902's `decision_approval` gate. The
  direction was settled with the product owner in the planning conversations on 2026-09-29; this
  record writes it up, derives the one number it left open (the storage rate) and states its edges as
  observable behaviour. It does not re-open the direction.
- **Card:** MOTIR-6902 · **Epic:** MOTIR-6859 (_Your own agent instances_)
- **Evidence pinned at:** `motir-core` `origin/main` @ `2464b8d` (MOTIR-6860 merged, so
  `agent-instances.md` AMENDMENT 1 and 2 and `lib/agentInstances/*` are on `main`), `motir-ai`
  `origin/main` for `docs/credit-model.md`, and Fly's pricing page read 2026-09-29.
- **Supersedes:**
  - `agent-instances.md` **§3 · Sizes** and **Consequences**: _"Instance machine time is charged;
    volume storage is not. Storage is Motir's cost."_, and _What this does NOT decide_'s _"Charging
    volume storage. Not charged here."_ Volume storage is charged (§2 below).
  - `agent-instances.md` **§5 · The charge — one debit per running interval**, its bullet _"The credit
    pre-flight gates create and wake"_, as the ONLY gate. A paid-AI-plan check now runs before it
    (§1 below). The credit pre-flight stays, second.
  - `agent-instances.md` **AMENDMENT 2 §3 · No organisation cap; the pool's cap is a safety valve, not
    a product limit**: `MOTIR_INSTANCE_MAX_RUNNING` as ONE count across every organisation, and the
    _Motir is busy_ refusal it produced. It becomes a per-organisation cap (§3 below).
  - MOTIR-6868's design, **partially**: its refusal set gains _needs an AI plan_ and _your
    organisation's running limit_, loses _Motir is busy_, and its _Your limit_ and _Not enough
    credits_ copy mentions storage (§4 below). The rest of that design stands.
  - The researched version of this card, which charged storage plus a 30-day retention delete. The
    retention delete is dropped; the AI-plan gate is what stops an abandoned trial from holding disks.
- **Amends (names the clause; the edit rides the consuming card, not this diff):**
  - `internal-billing-classification.md` **§4 · What the classification does NOT do**, _"It lifts no
    cap and grants no entitlement."_ For the **agent lane only**, an `internalBilling` org skips the
    agent limits (§5 below). Everywhere else that sentence stands, and the flag gains no meaning
    outside this lane.
- **Unchanged, and cited:** `hosted-agent-machine-charge.md` (1 credit per running minute, and
  Decision 8, _never refused for balance at settle_), `agent-instances.md` **§6 · The fleet ceiling**'s
  per-user cap of 10, `billing-tiering.md` **§2 · The catalog** (the AI plan table and the two-lane
  margin) and **§4 · The entitlement caps + the org-creation gate** (what the $5 seat buys),
  `fleet-per-org-pool.md` §1 (the paid-plan check and its fail-closed rule, which this record reuses).
- **Consumed by:**
  - **MOTIR-6860** — the agent-instances story whose create path, wake path, running cap and storage
    premise this record changes. Its code is the substrate the build edits.
  - **MOTIR-6868** — the My agents design; its refusal copy changes as §4 says, drawn as a delta by
    MOTIR-6916.
  - **MOTIR-6914** — the build story. §7 maps every piece to its subtask and repository.

---

## Context

MOTIR-6860 shipped agent instances. Each one is a Fly Machine plus a **10 GB Fly volume** mounted at
the sandbox user's home (`agent-instances.md` §1, §3; `INSTANCE_VOLUME_SIZE_GB = 10` in
`lib/agentInstances/config.ts`). On `main` today:

1. **Machine time is charged; storage is not.** A running interval costs 1 credit per minute
   (`agent-instances.md` §5, AMENDMENT 2 §1). A hibernated agent costs nothing, and Fly still bills
   Motir for its volume: _"You'll be charged for volumes that you create, whether they are attached to
   a Machine or not, including when an attached Machine is stopped."_ (Fly pricing, read 2026-09-29.)
2. **Any organisation with a positive balance may create or wake an agent.** `assertCredits`
   (`lib/services/agentInstanceLifecycleService.ts`) asks motir-ai's `agent-run-check`, which answers
   _"is the balance above zero?"_. The Free AI tier's one-time 300 credits pass it.
3. **So a trial can hold ten disks for ever.** A Free org's member can create 10 agents
   (`INSTANCE_MAX_PER_USER`), let them hibernate, and leave. Motir then pays about $15 a month for their
   volumes, plus snapshots, with nothing to charge it against.
4. **The running cap is one number for all of Motir.** `instanceMaxRunning()` reads
   `MOTIR_INSTANCE_MAX_RUNNING` (default 50) and `reserveSlot` counts every organisation's running
   agents against it. One busy organisation refuses every other one with _"Motir is running as many
   machines as it can right now."_
5. **Motir's own organisations meet customer limits.** Only the meta org's CREDIT gate is bypassed,
   in motir-ai (`hasCredits = isMeta || balance > 0`, `src/services/gatewaySyncService.ts`).

The card as first filed asked the $5 tracker seat to cover the storage. The product owner chose the
opposite: seats stay the price of tracker scale, and everything an agent costs is paid in credits.

---

## Decision

**Hosting an agent instance requires a paid monthly AI plan** (Standard, Pro, Max or Enterprise). An
organisation on the tracker only, the free tracker or the $5-per-seat scaled tracker, cannot create or
wake any agent, and neither can one on the Free one-time AI tier.

**There is no free storage.** Every agent that exists, running or hibernated, has its volume storage
debited from the organisation's **monthly credit pool**: the same pool (plus top-ups) that pays for its
machine minutes and for planning. One gate (you have an AI plan) and one currency (credits) cover
everything an agent costs. **Seats pay for tracker scale and nothing else.**

**Each organisation has its own running-agent cap.** `MOTIR_INSTANCE_MAX_RUNNING` counts one
organisation's running agents, not Motir's. In the product owner's words: _"50 is not enough for all
motir orgs for sure, motir is multi tenants, we should change MOTIR_INSTANCE_MAX_RUNNING to per org."_

**Motir's own organisations have no agent limit.** The meta org (`Organization.isMeta`, moooon B.V.)
and every internal org (`Organization.internalBilling`) skip every agent limit: _"meta org and internal
org have no limit."_ They are still charged on the ledger like any organisation.

The sections below fix what the direction left open.

### §1 · Who may host

- **A paid monthly AI plan** is the motir-ai `PlanTier` `standard`, `pro`, `max` or `enterprise`
  (`billing-tiering.md` §2's AI table). The check is the one `fleet-per-org-pool.md` §1 defines and
  MOTIR-6909 builds once for the fleet: for the three Stripe-billed tiers the subscription is `active`
  or `past_due`, and Enterprise, which has no Stripe object, is read from its tier.
- **It runs at create and at wake, BEFORE the credit pre-flight.** A tracker-only org is told it needs
  a plan, never that it is out of credits.
- **A plan that cannot be read refuses** (fail closed), with its own words (§4).
- **`isMeta` or `internalBilling` passes** (§5).
- **A self-hosted build checks nothing**, exactly as `assertCredits` returns early when
  `isCloudBilling()` is false. There is no AI plan to hold and no storage charge (§2).
- **The Free AI tier is not a paid plan.** Its 300 one-time credits still pay for planning; they no
  longer open the agent lane.

### §2 · What storage costs — the rate, derived

**The rate is 10 credits per agent per UTC day.** It is derived, not chosen, from four inputs, each
named with its source:

| Input                          | Value                                                                                                                                                          | Source                                                                                                                                                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Volume size                    | 10 GB, fixed, no auto-extend                                                                                                                                   | `agent-instances.md` §3; `INSTANCE_VOLUME_SIZE_GB`                                                                                                                                                                                                                            |
| Fly volume price               | **$0.15 / GB-month of provisioned capacity**, prorated hourly, charged whether the machine runs or not                                                         | docs.fly.io/about/pricing, _Persistent Storage_, read 2026-09-29                                                                                                                                                                                                              |
| Fly snapshot price             | **$0.08 / GB-month of stored data**, first 10 GB free each month per Fly organisation; stored incrementally; daily snapshots with 5 days' retention by default | the same page, read 2026-09-29                                                                                                                                                                                                                                                |
| The credit's retail peg        | **1 credit = $0.01**                                                                                                                                           | motir-ai `docs/credit-model.md` (_"a credit retails at $0.01"_), the top-up price in `billing-tiering.md` §2 ($10 per 1,000)                                                                                                                                                  |
| The agent lane's margin target | **~20%** over cost                                                                                                                                             | `billing-tiering.md` §2, the two-lane DECISION (_"a small margin (~20%, near-cost)"_). Since MOTIR-6514 that lane's per-token margin covers tokens only and hosting is charged directly; storage is a hosting charge made directly, so the lane's stated target is its markup |

**Snapshots are UNMEASURED.** No agent instance was reachable from the session that wrote this record,
so no snapshot's stored size was read. The figure below takes **one full copy of the volume** as the
retained snapshot data: Fly stores snapshots incrementally, so five days of retention is one base copy
plus four days of changes. Those daily changes are unmeasured and counted as zero. The bound is **$0.00**
(an empty home) to **$4.00** per agent-month (five independent full copies: 5 × 10 GB × $0.08). The
10 GB free allowance is one allowance for the whole fleet Fly organisation, which every Motir agent
shares (`agent-instances.md` §7), so it is counted as zero per agent.

The derivation, per agent per month:

```
volume        10 GB × $0.15                          = $1.50
snapshots     10 GB × $0.08   (one full copy; UNMEASURED)  = $0.80
cost                                                  = $2.30
+ margin      $2.30 × 1.20                            = $2.76
in credits    $2.76 ÷ $0.01                           = 276 credits / agent-month
per day       276 ÷ 30                                = 9.2  →  ⌈9.2⌉ = 10 credits / agent / day
```

**It rounds UP to a whole credit**, for the reason motir-ai's `credit-model.md` gives for pricing
unclassified turns in the expensive lane: under-charging is unrecoverable, over-charging is a refund
conversation. The day rate makes a 30-day month 300 credits and a 31-day month 310.

**How the rate moves with its inputs** (per agent):

| Basis                                                | $ / month | credits / month | credits / day |
| ---------------------------------------------------- | --------- | --------------- | ------------- |
| Volume only, at cost                                 | $1.50     | 150             | 5             |
| Volume only, + 20%                                   | $1.80     | 180             | 6             |
| **Volume + one full snapshot copy, + 20% (chosen)**  | **$2.76** | **276**         | **10**        |
| Volume + five full snapshot copies (the bound), +20% | $6.60     | 660             | 22            |

**Re-deriving it.** The rate lives in one constant in motir-core (§7). When a measured snapshot size
exists (the first agent instance on production, read from Fly's snapshot list), or Fly's prices move,
the row above is re-computed with the measured figure and the constant changes with a note in this
record. The approver who would rather Motir absorb snapshots picks the second row, 6 credits per day,
at the gate.

**How it is charged.**

- **One debit per agent per UTC day on which the agent existed at any moment**, running, hibernated
  or failed. The day it is created is charged; so is the day it is deleted.
- **Idempotent on the agent and the day**: the ledger's `externalRef` is
  `agent-storage:<instance id>:<YYYY-MM-DD>`, so a retried or replayed charge debits nothing more.
- **Under its own ledger kind, `agent_storage`**, beside `agent_machine`, so the billing page can show
  storage and machine time as two figures (§6).
- **Never refused for balance.** The disk already existed that day; the charge may take a balance
  below zero, exactly as `hosted-agent-machine-charge.md` Decision 8 lets a machine debit.
- **An internal org's debit is offset** by motir-ai's `internal_offset`, as every charge is
  (`internal-billing-classification.md` §2), so what Motir's own agents cost stays visible.

### §3 · How many — credits, bounded by two caps

Credits are the limit. Two caps bound the worst case:

- **Per organisation: `MOTIR_INSTANCE_MAX_RUNNING` running agents per organisation, default 50**, set
  by an operator. It is counted per organisation under the one existing fleet admission lock, the same
  rule `fleet-per-org-pool.md` §2 applies to CI's pool (a per-org lock re-opens the race that lock
  closes). One organisation at its cap is refused in words naming its own limit (§4), and never slows
  another organisation. There is no longer any fleet-wide agent count, so _Motir is busy_ has no
  source and is removed.
- **Per person: at most 10 existing agents**, unchanged, as a safety valve. AMENDMENT 2 kept it
  because storage was uncharged, and said _"It can go if volume storage is ever charged."_ It stays
  anyway, by the product owner's direction: it bounds one person's mistake, not an organisation's bill.
- **`MOTIR_FLEET_MAX_IN_FLIGHT=0`** stays the operator's kill switch for every workload
  (`fleet-per-org-pool.md` §6).
- **The fixed 10 GB volume stays.** `agent-instances.md` §3 rejected auto-extend because storage was
  uncharged. It stays rejected for a new reason: a fixed size keeps the daily rate one number an owner
  can read.

### §4 · What a person sees

Each row is observable behaviour; the words are the ones shown. The refusal code is the
`AgentInstanceStartRefusedError` reason, and the sentence is its message. MOTIR-6916 draws them as a
delta on MOTIR-6868's design and may adjust punctuation, never meaning.

| Situation                                                                                                | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Words                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A tracker-only or Free-AI-tier org** presses **New agent** or **Wake**                                 | Refused before any credit check or Fly call. Nothing is created or started                                                                                                                                                                                                                                                                                                                                                                                                                          | `ai_plan_required` — _"Agents need a paid AI plan (Standard, Pro, Max or Enterprise). <link>Choose an AI plan</link> to create or wake one."_ The link opens _Billing & plans_                                                                   |
| The plan cannot be read                                                                                  | Refused (fail closed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `ai_plan_unknown` — _"Motir could not check your organization's AI plan just now. Try again in a moment."_                                                                                                                                       |
| **An org at its running limit** creates or wakes one more                                                | Refused. Only this org waits; another org's create at the same moment proceeds                                                                                                                                                                                                                                                                                                                                                                                                                      | `org_running_limit` — _"Your organization is running {limit} of its {limit} agents. Hibernate one to start another."_ (replaces `fleet_busy`)                                                                                                    |
| **An org at zero credits** creates or wakes                                                              | Refused. Its running agents are hibernated by the sweep, as AMENDMENT 2 §1 already does. Its hibernated agents stay hibernated and cannot wake. **Storage keeps accruing** past zero (§2), and **nothing is deleted**                                                                                                                                                                                                                                                                               | `credits` — _"Your organization is out of credits. Agents use credits while they run and for their storage every day, asleep or not. <link>Add credits</link> to create or wake an agent."_                                                      |
| **An org drops its AI plan** (the subscription leaves `active` / `past_due`, or the tier becomes `free`) | From that UTC day: create and wake are refused with `ai_plan_required`. A running agent runs on, charged, until it goes idle and hibernates. Each agent is scheduled for deletion **30 days later**, at the start of that UTC day. Each owner is emailed once, on the lapse day. Storage keeps being charged while the agents exist. **On the date, each agent's machine and volume are deleted**, through the ordinary delete. **Re-subscribing before the date cancels every scheduled deletion** | Email subject: _"Your agents in {organization} will be deleted on {date}"_. Page banner: _"Your organization's AI plan has ended. Your agents will be deleted on {date} unless the plan is renewed."_ On each row: _"Will be deleted on {date}"_ |
| **A person with 10 agents** creates an 11th                                                              | Refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `user_cap` — _"You already have 10 agents. Each one is charged for its storage every day, even asleep. Delete one to create another."_                                                                                                           |
| **The meta org or an internal org** creates, wakes, or runs past any of the above                        | Never refused by the plan, the per-person cap, the running cap or credits, never hibernated by the sweep for credits, and never scheduled for deletion. Machine and storage charges still land on its ledger and show on its billing page                                                                                                                                                                                                                                                           | No refusal is ever shown                                                                                                                                                                                                                         |

Idle hibernation and the 12-hour backstop (`agent-instances.md` §2, AMENDMENT 1) are lifecycle, not
limits: they apply to every organisation, Motir's own included.

### §5 · Motir's own organisations

An organisation with `isMeta` **or** `internalBilling` skips, in the agent lane:

1. the paid-AI-plan gate (§1);
2. the per-person cap of 10 and the per-organisation running cap (§3);
3. the credit pre-flight at create and at wake;
4. the sweep's hibernate-on-credits (AMENDMENT 2 §1);
5. the plan-lapse deletion (§4).

It is **still charged**: every machine interval and every storage day is debited like any other org's.
An `internalBilling` org's debits are offset by `internal_offset`; the meta org's balance is whatever
its ledger reads, since motir-ai already never refuses it (`hasCredits = isMeta || balance > 0`).

**Neither flag gains a new meaning.** `isMeta` already means _every cap lifted, the AI paywall off_
(`internal-billing-classification.md` §1), so the agent lane reading it is that meaning applied.
`internalBilling` means _charged like a customer, then made whole_; this lane also reads it as _no
agent limit_, which is the scoped amendment named in this record's header. The build reads each flag
where the gate is; nothing else changes on account of this record.

### §6 · Where the organisation sees it

The billing page's new **Agents** line, beside _Motir CI_, shows this period's **machine credits** and
**storage credits**, from motir-ai's usage read (which returns `agentMachine` today and gains
`agentStorage`). An org without a paid AI plan and without agents sees the line's no-plan state. The
states are MOTIR-6917's to draw.

---

## §7 · The build, checked against MOTIR-6914's subtasks

| Piece                                                                                                                                                                                                                                                       | Repository            | Subtask                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------ |
| The shared paid-plan check: `standard` / `pro` / `max` / `enterprise`, subscription `active` or `past_due`, Enterprise by tier, fail-closed, `isMeta` passing (this record adds `internalBilling` passing for the agent lane's call)                        | motir-core            | MOTIR-6909 (fleet story) |
| The `agent_storage` ledger kind and `POST /v1/credits/agent-storage`, idempotent on `agent-storage:<instance id>:<day>`, never refused for balance, offset for an internal org, reported by the usage read as `agentStorage` beside `agentMachine` (§2, §6) | motir-ai              | MOTIR-6915               |
| My agents delta: the `ai_plan_required`, `ai_plan_unknown` and `org_running_limit` refusals, the storage wording in `credits` and `user_cap`, the lapse banner and the per-row deletion date (§4)                                                           | motir-core            | MOTIR-6916 (design)      |
| Billing & plans delta: the Agents line with machine and storage credits, its empty and no-plan states (§6)                                                                                                                                                  | motir-core            | MOTIR-6917 (design)      |
| Create and wake call the plan check before `assertCredits`, fail closed, skipped on a self-hosted build (§1)                                                                                                                                                | motir-core            | MOTIR-6918               |
| The daily storage charge: `INSTANCE_STORAGE_CREDITS_PER_DAY = 10` in `lib/agentInstances/config.ts`, one job debiting every agent that existed that UTC day, failed debits retried (§2)                                                                     | motir-core            | MOTIR-6919               |
| The Agents line on Billing & plans, typing `agentMachine` and `agentStorage` in `RawUsageResponse` (§6)                                                                                                                                                     | motir-core            | MOTIR-6920               |
| The plan lapse: record it from the billing push, schedule each agent's deletion 30 days on, email each owner, show the date, delete at it, clear it on re-subscribe (§4)                                                                                    | motir-core            | MOTIR-6921               |
| `MOTIR_INSTANCE_MAX_RUNNING` counted per organisation under the fleet admission lock, `org_running_limit` replacing `fleet_busy`, and the `isMeta` / `internalBilling` exemption from every agent limit (§3, §5)                                            | motir-core            | MOTIR-6926               |
| Integration gates over the above                                                                                                                                                                                                                            | motir-core · motir-ai | MOTIR-6922 · MOTIR-6923  |
| E2E and acceptance video                                                                                                                                                                                                                                    | motir-core            | MOTIR-6924               |

Every piece has a subtask and every subtask has a piece. The rate is converted to credits on the
motir-core side, which runs the meter (`credit-model.md` §4a, _the meter's owner converts_); motir-ai
is handed whole credits and never learns what a volume costs.

---

## §8 · What storage costs a plan — the table

At the chosen rate, 10 credits per agent per day, over a 30-day month, as a share of each paid plan's
monthly allotment (`billing-tiering.md` §2: Standard 2,000, Pro 8,000, Max 30,000):

| Agents | Storage credits / month | Standard (2,000) | Pro (8,000) | Max (30,000) |
| ------ | ----------------------- | ---------------- | ----------- | ------------ |
| 1      | 300                     | 15%              | 3.8%        | 1.0%         |
| 3      | 900                     | 45%              | 11.3%       | 3.0%         |
| 10     | 3,000                   | **150%**         | 37.5%       | 10.0%        |

Snapshots are included at the unmeasured one-copy estimate (§2). Machine minutes are extra.

**Said plainly:** at Fly's cost, ten agents' volumes alone are about 1,500 credits a month, three
quarters of Standard's pool. At the charged rate, ten agents' storage is **one and a half times
Standard's whole monthly pool**, before a single machine minute or planning pass. A Standard
organisation can keep about three agents and still plan; a heavier user of agents needs Pro, Max or
top-ups. That is the direction working as intended, not a side effect: the agent lane is sold on the
plans built for it (`billing-tiering.md` §2: Pro _"planning + hosted coding"_, Max _"heavy agent"_).

---

## Alternatives rejected

- **The $5 seat pays for storage** (the card as first filed). A seat is the price of tracker scale
  (`billing-tiering.md` §4), and a solo org on a paid AI plan pays no seat at all, so the seat cannot
  fund what an agent costs.
- **Free storage bounded by a per-user cap** (MOTIR-6860 as shipped). It leaves a trial holding ten
  disks at Motir's cost for ever.
- **Charge storage and delete after 30 days of disuse** (the researched version of this card). The
  AI-plan gate removes the abandoned-trial case the retention delete existed for, and deleting a
  paying customer's idle agent is a worse surprise than charging for it.
- **Storage at cost, no margin** (5 credits/day). Every other hosting charge carries a margin, and
  snapshots would then be Motir's unrecovered cost.
- **Keep one fleet-wide running cap and raise it.** One organisation's burst would still refuse every
  other one, which is the fault the product owner named.

---

## Consequences

- A tracker-only or Free-AI-tier organisation can no longer create or wake an agent. Agents are an
  AI-plan feature.
- Every existing agent costs its organisation 10 credits a day, running or asleep, shown on the
  billing page as storage beside machine time.
- An organisation that drops its AI plan loses its agents 30 days later unless it renews, and each
  owner is told the date.
- No organisation's agents wait on another's: the running cap is per organisation.
- Motir's own organisations run agents without limits and still see what they cost.
- The per-user cap of 10 and the fixed 10 GB volume stay, as safety valves.

---

## What this does NOT decide

- **The machine price.** 1 credit per running minute stays `hosted-agent-machine-charge.md`'s.
- **The CI fleet pool** (`fleet-per-org-pool.md`, MOTIR-6901). This record makes only the agent pool
  per organisation.
- **The agent-lane token multiplier** (MOTIR-4483).
- **The AI plan prices and allotments** (`billing-tiering.md` §2) and **the seat** (§4).
- **A second reminder email** before the deletion date. One notice is sent, on the lapse day.
- **Restoring a deleted agent.** Deletion destroys the machine and the volume, as today's delete does.
- **The measured snapshot size.** §2 names how the rate is re-derived once it is read.
