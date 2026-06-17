# AI chat / onboarding — design notes

Design reference for the `ai-chat` UI area — **Motir's start-fresh onboarding
journey** (Story 7.3, `MOTIR-804`). The flow is one co-designed path:

> **public landing / chat front door → login gate → authed discovery chat →
> three direction docs → wizard shell + states**

This asset is the layout source of truth for every UI subtask in Story 7.3 — the
chat front-door UI (`7.3.5`), the direction-docs render/edit view (`7.3.6`), the
wizard shell UI (`7.3.11`) and the orchestration it embeds (`7.3.9`). It is built
FROM the real design system — `app/globals.css` `--el-*` colour + the
`[data-display-style]` shape tokens, the shipped `components/ui/*` primitives, and
the **real** app shell + nav — so the code subtasks compose the same primitives
with no Pencil→code gap, no Tier-0 `--color-*`, and no raw `rounded-*` / `p-*` /
`h-*`.

> **Supersedes** the old `7.2.1` chat design (`MOTIR-489`, PR #1216 — never merged
> to `main`) and the old `7.15.1` wizard design. The `7.3` re-plan consolidated
> the chat front door and the onboarding wizard into ONE flow, because the chat
> renders INSIDE the wizard shell. The old `MOTIR-489` mock is a **reference to be
> REDONE**, not copied: it invented a `Plan` nav entry and an assumed rail that do
> not exist in shipped reality (see the grounding note below).

---

## ⚠️ Grounded in SHIPPED REALITY (the design rule — read before building)

Every surface here is drawn to fit what is actually implemented, not an assumed
layout. The load-bearing facts (verified against the code, not the plan prose):

- **The real primary nav** (`app/(authed)/_components/SidebarNav.tsx`, labels from
  `messages/en.json`): **Dashboard · Work Items · Ready · Boards · Backlog ·
  Triage · Reports**, then bottom **Settings · Job runs · Docs**. The rendered
  label for `/issues` is **"Work Items"** (the i18n key is `nav.issues`; the copy
  is "Work Items", never "Issues"). **There is NO `Plan` nav entry** — the old
  mock invented one; do not. The authed onboarding wizard is NOT a nav
  destination — it is a focused flow reached via the access path below.
- **The real app shell** (`app/(authed)/layout.tsx`, `components/ui/AppLayout.tsx`,
  `Sidebar.tsx`): a sticky 56px top bar — left: the sidebar toggle + `ShellTierNav`
  (org → workspace → project switchers); right: Create-issue, ⌘K search, Report,
  theme toggle, notification bell, user menu — over a 240px sidebar rail
  (`--el-sidebar-bg` / `--el-sidebar-border`; active row = `--el-sidebar-item-bg-active`
  canvas inset + `--el-accent-on-surface` + `--shadow-subtle`).
- **The real auth** (`app/(auth)/`, `AuthShell.tsx`): a centered `max-w-[28rem]`
  Card on an `--el-surface` page, a serif headline, **no brand wordmark**. The
  login gate (panel 2) reuses this grammar; it is rendered as a `Modal` here, but a
  full-page `/sign-up?intent=plan` redirect is an equally valid implementation —
  the load-bearing requirement is **prompt preservation**, not modal-vs-page.
- **The root** (`app/page.tsx`) is today a placeholder ("Motir" + a `/tokens`
  link); panel 1 (the landing) **replaces** it.
- **AI is cloud-gated** (the locked decision; `design/ai-usage/`): the planner is a
  closed cloud service. A self-host install must connect a Motir Cloud token before
  planning runs — the **"Connect Motir AI"** gate (panel 6) is FIRST specified
  here (it did not exist in shipped design; this subtask creates it).

---

## ⚠️ Access path — the wizard is reached from TWO doors (both DRAWN)

The onboarding wizard is not on the nav; the design VISUALIZES the entry
affordances that open it (the access-path rule — show the door, not just the room):

1. **Logged-out → the public hero** (panel 1). Typing an idea + "Start planning"
   is the front door; submitting raises the login gate (panel 2), and the typed
   idea is preserved across the auth round-trip.
