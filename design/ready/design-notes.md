# Ready — design notes

Design reference for the `ready` UI area — the **AI dispatch surface** (Story
7.0). The asset is the source of truth for every UI subtask in Story 7.0. Built
FROM the real design system (`app/globals.css` `--el-*` / shape tokens + the
shipped `components/ui/*` and issue-cell primitives), so the code subtasks
compose the same primitives — no Pencil→code gap.

| Surface                            | Asset                               | Notes                                                                                                                                                                                                                              |
| ---------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ready set page + dispatch rows** | **`ready.mock.html`** (HTML mockup) | The whole `/ready` surface — no `design/ready/` asset existed; the 7.0.1 design gate produces this. Multi-panel: populated page · popover · sidebar entry · empty · copy toast. **Gates 7.0.6** (the page + sidebar code subtask). |

The `/ready` page is a **pure consumer** of the Story-7.0 service/endpoints
(`workItemsService.listReady` server-side for the page; `GET /api/ready` +
`POST /api/ready/next` for the BYOK CLI / a future agent). It renders the
project's **ready set** — every work item whose `is_blocked_by` blockers are all
terminal (the shipped 2.4.5 / finding-#21 readiness rule) — as a flat dispatch
list, NOT a board (readiness is a flat set; a board would lie about its
structure).

The asset is **multi-panel** (review EACH, not just the first — mistake #31):

- **(1)** the populated `/ready` page — header + count + "What is this?" button,
  the flat list of dispatch cards, one row shown hovered with the copy-button +
  its tooltip, and a review-only virtualization annotation.
- **(1b)** the **"What is this?" popover, open** — the first-run predicate
  explainer (anchored under the header button on the real page; drawn standalone
  here so its copy is reviewable without obscuring the list).
- **(2)** the **sidebar rail** with the new **"Ready"** entry (active),
  positioned BETWEEN Issues and Boards, carrying the count badge.
- **(3)** the **empty state** (zero ready items) — the `EmptyState` primitive.
- **(4)** the per-row **copy-confirmation toast** — the `Toast` primitive.

---

## Where it lives

A new authed route **`app/(authed)/ready/page.tsx`** (Server Component), reached
from a new **"Ready"** entry in the primary nav of
`app/(authed)/_components/SidebarNav.tsx` (and therefore the mobile
`SidebarDrawer`, which renders the same `SidebarNav`). The page resolves the
active project via the established `getActiveProject()` pattern (mirror
`/dashboard`, `/issues`) and reads `workItemsService.listReady` directly
(server-component path; the HTTP endpoints are for the OTHER consumers).

The board is flat — there is **no `/ready` board view**; readiness is a set.

## Layout (panel 1 — the page)

- **Page shell** inside the app shell (1.5.1): the `/issues` page-header grammar
  — a serif `h1` title + a muted subtitle — extended with a count chip and a
  help button:
  - **Title** — `font-serif text-2xl font-semibold text-(--el-text)` reading
    **"Ready to start"** (`t('ready.heading')`). Not "Ready" alone — the
    imperative names the surface's job.
  - **Count chip** — a neutral `Pill` (`tone="neutral"`) beside the title:
    **"{n} ready"** (`t('ready.count', { count })`). The denominator the agent
    will dispatch from; neutral, never coloured by urgency.
  - **Subtitle** — `text-(--el-text-muted) text-sm` reading the active project:
    **"{projectName} · {projectKey}"** (e.g. "Motir · PROD").
  - **"What is this?" button** — a `Button variant="ghost" size="sm"` with a
    leading lucide `circle-question-mark` (the glyph behind `CircleHelp`),
    `text-(--el-text-secondary)`. Opens the predicate popover (panel 1b). First-
    run discoverability for a concept (the readiness predicate) a new user won't
    know.
- **The list** is a vertical stack of **dispatch cards** (`gap-2`), each a
  `Card`-shaped row (`--radius-card` + `--el-border` + `--shadow-subtle`, on
  `--el-page-bg`). Whole-card clickable → opens the existing **`IssueQuickView`
  peek** (the `/issues` interaction — NOT a full-page navigation, notes.html #7).
  Hover raises `--el-border-strong` + `--el-surface-soft` and underlines the
  title.
- **Sort** — `(priority desc, key asc)`, the SAME order `POST /api/ready/next`
  dispatches, so the page and the agent agree on "what's next". Documented in a
  dashed **review-only** `.virt-note` (NOT shipped), which also notes the list
  **virtualizes via the 2.5.15 `useRowWindow` primitive** (only viewport rows
  render; cursor pages stream in on scroll) — the finding-#57 scale shape.

## Dispatch-card anatomy (panel 1) — REUSES the issue primitives

A ready row composes the EXACT shipped vocabulary — **no new card primitive**:

- **`IssueTypeIcon`** (`components/issues/IssueTypeIcon.tsx`) — the kind's lucide
  glyph in its `--el-type-*` hue (epic = zap / story = book-open / task =
  square-check-big / bug = bug / subtask = list-checks). 18px. Decorative
  (`aria-hidden`); the key + title carry the accessible name.
- **Key** — the mono identifier `PROD-<n>` in `font-mono text-xs
text-(--el-text-muted)`.
- **Title** — `text-sm text-(--el-text)`, single-line truncate.
- **Priority `Pill`** — the shared `PRIORITY_META` chip (`PriorityValue` from
  `issueCellPrimitives`): a tone plus a direction icon. Highest is rose
  (`severity=danger`) with an up arrow; high is peach (`warning`) with an up arrow;
  medium is neutral with a minus; low is sky (`info`) with a down arrow; lowest is
  neutral with a down arrow. AA via charcoal-on-tint (finding #35).
- **Assignee** — the initial-letter **`Avatar`** (`issueCellPrimitives`) + name
  in `text-(--el-text-secondary)`; **unassigned** renders the dashed-circle
  placeholder (`border-(--el-border-strong)`), matching the cell convention.
- **Copy icon-button** — a square icon button (`--spacing-icon-btn` padding,
  `rounded-(--radius-control)`, 16px lucide `copy` in `text-(--el-text-muted)`)
  revealed on row hover / keyboard focus. Keyboard-reachable with an explicit
  `aria-label` **"Copy run command for PROD-<n>"**. On hover it shows the
  **`Tooltip`** (dark `--el-text` bubble, `--el-text-inverted` text) reading
  **Copy `motir run PROD-<n>`**. Click copies the server-built `runCommand`
  (`ReadyItemDispatchDto.runCommand`, the 7.0.3 field) verbatim and fires the
  panel-4 toast.

## The "What is this?" popover (panel 1b)

A Radix `Popover` rendered as a card container — radius `--radius-card`, border
`--el-border`, shadow `--shadow-elevated`, on `--el-page-bg` — anchored under the
header help button. Copy:

- **Heading** — `What is "ready"?`
- **Body 1** — "A work item is **ready** when every issue blocking it has been
  completed — so it has no unfinished blockers and can be started right now."
- **Body 2** — "Click `Copy` on any row to put its `motir run PROD-…` command on
  your clipboard, then paste it into your own coding agent to dispatch the work."
  (the `motir run PROD-…` rendered as an inline `--el-code-bg` code chip.)

## Sidebar entry + count badge (panel 2)

- A new `SidebarItem` inserted into the primary section of `SidebarNav.tsx`,
  **between Issues and Boards** — composes the shipped `Sidebar` row grammar
  (`h-(--height-control)` · `rounded-(--radius-control)` ·
  `px-(--spacing-control-x)` · 18px icon · `text-sm`). Active state = the canvas-
  inset treatment (`bg-(--el-sidebar-item-bg-active)` + `border-(--el-sidebar-
border)` + `shadow-(--shadow-subtle)` + accent icon + `font-medium`), exactly
  as the other rows.
- **Icon — LOCKED: lucide `circle-play`** (the 7.0.1 design decision the plan
  card defers to me). The card _suggested_ `Zap`, but **`Zap` is already the
  epic issue-type glyph** (`ISSUE_TYPE_META.epic.icon`) — reusing it for a nav
  item invites a glyph clash. `circle-play` reads as "run / dispatch", which is
  exactly what this surface does (its rows copy a `motir run` command), and it
  collides with no issue-type glyph. Justified deviation from the card's
  suggestion under a concrete reason (the dispatch semantic + the glyph-clash
  avoidance).
- **Label** — `t('nav.ready')` → **"Ready"**. **Href** — `/ready`.
- **Count badge** — the readiness total in the neutral `Pill` grammar, sized for
  the rail (`bg-(--el-muted)` + `text-(--el-text-secondary)` + `border-(--el-
border)`, `rounded-(--radius-badge)`). **Tone: neutral — never coloured by
  urgency.** Sourced from the SAME `listReady` count the page renders (read once
  in `app/(authed)/layout.tsx` and passed via the existing sidebar props
  plumbing, to avoid a double-fetch — see the 7.0.6 card's note; if that
  plumbing exposes no slot, that's a follow-up subtask, not an improvisation).

## Empty state (panel 3)

The shipped **`EmptyState`** primitive (Card + icon + title + description +
action), shown when the active project has zero ready items:

- **Icon** — lucide `Inbox` (the primitive's default; the neutral "nothing here"
  glyph). `text-(--el-text-muted)`, 48px.
- **Title** — **"Nothing's ready right now"** (`t('ready.empty.title')`).
- **Description** — **"A work item appears here once every issue blocking it is
  done. Right now nothing is fully unblocked — head to Issues to see what's still
  in progress and what it's waiting on."** (`t('ready.empty.body')`) — explains
  the predicate AND points elsewhere for not-ready work.
- **Action** — a `Button variant="secondary"` (rendered as a `Link`) **"View all
  issues"** → `/issues`, leading lucide `circle-dot` (the Issues nav glyph).

## Copy-confirmation toast (panel 4)

The shipped **`Toast`** primitive, `variant="success"` (left `border-(--el-
success)`, `CheckCircle2` icon in `--el-success`), bottom-right of the viewport:

- **Title** — **"Copied"** (`t('ready.toast.title')`).
- **Description** — **"Paste `motir run PROD-<n>` into your terminal."**
  (`t('ready.toast.body', { command })`), the command as an inline `--el-code-bg`
  code chip.
- Fired via `useToast()` from the row's copy handler. The close `×` is the
  primitive's built-in `RadixToast.Close`.

## i18n

- **`shell` namespace** — add `nav.ready` → "Ready".
- **new `ready` namespace** — `heading` ("Ready to start"), `count`
  ("{count} ready"), `empty.title`, `empty.body`, `whatIsThis` ("What is
  this?"), `popover.title`, `popover.body1`, `popover.body2`, `toast.title`,
  `toast.body`, `copyAria` ("Copy run command for {key}").
- Same locale set the rest of the app ships.

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): the palette, not grey + one
  accent — issue-type hues (`--el-type-*`), the priority `Pill` tones (rose /
  peach / sky / neutral), the accent on the active nav row + project mark, the
  `--el-success` toast, the `--el-code-bg` command chips. No Tier-0 `--color-*`
  and no Tailwind Tier-0 utilities (`text-foreground` / `bg-surface`). Tints
  carry the hue in the BACKGROUND with `--el-text-strong` text (finding #35, AA);
  no page-level surface is tinted.
- **Shape** via element-semantic tokens only (`--radius-card` / `-btn` /
  `-badge` / `-control` / `-input`, `--shadow-subtle` / `-card` / `-elevated`,
  `--spacing-card-padding` / `-control-*` / `-icon-btn` / `-chip-*` /
  `-tooltip-*`, `--height-control` / `-btn-*`) — no generic Tier-0 scale, no raw
  `rounded-md` / `p-1` / `h-9`. `rounded-full` only on the circular avatar.
- **Not colour-alone** (finding #35): priority carries tone + direction icon +
  text; the copy affordance is icon + tooltip + `aria-label`; the empty/ready
  meaning is in copy, not hue; the toast pairs the green with the check icon +
  "Copied" text.
- **A11y**: the list is a `role="list"` of `role="listitem"` rows; the copy
  button is keyboard-reachable with an explicit `aria-label`; the toast is a
  `role="status"`; the page header is a single `h1`; row click opens the peek
  (no full-page nav), matching `/issues`.

## Primitives composed (no hand-rolling)

| Element                | Shipped primitive                                                         |
| ---------------------- | ------------------------------------------------------------------------- |
| dispatch card / empty  | `components/ui/Card.tsx` · `components/ui/EmptyState.tsx`                 |
| type icon (hued)       | `components/issues/IssueTypeIcon.tsx` (`ISSUE_TYPE_META`)                 |
| priority chip          | `issueCellPrimitives.tsx` `PriorityValue` (`PRIORITY_META`)               |
| count chip / nav badge | `components/ui/Pill.tsx` (`tone="neutral"`)                               |
| assignee avatar        | `issueCellPrimitives.tsx` `Avatar` / `AssigneeValue`                      |
| copy tooltip           | `components/ui/Tooltip.tsx`                                               |
| copy / help / action   | `components/ui/Button.tsx` (ghost / secondary / icon)                     |
| sidebar entry + badge  | `components/ui/Sidebar.tsx` via `app/(authed)/_components/SidebarNav.tsx` |
| copy confirmation      | `components/ui/Toast.tsx` (`useToast`, `variant="success"`)               |
| row peek               | `app/(authed)/issues/_components/IssueQuickView.tsx`                      |
| virtualization         | the 2.5.15 `useRowWindow` windowing primitive                             |

No new design-system entry is invented in this Story. If a future need arises
that a shipped primitive can't cover, that is a NEW `design/` subtask, not a code
workaround.

---

## Work-type chip + manual "Show instruction" (8.8.5, gating 8.8.10)

Asset: **`work-type-manual.mock.html`** / **`.png`** — adds two related treatments
to the dispatch rows above. (The base ready row anatomy is unchanged; this layers
onto it.)

### (1) The work-type chip on ready rows

Each ready row gains the shipped **`WorkItemTypeChip`**
(`components/issues/WorkItemTypeChip.tsx`) — the leaf's work `type` (`code` /
`design` / `test` / … / `manual`), **distinct from the kind icon** at the row's
lead. It sits at the **head of the meta cluster**, before the priority `Pill`
(the two "tags" — type + priority — group together), then assignee, then the
action slot: `[type chip] · [priority] · [assignee] · [action]`. A ready item
with `type: null` (a story/task with no work type) **omits the chip** — no `—`
placeholder, since a flex row (unlike the list's grid) needs no column filler.
The chip recipe is unchanged (tint background via `workItemTypeChipBackground()`,
`--el-text-strong` label, hued `WorkItemTypeIcon` — 14% mix, 18% for `manual`).

### (2) The manual variant — copy button → "Show instruction"

A coding agent **cannot run human work**, so a ready row whose item is manual
(**`executor: human`** / **`type: manual`**) has **no `motir run` command**. Its
action slot swaps the hover-revealed **Copy** icon-button for a labelled
**"Show instruction"** button:

- A **ghost `Button` size `sm`** (`--height-btn-sm`, `--radius-btn`, `--el-border`,
  `text-(--el-text-secondary)`) with a leading lucide **`scroll-text`** glyph
  (15px) and the text **"Show instruction"**. `aria-label` **"Show instruction
  for PROD-<n>"**.
- **Always visible** (not hover-gated like the agent Copy button) — reading the
  instruction is the only way to action a human task, so it must not hide behind
  hover. The agent Copy button stays reveal-on-hover (the row is calm at rest and
  the command is one hover away). The **Manual type chip** is the at-rest
  discriminator that flags a row as human work before you even reach the button.
- Hover **Tooltip**: **"A human task — no run command"** (the shipped `Tooltip`,
  dark `--el-text` bubble) — names WHY it differs from the other rows' Copy.

Clicking opens the **instruction modal**.

### The instruction modal (`Modal` + `MarkdownView`)

The shipped **`Modal`** (`components/ui/Modal.tsx`, size **`lg`** = 32rem) +
**`MarkdownView`** (`components/ui/MarkdownView.tsx`) rendering the item's
**`descriptionMd`** — the SAME markdown stack + `motir-prose` styling as the issue
detail page, so the run-instruction reads identically wherever it appears.

- **Header** — `Modal title` (serif `text-xl`) = the work item **title**. A
  **subhead** row below it: the mono key (`PROD-<n>`), the **Manual** type chip,
  and **"Human task · assigned to {name}"** (or "· unassigned").
- **Body** — `Modal.Body` (the shipped `flex-1 overflow-y-auto` scroll recipe)
  wrapping `MarkdownView value={descriptionMd}`.
- **Footer** — `Modal.Footer` with a single **"Close"** ghost `Button`; the
  built-in `×` and Radix's ESC / click-outside / focus-trap / focus-return all
  also dismiss.

**States:**

- **Empty** — when `descriptionMd` is blank, the body shows a quiet empty block
  (lucide **`file-x`** 40px in `--el-text-faint` + **"No instruction yet"** +
  "This human task has no description. Add one on the work item so whoever picks
  it up knows what to do.") instead of a blank pane, pointing the reader at the
  fix.
- **Long content** — the body **scrolls** (`max-h-[90vh]` on the panel) while the
  title, subhead, and footer stay pinned — the shipped `Modal` column layout.

**Data note for 8.8.10:** `ReadyItemDto` must carry `executor` + `type` (to pick
the variant) and the modal's description source — `descriptionMd` inline, or a
**fetch-on-open** (`get_work_item` / the detail endpoint) to keep the list
payload lean. Fetch-on-open is preferable when descriptions are long; the modal
then shows a brief loading state before the `MarkdownView`.

### Primitives composed (no hand-rolling)

| Element                 | Shipped primitive                                                               |
| ----------------------- | ------------------------------------------------------------------------------- |
| type chip               | `components/issues/WorkItemTypeChip.tsx`                                        |
| show-instruction button | `components/ui/Button.tsx` (ghost, size `sm`) + lucide `scroll-text`            |
| button tooltip          | `components/ui/Tooltip.tsx`                                                     |
| instruction modal       | `components/ui/Modal.tsx` (size `lg`, `Modal.Body` + `Modal.Footer`)            |
| instruction body        | `components/ui/MarkdownView.tsx` (`descriptionMd`)                              |
| empty state             | inline (lucide `file-x` + copy) — the same shape as `EmptyState` at modal scale |

No new design-system entry is invented — every piece reuses a shipped primitive.
