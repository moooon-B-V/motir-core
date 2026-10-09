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
`/dashboard`, `/items`) and reads `workItemsService.listReady` directly
(server-component path; the HTTP endpoints are for the OTHER consumers).

The board is flat — there is **no `/ready` board view**; readiness is a set.

## Layout (panel 1 — the page)

- **Page shell** inside the app shell (1.5.1): the `/items` page-header grammar
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
  peek** (the `/items` interaction — NOT a full-page navigation, notes.html #7).
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
text-(--el-text-identifier)` (MOTIR-4255; it was `--el-text-muted`, which the
  row's own `:hover` tint takes to 4.17:1).
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
  issues"** → `/items`, leading lucide `circle-dot` (the Issues nav glyph).

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
  (no full-page nav), matching `/items`.

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
| row peek               | `app/(authed)/items/_components/IssueQuickView.tsx`                       |
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
  (lucide **`file-x`** 40px in `--el-text-faint` + **"No instruction yet"** + — faint is correct here: a 40px lucide glyph beside the string, not the string.
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

---

## Lanes — runnable containers, standalone leaves and a Bugs lane, one switched full-height pane (MOTIR-6831, gating MOTIR-6834)

Asset: **`ready--lanes.mock.html`** — a DELTA on `ready.mock.html` (§ _Layout_ and
§ _Dispatch-card anatomy_ above), drawn against `/ready` as `origin/main` renders it
(rendered before drawing: a flat list of dispatch cards under "Ready to start").
Story MOTIR-6829 splits the ready set into three **lanes**, defined once in
`lib/workItems/readyFilter.ts` and served by `workItemsService.listReadyLeaves` /
`listReadyContainers` / `listReadyBugs` / `countReadyLanes`:

- **leaves** — the ready leaves that are not bug work, each naming its **runnable
  container** (a `story` / `task` / `bug` whose every child is childless — the shape
  `motir run <parent>` accepts) or none;
- **containers** — every non-bug runnable container holding at least one ready leaf;
- **bugs** — a ready `bug`, or a ready subtask of a bug.

The page shows the leaves lane as **Ready to run** and the bugs lane as **Bugs**. An
**epic is never a row**, and neither is a container holding a grandchild: its leaves
stand alone. Eight panels, one per state — review each.

**Revised twice on review.** Version `c181c7ae2` stacked Bugs under the main list;
the review asked for _"full page height for both 'ready to run' and 'bugs'"_. Version
`106bc0386` put them side by side in two full-height panes; the review asked to _"add a
switch to switch between 'ready to run' and bugs"_. This version: **one switch, one
full-height pane.**

### The page (panel 1)

- **Header** — unchanged: title **"Ready to start"**, the neutral **`{n} ready`**
  chip (`ready.count`, now the LEAVES lane's count from `countReadyLanes`), subtitle,
  "What is this?". The chip drops out with the EmptyState (panel 6), as today.
- **The lane switch** — directly below the header, a `Segmented` control
  (`components/ui/Segmented.tsx`, `role="tablist"`, `aria-label` **"Ready lanes"**,
  `ready.lanes.switchAria`) with two segments, each carrying its lane's count:
  **"Ready to run {n}"** (`ready.lanes.main.heading` + the leaves count) and
  **"Bugs {n}"** (`ready.lanes.bugs.heading` + the bugs count), the count in
  `text-xs text-(--el-text-secondary)`. **Default: Ready to run.** The choice is URL
  state the CLIENT reads — `?lane=bugs`, absent for Ready to run — written with
  `shallowPush` (`lib/navigation/shallowUrl.ts`, CLAUDE.md § _URL state the CLIENT
  reads_): both lanes' first pages are server-rendered with the page, so switching
  needs no server round-trip, draws no pending state, and a reload or a shared link
  lands on the same lane. The switch never moves on its own — not even when the
  chosen lane is empty (panel 4).
- **The pane** — ONE `role="tabpanel"` below the switch, filling the page height
  (`flex-1 min-h-0`, the page a `h-[calc(100dvh-<shell chrome>)]` flex column) with
  its OWN scroll container (`overflow-y-auto`). It holds the chosen lane's
  `role="list"`: **"Ready work items"** (`ready.listAria`, unchanged) for Ready to
  run, **"Ready bugs"** (`ready.lanes.bugs.listAria`) for Bugs. `gap-2`, as today.
- **Order** — the service's lane order, never re-sorted by the page: groups rank by
  their best member's `(kind, priority, key)`, members keep that order inside a
  group. A group is contiguous by construction.

### Rows

Every row is **today's dispatch card**, unchanged (`ReadyRow`: `IssueTypeIcon`, mono
key in `--el-text-secondary`, title, `WorkItemTypeChip`, the priority `Pill`,
`Avatar` + name, the hover copy button + `Tooltip`), with ONE addition at its lead:
the **tree toggle slot**, composed from `components/ui/TreeTable.tsx` exactly.

- **Runnable-container row** — a 16px **chevron button** (lucide `ChevronRight`, 12px,
  `text-(--el-text-secondary)`, `rounded-(--radius-control)`; `rotate-90` when open;
  `aria-expanded`; `aria-label` **"Expand {key}"** / **"Collapse {key}"** —
  `ready.container.expand` / `ready.container.collapse`), then the kind icon, key,
  title and meta cluster, which OPENS with the **hint** **"{ready} of {children}
  ready"** (`ready.container.hint`, `text-xs text-(--el-text-secondary)`) —
  `readyLeafCount` of `childCount`. A container has no work type, so no type chip.
  Its **copy** button copies **`motir run <KEY>`** — the parent run — with the tooltip
  **Copy `motir run <KEY>`** and the `aria-label` **"Copy parent-run command for
  {key}"** (`ready.container.copyAria`). **Collapsed by default.** The chevron
  toggles; the rest of the row still opens the peek, as today.
- **Standalone leaf row** — no chevron; the 16px slot is RESERVED (TreeTable's leaf
  slot) so every kind icon in the list aligns. Otherwise exactly today's row,
  including its copy (`motir run` / `motir plan`) or the manual _Show instruction_.
- **Expanded container (panel 2)** — its ready leaves render directly beneath it,
  each a full leaf row indented ONE tree level: **22px** (`TreeTable`'s
  `INDENT_PX`) via `ml-[22px]`. Only the READY leaves are listed; the hint says how
  many children there are in all.
- **A bug with ready subtasks (panel 3)** — the same container row in the Bugs lane;
  a childless bug is a plain leaf row there.

### States

- **(3) The switch on Bugs** — the Bugs lane in the same full-height pane.
- **(4) Ready to run empty, bugs present** — the pane shows ONE line, **"Nothing
  ready to run."** (`ready.lanes.main.empty`, `text-sm text-(--el-text-secondary)`),
  and the switch's **"Bugs 2"** is what says there is still work. Never the
  EmptyState, because the page is not empty.
- **(5) Bugs empty** — with the switch on Bugs, **"No ready bugs."**
  (`ready.lanes.bugs.empty`), the pane still full height.
- **(6) All empty** — today's `EmptyState`, unchanged (panel 3 of `ready.mock.html`),
  with no switch and no chip.
- **(7) Loading** — `PageSkeleton` in an in-page `<Suspense>` below the page gate
  (never a `loading.tsx`): the REAL header and the REAL switch (its counts arrive
  with the data), then pulsing card-height blocks (`--el-muted` on `--radius-card`)
  in the pane.
- **(8) Load-more at scale** — the pane is a virtualized, cursor-streamed list
  (`useRowWindow` measured against the PANE's scroll container, a bottom sentinel
  inside it), one per lane. The load-more cursor is the LANE cursor, which may end a
  page inside a group: the next page's first rows are that group's remaining members
  and they **merge into the rendered group** — never a second header for the same
  container. Expand state is client-local, keyed by container id, and survives a
  load and a switch to the other lane and back. "Loading more…" (`ready.loadingMore`)
  is unchanged.

### Access path

Unchanged: the sidebar **Ready** entry (`nav.ready`, lucide `circle-play`) opens
`/ready` on Ready to run; `/ready?lane=bugs` opens it on Bugs. No filter is added.

### i18n — new keys under `ready.*` (en + zh)

`lanes.switchAria` ("Ready lanes"), `lanes.main.heading` ("Ready to run"),
`lanes.main.empty` ("Nothing ready to run."), `lanes.bugs.heading` ("Bugs"),
`lanes.bugs.empty` ("No ready bugs."), `lanes.bugs.listAria` ("Ready bugs"),
`container.hint` ("{ready} of {total} ready"), `container.expand` ("Expand {key}"),
`container.collapse` ("Collapse {key}"), `container.copyAria` ("Copy parent-run
command for {key}").

### Primitives composed (no hand-rolling)

| Element                      | Shipped primitive                                                      |
| ---------------------------- | ---------------------------------------------------------------------- |
| every row                    | `app/(authed)/ready/_components/ReadyList.tsx` `ReadyRow` (unchanged)  |
| chevron · leaf slot · indent | `components/ui/TreeTable.tsx` (`ChevronRight`, 16px slot, `INDENT_PX`) |
| lane switch                  | `components/ui/Segmented.tsx` + `shallowPush`                          |
| count chip                   | `components/ui/Pill.tsx` (`tone="neutral"`)                            |
| priority chip                | `Pill` via `PriorityValue` (`PRIORITY_META`)                           |
| all-empty                    | `components/ui/EmptyState.tsx` (unchanged)                             |
| loading                      | `components/ui/PageSkeleton.tsx`                                       |
| copy tooltip · confirmation  | `components/ui/Tooltip.tsx` · `components/ui/Toast.tsx`                |
| virtualization               | `components/ui/useRowWindow.ts`                                        |

No new design-system entry. The expand grammar is TreeTable's; the page does not
become a TreeTable — each lane is a list of dispatch cards, which is what the page
already is.

## The expansion nudge hands off to the planning overlay (MOTIR-7875, gating MOTIR-7876)

**Mock:** [`ready--nudge-handoff.mock.html`](ready--nudge-handoff.mock.html), a delta.
It holds only the expansion nudge on `/ready` from **Expand** onwards. It amends the
page drawn in [`ready.mock.html`](ready.mock.html) and § _Layout (panel 1 — the page)_
above. The nudge itself was never drawn in this area. It shipped as
`app/(authed)/ready/_components/ExpansionNudgeBanner.tsx` and
`ExpansionNudgeReview.tsx`, and the drawing is made against that code as `main` ships
it.

**The change.** The banner no longer reviews, approves or declines a plan. When the
plan is ready, it opens the planning overlay, which is the one place a plan is decided.
`ExpansionNudgeReview` (the inline list with Approve/Decline) is retired.
`approvePlanRequest` / `declinePlanRequest` are no longer called from `/ready`.

### Q1, decided: a button, not auto-open (panel 2)

When the plan is ready, the banner **offers _Review the plan_** (`Button`
`variant="primary"` `size="sm"`, `ArrowRight` right icon). It replaces **Expand**, so
the banner never offers to expand twice. It does **not** open the overlay by itself.
The mock draws auto-open beside it as the rejected alternative.

Why:

- An expand runs for minutes. By then the person is working the list under the banner,
  and an overlay that arrives on its own takes the page out from under them in the
  middle of an action.
- The planner already promises the plan will wait for them
  (`design/ai-planning/design-notes.md` §22.6), so nothing is lost by not opening it.
- The button costs one click, on a path the person already chose.

### Q2, decided: one destination, written with `shallowPush` (panel 2, continued)

The href is `planRowDestination` (`lib/planning/planDestination.ts`), with:

| argument     | value                                                                          |
| ------------ | ------------------------------------------------------------------------------ |
| `planStatus` | the polled plan's status                                                       |
| `planId`     | the plan the expand created                                                    |
| `sessionId`  | `review.conversation?.sessionId ?? null`                                       |
| `anchorKey`  | `review.conversation?.targetKeys[0]` (the stub the person expanded)            |
| `host`       | the current `/ready` address, **path and query**, so the lane survives a Close |

An undecided plan with a session resolves to `{ kind: 'planning-surface' }`, whose
href is `withPlanningOverlay(host, { kind: 'work-item', itemKey, sessionId })`. The
path stays `/ready` and only the overlay's parameters are added (`plan`, `planFrom`,
`planItem`, `planSession`). The press writes it with `shallowPush`, so `/ready` stays
mounted under the scrim and Close, Esc or Back return to it unchanged.

The banner has **one** destination. It does not read `reason` and draws no second
door. The overlay is composed as it ships
(`components/planning/PlanningWorkspaceOverlay.tsx`, the design of record in
`design/ai-chat/planning-workspace.mock.html` sheet 6, MOTIR-4726), with the decide
door of `design/ai-planning/design-notes.md` Part XXII. Nothing inside it is changed
by this card.

### The states, one panel each

| panel | state                        | the banner shows                                                                                                                                     |
| ----- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | idle (context, unchanged)    | `nudge.body` + **Expand** (secondary) + ✕                                                                                                            |
| 1     | expanding                    | **Expanding…** (disabled) + NEW `nudge.waitHint`, which links _Waiting on you_. The ✕ stays live.                                                    |
| 2     | the plan is ready            | NEW `nudge.readyBody` + **Review the plan** (primary)                                                                                                |
| 3     | closed the overlay undecided | as panel 2, plus NEW `nudge.stillWaiting`. Pressing again re-opens the same session.                                                                 |
| 4     | decided on the overlay       | **nothing**: the banner renders `null`. The overlay already said what happened, so the shipped `nudge.approved` pill retires with no replacement.    |
| 5     | nothing proposed             | NEW `nudge.nothingProposed` + **Dismiss** (ghost). The plan ended `declined`/`discarded`, or reached `planned` with no items. The poll stops.        |
| 6     | dismissed while expanding    | hidden for the session (the shipped `sessionStorage` key). **The plan is not declined.** It finishes and waits in _Waiting on you_.                  |
| 7     | a failure                    | one sentence in `--el-danger-on-surface`, `role="alert"`, + **Dismiss** (ghost). The retryable ones add **Try again** (secondary), which re-submits. |

Panel 5 fixes a shipped hole: today's poll waits only for proposals, so a plan that
ends with none shows **Expanding…** for ever. The target poll stops on any terminal
plan.

Panel 4: after the decision, the card re-reads the plan once the overlay's parameters
leave the address. The rows do not jump, because the push was shallow.

### Failures: every one a sentence, none a code (panel 7)

No machine code is rendered anywhere. The shipped `nudge.error` ("Something went wrong
(…)") retires.

| what the expand met                                                           | key                                         | retry |
| ----------------------------------------------------------------------------- | ------------------------------------------- | ----- |
| `402` out of credits                                                          | REUSES `aiPlanning.generation.creditsTitle` | no    |
| `403` (AI planning switched off for the org, or `ai:plan` missing)            | `nudge.errors.unavailable`                  | no    |
| `422` `INVALID_TARGET` (not an epic, story, task or bug)                      | `nudge.errors.cannotExpand`                 | no    |
| `502` Motir AI unreachable                                                    | `nudge.errors.unreachable`                  | yes   |
| `429` the `ai:generate` ceiling                                               | `nudge.errors.rateLimited`                  | yes   |
| the plan ended `abandoned` while polling (the job died)                       | `nudge.errors.stopped`                      | yes   |
| `400`, `404`, a response with no plan id, any other status, a network failure | `nudge.errors.generic`                      | yes   |

### Copy — en + zh

Kept as shipped: `body`, `expandLabel`, `expanding`, `dismissAria`, `dismissLabel`,
`emptyHint`. Reused from the catalogue: `aiPlanning.generation.creditsTitle`,
`common.retry` ("Try again" / "重试"). The _Waiting on you_ link text is
`workbench.tabs.toApprove`, and it points at the workbench's approvals tab.

| key (`ready.nudge.*`) | en                                                                                                                               | zh                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `waitHint`            | You don’t have to wait here. Close this whenever you like — the plan will be waiting for you in `<link>`Waiting on you`</link>`. | 你不必在这里等待。随时可以关闭——计划完成后会在`<link>`等你处理`</link>`中等你。 |
| `readyBody`           | Motir proposed {count, plural, one {# change} other {# changes}} for {key}.                                                      | Motir 为 {key} 提议了 {count} 项变更。                                          |
| `reviewLabel`         | Review the plan                                                                                                                  | 查看计划                                                                        |
| `stillWaiting`        | You haven’t decided this plan yet — it is waiting for you in `<link>`Waiting on you`</link>`.                                    | 你还没有决定这个计划——它在`<link>`等你处理`</link>`中等你。                     |
| `nothingProposed`     | Motir didn’t propose any changes for {key}, so there is nothing to review.                                                       | Motir 没有为 {key} 提议任何变更，因此没有需要查看的内容。                       |
| `errors.unavailable`  | Motir AI planning isn’t available to you in this project.                                                                        | 你在此项目中无法使用 Motir AI 规划。                                            |
| `errors.cannotExpand` | {key} can’t be expanded — only an epic, story, task or bug can be.                                                               | {key} 无法展开——只有篇章、故事、任务或缺陷可以展开。                            |
| `errors.unreachable`  | Motir AI couldn’t be reached, so nothing was expanded. Try again in a moment.                                                    | 无法连接 Motir AI，因此没有展开任何内容。请稍后重试。                           |
| `errors.rateLimited`  | You’re starting plans a little too fast. Try again in a moment.                                                                  | 你发起规划的速度有点快。请稍后重试。                                            |
| `errors.stopped`      | Motir AI stopped before it finished planning {key}. Nothing was changed.                                                         | Motir AI 在完成 {key} 的规划前停止了。没有任何更改。                            |
| `errors.generic`      | Something went wrong, so nothing was expanded. Try again in a moment.                                                            | 出了点问题，因此没有展开任何内容。请稍后重试。                                  |

Retired with the inline review: `reviewTitle`, `opChange`, `opRemove`,
`approveLabel`, `approving`, `declineLabel`, `approved`, `error`.

### Tokens and primitives

| element                   | primitive / token                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| banner                    | `Card`, `bg-(--el-tint-lavender) border-(--el-border-soft)` (as shipped)                     |
| sparkles                  | lucide `Sparkles`, `--el-accent-on-surface` (as shipped)                                     |
| body                      | `--el-text-strong` (as shipped)                                                              |
| the ✕                     | icon button, `--spacing-icon-btn`, `--radius-control`; ink `--el-text-secondary` (see below) |
| Review the plan           | `Button` `primary` `sm`                                                                      |
| Try again                 | `Button` `secondary` `sm`                                                                    |
| Dismiss                   | `Button` `ghost` `sm`                                                                        |
| the hint lines            | `text-xs`, `--el-text-secondary`                                                             |
| the _Waiting on you_ link | `--el-text-strong`, underlined, `font-medium`                                                |
| a failure                 | `--el-danger-on-surface`, `role="alert"`                                                     |

Three ink corrections against the shipped banner, all on the lavender tint:

- The ✕ moves from `--el-text-muted` to `--el-text-secondary`. Muted is AA on the
  white page only.
- The in-sentence link does not take `--el-link`, which is about 3.95:1 on the
  lavender tint. It keeps the line's strong ink and is told apart by its underline.
- The shipped Dismiss text link becomes a ghost `Button`, for the same reason.

No new design-system entry and no new token.

### A record that is not edited

`design/ai-planning/design-notes.md` (the row citing `ExpansionNudge{Banner,Review}.tsx`
as the "shipped in-surface AI proposal grammar", and the Approve / Discard row that
mirrors it) is a record of when it was drawn. It is not edited here. From MOTIR-7876 on,
that grammar no longer ships on `/ready`. The pair it describes lives on in the
overlay's decide door.
