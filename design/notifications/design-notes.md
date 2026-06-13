# Notifications — design notes

Design reference for the `notifications` UI area (Story 5.7 — in-app
notifications). Each surface names the design asset it lives in, the primitives
it composes from, copy strings, placement, and the decisions a code subtask
must honour. Produced by **Subtask 5.7.1** (the design subtask that gates the
UI code subtasks **5.7.5** the bell + drawer and **5.7.6** the preferences
page).

Every asset is an HTML mockup built FROM the shipped design system
(`components/ui/*` primitives' markup + the `app/globals.css` `--el-*` colour
tokens + the element-semantic shape tokens), so there is no Pencil→code gap —
the reviewer and the code subtask see the same tokens. Tokens are copied 1:1
from `app/globals.css`; colour flows only through Tier-3 `--el-*`, shape only
through the element-semantic radius / spacing / sizing / shadow tokens. Toggle
dark in any mockup for theme parity.

| Surface                                     | Asset                            | Notes                                                                                                                                                                      |
| ------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Header notification bell + unread badge** | `bell.mock.html` + `.png`        | The shell-header bell + the unread/_seen_ count pill. Gates 5.7.5. `design/shell/desktop.pen` draws the TopNav but no bell. See below.                                     |
| **Notification drawer / feed**              | `drawer.mock.html` + `.png`      | The header-anchored popover the bell opens: Direct/Watching split, per-row read state, mark-all, cursor-paged feed. Gates 5.7.5. See below.                                |
| **Notification preferences (settings)**     | `preferences.mock.html` + `.png` | The per-user × event-type × channel matrix on `/settings/account` — the channel gate both the in-app job (5.7.3) and the email job (5.1.6) honour. Gates 5.7.6. See below. |

**Mirror-product anchor (decision-ladder rung 1, verified at plan time in the
5.7 story module — Atlassian + Linear sources, not memory):** the Jira Cloud
header notification bell + drawer (Direct/Watching split, unread blue-dot,
"Mark all as read" in the overflow) and the Jira _Personal settings →
Notification settings_ page; Linear's Inbox is the feed-model cross-check
(per-row read state, a per-row toggle, keyboard-navigable, deep-link on open).
Motir mirrors the _model_ at Jira's _altitude_ — a header bell + popover, not a
separate Inbox route.

---

## Notification bell + unread badge (Story 5.7 · 5.7.1 → 5.7.5)

`design/shell/desktop.pen` draws the TopNav (workspace switcher · Create ·
Search · theme · user menu) but **no bell and no badge** — whole elements no
design specifies, so this mockup (`bell.mock.html`) is the design asset. Code
subtask 5.7.5 composes the same primitives.

### Placement

The bell mounts in **`TopNav`'s right cluster**, between the `ThemeToggle` and
the `UserMenu` (`app/(authed)/_components/TopNav.tsx`). On the collapsed
desktop rail and inside the off-canvas mobile `SidebarDrawer` it renders
icon-only, beside the project-context affordance `SidebarHeader` already owns
(panel 2).

### Anatomy

- **The bell** is an **`IconButton`** — the same affordance the Search / theme
  controls use: `rounded-(--radius-control)` + `p-(--spacing-icon-btn)`, text
  `--el-text-muted`, hover lifts to `--el-text` over an `--el-surface` wash.
  The 20px lucide `Bell` glyph. The open (drawer-anchored) state shows the
  pressed `--el-surface` background.
- **The count pill** (the "badge") is anchored top-right of the bell in the
  `Pill`/`Badge` grammar: `--radius-badge` + the small chip padding,
  **`--el-accent` fill with `--el-accent-text`** (white), `min-width: 16px`,
  10px/700 text, and a 2px `--el-page-bg` ring so it reads on the header
  surface. **Decision — accent, not danger.** A "you have N new" count is not
  an error, so the fill is the brand accent (purple), NOT `--el-danger` red;
  accent is on-brand, AA in both themes (white on purple), and avoids the
  finding-#54 grey-everything trap.

### Badge states (panel 1)

- **Zero** → no pill at all.
- **1–99** → the count (e.g. `3`).
- **99+** → capped at `99+` (the Jira/GitHub cap).
- **Open** → the badge is **cleared** (the bell shows its pressed state).

### The seen-vs-read distinction (load-bearing)

The badge counts **NEW notifications since the drawer was last opened**; opening
the drawer marks them **seen** and the badge clears (the Jira "seen-since-open"
rule). This is **distinct from per-row `read` state** (the blue-dot in the
drawer): a row can still be unread (its dot showing) _after_ the badge has
cleared. The schema (5.7.2) and services (5.7.4) model BOTH — a cheap indexed
unread-count aggregate for the badge, and a per-row `readAt` for the dot +
mark-read. The accessible name carries the live count
(`"Notifications, 3 unread"`) so the number is announced, not colour-only.

### Copy

- Bell accessible name: `Notifications, {n} unread` (`Notifications, no unread`
  at zero).
