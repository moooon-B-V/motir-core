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

## Expand starts a planning conversation (MOTIR-7875, gating MOTIR-7973 / MOTIR-7876)

**Mock:** [`ready--nudge-expand-plans.mock.html`](ready--nudge-expand-plans.mock.html) — a
delta on [`ready.mock.html`](ready.mock.html) and the lanes delta
[`ready--lanes.mock.html`](ready--lanes.mock.html) (§ _Lanes_ above). It holds only the
expansion nudge's **Expand** and what that press opens.

**What changes.** Today the nudge
(`app/(authed)/ready/_components/ExpansionNudgeBanner.tsx`) submits a background expand
job, polls it, and reviews, approves and declines the plan inside the banner. That
whole machine goes. **Expand now opens the planning overlay over `/ready` at once**, on
a session anchored on the stub, with **"Plan <KEY>" already sent as the person's first
turn**. The planner starts in its conversation phase, so a thin stub is asked what to
plan. Approve and decline happen on the overlay only, through its shipped decide door
and approve progress, which this design does not draw or change.

This replaces the hand-off design that was sent back on 2026-10-09 (evidence
`cmv0dxxjq00jdhvoi327iduxr`). Its mock and section are deleted from this area.

### Rail framing — decided: no new chip, lead or card

The launch reuses the **shipped contextual work-item framing** unchanged: the
`in context` mode chip (`planningWorkspace.mode.contextual`), the lead _Opened in the
context of MOT-9._ (`planningWorkspace.lead.contextualItem`) and the opener bubble
(`planningWorkspace.conversation.opener`). Nothing new is added on the rail.

The reason: the pick launch needs its _Follow-up to a choice_ card because its first
turn quotes a choice the person made somewhere else, and the rail has to say where that
came from. Here the first turn is **"Plan MOT-9"** and the item is the one the overlay
already names in its bar, chip and lead. A further line would only repeat it.

### The canvas — the existing one, arriving inside the stub

The overlay's left pane is **the shipped planning canvas, unchanged**. This design adds
nothing to it.

- **What it is.** With no plan yet, the pane is `PlanChangeCanvas`, the shipped
  `ProjectRoadmapCanvas` consumer that `PlanningWorkspaceHost` mounts.
- **Where it stands.** It follows the arrival rule of
  [`design/ai-chat/planning-workspace--arrival.mock.html`](../ai-chat/planning-workspace--arrival.mock.html)
  (`design/ai-chat/design-notes.md` § _The canvas ARRIVES INSIDE the node being planned_,
  MOTIR-6159). A stub is an epic, story, task or bug, so its arrival trail is
  `ancestors ++ [stub]`, and the canvas opens **inside MOT-9**.
- **How the target shows.** The breadcrumb is
  _Roadmap › MOT-2 · … › ◎ MOT-9 · …_. Its last crumb is the shipped **target crumb**:
  the `target` glyph in `--el-accent-on-surface`, the 2px `--el-accent` underline and the
  `planningWorkspace.arrival.crumbTargetPrefix` screen-reader prefix.
- **What fills the level.** A stub has no children, so the level shows the canvas's own
  `roadmap.canvas.emptyDrilled` statement, _No items at this level_. That is where the
  planner's proposed cards land.
- **After a proposal.** Once the planner proposes, the host swaps the pane to the
  shipped proposed-plan views (`PlanProposalViews`), exactly as for any other planning
  session.

So the connection to the existing canvas is the `planItem` anchor. The Expand launch
passes the stub as that anchor, which every work-item launch already does, and the canvas
arrives where it always arrives for one. The exit bar is drawn as sheet 6 and the arrival
mock draw it: **Close** with its `Esc` key hint, then the project name.

### States

