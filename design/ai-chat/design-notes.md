# AI chat — design notes

Design reference for the `ai-chat` UI area — the **AI planning front door**
(Story 7.2, the first human-facing AI surface in Epic 7). The asset is the
source of truth for the Story-7.2 UI subtasks (7.2.7 chat UI, 7.2.8 docs view)
and sets the visual grammar the rest of the planning flow reuses (7.3 review,
7.4 diff, 7.6 dispatch). Built FROM the real design system (`app/globals.css`
`--el-*` colour + `[data-display-style]` shape tokens, and the shipped
`components/ui/*` primitives), so the code subtasks compose the same primitives
— no Pencil→code gap, no Tier-0 `--color-*`, no raw `rounded-*`/`p-*`/`h-*`.

| Surface                                            | Asset                                 | Notes                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Chat front door + discovery + 3 direction docs** | **`ai-chat.mock.html`** (HTML mockup) | The whole `ai-chat` surface — no `design/ai-chat/` asset existed; the 7.2.1 design gate produces this. Multi-panel. **Gates 7.2.7** (chat UI) **and 7.2.8** (docs view). |

The asset is **multi-panel** (review EACH, not just the first — mistake #31):

- **(1)** the **chat front door** (first run / empty) — heading, explainer, the
  prompt `Textarea`, the primary "Start discovery" action, and the "What happens
  next?" `Popover` shown OPEN.
- **(2)** the **discovery interview** (mid-conversation, streaming) —
  alternating user / assistant message bubbles, a streaming caret + typing
  affordance, and the **pin-vs-delegate** decision model (a pinned answer, a
  delegated answer, AND the live pin/delegate affordance on the open question).
- **(3)** the **three direction docs** (vision / discovery / feasibility) as
  editable Markdown — Discovery active in a `Segmented` tab strip, its
  **PINNED-vs-DELEGATED** split visible, and the "Looks right — generate the
  plan" CTA (drawn here; **wired in 7.3**).
- **(4)** the **running / error / resume** states — the streaming job (tied to
  the 7.1.4 job stream), the discovery-failed `ErrorState` with retry, and the
  "docs already exist — resume" state.

---

## ⚠️ Verified-vs-assumed mirror note (read before building)

The mirror product for the AI layer is **Atlassian Rovo** (Jira's AI). What is
**verified** vs **assumed** must be visible to the reviewer:

- **VERIFIED (Rovo):** a conversational chat front door where the user describes
  intent in natural language and the assistant streams a reply. The
  chat-as-entry-point posture is real.
- **ASSUMED (Motir-specific — to validate against a live Rovo tenant):** the
  explicit **discovery-interview** shape (a structured "do you care?" Q&A) and
  the **three direction-docs** model (vision / discovery / feasibility as
  reviewable, lightly-editable artifacts the plan is generated from). These are
  Motir's framing, taken from the Story-7.2 module header — not observed in
  Rovo. The **pin-vs-delegate** interaction (answer to PIN a decision, or hand
  it to the planner to DELEGATE) is likewise a Motir design decision. Panel 2's
  interaction in particular is to be validated against a live Rovo tenant before
  7.2.7 freezes its copy. Build to this design; flag at review if Rovo
  observation contradicts it.

## ⚠️ The message bubble is a composed pattern, NOT a separate design subtask

No shipped chat/message-bubble primitive exists in `components/ui/*`. Per the
7.2.1 acceptance criterion this is the decision point: **flag a new `design/`
subtask, or compose it here.** It is composed HERE, and that is deliberate —
7.2.1's stated job is to "set the visual language for the whole planning flow,"
so the message bubble IS this subtask's deliverable. It is a **NEW ARRANGEMENT
of shipped primitives — no new design-system vocabulary** (exactly as 7.0.1 made
the `/ready` dispatch card a new arrangement, not a new primitive):

- a **bubble** = a tinted `Card` surface (`--radius-card`, `--el-surface-soft`
  for assistant / `--el-tint-sky` for user, `--el-border`), with one corner
  squared (`--radius-sm`) toward its avatar — pure tokens, no hand-rolled shape.
- an **`Avatar`** (the initial-letter disc from `issueCellPrimitives`) — accent
  fill for Motir, sky tint for the user.
- a **`MarkdownView`** body inside the bubble (the same renderer the docs use).

So 7.2.7 should implement `MessageBubble` as a small composition of `Card` +
`Avatar` + `MarkdownView`, NOT a bespoke primitive and NOT a code workaround. If
a future need arises that these can't cover, THAT is a new `design/` subtask.

---

## Where it lives

A new authed route — proposed **`app/(authed)/plan/page.tsx`** (the AI planning
front door for the active project), reached from a primary-nav entry (the nav
entry + count are a 7.2.7 concern; this asset only specifies the surface).
The page resolves the active project via the established `getActiveProject()`
pattern (mirror `/dashboard`, `/issues`, `/ready`). The chat transcript and the
docs view are **client islands** (they own streaming + optimistic state); the
page-state-after-mutation contract applies — a generated-plan handoff (7.3) that
changes the issue tree must bump the relevant island tick, not lean on
`router.refresh()` alone.

## Panel 1 — chat front door (first run / empty)

- **Brand mark** — a `--radius-card` accent tile (`--el-accent` fill,
  `--el-accent-text`) holding the lucide **`sparkles`** glyph (20px). The AI
  signifier reused across the planning flow.
- **Heading** — `font-serif`, 27px, `--el-text`: **"Let's plan {projectName}"**
  (the active project identifier in `--el-accent-on-surface`). Names the
  surface's job with the project in it (mirror `/ready`'s imperative heading).
- **Explainer (lede)** — `--el-text-secondary`, 14px: "Describe what you want to
  build. Motir will ask a few questions, then draft three direction docs —
  vision, discovery, and feasibility — to plan from."
- **Prompt input** — the shipped **`Textarea`** primitive
  (`--radius-input`, `--el-border-strong`, `--spacing-input-*`), 4 rows,
  placeholder "e.g. A work tracker for small startup teams — issues, boards,
  sprints, and AI that turns a chat into a plan…". Drawn in its focused state
  (`--el-accent-on-surface` ring) to show the affordance.
- **Action row** — a `Button variant="ghost" size="sm"` **"What happens next?"**
  (leading lucide `circle-help`, `--el-text-secondary`) on the left opening the
  popover; a `Button variant="primary"` **"Start discovery"** (leading
  `sparkles`) on the right.
- **"What happens next?" `Popover`** (shown OPEN) — a `--radius-card` container,
  `--el-border`, `--shadow-elevated`, on `--el-page-bg`, anchored under the help
  button. A 4-step numbered explainer (numbers in `--el-muted` discs): **1** you
  describe it · **2** Motir interviews you (answer to **pin** a decision, or let
  Motir **decide**) · **3** it drafts three docs · **4** you generate the plan.
  First-run discoverability for the discovery→docs flow a new user won't know.

## Panel 2 — discovery interview (streaming)

- **Transcript** — a centered column (max 760px) of message rows; assistant rows
  left, user rows right (`row-reverse`), each `Avatar` + `who` label + `bubble`.
- **Pin-vs-delegate (the core interaction):**
  - a **pinned** answer — the user's reply bubble carries a `Pill`
    (`--el-tint-mint`, lucide `pin`) reading **"Pinned"** + the chosen value
    ("Vercel."). The decision is locked to what the user said.
  - a **delegated** answer — the user's reply bubble carries a `Pill`
    (`--el-tint-lavender`, lucide `wand-sparkles`) reading **"You decide"**. The
    planner will choose.
  - the **live affordance** on the open question — under a decision question, a
    dashed `--el-border-strong` divider, a hint ("Answer to pin it — or let Motir
    decide.", lucide `pin`), and option chips: the literal answers
    (`.opt`, `--el-border-strong`, `--radius-control`) plus a dashed
    **"You decide"** delegate chip (`.opt-delegate`, `wand-sparkles` in
    `--el-accent-on-surface`). This is the pin (pick an answer) vs delegate (hand
    it off) choice, rendered as a real control.
- **Streaming affordance** — the in-flight assistant message ends with a blinking
  **caret** (`--el-accent-on-surface`, `caret` keyframes), and a **typing**
  indicator (three `--el-text-muted` dots, `blink` keyframes) sits under the
  bubble. Animation is review-only; 7.2.7 drives it from the real token stream.
- **Composer** — a `Textarea` (2 rows) with an inline **send** icon-button
  (`--el-accent` fill, lucide `send-horizontal`) pinned bottom-right. Placeholder
  "Type a reply, or pick an option above…".

## Panel 3 — direction docs (review / light-edit)

- **Header** — `font-serif` `h3` **"Direction docs"** + a `--el-text-muted`
  subtitle "Review and lightly edit before generating the plan.", with the
  **`Segmented`** primitive on the right: **Vision · Discovery (active) ·
  Feasibility**, each with a lucide `file-text` glyph. Active tab =
  `--el-page-bg` + `--shadow-subtle` (the primitive's selected treatment).
- **Doc container** — a `Card` (`--radius-card`, `--el-border`,
  `--shadow-subtle`). A **doc-bar** header (`--el-surface-soft`) shows the file
  name (`file-text` + `discovery.md`), a muted "Edited just now · draft" stamp,
  and a `pencil` **icon-button** (the document-level edit affordance).
- **Body** — the **`MarkdownView` / `MarkdownEditor`** prose surface
  (`--font-serif` `h1`, uppercase `--el-text-muted` `h2` section labels,
  `--el-text-secondary` paragraphs). Editable blocks use the **editable-field**
  pattern: a hover-revealed `pencil` in the top-right + a `--el-surface-soft`
  hover wash + `--el-border`, matching the shipped inline-edit affordance.
- **Pinned-vs-delegated split** — under a **Decisions** heading, a stack of
  `dec-row`s, each a `--el-surface-soft` row with the same **Pinned** (mint,
  `pin`) / **Delegated** (lavender, `wand-sparkles`) `Pill`s from panel 2, so the
  discovery doc visibly separates what the user locked from what Motir will
  choose. (Deploy target / team size = pinned; deploy region / auth = delegated.)
- **CTA** — under a `--el-border` divider, a muted note ("Edits here update the
  docs. The plan is generated from all three in the next step.") + a
  `Button variant="primary"` **"Looks right — generate the plan"** (leading
  `sparkles`). **This is the 7.3 hand-off — DRAWN here, WIRED in 7.3.**

## Panel 4 — running / error / resume states

A responsive grid of three `Card` state panels:

- **Running** (`--el-tint-lavender` glyph tile) — a **`Spinner`** +
  **"Drafting your direction docs"**, a progress bar (`--el-muted` track,
  `--el-accent` fill), and a per-doc step list (Vision **done** in
  `--el-success` with a `check`; Discovery **writing…** with a small spinner;
  Feasibility **queued** with a `file-text`). Caption: "Streams live from the
  planning job (7.1.4). You can leave — it keeps running." Ties the surface to
  the 7.1.4 job stream.
- **Error** (`--el-tint-rose` glyph, lucide `triangle-alert` in `--el-danger`) —
  the shipped **`ErrorState`** shape: **"Discovery couldn't finish"** + body
  ("The planning job stopped before the docs were ready. Your answers are saved —
  retry to pick up where it left off.") + a `Button variant="secondary"`
  **"Try again"** (lucide `rotate-cw`).
- **Resume** (`--el-tint-sky` glyph, lucide `history` in `--el-info`) — **"Docs
  already exist"** + body ("You drafted direction docs for **Motir** on Jun 14.
  Pick up where you left off, or start a new discovery.") + a
  `Button variant="secondary"` **"Resume editing"** (`file-text`) and a
  `Button variant="ghost"` **"Start over"**. The re-open state when a project
  already has direction docs.

## i18n

A new **`plan` (AI planning) namespace**, same locale set as the rest of the
app. Strings: `door.heading` ("Let's plan {project}"), `door.lede`,
`door.placeholder`, `door.start` ("Start discovery"), `door.whatsNext` + the
4 `popover.step{1..4}` bodies; `chat.composerPlaceholder`, `chat.pinned`
("Pinned"), `chat.delegate` ("You decide"), `chat.decisionHint`; `docs.heading`,
`docs.subtitle`, the three `docs.tab.*` labels, `docs.generate` ("Looks right —
generate the plan"); `state.running.*`, `state.error.*` (reuse `ErrorState`),
`state.resume.*`. (7.2.7 / 7.2.8 own the final key names; this lists the copy.)

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): the accent for the AI mark /
  primary CTAs / send / active nav; the **palette, not grey + one accent** — the
  pin chip is mint (`--el-tint-mint`), the delegate chip is lavender
  (`--el-tint-lavender`), the user bubble is sky (`--el-tint-sky`), the error
  glyph rose + `--el-danger`, the resume glyph sky + `--el-info`, the success
  step `--el-success`. No Tier-0 `--color-*`, no Tier-0 utilities. Tints carry
  the hue in the BACKGROUND with `--el-text-strong` text (finding #35, AA); no
  page-level surface is tinted.
- **Shape** via element-semantic tokens only (`--radius-card` / `-input` /
  `-btn` / `-badge` / `-control`, `--shadow-subtle` / `-card` / `-elevated`,
  `--spacing-input-*` / `-btn-*` / `-chip-*` / `-icon-btn`,
  `--height-btn-*`) — no generic Tier-0 scale, no raw `rounded-md` / `p-1` /
  `h-9`. `rounded-full` (`--radius-pill`) only on the circular avatar / spinner /
  typing dots.
- **Not colour-alone** (finding #35): pin vs delegate carries an icon (`pin` vs
  `wand-sparkles`) + a label + a distinct tint, never hue alone; the streaming
  state pairs the caret with the typing dots; each state card pairs its tint with
  an icon + a title.
- **A11y**: the popover is a `role="dialog"` with an accessible name; the tab
  strip is `role="tablist"` / `role="tab"` with `aria-selected`; the typing
  indicator carries `aria-label="Motir is typing"`; the send button has an
  `aria-label`; every icon is decorative (`aria-hidden` in code) with the text
  carrying the accessible name. AA holds on all tints (charcoal-on-tint,
  finding #35).

## Primitives composed (no hand-rolling)

| Element                       | Shipped primitive                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| front door / state / doc card | `components/ui/Card.tsx`                                                                                                                                           |
| prompt + composer input       | `components/ui/Textarea.tsx`                                                                                                                                       |
| "what happens next?" popover  | `components/ui/Popover.tsx`                                                                                                                                        |
| primary / ghost / secondary   | `components/ui/Button.tsx`                                                                                                                                         |
| pin / delegate chips          | `components/ui/Pill.tsx` (tint tones)                                                                                                                              |
| 3-doc tabs                    | `components/ui/Segmented.tsx`                                                                                                                                      |
| doc render + light-edit       | `components/ui/MarkdownView.tsx` · `MarkdownEditor.tsx`                                                                                                            |
| inline editable block         | the shipped editable-field pattern (hover pencil + wash)                                                                                                           |
| running job / writing step    | `components/ui/Spinner.tsx`                                                                                                                                        |
| discovery-failed state        | `components/ui/ErrorState.tsx`                                                                                                                                     |
| message bubble                | **new ARRANGEMENT** = `Card` + `Avatar` (`issueCellPrimitives`) + `MarkdownView` (see the bubble note above — no new primitive)                                    |
| avatar                        | `issueCellPrimitives.tsx` `Avatar` (initial-letter disc)                                                                                                           |
| icons                         | lucide-react (`sparkles`, `circle-help`, `pin`, `wand-sparkles`, `send-horizontal`, `file-text`, `pencil-line`, `rotate-cw`, `history`, `triangle-alert`, `check`) |

No new design-system entry is invented in this Story. If a future need arises
that a shipped primitive can't cover, that is a NEW `design/` subtask, not a code
workaround.
