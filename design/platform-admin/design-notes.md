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

| Surface                                                                                               | Asset                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Platform admin console (access path · nav shell · overview · rollup · per-model · drill · states)** | **`console.mock.html`** (HTML mockup) | The whole operator surface. Multi-panel: **access path** (the staff-only account-menu door) · **estate overview** (in the left-nav shell) · **usage/cost rollup hierarchy** · **per-model + top consumers** · **audited drill-down** · **gating / empty / loading / error**. Panels 2–5 render inside the persistent left-nav shell. **Gates 10.1.4 / 10.1.5 / 10.1.6.** A `console.png` full-page export sits beside it (the board-visible face). |

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
  existence is not leaked). See Panel 6a. Staff ENTER via a menu item drawn in
  Panel 1; they NAVIGATE via the left-nav shell — see "Access path & navigation".
- **Read-mostly (this Story).** Story 10.1 draws **READ** views — overview, the
  usage/cost rollup, the drill-down. The **governance ACTIONS** (suspend a
  tenant, adjust credits, impersonate, force-reset, …) are **Story 10.3's
  governance toolkit**; this design draws **no destructive control**, only the
  read views + the audited drill-in. (See "Shared shell" below.)
- **Denser, but the SAME design system.** Because an operator scans the whole
  estate, the console reads more table-heavy than a customer screen — but it
  composes **only** the shipped `components/ui/*` primitives + `--el-*` / shape
  tokens. **No bespoke admin CSS.** The one thing that visually distinguishes it
  from a tenant view is the **`--el-info` "Platform staff" context banner**
  (Panel 1) carried on every page, so an operator never confuses it with a
  customer tenant.

### ⚠️ Shared shell — Stories 10.2 + 10.3 EXTEND this area

**This card establishes the `design/platform-admin/` shell language for the whole
of Epic 10.** Story **10.2** (platform monitoring panels — health / queue depth /
error rates) and Story **10.3** (the governance toolkit — the tenant ACTIONS) both
**reuse this shell**: the `/admin` route group, the persistent platform-staff
banner, the `Platform · …` breadcrumb grammar, the `Card`-stack page body, the
at-scale table+pager pattern, and the per-entity / per-model colour roles below.
Their skeletons should not re-invent any of it. **10.1 is read-mostly; the
governance actions are 10.3** — when 10.3 lands, the drill-down detail (Panel 5)
grows an actions affordance, but 10.1 ships none.

### ⚠️ Net-new capability (a planning dependency for 10.1.x)

A **platform-staff persona does not exist in the shipped schema** (recon
2026-06-21: the only role enums are `OrganizationRole` and `MemberRole`, both
tenant-scoped; there is no `/admin` route and no cross-tenant operator
capability). This console therefore introduces a **net-new platform-staff gate**
orthogonal to the tenant roles — a prerequisite the 10.1.x code subtasks (and
likely an **Epic-10 foundation subtask** ahead of them) must own:

- a **staff flag** (e.g. `User.isPlatformStaff`, seeded only for moooon staff),
- a **`requirePlatformStaff()` guard** that **404s** (not 403s) every non-staff
  request to `/admin` and its APIs,
- an **audit-log write on every cross-tenant read** (the posture Panel 5 makes
  visible).

This is flagged here, not silently assumed by the design. If the planner agrees,
add that foundation subtask to Story 10.1 (or Epic 10) as a `blocked_by` of
10.1.4/5/6.

### Data — the usage figures aggregate the 7.2 `OrgUsageDTO`, summed UP a level

The usage/cost panels are the **estate-scope** sibling of the **org-scope** 7.2
dashboard (`design/ai-usage/`). The org dashboard reads an **`OrgUsageDTO`**
(`lib/dto/aiUsage.ts`: `balance`, `tier`, `totalSpend`, `monthSpend`,
`monthlyHistory[]`, `perModel[{ model, inputTokens, outputTokens, credits }]`,
`recentRuns[{ jobKind, model, projectName, … }]`, `hasUsage`) from **motir-ai
over the 7.1 boundary**. The platform console reads the SAME shape **summed up
one more level** to a **`PlatformUsageDTO`** the **10.1.5** code subtask builds:
estate counts + a hierarchical `byTenant[]` rollup (project → workspace → org →
platform total) + an estate-wide `perModel[]` + a `topConsumers[]` leaderboard,
all **pre-aggregated** (the table never implies a live scan of raw usage rows).
Numbers in the mock are illustrative. The loading skeleton (Panel 6c) covers the
fetch; the error state (Panel 6d) covers the motir-ai boundary being down.

