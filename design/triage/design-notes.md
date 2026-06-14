# Triage — design notes

Design reference for the `triage` UI area — the **incoming-work front door**
(Story 6.11). The asset is the source of truth for every UI subtask in Story
6.11. Built FROM the real design system (`app/globals.css` `--el-*` colour
tokens + `[data-display-style]` shape tokens + the shipped `components/ui/*`
primitives), so the code subtasks compose the same primitives — no Pencil→code
gap.

> **⚠️ Model revision (Yue, 2026-06-14).** A work item can be **created only by a
> signed-in account** — so the earlier **unauthenticated public portal form**
> (captured name/email, no account) is **dropped**. Triage intake is now two
> signed-in surfaces: the **in-app "Report" widget** for a workspace member, and
> the **6.12 public-project "Submit a request"** for a signed-in viewer who is
> **not** a workspace member — both post into this same triage queue
> (`canSubmitToTriage`, sign-in-to-act; the 6.12 path is designed in
> `design/public-projects/`). The queue still distinguishes a **team member**
> from a **public (non-member) submitter**, but BOTH now carry a real
> `submittedByUserId`, so the captured-external `externalSubmitter` name/email
> fields and the public form's honeypot / rate-limit / confirmation states are
> removed. This mirrors the 6.12 sign-in-to-act revision.

| Surface                  | Asset              | Gates                                               |
| ------------------------ | ------------------ | --------------------------------------------------- |
| **Admin triage inbox**   | `triage.mock.html` | **6.11.6** (queue + detail + action bar, paginated) |
| **In-app report widget** | `triage.mock.html` | **6.11.7** (the authenticated submission modal)     |

