# Triage — design notes

Design reference for the `triage` UI area — the **incoming-work front door**
(Story 6.11). The asset is the source of truth for every UI subtask in Story
6.11. Built FROM the real design system (`app/globals.css` `--el-*` colour
tokens + `[data-display-style]` shape tokens + the shipped `components/ui/*`
primitives), so the code subtasks compose the same primitives — no Pencil→code
gap.

| Surface                  | Asset              | Gates                                                         |
| ------------------------ | ------------------ | ------------------------------------------------------------- |
| **Admin triage inbox**   | `triage.mock.html` | **6.11.6** (queue + detail + action bar, paginated)           |
| **In-app report widget** | `triage.mock.html` | **6.11.7** (the authenticated submission modal)               |
| **Public portal form**   | `triage.mock.html` | **6.11.7** (the unauthenticated branded form + result states) |

Both UI code subtasks (6.11.6, 6.11.7) carry `6.11.1` in `dependsOn` and are
`blocked` until this lands.

## The model this UI sits on (6.11.2 / 6.11.3)

A submission **IS a `work_item`** (kind `bug` or `task`) in a **`triage`
state** that excludes it from EVERY normal read — the tree, every board, every
list, the ready set, and search. **The triage inbox is the one read that
returns only triage items.** Promotion is not a copy: it clears the triage
marker and sets parent + backlog rank through the shipped `workItemsService`,
so the SAME item (comments / attachments / history intact) appears in the tree.

