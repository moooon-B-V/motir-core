# AI chat — design notes

Design reference for the `ai-chat` UI area — **Motir's AI planning front door,
which IS the public landing page** (Story 7.2, the first human-facing AI surface
in Epic 7). The asset is the source of truth for the Story-7.2 UI subtasks
(7.2.7 chat UI, 7.2.8 docs view) and sets the visual grammar the rest of the
planning flow reuses (7.3 review, 7.4 diff, 7.6 dispatch). Built FROM the real
design system (`app/globals.css` `--el-*` colour + `[data-display-style]` shape
tokens, the shipped `components/ui/*` primitives, and the public marketing-nav
grammar from `app/(public)/_components/PublicTopBar.tsx`), so the code subtasks
compose the same primitives — no Pencil→code gap, no Tier-0 `--color-*`, no raw
`rounded-*` / `p-*` / `h-*`.

> **⚠️ Reframe (Yue, 2026-06-15):** the chat front door is **not** an in-app
> authed surface — it is **Motir's public landing page**, Replit-style: a
> marketing top-nav + a hero prompt box. A logged-out visitor describes their
> idea in the hero prompt; submitting it raises a **login gate** (the typed idea
> is preserved); after auth the user is sent to a **separate authed chat screen**
> where the streaming discovery interview runs. The landing **replaces the
> placeholder root `app/page.tsx`** (no marketing-landing design existed before).

| Surface                          | Asset                                 | Notes                                                                                                                                     |
| -------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Landing → gate → chat → docs** | **`ai-chat.mock.html`** (HTML mockup) | The whole `ai-chat` flow — no `design/ai-chat/` asset existed; the 7.2.1 design gate produces this. Multi-panel. **Gates 7.2.7 + 7.2.8.** |

