# AI chat / onboarding — design notes

Design reference for the `ai-chat` UI area — **Motir's start-fresh onboarding
journey** (Story 7.3, `MOTIR-804`). The single, comprehensive
**screen-by-screen** design of the flow, reviewable before any UI is built.

> **Revised to the gated, conversation-only model (subtask 7.3.68 /
> `MOTIR-1100`, 2026-06-18).** This asset began as `7.3.44` / `MOTIR-1061`;
> `MOTIR-1100` brings it onto the FINALIZED model and is now the source of truth.
> Everything `1061` got right is kept (canvas roadmap + chat rail, full-screen
> per-tier review, validate-first ask, the design step styling its whole self,
> the feature catalog folded into vision). What changed: **(1)** all inline doc
> editing is REMOVED — the docs are READ-ONLY and the chat is the sole input;
> **(2)** the per-tier **Continue gate + conductor narration** is drawn; **(3)**
> the **downstream-only cascade / back-navigation** + "nothing locked until
> generate" is drawn.
>
> **Grounded in the workflow-defining subtasks** (the design-content dependency
> rule — design TO the spec, never invent the flow): the **conductor**
> `7.3.67`/`MOTIR-1099` (one prompt drives the whole gated conversation:
> ask → draft-tier(ready) → narrate → classify-impact across the DAG), the
> **gated step machine** `7.3.9`/`MOTIR-838` + `7.3.23`/`MOTIR-1036` (per-tier
> gates, dependency-closed skips, catalog folded into vision), the **read-only
> gates** `7.3.5`/`MOTIR-833` + `7.3.6`/`MOTIR-834` (Continue / Skip + chat-only,
> cascade-back re-review, NO edit affordance), the **re-derivation engine**
> `7.3.24`/`MOTIR-1037` (downstream-only coordinated re-derivation), the
> **validate-first** ask `7.3.47`/`MOTIR-1064`, and `workflow.html` Steps 1-6.
> Supersedes the cancelled wizard designs `7.3.26`/`MOTIR-1039` +
> `7.3.43`/`MOTIR-1060`.

---

## ⭐ The model — the canvas IS the roadmap; the chat is a right rail

The whole flow is **one frame with two modes**:

1. **The hub = a visual CANVAS (left) + a CHAT (compact right rail).** The canvas
   is **one continuous roadmap** — _another form of display of the work-item tree
   **+** the pre-plan phase_: **Idea → Discovery → Vision → Feasibility →
   Validation → Plan → Epic 1 → Epic 2 → …**, each epic expandable to its
   **stories → subtasks**. It shows **where you are** the whole way through (with
   descriptive station names, not jargon). The **chat drives** the active step; it
   never takes the screen.
2. **A step takes the FULL SCREEN** — a READ-ONLY write-up to review, or the design
   step — with a plain **"Back"** button (no internal words like "canvas") and a
   **descriptive** header (`Pre-plan · building your direction`, not a row of
   meaningless short words and never "doc N of 4"; the journey lives on the canvas).

**Labels are PLAIN LANGUAGE, never jargon** — a founder won't know "Feasibility"
or "Validation". The four pre-plan docs read: **"Understanding your idea"** ·
**"What we'll build"** · **"Is it worth building?"** (optional) · **"Will people
want it?"** (optional). Each is **shown READ-ONLY** at its own review gate, then an
explicit **Continue** advances to the next tier. **There is NO inline editing
anywhere** — you react ONLY in the chat, and the conductor revises the write-up for
you (`7.3.5` / `7.3.6`). The two optional ones are **skipped in the CHAT** (before
they generate), never on the doc. Validation can be **front-loaded** (validate
demand first). The conductor **drives the flow** (proceeds on its own; Skip cancels
an upcoming optional tier). The design step **styles its whole self**. (All
detailed below.)