### Where it lives

- A new staff-only route group **`app/(admin)/admin/`** (suggested):
  `admin/page.tsx` (overview), `admin/usage/page.tsx` (rollup + per-model),
  `admin/tenants/[scope]/[id]/page.tsx` (drill-down). Gated by
  `requirePlatformStaff()`; a non-staff request 404s.
- **At-scale (finding #57 — NOT load-all).** The estate has hundreds of orgs and
  tens of thousands of jobs; **every list paginates** — the activity feed (Panel
  2), the rollup hierarchy (Panel 3), the top-consumers list (Panel 4), the
  per-tenant recent-jobs list (Panel 5). The 10.1.x code subtasks MUST fetch a
  page at a time off pre-aggregated reads.

---

## Access path & navigation (the door + the hallway — drawn, not just named)

The design-reference rule requires drawing **how the surface is reached**, not
naming a route in prose. Two mechanisms, both drawn:

1. **Entering the console (Panel 1).** A platform-staff account's **account menu**
   (the shipped TopNav user-avatar `Popover`) carries a staff-only **"Platform
   admin"** item (`i-shield`, a "Staff only" tag) → `/admin`. For a non-staff user
   the item is **absent** and `/admin` **404s** (Panel 6a) — the route's existence
   is never revealed. This is the one door in.
2. **Moving between screens (the shell — Panels 2–5).** Every console page renders
   inside a **persistent left-nav rail** (`.admin-nav`, the shipped `Sidebar`
   grammar): a brand header (`Motir · Platform admin`), a **Platform** group
   (**Overview · Usage & cost · Tenants**) and an **Operations** group (**Monitoring
   [10.2] · Governance [10.3]**, shown as reserved with a "soon" tag), an operator
   identity footer + an **"Exit to app"** row back to the normal app. The active
   section is tinted `--el-tint-sky`. This rail IS the hallway — it answers "where
   am I / how do I reach the next screen" on every page, and it is the shell
   Stories 10.2 + 10.3 hang their sections on.

The **drill-down (Panel 5)** is reachable **three ways, all drawn**: clicking any
tenant row in the Overview activity feed, the rollup tree, or the top-consumers
leaderboard (every such row is `.drillable` / carries a drill chevron), OR the
**Tenants** rail section. The Overview's footer `reach-note` states this in words
too.

## Panels (review EACH — mistake #31)

### Panel 1 — ACCESS PATH (how staff enter /admin)

The normal Motir app `TopNav` (a customer tenant view) with the **account menu
open**. Composes the shipped user-avatar `Popover` + `opt` rows: **Account
settings**, **Your organizations**, then the staff-only **"Platform admin"** row
(`i-shield`, active tint, a `--el-info` "Staff only" tag, sub-label "Operator
console · the whole estate"), then **Sign out**. A side note states the gate: the
item is **absent** for non-staff and `/admin` **404s** for them (the existence
isn't leaked). An `entry-call` line ties the click to the destination (the console
**Overview**, breadcrumb `Platform · Overview`). This is the access-path half of
the design-reference rule — the **net-new platform-staff capability** (above) is
what makes this item conditional.

### Panel 2 — estate OVERVIEW (populated, in the shell)

The operator's landing page — the first thing seen after entering. Rendered inside
the **left-nav shell** ("Overview" active) with the staff banner across the top.
Composes, top to bottom:

- **Platform-staff context banner** (`.staff-banner`) — the OPERATOR-view marker,
  carried on every console page. An `--el-tint-sky` strip with an
  `inset 3px 0 0 --el-info` left rule, a shield icon in `--el-info`, the copy
  **"Platform staff · operator console. You are viewing the entire Motir estate
  across all tenants. Every cross-tenant read is recorded in the audit log."**,
  and a right-aligned **"moooon B.V. internal"** neutral `Pill`. Hue lives in the
  banner, never the page surface (finding #35).
- **Estate counts** — four stat `Card`s (`.stat`): **Organizations / Workspaces /
  Projects / Users**, each a serif hero number + a per-entity tinted icon +
  a `+n this month` `--el-success` delta. Per-entity tint, not grey-only
  (finding #54) — see colour roles.
- **Recent estate activity** — a `Card` with an at-scale **table** (`.tbl`),
  newest first: **When**, **Event** (an event-kind `Pill` — new org / new
  workspace / planning run / coding job), **Tenant** (avatar + dotted
  `org › workspace › project` path), **Detail** (job/model/token or owner). A
  card-foot **pager** ("Showing 1–5 of 48,920 events", Prev disabled on page 1) —
  at-scale, NOT load-all (finding #57). Every tenant row drills to Panel 5; a
  footer `reach-note` spells out the navigation.

- **Platform-staff context banner** (`.staff-banner`) — the OPERATOR-view marker,
  carried on every console page. An `--el-tint-sky` strip with an
  `inset 3px 0 0 --el-info` left rule, a shield icon in `--el-info`, the copy
  **"Platform staff · operator console. You are viewing the entire Motir estate
  across all tenants. Every cross-tenant read is recorded in the audit log."**,
  and a right-aligned **"moooon B.V. internal"** neutral `Pill`. Hue lives in the
  banner, never the page surface (finding #35).
- **Estate counts** — four stat `Card`s (`.stat`): **Organizations / Workspaces /
  Projects / Users**, each a serif hero number + a per-entity tinted icon +
  a `+n this month` `--el-success` delta. Per-entity tint, not grey-only
  (finding #54) — see colour roles.
- **Recent estate activity** — a `Card` with an at-scale **table** (`.tbl`),
  newest first: **When**, **Event** (an event-kind `Pill` — new org / new
  workspace / planning run / coding job), **Tenant** (avatar + dotted
  `org › workspace › project` path), **Detail** (job/model/token or owner). A
  card-foot **pager** ("Showing 1–6 of 48,920 events", Prev disabled on page 1) —
  at-scale, NOT load-all (finding #57).

### Panel 3 — usage/cost ROLLUP (the hierarchy, in the shell)

In the shell, **"Usage & cost"** active. A single `Card` whose head carries the
**platform total as the hero figure**
(serif 30px + `credits` unit + a `≈ $… equiv` caption — the $-equivalent is
operator context only; credits stay the unit). The body is the **TreeTable**
hierarchy (`.tbl.tree`): columns **Tenant** (indented name + expand chevron),
**Level** (an `Org` / `Workspace` / `Project` `Pill`), **Tokens**, **Share of
estate** (a per-level-tinted `.usebar`), **Credits**. Rows nest **org → workspace
→ project** by indentation (`.lvl-1` / `.lvl-2`) with an expand/collapse chevron
(`i-chevdown` open / `i-chevright` collapsed; leaf rows hide it). Org rows carry a
faint `--el-surface` wash so the groups read. The card-foot states the rollup is
**pre-aggregated, never a live scan** + a pager ("Top 4 of 214 orgs"). The big
consumer is obvious at a glance (the widest bar / biggest credits).

### Panel 4 — per-MODEL breakdown + TOP CONSUMERS (in the shell)

Still under **"Usage & cost"** in the shell. Two `Card`s side by side (`.grid-2`):

- **By model** — a `.tbl`: per model a **model chip** (a coloured `.dot` + name;
  the 9.0-gateway models annotate "· 9.0 gateway"), **Tokens**, a **Share**
  `.usebar` (per-model tint), **Credits**, and a **$ equiv** muted column. Foot
  totals tokens + credits + the $-equiv `Pill`. Palette-tinted per model so the
  costliest model is visibly the bigger drain (finding #54).
- **Top consumers** — a `.tbl` leaderboard: a **rank** chip (`.rank.top` for the
  top 3, `--el-tint-yellow`), the **tenant** (avatar + `· org`/`· workspace`
  kind), a **Share** `.usebar`, **Credits**, and a **drill chevron** (each row is
  a drill-in target). Foot: "Top 5 of 214 · ranked by credits this month" + a
  "View all" affordance.

### Panel 5 — DRILL-DOWN detail (org / workspace / project, in the shell)

In the shell, **"Tenants"** active (the section the drill lives under). Reached
three ways — a tenant row in Overview / the rollup / top-consumers, OR the Tenants
section. The single-tenant detail an operator drills into. Composes:

- **Scope breadcrumb** (`.scope`) — `Platform › Tenants › Acme Corp`, the
  active segment tinted `--el-tint-lavender` with the `i-updown` switcher chevron
  (the Combobox/breadcrumb grammar from the org dashboard, reused).
- **Audited-read affordance** (`.audit-banner`) — the cross-tenant-read-is-audited
  posture **made visible**: an `--el-tint-sky` banner, `i-eye` in `--el-info`,
  **"You are viewing Acme Corp's data as platform staff. This cross-tenant read
  is recorded in the audit log (operator OP · ops@moooon.net, just now)."**
- **Tenant header** — avatar + name + status `Pill` (`● Active`) + tier `Pill` +
  created-date, with the tenant **balance** as a hero figure on the right.
- **Usage over time** — a token-only `.trend` sparkline (the current month tinted
  `--el-accent`, history `--el-tint-lavender`); no chart lib, no image.
- **Tenant shape** — a 2×2 `.mini-stats` grid (Workspaces / Projects / Members /
  Work items) + a member-avatar preview ("+45 more · owner …").
- **Recent jobs** — a `.tbl` of planning **and** coding runs (When / Job kind
  `Pill` / Project / Model chip / Tokens / Credits), **paginated** ("Showing 1–4
  of 9,140 jobs").

### Panel 6 — gating · empty · loading · error

A 2×2 `.states-grid` of the four non-happy states:

- **(a) Access denied = a 404 (`.state.notfound`).** A non-staff user hitting
  `/admin` gets the **standard app 404** — "This page doesn't exist", a "Back to
  Motir" button. A dashed **reviewer note** (not part of the shipped UI) states
  the rule: NO "403 / forbidden" page, no hint the route is real (its existence
  isn't leaked); the surface simply does not exist for them. (This is the staff
  gate from "Net-new capability".)
- **(b) Empty (`.state`).** First run, no usage across any tenant yet — `i-coins`,
  "No usage yet", a "View tenants" secondary CTA.
- **(c) Loading (`.state` + `.sk` skeletons, `aria-busy`).** The dashboard
  skeleton (stat-card + chart placeholders) while the rollup fetches over 7.1.
- **(d) Error (`.state.err`).** The usage fetch failed (motir-ai down) —
  `i-alert` in `--el-tint-rose` / `--el-danger-text`, "Couldn't load usage", an
  explicit "no tenant has zero usage; the figures are simply not loaded" (a
  fetch error, **not** a misleading zero), and a **Retry** secondary button.

---

## Primitives composed (no hand-rolling)

Every surface composes a shipped `components/ui/*` primitive. If a 10.1.x code
subtask needs a genuinely new primitive, that is a **new `design/` subtask**, not
a code workaround.

- **`Card`** — every stat card, the rollup card, the per-model / top-consumers /
  recent-jobs / state cards, the drill-down section cards (`--radius-card`,
  `--shadow-card`, `--spacing-card-padding`; head/body/foot split by
  `--el-border-soft`).
- **`Pill`** — the level chips (`Org` / `Workspace` / `Project` / `Platform`), the
  event-kind chips (new org / new workspace / planning run / coding job), the
  model chips, the tenant **status** + **tier** chips, the neutral count / scope
  chips. `--radius-badge`, `--spacing-chip-*`; **hue in the tint BACKGROUND with
  `--el-text-strong` text (finding #35 — AA-safe), never a tinted page surface.**
- **`Button`** — primary ("Back to Motir"), secondary ("View tenants", "Retry"),
  ghost. `--height-btn-md` / `--height-btn-sm`; `--spacing-btn-x[-sm]`.
- **Table / list pattern** — the activity feed, the rollup TreeTable, the
  per-model + top-consumers tables, the recent-jobs list. Reuse the at-scale list
  pattern the issues list / org-admin roster / org usage dashboard established
  (header row, `--el-border-soft` row separators, tabular-nums on numerics). The
  rollup adds level indentation (`.lvl-*`) + an expand chevron — the `TreeTable`
  pattern, not a new control.
- **Pagination** — every list foot (count text + Prev/Next + page indicator),
  identical to the org-admin roster / org-usage pagers. The at-scale control —
  NOT load-all.
- **`Sidebar` (the left-nav shell · `.admin-nav`)** — the persistent console
  navigation on every page (Panels 2–5): the brand header, the grouped nav rows
  (`.nav-item`, `--radius-control` / `--spacing-control-*`, the active row tinted
  `--el-tint-sky`), the reserved 10.2/10.3 rows, the operator footer + "Exit to
  app". Reuses the shipped `Sidebar` / nav-row grammar (`design/shell/`) — do NOT
  hand-roll a new rail. This IS the inter-screen navigation.
- **`Popover` + menu rows (the access path · Panel 1)** — the account menu in the
  TopNav (the shipped user-avatar `Popover`, `design/shell/` / `design/org-admin/`)
  carries the staff-only **"Platform admin"** `opt` row → `/admin`. The entry
  affordance is DRAWN, not just named (the route is the door).
- **`Combobox` / breadcrumb (the scope control)** — the `Platform › Tenants › …`
  drill path in Panel 5 (the same switcher grammar the org → workspace → project
  drill established). Do NOT hand-roll a new control.
- **`EmptyState` / `ErrorState`** family — Panel 6 b / d (and the 404 reuses the
  same centred `.state` shell).
- **`Skeleton`** — Panel 6c loading dashboard.
- **Meter / bar (token-only)** — the share `.usebar`s + the per-tenant `.trend`
  sparkline are plain token-styled `div`s (radius + tint), no charting lib, no
  image. A richer chart would be a new `design/` subtask.

## Colour roles (`--el-*` — palette, not grey-only · finding #54)

| Element                                            | Token                                                                                              | Why                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Platform-staff banner**                          | `--el-tint-sky` bg + `--el-info` left rule & icon, text `--el-text-strong`                         | The OPERATOR marker — the info family, hue in the banner (finding #35).  |
| **Audited-read banner (drill-down)**               | `--el-tint-sky` bg + `--el-info` `i-eye`, text `--el-text-strong`                                  | "You are viewing another tenant (audited)" — same info family.           |
| **Estate count: Organizations**                    | icon `--el-tint-lavender` + `--el-accent-on-surface`; avatar `--el-tint-lavender`                  | The org/tenancy root — the brand-purple family (matches the org avatar). |
| **Estate count: Workspaces**                       | icon `--el-tint-sky` + `--el-info`; avatar `--el-tint-sky`                                         | Distinct blue — the workspace tier.                                      |
| **Estate count: Projects**                         | icon `--el-tint-mint` + `--el-success`; avatar `--el-tint-mint`                                    | Green — the project tier.                                                |
| **Estate count: Users**                            | icon `--el-tint-rose` + `--el-highlight`                                                           | Brand-pink decorative — clearly NOT an alert hue.                        |
| **Level pill: Org / Workspace / Project**          | `--el-tint-lavender` / `--el-tint-sky` / `--el-tint-mint` + `--el-text-strong`                     | The same tier tints as the counts — one tier, one hue, everywhere.       |
| **Platform total (hero) / share bar (org)**        | `--el-accent` (serif `--el-text`)                                                                  | The estate total + the org-level share — the strongest hue.              |
| **Share bar: workspace / project**                 | `--el-info` / `--el-success`                                                                       | Match the tier tints; the deepest level is the lightest hue.             |
| **Event-kind: new org / new ws / plan / code**     | `--el-tint-lavender` / `--el-tint-sky` / `--el-tint-mint` / `--el-tint-peach` + `--el-text-strong` | Four event tints, readable at a glance.                                  |
| **Model: Claude Opus**                             | dot + bar `--el-accent`                                                                            | The priciest/heaviest model — the biggest drain.                         |
| **Model: Claude Sonnet**                           | dot + bar `--el-info`                                                                              | Distinct blue, the mid tier.                                             |
| **Model: Claude Haiku**                            | dot + bar `--el-success`                                                                           | Green — the cheapest tier.                                               |
| **Model: DeepSeek (9.0 gateway)**                  | dot + bar `--el-type-subtask` → `--color-accent-teal`                                              | The teal family — the non-Claude gateway channel, visibly distinct.      |
| **Top-consumer rank (top 3)**                      | `.rank.top` `--el-tint-yellow` + `--el-text-strong`                                                | The leaders stand out; ranks 4+ are neutral.                             |
| **Tenant status: Active**                          | `--el-tint-mint` + `--el-text-strong`                                                              | Healthy tenant.                                                          |
| **Tenant tier chip**                               | `--el-tint-lavender` + `--el-text-strong`                                                          | The plan tier — the brand-purple family.                                 |
| **Estate-growth delta (`+n this month`)**          | `--el-success`                                                                                     | Growth — coloured, not grey.                                             |
| **Active left-nav row + active account-menu item** | `--el-tint-sky` bg + `--el-text-strong`, icon `--el-info`                                          | The current section — the info family, matching the staff banner.        |
| **Error icon tint (Panel 6d)**                     | `--el-tint-rose` + `--el-danger-text`                                                              | Fetch-error state.                                                       |
| **404 icon (Panel 6a)**                            | `--el-surface` + `--el-text-faint` (the `i-ban` glyph)                                             | A plain not-found, deliberately undramatic (no "forbidden" red).         |
| **Primary CTA / active scope segment**             | `--el-accent` (+ `--el-accent-text`) · `--el-tint-lavender`                                        | "Back to Motir" / the active drill segment.                              |
| Count / scope / "internal" chips                   | `--el-surface` + `--el-text-secondary` (neutral `Pill`)                                            | Genuinely neutral metadata.                                              |
| Text / surfaces / borders                          | `--el-text*`, `--el-surface*`, `--el-border*`                                                      | Standard element tokens — never Tier-0 `--color-*`.                      |

> **One deliberate Tier-0 reach:** the DeepSeek dot/bar uses `--color-accent-teal`
> (via the `--el-type-subtask` fallback), exactly as `design/ai-usage/` does,
> because there is no dedicated `--el-*` teal element token. When 10.1.5 builds
> this, prefer adding an `--el-model-deepseek` (or reusing `--el-type-subtask`)
> element token over reaching Tier-0 directly — the per-component growth pattern
> (`notes.html` #20). Every other colour routes through `--el-*`.

All shaped surfaces use the **`[data-display-style]` shape tokens**
(`--radius-{btn,card,input,control,badge}`, `--spacing-{btn,input,control,chip,
card-padding}`, `--height-{btn-*,input,control}`, `--shadow-*`) — never the inert
Tier-0 radius/spacing scale or a fixed raw utility. `rounded-full` (`9999px`) is
used only for the round status dots / share-bar caps / circular avatars. Toggle
the mock's dark mode to confirm token parity (every colour flips through Tier-0
under `--el-*`).

## Copy strings (en — the `admin` / `platformAdmin` i18n namespace 10.1.x adds)

- **Access path (account menu):** item **"Platform admin"** / sub **"Operator
  console · the whole estate"** / tag **"Staff only"**; the entry note **"Selecting
  'Platform admin' lands on the console Overview."**
- **Left-nav shell:** brand **"Motir"** / **"Platform admin"**; groups
  **"Platform"** / **"Operations"**; items **"Overview"**, **"Usage & cost"**,
  **"Tenants"**, **"Monitoring"** (tag **"10.2"**), **"Governance"** (tag
  **"10.3"**); footer **"Platform staff"** / **"{email}"** / **"Exit to app"**.
- **Banner:** **"Platform staff · operator console."** / **"You are viewing the
  entire Motir estate across all tenants. Every cross-tenant read is recorded in
  the audit log."** / chip **"moooon B.V. internal"**.
- **Overview:** breadcrumb **"Platform · Overview"**; title **"Platform
  overview"**; subtitle **"The whole estate at a glance — how many organizations,
  workspaces, projects and users Motir hosts, and what's happened recently across
  every tenant. Read-only; tenant governance lives in the Governance toolkit."**;
  counts **"Organizations"** / **"Workspaces"** / **"Projects"** / **"Users"**,
  delta **"+{n} this month"**.
- **Activity:** **"Recent estate activity"** / **"New tenants and AI jobs across
  every organization, newest first."**; columns **"When"**, **"Event"**,
  **"Tenant"**, **"Detail"**; event kinds **"New organization"** / **"New
  workspace"** / **"Planning run"** / **"Coding job"**; pager **"Showing
  {from}–{to} of {total} events"**, **"Page {n} of {m}"**, **"Prev"** / **"Next"**.
- **Rollup:** breadcrumb **"Platform · Usage & cost"**; title **"Usage & cost
  rollup"**; subtitle **"Credits spent across the whole estate this month, rolled
  up the tenancy hierarchy. Credits are an internal usage unit (never a
  currency); the $-equivalent is operator context only."**; **"Spend by
  tenancy"** / **"Expand an org to see its workspaces and projects. Sorted by
  spend."**; hero **"{n} credits"** / **"Platform total · this month · ≈ ${usd}
  equiv"**; columns **"Tenant"**, **"Level"**, **"Tokens"**, **"Share of
  estate"**, **"Credits"**; levels **"Org"** / **"Workspace"** / **"Project"**;
  foot **"Top {n} of {total} orgs · figures are pre-aggregated, never a live scan
  of raw usage rows."**
- **By model:** **"By model"** / **"Estate-wide tokens + credits this month, per
  model. Planning + coding."**; columns **"Model"**, **"Tokens"**, **"Share"**,
  **"Credits"**, **"$ equiv"**; gateway annotation **"· 9.0 gateway"**; foot
  **"{tok} tokens · {credits} credits"** / **"≈ ${usd} equiv"**.
- **Top consumers:** **"Top consumers"** / **"The orgs & workspaces draining the
  most this month. Click to drill in."**; **"· org"** / **"· workspace"**; foot
  **"Top {n} of {total} · ranked by credits this month"** / **"View all"**.
- **Drill-down:** scope **"Platform › Organizations › {tenant}"**; audit banner
  **"You are viewing {tenant}'s data as platform staff. This cross-tenant read is
  recorded in the audit log (operator {op} · {email}, just now)."**; status
  **"● Active"**; tier **"{tier} tier"**; **"Created {month}"**; **"Usage over
  time"** / **"Credits debited per month — this tenant."**; **"Tenant"** /
  **"Shape & access — read-only."**; mini-stats **"Workspaces"** / **"Projects"**
  / **"Members"** / **"Work items"**; **"+{n} more · owner {email}"**; **"Recent
  jobs"** / **"Planning & coding runs for this tenant, newest first."**; columns
  **"When"**, **"Job"**, **"Project"**, **"Model"**, **"Tokens"**, **"Credits"**;
  job kinds **"Coding"** / **"Generate"** / **"Expand"**; pager **"Showing
  {from}–{to} of {total} jobs"**.
- **States:** 404 **"This page doesn't exist"** / **"The page you're looking for
  couldn't be found. Check the URL, or head back to your workspace."** / **"Back
  to Motir"**; empty **"No usage yet"** / **"No AI planning or coding jobs have
  run across any tenant yet. Once they do, the estate rollup, per-model breakdown
  and top consumers fill in here."** / **"View tenants"**; loading **"Loading the
  estate rollup…"**; error **"Couldn't load usage"** / **"The usage service
  (motir-ai) didn't respond, so the estate rollup is temporarily unavailable.
  This is a fetch error — no tenant has zero usage; the figures are simply not
  loaded."** / **"Retry"**.

The full string set is added to the app's locale files (en + zh, the shipped
locale set) by the 10.1.x code subtasks under the new `admin` namespace.
