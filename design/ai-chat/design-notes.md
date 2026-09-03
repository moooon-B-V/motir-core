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
| **4** | The universal entrance — BOTH hero affordances: the header "Plan with AI" pill + the floating Motir callout; context → mode adapts              |
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

### The orb's colour is READ from the token layer, not painted (MOTIR-3217)

Sheet 4's floating orb is drawn twice (`.fab` on the faux page, `.orb` in the
anatomy close-up and the palette strip). Until 2026-08-20 both carried the same
literal —
`radial-gradient(circle at 33% 27%, #9c81ff, #5645d4 58%, #4733bd)` plus a
`#ffffff6e` rim, a `#5645d4cc` drop and a `#ff64c895` glow — three invented hues
that reached **no token at all**. Two consequences, and the second is the one
that lasts:

- **It could not follow a `data-palette` swap.** `data-palette` re-points
  `--color-primary-fill` / `--color-primary-foreground` / `--color-accent` across
  ten palettes; a hex follows none of them, so this sheet depicted the `motir`
  palette while its own closing note claimed "`--el-*` palette-derived colour".
- **Its first stop measured 2.995:1 against the white mark** — the same WCAG
  1.4.11 miss MOTIR-3207 was filed for, in the asset next door, one week after
  that asset recorded the finding.

Both rules now reproduce the shipped `PlanWithAIFab` `ORB_STYLE` **stop for
stop**, in the tokens the app uses:

```css
background-image: radial-gradient(
  circle at 33% 27%,
  color-mix(in srgb, var(--el-accent-text) var(--orb-lit-mix), var(--el-accent)),
  var(--el-accent) 56%,
  color-mix(in srgb, var(--el-accent) 68%, var(--el-highlight))
);
```

with the rim, drop and glow as `--el-accent-text` / `--el-accent` /
`--el-highlight` mixes, the mark's stroke as `--el-accent-text`, and the first
stop's mix READ from `--orb-lit-mix` — the contrast knob § _B_ documents, never
retyped here. The geometry moved with it: the old sketch's `58%` body stop is
now the shipped `56%`, and the third stop is the shipped
`--el-highlight`-leaning mix rather than a flat `#4733bd`. **Recorded ratios,
default palette: 3.77:1 light · 3.09:1 dark**, with every one of the twenty
palette × theme contexts clearing 3:1.

