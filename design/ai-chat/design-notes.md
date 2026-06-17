# AI chat / onboarding — design notes

Design reference for the `ai-chat` UI area — **Motir's start-fresh onboarding
journey** (Story 7.3, `MOTIR-804`), designed as a **visual planning canvas** in
the spirit of cofounder.co: the process is the hero, the chat is a quiet rail.

> **The spine of the whole design — one continuous road:**
> **Idea → Discover · Shape · Validate → Plan → Epic 1 → Epic 2 → Epic 3 → …**

The user describes an idea; it flows through **three stages** and materializes as
a generated issue tree (a dispatchable backlog). **A "vibe project" is the WHOLE
venture, not just the code** (Yue, 2026-06-17) — Motir plans the entire project
(**brand, pricing, legal, marketing, and the code**), tracks **every kind of
work** in one place, and ships the code for you. So the generated plan and the
roadmap span all of Motir's work-item types, not just engineering (see "Whole-
project breadth" below). **The canvas is not thrown away once planning ends — it
becomes the project's persistent ROADMAP**: the same road continues through the
epics, and each epic expands into its own sub-roadmap (the work-item tree in the
same node/road language). Onboarding and the roadmap are one surface (panels 7–8). This asset is the layout source
of truth for every UI subtask in Story 7.3 — the chat front-door UI (`7.3.5`), the
stage-output render/edit view (`7.3.6`), the wizard/canvas shell (`7.3.11`) and the
orchestration it embeds (`7.3.9`). It is built FROM the real design system
(`app/globals.css` `--el-*` colour + `[data-display-style]` shape tokens, the
shipped `components/ui/*` primitives, the real app shell + nav), so the code
subtasks compose the same primitives — no Pencil→code gap, no Tier-0 `--color-*`,
no raw `rounded-*` / `p-*` / `h-*`.

