# ADR: Open-core tiering + pricing model (free PM-core ↔ paid AI; credit-metered; the cloud entitlement caps)

- **Status:** Accepted (2026-06-21, locked with Yue). This is the rung-1 pricing
  decision Story 8.1 implements — no billing code ships until it is locked.
- **Story / Subtask:** 8.1 (Stripe billing + open-core tiering) · Subtask 8.1.1 (MOTIR-1138)
- **Supersedes / superseded by:** none. **Relates to / absorbs** MOTIR-1106
  (8.6.2 "Decide pricing strategy: free PM-core ↔ paid AI boundary") — that card
  is the same decision in Epic 8.6 and should be closed as a duplicate of this ADR.
- **Builds on:** `organization-tier.md` (the `Organization` = billing entity +
  `Organization → N Workspace → Project` hierarchy + progressive disclosure +
  signup auto-provisioning). This ADR adds the **commercial layer** (tiers,
  prices, entitlement caps, lifecycle) ON TOP of that tenancy model — it changes
  no tenancy shape.
- **Consumed by:** 8.1.2 (MOTIR-1141, Stripe Products/Prices/webhook/Portal/tax),
  8.1.3 (MOTIR-1142, billing/paywall design), 8.1.4 (MOTIR-1145, motir-ai
  Stripe customer/subscription schema), 8.1.4b (MOTIR-1230, idempotent
  webhook → tier/credit state), 8.1.5 (MOTIR-1146, Checkout + Portal endpoints),
  8.1.6 (MOTIR-1147, billing boundary service), 8.1.7 (MOTIR-1148, billing
  settings + plan UI), 8.1.8 (MOTIR-1149, AI-boundary paywall), 8.1.9/8.1.10
  (tests/E2E) — **and a NEW subtask, 8.1.11 (entitlement/cap enforcement)**, which
  this ADR surfaces as a planning gap (see Consequences).

> Convention (set by `work-item-type-taxonomy.md`, followed by
> `organization-tier.md`): a decision record is a markdown file under
> `docs/decisions/`, structured **Status → Context → Decision → Consequences**,
> with the load-bearing facts pinned in explicit tables so downstream code has one
> authoritative source to implement against. **No application behaviour ships in
> this subtask** — the shapes it freezes are what make the rest of Story 8.1
> buildable.

---

## Context