**The gated rhythm** (the model's spine — see §"The gate rhythm"): the conductor
DRAFTS a tier → you review it READ-ONLY → you press **Continue** → the conductor
**NARRATES** the handoff in the chat ("I have enough — drafting what we'll build
now") → it drafts the next tier. **Nothing is locked until epic generation** (the
single commit) — every Continue is **navigation, not sign-off**. A chat reaction
the conductor attributes to an **upstream** tier sends you **back** to re-review
that tier, then forward; downstream tiers re-derive. **Cascade is downstream-only.**

This keeps what the prior drafts got right: the canvas-left + chat-right layout
(the chat never dominates), progress **on the canvas** (visual + descriptive), the
roadmap **continuing past Plan** into the epics/stories (the same canvas, a view of
the work-item tree), the **skip as a chat decision**, and the design step as the
example **at full page scale** — and corrects them to the conversation-only,
gated model above.

---

## The screens (in journey order)

| #      | Screen                                    | What it is                                                                                                                                                                                                                                                             |
| ------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B**  | **Public landing**                        | the idea prompt **+ the workflow preview**: the **3 mandatory steps** (Understanding your idea · What we'll build · Your plan/build) shown as descriptive blocks, with a **click-to-expand** bar revealing the optional steps (reality check · market check · design). |
| **C**  | **The hub**                               | the **canvas roadmap on the LEFT** — each done station **shows its captured findings** — + the **chat right rail**; here the agent raises the **validate-first ask** (with context) and **blocks** until you choose.                                                   |
| **D**  | **"Understanding your idea"**             | a **readable, READ-ONLY document** (editorial prose): what / who, the **mirror scan** (real comparables), inferred class + platform. React in the chat — no inline edit.                                                                                               |
| **E**  | **"What we'll build"**                    | a **READ-ONLY document**: in / out of scope (v1) + key decisions (pinned vs delegated). The **read → react → revise** loop runs through the **chat**, never inline.                                                                                                    |
| **F**  | **"Is it worth building?"** (opt.)        | a **READ-ONLY document**: the market, how hard it is to build, things to watch. Skipped (if at all) earlier, in the chat.                                                                                                                                              |
| **G**  | **"Will people want it?"** (opt.)         | a **READ-ONLY document**: demand + competition + the **validate-demand-first recommendation**, with the accept/decline **decision on the page** (also asked in the chat) — it **blocks** continuing.                                                                   |
| **G2** | **The gate rhythm + narration**           | the per-tier loop drawn: draft → READ-ONLY review → **Continue** → the conductor **narrates** the handoff (typing) and drafts the next tier; **Skip offered in the chat** for an optional tier; "Continue = navigation, nothing locked".                               |
| **G3** | **Going back — downstream-only cascade**  | a chat reaction at a LATER gate that the conductor attributes **upstream** sends you **back** to re-review that tier; the canvas shows the "Revisiting" state + downstream tiers "Will refresh"; cascade arrows point **downstream only**; nothing is locked.          |
| **H**  | **Design step** (whole page styled)       | the **ENTIRE page** — header, pickers, buttons, list, footer — rendered live in the chosen **style × palette × type**. Change a pick → it all restyles.                                                                                                                |
| **I**  | **The canvas as the roadmap** (post-plan) | the road continues past Plan: **Epic 1 (done) → Epic 2 (you are here, progress meter) → Epic 3 → + more**.                                                                                                                                                             |
| **J**  | **An epic expanded**                      | the epic opens to its **stories → subtasks** (the work-item tree, same road language) with per-item status + work-type chips (Code / Design / Content / …).                                                                                                            |
| **K**  | **Plan states**                           | the degraded **"AI planning not configured"** gate + loading / resume / error.                                                                                                                                                                                         |

---

## ⚠️ The canvas = one view of the work-item tree + the pre-plan phase

The canvas is **not a separate onboarding widget** — it is a **roadmap view** of
the same work-item tree the boards / backlog / list render, with the **pre-plan
phase** (Idea + the 4 docs) as its start. So the SAME surface serves the whole
journey:

- **Pre-plan (screen C):** the stations are Idea → Discovery → Vision → Feasibility
  → Validation → Design → (Plan), with the active one ringed and the optional ones
  tagged "can skip"; future epics are a dashed "after planning" station.
- **Post-plan (screen I):** the planning origin collapses to "Planning · done" and
  the road extends into **Epic stations** with progress meters + "you are here".
- **Expanded (screen J):** an epic's **stories → subtasks** render in the same
  node language — a roadmap = a planning origin + a tree, self-similar at every
  level. This is a NEW PRESENTATION of the shipped work-item tree, not a new data
  model. (Its own BUILD is a separate Epic-7 story — "planning canvas → persistent
  roadmap"; drawn here because the continuity is the point.)

---

## ⚠️ The design step styles its WHOLE self (screen H)

The design step is **web-only** (mobile skips it; skip → the default style, no
`DESIGN.md`). It is the third axis of Motir's own design system — **Colour
`data-palette` · Type `data-type` · Shape/feel `data-style`**. It is **not a
styled frame embedded in normal chrome** — the `data-style` / `data-palette` /
`data-type` attributes sit on the **whole panel surface**, so **every element on
the page** — the header, the **pickers**, every button, the input, the list, the
cards, the footer — renders in the selected design. **Change a pick and the whole
page restyles** (including the header). The page you are looking at _is_ the
example. (The doc & plan screens keep Motir's normal chrome — only the design step
restyles itself.)

Everything is faithful: the `[data-style]` / `[data-palette]` / `[data-type]` axis
blocks are **copied 1:1 from `app/globals.css`** and the six real next/font faces
(Inter · Source Serif 4 · JetBrains Mono · Space Grotesk · Fraunces · IBM Plex
Mono) are loaded, so the page re-shapes / re-skins / re-types exactly as the
running app does. The result composes into a `DESIGN.md` starter. The **v1 set**:

| Axis        | v1 entries                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| **Style**   | Warm Editorial (default) · Soft/Playful · Swiss/Minimal-Flat · Neo-Brutalism · Glassmorphism · Cybercore/Y2K |
| **Palette** | Motir (default) · Cobalt · Graphite · Evergreen · Spectrum                                                   |
| **Type**    | Motir (default) · Motir Sans · Motir Mono · Grotesk · Editorial · Mono-Technical                             |

> The shared style specimen of **7.3.37 / `MOTIR-1050`** (this design is
> `blocked_by` it) is, here, the whole styled page itself.
>
> **Mock-only adaptation:** in the app `data-palette` sits on `<html>`; because the
> styled panel is a nested element, the mock re-emits the derived `--el-*` layer
> scoped to `[data-palette]` so it recomputes locally. Style + type need no fix.

---

## ⚠️ The gate rhythm — the conductor DRAFTS, you Continue, it NARRATES (screen G2)

**One conductor drives the conversation, but each tier STOPS at a review gate.** The
conductor (`7.3.67`) does **not** ask _"shall I draft the next step?"_ and wait — it
gathers what it needs through the chat, then **drafts a tier on its own** and stops
at that tier's **review gate**. The user reads the READ-ONLY write-up and presses
**Continue**; the conductor then **narrates the handoff** in the chat (_"That's
Understanding your idea set — I've got enough to draft what we'll build. Writing it
up now…"_) with a typing indicator, and drafts the next tier. So the rhythm per tier
is: **draft → READ-ONLY review → Continue → narrate → next**.

**Continue is navigation, not sign-off.** Pressing Continue moves you forward; it
does **not** lock anything. **Nothing is locked until epic generation** — the single
commit at the end. The doc footers and the gate banner say so explicitly.

**Skip is a CHAT decision, before a tier drafts (not a button on a generated doc).**
For the two **optional** tiers (the worth-building check and the market check) — and
the design step — the conductor **offers Skip in the chat** before it drafts that
tier (`7.3.9` surfaces the per-tier skip control; when the interview already revealed
the work is done, it pre-suggests the skip). Pressing Skip **cancels that tier and
advances** to the next. A **generated report has nothing to "skip"** — once a doc is
on screen, its gate has only **Continue**. (This is why screen G2 draws Skip as chat
chips at the optional-tier handoff, never as a footer button on D/E/F/G.) Skips are
**dependency-closed**: skipping the worth-building check also drops the market check,
since validation builds on it (`7.3.23`).

## ⚠️ Going back — the downstream-only cascade (screen G3)

**The chat is the SOLE way to change anything — there is NO inline editing.** When
the user reacts in the chat, the conductor **classifies the impact across the whole
dependency DAG** (discovery → vision → feasibility → validation) — a remark made at a
**later** gate can change an **upstream** tier (the product can do the same thing a
different way). When it does, the machine sends the user **BACK to re-review that
upstream tier** ("Revisiting"), then **replays the gates forward**, while the
**downstream** tiers **re-derive** (`7.3.24`) — drawn on the canvas as "Will refresh".

**Cascade is DOWNSTREAM-ONLY.** A note at the market check can change your idea, but a
note about your idea never edits a step before it; upstream is never rewritten by a
downstream note. Because nothing is locked until generation, going back is always
safe — the G3 banner + the chat reassure the user of this.

## ⚠️ Validate-demand-first — the one BLOCKING ask (MOTIR-1064 / 7.3.47)

Most steps just flow, but **validate-demand-first is a genuine strategic decision**
(it can't be inferred — it's the user's call), so it is the **one place the agent
asks and waits**. The sequence (per `MOTIR-1064`): the agent **generates the
validation step summary** (screen G — the demand + competition write-up) → then
**asks in the chat, with context** from it → and **this BLOCKS the next step**
(Design / Plan stay locked until you choose). The default if the ask is never
reached is standard timing.

The decision appears in **both** places — **in the chat** (screen C) **and on the
validation page** (screen G, a decision block gating "continue"). **What "prove
demand first" means must be CONCRETE on the page** (Yue): it is not vague
"validation" — it means Motir **builds and launches a small marketing site first**
(a landing page that pitches the idea + a "notify me" waitlist) and **plans the
go-to-market**, **ahead of** the product build, so real sign-ups measure interest
before you commit. **On acceptance**, the plan **front-loads that launch slice** —
a `manual` domain-registration task, the marketing landing page + waitlist, and the
deploy tasks — sequenced **first**; the signups become the green light. **"No —
build it all"** keeps the standard order.

## ⚠️ Vertical canvas; step SUMMARIES, not "docs"

The canvas is a **vertical pipeline** (screen C) — the workflow runs **top to
bottom** (idea → the four checks → design → plan), and **each block shows what was
captured** (what/who/competitors · scope · market + risk), so the canvas is
informative, not empty boxes. The active step is ringed; done steps carry their
findings; upcoming steps are ghosted rows.

The four full-screen pages (D/E/F/G) are **step summaries** the user reads — a
clean **editorial write-up** (kicker + serif title + lead, then prose sections,
lists, a competitor "scan"), **READ-ONLY** (you react in the chat, never inline).
**Don't call them "docs" or number them "doc N of 4"** (Yue) — "doc" is an internal
word and there's nothing to download; each page is just the write-up of that step.

---

## Token / a11y discipline

- **Colour** strictly via `--el-*`; the showcase + specimens carry the palette in
  the `--el-*` layer (re-emitted for nesting); chips put the hue in the tint
  background with `--el-text-strong` (finding #35, AA). The only `--color-*` is
  inside the axis blocks copied 1:1 from `globals.css`.
- **Shape** strictly via element-semantic tokens (`--radius-*` / `--shadow-*` /
  `--spacing-*` / `--height-*`) — so the `[data-style]` swap re-shapes the
  showcase (that IS the demo). `rounded-full` only on dots / avatars.
- **Not colour-alone** — every station / state pairs an icon + label + tint; the
  roadmap "you are here" pairs a `map-pin` + label; pinned vs delegated keep their
  `pin` / `wand` markers; the new gate states pair a glyph + word —
  `Drafting now…` (`sparkles`) · `Will refresh` (`rotate`) · `Revisiting`
  (`corner-up-left`, ringed) — so the state never rests on hue alone.
- **AA holds** — each style × palette pair is AA by construction; Cybercore renders
  its native dark register.
- **A11y** — the chat rail and the canvas are labelled regions; decorative icons
  are `aria-hidden`; buttons carry accessible labels.

## Primitives composed (no hand-rolling)

| Element                           | Built from                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| canvas roadmap (stations + road)  | NEW ARRANGEMENT of `Card` (`.estation`) + tint glyph tiles + connector lines + progress meters                                                                                                    |
| chat rail + bubbles + composer    | `Card` + `Avatar` + `Input` (the compact right rail)                                                                                                                                              |
| full-screen step frame            | a `step-top` bar (`Button` back + a descriptive label) over a centred doc body                                                                                                                    |
| READ-ONLY doc body + read hint    | `Card` + prose sections + a `.doc-readhint` "react in the chat" banner (a `message` glyph, **never a `pencil`**)                                                                                  |
| doc-footer Continue gate          | `Button` (Back) + a `.gate-note` ("Continue = navigation, nothing locks until generate", `lock-open` glyph) + `Button` (Continue)                                                                 |
| gate banner / "going back" state  | `.gate-banner` (`Card` tint + glyph tile + title/desc); the `.back` variant tints peach for the cascade re-review                                                                                 |
| narration + cascade canvas states | the `.active-node` blocks reuse `Pill` states — `Drafting now…` / `Will refresh` / `Revisiting` (hue in tint bg, `--el-text-strong`) + a `typing` indicator + downstream `cflow` connector labels |
| full-page design showcase         | NEW ARRANGEMENT of `Card`/`Button`/`Pill`/list wrapped in the real axis attributes (the `/tokens` specimen pattern)                                                                               |
| epic → story → subtask tree (I/J) | NEW ARRANGEMENT of `Card` + the `--el-type-*` work-type hues + the connector language                                                                                                             |
| state callouts                    | `Card` tints + `Button`; the spinner is `Spinner`                                                                                                                                                 |
| icons                             | lucide-react + Google / GitHub marks                                                                                                                                                              |

## Deliverable

The three-file design-asset set under `design/ai-chat/`: `design-notes.md` (this
file) · `onboarding.mock.html` (the HTML mockup — source of truth, screens B–K incl.
the new G2 gate-rhythm + G3 cascade panels) · `onboarding.png` (the full-page
export). Rendered with Playwright chromium (full-page, light theme,
`deviceScaleFactor: 2`, 1200px wide); `prettier --check` clean.

---

## ⭐ The canvas is a SPATIAL canvas — Miro-style (2026-06-21 redesign, MOTIR-1235)

**Supersedes screen C's "vertical pipeline (down)".** The hub's left pane is not a
list — it is a genuine **2D spatial canvas** (Miro / tldraw feel). Asset:
`canvas-spatial.mock.html` (interactive: drag to pan, wheel to zoom) +
`canvas-spatial.png` (zoomed-in detail) + `canvas-spatial-overview.png` (zoomed-out,
the whole-project map). Approved direction (Yue, 2026-06-21):

- **Render the REALITY — the canvas never invents structure.** It is a live VIEW of
  the actual work-item tree + its actual dependencies: every node is a real station /
  epic / story, every edge is a **real dependency edge from the plan**, and the picture
  reflects what IS, not a designed diagram. The illustrative content in the mock
  (PayFlow, the named epics/stories) stands in for whatever the real project is — the
  BUILD reads the nodes + edges from the work-item graph (the pre-plan tier chain + the
  epic/story DAG) and renders them; it never hardcodes a layout or a link.
- **Pan** anywhere (drag the surface), **zoom in / out** (wheel / trackpad +
  `−` / `+` / `fit` controls, bounded ~30–200%). A subtle dot-grid backdrop reads
  as an infinite canvas.
- **Nodes are draggable.** Each station is a node the user can **drag to rearrange**;
  the arrangement **PERSISTS per user, per project** (a drag survives reload — the
  user shows the roadmap the way they want). Nodes **auto-initialise in a
  space-filling 2D FLOW** — a serpentine that uses the canvas WIDTH (the chain runs
  across the top, drops, and reverses; plan fans to the epics), NOT a single
  top-to-down column — so the space is utilised; the user takes it from there.
- **Links are PRE-DEFINED and READ-ONLY.** Edges are the work-item / pre-plan
  dependencies, drawn as curved connectors — there is **no link create / edit / delete
  on the canvas** (the canvas arranges and reads; it never restructures the plan). The
  pre-plan edges are the real tier dependency **chain** — each tier builds on the one
  before it: **idea → discovery → vision → feasibility → validation → design → plan**,
  so &ldquo;What we&rsquo;ll build&rdquo; (vision) links from &ldquo;Understanding your
  idea&rdquo; (discovery), matching the conductor&rsquo;s downstream-only re-derivation
  order (`DIRECTION_DOC_ORDER`) — NOT a free 2D branch. **The post-plan epics are a
  DAG of their REAL dependencies**, not a flat fan off `plan`: earlier epics usually
  block later ones — **Foundation blocks the implementation epics** (`Foundation →
Invoices`, `Foundation → Reminders`) — but it is **not a hard rule**, so independent
  epics run in **parallel** (e.g. the app `Foundation` and a `Marketing-site` epic both
  come straight off `plan`). Each epic fans to its stories. These edges are whatever
  the plan&rsquo;s real dependency graph says — the canvas renders them, it doesn&rsquo;t
  decide them.
- **One surface, whole journey.** The pre-plan stations (idea → the 4 tiers →
  design / plan slots) live on the same canvas that later carries the **post-plan
  epic → story clusters** (zoom out → the whole-project map). The post-plan RENDER is
  a separate Epic-7 story; the canvas is designed to accommodate it.
- **Node states** carry over from screen C — done (Reviewed ✓) · active/frontier
  (`map-pin` + ring + `aria-current`) · deciding (validation + the blocking ask) ·
  upcoming (ghosted, dashed) — each pairs an icon + label + tint (finding #35), with
  captured-findings rows on the produced tiers.
- **Tokens + a11y:** colour via `--el-*`, shape via element-semantic tokens; the
  canvas + chat are labelled regions; nodes are keyboard-focusable; zoom/pan have
  keyboard equivalents.

**Build split (the canvas is a FOUNDATION):** a reusable `PlanningCanvas` component
(pan/zoom/drag/fit + node + read-only edge rendering — MOTIR-1236), per-user layout
persistence (MOTIR-1237), composed by the onboarding shell (MOTIR-840) and reused by
generation review (7.4) and the persistent roadmap (7.19).

---

## ⭐ The reusable AI planning workspace — shell + universal entrance (MOTIR-1193 / 7.20.1)

**THE ONE SHARED PLANNING INTERFACE.** Every AI-planning surface uses the SAME
structure — a full-screen **canvas (left) + chat (right)** workspace. Onboarding
(above) is one specialization; **generation review (7.4), re-planning (7.11),
contextual planning (7.12) and the persistent roadmap (7.19) REUSE this same
surface** as MODES (states), not separate UIs. This is the SINGLE design for it —
it supersedes the separate per-story designs `7.11.1`/`MOTIR-898` +
`7.12.1`/`MOTIR-907`.

**Asset:** `planning-workspace.mock.html` (source) + `planning-workspace.png`
(full-page export). A five-sheet review board:

| Sheet | What it shows                                                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | The shell — full-screen two-pane workspace (canvas left · chat right), no app nav                                                               |
| **2** | Chat-to-plan — proposed cards land on the canvas one-by-one, with edges, pending until Confirm (confirm-to-persist)                             |
| **3** | The four MODES (generation / re-plan / contextual / roadmap-read) as STATES of the one surface, each tied to its entrance door                  |
| **4** | The universal entrance — BOTH hero affordances: the header "Plan with AI" pill + the floating "M" universal AI callout; context → mode adapts   |
| **5** | Style-aware — the "Plan with AI" control rendered special in each `data-style` (Editorial / Soft / Swiss / Brutalism / Glass / Cybercore)       |
| **6** | Opening & exiting — a full-screen overlay ON TOP of the app; Close (✕ / Esc / "Back to …") + the confirm-to-persist guard on close-with-pending |

### ⚠️ SCOPE — this designs the SHELL + ENTRANCE, NOT the canvas pane

The canvas pane is the **standalone work-item canvas** — already designed +
owned elsewhere; this asset **COMPOSES it, it does NOT redesign it**:

- **The canvas DESIGN** = **MOTIR-1009** (`7.3.76`, done) → the three-file asset
  at **`design/roadmap/`** (the deterministic auto-layout, the work-item tree,
  the dependency edges — within-story arrow vs the cross-story warning edge —
  zoom / fit, search-to-focus, filters, node states, drill-down, empty/loading/
  error). This asset READS it and reuses its node + edge language; it does **not**
  re-draw the tree / edges / zoom / search.
- **The canvas COMPONENT** = **MOTIR-1194** (`7.3.77`, the reusable
  `WorkItemCanvas`) → the code this workspace's canvas pane MOUNTS. A FOUNDATION
  (it does not depend on this design); this workspace is one of its consumers.

So the mock's canvas panes are the `design/roadmap/` canvas language reproduced
faithfully (the `StationCard` node + the `PlanningCanvas` neutral firm /
dashed-pending edges + the cross-story `--el-warning` edge), **never a new
canvas**.

### ⭐ Built on SHIPPED REALITY (design-against-shipped-reality)

The shell is **already shipped** and reused, not reinvented:

- **The shell** = `components/planning/PlanningWorkspace.tsx` — the full-screen
  two-pane frame: `grid h-dvh w-full grid-cols-1 md:grid-cols-[1fr_22rem]`
  (canvas left, a **22rem** chat rail right), **no app shell / sidebar / top
  nav** — a focused planning surface. The mock mirrors this exactly.
- **The chat rail** = `components/onboarding/DiscoveryChatRail.tsx` — the mock
  reproduces its real markup: the rail header (a `--el-success` status dot + the
  mono uppercase **"Motir AI"** label), the `Bubble` + `Avatar` language
  (AI = `--el-accent` avatar + soft bubble; user = accent bubble), the drafting
  `Spinner` indicator, and the composer (`Input` + a primary `Send` button).
  The one new rail element is a small **mode chip** (mono, accent tint) naming
  the active mode — the only per-mode difference in the rail.
- **The global launcher** composes `components/ui/CommandPalette.tsx` (the wired
  ⌘K palette, app composition in `(authed)/_components/AppCommandPalette.tsx`):
  a **"Plan with AI"** command in a `Plan` group.

### Chat-to-plan, on-canvas incremental placement & confirm-to-persist (sheet 2)

> **⚠️ No "plan" button INSIDE the workspace (Yue, 2026-06-24).** Inside, the
> user **just chats** — there is **no "Plan with AI" action/button** on the canvas
> or anywhere in the shell. The **conversation itself turns into a plan**: as you
> talk, proposed cards appear on the canvas. "Plan with AI" names **only the
> ENTRANCE** (the affordance that opens this from the app); once you're in, the
> canvas is just the project roadmap and the **chat is the sole input**. (The
> canvas chrome shows the project / roadmap context + Close + search — never a
> "plan" button; the composer reads "Message Motir AI…", not "describe what to
> plan".)

- **The chat drives; the conductor proposes work.** Free-form chat in the rail
  → the conductor proposes work items. The user never presses "plan" — talking
  is planning.
- **On-canvas incremental placement.** Proposed work items appear on the
  standalone canvas **one by one**, each drawn with its **relationship edges** —
  parent→child, the within-story `depends_on` arrow, and the cross-story
  `blocked_by` warning edge — in the canvas's own node + edge language.
- **Confirm-to-persist.** The proposed set is a **STATE of the canvas** —
  pending nodes (a dashed `--el-accent` border + a `proposed` `Pill`) and
  pending edges (dashed). **Nothing is written to the DB until the user presses
  Confirm**; **Discard** drops the whole proposal. This IS the diff/review
  surface — there is no separate review screen. The gate is a floating bar:
  _"N proposed work items · Nothing saved yet"_ + **Discard** / **Confirm & add
  to project**.

### The MODES — states of the one surface, each opened by a door (sheet 3)

All four differ ONLY in (a) what the canvas is seeded with and (b) the chat
driver's framing — the shell, the placement, and the confirm gate are identical.
**Grounded in the workflow-defining stories** (design TO the spec, never invent
the flow):

- **Generation review — 7.4 (`MOTIR-805`).** Door: a project surface with **no
  plan yet** → generate the first fresh tree from the frozen baseline → review →
  Confirm persists. (7.4 is fresh, empty-skeleton generation.)
- **Augment / re-plan — 7.11 (`MOTIR-811`).** Door: a project surface **with a
  plan** → expand / re-sequence; **completion-aware** — done work stays locked,
  new cards propose around it.
- **Contextual planning — 7.12 (`MOTIR-812`).** Door: **from a specific work
  item** (detail page / row action) → planning **scoped to that item's subtree**
  (the canvas focuses that item; proposals are its children).
- **Roadmap read + augment — 7.19 (`MOTIR-1008`).** Door: the **Board ↔
  Roadmap** toggle → the persistent roadmap; read the whole tree, augment in
  place.

Onboarding (7.3) is the one specialization that wraps this shell in its gated
per-tier pre-plan review loop (see `onboarding.mock.html`).

### ⚠️ The universal entrance — global hero affordances, not per-surface (sheet 4)

**Corrected 2026-06-24 (Yue): NOT one door per screen.** The global **header**
(`TopNav`) and the **⌘K** command menu are present on **every** PM screen, so AI
is reachable everywhere via **global** affordances, not a per-surface button. And
because this is the
**product's headline feature / selling point**, the affordance is a **hero
control** — gradient fill, a soft glow / aura, a `Sparkles` mark, a subtle
shimmer — **never a plain toolbar button**. (This supersedes the earlier
per-surface in-situ grid, which multiplied a regular button across seven
surfaces — wrong on both counts.)

**We ship BOTH entrances** (refined 2026-06-24, Yue) — they are complementary,
both always-present, and both restyle with the active design style (sheet 5);
⌘K opens the workspace too:

- **A — the header "Plan with AI" pill.** A gradient hero pill in `TopNav`'s
  right cluster, present on every screen, never covering content — the direct
  **planning** entrance; opens the workspace in the current context's mode.
- **B — the floating "M" button = the universal AI callout.** A glowing orb (the
  **M** logo) afloat bottom-right on every screen; tapping it opens the AI
  callout — **the home of ALL AI**, where **Plan with AI is ONE action**
  alongside **"Ask about this project"** (Q&A over the plan / docs / work items)
  and **"Help with a task"** (draft / summarise / assist). Planning is the
  capability this design+story deliver now; project Q&A and task assistance are
  **future capabilities reached through the same button**. **Built now with a
  mock `M` logo** — the real brand logo replaces it later (the orb is the logo's
  home). The callout menu composes `Card` + list rows + an "Ask Motir anything…"
  input.

**⚠️ The hero control is STYLE-AWARE — special in every design style (sheet 5).**
It is not a fixed gradient: each `data-style` gives the "Plan with AI" control a
**distinct, special treatment** — Warm Editorial (gradient + glow + shimmer),
Soft/Playful (rounded, pillowy stacked shadow), Swiss/Minimal-Flat (flat solid,
sharp, uppercase), Neo-Brutalism (hard border + offset hard shadow), Glassmorphism
(frosted translucent over a colourful surface), Cybercore/Y2K (dark surface + neon
glow + mono). The floating **M** orb adopts each style's material the same way.
Implemented as a **per-style material surface** (the sanctioned exception, like
glassmorphism): `[data-style='id'] [data-surface='ai-cta'] { … }` rules whose
colour is **palette-DERIVED** (`color-mix()` / `var(--el-accent|--el-highlight)`,
no raw hex) and whose radius/padding/shadow flow through element-semantic **shape**
tokens — so a `data-palette` swap re-tints every style's treatment and a
`data-style` swap re-shapes it (the axes stay disjoint). **AA holds in each**
(label over the accent-dominant region; Cybercore renders its native dark
register).

**The anatomy of the hero control** (drawn in the sheet-4 close-up):

- **Gradient fill** — `--el-accent` → an `--el-highlight`-derived violet/pink;
  white label text sits over the **accent-dominant** region so **AA holds** (the
  brand pink lives only in the glow/aura, never under text).
- **Aura / outer glow** — a soft pink + violet halo so it lifts off the chrome.
- **Sparkle mark** (lucide `Sparkles`) + a **shimmer sweep** (a slow loop in the
  build) — the living, AI feel.
- An optional **conic-gradient ring** for a premium rim (shown on the close-up).
- This is a **sanctioned "feature surface" exception** to the flat-button norm
  (like the surface-material styles): the gradient + glow are **palette-DERIVED**
  (`color-mix()` / `var(--el-accent | --el-highlight)`, **no raw hex hue**), so a
  `data-palette` swap re-tints the hero and a `data-style` swap leaves its hue
  alone. Shape (radius/padding) still flows through semantic tokens.

**ONE door that ADAPTS — context → mode** (not seven doors). The single
affordance opens the workspace in the mode for the **current context**:

| Current context                                | Mode it opens                            | Story |
| ---------------------------------------------- | ---------------------------------------- | ----- |
| viewing a **work item**                        | contextual planning, scoped to that item | 7.12  |
| a **project surface** (board / backlog / list) | augment / re-plan                        | 7.11  |
| an **empty project** (no plan yet)             | generation                               | 7.4   |
| the **roadmap**                                | roadmap read + augment                   | 7.19  |

- **Implementation** = the reusable **`PlanWithAILauncher`** (**`MOTIR-1299`** /
  `7.20.3`, `blocked_by` this design): it renders **both** hero controls (the
  header pill + the floating **M** callout), opens the `PlanningWorkspace`, and
  passes the originating context so it lands in the matching state (sheet 3). The
  callout's non-planning actions (project Q&A, task assistance) are future
  capabilities that mount in the same menu.
- The **work-item detail door** (`MOTIR-910`) and the **Board ↔ Roadmap toggle**
  (`MOTIR-1011`) are **the same launcher in context**, not separate inventions.
  (The authed roadmap + toggle are owned by 7.19/`MOTIR-1011` and not shipped yet
  — only the public roadmap exists today; that door reuses this launcher when
  1011 lands.)

### ⚠️ Opening & exiting — a full-screen overlay ON TOP of the app (sheet 6)

The workspace **covers the screen** (the canvas + chat need the room) but it is a
**full-screen overlay LAYERED ON TOP of the PM app — not a route change**. The app
stays mounted, dimmed + inert, behind it; the overlay sits with a slight inset +
drop shadow so the reader SEES it is a layer on top. **Closing returns you to the
exact screen you launched from** (same route, scroll, filters) with **no reload or
lost state** — so it is "full-screen" for working AND "on top" for context.

**The shell carries its OWN exit chrome** (it has no app nav to leave through):

- **Close** — a `✕ Close` control **top-left** of the workspace (it can name the
  origin, e.g. "↩ Back to board"), drawn on the shell in every sheet.
- **`Esc`** — closes from anywhere in the workspace (keyboard).
- **Close-with-pending guard** — because **confirm-to-persist** means nothing is
  saved until Confirm, dismissing with proposed (pending) cards opens a guard:
  **Discard N proposed · Keep planning · Confirm & add** — never a silent loss.

**Onboarding is the one exception** — a genuine full-page first-run _route_ (a
dedicated journey), not this dismissable overlay.

### Primitives composed (no hand-rolling)

| Element                                            | Built from                                                                                                                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the workspace shell                                | the shipped `PlanningWorkspace` (`grid-cols-[1fr_22rem]`)                                                                                                                  |
| canvas pane (nodes + edges + zoom + search)        | the standalone `WorkItemCanvas` (`MOTIR-1194`; design `design/roadmap/`) over the shipped `PlanningCanvas` — composed, never redrawn                                       |
| chat rail (header + bubbles + drafting + composer) | the shipped `DiscoveryChatRail` language — `Card`/`Avatar`/`Input`/`Spinner`/`Button`                                                                                      |
| proposed (pending) node + edge                     | the canvas's `StationCard` + `PlanningCanvas` edge language in a `proposed` state (dashed `--el-accent`)                                                                   |
| confirm-to-persist bar                             | `Card` (accent border) + `Button` (Confirm primary, Discard ghost)                                                                                                         |
| "Plan with AI" hero launcher                       | NEW reusable affordance — a `Button`-based gradient pill (header) OR a floating orb (FAB), palette-derived gradient + glow + `Sparkles` + shimmer; ⌘K via `CommandPalette` |
| host context (sheet 4)                             | the real shipped `TopNav` (Option A host) + the global `AppCommandPalette` (⌘K); the FAB docks into any route                                                              |
| icons                                              | lucide-react (`Sparkles` for the launcher)                                                                                                                                 |

### Token / a11y discipline

- **Colour** strictly via `--el-*` (the mock inlines the real light-palette
  values, as the sibling canvas mocks do). The **hero launcher** is a
  palette-DERIVED gradient (`--el-accent` → `--el-highlight`) + glow — a
  sanctioned feature-surface exception (no raw hex), with the white label kept
  over the **accent-dominant** region so **AA holds** and the brand pink confined
  to the glow/aura. The proposed state uses `--el-accent` border over a faint
  accent-tinted surface + a soft pink glow; the cross-story edge is
  `--el-warning`. Work-item type hues are `--el-type-{epic,story,subtask,…}`; type
  dots/tiles put the hue in a tint with strong text (finding #35, AA).
- **Shape** strictly via element-semantic tokens (node = `--radius-card`, pills =
  `--radius-badge`, buttons = `--radius-btn`, menu/list rows = `--radius-control`,
  the palette = `--radius-modal`; shadows = `--shadow-{subtle,card,modal}`) so a
  `[data-style]` swap reshapes the whole surface. `rounded-full` only on dots /
  avatars.
- **Not colour alone** — the proposed state pairs the dashed border + a
  `proposed` pill + a label; pending edges are dashed (not just tinted); each
  mode pairs an icon + label; the launcher pairs the `✦` icon + the "Plan with
  AI" text everywhere.
- **A11y** — the canvas + chat are labelled regions (`role="application"` /
  `aria-label`, shipped on `PlanningCanvas` / the rail); the launcher is a real
  `Button` / menu `option`, keyboard-reachable; the ⌘K command follows the
  shipped palette's combobox/listbox pattern; decorative icons are
  `aria-hidden`.

### Deliverable

The three-file set under `design/ai-chat/` for this surface:
`design-notes.md` (this section) · `planning-workspace.mock.html` (source) ·
`planning-workspace.png` (full-page export, Playwright chromium — light,
`deviceScaleFactor: 2`, 1200px wide); `prettier --check` clean. Grounded in
`7.4`/`7.11`/`7.12`/`7.19` (the modes) + `7.20.3`/`MOTIR-1299` (the launcher it
gates); supersedes `MOTIR-898` + `MOTIR-907`.