Only the tokens the orb reads are inlined (Tier-0 `--color-*` → Tier-3
`--el-*` → the paint, extracted verbatim from
`packages/design-system/theme.css`, plus each palette's Tier-0 triplet). **The
rest of this sheet is still an older light-only sketch that inlines the default
palette by hand** as `--accent` / `--border` / `--muted`; that is left alone
deliberately — this card re-expresses colours that already exist, it is not a
re-skin of the board. Sheet 4's palette strip is the visible proof: the same
rule under all ten `data-palette` values, including the four whose
`--color-primary-foreground` is not white.

`tests/theme/orb-glyph-contrast.test.ts` holds both halves — the gradient must
equal the shipped one and contain `var(--orb-lit-mix)`, and no rule the orb is
made of may carry a raw hex. It runs on `design/*` branches via
`vitest.design.config.ts` (MOTIR-2442), which is the only lane that sees them.

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
- **B — the floating Motir orb = the universal AI callout.** A glowing orb
  wearing the **Motir mark** afloat bottom-right on every screen; tapping it opens
  the AI callout — **the home of ALL AI**, where **Plan with AI is ONE action**
  alongside **"Ask about this project"** (Q&A over the plan / docs / work items)
  and **"Help with a task"** (draft / summarise / assist). Planning is the
  capability this design+story deliver now; project Q&A and task assistance are
  **future capabilities reached through the same button**. The callout menu
  composes `Card` + list rows + an "Ask Motir anything…" input.

  > **✅ Deferral discharged 2026-08-19 (MOTIR-3183).** This bullet used to read
  > _"Built now with a mock `M` logo — the real brand logo replaces it later (the
  > orb is the logo's home)."_ It does now. The orb renders the **wave band**,
  > read from `design/brand/wave-band-24.svg`, at a **26 px glyph box in the 56 px
  > circle** (the box the letter occupied, so the swap changes _what_ is in the
  > circle and not how much of it is filled). **Centred geometrically**: the ink
  > centroid sits at (11.705, 11.820) on the 24 grid against a bbox centre of
  > (11.975, 11.975), an offset of 0.27 / 0.16 units = **0.29 / 0.17 px at 26 px**,
  > below half a device pixel — so no optical nudge is applied, and the number is
  > recorded because _"it looks centred"_ is the claim it replaces. The same mark
  > rides the **28 px assistant avatar** in both rails at a 13 px box — the same
  > 0.464 glyph-to-circle ratio, so the two read as one object at two sizes. The
  > mark is `fill="currentColor"` and therefore **needs no dark variant**. Drawn in
  > `ai-callout-menu.mock.html` panel 9; the code swap is MOTIR-3185, which composes
  > `BrandMark` `variant="mark"` rather than inlining an `<svg>`.
  >
  > **⚠️ And a finding, recorded not inherited.** Measured against the orb's own
  > gradient, white-on-accent cleared 3:1 in light (**#8c81e2, 3.32:1** at the
  > gradient's lightest point) and **missed it in dark (#9b90e8, 2.78:1** — WCAG
  > 1.4.11 for a non-text graphic). This was **pre-existing** — the mock `M` was
  > white on the same gradient and measured the same — but this was the pass that
  > measured it. Not changed here: the orb's fill belongs to MOTIR-1811 (`done`).
  >
  > **✅ Fixed 2026-08-20 (MOTIR-3207), and the remedy is one number — though not
  > the one this note proposed.** The shipped values are now **#8275df, 3.77:1**
  > light and **#9286e6, 3.09:1** dark. The note above recommended a _theme-aware_
  > mix on the reasoning that light had headroom at 32%; re-measured across the
  > whole shipped matrix — ten `data-palette` values × both themes, resolved from
  > the tokens rather than from the default pair — that is a property of the
  > **default palette**, not of light. **Four** of the twenty contexts failed at
  > 32% (default dark 2.78:1, `cobalt` dark 2.86:1, `spectrum` dark 3.00:1 —
  > 2.999, under the bar — and `evergreen` **light** at **2.94:1**), so a
  > `[data-theme='dark']` override of the stop would have left a light orb below
  > the bar. The fix is therefore **one global 26%**, expressed once as
  > `--orb-lit-mix` in `packages/design-system/theme.css` and read from there by
  > both `PlanWithAIFab` and `ai-callout-menu.mock.html` panel 9. Worst context
  > after the change: **3.09:1**; all twenty clear 3:1. Because mixing the glyph's
  > own colour into its backdrop is monotonic, the knob is a **ceiling** — only
  > raising it can break the bar — and `tests/theme/orb-glyph-contrast.test.ts`
  > re-derives every context from the tokens on every run.

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

**No browser / window chrome** — it is an in-app overlay, not a browser mock; the
only chrome is the workspace's own top-left controls.

**The canvas title is a drill-down breadcrumb (Yue, 2026-06-24).** The button-
shaped chip top-left is the project **root** (`PayFlow`); drilling into a node
grows it to **`PayFlow › Epic 1 › Story 1`** and walks back up — the **canvas's
own drill-down breadcrumb** (reused from the canvas design, `MOTIR-1009` sheet 6),
not a "plan" action.

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

---

## @-mention work-item picker in the planning chat (MOTIR-1490)

Design for the **@-mention work-item target picker** inside the universal
planning workspace's chat composer — MOTIR-1490, design subtask of
MOTIR-812 (Contextual planning from each work item). The user must be able to
**search/locate a work item and reference it as the planning/re-planning TARGET**
in the chat — like Claude Code's `@ a file` — so the planner sees the target(s)
in the conversation. **Multiple targets** supported.

Grounded in the workflow-defining subtasks (the design-content dependency rule):
**MOTIR-909** (contextual session — the session accepts ONE OR MORE target ids
as a target SET) + **MOTIR-1489** (entrance design — the pre-scoped target
from the entrance). The code subtask this design gates is **MOTIR-1491** (the
picker implementation).

**Asset:** `target-picker.mock.html` (source) + `target-picker.png` (full-page
export). A five-panel review board:

| Panel | What it shows                                                                                                                                                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1** | The `@` trigger — typing `@` in the chat composer opens a search dropdown over the project's work items; each result shows kind icon · key · title · status Pill; type-to-filter; keyboard (↑/↓/Enter/Esc)                                                               |
| **2** | Multi-target tray — the composer above the input carries a "Targets" tray of picked-item chips (reusing the shipped `WorkItemRefChip` vocabulary); user can add several and remove any (⨉). States: empty, one target, multiple targets, the @-trigger button affordance |
| **3** | Targets in the conversation — a sent turn shows the target chips in the bubble; the map (canvas) highlights the target node(s) with the accent active ring + glow + "Target" pill                                                                                        |
| **4** | States — empty (no query: "Type to search…"), short query ("Keep typing…"), loading (spinner + "Searching…"), no-results ("No work items match 'zzqq'")                                                                                                                  |
| **5** | Pre-scoped entrance — opened from an item's Plan/Re-plan entrance (MOTIR-1489), that item is pre-filled as an initial target in the tray; the user can remove it or add more                                                                                             |

### ⚠️ COMPOSES, DOES NOT REDRAW (design-compose rule, notes #82 + #95)

Every element this surface needs already exists in shipped form; the @-picker
is an ARRANGEMENT of them, never a redesign:

- **The chat rail** = the shipped `DiscoveryChatRail.tsx` language, reproduced
  faithfully in the mock (rail head + dot + "Motir AI" label + mode chip,
  `Bubble` + `Avatar`, the composer `Input` + `Send` button). The one NEW
  element is the @-trigger + targets tray — both live above/beside the
  existing composer input.
- **The @ search dropdown popup** = the shipped work-item-search row vocabulary
  from `design/work-items/internal-links.mock.html` panel 3 (`.pop-row`:
  type-icon · mono key · title · status Pill), adapted for a chat-context
  dropdown. The search fetcher reuses the shipped
  `lib/mentions/workItemMentionSearch.ts` (`GET /api/work-items/mention-search`).
  Results are scoped to the currently active project — the same scope the
  contextual session operates in. This is NOT the Tiptap `@`-mention picker
  (`markdownEditorMentions.tsx`) — the chat composer is a plain text input,
  not a rich-text editor, so the picker is a standalone combobox dropdown.
- **The inserted chip** IS the shipped `WorkItemRefChip` (5.8 /
  MOTIR-1399, done) — `components/markdown/WorkItemRefChip.tsx`, the
  `.wi-chip` vocabulary with type icon · mono key · title. The targets tray
  COMPOSES it — never redesigns the chip. (No status dot in this context —
  a target assignment doesn't imply status relevance.)
- **The map highlight** = the shipped canvas "active" node state from
  `design/ai-chat/planning-workspace.mock.html` (`.node.active`: accent
  border + ring + glow), plus a "Target" pill above each target node so the
  user SEES which part of the plan the planner is acting on.

### How it works (grounded in the workflow spec)

1. **The `@` trigger.** Typing `@` (or clicking the @ button) in the chat
   composer opens the search dropdown. The dropdown reuses the shipped
   work-item-search fetcher debounced at N ≥ 2 characters; results carry
   kind icon · key · title · status Pill. Keyboard: ↑/↓/Enter/Esc;
   `aria-activedescendant` on the listbox.
2. **Picking a target.** Enter/click on a result adds that item's chip to the
   targets tray ABOVE the input; the dropdown closes; the input keeps focus
   so the user can continue typing the message.
3. **Multi-target.** The user can add several targets by repeating `@` →
   pick. Each chip carries a ⨉ remove button; clicking it removes that target
   from the set. The tray label reads "Target" (singular) or "Targets"
   (plural). The session API (MOTIR-909) accepts the target SET as
   `targetKeys[]`.
4. **Sending a turn.** When the user sends, the turn bubble shows the target
   chips in compact form (semi-transparent accent chips, plus a "Targeting
   n items" label). On the canvas (left), the target node(s) are highlighted
   with the active ring + glow + "Target" pill — the chat ↔ canvas link is
   explicit. The targets tray stays populated across turns until the user
   removes them.
5. **Pre-scoped entrance (MOTIR-1489).** When the Plan/Re-plan entrance opens
   the workspace from a specific item, that item is pre-filled as the initial
   target in the tray; the canvas highlights it; the AI's opening turn
   acknowledges the scope. The user CAN remove it (⨉) and/or add more — the
   entrance sets the _initial_ target, not a locked one.

### Primitives composed (no hand-rolling)

| Element                        | Built from                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| chat rail + bubbles + composer | the shipped `DiscoveryChatRail` language — `Card`/`Avatar`/`Input`/`Button`                                         |
| @-search dropdown              | the shipped `.pop`/`.pop-row` vocabulary from `internal-links.mock.html` panel 3 + the `mention-search` API fetcher |
| target chip in tray            | the shipped `WorkItemRefChip` component (`internal-links.mock.html` panels 0–2)                                     |
| ⨉ remove button                | `Button` (icon-only, `--radius-control`, ghost) with a `X` lucide icon                                              |
| map highlight                  | the shipped `.node.active` accent ring + glow from `planning-workspace.mock.html`                                   |
| @-trigger button               | `Button` (mono `@` glyph, `--radius-control`, soft fill) in the input's left padding                                |
| icons                          | lucide-react (`Search`, `X`, `BookOpen`, `CheckSquare`, `Bug`, `GitPullRequest`, `Target`)                          |

### Token / a11y discipline

- **Colour** strictly via `--el-*` (the mock inlines the real light-palette
  values). The dropdown popup reuses `--el-surface` / `--el-border` /
  `--el-muted`; the type icons are `--el-type-*`; the status Pill puts the
  hue in the tint background with `--el-text-strong` (finding #35, AA). The
  map highlight uses the accent ring (`--el-accent`) + glow (`--el-highlight`).
  The @-trigger button is `--el-muted` text on `--el-surface-soft`.
- **Shape** strictly via element-semantic tokens — the dropdown =
  `--radius-card`, rows = `--radius-control`, the @ button = `--radius-control`,
  chips = `--radius-control`, the send button = `--radius-btn`,
  shadow = `--shadow-elevated`. `rounded-full` only on the rail's status dot.
- **Not colour alone** — the `@` trigger pairs a glyph + "type to search" hint;
  the active dropdown row pairs highlight + `aria-selected`; each target chip
  pairs the type icon + key (not just a hue); the map "Target" pill pairs a
  label + the ring.
- **A11y** — the dropdown is a `role="listbox"` with `aria-label` and
  `aria-activedescendant`; the @ button is a real `Button` with a label; the
  ⨉ remove button has `aria-label="Remove <key>"`; the targets tray is a
  labelled group; decorative icons are `aria-hidden`.

### Deliverable

The three-file set under `design/ai-chat/` for this surface:
`design-notes.md` (this section) · `target-picker.mock.html` (source) ·
`target-picker.png` (full-page export, Playwright chromium — light,
`deviceScaleFactor: 2`, 1200px wide); `prettier --check` clean. Grounded in
MOTIR-909 (session API) + MOTIR-1489 (entrance) + MOTIR-1399 (work-item-link
chip, shipped); gates MOTIR-1491 (code implementation).

---

## ⭐ Changing a plan is a CONVERSATION — the plan-change mode + the retired "Augment from prompt" door (MOTIR-1727, 2026-07-27)

**What changed, and why.** Product decision (Yue, 2026-07-27): **a change to the
plan is ALWAYS a conversation** — a single prompt is not enough to reshape a
plan. The shipped one-shot **"Augment from prompt"** entry (`MOTIR-903`, done) is
therefore retired: a `Button` in the `/backlog` + `/items` toolbars opening a
`Modal` with ONE `Input`, POSTing `{ prompt }` and rendering the delta in a fixed
bottom-right `PlanEditsReviewDock` — **with no way to refine**. If the result is
wrong you re-run a different prompt. That is a vending machine, not a planning
conversation, and it is a **second, bespoke AI surface** beside the universal
workspace (breaking the "all AI conversation rides ONE surface" invariant).
Story **MOTIR-1726** replaces it with the conversational surface and removes the
button.

**This amendment adds a STATE, it does not redraw the workspace.** The
`planning-workspace.mock.html` section above already specifies the four MODES as
states of the one surface, "each tied to its entrance door" — its **sheet 3**
names _"Augment / re-plan — 7.11 · Door: a project surface with a plan"_. That
mode was named but never drawn. This asset draws it, and sheet 3's mode card now
points here. **Nothing structural is new**: the two-pane frame, the canvas node +
edge language, the chat rail, the confirm-to-persist bar and the close-with-pending
guard are all composed verbatim from that asset.

**Grounded in the workflow-defining subtasks** (the design-content dependency
rule — design TO the spec, never invent the flow): **MOTIR-1729** (the workspace
HOST for an established project — mode + originating context, replacing the
launcher's dead-end round-trip), **MOTIR-1730** (the conversational rail — turn
list, composer, streamed delta, in-canvas diff, approve/discard, and the rail
STAYS OPEN after either), **MOTIR-1728** (the persisted, project-scoped session
whose ACCUMULATED turns drive the already-shipped `POST /api/ai/augment` job
contract — no engine change), and **MOTIR-1731** (the removal + its i18n and E2E
sweep).

**Asset:** `plan-change-conversation.mock.html` (source) +
`plan-change-conversation.png` (full-page export). A seven-panel review board:

| Panel | What it shows                                                                                                                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **The door** — the shipped `/backlog` chrome with the hero pill in `TopNav`, the floating **M** orb, ⌘K, and the `/roadmap` empty-state CTA; the augment button marked for retirement                           |
| **2** | **Opening it** on an ESTABLISHED project — the overlay over the (dimmed, inert) backlog, canvas seeded with the project's EXISTING tree, mode chip `plan change`, the **empty** conversation with starter chips |
| **3** | **The conversation** — turn 1 → proposal → turn 2 REFINES it → the **streaming** reply (caret + `Spinner`), canvas updating incrementally                                                                       |
| **4** | **Review** — the proposed changes as a **DIFF ON THE CANVAS** (add / change / remove) with `done` work **LOCKED**, the confirm-to-persist bar, and the corner `PlanEditsReviewDock` shown as **was → now**      |
| **5** | **The removed door** — `/backlog` and `/items` toolbars **today vs after**, drawn to scale, plus what deliberately STAYS                                                                                        |
| **6** | **Rail states** — empty · streaming · review · error · out of credits · after approve                                                                                                                           |
| **7** | **What it composes** — every element mapped to the shipped component or design that owns it                                                                                                                     |

### ⭐ Drawn against SHIPPED REALITY — rendered before drawn

Per design-against-shipped-reality (and lesson #73 — a surface reasoned from
`.tsx` alone silently drifts), every app strip on this board was **rendered from
the running app first** (production build, signed in, a PayFlow project, with
`MOTIR_AI_URL` + `MOTIR_AI_SERVICE_TOKEN` set so the launcher mounts). What the
render corrected:

- **The `TopNav` right cluster order** is `[Plan with AI] [Build in public]
[+ Create ⌘C] [Search ⌘K] [bug] [screen] [bell] [avatar]` — the hero pill
  **leads** the cluster.
- **The two toolbars put the augment button in DIFFERENT places.** `/backlog`:
  `[View all work items] [Filter] [Advanced] [Saved ▾] [+ New work item]
[Augment from prompt]` — it **trails**. `/items`: `[Archived] [Filter]
[Advanced] [Saved ▾] [Tree ▾] [Augment from prompt] [+ New work item]` — it sits
  **between** the view switcher and New work item. Panel 5 draws both.
- **The vocabulary is "work item", not "issue"** — the real labels are
  _New work item_, _View all work items_, _Work Items_.
- **The launcher is gated**: `(authed)/layout.tsx:153` mounts the pill AND the FAB
  only when `isMotirAiConfigured() && activeProject`. With AI unconfigured the
  header has no pill at all — worth knowing before assuming the door is present.

### ⚠️ The door is GLOBAL — which is why the removal costs no access

The entrance was already corrected to be **global, not per-surface** (sheet 4,
2026-06-24): the header pill + ⌘K + the floating orb are on **every** PM screen,
so "Plan with AI" is summonable from `/backlog`, `/items` and `/roadmap` without
any of them owning a button. **"Augment from prompt" is the leftover of the older
per-surface model.** Retiring it removes a duplicate door, not a capability.

**But the door currently dead-ends on an established project** (verified, rung 2):
`planningWorkspaceHref()` returns `/onboarding?mode=…&from=…`, **no file reads
`?mode=`**, and `app/(onboarding)/onboarding/page.tsx` redirects an
onboarding-ran project to `/roadmap` — so the pill round-trips. MOTIR-1729 owns
the host that makes panel 2 real; this design does not assume it exists today.

### The conversation — multi-turn is the whole point (panel 3)

- **Turn 2 REFINES turn 1; it does not re-run it.** Each turn appends to a
  persisted, project-scoped session and the **ACCUMULATED** intent is submitted
  (MOTIR-1728), so "split it into monthly and yearly" lands on the proposal
  already on the canvas. The session is persisted, so **re-opening the workspace
  resumes the same thread**.
- **Streaming** uses the shipped `DiscoveryChatRail` language unchanged: partial
  text in an `aria-live="polite"` region with a caret, then the `Spinner` row
  while the delta is computed. The canvas places each proposed item as it arrives.
- **Empty is never a blank screen** — the canvas already shows the plan; only the
  conversation is empty. Three **starter chips** (outcome-phrased: _add work to an
  epic_ / _re-sequence what's left_ / _drop something we don't need_) prefill the
  composer. They are hints, not a mode menu.

### ⚠️ The review surface is the CANVAS, not a corner dock (panel 4)

The delta renders **on the canvas, on the node it affects** — this replaces
`PlanEditsReviewDock` **for this flow**. Four node states, each pairing a border
treatment + a glyph + a word (never colour alone):

| State      | Treatment                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------ |
| **add**    | dashed `--el-accent` border + faint accent-tinted surface + `＋ add` corner tag + `added` pill   |
| **change** | solid `--el-info` border + `--el-tint-sky` wash + `✎ change` tag + `changed` pill + what changed |
| **remove** | dashed `--el-danger` border + `--el-tint-rose` wash + struck-through title + `− remove` tag      |
| **locked** | **hatched** surface + 🔒 lock glyph + `✓ done` + `can't change` pills + `locked` tag             |

- **`done` work is LOCKED and the lock is legible.** The completion-aware
  guarantee (7.11) becomes visible: the engine proposes AROUND finished work,
  never over it, and the AI says so in the rail. An attempted immutable edit is
  rejected server-side.
- **Confirm-to-persist.** Nothing reaches the DB until **Approve changes**;
  **Discard** writes nothing. **After either, the conversation stays open** — that
  is what makes it a conversation rather than a transaction. Dismissing with a
  pending proposal raises the shipped close-with-pending guard (sheet 6).
- **Page state after approve:** the canvas is a **client island that owns its own
  state**, so it will NOT see `router.refresh()` — it needs an explicit refetch
  trigger; the server-rendered counts behind the overlay take the refresh. Both,
  where both apply (`motir-core/CLAUDE.md`).
- Edges keep the canvas's own language: firm neutral parent→child, **dashed
  accent** for proposed edges, dashed `--el-danger` into a removed node.

### ⚠️ The REMOVED door is drawn too (panel 5) — the removal corollary

Per `notes.html` **#154**, a decision that **removes** an affordance must spawn
its matching design amendment in the same pass, or the design of record keeps
depicting a control the product no longer has. Panel 5 is that amendment: the
`/backlog` and `/items` toolbars are drawn **today vs after**, to scale, one above
the other. **Nothing else shifts** — the toolbars are a plain flex row, so the
neighbour simply becomes the last control.

**What is lost:** one control on two surfaces, its `Modal` (a single `Input` +
Submit), and the three `planEdits.augmentPrompt*` keys in **both** locales.
**What deliberately stays:** the item-scoped `expand` / `replan` row actions
(`PlanEditsTrigger`) and their dock, the `/ready` expansion nudge, and
`POST /api/ai/augment` with its whole job path — the conversation drives that
same endpoint. Converging the row actions onto this workspace rides the per-item
entrance (MOTIR-812), not this story.

### States (panel 6)

**Empty** (opener + starter chips; the canvas still shows the plan) ·
**streaming** (partial text + `Spinner`, Send disabled until the turn settles) ·
**review** (rail mirrors the canvas bar's counts) · **error** (`role="alert"`,
**recoverable in place** — the thread and any prior proposal survive a retry) ·
**out of credits** (distinct from an error: nothing failed, the capability is
cloud-gated; the canvas stays readable) · **after approve** (the thread
continues — a plan change is rarely one change).

### Primitives composed (no hand-rolling)

| Element                                           | Built from                                                                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the two-pane workspace frame                      | the shipped `components/planning/PlanningWorkspace.tsx` (`grid grid-cols-1 md:grid-cols-[1fr_22rem]`)                                                       |
| the header hero pill + the floating orb           | the shipped `PlanWithAILauncher` + `PlanWithAIFab`, mounted by `(authed)/layout.tsx` — never a hand-rolled AI affordance                                    |
| canvas, nodes, edges, zoom, search, crumb         | the standalone work-item canvas — design `design/roadmap/` (MOTIR-1009) over `ProjectRoadmapCanvas` / `PlanningCanvas`; composed, never redrawn             |
| the diff rendering                                | `components/planning/PlanReviewCanvas.tsx` (already feeds proposed items into the canvas as data); this asset adds only the change / remove / locked states |
| the chat rail (head, bubbles, drafting, composer) | the shipped `DiscoveryChatRail` language — `Card`/`Avatar`/`Input`/`Spinner`/`Button`; the only per-mode difference is the mode chip                        |
| confirm-to-persist bar + pending guard            | `planning-workspace.mock.html` sheets 2 + 6, unchanged — only the copy names add/change/remove/locked counts                                                |
| the @-mention target picker in the composer       | already designed — `target-picker.mock.html` (MOTIR-1490); composes in unchanged, not redrawn here                                                          |
| the multi-turn session behind it                  | MOTIR-1728 — accumulated turns → the shipped `POST /api/ai/augment` contract; no new job kind                                                               |
| icons                                             | lucide-react (`Sparkles`, `Lock`, `Plus`, `Pencil`, `Minus`)                                                                                                |

### Token / a11y discipline

- **Colour** strictly via `--el-*` (the real light values inlined at the top of
  the mock, as the sibling `design/ai-chat/` mocks do). Every non-token fill is a
  `color-mix()` of two tokens — **no invented hue**; the only raw values are the
  body backdrop and the canvas grid-dot texture (non-semantic decoration). Tinted
  chips put the hue in the **background** with `--el-text-strong` (finding #35,
  AA). Work-item type hues are `--el-type-*`; the hero pill's gradient + glow are
  palette-derived (`--el-accent` → `--el-highlight`) with the label over the
  accent-dominant region.
- **Shape** strictly via element-semantic tokens — node = `--radius-card`, pills =
  `--radius-badge`, buttons = `--radius-btn`, the composer input =
  `--radius-input`, toolbar controls + rail rows = `--radius-control`, elevation =
  `--shadow-{subtle,card,elevated}` — so a `[data-style]` swap reshapes the surface.
  `rounded-full` only on the status dot, avatars and the orb.
- **Not colour alone** — every diff state pairs a border treatment + a glyph
  (＋ ✎ − 🔒) + a word; every rail state pairs its icon with a sentence.
- **A11y** — the canvas and the rail are labelled regions; the streaming reply is
  `aria-live="polite"`, the error is `role="alert"`; a node's diff state is in its
  accessible name ("Recurring invoices, proposed addition"), not its border alone;
  a locked node is `aria-disabled` and says why; Approve / Discard are real buttons
  in the tab order; `Esc` closes through the pending guard.

### Deliverable

The three-file set under `design/ai-chat/` for this surface:
`design-notes.md` (this section) · `plan-change-conversation.mock.html` (source) ·
`plan-change-conversation.png` (full-page export, Playwright chromium — light,
`deviceScaleFactor: 2`, 1200px wide); `prettier --check` clean. Composes
`planning-workspace.mock.html` (MOTIR-1193) + `design/roadmap/` (MOTIR-1009);
grounded in MOTIR-1728 / 1729 / 1730 / 1731; gates those four code subtasks.

---

## ⭐ The Motir callout — the orb becomes a TRIGGER (MOTIR-1811, 2026-08-01)

**What changes.** The shipped floating **"M"** orb (`PlanWithAIFab`, MOTIR-1299)
navigates **straight** to the planning workspace today. It becomes the **trigger
for a small anchored menu** — "the home of all AI" — whose first action is
_Plan with AI_, with _Ask about this project_ (MOTIR-1343) and _Help with a task_
(MOTIR-1344) mounting into the same menu as their stories land. **The orb is the
ONLY entrance this touches** — the TopNav hero pill, ⌘K, the work-item door
(MOTIR-910) and the roadmap door (MOTIR-1011) are all unchanged.

### ⭐ EVERY ROW OPENS THE SAME SURFACE — the menu only says what the callout CAN DO (Yue, 2026-08-01)

> **UNCHANGED by the 2026-08-19 glyph amendment (MOTIR-3183).** That pass renamed the surface in
> prose — _the Motir callout_, whose trigger is _the Motir orb_ — and swapped the letter inside the
> circle for the mark. **It touched no mechanism**: one href shared by every row, a row is a LABEL
> and not a route, a row appears when its capability lands, and a row may seed the composer's
> starter phrasing without constraining the thread. The name changed because it had stopped
> describing the thing; the contract below did not.

Motir has exactly one AI conversation surface — the `PlanningWorkspace` hosted at
`/planning` (MOTIR-1729) — and **all three rows navigate to that one surface with
the same context-derived href**, via the shipped `planningWorkspaceHref()`. The
callout is **not a mode picker and not a router**: it is a **capability list**, an
answer to "what can I ask this thing?", and the row the user picks does **not**
narrow what the conversation can be about.

**Why.** The conversation is free-form and **the user can switch topic
mid-conversation** — plan the sprint, then ask what blocks a card, then get help
drafting its description, all in one thread. A mode chosen at the door would be
wrong within one turn, and enforcing it would fragment the one surface the product
deliberately has. So the door does not choose; it only **advertises**. The topic is
chosen — and re-chosen — inside the conversation.

Three consequences the code subtask must honour:

- **One href, shared by every row.** Not three destinations, not three modes, not a
  thread locked to one kind of question. A row is a **label**, not a route.
- **A row appears when the CAPABILITY exists behind that one surface** (MOTIR-1343
  / MOTIR-1344) — what a story adds is what the workspace can do, never where the
  row points.
- **A row may seed the composer's starter phrasing**, but it never constrains the
  thread. The composer slot is the same door with the first turn already typed.

Still forbidden in the other direction: a row that opens a **bespoke per-feature
chat panel**. Every row is a door to the ONE workspace.

**It DEEPENS the sketch, it does not re-invent it.** `planning-workspace.mock.html`
sheet 4 ("B — Floating 'M': the universal AI callout") already draws the callout
at options-comparison depth — the "Motir AI" header, three icon + title +
description rows, an "Ask Motir anything…" field. That visual language is settled
and reproduced here; what this asset adds is BUILD depth. The orb's own fill, glow
and pulse, and the planning workspace itself (7.20.1 / MOTIR-1193), are composed,
never redrawn.

**Asset:** `ai-callout-menu.mock.html` (source) + `ai-callout-menu.png` (full-page
export). An eight-panel review board:

| Panel | What it shows                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **The access path** — the orb in situ over the shipped authed shell, closed (today: click → `/planning`) then open                    |
| **2** | **The orb's trigger role** — `<Link>` → `Popover.Trigger` + `<button>`, the accessible-name change, and its four states               |
| **3** | **Both menu states** — interim (header + the one live row) · target (three rows + composer) · and the FORBIDDEN "coming soon" variant |
| **4** | **Row anatomy** — icon tile, title, one-line description, and rest / hover / focus-visible / active                                   |
| **5** | **Open · close · keyboard** — the shipped `UserMenu` popover idiom, plus the anchoring + panel props                                  |
| **6** | **Narrow / mobile** — 390 px and 320 px drawn TO SCALE, the width clamp, and the never-covers-the-orb rule                            |
| **7** | **Dark, AA, and surface material** — the real dark token flip, the per-element ink table, `data-surface="popover"`                    |
| **8** | **What it composes** — every element mapped to its shipped owner — and which entrances stay exactly as they are                       |

### ⭐ Drawn against SHIPPED REALITY — rendered before drawn

Per design-against-shipped-reality (lesson #73), both surfaces this design
composes were **rendered from the running app first** (production build, signed
in, an active project, `MOTIR_AI_URL` + `MOTIR_AI_SERVICE_TOKEN` set so the
launcher mounts) and the mock reuses that markup rather than a stylised
stand-in. What the render pinned down:

- **The orb** is an `<a href="/planning?mode=project&from=project">` with
  `aria-label="Plan with AI"` — 56 × 56 (`h-14 w-14`), `fixed right-5 bottom-5
z-40`, `rounded-full`, the radial accent fill + pink aura + the 3.2 s
  `.plan-with-ai-fab-pulse` ring. Measured at **x 1364, y 824** on a 1440 × 900
  viewport and **x 314, y 704** at 390 × 780 — the same 20 px offsets, no
  breakpoint.
- **`Popover.Content` renders `role="dialog"`**, not `role="menu"` — with
  `data-side` / `data-align` / `data-state` on the panel and the shipped
  `UserMenu` holding plain links inside it. That is the keyboard contract this
  design mirrors, and it is why a roving `menuitem` model is explicitly ruled out.
- **The shipped `UserMenu` panel** is 240 px, `--radius-card` (12 px),
  `--el-page-bg`, a `--el-border` hairline, `--shadow-elevated`, `py-1`, a
  bordered header block (`px-3 pb-2 pt-2`) and rows with a 16 px muted lucide
  glyph + a 14 px `--el-text` label.
- **The `TopNav` right cluster** is `[Plan with AI] [Build in public]
[+ Create ⌘C] [Search ⌘K] [bug] [screen] [bell] [avatar]` — the hero pill leads
  it, and it is present on every authed screen, which is why losing the orb's
  direct navigation costs no access.
- **A shape drift worth fixing while mirroring:** the shipped `UserMenu` rows
  render `rounded-(--radius-sm)` with raw `px-2 py-2` — Tier-0 shape a
  `data-style` swap cannot reshape. The callout's rows take the element-semantic
  tokens (`--radius-control`, `--spacing-control-x/y`) instead; rendered values
  are near-identical today, so nothing looks different.

### ⚠️ The interim menu is deliberate — and the fast lane is NOT lost

The menu ships with **one** row, because one capability exists. That is a real cost
(an extra click on the orb) and it is paid on purpose: the header names the
surface so the single row reads as "the first of several", and the architecture
that holds all three actions is built once rather than retrofitted. **The direct
one-click path survives untouched** — the TopNav hero pill and ⌘K still go
STRAIGHT to `/planning` on every screen (panel 8). And `⌘`/middle-click is
preserved one level in, because every row is a real link.

**An action whose story has not landed is ABSENT — never a dimmed, disabled or
"Coming soon" row** (drawn as the forbidden variant in panel 3). A dead row is a
promise the product cannot keep, it costs a tab stop and a screen-reader
announcement, and it makes the interim state feel broken rather than young.

### The panel — anchoring, and the keyboard model it inherits

| Prop               | Value   | Why                                                                |
| ------------------ | ------- | ------------------------------------------------------------------ |
| `side`             | `top`   | the orb hugs the bottom edge — there is no room below              |
| `align`            | `end`   | right edges line up with the orb, away from the viewport edge      |
| `sideOffset`       | `12`    | clears the orb's outer glow (the primitive's default 8 sits in it) |
| `collisionPadding` | `16`    | keeps the panel off every viewport edge when it shifts             |
| `width`            | `288`   | fits the longest description on ONE line; 320 is wider than needed |
| `overflowVisible`  | `false` | static rows only — the default clip is correct                     |
| `modal`            | `false` | the page behind stays scrollable + readable, like the user menu    |

**Keyboard = the shipped `UserMenu` idiom, unchanged.** Open with click / `Enter`
/ `Space`; `Tab` and `Shift+Tab` walk the rows in DOM order (composer last, once
it exists); `Enter` follows the row's `href`; `Esc` or a click outside dismisses;
focus returns to the orb on every close path (Radix's `onCloseAutoFocus`).
**Do NOT invent a roving `role="menu"` pattern** — a second, contradictory model
would make two shell menus behave differently under the same-looking chrome. If a
future card genuinely wants arrow-key roving it must say so explicitly and specify
the FULL `menu` / `menuitem` semantics (`aria-activedescendant` or roving
`tabindex`, typeahead, Home/End); it is not something to half-build.

**Motion.** While the menu is open the pulse **stops**
(`[data-state='open'] .plan-with-ai-fab-pulse { animation: none }`, keyed off the
attribute Radix already sets on the trigger) so the panel never sits inside a
breathing halo — stopping, not `animation-play-state: paused`, which would freeze
the ring at an arbitrary radius. The pulse is already gated behind
`@media (prefers-reduced-motion: no-preference)`, so a motion-sensitive user never
sees it in any state and the open-state rule is a no-op for them.

**Responsive.** `width: min(288px, calc(100vw - 2rem))`; the rows reflow (the
description wraps) rather than truncating. `side="top"` + `sideOffset: 12` put the
panel's bottom edge 12 px above the orb's top, so it can never cover the trigger —
there is never room below for Radix to flip into. At 320 px the collision padding
shifts the panel 4 px, leaving 16 px margins. The orb itself gets no new
responsive rule.

### Primitives composed (no hand-rolling)

| Element             | Built from                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the orb             | the shipped `components/planning/PlanWithAIFab.tsx` — fill, aura, pulse, position, size verbatim; only the ELEMENT changes                                               |
| the panel           | `Popover` / `Popover.Trigger` / `Popover.Content` from `@motir/design-system` (re-exported at `components/ui/Popover.tsx`)                                               |
| header block + rows | the shipped `app/(authed)/_components/UserMenu.tsx` idiom — bordered header, `--el-surface` row hover, muted lucide glyph                                                |
| the destination     | `lib/planning/launcher.ts` — `planningWorkspaceHref()` / `PLANNING_WORKSPACE_PATH`; **ONE href shared by every row** — no new route, no new mode, no per-row destination |
| the composer slot   | `Input` shape tokens (`--radius-input`, `--height-control`); its behaviour is MOTIR-1343's to specify — this asset reserves the slot                                     |
| icons               | lucide-react — `Sparkles`, `MessageCircleQuestion`, `Wrench`, `ArrowUp`                                                                                                  |
| gating              | unchanged — `(authed)/layout.tsx` mounts the orb only under `isMotirAiConfigured() && activeProject`                                                                     |

### Token / a11y discipline

- **Colour** strictly via `--el-*`. The mock's token block is **generated
  verbatim** from `packages/design-system/theme.css` (the Tier-0 `@theme` +
  `[data-theme='dark']` blocks and the Tier-3 `:root,[data-appearance-scope]`
  layer), and every icon is a real lucide `__iconNode` path — so the asset cannot
  drift from the shipped design system and contains **no retyped hex and no
  invented hue**. The header tint and the icon tiles are `color-mix()` of
  `--el-accent` → `--el-highlight` over `--el-page-bg` — the same palette-derived
  recipe the shipped hero pill and orb already use.
- **Shape** strictly via element-semantic tokens — panel = `--radius-card`, rows +
  icon tiles = `--radius-control`, composer = `--radius-input`, chips =
  `--radius-badge`, elevation = `--shadow-elevated`, row padding =
  `--spacing-control-x/y`. `rounded-full` only on the orb and the avatar.
- **Dark** is drawn from the real dark token flip (`data-theme="dark"` **plus**
  `data-appearance-scope`, since the Tier-3 layer is declared on
  `:root,[data-appearance-scope]` and a nested subtree must re-emit it).
- **AA** — the row description is `--el-text-secondary`, never `--el-text-muted`,
  which fails at 11.5 px; tile ink is `--el-accent-text` on the accent-dominant
  gradient and `--el-accent-on-surface` on the tint.
- **Not colour alone** — the primary row is marked by its filled tile AND its
  position; every state pairs a fill with a ring.
- **A11y** — the trigger's accessible name becomes **"Motir AI"** ("Plan with AI"
  moves inside, as the row's name) and Radix adds `aria-haspopup="dialog"` /
  `aria-expanded` / `aria-controls`; rows are real links in the natural tab order;
  focus-visible draws the 2 px `--focus-ring-color` ring inset so it never clips
  at the panel edge.

### Deliverable

The three-file set under `design/ai-chat/` for this surface: `design-notes.md`
(this section) · `ai-callout-menu.mock.html` (source) · `ai-callout-menu.png`
(full-page export, Playwright chromium — light, `deviceScaleFactor: 2`, 1240 px
wide). Composes `planning-workspace.mock.html` sheet 4 (MOTIR-1193); gates the
code subtask **MOTIR-1812** (the callout menu shell), and reserves the rows
MOTIR-1343 / MOTIR-1344 deliver.

---

## ⭐ The planner SPEAKS in the plan-change thread — the findings report, the question, and the waiting rail (MOTIR-2225, 2026-08-05)

**Amendment to this asset set, for `MOTIR-2225`.** `MOTIR-2222` (motir-ai) gives the
planner a voice: **every** planning turn now returns a message — a findings
report before the proposals, and at most one clarifying question when the
request is genuinely not determinate. The plan-change thread has nowhere to put
either. This section draws that room. The code subtask it gates is
**`MOTIR-2226`** (the `assistant` turn role, its rendering, and the reply path),
which is `blocked_by` this design.

**Asset:** `plan-change-planner-speaks.mock.html` (source) +
`plan-change-planner-speaks.png` + `plan-change-planner-speaks.dark.png`. A
six-panel review board, every state drawn **in situ** — inside the real
two-pane workspace, at the rail's real `22rem`, beside the real canvas.

| Panel   | What it shows                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**   | **The access path, unchanged** — the shipped `TopNav` hero pill, the floating **M** orb and ⌘K on any authed screen, opening the one planning workspace this all happens inside |
| **A**   | **The findings report** — the planner's per-turn narration, with work-item chips, arriving **before** the proposals land on the canvas                                          |
| **B**   | **The question, and the whole rail waiting on it** — the asking bubble plus what changes around it, and the comparison table that carries the load-bearing decision             |
| **C**   | **The answer and the resumption** — and the same session reopened hours later, its pending state recovered from the persisted thread rather than from client state              |
| **D·E** | **Work-item chips at realistic density**, and **the question nobody answered** — superseded, marked, never dropped and never blocking                                           |
| **F**   | **Anatomy + the token map** the code card composes, in light and in the real dark flip                                                                                          |

### ⭐ Drawn against SHIPPED REALITY — rendered before drawn (`notes.html` #73)

Every rail fragment on the board is the **real emitted markup** of the shipped
`components/planning/PlanChangeRail.tsx` + `PlanChangeComposer.tsx`, captured by
a headless render of the actual components (the repo's own
`tests/helpers/renderWithIntl` harness → `container.innerHTML`) against the real
`packages/design-system/theme.css`, at the rail's real width. The class strings
in the mock are therefore not a stylised redraw — they are what the app emits,
so the asset cannot silently drift from the implementation and the code card can
lift the new elements' markup verbatim. What the render corrected, versus what
reading the `.tsx` alone would have suggested:

- **An assistant/user contrast already exists**, and it is strong: the assistant
  bubble is the soft `--el-chat-bubble-ai` fill with the accent **M** avatar on
  the LEFT; the user bubble is the accent fill with a `·` avatar and the whole
  row `flex-row-reverse`. A findings report needs **no new treatment at all** to
  read as the planner speaking.
- **The `label` slot already renders inside the bubble** (mono, 10 px, uppercase,
  `opacity-80`) and is used **only by user turns** today (`turn 1`,
  `turn 2 · refine`). That is why the question reuses that slot rather than
  inventing a bubble header.
- **The submission marker is a centred `--el-text-faint` line**, not a bubble —
  the vocabulary both new marker lines borrow.
- **At `22rem` the rail header is already full** (status dot + `Motir AI` +
  mode chip), which is why the pending state lives on the composer and not in a
  header pill.

### ⚠️ INHERITED vs NEW — what is not redrawn

**Inherited, verbatim** from `plan-change-conversation.mock.html` (MOTIR-1727)
and the shipped components it composes: the two-pane frame
(`PlanningWorkspace`, `grid-cols-[1fr_22rem]`), the canvas pane and its node +
edge language (`design/roadmap/`, MOTIR-1009, over `PlanningCanvas`), the rail
head, the assistant `Bubble` anatomy that **panel 3 of that asset already draws
as the AI reply**, the user bubble, the submission marker, the confirm-to-persist
review block, the `@`-target composer, and the exit chrome. **The bubble, the
rail, the composer and the canvas are NOT redrawn here.**

**Genuinely new — four things, and only four:**

1. An assistant turn that is **persisted** (it belongs to the thread's history and
   survives a reload, rather than being local chrome as every assistant bubble on
   screen today is).
2. The **asking** variant of that bubble — the same anatomy with two token values
   swapped and the existing label slot filled.
3. The **answer bar**, a sibling pinned above the composer input where the target
   tray already sits.
4. Two **marker lines** in the shipped marker vocabulary — _Answered — planning
   resumed_ and _Not answered — Motir AI carried on with what you asked_.

### ⭐ The load-bearing decision: a report and a question at a glance

Most turns are reports; questions are rare by construction, because `MOTIR-2222`'s
whole bar is _derive before you ask_. That ratio is exactly what makes a question
dangerous — a rare thing that looks like the common thing gets skimmed, and a
skimmed question is a thread that dies silently with each side waiting on the
other. So the distinction cannot rest on wording, and it does not rest on colour
either. In one sentence:

> **A report changes only the transcript. A question changes the composer.**

|             | report                      | question                   |
| ----------- | --------------------------- | -------------------------- |
| bubble fill | `--el-chat-bubble-ai`       | `--el-warning-surface`     |
| bubble ink  | `--el-text`                 | `--el-warning-text`        |
| label slot  | none                        | `asking` + the `?` glyph   |
| answer bar  | —                           | pinned above the composer  |
| placeholder | _Reply, or refine further…_ | _Answer Motir AI…_         |
| Send button | icon only                   | icon + the word **Answer** |
| canvas      | proposals land              | untouched                  |

**Three cues, none of them colour alone:** a word (`asking` / _Waiting for your
answer_ / **Answer**), a glyph (lucide `message-circle-question-mark`), and a
**position** — the bar sits against the input, which is pinned, so "the planner
is waiting on you" is legible with the thread scrolled anywhere.

**No dashed or dotted border carries the pending state.** Pending is a
token-driven tint plus a label: a hardcoded dashed edge would fight the
`data-style` axis and collide with the canvas's proposed-node language, which
already owns dashed-accent.

**Why a bar and not a header pill:** measured at the rail's real `22rem`, the
header row already carries the status dot, the `Motir AI` label and the mode
chip; a fourth element truncates. The bar has the full width, sits in the pinned
region, and is adjacent to the control whose behaviour actually changed.

### The states (A–E)

| State | What it is                                                                   | How it is drawn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | **The findings report** — what was searched, what came back, what that means | An **ordinary** assistant `Bubble`: same fill, ink, avatar and width as the opener and the proposal summary. It arrives **before** the proposals, so a wrong match is catchable before a branch is built on it (the ordering `MOTIR-2222` asserts on the producing side).                                                                                                                                                                                                                                                                                                                                              |
| **B** | **The question** — the request admits two outcomes the grounding cannot rank | The same `Bubble` with `--el-warning-surface` / `--el-warning-text` and the `asking` label + glyph, **plus** the answer bar, the `Answer Motir AI…` placeholder and the relabelled Send. The canvas stays untouched — nothing is proposed while the planner is blocked.                                                                                                                                                                                                                                                                                                                                                |
| **C** | **The answer, and resumption**                                               | An **ordinary user turn**, labelled `answer` in the slot user turns already number themselves in — not a paired or nested element. Resumption is one centred `--el-text-faint` marker, _Answered — planning resumed_. The bar clears, Send returns to its icon, the placeholder returns.                                                                                                                                                                                                                                                                                                                               |
| **D** | **Referenced work items inside a turn**                                      | The shipped `WorkItemRefChip` autolink, reused as-is (type-hue icon · mono key · title · status dot, peek on click) — no new inline treatment. **Two or three per report is the density**, and it is a decision: the chip is `white-space: nowrap`, so a fourth turns a report at `22rem` into a wall of boxes. A report with no match names none.                                                                                                                                                                                                                                                                     |
| **E** | **A question left unanswered**                                               | **SUPERSEDED — never dropped, never blocking.** The instant the user sends anything else the pending state clears (bar gone, Send an icon, placeholder back) and the planner proceeds on its own best reading of the original request. The question bubble **stays in the thread exactly as it was** — it is a persisted turn and the transcript never rewrites itself — and gains one marker line beneath it: _Not answered — Motir AI carried on with what you asked_. Not dimmed, not struck through, not removed: the user has to be able to see later **why** a plan rests on an assumption they never confirmed. |

**Awaiting is DERIVED, not stored client-side.** The rail is in the awaiting
state exactly when _the last planner turn is a question with no user turn after
it_. That is why panel C's second frame — the same session reopened hours later
from a cold start — comes back to the identical bar, placeholder and button, and
it is what `MOTIR-2226`'s reload criterion asserts.

### Primitives composed (no hand-rolling)

| Element                               | Built from                                                                                                           | Colour                                                     | Shape                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| the two-pane frame                    | the shipped `PlanningWorkspace` (`grid-cols-[1fr_22rem]`)                                                            | —                                                          | —                                                                        |
| canvas pane, nodes, edges             | the standalone work-item canvas (`design/roadmap/`, MOTIR-1009) over `PlanningCanvas` — composed, never redrawn      | `--el-canvas`, `--el-type-*`, `--el-canvas-edge-committed` | `--radius-card`                                                          |
| rail head, bubbles, markers, composer | the shipped `PlanChangeRail` / `PlanChangeComposer` — real emitted markup                                            | as shipped                                                 | as shipped                                                               |
| **report bubble**                     | `Bubble role="assistant"`, unchanged                                                                                 | `--el-chat-bubble-ai` / `--el-text`                        | `--radius-card`                                                          |
| **question bubble**                   | the same `Bubble`, `label` slot filled                                                                               | `--el-warning-surface` / `--el-warning-text`               | `--radius-card`                                                          |
| **asking label**                      | the `label` span user turns already use                                                                              | inherits the bubble ink at `opacity-80`                    | `font-mono text-[10px] uppercase`                                        |
| **answer bar**                        | NEW — a sibling in `PlanChangeComposer`, where the target tray sits                                                  | `--el-warning-surface` / `--el-warning-text`               | `--radius-card`; its button `--radius-control` + `--spacing-control-x/y` |
| **Send → Answer**                     | `Button variant="primary" size="sm"` with a visible label                                                            | `--el-accent` / `--el-accent-text`                         | `--radius-btn`, `--height-btn-sm`                                        |
| **resumed / not-answered markers**    | the shipped `system`-marker line                                                                                     | `--el-text-faint`                                          | `text-center text-xs`                                                    |
| work-item reference                   | the shipped `WorkItemRefChip` (`.wi-chip`)                                                                           | `--el-surface-soft`, key `--el-link`, hue `--el-type-*`    | `--radius-control`, `--spacing-kbd-x/y`                                  |
| the entrance (panel 1)                | the shipped `PlanWithAILauncher` + `PlanWithAIFab` + ⌘K — unchanged, drawn so the reader sees the door               | palette-derived hero gradient                              | `--radius-badge`                                                         |
| icons                                 | lucide-react — `message-circle-question-mark`, `send`, `at-sign`, `sparkles`, `check`, the `--el-type-*` kind glyphs | —                                                          | —                                                                        |

### Token / a11y discipline

- **Colour** strictly via `--el-*`. The mock's stylesheet is Tailwind's **real
  output for this page**, built over `packages/design-system/theme.css`, so the
  Tier-0 `--color-*`, the `[data-theme='dark']` flip and the Tier-3 `--el-*`
  layer are the shipped values verbatim — **no retyped hex and no invented hue**.
  Even the canvas grid-dot texture is a `color-mix()` of two tokens.
- **Shape** strictly via element-semantic tokens (`--radius-card|control|input|badge`,
  `--spacing-chip-x/y`, `--spacing-control-x/y`, `--spacing-kbd-x/y`,
  `--height-btn-sm`, `--shadow-*`), so a `data-style` swap reshapes the new bar
  exactly as it reshapes the bubbles. `rounded-full` only on the status dot, the
  avatars and the orb.
- **AA** — charcoal `--el-warning-text` on `--el-warning-surface` is the
  tint-background recipe finding #35 pins (~10:1 in both themes); the hue never
  lands under light ink. The `See it` control is a real button, not link-coloured
  text on a tint.
- **Not colour alone** — every new state pairs its tint with a word AND a glyph,
  and the awaiting state additionally changes a control's label and position.
- **Dark** is drawn from the real token flip (`data-theme="dark"` **plus**
  `data-appearance-scope`, since the Tier-3 layer is declared on
  `:root,[data-appearance-scope]` and a nested subtree must re-emit it). The
  states stay distinguishable — the warm `--el-warning-surface` against the
  near-black `--el-chat-bubble-ai` — which is why the `.dark.png` ships.
- **A11y** — the question is an ordinary turn inside the rail's existing
  `role="log"`; the answer bar is not an alert (nothing failed) but its copy
  names the state in text, so it is announced when the log updates; the composer's
  `aria-label` tracks its placeholder, as the shipped composer already
  guarantees; `See it` moves focus to the question turn; decorative glyphs are
  `aria-hidden`.

### Deliverable

The three-file set under `design/ai-chat/` for this surface: `design-notes.md`
(this section) · `plan-change-planner-speaks.mock.html` (source) ·
`plan-change-planner-speaks.png` (+ `.dark.png`), full-page Playwright chromium
exports, `deviceScaleFactor: 2`, 1240 px wide; `prettier --check` clean.
Composes `plan-change-conversation.mock.html` (MOTIR-1727) +
`planning-workspace.mock.html` (MOTIR-1193); grounded in the producer
**MOTIR-2222**; gates the code subtask **MOTIR-2226**.

---

## ⭐ Ask about this project — the cited ANSWER turn, and the chrome that follows the turn (MOTIR-1815, 2026-08-20)

**What changes.** A turn in the one conversation can now be a **question** rather
than a plan change. Nothing about the surface changes with it: the same
workspace, the same rail, the same composer, the same single door. What changes
is that a turn has an **intent**, that intent is resolved by the server and comes
back on the turn, and the canvas chrome follows the **latest turn**.

**Asset:** `ask-answers.mock.html` (source) + `ask-answers.png` (full-page
export). A nine-panel review board.

| Panel | What it shows                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------- |
| **1** | **The door** — the "Ask about this project" row, what it opens, and the one thing it seeds                     |
| **2** | **The cited ANSWER turn** — the new turn form, and why citations are inline                                    |
| **3** | **⭐ The chrome transition** — one footer slot, two contents, drawn at all three moments                       |
| **4** | **A mixed thread in both orders** — ask→change and change→ask, and how the two turn kinds read apart           |
| **5** | **The correction marker** — both labels, and what re-running a turn does to the transcript                     |
| **6** | **The redirect's second stream** — the hand-off state, so the rail never shows two spinners with a gap between |
| **7** | **Six states** — empty · thinking · answered · **no confident answer** · error · out-of-credits                |
| **8** | **Dark, and the ink every new element carries** — the real token flip and the per-element AA table             |
| **9** | **What it composes** — every element mapped to its shipped owner, and the four things this asset actually owns |

### ⚠️ SCOPE — four elements, and everything else is composed

The two-pane frame is `planning-workspace.mock.html` (MOTIR-1193); the rail
shell, its bubbles, its markers, its composer and the confirm bar are
`plan-change-conversation.mock.html` (MOTIR-1727) and
`plan-change-planner-speaks.mock.html` (MOTIR-2225); the canvas is
`design/roadmap/` (MOTIR-1009). **None of them is re-specified here.** This asset
owns exactly four things: the **answer turn's form** (panel 2), the **canvas
footer slot** (panel 3), the **correction marker + the redirect hand-off**
(panels 5–6), and the **ask row's copy, the fourth starter and the widened
opener** (panel 1).

**And it does NOT own the avatar's glyph.** The Motir mark inside the 28 px
assistant circle is the sibling glyph design's element (MOTIR-3183, § "The
identity glyph wherever Motir speaks"); its path lives in
`components/brand/waveBand.ts` and reaches every surface through
`BrandMark variant="mark"`. This asset draws that specimen at the 13 px it
specifies and re-decides nothing about it. **No stand-in letter appears anywhere
in the asset.**

### ⚠️ Two rungs above fix what this may draw — cited, never re-opened

- § **"EVERY ROW OPENS THE SAME SURFACE"** (above): every row shares ONE href, a
  row is a **label** and not a route, and a row may seed the composer's starter
  phrasing without constraining the thread.
- **`docs/decisions/conversation-turn-intent.md`** (MOTIR-1816): §1 intent is
  **server-resolved** and the client sends none; §2 `ask` is the one door and the
  resolver is the `ask_project` job's first step; §3 a mis-read is corrected by
  **re-running the same turn**; §4 the not-confident default is `ask`; §5 intent
  is per-**TURN** and a row seeds TEXT only.

So there is **no ask/act switch** in the composer, **no `?mode=ask`**, no second
href, no per-feature chat panel, and no session-scoped state a thread can be
stuck in. Every state drawn is reachable from every other by typing the next
sentence.

### ⭐ The load-bearing finding — the confirm bar MOUNTS today, and three canvas controls ride on it

Measured in the shipped component rather than assumed.
`PlanningWorkspaceHost` renders the confirm bar as a `shrink-0` flex **sibling
below** a `min-h-0 flex-1` canvas box, conditionally
(`state.review && !state.decided && !index.isEmpty`). So the bar mounts and
unmounts, and the canvas box grows and shrinks by its full height.

That would be nearly harmless if the canvas were a static page. It is not:
`ProjectRoadmapCanvas` anchors **three control clusters to the bottom of that
box** — the engine's zoom + fit cluster (`bottom-4 left-4`), the LOCATE control
(`bottom-4 left-[8.25rem]`) and the full-screen control (`right-3 bottom-4`).
Alternating between a question and a change — the exact rhythm this story invites
— would make the canvas's own furniture hop on every turn. The nodes do **not**
move (there is no `ResizeObserver` and no fit-on-resize, so pan and zoom survive);
the jump is entirely in the bottom-anchored chrome, which is why the fix belongs
to the **box** and costs nothing else.

**The answer: ONE footer slot, always mounted, two contents.**

|             | Resting (post-answer, and every state with no pending proposal)                                                                                                    | Proposal pending                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| **box**     | identical — `border-t --el-border`, `bg --el-surface`, `px-4 py-2.5`, and a two-line text column whose lines BOTH `truncate`. **57 px, measured, in both states.** |
| **line 1**  | "Roadmap — as saved" · `--el-text-secondary`, 600                                                                                                                  | "1 added · 1 changed" · `--el-text`, 650 |
| **line 2**  | "Nothing proposed. The conversation has changed nothing."                                                                                                          | "Nothing is saved yet."                  |
| **actions** | none                                                                                                                                                               | Discard (ghost) · Approve (primary)      |

**The truncation is load-bearing.** The heights match STRUCTURALLY — same box,
same two type sizes — rather than by a pinned `min-h`, which would drift the
moment the bar's own content changed. Both lines truncate (the shipped bar's own
recipe), so neither state can grow a third line: let the title wrap and the gate
measures 64 px against the resting slot's 57, and the jump is back.

The bar does **not** animate out, because it never leaves: a 120 ms opacity
cross-fade of the contents, no transform and no height animation. What this costs
the shipped code is one level of nesting — the conditional **mount** becomes a
conditional **content**, on the same predicate — which is why "chrome follows the
turn" is a composition here and not a redesign. `PlanChangeConfirmBar` itself is
untouched.

The resting slot is deliberately **not** a status bar that accumulates things to
say: it has exactly those two lines in every non-proposal state. Its second line
is the ask's own promise made visible — **an ask writes nothing** — at the one
moment a person might wonder whether their question moved something.

### The cited answer turn — citations are INLINE, and the count line is not a second list

An answer is an **ordinary assistant bubble**: same fill, ink, avatar and width
as the opener and the planner's findings report. It needs no new treatment to
read as Motir speaking — the finding MOTIR-2225 already made.

**Citations sit inline, in the prose that rests on them**, rendered by the
shipped path (`MarkdownView` → `WorkItemRefChip`). Three grounds, the first
decisive:

1. **The rail already cites inline.** An assistant findings report renders its
   `[KEY](motir:<id>)` tokens through exactly that path, and the shipped
   component says so in the imperative — _"never a second inline treatment
   invented for this surface."_ A trailing source list would be a second citation
   treatment on the same bubble in the same rail.
2. **The mirror links inline.** Rovo and Linear both render references in the
   sentence; the numbered-footnote model belongs to a full-page answer surface,
   and in a 332 px rail a bibliography routinely out-lengths the answer.
3. **Checkability.** A citation beside the **claim** says which sentence rests on
   what. A trailing list says only what was read.

The envelope's `citations` array is the grounding **contract**, and an answer may
rest on items the prose never names — so one quiet line inside the bubble,
_"Answered from 6 work items"_, states the size of the evidence base without
re-rendering it. It is a **number**; the two treatments cannot be confused.

**A user turn is plain text.** The shipped rail renders `{turn.body}` for a user
bubble and `<MarkdownView>` only for an assistant one, so a key the person typed
stays a key and a chip appears only where Motir cited something. That asymmetry
is shipped and is kept.

### The two turn kinds are deliberately NOT differentiated by their bubble

Tinting answers would say "these are two conversations", which is the one thing
this story exists to deny. What separates them is **what each turn carries** —
citations and a count line, or a "Sent to Motir AI" submission marker and a
canvas state — every one of which is meaningful on its own. No distinction rests
on colour alone. A question asked mid-review does **not** discard the pending
proposal: `state.review` is what the footer reads, and an ask writes nothing to
it. Asking mid-review is a lookup, not an abandonment.

### The correction marker, and the redirect's second stream

The marker sits under the **assistant** turn — the moment the user discovers the
mis-read — as a single centred line in the shipped marker vocabulary. Two labels:
**"Propose changes instead"** under an answer, **"Answer this instead"** under a
proposal. It re-runs the **original user turn** under the other intent (no second
user turn), appends a **new** assistant turn, and leaves the superseded one on the
thread undimmed and unstruck — a correction is a second answer, not an erasure.
Only the latest assistant turn carries a marker, so a thread never offers two ways
to re-run the same turn. It is an interactive marker (`--el-link`, underlined, a
real `<button>` in the tab order), distinguished from the passive ones by ink AND
underline; while the re-run streams it becomes a disabled _"Re-reading…"_ rather
than disappearing, and once it fires a passive line — _"Re-read as a plan
change"_ / _"Re-read as a question"_ — says why a second assistant turn exists.

Because `ask` is the one door, a plan-change turn **streams twice** (ADR
Consequence 3). The rail draws **one continuous waiting state** across both jobs:
the waiting bubble never unmounts, its text is swapped in place, and the hand-off
is named in a marker — _"Reading it as a plan change — working on the
proposal"_ — because it is provenance, not conversation. The footer slot stays
**resting** until the proposal exists. A failure in either stream lands in the
shipped error state; Motir never falls through to the other intent.

### The door — one row, one starter, one widened sentence

The row is a **single entry** in `aiCalloutActions()` — icon
`message-circle-question` (the name the shipped registry already reserves in its
own comment), title **"Ask about this project"**, description **"Answer questions
about the plan, docs and work items"** — drawn to the row anatomy MOTIR-1811
specifies, carrying the same `planningWorkspaceHref(context)` every other row
carries. Nothing in `AiCalloutMenu` or on the orb changes.

**The row seeds NOTHING into the composer; the STARTER SET grows by one.** The
rail already has the mechanism the shipped spec's "seed the composer's starter
phrasing" describes — `STARTERS`, chips that **prefill** the composer on click and
never send. So the seed is one more chip, _"What's blocked, and why?"_, and it
belongs to the **surface** rather than to the row: it shows however the user
arrived. A pre-filled **value** was rejected on two grounds — it is in the way of
anyone who wanted to ask something else, and a stub sent unedited becomes a real
turn that costs a real job. A starter chip cannot be sent by accident, and being
surface-scoped it provably carries no intent through the door (§5).

**The opener widens.** Shipped copy is _"What should change?"_, which is now half
the truth and quietly discourages the other half. It becomes **"What should
change — or what would you like to know?"** — one sentence, both capabilities,
still one thread.

### The states

Six, and the fourth is the one that matters. **No confident answer** is an honest
_"I can't answer that from this project"_ — an ordinary bubble, not an error,
because nothing went wrong — and it is still a **cited** answer: it says what it
searched (_"Searched 214 work items and 3 decision records"_), so "I don't know"
is checkable rather than a shrug. **Error** and **out-of-credits** are the shipped
rail error slot and the shipped gateway gate (MOTIR-803), composed unchanged; what
this asset records is that an **ask** reaches them too. The footer slot is
**resting** in all six unless a proposal is pending from an earlier turn.

### Primitives composed (no hand-rolling)

| Element                                     | Shipped owner                                                  |
| ------------------------------------------- | -------------------------------------------------------------- |
| two-pane workspace frame                    | `planning-workspace.mock.html` · `PlanningWorkspaceHost`       |
| rail shell · head · turn list · composer    | `plan-change-conversation.mock.html` · `PlanChangeRail`        |
| bubble · marker vocabulary · asking variant | `plan-change-planner-speaks.mock.html` (MOTIR-2225)            |
| roadmap canvas · diff rings · its controls  | `design/roadmap/` · `ProjectRoadmapCanvas`                     |
| confirm bar                                 | `PlanChangeConfirmBar` — **unchanged**; it moves INTO the slot |
| callout panel · row anatomy · keyboard      | `ai-callout-menu.mock.html` (MOTIR-1811)                       |
| the assistant avatar's MARK                 | the glyph design (MOTIR-3183) · `BrandMark` · `waveBand.ts`    |
| citation chip                               | `WorkItemRefChip` · `markdown-editor.css`                      |
| error · out-of-credits                      | the shipped rail error slot · the gateway gate (MOTIR-803)     |

### Token / a11y discipline

| New element                 | Ink on fill                                        | Light / dark     |
| --------------------------- | -------------------------------------------------- | ---------------- |
| count line                  | `--el-text-secondary` on `--el-surface-soft`       | 6.51 / ≥6 ✓      |
| correction marker           | `--el-link` on `--el-surface` — **and underlined** | AA ✓             |
| hand-off marker             | `--el-text-secondary` on `--el-surface`            | 6.24 / ≥6 ✓      |
| footer slot · resting lines | `--el-text-secondary` on `--el-surface`            | 6.24 / ≥6 ✓      |
| ask starter chip            | `--el-text-strong` on `--el-tint-lavender`         | tint-bg recipe ✓ |
| callout row description     | `--el-text-secondary` — shipped                    | as shipped       |

**Neither `--el-text-muted` nor `--el-text-faint` carries text anywhere in the
asset.** Muted clears AA only on the white page (4.54, 0.04 of headroom) and every
surface here is `--el-surface` or `--el-surface-soft`, where it measures
4.17–4.34 and fails. Faint clears AA on nothing; its one appearance is the shipped
chip's 6 px status **dot** — a `background`, not an ink, carrying no text and
pairing its hue with a position.

Shape flows through element-semantic tokens only — `--radius-card`,
`--radius-control`, `--radius-btn`, `--radius-badge`, `--radius-input`,
`--spacing-control-*`, `--spacing-chip-*`, `--spacing-kbd-*`, `--height-btn-sm`,
`--height-input`. No raw hue anywhere: the two `color-mix()` gradients are the
shipped callout's own, over `--el-*` inputs only. The correction marker is a real
`<button>` in the tab order with `--focus-ring-color` on focus-visible; the
citation chip keeps its shipped hover / focus treatment and its **peek** click, so
"click a citation, then keep talking" is true without this asset designing
anything; decorative glyphs are `aria-hidden`.

### Deliverable

The three-file set under `design/ai-chat/` for this surface: `design-notes.md`
(this section) · `ask-answers.mock.html` (source) · `ask-answers.png` (full-page
Playwright chromium export, light, `deviceScaleFactor: 2`, 1200 px wide);
`prettier --check` clean. Composes `planning-workspace.mock.html` (MOTIR-1193) +
`plan-change-conversation.mock.html` (MOTIR-1727) +
`plan-change-planner-speaks.mock.html` (MOTIR-2225) +
`ai-callout-menu.mock.html` (MOTIR-1811); bound by
`docs/decisions/conversation-turn-intent.md` (MOTIR-1816); gates the code subtask
**MOTIR-1820**.

---

## ⭐ The run surface while it is RUNNING — a live composer, a stop, and a run that ended on purpose (MOTIR-4066, 2026-09-03)

**Amendment to this asset set, for `MOTIR-4066`.** The rail shipped by
`MOTIR-2226` draws a run that is **watched**. Story `MOTIR-4054` makes it a run
that is **participated in**, and that is a different surface: the composer stays
live while the planner works, a control can end the run, and a run can now finish
in a state that is neither success nor failure. None of those had a drawing. The
three cards under that story — **MOTIR-4067** (the mailbox), **MOTIR-4068** (the
stop), **MOTIR-4069** (the rail narrates every act) — consume this asset; none of
them decides what it shows.

**Asset:** `plan-change-run-live.mock.html` (source) + `plan-change-run-live.png`.
A five-sheet board: the entrance, the four states against one layout, the act-kind
table, the anatomy + token map (light and the real dark flip), and the measured
viewport table.

| Sheet | What it shows                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ |
| **1** | **The entrance** — where the **Stop** lives, and why it is reachable at the moment it is wanted                                |
| **2** | **The four states against ONE 22rem rail**: running · running-and-typed · stopping · stopped, plus the queued-vs-consumed pair |
| **3** | **The act rail** — every frame kind the contract carries, `retrieval` beside them, and the LOUD unknown                        |
| **4** | **Anatomy + the token map**, and the stopped state asserted **by absence** — what it may not use                               |
| **5** | **Measured** — how many act lines fit at each viewport, and what follows from the answer                                       |

### ⭐ Drawn against SHIPPED REALITY — rendered before drawn

Every rail fragment on the board is the **real emitted markup** of the shipped
`components/planning/PlanChangeRail.tsx` + `PlanChangeComposer.tsx`, captured by a
headless render of the actual components in the `streaming` phase (the repo's own
`tests/helpers/renderWithIntl` harness → `container.innerHTML`) at the rail's real
`22rem`. Five things the render corrected, versus what reading the `.tsx` alone
would have suggested — and the first is the largest thing on this board:

- **THE COMPOSER IS `disabled` FOR THE WHOLE RUN.** `busy = state.phase === 'streaming'`
  reaches the `@` trigger, the text input **and** Send; all three carry a real
  `disabled` attribute in the emitted markup. _"The composer stays live"_ is
  therefore a **behaviour** change, not a styling one.
- **THE PROGRESS REGION IS ONE REPLACING LINE, not a rail.** A single
  `aria-live="polite"` div (`data-testid="plan-change-progress"`) holding a spinner
  and the current narration, overwritten on every frame. **A run's whole history is
  one sentence long today.**
- **THE MARKER LINE IS `--el-text-secondary`**, not `--el-text-faint` as the
  MOTIR-2225 section above states. The notes drifted from the component; the render
  is the truth, and the two new marker lines here follow the component.
- **THE USER BUBBLE IS `--el-chat-bubble-user`** with a `--el-muted` avatar (the
  MOTIR-2225 section says "accent fill"), and the `label` slot
  (`font-mono text-[10px] uppercase opacity-80`) renders **inside** the bubble —
  which is why the `queued` state fills that slot rather than inventing a header.
- **THERE IS NO STOP CONTROL ANYWHERE**, at any phase, in any of the three
  components.

### ⭐ The load-bearing decision: a stop is a DECISION, not a failure

The whole card turns on this, and it is expressible as a prohibition rather than a
treatment:

> **The stopped state borrows nothing from the error state.**

If stopping reads as throwing work away, people will not stop runs — they will wait
them out, and the control is decorative. That is a product failure with no error to
trace. So the stopped state is asserted **by absence**, and sheet 4 lists what it
may not use so a reviewer checks a claim rather than an impression:

| not used                                        | why it would be wrong                                                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `--el-tint-rose` + `role="alert"`               | the rail's OWN error affordance (`PlanChangeRail`'s error block). Absent from every stopped frame                       |
| `--el-warning-surface` / `--el-warning-text`    | spoken for by the **asking** state (MOTIR-2225); two warm pending-ish states one scroll apart are less legible than one |
| `--el-destructive`                              | nothing is destroyed — the plan survives a stop intact                                                                  |
| `triangle-alert` · `circle-x` · `octagon-alert` | no failure iconography anywhere                                                                                         |
| dimming, strike-through, grey-out               | a stopped run's proposals are worth what they were worth a second earlier                                               |

**And the reviewability is drawn by REUSE, not by a new element:** the stopped rail
carries the shipped `plan-change-review` block — `--el-accent` border, _"Nothing is
saved yet."_, Discard + Approve — **live**. That is the strongest available way to
say the plan still stands: it is literally the same block a completed run shows.

### The states (A–D, sheet 2)

| State | What it is                       | How it is drawn                                                                                                                                                                                                                                                                                                      |
| ----- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | **RUNNING — nothing said**       | The composer is live and empty. The act rail accumulates; the newest line carries the spinner and is the one line at full `--el-text` ink. The **running bar** sits pinned above the composer input with the live line and **Stop**                                                                                  |
| **B** | **RUNNING — the user has typed** | The turn is an ordinary user bubble — **not re-tinted** — whose `label` slot reads `queued` with a `clock` glyph, plus a marker line: _"Queued — Motir AI reads this when it finishes the card it is writing."_                                                                                                      |
| **C** | **STOPPING**                     | The click is not the stop: the walk reads the flag at its next phase boundary, which can be a whole authoring session away. The bar keeps spinning, **Stop** becomes `disabled` and relabelled **Stopping…**, and the act rail gains a `stopping` line. The surface never claims a terminal state it has not reached |
| **D** | **STOPPED**                      | A `stopped` act line at full ink, one centred marker (_"You stopped this run."_), and the shipped review block live underneath it                                                                                                                                                                                    |

**B, one boundary later.** The queued and the delivered-and-acted-on states are
visibly distinct, and the distinction is **textual and structural rather than
chromatic** — four cues, none of them colour: the label slot changes
(`queued` → `turn 2`), the clock glyph goes, the marker line is replaced with
_"Read at the boundary — folded into this run."_, and a `folded` act line appears
in the rail saying what the run did with it.

**Why the queued bubble is not re-tinted.** The obvious move is a warm tint on the
pending turn, and it is wrong here: `--el-warning-surface` already carries the
planner's **asking** state on this exact surface, and two warm pending-ish states
one scroll apart are less legible than one — the same reasoning MOTIR-2225 used to
keep the report bubble ordinary.

### ⚠️ THE ENTRANCE — the pinned footer, and only there

The moment a stop is wanted is the moment the run is visibly going wrong and the
user is already annoyed. So it may not be on hover, and it may not be below a
scroll. The rail has exactly one region that is always on screen: the **pinned
composer footer**, outside the `overflow-y-auto` transcript. MOTIR-2225 put the
answer bar there for the same reason and measured why — at `22rem` the header row
already carries the status dot, `Motir AI` and the mode chip, and a fourth element
truncates. **The running bar takes that slot**, on the same fill the shipped
progress row already uses.

**No second door.** A keyboard shortcut, a canvas-bar stop and a context-menu entry
were considered and rejected: three entrances to one control is three things to
keep in sync, and the pinned one already answers the question. If a second is ever
wanted it belongs beside `Esc`-closes in the workspace shell, not in this rail.

### The ACT RAIL — one replacing line becomes a record

The shipped surface renders **one replacing line**. The rail here is an
**accumulating ordered list**, three columns — glyph · mono act label · line —
because the user is now making a decision against it (whether to stop), and a
decision needs the record rather than the latest word.

**The skim axis is the middle column, not colour.** Every act line is the same ink;
what a reader runs their eye down is a fixed-width column of short mono words, with
the glyph as a second, non-textual cue. Deliberate: the rail already carries three
coloured states (assistant, user, the accent review block) and a fourth hue would
compete with them rather than help.

| frame                                 | glyph                      | the line                                                          |
| ------------------------------------- | -------------------------- | ----------------------------------------------------------------- |
| `submitted`                           | `send`                     | Sending the conversation to Motir AI…                             |
| `reading`                             | `scan-search`              | Reading your request…                                             |
| `redirected`                          | `corner-down-right`        | Working on the proposal…                                          |
| **`retrieval`**                       | **`book-open-text`**       | **Read the plan tree · code graph · code health · web · lessons** |
| **`retrieval` (blocked)**             | **`ban`**                  | **Out of lookups — carrying on with what it has.**                |
| `search`                              | `search`                   | Reading your plan…                                                |
| `drill`                               | `list-tree`                | Working through the tree…                                         |
| `pass` · `planned` · `level_complete` | `sparkles`                 | N items proposed so far…                                          |
| `validated` · `validation_skipped`    | `shield-check`             | Checking the proposal against your plan…                          |
| **anything else**                     | **`circle-question-mark`** | **`frame: <the raw kind>`**                                       |

`retrieval` is the frame this card exists for: the planner emits it on every graph
lookup carrying `{ tool, family }` over five families — `plan_tree`, `code_graph`,
`code_health`, `web`, `lessons` — plus a `blocked: true` variant when the per-job
retrieval budget is spent, and nothing renders any of it.

**The last row is the point, not a footnote.** Adding a `retrieval` arm fixes
today's symptom and leaves the mechanism: `default: return null` means every frame
kind added upstream is invisible, with no signature — nothing throws, nothing logs,
the rail just says less than the run did. So the unknown kind gets a drawn line of
its own, loud enough that a developer sees it and quiet enough that it is not an
error for a user, because it is not one.

**Ordering, and the one thing the rail must not do.** Act lines append. They are
never re-ordered, never collapsed and never de-duplicated: two `retrieval` lines in
a row mean the planner made two lookups, and a rail that folds them into "2
lookups" has turned a record into a summary. The _only_ line that changes after it
is written is the live one, which loses its spinner when the next act arrives.

### ⭐ MEASURED — and the number decides the layout

Measured in chromium against the shipped rail markup inside the real two-pane
shell, act lines added until the transcript overflows. Not estimated.

| viewport                   | usable px (−~120 chrome) | act lines, rail alone | act lines, after the ordinary opening |
| -------------------------- | ------------------------ | --------------------- | ------------------------------------- |
| **1366 × 768** (the floor) | 648                      | 17                    | **9**                                 |
| 1280 × 800                 | 680                      | 18                    | **10**                                |
| 1440 × 900                 | 780                      | 23                    | **15**                                |
| 1512 × 982                 | 862                      | 27                    | **19**                                |

**The finding is nine.** With the ordinary opening above it — the assistant opener,
one user turn, the _Sent to Motir AI_ marker — nine act lines fit at the floor
before the transcript scrolls, and a real planning run emits several times that. So
the rail **will** scroll, on the most common laptop, in the first thirty seconds.
The question was never whether to prevent that but what has to remain visible when
it happens, and two things follow — both drawn: the live line is **duplicated into
the pinned bar**, and **Stop** lives in the pinned footer rather than beside the act
it would end.

**The invariant, for the cards that build it:** the transcript scrolls and the
footer does not. The running bar, the composer and the **Stop** button are never
inside the scroll region — at any viewport, at any run length. A build that puts the
bar in the transcript passes every unit test and breaks the only claim sheet 1
makes. **And the rail auto-scrolls to the newest act while the user has not scrolled
away**; a reader who scrolled up to re-read an earlier act is reading deliberately,
and the pinned bar is what makes leaving them alone safe.

### Primitives composed (no hand-rolling)

| Element                                      | Built from                                                                                                                                                                            | Colour                                       | Shape                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------- |
| the rail, header, bubbles, markers, composer | the shipped `PlanChangeRail` / `PlanChangeComposer` — real emitted markup                                                                                                             | as shipped                                   | as shipped                        |
| **act rail**                                 | NEW — an `<ol>` in the transcript, replacing the one-line `plan-change-progress` region                                                                                               | `--el-surface-soft` (that region's own fill) | `--radius-card`                   |
| **act line, past**                           | glyph + mono label + line                                                                                                                                                             | `--el-text-secondary`                        | —                                 |
| **act line, live / outcome**                 | the same row, spinner in the glyph slot                                                                                                                                               | `--el-text`                                  | —                                 |
| **act label column**                         | the shipped label-slot type                                                                                                                                                           | `--el-text-secondary`                        | `font-mono text-[10px] uppercase` |
| **running bar**                              | NEW — a sibling in `PlanChangeComposer`, in the answer bar's slot                                                                                                                     | `--el-surface-soft` / `--el-text-secondary`  | `--radius-card`                   |
| **Stop**                                     | `Button variant="secondary" size="sm"` + `circle-stop` — **not** destructive                                                                                                          | `--el-surface` / `--el-border` / `--el-text` | `--radius-btn`, `--height-btn-sm` |
| **queued label**                             | the shipped `label` span, filled, + `clock`                                                                                                                                           | inherits the bubble ink at `opacity-80`      | `font-mono text-[10px] uppercase` |
| **queued / folded / stopped markers**        | the shipped `plan-change-marker` line                                                                                                                                                 | `--el-text-secondary`                        | `text-center text-xs`             |
| the surviving proposal                       | the shipped `plan-change-review` block, reused whole                                                                                                                                  | `--el-accent` border                         | `--radius-card`                   |
| icons                                        | lucide-react — `circle-stop`, `clock`, `book-open-text`, `ban`, `scan-search`, `corner-down-right`, `list-tree`, `shield-check`, `sparkles`, `search`, `send`, `circle-question-mark` | —                                            | —                                 |

### Token / a11y discipline

- **Colour** strictly via `--el-*`. The mock's stylesheet is lifted verbatim from
  `plan-change-planner-speaks.mock.html` — Tailwind's real output for this surface
  over `packages/design-system/theme.css` — so the Tier-0 `--color-*`, the
  `[data-theme='dark']` flip and the Tier-3 `--el-*` layer are the shipped values.
  **No retyped hex, no invented hue, and no missing token was found.** A short
  supplemental block adds only the utilities Tailwind emits for the new markup
  (`truncate`, `size-3.5`, `w-16`, `mt-px`, the spinner's four) — none of them
  carries a colour.
- **Shape** strictly via element-semantic tokens (`--radius-card|control|input|btn|badge`,
  `--spacing-chip-x/y`, `--spacing-control-x/y`, `--spacing-icon-btn`,
  `--height-btn-sm`, `--height-input`), so a `data-style` swap reshapes the running
  bar exactly as it reshapes the bubbles.
- **Not colour alone** — every new state pairs its treatment with a word AND a
  glyph: `queued` + `clock`, **Stopping…** + a disabled control, `stopped` +
  `circle-stop`, and a marker line in every case. **No dashed or dotted border
  carries a state**, which would fight the `data-style` axis and collide with the
  canvas's proposed-node language.
- **Dark** is the real token flip (`data-theme="dark"` **plus**
  `data-appearance-scope`, since the Tier-3 layer is declared on
  `:root,[data-appearance-scope]` and a nested subtree must re-emit it). The states
  stay distinguishable in both themes for the same reason they do in light — the
  distinction never rested on a hue.
- **A11y** — the act rail is the `aria-live="polite"` region the shipped progress
  line already was, so the newest act is announced without a second live region
  competing with the transcript's `role="log"`. **Stop** is a real `<button>` with a
  visible label (never an icon-only control), and its `disabled` **Stopping…** state
  keeps the label in text so the interval is announced rather than only shown.
  Decorative glyphs are `aria-hidden`; the spinner keeps its shipped
  `role="status"`.

### Deliverable

The three-file set under `design/ai-chat/` for this surface: `design-notes.md`
(this section) · `plan-change-run-live.mock.html` (source) ·
`plan-change-run-live.png` (full-page Playwright chromium export, light,
`deviceScaleFactor: 2`, 1580 px wide); `prettier --check` clean. Composes
`plan-change-planner-speaks.mock.html` (MOTIR-2225) +
`plan-change-conversation.mock.html` (MOTIR-1727) and the shipped
`PlanChangeRail` / `PlanChangeComposer`; grounded in the consumer half already
merged in `motir-ai` (**MOTIR-4060**'s boundary mailbox); gates **MOTIR-4067**,
**MOTIR-4068** and **MOTIR-4069**.