2. **Authed → the ProjectSwitcher "Create project"** (panel 3,
   `app/(authed)/_components/ProjectSwitcher.tsx`). The switcher Popover is drawn
   OPEN with its "Create project" / "Plan a new project" row highlighted — the
   affordance that opens the wizard for an existing user starting another project.
   (Build note: this consolidates with the existing `CreateProjectModal`; whether
   the AI wizard replaces or augments the blank-name modal is a `7.3` build
   decision, flagged — not silently redesigned here.)

---

## Surfaces (the asset is multi-panel — review EVERY panel, mistake #31)

| #   | Panel                                | What it fixes                                                                                                                                                  |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Public landing = chat front door** | the marketing top-nav, the "vibe project" hero, the prompt box (front door), starter chips, the 3-layer strip — replaces `app/page.tsx`                        |
| 2   | **Login gate**                       | the `Modal` raised on a logged-out submit; the **preserved-idea** callout; OAuth + email; reuses the `(auth)` flow                                             |
| 3   | **Authed entry / access path**       | the REAL shell + nav; the ProjectSwitcher Popover open on "Create project" — the authed door into the wizard                                                   |
| 4   | **Wizard shell + discovery chat**    | the 6-step frame (Name · Discovery · Convention · Generate · Review · Dispatch) + the streaming discovery interview with **pin-vs-delegate**                   |
| 5   | **Direction docs**                   | Vision / Discovery / Feasibility in a `Segmented` tab strip, editable Markdown, the pinned-vs-delegated split, the "generate the plan" hand-off (wired in 7.4) |
| 6   | **States**                           | running (job stream) · discovery-failed (`ErrorState`) · resume · the **"Connect Motir AI"** self-host connect-gate                                            |

---

## Panel notes

### Panel 1 — public landing (the chat front door)

- **Marketing top-nav** (cloud-only chrome, NOT the app sidebar): the brand lockup
  (an `--el-accent` `--radius-control` tile with the lucide `sparkles` mark + serif
  "Motir") left; `Product / Resources / Pricing / Docs` links (`--el-text-secondary`)
  center; the logged-out CTA pair right — **"Log in"** (`Button ghost sm`) +
  **"Sign up"** (`Button primary sm`).
- **Hero** — an `--el-hero-wash-a` soft radial wash; an eyebrow `Pill`
  ("✦ Vibe project", `--el-tint-lavender`); a `font-serif` ~44px headline **"What
  do you want to build?"**; a subhead that DEFINES _vibe project_ in terms of vibe
  coding. Per the framing rule, **never "AI project management"** — the term is
  defined in copy.
- **The prompt box (front door)** — a `Card` (`--radius-card`, `--el-border-strong`,
  `--shadow-elevated`) holding a borderless `Textarea` + a foot row: a muted "Free
  to start · no card" hint (lucide `lock`) + a primary **"Start planning"**
  (`sparkles`). Submitting → panel 2.
- **Starter chips** — three example prompts (`chip`, `--el-surface`,
  `--radius-pill`, `arrow-right`) that pre-fill the box.
- **Three-layer strip** — three `Card`s (Plan · Track · Ship) naming Motir's three
  layers (AI planner · MCP-native tracker · hosted coding agent), each a
  `--el-tint-lavender` glyph tile + an uppercase `step` label + title + one line.

### Panel 2 — login gate

- A **`Modal`** (`role="dialog"`, `--radius-modal`, `--shadow-modal`) over the
  dimmed landing (an `--el-page-bg` scrim). Brand tile + `font-serif` **"Sign in to
  start planning"** + subhead.
- **Preserved idea** — an `--el-surface-soft` callout with an `--el-accent` left
  rule, label **"Your idea — saved"**, and the visitor's verbatim prompt.
- **OAuth + email** — full-width **"Continue with Google"** (the 4-colour brand G)
  and **"Continue with GitHub"**, a labelled `or` divider, an email `Input`, a
  primary **"Continue with email"** (`mail`), and an **"Already have an account?
  Log in"** foot link. Reuses the shipped `(auth)` flow.

### Panel 3 — authed entry / access path

