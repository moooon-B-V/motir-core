# Platform admin console — design notes

Design reference for the **`platform-admin`** UI area — the **INTERNAL operator
console for Motir platform staff** (moooon B.V.), Epic 10 · Story 10.1 · subtask
**10.1.1** (card **MOTIR-728**). The asset is the source of truth for the three
code subtasks it gates: the estate overview (**10.1.4**), the usage/cost rollups
(**10.1.5**) and the drill-down (**10.1.6**) — each `blocked` behind this design
gate (Principle #13 + the design-reference rule; without it the operator console
would be improvised — forbidden, `notes.html` #31). Built FROM the real design
system (`app/globals.css` `--el-*` colour tokens + `[data-display-style]` shape
tokens + the shipped `components/ui/*` primitives), so the code subtasks compose
the same primitives — no mock→code gap. Most of `console.mock.html`'s token
block + primitive CSS is shared 1:1 with `design/ai-usage/usage.mock.html`, the
closest existing usage surface.

| Surface                                                                                                                  | Asset                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Platform admin console (access · search · nav shell · overview · usage/cost · seats · read-only drill-down · states)** | **`console.mock.html`** (HTML mockup) | The whole operator surface. Seven panels: **access path** · **estate overview** (in the left-nav shell + search top bar) · **global search** · **usage/cost · by tenancy** (rollup + members) · **usage/cost · by model & consumers** · **drill-down** (seats + read-only inspect) · **gating / empty / loading / error**. **Gates 10.1.4 / 10.1.5 / 10.1.6.** A `console.png` full-page export sits beside it. |

| **ORG lookup · ORG page · the internal-billing CLASSIFICATION control** (AMENDMENT 2026-09-05) | **`console.mock.html`** (HTML mockup, Panels 10 · 10b · 11 · 12) | The ORG level of the reserved **Tenants** row. Four panels: the **org lookup** (a GET form, the shipped user-lookup grammar one entity over) · its **three states** (idle · query too short · no results) · the **org page** (identity, plan tier, balance, the `isMeta` and `internalBilling` chips drawn SEPARATELY, MOTIR-733's panels as RESERVED regions, and the allocation table) · the **classification control** in six states (not-classified · classified · confirm with a mandatory reason · reason-missing · already-in-that-state · generic failure) with the `PlatformAuditLog` row rendered back on the same surface. **Gates MOTIR-4566 and MOTIR-4568** (Story MOTIR-4337). Draws to `docs/decisions/internal-billing-classification.md`. |

## What this area is

The **home base for Motir's own operators**. It is **NOT a customer surface** — a
single internal console from which platform staff see the WHOLE estate: every
organization, workspace, project and user across all tenants, plus the
platform-wide usage/cost rollup. It is the same multi-tenant superadmin idiom
GitLab, Sentry, Stripe and Vercel run for their own staff.

- **Internal & gated.** It lives at **`/admin`** (suggested route group
  `app/(admin)/admin/…`, a sibling of `(authed)` / `(public)`), reachable only
  by platform staff. For everyone else the route is a **404** — the surface does
  not exist for them; there is **no visible "403 / forbidden" page** (its very
  existence is not leaked). See Panel 7a. Staff ENTER via the account-menu item
  in Panel 1; they NAVIGATE via the left-nav shell + the top-bar search.
- **Read-mostly (this Story).** Story 10.1 draws **READ** views — overview, the
  usage/cost rollup, the drill-down — plus the **read-only inspect** (below). The
  governance **WRITE actions** (suspend a tenant, adjust credits, write-level
  impersonation, …) are **Story 10.3's governance toolkit**; this design draws no
  destructive control.
- **Denser, but the SAME design system.** Because an operator scans the whole
  estate, the console reads more table-heavy than a customer screen — but it
  composes **only** the shipped `components/ui/*` primitives + `--el-*` / shape
  tokens. **No bespoke admin CSS.** The thing that visually distinguishes it from
  a tenant view is the persistent **`--el-info` operator top bar** (a shield +
  "Platform staff" marker), carried on every page so an operator never confuses
  it with a customer tenant.

### Read-only "View as tenant" — the impersonation question (Yue review #2 · point 3)

Yue asked whether staff should be able to assume another org's identity for
debugging, **read-only**. Yes — and the read/write split is the safety boundary:

- **10.1 (here): READ-ONLY, audited inspection.** The drill-down (Panel 6) is the
  read view; a **"View as tenant (read-only)"** affordance opens a **read-only
  session** — the tenant's own app with a pinned banner and **every write control
  disabled**. Staff SEE exactly what the tenant sees (to debug) but cannot change
  anything; the session is audited (operator + tenant + time).
- **10.3 (governance): WRITE-level impersonation** — acting AS a user with the
  power to change things — is a **separate, heavily-gated** capability (reason
  required, time-boxed, fully audited, possibly two-person). It is **NOT** in
  10.1 and is **not** drawn here beyond naming the boundary.

This split is the answer to the question; the design implements the read-only
half and leaves the write half to 10.3.

### ⚠️ Shared shell — Stories 10.2 + 10.3 EXTEND this area

**This card establishes the `design/platform-admin/` shell language for the whole
of Epic 10.** Story **10.2** (platform monitoring — health / queue depth / error
rates) and Story **10.3** (governance toolkit — the tenant WRITE actions) both
**reuse this shell**: the `/admin` route group, the left-nav rail (their sections
slot into the **Operations** group, drawn here as reserved "10.2" / "10.3" rows),
the operator top bar + search, the `Platform · …` breadcrumb grammar, the
`Card`-stack body, the at-scale table+pager, and the per-entity / per-model colour
roles. Their skeletons should not re-invent any of it.

### ⚠️ Net-new capability (a planning dependency for 10.1.x)

A **platform-staff persona does not exist in the shipped schema** (recon
2026-06-21: only `OrganizationRole` and `MemberRole`, both tenant-scoped; no
`/admin` route, no cross-tenant operator capability). This console introduces a
**net-new platform-staff gate** orthogonal to the tenant roles — a prerequisite
the 10.1.x code subtasks (and likely an **Epic-10 foundation subtask** ahead of
them) must own:

- a **staff flag** (e.g. `User.isPlatformStaff`, seeded only for moooon staff),
- a **`requirePlatformStaff()` guard** that **404s** (not 403s) every non-staff
  request to `/admin` and its APIs,
- an **audit-log write on every cross-tenant read** (incl. each read-only
  session) — the posture Panels 6 makes visible.

Flagged here, not silently assumed. If the planner agrees, add that foundation
subtask to Story 10.1 (or Epic 10) as a `blocked_by` of 10.1.4/5/6.

### Data — usage aggregates the 7.2 `OrgUsageDTO`; seats from membership tables

The usage/cost panels are the **estate-scope** sibling of the **org-scope** 7.2
dashboard (`design/ai-usage/`). The org dashboard reads an **`OrgUsageDTO`**
(`lib/dto/aiUsage.ts`: `balance`, `tier`, `totalSpend`, `monthSpend`,
`monthlyHistory[]`, `perModel[{ model, inputTokens, outputTokens, credits }]`,
`recentRuns[…]`, `hasUsage`) from **motir-ai over the 7.1 boundary**. The platform
console reads the SAME shape **summed up one level** to a **`PlatformUsageDTO`**
(10.1.5 builds): estate counts + a hierarchical `byTenant[]` rollup (project →
workspace → org → platform) + an estate `perModel[]` + a `topConsumers[]`
leaderboard, all **pre-aggregated** (never a live scan). **Member / seat counts**
(Panels 4 + 6) come from **`Organization/Workspace/ProjectMembership`** counts in
`motir-core` (recon-confirmed model names); the **seat LIMIT** is the tier's
`monthlyCreditAllotment` sibling (a tier seat cap, Epic 8 billing) — shown as
`used / limit` only where a tier defines one. **Search** (Panel 3) queries the
same four entity tables. Numbers in the mock are illustrative.

### Where it lives

- A new staff-only route group **`app/(admin)/admin/`** (suggested):
  `admin/page.tsx` (overview), `admin/usage/page.tsx` (the two-view usage page —
  the segmented control switches `?view=tenancy|model` in place),
  `admin/tenants/[scope]/[id]/page.tsx` (drill-down), and a search API the top-bar
  box calls. Gated by `requirePlatformStaff()`; a non-staff request 404s.
- **At-scale (finding #57 — NOT load-all).** Hundreds of orgs, tens of thousands
  of jobs; **every list paginates** — the activity feed (Panel 2), the rollup
  (Panel 4), top-consumers (Panel 5), the per-tenant jobs list (Panel 6), and the
  search results are a bounded top-N per group. Off pre-aggregated reads.

## Access path & navigation (the door, the hallway, and finding things)

The design-reference rule requires drawing **how the surface is reached and moved
through** — not naming routes in prose. Three mechanisms, all drawn:

1. **Entering (Panel 1).** A platform-staff account's **account menu** (the
   shipped TopNav user-avatar `Popover`) carries a staff-only **"Platform admin"**
   item → `/admin`. Absent + a 404 for non-staff (Panel 7a).
2. **Section nav (the shell, Panels 2–6).** A **persistent left-nav rail**
   (`.admin-nav`, the `Sidebar` grammar): a **Platform** group (**Overview ·
   Usage & cost · Tenants**) and an **Operations** group (**Monitoring [10.2] ·
   Governance [10.3]**, reserved). Active section tinted `--el-tint-sky`. Footer:
   operator identity + **"Exit to app"**.
3. **Finding a specific tenant — GLOBAL SEARCH (Panel 3, Yue review #2 · point
   2).** A **search box in the operator top bar**, present on every console
   screen (⌘K). Typing matches the estate; results group **Organizations /
   Workspaces / Projects / Users**, each row showing a member count and a
   drill-in chevron → that tenant's drill-down. The `CommandPalette` grammar.

The **two Usage & cost views jump via a SEGMENTED control** (Yue review #2 · point
1 — see Panels 4–5), and the **drill-down (Panel 6) is reachable** from any tenant
row (Overview / rollup / top-consumers / search) or the Tenants section.

---

## Panels (review EACH — mistake #31)

### Panel 1 — ACCESS PATH (how staff enter /admin)

The normal Motir app `TopNav` with the **account menu open** (the shipped
user-avatar `Popover` + `opt` rows): **Account settings**, **Your organizations**,
then the staff-only **"Platform admin"** row (`i-shield`, a `--el-info` "Staff
only" tag, sub-label "Operator console · the whole estate"), then **Sign out**. A
side note states the gate: the item is **absent** for non-staff and `/admin`
**404s** for them. An `entry-call` line ties the click to the destination (the
console **Overview**).

### Panel 2 — estate OVERVIEW (populated, in the shell)

The landing page, inside the **left-nav shell** ("Overview" active) under the
**operator top bar** (`.adminbar`: the shield + "Platform staff / all reads
audited" marker, the **search box**, the operator avatar). Composes:

- **Estate counts** — four stat `Card`s: **Organizations / Workspaces / Projects /
  Users (seats)**, each a serif hero + a per-entity tinted icon + a
  `+n this month` `--el-success` delta. Per-entity tint, not grey (finding #54).
- **Recent estate activity** — a `Card` `.tbl`, newest first: **When**, **Event**
  (kind `Pill` — new org / new workspace / planning run / coding job), **Tenant**
  (avatar + dotted path), **Detail**. A card-foot **pager** (at-scale, NOT
  load-all · finding #57). Every tenant row drills to Panel 6.
- A footer `reach-note` spells out navigation: rail = sections, search = find a
  tenant, row-click = drill-down.

### Panel 3 — GLOBAL SEARCH (org / workspace / project / user)

The top-bar search, **open** (the box `.focused`, a value typed). A `.search-pop`
results popover (the `CommandPalette` grammar) groups matches by entity —
**Organizations / Workspaces / Projects / Users** — each `.sr-item` an avatar +
name + (for tenant rows) a member-count `.seatcell` + a drill chevron; selecting a
row opens that tenant's drill-down (Panel 6). A keyboard hint (Enter / ↑↓ / esc).
Search is reachable from **every** console screen (the box is in the top bar).

### Panel 4 — USAGE & COST · by tenancy (segmented · members)

Left-nav **"Usage & cost"** active. The page header carries a **`Segmented`
control** (`By tenancy` / `By model & consumers`) — the shipped
`components/ui/Segmented` (an `--el-surface` track, the active option raised with
`--el-page-bg` + `--shadow-subtle` and an `--el-accent` glyph). **This is the
explicit jump to Panel 5 — one page, two views** (Yue review #2 · point 1). The
body is the **rollup TreeTable** (`.tbl.tree`): columns **Tenant** (indented +
expand chevron), **Level** (`Org`/`Workspace`/`Project` `Pill`), **Members** (a
per-level member count — point 4), **Tokens**, **Share** (per-level-tinted
`.usebar`), **Credits**. Rows nest org → workspace → project by indentation; the
foot states "pre-aggregated, never a live scan" + a pager.

### Panel 5 — USAGE & COST · by model & consumers (segmented)

The **same page**, the OTHER `Segmented` option selected (the visible jump from
Panel 4). Two `Card`s (`.grid-2`):

- **By model** — a `.tbl`: per model a **model chip** (coloured `.dot` + name; the
  9.0-gateway models annotate "· 9.0 gateway"), **Tokens**, **Share** `.usebar`
  (per-model tint), **Credits**, **$ equiv** (muted). Palette-tinted per model so
  the costliest is visibly the bigger drain (finding #54).
- **Top consumers** — a `.tbl` leaderboard: a **rank** chip (`.rank.top` top-3,
  `--el-tint-yellow`), the **tenant**, a **Share** `.usebar`, **Credits**, a
  **drill chevron** (each row drills to Panel 6). Foot: "Top 5 of 214" + "View
  all".

### Panel 6 — DRILL-DOWN detail (org / workspace / project, in the shell)

Left-nav **"Tenants"** active. Reached via a tenant row (Overview / rollup /
top-consumers / search) or the Tenants section. Composes:

- **Scope breadcrumb** (`.scope`) — `Platform › Tenants › Acme Corp`, active
  segment `--el-tint-lavender` + the `i-updown` switcher (the Combobox/breadcrumb
  grammar from the org dashboard).
- **Audited-read banner** (`.audit-banner`) — `i-eye` in `--el-info`, **"You are
  viewing Acme Corp's data as platform staff — read-only. This cross-tenant read
  is recorded in the audit log…"**
- **Tenant header** — avatar + name + status `Pill` + tier `Pill` + created-date,
  and a **"View as tenant (read-only)"** `Button` (point 3, the read-only inspect).
- **Read-only session banner** (`.ro-session`, `--el-tint-yellow` dashed) — what
  "View as tenant" opens: the tenant's app with this banner pinned and **every
  write control disabled**, audited; names that write-impersonation is Story 10.3.
- **Seats & members card** (point 4) — a `48 / 50 seats` tier `Pill` + a
  `.seatmeter` (seats used vs tier limit) + a **per-workspace `.tbl`** (Workspace ·
  Members · Projects), so member counts are exposed at org AND workspace AND
  project granularity.
- **Usage & shape card** — a token-only `.trend` sparkline + a `.mini-stats`
  (Workspaces / Projects) + the tenant balance.
- **Recent jobs** — a `.tbl` of planning + coding runs, **paginated**.

### Panel 7 — gating · empty · loading · error

A 2×2 `.states-grid`:

- **(a) Access denied = a 404 (`.state.notfound`).** Non-staff hitting `/admin`
  get the **standard app 404** — "This page doesn't exist", "Back to Motir". A
  dashed reviewer note states the rule: NO "403 / forbidden" page, no hint the
  route is real. (The staff gate from "Net-new capability".)
- **(b) Empty (`.state`).** First run, no usage across any tenant — `i-coins`,
  "No usage yet", "View tenants".
- **(c) Loading (`.state` + `.sk` skeletons, `aria-busy`).** The dashboard
  skeleton while the rollup fetches over 7.1.
- **(d) Error (`.state.err`).** The usage fetch failed (motir-ai down) — `i-alert`
  in `--el-tint-rose`, "Couldn't load usage", an explicit "no tenant has zero
  usage; the figures are simply not loaded" (a fetch error, NOT a misleading
  zero), and a **Retry**.

---

## Primitives composed (no hand-rolling)

Every surface composes a shipped `components/ui/*` primitive. If a 10.1.x code
subtask needs a genuinely new primitive, that is a **new `design/` subtask**, not
a code workaround.

- **`Sidebar` (the left-nav shell · `.admin-nav`)** — the persistent console
  navigation on every page (Panels 2–6): brand header, grouped nav rows
  (`.nav-item`, `--radius-control` / `--spacing-control-*`, active row
  `--el-tint-sky`), the reserved 10.2/10.3 rows, the operator footer + "Exit to
  app". The shipped `Sidebar` / nav-row grammar (`design/shell/`).
- **`Popover` + menu rows (the access path · Panel 1)** — the account menu in the
  TopNav (the shipped user-avatar `Popover`) carries the staff-only "Platform
  admin" `opt` row → `/admin`.
- **`CommandPalette` / search (the operator top bar · Panel 3)** — the search box
  (`.searchbar`) + the grouped `.search-pop` results (Organizations / Workspaces /
  Projects / Users), the shipped grouped-keyboard-search grammar
  (`components/ui/CommandPalette.tsx`). The box lives in the top bar on every
  page; ⌘K opens it.
- **`Segmented` (the usage view switcher · Panels 4–5)** — the shipped
  `components/ui/Segmented`: an `--el-surface` track + a 2px inset, each option
  `--height-control` at `calc(--radius-btn - 2px)`, the active option raised
  (`--el-page-bg` + `--shadow-subtle`, `--el-accent` glyph). Switches `By tenancy`
  ↔ `By model & consumers` in place — do NOT hand-roll tabs.
- **`Card`** — every stat / rollup / per-model / top-consumers / seats / usage /
  recent-jobs / state card.
- **`Pill`** — level chips, event-kind chips, model chips, tenant status + tier
  chips (incl. the `48 / 50 seats` tier pill), neutral counts. Hue in the tint
  BACKGROUND with `--el-text-strong` text (finding #35 — AA-safe).
- **`Button`** — primary ("Back to Motir"), secondary ("View as tenant
  (read-only)", "Retry", "Exit read-only"), the pager / "View all" ghosts.
- **Table / list pattern + pagination** — the activity feed, the rollup TreeTable
  (level indentation + expand chevron + the Members column), the per-model + top
  consumers + per-workspace + recent-jobs tables, each with the at-scale foot
  pager. Reuse the issues-list / org-roster pattern.
- **`Combobox` / breadcrumb** — the `Platform › Tenants › …` drill scope (Panel 6).
- **`EmptyState` / `ErrorState`** — Panel 7 b / d (the 404 reuses the `.state`
  shell). **`Skeleton`** — Panel 7c.
- **Meter / bar (token-only)** — the share `.usebar`s, the per-tenant `.trend`,
  and the **`.seatmeter`** (seats used vs tier limit) are token-styled `div`s, no
  charting lib.

## Colour roles (`--el-*` — palette, not grey-only · finding #54)

| Element                                               | Token                                                                                             | Why                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Operator top bar + staff marker / search**          | `--el-tint-sky` bar + `--el-info` rule & shield, text `--el-text-strong`                          | The OPERATOR marker on every page — the info family (finding #35).      |
| **Active left-nav row + active account-menu item**    | `--el-tint-sky` + `--el-text-strong`, icon `--el-info`                                            | The current section — matches the operator bar.                         |
| **Active segmented option**                           | `--el-page-bg` raised + `--shadow-subtle`, glyph `--el-accent-on-surface`                         | The shipped `Segmented` active treatment.                               |
| **Estate count / avatar: Organizations**              | `--el-tint-lavender` + `--el-accent-on-surface`                                                   | The tenancy root — the brand-purple family.                             |
| **… Workspaces / Projects / Users**                   | `--el-tint-sky`/`--el-info` · `--el-tint-mint`/`--el-success` · `--el-tint-rose`/`--el-highlight` | One tier, one hue, everywhere (counts, level pills, share bars).        |
| **Level pill + share bar: Org / Workspace / Project** | `--el-tint-lavender` · `--el-tint-sky`/`--el-info` · `--el-tint-mint`/`--el-success`              | The tier tints, consistent across the rollup.                           |
| **Member / seat counts (`.seatcell`, `.seatmeter`)**  | icon `--el-text-faint`, meter fill `--el-accent`, `n / limit` tier `Pill` `--el-tint-lavender`    | Seats read as neutral metadata; the tier pill carries the limit.        |
| **Audited-read banner**                               | `--el-tint-sky` + `--el-info` `i-eye`                                                             | "Viewing another tenant (read-only, audited)".                          |
| **Read-only SESSION banner (`.ro-session`)**          | `--el-tint-yellow` dashed + `--el-warning` `i-eye`                                                | A live read-only impersonation session — a cautionary (not danger) hue. |
| **Model: Opus / Sonnet / Haiku / DeepSeek**           | `--el-accent` · `--el-info` · `--el-success` · `--el-type-subtask`→`--color-accent-teal`          | Costliest = strongest hue; DeepSeek = the 9.0-gateway teal channel.     |
| **Top-consumer rank (top 3)**                         | `.rank.top` `--el-tint-yellow` + `--el-text-strong`                                               | The leaders stand out; 4+ neutral.                                      |
| **Tenant status Active / tier chip**                  | `--el-tint-mint` · `--el-tint-lavender` (+ `--el-text-strong`)                                    | Healthy tenant; the plan tier.                                          |
| **Error icon (Panel 7d) / 404 icon (Panel 7a)**       | `--el-tint-rose`+`--el-danger-text` · `--el-surface`+`--el-text-faint`                            | Fetch error; a plain not-found (no "forbidden" red).                    |
| Text / surfaces / borders                             | `--el-text*`, `--el-surface*`, `--el-border*`                                                     | Standard element tokens — never Tier-0 `--color-*`.                     |

> **One deliberate Tier-0 reach:** the DeepSeek dot/bar uses `--color-accent-teal`
> (via the `--el-type-subtask` fallback), exactly as `design/ai-usage/` does. When
> 10.1.5 builds this, prefer adding `--el-model-deepseek` (or reusing
> `--el-type-subtask`) over Tier-0 (`notes.html` #20). Every other colour routes
> through `--el-*`.

All shaped surfaces use the **`[data-display-style]` shape tokens** — never the
inert Tier-0 radius/spacing scale or a fixed raw utility. `rounded-full` (`9999px`)
only for round dots / bar caps / circular avatars. Toggle the mock's dark mode to
confirm token parity.

## Copy strings (en — the `admin` / `platformAdmin` i18n namespace 10.1.x adds)

- **Access path (account menu):** item **"Platform admin"** / sub **"Operator
  console · the whole estate"** / tag **"Staff only"**.
- **Operator top bar:** marker **"Platform staff"** / **"all reads audited"**;
  search placeholder **"Search organizations, workspaces, projects, users…"** (⌘K).
- **Left-nav shell:** brand **"Motir"** / **"Platform admin"**; groups
  **"Platform"** / **"Operations"**; items **"Overview"**, **"Usage & cost"**,
  **"Tenants"**, **"Monitoring"** (tag **"10.2"**), **"Governance"** (tag
  **"10.3"**); footer **"Platform staff"** / **"{email}"** / **"Exit to app"**.
- **Search results:** groups **"Organizations"** / **"Workspaces"** / **"Projects"**
  / **"Users"**; hint **"Enter opens the selected tenant's drill-down · ↑ ↓ to move
  · esc to close"**.
- **Overview:** breadcrumb **"Platform · Overview"**; title **"Platform
  overview"**; counts **"Organizations"** / **"Workspaces"** / **"Projects"** /
  **"Users (seats)"**, delta **"+{n} this month"**.
- **Usage & cost:** title **"Usage & cost"**; segmented **"By tenancy"** / **"By
  model & consumers"**; hero **"{n} credits · platform total this month"**; rollup
  **"Spend by tenancy"** / **"Expand an org to its workspaces and projects. Members
  shown per level."**; columns **"Tenant"**, **"Level"**, **"Members"**,
  **"Tokens"**, **"Share"**, **"Credits"**; levels **"Org"** / **"Workspace"** /
  **"Project"**; foot **"Top {n} of {total} orgs · pre-aggregated, never a live
  scan of raw usage rows."**
- **By model / top consumers:** **"By model"**; columns **"Model"**, **"Tokens"**,
  **"Share"**, **"Credits"**, **"$ equiv"**; **"· 9.0 gateway"**; **"Top
  consumers"** / **"The orgs & workspaces draining the most. Click to drill in."**
- **Drill-down:** scope **"Platform › Tenants › {tenant}"**; audit **"You are
  viewing {tenant}'s data as platform staff — read-only. This cross-tenant read is
  recorded in the audit log (operator {op} · {email}, just now)."**; **"View as
  tenant (read-only)"**; read-only session **"Read-only session. 'View as tenant'
  opens {tenant}'s own app with this banner pinned and every write control
  disabled — staff can SEE what the tenant sees to debug, but cannot change
  anything. The session is audited. (Acting as a user with write is Story 10.3
  governance, separately gated.)"** / **"Exit read-only"**; status **"● Active"**;
  tier **"{tier} tier"**.
- **Seats & members:** **"Seats & members"** / **"Members per level. Seat limit
  from the tier (Epic 8)."**; tier pill **"{used} / {limit} seats"**; **"{used} of
  {limit} {tier}-tier seats used across {w} workspaces & {p} projects."**; columns
  **"Workspace"**, **"Members"**, **"Projects"**; **"+{n} more workspaces"**.
- **States:** 404 **"This page doesn't exist"** / **"Back to Motir"**; empty **"No
  usage yet"** / **"View tenants"**; loading **"Loading the estate rollup…"**;
  error **"Couldn't load usage"** / **"…your figures are simply not loaded."** /
  **"Retry"**.

The full string set is added to the app's locale files (en + zh, the shipped
locale set) by the 10.1.x code subtasks under the new `admin` namespace.

---

# The DAY-1 operator panels — Panels 8 & 9 (Story 8.5 · Subtask 8.5.10, card MOTIR-1166)

Everything above this line is **Subtask 10.1.1**'s (card `MOTIR-728`, merged
2026-06-21/22) and is **NOT re-specified here**. Panels 1–7 — the access path, the
console shell, the global search, the two usage/cost views, the tenant drill-down
and the states — remain that card's design, unchanged. This section adds the two
panels 10.1.1 deliberately deferred, because **Story 8.5 (launch readiness) needs
them before Epic 10 runs**: a read-only **system-health glance** and a minimal
**audited support action**.

> **Why they live in THIS file rather than a second asset.** The area already has
> one asset with one basename. A second `platform-admin.*` trio would be two
> pictures of one screen, free to drift from the day both merged — the failure
> `notes.html` #82 names (_a design card COMPOSES an already-designed sub-surface;
> it does NOT REDRAW it_). So these panels extend `console.mock.html`, reuse its
> shell verbatim, and are drawn INSIDE the same left-nav.

| Surface                            | Asset                                 | Notes                                                                                                                                     |
| ---------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Day-1 system health** (Panel 8)  | **`console.mock.html`** (HTML mockup) | Six read-only signal cards + the overdue-schedules list. Occupies the **Operations → Monitoring** row. **Gates MOTIR-1167.**              |
| **Day-1 support action** (Panel 9) | **`console.mock.html`** (HTML mockup) | The USER drill-down, the two writes, the confirm step with a required reason, and the audit row the write produces. **Gates MOTIR-1167.** |

## The three boundaries, in writing

1. **Story 10.2 SUPERSEDES Panel 8.** The day-1 glance takes the left-nav
   **Operations → Monitoring** row that Panels 2–6 draw as a reserved `10.2` stub.
   When `MOTIR-737` (10.2.1) draws the full ops board — per-provider panels,
   thresholds, error-rate and traffic — that board takes this row and this panel
   goes away. The row has one owner at a time; 10.2.1's own notes must say which
   of these elements it replaces and which it keeps.
2. **Story 10.3 owns the rest of the WRITES.** Panel 9 draws exactly two: send
   password reset, and suspend / unsuspend an account. Credit and plan governance,
   tier changes, per-org feature flags, time-boxed WRITE-level impersonation and
   the tamper-evident **hash-chained** audit log are 10.3. The "Support actions"
   table here is the plain append-only row `MOTIR-1167` writes — deliberately not
   that. Suspending an ORGANIZATION is 10.3 too; the day-1 answer to an abusive
   tenant is to suspend the account behind it.
3. **Story 10.1 keeps the usage/cost rollups.** Panels 2, 4 and 5 are drawn but are
   NOT `MOTIR-1167`'s to build.

## Panel 8 — the day-1 system-health glance

**Access path (the door, drawn).** The left-nav **Operations → Monitoring** row,
`.nav-item.active` with `--el-tint-sky`, its reserved `10.2` `.soon` chip removed
for this panel. Everything else in the rail, the operator top bar and the footer is
Panel 2's shell verbatim. Breadcrumb `.crumb` → **"Platform · Monitoring"**.

**Posture: READ and LINK, never remediate.** Six cards, each a state and a link-out
to the provider's own dashboard. Motir does not redeploy, cancel or replay — the
link-out is how the operator acts. This is 10.2's _integrate-not-rebuild_ stance
applied one story early, and it is why there is no trace timeline, no log search
and no per-run viewer here.

**The six signals, and where each comes from** (all verified on `origin/main`,
2026-08-10 — a signal nobody can read is not a design, it is a wish):

| Card                  | Reads                                                                                                                                              | Drawn state     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| **Database**          | A reachability + latency ping. Neon Postgres, region `iad` — `docs/decisions/application-hosting.md`                                               | Healthy         |
| **Hosting**           | Fly app `motir-core`, org `moooon`, `machine_count` — `production-service-stack.md` records 2, asserted from Fly's API by `ci.yml` on every deploy | Healthy         |
| **Scheduled jobs**    | `ScheduleHealthReportDTO.overdue` from `lib/services/jobScheduleHealthService.ts`, produced by the 09:00 `dailyHealthCheck` schedule probe         | **Degraded**    |
| **Failed jobs**       | The dead-letter set — `lib/jobs/dlq.ts` / `JobRunDlqDTO`                                                                                           | **Degraded**    |
| **Errors**            | Sentry. **Not wired yet** — `MOTIR-1161` provisions and `MOTIR-1162` wires it; `grep sentry package.json` returns nothing today                    | **Can't reach** |
| **Last health check** | The `job_run` row for `scheduled.system.daily-health-check` and its three probes (schedules, runner image, indexer image)                          | Healthy         |

**Three tones, and why all three are on ONE board rather than three boards.** An
operator's real screen is mixed, and the mixed board is the one that proves the
rule that matters: **an unreachable probe must never read as a zero.** The Errors
card says _"No response from Sentry"_ and _"this is **not** an error count of zero"_
in situ — a green card reading "0 errors" while the probe is down is the failure
this panel exists to prevent.

**The one list the glance owns.** _"Overdue schedules"_ — a `.tbl` of the crons
that missed more than one consecutive tick (`Job` / `Cron` / `Last fired` /
`Expected`), with the standard `.card-foot` pager. Everything deeper is a link-out.

**⚠️ Do NOT fork the existing jobs surface.** A per-WORKSPACE view of this same job
data already ships at **`/settings/workspace/jobs`** (`JobsDashboard.tsx`, tabs
`runs | dlq | system`, a DLQ badge count, status filter, paging, row-detail panel).
`MOTIR-1167` reads the platform-wide equivalent through its own staff-gated
service; it does not copy that component and it does not widen it in place.

### Panel 8 — primitives composed (no hand-rolling)

- **`Sidebar` / `.admin-nav`, `.adminbar`, `.navfoot`** — Panel 2's shell, verbatim.
- **`Card`** (`.card` + `.card-head` + `.card-body`) — every signal card and the
  overdue list. New modifier `.hcard` sets only the body padding and two text
  scales (`.hval`, `.hmeta`); it adds no colour and no shape of its own.
- **`Pill`** — the state chip: `.pill-active` (reused verbatim) for Healthy,
  `.pill-warn` and `.pill-down` added. Each carries a `.dot` in the matching tone.
- **The icon tile `.ico`** — with `.sig-ok` / `.sig-warn` / `.sig-down`, following
  `.ico.ent-*`'s exact pattern (a tint background + a stronger ink).
  **⚠️ NOT the `.ico.ent-*` entity tints** — those encode org / workspace / project /
  user identity, and borrowing them for a health card would say "this card is about
  users" in a system where that tint means exactly that.
- **Table + `.card-foot` pager** — the overdue list, the issues-list pattern.
- **`.linkout`** — the new text link-out affordance: `--el-link` + the `i-external`
  lucide glyph.
- **`.note`** — the dashed reviewer note carrying the scope boundary.

### Panel 8 — colour & shape roles

| Element           | Colour token                                                  | Why                                                                                            |
| ----------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Healthy pill      | `--el-tint-mint` bg + `--el-text-strong`                      | Hue in the tint BACKGROUND, strong ink on top — finding #35, AA-safe                           |
| Degraded pill     | `--el-tint-yellow` bg + `--el-text-strong`                    | Same rule, warning hue                                                                         |
| Unreachable pill  | `--el-tint-rose` bg + `--el-text-strong`                      | Same rule, danger hue                                                                          |
| Status dot        | `--el-success` / `--el-warning` / `--el-danger`               | The saturated ink, safe on a dot (no text on it)                                               |
| Signal icon tile  | tint bg + `--el-success` / `--el-warning` / `--el-danger` ink | Mirrors `.ico.ent-*`; the card states its tone twice, which is what an at-a-glance board wants |
| Link-out          | `--el-link`                                                   | The shipped link ink                                                                           |
| Card value / meta | `--el-text` / `--el-text-secondary`                           | The shipped text ramp                                                                          |

Shape everywhere is the element-semantic set — `--radius-card` (cards),
`--radius-badge` (pills), `--spacing-card-padding`, `--height-btn-md`. **No Tier-0
`--color-*` and no raw `rounded-*` / `p-*` / `h-*` in any element this card adds.**

### Panel 8 — copy strings (the `admin` namespace `MOTIR-1167` adds)

- Nav row **"Monitoring"**; breadcrumb **"Platform · Monitoring"**; title
  **"System health"**; sub **"Is the machinery running? Six signals, read-only,
  refreshed on load. Each card links OUT to the provider's own dashboard — Motir
  shows the state and never redeploys, cancels or replays. The deeper per-provider
  board is Story 10.2."**
- State chips: **"Healthy"** · **"Degraded"** · **"Can't reach"** · **"Ran"**.
- Cards: **"Database"** / **"Reachable · {ms} ms"** / **"Neon Postgres · region
  {region}, alongside the app."** / **"Neon console"** · **"Hosting"** /
  **"{n} machines running"** / **"Fly app {app} · org {org} · {region} — last deploy
  {ago}."** / **"Fly dashboard"** · **"Scheduled jobs"** / **"{n} of {total} crons
  overdue"** / **"From the 09:00 daily health check's schedule probe — a cron that
  stopped firing. Listed below."** / **"Inngest functions"** · **"Failed jobs"** /
  **"{n} dead-lettered · 24h"** / **"Failed after their retries. Inngest has no
  literal DLQ — this is the failed-set, and replay happens there."** /
  **"Inngest runs"** · **"Errors"** / **"No response from Sentry"** / **"The probe
  failed — this is not an error count of zero. Last good reading {ago}."** /
  **"Sentry issues"** · **"Last health check"** / **"{date} {time} · {n} probes"** /
  **"Schedules, runner image, indexer image. Runs once daily and does not retry, so
  a miss shows up here as a stale timestamp."** / **"Job runs"**.
- List: **"Overdue schedules"** / **"Crons that missed more than one consecutive
  tick, newest miss first."**; pill **"{n} overdue"**; columns **"Job"**,
  **"Cron"**, **"Last fired"**, **"Expected"**; foot **"Showing {n} of {total}
  overdue · {checked} schedules checked"**.

## Panel 9 — the day-1 support action

**Access path (the door, drawn).** The **USER** drill-down. Panel 3's global search
already groups results into Organizations / Workspaces / Projects / **Users**, each
row with a drill-in chevron — so the user destination is a door Panel 3 promises and
10.1.1 never drew. Panel 9 draws it, in Panel 6's exact grammar: the `.scope`
breadcrumb chips **"Platform › Users › {user}"**, the `--el-info` `.audit-banner`
recording the cross-tenant read, then the identity header.

**The two writes, and nothing else.** `Send password reset` (`.btn-secondary`,
`i-key`) and `Suspend account` (`.btn-danger`, `i-ban`) sit in the header's right
slot, exactly where Panel 6 puts _"View as tenant (read-only)"_. Every other field
on the account is read-only.

**The confirm step is the design.** Each action opens a `.confirm` dialog
(`--radius-modal` + `--shadow-modal`) that states the consequence in plain words —
what happens to the person, what happens to their data, and that it is reversible —
and requires a **reason** before the destructive button is usable. The reason is not
decoration: it is what makes the audit row readable months later. A row that says
only _"suspended by OP"_ answers nothing.

**The result is rendered back.** The **"Support actions"** card underneath is the
append-only log of every operator write on the account (`When` / `Action` /
`Operator` / `Reason`), newest first, with the just-performed row at the top. The
write and its record are one surface, so an operator can never perform an action and
wonder whether it was recorded.

### Panel 9 — primitives composed (no hand-rolling)

- **The shell**, `.scope` breadcrumb chips, `.audit-banner`, the `.row-between`
  identity header, `.ava.ent-user`, `.pill-active` / `.pill-neutral` / `.pill-tier`
  — all Panel 6's, verbatim.
- **`Button`** — `.btn-secondary` (reset, Cancel) and the new `.btn-danger`.
- **`Modal`** — `.confirm`, on `--radius-modal` / `--shadow-modal`.
- **`FormField` / `Input`** — `.field` label + `.input` + `.hint`, on
  `--radius-input`, `--height-input`, `--spacing-input-*`.
- **Table + `.card-foot` pager** — the Support-actions log.
- **`Pill`** — `.pill-down` for **"Suspended"**, `.pill-readonly` for **"Password
  reset sent"**.

### Panel 9 — colour & shape roles

| Element                    | Colour token                                     | Why                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Destructive button         | `--el-danger` fill + `--el-danger-text` label    | The shipped filled-danger CTA. `--el-danger-text` is the **ink ON the fill** (`--color-destructive-foreground`, white), NOT a red label — see the token-correction note below. Measured **4.51:1**, AA |
| Secondary action           | `--el-text` on transparent, `--el-border-strong` | The shipped secondary button                                                                                                                                                                           |
| Audit banner               | `--el-tint-sky` + `--el-text-strong`             | Panel 6's cross-tenant read banner, verbatim                                                                                                                                                           |
| "Suspended" row chip       | `--el-tint-rose` + `--el-text-strong`            | Hue in the tint background — finding #35                                                                                                                                                               |
| "Password reset sent" chip | `--el-tint-sky` + `--el-text-strong`             | A non-destructive operator action                                                                                                                                                                      |
| Confirm dialog             | `--el-page-bg`, `--el-border`, `--shadow-modal`  | The shipped modal surface                                                                                                                                                                              |

### Panel 9 — copy strings (the `admin` namespace `MOTIR-1167` adds)

- Breadcrumb **"Platform › Users › {name}"**; audit **"You are viewing {name}'s
  account as platform staff. This cross-tenant read is recorded in the audit log
  (operator {op} · {email}, just now)."**
- Actions **"Send password reset"** · **"Suspend account"** · **"Cancel"**.
- Confirm **"Suspend {name}?"** / **"They are signed out of every session
  immediately and cannot sign back in. Their workspaces, projects and work items are
  untouched, and another platform operator can lift the suspension. {org} keeps
  running for its other {n} members."**; field **"Reason"** + **"— required, written
  to the audit log"**; hint **"Shown to any operator reading this account later, and
  to {name} if they ask."**
- Log **"Support actions"** / **"Every operator write on this account, newest first.
  Append-only."**; pill **"This account"**; columns **"When"**, **"Action"**,
  **"Operator"**, **"Reason"**; chips **"Suspended"**, **"Password reset sent"**;
  foot **"Showing {n}–{m} of {total} actions"**.

## ⚠️ A correction to this file's own token block (made by 8.5.10)

The inlined Tier-3 block carried **`--el-danger-text: var(--color-destructive)`** —
the danger red itself. In the shipped design system
(`packages/design-system/theme.css`) that token is
**`var(--color-destructive-foreground)`**, i.e. the **white ink that goes ON the
danger fill**. Any filled destructive control built from this asset therefore
rendered **red text on a red fill — 1.00:1, invisible**, which is exactly how Panel
9's Suspend button first came out.

Corrected here: `--color-destructive-foreground: #ffffff` was added to the Tier-0
block and `--el-danger-text` re-aliased to it. `.state.err .ico` in Panel 7 had been
leaning on the wrong alias to obtain the RED, so it now names `--el-danger`
directly — which is the same value, so **Panels 1–7 render pixel-for-pixel
identically** (verified: a 2400×11220 device-pixel diff of panels 1–7 before and
after returns **0** differing pixels).

**One drift was left UNFIXED on purpose** — `--el-accent` — and is now fixed by
MOTIR-2595; see the next section.

## ⚠️ `--el-accent` aliases the FILL, not the ink (fixed by MOTIR-2595)

The block carried **`--el-accent: var(--color-primary)`** where `theme.css` says
**`var(--color-primary-fill)`**. The two are a deliberate pair — `--color-primary`
is the accent **as ink** on a pale surface, `--color-primary-fill` is the **block of
colour behind a white label** — and `--el-accent` is the fill role (`.btn-primary`
here is `background: var(--el-accent); color: var(--el-accent-text)`). The ink form
has its own token, `--el-accent-on-surface`, which was already correct.

Corrected: `--color-primary-fill` was added to the inlined Tier-0 block in both
themes (`#5645d4` light, `#6c5cdd` dark — the values `theme.css` carries) and
`--el-accent` re-aliased to it. What that changes:

| theme (default palette) | accent fill before  | after                | white label on it                                              |
| ----------------------- | ------------------- | -------------------- | -------------------------------------------------------------- |
| light                   | `#5645d4`           | `#5645d4`            | 6.57:1 — unchanged, **the light PNG export is byte-identical** |
| dark                    | `#7b6ce5` (the ink) | `#6c5cdd` (the fill) | **4.10:1 → 4.99:1**, i.e. below AA → AA                        |

So this was never only an other-palettes hazard: the mock's own dark mode was
painting the accent CTA with the ink colour and failing AA on its label. Under a
palette where the pair diverges further (several define a light `--color-primary`
against a near-black or near-white `--color-primary-fill`) the gap is larger.

## ⚠️ The inlined token block is a POINT-IN-TIME COPY — re-check it, don't trust it

`console.mock.html` inlines a **subset** of the design system's Tier-0 + Tier-3
layers so the asset renders standalone from a `file://` URL. That copy was taken by
hand and does not update when `packages/design-system/theme.css` moves, so **every
value in it is a claim about a past state of the design system.** Three corrections
have already been needed (`--el-danger-text`, above; `--el-accent`, here; and the
Tier-0 set below). The first two were invisible in the default light palette; the
third was not, which is the point — invisibility is not what makes drift worth
finding, and neither is visibility what makes it safe to leave.

Re-run this from the repo root before trusting the block — it parses every `--el-*`
declaration out of both files and diffs them, so it reports drift the eye cannot
see. It prints `DISAGREEMENTS: 0` today:

```bash
python3 - <<'PY'
import re
M='design/platform-admin/console.mock.html'; T='packages/design-system/theme.css'
def body(t,sel):
    for m in re.finditer(sel,t):
        j=t.index('{',m.start()); d,k=1,j+1
        while d: d+={'{':1,'}':-1}.get(t[k],0); k+=1
        yield t[j+1:k-1]
def decls(t,sel,pre='--el-'):
    o={}
    for b in body(t,sel):
        o.update({m[1]:' '.join(m[2].split())
                  for m in re.finditer('('+pre+r'[a-z0-9-]+)\s*:\s*([^;]+);',b)})
    return o
strip=lambda s: re.sub(r'/\*.*?\*/','',s,flags=re.S)  # a comment naming a token would fool the scan
mock=strip(open(M).read()); theme=strip(open(T).read()); bad=0
for label,ms,ts in [('LIGHT',r'(?m)^\s*:root\s*\{',r'(?m)^:root,\s*\n\[data-appearance-scope\]\s*\{'),
                    ('DARK',r"(?m)^\s*\[data-theme='dark'\]\s*\{",r"(?m)^\[data-theme='dark'\]\s*\{")]:
    m=decls(mock,ms); t=decls(theme,ts)
    print(f'== {label} == mock {len(m)} · theme {len(t)}')
    for k in sorted(m):
        if k not in t: print(f'  ONLY-IN-MOCK {k}: {m[k]}'); bad+=1
        elif m[k]!=t[k]: print(f'  DIFFERS {k}: mock={m[k]} theme={t[k]}'); bad+=1
print('DISAGREEMENTS:',bad)
PY
```

`ONLY-IN-MOCK` and `DIFFERS` are both defects — the first means the mock invented a
token or kept one the system dropped, the second is a stale alias. Tokens the mock
simply does not inline are fine (it copies 37 of the system's 200 `--el-*`). To
check the Tier-0 half the same way, change `pre='--el-'` to `pre='--color-'` **and**
the light theme-side selector to `r'(?m)^@theme\s*\{'` — Tier-0 lives in the
`@theme` block, Tier-3 in the `:root, [data-appearance-scope]` one.

**The Tier-0 half prints `DISAGREEMENTS: 0` today too** — MOTIR-2609 corrected the
four drifts it had (`--color-link` `#0075de`→`#0070d2`, `--color-tint-yellow`
`#fbf0c4`→`#fef7d6` light and `#332d12`→`#3a341a` dark, plus a dark
`--color-warning: #f08c3a` override the mock still carried and `theme.css` no longer
has, DELETED rather than re-pinned — an override the system dropped is not a value to
refresh). They were filed apart from MOTIR-2595 because they change rendered hues
across the panels rather than only the swap layer, and the re-export proves it: the
light PNG moved 289,487 pixels (0.745%), all of them the yellow-tint banner in the
view-as-tenant panel plus the external links in the estate and health panels, and
every one of the 1,311 distinct colour transitions traces to those two light values
or to an antialiasing blend of them. Nothing else moved.

The scan now covers the block completely: 33 light + 24 dark `--color-*`
declarations, which is every `--color-*` line in the file, against `theme.css`'s
37 + 28. The mock inlines no `--color-*` the system does not define, so there is no
ONLY-IN-MOCK exception to name here.

Whenever the block is corrected, re-export `console.png` after `prettier --write`:
Playwright chromium, light theme, `deviceScaleFactor: 2`, viewport width 1200,
`fullPage` — which reproduces the committed **2400×24962** export. (It was 2400×16180 until
the MOTIR-4564 amendment added Panels 10–12; `node scripts/render-design-mock.mjs
design/platform-admin/console.mock.html` recovers the viewport from the committed PNG and
reports `EXACT 1200x900@2x`, so the height is the only thing that moved.)

---

# AMENDMENT 2026-09-05 — the ORG level: lookup, page, and the internal-billing classification control

**Story MOTIR-4337 · card MOTIR-4564.** Panels **10 · 10b · 11 · 12** of
`console.mock.html`. This is an **amendment to this asset, not a new area** — it composes the
shell Panels 2–9 already draw and introduces no primitive and no bespoke admin CSS.

## What this amendment is, and the sentence in this file it corrects

The story's own body says the platform-admin console _"has no design area of its own today"_ and
calls that the NONE-exists case. **It is false on `origin/main`** — this area ships
`console.mock.html`, `console.png` and these notes, authored by MOTIR-728. What is genuinely
undrawn is narrower, and this file already said so: _"Story 10.1 draws READ views"_ and _"this
design draws no destructive control."_ Both of those statements survive. The control drawn in
Panel 12 is neither destructive nor 10.1's — it is a reversible per-org classification owned by
Story MOTIR-4337, and it is the only write this amendment adds.

**A reserved nav row is evidence the room is required, not evidence it is designed.** The rail
draws **Tenants** behind a `10.1` pill (`AdminShell.tsx`, `soonTenants`, `href="/admin/tenants"`,
`disabled: true`). Panels 10–12 draw that row **live and unbadged**, because this story builds its
ORG level.

## The ROUTE — `/admin/tenants`, not `/admin/orgs` (decision-authority rung 2)

The story's amendment block observes that `/admin/orgs` does not exist. So does `/admin/tenants` —
but the shipped rail already **points at `/admin/tenants`**, and this asset already reserves that
row for the tenant hierarchy. Inventing a second, sibling route would leave the reserved row
pointing at nothing while an unreserved one carried the surface. So:

| route                                   | owner          | what it is                                                      |
| --------------------------------------- | -------------- | --------------------------------------------------------------- |
| `/admin/tenants`                        | **MOTIR-4566** | the ORG lookup (Panel 10)                                       |
| `/admin/tenants/[orgId]`                | **MOTIR-4566** | the org page SHELL (Panel 11) + MOTIR-4568's control (Panel 12) |
| the workspace + project levels below it | **MOTIR-733**  | not drawn here at all                                           |

This is rung 2 — shipped reality — outranking the card's prose, the same call
`platform-staff-auth.md` recorded when it filed itself under `docs/decisions/` rather than the
path its own card named.

## Panel 10 — the ORG LOOKUP (review EACH panel — mistake #31)

- **The access path, end to end, drawn as a strip above the shell**: account menu → `/admin` →
  the left-nav **Tenants** row (live) → `/admin/tenants`. Panel 1 already draws step 1 in full;
  the strip is what makes the _whole_ path visible on one screen rather than inferred across two.
- **A GET form, not a type-ahead.** The shipped user lookup
  (`app/(admin)/admin/users/page.tsx`) settles this and the reasoning transfers unchanged: every
  search is an **audited cross-tenant read**, so a keystroke-per-request lookup would write an
  audit row per keystroke and bury the reads that mattered; and the query in the URL makes a
  result set linkable, reloadable and findable in history an hour later.
- **The ⌘K box in the top bar stays inert**, exactly as it does beside the user lookup. Panel 3's
  estate search groups four entity kinds and three of them still read tables with no
  `platform_staff` policy arm — this story ships the arms for `organization` **and only**
  `organization` (MOTIR-4565, carved from MOTIR-730). A palette that answered one group and
  silently returned nothing for the rest would be a search that lies about the estate.
- **The result row carries TWO classification chips**, `isMeta` and `internalBilling`, separately
  labelled. A single "Internal" chip would draw the conflation
  `docs/decisions/internal-billing-classification.md` §1 refuses; the two flags are true together
  on `moooon` today and that coincidence is not identity.

## Panel 10b — the lookup's three states

**Idle · query too short · no results.** There is deliberately no "forbidden" arm: a non-staff
user never reaches this route (Panel 7a's 404 is the whole answer, and it is the console's
standing rule). The idle state shows nothing until asked rather than listing the estate, because
the lookup answers a question and every answer is an audited read.

## Panel 11 — the ORG PAGE, and the ALLOCATION that keeps it honest

- **Header:** identity (name, slug), **plan tier**, **credit balance**, and the two chips. The
  balance reads `0` for a classified org and the panel says why in a `note`: the debits are real
  and each is paired with an `internal_offset` credit in the same transaction, so the balance nets
  to zero **while both entries stay visible** (ADR §2–§3). A reader who sees `0` and thinks
  _suppressed_ is the exact misreading this story exists to end.
- **One action:** _Classify as internal billing_ / _Remove internal classification_. Everything
  else on the page is read-only.
- **MOTIR-733's panels are drawn as RESERVED REGIONS** — a `card.reserved` with the owning card's
  key as a neutral `Pill` and one line saying what it will hold. Not content, not a skeleton (a
  skeleton claims the data is loading), not empty states (an empty state claims there is nothing
  to show).
- **The ALLOCATION TABLE is on the asset**, not in a card body, because it is the artifact three
  cards in two epics have to read the same way. It names, per element, whether MOTIR-4566,
  MOTIR-4568, MOTIR-4565, MOTIR-733 or MOTIR-745 builds it.

## Panel 12 — the CLASSIFICATION CONTROL, six states

The shipped `SupportActionsBar` pattern one entity over (`app/(admin)/admin/users/[userId]/`):
`Button` → `Modal` → `FormField` reason → confirm, with the audit row rendered back underneath.

| state                       | what it draws                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| **a** not classified        | no chip at all (absence is absence, not a badge) + the set button                              |
| **b** classified            | both chips + the unset button — the same control inverted                                      |
| **c** confirm, reason typed | the dialog, the required-reason field, the primary ENABLED                                     |
| **d** reason missing        | the same dialog with the primary **`disabled`** — a gate, never a post-submit error            |
| **e** already in that state | a warning toast: _no change made_, nothing written, **no audit row created**                   |
| **f** generic failure       | an error toast: the write and its audit row share one transaction, so a failure leaves neither |

- **The reason is mandatory and it is enforced twice** — `disabled` on the client, and the audit
  vocabulary's own reason policy inside the transaction. The client gate is convenience; the
  server gate is the rule.
- **The record is on the same surface as the action**, per this file's standing line that an
  operator can never perform an action and wonder whether it was recorded.
- **One `PlatformAuditLog` row, and no second audit log.** It is the shipped table from
  MOTIR-2896 and it joins `platform-staff-auth.md` §7's allocation as a `superadmin`-level,
  reason-required, audited write. When MOTIR-751's hash chain lands it extends this same table.

## Primitives composed (no hand-rolling)

`Sidebar` (the rail, with Tenants live), the `.adminbar` operator top bar, the `.scope` breadcrumb
grammar, `Card` (+ `card-head` / `card-body flush` / `card-foot`), the at-scale `table` + `pager`,
`Pill` (neutral / tier / platform / the new `internal` tone), `Button` (primary · secondary ·
disabled), `Modal` (the `.confirm` dialog) with `FormField` + its required-reason hint,
`EmptyState` (`.state`, three of them), and the `.note` / `.toast` annotation family. **No new
primitive is introduced.**

## Colour roles added by this amendment (`--el-*` only)

| Element                                       | Token                                                         | Why                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **`internalBilling` chip** (`.pill-internal`) | `--el-tint-sky` + `--el-text-strong`                          | The INFO family — a marker the platform set, the same family as the operator bar. Distinct from `isMeta`. |
| **`isMeta` chip** (`.pill-platform`)          | `--el-tint-lavender` + `--el-text-strong` (existing)          | The platform/tenancy family this asset already uses; keeps the two flags visually apart.                  |
| **Reserved region** (`.card.reserved`)        | `--el-surface-soft` + `--el-text-secondary` note              | Quieter than a live card, still a card. **No dashed border** — border style never carries state.          |
| **State-key badge** (`.ctrl-key`)             | `--el-tint-lavender` + `--el-text-strong`                     | A board-chrome index letter, the tint-plus-strong-ink rule (finding #35).                                 |
| **Already-in-state toast** (`.toast-warn`)    | `--el-tint-yellow` + `--el-text-strong`, glyph `--el-warning` | A refusal, not a failure — the cautionary hue, never danger.                                              |
| **Failure toast** (`.toast-err`)              | `--el-tint-rose` + `--el-text-strong`, glyph `--el-danger`    | Hue in the tint BACKGROUND with strong ink on top; the glyph carries the danger hue.                      |

Every caption in the new panels is `--el-text-secondary`, never `--el-text-muted` — muted clears
AA on the white page only, and these captions sit on `--el-surface`, `--el-surface-soft` and the
tints. `--el-danger-text` appears nowhere: it is the ink FOR a danger fill and there is no danger
fill in these panels.

## Copy strings (en — the `platformAdmin` namespace these panels add)

| Key                                        | String                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orgs.breadcrumb`                          | Platform · Tenants                                                                                                                                                                                                                                                                                                       |
| `orgs.title`                               | Organizations                                                                                                                                                                                                                                                                                                            |
| `orgs.subtitle`                            | Find an organization by name or slug. Opening one is an audited cross-tenant read.                                                                                                                                                                                                                                       |
| `orgs.searchLabel` / `orgs.searchSubmit`   | Name or slug / Search                                                                                                                                                                                                                                                                                                    |
| `orgs.idleTitle` / `orgs.idleDescription`  | Search for an organization / Type a name or slug above. Results are limited to 20; every match you open is recorded in the audit log.                                                                                                                                                                                    |
| `orgs.tooShort`                            | Enter at least {n} characters.                                                                                                                                                                                                                                                                                           |
| `orgs.noneTitle` / `orgs.noneDescription`  | No organizations match "{query}" / Check the spelling, or search by slug.                                                                                                                                                                                                                                                |
| `orgs.chip.isMeta` / `orgs.chip.internal`  | isMeta / internalBilling                                                                                                                                                                                                                                                                                                 |
| `orgs.action.classify`                     | Classify as internal billing                                                                                                                                                                                                                                                                                             |
| `orgs.action.unclassify`                   | Remove internal classification                                                                                                                                                                                                                                                                                           |
| `orgs.confirm.classify.title`              | Classify {name} as internal billing?                                                                                                                                                                                                                                                                                     |
| `orgs.confirm.classify.body`               | Every AI debit this org incurs will be paired, in the same transaction, with an offsetting credit — so it is charged exactly like a customer and its balance nets to zero. Both entries stay visible in the ledger. This changes no rate, lifts no cap and touches no Stripe object, and another operator can remove it. |
| `orgs.confirm.reasonLabel` / `…reasonHint` | Reason — required, written to the audit log / Shown to any operator reading this organization later. "Internal" on its own answers nothing.                                                                                                                                                                              |
| `orgs.action.error.alreadyInState`         | {name} is already classified as internal billing.                                                                                                                                                                                                                                                                        |
| `orgs.action.failedTitle`                  | Couldn't update the classification                                                                                                                                                                                                                                                                                       |
| `orgs.audit.title` / `orgs.audit.subtitle` | Platform actions on this organization / Every operator write on this org, newest first. Append-only.                                                                                                                                                                                                                     |

## The `meta` sweep of the customer areas (card criterion 7)

`grep -rin 'meta' design/billing/ design/ai-usage/` returns 37 hits. They fall into three groups,
and every one is disposed of:

1. **The `.meta` CSS class and its markup** (`.line .meta`, `<div class="meta">`) — 20 hits across
   `billing.mock.html`, `ci-line.mock.html`, `search-line.mock.html`. **UNRELATED**: it is a
   billed line's own metadata row, nothing to do with the META org.
2. **`Motir-state` / `metadata` prose** — 2 hits (`design/billing/design-notes.md:547`,
   `design/ai-usage/design-notes.md:329`). **UNRELATED**: the word inside "metadata".
3. **The META-org VARIANT** — the rest. **CORRECTED** in `design/billing/design-notes.md` and
   `design/ai-usage/design-notes.md` by an amendment section in each, which records that after
   MOTIR-4572 an internal org renders the ordinary customer panels and the CI line RENDERS in
   whatever state `ciAllowanceService` returns. The drawn META panels in `ci-line.mock.html`,
   `search-line.mock.html` and `search-spend.mock.html` are **annotated as superseded** in place
   rather than redrawn: they remain a true record of shipped behaviour until MOTIR-4572 merges,
   and redrawing customer pixels is out of this card's scope.