Epic 8 turns Motir into a commercial product. The open-core thesis (`_shared.md`,
`vision.html` Principle #19) is fixed: **`motir-core` (the PM tracker) is
free/open-source forever; the AI layers (`motir-ai` — Epic 7 planning + Epic 9
hosted coding) are the paid product**, metered/gated at the `motir-core ↔
motir-ai` boundary. This ADR locks how that thesis becomes Stripe Products,
PlanTiers, and enforcement.

Three things were already shipped or decided and this ADR must **reconcile
against them, not re-invent them**:

1. **The billing entity is the `Organization`** (`organization-tier.md` §3, locked
   with Yue; `prisma/schema.prisma` — the `Organization` model). Usage and billing
   roll up to the org; one account may belong to multiple orgs (N:N membership);
   signup auto-provisions exactly one org + one default workspace
   (`organization-tier.md` §6).

2. **The metered unit is the `credit`** — an internal usage unit, **never a
   currency** (`design/ai-usage/design-notes.md`). The AI side is already built in
   `motir-ai`:
   - `model PlanTier { key @unique, name, monthlyCreditAllotment }` — the tier
     row (`motir-ai/prisma/schema.prisma:302`).
   - `model AiOrganization { coreOrganizationId @unique, planTierId? }` — **ONE
     balance + ONE tier per org**; `planTierId` is nullable because the org is
     created before billing is provisioned (`motir-ai/prisma/schema.prisma:26`).
   - `creditService.ts`: `BASIC_TIER_KEY = 'basic'` is the **default tier
     auto-assigned at first ledger provisioning, with no Stripe involved**
     (`provisionLedger` → `setOrgTier(basic)`); `topUp()` is the purchased-credit
     path; `grantAllotment()` grants `tier.monthlyCreditAllotment` monthly.
   - The AI boundary already raises a typed **`out_of_credits` → HTTP 402**
     (`motir-ai/src/problem.ts:16`; `creditGate.test.ts`).
   - Per-model credit cost is **policy, not code** — `ModelCreditRate` is
     effective-dated seed/config (`motir-ai/prisma/schema.prisma:317`). The same
     stance applies to tier allotments and prices here: **the numbers below are
     v1 seed values, tunable without a code change**, not hard-coded constants.

   So billing **builds on** this ledger — the shipped auto-assigned `basic` tier
   **IS** the free tier (default, no payment). Stripe writes into this ledger; it
   does not re-implement metering (Story 7.2 owns usage; 8.1 owns money-in).

3. **Self-host is real and uncapped.** `motir-core` is GPL-3.0 and runs WITHOUT
   `motir-ai`/Stripe. Billing is **cloud-only** (`organization-tier.md` notes the
   self-host gate; the front-door already has `isAiPlanningConfigured`).

### What this ADR adds beyond the prior decisions (Yue, 2026-06-21)

The earlier framing ("PM-core is free, AI is paid") left the **free tier
unbounded** — unlimited members, workspaces, organizations, and work items. That
is not a durable commercial shape: a free account could farm unlimited free
tenants and run an unbounded project at zero cost, and there would be no growth
lever pulling a scaling team toward a paid plan. Yue's decision: **the cloud free
tier is bounded** — one organization, one (default) workspace, and a **cap on the
number of work items** (plus the secondary caps: a small project limit, a per-file
upload-size limit, and a per-org total-storage cap) — and **creating additional
organizations
requires a paid org**, precisely because the org is the charging entity (an
ungated free-org-create loophole would defeat every per-org cap). **All these
counts are measured at the `Organization`, the billing entity** (§4).

### The verified mirror (rung 1 — cited, not asserted)

How the two reference products bound their free tiers (June 2026):

- **Jira (Atlassian) — caps SEATS.** The Free plan is a hard **10-user** ceiling
  (no time limit), 2 GB storage; user 11 forces the whole team onto Standard
  ($8.15/user/mo).
  ([Atlassian — Explore Jira Cloud plans](https://support.atlassian.com/jira-cloud-administration/docs/explore-jira-cloud-plans/);
  [Atlassian — Jira pricing](https://www.atlassian.com/software/jira/pricing))
- **Linear — caps SCOPE, not seats.** The Free plan allows **unlimited members**
  but caps **work items** at **250 non-archived issues** (plus 2 teams / 10 MB
  uploads); the 250-issue cap is the real wall — new-issue creation is blocked
  once it is hit.
  ([Linear pricing 2026 — costbench](https://costbench.com/software/developer-tools/linear/free-plan/);
  [Linear pricing — Quackback](https://quackback.io/blog/linear-pricing))

**Motir mirrors Linear's scope cap, not Jira's seat cap (Yue, after reviewing
both).** For a PM tool the **work item is the unit of value**, so capping work
items is the better, less hostile growth lever than capping seats: a free team can
be any size (collaboration is the product's whole point), but a free _project_
stays small. This supersedes the earlier "no unlimited members" instinct — once
the work-item count is the binding cap, a separate seat cap is redundant friction.
The fit with shipped reality is exact: **Motir already has soft-archive**
(`workitem-archive` — a non-cascading archive/unarchive), so the cap is on
**non-archived** work items — archived items don't count, mirroring Linear's "250
_non-archived_ issues" precisely and giving free users a built-in escape valve
(archive to make room) instead of a hard delete. Members stay **unlimited** on
free. (This is also GitLab/Plane-shaped: a real, permanent free plan capped by
scope, with the self-managed/self-host build uncapped — §6.)

---

## Decision

### 1. Two gating axes + two BILLED dimensions (seats and AI are decoupled)

Motir's free/paid line is gated on **two axes**, and what a paid org **pays for**
is **two decoupled dimensions**. Keeping them separate is the core of this model.

| Axis                                                                       | What it gates                                                                                             | Mechanism                                                                                                        | Free                                                                                                                     | Paid                                                                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **A. AI usage** (planning + hosted coding)                                 | every call crossing the `motir-core → motir-ai` boundary                                                  | the shipped **credit** ledger (`monthlyCreditAllotment` + `topUp` overage); `out_of_credits` 402 at the boundary | a **one-time** trial grant (signup), **no top-ups**                                                                      | an **org-level** monthly credit pool **+ metered top-ups**                                           |
| **B. PM-core scale** (work items / projects / storage / workspaces / orgs) | per-**org** counts: non-archived work items, projects, per-file + total storage, workspaces, org-creation | **entitlement caps** keyed off the org's `PlanTier`, measured at the org                                         | 1 org · 1 workspace · ≤ 3 projects · ≤ 250 non-archived work items · ≤ 10 MB/file · ≤ 2 GB total · **unlimited members** | lifted (unlimited work items/projects, 100 MB/file, 100 GB total, multi-workspace, create more orgs) |

- **Axis A is the open-core thesis** — the AI layers are the paid product, metered
  by credits, gated at the boundary. Confirmed to map onto the **shipped
  `out_of_credits` (402)** enforcement.
- **Axis B is the cloud commercial layer** — caps that exist **only on cloud** to
  pull a growing team toward a paid plan. They are NOT in open-core; **self-host
  is uncapped** (§6).
- **The PM tracker itself stays free and fully-featured** — work items, boards,
  sprints, reports, search, MCP, custom fields, automation. The free tier is
  bounded by **scale** (how many non-archived work items / workspaces / orgs),
  never by **feature removal** or a seat cap inside the one workspace it gives
  you. (This preserves "the PM substrate is real, not a veneer", Principle #8,
  while still giving growth a price.)

**The two BILLED dimensions are decoupled (Yue, 2026-06-21):**

- **Per-seat tracker access — priced WELL BELOW Jira/Linear.** A seat pays only
  for using the PM tracker (the Jira/Linear-equivalent: issues, boards, sprints,
  reports). Motir competes as the **cheaper tracker**, so the per-seat fee sits
  **well under Jira ($8.15) and Linear ($10)** — a team can adopt Motir purely as
  a Jira replacement, never touching the AI.
- **Org-level AI credits — NOT per-seat.** Planning and hosted coding run against
  the **org's project**, not a person — they are **org-level activities**. So AI is
  a **credit pool granted to the ORG** (flat, independent of seat count), plus
  metered top-ups. A 3-seat and a 30-seat Pro org get the **same** AI pool (buy
  top-ups or go Enterprise for more). This is **exactly the shipped shape** —
  `AiOrganization` already holds **ONE balance + ONE flat `monthlyCreditAllotment`
  per org**, never a per-seat figure (`credit-model.md` §4).
- **Credits are funded by a per-ORG fee, NEVER by the seat fee (the margin rule).**
  Credits cost real money to serve, so a cheap per-seat fee **cannot** subsidize
  them: a 1-seat $4/seat org would owe more in inference than it pays. Therefore
  each tier's AI pool carries its **own flat per-org price** set to cover that
  pool's credit COGS + margin, **separate from** the seat fee. A 1-seat org pays
  `$4 (tracker) + (its tier's per-org AI fee)`, and the AI fee — not the $4 — funds
  the pool. **No margin hole at any seat count.** (This is the resolution of the
  1-seat-floor caveat raised last revision.)

So an org's bill = **(a flat low per-seat tracker fee) + (the tier's org-level AI
credit pool)** — two Stripe line items on one subscription, moving independently.
The **per-seat tracker fee is the SAME across every paid tier** (Starter /
Standard / Pro / Max all unlock the identical, cap-lifted tracker — there is no
reason the same tracker costs more on a higher tier), and **the tier you pick sets
the size of the org AI pool** (funded by that tier's per-org AI fee, §2). That is what makes the tiers a clean ladder of _AI capacity_:
**Starter** (a taste of planning) → **Standard** (everyday planning for a project)
→ **Pro** (+ hosted coding agent) → **Max** (+ heavy agent: design, docs, coding) →
**Enterprise** (custom). Seats scale your tracker cost; the tier scales your org's
AI.

**AI model choice is the USER's — transparent, per-model-priced (no black box).**
Motir does **not** silently route AI work to a model of its own choosing. The user
**selects which model runs each kind of work** — planning, and each hosted-agent
task type (design, docs, coding, …) — **per project** (the model catalog + the
per-project model config live in the AI layers: Epic 7 planning, Epic 9 hosted
coding). Three billing consequences:

- **Each model carries its own cost-plus `ModelCreditRate`** (`credit-model.md`
  §2), so the **credits a task burns reflect the chosen model's real cost** — a
  Claude turn burns ~3.9× (Opus) to ~7.7× (Fable) the credits of a DeepSeek turn
  for the same work. The user **sees** that and chooses with eyes open; the cost
  difference is **theirs**, paid in credits, surfaced transparently — never hidden
  in a blended bill.
- **Motir's margin per credit is therefore uniform across models** (no involuntary
  model-mix exposure): Motir isn't picking the model and isn't absorbing its cost,
  so a pricier model depletes the **user's** pool faster without thinning Motir's
  margin. A tier's pool COGS is a fixed dollar amount set by its credit count,
  model-independent. **The COGS / margin figures live only in the private
  `motir-meta/margin-analysis.md`, never in this open-source repo.**
- **Gate:** a model is **selectable only once its `ModelCreditRate` is seeded**
  (the §2 reconciliation rule) — an unpriced model can't meter (the shipped guard
  refuses it). The **default planner is DeepSeek** (cheapest); whether planning
  quality on the cheaper model matches Claude is a **product question to test**, and
  the per-project override lets a user pick a pricier model for planning if they
  want it.

### 2. The tier catalog — SIX tiers (what 8.1.2 provisions, what 8.1.4 stores)

Six tiers for distinct use cases. Per §1, an org's bill = a **per-seat tracker fee**
(cheap — covers the tracker, beats Jira/Linear) **+ a per-org AI fee** (covers the
tier's credit pool — the margin rule). The two are independent: the **tier sets the
credit pool and its per-org fee**; seats only scale the tracker.

**Pricing** (illustrative `$` — the STRUCTURE is fixed; exact `$` awaits the Epic-8
credit→`$` peg):

| Tier           | `PlanTier.key` | Use case                                      | Per-seat tracker / mo | Org AI pool / mo | Per-org AI fee / mo | Cadence      | Top-ups |
| -------------- | -------------- | --------------------------------------------- | --------------------- | ---------------- | ------------------- | ------------ | ------- |
| **Free**       | `free`         | register & try                                | $0 (capped)           | 300              | $0 (loss-leader)    | **ONE-TIME** | ✗       |
| **Starter**    | `starter`      | a cheaper Jira/Linear + try planning monthly  | **$4**                | 300              | ~$5                 | monthly      | ✓       |
| **Standard**   | `standard`     | everyday planning for one project             | **$4**                | 2,000            | ~$20                | monthly      | ✓       |
| **Pro**        | `pro`          | planning + hosted coding agent                | **$4**                | 8,000            | ~$70                | monthly      | ✓       |
| **Max**        | `max`          | planning + heavy agent (design, docs, coding) | **$4**                | 30,000           | ~$250               | monthly      | ✓       |
| **Enterprise** | `enterprise`   | customized                                    | custom                | custom           | custom              | monthly      | ✓       |

**The 1-seat margin is safe by construction.** A 1-seat Starter org pays **$4 +
~$5 = ~$9/mo**, and the **~$5 (not the $4) funds its 300 credits** — never
underwater. A 10-seat Starter org pays **$40 + ~$5 = ~$45/mo** for the _same_ single
AI pool. The **$4 tracker seat is the Jira/Linear competitor** (~half their price);
the per-org AI fee scales with the **pool**, not the team.

**Free vs Starter — what the monthly fee buys.** Free gives 300 credits **once** (a
$0 trial); Starter gives 300 credits **every month** + lifts the scale caps + the
cheap paid tracker. Starter = "Motir as my (cheap) tracker, with a recurring taste
of planning."

**PM-core scale caps (measured at the `Organization` — §4). Free is capped; every
PAID tier lifts them identically:**

| Tier              | Non-archived work items | Projects  | Upload / file | Total storage | Workspaces | Orgs you can create | Members   |
| ----------------- | ----------------------- | --------- | ------------- | ------------- | ---------- | ------------------- | --------- |
| **Free**          | **≤ 250**               | **≤ 3**   | **10 MB**     | **2 GB**      | **1**      | 1 (auto)            | unlimited |
| **Starter → Max** | unlimited               | unlimited | 100 MB        | 100 GB        | unlimited  | unlimited           | unlimited |
| **Enterprise**    | unlimited               | unlimited | custom        | custom        | unlimited  | unlimited           | unlimited |

The tiers differ **only by AI capacity**, never by tracker features. All numbers
are v1 seed policy, tunable. (Free's 2 GB mirrors Jira's free tier.)

**Reconciliation with shipped `motir-ai` (binding on 8.1.4 / MOTIR-1230).** The
shipped default tier is **`basic` ("Basic"), 1,000 credits/MONTHLY**, seeded in the
`credit_ledger` migration and auto-assigned by `creditService` (`BASIC_TIER_KEY =
'basic'`; `credit-model.md` §4). Changes:

1. **Rename `basic` → `free`** (constant + the seeded row) and **make its grant
   ONE-TIME** — 300 credits at provisioning, never refreshed. Add a **cadence field
   on `PlanTier`** (`allotmentCadence: 'one_time' | 'monthly'`, default `monthly`).
2. **Add `starter` (300), `standard` (2,000), `pro` (8,000), `max` (30,000),
   `enterprise` (custom)** rows, all `monthly` cadence.
3. **The monthly allotment scheduler** (8.1.4b / ops) grants only **`monthly` tiers
   with allotment > 0** — `free` (one-time) never refreshes; the five paid tiers do.

A one-row update + five inserts + a nullable column — NOT a user-data migration;
existing `AiOrganization.planTierId` FKs (by id) stay valid. The pool stays the
shipped **flat per-org `monthlyCreditAllotment`** (NOT × seats).

**AI pool sizing** (off the shipped credit math — `credit-model.md`: default
`deepseek-v4-pro` = 1.0/1k in · 2.0/1k out · ×1.5 → a representative 8k-in/1.2k-out
turn = **16 credits**; one onboarding planning pass ≈ 150–250 credits):

- **Free = 300, ONE-TIME** — try planning once.
- **Starter = 300 / mo** — a recurring taste (~1–2 passes/mo); the cheap-tracker tier.
- **Standard = 2,000 / mo** — everyday planning for one project (~10 passes/mo).
- **Pro = 8,000 / mo** — planning + a run of hosted coding subtasks.
- **Max = 30,000 / mo** — heavy agent: sustained design + docs + coding across epics.
- **Enterprise = custom.** All paid tiers add metered **top-ups** for overage.

**Prices (for 8.1.2; Yue to finalize with the peg):** tracker **$4/seat/mo**
(**$40/yr**); per-org AI fees illustratively **~$5 / ~$20 / ~$70 / ~$250** for
Starter / Standard / Pro / Max; **credit top-up $10 / 1,000**.

> **COGS — resolved by construction (the margin rule, §1).** Because every tier's
> credits are funded by its **per-org AI fee** (not the seat fee), margin holds at
> **any** seat count, including 1. The remaining binding rule for Epic 8: when the
> credit→`$` peg is set, fix each tier's per-org AI fee **≥ (pool credits × `$`/credit)
> × margin**, and **never let the seat fee fund credits** (the `notes.html` #10
> lesson). If a pool can't be priced profitably as a flat per-org fee, raise the fee
> — do not absorb it into the seat.

### 3. The Stripe Price catalog (binding on 8.1.2 / MOTIR-1141)

A paid org's subscription carries **two recurring items**: one **shared per-seat
tracker** price (`quantity` = seats) + one **flat per-org AI-pool** price for its
tier (`quantity` 1). Provision:

| Stripe Product                                | Prices                                                                         | Billing model                                | Notes                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Motir Tracker** (seat)                      | `tracker_monthly`, `tracker_annual`                                            | **recurring, per-seat** (`quantity` = seats) | the **same** item on every paid tier ($4/seat); lifts the caps                              |
| **Motir AI — Starter / Standard / Pro / Max** | `starter_pool_{monthly,annual}`, `standard_pool_*`, `pro_pool_*`, `max_pool_*` | **recurring, flat per-org** (`quantity` 1)   | the tier's monthly AI fee that **funds** its credit pool; an org has **exactly one**        |
| **Motir Credits** (top-up)                    | `credit_topup`                                                                 | **metered / one-time**                       | pay-as-you-go overage beyond the pool; writes via `topUp()`                                 |
| — (Free)                                      | —                                                                              | —                                            | **no Stripe object** — free = no subscription (the one-time 300 is granted at provisioning) |
| — (Enterprise)                                | —                                                                              | —                                            | **no public Stripe object** — invoiced/custom; tier set by platform staff                   |

So a 5-seat Pro org = `5 × tracker_monthly` + `1 × pro_pool_monthly`. The org's
`PlanTier` is determined by **which pool price** sits on the subscription (8.1.4b
maps `*_pool_*` → tier). The **billing entity on every Stripe Customer is the
`Organization`** (one Customer ↔ one core `Organization` ↔ one `AiOrganization`);
the seat item's `quantity` syncs to membership (Stripe proration, §5), the pool
item stays `quantity` 1.

### 4. The entitlement caps + the org-creation gate (Yue, binding)

The caps from §2, stated as enforceable rules (the enforcement home is the new
8.1.11 — see Consequences):

> **All scale caps are counted at the `Organization`, not the workspace or
> project (binding).** The hierarchy is `Organization → Workspace → Project →
work item`; the **org is the billing entity**, so every entitlement is measured
> at that boundary. Counting at the org is also **ungameable** — a user can't
> split work across projects/workspaces to dodge a cap — and matches Linear, which
> counts at its workspace-root (= Motir's org). On `free` the question is moot
> anyway (one workspace), but the org-level definition is the one that stays
> coherent when a paid org has many workspaces. The entitlement helper resolves
> the org **up** from the entity being created (work item → its project → its
> workspace → its org) and counts there.

1. **Work items (the headline cap — Linear's model).** `free` org: **≤ 250
   non-archived work items across the whole org** (summed over every project in
   every workspace it owns). Creating the 251st is blocked with an upgrade prompt
   (the user can **archive** items to free room — archived items don't count,
   mirroring Linear's "250 non-archived issues"). `starter`/`standard`/`pro`/`max`/`enterprise`: unlimited.
   Counted via the existing soft-archive state (`workItem` `archivedAt: null`,
   already a repository pattern), so the cap reuses shipped data — no new "deleted
   vs active" concept. **Members are NOT seat-capped on free** — the work-item
   count is the binding lever, so a free team can be any size (collaboration is the
   point); they hit the wall on _project size_, not _headcount_. (Mirror: Linear's
   scope cap, chosen over Jira's seat cap — §Context.)
2. **Projects (the secondary Linear lever).** `free` org: **≤ 3 projects** across
   its org. A Motir `Project` (the issue container, under a workspace) is the
   analogue of a Linear **team**, and Linear's free plan caps **teams at 2**; Motir
   allows a slightly more generous 3 because it folds the extra workspace tier away
   on free. The 250-item cap is the real wall; this is the belt-and-suspenders
   Linear-parity lever. `starter`/`standard`/`pro`/`max`/`enterprise`: unlimited. Gate `createProject`.
3. **Uploads — TWO limits: per-file size AND total org storage.**
   - **Per-file size (tier the SHIPPED limit).** motir-core **already** enforces a
     global **`MAX_UPLOAD_BYTES = 10 MB`** (`lib/blob/allowlist.ts`, raising
     `FileTooLargeError`; checked in `attachmentsService` + `usersService`) — exactly
     Linear's free 10 MB. Make it **tier-derived**: `free` **10 MB** / `pro`
     **100 MB** / `enterprise` custom.
   - **Total storage per org (NEW — there is none today).** The shipped code caps
     only per-file; nothing sums usage, so free storage is currently unbounded (250
     × 10 MB ≈ 2.5 GB slips through). Add a **per-org total-storage cap**: `free`
     **2 GB** (mirrors Jira's free tier) / `pro` **100 GB** / `enterprise` custom.
     Computed as the **`SUM(Attachment.sizeBytes)` across the org's workspaces**
     (`Attachment.workspaceId → Workspace → Organization`; blobs live in Vercel
     Blob); checked at the upload path: reject when `currentOrgBytes + file.size`
     exceeds the tier limit. v1 computes the sum on upload (cheap at free scale,
     bounded by the item cap); a cached running counter is a later optimization. A
     single-file overage from a concurrent race is benign (storage, not money), so
     a strict `FOR UPDATE` is optional here.
   - All four numbers are tunable seed policy.
4. **Workspaces per org.** `free` org: **exactly 1** (the auto-provisioned default
   workspace; the "new workspace" affordance is gated). `pro`/`enterprise`:
   unlimited. (The data model already carries the tier — `organization-tier.md` §6
   — so there is **never a migration** as a team grows; only the cap lifts.)
5. **Org creation.** A user may create their **first** org for free (it is
   auto-provisioned at signup — every account is an org-of-one from day one). To
   create **any additional** organization, the user MUST be **owner/admin of at
   least one organization whose `PlanTier` is paid** (`starter`/`standard`/`pro`/`max`/`enterprise`). A
   free-only account cannot spin up a second org.
   - **Rationale.** The org is the charging entity. If free-org creation were
     ungated, a user could create N free orgs and dodge the per-org work-item cap
     (250 items × N orgs = an unbounded free workload). Gating new-org creation
     behind a paid org closes the loophole **without** taxing onboarding (the
     first org is always free).
   - New orgs created by a paid account **start on `free`** (with caps) until
     individually upgraded — each org is its own billing entity.

**Downgrade is never destructive (binding on 8.1.11 / MOTIR-1230).** When an org
drops from paid to `free` (cancellation/non-payment, §5), over-cap data is
**locked, never deleted**:

- Work items beyond 250 → **all retained and readable; creating NEW items is
  blocked** until the count is back under cap (archive to free room) or the org
  re-upgrades. Nothing is deleted (Linear's exact behaviour).
- Projects beyond 3 / workspaces beyond the first → **read-only / locked**; the
  user picks which to keep active (or re-upgrades). No data is removed.
- All existing files stay; only NEW uploads are held to the free per-file (10 MB)
  and total-storage (2 GB) limits — an over-2 GB org cannot upload until it's
  back under (delete files) or re-upgrades. Nothing is deleted automatically.
- AI allotment → drops to the `free` allotment; top-ups disabled.

### 5. Trial, proration, dunning (subscription lifecycle → tier state)

- **Trial.** **No separate free trial in v1** — the **`free` tier is the perpetual
  trial** (the GitLab/Linear shape: a real, permanent free plan de-risks adoption
  without dunning complexity). An optional 14-day Pro trial via Stripe
  `trial_period_days` is a **non-blocking later** addition.
- **Proration.** Stripe **default mid-cycle proration**, applied independently to
  the two items (§3). Free→paid, an **AI-pool tier change** (Starter↔Pro↔Max — swap
  the `*_pool_*` price), and **seat add/remove** all prorate immediately; a
  downgrade to a smaller pool or to `free` takes effect at period end unless forced.
  A **tier-to-tier downgrade among paid tiers** (e.g. Max→Starter) only **shrinks
  the org AI pool** — the tracker stays paid, so the §4 caps stay lifted; only `free`
  re-applies the caps.
- **Dunning + grace (binding on 8.1.4b / MOTIR-1230 — applied idempotently from
  the webhook).** Stripe Smart Retries + dunning emails. Subscription status maps
  to entitlement:

  | Stripe subscription status                 | Motir org tier / access                                                                                                             |
  | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
  | `active`, `trialing`                       | paid tier active                                                                                                                    |
  | `past_due`                                 | **KEEP paid access through the grace window** (Stripe's retry window, ~2–3 weeks); allotment intact; show a "payment failed" banner |
  | `canceled`, `unpaid`, `incomplete_expired` | **drop to `free`**: re-apply caps (§4 non-destructive lock), allotment → free, top-ups off                                          |

  The webhook flips `AiOrganization.planTierId` via the existing
  `creditService.setOrgTier()` — the mechanism already exists; 8.1.4b only wires
  Stripe events to it, idempotently.

### 6. Tax + the cloud/self-host gate

- **Tax.** **Stripe Tax ON for v1** (`automatic_tax` on Checkout + subscriptions)
  — low effort, globally correct. Start registered in **NL/EU** (moooon B.V. is a
  Netherlands entity → EU VAT, reverse-charge for EU B2B via VAT-ID collection in
  the Customer Portal) and **US**; rely on Stripe Tax threshold monitoring and
  collect only where registered, expanding as thresholds are crossed.
- **Self-host = cloud-only billing, uncapped.** Billing **and** the §4 caps exist
  **only on cloud**. A single explicit flag distinguishes the builds: **`MOTIR_CLOUD`
  env (default `false`)**.
  - `MOTIR_CLOUD=false` (self-host): no checkout UI, no paywall, the entitlement
    layer is inert, **all caps lifted** — full GPL-3.0 PM tracker, unbounded.
  - `MOTIR_CLOUD=true` (Motir cloud): billing + caps + paywall active.
  - Use an **explicit** flag (not inferred from the presence of `motir-ai`/Stripe
    config), so a self-hoster who DOES connect their own `motir-ai` is **not
    force-billed**. This is **distinct from** `isAiPlanningConfigured` (which gates
    whether AI is _reachable_); both are `false` on a bare self-host, but they
    answer different questions and must stay separate flags.

### 7. Permissions — who manages billing

Reuse `OrganizationRole` (`owner | admin | member`) and `resolveOrgAccess.isOrgAdmin`
(`organization-tier.md` §4 — owner is the sole billing/destructive authority):

| Action                                                        | owner | admin | member                             |
| ------------------------------------------------------------- | ----- | ----- | ---------------------------------- |
| Start checkout / change plan / change payment method / cancel | ✓     | ✗     | ✗                                  |
| View billing + usage / invoices                               | ✓     | ✓     | ✗                                  |
| Trigger an upgrade prompt (hit a cap / paywall)               | ✓     | ✓     | ✓ (prompt routes them to an owner) |

Billing **mutations are owner-only**; admins get **read** (view plan, usage,
invoices). The `isOrgAdmin` helper gates the read surface; an `isOrgOwner` check
gates the mutations. Self-host: N/A (no billing surface).

---

## Consequences

- **8.1.2 (MOTIR-1141)** provisions exactly the §3 catalog: Product "Motir
  Tracker" (`tracker_monthly` + `tracker_annual`, per-seat), Product "Motir AI"
  with the **four** flat-per-org pool Prices (`starter_pool_*` / `standard_pool_*` /
  `pro_pool_*` / `max_pool_*`), Product "Motir Credits" (`credit_topup`,
  metered/one-time), the webhook endpoint, the Customer Portal, and **Stripe Tax
  on**. No Stripe object for `free`/`enterprise`.
- **8.1.4 (MOTIR-1145)** stores the Stripe customer/subscription against the
  `AiOrganization` (one Customer ↔ one org), **renames `BASIC_TIER_KEY` `'basic'`
  → `'free'`**, **adds a `PlanTier.allotmentCadence` (`one_time` | `monthly`)
  column**, **converts the seeded tier to `free` (300, `one_time`)**, and **adds the
  `starter` (300), `standard` (2,000), `pro` (8,000), `max` (30,000), `enterprise`
  (custom) rows** (all `monthly`) — a one-row update + five inserts + a nullable
  column, not a user-data migration.
- **8.1.4b (MOTIR-1230)** wires Stripe webhook events to tier/credit state
  idempotently: maps the subscription's `*_pool_*` price → `PlanTier`, applies the
  §5 status→tier map via the existing `creditService.setOrgTier()`, and grants the
  monthly allotment for `monthly`-cadence tiers only (skips `free`/one-time).
- **8.1.8 (MOTIR-1149)** is the **Axis-A** paywall — the `out_of_credits` 402 +
  tier gate at the AI boundary (upgrade prompt when allotment is exhausted and no
  top-up is allowed on `free`).
- **⚠️ Planning gap surfaced — Axis-B caps have no owner → new subtask 8.1.11.**
  None of the existing 8.1 subtasks enforces the §4 **PM-core scale caps** (the
  work-item / project / upload / workspace / org-creation gates + the
  paid-org-to-create-orgs rule + the non-destructive downgrade-lock). 8.1.6/8.1.7
  build the billing _boundary + settings_; 8.1.8 is the _AI_ paywall; none gates
  work-item creation, `createProject`, the attachment upload, `createWorkspace`, or
  `createOrganization` by tier. This ADR adds **8.1.11 — "motir-core: PM-core
  entitlement/cap enforcement (work-item / project / upload / workspace / org gates
  by tier, cloud-only)"**, `blocked_by` this decision, to own that contract (a
  single tier-aware entitlement helper the work-item-create / project-create /
  workspace-create / org-create services + the attachment-upload path call, behind
  `MOTIR_CLOUD`; all caps measured at the `Organization`, the work-item count
  reuses the shipped non-archived state, the per-file gate turns the already-shipped
  `MAX_UPLOAD_BYTES` (`lib/blob/allowlist.ts`) into a tier-derived limit, and the
  **total-storage gate is net-new** — `SUM(Attachment.sizeBytes)` per org checked
  at upload, which nothing does today).
- **Self-host stays GPL-3.0 and uncapped** — the caps + billing live behind
  `MOTIR_CLOUD`; the open-core PM tracker a self-hoster runs is unbounded and
  shows no checkout. The cross-story audit stays clean: 8.1 takes no dependency on
  Epic 7 internals beyond the already-shipped credit ledger it builds on.
- **MOTIR-1106 (8.6.2)** is the same pricing-strategy decision in Epic 8.6 and is
  now redundant with this ADR — close it as a duplicate, pointing here.
- **Out of scope (named so they land in their owning story):** the actual Stripe
  account creation (a `manual/human` prerequisite of 8.1.2); platform-staff
  manual tier flips for Enterprise (Epic 10); the org-scoped usage/credit _view_
  (Story 7.12.5); per-region tax registration ops (operational, not code).