The asset is **multi-panel** (review EACH, not just the first — mistake #31):

- **(1)** the **public landing page** (logged-out) — the marketing top-nav, the
  "vibe project" hero, the chat **prompt box** (the front door), example starter
  chips, and the three-layer (plan · track · ship) strip.
- **(2)** the **login gate** — a `Modal` raised after a logged-out visitor
  submits a prompt; the typed idea is **preserved** and shown; OAuth (Google /
  GitHub) + email, with a sign-in link.
- **(3)** the **authed chat screen** (post-login, a DIFFERENT screen) — the app
  shell (sidebar) + the streaming discovery interview: alternating bubbles, a
  streaming caret + typing affordance, and the **pin-vs-delegate** decision.
- **(4)** the **three direction docs** (vision / discovery / feasibility) as
  editable Markdown — Discovery active in a `Segmented` tab strip, its
  **PINNED-vs-DELEGATED** split visible, and the "Looks right — generate the
  plan" CTA (drawn here; **wired in 7.3**).
- **(5)** the **running / error / resume** states — the streaming job (tied to
  the 7.1.4 job stream), the discovery-failed `ErrorState` with retry, and the
  "docs already exist — resume" state.

---

## ⚠️ Routing & the prompt-preservation handoff (build note for 7.2.7)

The flow spans three trust zones — **public** (landing), the **auth gate**, and
**authed** (chat/docs) — so 7.2.7 must wire a handoff, not just a page:

- **`/` (public, replaces `app/page.tsx`)** — the landing + hero prompt box.
  Anonymous; the marketing nav links (`Product` / `Resources` / `Pricing` /
  `Docs`) are illustrative and owned by whatever marketing-site story ships them
  — this asset only fixes the chat-front-door surface.
- **Submitting a prompt while logged-out → the login gate.** The visitor's typed
  idea MUST survive the auth round-trip (stash it — query param / signed cookie /
  localStorage — and replay it as the first authed message). The gate reuses the
  shipped `(auth)/sign-in` + `sign-up` flow (`design/auth`); it is rendered here
  as a `Modal`, but a full-page `/sign-up?intent=plan` redirect is an equally
  valid implementation — the load-bearing requirement is **prompt preservation**,
  not modal-vs-page. (If preservation proves non-trivial, that is a 7.2.7
  sub-concern, flagged here — not a silent drop of the typed idea.)
- **After auth → a separate authed chat screen** (proposed
  `app/(authed)/plan/page.tsx`) inside the app shell. The transcript + docs view
  are **client islands** (they own streaming + optimistic state); the
  page-state-after-mutation contract applies — the generate-plan handoff (7.3)
  that mutates the issue tree must bump the relevant island tick, not lean on
  `router.refresh()` alone.

## ⚠️ Verified-vs-assumed mirror note (read before building)

- **Landing-page posture — VERIFIED (Replit):** the chat/prompt box AS the
  product's public landing page, with a marketing top-nav (products / resources /
  pricing) and a logged-out visitor typing intent into a hero prompt that gates
  to sign-up. This panel-1 shape mirrors replit.com directly (Yue's reference).
- **Discovery interview + three direction-docs — ASSUMED (Motir-specific):** the
  AI-layer mirror is **Atlassian Rovo**, where a conversational chat front door
  is verified, but the explicit **discovery-interview** shape and the **three
  direction-docs** model (vision / discovery / feasibility as reviewable,
  lightly-editable artifacts the plan is generated from) are Motir's framing
  (Story-7.2 module header), to be validated against a live Rovo tenant. The
  **pin-vs-delegate** interaction (answer to PIN a decision, or hand it to the
  planner to DELEGATE) is likewise a Motir design decision.

## ⚠️ The message bubble is a composed pattern, NOT a separate design subtask

No shipped chat/message-bubble primitive exists in `components/ui/*`. Per the
7.2.1 acceptance criterion this is the decision point: **flag a new `design/`
subtask, or compose it here.** It is composed HERE, deliberately — 7.2.1's job is
to "set the visual language for the whole planning flow," so the bubble IS this
subtask's deliverable. It is a **NEW ARRANGEMENT of shipped primitives — no new
design-system vocabulary** (as 7.0.1 made the `/ready` dispatch card a new
arrangement, not a new primitive):

- a **bubble** = a tinted `Card` surface (`--radius-card`, `--el-surface-soft`
  for assistant / `--el-tint-sky` for user, `--el-border`), with one corner
  squared (`--radius-sm`) toward its avatar — pure tokens, no hand-rolled shape.
- an **`Avatar`** (the initial-letter disc from `issueCellPrimitives`) — accent
  fill for Motir, sky tint for the user.
- a **`MarkdownView`** body inside the bubble (the same renderer the docs use).

So 7.2.7 should implement `MessageBubble` as a small composition of `Card` +
`Avatar` + `MarkdownView`, NOT a bespoke primitive and NOT a code workaround.

---

## Panel 1 — public landing page (the chat front door)

- **Marketing top-nav** (the `PublicTopBar` grammar) — the brand lockup (a
  `--radius-control` accent tile with the lucide `sparkles` mark + serif
  "Motir") on the left; `navlink`s (`Product` / `Resources` / `Pricing` /
  `Docs`, `--el-text-secondary`, hover `--el-surface`) center; and the
  logged-out CTA pair on the right — **"Log in"** (`Button variant="ghost"
size="sm"`) + **"Sign up"** (`Button variant="primary" size="sm"`), exactly
  the `PublicTopBar` Sign-in / Start-free pair.
- **Hero** — a soft `--el-hero-wash-a` radial wash, an **eyebrow** `Pill`
  ("✦ Vibe project", `--el-tint-lavender` / `--el-accent-on-surface`), a
  `font-serif` 44px headline **"What do you want to build?"**, and a subhead that
  **defines vibe project** in terms of vibe coding ("You've heard of vibe coding.
  A **vibe project** takes it to the whole thing — describe your idea and Motir
  plans the work, tracks it, and ships the code, end to end."). Per the framing
  rule, never "AI project management"; the term is DEFINED in copy (it is novel).
- **The chat prompt box (the front door)** — a `Card` (`--radius-card`,
  `--el-border-strong`, `--shadow-elevated`) holding a borderless `Textarea`
  (placeholder "Describe what you want to build — e.g. …") and a foot row: a
  muted "Free to start · no card" hint (lucide `lock`) + a primary **"Start
  planning"** button (lucide `sparkles`). Submitting → the panel-2 gate.
- **Starter chips** — three example prompts (`chip`, `--el-surface` /
  `--radius-pill`, lucide `arrow-right`) that pre-fill the prompt; lowers the
  blank-canvas cost.
- **Three-layer strip** — three `Card`s (`plan · track · ship`) naming Motir's
  three layers (AI planner · MCP-native tracker · hosted coding agent), each a
  `--el-tint-lavender` glyph tile + an uppercase `step` label + title + one line.
  This is the "vibe project" definition rendered as the trust strip.

## Panel 2 — login gate

- A **`Modal`** (`--radius-modal`, `--shadow-modal`) over the **dimmed** landing
  (a `--el-page-bg` 50% scrim), raised when a logged-out visitor submits a
  prompt. Brand tile + `font-serif` **"Sign in to start planning"** + a subhead.
- **Preserved idea** — a `--el-surface-soft` callout with a `--el-accent` left
  rule, label **"Your idea — saved"**, and the visitor's verbatim prompt. Makes
  the prompt-preservation requirement visible: the typed idea is never lost to
  the auth wall.
- **OAuth** — full-width **"Continue with Google"** (the 4-colour brand G) and
  **"Continue with GitHub"** (the GitHub mark) buttons, a labelled `or` divider,
  an email `Input`, and a primary **"Continue with email"** (lucide `mail`).
  A **"Already have an account? Log in"** foot link. Reuses the shipped
  `(auth)` flow (`design/auth`) — this panel only specifies the gate's framing +
  the preserved-prompt callout.

## Panel 3 — authed chat screen (post-login)

- **App shell** — the shipped `Sidebar` rail (brand lockup + nav: **Plan**
  active with the `sparkles` glyph + the canvas-inset active treatment
  `--el-sidebar-item-bg-active` / `--el-sidebar-border` / `--shadow-subtle`;
  Issues / Boards / Dashboard below). This is the "different screen" the user
  lands on after auth.
- **Chat header** — title "Planning · new project" (`sparkles`) + a muted
  progress meta ("Discovery — step 3 of ~5").
- **Transcript** — a centered column of message rows; assistant left, user right
  (`row-reverse`), each `Avatar` + `who` label + `bubble`. The first assistant
  message picks up the **preserved landing prompt**.
- **Pin-vs-delegate (the core interaction):**
  - a **pinned** answer — the user's reply bubble carries a `Pill`
    (`--el-tint-mint`, lucide `pin`) reading **"Pinned"** + the chosen value. The
    decision is locked to what the user said.
  - a **delegated** answer — the user's reply bubble carries a `Pill`
    (`--el-tint-lavender`, lucide `wand-sparkles`) reading **"You decide"**. The
    planner will choose.
  - the **live affordance** on the open question — a dashed divider, a hint
    ("Answer to pin it — or let Motir decide.", lucide `pin`), and option chips:
    the literal answers (`.opt`) plus a dashed **"You decide"** delegate chip
    (`.opt-delegate`, `wand-sparkles` in `--el-accent-on-surface`).
- **Streaming affordance** — the in-flight assistant message ends with a blinking
  **caret**, and a **typing** dot indicator sits under the bubble. Animation is
  review-only; 7.2.7 drives it from the real token stream.
- **Composer** — a bordered `Textarea` box with an inline **send** icon-button
  (`--el-accent`, lucide `send-horizontal`) pinned bottom-right.

## Panel 4 — direction docs (review / light-edit)

- **Header** — `font-serif` `h3` "Direction docs" + a muted subtitle, with the
  **`Segmented`** primitive (Vision · **Discovery** active · Feasibility, each a
  `file-text` glyph; active = `--el-page-bg` + `--shadow-subtle`).
- **Doc container** — a `Card` with a `--el-surface-soft` doc-bar (file name +
  "Edited just now · draft" + a `pencil` document-edit icon-button), over the
  **`MarkdownView` / `MarkdownEditor`** prose surface. Editable blocks use the
  shipped **editable-field** pattern (hover-revealed `pencil` + `--el-surface-soft`
  wash).
- **Pinned-vs-delegated split** — under a **Decisions** heading, `dec-row`s carry
  the same **Pinned** (mint, `pin`) / **Delegated** (lavender, `wand-sparkles`)
  `Pill`s from panel 3, so the discovery doc visibly separates what the user
  locked from what Motir will choose.
- **CTA** — a muted note + a primary **"Looks right — generate the plan"**
  (`sparkles`). **The 7.3 hand-off — DRAWN here, WIRED in 7.3.**

## Panel 5 — running / error / resume states

A responsive grid of three `Card` state panels:

- **Running** (`--el-tint-lavender` glyph) — a `Spinner` + "Drafting your
  direction docs", a progress bar (`--el-muted` track, `--el-accent` fill), and a
  per-doc step list (Vision **done** in `--el-success`; Discovery **writing…**;
  Feasibility **queued**). Caption ties it to the **7.1.4 job stream**.
- **Error** (`--el-tint-rose` glyph, lucide `triangle-alert` in `--el-danger`) —
  the shipped **`ErrorState`** shape: "Discovery couldn't finish" + a saved-answers
  body + a `Button variant="secondary"` "Try again" (`rotate-cw`).
- **Resume** (`--el-tint-sky` glyph, lucide `history` in `--el-info`) — "Docs
  already exist" + a body + a `Button variant="secondary"` "Resume editing" and a
  `Button variant="ghost"` "Start over".

## i18n

A new **`plan` (AI planning) namespace** + landing strings, same locale set as
the rest of the app. Landing: `landing.eyebrow` ("Vibe project"),
`landing.heading` ("What do you want to build?"), `landing.sub`,
`landing.placeholder`, `landing.start` ("Start planning"), the 3 `landing.chip.*`
and 3 `landing.layer.*` blocks, and the nav labels. Gate: `gate.heading` ("Sign
in to start planning"), `gate.sub`, `gate.savedLabel` ("Your idea — saved"),
`gate.google` / `gate.github` / `gate.email`, `gate.login`. Chat: `chat.pinned`
("Pinned"), `chat.delegate` ("You decide"), `chat.decisionHint`,
`chat.composerPlaceholder`. Docs: `docs.heading`, the 3 `docs.tab.*`,
`docs.generate`. States: `state.running.*`, `state.error.*` (reuse `ErrorState`),
`state.resume.*`. (7.2.7 / 7.2.8 own final key names; this lists the copy.)

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): the accent for the brand mark /
  primary CTAs / send / active nav; the **palette, not grey + one accent** — the
  eyebrow + layer tiles lavender, the pin chip mint, the delegate chip lavender,
  the user bubble sky, the error glyph rose + `--el-danger`, the resume glyph sky
  - `--el-info`, the success step `--el-success`. The hero wash uses
    `--el-hero-wash-a`. No Tier-0 `--color-*`, no Tier-0 utilities. Tints carry the
    hue in the BACKGROUND with `--el-text-strong` text (finding #35, AA); no
    page-level surface is tinted. (The Google "G" is the only intentional exception
    — a fixed brand asset, not a UI colour.)
- **Shape** via element-semantic tokens only (`--radius-card` / `-input` / `-btn`
  / `-modal` / `-badge` / `-control` / `-pill`, `--shadow-subtle` / `-card` /
  `-elevated` / `-modal`, `--spacing-input-*` / `-btn-*` / `-chip-*` /
  `-icon-btn` / `-control-*`, `--height-btn-*` / `-control` / `-input`) — no
  generic Tier-0 scale, no raw `rounded-md` / `p-1` / `h-9`. `rounded-full`
  (`--radius-pill`) only on the circular avatar / spinner / typing dots / pill.
- **Not colour-alone** (finding #35): pin vs delegate carries an icon (`pin` vs
  `wand-sparkles`) + a label + a distinct tint; the streaming state pairs the
  caret with the typing dots; each state card pairs its tint with an icon + a
  title.
- **A11y**: the gate is a `role="dialog"` with an accessible name; the tab strip
  is `role="tablist"` / `role="tab"` with `aria-selected`; the typing indicator
  carries `aria-label="Motir is typing"`; the send button has an `aria-label`;
  icons are decorative (`aria-hidden` in code) with the text carrying the
  accessible name. AA holds on all tints (charcoal-on-tint, finding #35).

## Primitives composed (no hand-rolling)

| Element                       | Shipped primitive                                                                                                                                                                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| marketing top-nav             | the `PublicTopBar` grammar (`app/(public)/_components/PublicTopBar.tsx`) + `components/ui/Button.tsx`                                                                                                                                                                                     |
| landing / state / doc / layer | `components/ui/Card.tsx`                                                                                                                                                                                                                                                                  |
| prompt box + composer input   | `components/ui/Textarea.tsx`                                                                                                                                                                                                                                                              |
| login gate                    | `components/ui/Modal.tsx` + the shipped `(auth)/sign-in` + `sign-up` flow (`design/auth`)                                                                                                                                                                                                 |
| eyebrow / pin / delegate      | `components/ui/Pill.tsx` (tint tones)                                                                                                                                                                                                                                                     |
| primary / ghost / secondary   | `components/ui/Button.tsx`                                                                                                                                                                                                                                                                |
| sidebar rail                  | `components/ui/Sidebar.tsx`                                                                                                                                                                                                                                                               |
| 3-doc tabs                    | `components/ui/Segmented.tsx`                                                                                                                                                                                                                                                             |
| doc render + light-edit       | `components/ui/MarkdownView.tsx` · `MarkdownEditor.tsx`                                                                                                                                                                                                                                   |
| running job / writing step    | `components/ui/Spinner.tsx`                                                                                                                                                                                                                                                               |
| discovery-failed state        | `components/ui/ErrorState.tsx`                                                                                                                                                                                                                                                            |
| message bubble                | **new ARRANGEMENT** = `Card` + `Avatar` (`issueCellPrimitives`) + `MarkdownView` (see the bubble note — no new primitive)                                                                                                                                                                 |
| avatar                        | `issueCellPrimitives.tsx` `Avatar` (initial-letter disc)                                                                                                                                                                                                                                  |
| icons                         | lucide-react (`sparkles`, `circle-help`, `pin`, `wand-sparkles`, `send-horizontal`, `file-text`, `pencil-line`, `rotate-cw`, `history`, `triangle-alert`, `check`, `mail`, `lock-keyhole`, `arrow-right`, `circle-dot`, `square-kanban`, `layout-grid`) + the Google / GitHub brand marks |

No new design-system entry is invented in this Story. If a future need arises
that a shipped primitive can't cover, that is a NEW `design/` subtask, not a code
workaround.
