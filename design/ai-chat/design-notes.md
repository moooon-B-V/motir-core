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
   **+** the pre-plan phase_: **Idea → Discovery → Vision → Validation → Plan →
   Epic 1 → Epic 2 → …**, each epic expandable to its **stories → subtasks**. It
   shows **where you are** the whole way through (with descriptive station names,
   not jargon). The **chat drives** the active step; it never takes the screen.
2. **A step takes the FULL SCREEN** — a stage's **doc to review**, or the **design
   wizard** — with a **"← Back to canvas"** button and a **descriptive** header
   (`Pre-plan · step 1 of 4`, not a row of meaningless short words; the journey
   lives on the canvas).

**Every stage's output is SHOWN and editable before you continue.** Validation is
**skippable** and can be **front-loaded**. The design step is a **full-page
showcase**.

This is the fix for the prior drafts: the canvas-left + chat-right layout is kept
(the chat never dominates), the progress is **on the canvas** (visual +
descriptive, not short words in a header), the roadmap **continues past Plan** into
the epics/stories (the same canvas, a view of the work-item tree), and the design
wizard shows the look at **full-page** scale.

---

## The screens (in journey order)

| #     | Screen                                    | What it is                                                                                                                                                        |
| ----- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B** | **Public landing**                        | the idea prompt; replaces `app/page.tsx`.                                                                                                                         |
| **C** | **The hub**                               | the **canvas roadmap on the LEFT** (descriptive stations, where-you-are, pre-plan state) + the **chat as a compact RIGHT rail** that drives the active step.      |
| **D** | **Doc · "Understanding your idea"**       | the **discovery** output full-screen + editable: what / who, the **mirror scan** (real comparables), inferred class + platform. Descriptive header.               |
| **E** | **Doc · "What we'll build"**              | the **vision** output: in / out of scope (v1) + core decisions (pinned vs delegated) + the **read → react → revise** diff/history inline.                         |
| **F** | **Doc · "Checking against the market"**   | the **validation** output — **SKIPPABLE** (header + footer) — comparables + demand, AND the **validate-demand-first** offer (front-load a landing + waitlist).    |
| **G** | **Design wizard** (full-page showcase)    | a **whole product page** (its own nav + hero + cards + footer) rendered live in the chosen **style × palette × type**; the pickers sit above. Chrome IS the demo. |
| **H** | **The canvas as the roadmap** (post-plan) | the road continues past Plan: **Epic 1 (done) → Epic 2 (you are here, progress meter, Open roadmap) → Epic 3 → + more**.                                          |
| **I** | **An epic expanded**                      | the epic opens to its **stories → subtasks** (the work-item tree, same road language) with per-item status + work-type chips (Code / Design / Content / …).       |
| **J** | **Plan states**                           | the degraded **"AI planning not configured"** gate + loading / resume / error.                                                                                    |

---

## ⚠️ The canvas = one view of the work-item tree + the pre-plan phase

The canvas is **not a separate onboarding widget** — it is a **roadmap view** of
the same work-item tree the boards / backlog / list render, with the **pre-plan
phase** (Idea + the 3 docs) as its start. So the SAME surface serves the whole
journey:

- **Pre-plan (screen C):** the stations are Idea → Discovery → Vision → Validation
  → Design → (Plan), with the active one ringed ("chatting now") and an **Open
  doc** affordance; future epics are a dashed "after planning" station.
- **Post-plan (screen H):** the planning origin collapses to "Planning · done" and
  the road extends into **Epic stations** with progress meters + "you are here".
- **Expanded (screen I):** an epic's **stories → subtasks** render in the same
  node language — a roadmap = a planning origin + a tree, self-similar at every
  level. This is a NEW PRESENTATION of the shipped work-item tree, not a new data
  model. (Its own BUILD is a separate Epic-7 story — "planning canvas → persistent
  roadmap"; drawn here because the continuity is the point.)

---

## ⚠️ The design wizard is a FULL-PAGE showcase (screen G)

The design step is **web-only** (mobile skips it; skip → the default style, no
`DESIGN.md`). It is the third axis of Motir's own design system — **Colour
`data-palette` · Type `data-type` · Shape/feel `data-style`**. Rather than small
tiles, the wizard renders a **whole product page** (a styled top nav + a hero +
product cards + a footer) **live in the chosen combination**, so you judge the
look at real page scale — **the header and footer are part of the showcase**. The
**pickers** (style / palette / type chips + Fine-tune) sit above the showcase as
the wizard's own controls.

Everything is faithful: the `[data-style]` / `[data-palette]` / `[data-type]` axis
blocks are **copied 1:1 from `app/globals.css`** and the six real next/font faces
(Inter · Source Serif 4 · JetBrains Mono · Space Grotesk · Fraunces · IBM Plex
Mono) are loaded, so the showcase re-shapes / re-skins / re-types exactly as the
running app does. The result composes into a `DESIGN.md` starter. The **v1 set**:

| Axis        | v1 entries                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| **Style**   | Warm Editorial (default) · Soft/Playful · Swiss/Minimal-Flat · Neo-Brutalism · Glassmorphism · Cybercore/Y2K |
| **Palette** | Motir (default) · Cobalt · Graphite · Evergreen · Spectrum                                                   |
| **Type**    | Motir (default) · Motir Sans · Motir Mono · Grotesk · Editorial · Mono-Technical                             |

> The wizard's style specimen is the shared **7.3.37 / `MOTIR-1050`** vignette —
> and since 7.3.37 is `blocked_by` this design, defining it well is this card's
> job. In the showcase, "the specimen" is the full product page itself.
>
> **Mock-only adaptation:** in the app `data-palette` sits on `<html>`; because the
> showcase wraps a nested element, the mock re-emits the derived `--el-*` layer
> scoped to `[data-palette]` so it recomputes locally. Style + type need no fix.

---

## ⚠️ Validation is skippable, and can be front-loaded (screen F)

The **Validate** step is **optional** — the canvas station tags it "can skip", the
step header offers **"Skip validation"**, and the footer offers **"Skip this
step"**. Screen F also surfaces the **validate-demand-first** strategy (Yue,
2026-06-17): when demand is unproven and commercial, Motir **proactively offers**
to validate EARLY — **"Validate demand first"** front-loads a launch slice (a
domain + a landing page with a "notify me" waitlist, sequenced **ahead of the
build**); **"No — plan the full build"** keeps standard timing.

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
