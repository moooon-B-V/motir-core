# AI chat / onboarding — design notes

Design reference for the `ai-chat` UI area — **Motir's start-fresh onboarding
journey** (Story 7.3, `MOTIR-804`; this asset is subtask **7.3.44 /
`MOTIR-1061`**). The single, comprehensive **screen-by-screen** design of the
flow, reviewable before any UI is built.

> **Rebuilt on review feedback (Yue, 2026-06-18).** Supersedes the cancelled
> wizard designs `7.3.26`/`MOTIR-1039` + `7.3.43`/`MOTIR-1060`.

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
2. **A step takes the FULL SCREEN** — a doc to review, or the design step — with a
   plain **"Back"** button (no internal words like "canvas") and a **descriptive**
   header (`Pre-plan · doc 1 of 4`, not a row of meaningless short words; the
   journey lives on the canvas).

**Labels are PLAIN LANGUAGE, never jargon** — a founder won't know "Feasibility"
or "Validation". The four pre-plan docs read: **"Understanding your idea"** ·
**"What we'll build"** · **"Is it worth building?"** (optional) · **"Will people
want it?"** (optional). Each is **shown and editable** before you continue. The two
optional ones are **skipped in the CHAT** (before they generate), never on the doc.
Validation can be **front-loaded** (validate demand first). The agent **drives the
flow** (proceeds on its own; Skip cancels). The design step **styles its whole
self**. (All detailed below.)

This is the fix for the prior drafts: the canvas-left + chat-right layout is kept
(the chat never dominates), the progress is **on the canvas** (visual +
descriptive), the roadmap **continues past Plan** into the epics/stories (the same
canvas, a view of the work-item tree), the **skip is a chat decision**, and the
design step is the example **at full page scale**.

---

## The screens (in journey order)

| #     | Screen                                     | What it is                                                                                                                                                                                                           |
| ----- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B** | **Public landing**                         | the idea prompt **+ the workflow preview as descriptive BLOCKS** (a card per step — plain title + one-line description; optional / web-only tagged).                                                                 |
| **C** | **The hub**                                | the **canvas roadmap on the LEFT** — each done station **shows its captured findings** — + the **chat right rail**; here the agent raises the **validate-first ask** (with context) and **blocks** until you choose. |
| **D** | **Doc 1 · "Understanding your idea"**      | a **readable document** (editorial prose): what / who, the **mirror scan** (real comparables), inferred class + platform — inline-editable.                                                                          |
| **E** | **Doc 2 · "What we'll build"**             | a **readable document**: in / out of scope (v1) + key decisions (pinned vs delegated) + the **read → react → revise** revision inline.                                                                               |
| **F** | **Doc 3 · "Is it worth building?"** (opt.) | a **readable document**: the market, how hard it is to build, things to watch. Skipped (if at all) earlier, in the chat.                                                                                             |
| **G** | **Doc 4 · "Will people want it?"** (opt.)  | a **readable document**: demand + competition + the **validate-demand-first recommendation**, with the accept/decline **decision on the page** (also asked in the chat) — it **blocks** continuing.                  |
| **H** | **Design step** (whole page styled)        | the **ENTIRE page** — header, pickers, buttons, list, footer — rendered live in the chosen **style × palette × type**. Change a pick → it all restyles.                                                              |
| **I** | **The canvas as the roadmap** (post-plan)  | the road continues past Plan: **Epic 1 (done) → Epic 2 (you are here, progress meter) → Epic 3 → + more**.                                                                                                           |
| **J** | **An epic expanded**                       | the epic opens to its **stories → subtasks** (the work-item tree, same road language) with per-item status + work-type chips (Code / Design / Content / …).                                                          |
| **K** | **Plan states**                            | the degraded **"AI planning not configured"** gate + loading / resume / error.                                                                                                                                       |

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

## ⚠️ Motir DRIVES the workflow; Skip CANCELS a step (it's an agent, not a form)

**The AI agent runs the workflow on its own.** It does **not** ask _"shall I do the
next step?"_ and wait — if the user never replied, nothing would happen. When it
has what it needs, it **proceeds to the next step automatically** and **writes up
what it finds**; the chat narrates progress (_"Now I'm checking whether it's worth
building… I'll write it up and move on by myself"_) with a typing indicator, not a
blocking question.

For the two **optional** steps (the worth-building check and the market check),
the chat shows a **Skip** control — pressing it **cancels that step and the agent
advances directly** to the next. Skip is offered **before** a doc generates; a
generated report has nothing to "skip".

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
lists, a competitor "scan"), inline-editable. **Don't call them "docs" or number
them "doc N of 4"** (Yue) — "doc" is an internal word and there's nothing to
download; each page is just the write-up of that step.

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
  `pin` / `wand` markers.
- **AA holds** — each style × palette pair is AA by construction; Cybercore renders
  its native dark register.
- **A11y** — the chat rail and the canvas are labelled regions; decorative icons
  are `aria-hidden`; buttons carry accessible labels.

## Primitives composed (no hand-rolling)

| Element                                 | Built from                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| canvas roadmap (stations + road)        | NEW ARRANGEMENT of `Card` (`.estation`) + tint glyph tiles + connector lines + progress meters                      |
| chat rail + bubbles + composer          | `Card` + `Avatar` + `Input` (the compact right rail)                                                                |
| full-screen step frame                  | a `step-top` bar (`Button` back + a descriptive label) over a centred doc body                                      |
| doc fields / scope boxes / mirror cards | `Card` + labelled fields + hover-reveal `pencil` (inline edit)                                                      |
| full-page design showcase               | NEW ARRANGEMENT of `Card`/`Button`/`Pill`/list wrapped in the real axis attributes (the `/tokens` specimen pattern) |
| epic → story → subtask tree (H/I)       | NEW ARRANGEMENT of `Card` + the `--el-type-*` work-type hues + the connector language                               |
| state callouts                          | `Card` tints + `Button`; the spinner is `Spinner`                                                                   |
| icons                                   | lucide-react + Google / GitHub marks                                                                                |

## Deliverable

The three-file design-asset set under `design/ai-chat/`: `design-notes.md` (this
file) · `onboarding.mock.html` (the HTML mockup — source of truth, screens B–J) ·
`onboarding.png` (the full-page export). Rendered with Playwright chromium
(full-page, light theme, `deviceScaleFactor: 2`, 1200px wide); `prettier --check`
clean.
