# AI usage & cost — design notes

Design reference for the **`ai-usage`** UI area — the **ORG-LEVEL token-cost
dashboard** (Story 7.2, subtask **7.2.10** / card **MOTIR-820**). The asset is
the source of truth for the cost-display code subtask (**7.2.11** /
**MOTIR-824**), which is `blocked` behind this design gate (Principle #13 + the
design-reference rule; without it the surface would be improvised — forbidden,
`notes.html` #31). Built FROM the real design system (`app/globals.css` `--el-*`
colour tokens + `[data-display-style]` shape tokens + the shipped
`components/ui/*` primitives), so the code subtask composes the same primitives
— no Pencil→code gap.

| Surface                                                                      | Asset                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Org cost dashboard (balance · drill · model · runs · states)**             | **`usage.mock.html`** (HTML mockup)        | The whole org-level token-cost surface. Multi-panel: **access path (org-menu entry)** · cost summary · org→workspace→project drill-down · per-model breakdown · paginated run log · limited member view · low-balance/out-of-credits · empty/loading/error. **Gates 7.2.11 (MOTIR-824).** A `usage.png` full-page export sits beside it (the board-visible face).                                                                                                                                                                                                                                                     |
| **Search spend (the FIFTH figure · the mixed activity log · the remainder)** | **`search-spend.mock.html`** (HTML mockup) | The web-search spend the grounding channel adds to this dashboard, 6 panels: the summary figure IN PLACE beside the shipped stat row · the same row UNDER THE DRILL, where the org-level and attributed figures come apart · the activity log holding a MIX of search and token rows · the un-attributed REMAINDER and its zero case · states (no spend for the scope · figures unavailable · plain member · META) · the access path, reproduced. Amends the row above; redraws none of it. `search-spend.png` beside it. See § "Amendment 2026-09-05 — search spend on the usage dashboard" at the end of this file. |

## What this area is

The **org admin's home for token cost**. **All cost views and settings live at
the ORG level** (Yue, locked 2026-06-12) — not the workspace, not the project.
The org is the tenancy + **billing entity** that credits and usage roll up to
(established by Story 6.10 / `design/org-admin/`). This surface **SHOWS** usage;
it does **not** sell anything.