The **verified mirror is Linear Triage** (https://linear.app/docs/triage): a
queue + detail layout, with the action set **Accept · Promote · Decline · Mark
duplicate/Merge · Snooze**. This asset mirrors that surface shape and taxonomy.

---

## The asset is multi-panel (review EACH — mistake #31)

1. **(1)** the admin triage inbox — the paginated **queue** (left) + the
   **detail pane** (right) + the **action bar** (sticky footer of the detail).
   One queue row is an external submission, one is snoozed.
1. **(1b)** the **Promote picker** (open) — Backlog / Active sprint / Under an
   epic / Under a story + the position-in-backlog chooser.
1. **(1c)** the **Mark-duplicate / Merge picker** (open) — the canonical-item
   `Combobox`.
1. **(1d)** the **Snooze picker** (open) — the time options.
1. **(2)** the **empty queue** state (`EmptyState`) + the per-action `Toast`s.
1. **(3)** the **in-app report widget** (a `Modal`).
1. **(4)** the **public portal form** (unauthenticated, branded, single column).
1. **(4b)** the public form **confirmation** state.
1. **(4c)** the public form **rate-limit / error** state.

---

## Where it lives

- **Inbox** — a per-project admin route (mirror the established project-settings /
  `/issues` page-header grammar): `app/(authed)/.../triage/page.tsx`, reached from
  the project nav, gated by 6.4 admin permission. The page reads the 6.11.3
  triage-queue read (paginated/cursor'd) and drives the 6.11.5 actions service.
- **In-app widget** — a `Modal` launched from a shell affordance (a "Report"
  button), posting to the authenticated intake endpoint (6.11.4).
- **Public portal form** — a public, unauthenticated route keyed by the
  per-project shareable form token (6.11.4): `app/triage/[formToken]/page.tsx`
  (outside the authed group; no app chrome). It exposes NO tree/project data.

---

## Panel 1 — the inbox (the 6.11.6 surface)

### Page header (mirror `app/(authed)/issues/page.tsx`)

- **Title** — `font-serif text-2xl font-semibold text-(--el-text)` reading
  **"Triage"** (`t('triage.heading')`).
- **Count chip** — a neutral `Pill` (`tone="neutral"`) beside the title:
  **"{n} to triage"** (`t('triage.count', { count })`). Neutral, never coloured
  by urgency — it's the size of the backlog of unhandled intake.
- **Subtitle** — `text-(--el-text-muted) text-sm`: **"{project} · {key} —
  incoming bug reports & feature requests, excluded from the tree until you
  act"**.
- **Header actions** — a `Button variant="outline" size="sm"` **"Public form
  link"** (icon `ExternalLink`) that copies/opens the shareable form URL, and a
  `Button variant="primary" size="sm"` **"Report"** (icon `Bug`) that opens the
  in-app widget (panel 3).

### Layout — a 2-pane split

`grid-template-columns: 380px 1fr` inside a `Card`-bordered container
(`--radius-card`, `--shadow-card`, `border-(--el-border)`). Left = queue, right
= detail. Collapses to a single column under `880px` (mobile: queue list →
tapping a row pushes the detail).

### The queue (left)

- **Queue head** — a `SectionLabel`-style caption **"Queue · newest first"**
  (`text-(--el-text-faint)`, uppercase) + the count.
- **Search** — an `Input`-styled search box **"Search submissions"** (icon
  `Search`, `--radius-input`, `--height-control`). Filters the queue only.
- **Rows** — each row is a NEW arrangement (not a new primitive):
  - **kind glyph** — `IssueTypeIcon` for the work_item kind: `bug` →
    `--el-type-bug`, `task` (feature request) → `--el-type-task`. (Never grey —
    finding #54.)
  - **title** — `text-(--el-text)`, 1–2 lines.
  - **snippet** — one clamped line of the body, `text-(--el-text-muted)`.
  - **submitter** — a **member** shows the initial-letter `Avatar` (the
    issue-cell avatar; tinted bg, `--el-text-strong`) + name; an **external**
    submitter shows the **"External · {email}" chip** instead (see colour roles).
  - **age** — relative time, `text-(--el-text-faint)`.
  - A **snoozed** row shows a lavender **"Snoozed · {day}"** chip and is dimmed
    out of the active set (it returns at its time or on new activity).
  - The **active** row carries an inset accent rail
    (`box-shadow: inset 3px 0 0 var(--el-accent)`) on the page bg.
- **Pagination (finding #57 — NOT a load-all list).** A footer shows **"Showing
  1–{m} of {n}"** + **Newer / Older** pager buttons. The queue is an unbounded
  inbox (a public form can produce many), so the 6.11.3 read is paginated /
  cursor'd and the UI is infinite-scroll or paged — never "load all rows". The
  mock shows page 1 of a 63-item queue to make the scale explicit.

### The detail pane (right)

- **Kind line** — `IssueTypeIcon` + **"Bug report"** / **"Feature request"** +
  the submitted-age.
- **Title** — `font-serif text-xl` (`--el-text`).
- **Attribution card** — a `--el-surface-soft` bordered box: the `Avatar` (lg) +
  the submitter name + a meta line: **"Team member · reported from the in-app
  widget"** for a member, or **"External submitter · {email}"** for a portal
  submission. (External submitters get no tenant access — 6.11.2 §3.)
- **Body** — the full submission `MarkdownView` prose (`text-(--el-text-secondary)`).
- **Attachment(s)** — a `SectionLabel` **"Attachment"** + an attachment chip
  (icon `Paperclip`, `--radius-control`) reusing the 2.3.7 attachment row.
- **Comments** — a `SectionLabel` **"Comments"** + the existing comment-thread
  primitive (avatar + author + timestamp + body). Carries over on promote/merge.

### The action bar (the 6.11.5 taxonomy)

Sticky footer of the detail pane, `border-top`, `bg-(--el-page-bg)`. Buttons,
left→right, with one destructive action pushed to the right:

| Action             | Primitive / variant            | Icon           | Copy             | Behaviour (6.11.5)                                                                  |
| ------------------ | ------------------------------ | -------------- | ---------------- | ----------------------------------------------------------------------------------- |
| **Accept**         | `Button variant="primary"`     | `CheckCheck`   | "Accept"         | → backlog at the team default status (+ optional comment). Clears triage.           |
| **Promote**        | `Button variant="outline"` + ▾ | `ArrowUpRight` | "Promote"        | opens the Promote picker (panel 1b): parent + position via `workItemsService`.      |
| **Mark duplicate** | `Button variant="outline"`     | `GitMerge`     | "Mark duplicate" | opens the canonical-item Combobox (panel 1c): cancel + fold comments/attachments.   |
| **Snooze**         | `Button variant="ghost"`       | `AlarmClock`   | "Snooze"         | opens the Snooze picker (panel 1d): `snoozedUntil`, returns on new activity.        |
| **Decline**        | `Button` **danger-tinted**     | `CircleX`      | "Decline"        | → canceled terminal status (+ optional comment). Leaves the queue. (Right-aligned.) |

> **Destructive styling (finding #35).** Decline carries the danger hue in a
> **`--el-tint-rose` background with `--el-text-strong` text** (clears AA ~10:1)
>
> - the `--el-danger` icon — never `--el-danger` as a text/fill that fails AA on
>   a page surface.

### Panel 1b — the Promote picker

A `Popover` (Radix → `--radius-card` container, `--shadow-elevated`). Header
caption **"Promote into"**. Four targets, each a menu row (`--radius-control`,
hover `--el-surface`) with the matching glyph:

- **Backlog** (`Inbox`) — sub "Unparented, default status".
- **Active sprint** (`Calendar`) — sub names the sprint; chevron → sprint pick.
- **Under an epic** (`IssueTypeIcon epic`, `--el-type-epic`) — chevron → epic pick.
- **Under a story** (`IssueTypeIcon story`, `--el-type-story`) — chevron → story pick.

Then a divider + a **"Position in backlog"** field (a `Combobox`/`Select`:
"Top of backlog" / "Bottom" / "Before…"). The chosen target + position set
`parent` + `backlogRank` via `workItemsService`, honouring the kind-parent
matrix (a `bug`/`task` parents to epic/story/task — `prisma/sql/work_item_triggers.sql`).

> **Radix-portal-in-dialog gotcha.** If the Promote/Merge picker is a popover
> rendered while a modal is open, gate the portal on not-in-`[role=dialog]`
> (the `portal-popover-breaks-in-radix-dialog` rule) — render inline there.

### Panel 1c — the Mark-duplicate / Merge picker

The shipped `Combobox`: a search input (icon `Search`) + option rows, each
**`IssueTypeIcon` + the mono `PROD-{n}` key + the title** (the established
"option name = label + secondary" pattern — mind the E2E selector gotcha). On
select, the submission is canceled, the duplicate-of link is recorded, and its
comments + attachments fold into the canonical item (mirrors Linear). A caption
states this so the admin understands it's destructive-but-recoverable.

### Panel 1d — the Snooze picker

A `Popover` with **"Snooze until"** options: **Tomorrow** / **Next week** (each
with the resolved time, `text-(--el-text-muted)`) / **Pick a date…** (`Calendar`
→ `DatePicker`). A divider + a muted note **"Returns early on new activity"**
(icon `AlarmClock`) — the snooze auto-returns on a comment/edit, whichever comes
first.

### Panel 2 — empty state + toasts

- **Empty** — the shipped `EmptyState`: a `--el-surface` icon circle (`Inbox`,
  `--el-text-faint`), `font-serif` heading **"No items to triage"**, and body
  **"New bug reports and feature requests land here. Share the public form or use
  the in-app 'Report' button to collect them."**
- **Toasts** — the shipped `Toast` (dark `--el-text` bubble, inverted text) for
  each terminal action: **"Promoted to the backlog"** (+ an **Undo** affordance),
  **"Merged into PROD-318"**, **"Snoozed until Monday"**. The success check uses
  `--el-success`.

---

## Panel 3 — the in-app report widget (the 6.11.7 authenticated surface)

A `Modal` (`--radius-modal`, `--shadow-modal`), launched from the shell. Header
**"Report something"** + a close `icon-btn` (`X`). Body:

- **Type toggle** — the shipped `Segmented` (two segments): **"Bug"**
  (`IssueTypeIcon bug`) · **"Feature"** (`IssueTypeIcon task`). Maps to the
  work_item kind (`bug` / `task`).
- **Title** — `FormField` + `Input`, label **"Title"**.
- **Description** — `FormField` + `Textarea`, label **"What happened?"** with an
  optional hint **"— steps, expected vs. actual"** (`--el-text-faint`).
- **Attachment (optional)** — a dashed `--el-border-strong` dropzone reusing the
  2.3.7 upload affordance (icon `Paperclip`, copy "Add a screenshot or file").
- **Footer** — `Button variant="ghost"` **"Cancel"** + `Button variant="primary"`
  **"Submit"** (icon `Send`).

On submit it posts to the authenticated intake endpoint (6.11.4), creating a
triage work_item attributed to the session user, scoped to the active project —
invisible to the tree, visible only in the queue. Confirms with a `Toast`.

---

## Panel 4 — the public portal form (the 6.11.7 unauthenticated surface)

A branded, single-column page on the project's shareable form URL. NO app
chrome, NO tree/project data. Composition:

- **Brand bar** — an accent `--el-accent` top stripe + a workspace logo tile
  (`--el-accent` bg, `--el-accent-text`) + the workspace name. (Read-only brand;
  no nav.)
- **Heading** — `font-serif` **"Report a bug or request a feature"** + a lede
  **"Tell us what's broken or what you'd like to see. We read every
  submission."**
- **Type toggle** — `Segmented`: **"Feature request"** / **"Bug"**.
- **Submitter identity** — two `FormField`s side by side: **"Your name"** +
  **"Email"** (the captured external attribution; stored as `externalSubmitter`,
  no account created).
- **Summary** — `Input`, label **"Summary"**.
- **Details** — `Textarea`, label **"Details"**.
- **Honeypot** — a visually-hidden field the abuse guard checks (6.11.4); noted
  in the markup, not shown.
- **Footer** — a privacy reassurance **"We never share your email"** (icon
  `Shield`, `--el-text-faint`) + a `Button variant="primary" size="lg"` **"Send
  it"** (icon `Send`).

### Panel 4b — confirmation

A centred state card: a `--el-tint-mint` success badge (`CheckCheck`,
`--el-success`), `font-serif` **"Thanks — we got it"**, body **"Your {kind} is
with the {workspace} team. We'll take it from here — no account needed."** No
link back into the app (it's public).

### Panel 4c — rate-limit / error (graceful — never a raw 500)

The form re-rendered with an inline **banner** at the top: a `--el-tint-peach`
box (icon `AlarmClock`, `--el-warning`) + **"You're sending these a little fast.
Please wait a moment and try again — this keeps the form free of spam."** The
submit button is disabled with a countdown label **"Try again in {s}s"** (icon
`Clock`). The same banner grammar carries validation errors (missing
email/summary). The throttle/honeypot fire as a typed error → this state, not a
crash (6.11.4 AC).

---

## Colour roles (every colour via `--el-*` — no Tier-0 `--color-*`)

| Element                          | Token                                                                | Note                                                      |
| -------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------- |
| bug kind glyph                   | `--el-type-bug`                                                      | via `IssueTypeIcon` (finding #54 — never grey)            |
| feature/task kind glyph          | `--el-type-task`                                                     | via `IssueTypeIcon`                                       |
| epic / story target glyphs       | `--el-type-epic` / `--el-type-story`                                 | promote picker                                            |
| **"External" submitter chip**    | bg `--el-tint-peach` · text `--el-text-strong`                       | warm, distinct from the kind hues; AA ~10:1 (finding #35) |
| **Snoozed chip**                 | bg `--el-tint-lavender` · text `--el-text-strong`                    | AA ~10:1                                                  |
| **Decline (destructive)**        | bg `--el-tint-rose` · text `--el-text-strong` · icon `--el-danger`   | tint-bg, not a failing solid fill (finding #35)           |
| Accept / primary CTAs            | `--el-accent` · `--el-accent-text`                                   | Button primary                                            |
| active queue row rail            | `--el-accent`                                                        | `inset 3px 0 0`                                           |
| confirmation success badge       | bg `--el-tint-mint` · icon `--el-success`                            |                                                           |
| rate-limit banner                | bg `--el-tint-peach` · icon `--el-warning` · text `--el-text-strong` |                                                           |
| member avatar tints              | `--el-tint-mint/sky/lavender` · `--el-text-strong`                   | the issue-cell name-hash avatar                           |
| body / secondary / muted / faint | `--el-text` / `-secondary` / `-muted` / `-faint`                     | per the standard text scale                               |
| Toast bubble                     | bg `--el-text` · text `--el-text-inverted`                           | the shipped `Toast`                                       |

## Shape roles (every shaped surface via the `[data-display-style]` tokens)

`--radius-card` (panes, popovers, banners, state cards), `--radius-modal` (the
widget), `--radius-input` (inputs, search, dropzone), `--radius-control` (menu
rows, attachment chip, icon buttons), `--radius-badge` (pills/chips),
`--radius-btn` (buttons); `--spacing-card-padding`, `--spacing-input-*`,
`--spacing-control-*`, `--spacing-icon-btn`, `--spacing-chip-*`; `--height-btn-*`,
`--height-input`, `--height-control`; `--shadow-subtle/card/elevated/modal`.
`rounded-full` only for avatars + the success/icon circles. No raw `rounded-md`
/ `p-2` / `h-9` on a control's own box, no Tier-0 `--radius-sm`/`--spacing-md`.

## Copy index (the strings 6.11.6 / 6.11.7 wire to i18n)

- Inbox: "Triage" · "{n} to triage" · "Queue · newest first" · "Search
  submissions" · "Showing 1–{m} of {n}" · "Newer" / "Older" · "Public form link"
  · "Report".
- Detail meta: "Bug report" / "Feature request" · "Team member · reported from
  the in-app widget" · "External submitter · {email}" · "Attachment" ·
  "Comments".
- Actions: "Accept" · "Promote" → "Promote into" / "Backlog" / "Active sprint" /
  "Under an epic" / "Under a story" / "Position in backlog" · "Mark duplicate" ·
  "Snooze" → "Snooze until" / "Tomorrow" / "Next week" / "Pick a date…" /
  "Returns early on new activity" · "Decline".
- Empty: "No items to triage" + the body line above.
- Toasts: "Promoted to the backlog" / "Undo" · "Merged into {key}" · "Snoozed
  until {day}".
- Widget: "Report something" · "Bug" / "Feature" · "Title" · "What happened?" ·
  "Add a screenshot or file" · "Cancel" / "Submit".
- Public form: "Report a bug or request a feature" · the lede · "Feature
  request" / "Bug" · "Your name" / "Email" / "Summary" / "Details" · "We never
  share your email" · "Send it".
- Confirmation: "Thanks — we got it" + the body line.
- Rate-limit: "You're sending these a little fast. Please wait a moment and try
  again — this keeps the form free of spam." · "Try again in {s}s".

## Context refs

- `scripts/plan-seed/data/story-6.11.ts` — the story + 6.11.1 card + the locked
  model.
- `scripts/plan-seed/data/story-7.0.ts` § 7.0.1 + `design/ready/` — the
  multi-panel design-card shape this mirrors.
- Linear Triage — https://linear.app/docs/triage (the verified mirror).
- `components/ui/*` (`Modal`, `Combobox`, `Popover`, `Segmented`, `FormField`,
  `Input`, `Textarea`, `EmptyState`, `Toast`, `Pill`, `Button`, `DatePicker`),
  `components/issues/IssueTypeIcon.tsx`, `app/globals.css` (the `--el-*` +
  `[data-display-style]` token layers), `motir-core/CLAUDE.md` § colour + shape
  tokens.