| #   | state                | what it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | banner, idle         | The shipped nudge (lavender `Card`, `Sparkles` in `--el-accent-on-surface`, ✕ icon button, `Button` secondary sm **Expand**). Body unchanged. NEW: one line under the button, `ready.nudge.expandHint`, in `--el-text-secondary` on the tint. **The banner has no post-Expand state**: no _Expanding…_, no spinner, no error line, no review.                                                                                                                                           |
| 2   | overlay, just opened | The press `shallowPush`es `withPlanningOverlay`'s `work-item` launch on the stub with the start-turn flag, over the current `/ready` address (path and query, so the lane survives and Close returns to it). The rail shows the framing above, then **"Plan MOT-9"** as a user bubble, the _Sent to Motir AI_ marker, the first act and the running bar with **Stop**. The composer is empty. Drawn the way MOTIR-6432 draws a sent first turn. The canvas stands inside MOT-9 (above). |
| 3   | thin stub            | The planner's first reply is a question about what to plan. **Its words are illustrative.** The rail is in the shipped answer-awaiting state: no running bar, the _Waiting for your answer_ strip over the composer, placeholder _Answer Motir AI…_.                                                                                                                                                                                                                                    |
| 4   | resumed              | Expand on a stub that has a recent open session opens **that** session's transcript and **sends nothing new**: no second "Plan MOT-9", no new marker. A reload or Back/forward onto panel 2's address behaves the same. The first turn is sent once per session, keyed on the server's session answer, never on the address.                                                                                                                                                            |
| 5   | send failed          | Any refusal of the first send. The rail's **ordinary** send error, composed as it ships: the rose `role="alert"` line (`planningWorkspace.conversation.error.body`) and **Try again** (`…conversation.retry`). The unsent **"Plan MOT-9"** stays in the composer with Send live. No new failure copy, nothing logged as sent, and the `/ready` banner is not involved.                                                                                                                  |

The address flag is drawn as `planStart=1` for illustration only. Its real name, and
how it is cleared once the session answers, belong to MOTIR-7973.

### Copy — en + zh

New keys. `{key}` is the only interpolation in each.

| key                                | en                                                                        | zh                                                          |
| ---------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `ready.nudge.expandHint`           | Opens Motir AI planning on {key}. It may ask what you want planned first. | 将在 {key} 上打开 Motir AI 规划。它可能会先问你想规划什么。 |
| `planningWorkspace.startTurn.plan` | Plan {key}                                                                | 规划 {key}                                                  |

`planningWorkspace.startTurn.plan` is the first turn MOTIR-7973 composes from the
catalogue and sends. It is the person's words in the transcript, in the person's locale.

Kept and still rendered: `ready.nudge.body`, `ready.nudge.expandLabel`,
`ready.nudge.dismissAria`, `ready.nudge.dismissLabel` and `ready.nudge.emptyHint`.
Everything on the rail reuses shipped `planningWorkspace.*` keys
(`mode.contextual`, `lead.contextualItem`, `conversation.opener`,
`conversation.submitted`, `conversation.composerPlaceholder`,
`conversation.composerPlaceholderAnswer`, `conversation.awaitingAnswer`,
`conversation.retry`, `conversation.error.body`).

### Retired keys

MOTIR-7876 deletes these from `messages/en.json` and `messages/zh.json`, because nothing
renders them once the banner stops making a plan:

`ready.nudge.expanding` · `ready.nudge.reviewTitle` · `ready.nudge.opChange` ·
`ready.nudge.opRemove` · `ready.nudge.approveLabel` · `ready.nudge.approving` ·
`ready.nudge.declineLabel` · `ready.nudge.approved` · `ready.nudge.error`

### Not changed

- The row at `design/ai-planning/design-notes.md:326` that names
  `ExpansionNudge{Banner,Review}.tsx` as the shipped in-surface proposal grammar is a
  record and is not edited. **That grammar no longer ships on `/ready`.**
- The overlay's decide door, close guard and approve progress; `planRowDestination`;
  `/ready`'s rows, lanes, facets and nomination.
- What the planner asks in its conversation phase. Panel 3's words are illustrative.

### Tokens

Banner: `--el-tint-lavender` · `--el-border-soft` · `--el-accent-on-surface` (glyph) ·
`--el-text-strong` (body) · `--el-text-secondary` (hint, on the tint) · `--radius-card` ·
`--spacing-card-padding` · `--spacing-icon-btn` / `--radius-control` (✕) ·
`--height-btn-sm` / `--spacing-btn-x-sm` / `--radius-btn` (Expand). Rail, as shipped:
`--el-chat-bubble-ai` / `--el-text` · `--el-chat-bubble-user` / `--el-accent-text` ·
`--el-surface-soft` with `--el-text-secondary` (acts) · `--el-warning-surface` /
`--el-warning-text` (awaiting) · `--el-tint-rose` / `--el-text-strong` (error) ·
`--el-chip-bg` / `--el-chip-border` (chip) · `--el-input-border` / `--radius-input` /
`--height-input` (composer).
