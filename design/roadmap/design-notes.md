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

## Asset set (the files)

| File                        | What it is                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `design-notes.md`           | this spec (primitives, copy, token roles, per-behaviour provenance)                                           |
| `roadmap.mock.html`         | the canvas source of truth — a multi-panel mock built from the real tokens                                    |
| `roadmap.png`               | the full-page export (Playwright chromium, light, `deviceScaleFactor 2`, 1200px)                              |
| `edges.mock.html`           | the dependency-edge spec (7.20.8 / MOTIR-1331) — arrows + legend + cross-story                                |
| `edges.png`                 | its full-page export (Playwright chromium, light, `deviceScaleFactor 2`, 1200px)                              |
| `grid-init.mock.html`       | grid + init arrangement (7.20.9 / MOTIR-1333) — grid system + the plan preview                                |
| `grid-init.png`             | its full-page export (Playwright chromium, light, `deviceScaleFactor 2`, 1200px)                              |
| `detail-surfaces.mock.html` | the canvas **detail surfaces** (MOTIR-1351): work-item quick-view + tier-doc viewer + their on-canvas entries |
| `detail-surfaces.png`       | the detail-surfaces export (same render settings)                                                             |

The `roadmap` mock is a **multi-panel review board** — six sheets (5 spec + the
multi-level drill-down sheet, below), every panel inspected (the multi-panel
rule, `notes.html` #31). The `detail-surfaces` mock is the
**[Canvas detail surfaces](#-canvas-detail-surfaces-the-quick-view--tier-doc-viewer-motir-1351)**
the canvas OPENS — documented in its own section below.

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

## ⭐ Dependency-edge LEGIBILITY (Subtask 7.20.8 / MOTIR-1331 — `edges.mock.html`)

The shipped per-level canvas (`MOTIR-1194`) drew the firm / pending / cross edges
but three things were illegible or unhandled. This section specifies them; the
build adds them to `PlanningCanvas`'s edge `<svg>` (still read-only, non-scaling
stroke). Drawn on **`edges.mock.html` sheets 1 (in-level) + 2 (cross-level)**.

### 1. DIRECTION — an arrowhead, one stated convention

Edges were undirected lines — you could not tell which item blocked which. Every
edge now carries an **arrowhead at its `to` end**, and the convention is fixed and
stated **everywhere**:

> **The arrow points from the BLOCKER to the item it blocks** — `A → B` reads
> "A blocks B / B can't start until A is done" (the unblocking flow). This matches
> the engine's `CanvasEdge.from = blocker`, `to = blocked`.

The arrowhead is an SVG `<marker>` (a filled triangle, `markerWidth ≈ 7`,
`orient="auto"`) **coloured to match its edge** — one marker per variant (firm =
`--el-border-strong`, pending = `--el-border`, cross = `--el-danger`) so the head
reads at a glance. It rides the shipped cubic-bezier connector; `vector-effect:
non-scaling-stroke` keeps it crisp at any zoom.

### 2. A LEGEND on the canvas (what the styles MEAN)

The canvas never told the reader what solid vs dashed meant. Add a small,
unobtrusive **edge legend** — a fixed overlay anchored **bottom-left** (the zoom
control already owns bottom-left in the engine; the legend sits beside it, or
bottom-left with zoom moved to bottom-right on this surface), `--el-surface` card,
`--radius-card`, `--shadow-card`. It lists each edge style with a **directional
swatch** + a plain-language meaning:

- **solid arrow → "blocks"** — _blocker is done (the dependency is settled / ready)_
- **dashed arrow ⟶ "pending"** — _blocker is not done yet_
- **red arrow → "cross-story"** — _blocker is in another story (a bad plan)_

(Header "Dependencies", `--el-text-faint` uppercase caption; rows
`--el-text-strong`, the meanings `--el-text-muted`.) It is the SAME three styles
the edges use, so the canvas is self-documenting.

### 3. CROSS-LEVEL / cross-story SIGNAL — the off-level blocker (the heart, sheet 2)

A badly-planned project can set a work item `blocked_by` an item on **another
level** (a different story / epic). The per-level read (`MOTIR-1010`) already
RETURNS that edge (its blocker id is off-level), but the canvas has no on-screen
node for the blocker — so it was dropped. It must instead read as the **bad-plan
TANGLE** the dependency-arrow audit forbids (a correct plan is a tree). Design:

- **A RED edge** (`--el-danger`, slightly heavier, solid) with the red arrowhead —
  visually distinct from the neutral in-level firm/pending.
- **A GHOST ANCHOR** for the off-level blocker (it has no node here): a small
  **dashed-red, hatched chip** that NAMES the blocker — its identifier (`PROD-42`,
  with an **↗ "leaves this level"** glyph), its title, and **where it lives**
  ("in Story · Auth hardening ↗", `--el-danger` text). The red edge runs from this
  anchor INTO the blocked node, so the tangle is legible without leaving the level.
- **A node BADGE** on the blocked item — a `cross-story` flag pill
  (`--el-danger-surface` tint + strong text + a flag glyph) + a red node ring — so
  even off-screen of the edge, the node reads as entangled (not colour-alone:
  icon + label + tint, AA).
- **States:** one vs several off-level blockers (the anchor stacks "+N more");
  **hover/tooltip** on the flag names the blocker + its level; **click** → drill to
  the blocker's level (the canvas already navigates per level). The normal
  (in-level, tree-shaped) case is unaffected — no anchor, no red.

**Build note.** The consumer's `loadLevel` already gets each level's edges; for an
edge whose blocker is NOT in the level's node set, emit a `cross` dep + a ghost
anchor node (id = the blocker, rendered as the anchor chip) so `PlanningCanvas`
draws the red edge to a real anchored target, and flag the blocked node. The
within-level firm/pending arrows are unchanged.

---

## ⭐ GRID system + INIT arrangement (Subtask 7.20.9 / MOTIR-1333 — `grid-init.mock.html`)

This **refines** the deterministic initial layout (below) into a real GRID, and
fixes what the init screen shows for a project that ALREADY has a planned tree.
Drawn on **`grid-init.mock.html` sheet 1 (the init screen) + 2 (the preview up
close)**.

### 1. A grid SYSTEM (not an ad-hoc serpentine)

Every node **initialises snapped to a fixed grid cell** — a reproducible,
tidy arrangement (the mock uses a **268 × 160** cell; the build keys it off the
node card width + a gutter). The grid is the INIT discipline only: the user can
still **drag freely**, and a saved position (the 7.3.77 persistence) overrides the
grid per node. The dot-grid the engine already paints stays; the cell guides are a
faint `#0000000a` overlay so the grid reads without shouting. The stations lay out
on the grid (idea → the four tiers → design → plan), `you-are-here` ringed,
upcoming dimmed — the serpentine below, but cell-snapped.

### 2. Init shows the WHOLE project on ONE screen — stations + the plan

At init (no saved layout) the canvas `fit`s so BOTH halves are visible at once:
the **pre-plan stations** (the journey) AND the **existing work items**. For a
project with no tree yet (fresh onboarding) the plan slot is just the `Plan` node;
once a tree exists, that node carries a **preview** (below). One screen, one
glance — "here's the journey, and here's the plan it produced."

### 3. The work items are fit PARTIALLY — a PREVIEW that says "there's a plan here" (Yue)

The init screen must NOT cram the whole tree on. The produced epics render as a
compact **plan-preview cluster** hung off the `Plan` station — a `--el-surface`
card (`--radius-card`, `--shadow-card`) with:

- a **header** — an epic-hued tile + **"Your plan"** + a summary line
  `10 epics · 142 work items · 58 done`, and an **"Explore the plan →"** primary
  button (`--el-accent`);
- a thin **progress bar** (done / total, `--el-success` fill over `--el-muted`);
- a **row of compact epic mini-cards** (the first ~4: an epic dot in `--el-type-epic`,
  the identifier mono-faint, the title 2-line-clamped, a tiny count "58 / 58 done"
  / "in progress"), capped by a dashed **"+ N more epics"** tile.

It reads as **"the plan exists and is explorable"**, not the full graph. **Clicking
an epic mini-card — or "Explore the plan" — DRILLS into the full per-level roadmap**
(epic → story → subtask, MOTIR-1194); the preview only ever reads the **epic roots**
(the per-level read, MOTIR-1010), so a 1000-item plan still inits instantly.

### Build note

The onboarding consumer already feeds `loadLevel(null)` = stations + the root
epics. For the init preview, the root level renders the stations + a SINGLE
`plan-preview` node (not the epics fanned out) that the consumer composes from the
roots read (count + the first N + the done/total rollup if available, else just
the count); its "Explore"/epic-click sets the canvas focus to drill. Snapping is a
pure grid function in the deterministic layout (`col·cellW, row·cellH`).

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
| **6** | Multi-level — **drill-down**     | the chain at every level: click a node → the canvas refreshes to that node's children as a chain; breadcrumb + Back (3 states drawn)                                   |

---

## ⚠️ MULTI-LEVEL CHAINS — DRILL-DOWN (decided, Yue 2026-06-22; sheet 6)

The planner orders same-level work as a **chain (DAG) at EVERY level** — epic↔epic, story↔story,
subtask↔subtask (`plan.md`'s dependency-arrow rule: "genuinely sequential work → a chain"). So the
roadmap renders the **story-level and subtask-level chains**, not only the epic level. (Sheet 3's
rows-inside-an-epic-card stay as a compact SUMMARY of an epic's contents; the navigable lower-level
**roadmaps** are this drill-down.)

**The model is DRILL-DOWN (self-similar).** Click a node and the canvas **REFRESHES to that node's
children**, laid out as their own chain; a breadcrumb (`Plan ▸ Invoices ▸ Create invoice`) + a
**Back** control walks you up. One level fills the screen at a time, so each chain stays big + legible
**at any tree size** — the completeness / scale axis. Zoom-to-fit still gives a whole-level overview.
Sheet 6 draws the three drill states (epic chain → story chain → subtask chain).

**Why drill-down** (the chosen model over expand-in-place and a level toggle): it is the only one that
stays legible on a real, large plan; it reuses the shipped `PlanningCanvas` engine cleanly (the **same
surface**, re-fed the per-level nodes + edges on drill — no new engine); and it EXTENDS, rather than
overturns, the already-decided spatial-canvas **"self-similar at every level"** direction. A
power-user expand-in-place could be added later as an affordance, but drill-down is the core model.

> Drill-down reuses the SAME node + edge language as sheets 1-5 (the shipped `StationCard` /
> `PlanningCanvas` languages, `--el-type-*` hues, neutral firm / dashed-pending edges + the cross-story
> warning edge) — only the per-level node + edge SET changes on drill. Build (`MOTIR-1194`): the
> consumer re-feeds the engine the children of the focused node + their same-level `blocked_by` edges,
> and tracks the breadcrumb path; the engine is unchanged.

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

---

## ⭐ Canvas detail surfaces — the quick-view + tier-doc viewer (MOTIR-1351)

`detail-surfaces.mock.html` designs the two DETAIL surfaces the roadmap canvas
**opens**, plus their on-canvas **entry affordances**. The card's mandate is to
**COMPOSE existing designs / components, not redraw them** — `notes.html`
**#82** (reuse the real shipped COMPONENT + its markup, never a stylized
stand-in) and **#95** (ground a composing design in the COMPONENT and its
CONTRACT — not an asset path or the parent story). So every element here is the
real shipped surface, annotated with the component it composes.

