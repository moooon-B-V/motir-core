# Roadmap — design notes

Design reference for the **`roadmap`** UI area — the **reusable, deterministic
work-item canvas** (Subtask **MOTIR-1009 / 7.3.76**). One canvas component that
renders any project's **work-item tree + pre-plan phase** in a fixed, opinionated
layout. It is the auto-arranged **sibling** of the free-form **spatial canvas**
(`design/ai-chat/canvas-spatial.*`, `MOTIR-1235`): the **same node + edge
model**, a **different layout discipline** — where the spatial canvas lets the
user drag nodes anywhere, this one auto-initialises them in a deterministic
arrangement (still pannable / zoomable; nodes still draggable from there).

> **This is the FOUNDATION design.** Its BUILD is the standalone component
> `MOTIR-1194 / 7.3.77` (which this card `blocks`). It is consumed by:
> start-fresh onboarding (**7.3** / `MOTIR-804`), migrate-existing onboarding
> (**7.15** / `MOTIR-815`), re-planning (**7.11** / `MOTIR-811`), the persistent
> roadmap (**7.19** / `MOTIR-1011`, which this card `blocks`), and the public
> project page (unplanned). Design it surface-agnostic.

## Asset set (the three files)

| File                | What it is                                                                       |
| ------------------- | -------------------------------------------------------------------------------- |
| `design-notes.md`   | this spec (primitives, copy, token roles, per-behaviour provenance)              |
| `roadmap.mock.html` | the source of truth — a multi-panel mock built from the real tokens              |
| `roadmap.png`       | the full-page export (Playwright chromium, light, `deviceScaleFactor 2`, 1200px) |