- The REAL app shell: the 56px top bar (toggle + `ShellTierNav` org/workspace/project
  - the right cluster: Create-issue · ⌘K search · Report · theme · bell · avatar)
    over the 240px sidebar with the REAL 7-item nav (Dashboard active) + bottom rows.
- The **`ProjectSwitcher` Popover OPEN**, anchored at the top-bar project switcher:
  the project list + a divider + a highlighted **"Plan a new project"** row
  (`plus`). This is the authed door into the wizard. A caption names both doors
  (public hero + this).

### Panel 4 — wizard shell + discovery chat

- The **wizard shell** (a focused frame — NOT the 7-nav app sidebar; onboarding
  takes over the screen): a header with the brand tile + "New project" + a right
  **"Save & exit"** (`Button ghost` — resumability) + a muted step meta.
- The **stepper** — six steps **Name · Discovery (active) · Convention · Generate ·
  Review · Dispatch**; done = `check` + `--el-success`, active = `--el-accent`
  ring, upcoming = `--el-text-faint` (icon + label, never colour alone).
- The embedded **discovery chat** — a centered transcript; assistant left, user
  right (`row-reverse`); each row = an `Avatar` (initial-letter disc — accent fill
  for Motir, sky tint for the user) + a who-label + a **bubble**. The bubble is a
  **NEW ARRANGEMENT** of shipped primitives: a tinted `Card` (`--el-surface-soft`
  assistant / `--el-tint-sky` user, one corner squared toward the avatar) holding a
  `MarkdownView` body — no new primitive. The first assistant bubble picks up the
  preserved landing prompt.
- **Pin-vs-delegate** (the core interaction): a **pinned** user reply carries a
  `Pill` (`--el-tint-mint`, `pin`) "Pinned" + the chosen value; a **delegated**
  reply carries a `Pill` (`--el-tint-lavender`, `wand-sparkles`) "You decide". The
  live open question shows a dashed hint ("Answer to pin it — or let Motir decide.")
  - option chips (`.opt`) + a dashed **"You decide"** delegate chip.
- **Streaming** — the in-flight assistant message ends with a blinking caret; a
  typing-dots indicator (`aria-label="Motir is typing"`) sits under it. Animation
  is review-only; the code drives it from the real token stream.
- **Composer** — a bordered `Textarea` with an inline **send** icon-button
  (`--el-accent`, `send-horizontal`) bottom-right.

### Panel 5 — direction docs (review / light-edit)

- **Header** — `font-serif` "Direction docs" + a muted subtitle, with the
  **`Segmented`** primitive (Vision · **Discovery** active · Feasibility, each a
  `file-text` glyph; `role="tablist"` / `role="tab"` + `aria-selected`).
- **Doc container** — a `Card` with an `--el-surface-soft` doc-bar (file name +
  "Edited just now · draft" + a `pencil` icon-button) over the
  `MarkdownView` / `MarkdownEditor` prose. Editable blocks use the shipped
  editable-field pattern (hover-revealed `pencil` + `--el-surface-soft` wash).
- **Pinned-vs-delegated split** — under a **Decisions** heading, `dec-row`s carry
  the same Pinned (mint, `pin`) / Delegated (lavender, `wand-sparkles`) `Pill`s, so
  the doc visibly separates what the user locked from what Motir will choose.
- **CTA** — a muted note + a primary **"Looks right — generate the plan"**
  (`sparkles`). **Drawn here; wired in 7.4** (the generated-tree review/approve
  surface).

### Panel 6 — states

A responsive grid of `Card` state panels:

- **Running** (`--el-tint-lavender` glyph) — a `Spinner` + "Drafting your direction
  docs", a progress bar (`--el-muted` track, `--el-accent` fill), and a per-doc
  step list (Vision **done** `--el-success`; Discovery **writing…**; Feasibility
  **queued**). Tied to the planning job stream.
- **Discovery-failed** (`--el-tint-rose` glyph, `triangle-alert` in `--el-danger`)
  — the shipped `ErrorState` shape: "Discovery couldn't finish" + a saved-answers
  body + a `Button secondary` "Try again" (`rotate-cw`).
- **Resume** (`--el-tint-sky` glyph, `history` in `--el-info`) — "Docs already
  exist" + a `Button secondary` "Resume editing" + a `Button ghost` "Start over".
