# `design/ai-planning/` — design notes

This area holds the surfaces where a person reviews what Motir's planner PROPOSES.

| Surface                 | Files                                         | Card                 | Section  |
| ----------------------- | --------------------------------------------- | -------------------- | -------- |
| The Plans surface       | `plans-surface.mock.html` + `.png`            | MOTIR-843 (7.4.1)    | Part I   |
| AI **sprint** planning  | `sprint-planning.mock.html` + `.png`          | MOTIR-1749 (7.13.11) | Part II  |
| **Who authored a plan** | `plans-surface.mock.html` (panel A2) + `.png` | MOTIR-2985           | Part III |

Both review the same way — nothing is real until approve, and the approve CTA names what it
will create. Part II mirrors Part I's grammar deliberately; it does not invent a second one.
Part III **amends Part I's asset in place** — it adds one meta entry to a shipped row and to a
shipped header, and redraws nothing.

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
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Page title / body ink                                         | `--el-text`                                                                         | —                                                         |
| Sprint name, chip ink, callout lead                           | `--el-text-strong`                                                                  | —                                                         |
| Secondary copy, ghost button ink                              | `--el-text-secondary`                                                               | —                                                         |
| Capacity line, count badge ink, footer fine print             | `--el-text-muted`                                                                   | —                                                         |
| Velocity seam, drag grip, avatar dash                         | `--el-text-faint`                                                                   | —                                                         |
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

# Part III — Who authored this plan (MOTIR-2985 / Story MOTIR-2982)

**Amends Parts I and II's asset in place**: the same three files
(`design-notes.md` · `plans-surface.mock.html` · `plans-surface.png`), one new panel — **A2**.

## 0. What is UNCHANGED — composed, not redrawn

Nothing on the Plans surface is re-decided here. Explicitly unchanged, and composed from the
shipped asset rather than redrawn:

- **The access path.** Plans is reached from the left-nav _Plans_ entry (Part I §5), and a row is a
  single `<Link>` into `/plans/[id]` — `PlanRow.tsx` says so in its own header ("the whole row is a
  single `<Link>` into the plan detail — the access path"). This amendment adds **no new door**.
- **The row's shape**: the 22px status icon-square, the title line, the meta line, the right-hand
  pill cluster, the accent border on a `planned` row awaiting review.
- **The status pills** and their tones (`generating`→info/sky, `planned`→lavender,
  `approved`→success/mint, `declined`→archived), and the rule that status is carried by TEXT in the
  pill, not colour alone.
- **The staleness flag** (`N may be out of date`, warning tone).
- **The plan-detail canvas, the history timeline, and the approve / decline bar.**

## 1. Drawn against SHIPPED reality — what was RENDERED first

The list row is already implemented, so this was drawn against pixels rather than against source.
The **real `PlanRow` component** was bundled (esbuild) with the **real `messages/en.json`** through
a `NextIntlClientProvider`, styled with the **real `app/globals.css` + `@motir/design-system`
theme**, and screenshotted headlessly in both themes before a line of this panel was written. Three
things that render settled, which reading the `.tsx` would not have:

1. The meta line has **room**: at a normal list width, `14 items   planned 2 hours ago` occupies
   under a third of it. The attribution does not need its own row, its own chrome, or a pill.
2. The right-hand cluster is where the eye lands for STATUS. Putting attribution there would give
   the row **two chips that read as one** — a `Planned` pill beside a `Claude Code` pill is a
   status the reader will try to interpret.
3. The meta entries are visually identical to each other (same size, same ink, same gap). A bare
   `by Claude Code` in that line reads as a fourth timestamp. **That is why the attribution carries
   a glyph** — see §3.

## 2. WHAT IT DRAWS — the five list-row states, and which FIELD each reads

The attribution is **one more entry in the row's existing meta line**, after the timestamp. The
per-state contents, and the data behind them (the fields
[the contract decision](motir:cmsympvcb017mi4philjyjccs) Q3 pins):

| #   | state               | what the row shows                         | read from                                  |
| --- | ------------------- | ------------------------------------------ | ------------------------------------------ |
| 1   | **Agent-authored**  | 🤖 `by ` **`<harness>`**                   | `authorSource === 'mcp'` → `authorHarness` |
| 2   | **Motir-generated** | ✨ `by ` **`Motir AI`**                    | `sourceJobId !== null` (see the ⚠️ below)  |
| 3   | **Auto-planned**    | a SECOND entry: ↻ `auto-planned`           | `origin === 'cadence'`                     |
| 4   | **Unattributed**    | **nothing — the entry is absent**          | neither an author nor a `sourceJobId`      |
| 5   | **Long harness**    | the harness ellipsizes; nothing else moves | §4                                         |

**⚠️ State 2 is read from `sourceJobId`, NOT from `authorSource === 'native'`.** The contract
decision deliberately does not retrofit Motir's own generator — `aiGenerationService` and
`aiPlanEditsService` keep calling `createPlan` without the triple — so **every plan the product
generates carries `authorSource === null`**. Drawing state 2 off a `'native'` value would specify a
row the surface can never render. Retiring that inference (and backfilling the column) is
**MOTIR-2996**, and when it lands this table's state-2 row becomes `authorSource === 'native'` with
no other change to the drawing.

**State 3 is a different FACT and is never merged into state 2.** `origin` answers WHY the plan was
started; the triple answers WHO wrote it. A cadence-fired Motir generation shows **both** entries,
in that order — the panel's third row draws exactly that.

**State 4 renders NOTHING.** No em-dash, no `Unknown`, no greyed placeholder. Every plan that
predates the authorship column is in this state, and a placeholder in a scanned list is a value the
reader has to learn to ignore.

## 3. Per element — the primitive, the tokens, the copy

| element                        | primitive / markup                                                                               | colour token                                                                                   | shape / size                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------- |
| the attribution entry          | a `<span>` **inside the existing meta line** — no new container, no `Pill`                       | `--el-text-secondary` (the meta line's own ink)                                                | inherits the line: `text-xs`, `gap-x-3` |
| the harness / `Motir AI` value | `<b>` within it                                                                                  | `--el-text-secondary` at `font-semibold` — the same emphasis the meta line already gives `<b>` | —                                       |
| the glyph                      | lucide **`Bot`** (agent) · **`Sparkles`** (Motir) · **`RotateCw`** (auto-planned), `aria-hidden` | `--el-text-faint`                                                                              | `h-3 w-3`, `shrink-0`                   |
| the model (DETAIL header only) | a `<span>` after a `·` separator                                                                 | `--el-text-muted`                                                                              | —                                       |

- **No new colour, and no Tier-0 value.** Every ink above is an `--el-*` token this surface already
  uses; the entry has no background, no border and no fill, so it introduces no tint at all.
- **`--el-text-faint` on the glyph is legal precisely because the glyph is decorative.** `CLAUDE.md`'s
  measured table puts faint at 2.39–2.61 against every surface here — below AA — and permits it only
  for decorative glyphs whose meaning is carried elsewhere. It is: the words `by <harness>` say the
  whole thing, and the icon is `aria-hidden`. **The attribution is never conveyed by icon or colour
  alone.**
- **`--el-text-secondary` for the words** (6.24 on `--el-surface`, AA in both themes) rather than
  `--el-text-muted`, which clears AA only on the white page and the row sits on `--el-surface`.
- **Copy** (i18n namespace `aiPlanning`, both catalogs — the parity gate):
  - `authoredBy` → `by {harness}`
  - `authoredByMotir` → `by Motir AI`
  - `autoPlanned` → `auto-planned`
  - `authoredByWithModel` (detail header) → `by {harness} · {model}`

## 4. The long-harness state — what truncates, stated so the code card need not improvise

`authorHarness` is caller-supplied free text of any length. Panel A2's fifth row draws a long
harness AND a long title in a narrow row at once:

- **The TITLE keeps its own single-line ellipsis** (`truncate` on the title line) and is **never
  shortened by the attribution** — the meta line is a separate line below it.
- **Inside the attribution, only the HARNESS truncates**, at **`max-w-[12rem]`**, with the full
  value on the element's `title` attribute. The glyph, the word `by`, the item count and the
  timestamp always stay legible.
- **The meta line stays `flex-wrap`.** On a row too narrow for all three entries the attribution
  moves to its own line, as the panel draws — it never pushes anything out of the row and never
  breaks the text column's `min-w-0 flex-1`.

## 5. The DETAIL header — the same fact where Approve is pressed

The plan-detail header is `PlanReviewRail`'s `<header>` (title + status pill + summary +
`N items`). The attribution joins the **`N items` line** as a second entry, same treatment as the
row, with **one difference**: the detail also shows the **model**, after a `·`.

**Why the model is on the detail and not on the row.** The row is SCANNED — the harness alone
answers _whose plan is this?_, and a model string beside it would roughly double the line for a fact
nobody scans on. The header is READ, once, by the person about to press Approve, and there the model
is exactly what separates two agent-written plans. **Absent model ⇒ the separator and the model both
disappear** and the harness stands alone; **absent everything ⇒ the entry is absent**, as in the row.

## 6. What this amendment ASSIGNS to its sibling cards

Written into those cards in the same pass (the sweep-the-referrers rule):

- **[The Plans surface shows who authored a plan](motir:cmsymy41w01fri4phh1ur2b2v)** builds every
  state above, in BOTH reads — `PlanRowView` (from `PlanDto`) for the row and `PlanReviewDto` (from
  `lib/planning/planReview.ts`) for the header. **It also owes `sourceJobId` on `PlanReviewDto`**,
  which does not carry it today: without it the header cannot tell state 2 from state 4 however
  complete the authorship fields are.
- **[MOTIR-2996](motir:cmsyo0t8100dpi3ph16o9k6bm)** retires the `sourceJobId` inference once the
  generator records its own attribution, at which point state 2 reads `authorSource === 'native'`.

Nothing else moves: no sibling loses an element to this amendment.
