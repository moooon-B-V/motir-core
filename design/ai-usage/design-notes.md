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

| Surface                                                          | Asset                               | Notes                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Org cost dashboard (balance · drill · model · runs · states)** | **`usage.mock.html`** (HTML mockup) | The whole org-level token-cost surface. Multi-panel: **access path (org-menu entry)** · cost summary · org→workspace→project drill-down · per-model breakdown · paginated run log · limited member view · low-balance/out-of-credits · empty/loading/error. **Gates 7.2.11 (MOTIR-824).** A `usage.png` full-page export sits beside it (the board-visible face). |

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
the **run** (a job-kind `Pill` — generate / expand / augment — + the project),
the **model** (chip), **tokens**, and **credits debited**. A card-foot **pager**
(`.pager`: "Showing 1–6 of 2,914" + Prev / "Page 1 of 486" / Next, Prev disabled
on page 1) — **at-scale, NOT load-all** (finding #57). Scoped to the active drill
level (a "Scope: moooon (org)" note in the head).

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

| Element                                   | Token                                                                          | Why                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| **Balance hero figure / medium figures**  | `--el-text` (serif) · unit in `--el-text-muted`                                | The primary numbers; the unit is quiet so "credits" reads as a label. |
| **Tier chip**                             | `--el-tint-lavender` bg + `--el-text-strong`                                   | The org/plan tier — the brand-purple family, matches the org avatar.  |
| **Allotment meter fill (healthy)**        | `--el-accent`                                                                  | Primary "credits remaining" share.                                    |
| **Allotment meter fill (low)**            | `--el-warning`                                                                 | Low-balance variant (panel 7a).                                       |
| **Monthly-trend bars**                    | current `--el-accent` · prior `--el-tint-lavender`                             | The latest month stands out; history is quieter.                      |
| **Spend delta — up / down**               | `--el-warning` (up) · `--el-success` (down)                                    | Coloured by direction (more spend = warning hue), not grey.           |
| **Model: Claude Opus**                    | dot + bar `--el-accent`                                                        | The priciest/heaviest model — the strongest hue, biggest drain.       |
| **Model: Claude Sonnet**                  | dot + bar `--el-info`                                                          | Distinct blue, clearly the mid tier.                                  |
| **Model: Claude Haiku** (reserved)        | dot + bar `--el-success`                                                       | Green — the cheapest tier (token present for future Haiku rows).      |
| **Model: DeepSeek**                       | dot + bar `--color-accent-teal` (`--el-type-subtask` hue)                      | The teal family — the non-Claude channel, visibly distinct.           |
| **Job-kind: generate / expand / augment** | `--el-tint-lavender` / `--el-tint-sky` / `--el-tint-mint` + `--el-text-strong` | Three planning verbs, three tints — readable at a glance.             |
| **Low-balance banner**                    | `--el-tint-yellow` bg + `--el-text-strong`, icon `--el-warning`                | Warning hue in the BANNER tint, not the page (finding #35).           |
| **Out-of-credits / blocked icon**         | `--el-tint-yellow` + `--el-warning`                                            | The paused state — warning, not danger (nothing is broken).           |
| **Error icon tint**                       | `--el-tint-rose` + `--el-danger-text`                                          | Fetch-error state (panel 8c).                                         |
| **Read-only chip / member lock note**     | neutral `Pill` (`--el-surface`) · lock note `i-lock`                           | The limited member view's gating affordance.                          |
| **Primary CTAs / active scope segment**   | `--el-accent` (+ `--el-accent-text`) · `--el-tint-lavender`                    | Open-planner / Retry / the active drill segment.                      |
| Count / scope-level / "Credits" chips     | `--el-surface` + `--el-text-secondary` (neutral `Pill`)                        | Genuinely neutral metadata.                                           |
| Text / surfaces / borders                 | `--el-text*`, `--el-surface*`, `--el-border*`                                  | Standard element tokens — never Tier-0 `--color-*`.                   |

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
  **"Model"**, **"Tokens"**, **"Credits"**; job kinds **"Generate plan"** /
  **"Expand story"** / **"Augment tree"**; pager **"Showing {from}–{to} of
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
