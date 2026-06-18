# AI chat / onboarding — design notes

Design reference for the `ai-chat` UI area — **Motir's start-fresh onboarding
journey** (Story 7.3, `MOTIR-804`; this asset is subtask **7.3.44 /
`MOTIR-1061`**). It is the single, comprehensive **screen-by-screen** design of
the flow, so it can be reviewed before any UI is built.

> **Rebuilt from scratch (Yue feedback, 2026-06-18).** The earlier multi-panel
> "spatial canvas" draft was not legible as a workflow and never showed the user
> each stage's output. This is a **complete redo**, not a patch. It supersedes the
> cancelled wizard designs `7.3.26`/`MOTIR-1039` + `7.3.43`/`MOTIR-1060`.

---

## ⭐ The interaction model (one model, made legible)

The whole flow is **one frame with two modes**:

1. **The hub = a visual canvas + a chat.** The **canvas** is a horizontal
   journey road (`Your idea → Understand → Shape → Validate → Design → Plan`)
   that shows **where you are**. The **chat** is how you **move forward** — it
   drives the conversation that produces each stage. This is home.
2. **A step takes the FULL SCREEN.** Opening a stage's **doc to review**, or the
   **design wizard**, replaces the hub with a focused full-screen view. The chat
   is hidden; a **"← Back to chat"** button returns you, and a slim **progress
   map** (the canvas distilled to 5 steps) keeps you oriented.

**Every stage's output is SHOWN and editable before you continue** — you never
"continue" past a doc you haven't seen. Stage names are **descriptive**, never
one-word jargon: _Understanding your idea_ · _What we'll build_ · _Checking your
idea against the market_.

This directly fixes the four problems with the prior draft: the workflow is
legible (flow map + descriptive names + one consistent navigation), the docs are
shown, the canvas is visual (not a slide of bullet text), and a focused step uses
the whole screen with a clear way back.

---

## The screens (in journey order)

| #     | Screen                                   | What it is                                                                                                                                                       |
| ----- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | **Flow map**                             | the whole workflow at a glance — the hub (canvas + chat) ⇄ the full-screen steps (each with a back-arrow) → "Go to plan phase". Legible in one look.             |
| **B** | **Public landing**                       | the idea prompt + the one-line "how it works" progress preview; replaces `app/page.tsx`.                                                                         |
| **C** | **The hub**                              | the **visual journey road** (where you are) + the **chat** (move forward) + the affordance that opens a ready doc full-screen.                                   |
| **D** | **Doc · "Understanding your idea"**      | the **discovery** output, full-screen + editable: what / who / how-used, the **mirror scan** (real comparable products), the inferred class + platform chips.    |
| **E** | **Doc · "What we'll build"**             | the **vision** output: in-scope / out-of-scope (v1) + core decisions (pinned vs delegated) + the **read → react → revise** loop shown inline (a diff + history). |
| **F** | **Doc · "Checking against the market"**  | the **validation** output — **SKIPPABLE** — comparables + demand + risk, AND the **validate-demand-first** offer (front-load a landing page + waitlist).         |
| **G** | **Wizard · Style** (full screen)         | pick from the 6 real styles; a **big live specimen** (the shared 7.3.37 vignette) makes the FEEL legible — silhouette / stroke / elevation / density.            |
| **H** | **Wizard · Palette** (full screen)       | pick from the 5 real palettes; the big specimen mirrors the shipped `docs/palettes/*.png` — every colour role, re-skinned live.                                  |
| **I** | **Wizard · Type + Review** (full screen) | pick from the 6 real type pairings; the specimen mirrors `docs/typography/*.png` (headline / body / meta roles); then the optional Fine-tune + the `DESIGN.md`.  |
| **J** | **Go to plan phase**                     | the generated dispatchable backlog (every kind of work) + the degraded **"AI planning not configured"** + loading / resume / error states.                       |

---

## ⚠️ The design phase uses the specimens the 7.3 subtasks shipped (Yue, 2026-06-18)

The design wizard is **web-only** (a mobile project skips it; skip → the default
style, no `DESIGN.md`); it is the third axis of Motir's own design system —
**Colour `data-palette` · Type `data-type` · Shape/feel `data-style`** — and it
lets a user design THEIR product's system. Every specimen is **live**: a real
mini-UI wrapped in the axis attributes, with the `[data-style]`/`[data-palette]`/
`[data-type]` blocks **copied 1:1 from `app/globals.css`** and the six real
next/font faces loaded, so it re-shapes / re-skins / re-types exactly as the app
does.

Crucially, the wizard's specimens **match the specimen designs those subtasks
already shipped**, not a generic card:

- **Palette (`H`)** mirrors `docs/palettes/*.png` (the 7.3.49–52 specimens):
  canvas / surface / surface-soft / muted swatches · the ink hierarchy · Ink CTA
  / Secondary / accent-on-surface · semantic chips · the six tints · the
  work-item type hues — all re-skinned live by `data-palette`.
- **Type (`I`)** mirrors `docs/typography/*.png` (the 7.3.54–56 specimens): the
  headline / body / meta roles with real content + the role-mapping table, live
  by `data-type`.