The external-intake surface lives in Story 6.12 (the public-project **"Submit a
request"** form, signed-in), not here — see `design/public-projects/`.

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
   One queue row is a **public (non-member) submission**, one is snoozed.
1. **(1b)** the **Promote picker** (open) — Backlog / Active sprint / Under an
   epic / Under a story + the position-in-backlog chooser.
1. **(1c)** the **Mark-duplicate / Merge picker** (open) — the canonical-item
   `Combobox`.
1. **(1d)** the **Snooze picker** (open) — the time options.
1. **(2)** the **empty queue** state (`EmptyState`) + the per-action `Toast`s.
1. **(3)** the **in-app report widget** (a `Modal`, signed-in member).

---

## Where it lives

- **Inbox** — a per-project admin route (mirror the established project-settings /
  `/issues` page-header grammar): `app/(authed)/.../triage/page.tsx`, reached from
  the project nav, gated by 6.4 admin permission. The page reads the 6.11.3
  triage-queue read (paginated/cursor'd) and drives the 6.11.5 actions service.
- **In-app widget** — a `Modal` launched from a shell affordance (a "Report"
  button), posting to the authenticated intake endpoint (6.11.4) as the session
  member.
- **Public-project submit** — the external-intake channel is the signed-in
  **"Submit a request"** form on a public project page (Story 6.12,
  `design/public-projects/`); it posts into THIS triage queue via the
  `canSubmitToTriage` grant. It is not a surface of this story — 6.11 owns the
  in-app widget and the inbox.

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
- **Header actions** — a `Button variant="primary" size="sm"` **"Report"** (icon
  `Bug`) that opens the in-app widget (panel 3). (No "public form link" — the
  external-intake surface is the 6.12 public-project page, reached from there.)

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
  - **submitter** — a **team member** shows the initial-letter `Avatar` (the
    issue-cell avatar; tinted bg, `--el-text-strong`) + name; a **public**
    submitter (a signed-in viewer who is not a workspace member, via the 6.12
    submit) shows the `Avatar` + name + a **"Public" chip** (see colour roles).
  - **age** — relative time, `text-(--el-text-faint)`.
  - A **snoozed** row shows a lavender **"Snoozed · {day}"** chip and is dimmed
    out of the active set (it returns at its time or on new activity).
  - The **active** row carries an inset accent rail
    (`box-shadow: inset 3px 0 0 var(--el-accent)`) on the page bg.
- **Pagination (finding #57 — NOT a load-all list).** A footer shows **"Showing
  1–{m} of {n}"** + **Newer / Older** pager buttons. The queue is an unbounded
  inbox (the 6.12 public submit channel can produce many), so the 6.11.3 read is paginated /
  cursor'd and the UI is infinite-scroll or paged — never "load all rows". The
  mock shows page 1 of a 63-item queue to make the scale explicit.

### The detail pane (right)

- **Kind line** — `IssueTypeIcon` + **"Bug report"** / **"Feature request"** +
  the submitted-age.
- **Title** — `font-serif text-xl` (`--el-text`).
- **Attribution card** — a `--el-surface-soft` bordered box: the `Avatar` (lg) +
  the submitter name + a meta line: **"Team member · reported from the in-app
  widget"** for a member, or **"Public submitter · {name}"** for a signed-in
  non-member who submitted from the 6.12 public project page. (A public submitter
  is a real account but gets no tenant access — 6.11.2 §3 / 6.12.)
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
  **"New bug reports and feature requests land here — from the in-app 'Report'
  button or a signed-in 'Submit a request' on the public project page."**
- **Toasts** — the shipped `Toast` (dark `--el-text` bubble, inverted text) for
  each terminal action: **"Promoted to the backlog"** (+ an **Undo** affordance),
  **"Merged into PROD-318"**, **"Snoozed until Monday"**. The success check uses
  `--el-success`.

---

## Panel 3 — the in-app report widget (the 6.11.7 surface — signed-in member)

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

> **The external-intake surface is NOT in this story.** A non-member submits
> through the signed-in **"Submit a request"** form on a public project page
> (Story 6.12, designed in `design/public-projects/`), which posts into this
> same triage queue via the `canSubmitToTriage` grant. There is no
> unauthenticated public portal form, captured name/email, honeypot, or
> per-form-token route in 6.11 (Yue, 2026-06-14 — a work item is created only
> by a signed-in account). The inbox simply receives those signed-in
> non-member submissions and renders them with the **"Public" chip**.

---

## Colour roles (every colour via `--el-*` — no Tier-0 `--color-*`)

| Element                          | Token                                                              | Note                                                      |
| -------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| bug kind glyph                   | `--el-type-bug`                                                    | via `IssueTypeIcon` (finding #54 — never grey)            |
| feature/task kind glyph          | `--el-type-task`                                                   | via `IssueTypeIcon`                                       |
| epic / story target glyphs       | `--el-type-epic` / `--el-type-story`                               | promote picker                                            |
| **"Public" submitter chip**      | bg `--el-tint-peach` · text `--el-text-strong`                     | warm, distinct from the kind hues; AA ~10:1 (finding #35) |
| **Snoozed chip**                 | bg `--el-tint-lavender` · text `--el-text-strong`                  | AA ~10:1                                                  |
| **Decline (destructive)**        | bg `--el-tint-rose` · text `--el-text-strong` · icon `--el-danger` | tint-bg, not a failing solid fill (finding #35)           |
| Accept / primary CTAs            | `--el-accent` · `--el-accent-text`                                 | Button primary                                            |
| active queue row rail            | `--el-accent`                                                      | `inset 3px 0 0`                                           |
| member/public avatar tints       | `--el-tint-mint/sky/lavender` · `--el-text-strong`                 | the issue-cell name-hash avatar                           |
| body / secondary / muted / faint | `--el-text` / `-secondary` / `-muted` / `-faint`                   | per the standard text scale                               |
| Toast bubble                     | bg `--el-text` · text `--el-text-inverted`                         | the shipped `Toast`                                       |

## Shape roles (every shaped surface via the `[data-display-style]` tokens)

`--radius-card` (panes, popovers), `--radius-modal` (the
widget), `--radius-input` (inputs, search, dropzone), `--radius-control` (menu
rows, attachment chip, icon buttons), `--radius-badge` (pills/chips),
`--radius-btn` (buttons); `--spacing-card-padding`, `--spacing-input-*`,
`--spacing-control-*`, `--spacing-icon-btn`, `--spacing-chip-*`; `--height-btn-*`,
`--height-input`, `--height-control`; `--shadow-subtle/card/elevated/modal`.
`rounded-full` only for avatars + the success/icon circles. No raw `rounded-md`
/ `p-2` / `h-9` on a control's own box, no Tier-0 `--radius-sm`/`--spacing-md`.

## Copy index (the strings 6.11.6 / 6.11.7 wire to i18n)

- Inbox: "Triage" · "{n} to triage" · "Queue · newest first" · "Search
  submissions" · "Showing 1–{m} of {n}" · "Newer" / "Older" · "Report".
- Detail meta: "Bug report" / "Feature request" · "Team member · reported from
  the in-app widget" · "Public submitter · {name}" · "Attachment" · "Comments".
- Actions: "Accept" · "Promote" → "Promote into" / "Backlog" / "Active sprint" /
  "Under an epic" / "Under a story" / "Position in backlog" · "Mark duplicate" ·
  "Snooze" → "Snooze until" / "Tomorrow" / "Next week" / "Pick a date…" /
  "Returns early on new activity" · "Decline".
- Empty: "No items to triage" + the body line above.
- Toasts: "Promoted to the backlog" / "Undo" · "Merged into {key}" · "Snoozed
  until {day}".
- Widget: "Report something" · "Bug" / "Feature" · "Title" · "What happened?" ·
  "Add a screenshot or file" · "Cancel" / "Submit".

(The external "Submit a request" form copy — its heading, fields, confirmation,
and rate-limit states — lives in `design/public-projects/design-notes.md`, since
that signed-in surface belongs to Story 6.12.)

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