> **Supersedes** the old `7.2.1` chat design (`MOTIR-489`, PR #1216 — never merged)
> and the old `7.15.1` wizard design. The `7.3` re-plan consolidated the chat front
> door and the onboarding wizard into ONE flow. **This revision (Yue, 2026-06-17)
> further pivots the visual language**: the earlier draft was a chat-dominated
> wizard with the three artifacts framed as **documents** (tabs, `discovery.md`
> filenames). Per feedback — modelled on cofounder.co — the redesign makes the
> **idea → stages → plan process the visual hero on a spatial canvas**, **demotes
> the chat to a compact side rail**, and reframes the three artifacts as **stages
> of one process, never documents**.

---

## ⚠️ The three artifacts are STAGES, not documents

The backend persists three direction artifacts (vision / discovery / feasibility
`DirectionDoc`s in motir-ai). **The UI never presents them as documents** — no
tabs-of-files, no `*.md` filenames, no "open the doc" framing. They are the three
**stages of the visual process**, each a node on the canvas that fills in as the
user goes:

| Stage (UI)   | Backend artifact | What the stage captures                                  |
| ------------ | ---------------- | -------------------------------------------------------- |
| **Discover** | discovery doc    | the interview — what you're building & for whom          |
| **Shape**    | vision doc       | the product direction — scope, the core decisions        |
| **Validate** | feasibility doc  | a scope & feasibility check before any work is generated |

A completed stage renders as **structured direction** (labelled fields + decision
chips with pinned-vs-delegated markers), inline-editable — NOT a rendered Markdown
file (panel 5). The plan is generated only after Validate.

---

## ⚠️ Whole-project breadth — every kind of work, not just code

A vibe project spans the whole venture, so the generated plan + the roadmap show
**all of Motir's shipped work-item types**, each with its `--el-type-*` hue + a
type chip (a hue tint bg + `--el-text-strong` + a dot **and** a label — AA, never
colour-alone). The mapping used in the example (grounded in `workItemTypeMeta.ts`
— there is **no `legal` type**):

| Work                                                  | Type                                                    | Token               |
| ----------------------------------------------------- | ------------------------------------------------------- | ------------------- |
| the build                                             | `code`                                                  | `--el-type-code`    |
| logo / UI / brand                                     | `design`                                                | `--el-type-design`  |
| pricing / landing / marketing copy                    | `content`                                               | `--el-type-content` |
| incorporate / ToS / domain / accounts (incl. "legal") | `manual`                                                | `--el-type-manual`  |
| automated tests                                       | `test`                                                  | `--el-type-test`    |
| (also available)                                      | `research` · `review` · `deploy` · `decision` · `chore` | `--el-type-*`       |

The example plan (panels 6–8) is **"the whole project"**: epics **Brand & landing**
· **Build the product** · **Pricing & billing** · **Launch & growth**, with
work items spanning design / content / manual / code / test. Motir **plans + tracks**
every type; only `code` is **auto-shipped** by the hosted coding agent — the breadth
lives in the planner + tracker, the copy never claims the agent does legal/marketing.

---

## ⚠️ Grounded in SHIPPED REALITY (the design rule)

Every shell/nav/auth surface is drawn to fit what is actually implemented:

- **The real primary nav** (`app/(authed)/_components/SidebarNav.tsx`, labels from
  `messages/en.json`): **Dashboard · Work Items · Ready · Boards · Backlog ·
  Triage · Reports**, then **Settings · Job runs · Docs**. The `/issues` label
  renders **"Work Items"** (never "Issues"). **There is NO `Plan` nav entry** — the
  onboarding canvas is NOT a nav destination; it is a focused flow reached via the
  access path below.
- **The real app shell** (`app/(authed)/layout.tsx`, `Sidebar.tsx`): a sticky 56px
  top bar (sidebar toggle + `ShellTierNav` org→workspace→project; right: Create-issue,
  ⌘K search, Report, theme, bell, user) over a 240px sidebar rail.
- **The real auth** (`app/(auth)/`, `AuthShell.tsx`): a centered `max-w-[28rem]`
  Card on `--el-surface`, serif headline, no wordmark — the login gate (panel 2)
  reuses this grammar (rendered as a `Modal`; a full-page `/sign-up?intent=plan`
  redirect is equally valid — the load-bearing requirement is **prompt
  preservation**).
- **The root** (`app/page.tsx`) is a placeholder; panel 1 (the landing) replaces it.
- **AI is cloud-gated** (`design/ai-usage/`): the planner is a closed cloud service;
  a self-host install must connect a Motir Cloud token first — the **"Connect Motir
  AI"** gate (panel 6) is FIRST specified here (no prior shipped design).

---

## ⚠️ Access path — the canvas is reached from TWO doors (both DRAWN)

1. **Logged-out → the public hero** (panel 1): typing an idea + "Start planning" →
   the login gate (panel 2), idea preserved across auth.
2. **Authed → the ProjectSwitcher "Plan a new project"** (panel 3,
   `ProjectSwitcher.tsx`): the switcher Popover is drawn OPEN with that row
   highlighted — the affordance that opens the planning canvas. (Build note:
   consolidates with the existing `CreateProjectModal`; replace-vs-augment is a 7.3
   build decision, flagged not silently decided.)

---

## The design language (futuristic, within our tokens)

- **The planning canvas** — a warm `--el-surface` field with a low-contrast
  **dotted grid** (a `radial-gradient` dot pattern), the cofounder canvas feel.
- **Stage nodes** (`.snode`) — soft `Card`s (`--el-page-bg`, `--el-border`,
  `--radius-card`, `--shadow-card`) with a tinted glyph tile per stage, a **mono
  micro-label** ("STAGE 1 · DISCOVER"), a title, and a state line.
- **Connectors** (`.conn` / `.tconn`) — dashed grey for done/upcoming; the **active
  path is a solid `--el-accent` line with a soft glow**.
- **State encoding (never colour-alone)** — done = `check` + `--el-success`; active
  = `--el-accent` ring + glow + label; upcoming = ghosted/dashed + `--el-text-faint`.
- **Mono micro-labels** for all stage meta (`STAGE 2 OF 3`, `IDEA`, `PLAN ·
1 EPIC · 4 STORIES · 12 SUBTASKS`).
- Lavender / sky / mint tints for the three stages; accent for the active path +
  primary CTAs. A soft `--el-hero-wash-a` wash behind the landing hero.

---

## Surfaces (multi-panel — review EVERY panel, mistake #31)

| #   | Panel                         | What it fixes                                                                                                                                                                                 |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Public landing**            | the idea prompt + the **visual pipeline preview** (`Idea → Discover · Shape · Validate → Plan`) — "what's going to happen", made visual; replaces `app/page.tsx`                              |
| 2   | **Login gate**                | the `Modal` on a logged-out submit; the **preserved-idea** callout; OAuth + email                                                                                                             |
| 3   | **Authed access path**        | the REAL shell + nav; the ProjectSwitcher open on "Plan a new project"                                                                                                                        |
| 4   | **The planning canvas**       | the spatial stage pipeline as the MAIN STAGE; the chat as a **compact right rail** driving the active stage (pin-vs-delegate)                                                                 |
| 5   | **Stage review + transition** | the SAME shell — Discover collapsed to done, **Shape expanded in place** into review/edit, the rail re-pointed to "Shape · chat", and **"Continue to Validate →"** (the drawn 4→5 transition) |
| 6   | **Plan + states**             | the **issue tree materializing on the canvas** + "Review & dispatch"; the canvas states (generating / failed / resume / Connect Motir AI)                                                     |
| 7   | **The project roadmap**       | the road CONTINUES past planning: a collapsed planning origin → **Epic 1 → Epic 2 (you-are-here) → Epic 3 → +more**, each with progress/status — the persistent roadmap                       |
| 8   | **Epic expanded**             | one epic opened into its **sub-roadmap** — its stories → subtasks tree in the same road/node language (kind hues + status); the work-item tree as a roadmap                                   |

---

## Panel notes

### Panel 1 — public landing (idea capture + the visual process)

- A marketing top-nav (brand lockup `--el-accent` tile + `sparkles` + serif "Motir";
  Product / Resources / Pricing / Docs; "Log in" ghost + "Sign up" primary) —
  cloud-only chrome.
- Hero: an eyebrow `Pill` ("✦ Vibe project", lavender); a `font-serif` ~44px **"What
  do you want to build?"**; the **whole-project** vibe-project definition subhead
  ("…a vibe project is the whole thing — describe your idea and Motir plans the
  entire project (brand, pricing, legal, marketing, and the code), tracks every kind
  of work in one place, and ships the code for you" — **never "AI project
  management"**). A compact idea prompt (`Card` + borderless `Textarea` + "Free to
  start · no card" + a primary **"Start planning"**).
- **The hero visual** — under "HOW IT WORKS · ONE VISUAL PROCESS", the pipeline
  preview on a dotted-grid canvas: `Your idea → Discover · Shape · Validate → Your
plan → · your epics`, connected stage nodes (the road visibly continues past the
  plan into the roadmap). The caption frames it as a plan **for the whole project**.

### Panel 2 — login gate

A `Modal` (`role="dialog"`) over the dimmed landing; brand tile + serif **"Sign in
to start planning"**; a **"Your idea — saved"** callout (`--el-surface-soft`,
`--el-accent` left rule) with the verbatim prompt; **Continue with Google** (4-colour
G) / **GitHub** / email + a **"Log in"** foot link. Reuses the `(auth)` flow.

### Panel 3 — authed access path

The REAL app shell (56px top bar + `ShellTierNav` + the 240px sidebar with the real
7-item nav, Dashboard active) with the **`ProjectSwitcher` Popover OPEN** on a
highlighted **"Plan a new project"** row — the authed door into the canvas. A
caption names both doors.

### Panel 4 — the planning canvas (the hero)

- The **main stage** is the spatial pipeline on the dotted grid: **Your idea**
  (pinned, the preserved prompt) → **Discover** (ACTIVE — `--el-accent` ring +
  glow, "STAGE 1 · IN PROGRESS", captured items ticking in, pinned markers) →
  **Shape** (UP NEXT, ghosted) → **Validate** (UP NEXT) → **Plan — your backlog**
  (GENERATED LAST), joined by glowing-active / dashed connectors. Wizard chrome:
  brand + "New project" + "STAGE 1 OF 3 · DISCOVER" + a **"Save & exit"** (ghost —
  resumability).
- The **chat is a compact right rail** (~348px, `--el-surface-soft`, a "DISCOVER ·
  CHAT" mono header): the discovery Q&A driving the active stage — small bubbles
  (22px avatars, ~12.5px text), the **pin-vs-delegate** interaction (Pinned mint
  pill / "You decide" lavender pill / option chips + dashed "You decide"), a
  streaming caret + typing dots (`aria-label`), a small composer with a send
  icon-button. The rail is clearly **secondary** — the glowing active stage node on
  the canvas is the focal point.

### Panel 5 — stage review + the drawn 4→5 transition (SAME shell)

Panel 5 is **the same screen as panel 4** — the persistent `canvas + chat rail`,
not a separate layout. The flow within a stage: the rail asks → the active stage
node **expands in place** and fills with structured direction → when it has enough,
the node flips to a **review/edit** state with **"Continue to [next] →"** (that
button is the drawn transition). Here:

- **Discover** has collapsed to a **done** node ("Done · invoicing +
  payment-tracking · solo freelancers").
- **Shape** is the active node, **expanded in place** into "The shape of it"
  (`In scope` / `Out of scope (v1)` fields with hover-reveal inline-edit `pencil`
  - a **Core decisions** table whose rows carry the Pinned (mint, `pin`) /
    Delegated (lavender, `wand-sparkles`) chips), ending in a primary **"Continue to
    Validate →"**.
- The **chat rail re-points** from "Discover · chat" (panel 4) to **"Shape · chat"**
  with a Shape-specific Q&A — it stays present but quiet.

**De-duplicated per stage** (no field repeats): Discover = what / who · Shape =
in-scope / out-of-scope-v1 + core decisions · Validate = feasibility flags. No
filename, no Markdown-file framing — it is the stage's output on the canvas.

### Panel 6 — plan materialized + states

- The tracker shows Discover · Shape · Validate done → **Plan** active. The
  **generated issue tree forms on the canvas** (mono "PLAN · THE WHOLE PROJECT ·
  4 EPICS · 8 STORIES · 21 WORK ITEMS"): venture-spanning epics (Brand & landing ·
  Build the product · Pricing & billing · Launch & growth) → stories → work items
  carrying **type chips** (Design / Content / Code / Manual / …), the last rows
  ghosted / streaming in, with a primary **"Review & dispatch →"** (the 7.4 hand-off — drawn,
  wired later).
- A row of **canvas states**: **Generating your plan** (progress + "Discover ·
  Shape · Validate — done" + "Drafting the issue tree…"); **Discovery couldn't
  finish** (`ErrorState`: saved-answers + "Try again"); **Pick up where you left
  off** (resume: "Resume" + "Start over"); **Connect Motir AI** (`--el-tint-yellow`,
  `plug` glyph — the self-host connect-gate: "Planning runs on Motir Cloud…" +
  "Connect Motir AI" primary + "Self-hosted? Learn more").
- **Bridge:** once dispatched, this same canvas becomes the persistent roadmap
  (panel 7) — the road continues into the epics.

### Panel 7 — the project roadmap (the canvas, persistent)

The canvas is not thrown away after planning. The **road continues** on the same
dotted-grid surface: a collapsed **"planning origin"** cluster ("PLANNING · DONE":
✓ Idea · ✓ Discover · ✓ Shape · ✓ Validate · ✓ Plan) → **Epic 1** (done) → **Epic
2** (active, a `map-pin` **"You are here"** marker + an **"Open roadmap"** affordance
→ panel 8) → **Epic 3** (up next, ghosted) → **+ more epics**. Each epic node: an
`--el-type-epic` glyph, the epic title, a progress meter (e.g. "3 / 8 done"), a
story count, and a status. Connectors: green (done) → glowing accent (active) →
dashed (upcoming). A mono section label "ROADMAP · <project>" and a "Board view"
toggle (the roadmap is one VIEW of the work-item tree, alongside boards/backlog).

### Panel 8 — an epic expanded into its sub-roadmap (work-item tree as a road)

One epic node **opened in place**: the parent road stays visible (compact, the epic
marked OPEN), and below it the epic's **stories → subtasks** render in the SAME
node/road language — stories as nodes (`--el-type-story` green), their subtasks
beneath (`--el-type-subtask` teal), each with per-item status (done check /
in-progress / todo) **and a work-item TYPE chip** (Code · Design · Content · Manual ·
Test — "every kind of work", per the whole-project breadth above). A "TRACES TO
SHAPE · VALIDATE" lineage chip reinforces the
self-similar pattern (a roadmap = a planning origin + a tree of work, at every
level). This is **a new PRESENTATION of the shipped work-item tree** (epics →
stories → subtasks), not a new data model.

> **⚠️ Scope flag — panels 7–8 are beyond Story 7.3 (Yue, 2026-06-17).** The
> persistent **roadmap canvas** (the road continuing through epics + epic→sub-roadmap
> expansion) is a new project VIEW — a first-class surface in the mirror products
> (Jira Timeline/Roadmaps, Linear Roadmaps), and a recognised PM-tool view. Story
> 7.3 is _start-fresh onboarding_; the roadmap is drawn here because it is the same
> visual system and the continuity is the point, but its **BUILD needs its own
> owning story** (proposed: an Epic-7 story "Planning canvas → persistent project
> roadmap", `dependsOn` the 7.3 canvas shell + the work-item tree read). Tracked so
> the plan stays honest — not silently folded into 7.3's build scope.

---

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54), palette-not-grey-plus-accent: the
  three stage tints (lavender/sky/mint), the accent active path + glow, the success
  done-check, the rose error glyph + `--el-danger`, the yellow connect gate. The
  hero wash uses `--el-hero-wash-a`. No Tier-0 `--color-*`, no Tier-0 utilities.
  Tints carry the hue in the BACKGROUND with `--el-text-strong` text (finding #35,
  AA); the canvas dotted grid sits on `--el-surface` with low-contrast dots (no
  page-level tint).
- **Shape** via element-semantic tokens only (`--radius-card` / `-input` / `-btn` /
  `-modal` / `-control` / `-badge` / `-pill`; `--shadow-subtle` / `-card` /
  `-elevated` / `-modal`; `--spacing-*`; `--height-*`). `rounded-full` only on
  avatar / spinner / typing dots / pill / status dot.
- **Not colour-alone** (finding #35): every stage and state pairs an icon + a label
  - a tint; pin vs delegate pairs `pin` vs `wand-sparkles` + a label; the active
    path pairs the glow with the "IN PROGRESS" label + ring.
- **A11y**: the gate is `role="dialog"` with an accessible name; any tab strip is
  `role="tablist"` / `role="tab"` + `aria-selected`; the typing indicator carries
  `aria-label`; the send button has an `aria-label`; decorative icons are
  `aria-hidden`. AA holds on all tints (charcoal-on-tint).

## Primitives composed (no hand-rolling)

| Element                                               | Shipped primitive                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| marketing top-nav                                     | a `PublicTopBar`-style nav + `Button.tsx`                                                                                                              |
| stage node / state / direction card                   | `components/ui/Card.tsx` (tints) — `.snode` is a NEW ARRANGEMENT of Card, no new primitive                                                             |
| canvas + dotted grid + connectors                     | NEW ARRANGEMENT (CSS `radial-gradient` grid + token-styled connector lines) — no new design-system vocabulary                                          |
| roadmap epic / story / subtask nodes (panels 7–8)     | NEW ARRANGEMENT of `Card` + the `--el-type-{epic,story,subtask}` kind hues + the connector language — a new presentation of the shipped work-item tree |
| prompt box + composer + email                         | `Textarea.tsx` · `Input.tsx`                                                                                                                           |
| login gate                                            | `Modal.tsx` + the `(auth)` flow                                                                                                                        |
| eyebrow / pin / delegate / decision chip / stage meta | `Pill.tsx` (tint tones)                                                                                                                                |
| primary / ghost / secondary                           | `Button.tsx`                                                                                                                                           |
| app shell + sidebar (panel 3)                         | `app/(authed)/layout.tsx` · `Sidebar.tsx` · `SidebarNav.tsx` · `ShellTierNav.tsx`                                                                      |
| authed access path                                    | `ProjectSwitcher.tsx` (Popover + "Plan a new project")                                                                                                 |
| running job / writing step                            | `Spinner.tsx`                                                                                                                                          |
| discovery-failed state                                | `ErrorState.tsx`                                                                                                                                       |
| message bubble                                        | NEW ARRANGEMENT = `Card` + `Avatar` + `MarkdownView` (no new primitive)                                                                                |
| avatar                                                | the initial-letter disc (`issueCellPrimitives`)                                                                                                        |
| icons                                                 | lucide-react + the Google / GitHub brand marks                                                                                                         |

No new design-system primitive is invented — the canvas, stage nodes, and
connectors are new ARRANGEMENTS of shipped primitives + tokens (the same latitude
the message bubble takes). A future need a shipped primitive can't cover is a NEW
`design/` subtask, not a code workaround.

## Deliverable

The three-file design-asset set under `design/ai-chat/`: `design-notes.md` (this
file) · `onboarding.mock.html` (the HTML mockup — source of truth) ·
`onboarding.png` (the full-page export — the board-visible face).
