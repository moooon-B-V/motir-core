# The per-seat CI-MINUTES allowance + credit overage

**Status:** accepted · **Date:** 2026-07-30 · **Card:** MOTIR-1898 (Story MOTIR-1775 —
establish the project's repository set at plan approval) · **Evidence pinned at:**
`motir-core` `origin/main` @ `a5ac04a2` (**includes the MOTIR-1893 ownership amendment**),
`motir-ai` `origin/main` @ `93afca4`, `nextjs-prisma-vercel-starter`
`.github/workflows/ci.yml` · **Vendor pricing + API status read 2026-07-30** (sources in §9)

Motir hosts some of its users' repositories, so Motir pays some of their CI bill. This
record prices that: the **included allowance** every seat carries, the **rate** the
overage draws from the credit ledger, how the pool is **pooled and reset**, how minutes
are **normalized** across runner types, the **two exhaustion thresholds**, how a workflow
run is **attributed** to an org, **what the user sees**, and **which repo owns** the
entitlement.

The charging MODEL was fixed by Yue on 2026-07-30: _"we give every seat a default CI
minutes per month; when that amount is exceeded, we start charging the credits."_ This ADR
supplies the numbers and the mechanics; it does not re-open the model.

## Context

### The cost — and it applies to EVERY new project, not a subset

`docs/decisions/project-repository-set.md` §3 establishes every new project's repository
set. Private-repo Actions minutes bill to the **repository owner**, so where Motir owns
the repo, Motir pays for the CI — from the first `motir run` onward, because every
dispatch ends in a PR and every PR runs CI. That is why this is not an Epic 9 concern: it
starts the day the pre-Epic-9 loop works.

**The 2026-07-30 amendment (Yue · MOTIR-1893) makes that universal.** _"Every repository
Motir CREATES for a new project is created under Motir's own organization, for both
audiences, with no branch on what the user has."_ The earlier §3.1/§3.2 branch — repos in
the user's account when a GitHub identity is connected — is **superseded**. So the metered
population is **every newly created project repository**, and the amendment says so in its
own standing-consequences note: _"Every new project's repositories live there, so their
Actions minutes and storage bill to Motir."_

Only two paths reach a repo Motir does **not** pay for, and both are exits rather than
alternatives:

| Path                                        | Repo lives in      | Who GitHub bills | Metered here |
| ------------------------------------------- | ------------------ | ---------------- | ------------ |
| **Created** for a new project (the default) | **Motir's org**    | **Motir**        | **yes**      |
| **Connect-existing** (code the user has)    | the user's account | the user         | no           |
| **After the 9.3.7 handoff** (MOTIR-711)     | the user's account | the user         | no           |

This is the full exposure, not a fraction of it: **every org that dispatches drains the
pool.** §1's numbers are set against that, and §1.5 states the risk it creates rather than
discounting it.

The hosting org is a **GitHub** org (MOTIR-1779, working login `motir-projects`), created
through `POST /orgs/{org}/repos` with an org-scoped provisioning App. **Motir never creates
a GitLab repository** — GitLab is reachable only through connect-existing, i.e. a namespace
the user already owns and GitLab already bills them for. §5.5 records what follows for the
meter.

### What one dispatch actually costs — derived from the starter's own CI

The metered workload is **the seeded starter's** CI, not `motir-core`'s (a sharded E2E
matrix that no user project runs). `nextjs-prisma-vercel-starter/.github/workflows/ci.yml`
is four jobs, all `ubuntu-latest`, plus a cleanup workflow on PR close:

| Job                           | What it runs                                                        | Est. min |
| ----------------------------- | ------------------------------------------------------------------- | -------- |
| `lint`                        | install → `lint` → `format:check`                                   | ~3       |
| `typecheck`                   | install → `prisma generate` → `typecheck`                           | ~3       |
| `build`                       | install → generate → `migrate deploy` → `next build` (+ PG service) | ~5       |
| `e2e` (`needs: build`)        | install → generate → migrate → `playwright install` → `test:e2e`    | ~8       |
| `cleanup-preview-deployments` | one short job, on PR close                                          | ~1       |

**The suite runs TWICE per merged dispatch.** The workflow triggers on
`pull_request` **and** `push: branches: [main]`, and the two are separate concurrency
groups — so the four jobs bill once on the PR and again on the merge commit. GitHub bills
**per job, rounded up to the minute**, and jobs bill in parallel by wall clock, so the
figure is the sum of the jobs, not the critical path:

```
(3 + 3 + 5 + 8) × 2 suites + 1 cleanup  ≈  39 Linux minutes per merged dispatch
```

**~35–40 minutes per dispatch, and that is a FLOOR** — every fix-up commit pushed to the
PR branch re-runs the PR suite (the `cancel-in-progress` concurrency group keeps it to one
live run per push, not one per dispatch), and a CI failure the agent has to chase
multiplies it.

MOTIR-1898's own calibration said _"~20 minutes ≈ one dispatch"_. That counts the PR run
only and misses the merge-to-`main` re-run and the cleanup job. **The planning figure this
ADR uses is ~39 minutes**, and it is an estimate from the workflow's shape, not a
measurement — MOTIR-1896's meter is what produces the real number, and §1.4 names the
trigger to re-derive from it.

### The three prices this is set against (verified at source, §9)

| Fact                              | Value                                         |
| --------------------------------- | --------------------------------------------- |
| A Motir seat                      | **$5/mo**, $40/yr (`lib/billing/catalog.ts`)  |
| A Motir credit, retail            | **~$0.01** (top-up: 1,000 credits for $10)    |
| A Linux 2-core x64 Actions minute | **$0.006** (GitHub, since the 2026-01-01 cut) |

## Decision

### §1 — 300 included Linux-equivalent minutes per seat per month, with a 1,000-minute per-org floor

**The pool for an org, evaluated at read time:**

```
pool(org) = max( members × 300 , 1000 )   Linux-equivalent minutes, per calendar month
```

**1.1 · Why 300 per seat.** At full drain it costs Motir **300 × $0.006 = $1.80 per seat
per month**, and it buys **~7–8 dispatches per person per month** at the §Context figure
of ~39 min per merged dispatch.

Measured against revenue three ways, because the seat line alone is the wrong denominator:

| Org                            | Pool            | Cost at full drain | Revenue            | % of revenue |
| ------------------------------ | --------------- | ------------------ | ------------------ | ------------ |
| Per seat, monthly cadence      | 300             | $1.80              | $5.00 seat         | **36%**      |
| Per seat, annual cadence       | 300             | $1.80              | $3.33 seat (¹⁄₁₂)  | **54%**      |
| Solo, Standard AI (seat incl.) | 1,000 _(floor)_ | $6.00              | $25.00             | **24%**      |
| 5-person team, Standard AI     | 1,500           | $9.00              | $45.00 ($25+4×$5)  | **20%**      |
| 8-person team, Pro AI          | 2,400           | $14.40             | $110.00 ($75+7×$5) | **13%**      |

**The seat fee is not the right denominator, and this is the load-bearing argument.** CI
minutes are generated by _dispatches_, a dispatch requires a _plan_, and planning burns
_credits_ — so **an org that consumes this pool necessarily holds a paid AI plan.** Per
`billing-tiering.md` §1 a paid AI plan even bundles the first seat, so the solo case has
$25 of AI revenue and $0 of seat revenue: reading the allowance against the $5 seat line
alone would price it against revenue that org does not pay. Against total ①+② revenue the
worst case is **13–24%**, and the 36%/54% seat-only rows are the honest ceiling for the
one shape that pays seats without AI — a tracker-only org, which by construction dispatches
nothing and drains nothing.

**These rows are the LIVE case, not a remote ceiling** — see §1.5. Since MOTIR-1893 every
created repo is Motir-owned, so there is no subset of projects that quietly costs nothing.

**1.2 · Why a 1,000-minute per-org floor, and why 1,000.** A pure `seats × 300` pool
starves exactly the user this hosting model exists for — the solo founder whose whole
project lives in Motir's org and who has no second machine to run CI on. At 300 minutes a
solo user gets ~7 dispatches a month; the product's own loop is not usable at that rate.

The floor binds for orgs of **1–3 members** (3 × 300 = 900 < 1,000); a 4-person org
(1,200) clears it. At full drain it costs **$6.00/org/month**, 24% of the $25 Standard AI
plan such an org holds.

**1.3 · Where that sits against the mirrors — Motir is deliberately below both.**

| Product                   | Included compute, private repos | Priced at              |
| ------------------------- | ------------------------------- | ---------------------- |
| GitLab Free               | 400 / namespace / mo            | $0                     |
| **Motir (floor)**         | **1,000 / org / mo**            | the AI plan it implies |
| GitHub Free               | 2,000 / account / mo            | $0                     |
| GitHub Team               | 3,000 / org / mo                | $4 / user / mo         |
| **Motir (4-person team)** | **1,200 / org / mo**            | $25 AI + 3 × $5        |
| GitLab Premium            | 10,000 / namespace / mo         | $29 / user / mo        |

Both mirrors pool **flat per account, not per seat**, and both are more generous than
Motir at small sizes. That is a deliberate deviation on both axes, and the reasoning is
not "we are cheaper":

- **Per-seat, not flat**, because here CI is generated by _people dispatching agents_. A
  hand-written commit's CI does not scale with headcount the way an agent loop's does, so a
  flat pool that is right for a 2-person team is a blank cheque for a 20-person one.
- **Smaller than GitHub/GitLab**, because they are compute vendors selling a DevOps
  platform, for whom included minutes are a loss-leader on their own infrastructure. Motir
  **resells GitHub's compute** — the same $0.006 GitHub charges it — so a 3,000-minute
  giveaway is $18/org/month of pure pass-through cost against a $5 seat. The floor exists
  so the solo case is not starved, not to match a compute vendor's marketing allotment.

**1.4 · The number does NOT vary by tier or cadence.** One figure for `free` / `standard`
/ `pro` / `max` / `enterprise`, monthly and annual alike. A tier-varying CI pool would add
a fourth entitlement axis (AI tier × seat count × CI minutes) whose only function would be
price discrimination on a cost Motir passes through near-cost. **Revisit trigger, named so
it is recognisable:** measured consumption showing a tier's median org routinely past its
pool while a cheaper tier's sits under half — i.e. the pool tracking plan size in practice.
That is a datum MOTIR-1896's meter produces; it is not guessable now.

**1.5 · The risk this number carries, stated rather than discounted.** Because MOTIR-1893
made every created repo Motir-owned, **§1.1's table is the expected case, not a tail
case** — there is no population of self-hosted-by-the-user projects diluting it. Two
things bound the exposure, and neither is a guess:

- **A tracker-only org drains nothing.** Consuming the pool requires dispatches, which
  require a plan, which burns credits — so the 36%/54% seat-only rows describe an org that
  by construction generates no CI at all. The orgs that DO drain are the ones paying $25–$150
  of AI, where the ratio is 13–24%.
- **The credit gate is the backstop.** An org cannot dispatch indefinitely on an empty
  balance: §6.2 refuses at zero, so unbounded consumption is not reachable even in the worst
  case.

What is genuinely unknown is the **utilisation rate** — what fraction of the pool a typical
org actually burns. Every figure above is full-drain, and full drain is unlikely; but the
honest position is that Motir does not know the real number yet. **The first month of
MOTIR-1896's meter is the check**, and §1.4's revisit trigger is how the 300 gets corrected
if it is wrong. Nothing here should be read as "this is safe" — it is "this is bounded, and
measured shortly."

### §2 — 1 credit = 1 Linux-equivalent minute

**2.1 · The rate.** Overage converts at **1 credit per Linux-equivalent minute**.

**2.2 · The margin, stated rather than buried in a constant.** At the $10/1,000 top-up a
credit retails at **$0.01**; a Linux-equivalent minute costs **$0.006**. That is a **40%
gross margin** on overage. It also lands at **exactly GitLab's published extra-compute
price** ($10 per 1,000 minutes), so the overage is at market rather than above it.

**2.3 · A single blended number is correct — because normalization already happened.** The
rate is not per-runner-type, and that is safe only because the **meter** converts every
runner to Linux-equivalents first (§3). A blended rate over _raw wall clock_ would be a
lie — one macOS minute costs 10.33× a Linux one — but a single rate over a
cost-normalized unit is exactly right, and it gives the user one number to hold: **a
minute is a credit.**

### §3 — Normalize by COST, using GitHub's real per-minute prices — not its included-minutes multipliers

**3.1 · The pool is denominated in Linux-equivalent minutes**, defined as
`raw_wall_clock_minutes × multiplier(runner)`, where the multiplier is the runner's price
divided by the Linux 2-core x64 price:

| Runner             | GitHub price / min | Multiplier | Source basis    |
| ------------------ | ------------------ | ---------- | --------------- |
| Linux 2-core x64   | $0.006             | **×1.00**  | the numéraire   |
| Linux 2-core arm64 | $0.005             | **×0.83**  | $0.005 / $0.006 |
| Windows 2-core x64 | $0.010             | **×1.67**  | $0.010 / $0.006 |
| macOS 3/4-core     | $0.062             | **×10.33** | $0.062 / $0.006 |

**3.2 · GitHub's own `Linux ×1 / Windows ×2 / macOS ×10` multipliers are the WRONG basis,
and MOTIR-1898's recommendation to adopt them was mistaken.** Those are the rates at which
a plan's _included_ minutes drain — a marketing allotment device — not a cost signal, and
they do not match what GitHub actually charges. Adopting them would **overcharge Windows by
20%** (×2 implies $0.012 against a real $0.010) and **undercharge macOS by 3%** (×10
implies $0.060 against a real $0.062).

This is the shipped `ModelCreditRate` rule one domain over: Motir already prices AI
cost-plus from each provider's own price (`credits = tokens × per-1k-rate × margin`), and
`notes.html` #88 is the recorded lesson from taking a rate off a secondary catalog instead
of the provider's own page. CI follows the same rule — **the multiplier is a price ratio,
sourced from the vendor's own pricing page.**

**3.3 · Multipliers are effective-DATED policy, not a hardcoded constant.** They live in a
table with an `effectiveFrom`, mirroring `ModelCreditRate`'s `(model, effectiveFrom)`
shape, and each metered row **stores the raw wall clock, the runner label, and the
multiplier it applied**. A GitHub repricing is then a new row, never a backfill, and
already-charged history never silently re-prices. (This is MOTIR-1896's "keep the raw
wall-clock alongside" requirement, and this section is why.)

**3.4 · An unknown runner label meters at ×1.00 and is logged.** Under-counting a runner
Motir has not priced is the safe direction — it never over-bills a user for a rate nobody
decided. The log entry is the signal to add the row.

### §4 — The pool is org-level, derived from membership, and resets on the calendar month

**4.1 · Pooled at the ORG, never per member.** Credits are org-level (`AiOrganization` —
one balance, one tier per org) and seats are counted org-wide, so a per-member pool would
be the only per-member quantity in the billing model, and would strand minutes on the
members who did not dispatch.

**4.2 · The seat count is the ORG MEMBERSHIP COUNT, not the Stripe quantity.** The shipped
seat sync (`lib/billing/seatSync.ts`, `lib/jobs/definitions/billingSeatSync.ts`) is an
**absolute recompute of membership pushed TO Stripe** — membership is upstream, the Stripe
quantity is a lagging mirror of it, and its enqueue is explicitly best-effort and
droppable. Deriving the pool from the mirror would make it lag a lagging copy of a number
motir-core holds directly.

**4.3 · An org with no scaled-tracker subscription still gets a pool** —
`max(members × 300, 1000)`, the same formula. Two reasons: the floor dominates for the
small orgs this describes anyway, and a free-tracker org can hold a paid AI plan
(`billing-tiering.md` §1: _"a free-tracker org can buy AI"_), so a subscription-gated pool
would refuse dispatches to a paying AI customer. **The free-AI-tier org is bounded by the
credit gate, not by the pool**: 300 one-time credits buys 1–2 planning passes, so it
cannot generate enough dispatches to approach 1,000 minutes, and at balance ≤ 0 §6 refuses
the next dispatch regardless.

**4.4 · The META org (`Organization.isMeta`) is bypassed entirely** — no pool accounting,
no overage, no refusal. It mirrors the shipped credit-gate bypass (`AiOrganization.isMeta`
→ `assertHasCredits` treats it as always-funded) and the `meta` PM tier that lifts every
cap. moooon B.V. pays its own GitHub bill directly; metering it would bill the house to
itself.

**4.5 · The reset boundary is the CALENDAR MONTH in UTC** — `date_trunc('month', at AT
TIME ZONE 'UTC')`. MOTIR-1898 recommended the seat subscription's period
(`SeatSummaryDTO.currentPeriodEnd`); that is rejected on three grounds:

1. **It is undefined for a large share of the population.** `currentPeriodEnd` exists only
   for an org with an ACTIVE scaled-tracker subscription. §4.3 gives free/unscaled orgs a
   pool, so a subscription-derived boundary has no value to use for exactly the orgs the
   floor was written for.
2. **It couples the meter to billing state.** A calendar month is a pure function of the
   run's timestamp, so MOTIR-1896 can key a metering row **without reading any subscription
   at all** — which keeps an open-core meter free of commercial coupling and makes the
   `workflow_run` write a single insert. A Stripe-period key would require resolving a
   subscription on every webhook delivery.
3. **A moving period needs backfills.** A plan change or proration shifts
   `currentPeriodEnd`, which would re-bucket already-written consumption rows. A calendar
   month never moves.

The cost of this choice, stated: the CI line's reset date will not match the seat line's
renewal date on the billing panel. §7 requires the panel to show it explicitly rather than
let the user assume they coincide.

**4.6 · Mid-period seat changes: absolute recompute, no proration, and no back-billing.**
The pool is **evaluated at read time from current membership** — never accrued, never
prorated — following the shipped seat sync's absolute-recompute model exactly. Two
consequences, both deliberate:

- A member **added** on day 20 adds a **whole month** of pool (300 minutes) for the
  remainder of that month. This is generous, bounded at $1.80, and it is the same
  direction the shipped seat sync errs.
- A member **removed** shrinks the pool immediately, which can leave a period retroactively
  over a pool it was under when the minutes were consumed. **This never back-bills.**
  Overage is charged **incrementally as it is consumed** — the charge is computed against
  the pool as it stood when the minutes were metered — and an already-charged minute is
  never re-charged, so a shrink cannot produce a surprise bill for compute that was free
  when it ran. (Binding on MOTIR-1901: charge on the metering event, not by re-summing the
  period.)

### §5 — Attribution: meter a run iff MOTIR'S ORG owns the repository

**5.1 · The predicate keys on the REPOSITORY OWNER, not on a project column.** A completed
workflow run is metered **if and only if its repository's owner login is Motir's
provisioning org** (`GITHUB_FALLBACK_ORG`, MOTIR-1779). Everything else is a no-op — not an
error, not a zero-credit debit, simply not metered.

The owner login is the right key because **it is exactly what GitHub bills on**: private-repo
Actions minutes bill to the repository owner, so "does Motir pay for this run?" and "is the
owner Motir's org?" are the same question. `Project.repoSetOwnership` is a good
_reporting_ signal but the wrong _gate_ — it is SET-level on `Project`, so it cannot
express a set containing both a created row and a connect-existing row, and it would drift
from reality on any path that moves a repo without updating the column. Reading the owner
cannot drift, because it is the billing fact itself.

**5.2 · The chain**, every hop verified in shipped schema. The gate is at the top; the rest
resolves WHOM to charge:

```
workflow_run (owner/name)   ── gate: owner == GITHUB_FALLBACK_ORG  (Motir pays)
  → GithubRepo            (the mirror; owner/name is the identity GitHub reports)
  → ProjectRepo           (via githubRepoId @unique — at most one project row per repo)
  → Project               (projectId)
  → Workspace             (workspaceId)
  → Organization          (organizationId)  ── the pool + the ledger are keyed here
```

`resolveTenantOrg` already performs the last two hops and returns `{ organizationId,
isMeta }`; §4.4's bypass reads the same flag.

**5.3 · Since MOTIR-1893 the gate passes for every CREATED repo.** The amendment removed
the what-the-user-has branch, so a newly created project repository is always in Motir's
org and always metered. The predicate is unchanged by that — it just stops being selective,
which is the §1.5 risk.

**5.4 · The edge cases, each decided:**

| Situation                                            | Behaviour                                                                                                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connect-existing** repo (the user's own account)   | **Not metered** — the owner is not Motir's org, and GitHub bills the user directly. Charging would bill for compute Motir never bought.                                                       |
| Repo in the installation belonging to **no project** | **Not metered.** A repo connected only for code-graph is in the user's account.                                                                                                               |
| Repo in Motir's org whose **project was deleted**    | **Metered as a cost, charged to nobody, and LOGGED.** Motir is still billed by GitHub, but the chain resolves no org. The log is the signal — silence here would hide real spend.             |
| Repo **transferred** to the user (MOTIR-711 / 9.3.7) | **Metering STOPS at the transfer**, because the owner login changes at the transfer itself. §5.5 is the one edge that needs care. Minutes metered before it stay attributed and stay charged. |
| A **GitLab** project's pipelines                     | **Never metered** — Motir creates no GitLab repos (§Context); a connected GitLab namespace is the user's and GitLab bills them. §5.6.                                                         |
| Run reported **twice**                               | **Counted once** — idempotent on the GitHub run id (MOTIR-1896's duplicate-report test).                                                                                                      |

**5.5 · The transfer edge — read the owner from the RUN, not from the mirror.** Because the
gate is the owner login, a transfer flips it automatically; but the `GithubRepo` mirror row
may still hold the pre-transfer `owner` until a webhook reconciles it. So the meter takes
the owner from **the run's own payload**, not from the mirror, and treats the mirror purely
as the join to the project. A run that completes after the transfer then correctly falls
outside the gate even if the mirror is briefly stale. (Binding on MOTIR-1896.)

**5.6 · GitLab is out of scope for the meter, and that is structural, not an omission.**
Motir creates repositories only in its own **GitHub** org (MOTIR-1779 —
`POST /orgs/{org}/repos`); the shipped GitLab provider (`provider: 'gitlab'` on the shared
installation model) exists for **connect-existing** only, which by definition reaches a
namespace the user owns and GitLab already bills them for. There is therefore no GitLab
compute Motir pays for, and the meter needs no GitLab read. **If that ever changes** — a
decision to create repos on GitLab — it is a new card and an amendment here, and §9 records
where GitLab's usage data would come from so the option stays costed rather than unknown.

**5.7 · The predicate is evaluated at RUN COMPLETION, not at dispatch**, which is what
makes the transfer case fall out with no special handling.

**5.8 · ⚠️ WHERE the minutes come from — a hard constraint on MOTIR-1896, because the
obvious endpoint is being switched off.** MOTIR-1896 owns the mechanism choice, but two of
the three candidates are closing down and it must not build on them:

| Source                                            | Gives                                                                                                                  | Status                                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /repos/{o}/{r}/actions/runs/{id}/timing`     | `billable` per OS: `total_ms`, `jobs`, `job_runs[]` — exactly what we want                                             | ❌ **Closing down** — _"This endpoint is in the process of closing down."_                  |
| `GET /orgs/{org}/settings/billing/actions`        | org totals + `minutes_used_breakdown` by OS                                                                            | ❌ **Closing down** (product-specific billing APIs, 2025-09-26 changelog)                   |
| `GET /organizations/{org}/settings/billing/usage` | `usageItems[]`: `date`, `product`, `sku` (e.g. "Actions Linux"), `quantity`, `unitType: minutes`, **`repositoryName`** | ✅ The enhanced-billing replacement — but **summarised by SKU/repo/day, no per-run detail** |
| `GET /repos/{o}/{r}/actions/runs/{id}/jobs`       | per job: `started_at`, `completed_at`, `labels`, `runner_name`, `run_attempt`                                          | ✅ Not deprecated — the durable per-run source                                              |

**The recommended shape, which the acceptance criteria already fit:**

- **Real-time + attributable:** the `workflow_run` **completion webhook** (not currently
  handled — the shipped `parseCiStatusEvent` covers `check_run`/`check_suite` and carries no
  timing) → read that run's **jobs**, and compute
  `Σ ceil(per-job wall-clock minutes) × multiplier(labels)`. **Per-job rounding UP is not
  optional** — it is how GitHub bills, and summing the run's wall clock instead would
  undercount a 4-job suite badly. Idempotent on **`(run_id, run_attempt)`**, since a re-run
  is a new attempt that bills again.
- **Reconciliation:** the enhanced-billing **usage endpoint** monthly, filtered to
  `product: Actions`. It carries `repositoryName`, so it reconciles per repo against the
  meter's own sum. Drift is **logged, not silently trusted in either direction** — the
  webhook path is the operational meter; the billing report is the audit.

This also means the ADR's own margin depends on the meter matching GitHub's billing within
a tolerance MOTIR-1896 should state. §3.3's stored raw wall-clock + multiplier is what makes
that reconciliation possible after the fact.

### §6 — Two thresholds, two named states, and only one of them stops anything

These are separate events and must never be conflated.

**6.1 · (a) The POOL is exhausted → `drawing_on_credits`. Work continues; the state is
VISIBLE, not silent.** Consumption past the pool converts at §2's rate and debits the
credit ledger. Nothing is blocked. It is surfaced on the billing panel's CI line (§7),
because an allowance nobody can see is not an allowance and a charge nobody was told about
is a support ticket.

**6.2 · (b) The BALANCE hits ≤ 0 → `ci_credits_exhausted`. The next dispatch is REFUSED.**
The three candidates are not equivalent:

- **Refuse at dispatch** — chosen. It fails **before** the user waits on a run, and it is
  the only option that keeps the verification gate intact.
- **Let the PR open but skip CI** — rejected. It silently degrades the exact gate the whole
  agent loop leans on: an unverified PR that looks verified is worse than no PR.
- **Run it and go negative** — rejected as a policy. Motir would be funding unbounded
  compute for an org that has stopped paying.

**6.3 · The refusal sits on the DISPATCH/claim path**, so the user sees it before work
starts, and it raises a typed error mirroring the shipped `MotirAiOutOfCreditsError` — a
motir-core `CiCreditsExhaustedError` with a stable `code`, carrying the org, the balance,
and the pool state, so the surface can render _why_ rather than a generic failure. Never a
raw provider payload.

**6.4 · The balance MAY go transiently negative, by at most the cost of runs already in
flight — and that is accepted, not a bug.** CI cannot be un-run: a run that starts while
the balance is positive and completes after it crosses zero still consumed real compute.
The invariant is therefore **"the next DISPATCH is refused"**, not "the balance never goes
negative". The overshoot is bounded by concurrent in-flight runs (~39 minutes each) and is
recorded honestly in the ledger rather than clamped at zero, which would lose the fact that
Motir paid for it. This mirrors the AI side's contract, where `≤ 0` means exhausted rather
than asserting the balance can never be negative.

**6.5 · The state machine, complete:**

| State                  | Condition                        | Dispatch    | Charged               |
| ---------------------- | -------------------------------- | ----------- | --------------------- |
| `within_allowance`     | period consumption < pool        | allowed     | nothing               |
| `drawing_on_credits`   | consumption ≥ pool, balance > 0  | allowed     | 1 credit / Lin-eq min |
| `ci_credits_exhausted` | consumption ≥ pool, balance ≤ 0  | **refused** | in-flight only        |
| _(bypassed)_           | `isMeta`, or `MOTIR_CLOUD=false` | allowed     | nothing               |

### §7 — The user sees a THIRD line on the billing panel: "Motir CI"

**7.1 · A third line, not a second usage kind on the Motir AI line.** The panel's grammar
is one line per billed product (`billing-tiering.md` §1: ① Motir, ② Motir AI). CI is a
third billed dimension with its **own unit** (minutes, not credits), its **own period**
(calendar month, not the Stripe period — §4.5), and its **own exhaustion state**. Folding
it into the AI line would put two units and two reset dates on one row.

**7.2 · It cross-links to the AI line for the balance; it never restates it.** The overage
draws from the one AI credit balance, so the CI line reports **minutes** and the **credits
this period's overage drew**, and links to the AI line rather than re-rendering a balance.
This is the non-duplication rule `design/billing/design-notes.md` already sets between the
`billing` panel and the `ai-usage` dashboard.

**7.3 · What the line states — the spec MOTIR-1902 draws and MOTIR-1903 builds:**

1. **Used vs included this period** — "1,240 of 1,800 minutes", with a meter/progress
   affordance.
2. **How the pool was derived, in words** — "300 min × 6 seats", or "1,000 minute minimum"
   when the floor binds (§1.2). A pool the user cannot explain reads as arbitrary.
3. **The reset date** — "Resets 1 Aug", the calendar-month boundary, formatted in UTC the
   way `formatRenewal` already formats the seat renewal (deterministic across
   server/client — the finding-#89 hydration rule). **§4.5's cost is paid here:** this date
   differs from the seat line's renewal date and the panel must not imply they coincide.
4. **`drawing_on_credits`** — "420 minutes over your included minutes · 420 credits drawn
   this period", linking to the AI balance.
5. **`ci_credits_exhausted`** — "Dispatch paused — out of credits", using the owner/member
   split the shipped AI paywall already uses (`AiAccessDTO.canManageBilling`: an owner gets
   "Top up"; a member gets the routed-to-an-owner variant).
6. **The zero-consumption case is not an empty state** — an org whose repos are all
   user-owned (§Context) has a pool it will never draw on. The line says so plainly rather
   than showing "0 of 1,000" as if something were wrong.
7. **META and self-host** — the meta org shows the "Internal plan" treatment the panel
   already renders and no CI line; off-cloud the page does not render at all
   (`isCloudBilling()` → `notFound()`).

### §8 — `motir-core` owns the meter AND the entitlement; `motir-ai` gains exactly one debit kind

**8.1 · The split.**

| Repo         | Owns                                                                                                            | Card       |
| ------------ | --------------------------------------------------------------------------------------------------------------- | ---------- |
| `motir-core` | the meter (webhook → normalize → attribute → per-period store) and the **entitlement** (pool, overage, refusal) | 1896, 1901 |
| `motir-ai`   | **only** accepting a CI-overage debit on the credit ledger, with its own idempotency key                        | 1899       |

**8.2 · Why the entitlement is in `motir-core`.** Its only input that is not already local
is nothing: **the seat count IS org membership** (§4.2), which lives only in motir-core;
the meter's inputs (`GithubRepo`, `ProjectRepo`, `Project.repoSetOwnership`, `Workspace`)
are all motir-core; and putting the pool in motir-ai would require propagating a live
membership count across the boundary on every check — a new sync with exactly the staleness
§4.2 rejected. Keeping entitlement next to its meter also keeps the read-derived decision
(read consumption → read balance → decide → debit) inside **one** transaction boundary,
which §Consequences requires to be lock-guarded.

**8.3 · The argument against, answered.** Every other allotment
(`PlanTier.monthlyCreditAllotment`) lives in motir-ai, so this does split the entitlement
model across two repos. That cost is real and is accepted, because:

- **The precedent already exists in motir-core.** `lib/billing/entitlements.ts` holds the
  §4 PM-core caps — a commercial, cloud-only entitlement policy — in the open repo behind
  `MOTIR_CLOUD`. The CI pool is the same shape, so this is a second instance of a settled
  pattern, not a new straddle.
- **The split is along the right seam.** motir-ai's allotments are all **credit-denominated
  and tier-derived**; the CI pool is **minute-denominated and seat-derived**. They are not
  the same kind of object, and co-locating them would put a membership count in the AI
  service.
- **motir-ai's ledger stays a pure credit store**, gaining one new debit kind — which is
  what keeps MOTIR-1899 a 3-point card rather than an entitlement port.

**8.4 · The CI pool is NOT added to `PM_ENTITLEMENTS`.** That map is tier → caps; this is
seat-derived and tier-independent (§1.4). It gets its own policy module alongside it,
mirroring its shape (pure config + a resolver, no DB, no Stripe, no cloud check).

**8.5 · Self-host is inert.** Under `MOTIR_CLOUD=false` there is no meter, no pool, no
overage and no refusal — a self-hoster's Actions bill is their own, and Motir never hosts
their repos. Same gate as `billing-tiering.md` §6.

**8.6 · The debit is a cross-boundary side effect** and therefore runs **after** the local
commit, degrading gracefully on failure (log + retry/enqueue) — it never rolls back the
metering write and never fails the request. This is the shipped side-effects-outside-tx
rule, and it is why the meter must be durable on its own.

### §9 — Sources

Vendor prices were read from each vendor's own pricing page on **2026-07-30**, not from a
secondary catalog or a paraphrase (`notes.html` #88 — the DeepSeek/OpenRouter lesson):

- **GitHub Actions** — per-minute rates (Linux x64 $0.006, Linux arm64 $0.005, Windows x64
  $0.010, macOS $0.062) and included private-repo minutes (Free 2,000, Team 3,000,
  Enterprise Cloud 50,000):
  <https://docs.github.com/en/billing/concepts/product-billing/github-actions>. The
  2026-01-01 repricing cut Linux 2-core from $0.008 to $0.006 and folded a $0.002/min
  platform charge into the meter rates:
  <https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/>
- **GitLab** — included compute minutes (Free 400, Premium 10,000, Ultimate 50,000) and
  extra compute at $10 per 1,000 minutes: <https://about.gitlab.com/pricing/>
- **Motir** — `lib/billing/catalog.ts` (`BILLING_CATALOG`): the $5/$40 seat plan, the AI
  ladder, and the 1,000-credits-for-$10 top-up that fixes a credit at ~$0.01.

**API sources for §5.8 (the meter's read):**

- **`/timing` is closing down** — _"This endpoint is in the process of closing down"_:
  <https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28#get-workflow-run-usage>
  · the notice:
  <https://github.blog/changelog/2025-02-02-actions-get-workflow-usage-and-get-workflow-run-usage-endpoints-closing-down/>
- **Product-specific billing APIs are closing down** (including
  `/orgs/{org}/settings/billing/actions`):
  <https://github.blog/changelog/2025-09-26-product-specific-billing-apis-are-closing-down/>
- **The enhanced-billing usage endpoint** (`usageItems[]` with `sku`, `quantity`,
  `unitType`, `repositoryName`): <https://docs.github.com/en/rest/billing/usage> ·
  <https://docs.github.com/en/billing/tutorials/automate-usage-reporting>
- **Workflow jobs** (`started_at` / `completed_at` / `labels` / `run_attempt`, not
  deprecated): <https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2022-11-28>
- **GitLab, for the §5.6 "if that ever changes" case only** — compute usage is tracked
  monthly per namespace and per project (`ci_namespace_monthly_usages` /
  `ci_project_monthly_usages`, surfaced on the group usage-quotas page and in GraphQL);
  per-job `duration` is on the jobs API and the pipeline webhook:
  <https://docs.gitlab.com/ci/pipelines/compute_minutes/>

**Prices and endpoints drift.** Every number above is dated, the multipliers of §3 are
effective-dated in storage so a repricing is a new row rather than a code change plus a
backfill, and §5.8 records which endpoints are sunsetting so the meter is not built on one.

## Consequences

**The four gated cards, and what each takes from here** — the test of this ADR is that
none of them needs a further question:

- **MOTIR-1896 (motir-core, the meter).** Read per §5.8 — **not** `/timing` and **not** the
  product-specific billing API, both of which are closing down: accumulate from the
  `workflow_run` completion webhook plus that run's **jobs**, summing `ceil()` per job, and
  reconcile monthly against the enhanced-billing usage endpoint. Normalize by §3's
  cost-proportional multipliers, storing raw wall clock + runner label + multiplier applied.
  Key per-period rows by **calendar month UTC** (§4.5) — a pure function of the run
  timestamp, so the meter reads no billing state. Gate on **the run's own repository owner**
  being Motir's org (§5.1, §5.5), not on a project column; the edge cases in §5.4 are each a
  decided behaviour. Idempotent on **`(run_id, run_attempt)`**. The table is
  workspace-scoped (`workspace_id` + RLS) per the shipped contract.
- **MOTIR-1901 (motir-core, the allowance + overage).** Pool = `max(members × 300, 1000)`,
  recomputed from membership at read (§4.2, §4.6), with the no-subscription case (§4.3) and
  the `isMeta` bypass (§4.4). Charge **incrementally, at the metering event, against the
  pool as it stood then** — never by re-summing the period, so §4.6's seat-removal case
  cannot back-bill. Rate 1 credit per Linux-equivalent minute (§2). Refuse at dispatch on
  balance ≤ 0 with `CiCreditsExhaustedError` (§6.2–6.3), accepting the bounded in-flight
  overshoot (§6.4). The read-derived write is **contended** — lock the row and re-read
  inside the transaction, and ship the real-concurrency test; the debit is a cross-boundary
  side effect that runs after the local commit (§8.6).
- **MOTIR-1899 (motir-ai, the ledger).** One new debit kind for CI overage with its own
  idempotency key. Today `CreditTransaction.planningTurnId @unique` is the only idempotency
  hook and it is AI-turn-shaped, so a CI debit needs its own — keyed on the metering event,
  not a planning turn. Nothing else about the ledger changes.
- **MOTIR-1902 → MOTIR-1903 (the billing panel).** A third line, "Motir CI" (§7.1), with
  the seven items of §7.3 — including the two states named in §6 and the deliberate
  reset-date mismatch §4.5 creates.

**Two corrections this ADR makes to its own card, recorded so they are not re-derived:**

1. **`Windows ×2 / macOS ×10` is the wrong basis.** Those are included-minutes drain
   multipliers, not price ratios; the real ratios are ×1.67 and ×10.33 (§3.2).
2. **~20 minutes per dispatch undercounts by roughly half.** The starter's CI runs on
   `pull_request` **and** `push: main`, so a merged dispatch bills the suite twice —
   ~39 minutes, and that is a floor (§Context).

**And one correction this ADR makes to ITSELF, kept visible rather than quietly edited
out.** A draft of this record claimed the exposure was narrower than the card said — that
§3.1/§3.3 of the repo-set ADR put repos in the user's account whenever a GitHub identity
was connected, so only some projects cost Motir anything. **That was wrong**: it was read
against a `main` that predated the **2026-07-30 MOTIR-1893 amendment**, which removed the
branch and made every created repo Motir-owned. The card's original framing was right. The
number and the floor are unchanged — they never rested on that claim, since §1.1's
load-bearing argument is the AI-plan denominator, not a smaller metered population — but
the margin of safety is thinner than the draft implied, which is why **§1.5 now states the
risk explicitly** instead of discounting it. (Method note for the next reader: this ADR's
Status line pins the exact `origin/main` SHA it was written against, and the amendment
landed between the initial read and the write. Re-fetch before trusting a §-reference.)

**What is deliberately NOT decided here**, so nobody reads silence as an answer:

- **The real per-dispatch minute figure.** §Context's ~39 is derived from the workflow's
  shape, not measured. MOTIR-1896's meter produces the measurement, and §1.4 names the
  trigger for revisiting the 300.
- **Whether CI minutes are purchasable directly.** Overage draws from the existing credit
  balance; there is no separate CI minutes SKU and no new Stripe Price. If one is ever
  wanted, it is a new card and an amendment here — not a gap to fill quietly.
- **Rate-limiting or concurrency caps on dispatch.** The pool bounds spend; it does not
  bound burst. Nothing today needs it, and inventing a limiter with no observed problem
  would be work with no consumer.

**Related planning bug.** MOTIR-1904 records that this card's earlier revision promised its
implementers "no further questions" while its "what the user sees" answer had no owning
surface — the gap MOTIR-1902/1903 now close, and which §7 is written to specification level
because of.