The mock is a **multi-panel review board** — eight sheets (5 spec + 3 multi-level
navigation OPTIONS, below), every panel inspected (the multi-panel rule,
`notes.html` #31).

---

## ⭐ Built on SHIPPED REALITY (rung 2 — design-against-shipped-reality)

This canvas does **not** invent an engine. It **renders on the shipped
`PlanningCanvas`** (`MOTIR-1236`, done — `components/planning/PlanningCanvas.tsx`):
a Miro-style **pan / zoom / drag / fit viewport** that draws caller-supplied
**nodes + READ-ONLY dependency edges**. This design supplies the **deterministic
LAYOUT + node / edge CONTENT**, not a new canvas. The node cards reuse the
shipped **`StationCard`** language (`components/onboarding/StationNode.tsx`): the
tier-coloured tile, title + subtitle, the state pill, and the captured-findings
rows. So the mock mirrors the running UI rather than a stylised stand-in.

**The build split it slots into** (so the FOUNDATION reuse is real):

- `PlanningCanvas` (`MOTIR-1236`) — the surface + interaction (pan/zoom/drag/fit,
  read-only edges, `onNodeMove` / `onNodeActivate`). **Reused, never rebuilt.**
- `MOTIR-1194 / 7.3.77` — the **standalone work-item canvas component** this
  design specifies: the deterministic auto-layout + the node/edge content +
  search-to-focus + filters, composed over `PlanningCanvas`.
- The onboarding consumer `OnboardingCanvas` (`MOTIR-840`) is the existing,
  shipped composition the deterministic layout generalises.

### Edge convention — match the engine, add the cross-story case

The shipped `PlanningCanvas` draws edges in **two neutral variants**:
`firm` = solid `--el-border-strong`; `pending` = dashed `--el-border`. This
design **adopts that convention verbatim** (the spatial _mock_'s illustrative
green/accent edges were a simplification; the engine — the reality — is neutral).
It **adds one variant**: a **cross-story `blocked_by`** edge, drawn **warning-
toned** (`--el-warning`) **+ a flag badge** at its midpoint, so the dependency
tangle the arrow-audit forbids is visible (carried from `MOTIR-1009`). This is a
clean superset; `7.3.77`'s build adds a `variant: 'cross'` to `CanvasEdge`.

---

## The deterministic INITIAL LAYOUT (the heart of the card — Yue, 2026-06-22)

Nodes auto-initialise in this fixed arrangement (it **refines** the space-filling
serpentine the spatial canvas uses — here the layout is **opinionated, not
space-filling**). Drawn on **sheet 1** (start-fresh) + **sheet 2** (migrate):

- **Row 1 — the 4 pre-plan tiers, left → right in ONE row:** _Understanding your
  idea_ · _What we'll build_ · _Is it worth building?_ · _Will people want it?_
  (plain language, never jargon — the canvas-spatial copy rule). The seed **Your
  idea** node sits at the left, feeding the row (omitted on a resume with no idea).
- **Row 2 — _Design your look_**, and — **only when the project already has work
  items — _Read your project_** in the same row.
- **Then a single _Plan → your project_ node — NOT the epics fanned out.** The
  plan node stands for the produced backlog; epics / stories appear on
  expand / post-plan (sheet 3), never in the initial layout.

**Skippable steps get DOTTED borders** — the two optional tiers, the design step,
and _Read your project_. **Distinct from** the _upcoming / ghosted_ **DASHED**
border the shipped canvas already uses: **skippable = dotted, upcoming = dashed**
(spelled out in the sheet-1 legend + the sheet-4 state strip). Skip semantics
come from the gated step machine (`MOTIR-838`) + conductor (`MOTIR-1099`) — a skip
is a **chat** decision before a tier drafts, never a button on the node (the
canvas-spatial gate-rhythm rule).

---

## The screens (sheets, in the mock)

| Sheet | Screen                           | What it shows                                                                                                                                                          |
| ----- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | Initial layout — **start-fresh** | the deterministic arrangement; node states; dotted-vs-dashed; the **Board ↔ Roadmap** view toggle (the access path); zoom + legend                                     |
| **2** | Initial layout — **migrate**     | the same layout + **Read your project** (the 7.15 entry: connect repo + grant Motir AI access); the search-to-focus field                                              |
| **3** | **Post-plan** tree               | plan → epic → story → subtask; within-story dep arrow **vs.** the cross-story `blocked_by` warning edge + flag; migrate linking (linked-under-tier **and** standalone) |
| **4** | **Node states** spec strip       | done / active-frontier / deciding / skippable(dotted) / upcoming(dashed) / drafting — each an icon + label + tint                                                      |
| **5** | **Controls & states**            | filters (status / assignee / epic) · search-to-focus · density · empty / loading / error · the reuse note                                                              |
| **6** | Multi-level — **Option A**       | drill-down (self-similar): click a node → the canvas refreshes to that node's children as a chain; breadcrumb + Back                                                   |
| **7** | Multi-level — **Option B**       | expand-in-place: all levels on one canvas, an epic opens its stories inline, a story its subtasks (nested clusters)                                                    |
| **8** | Multi-level — **Option C**       | level toggle: an Epic / Story / Subtask switch + scope filter picks which level's flat chain to draw                                                                   |

---

## ⚠️ MULTI-LEVEL CHAINS — an OPEN DECISION (sheets 6-8; Yue, 2026-06-22)

The planner orders same-level work as a **chain (DAG) at EVERY level** — epic↔epic, story↔story,
subtask↔subtask (`plan.md`'s dependency-arrow rule: "genuinely sequential work → a chain"). So the
roadmap must render the **story-level and subtask-level chains**, not only the epic level. Sheets 1-5
draw the epic-level chain; the rows-inside-an-epic-card on sheet 3 are a SUMMARY, not the lower-level
roadmaps. **How the one canvas lets you NAVIGATE between levels is an open product decision** — three
options are drawn (same scenario, Plan ▸ Invoices ▸ Create invoice, for a fair comparison). **Pick one
before the BUILD (`MOTIR-1194`).**

| Option                            | Model                                                                                              | ✅                                                                                                                           | ⚠️                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **A — Drill-down** (sheet 6)      | click a node → canvas **refreshes** to its children as a chain; breadcrumb + Back                  | each chain stays big + legible at any tree size (the scale axis); extends the spatial canvas's "self-similar at every level" | one level shown at a time (zoom-to-fit gives the overview)                      |
| **B — Expand-in-place** (sheet 7) | epic opens its stories **inline / nested**; a story opens its subtasks — all levels on one surface | whole multi-level shape visible at once                                                                                      | crowds fast on a real (100s-of-items) backlog; needs collapse / zoom            |
| **C — Level toggle** (sheet 8)    | an **Epic / Story / Subtask** switch + scope filter picks the level's flat chain                   | simplest model; every view uncluttered                                                                                       | hierarchy lives in the dropdown, not on the canvas — weakest whole-project feel |

**Recommendation: Option A (drill-down).** It is the only model that stays legible on a real, large
plan (the completeness / scale axis), reuses the shipped `PlanningCanvas` engine cleanly (same surface,
re-fed nodes + edges per level), and EXTENDS — rather than overturns — the already-decided spatial-
canvas "self-similar at every level" direction. A + a zoom-to-fit overview is one coherent product; B
could later be added as a power-user affordance. **This section is provisional until Yue picks**; on
selection, the chosen model becomes the spec, the other two sheets are dropped, and `MOTIR-1009`'s
acceptance criteria + the build card `MOTIR-1194` are updated to require multi-level chains.

> All three options use the SAME node + edge language as sheets 1-5 (the shipped `StationCard` /
> `PlanningCanvas` languages, `--el-type-*` hues, neutral firm / dashed pending edges + the cross-story
> warning edge) — only the level-navigation interaction differs.

---

## ⚠️ "Read your project" IS the migrate-onboarding entry (sheet 2)

Existing work items imply an **existing project** — and a **git repo** — so this
node leads into **migrate-existing-codebase onboarding** (`MOTIR-815` / wizard
`MOTIR-930`). The node DRAWS the entry the migrate flow specifies (read TO the
spec, `MOTIR-930` `descriptionMd` — never invent it): **connect the git repo** +
**grant Motir AI read access**, with a **Connect GitHub** button (the `7.7`
connect surface, composed). The AI then **reads the project** (existing items +
code) and folds it into the tiers — the node's captured row shows
`Read 1,240 files · 86 work items`. This card draws the **node + the post-plan
linking**; the BUILD is the 7.15 flow (`MOTIR-815` / `MOTIR-930`), not a separate
7.3 subtask. Shown **only when** the project already has work items.

**Post-plan linking (sheet 3).** Once planning produces the backlog, an existing
work item is **LINKED into the tier tree** (attached under the tier / story it
informs — the violet **"Existing: User model · LINKED"** row under Epic 1), **or
left STANDALONE** when it is not reusable (the **"Legacy export job"** cluster,
off on its own with a `STANDALONE` chip). Part of the 7.15 migrate flow.

---

## Carried-over behaviours (still required) — and where each is drawn

| Behaviour                                       | Drawn on     | Source subtask it came from                                                                    |
| ----------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| Dependency **EDGES** (not just tree)            | sheet 3      | `MOTIR-1009`; engine variants from `PlanningCanvas` (`MOTIR-1236`)                             |
| **Cross-story** warning edge + flag             | sheet 3      | `MOTIR-1009` (the dependency-arrow audit — a tangle MEANS the plan is wrong)                   |
| **Search-to-locate-and-focus**                  | sheets 2,5   | `MOTIR-1009` (centre + highlight the match); `/` shortcut                                      |
| **Zoom in/out + fit / overview**                | all canvases | `PlanningCanvas` (`MOTIR-1236`) — `−` / `+` / `⤢` + the % readout (bottom-left)                |
| **Filters** (status / assignee / epic)          | sheet 5      | `MOTIR-1009`                                                                                   |
| **Empty / loading / error**                     | sheet 5      | `MOTIR-1009`; loading paints nodes only after positions resolve (no layout jump, `MOTIR-1253`) |
| **Large-tree** handling / density               | sheet 5      | reuse `PlanningCanvas` pan/zoom + windowing (`MOTIR-1236`) — engine not rebuilt                |
| **Board ↔ Roadmap** view toggle                 | sheet 1      | `MOTIR-1009`; the 7.19 access path (`MOTIR-1011`)                                              |
| **Node states** (done/active/deciding/upcoming) | sheet 4      | `MOTIR-1235` canvas-spatial; finding #35 (icon + label + tint)                                 |
| **Skippable (dotted) vs upcoming (dashed)**     | sheets 1,4   | `MOTIR-1009`; skip machine `MOTIR-838`, conductor `MOTIR-1099`                                 |
| **Captured-findings rows** on produced tiers    | sheets 1,2   | `MOTIR-1235` (StationCard); the conductor's per-tier output (`MOTIR-1099`)                     |
| Validation **deciding / blocking ask**          | sheet 4      | validate-demand-first `MOTIR-1064` (the one blocking ask)                                      |

---

## Primitives composed (no hand-rolling)

| Element                      | Built from                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| the canvas surface           | the shipped **`PlanningCanvas`** (`MOTIR-1236`) — viewport, dot-grid, `world` transform, read-only `<svg>` edges |
| node card                    | the shipped **`StationCard`** language — `Card` + tile + title/sub + state `Pill` + captured rows                |
| state pill                   | **`Pill`** tones — `reviewed` (mint), `here` (lavender), `deciding` (peach), `drafting` (lavender)               |
| "You are here" tab           | accent `Pill` + `map-pin`; node carries `aria-current="step"`                                                    |
| epic / story / subtask tree  | `Card` + the `--el-type-*` work-type hues + the connector language (sheet 3)                                     |
| view toggle / zoom / filters | `Button` group (segmented) · the canvas zoom control (`PlanningCanvas`) · `Pill`-style filter chips              |
| search field                 | `Input` (compact) + `search` glyph + a `/` `<kbd>`                                                               |
| empty / loading / error      | `Card` tints + `Button`; the spinner is `Spinner`                                                                |
| icons                        | lucide-react + the GitHub mark                                                                                   |

---

## Token / a11y discipline

- **Colour** strictly via **`--el-*`**; the mock inlines the real light-palette
  `--el-*` values (exactly as `canvas-spatial.mock.html` does). The **work-item
  type hues** are `--el-type-{epic,story,task,bug,subtask}`
  (`#ff64c8` / `#1aae39` / `#0075de` / `#e03131` / `#2a9d99`); type chips put the
  hue in a **tint background** with strong text (finding #35, AA). No Tier-0
  `--color-*` reached for content.
- **Shape** strictly via element-semantic tokens — node = `--radius-card`,
  chips/pills = `--radius-badge`, controls = `--radius-control`,
  shadow = `--shadow-{subtle,card}` — so a `[data-style]` swap re-shapes the
  canvas. `rounded-full` only on dots / the spinner.
- **Not colour alone** — every state pairs an **icon + label + tint**
  (`Reviewed ✓` · `You are here` map-pin · `Deciding` ⚠ · `Drafting now…`
  sparkles); the **skippable** affordance pairs the **dotted** border with a
  **"can skip"** chip, and **upcoming** the **dashed** border — so the dotted /
  dashed distinction never rests on line-style alone.
- **AA holds** — tint-background + strong-text chips by construction; the
  warning edge's flag badge uses peach tint + `#8a3d00` text.
- **A11y** — the canvas + chat are labelled regions (`role="application"`,
  `aria-label` — shipped on `PlanningCanvas`); nodes are keyboard-focusable;
  zoom / pan have keyboard equivalents (`+` / `−` / `0` / arrows — shipped);
  decorative icons are `aria-hidden`; the frontier node carries
  `aria-current="step"`; edges are `aria-hidden` (the dependency facts live in
  the node list).

## Deliverable

The three-file set under `design/roadmap/`: `design-notes.md` (this file) ·
`roadmap.mock.html` (source) · `roadmap.png` (export). Rendered with Playwright
chromium — full-page, light theme, `deviceScaleFactor: 2`, 1200px wide;
`prettier --check` clean.