- Badge cap: `99+`.

---

## Notification drawer / feed (Story 5.7 · 5.7.1 → 5.7.5)

`drawer.mock.html` is the header-anchored popover the bell opens (a sheet on
mobile). Code subtask 5.7.5 composes the same primitives on the 5.7.4 read/mark
API.

### Container + header

A **`Popover`** container — `--radius-card`, `--shadow-elevated`, hairline
`--el-border`, ~384px wide, `align="end"` under the bell. The header row = the
**"Notifications"** title (`--el-text`, 15px/600) + the **overflow** three-dots
`IconButton`. Below it a **`Segmented`** control: **Direct** (default, carries
the unread count) | **Watching**.

### Direct vs Watching (the 5.4 seam)

**Direct** = the actions involving you (mentioned · assigned · reporter — the
"mentions first" set), shipped in 5.7. **Watching** is drawn **disabled** (the
`is-disabled` segment grammar 2.5.3 used for the view-switcher seam, with a
`title` tooltip) because issue-watching's `work-item/transitioned` event is
**Story 5.4's**; the 5.7.3 fan-in consumer is built to populate it with **no
5.7 change**.

### Notification row anatomy

Each row is a horizontal flex:

- **Leading unread dot** — an 8px `--el-accent` dot (Jira's "blue-dot"; Motir
  uses one accent unread signal shared with the badge). On a read row the dot
  is transparent (the gutter is preserved so rows align).
- **Avatar + event-type glyph** — the initial-letter `Avatar` (30px, `--el-text`
  fill, `--el-text-inverted` letter) with a small **event-type glyph** badge at
  its bottom-right taking the **event's hue** (finding #54: the palette, not
  grey): mention → `--el-accent` + `@`, comment → `--el-type-task` + message,
  assigned → `--el-type-story` + user-check, transitioned → `--el-type-subtask`
  - pull-request. White glyph on the hue fill, a `--el-page-bg` ring.
- **Body** — line 1 = the one-line summary (actor + action + issue key, actor &
  key in `--el-text-strong`) with the **relative time** pushed right (absolute
  on hover/`title`); line 2 = the denormalized excerpt, single-line truncated.
- **Read treatment** — read rows persist in the feed (NOT purged): greyed via
  `--el-text-muted`/`--el-text-faint`, no dot. Unread rows take a faint
  `--el-surface-soft` wash.

**Clickable target + the no-nested-interactive rule.** The whole row is ONE
clickable deep-link to `/issues/[key]`. The per-row hover **mark-read toggle**
(the Linear `U` model) is a **SIBLING control overlaid top-right — NOT nested
inside the link** (the nested-interactive / portal-popover lessons): in markup
the `<a class="n-row">` and the `<button class="n-toggle">` are siblings under a
`position: relative` wrapper. Clicking the row body also marks it read.

### Overflow menu (panel 3)

The three-dots opens the `IssueViewSwitcher` overflow-menu vocabulary
(`--radius-card` + `--shadow-elevated` container, `--radius-control` rows):

- **Mark all as read** (check-check glyph) — a **single server operation** over
  the caller's whole unread set (a bulk `updateMany` in 5.7.4), NOT a client
  loop over rendered rows (that loop is the JRACLOUD-85017 bug where reload
  re-shows the dots). After it runs every dot clears and the count returns 0
  **from the mutation response** (no whole-tree refresh — the
  inline-edit-no-tree-refresh memory).
- **Notification settings** (gear glyph) — deep-links to `/settings/account` →
  Notifications (`preferences.mock.html`).

### Feed states (panel 4) + scale (panel 5)

- **Loading** → the `BacklogSkeleton` pulse (avatar circle + two `--el-muted`
  lines per row).
- **Empty** → the inbox glyph + **"You're all caught up"** / "No notifications
  yet. Mentions, comments, and assignments will land here." — inviting, never
  blank.
- **Error** → the `ErrorState` alert glyph + **"Couldn't load notifications"** +
  a **"Try again"** `Button variant="secondary"`, `role="alert"`.
