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

### 1. The free/paid line — two independent gating axes

Motir monetizes along **two** axes, not one. Conflating them was the gap in the
earlier framing.

| Axis                                                                       | What it gates                                                                                             | Mechanism                                                                                                        | Free                                                                                                                     | Paid                                                                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **A. AI usage** (planning + hosted coding)                                 | every call crossing the `motir-core → motir-ai` boundary                                                  | the shipped **credit** ledger (`monthlyCreditAllotment` + `topUp` overage); `out_of_credits` 402 at the boundary | small monthly allotment, **no top-ups**                                                                                  | larger allotment **+ metered top-ups**                                                               |
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

### 2. The tier catalog (what 8.1.2 provisions, what 8.1.4 stores)

Three tiers. Keys are the canonical `PlanTier.key` values every downstream
subtask references. **The scale caps are measured at the `Organization`** (the
billing entity) — see §4 for why and how each is counted.

| Tier           | `PlanTier.key` | Stripe Price                          | Monthly AI allotment (v1 seed) | Credit top-ups | Non-archived work items (per org) | Projects (per org) | Max upload / file | Total storage (per org) | Orgs you can create          | Workspaces / org | Members / org           |
| -------------- | -------------- | ------------------------------------- | ------------------------------ | -------------- | --------------------------------- | ------------------ | ----------------- | ----------------------- | ---------------------------- | ---------------- | ----------------------- |
| **Free**       | `free`         | **none**                              | 200 credits                    | ✗              | **≤ 250**                         | **≤ 3**            | **10 MB**         | **2 GB**                | 1 (the auto-provisioned one) | 1                | unlimited               |
| **Pro**        | `pro`          | per-seat recurring (monthly + annual) | 2 000 credits / seat           | ✓ (metered)    | unlimited                         | unlimited          | 100 MB            | 100 GB                  | unlimited                    | unlimited        | unlimited (seat-billed) |
| **Enterprise** | `enterprise`   | none in Stripe (sales-invoiced)       | custom (contract)              | ✓              | unlimited                         | unlimited          | custom            | custom                  | unlimited                    | unlimited        | unlimited               |

(Upload sizes, total storage, and the project/work-item caps are **v1 seed
policy, tunable**, like the allotments — §Context. Free's **2 GB** mirrors Jira's
free tier; without a total cap, 250 items × 10 MB ≈ 2.5 GB could slip through, so
the per-file limit alone is not enough.)

**Reconciliation with shipped `motir-ai` (binding on 8.1.4 / MOTIR-1230).** The
shipped default-assignment constant is `BASIC_TIER_KEY = 'basic'`. **Rename it to
`free`** (the constant + the one `provisionLedger` reference; **no seeded
`PlanTier` rows exist yet**, so churn is a constant rename, not a data migration)
so the key matches the product name and the three keys above are the single source
of truth. The auto-assign-on-provision behaviour is unchanged: a new org lands on
`free` until a paid subscription moves it.

**Allotment / price numbers are v1 seed policy, not constants** (the
`ModelCreditRate` stance, §Context). They live as seeded `PlanTier` rows / Stripe
Prices and are tunable without a code change. Provisional prices for 8.1.2 to
create, **for Yue to finalize before launch** (bracketed by Jira $8.15 and Linear
$10–16/seat):

- **Pro monthly** — ~**$12 / seat / month**.
- **Pro annual** — ~**$120 / seat / year** (~2 months free).
- **Credit top-up** — a metered or one-time Price, ~**$10 per 1 000 credits**,
  charged via `creditService.topUp()`.

### 3. The Stripe Price catalog (binding on 8.1.2 / MOTIR-1141)

Provision exactly these objects; nothing for Free or Enterprise:

| Stripe Product    | Prices                      | Billing model                                           | Notes                                                                                  |
| ----------------- | --------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Motir Pro**     | `pro_monthly`, `pro_annual` | **recurring, per-seat** (`quantity` = org member count) | the org's subscription; seat quantity synced to membership                             |
| **Motir Credits** | `credit_topup`              | **metered / one-time**                                  | usage-based AI overage beyond the monthly allotment; writes via `topUp()`              |
| — (Free)          | —                           | —                                                       | **no Stripe object** — `free` tier is the absence of a subscription                    |
| — (Enterprise)    | —                           | —                                                       | **no public Stripe object** — invoiced/custom; tier flipped manually by platform staff |

The **billing entity on every Stripe Customer is the `Organization`** (one Stripe
Customer ↔ one core `Organization` ↔ one `AiOrganization`). Per-seat `quantity` is
the org's billable member count; adding/removing members updates the subscription
quantity (Stripe proration, §5).

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
   mirroring Linear's "250 non-archived issues"). `pro`/`enterprise`: unlimited.
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
   Linear-parity lever. `pro`/`enterprise`: unlimited. Gate `createProject`.
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
   least one organization whose `PlanTier` is paid** (`pro`/`enterprise`). A
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
- **Proration.** Stripe **default mid-cycle proration**. Free→Pro upgrade and seat
  additions take effect **immediately** with a prorated charge; seat removals /
  downgrades apply a proration credit (downgrade to `free` takes effect at period
  end unless the user forces it).
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

- **8.1.2 (MOTIR-1141)** provisions exactly the §3 catalog: Product "Motir Pro"
  (`pro_monthly` + `pro_annual`, per-seat recurring), Product "Motir Credits"
  (`credit_topup` metered/one-time), the webhook endpoint, the Customer Portal,
  and **Stripe Tax on**. No Stripe object for `free`/`enterprise`.
- **8.1.4 (MOTIR-1145)** stores the Stripe customer/subscription against the
  `AiOrganization` (one Customer ↔ one org), and **renames `BASIC_TIER_KEY`
  `'basic'` → `'free'`** (constant + provisioning reference; no seeded rows yet).
  Seeds the three `PlanTier` rows (`free`/`pro`/`enterprise`) with the §2 v1
  allotments.
- **8.1.4b (MOTIR-1230)** wires Stripe webhook events to tier/credit state
  idempotently, applying the §5 status→tier map via the existing
  `creditService.setOrgTier()` + `grantAllotment()`.
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
