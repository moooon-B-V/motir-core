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