- **Scale (finding #57)** → the feed is **cursor-paginated** — newest 20, body
  scrolls within a bounded max-height, **"Show more (N older)"** at the older
  edge pages the next window. Never a load-all; the badge count is the cheap
  indexed unread aggregate (5.7.2's partial index).

### Copy

- Title: `Notifications`. Tabs: `Direct` · `Watching`. Overflow: `Mark all as
read` · `Notification settings`. Older edge: `Show more` / `Show more (N
older)`. Empty: `You're all caught up` / `No notifications yet. Mentions,
comments, and assignments will land here.` Error: `Couldn't load
notifications` / `Something went wrong fetching your feed.` / `Try again`.
- Row summaries: `{Actor} mentioned you on {KEY}` · `{Actor} commented on
{KEY}` · `{Actor} assigned you {KEY}` (· later: `{Actor} moved {KEY} to
{Status}` for the Watching/transitioned event).

### A11y

The bell is a labelled button announcing the count; the drawer is a
keyboard-navigable feed/list; read state is conveyed as text + dot, not colour
alone; focus returns to the bell on close; **no nested interactive elements
inside a row** (the toggle is a sibling). The strict axe sweep covers the
header with the drawer open.

---

## Notification preferences (Story 5.7 · 5.7.1 → 5.7.6)

`preferences.mock.html` is the per-user notification-preferences section. Code
subtask 5.7.6 composes the same primitives + the `NotificationPreference` model
behind it.

### Placement

A **`Card`** (the `ContentSectionCard` `<h2>`-header grammar `LanguageCard` /
`NameCard` use) on the existing **`/settings/account`** personal-settings area,
beside the Language card.

### The matrix

A grid: **rows = event types**, **columns = the two channels (Email · In-app)**,
each cell a **`Switch`** (`role="switch"`, `--el-accent` track on, `--el-muted`

- `--el-border-strong` off, the `--el-surface` knob with `--shadow-subtle`).
  Column header labels (`EVENT` · `EMAIL` · `IN-APP`) in the faint uppercase
  mono-label grammar over an `--el-border` rule; rows divided by `--el-border-soft`.

Event rows (the Jira personal-notification-settings set, generalized):

- **Mentioned** — "Someone @-mentions you in a comment or description."
- **Commented on an item you're involved in** — "A new comment on an item you
  reported, are assigned, or commented on."
- **Assigned to you** — "An item is assigned to you."
- **An item you're watching changes status** `[Soon]` — drawn **disabled** (the
  Story 5.4 seam, the same seam the drawer's Watching tab draws). "Available
  once issue-watching ships (Story 5.4)." The `Soon` tag is a `--radius-badge`
  pill in `--el-tint-lavender` + `--el-text-strong` (AA-safe — hue in the tint
  bg, strong text, finding #35).

### Defaults (annotated)

Direct events — mentions, comments on your items, and assignments — **default
on for both channels**. An untouched row uses that default: **the resolver
supplies it (an unset row is NOT "off")**, so the matrix already reflects
"direct events on" without writing a `NotificationPreference` row. Recorded in
the footnote under the matrix.

### The channel gate (load-bearing)

The resolved preference is the **single channel gate** consulted by BOTH the
**5.7.3 in-app job** (`in_app` channel) AND the **DONE 5.1.6 email job**
(`email` channel) — 5.7.6 wires the gate at the email job's _send decision_,
touching no emit site (the event still fires once). Toggling **in-app off**
stops the bell row; toggling **email off** stops the mail — both off the same
matrix.

### Inline status (panel 1) — success IS confirmation

Each toggle is an inline mutation through a Server Action. The **success
response IS the confirmation** — the switch stays where the user put it, with
**no `router.refresh()` / `revalidatePath` whole-tree fan-out** (the
inline-edit-no-tree-refresh memory; the fan-out is what caused the revert bug).
A transient **"Saved"** (`--el-success` check) confirms; **"Saving…"** shows a
spinner; on failure the switch reverts to its prior position and an inline
**"Couldn't save · Retry"** (`--el-danger` + a `--el-link` Retry) appears.

### Copy

- Section header: `Notifications`. Helper: `Choose how you're notified for each
kind of update. These apply to you across every workspace.`
- Columns: `Email` · `In-app`. Status: `Saving…` · `Saved` · `Couldn't save` /
  `Retry`.

### A11y

Each switch carries an explicit `aria-label` naming its event + channel (e.g.
`Email for Mentioned`) so the matrix is fully screen-reader-legible; disabled
rows carry `aria-disabled`.

---

## Tokens / primitive inventory (what 5.7.5 + 5.7.6 reuse — invent nothing)

- **`IconButton`** — the bell + the drawer overflow + the per-row toggle.
- **`Pill`/`Badge`** — the bell count pill (`--el-accent`) + the `Soon` seam
  tag (`--el-tint-lavender` + `--el-text-strong`).
- **`Popover`** — the drawer container + the overflow menu (`--radius-card` +
  `--shadow-elevated`).
- **`Segmented`** — the Direct/Watching filter (with the disabled-segment seam).
- **`Avatar`** — the actor initial-letter circle; the event-type glyph badge
  takes `--el-accent` / `--el-type-{task,story,subtask}`.
- **`Card` (ContentSectionCard)** + the `<h2>` settings-card header grammar.
- **`Switch`** — the preferences matrix cells.
- **`Button variant="secondary"`** — the drawer error "Try again".
- **`BacklogSkeleton`** pulse · the inbox **empty state** · **`ErrorState`** ·
  the **"Show more"** ghost edge.
- **New token need for 5.7.5/5.7.6:** none. Every colour resolves to an existing
  `--el-*` and every shaped surface to an existing element-semantic shape token;
  no Tier-0 `--color-*` and no raw `rounded-*` / fixed control padding are used.