**Composition — this is an org-admin PANEL, not a standalone page.** It
**composes into the 6.10 org-admin / org-settings area** (`design/org-admin/`),
reached from the org menu in the TopNav (the org-admin asset's panel 1) as an
**"Usage & cost"** entry alongside **Settings** and **Members**. The org-admin
settings already draw a **passive "Billing & usage — Coming soon"** placeholder
card (org-admin design-notes, panel 2); this surface is the **usage** half of
that promise landing — the **billing/checkout** half is still Epic 8 (below).
The page shell reuses the org-admin grammar: a serif `h2` title + a muted
subtitle, then a `stack` of `Card`s, under the `Organization · {org} · …`
breadcrumb.

### Mirror product (rung 1 — cited, not asserted)

- **Lovart** (the cited transparent-usage shape) shows the **exact credit cost
  before and after each generation** and a **balance usable across all models**;
  cost-plus write-ups stress "cost/usage visible in real time, **per model**".
  We draw THAT at the **org** level: a clear org balance, the org's spend +
  monthly trend, the org → workspace → project drill-down, and a per-**model**
  breakdown (so a pricier model is visibly the bigger drain) — the
  **transparency, minus the storefront**.
- **Atlassian / Jira Cloud** — usage/billing is an **org-admin** concern at
  `admin.atlassian.com`, gated to org admins; site/project members below don't
  see org-wide billing. This is why the full view is org-admin-gated and a
  plain member sees only their own slice (panel 6; the 6.10.4 gate).

### ⚠️ Out of scope here (named, NOT drawn) — display only, NOT checkout

**Checkout / pricing / upgrade is Epic 8 billing and is ABSENT from this design
area.** This surface SHOWS usage; it does **not** sell credits. There is:

- **NO** pricing / plan-comparison table,
- **NO** "buy credits" button,
- **NO** upgrade / change-plan CTA,
- **NO** Stripe element or any active purchase control.

The **one** forward-looking affordance allowed is a **passive "out of credits"
empty/blocked state that NAMES the limit** (so the user understands why planning
paused) **without** an active purchase control. **Epic 8 will attach the upgrade
flow to that passive slot later** — it is drawn here as a dashed placeholder
(panel 7b's `.passive-slot`), the same shape the org-admin settings use for the
"Billing & usage — Coming soon" card. Credits are an **internal usage unit**,
labelled **"credits"** everywhere, **never** a currency (`$`/`€`); a quiet
"credits, not a bill" affordance (panel 2) frames the balance as an allotment.

## Where it lives

- A new org-scoped surface under the org-admin area — suggested route
  `app/(authed)/settings/organization/usage/page.tsx` (sibling of the 6.10
  `settings/organization/` + `settings/organization/members/` routes), entered
  from the org menu's **"Usage & cost"** item. **Org-owner/admin gated** for the
  full view; a non-admin org member gets the **limited own-project** view (panel 6) rather than a 404 — they legitimately have a project cost slice to see.
- **Data flows over the 7.1 core↔AI boundary / the 7.2 metering grain.** Figures
  are fetched (the loading skeleton, panel 8b); the fetch can fail when the
  motir-ai boundary is down (the error state, panel 8c). The metering rows
  support **org / workspace / project** grain, which is what the drill-down
  (panel 3) re-scopes across. (Numbers in the mock are illustrative.)
- **At-scale (finding #57 — NOT load-all).** An org accrues **thousands** of
  planning runs; the activity log (panel 5) is **paginated** (page-numbered
  offset paging, matching the org-admin roster's pager), never a load-all list.
  The 7.2.11 code subtask MUST fetch a page at a time.

---

## Panels (review EACH — mistake #31)

### Panel 1 — access path (the entry point)

**FROM WHICH UI the user reaches this page — drawn, not just named.** The shell
TopNav's **org menu** (the same 6.10 org-admin menu that opens **Settings** and
**Members** — `app/(authed)/_components/TopNav.tsx`, drawn in
`design/org-admin/`) carries a new **"Usage & cost"** item; selecting it opens
this dashboard. The panel draws the TopNav (the `moooon ▾` org button + search +
user avatar) and the **org menu OPEN**, with **"Usage & cost"** as the active
row (`--el-tint-lavender`, the coins icon) — the door to the destination page in
panels 2–8. A separate **"Billing"** row stays **"Coming soon"** (Epic 8); usage
is the half that ships here. A caption ties the click to the page's breadcrumb
(`Organization · moooon · Usage & cost`).

This is the **access-path** half of the design-reference rule (MOTIR.md): a
design shows the _door_, not just the _room_, so the 7.2.11 coding agent wires
the entry affordance to the right place instead of improvising it. Composes the
shipped **`Popover` + menu `opt`** grammar (the org-admin switcher), not a new
control.

### Panel 2 — org cost summary (populated, the PRIMARY view)

A `stack` on the org usage page: a **stat-card row** of three `Card`s + a
monthly-trend `Card` + the "credits, not a bill" affordance note.

- **Credit balance (hero `Card`).** The org's current balance as the hero figure
  (serif, 34px) with a `credits` unit suffix, the **org name** + a **tier
  `Pill`** ("Basic tier"), and an **allotment meter** (`.meter`) showing the
  share of the month's allotment remaining + a one-line caption.
- **Spent all time (`Card`).** The org's lifetime credits spent + the since-date.
- **Spent this month (`Card`).** This month's credits + a **delta** vs last month
  (`.delta.up` in `--el-warning` for an increase, `.delta.down` in `--el-success`
  for a decrease — coloured by direction, not grey).
- **Monthly spend trend (`Card`).** A **token-only bar sparkline** (`.trend`, no
  canvas/image) of the last 6 months' credits, the current month tinted
  `--el-accent`, prior months `--el-tint-lavender`.
- **"credits, not a bill" affordance** — an info note (`.note.credits-aff`, sky
  tint) stating credits are an internal allotment, not a currency, and that
  buying credits / plan changes arrive with billing later.

### Panel 3 — drill-down org → workspace → project

A **scope control** (`.scope`) that is a clickable **breadcrumb**: each crossed
segment stays clickable (go back up in one click); the deepest/active segment
carries the switcher chevron (`i-updown`) to pick a sibling. Three `Card`s draw
the **same cost view at all three levels**:

- **A · org-wide** (the default / total) — `moooon (org)`, "Org total" pill,
  spend + the per-model mini-breakdown.
- **B · a workspace** — `moooon › Engineering`, "Workspace" pill, that
  workspace's share of spend + per-model breakdown.
- **C · a project** — `moooon › Engineering › Mobile App`, "Project" pill, that
  project's share + per-model breakdown.

A `.scope-note` states that drilling re-scopes **every** panel (balance share,
per-model, run log) to the active level. (The 7.2.x metering grain supports
each level — see _Where it lives_.)

### Panel 4 — per-model usage breakdown

A `Card` with a **table** (`.tbl`, the at-scale list pattern): per model — a
**model chip** (a coloured `.dot` + name), **tokens in**, **tokens out**, a
**share-of-credits usage bar** (`.usebar`, per-model tint), and the **credits**
debited this month (emphasised). Card foot totals tokens + credits. Shown at
**whichever drill level is active** (here org-wide). Palette-tinted per model
(not grey-only · finding #54) — see colour roles.

### Panel 5 — recent activity / per-run log (PAGINATED)

A `Card` with a **table** of recent planning **runs**, newest first: **when**,
the **run** (a job-kind `Pill` — see below — + the project), the **model**
(chip), **tokens**, and **credits debited**. A card-foot **pager** (`.pager`:
"Showing 1–6 of 2,914" + Prev / "Page 1 of 486" / Next, Prev disabled on page 1)
— **at-scale, NOT load-all** (finding #57). Scoped to the active drill level (a
"Scope: moooon (org)" note in the head).

#### ⚠️ AMENDED (MOTIR-4303, 2026-09-03) — the ONE planning pill, BESIDE the four it keeps

[MOTIR-3943](motir:cmtf1eu0l002vhvn8g359yhxr) collapses the five planning job
kinds to one, `plan`, so every run submitted after that switch records the same
kind. This panel is a caller of the mechanism that story replaces, and without
this amendment every planning run would fall to the shipped renderer's generic
`kindOther` default ("Planning run").

- **The new pill.** Copy **"Planning"** — the noun the ADR settles on ("THE ONE
  PLANNING KIND"), not a verb phrase, because it no longer names an operation.
  Class `.pill-plan`, role **`--el-tint-peach` bg + `--el-text-strong`** — the
  one remaining tint in the `--el-tint-*` family that this asset does not
  already spend (lavender = generate + tier chip, sky = expand, mint = augment,
  yellow = warn/low-balance, rose = the panel-8c error icon). It is an
  **addition**, not a replacement.
- **⚠️ THE FOUR OLDER LABELS ARE RETAINED, and this is the load-bearing
  decision.** `AiUsage.jobKind` is **persisted history**: rows written before the
  switch keep their old value for ever, and the shipped renderer takes a plain
  `string`. Those rows are what an organization was **billed** for, so an asset
  that replaced the old pills would specify a surface that mislabels every run
  already paid for. They are historical values, not a vocabulary the product
  still emits.
- **The run log is drawn holding a MIX** — two `plan` rows above the older ones,
  with a comment marking where the switch falls — so the reader sees the table as
  it looks the week after the cutover rather than in a hypothetical steady state.
- **"Re-plan" is drawn with the NEUTRAL pill**, because that is what actually
  renders: `OrgUsageClient`'s `jobKindLabel` has a `replan` case and
  `jobKindTint` does not, so a re-plan row falls to `bg-(--el-surface)`. Drawn as
  it ships, not as a fourth tint it never had.
- **Everything else in Panel 5 is UNCHANGED** — the columns, the pagination, the
  scope note, and the access path (already drawn in Panel 1; this amends a panel
  inside a surface that is already reachable).
- **⚠️ WHAT THIS PANEL DOES NOT SHOW, recorded because it is not obvious from the
  drawing and the amendment sits right next to it (MOTIR-4325).** The run log is
  **planning runs only, by construction** — every figure in Panels 2, 4 and 5
  joins `PlanningTurn`, which `motir-ai`'s `usageService` states outright. But
  the ledger has **three** debit kinds: `debit` (a planning turn), `ci_overage`
  (CI minutes past the pool) and `search` (a web search on the grounding
  channel). CI has its own card on the _billing_ panel; **search is rendered
  nowhere at all**, and the `balance` this area's Panel 2 draws is the WHOLE
  ledger — so the spend shown here and the balance above it are measured over
  different sets, with nothing on the surface saying so.
  **That is NOT this card's to fix and is deliberately not drawn here** — it
  predates the wire change, it reaches Panel 2 (out of scope), and where a
  non-AI charge belongs is a real design question rather than something to
  improvise. **⚠️ AMENDED 2026-09-05 (MOTIR-4554): it was filed as MOTIR-4325,
  which is now ARCHIVED and superseded by the story MOTIR-4334 — and the half of
  it this asset owed is DRAWN, in `search-spend.mock.html`. A deferral pointing
  at a dead card is a deferral nobody can follow, which is why the pointer is
  corrected here rather than left to read as still-open.** It is named here so the next reader
  of this asset — including the code card MOTIR-4305 — does not re-derive it or
  read the run log as a complete account of what burns credits. It will widen:
  hosted-agent runtime and code-graph indexing are the same shape, arriving.
- **Shipped-reality check.** The pill markup mirrors the shipped renderer
  one-for-one: `OrgUsageClient.tsx` renders `<Pill className={jobKindTint(kind)}
text-(--el-text-strong) border-transparent>` and the mock's `.pill-*` classes
  are that same background/colour/border triple, so the asset cannot specify a
  pill the component cannot produce. The code that consumes this amendment is
  [the usage-label card](motir-ref:cmtl1i03o00o7hun8zfl7kigr), which is
  `blocked_by` this one; nothing under `app/`, `components/` or `messages/` is
  touched here.

### Panel 6 — limited member view (role gating · 6.10.4)

Two mini-surfaces side by side so the gating is visible:

- **Org owner / admin (full)** — the org-wide balance, the full org → workspace
  → project drill control, "sees every run".
- **Non-admin member (limited)** — a **`Read-only`** pill (`i-eye`), scope locked
  to **their own project** (no drill-up), only that project's credits, and a
  **lock `note`** explaining org-wide totals / cross-workspace drill / the full
  run log are **owner/admin only**. **No org total, no other workspaces, no
  controls.** This is the same 6.10.4 gate the org-admin asset's forbidden panel
  expresses — but here the member is **not** 404'd, because they legitimately own
  a project cost slice; they're shown a **reduced read-only** view instead.

### Panel 7 — low-balance + out-of-credits states

- **(a) Low balance (still usable)** — a **`--el-warning` tint BANNER**
  (`.banner-warn`, hue in the banner only — NOT a page-level tinted surface,
  finding #35) reading "Running low on credits", + the balance card with an
  allotment meter filled in `--el-warning`. Planning still works.
- **(b) Out of credits (planning paused)** — a **blocked** `state`
  (`.state.blocked`, `i-pause`, `--el-tint-yellow` icon tint) explaining planning
  is paused and existing plans stay editable, with a **passive Epic-8 slot**
  (`.passive-slot`, dashed) naming that buying credits / changing plan arrive
  with billing later. **NO active buy/upgrade control** — the Epic-8 flow
  attaches to this slot.

### Panel 8 — empty / loading / error states

- **(a) Empty** — first-run, no usage yet: an `EmptyState` (`i-coins`) inviting
  the team to run the planner, with an **"Open the planner"** primary CTA (not a
  purchase CTA).
- **(b) Loading** — the dashboard **`Skeleton`** (stat-card placeholders + a
  trend-bar skeleton), `aria-busy` on the card, while fetching over 7.1.
- **(c) Error** — the usage fetch failed (the motir-ai boundary is down): an
  `ErrorState` (rose icon tint, `i-alert`, "Couldn't load usage", "your credits
  are safe") with a **Retry** secondary button — not a broken-looking zero.

---

## Primitives composed (no hand-rolling)

Every surface composes a shipped `components/ui/*` primitive. If 7.2.11 needs a
genuinely new primitive, that is a **new `design/` subtask**, not a code
workaround.

- **`Popover` + menu rows (the access-path entry, panel 1)** — the org-menu
  `opt` rows in the TopNav (the org-admin switcher grammar): rows at
  `--spacing-control-*` / `--radius-control`, the active **"Usage & cost"** row
  tinted `--el-tint-lavender`. The TopNav org button is a `--radius-btn` trigger.
  Reuses the shipped org switcher — do NOT hand-roll a new menu.
- **`Card`** — the stat cards, the trend card, the per-model + run-log tables,
  the state panels, the mini member-view wrappers (`--radius-card`,
  `--shadow-card`, `--spacing-card-padding`; head/body/foot split by
  `--el-border-soft`).
- **`Pill`** — the **tier** chip, **job-kind** chips (generate / expand /
  augment), the **read-only** chip, the neutral count / scope-level chips.
  `--radius-badge`, `--spacing-chip-*`; **hue in the tint BACKGROUND with
  `--el-text-strong` text (finding #35 — AA-safe), never a tinted page surface.**
- **`Button`** — primary ("Open the planner", "Back"), secondary (Retry), ghost.
  Heights `--height-btn-md` / `--height-btn-sm`; padding `--spacing-btn-x[-sm]`.
- **`Combobox` / breadcrumb (the scope control)** — the org → workspace →
  project drill (`.scope` segments at `--height-control` / `--radius-input` /
  `--spacing-control-*`, the active segment tinted `--el-tint-lavender`, the
  switcher chevron `i-updown`). Reuses the switcher grammar the org-admin /
  workspace switchers established — do NOT hand-roll a new control.
- **Table / list pattern** — the per-model breakdown + the run log. Reuse the
  at-scale list pattern the issues list / org-admin roster established (header
  row, `--el-border-soft` row separators, tabular-nums on numeric columns).
- **Pagination** — the run-log foot pager (count text + Prev/Next + page
  indicator), identical to the org-admin roster pager. The at-scale control —
  NOT load-all.
- **`EmptyState` / `ErrorState`** family — panels 7b, 8a, 8c.
- **`Skeleton`** — panel 8b loading dashboard.
- **Meter / bar (token-only)** — the allotment meter + the per-model usage bars +
  the monthly-trend sparkline are plain token-styled `div`s (radius + tint), no
  charting lib, no image. If a richer chart is ever wanted, that's a new
  `design/` subtask, not a code workaround.

## Colour roles (`--el-*` — palette, not grey-only · finding #54)

| Element                                                | Token                                                                          | Why                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **Balance hero figure / medium figures**               | `--el-text` (serif) · unit in `--el-text-muted`                                | The primary numbers; the unit is quiet so "credits" reads as a label.                                         |
| **Tier chip**                                          | `--el-tint-lavender` bg + `--el-text-strong`                                   | The org/plan tier — the brand-purple family, matches the org avatar.                                          |
| **Allotment meter fill (healthy)**                     | `--el-accent`                                                                  | Primary "credits remaining" share.                                                                            |
| **Allotment meter fill (low)**                         | `--el-warning`                                                                 | Low-balance variant (panel 7a).                                                                               |
| **Monthly-trend bars**                                 | current `--el-accent` · prior `--el-tint-lavender`                             | The latest month stands out; history is quieter.                                                              |
| **Spend delta — up / down**                            | `--el-warning` (up) · `--el-success` (down)                                    | Coloured by direction (more spend = warning hue), not grey.                                                   |
| **Model: Claude Opus**                                 | dot + bar `--el-accent`                                                        | The priciest/heaviest model — the strongest hue, biggest drain.                                               |
| **Model: Claude Sonnet**                               | dot + bar `--el-info`                                                          | Distinct blue, clearly the mid tier.                                                                          |
| **Model: Claude Haiku** (reserved)                     | dot + bar `--el-success`                                                       | Green — the cheapest tier (token present for future Haiku rows).                                              |
| **Model: DeepSeek**                                    | dot + bar `--color-accent-teal` (`--el-type-subtask` hue)                      | The teal family — the non-Claude channel, visibly distinct.                                                   |
| **Job-kind: `plan`** (MOTIR-4303)                      | `--el-tint-peach` + `--el-text-strong`                                         | The ONE planning kind, post-switch. The last unspent tint in the family.                                      |
| **Job-kind: generate / expand / augment** (historical) | `--el-tint-lavender` / `--el-tint-sky` / `--el-tint-mint` + `--el-text-strong` | Three planning verbs, three tints — readable at a glance. RETAINED: persisted history, not a live vocabulary. |
| **Job-kind: re-plan** (historical)                     | neutral `Pill` (`--el-surface`)                                                | Labelled but untinted — `jobKindTint` has no `replan` case, so this is what ships.                            |
| **Low-balance banner**                                 | `--el-tint-yellow` bg + `--el-text-strong`, icon `--el-warning`                | Warning hue in the BANNER tint, not the page (finding #35).                                                   |
| **Out-of-credits / blocked icon**                      | `--el-tint-yellow` + `--el-warning`                                            | The paused state — warning, not danger (nothing is broken).                                                   |
| **Error icon tint**                                    | `--el-tint-rose` + `--el-danger-text`                                          | Fetch-error state (panel 8c).                                                                                 |
| **Read-only chip / member lock note**                  | neutral `Pill` (`--el-surface`) · lock note `i-lock`                           | The limited member view's gating affordance.                                                                  |
| **Primary CTAs / active scope segment**                | `--el-accent` (+ `--el-accent-text`) · `--el-tint-lavender`                    | Open-planner / Retry / the active drill segment.                                                              |
| Count / scope-level / "Credits" chips                  | `--el-surface` + `--el-text-secondary` (neutral `Pill`)                        | Genuinely neutral metadata.                                                                                   |
| Text / surfaces / borders                              | `--el-text*`, `--el-surface*`, `--el-border*`                                  | Standard element tokens — never Tier-0 `--color-*`.                                                           |

> **One deliberate Tier-0 reach:** the DeepSeek dot/bar uses `--color-accent-teal`
> because there is no dedicated `--el-*` teal element token beyond `--el-type-subtask`
> (which maps to the same teal). When 7.2.11 builds this, prefer adding an
> `--el-model-deepseek` (or reusing `--el-type-subtask`) element token over reaching
> Tier-0 directly — the per-component growth pattern (notes.html #20). Every other
> colour in the mock routes through `--el-*`.

All shaped surfaces use the **`[data-display-style]` shape tokens**
(`--radius-{btn,card,input,control,badge}`, `--spacing-{btn,input,control,chip,
card-padding}`, `--height-{btn-*,input,control}`, `--shadow-*`) — never the inert
Tier-0 radius/spacing scale or a fixed raw utility. `rounded-full` (`9999px`) is
used only for the round status dots / meter caps. Toggle the mock's dark mode to
confirm token parity (every colour flips through Tier-0 under `--el-*`).

## Copy strings (en — the `usage` / `orgUsage` i18n namespace 7.2.11 adds)

- Nav / shell: org-menu item **"Usage & cost"**; breadcrumb **"Organization ·
  {org} · Usage & cost"**.
- Summary: title **"Usage & cost"**; subtitle **"Token cost for the {org}
  organization — credits spent planning across all its workspaces. Credits are a
  usage allotment shared across every model."**; **"Credit balance"**, **"{n}
  credits"**, **"{tier} tier"**, **"{pct}% of this month's {allotment}-credit
  allotment remaining"**; **"Spent all time"** / **"Since the org was created ·
  {date}"**; **"Spent this month"** / **"+{pct}% vs {month}"**; **"Monthly
  spend"** / **"Credits debited per month, org-wide. Last 6 months."**
- Credits affordance: **"Credits are an internal usage allotment — not a
  currency, and this is not a bill. One planning run debits credits by the tokens
  it consumed. Buying more credits and plan changes arrive with billing in a
  later release."**
- Drill: **"Scope"**; **"{org} (org)"** / **"Org total"** / **"Workspace"** /
  **"Project"**; segment helper **"The drill path is a breadcrumb… Drilling
  re-scopes every panel to the active level."**
- By model: **"By model"** / **"Where the org's credits went this month, per
  model…"**; columns **"Model"**, **"Tokens in"**, **"Tokens out"**, **"Share of
  credits"**, **"Credits"**; foot **"{in} tokens in · {out} out"** / **"{n}
  credits"**.
- Activity: **"Recent activity"** / **"Every planning run that debited credits,
  newest first. Filtered to the current scope ({scope}). Older runs load a page
  at a time."**; **"Runs"** / **"{n} total"**; columns **"When"**, **"Run"**,
  **"Model"**, **"Tokens"**, **"Credits"**; job kinds — the live one
  **"Planning"** (MOTIR-4303), and the historical **"Generate plan"** /
  **"Expand story"** / **"Augment tree"** / **"Re-plan"**, which stay because
  `AiUsage.jobKind` is persisted history; pager **"Showing {from}–{to} of
  {total}"**, **"Page {n} of {m}"**, **"Prev"** / **"Next"**.
- Member view: **"{project} · your project"** / **"Read-only"**; **"This project
  · this month"** / **"Your project's share. No org total, no other
  workspaces."**; lock note **"Org-wide totals, the cross-workspace drill-up and
  the full run log are visible to organization owners and admins only. Ask an org
  admin for org-level usage."**
- Low balance: **"Running low on credits."** / **"{n} credits left — about {pct}%
  of this month's allotment. Planning still works; large generations may exhaust
  the balance. Buying more credits arrives with billing later."**
- Out of credits: **"Planning is paused — you're out of credits"** / **"The {org}
  organization has used all of this month's credits, so new planning runs are
  paused. Existing plans stay fully editable."**; passive slot **"Buying more
  credits and changing your plan arrive with billing in a later release. This is
  where that option will appear."**
- States: empty **"No usage yet"** / **"Once your team runs the AI planner, every
  run's credit cost shows up here — broken down by workspace, project and
  model."** / **"Open the planner"**; error **"Couldn't load usage"** /
  **"Something went wrong fetching this organization's usage. The figures are
  temporarily unavailable — your credits are safe."** / **"Retry"**.

The full string set is added to the app's locale files (en + zh, the shipped
locale set) by the 7.2.11 code subtask under the new `usage` namespace.

---

# Amendment 2026-09-05 — search spend on the usage dashboard (MOTIR-4554)

The asset is **`search-spend.mock.html`** + **`search-spend.png`**, a NEW
three-file member of this area, under story **MOTIR-4334**. Its consuming code
card is **MOTIR-4558**, `blocked_by` this design gate; the read that feeds it is
**MOTIR-4555**, and the per-run attribution it renders is produced by
**MOTIR-4552**.

**This is the answer to the note Panel 5's own amendment left.** That section
records, in its own words, that the run log is planning runs ONLY while the
balance above it is the WHOLE ledger — that _"search is rendered nowhere at
all"_, with _"nothing on the surface saying so"_ — and deliberately did not draw
it. Its pointer (MOTIR-4325) is corrected in the same pass: that card is archived
and superseded by MOTIR-4334, and a deferral pointing at a dead card is a
deferral nobody can follow.

## Why the shipped asset cannot absorb this

`usage.mock.html` draws eight panels and **every quantity on them is
token-denominated** — the cost summary, the drill, the per-MODEL breakdown, the
paginated run log. **A search has no model and no tokens.** It cannot be a row in
the per-model breakdown and it cannot be a token count anywhere. So it needs its
own figure and its own row treatment, and per the standing convention it gets a
NEW file rather than an amendment that re-exports eight panels nobody changed.
`usage.mock.html` and `usage.png` are byte-unchanged.

## THE THREE DECISIONS (the card's own three questions)

### 1. Under the DRILL, two figures come apart — so EVERY figure states its scope

`OrgUsageDTO.search` is **org-level and scope-independent**: a search made
outside any run has no project to attribute to, so the organization total is the
only honest place to count them all. `searchRuns.attributedSpend` **does** narrow,
because an attributed search has a run and a run has a project.

So at project scope the two search figures disagree, correctly. **A number that
silently ignored the scope selector above it would be the surface lying
quietly** — and the fix is not to hide one of them, because both are useful. Each
figure carries a **`.scopetag`**, in the same place, in the same two possible
words:

| Label                  | Meaning                | Figures                           |
| ---------------------- | ---------------------- | --------------------------------- |
| **Follows this scope** | narrows with the drill | token spend · search _attributed_ |
| **Whole organization** | does NOT narrow        | search _total_                    |

The second is drawn at `--el-text-strong` rather than `--el-text-secondary`: a
figure that ignores the selector above it has to say so **louder** than one that
obeys it. Panel 2 adds a note in prose saying WHY, because a reader who notices
the middle figure did not change deserves the reason on the same screen.

### 2. In the ACTIVITY LOG, a search row is NOT a job kind

**One list, not two.** The page answers _where did my credits go_, and splitting
search into its own table puts the reconciliation back on the reader.

- **Chip:** the base asset's `pill-neutral` treatment plus the `i-search` glyph
  (`.pill-search`). **Deliberately NOT a `--el-tint-*`** — see the tint decision
  below.
- **Model column:** an **em-dash**, not blank. A search has no model.
- **Token column:** an **em-dash**, not a `0`. A search does not use zero tokens;
  it uses none, and a `0` claims the first.
- **Credits column:** the real figure, in the same column every other row sums
  into.
- **Secondary text:** the project and the search COUNT (`Mobile App · 4
searches`), because a run's row is one entry covering several searches.

### 3. The UN-ATTRIBUTED REMAINDER is a residual ROW — and it is ABSENT at zero

Attributed rows will not sum to the org total, because searches made outside a
run still debit (`MOTIR-2778` §4 makes two such arrivals legitimate, and a third
is a `runRef` naming a run motir-ai never opened). **That difference is a real,
explainable quantity, not a reconciliation failure** — and an unexplained gap
between a total and its rows is exactly the complaint this story exists to end.

- **Labelled** _"Not attributed to a run"_, as the LAST row of the by-run table,
  in the same credits column the rows above sum into. **Never a footnote** — a
  number the reader can add up by eye is a number they can trust. The card foot
  states the arithmetic in words: _"246 attributed + 66 not attributed = 312."_
- **At ZERO the row is not drawn at all.** A residual line reading _"Not
  attributed — 0"_ invites the reader to look for a problem that does not exist.
  Panel 4 draws both cases side by side for exactly this reason.
- The `Searches` cell on that row is an em-dash: the count is per-run and there
  is no run.

## ⚠️ THE TINT DECISION — where this asset differs from its billing sibling

On the **billing panel** the search glyph takes `--el-tint-sky` (that asset's own
amendment). **Here it takes no tint at all**, and the difference is a decision
rather than an inconsistency:

**All six `--el-tint-*` slots on this surface are already spent, five of them on
JOB KINDS** — lavender = generate + the tier chip, sky = expand, mint = augment,
peach = plan (MOTIR-4303), yellow = low balance, rose = the error icon.

A search row is **not a job kind** — it is a different KIND OF CHARGE. Giving it
a tint would put two meanings on one colour inside one table, and reusing `sky`
would make a search row and an `expand` run read alike at a glance. **Two
identical signals are less legible than one.** The neutral chip plus the search
glyph is what _"not one of the job kinds"_ looks like in this asset's own
vocabulary — and the billing panel, which has no job-kind pills at all, has no
such collision and is free to use the tint.

## Primitives composed (no new primitive is introduced)

| Element                | Primitive / shipped source                               |
| ---------------------- | -------------------------------------------------------- |
| The search figure card | the shipped `.card.stat` — same as the three beside it   |
| The scope label        | NEW inline element (`.scopetag`); no primitive owns one  |
| The search chip        | the base `Pill` at `pill-neutral` + the `i-search` glyph |
| The em-dash cells      | plain table cells (`.nodata`)                            |
| The residual row       | a `.tbl` row (`tr.residual`) on `--el-surface-soft`      |
| The by-run table       | the shipped `.tbl` at-scale list pattern                 |
| Pager                  | the shipped `.pager` — unchanged, one list               |
| Notes / banners        | the shipped dashed `note` family                         |
| Loading                | the dashboard's own inline skeleton (`.sk` / `.sk-stat`) |

## Colour + shape roles (additions only — the base table above still governs)

| Element                 | Token                                                                        | Why                                                                                |
| ----------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Search figure glyph     | `--el-text-muted` on the card                                                | the `.stat .lbl` treatment every stat card already uses                            |
| Scope label (follows)   | `--el-text-secondary`                                                        | 6.18–6.80:1 on the card AND on `--el-surface-soft`, which is where panel 5 puts it |
| Scope label (org-level) | `--el-text-strong`                                                           | it has to out-state the one beside it                                              |
| Search chip             | `--el-surface` bg + `--el-text-secondary`                                    | the base `pill-neutral` triple. NOT a tint — see the tint decision                 |
| Em-dash cells           | `--el-text-secondary`                                                        | information, not a disabled control                                                |
| Residual row            | `--el-surface-soft` bg, `--el-text-secondary` ink, `--el-text-strong` figure | quieter than a run row, still AA, with the number readable                         |
| Card radius / padding   | `--radius-card` / `--spacing-card-padding`                                   | unchanged from the base                                                            |

Credits are labelled **"credits"** and never a currency, per this area's standing
rule.

## Copy strings (en — the `orgUsage` namespace; MOTIR-4558 adds each with a `zh` twin)

- Figure labels: **"Search spend, this month"** / **"…of which attributed"** /
  **"{credits} credits all time"** / **"{credits} credits not attributed to a run"**
- Scope labels: **"Follows this scope"** / **"Whole organization"** /
  **"Whole organization · unchanged by this drill"**
- The what-is-a-search note: **"A web search is charged per search, at 1 credit
  each, and has no model and no tokens — so it never appears in the per-model
  breakdown above. It is shown as its own figure for the same reason."**
- The drill note: **"Why the middle figure did not change."** / **"Search is
  charged to the organization. A search made inside a planning run can be
  attributed to that run's project — that is the third figure — but a search made
  outside any run has no project, so the organization total is the only honest
  place to count them all."**
- Activity row: **"Web search"** / **"{project} · {n} searches"**
- One-list note: **"One list, not two."** / **"Splitting search into its own
  table would put the reconciliation back on the reader — the question this page
  answers is 'where did my credits go', and the answer has to be readable in one
  column."**
- Residual: **"Not attributed to a run"** / **"{attributed} attributed +
  {remainder} not attributed = {total}. A search made outside a planning run still
  costs credits and still appears in the total; it just has no run to name."**
- Zero: **"No searches this month."**
- Unavailable: **"Search figures aren't available right now. Your searches are
  still being charged — this is the display, not the billing."**
- Member lock: **"A member sees their own project's slice. The organization-wide
  search total and the un-attributed remainder are owner/admin only."**

## GIVES / TAKES

**GIVES — MOTIR-4558** the whole element set: the fourth and fifth stat cards and
their scope labels, the search row's chip / em-dash / secondary text, the
residual row and its absence at zero, the four states, and the two decisions
above as build instructions rather than as taste.

**TAKES — one thing, and it is AMENDED IN THIS PASS.** Panel 5's MOTIR-4303
amendment carried a deferral naming **MOTIR-4325** as the open card for the
missing search surface. That card is archived and superseded by **MOTIR-4334**,
and the dashboard half of what it described is now drawn here — so the pointer is
corrected in place rather than left to read as still-open. No sibling card's
scope is narrowed.

The access path is **REPRODUCED** from `usage.mock.html` panel 1, not taken from
it: the door already exists and this figure joins a page that already has one.

Its neighbours for the record, neither amended: **MOTIR-4551** draws the same
spend as a billed line on the billing panel (what am I charged for — this asset
answers where did it go), and **MOTIR-4555** carries the figures across the
boundary that feed both.

---

# AMENDMENT 2026-09-05 — an INTERNAL org renders exactly what a paying org renders

**Story MOTIR-4337 · swept by card MOTIR-4564.** `search-spend.mock.html` panel (d) draws "the
META org", whose "shipped `isMeta` treatment is unchanged: the balance reads Unlimited". After
MOTIR-4337 that is superseded, and the same correction applies to every meta-only variant this
area describes.

- **`isMeta` keeps its shipped meaning** and gains no new one; a separate
  `Organization.internalBilling` flag means _charged exactly like a customer, then made whole_
  (`docs/decisions/internal-billing-classification.md` §1).
- **The balance, the allotment line, the drill-down, the per-model breakdown, the run log and the
  remainder all render with REAL figures for an internal org** — the debits are real and each is
  offset in the same transaction, so the balance nets to zero with both sides visible (§2–§3).
- **Panels 7a low-balance and 7b out-of-credits RENDER**, and the org is never actually blocked
  from working: the pairing means the balance never moves, so no refusal valve is ever reached.
  That is a property of the write, not a second bypass (§2).
- The five `isMeta` branches in `OrgUsageClient.tsx` are **deleted**, not duplicated for the new
  flag — MOTIR-4572 owns that change, and MOTIR-4575's acceptance video is literally an org admin
  watching these states.

Panel (d) is **annotated in place** rather than redrawn: it remains a true record of shipped
behaviour until MOTIR-4572 merges, and redrawing customer pixels is outside MOTIR-4564's scope.
