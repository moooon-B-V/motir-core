# `design/ai-planning/` — design notes

This area holds the surfaces where a person reviews what Motir's planner PROPOSES.

| Surface                                      | Files                                                     | Card                 | Section   |
| -------------------------------------------- | --------------------------------------------------------- | -------------------- | --------- |
| The Plans surface                            | `plans-surface.mock.html` + `.png`                        | MOTIR-843 (7.4.1)    | Part I    |
| AI **sprint** planning                       | `sprint-planning.mock.html` + `.png`                      | MOTIR-1749 (7.13.11) | Part II   |
| **Who authored a plan**                      | `plans-surface.mock.html` (panel A2) + `.png`             | MOTIR-2985           | Part III  |
| **The status tag's place**                   | `plans-surface.mock.html` (the header gallery) + `.png`   | MOTIR-3074           | Part IV   |
| A proposal on its parent's **roadmap level** | `plans-surface.mock.html` (panel E) + `.png`              | MOTIR-3082           | Part V    |
| A proposal **READ view**                     | `plans-surface.mock.html` (panel F) + `.png`              | MOTIR-3082           | Part V    |
| A **decided** plan's node treatments         | `plans-surface.mock.html` (panel G) + `.png`              | MOTIR-3159           | Part VI   |
| What the pane holds **after approve**        | `plans-surface.mock.html` (panel H) + `.png`              | MOTIR-3159           | Part VI   |
| The Plans list **tabbed by status**          | **`plans-tabbed-list.mock.html`** + `.png`                | MOTIR-3233           | Part VII  |
| The plan detail's **List ↔ Canvas** switcher | **`plan-detail-list-view.mock.html`** + `.png`            | MOTIR-3234           | Part VIII |
| What a **generating** plan offers            | **`plan-detail-list-view.mock.html`** (panel 4) + `.png`  | MOTIR-3234           | Part VIII |
| The plan canvas **at arrival**               | **`plan-canvas-arrival.mock.html`** + `.png`              | MOTIR-3259           | Part IX   |
| **Show changes** on the plan canvas          | **`plan-canvas-arrival.mock.html`** (panels 3–4) + `.png` | MOTIR-3259           | Part IX   |

Both review the same way — nothing is real until approve, and the approve CTA names what it
will create. Part II mirrors Part I's grammar deliberately; it does not invent a second one.
Part III **amends Part I's asset in place** — it adds one meta entry, carrying the plan's REQUESTER
and its AUTHOR, to a shipped row and a shipped header, and redraws nothing.
Part IV amends the same asset again, and is the one place either amendment MOVES a shipped
element: the review rail's status tag leaves the title's line for its own.

## ⚠️ A design result is a MOMENT — a new surface gets a NEW asset (Yue, 2026-08-20)

**Parts III–VI amended `plans-surface.mock.html` IN PLACE and re-exported its PNG each time. Part
VII stops doing that, and the earlier Parts are not a precedent to follow.**

A design asset records the moment it was drawn, the way a commit does. Amending it for every later
surface has three costs, and the third is the one that matters:

1. **The export stops being reviewable.** By Part VI the board was 14 950px tall; adding one panel
   took it past 20 000. The design RESULT published onto the card — the thing a reviewer actually
   opens — was then fifteen screens of already-approved work with the new surface somewhere inside
   it. _"I only need to see the new tabbed list design."_
2. **Every amendment re-exports pixels nobody changed.** A binary diff of a 20 000px PNG says
   nothing about what moved, so the one guard that could catch an accidental change to an older
   panel cannot.
3. **It reads as though the old design were still current.** It is not: `plans-surface.mock.html`
   is what MOTIR-843 / 2985 / 3074 / 3082 / 3159 decided, on the days they decided it, and the
   product has moved since. Re-exporting it every time quietly claims otherwise.

**So: a NEW surface gets a NEW `<surface>.mock.html` + `.png`, and the older assets are left
frozen.** What stays shared is `design-notes.md` — one per area, indexing that area's surfaces, and
the right home for a decision that AMENDS an earlier Part's rule (§3 below reverses Part III §3;
the reversal belongs in the notes precisely because the asset it corrects is frozen).

Where a new asset reproduces rows or elements from an older one so the two are diffable, it says so
and cites the file — it does not re-render the original.

**This does NOT retroactively re-cut Parts III–VI.** Those panels stay where they are; splitting
them now would re-export the very asset this rule exists to leave alone.

**Part V amends it again** — two panels on the plan DETAIL surface: a proposal drawn on its
parent's roadmap LEVEL (nothing new — the shipped drill-down, with only the proposed card's style
differing), and a read view for one proposal composing the shipped quick view.

**Part IX gets its own asset too** — `plan-canvas-arrival.mock.html` decides the canvas's
BEHAVIOUR where Part VIII decided the pane's bodies: which level it arrives at, the breadcrumb crumb
for a parent that does not exist yet, and a **Show changes** control. It also carries the conditional
DEFAULT-VIEW rule Part VIII defers to it, and RELEASES the pane-header slot Part VIII reserved.

**Part VIII gets its own asset too** — `plan-detail-list-view.mock.html` gives the canvas pane a
header, a **List ↔ Canvas** switcher and a second body (a list of what the plan proposes) beside the
first, and draws the door for the discard valve MOTIR-3189 opened and nothing could reach. It
decides everything about the switcher EXCEPT which option is preselected, which is Part IX's
conditional rule.

**Part VII is the first Part with its OWN asset, and the first to REVERSE a rule this area
records.** `plans-tabbed-list.mock.html` tabs the list by status, draws the two different
emptinesses tabs create, restores the requester to a decided row beside the decider Part III kept
(and nobody ever built), and takes the page header's duplicate Plan-with-AI pill away.
**It does not amend `plans-surface.mock.html`** — see _A design result is a MOMENT_ below.

**Part VI amends it once more, and is the first Part to draw the state AFTER the decision** — the
accepted / declined node treatments (a fourth axis CROSSING the three `op` languages, not a fourth
member of them), and the answer to what the canvas pane holds once a plan is approved. That second
half re-opens a shipped decision on the record: MOTIR-1775 / MOTIR-1782 decided the establish step
REPLACES the canvas; Part VI §4 decides it STACKS above it, and says why.

---

# Part I — The Plans surface — design notes (MOTIR-843 / 7.4.1)

> **This design COMPOSES four already-shipped surfaces and adds ONLY the Plans-substrate
> chrome.** It is NOT a bespoke tree editor and NOT a re-draw of the planning canvas, its
> edges, zoom, search, drill-down, or the canvas+chat review. Per `notes.html` mistake **#82**
> ("a design that COMPOSES an already-designed sub-surface must ground in that sub-surface's
> shipped asset and say so — a design whose prose reads as re-drawing a pane another done
> design owns will be built twice") and **#64** (a design that changes only the chrome, not the
> interaction model, must reuse the shipped model), the only new pixels here are the
> Plans-substrate chrome listed in §3.

## 1. The four shipped references this composes (cited per the acceptance criteria)

The card names these with their planning aliases; the **real shipped assets / components** are
the ground truth (rung 2 — shipped reality outranks card prose). All four were read on disk in
PR **#1398** (MOTIR-1194, the canvas implementation, in review) and on `main`:

| Card alias                                                                                 | Real shipped asset / component                                                                                                | What it owns — NOT re-drawn here                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-1193** — "the canvas+chat workspace shell" (`design/ai-chat/planning-workspace.*`) | `design/ai-chat/canvas-spatial.*` + `onboarding.*`                                                                            | The ONE shared planning interface: canvas-left + chat-rail-right, the on-canvas one-by-one proposed placement, confirm-to-persist. **Generation-review is a MODE of this shell.**                                                               |
| **MOTIR-1009** — "the standalone canvas DESIGN"                                            | `design/roadmap/` (`roadmap.mock.html`, `edges.mock.html`, `grid-init.mock.html`)                                             | The tree (epic→story→subtask), within-story vs cross-story dependency edges, zoom / zoom-to-fit, search-to-focus, drill-down, virtualization, node / empty / loading states, the on-canvas dependency legend + cross-story ghost-anchor signal. |
| **MOTIR-1194** — "the canvas COMPONENT (`WorkItemCanvas`)"                                 | `components/planning/ProjectRoadmapCanvas.tsx` + `PlanningCanvas.tsx` + `WorkItemNode.tsx` + `PlanPreview.tsx` (PR **#1398**) | The **presentational** canvas: fed forest + edges as DATA, owns no fetching. The plan detail FEEDS it the plan's `PlanItem`s as data — the proposed tree is just another data input to the same canvas, NOT a second canvas.                    |
| **MOTIR-1010** — "the per-level READ"                                                      | the per-level roadmap read (`app/api/projects/[key]/roadmap/route.ts` + `lib/planning/projectCanvasModel.ts`, PR **#1398**)   | The canvas is per-level **DRILL-DOWN, not whole-tree** (finding #91). The proposed tree renders PER LEVEL (drill epic→story→subtask); a `modify`/`remove` diff overlays the EXISTING per-level committed tree with the plan's changes on top.   |

**This design does NOT redesign the canvas, the canvas+chat review, the dependency edges, zoom,
search, or drill-down.** Those ship from 1009/1194/1010 and are mounted as-is. Where this doc
shows the canvas, it embeds the **real shipped markup** from `design/roadmap/` and the
`ProjectRoadmapCanvas` / `WorkItemNode` / `PlanPreview` components — not a stylized stand-in (the
MOTIR-1196 / 7.2.1 lesson: show/reuse the real shipped UI, never a redrawn copy).

## 2. The model this renders (Story 7.21 — the Plan substrate, MOTIR-1336/1337)

A **`Plan`** is a reviewable bundle of proposed **`PlanItem`** operations. Nothing is real until
**approve**; on approve the PlanItems **materialize**. There is **NO `proposed` WorkItem status**
and **NO "Discard"** — proposals never enter the tree, ready-set, board, or dispatch.

- **`Plan.status`**: `generating → planned → approved | declined`.
- **History surface** = the lifecycle timestamps + actor: `createdAt`, `plannedAt` (generation
  done), `decidedAt` + `decidedById` (approve/decline). These ARE the history timeline (no
  separate event log needed).
- **`PlanItem.op`**: `add | modify | remove`.
  - **`add`** — proposed new node; lives ONLY as a PlanItem (`workItemId` null, fields in
    `proposedFields`) until approve → create the WorkItem.
  - **`modify`** — the EXISTING target untouched; `patch` holds the sparse changed fields +
    `baseRevision`. Approve → apply patch to the **same id** (a logged revision, not a ghost copy).
  - **`remove`** — approve → **archive** the target.
- **Approve** = MATERIALIZE (add→create, modify→patch same id, remove→archive). **Decline** =
  drop the PlanItems (the tree was never touched). Identity is preserved on modify.

## 3. What 843 GENUINELY adds — the only new pixels (the Plans-substrate chrome)

Everything below is layered ON the composed shell + canvas; nothing here re-draws them.

### Panel A — the Plans LIST + left-nav "Plans" entry (a LIST, not a canvas)

The index. A left-nav **"Plans"** entry (the access path — drawn beside the other project nav
surfaces, routing to `/…/plans`). Each row: the summary/idea the plan came from, a **status pill**
(`generating` / `planned` / `approved` / `declined`), the item count, when-planned, when-decided,
and a **"N may be out of date" stale flag** for a `planned` plan with drifted items. The empty
state — "Generate your first plan" CTA into the 7.3 discovery hand-off. Reuses the shipped
list/`useRowWindow` primitives — not a hand-rolled list. (Built by MOTIR-1338.)

### Panel B — the plan DETAIL = the generation-review MODE of the 1193 workspace (composed)

The composed canvas+chat shell, with the Plans chrome layered on:

- **Plan status** + a **history timeline** (created / planned at X; approved or declined at Y by Z).
- **Per-item `op` treatment**, drawn ON the real `WorkItemNode`. The three ops use **three
  distinct, non-colliding visual languages**, and none of them reuses the red dashed/hatched
  language the shipped canvas already owns for **cross-story dependencies** (the `GhostAnchor` /
  cross-blocked node — danger dashed border + `danger-surface` hatch). Red-hatch stays reserved
  for that dependency signal; the op treatments are a separate axis:
  - **`add`** → **dashed ACCENT (purple) border + accent-soft tint + a "+ add" badge** — a new
    node not yet in the tree (proposed). An `add` node also carries an **Edit affordance** (a
    pencil icon-button in the node's top-right, beside where a status pill sits on other ops) —
    see the inline-edit bullet below (MOTIR-1370).
  - **`modify`** → the **EXISTING** node, **solid INFO (blue) ring + a "proposed change" badge** +
    an inline **old→new diff** (old read live from the target, new from `patch`) — SAME id, not a
    ghost copy.
  - **`remove`** → a **dimmed, de-saturated, NEUTRAL "will be archived"** treatment (solid muted
    border + grey fill + strike-through title + an archive chip) — deliberately **not**
    red/dashed/hatched, since archive is reversible (the `cancelled`-status hue), not the
    error/attention signal cross-story deps carry. This is the fix for the original collision:
    `remove` previously read identically to a cross-level dependency.
- **Inline edit of a proposed `add`** (MOTIR-1370). The Edit pencil on an `add` node opens a
  **Modal** edit form over the add's proposed fields — **Title** (`Input`), **Type** (the kind
  picker `TypePicker`), **Work type** (`WorkItemTypePicker`), **Priority** (`PriorityPicker`),
  **Description** (`Textarea`) — Save / Cancel in the footer. The same field controls the
  create-issue modal uses, so the form needs no new primitive. Editing patches the PlanItem's
  `proposedFields`; **no WorkItem is created** (an `add` stays a proposal until approve), and on
  save the canvas refetches the review model and re-renders. **Only an `add` is editable** —
  `modify`/`remove` target existing items, so they carry no Edit affordance. The trigger and the
  form are offered **only while the plan is `planned`**; a decided plan is read-only.
- The decision gate: an **Approve** primary — **"Add N items to your backlog"** (→ MATERIALIZE),
  with a stale-warning confirm when items are stale — and a **Decline** secondary (drop). A
  decided plan is **read-only** with its outcome + history shown. (NO "Discard"; Approve =
  materialize, Decline = drop.) (Built by MOTIR-847.)

### Panel C — live generation

The streaming **"Generating your plan…"** state: proposed nodes appear **PER LEVEL** on the
composed canvas as the engine emits PlanItems (respecting drill-down — NOT a whole-tree reveal);
`aria-live` announces progress. Reads the substrate's own Plan data (poll/refresh `getPlan`), so
7.21 never depends on the 7.4 generation stream.

### Panel D — terminal states

- **Empty** — no direction docs yet → link the 7.3 discovery chat (MOTIR-833).
- **Failed** — retry; a partial proposed frontier is discardable.
- **Out of credits** — "You're out of planning credits" + top-up CTA into 6.10 (generation is
  metered — 7.2).

## 4. Tokens, primitives, a11y

- **Tokens only**: `--el-*` element/semantic tokens + the element-semantic **shape** tokens,
  driven by the top-level `[data-display-style]` attribute. **No Tier-0 `--color-*`, no raw
  `rounded-md`/`p-2`/`h-9`.** The proposed tint, the "will be archived" treatment, and the stale
  badge all route through the semantic intent tokens (accent / warning / danger), not hand-picked
  hex.
- **Composes ONLY shipped primitives** (`Card` / `Button` / status `Pill`/`Badge` /
  `SectionLabel` / `Modal` / the list row + `useRowWindow`) + the real canvas. The proposed-`add`
  edit form (MOTIR-1370) likewise composes shipped controls only — `Input` / `Textarea` /
  `TypePicker` / `WorkItemTypePicker` / `PriorityPicker` inside the shared `Modal` (the same set
  the create-issue modal uses). A genuinely new primitive would be its OWN `design/` subtask —
  none is introduced here.
- **a11y**: status pills carry **text, not colour only**; the generating state is `aria-live`; the
  canvas keyboard/zoom affordances are inherited from the composed `ProjectRoadmapCanvas` (not
  re-specified). Copy lives in the `aiPlanning` i18n namespace.

## 5. Access path

The surface is reached from the **"Plans" left-nav entry** (Panel A) → the Plans list → a row →
the plan detail (Panel B). The empty list and the onboarding hand-off (MOTIR-840) both route into
the generate entry. The nav entry is drawn in the mock so the reader SEES the door, not just the
route name (the access-path rule).

---

# Part II — AI sprint planning: the entrance, the packing review, approve / discard (MOTIR-1749 / 7.13.11)

> **Story:** MOTIR-813 · _Cadence — auto-planning + AI sprint planning_ (Epic 7).
> **Subtask:** MOTIR-1749 (7.13.11) — the design gate for **MOTIR-1750** (7.13.12), which implements
> this asset. **motir-core only.**

| File                        | What it is                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `sprint-planning.mock.html` | The asset SOURCE — six panels, built from the real design system. Layout source of truth. |
| `sprint-planning.png`       | Full-page export (light, `deviceScaleFactor: 2`, viewport 1200) — the reviewable face.    |

**The gap this closes.** MOTIR-917 ships the `plan_sprint` packing job, MOTIR-918 the API + persist
behind an approve gate, MOTIR-919 the settings toggles — and the shipped settings copy already
promises the user _“Motir proposes the next sprints from ready work; **you approve before any sprint
is created**.”_ No surface ever shipped where that approval happens. This asset draws it.

## 1. Drawn against SHIPPED reality — what was RENDERED first

The host already exists, so it was **rendered, not reasoned about** (notes.html mistake **#73** — “reading
the `.tsx` is not seeing what renders”). On `origin/main` @ `28c11c8b`: `pnpm next build` +
`next start`, signed in against a seeded tenant, full-page screenshots of **`/backlog`**,
**`/settings/project/ai-planning`** and **`/ready`** at 1280 × dSF 2. Everything below composes
those renders:

| Rendered / read source                                                                    | What this design takes from it — verbatim, not redrawn                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/(authed)/backlog/page.tsx`                                                           | The host page: serif `text-2xl` **Backlog** + muted sub **“Motir · plan & groom — rank, sprint, estimate”**; toolbar `[View all work items] [Filter] [Advanced] [Saved] [+ New work item]`. |
| `_components/BacklogContainer.tsx` → `CreateSprintButton`                                 | The **full-width dashed `＋ Create sprint` strip** between the sprint region and the Backlog region. This strip is where the door lands.                                                    |
| `_components/SprintContainer.tsx`                                                         | The sprint panel the **proposed** sprint is a variant of — chevron · name · state `Pill` · calendar range · count badge · committed points · velocity seam · Start sprint · `⋯`.            |
| `_components/BacklogRow.tsx`                                                              | The work-item row — grip · selection circle · `IssueTypeIcon` · mono identifier · title · `EstimateBadge` · avatar · status pill · `⋯`.                                                     |
| `app/(authed)/ready/_components/ExpansionNudge{Banner,Review}.tsx`                        | The **shipped in-surface AI proposal grammar**: lavender-tint `Card`, `Sparkles` in `--el-accent-on-surface`, a phase machine, **Approve** primary / **Decline** ghost. Reused.             |
| `components/planning/PlanEditsReviewDock.tsx`                                             | The **review-dock grammar**: header title + close · scrolling body · footer with the count on the left and ghost-decline / primary-approve on the right, the CTA carrying the count.        |
| `design/ai-planning/plans-surface.*` (Part I)                                             | The proposal-review grammar this mirrors — nothing real until approve; approve MATERIALIZES; the CTA names what it creates.                                                                 |
| settings `/settings/project/ai-planning` (rendered)                                       | The **“Plan sprints with Motir”** switch, its promise copy, and the peach “Motir AI isn’t connected” callout shape reused for off/error.                                                    |
| `lib/ai/sprintAssignment.ts`, `lib/ai/types` (`SprintAssignmentDelta` / `ProposedSprint`) | Every figure rendered is a REAL field — see §4.                                                                                                                                             |
| `lib/services/aiSprintPlanningService.ts`, `app/api/ai/plan/sprint/**`                    | Submit (409 / 402 / 502), the SSE stream, approve (400 shape · 400 semantic · 403 sprint-admin).                                                                                            |

## 2. PLACEMENT — the backlog hosts it (justified from the shipped IA, not asserted)

The card offers three candidate hosts. Shipped reality picks the backlog:

1. **`/backlog` IS the sprint-planning surface.** Its own page comment: _“The Backlog /
   sprint-planning surface (Story 4.2 · 4.2.3) — Motir’s clone of the Jira backlog.”_ Sprints are
   created, filled, started and completed there and nowhere else.
2. **Approve writes exactly the two gestures this page already owns.**
   `aiSprintPlanningService.approveSprintPlan` calls `sprintsService.createSprint` (the page’s
   `＋ Create sprint` strip) and `backlogService.bulkAssignToSprint` (its drag-into-sprint / bulk
   move). AI sprint planning is the **automated form of the host’s own two gestures**, so the door
   belongs beside the manual one — not on a third surface.
3. **The settings asset explicitly disclaims it.** `design/ai-settings/design-notes.md` scopes card 2
   to `aiSprintPlanningEnabled` + `aiSprintLengthDays` and lists _“the sprint-proposal review UI —
   **its own surface**, not a settings pane”_ as out of scope. Settings CONFIGURES; the backlog RUNS.
4. **It earns NO left-nav entry.** A nav entry is this app’s convention for a first-class project
   VIEW (Dashboard / Boards / Backlog / Roadmap / Plans). This is an **action on the backlog’s own
   objects** — the same class as Start sprint and Complete sprint, which also live in-surface. Adding
   a route would fork sprint planning across two surfaces (the converse of notes.html mistake **#99**:
   a view earns a nav entry, an in-surface action does not).

### The doors, both DRAWN (panels 0 and 0b)

- **Primary — the create-sprint strip becomes a two-action strip** (panel 0). Left: the shipped
  `＋ Create sprint` (unchanged, `flex: 1`). A 1 px `--el-border-strong` divider. Right:
  **`Plan sprints with Motir`**, `--el-tint-lavender` fill + `--el-accent-on-surface` ink + the
  `Sparkles` glyph — the same treatment every other AI affordance in the app carries. The strip keeps
  its single dashed `--el-border-strong` / `--radius-card` silhouette, so the page’s rhythm is
  unchanged.
- **Secondary — the ⌘K command palette** (panel 0b): a **Backlog** group entry
  **“Plan sprints with Motir”** that navigates to `/backlog` and opens the run in one step. Registered
  in the same command registry the shipped “Go to Backlog” / settings deep links come from, so the
  action has one implementation and two doors (the notes.html **#83** lesson: don’t leave the
  cross-surface door unowned — here it is drawn AND owned by MOTIR-1750).

## 3. Panels

| #   | Panel                | What it shows                                                                 |
| --- | -------------------- | ----------------------------------------------------------------------------- |
| 0   | **Entrance**         | The rendered backlog with the two-action strip in place.                      |
| 0b  | **Second door**      | The ⌘K palette with the Backlog-group entry.                                  |
| 1   | **Off**              | `aiSprintPlanningEnabled = false` — door present and disabled + the fix hint. |
| 2   | **Generating**       | The streamed packing run, with Cancel.                                        |
| 3   | **Proposed packing** | The review — the main panel.                                                  |
| 4   | **Edge states**      | Empty packing + the four failure shapes.                                      |
| 5   | **After approve**    | The created sprints as ordinary Epic-4 sprints + the toast.                   |

## 4. The review renders REAL fields only

Every figure maps 1:1 onto `SprintAssignmentDelta` / `ProposedSprint`. Nothing is invented:

| Drawn                                    | Field                                                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| “3 sprints · 9 work items · 7 days each” | `sprints.length` · `itemCount` · `sprintLengthDays`                                                                   |
| Sprint name (**Sprint 2**)               | `sprints[].name`                                                                                                      |
| **7 days** chip                          | `sprints[].lengthDays`                                                                                                |
| Count badge (**4**)                      | `sprints[].itemKeys.length`                                                                                           |
| “19h 50m of 28h — 71%”                   | `sprints[].totalEstimateMinutes` / `sprints[].capacityMinutes`                                                        |
| “at 240 agent-minutes a day”             | `agentMinutesPerDay`                                                                                                  |
| **Bigger than a sprint** pill            | `sprints[].oversizedKeys` (and the head’s roll-up count)                                                              |
| **No estimate** pill                     | `unestimatedKeys`                                                                                                     |
| **Why this order** callout               | `sprints[].rationale`                                                                                                 |
| The row order itself                     | `sprints[].itemKeys` order — the packing’s dependency order, which `validatePacking` proves is blocker-before-blocked |

**One read MOTIR-1750 must ADD.** The per-row **“after MOTIR-1749”** caption is the only element not
in the delta. It comes from the `is_blocked_by` edges among the packed items — exactly the edges
`aiSprintPlanningService.validatePacking` already resolves via
`workItemLinkRepository.findBlockedByEdges`. MOTIR-1750 surfaces the same read in the review model so
the caption is server-derived, never guessed in the browser. A row with no in-packing blocker shows
nothing (absence is the default; the caption is never rendered empty).

## 5. Primitives — every element, and what it is

| Element                                 | Primitive / shipped component                                 | Notes                                                                  |
| --------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Page header, toolbar                    | `app/(authed)/backlog/page.tsx`                               | Untouched.                                                             |
| `＋ Create sprint`                      | `BacklogContainer.CreateSprintButton`                         | Untouched; becomes `flex: 1` inside the strip.                         |
| `Plan sprints with Motir` (both states) | `Button` (`variant="ghost"`, `size="sm"`) inside the strip    | Lavender fill is the strip’s, not a new button variant.                |
| Off hint                                | the shipped callout shape (`Card`-less tinted block)          | Same markup family as the settings “Motir AI isn’t connected” callout. |
| Generating dock                         | `PlanEditsReviewDock` running state + `Spinner`               | `role="status"`, `aria-live="polite"`.                                 |
| Review dock shell                       | `PlanEditsReviewDock` (header / body / footer)                | Header/footer copy differs; structure identical.                       |
| Proposed sprint                         | `SprintContainer` + the proposed treatment                    | Read-only variant — see §6.                                            |
| Proposed row                            | `BacklogRow` (`BacklogRowBody`, no `dragProps`)               | Read-only variant — see §6.                                            |
| State chips                             | `Pill`                                                        | `Proposed` · `Bigger than a sprint` · `No estimate`.                   |
| Approve / Discard                       | `Button` `variant="primary"` / `variant="ghost"`              | Mirrors the dock + the ExpansionNudge pair.                            |
| Empty packing                           | `EmptyState`                                                  | Title + description + a secondary Close.                               |
| Failures                                | the tinted callout + a `Button variant="secondary" size="sm"` | One per status code (§7).                                              |
| Success                                 | `Toast` (`variant="success"`)                                 | Via the shipped `useToast`.                                            |
| ⌘K entry                                | `CommandPalette` registry entry                               | No new primitive.                                                      |

**No new primitive is introduced.** Anything that looks new is a composition of the above.

## 6. The PROPOSED treatment (the only genuinely new pixels)

A proposed sprint is the shipped `SprintContainer` with three changes, and three removals:

- **Border** → `1px dashed var(--el-accent)` (a real sprint is `1px solid var(--el-border)`).
- **Head fill** → `var(--el-tint-lavender)`, `border-bottom` `--el-accent`.
- **State pill** → `Pill` reading **Proposed**. On the lavender head it flips to
  `background: var(--el-page-bg)` + `color: var(--el-accent-on-surface)` — a lavender chip on a
  lavender head is not a chip. Both are palette tokens; no hue is invented.
- **Removed:** the drag grip, the selection circle, the row `⋯`, the sprint `⋯`, and **Start sprint**.
  A proposal has no lifecycle; those controls appear only once the sprints are real (panel 5).
  (The blue check-square that remains on each row is the **`IssueTypeIcon` for a task**, not a
  checkbox — same glyph the shipped backlog row renders.)
- **Added:** the capacity line and the **Why this order** callout (below).

**Deliberately NOT reused:** the canvas’s dashed-danger / hatched language, which is reserved for
cross-story dependency signalling (Part I §3). Proposed is accent-dashed; over-capacity is warning;
a refusal is danger. Three separate axes.

**Editing a proposal is out of scope for this release.** The approve API accepts an edited delta
(`approvedDelta`), so the seam exists — but v1 approves or discards **whole**, and re-running is how
you get a different packing. Drawing an editor here would design a surface no card owns.

## 7. Copy — every string (i18n namespace `backlog.aiPlan.*`)

The host page already uses the `backlog` namespace; these keys join it under an `aiPlan.` prefix, the
same way `/ready` nests its AI banner under `ready.nudge.*`. **Every new `en.json` key needs its
`zh.json` twin in the same PR** (the i18n-catalog parity gate).

**Entrance / off**

- `aiPlan.cta` — **Plan sprints with Motir**
- `aiPlan.offTitle` — **AI sprint planning is off for this project.**
- `aiPlan.offBody` — **Turn it on to let Motir pack your ready work into short, dependency-aware sprints.**
- `aiPlan.offLink` — **AI planning settings**
- `aiPlan.commandLabel` (⌘K) — **Plan sprints with Motir**

**Generating**

- `aiPlan.runningTitle` — **Planning your sprints…**
- `aiPlan.cancel` — **Cancel**
- `aiPlan.stepRead` — **Read {count} ready work items and what blocks what**
- `aiPlan.stepSize` — **Sized them against a {days}-day sprint at {minutes} agent-minutes a day**
- `aiPlan.stepPack` — **Packing sprint {n} of {total}…**
- `aiPlan.stepDone` — **done**

**Review**

- `aiPlan.reviewTitle` — **Proposed sprints**
- `aiPlan.reviewSub` — **{sprints} sprints · {items} work items · {days} days each — nothing is created until you approve.**
- `aiPlan.proposed` — **Proposed**
- `aiPlan.lengthDays` — **{days} days**
- `aiPlan.capacity` — **{used} of {total} — {pct}% of a {days}-day sprint at {minutes} agent-minutes a day**
- `aiPlan.capacityOver` — **{used} of {total} — over by {over}, held together because {key} blocks the rest**
- `aiPlan.firstSprint` — **first — nothing blocks it**
- `aiPlan.after` — **after {key}**
- `aiPlan.oversized` — **Bigger than a sprint**
- `aiPlan.oversizedCount` — **{count} bigger than a sprint**
- `aiPlan.unestimated` — **No estimate**
- `aiPlan.whyLabel` — **Why this order.**
- `aiPlan.approveFine` — **Approving creates these sprints and moves the work items into them. Nothing else changes — no status moves, no sprint starts.**
- `aiPlan.discard` — **Discard**
- `aiPlan.approve` — **Create {count} sprints**

**Empty / failures / success**

- `aiPlan.emptyTitle` — **Nothing to schedule**
- `aiPlan.emptyBody` — **Every work item that could go into a sprint is already in one. Motir will have something to pack once new work is ready, or once this sprint completes.**
- `aiPlan.close` — **Close**
- `aiPlan.errDisabled` — **AI sprint planning is off for this project.** _(+ “Nothing was created.”)_ → 409 `SPRINT_PLANNING_DISABLED`
- `aiPlan.errCredits` — **You’re out of planning credits.** Top up to keep Motir planning your sprints. → 402
- `aiPlan.errUnreachable` — **Motir didn’t answer.** Nothing was created — try again in a moment. → 502
- `aiPlan.errPacking` — **This packing no longer fits your plan.** {detail} Nothing was created. → 400 (`SPRINT_ASSIGNMENT_INVALID` / `SPRINT_PLAN_APPROVE_ERROR`)
- `aiPlan.errNotAdmin` — **You need sprint-admin rights on this project to create sprints.** → 403 `NotSprintAdminError`
- `aiPlan.retry` — **Try again** · `aiPlan.planAgain` — **Plan again** · `aiPlan.topUp` — **Top up**
- `aiPlan.doneTitle` — **{count} sprints created**
- `aiPlan.doneBody` — **{items} work items moved into {names}.**

Every failure states **nothing was created** — true by construction: approve runs in ONE
`withWorkspaceContext` transaction, so a partial write cannot happen, and the copy may promise it.

## 8. Token roles — colour (`--el-*`) and shape

**No raw hex, no `rgb()`, no Tier-0 `--color-*`, and no raw `rounded-*`/`p-*`/`h-*` anywhere in the
mock or the implementation.**

| Element                                                       | Colour token                                                                        | Shape token                                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Page title / body ink                                         | `--el-text`                                                                         | —                                                         |
| Sprint name, chip ink, callout lead                           | `--el-text-strong`                                                                  | —                                                         |
| Secondary copy, ghost button ink                              | `--el-text-secondary`                                                               | —                                                         |
| Capacity line, count badge ink, footer fine print             | `--el-text-muted`                                                                   | —                                                         |
| Velocity seam, drag grip, avatar dash                         | `--el-text-faint`                                                                   | —                                                         | — faint is correct here: the grip and the avatar dash are `aria-hidden` glyphs. |
| Strip + panel borders                                         | `--el-border` · `--el-border-strong` (dashed strip) · `--el-border-soft`            | `--radius-card`                                           |
| AI door fill / dock head / Proposed chip on white             | `--el-tint-lavender`                                                                | `--radius-card` · `--radius-badge`                        |
| AI door ink, Sparkles glyph, ⌘K active row                    | `--el-accent-on-surface`                                                            | —                                                         |
| Proposed sprint border, review-dock border, insertion accents | `--el-accent`                                                                       | `--radius-card`                                           |
| Approve CTA fill / its ink                                    | `--el-accent` / `--el-accent-text`                                                  | `--radius-btn` · `--height-btn-md`                        |
| Capacity bar track / fill                                     | `--el-muted` / `--el-accent`                                                        | `--radius-badge`                                          |
| Capacity bar OVER capacity                                    | `--el-warning`                                                                      | `--radius-badge`                                          |
| Over-capacity + unestimated chips                             | `--el-warning-surface` + `--el-warning-text` · `--el-tint-sky` + `--el-text-strong` | `--radius-badge` · `--spacing-chip-x/y`                   |
| Off hint, fixable failures (disabled / credits)               | `--el-warning-surface` + `--el-warning-text`                                        | `--radius-card`                                           |
| Refusals (unreachable / invalid packing / not admin)          | `--el-danger-surface` + `--el-danger-surface-text`                                  | `--radius-card`                                           |
| Success toast glyph                                           | `--el-success`                                                                      | `--radius-card` · `--shadow-elevated`                     |
| Row hover / status pill                                       | `--el-surface-soft` · `--el-tint-lavender`                                          | `--radius-control` · `--spacing-control-x/y`              |
| Links (settings, create-work-item)                            | `--el-link`                                                                         | —                                                         |
| Card / dock elevation                                         | —                                                                                   | `--shadow-subtle` · `--shadow-card` · `--shadow-elevated` |

> ⚠️ `--el-danger-text` is **fill ink** (it resolves to `--color-destructive-foreground`, i.e. white),
> NOT a label colour for a light surface. Danger copy on a surface uses
> `--el-danger-surface` + `--el-danger-surface-text`, or `--el-danger` as the ink. The mock uses the
> pair everywhere.

Colour is never the only signal: **Proposed**, **Bigger than a sprint**, **No estimate** and every
failure all carry text (the a11y rule Part I §4 states).

## 9. a11y

- The review dock is a `<section aria-labelledby>` with the **Proposed sprints** heading; the
  generating state is `role="status" aria-live="polite"` (as `PlanEditsReviewDock` already does).
- Each proposed sprint is a `<section aria-label="{name}, proposed, {count} work items">` — mirroring
  `SprintContainer`’s `sprintRegionLabel`.
- The proposed rows are a `role="list"` of `role="listitem"`, **not** the sortable `role="row"` grid —
  they are not draggable, and claiming row semantics for a static list would mislead (the
  listbox-row-actions lesson).
- The failure callouts are `role="alert"`; the success is the shipped `Toast` (already announced).
- Focus after approve moves to the first created sprint’s header, so a keyboard user lands on the
  result rather than on a removed dock.

## 10. Page state after the mutation (the enforced contract — CLAUDE.md)

Approve touches **two** surfaces on `/backlog`, and they update differently:

1. **The sprint region** — `BacklogContainer` is a **client island** that seeds `useState` from its
   own `/api/sprints` fetch. `router.refresh()` **cannot** reach it. Approve must call the island’s
   existing refetch (`reloadKey` bump — the same signal `CreateSprintButton`’s `onCreated` and
   `SprintContainer`’s `onStarted` / `onDeleted` already use).
2. **The Backlog region** — the approved items LEAVE it, so its `useRankedIssues` read must refetch in
   the same update (the `issuesRefreshKey` tick, exactly as a completed sprint’s carry-over does).

Both are already-shipped signals; MOTIR-1750 wires approve to them and adds no third mechanism. The
dock unmounts on success — it must not linger showing a proposal that has become real.

## 11. Explicitly OUT of scope here (so no one builds it twice)

- **Editing a proposed packing** (move an item between proposed sprints, rename, re-size). The
  `approvedDelta` seam exists; the UI is a later card if it is ever wanted.
- **Sprint dates.** `approveSprintPlan` deliberately leaves the window unset — the shipped
  `startSprint` stamps it. So the proposal shows a **length**, never a calendar window, and the
  created sprints read **Not started** (panel 5).
- **The cadence-fired path.** MOTIR-916’s sweep may submit the same job unattended; where its result
  is surfaced is that card’s question, not this surface’s. This asset covers the **person-initiated**
  run. (Both land on the same approve gate, so a later card can mount this same dock.)
- **The settings pane** — MOTIR-914 / MOTIR-1739 own it (`design/ai-settings/`).

---

# Part III — Who ASKED for this plan, and who WROTE it (MOTIR-2985 / Story MOTIR-2982)

**Amends Parts I and II's asset in place**: the same three files
(`design-notes.md` · `plans-surface.mock.html` · `plans-surface.png`), one new panel — **A2**.

## 0. The premise — a plan has THREE parties

A plan is produced by up to three different people, and the surface recorded only one of them:

| axis             | question                                      | recorded before this                                                      |
| ---------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| **Requested by** | which PERSON asked for this plan              | **nothing at all**                                                        |
| **Written by**   | which agent (or Motir) produced the proposals | nothing at all                                                            |
| **Decided by**   | which person approved / declined it           | `Plan.decidedById` ✓ (drawn in panel A as _"approved yesterday by Mara"_) |

**The requester is the one a reviewer wants first**, and an agent-authored plan makes that question
sharper rather than softer. _An agent_ is not an answer to _whose plan is this?_ — **the MCP token
belongs to a person**, who minted it and pointed it at this project, and a Motir generation was
**clicked** by a person. A surface that named only the agent would read as though nobody is
accountable for a tree somebody is about to approve, which is a worse failure than the one the
attribution was added to fix.

So the attribution names **the person first and the agent second**, in one entry, as one sentence
about provenance.

## 1. What is UNCHANGED — composed, not redrawn

- **The access path.** Plans is reached from the left-nav _Plans_ entry (Part I §5), and a row is a
  single `<Link>` into `/plans/[id]` — `PlanRow.tsx` says so in its own header. **No new door.**
- **The row's shape**: the 22px status icon-square, the title line, the meta line, the right-hand
  pill cluster, the accent border on a `planned` row awaiting review.
- **The status pills** and their tones, and the rule that status is carried by TEXT, not colour alone.
- **The staleness flag**, **the plan-detail canvas, the history timeline, and the approve / decline bar.**

## 2. Drawn against SHIPPED reality — what was RENDERED first

The list row is already implemented, so this was drawn against pixels rather than source. The **real
`PlanRow`** was bundled (esbuild) with the **real `messages/en.json`** through a
`NextIntlClientProvider`, styled with the **real `app/globals.css` + `@motir/design-system` theme**,
and screenshotted headlessly in both themes before this panel was written. Four things that render
settled, which reading the `.tsx` would not have:

1. The meta line has **room**: `14 items   planned 2 hours ago` occupies under a third of it. Both
   parties fit without new chrome, a second row, or a pill.
2. The right-hand cluster is where the eye lands for STATUS. Putting attribution there would give
   the row **two chips that read as one** — a `Planned` pill beside a `Claude Code` pill is a status
   the reader will try to interpret.
3. The meta entries are visually identical to each other. A bare `Mara · via Claude Code` in that
   line reads as more timestamps — hence the **avatar** and the **glyph** (§4).
4. The shipped row does **not** render the decider, though panel A's mock draws _"approved yesterday
   by Mara"_. That drove a design rule rather than a shrug — see §3's _A DECIDED row shows the
   DECIDER_ — and the gap itself is pre-existing and **not** closed here.

## 3. What it draws — seven rows, and the FIELD each reads

The attribution is **one more entry in the row's existing meta line**, after the timestamp:
`<avatar> Mara · 🤖 via Claude Code`.

**Rows 1–4 ARE panel A's rows** — the same four plans, in the same order, with the same item counts,
op summaries, timestamps, staleness flag and accent border. This panel AMENDS A, so it must be
diffable against it: read the two side by side and the only difference is the new entry.
Substituting different plans would have forced the reader to re-read both panels to work out what
changed, which is the one thing an amendment panel exists to prevent. **Rows 5–7 are ADDED**, for
three states panel A has no row for.

| #   | row                             | the attribution shows                       | read from                                                         |
| --- | ------------------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| 1   | **generating** (A's row 1)      | `M` `Mara`                                  | `createdById` → name; no author yet                               |
| 2   | **planned + stale** (A's row 2) | `M` `Mara` · 🤖 `via ` **`Claude Code`**    | `createdById` → name · `authorSource === 'mcp'` → `authorHarness` |
| 3   | **approved** (A's row 3)        | ✨ `via ` **`Motir AI`** — NO requester     | `sourceJobId !== null`; decided, see below                        |
| 4   | **declined** (A's row 4)        | **nothing — the entry is absent**           | neither party known (a plan older than both columns)              |
| 5   | **NOBODY asked** (cadence)      | ↻ `auto-planned` · ✨ `via ` **`Motir AI`** | `createdById === null` **and** `origin === 'cadence'`             |
| 6   | **requester, no agent**         | `P` `Priya`                                 | `createdById` set, no author and no job                           |
| 7   | **long values**                 | both names ellipsize; nothing else moves    | §5                                                                |

### A DECIDED row shows the DECIDER, not the requester

Panel A's rows 3 and 4 already end **`approved yesterday by Mara`** / **`declined 3 days ago by
Mara`** — the THIRD party, drawn since 843. A decided row that also gained a requester would
therefore carry **two bare person names in one line**, and a reader cannot tell which one holds which
role; it is the two-chips-read-as-one hazard applied to people.

The rule that resolves it is also the one that matches how the list is read: **while a plan is
UNDECIDED, _who asked_ is what you weigh — you are about to approve their request. Once it is
decided, _who decided_ is the operative fact and the requester is history.** So the row drops the
requester on `approved` / `declined`, keeps the agent (which still answers _what wrote the tree I
accepted?_), and the **detail header keeps both** (§6). It also caps the meta line at three entries
in every state.

⚠️ **`by Mara` is drawn in panel A and is NOT shipped.** `PlanRow` renders
`t(view.whenKey, { when })` — _"approved yesterday"_, with no name. That gap is pre-existing, is
**not** closed by this amendment, and is named here so nobody reads panel A as shipped behaviour or
reads this panel as having deleted something.

### ⚠️ State 3 is the one the DATA had to be shaped for, and it is not cosmetic

`createPlan` **always has an acting user**, so the requester could not simply be defaulted from the
context. On the auto-plan path that acting user is the **project owner**, substituted by
`autoPlanCadenceService` (`{ userId: owner.userId }`) purely so the job has a credential — **nobody
clicked anything**. Recording them would attribute to a real person a request they never made, on
the single plan whose whole point is that no person asked.

So `Plan.createdById` is **written ⟺ a person actually asked** (`origin === 'user'`), and state 3 is
drawn from its ABSENCE plus `origin`. The column is explicit at every call site for exactly this
reason, and the abstention is pinned by a test (`autoPlanCadence.test.ts`) rather than left to the
next producer's judgement.

### ⚠️ State 2 reads `sourceJobId !== null`, NOT `authorSource === 'native'`

[The contract decision](motir:cmsympvcb017mi4philjyjccs) deliberately does not retrofit Motir's own
generator, so **every plan the product generates carries `authorSource === null`**. Drawing state 2
off `'native'` would specify a row the surface can never render. **MOTIR-2996** retires that
inference, and when it lands this row becomes `authorSource === 'native'` with no other change.

### State 4 renders NOTHING

No em-dash, no `Unknown`, no greyed placeholder. Every plan predating these columns is in this state,
and a placeholder in a scanned list is a value the reader must learn to ignore.

## 4. Per element — the primitive, the tokens, the copy

| element                  | primitive / markup                                                                                                  | colour token                                              | shape / size                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| the attribution entry    | a `<span>` **inside the existing meta line** — no new container, no `Pill`                                          | `--el-text-secondary` (the meta line's own ink)           | inherits: `text-xs`, `gap-x-3`                                  |
| the requester avatar     | the **shipped `Avatar`** (`app/(authed)/items/_components/issueCellPrimitives.tsx`) — initial letter, `aria-hidden` | `bg-(--el-text)` / `text-(--el-text-inverted)`, unchanged | **18px** here vs its 22px row size — the meta line is `text-xs` |
| the requester name       | `<b>`                                                                                                               | `--el-text-secondary` at `font-semibold`                  | `max-w-[10rem]`, truncate                                       |
| the agent glyph          | lucide **`Bot`** (agent) · **`Sparkles`** (Motir) · **`RotateCw`** (auto-planned), `aria-hidden`                    | `--el-text-faint`                                         | `h-3 w-3`, `shrink-0`                                           |
| the harness / `Motir AI` | `<b>`                                                                                                               | `--el-text-secondary` at `font-semibold`                  | `max-w-[12rem]`, truncate                                       |
| the `·` separators       | `<span>`                                                                                                            | `--el-text-faint`                                         | —                                                               |
| the model (DETAIL only)  | `<span>` after a `·`                                                                                                | `--el-text-muted`                                         | —                                                               |

- **No new colour and no Tier-0 value.** Every ink is an `--el-*` token this surface already uses;
  the entry has no background, border or fill, so it introduces no tint.
- **The avatar is the SHIPPED primitive, resized, not a new one.** A design that hand-rolled a
  circle would drift from every other person on the product the first time that primitive changes.
- **`--el-text-faint` on the glyphs and separators is legal precisely because they are decorative.**
  `CLAUDE.md`'s measured table puts faint at 2.39–2.61 against every surface here — below AA — and
  permits it only where meaning is carried elsewhere. It is: the avatar is `aria-hidden` and the
  NAMES say the whole thing. **Neither party is ever conveyed by icon or colour alone.**
- **`--el-text-secondary` for the words** (6.24 on `--el-surface`, AA in both themes) rather than
  `--el-text-muted`, which clears AA only on the white page — and this row sits on `--el-surface`.
- **Copy** (i18n namespace `aiPlanning`, both catalogs — the parity gate):
  - row: `requestedBy` → `{name}` · `viaHarness` → `via {harness}` · `viaMotir` → `via Motir AI` ·
    `autoPlanned` → `auto-planned`
  - detail: `requestedByLong` → `Requested by {name}` · `writtenByHarness` → `written by {harness}` ·
    `writtenByMotir` → `written by Motir AI` · `autoPlannedLong` → `Auto-planned — nobody requested this`

## 5. Long values — what truncates, and in what order

Both names are free text of unbounded length (`authorHarness` is caller-supplied; a person's name is
whatever they set). Panel A2's sixth row draws a long person AND a long harness AND a long title in a
narrow row at once:

- **The plan TITLE keeps its own single-line ellipsis** and is **never shortened by the attribution**
  — the meta line is a separate line below it.
- **The PERSON truncates at `max-w-[10rem]`, the HARNESS at `max-w-[12rem]`**, each with its full
  value on its `title` attribute. The person is given the tighter bound deliberately: a display name
  is usually short, and when it is not, the reader still gets the leading name.
- **The avatar, the `via`, the separators, the item count and the timestamp always stay legible** —
  none of them is inside a truncating box.
- **The meta line stays `flex-wrap`**, so a row too narrow for all three entries moves the whole
  attribution to its own line, as the panel draws. It never pushes anything out of the row and never
  breaks the text column's `min-w-0 flex-1`.

## 6. The DETAIL header — the same two parties, with the roles spelled out

The plan-detail header is `PlanReviewRail`'s `<header>` (status tag + title + summary + `N items`).
The attribution joins the **`N items` line**, with **two differences** from the row:

1. **The roles are named in words** — `Requested by Mara · written by Claude Code` — where the row
   says `Mara · via Claude Code`. The row is SCANNED, and an avatar in front of a name already reads
   as _this person's_; the header is READ, once, by the person about to press Approve, and there the
   words are what stop two names being taken for one party.
2. **The header carries the MODEL**, after a `·`. It is the difference between two agent-written
   plans and nobody scans a list on it. **Absent model ⇒ the separator and the model both
   disappear**; absent everything ⇒ the entry is absent, as in the row.

The cadence state is spelled out most explicitly of all here — **"Auto-planned — nobody requested
this"** — because this is the surface where somebody is about to accept the work, and _no requester_
is a fact they should read rather than infer from a missing name.

**And unlike the row, the header keeps the requester on a DECIDED plan.** The row drops it because a
second bare name competes with the decider in a scanned line (§3); the header has neither problem —
it names the roles in words, and the decider already lives in its own **history timeline** below
(`created → planned → approved by …`), not in the same line. So an approved plan's header reads
_"Requested by Jonas · written by Motir AI"_, with the decider a row further down where it always
was.

## 7. What this amendment ASSIGNS to its sibling cards

Written into those cards in the same pass (the sweep-the-referrers rule):

- **[The Plan's authorship carrier](motir:cmsyms0us018si4phpqjya7i1)** additionally carries
  **`Plan.createdById`** (+ its `PlanCreatedBy` relation, `ON DELETE SET NULL` like `decidedById`),
  written on the request paths and deliberately NOT on the cadence path.
- **[The Plans surface shows who authored a plan](motir:cmsymy41w01fri4phh1ur2b2v)** builds every
  state above, in BOTH reads, and owes **two name resolutions the DTOs do not carry today**:
  - `PlanDto.createdById` is an **id**; the LIST row needs a **name**. `planRowView.ts` is the
    server-side place for it — it already enriches each row — and the batch must be **one query for
    the page**, not one per row.
  - `PlanReviewDto` carries neither `createdById` nor `sourceJobId`. It already resolves
    `decidedByName` through `userRepository.findById` in `planReviewService`, which is the pattern to
    follow; **without `sourceJobId` the header cannot tell state 2 from state 4** however complete
    the authorship fields are.
- **[MOTIR-2996](motir:cmsyo0t8100dpi3ph16o9k6bm)** retires the `sourceJobId` inference once the
  generator records its own attribution, at which point state 2 reads `authorSource === 'native'`.

**Explicitly NOT closed here:** the shipped row does not render the DECIDER, though panel A draws it.
That is a pre-existing gap in the third axis, out of this story's scope, and it is named so nobody
reads panel A as shipped behaviour.

---

# Part IV — The review rail's STATUS TAG is an overline, above the title (MOTIR-3074)

Amends the **header gallery** in Part I's asset — the one place that asset draws
`PlanReviewRail`'s `<header>` as it actually ships. (Panel B's rail sketch predates that header and
draws neither the plan title nor the status tag, so there is nothing in it to correct.) Placement
only: no new element, no new token, no copy change, and the `data-testid="plan-status-pill"` hook
every shipped test reads is untouched.

## 1. What changed

The tag used to share one `flex items-center justify-between` row with the title. **It now sits on
its own line ABOVE it**, and the title owns the full rail width.

## 2. Why the row failed — and why it is not an edge case

Plan titles are **generated** — long by
default, and routinely carrying a token with no break opportunity in it (a `SCREAMING_CASE`
constant, a repo name, a cuid). The rail is a fixed **22rem** column, so a `shrink-0` tag took
roughly a third of the text width; the title wrapped to five lines while `items-center` held the
one-line tag against the middle of the block, and the tag ended up **inside the title's text
column**, reading as an annotation on line 3 of the sentence rather than as the plan's state. That
is the one thing this element exists to answer — _did my plan go through?_ — and it is read at the
moment somebody is about to press Approve.

## 3. Measured, at the shipped 352px rail width

**Measured in chromium**, on the reported title (_"…into
`SHARED_PLANNING_RULES` (motir-ai) — supersedes plan `cmszanri500bfi3phws7wdiu8`"_):

| shape                                  | rail overflow | title lines | tag inside the title's rows |
| -------------------------------------- | ------------- | ----------- | --------------------------- |
| shipped — tag beside the title         | **7px**       | 5           | **yes**                     |
| guard only, tag still beside the title | 0px           | **7**       | **yes**                     |
| **tag as an overline + the guard**     | **0px**       | **5**       | **no**                      |

The middle row is why the guard alone was not the fix: it stops the overflow and leaves both the
collision and two extra lines of wrapping.

## 4. What is unchanged, and the guard on the title

**The tag keeps its full status coverage and its `data-testid` hook** — the move is placement only,
no change to the tint map, the copy, or what a test reads. It stays `align-self: flex-start` so a
flex COLUMN child does not stretch across the rail.

**And the title carries the overflow guard whatever the placement**: `min-w-0` +
**`overflow-wrap: anywhere`** (Tailwind `wrap-anywhere`). `anywhere`, not `break-word`, is
load-bearing — only `anywhere` feeds its break opportunities into the **min-content** size a
flex/grid item's automatic minimum is measured from, which is the size that pushed the `<aside>`
past its track. Measured on the same harness: `break-words` alone left the 7px overflow standing;
`wrap-anywhere` alone cleared it. With the overline placement a token wider than the _whole_
column still overflows without the guard — 324px on a 60-character token, 0px with it — so the two
halves are independent and both are owed.

This is the repo's most-repeated overflow class (`min-w-0` on a shrinkable track) landing in a
header that never got the guard; the page's own `<h1>` one level up already had it.

---

# Part V — The plan-review DETAIL surfaces: a proposal on its parent's LEVEL, and a proposal READ view (MOTIR-3082 / bug MOTIR-3070)

**Amends Parts I–IV's asset in place**: the same three files
(`design-notes.md` · `plans-surface.mock.html` · `plans-surface.png`), two new panels — **E** and **F**.
Nothing already drawn is redrawn.

| Surface                                                     | Panel | Gates      |
| ----------------------------------------------------------- | ----- | ---------- |
| The out-of-plan **parent** signal on the plan-detail canvas | **E** | MOTIR-3083 |
| The proposal **read view** and its door                     | **F** | MOTIR-3084 |

## 0. The gap, and why it needed a design pass at all

`MOTIR-3070` reports two absences on the plan-detail canvas Part I §3 Panel B draws. Panel B
specifies exactly three op treatments (`add` / `modify` / `remove`) plus MOTIR-1370's inline-edit
modal, and it specifies **no parent context on a node** and **no per-proposal detail surface**. A
`grep` across every `design/*/design-notes.md` finds neither drawn anywhere else in the tree, so both
are whole elements rather than unspecified details — the design gate's NONE-exists case, and the
reason the card's `motir run` stopped instead of improvising.

## 1. What this composes — and does NOT redesign

Per `notes.html` **#82** and **#95**: cite the asset, the COMPONENT, and its contract.

| Composed                                   | Real asset / component                                                                                                                            | What it owns — NOT re-drawn here                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| The plan-detail canvas + its op treatments | Part I §3 Panel B · `components/planning/PlanItemNode.tsx` · `PlanReviewCanvas.tsx`                                                               | The three op languages, the stale badge, the drill chevron, the edit pencil, the node's fixed `NODE_W`/`NODE_H` footprint                          |
| The canvas **detail-surface pattern**      | `design/roadmap/design-notes.md` § _Canvas detail surfaces_ (MOTIR-1351) · built by MOTIR-1352                                                    | **Select a node → the selected card's `View` button → a `Modal size="xl"` peek.** This design adds no second interaction model; it reuses that one |
| The peek **body**                          | `design/work-items/quick-view.mock.html` · `components/planning/WorkItemQuickView.tsx` → `app/(authed)/items/_components/IssueQuickViewPanel.tsx` | The `.qv-head` / `.qv-body` / `.qv-main` + `.qv-rail` two-column shell, the section labels, the read-only rail rows                                |
| The dependency **ghost anchor**            | `design/roadmap/design-notes.md`, cross-level dependency                                                                                          | The red dashed + hatched off-level anchor and its `blocked elsewhere` flag — **cited here only to stay away from it** (§2)                         |
| The edit path                              | `ProposalEditModal.tsx` (MOTIR-1370)                                                                                                              | Editing an `add`. Unchanged, and still the ONLY writer                                                                                             |

## 2. Panel E — a proposed card is a NORMAL card on the roadmap level

### The problem in one sentence

`isRoot` (`lib/planning/projectCanvasModel.ts:141`) is true both for _a node with no parent_ and for
_a node whose parent is not in the rendered set_, so a proposal parented under a **committed** work
item draws at the top level, identical to a genuine root — and where a card lands in the tree is one
of the things approval decides.

### The decision: render the LEVEL, don't signal the parent (Yue, 2026-08-19)

**An earlier revision of this panel got this wrong and is recorded here rather than quietly
replaced.** It added a new element — a neutral "parent chip" pinned above the node — to _name_ the
parent the reader could not see. That answers the question by inventing vocabulary: a reader has one
more thing to learn, the canvas has one more language to keep from colliding, and the proposal still
sits alone on an otherwise empty canvas with no idea what it will live beside.

The right answer needs nothing new. **The plan-detail canvas is the roadmap, drilled to the level the
proposal lands in** — and `design/roadmap/design-notes.md` § _MULTI-LEVEL CHAINS — DRILL-DOWN_ already
specifies that surface completely:

> _"Click a node and the canvas REFRESHES to that node's children, laid out as their own chain; a
> breadcrumb (`Plan ▸ Invoices ▸ Create invoice`) + a **Back** control walks you up."_ … _"the
> consumer re-feeds the engine the children of the focused node + their same-level `blocked_by`
> edges, and tracks the breadcrumb path; **the engine is unchanged**."_

So the plan detail shows:

1. **The breadcrumb** — the committed ancestor path down to the focused level, exactly as the roadmap
   draws it. **This is what names the parent.** Not a badge, not a chip.
2. **The parent's real children** — every one of them, as ordinary committed nodes with their real
   identifiers and status pills. **They are on the canvas because they are the parent's children, NOT
   because anything depends on them**; a sibling with no `blocked_by` relationship to the proposal is
   still a sibling, and seeing the company a proposed card will keep is most of what "is this the
   right place for it?" means.
3. **The proposal**, at that same level, in the `add` style Panel B already specifies.
4. **Same-level `blocked_by` edges**, in the shipped edge language, unchanged.

**Nothing differs from the roadmap except the proposed card's style.**

### Why this dissolves the defect instead of flagging it

_Root or parented?_ stops being a question the reader has to ask. A proposal under a committed parent
is drawn **inside that parent's level**, among its siblings, with the parent in the breadcrumb; a
genuine root is drawn at the **top** level, where there is no breadcrumb to walk. The two read
differently because they **are** in different places — which is a distinction the reader already
understands from the roadmap, rather than one this surface teaches them.

It is also why no new visual language is introduced, and therefore why none of the canvas's reserved
languages (the three op treatments, the red hatched dependency tangle, the dashed _not in sprint_)
had to be worked around. The earlier revision spent a section arguing its way past them. The right
design never approaches them.

### States

- **A proposal under a committed parent** — drawn at that parent's level, breadcrumb walking to it.
- **A genuine root proposal** — the top level, no breadcrumb.
- **An archived or hard-deleted parent** — the level cannot be opened, so the proposal falls back to
  the top level and the breadcrumb has nothing to walk. That is the honest rendering, and it is the
  same one a genuine root gets (MOTIR-3083 AC 5's _degrade rather than throw_).
- **A plan whose proposals sit under SEVERAL committed parents** — they are at different levels, so
  the canvas cannot show them at once; that is the drill-down model working, not a gap. The review
  rail remains the whole-plan list, and selecting an item there drills the canvas to its level.

### What this does NOT change

`isRoot` keeps its contract — it is correct for its stated purpose. What changes is what the plan
canvas is FED: the committed level plus the plan's proposals, rather than a forest built from
`PlanItem`s alone (`buildPlanForest`). The canvas engine is untouched, per the roadmap's own build
note.

## 3. Panel F — read a proposal with the SHIPPED quick view, and REMOVE the edit modal

### The decision (Yue, 2026-08-19)

**Viewing a proposal is viewing a card.** It uses the same `Modal size="xl"` + `IssueQuickViewPanel`
quick view a normal work item gets, with **editing disabled** — not a bespoke panel that resembles it.

**And the proposal EDIT modal is REMOVED.** MOTIR-1370's inline-edit form over five fields is
withdrawn: manual editing of a proposal is not needed. A proposal is **read**, and changed by
**re-planning** — which is the model the rest of the product already runs on, where a plan is a
proposal a person accepts or declines rather than a draft they hand-correct. Part I §3 Panel B's
inline-edit bullet and panel **B′** are **SUPERSEDED**; they stay in the asset marked as such,
because they are the record of what shipped, not a live specification.

This also settles the door cleanly. The node's control cluster carries **`View` and nothing else**.

### The door

MOTIR-1351 specifies **select a node → the selected card's `View` button → a `Modal size="xl"` peek**,
and MOTIR-1352 shipped it for work-item nodes. The proposed node gains the same `View`, on **every**
op. A `modify` / `remove` peeks its **live target** — the already-shipped `WorkItemQuickView`,
unchanged. An `add` peeks its proposal.

### The body for an `add` — and the one difference forced by the model

The shipped work-item peek ends with a deliberate deferral:

> _"Explanation, child items, the full relationships / links panel, attachments, and the activity
> feed live on the **full page**."_

That is correct for a work item and **impossible for a proposal**: there is no per-item route
(`app/(authed)/plans/` holds `page.tsx` and `[id]/page.tsx`), and MOTIR-3070's sharpest finding is
that `explanationMd` is carried, diffed and materialized while nothing in the review surface reads it.
**So the proposal peek renders both bodies inline.** That is not a departure from _"the same as
viewing a normal card"_ — it is what the same experience means when the page the peek defers to does
not exist.

| Field                             | Rendered as                                                     | Composed from                                             |
| --------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| `descriptionMd`                   | `Description` section, **Markdown**                             | `.qv-section-label` + `.qv-desc` (the shipped peek)       |
| `explanationMd`                   | `Why this matters` section, **Markdown**, directly below        | the same pair — the item page renders the two as siblings |
| `kind` · `type`                   | rail rows with the shipped `IssueTypeIcon` + work-type chip     | `.qv-rail` `.rail-field`                                  |
| `priority`                        | rail row, shipped priority chip                                 | `.rail-field`                                             |
| `storyPoints` · `estimateMinutes` | one rail row each                                               | `.rail-field`                                             |
| `targetRepo` / `targetRepoRole`   | rail row, mono repo name; the ROLE when no name is pinned yet   | `.rail-field` + `design/work-items/repository-set.*`      |
| `executor`                        | rail row — _Coding agent_ / _Human_                             | `.rail-field`                                             |
| `explanationSource`               | a quiet `AI-drafted` marker beside the `Why this matters` label | the shipped provenance chip language                      |

**The head differs from the work-item peek only where the model has nothing to put there:** no
identifier (a proposal has none until it materializes — the `new` the node already shows), no status
pill (same reason), and no `Open full page →` (there is no page). The rail is read-only, as the
shipped peek's already is.

### After a decision

A **decided** plan is read-only per Part I, and the read view **stays available** on it — reading is
what a decided plan still supports, and it is how somebody later answers _what did we approve?_.

### a11y

`Modal` owns focus trap, `Esc` and the backdrop; the dialog is labelled by the proposal title. The op
badge carries **text**, not colour alone. `View` is an icon button with an `aria-label` that stops
propagation so a press cannot start a canvas drag — the same guard the shipped node's controls use.
Copy lives in the `planReview` namespace.

## 4. Tokens + primitives

Colour via the element/semantic tokens only, inlined here as light values exactly as
`quick-view.mock.html` does; no Tier-0 `--color-*`, no raw `rounded-md` / `p-2` / `h-9`. Everything
composes a shipped primitive — `Modal`, `Card`, `Pill`, `SectionLabel`, `IssueQuickViewPanel`,
`CoreFieldsPanel`, `IssueTypeIcon`. **No new primitive is introduced**; a genuinely new one would be
its own design subtask.

## 5. GIVES / TAKES sweep

`grep`ped this asset for every `MOTIR-<n>` it names, and read the result against MOTIR-3070's subtree
(the asset's key list says where to START; the subtree says where to STOP):

| Key                                             | Gives / takes                                                                              | Action                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------- |
| **MOTIR-3083**                                  | **GIVES** panel E — the parent chip, its states, and the rule that `isRoot` is not touched | none; its ACs already say this        |
| **MOTIR-3084**                                  | **GIVES** panel F — the door, the head's three differences, the field-by-field body        | none; its ACs already say this        |
| MOTIR-3070                                      | **GIVES** its two UI criteria a drawn answer                                               | none — the parent record is unchanged |
| MOTIR-1370                                      | neither — the edit modal is untouched and stays the only writer                            | none                                  |
| MOTIR-1351 / MOTIR-1352                         | neither — this composes the shipped detail-surface pattern and adds no second one          | none                                  |
| MOTIR-847 / MOTIR-850 / MOTIR-2982 / MOTIR-2985 | neither — cited as history / provenance                                                    | none                                  |

**One card is TAKEN from — MOTIR-3083, a STRUCTURE rather than an element** — and it was amended in
the same pass, per the design limb's rule that the design and the AC amendment ship together. Nothing
else in the subtree is invalidated: MOTIR-3084's read view is untouched by the Panel E redesign, and
MOTIR-3070's criterion 2 still holds (_distinguish, and name the parent_) — the level model satisfies
it by placement and breadcrumb rather than by a badge.

---

# Part VI — The DECIDED plan-review surface: the accepted / declined node treatments, and what the canvas pane holds after approve (MOTIR-3159 / bug MOTIR-3154)

**Amends Parts I–V's asset in place**: the same three files
(`design-notes.md` · `plans-surface.mock.html` · `plans-surface.png`), two new panels — **G** and **H**.
Nothing already drawn is redrawn. The three shipped `op` frames, Panel E's level model, Panel F's read
view, Part IV's status overline and Part III's attribution rows are all untouched and composed as they
stand.

| Surface                                         | Panel | Gates                  |
| ----------------------------------------------- | ----- | ---------------------- |
| The **accepted** / **declined** node treatments | **G** | MOTIR-3161             |
| What the canvas pane holds **after approve**    | **H** | MOTIR-3161, MOTIR-3162 |

## 0. The gap — a lifecycle drawn state by state, with no owner for the last state

Part I drew the generating state and the pending state. Part IV drew the status tag. Part V drew the
level model and the read view, and closed with one sentence about the state after a decision — _"a
decided plan is read-only per Part I, and the read view stays available on it"_ — which is true and is
not a specification of what the surface SHOWS.

So the decided state is the one nobody drew, and three separate cards each filled it locally, each
sensibly inside its own file:

- `declinePlan` **deletes** every `plan_item` row (`lib/services/plansService.ts:2068` →
  `planItemRepository.deleteByPlan`), so a declined plan's review model is `items: []` for ever.
- `PlanDetail` hands the **whole canvas pane** to `RepositorySetStep` whenever a repository set exists
  (`components/planning/PlanDetail.tsx:196-217`), and `approvePlan` proposes that set before
  materializing — so an ordinary approve creates the rows that then take the pane.
- `PlanItemNode` frames a card by **`op` alone** (`:74-80`), so there is no accepted or declined
  treatment to give it.

None of the three is wrong about its own file. Together they make the surface unable to show a
decision it has just taken. That is the shape MOTIR-3155 records, and drawing the whole lifecycle once
is what stops a fourth card from doing it again.

## 1. Drawn against SHIPPED reality — what was RENDERED first

Per the design-against-shipped-reality rule, and Part II §1's format. The real `PlanDetail` island was
bundled and rendered headless off `origin/main` `c57daef8` — the actual component, the actual
`packages/design-system/theme.css`, the actual `messages/en.json` — at 1440×820, `deviceScaleFactor: 2`,
light theme, in the three states below. The harness was deleted before the design lane was run; the
screenshots are attached to the pull request.

| State                                   | What the render SHOWS (not what the source suggests)                                                                                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planned` (the baseline)                | Four proposal nodes on the level in their three op frames; rail reads **Ready to review · 4 proposed items**, Approve / Decline beneath.                                                                                                                                                    |
| `approved` (+ a one-row repository set) | The canvas pane is **entirely** the establish step — _"YOUR PROJECT'S CODE / Motir will host your code"_, the it's-yours callout, **Continue** + _I already have code_. Rail reads **Approved · 4 proposed items · Added 4 items to your backlog**. The four cards are nowhere on the page. |
| `declined`                              | The pane holds the roadmap's own empty state — **"Nothing on the roadmap yet / Work items will appear here as the plan takes shape."** Rail reads **Declined · 0 proposed items**, with the correct outcome line _"Plan declined — your tree was left untouched"_ beneath it.               |

Two things only a render settles, and both shaped the panels below:

1. **The declined pane is not blank — it is confidently WRONG.** It reads _"work items will appear
   here as the plan takes shape,"_ which is the roadmap's empty copy addressed to a plan that has
   already finished. The rail says the right thing four inches away. So Panel G is not "fill an empty
   space"; it is "stop a correct component from being handed nothing to say".
2. **The rail is already RIGHT in both decided states.** `DecidedOutcome`
   (`components/planning/PlanReviewRail.tsx:323-`) renders _Added N items to your backlog_ with a
   `--el-success` `Sparkles`, and _Plan declined — your tree was left untouched_ with a neutral
   `--el-text-muted` `X`. **The outcome language this surface needs already exists on the page**, so
   Panel G borrows it rather than inventing a second one — which is why nothing below is new vocabulary.

## 2. What this composes — and does NOT redesign

| Composed                         | Real asset / component                                                                                 | What it owns — NOT re-drawn here                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| The three `op` languages         | Part I §3 Panel B · `components/planning/PlanItemNode.tsx:74-80`                                       | `add` dashed-accent, `modify` info-ring, `remove` muted-strike. **Untouched — Panel G crosses them, never joins them** |
| The canvas LEVEL model           | Part V Panel E · `components/planning/planLevel.tsx` · `PlanReviewCanvas.tsx`                          | Breadcrumb, the parent's real children, same-level `blocked_by` edges                                                  |
| The proposal READ view           | Part V Panel F · `ProposalQuickView.tsx`                                                               | The door, the body, its availability on a decided plan                                                                 |
| The rail's decided OUTCOME       | `components/planning/PlanReviewRail.tsx` `DecidedOutcome`                                              | _Added N items…_ / _Plan declined…_, the `--el-success` and neutral glyphs — **Panel G borrows this language**         |
| The establish STEP               | Story MOTIR-1775 · MOTIR-1782 · `components/planning/repositories/RepositorySetStep.tsx`               | Every pixel INSIDE the step. Panel H moves its container and changes nothing else                                      |
| The reserved dependency language | `design/roadmap/design-notes.md` — the red dashed + hatched cross-level anchor, dashed _not in sprint_ | Cited only to stay away from it (§3)                                                                                   |

## 3. Panel G — a DECIDED node: the outcome is a FOURTH AXIS that crosses the three ops

### Why it cannot be a fourth op

`op` and `outcome` are independent: every one of the three ops can be accepted and every one can be
declined, so there are **six** renderings, not four. A fourth member of the `op` set could only express
three of them. The outcome therefore has to ride on channels the op languages do not use at all — and
the op languages already consume border **style** (dashed vs solid), border **colour**, **fill**, the
**ring**, **opacity** and the **strike-through**.

### The two channels, and why they are free

**1. The op badge gains a second SEGMENT — the outcome word.** The shipped `OpBadge` sits at the top-left
of the node and carries the op in text already. A decided node fuses a second segment to its trailing
edge, so the chip literally reads _op × outcome_:

| chip                                      | segment 1 (the shipped op tone, unchanged)       | segment 2 (the outcome)                           |
| ----------------------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| `add · accepted`                          | `bg-(--el-accent)` / `text-(--el-accent-text)`   | `bg-(--el-tint-mint)` / `text-(--el-text-strong)` |
| `add · declined`                          | as above                                         | `bg-(--el-muted)` / `text-(--el-text-secondary)`  |
| `change · accepted` / `change · declined` | `bg-(--el-tint-sky)` / `text-(--el-text-strong)` | as the two rows above                             |
| `remove · accepted` / `remove · declined` | `bg-(--el-muted)` / `text-(--el-text-secondary)` | as the two rows above                             |

Shape: the fused chip keeps `--radius-badge` on its outer corners and `--spacing-chip-x/y` per segment;
the seam is a 1px `--el-border-soft` rule, not a gap.

**2. A solid 3px SPINE on the node's inline-start edge**, full height, inside the node's own border:
`--el-success` for accepted, `--el-text-muted` for declined. This channel is **verifiably unclaimed** —
`grep` for `border-l` / `border-s-` / a `w-[3px]` bar across `PlanItemNode.tsx`, `WorkItemNode.tsx` and
`ProjectRoadmapCanvas.tsx` returns nothing, and every reserved language in `design/roadmap/design-notes.md`
is either a border **style** (dashed _pending_, dotted _skippable_, dashed _upcoming_) or a red **chip**
(_blocked elsewhere_, _not in sprint_). A solid bar on the leading edge is neither.

Its two values are not chosen: they are the rail's own outcome colours one component down —
`--el-success` is the `Sparkles` on _Added N items to your backlog_, and the neutral is the `X` on _Plan
declined_. The node and the rail therefore say the same thing in the same colour, four inches apart.

### Non-collision, stated explicitly

- **Against the three op frames** — the spine is a solid fill inside the border; no op treatment paints
  the leading edge, and the chip's op segment is byte-identical to the shipped `OpBadge`. Adding the
  axis changes no existing pixel of any op.
- **Against the red dashed + hatched cross-level dependency anchor** — the spine is solid, neutral or
  green, on the node itself rather than an off-level stub, and carries no hatch.
- **Against dashed _not in sprint_ / dotted _skippable_ / dashed _upcoming_** — the axis touches no
  border style at all.

### State is carried by TEXT, not colour

The outcome word is IN the chip (`accepted` / `declined`), which is the whole of the meaning; the spine
is decorative reinforcement (`aria-hidden`) that makes the outcome legible at a zoom where 10.5px chip
text is not. Nothing is conveyed by colour alone, which is the a11y rule Part I §4 already holds this
asset to. And because the meaning is redundant in text, WCAG 1.4.11 does not bind on the spine — but
the values clear it anyway against every surface it can sit on.

### One signal that is FREE, and one that must not be faked

MOTIR-3160 keys a materialized `add` by its `plan_item.workItemId` and populates `identifier`. So an
**accepted `add` shows its real key** — `MOTIR-3166` — exactly where a pending one shows `new`, and it
lands ON the committed node rather than beside it as a keyless ghost. That is the strongest accepted
signal on the card and it costs no pixels.

A **declined `add` keeps `new`**, and must: it never became anything, and inventing a key for it would
be the surface asserting a work item that does not exist.

### States

- **Accepted `add`** — the op frame it had, the green spine, `add · accepted`, its real identifier and
  the target's live status pill (it is a work item now).
- **Declined `add`** — the op frame it had, the neutral spine, `add · declined`, still `new`, no status
  pill (there is no work item to have one).
- **Accepted `modify`** — the committed node, info ring, green spine, `change · accepted`; the diff
  overlay stays and now reads as history — what this plan changed, old → new.
- **Declined `modify`** — the committed node unchanged, neutral spine, `change · declined`, diff shown
  as what was proposed and refused.
- **Accepted `remove`** — muted frame + strike, green spine, `remove · accepted`. The target is archived;
  the strike is now a statement of fact rather than a proposal.
- **Declined `remove`** — muted frame + strike, neutral spine, `remove · declined`. **The strike is the
  one place a reader could be misled** — it says _will be archived_ about a card that was not. The chip's
  `declined` segment is what corrects it, which is why the outcome must never be colour-only here.
- **A decided plan whose target has since been archived or hard-deleted** (`targetMissing`) — unchanged
  from today; the decided axis adds nothing to a case Part I already covers.

### The level caption

The canvas's level caption (Part V Panel E's `Proposed by this plan`) becomes the plan's outcome, once,
above the level: **`Approved · 4 items added to your backlog`** / **`Declined · nothing was created`**.
Same primitive, same placement, one word of copy per outcome — so the page states the decision at a zoom
where no chip is readable. Copy lives in the `planReview` namespace, and every new `en` key owes its `zh`
counterpart (the per-card floor on MOTIR-3161 and MOTIR-3162).

## 4. Panel H — what the canvas pane holds after approve: **BOTH, STACKED — the step takes a band, not the pane**

### The decision, and the shipped one it re-opens

Story **MOTIR-1775** / **MOTIR-1782** decided this deliberately, and the shipped prop doc on
`PlanDetailProps.repositorySet` states the intent in its own words:

> _"Present → the canvas pane holds the ESTABLISH STEP instead of the proposals: once the plan has
> materialized, the canvas of proposals has served its purpose, and replacing it is the truthful use of
> the space."_

**That sentence is correct on its own premise, and this report overturns the premise rather than the
conclusion.** The premise is that the pane holds **proposals** — and a proposal genuinely is spent by
the decision that resolves it, so replacing it with the next task WAS the truthful use of the space.

After MOTIR-3160 and MOTIR-3161 the pane no longer holds proposals. It holds **the record of the
decision**: the accepted cards, on their real level, on the work items they became. A record is not
spent by the decision — it is _produced_ by it. So _"has served its purpose"_ stops describing what is
in the pane, and with it the reason for replacing it.

There is a second, sharper reason the two can share the space at all. **They are different kinds of
thing.** The establish step is a **task** — MOTIR-1782's own central claim is that its default path is
_one sentence, one primary, one quiet secondary_. The canvas is a **record**. A task and a record can
share a pane along the vertical axis; only two records compete for it. That is why replacing was
reasonable when the pane held a spent artifact and is not once it holds a record.

**So: BOTH, stacked.** The establish step keeps the TOP of the canvas pane, at its own natural height,
for as long as it is unanswered. The canvas takes the remainder and is **never replaced**. When the step
reaches its settled state it collapses to its shipped one-line form and the canvas has effectively the
whole pane — no extra rule needed, because the step's own design already shrinks.

**Nothing inside the step changes.** Panel H moves its container and touches no pixel of its content,
its copy, its primary, its secondary or its states. MOTIR-1782 keeps every decision it made about what
the step SAYS; what is re-decided is only whether saying it costs the user the thing they just approved.

MOTIR-3073 already trimmed this swap for a project that ARRIVES with code — the same sentence, stopped
half-way. This finishes it for a project that does not.

### The band

- Full width of the canvas pane, above the roadmap's search row, at the step's own natural height.
- `bg-(--el-surface)` with a `border-b border-(--el-border)` hairline; the pane's own
  `--radius-card` top corners are inherited, not re-declared.
- The canvas occupies the remainder with `min-h-0` so it can shrink rather than push the band out — the
  shrinking-list rule; the roadmap is pan/zoom and has never required the full pane.
- Below `1024px` the band and the canvas keep the same order; the step already wraps.
- **Declined** — no repository set is proposed, so there is no band at all, and the canvas has the pane.
  This panel changes nothing for a decline; Panel G is the whole of that state's fix.

### What the reader gets back

The render in §1 is the test: today an approve replaces four cards with a question. With the band, the
same approve shows _Approved · 4 items added to your backlog_ over four cards carrying their new keys,
with the repository question above them — the answer to _what did I just say yes to_ is on the surface
that asked it, which is the whole of MOTIR-3154's report.

## 5. Tokens + primitives

Colour via `--el-*` element/semantic tokens only — inlined in the mock as light values exactly as Parts
I–V do; no Tier-0 `--color-*`, no invented hue. Shape via the element-semantic tokens (`--radius-badge`
for the chip, `--radius-card` for the pane, `--spacing-chip-x/y`, `--el-border-soft` for the seam); no
raw `rounded-md` / `p-2` / `h-9`. Everything composes a shipped primitive — `PlanItemNode`, `OpBadge`,
`Pill`, `SectionLabel`, `PlanReviewCanvas`, `RepositorySetStep`. **No new primitive is introduced**; the
fused chip is the shipped `OpBadge` with a second segment, and the spine is a border on a box that
already exists.

## 6. GIVES / TAKES sweep

`grep`ped this asset for every `MOTIR-<n>` it names and read the result against MOTIR-3154's subtree
(the asset's key list says where to START; the subtree says where to STOP).

| Key                                                                       | Element / structure / premise                                                                                                              | Gives / takes                   | Action                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ----------------------------------------------------------------------- |
| **MOTIR-3161**                                                            | **ELEMENT** — Panel G's fused chip, the spine, the six states, the level caption; **STRUCTURE** — Panel H's stacked pane                   | **GIVES**                       | none; its criteria already say _"in the treatment the design decides"_  |
| **MOTIR-3162**                                                            | **STRUCTURE** — the workspace canvas keeps `review` after approve AND discard, so the same decided treatment has something to draw         | **GIVES**                       | none; its criteria are about the overlay surviving, which this presumes |
| **MOTIR-3160**                                                            | **PREMISE** — an accepted `add` keyed by `workItemId` is what lets the treatment land ON the committed node                                | **GIVES** (consumes, not takes) | none — this design depends on 3160, and 3161 already `blocked_by` both  |
| **MOTIR-3163**                                                            | **ELEMENT** — the E2E now has named things to assert: the chip's outcome word and the band's coexistence                                   | **GIVES**                       | none; its criterion is _the outcome ALONGSIDE the proposals_, satisfied |
| **MOTIR-3165**                                                            | neither — a decided plan's staleness verdict is an engine rule, and this draws no stale treatment                                          | neither                         | none                                                                    |
| **MOTIR-1775 / MOTIR-1782**                                               | **PREMISE** — their _replace the pane_ decision is re-decided here, in the open, to _stack_                                                | **TAKES**                       | **applied — see below**                                                 |
| MOTIR-3073                                                                | **PREMISE** — it trimmed the same swap one case at a time; this finishes the sentence rather than contradicting it                         | neither                         | none — its own case is unchanged                                        |
| MOTIR-1377                                                                | **PREMISE** — its `decided` short-circuit exists because a declined plan had no items; once it has them the guard stops shadowing anything | neither                         | none — removing it is MOTIR-3161's call, as that card's scope says      |
| MOTIR-3082 / MOTIR-3083 / MOTIR-3084                                      | neither — Panels E and F are composed as they stand                                                                                        | neither                         | none                                                                    |
| MOTIR-843 / MOTIR-847 / MOTIR-1370 / MOTIR-3070 / MOTIR-3074 / MOTIR-2985 | neither — cited as history / provenance                                                                                                    | neither                         | none                                                                    |

**The one TAKES, and how it is discharged.** MOTIR-1775 and MOTIR-1782 are both `done` and merged; their
acceptance criteria describe a step that shipped and still ships, and **not one of them is invalidated** —
the step's content, copy, states and behaviour are exactly as they specified. What this design takes is
narrower and is a PREMISE, not an element: _the step occupies the pane INSTEAD of the canvas_. Because
that premise lives in a shipped prop doc rather than in a criterion, the amendment owed is to the
**code comment that states it**, and that edit belongs to MOTIR-3161 — the card that opens
`PlanDetail.tsx`. It is named there so the re-decision cannot land as a silent edit: the comment must be
REPLACED with the stacked rule and a citation of this Part, never deleted.

## 7. Access path

Unchanged — the "Plans" left-nav entry → the Plans list → a row → the plan detail (Part I §5). A decided
plan is reached exactly as an undecided one is; the only difference is what the pane holds when you get
there, which is the subject of Panels G and H.

---

# Part VII — The Plans list, TABBED by status (MOTIR-3233 / Story MOTIR-3232)

**Its OWN asset**: `design/ai-planning/plans-tabbed-list.mock.html` + `plans-tabbed-list.png`,
four panels, plus this section in the area's shared `design-notes.md`.

**It does NOT amend `plans-surface.mock.html`, and that asset is not re-exported** — see _A design
result is a MOMENT_ above. What Part VII takes from it, it takes by CITATION: panel A's row shape
and panel A2's attribution entry are composed as drawn, and panel A2's rows are reproduced in
panel 2 so the decided-row change is diffable by reading the two files side by side.

It draws the `/plans` LIST surface and nothing else. The plan DETAIL is
[Part VIII](motir:cmt1lb9w600cci3phl3e3aysq)'s and the canvas's own behaviour is Part IX's; neither
is drawn here.

## 0. Why tabs, and why `Planned` is the default

The statuses are not categories somebody invented for a page — **they are the plan lifecycle**, and
each asks the reader a different question. `Planned` is _decide this_. `Generating` is _wait_.
`Approved` and `Declined` are _what happened_. A single reverse-chronological stream mixes all four,
so the one plan waiting on a decision sits below however many spinners the week produced — which is
the state the request came out of. **Defaulting to `Planned` is the surface saying what it is for.**

The tab set IS the shipped four-member `PlanStatus` enum. No member is added: the three histories
`declined` now covers stay a `decisionReason`, exactly as MOTIR-3189 decided.

## 1. What is UNCHANGED — composed, not redrawn

- **The row's own shape**: the 32px status icon-square, the title line, the meta line, the
  right-hand pill cluster, the accent border on a `planned` row awaiting review.
- **The status pills** and their tones; **the staleness flag**; the rule that status is carried by
  TEXT, not colour alone.
- **The left-nav access path** (Part I §5) and the row as a single `<Link>` into `/plans/[id]`. No
  new door.
- **The plan DETAIL surface entirely** — the canvas, the review rail, the history timeline, the
  approve / decline bar, the establish band.

## 2. Drawn against SHIPPED PIXELS — what was RENDERED first, and what it settled

Part III §2 bundled the real `PlanRow` with the real `messages/en.json` through a
`NextIntlClientProvider`, styled it with the real `app/globals.css` + `@motir/design-system` theme,
and screenshotted it headlessly before a word was written. The same was done here, adding the real
`Segmented` primitive and the real page header's markup, at **375 / 700 / 1200px in both themes**.
Four things that render settled, none of which is legible in the `.tsx`:

1. **The four-tab strip is 310.3px wide with labels alone** — segments 84.3 / 67.7 / 75.7 / 70.6 —
   **and 358.8px once each carries a count.** The width is INTRINSIC: identical at all three
   viewports, because the control is `inline-flex` and never stretches.
2. **The authed shell is `px-4` below `sm`**, so a 375px viewport gives the page a **343px** content
   box. `310.3 < 343 < 358.8`. **The labels fit and the counts do not**, by 15.8px — a real
   overflow, not a near miss. §4 is that disposition.
3. **At 375px the shipped header WRAPS.** `flex-wrap` drops the Plan-with-AI pill onto its own line,
   under a subtitle that has already wrapped to two. Removing that pill (§5) removes the wrap — a
   second reason for the removal beyond the duplication it exists to fix.
4. **A `planned` row's meta line already takes SIX lines at 375px** (138px tall) with title,
   item count, timestamp and attribution — while the same row is one line at 700px and above. The
   meta line is the phone-width pressure on this surface, which is exactly why §3 puts the second
   person INSIDE an existing entry rather than adding a fourth.

**And the mock reproduces the primitive to the pixel.** The asset's `.tabs` block measures **310.3px
and 358.8px, with segment widths 84.3 / 67.7 / 75.7 / 70.6 and 96.5 / 79.8 / 87.8 / 82.7** — the
same numbers as the real `Segmented` render, at every viewport. That agreement is what makes the
measurements in §4 readable off the asset rather than only off a throwaway harness.

## 3. A DECIDED row names BOTH people — this REVERSES Part III §3

**The superseded rule, quoted in full so the reversal is legible:**

> ### A DECIDED row shows the DECIDER, not the requester
>
> Panel A's rows 3 and 4 already end **`approved yesterday by Mara`** / **`declined 3 days ago by
Mara`** — the THIRD party, drawn since 843. A decided row that also gained a requester would
> therefore carry **two bare person names in one line**, and a reader cannot tell which one holds
> which role; it is the two-chips-read-as-one hazard applied to people.
>
> The rule that resolves it is also the one that matches how the list is read: **while a plan is
> UNDECIDED, _who asked_ is what you weigh — you are about to approve their request. Once it is
> decided, _who decided_ is the operative fact and the requester is history.**

**It is reversed, and the hazard it names is real.** What was wrong is the premise underneath it:
that the two names would land in the SAME entry. They do not have to.

**The decision: the two roles live in DIFFERENT meta entries, and the entry is what says the role.**

- **The DECIDER rides the WHEN entry**, where panel A has drawn it since 843 —
  `approved yesterday by Mara` — with the verb in front of it.
- **The REQUESTER rides the ATTRIBUTION entry**, behind its avatar, exactly as it does on an
  undecided row. Nothing about that entry changes: same avatar, same `·`, same agent half.

So an approved row's meta line reads
`8 items · approved yesterday by Mara · ⟨av⟩ Jonas · via Motir AI`, and no reader has to work out
which name is which: one is preceded by _approved … by_, the other by a face. **Part III's
three-entry cap is untouched** — the requester goes INSIDE entry 3 and adds no fourth entry, which
is why finding 4 above (six meta lines at phone width) does not get worse.

### ⚠️ And the other half of this Part is that the decider was NEVER BUILT

Part III recorded the gap in its own warning paragraph and left the rule standing on top of it:

> ⚠️ **`by Mara` is drawn in panel A and is NOT shipped.** `PlanRow` renders
> `t(view.whenKey, { when })` — _"approved yesterday"_, with no name.

So today's decided row names **nobody**: the rule was protecting a collision that could not occur,
because half of it did not exist. Part VII specifies **both** halves — the decider is drawn AND
built ([the decided-row card](motir:cmt1lba1600cgi3ph9crmidd1) owns it), and the requester comes
back.

### The decider is OPTIONAL, and row 8 is why

A plan the abandoned-plan sweep terminated is `declined` with **`decidedById` NULL** and
`decisionReason: 'abandoned'` (MOTIR-3236) — nobody decided it. Panel 2's row 8 draws that state:
`3 items · declined 2 days ago · ⟨av⟩ Mara · via Claude Code`, with **no `by` at all**. This is
Part III's own _absence, never a placeholder_ rule applied one axis over: no em-dash, no `Unknown`,
no greyed name. A `decidedById` that is null renders the plain
`aiPlanning.declinedAt` string the row uses today.

**Neither party is ever conveyed by colour or glyph alone.** Every one of them is a name; the
avatar is `aria-hidden` and the agent glyph is decorative, exactly as Part III §4 set them.

## 4. The TAB STRIP, per element — and its below-`sm` disposition

| element               | primitive / markup                                                                                | colour token                                                | shape / size                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| the strip             | the shipped **`Segmented`** (`packages/design-system/src/components/ui/Segmented.tsx`), unchanged | track `--el-tabnav-track`, border `--el-border`             | `--radius-btn`, 2px inset (`p-0.5`)                                   |
| one tab               | its `<button aria-pressed>` — a real button, keyboard-operable, announced as a toggle             | inactive ink `--el-text-secondary`; hover `--el-text`       | `--height-control`, `--spacing-control-x`, `calc(--radius-btn - 2px)` |
| the SELECTED tab      | the same button, `aria-pressed="true"`                                                            | fill `--el-page-bg`, ink `--el-text-strong`                 | `--shadow-subtle`                                                     |
| the count             | the primitive's own **`trailing`** slot (the notification drawer's unread count uses it)          | inactive `--el-text-secondary`; active `--el-tabnav-active` | `text-[11px] font-semibold tabular-nums`                              |
| the group's a11y name | `role="group"` + `aria-label`                                                                     | —                                                           | not rendered visually                                                 |

- **No raw hex, no Tier-0 `--color-*`, no raw `rounded-*` / `p-*` / `h-*`.** Every value above is a
  token the primitive already reaches for; the mock restates their VALUES only because it renders
  without the Tailwind build, as every asset in this area does.
- **The segment radius NESTS**: `calc(var(--radius-btn) - 2px)` against a 2px inset, so the control
  stays right when a style pills `--radius-btn`. That is the primitive's rule, not a new one.
- **How the selection is ANNOUNCED.** Each tab is a `<button aria-pressed>`, so a screen reader says
  _"Planned, toggle button, pressed"_. This is deliberately **not** an ARIA `tablist`: the panel
  below is not a tabpanel whose content is swapped client-side — the tab is a URL-addressable FILTER
  over a server-rendered list, and `aria-pressed` describes a filter honestly where `aria-selected`
  would promise a tabpanel relationship the DOM does not have. It is also what the shipped primitive
  already does everywhere else in the product (the board group-by, the Children List/Graph
  switcher), so the grammar is one grammar.
- **The URL carries the tab.** The strip's state is a query parameter, not component state, so a tab
  is linkable and survives a reload — [the tabbed-list card](motir:cmt1lba4800cji3phjm6pvixz) owns
  the parameter's name and its default.
- **Placement: BELOW the header, above the list.** It is a filter over the list, not a property of
  the page. In the header's right slot it would compete with the slot §5 just emptied, and it would
  break the reading order a screen reader takes: title → subtitle → filter → results.

### The below-`sm` disposition, MEASURED (panel 4)

| box                                           | strip            | verdict                   |
| --------------------------------------------- | ---------------- | ------------------------- |
| 343px (a 375px viewport − the shell's `px-4`) | 310.3px, labels  | **fits**, 32.7px to spare |
| the same 343px box                            | 358.8px, +counts | **overflows by 15.8px**   |
| 592px (a 640px viewport − `sm:px-6`)          | 358.8px, +counts | fits, 233px to spare      |

**So all four tabs keep their LABELS at every width, and the COUNTS render from `sm` up.** The
number decides it, not taste:

- **Not a horizontal scroller.** The fourth tab would sit off-screen on the one surface whose job is
  to show you which statuses exist — and `Declined`, the tab that would be hidden, is the one a
  reader reaches for when reconstructing what happened.
- **Not condensed to glyphs.** Four lifecycle states have no four icons a reader could tell apart;
  the status pills already carry glyphs and they are recognised BY their labels.
- **Not a `<select>` below `sm`.** A second control grammar for one breakpoint is two things to
  build, test and translate.
- **The counts are the right thing to drop** because they are an ORNAMENT on a filter: the number a
  tab promises is supplied by the result set the moment you press it. A count of **zero** still
  renders (`Declined 0`) wherever counts render at all — a tab that silently loses its number reads
  as a loading state, and the zero is a fact worth telling a reader before they press.

## 5. The header carries ONE Plan-with-AI entrance

`app/(authed)/plans/page.tsx` renders a `PlanWithAILauncher` in its header's right slot, and
`TopNav` renders one on every authed screen — two entrances to the same thing, a few hundred pixels
apart. **The page header's goes.** Panel 1 draws the header without it: `<h1>` + subtitle,
and nothing in the right slot.

**The EMPTY state's CTA STAYS.** `/roadmap`'s empty state carries the same one and the two must not
diverge; an empty page also has no populated surface for the top bar's entrance to sit in context
with, and the empty state is exactly where a first-time reader needs the door drawn for them.

## 6. Two EMPTINESSES, and they must not say the same thing

| state                        | when                                       | copy                                                        | CTA                         |
| ---------------------------- | ------------------------------------------ | ----------------------------------------------------------- | --------------------------- |
| **the project has no plans** | the unfiltered project holds zero plans    | `aiPlanning.emptyTitle` / `emptyDescription`, unchanged     | **Plan with AI** — retained |
| **this TAB has none**        | the project HAS plans, none in this status | `aiPlanning.tabEmpty.<status>Title` / `tabEmptyDescription` | **none**                    |

- **The whole-surface state is the shipped `EmptyState`, untouched** — same glyph, same strings,
  same CTA, reached exactly as it is today. **The tab strip is HIDDEN there**: there is nothing to
  filter, and four zeroes are four ways of saying the same thing.
- **An empty TAB keeps the strip above it** and offers no generate CTA. Repeating _Generate your
  first plan_ would be false on its face, and a generate CTA is the wrong answer to _nothing is
  generating_ — the reader's next move is a different tab, so the copy names where the plans
  actually are (_"Approved and Declined hold this project's history"_).
- **The strip is never hidden by an empty tab.** Hiding the control that got you there is how a
  reader gets stuck in a tab.

## 7. Copy — every string this Part introduces (namespace `aiPlanning`)

Both catalogues are owed — `messages/en.json` AND `messages/zh.json` (the zh-parity gate). The four
tab labels REUSE the shipped `aiPlanning.status.*` strings rather than adding a second set of words
for the same four states.

| key                        | en                                                                               |
| -------------------------- | -------------------------------------------------------------------------------- |
| `statusFilterAria`         | Filter plans by status                                                           |
| `tabEmpty.generatingTitle` | Nothing generating                                                               |
| `tabEmpty.plannedTitle`    | Nothing waiting on you                                                           |
| `tabEmpty.approvedTitle`   | Nothing approved yet                                                             |
| `tabEmpty.declinedTitle`   | Nothing declined                                                                 |
| `tabEmpty.description`     | This project's other plans are in the remaining tabs.                            |
| `decidedBy`                | {verb} {when} by {name} _(the existing `approvedAt` / `declinedAt` with a name)_ |

The decided-row string is a **variant of the shipped `approvedAt` / `declinedAt` keys, not a new
grammar**: `approved {when}` gains `approvedByName` → `approved {when} by {name}`, and the row picks
the plain key when `decidedByName` is null. That keeps the _absence, never a placeholder_ rule a
choice between two whole sentences rather than a name-shaped hole in one.

## 8. GIVES / TAKES

**TAKES — from other Parts and cards** (premises as well as elements):

- **Part III §3's _A DECIDED row shows the DECIDER_ rule — a PREMISE, and it is REVERSED** (§3).
  Amended on the record above, with the superseded text quoted and the reason it failed named.
- **Part III §4's inks, avatar and glyph treatment — an ELEMENT set, unchanged.** The requester's
  entry is byte-for-byte Part III's.
- **Part III's _absence, never a placeholder_ rule — a PREMISE, EXTENDED** to the decider (§3).
- **Part I panel A's `approved … by <name>` drawing — an ELEMENT**, which this Part finally makes
  buildable rather than aspirational.
- **Part I §5's left-nav access path and the row's `<Link>` — STRUCTURE, untouched.**
- **The page header's `PlanWithAILauncher` — a PREMISE removed** (§5): _the Plans page offers its
  own AI entrance_ stops being true. `TopNav`'s and the empty state's remain.
- **[MOTIR-2373](motir:cmsinu308000404la81khtv8y)'s below-`md` measurement discipline — a PREMISE**:
  a width claim is asserted only with a render behind it (§2, §4).
- **[MOTIR-3189](motir:cmt0sn4qq01hni2phocm94qwc)'s `decisionReason` decision — a PREMISE**: the tab
  set is the four-member enum and gains nothing.
- **[MOTIR-3236](motir:cmt1lba3600cii3phn69q6h8h)'s sibling — the null-decider STATE** row 8 draws
  (`decidedById` NULL on an abandoned plan).

**GIVES — to the cards built to this Part:**

- **[The tabbed, streamed list](motir:cmt1lba4800cji3phjm6pvixz)** takes the strip (§4), its
  primitive, its tokens, its a11y contract, its placement, the counts-from-`sm` rule, and both
  empty states (§6). It owns the URL parameter's name and the ten-a-page streaming this Part does
  not draw.
- **[The decided row](motir:cmt1lba1600cgi3ph9crmidd1)** takes §3 whole: the requester restored to
  the attribution entry, the decider BUILT into the when-entry, and the null-decider fallback.
- **[The header pill](motir:cmt1lba0000cfi3ph0gdrpk6n)** takes §5, including the explicit
  instruction that the empty state's CTA is retained.

## 9. What Part VII does NOT draw

The plan DETAIL surface and its List ↔ Canvas switcher (Part VIII); the canvas, its arrival level,
its breadcrumb and the Show-changes control (Part IX); the review rail; the establish band; the
left-nav entry itself; the row's own shape, its pills and its staleness flag; the ten-a-page
streaming mechanics and the scroll sentinel (drawn nowhere — they have no pixels of their own
beyond the list this Part already shows).

---

# Part VIII — The plan DETAIL: a LIST beside the canvas, and what a `generating` plan offers (MOTIR-3234 / Story MOTIR-3232)

**Its OWN asset**: `design/ai-planning/plan-detail-list-view.mock.html` + `plan-detail-list-view.png`,
four panels, plus this section in the area's shared `design-notes.md`.

**It does NOT amend `plans-surface.mock.html`, and that asset is not re-exported** — see _A design
result is a MOMENT_ above. Everything it composes from that asset — the canvas, the three `op`
languages, the decided node treatments, the establish band, the review rail — it composes by
CITATION, drawn there and not redrawn here.

It draws the `/plans/[id]` DETAIL surface and nothing else. The LIST surface is
[Part VII](motir:cmt1lb9t600cbi3ph3fd7qqkk)'s; the CANVAS's own behaviour — which level it arrives
at, the crumb for a proposed parent, and the **Show changes** control — is **Part IX**'s.

## 0. Why a list at all

A canvas is the right way to see **SHAPE**: where a proposal lands, what it hangs under, what blocks
what. It is a poor way to answer _"what exactly am I approving?"_, which is a question about a
**SET** — these cards get created, these get changed, this one gets archived. The work-item detail
already learned this and shipped a **List ↔ Graph** switcher on its Children section
(`design/work-items/child-panel-graph.*`, MOTIR-2284 / MOTIR-2285). **The plan detail is the same
reader asking the same question about a different tree, so it gets the same answer rather than a
second invention.**

**The list is a SECOND BODY in the same pane, never a re-drawing of the first.**

## 1. What this COMPOSES and must not redraw

`PlanReviewCanvas` / `ProjectRoadmapCanvas` / `WorkItemNode` / `PlanItemNode`; the three `op`
languages from Part I §3 panel B; the accepted / declined node treatments and the after-approve pane
from **Part VI**; the per-level drill-down and its breadcrumb; the review RAIL's whole layout; the
establish band. All composed as drawn.

### What it copies from the shipped List ↔ Graph grammar, and what it deliberately does differently

|                        | `child-panel-graph` (MOTIR-2284/2285)                            | Part VIII                                                                                                           |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| the switcher primitive | the shipped `Segmented`, `role="group"` + `aria-pressed`         | **same, unchanged**                                                                                                 |
| where it sits          | the section card's `headerRight` — a header that already existed | **a NEW 44px pane header**, because the canvas pane has none (§2)                                                   |
| which view is DEFAULT  | **LIST**, fixed                                                  | **conditional — Part IX's rule** (§2), cited not restated                                                           |
| the URL carries it     | `?children=graph`                                                | **yes**, same convention                                                                                            |
| the list body          | the SERVER-rendered `ChildList`, byte for byte                   | **its ROW grammar**, with the plan's own op language on top (§3)                                                    |
| the canvas box         | a fixed `h-[28rem]` inside a scrolling content column            | **not applicable** — the plan detail's pane is already a fitted two-pane workspace, and the canvas already fills it |

## 2. Panel 1 — the PANE HEADER and the switcher

**The pane had no header.** `PlanningWorkspace`'s `canvas` slot is filled edge to edge, and an
approved plan stacks the establish band above the canvas (Part VI §4). So a header had to be
DECIDED, not found.

**A 44px bar at the very top of the canvas pane, above the establish band.** `--el-surface`, a
bottom hairline (`--el-border`), `--spacing-control-x` gutters. It holds the switcher at its LEFT
and leaves its RIGHT end for Part IX's control.

**Why above the band, not between the band and the body:** the bar governs the BODY, and the band is
not part of the body. Part VI decided the establish step STACKS above the canvas rather than
replacing it; a control bar underneath the band would make the band read as chrome belonging to one
of the two views. Above both, it is the pane's own control bar, and the band keeps its position
relative to the body it precedes. **Nothing inside the step changes** — MOTIR-1782 keeps every
decision it made.

| element               | primitive                                                   | colour token                                      | shape / size                                                          |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| the pane header       | a `<div>` — new chrome, no primitive                        | `--el-surface`, bottom border `--el-border`       | 44px, `--spacing-control-x` gutters                                   |
| the switcher          | the shipped **`Segmented`**                                 | track `--el-tabnav-track`, border `--el-border`   | `--radius-btn`, 2px inset                                             |
| one option            | its `<button aria-pressed>`                                 | inactive `--el-text-secondary`, hover `--el-text` | `--height-control`, `--spacing-control-x`, `calc(--radius-btn - 2px)` |
| the SELECTED option   | the same button                                             | fill `--el-page-bg`, ink `--el-text-strong`       | `--shadow-subtle`                                                     |
| the group's a11y name | `role="group"` + `aria-label` = `planReview.viewSwitchAria` | —                                                 | not rendered                                                          |

- **No raw hex, no Tier-0 `--color-*`, no raw `rounded-*` / `p-*` / `h-*`.**
- **Both states are drawn** — panel 1 with `Canvas` selected, panel 2 with `List`.

### ⚠️ Part VIII does NOT decide which view is DEFAULT

**The default is a CONDITIONAL rule, and Part IX specifies it**: the canvas by default, the LIST
when the plan's proposals straddle more than one container. That condition is a statement about the
plan's SHAPE, and Part IX is the Part that reasons about shape. **Part VIII cites it and does not
restate it**, so the two Parts cannot drift into two answers. What Part VIII owns is everything
else about the control: its placement, its primitive, its tokens, its selected treatment, its
accessible group name, what it does to the establish band (nothing), and what **both** of its states
look like — which is why both are drawn.

### The place Part IX's control occupies

**The right end of the pane header, opposite the switcher.** Panels 1 and 2 draw it as a dashed
placeholder carrying Part IX's mark, in both frames. Its behaviour, treatment and states are Part
IX's to specify; Part VIII specifies only WHERE it goes, so the pane's chrome is decided once
rather than twice. Leaving it undrawn is how a pane ends up with two control bars.

## 3. Panel 2 — the LIST body, per row and per FIELD

**The row is the shipped `ChildList` row grammar** — kind glyph (`IssueTypeIcon`, its
`--el-type-*` hue), identifier, title, a facts line, a right-hand chip — so a reader who has read
the Children list has read this one. Shape routes through `--radius-control` /
`--spacing-control-x|y`, exactly as that row does.

| element           | reads                                                                         | primitive / treatment                                                                                          |
| ----------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| the kind glyph    | `kind`                                                                        | `IssueTypeIcon`, `--el-type-{epic,story,task,bug,subtask}`                                                     |
| the key           | `identifier`                                                                  | the row's monospace key, `--el-text-muted`; **`no key yet`** in `--el-text-faint` for an un-materialized `add` |
| the title         | `title`                                                                       | the row's title ink, single-line ellipsis                                                                      |
| the facts line    | `kind` · `type` · `storyPoints` · `estimateMinutes` · `targetRepo`            | `--el-text-secondary`, the row's own `text-xs`                                                                 |
| where it lands    | `parentIdentifier` / `parentTitle`, or `parentNodeId` naming another proposal | `under <b>…</b>`; an INTRA-PLAN parent is marked _(proposed)_                                                  |
| the live status   | `statusLabel` / `statusCategory`                                              | the shipped `StatusPill` — only where the row HAS one (never an `add`)                                         |
| the op            | `op`                                                                          | panel B's own `add` / `modify` / `remove` chips, unchanged                                                     |
| the stale flag    | `stale` / `staleReasons`                                                      | the row's shipped warning `Pill`, as the rail draws it                                                         |
| a `modify`'s diff | `changes[]`                                                                   | §3's two-line text form, below                                                                                 |

- **An `add` has NO KEY, and the list says so rather than leaving a gap.** `identifier` is null until
  approve materializes it. An empty slot in a column of keys reads as a missing value; `no key yet`
  reads as the fact it is. (`--el-text-faint` is legitimate here — it is a LABEL about absence
  beside a value the row also carries in words, and the row's meaning does not depend on it. Where
  it must carry meaning alone, use `--el-text-secondary`.)
- **A `modify`'s diff is TWO-LINE TEXT, per changed field — deliberately NOT the canvas's inline
  overlay.** The canvas overlay answers _this node is changing_, inside a node card ~280px wide: it
  is a SIGNAL. The list answers _changing to WHAT_, at the full width of the pane, for a reader
  deciding whether to approve. So **the list is the only surface that spells a change out and the
  canvas is the only surface that marks a node** — neither is built twice.
  - the field NAME in the row's monospace label ink; the OLD value struck through in
    `--el-text-muted`; an arrow in `--el-text-faint` (`aria-hidden`, decorative); the NEW value in
    `--el-text-strong` at `font-semibold`.
  - **A field whose new value is a BODY (`description`, `explanation`) is NAMED, not quoted** —
    _"rewritten — open the card to read it"_. A rewritten description is not a diff a review list
    can carry, and a truncated one is worse than a pointer.

### ⚠️ What the list says about a `remove` — DECIDED: a THIRD SECTION

A plan holds three ops. **A list showing two of them, under a row whose item count counts all
three, is a surface that contradicts itself** — and the count is on the row that got the reader
here. The request named _the cards it adds and the cards it updates_ because those are the two a
plan usually holds, not as an enumeration of what a list may show.

**So the list renders three sections — `Adds` · `Updates` · `Archives` — each appearing only when
it is non-empty, and the plan's item count keeps its WHOLE-PLAN scope**, which is truthful because
the list now covers the whole plan. An archived row takes panel B's own `remove` treatment: struck
title, muted ink, the archive chip — **nothing red, dashed or hatched**, because archive is
reversible and red-hatch stays reserved for the canvas's cross-story dependency signal.

Rejected: a one-line footnote (_"and 1 card will be archived"_) — it makes the one destructive op
the only one you cannot see; and a count that names its own scope (_"13 of 14"_) — it fixes the
arithmetic and leaves the reader unable to find the fourteenth.

### States

| state       | what it draws                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **empty**   | _No proposals_ — a plan that finished proposing nothing, with the one sentence that matters: _nothing will change if you approve it_ |
| **loading** | the canvas's own centred `Spinner`, in the same box. No second skeleton: the pane has already painted                                |
| **DECIDED** | the list is a **RECORD**, reconciled with Part VI in one sentence — see below                                                        |

**The DECIDED list, reconciled with Part VI.** Part VI decided the canvas pane holds the RECORD of
what was accepted rather than a set of proposals; **the list is the same pane's other body, so it
says the same thing in the same tense** — `Created` / `Applied` / `Archived` rather than
`+ add` / `change` / `archive`, and every row that has a key now shows one. A **declined** plan's
list keeps the proposal tense and adds no outcome chip: nothing happened to those cards.

## 4. Panel 4 — what a plan still GENERATING offers

`plansService.declinePlan` accepts a `generating` plan and records
`decisionReason: 'discarded'` (MOTIR-3189). `PlanReviewRail` renders its Decline button with
`disabled={!planned}` and the hint `reviewLocked`. **The valve exists and has no door** — and the
two plans this story was written about sat at `generating` for the better part of a day with a
control that could have ended them, greyed out.

| decision                                                       | the answer, and why                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **the control**                                                | the rail's SECOND button, in the decision bar where Decline is today — same place, same size, `Button variant="secondary"` (a real affordance, not a ghost: it is the only live control in this state)                                                                                                                                                 |
| **the label**                                                  | **`Discard this plan`**, not _Decline_. Declining is what you do to a finished proposal you have read; a plan that never finished is not being rejected on its merits, it is being ENDED. `Plan.decisionReason` already tells the two apart on the row (`discarded` vs `reviewed`); the button is where a reader learns which one they are doing       |
| **does it confirm?**                                           | **YES.** The shipped `Modal` at `size="sm"` — the same one the stale-approve confirm uses. Approve confirms when items are stale, and this is sharper: the action is irreversible from this surface and the plan is still moving                                                                                                                       |
| **what the confirm says about the proposals already appended** | it NAMES them: _"It has **3 proposals** so far and is still being written. Discarding ends it now and keeps the proposals as a record — nothing in your backlog changes, and nothing is created."_ The count is the one fact that tells the reader what they are throwing away, and the second half is the reassurance the whole substrate is built on |
| **what replaces `reviewLocked`**                               | _"Approve unlocks when generation completes. Discarding ends it now — nothing in your backlog changes."_ The old hint (_"Review & Approve unlock when generation completes"_) was true of both buttons and is now true of one; **a hint under two buttons that describes only one is how the live control reads as disabled too**                      |
| **who may press it**                                           | UNCHANGED — `ai:decide_plan`, exactly as it gates approve. A reader without it sees the rail without the control, as they do today                                                                                                                                                                                                                     |

**Approve stays disabled.** Nothing about this widens what may be approved: a plan that has not
finished generating is not a plan anybody should be materializing, and that is the half of
`reviewLocked` that was always right.

## 5. Copy — every string these panels introduce (namespace `planReview`)

Both catalogues are owed — `messages/en.json` AND `messages/zh.json` (the zh-parity gate).

| key                                            | en                                                                                                                                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viewSwitchAria`                               | Plan view                                                                                                                                                                                                         |
| `viewList`                                     | List                                                                                                                                                                                                              |
| `viewCanvas`                                   | Canvas                                                                                                                                                                                                            |
| `listAdds`                                     | Adds                                                                                                                                                                                                              |
| `listUpdates`                                  | Updates                                                                                                                                                                                                           |
| `listArchives`                                 | Archives                                                                                                                                                                                                          |
| `listCreated` / `listApplied` / `listArchived` | Created / Applied / Archived                                                                                                                                                                                      |
| `listNoKey`                                    | no key yet                                                                                                                                                                                                        |
| `listProposedParent`                           | (proposed)                                                                                                                                                                                                        |
| `listBodyRewritten`                            | rewritten — open the card to read it                                                                                                                                                                              |
| `listEmptyTitle`                               | No proposals                                                                                                                                                                                                      |
| `listEmptyBody`                                | This plan finished without proposing anything. Nothing will change if you approve it.                                                                                                                             |
| `discardCta`                                   | Discard this plan                                                                                                                                                                                                 |
| `discardHint`                                  | Approve unlocks when generation completes. Discarding ends it now — nothing in your backlog changes.                                                                                                              |
| `discardConfirmTitle`                          | Discard this plan?                                                                                                                                                                                                |
| `discardConfirmBody`                           | It has {n, plural, one {# proposal} other {# proposals}} so far and is still being written. Discarding ends it now and keeps the proposals as a record — nothing in your backlog changes, and nothing is created. |
| `discardConfirmCancel`                         | Keep generating                                                                                                                                                                                                   |
| `discardConfirmCta`                            | Discard plan                                                                                                                                                                                                      |

## 6. GIVES / TAKES

**TAKES** (premises as well as elements):

- **Part VI §4's _the establish step STACKS above the canvas_ — a PREMISE, honoured**: the pane
  header goes ABOVE the band precisely so that relationship is not disturbed (§2).
- **Part VI's _the decided pane holds a RECORD_ — a PREMISE, EXTENDED to the list** (§3's decided
  state), which is why the list changes tense rather than greying out its op chips.
- **Part I §3 panel B's three `op` languages — an ELEMENT set, unchanged.** The list introduces no
  fourth language for the same three facts.
- **[Part IX](motir-ref:cmt1ui496002zi1n8qe3uzt1k)'s _which view is DEFAULT_ — a PREMISE this Part
  DOES NOT DECIDE** (§2). Part IX also TAKES this Part's pane-header slot for its Show-changes
  control — a STRUCTURE this Part reserves and labels.
- **`PlanReviewRail`'s _a plan that is not `planned` offers nothing_ — a PREMISE, REVERSED for one
  control** (§4). It was true when nothing could act on a `generating` plan; MOTIR-3189 made that
  false and the rail did not follow.
- **MOTIR-2284 / MOTIR-2285's List ↔ Graph grammar — STRUCTURE**, cited in §1's table with what is
  copied and what is deliberately different.
- **`ChildList`'s row — an ELEMENT**, composed rather than redrawn.

**GIVES:**

- **[The plan-detail list view](motir:cmt1lba2700chi3phgktf5gn8)** takes §2's pane header and
  switcher and §3 whole: the row per field, the `modify` diff form, the three sections, and the
  empty / loading / decided states. It takes the DEFAULT rule from **Part IX**, not from here.
- **[The discard valve](motir:cmt1lba3600cii3phn69q6h8h)** takes §4 whole: the control, its label,
  its confirm, the replaced hint, and the unchanged permission.
- **Part IX** takes the pane-header slot (§2) and owes the control that fills it.

## 7. What Part VIII does NOT draw

The canvas and its node treatments; **which level the canvas arrives at**; **the breadcrumb crumb
for a PROPOSED parent**; **the Show-changes control's own behaviour and treatment** — all three are
Part IX's. Also: the drill-down, the review rail's layout, the establish step's own content, the
approve/decline flow for a `planned` plan, and the `/plans` list surface (Part VII).

---

# Part IX — The plan-detail CANVAS at arrival, and SHOW CHANGES (MOTIR-3259 / Story MOTIR-3232)

**Its OWN asset**: `design/ai-planning/plan-canvas-arrival.mock.html` + `plan-canvas-arrival.png`,
four panels, plus this section.

Part VIII gave the plan-detail pane a second BODY. **Part IX is the first body's BEHAVIOUR** — what
the canvas does when it opens, and one control it does not have.

**It draws NO new surface.** `/plans/[id]` is reached exactly as Part I §5 draws it — the left-nav
_Plans_ entry, then a row — and this Part adds no entrance. It does not amend
`plans-surface.mock.html`; the canvas, its node cards and the three `op` languages are composed as
that asset draws them.

## 0. The CONTRACT this Part must design to

`ProjectRoadmapCanvas` (MOTIR-1194) is the reusable foundation five surfaces mount, driven by
`PlanningCanvas`. Its shape constrains what may be drawn here:

- **PRESENTATIONAL and PER-LEVEL.** It owns no fetching; the consumer supplies `loadLevel(parentId)`
  and it renders exactly one level. **A panel that drew the whole proposed tree at once would be
  un-buildable against it** — so whatever Show changes does, it does to the level in view (§L5 is
  that consequence, faced rather than worked around).
- **It ARRIVES where the consumer tells it**, via `initialTrail` — read ONCE at mount, a seed and not
  a controlled level. Panel 1 is a decision about that seed and never about hijacking navigation.
- **The breadcrumb** is the trail plus a root crumb the consumer labels (`roadmap.canvas.breadcrumbRoot`,
  bug MOTIR-3152).
- **The top-right cluster** holds the search box and the full-screen toggle, gated on `searchable` /
  `fullScreenable`. §L1 is what this Part does about a third control wanting chrome.

## 1. Panel 1 — WHERE THE CANVAS ARRIVES

### The defect, read on `origin/main` @ `b820c979`

Two shipped facts meet, and each is right on its own:

1. `arrivalLevel(items)` counts proposals per parent and takes the largest — but its loop opens
   `if (!item.parentNodeId || !item.parentIdentifier) continue;`.
2. `planReviewService.getPlanReview` sets `parentIdentifier` (with `parentTitle`, `parentKind` and
   `parentTrail: []`) to **null for an intra-plan `planItem:` parent** — deliberately, because
   _"an intra-plan parent already has a node in the proposed set, so the canvas draws it and the
   breadcrumb does not."_ **`parentNodeId` IS populated** for those items.

**So (1) discards exactly the items (2) describes.** A plan proposing one story under a committed
epic plus five subtasks under that story counts ONE edge and opens on the **epic**, drawing the
proposed story as one card among its committed siblings. Panel 1 draws that BEFORE beside the AFTER,
because the change is invisible in a single frame.

### The five decisions

1. **The arrival rule.** The canvas opens on the level the plan most FILLS, counting proposals under
   PROPOSED containers as well as committed ones — i.e. count `parentNodeId` for every proposal.
   **What this changes:** the plan that proposes a container AND its contents, which is the shape an
   agent-authored skeleton produces almost every time. **What it does not:** a plan of pure roots
   still opens at the top level; a plan whose proposals all sit under one committed parent still
   opens there.
2. **The TIE-BREAK is the DEEPER level.** One story under an epic plus one subtask under that story
   is 1–1, and the shipped code keeps whichever level the `Map` yielded first — an accident, not a
   decision. Prefer the deeper: **a reviewer wants to land where the work is, and the shallower level
   is one Back away while the deeper one is a drill they must first discover.** Depth is the length
   of the arrival trail, which the same pass already builds.
3. **The CRUMB for a proposed parent — `New · <title>`.** A committed crumb is `KEY · Title`
   (`workItemCrumbLabel`); an un-materialized `add` has `identifier: null` **by construction**, and a
   placeholder key (`MOTIR-?`, `#new-3`) would assert a work item that does not exist — on the one
   surface whose whole promise is that nothing is real until approve. So the crumb keeps the grammar
   and puts the WORD `New` in the slot the key would occupy. **The distinction is TEXT first**, with
   the accent ink, the dashed border and the `+` glyph as second and third channels — never colour
   alone.
4. **A level that is ENTIRELY proposed.** Drilling into a proposed container asks the roadmap for the
   children of an id no work item has; `fetchRoadmapLevel` is best-effort and resolves an empty
   committed level, so the proposals render alone. That is correct and looks like nothing else on
   this surface, so **the level caption says why** — in the shipped `lvlcap` slot — and an
   empty-looking canvas is not read as a failed load.
5. **The DEGRADE.** An archived or hard-deleted ancestor gives `parentTrail: []` beside a non-null
   `parentNodeId`, and the shipped code already degrades to one synthesised crumb. When the parent is
   ITSELF proposed there is no committed chain to synthesise from at all, so the trail is the
   canvas's own ROOT crumb plus the proposed crumb. **The canvas never arrives with no breadcrumb**,
   and Back always leads somewhere real.

## 2. Panels 3–4 — SHOW CHANGES

### §L1 · Placement — the CANVAS's own cluster, and Part VIII's reserved slot is RELEASED

**Part VIII reserved the right end of its new pane header for this control, and Part IX does not take
it.** The toggle goes in `ProjectRoadmapCanvas`'s **top-right cluster**, beside the search box and
the full-screen button. Three reasons, in order:

- **It acts on the canvas's nodes and belongs adjacent to what it changes.** The pane header sits
  above a body that may be the LIST, where this control means nothing.
- **It must not exist in the list view**, and the canvas's own cluster gets that for free — no
  conditional chrome in a header that belongs to both bodies.
- **The emphasis state lives in the foundation.** The prop carrying the emphasised ids is
  `ProjectRoadmapCanvas`'s (opt-in, defaulting to absent, exactly as `searchable` / `fullScreenable`
  / `locatable` are); a control in a different component would have to lift that state out of the
  component that owns it.

**Part VIII's panel 1 draws a dashed placeholder in the pane header labelled for this Part. That
placeholder is not built.** It is recorded here rather than by re-exporting Part VIII's asset — that
asset records the moment it was drawn, and this note is the correction a reader needs (see _A design
result is a MOMENT_). The pane header therefore holds the switcher alone.

**Per element:** the shipped full-screen button's shell — `--el-surface` fill, `--el-border`,
`--radius-btn`, `--height-control`, `--shadow-card` — widened for a label, because this control has
no icon a reader could guess. Resting ink `--el-text-secondary`; ACTIVE takes `--el-accent-soft` fill,
`--el-accent` border and `--el-accent` ink; DISABLED is the same shell at reduced opacity. A real
`<button>` carrying `aria-pressed`. **No raw hex, no Tier-0 `--color-*`, no raw `rounded-*` / `p-*` /
`h-*`.**

### §L2 · The SET, and why it is orthogonal to the op languages

**Every proposal on the level in view, whatever its `op`** — `add`, `modify` and `remove` alike,
which is what the request's _added / updated / archived_ names. A `modify` or `remove` shares its node
id with the committed card it targets, so the ring lands ON that card rather than beside it.

**The op languages from Part I §3 panel B stay exactly as they are: they say WHICH change this is,
and the emphasis says THAT there is one.** They are orthogonal, and neither is an alternative to the
other — a build card must not read this as a choice.

### §L3 · The treatment — the SHIPPED ring and the SHIPPED dim

`ProjectRoadmapCanvas`'s node wrapper already rings a selected or search-matched node
(`ring-2 ring-(--el-accent) ring-offset-2 ring-offset-(--el-surface-soft)`) and already dims
everything outside the connected set (`opacity-35`). **Show changes applies that same pair to a SET.**
One ring value, one dim value, one vocabulary; no second highlight language.

**The dim stays at the shipped 35%, not lower.** A committed sibling is on this canvas for a reason —
_"seeing the company a proposed card will keep is most of what 'is this the right place for it?'
means"_ (`planLevel.tsx`) — so dimming it to invisibility would defeat the level the emphasis exists
to read.

### §L4 · A live SELECTION WINS, and the toggle stays pressed

Selecting a card already dims everything unconnected to it, and both mechanisms write the same
`connectedIds`-shaped state. Layering them gives three opacity tiers and no legible meaning. So the
**selection wins for as long as it lasts** — a proposed card outside the selection's connected set is
dimmed like any other. The toggle stays `aria-pressed`, so clearing the selection restores the
emphasis rather than making the reader re-arm it. **A selection is a momentary act; the toggle is a
mode, and a mode should survive one.**

### §L5 · The plan's cards that are NOT on this level — a COUNT, and no navigation

The canvas is per-level; a plan spread over three parents has most of itself off-screen. **The control
reads `3 of 11` whenever the level holds fewer than the plan's total, and stops there.** It offers no
way to reach the rest, deliberately: **the way to the other eight is Part VIII's LIST**, which is the
whole reason that body exists. A second navigation affordance here would be a worse answer to the
same question, in the pane that already has the better one.

### §L6 · The degenerate levels

- **A level with NO proposals** (the reviewer drilled elsewhere): the toggle is **disabled**, with
  `title` and accessible description _"No proposed changes on this level"_. An ON state would dim
  every card and ring none — a screen that says nothing, which is worse than a control that says why
  it cannot help.
- **A level that is ENTIRELY the plan's**: enabled, and ON simply rings everything with nothing to
  dim. Correct and harmless, not special-cased, and the count reading `4 of 4` is the honest thing to
  say about it.

### §L7 · A DECIDED plan — the control SURVIVES, in the past tense

Part VI made this pane a RECORD after the decision. **"What did this plan change?" is a better
question after approve than before** — the cards are real now and sit among neighbours that were
always there — so the control stays and its label moves to the past tense (_Show what changed_). On a
DECLINED plan it stays too, reading the same: the record is of what the plan _would_ have changed, and
the reader is asking the same thing.

### §L8 · a11y and motion

The toggle is a real button carrying `aria-pressed`, so its state is announced rather than inferred
from its fill; disabled, it carries the reason as its accessible description. **The emphasis is never
colour alone** — a ringed node also carries its own `op` badge, which is TEXT (`add` / `change` /
`archive`), and the dim is a second non-hue channel. And because turning this on changes the opacity
of most of the screen at once, **the transition is dropped entirely under
`prefers-reduced-motion: reduce`**: the state changes instantly rather than fading.

## 3. The conditional DEFAULT VIEW — the rule Part VIII defers to this Part

**The canvas by default; the LIST when the plan's proposals sit under MORE THAN ONE distinct
parent.**

- **What counts as a container:** a distinct `parentNodeId`, whether that parent is committed or
  itself proposed. **`null` — a root proposal — counts as ONE container, the top level**, so a plan of
  pure roots has exactly one and opens on the canvas.
- **Why:** a straddling plan has no single level that can show it, and the canvas shows one level at a
  time. Opening on it is the surface insisting on a view that structurally cannot answer the question.
  The list already exists by then, and making it the default in that one case is the cheapest of the
  three fixes here and the one that admits the most.
- **The switcher itself is Part VIII's.** This Part decides only which option is preselected — and
  Part VIII cites this section rather than restating it, so the two cannot drift into two answers.
- **The URL contract is unchanged:** the default writes a CLEAN url with no parameter, whatever the
  default is, so every existing `/plans/[id]` link stays byte-identical.
- **The default is a SEED, read once.** A `generating` plan can cross the one-container threshold
  while a reviewer is looking at it; a later poll must never move them between views.

## 4. The workflow spec this Part draws to — the three build cards

The card required these to be read, not inferred, and this is which behaviour came from which:

| behaviour                                                                                                    | card                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the arrival level, the tie-break, the proposed crumb, the trail synthesis and the degrades                   | **MOTIR-3260** — _the plan canvas OPENS on the level the plan actually fills_, which also ships a pure container-spread module (`planShape`) beside `lib/planning/planReview.ts` |
| the emphasis, its opt-in prop on the foundation, the set, the reset on level change, and the off-level count | **MOTIR-3261** — _SHOW CHANGES on the plan canvas_                                                                                                                               |
| the derived default view                                                                                     | **MOTIR-3262** — _a plan whose proposals STRADDLE containers opens in the LIST view_, which reads the container count from that same module and re-derives nothing               |

Two constraints those cards state that this Part has honoured rather than contradicted: the emphasis
prop is **opt-in and the foundation's four other consumers are byte-unchanged**, and the container
count has **exactly one implementation**, in that module, which both the arrival level and the
default view read.

## 5. Copy — every string these panels introduce

Both catalogues are owed (the zh-parity gate). **The namespace splits on WHO owns the string**, which
is the same line the opt-in prop draws:

| key                | namespace        | en                                                                   | why this namespace                                                                      |
| ------------------ | ---------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `showChanges`      | `roadmap.canvas` | Show changes                                                         | the control lives on the FOUNDATION, which has five consumers                           |
| `showChangesPast`  | `planReview`     | Show what changed                                                    | the past tense is a fact about a decided PLAN, which the foundation knows nothing about |
| `showChangesNone`  | `roadmap.canvas` | No proposed changes on this level                                    | the disabled reason, said by the control                                                |
| `showChangesCount` | `roadmap.canvas` | {n} of {total}                                                       | the count, said by the control                                                          |
| `proposedCrumb`    | `planReview`     | New                                                                  | the key-slot word on a proposed crumb — plan-specific                                   |
| `allProposedLevel` | `planReview`     | Nothing committed here yet — every card on this level is this plan's | the level caption                                                                       |

**The foundation cannot name what "the plan's changes" ARE** — it has no idea it is showing a plan —
so the strings it renders are generic and the plan-specific ones are passed in. That is the same
reason the emphasised ids are a prop rather than something the canvas derives.

## 6. GIVES / TAKES — swept over the story SUBTREE

**TAKES** (premises as well as elements):

- **Part VIII's _which view is DEFAULT_ deferral — a PREMISE.** Part VIII states the default is a
  conditional rule and cites this Part; §3 is that rule.
- **Part VIII's reserved pane-header slot — a STRUCTURE, RELEASED not consumed** (§L1). Part VIII's
  asset draws a placeholder there that is not built; recorded here, with that asset left frozen.
- **Part VI's _the decided pane holds a RECORD_ — a PREMISE, EXTENDED** (§L7): the control survives
  the decision and changes tense.
- **Part V panel E's _a proposal is a normal card on its parent's level_ — a PREMISE this Part
  completes.** Part V made the level right; Part IX makes the ARRIVAL right, which is the same
  argument one step earlier.
- **Part I §3 panel B's three `op` languages — an ELEMENT set, untouched and explicitly orthogonal**
  to the emphasis (§L2).
- **Part I §5's access path — a STRUCTURE, cited.** This Part adds no entrance.
- **`ProjectRoadmapCanvas`'s selected / search-matched ring and `opacity-35` dim — ELEMENTS, reused
  verbatim** (§L3), and its `initialTrail` read-once contract — a PREMISE (§0).
- **MOTIR-3152's breadcrumb-root fix — an ELEMENT** the degrade in §1.5 leans on.

**GIVES:**

- **MOTIR-3260** takes §1 whole: the rule, the tie-break, the crumb, the all-proposed level and both
  degrades.
- **MOTIR-3261** takes §L1–§L8: placement, the prop's shape, the set, the treatment, the selection
  interaction, the count, the two degenerate levels, the decided-plan label and the a11y/motion line.
- **MOTIR-3262** takes §3: the rule, what counts as a container, the pure-roots case, and the
  seed-not-controlled property.
- **Part VIII** gets its reserved slot back, and its switcher stands alone in the pane header.

## 7. What Part IX does NOT draw

The node treatments and the three `op` languages; the drill / Back / search / zoom / full-screen
mechanics; the List ↔ Canvas switcher and the list body (Part VIII's); the review rail; the establish
band; the `/plans` list surface (Part VII's); and any new entrance to this surface.

---

## The streaming allocation at ARRIVAL — `/plans` and `/plans/[id]` (MOTIR-3442)

Part of [MOTIR-3440](motir:cmt8s085i003li1ph06u469kx)'s sweep of the 24 heavy authed surfaces. The
rule this applies is `design/shell/design-notes.md` § _The navigation-pending grammar_ →
_WHICH SURFACES EARN A FRAME_, and the three-tier method is
`design/work-items/design-notes.md` § _The item page at ARRIVAL_'s. **Neither is restated here.**
Measured against `origin/main` `9455fc3c`.

### `/plans` — the list

|                            |                                                                                                                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **the gate**               | `searchParams` → `getSession` → `getTranslations('aiPlanning')` → `getActiveProject` → `getCapabilities` (`canBrowse`)                                                                                                                                          |
| **with the frame**         | the `<h1>`, and the status tab strip — the tabs are static route links, not derived from any read                                                                                                                                                               |
| **with the first content** | `Promise.all([listPlans, countPlansByStatus])`, then `buildPlanRowViews(firstPage.plans)`, which **depends on the first** and so is a genuine second wave; the rows and the per-status counts land together                                                     |
| **after the page**         | — nothing                                                                                                                                                                                                                                                       |
| **settles**                | **once.** Both waves are behind one boundary; splitting them would settle the list twice for no reader benefit, because the counts sit ON the tabs above the rows                                                                                               |
| **verdict**                | **NONE — reuse.** The region behind the boundary is a list of `PlanRow`s, and the pending state for a row list is already drawn: `app/(authed)/backlog/_components/BacklogSkeleton.tsx`. The code card composes it as the fallback; this asset draws no new one |

### `/plans/[id]` — the detail

|                            |                                                                                                                                                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **the gate**               | `getSession` → `params` → `getTranslations('planReview')` → `getWorkspaceContext` (**`notFound()`**) → `planReviewService.getPlanReview` (**`notFound()` on `PlanNotFoundError` / `ProjectAccessDeniedError`**)                                                                                           |
| **with the frame**         | the back-link and the `<h1>` — but the title is `review.title`, so **the header is only paintable once the gate's own read returns**, which it must anyway                                                                                                                                                |
| **with the first content** | `assertProjectInWorkspace` → `projectKey`, and — only when `review.status === 'approved'` — `getEstablishView`                                                                                                                                                                                            |
| **after the page**         | — nothing                                                                                                                                                                                                                                                                                                 |
| **settles**                | **once**                                                                                                                                                                                                                                                                                                  |
| **verdict**                | **NONE, and it is CONSTRAINED rather than chosen.** `getPlanReview` decides the 404 **and** supplies the title, the canvas and the chat; once it has returned there is nothing behind it worth a boundary. The two follow-on reads feed the repository-establish strip, which is a strip and not the page |

**The concurrency change here is real and small:** `assertProjectInWorkspace` and `getEstablishView`
are sequenced only because the second is gated on `review.status`; the first can start with the plan
read. **And note what it is not** — the canvas/chat body renders from the `review` the island already
holds, which is why `PlanDetail`'s view switch is `shallowPush` and shows no pending state at all
(`design/shell/design-notes.md` § _THE SWITCH RULE_, unchanged by this sweep).

> ## ⚠️ AMENDMENT — 2026-08-26, MOTIR-3445. TWO CLAUSES ABOVE WERE ASSERTED, NOT MEASURED.
>
> The build card read both pages and found two of this entry's clauses false. The **allocation**
> — the gate, the tiers, the settle count, the verdicts — is unchanged; what was wrong is the
> rendering detail underneath it, in both cases because it was reasoned from the route's shape
> rather than read off the component.
>
> **1. `/plans`' tab strip is NOT paintable with the frame.** The entry says
> _"the status tab strip — the tabs are static route links, not derived from any read"_.
> `PlanStatusTabs` takes `counts`, which comes from the tier-2
> `Promise.all([listPlans, countPlansByStatus])` — and `counts` also decides `projectIsEmpty`,
> which selects whether the page renders the tab strip at all or a project-level `EmptyState`.
> So tier 1 on this page is the `<h1>` and its subtitle, and nothing else.
>
> **2. `BacklogSkeleton` is not a stand-in for a plan-row list.** It draws TWO bordered regions,
> each a header row plus three `h-9` bars — the backlog's sprint/backlog grouping, which the plans
> list does not have. It is `app/(authed)/backlog/_components/BacklogContainer.tsx`'s and is used
> only there. Composing it here would stand in for a shape this page never renders, which is the
> same defect measured on `/items/archived` in `design/work-items/design-notes.md` (planning bug
> MOTIR-3521).
>
> **So `/plans` takes no boundary in MOTIR-3445**, and what it would need first is a drawn
> stand-in for a plan-row list — or the generic rung, `PageSkeleton`, which does not exist on
> `main` (MOTIR-3520).
>
> **3. `/plans/[id]`'s two follow-on reads WERE serial and are now one wave**, which the entry
> got right in substance and wrong in detail: it said `assertProjectInWorkspace` _"can start with
> the plan read"_. It cannot — it takes `review.projectId`. What it can do is overlap
> `getEstablishView`, which takes the same value. MOTIR-3445 ships that.

**`components/planning/PlanningWorkspaceSkeleton.tsx` is NOT reused here.** It is `/planning`'s, and
`/planning` already has its boundary from [MOTIR-2069](motir:cmsehmzxf000m04l51c9b71u0); naming it
so a code card does not reach for it by association.