- **Connect Motir AI** (`--el-tint-yellow` glyph, `plug`) — the self-host
  connect-gate, FIRST specified here: "Connect Motir AI" + "Planning runs on Motir
  Cloud. Connect your workspace to a Motir Cloud token to start planning." + a
  primary **"Connect Motir AI"** + a muted "Self-hosted? Learn more" link. A
  self-host install shows this until a Motir Cloud token is connected (the
  cloud-gated-AI decision).

---

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54), and the **palette, not grey +
  one accent**: the eyebrow/layer/running tiles lavender, the pin chip mint, the
  delegate chip lavender, the user bubble sky, the error glyph rose + `--el-danger`,
  the resume glyph sky + `--el-info`, the success step `--el-success`, the connect
  gate yellow. The hero wash uses `--el-hero-wash-a`. No Tier-0 `--color-*`, no
  Tier-0 utilities. Tints carry the hue in the BACKGROUND with `--el-text-strong`
  text (finding #35, AA); no page-level surface is tinted. (The Google "G" is the
  one intentional brand-asset exception.)
- **Shape** via element-semantic tokens only (`--radius-card` / `-input` / `-btn` /
  `-modal` / `-badge` / `-control` / `-pill`; `--shadow-subtle` / `-card` /
  `-elevated` / `-modal`; `--spacing-*`; `--height-*`) — no generic Tier-0 scale,
  no raw `rounded-md` / `p-1` / `h-9`. `rounded-full` (`--radius-pill`) only on the
  avatar / spinner / typing dots / pill.
- **Not colour-alone** (finding #35): pin vs delegate pairs an icon (`pin` vs
  `wand-sparkles`) + a label + a tint; the stepper pairs state with an icon; each
  state card pairs its tint with an icon + a title; the streaming state pairs the
  caret with the typing dots.
- **A11y**: the gate is a `role="dialog"` with an accessible name; the doc tab strip
  is `role="tablist"` / `role="tab"` with `aria-selected`; the typing indicator
  carries `aria-label="Motir is typing"`; the send button has an `aria-label`;
  decorative icons are `aria-hidden`. AA holds on all tints (charcoal-on-tint).

## Primitives composed (no hand-rolling)

| Element                                | Shipped primitive                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| marketing top-nav                      | a `PublicTopBar`-style nav + `components/ui/Button.tsx`                           |
| landing / state / doc / layer / bubble | `components/ui/Card.tsx` (tints)                                                  |
| prompt box + composer + email          | `components/ui/Textarea.tsx` · `Input.tsx`                                        |
| login gate                             | `components/ui/Modal.tsx` + the `(auth)/sign-in`+`sign-up` flow                   |
| eyebrow / pin / delegate / step        | `components/ui/Pill.tsx` (tint tones)                                             |
| primary / ghost / secondary            | `components/ui/Button.tsx`                                                        |
| app shell + sidebar (panel 3)          | `app/(authed)/layout.tsx` · `Sidebar.tsx` · `SidebarNav.tsx` · `ShellTierNav.tsx` |
| authed access path                     | `ProjectSwitcher.tsx` (Popover + "Create project")                                |
| 3-doc tabs                             | `components/ui/Segmented.tsx`                                                     |
| doc render + light-edit                | `components/ui/MarkdownView.tsx` · `MarkdownEditor.tsx`                           |
| running job / writing step             | `components/ui/Spinner.tsx`                                                       |
| discovery-failed state                 | `components/ui/ErrorState.tsx`                                                    |
| message bubble                         | **new ARRANGEMENT** = `Card` + `Avatar` + `MarkdownView` (no new primitive)       |
| avatar                                 | the initial-letter disc (`issueCellPrimitives`)                                   |
| icons                                  | lucide-react + the Google / GitHub brand marks                                    |

No new design-system primitive is invented. If a future need arises that a shipped
primitive can't cover, that is a NEW `design/` subtask, not a code workaround.

## Deliverable

The three-file design-asset set under `design/ai-chat/`:
`design-notes.md` (this file) · `onboarding.mock.html` (the HTML mockup — source of
truth) · `onboarding.png` (the full-page export — the board-visible face).