- **Style (`G`)** is the **shared specimen vignette of subtask 7.3.37 /
  `MOTIR-1050`** — and because 7.3.37 is `blocked_by` THIS design, defining that
  specimen well is the job of this card. It is a composed mini-UI (a toolbar +
  work-item list + a side form) that exercises silhouette / stroke / elevation /
  surface / density, so each style's feel is visibly distinct (the 7.3.33–36
  acceptance bar: "re-shapes silhouette/elevation/surface, not just type+color").

The **v1 set** the panels render (the shipped reality):

| Axis        | v1 entries                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| **Style**   | Warm Editorial (default) · Soft/Playful · Swiss/Minimal-Flat · Neo-Brutalism · Glassmorphism · Cybercore/Y2K |
| **Palette** | Motir (default) · Cobalt · Graphite · Evergreen · Spectrum                                                   |
| **Type**    | Motir (default) · Motir Sans · Motir Mono · Grotesk · Editorial · Mono-Technical                             |

> **One mock-only adaptation.** In the app `data-palette` sits on `<html>`, so the
> `:root` `--el-*` layer recomputes against the palette's overridden `--color-*`.
> Because a specimen wraps a NESTED element, the mock re-emits the derived `--el-*`
> layer (incl. the tint + work-item-type hues) scoped to `[data-palette]` so it
> recomputes locally. The style + type axes need no such fix — components read
> their tokens directly.

---

## ⚠️ Validation is skippable, and can be front-loaded (screen F)

The **Validate** step is **optional** — the journey road tags it "can skip", the
step header carries a **"Skip validation"** action, and the footer offers **"Skip
this step"**. A side-project / already-validated user moves straight to Design.

Screen F also surfaces the **validate-demand-first** strategy (Yue, 2026-06-17):
when demand is unproven and commercial, Motir **proactively offers** to validate
EARLY — **"Validate demand first"** front-loads a launch slice (register a domain,
ship a landing page with a "notify me" waitlist, sequenced **ahead of the build**)
so real interest is collected before committing; **"No — plan the full build"**
keeps standard timing. The choice is asked here, at the validation step, with a
default of standard timing.

---

## The read → react → revise loop (screen E, inline)

The loop is not a separate slide — it lives **inside the doc** the user is
reading. On "What we'll build", a recently-revised line shows a **diff** (rose
`−` strike-through / mint `+` add), a one-line note of the chat reaction that
triggered it and which **other tier it also updated** (coordinated revision), and
a **View history · restore** affordance (rollback). The loop stays live through
the build phase.

---

## Token / a11y discipline (honoured throughout)

- **Colour** strictly via `--el-*` — specimens carry the palette in the `--el-*`
  layer (re-emitted for nesting); chips put the hue in the tint BACKGROUND with
  `--el-text-strong` text (finding #35, AA); the degraded gate uses
  `--el-tint-yellow`. The only `--color-*` is inside the axis blocks copied 1:1
  from `globals.css` (where it is sanctioned).
- **Shape** strictly via element-semantic tokens (`--radius-*` / `--shadow-*` /
  `--spacing-*` / `--height-*`) so the `[data-style]` swap actually re-shapes the
  specimens (that IS the demo). `rounded-full` only on dots / avatars / swatches.
- **Not colour-alone** — every step pairs an icon + label + tint; the progress
  map pairs a check / number with the label; pinned vs delegated keeps its
  `pin` / `wand` markers.
- **AA holds** — each style × palette pair is AA by construction (the registries
  enforce it); chrome text is charcoal on cream; Cybercore renders its native
  dark register.
- **A11y** — the chat is a labelled region; the progress map / journey road are
  decorative orientation (the step labels carry the meaning); decorative icons are
  `aria-hidden`; buttons carry accessible labels.

## Primitives composed (no hand-rolling)

Every surface is a shipped primitive or a new ARRANGEMENT of them + tokens — no
new design-system vocabulary:

| Element                                 | Built from                                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| journey road / progress map             | NEW ARRANGEMENT of token-styled nodes + connector lines (orientation only)                                                                     |
| full-screen step frame                  | a `step-top` bar (`Button` back + the progress map) over a centred doc body                                                                    |
| doc fields / scope boxes / mirror cards | `Card` + labelled fields + hover-reveal `pencil` (inline edit)                                                                                 |
| chat (hub) + bubbles + composer         | `Card` + `Avatar` + `Input` (no new primitive)                                                                                                 |
| style / palette / type specimens        | NEW ARRANGEMENT of `Card`/`Input`/`Button`/`Pill` wrapped in the real axis attributes — the `/tokens` specimen pattern (`app/tokens/page.tsx`) |
| option chips (wizard)                   | a selectable `Card`/`Button` with a tiny live preview (mini card / swatch / Aa)                                                                |
| validate-early / state callouts         | `Card` tints + `Button`; the spinner is `Spinner`                                                                                              |
| icons                                   | lucide-react + Google / GitHub marks                                                                                                           |

## Deliverable

The three-file design-asset set under `design/ai-chat/`: `design-notes.md` (this
file) · `onboarding.mock.html` (the HTML mockup — source of truth, screens A–J) ·
`onboarding.png` (the full-page export — the board-visible face). Rendered with
Playwright chromium (full-page, light theme, `deviceScaleFactor: 2`, 1200px wide);
`prettier --check` clean.