> **⚠️ Grounded in the SHIPPED canvas `ProjectRoadmapCanvas` (MOTIR-1194 / PR
> #1398) — two DISTINCT node interactions, do not conflate them:**
>
> 1. **SELECT (click a card) = HIGHLIGHT only.** `ProjectRoadmapCanvas` rings the
>    selected card (`--el-accent` + `--el-surface-soft` offset) and lights the
>    dependency it belongs to (its `connectedIds` — the node + everything it links
>    to). Selecting does **NOT** open a detail surface.
> 2. **A dedicated VIEW button opens the detail** — surfaced **on the selected
>    card**, the same bottom-edge action slot where the shipped **"Open ›" DRILL
>    pill** appears (the canvas renders that pill on a _selected drillable_ card).
>    This card ADDS a **View** button there: a work-item node's View opens the
>    quick-view (MOTIR-1352); a tier station's View opens the tier doc
>    (MOTIR-1355). A drillable selected node shows **both** View + Open ›;
>    `WorkItemNode` keeps its passive `ChevronRight` has-children hint.
>
> So: **select = highlight, View = open detail, Open › = drill.** (Two earlier
> drafts of this mock got the entry wrong — first a hover "Eye", then "selection
> itself opens the detail". Both wrong: selection only HIGHLIGHTS; a dedicated
> View button opens the surface. This is the #82/#95 trap — read the composed
> component's _interaction contract_ — `handleActivate` + `connectedIds` + the
> selected-card action pills — not just its markup.)

### Composed components + their contracts (notes #95)

| Composed thing     | Source (component / asset)                                                                         | Contract this design honours                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| canvas interaction | `ProjectRoadmapCanvas` (`components/planning/ProjectRoadmapCanvas.tsx`, MOTIR-1194)                | click SELECTS = highlight (`connectedIds` lit, rest dim); selected card surfaces action pills ("Open ›" drill shipped; **View** added here); per-level drill-down (MOTIR-1010) |
| canvas card        | `WorkItemNode` (`components/planning/WorkItemNode.tsx`, MOTIR-1194)                                | presentational; fixed `NODE_W 280 × NODE_H 148`; status chip top · tile + id/title body · passive drill `ChevronRight` hint                                                    |
| tier station       | `StationCard` (`components/onboarding/StationNode.tsx`, MOTIR-840)                                 | tier-coloured tile + title/sub + captured rows + state pill; per-tier accent from `TIER_META`                                                                                  |
| work-item peek     | `design/work-items/quick-view.mock.html` (Story 2.5 / 8.8)                                         | reused **1:1**; read-only; the one write path is **Open full page →**                                                                                                          |
| modal shell        | `Modal` (`components/ui/Modal.tsx`)                                                                | `size="xl"` peek shell, `srTitle` (the body owns its heading), X close, `data-surface="modal"`                                                                                 |
| tier-doc render    | `DirectionDocView` (`components/onboarding/DirectionDocView.tsx`, MOTIR-834) + `direction-doc.css` | READ-ONLY editorial render; props `{ doc, availableDocs, onNavigate }`; accent via `--dd-accent`                                                                               |

### The five panels (`detail-surfaces.mock.html`)

| Panel | Surface                | What it draws                                                                                                                                                                                                                              |
| ----- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1** | Quick-view **entry**   | a **SELECTED** `WorkItemNode` (accent ring) with its connection lit (select = highlight); the selected card's **View** button opens the peek, beside the shipped **"Open ›"** drill pill on a drillable node (a leaf shows **View** alone) |
| **2** | Quick-view **peek**    | the shipped `quick-view` modal (Modal `size="xl"` + the two-column head/main/rail body), reused **verbatim** to confirm the entry → peek wiring                                                                                            |
| **3** | Tier-doc **entry**     | the 4 tier **stations** (`StationCard`) on the canvas; a **SELECTED** station (accent ring) surfaces a **View** button → opens the doc; only PRODUCED tiers carry it                                                                       |
| **4** | Tier-doc **modal**     | the **same** `Modal` shell rendering `DirectionDocView` inside; thin head carries **Open full page**; discovery accent `--el-info`                                                                                                         |
| **5** | Tier-doc **full page** | the read-only route `/projects/[key]/direction/[tier]` (NEW — no shipped route yet) — app shell + **← Back to roadmap** + breadcrumb; `DirectionDocView` at full reading width                                                             |

### Access paths (DRAW THE DOOR — `run.md` design gate)

- **Quick-view:** **select** a work-item node on the canvas (highlights it) →
  click the **View** button on the selected card (panel 1) → peek modal (panel 2)
  → **Open full page** → the work item's `/items/[key]` detail page. **View**
  (open peek) is DISTINCT from the **"Open ›" drill** pill (drillable nodes,
  MOTIR-1010) — both sit on the selected card.
- **Tier-doc:** **select** a produced tier station (highlights it) → click its
  **View** button (panel 3) → tier-doc modal (panel 4) → **Open full page** →
  `/projects/[key]/direction/[tier]` (panel 5) → **← Back to roadmap** returns to
  the canvas.

### New decisions this card makes (resolved from the decision ladder, not asked)

- **A dedicated VIEW button is the entry; selection only highlights.** In the
  shipped `ProjectRoadmapCanvas` (PR #1398), clicking a card SELECTS it = rings it
  and highlights the dependency it's part of (`connectedIds` lit); selection does
  **not** open anything. So the detail surface
  needs its own affordance: this design adds a **View** button on the selected
  card, in the same bottom-edge action slot the shipped **"Open ›"** drill pill
  uses. The builds add it: MOTIR-1352 adds View → quick-view on the work-item
  node; MOTIR-1355 adds View → tier doc on the station. View (open) and Open ›
  (drill) are distinct; a leaf shows View alone. (The onboarding consumer today
  opens a station's doc on bare select; this design refines that to the explicit
  View action so the on-canvas roadmap reads consistently — select highlights,
  View opens.)
- **The tier-doc FULL-PAGE route is NEW** (`/projects/[key]/direction/[tier]`).
  `DirectionDocView` is shipped but rendered in **no app route** today (only the
  onboarding gate embeds it, and PR #1398 renders it only inside the canvas). The
  MOTIR-1355 build adds the route; this design fixes its layout (app shell +
  back/breadcrumb + centred doc, read-only).
- Both surfaces stay **read-only** — the chat is the only edit path (the
  conversation-only model, MOTIR-1100); there is no inline-edit affordance.

### Token / a11y discipline (same rules as the canvas)

- **Colour** via `--el-*` only (inlined light palette, as `quick-view.mock.html`
  does). Status pills + tier tiles put the hue in a **tint background** with
  `--el-text-strong` (AA, finding #35); the selection ring is `--el-accent` with
  an `--el-surface-soft` offset (the shipped `ring-offset`). Tier accents:
  discovery `--el-info`, vision `--el-accent-on-surface`, feasibility
  `--el-success`, validation `--el-warning`; per-tier station tiles use
  `--el-station-tier-*`. Work-item kind tiles use `--el-type-*`.
- **Shape** via element-semantic tokens: card/modal/doc-table = `--radius-card`
  / `--radius-modal`; pills/chips = `--radius-badge`; close/menu rows =
  `--radius-control`; buttons + the "Open ›" drill pill = `--radius-btn`;
  elevation `--shadow-{subtle,card,modal}`. `--radius-pill` only on dots /
  avatars.
- **A11y** — selection is keyboard-reachable on the shipped canvas; the **View**
  and shipped **"Open ›"** drill buttons are labelled `button`s ("View
  &lt;identifier&gt;" / "Open this item's children"); the modal is the shipped
  `Modal` (Radix focus-trap, ESC, `srTitle`); `DirectionDocView` keeps its
  `aria-label` (tier label) + read-only hint; decorative icons `aria-hidden`; the
  full page leads with a back
  affordance + breadcrumb.

---

## ⭐ Scope toggle + sprint-scoped states (MOTIR-1380 / Story MOTIR-1379 — `scope-toggle.mock.html`)

`scope-toggle.mock.html` adds a header **scope control** that switches the SAME
roadmap canvas between **the whole project** (default) and **the active sprint**.
The card's mandate is to **COMPOSE the shipped canvas, not redraw it** (`notes.html`
**#82**/**#95**): the canvas (`ProjectRoadmapCanvas`, MOTIR-1194; design MOTIR-1009
/ `roadmap.mock.html`) is reused UNCHANGED — same node treatment, drill, edges,
zoom, and "you are here" overlay. The only NEW pixels are the toggle, the
per-scope subtitle, the no-active-sprint empty state, and the narrowed root-level
**node set** (the topmost in-sprint items). The behaviour the toggle depicts is defined
by the backend read subtask (the sprint-scoped read re-rooted at the TOPMOST
in-sprint items, MOTIR-1381), which this card `relates_to` and grounds in (not
invented here).

### Composed components + their contracts (notes #95)

| Composed thing | Source                                                     | Contract this design honours                                                                                                                                                                                                                                                                         |
| -------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| scope toggle   | `Segmented` (`components/ui/Segmented.tsx`, Subtask 3.3.5) | labelled `role="group"`; each option a real `<button aria-pressed>`; `--el-tabnav-track` track, active = `--el-page-bg` + `--shadow-subtle` raised fill, leading glyph takes `--el-tabnav-active`                                                                                                    |
| canvas + nodes | `ProjectRoadmapCanvas` / `WorkItemNode` (MOTIR-1194)       | reused unchanged; status pill · `--el-type-*` kind tile · id/title · subtree progress meter (`--el-success` fill on `--el-muted` track) · passive drill `ChevronRight`; only the root-level FED node set changes (re-rooted at the topmost members) — meters/drill are the normal full-subtree reads |
| empty state    | `EmptyState` (`components/ui/EmptyState.tsx`)              | `Card` + centred icon (`--el-icon-muted`) + serif title + `--el-text-subtitle` description; the no-active-sprint case                                                                                                                                                                                |
| page header    | `app/(authed)/roadmap/page.tsx` `<header>` (MOTIR-1011)    | serif `text-2xl` `<h1>` + `--el-text-muted` subtitle; the toggle is added to this header by the frontend's client wrapper (MOTIR-1382)                                                                                                                                                               |

### The four panels (`scope-toggle.mock.html`)

| Panel | Scope/state             | What it draws                                                                                                                                                                                                                                                                                                                                                                |
| ----- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | Whole project (default) | header with the `Segmented` toggle (**Whole project** selected) + the project subtitle; the full root level (every epic), whole-subtree meters (Epic 7 → `12 / 40`)                                                                                                                                                                                                          |
| **2** | Active sprint           | toggle flipped to **Active sprint**; subtitle = sprint name + goal + a quiet **Sprint scope** chip; the canvas RE-ROOTED at the topmost in-sprint items — a member story + the in-sprint subtask of a non-member story show as roots, the epics + non-member ancestors elided; below a root the tree is the normal unscoped read (a root story's meter is its whole subtree) |
| **3** | No active sprint        | toggle on **Active sprint** but no sprint running → an in-canvas `EmptyState` (**Goal** icon, **"No active sprint"**, a one-line hint); the toggle stays available, Whole-project scope unaffected                                                                                                                                                                           |
| **4** | Control + access path   | the `Segmented` toggle states (default / hover / sprint-active) + the **Roadmap** primary left-nav entry the page is reached from (MOTIR-1011)                                                                                                                                                                                                                               |

### Sprint-scope dependency signal — "not in sprint", not "cross-story" (MOTIR-1379)

The roadmap's off-level dependency signal (MOTIR-1331) MEANS something different in
sprint scope, so it is RE-LABELLED. In **project** scope a `blocked_by` edge to an
item on another level is the **cross-story tangle** (a bad plan — the red edge, the
ghost anchor "in {story} ↗", and the node's red **cross-story** flag). In **sprint**
scope the same edges become a **sprint-validity** signal (mirroring the MCP
`validate_sprint` rule): a blocker is a problem ONLY when it is **not done AND not in
the active sprint**. So:

- a **done** dependency, or one **already in the sprint**, is SATISFIED → it is NOT
  drawn (no edge, no anchor, no flag) — the sprint view stays focused on real risks;
- an **out-of-sprint, open** dependency is the problem → the red edge + a ghost
  anchor reading **"not in this sprint ↗"** + the node's red flag **"not in sprint"**;
- the edge **legend**'s warning row reads **"not in sprint" — "not done & outside the
  sprint"** (vs. project scope's "cross-story" — "in another story").

This fixes the mis-label where two items in the SAME story showed as "cross-story"
in sprint scope (they are siblings, not cross-story — the real issue is only whether
the open dependency is inside the sprint). Same red `--el-danger` / `--el-warning`
tokens; only the copy changes.

### Exact copy (the labels + strings the frontend ships — MOTIR-1382 `messages/en.json`)

- **Toggle option labels:** `Whole project` (default, selected) · `Active sprint`.
  (Distinct enough to avoid the getByRole superstring pitfall, `notes.html`
  aria-selector entries — neither is a substring of the other.)
- **Whole-project subtitle:** the existing `roadmap.subtitle` — `{project}'s roadmap`.
- **Active-sprint subtitle:** the sprint's **name** + goal — e.g. `Sprint 32 · Three Epic-7 stories`;
  the trailing **Sprint scope** chip marks the canvas as scoped.
- **No-active-sprint empty state:** title `No active sprint`; description
  `This project has no sprint running right now. Start a sprint from the board to see its slice of the roadmap, or switch back to Whole project.`

### Access path (DRAW THE DOOR — `run.md` design gate)

The Roadmap page is reached from the shipped **Roadmap** primary left-nav entry
(MOTIR-1011, panel 4) — there is **no new route or nav affordance**. The scope
toggle lives **in that page's header**, right-aligned beside the title/subtitle
(panels 1–3 draw it in place at the page's real width above the canvas).

### Token / a11y discipline (same rules as the canvas)

- **Colour** via `--el-*` only (light palette inlined, as the sibling mocks do).
  The Segmented track is `--el-tabnav-track` / `--el-border`; the active option is
  the raised `--el-page-bg` fill + `--shadow-subtle` with `--el-text-strong` text
  and the `--el-tabnav-active` glyph; inactive options are `--el-text-secondary`.
  The **Sprint scope** chip puts the hue in a `--el-tint-lavender` background with
  `--el-text-strong` text (AA, finding #35) and an `--el-accent-on-surface` glyph;
  never a page-level tint. Node status pills / kind tiles / progress meters are the
  shipped `WorkItemNode` tokens, unchanged.
- **Shape** via element-semantic tokens: the Segmented track = `--radius-btn`, each
  option = `calc(--radius-btn - 2px)` (nests in the track at any style) sized by
  `--height-control` + `--spacing-control-x`; the scope chip = `--radius-badge`;
  cards/canvas = `--radius-card`; elevation `--shadow-{subtle,card}`. No raw
  `rounded-*`/`p-*`/`h-*`.
- **A11y** — the toggle is the shipped `Segmented`: a labelled `role="group"` whose
  options are keyboard-operable `<button aria-pressed>`s announced as toggles; the
  selected scope carries `aria-pressed="true"`. The no-active-sprint surface is the
  shipped `EmptyState` (`Card` + heading + description); decorative icons are
  `aria-hidden`. Switching scope is a client-island refetch (the canvas reload),
  not a `router.refresh()` (the page-state contract; MOTIR-1382).

---

## ⭐ Ready-to-start highlight (MOTIR-1416 / Story MOTIR-1415 — `ready-highlight.mock.html`)

`ready-highlight.mock.html` adds a quiet highlight marking a roadmap node that is
**ready to start** — not yet started/done, and every item it is `blocked_by` is done
(no open blocker; the shipped `ReadinessDto.ready` / dispatch-ready set). It makes the
actionable FRONTIER obvious. COMPOSES the shipped `WorkItemNode` (MOTIR-1194,
`notes.html` #82/#95) — the card, status pill, kind tile, identifier/title, drill
chevron and "you are here" pill are the real shipped structure; only the ready
treatment is new. Works in BOTH project and sprint scope (the readiness rule is
scope-independent).

### The treatment (two parts, both `--el-success`)

1. **The "Ready" pill** — in the status slot, REPLACING the dim "To do" pill (a ready
   item IS a to-do whose blockers are all done, so "Ready" is the informative label).
   `--el-tint-mint` background + `--el-text-strong` text (AA, finding #35) + a
   `CirclePlay` glyph in `--el-success`.
2. **A success LEFT accent bar** — a 3px `--el-success` inset bar
   (`box-shadow: inset 3px 0 0`, respecting `--radius-card`) so a ready node is
   scannable across a dense canvas at zoom — WITHOUT a full border that would read
   like the accent "you are here" frame.

### Distinct from the existing node affordances (the AC)

The ready highlight fires on **exactly one** node state — a startable, unblocked item —
and is deliberately distinct from each existing signal by **hue + shape**:

| Signal          | Treatment                                  | Hue             |
| --------------- | ------------------------------------------ | --------------- |
| **Ready** (new) | "Ready" pill + 3px left accent bar         | `--el-success`  |
| "You are here"  | accent BORDER + accent map-pin pill        | `--el-accent`   |
| dependency flag | red chip ("cross-story" / "not in sprint") | `--el-danger`   |
| status pill     | tinted chip (To do / In progress / Done)   | per-status tint |

An in-progress or done node is NOT ready (already started/finished); a to-do with an
open blocker is NOT ready (the dim "To do" pill stays). The mock's panel 1 shows the
ready node beside all four non-ready states; panel 2 is the anatomy.

### Exact copy + tokens

- **Pill label:** `Ready`; glyph `CirclePlay` (`--el-success`).
- **Colour:** `--el-tint-mint` / `--el-text-strong` / `--el-success` only (no Tier-0
  `--color-*`). **Shape:** `--radius-badge` (pill) + `--radius-card` (the card the
  inset bar rides). No raw `rounded-*` / `p-*`.
- The code subtask (MOTIR-1417) renders this when the per-level roadmap read returns
  `ready: true` for a node (and the node is not the "you are here" / done state).

---

## ⭐ Full-screen mode (MOTIR-1423 / Story MOTIR-1420 — `full-screen.mock.html`)

`full-screen.mock.html` adds a **full-screen** affordance to the roadmap canvas: an
**Expand** button takes the canvas to full screen so a viewer can use the whole
display for a large tree; **ESC exits**. COMPOSES the shipped canvas + overlay chrome
(`ProjectRoadmapCanvas` / `PlanningCanvas`, MOTIR-1194) — the breadcrumb (top-left),
search (top-right), and the zoom + fit-view cluster (bottom-left) are the real shipped
controls; only the Expand/Exit button + the ESC hint are new (`notes.html` #82/#95).

### The control

- **Placement:** the Expand button joins the **top-right** cluster, beside the shipped
  search — an `--el-surface` icon button (`--radius-btn`, `--shadow-card`) the size of
  the other overlay controls (`--height-control`).
- **Glyph + label:** **Maximize** (corner brackets) — deliberately UNLIKE the
  bottom-left **fit-view** control's `Maximize2` (diagonal arrows), which only resets
  zoom. Accessible name **"Enter full screen"**.
- **Full-screen state:** the button flips to **Minimize** (accessible name **"Exit full
  screen"**) and a quiet **"Press `Esc` to exit full screen"** hint chip appears
  top-centre (a `<kbd>` on `--el-muted` / `--radius-kbd`). The other overlay controls
  stay reachable; pan / zoom / drill keep working.

### Behaviour (the code subtask, MOTIR-1424, decides + verifies)

The browser **Fullscreen API** on the canvas container is the preferred approach — the
OS chrome hides and **ESC exit is native** — with a `fullscreenchange` listener syncing
the button state; a fixed full-viewport overlay + a manual `keydown` Escape handler is
the fallback if the Fullscreen API doesn't compose with the app shell. Works in both
project and sprint scope.

### Token / a11y discipline

Colour via `--el-*` only; shape via `--radius-btn` (the button) / `--radius-kbd` (the
hint) / `--radius-control` (the overlay icon buttons) — no Tier-0 `--color-*` or raw
`rounded-*`. The Expand/Exit button is a labelled `<button>` (icon-only → `aria-label`);
decorative glyphs are `aria-hidden`. The two panels (embedded + full screen) are in the
mock.

---

## ⭐ Locate control (MOTIR-1427 / Story MOTIR-1421 — `locate.mock.html`)

`locate.mock.html` adds a **Locate** affordance to the roadmap canvas: a button that
**recentres the viewport on the actionable node** so a viewer never has to hunt for where
to work next. COMPOSES the shipped canvas + overlay chrome (`ProjectRoadmapCanvas` /
`PlanningCanvas`, MOTIR-1194) — the breadcrumb (top-left), search + Expand (top-right,
MOTIR-1420), and the zoom + fit-view cluster (bottom-left) are the real shipped controls;
only the Locate button + its position hint are new.

### What it targets

- **Priority — the "you are here" frontier first.** If the level has the in-progress
  current-position node (MOTIR-1013), Locate centres + highlights THAT (a single
  destination — no cycling).
- **Otherwise the READY nodes** (the mint "Ready" highlight, `RoadmapNodeDto.ready`,
  MOTIR-1417). With **multiple ready nodes**, repeated clicks **cycle** to the next ready
  node in a stable order and **wrap** to the first after the last.
- **Disabled** when there is NEITHER a frontier NOR a ready node on the level.

### The control

- **Placement:** the Locate button joins the **bottom-left** cluster, beside the shipped
  zoom + fit-view (it is a viewport-navigation control, so it lives with them) — an
  `--el-surface` icon button (`--radius-btn`, `--shadow-card`, `--height-control`).
- **Glyph + label:** **LocateFixed** (a crosshair), deliberately UNLIKE the `Maximize` /
  `Maximize2` of Expand + fit-view. Accessible name **"Locate the current item"** (or
  **"Locate the next ready item"** in the cycling state).
- **Cycling signal:** when there is more than one ready node, a quiet **"n of m"** position
  hint chip (`--el-surface`, `--radius-badge`, mono) sits beside the button so the cycle
  reads. The centred node carries the **accent focus ring** (the `data-highlighted`
  treatment the `/`-search locate already applies — so locate visually marks AND is
  assertable on the same attribute).
- **Disabled state:** `aria-disabled`, faint `--el-text-faint`, with a tooltip
  ("Nothing to locate — no in-progress or ready item on this level.").

### Behaviour (the code subtask, MOTIR-1428, builds it)

Pure-client: targets are read from the CURRENT level's already-loaded nodes (the active
frontier + the `ready` flags), so no new fetch. Centring reuses the shipped pan-to-node
machinery — set the focused id + bump `focusNonce` so `PlanningCanvas` recentres, and set
the highlight so the node lights up. The cycle cursor is a ref over the ordered ready-id
list, **reset when the level changes**. Gated behind a `locatable` prop the work-item
roadmap passes (like `fullScreenable`, MOTIR-1420); the onboarding canvas — which has no
work-item frontier / ready flags — does not show it.

### Token / a11y discipline

Colour via `--el-*` only (the accent ring for the located node; mint for Ready;
lavender for the frontier pill); shape via `--radius-btn` (button) / `--radius-control`
(overlay icon buttons) / `--radius-badge` (the hint chip) — no Tier-0 `--color-*` or raw
`rounded-*`. The Locate button is a labelled `<button>` (icon-only → `aria-label`);
decorative glyphs are `aria-hidden`. The three panels (frontier · ready-cycling ·
disabled) are in the mock.

---

## ⭐ Done & ready card styles (MOTIR-1434 / Story MOTIR-1422 — `done-ready.mock.html`)

`done-ready.mock.html` restyles TWO node states of the roadmap `WorkItemNode` (MOTIR-1194)
so each reads at a glance AND **when zoomed out**, and the two are **clearly distinct** from
each other (and from the accent "you are here" + the red blocked flag). COMPOSES the shipped
node — does NOT redraw it.

### The problem it fixes

Ready shipped (MOTIR-1417) as a `--el-success` **3px left bar** — a hairline that all but
disappears when the canvas is zoomed out, AND the same success-green a done border would use,
so done & ready would read identically. So BOTH signals move **into the card body**, where a
fill survives scale and the two can diverge.

### The two treatments

- **Ready (reworked):** the whole card fills with `--el-tint-mint` (was the 3px
  `--el-success` left bar) + the "Ready" pill (`CirclePlay`, `--el-success` icon) stays. The
  title goes `--el-text-strong` for AA on the tint. A ready node now **glows mint** at any zoom.
- **Done (new):** the card **sinks into the board** — it takes the recessed `--el-canvas`
  fill (clearly darker/greyer than the raised white todo card) with a defined
  `--el-border-strong` edge + a flat `--shadow-subtle` so it reads as settled-back, plus a
  **struck**, `--el-text-muted` title and a **solid dark "Done" stamp** (`bg --el-text-secondary` /
  `text --el-text-inverted` + a `Check`). The stamp is deliberately **NOT success-green** (so it
  can't be mistaken for ready) AND far heavier than the light `--el-muted` "To do" chip (so done
  can't be mistaken for **todo** — the redo fixed a too-similar pair). The board-coloured fill is
  the zoom-out signal.
- **Mint-forward (ready) vs board-recessed (done)** is a value contrast that holds at any zoom;
  the dark "Done" stamp vs the light "To do" chip separates done from todo.

### Precedence + boundaries

Done and ready never co-apply to one node; the accent **"you are here"** frontier (MOTIR-1013)
still wins, and the red **cross-blocked / not-in-sprint** flag is louder than both. The data is
already shipped: `RoadmapNodeDto.isDone` (own done-ness) + `RoadmapNodeDto.ready` (MOTIR-1417) —
so the code subtask only plumbs `isDone` like `ready` and restyles; no backend change.

### Token / a11y discipline

Colour via `--el-*` only — **done avoids `--el-success`** (ready's hue); the mint tint carries
`--el-text-strong` for AA. Shape via `--radius-card` / `--radius-badge` / `--radius-control` — no
Tier-0 `--color-*` or raw `rounded-*`. The two panels (the four states at 1× · a zoomed-out
before/after) are in the mock.

---

## Deliverable

Seven three-file surfaces under `design/roadmap/`, sharing this `design-notes.md`:

- **Canvas** — `roadmap.mock.html` + `roadmap.png` (MOTIR-1009).
- **Detail surfaces** — `detail-surfaces.mock.html` + `detail-surfaces.png`
  (MOTIR-1351).
- **Scope toggle** — `scope-toggle.mock.html` + `scope-toggle.png` (MOTIR-1380).
- **Ready highlight** — `ready-highlight.mock.html` + `ready-highlight.png`
  (MOTIR-1416).
- **Full-screen** — `full-screen.mock.html` + `full-screen.png` (MOTIR-1423).
- **Locate control** — `locate.mock.html` + `locate.png` (MOTIR-1427).
- **Done & ready styles** — `done-ready.mock.html` + `done-ready.png` (MOTIR-1434).

All rendered with Playwright chromium — full-page, light theme,
`deviceScaleFactor: 2`, ~1200px wide; `prettier --check` clean.
