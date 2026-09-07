# Workbench — design notes

Design reference for the `workbench` UI area — **`/workbench`, the signed-in
landing surface** (Story [MOTIR-4777](motir:cmtqhxi4v000uhvphhq0lndce), drawn by
the MOTIR-4779 design gate). It is the layout source of truth for **MOTIR-4782**
(the page) and **MOTIR-4783** (the sweep), and both carry it in `blocked_by`.

| Surface                           | Asset                                   | Notes                                                                                                                                                                                                                    |
| --------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The `/workbench` landing page** | **`workbench.mock.html`** (HTML mockup) | The whole surface, multi-panel: the door · To do · In progress · Recently finished · Watching grouped · the all-empty page · every tab's empty state · narrow · the no-project fall-through. Exports to `workbench.png`. |

**Panels:** A the door · 1 To do · 2 In progress · 3 Recently finished ·
4 Watching, grouped · 5 the all-empty page · 6 every tab's empty state ·
7 narrow (`< md`) · 8 the no-project fall-through — **the ADDRESS’s state, not the
Workbench’s** (below).

---

## ⚠️ THIS AREA WAS `design/home/` — the rename, and what carried across

**`design/home/` no longer exists.** The area, the mock and the export are
RENAMED — `home.mock.html` → `workbench.mock.html`, `home.png` →
`workbench.png` — and every panel of the old asset is carried across rather than
redrawn. The surface is the same surface; what changed is its NAME, its ADDRESS
and the shape of its one list.

Leaving an asset folder called `home` under a surface called Workbench is the
same drift [MOTIR-3171](motir:cmt0obeog002yi2ph44d93i6a) and
[MOTIR-3173](motir:cmt0p18t800m9i2php78xgcwn) were filed for, one layer down: a
reader navigates the design tree by area name exactly as they navigate the app
by route, and a folder that still says `home` sends the next person to an asset
they will think is stale.

**Panel-by-panel carry-over, so nothing is lost in the move:**

| old                   | new                               | what happened                                                                                                                            |
| --------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A the door            | **A the door**                    | Rail row relabelled and re-addressed; the 308 added; the glyph decision recorded (below).                                                |
| 1 populated (My work) | **1 To do**                       | Same frame, same row, same columns — the rows are now the `todo`-category slice.                                                         |
| —                     | **2 In progress**                 | NEW tab. Same frame; the rows are the `in_progress` category, including Implemented and In Review.                                       |
| —                     | **3 Recently finished**           | NEW tab, and a dataset this surface has never shown. Fifth column, window caption, `Done` and `Cancelled` rows.                          |
| 2 Watching            | **4 Watching, grouped**           | Same membership, same rows; the two GROUPS and their band are new.                                                                       |
| 3 the all-empty page  | **5 the all-empty page**          | Five tabs to be empty in; the both-zero count suppression is unchanged and now suppresses five.                                          |
| 4 both empty states   | **6 every tab's empty state**     | Two became five.                                                                                                                         |
| 5 narrow              | **7 narrow**                      | The row collapse is unchanged; the STRIP now scrolls (measured, below).                                                                  |
| 6 no active project   | **8 the no-project fall-through** | Drawing unchanged; its FRAMING is corrected — it is not a Workbench state (below). Was also re-addressed and the absent rail row's name. |

---

## What the surface is, and why it splits

A signed-in member opens Motir to answer **"what am I doing, and what have I
just done?"**. The shipped `/home` answered half of it: one list — assignee OR
reporter, deduped, active-project-scoped — plus Watching. This asset splits that
one list along the axis a person actually works on: **lifecycle**.

**And it splits on `workflow_status.CATEGORY`, never on a status KEY.** A
project defines its own statuses as `workflow_status` rows, so a tab keyed on
`'in_review'` is a tab that empties the day somebody renames a column. The
default workflow's four `in_progress`-category statuses — In Progress, Planning,
Implemented, In Review — all land in one tab, which is the point: two of them are
where an agent leaves work for a person.

| tab                   | predicate                                          | default workflow                                      |
| --------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| **To do**             | not `in_progress`-category and not `done`-category | `To Do`, `Blocked`                                    |
| **In progress**       | `category = 'in_progress'`                         | `In Progress`, `Planning`, `Implemented`, `In Review` |
| **Recently finished** | `category = 'done'` **and** finished ≤ 7 days      | `Done`, `Cancelled`                                   |
| **Watching**          | unchanged membership; ORDERED (below)              | —                                                     |
| **To approve**        | **not drawn here** — the SLOT only                 | —                                                     |

**⚠️ To do is written as a COMPLEMENT, and that is a drawn decision rather than
an implementation detail.** Three `IN` predicates are total only if every
`work_item.status` in the database names a live `workflow_status` row of its
project — a property of the DATA, not of the query. A legacy key, a column
deleted around the reassign path, or the schema's own vestigial `"open"` default
would then appear in NO tab at all: invisible on the one surface that exists to
say what is on you. The complement is total by construction, and it is also
where the shipped list put such a row, so nothing a reader can see today
disappears. [MOTIR-4781](motir:cmtqhxicf000yhvph5zbmqllq) implements it and
asserts it.

---

## The tab strip — five slots, drawn as ONE composition

The shipped link-based Segmented (`PublicTabNav`'s markup), unchanged in
grammar: an `--el-tabnav-track` track at `--radius-btn` with a `p-0.5` inset;
each tab an `<a>` at `--height-control`, `--radius-control`,
`--spacing-control-x`, `text-[12.5px] font-medium`. The active tab takes
`--el-page-bg` + `--shadow-subtle` + `--el-text-strong` and its glyph
`--el-tabnav-active`; an inactive one `--el-text-secondary` with an
`--el-text-faint` glyph.

| tab                   | glyph (lucide) | href                         |
| --------------------- | -------------- | ---------------------------- |
| **To do**             | `Circle`       | `/workbench`                 |
| **In progress**       | `CircleDot`    | `/workbench?tab=in-progress` |
| **Recently finished** | `CircleCheck`  | `/workbench?tab=finished`    |
| **Watching**          | `Star`         | `/workbench?tab=watching`    |
| **To approve**        | `Inbox`        | `/workbench?tab=approvals`   |

**⚠️ THE LABEL IS AN ACTION AND THE SLUG IS A SET, and the mismatch is
deliberate.** The tab says **To approve** because that is what it asks of the
reader — the other four name a state a card is IN, and this one names something
the reader must DO, which is the whole reason it sits apart from them. Its URL
stays `?tab=approvals` because a slug names the SET, which is also why _Recently
finished_ is addressed as `?tab=finished`: an address is a noun a person pastes
and a label is what they read on the strip, and neither owes the other a
transliteration.

- **The selection is a URL, not component state** — `aria-current="page"` on the
  active one. A reload stays on the tab and the tab is linkable; that is also
  why the link form was chosen over the client `Segmented`. **To do is the
  DEFAULT and is therefore spelled as the ABSENCE of the param**, so a link to
  the Workbench and a link to To do are the same link (the shipped
  `lib/home/tab.ts` rule, carried).
- **Counts** ride each tab as the shipped board count badge
  (`--el-count-bg` / `--el-count-text`, `--radius-badge`,
  `h-[18px] min-w-[20px] text-[11px] font-semibold`).
- **Every count is suppressed when they are ALL zero** (Panel 5) — a row of
  five `0`s is five numbers a brand-new user has to read and discard. A zero
  beside a non-zero sibling is KEPT, because there it is information. The rule
  is the shipped one and it now suppresses five instead of two.
- **The To-approve count is drawn as `0`**, which is what this story ships: the
  tab's rows, the gate records behind them and the approve/confirm control are
  [MOTIR-4778](motir:cmtqhxi7r000vhvphp60vjymc)'s and are drawn in that story's
  own design amendment. Drawing the whole strip once — rather than four tabs now
  and a fifth bolted on later — is what keeps it looking like one decision.

**Measured on this mock**, because a five-tab strip is the one thing the split
could plausibly break:

| band                          | content box | tab track needed | verdict                       |
| ----------------------------- | ----------- | ---------------- | ----------------------------- |
| 1200 viewport (rail 240)      | 894px       | **662px**        | fits, with 232px to spare     |
| all-empty (counts suppressed) | 894px       | **502px**        | fits                          |
| narrow `< md` (420 viewport)  | 386px       | **662px**        | **does not fit — it scrolls** |

The strip is `inline-flex` inside a flex column, so it stretches to the content
box and the tabs sit left. That is the SHIPPED behaviour, not a change: the
two-tab strip measured the same 894px with 249px of tabs in it. The split
narrows the empty track from 645px to 232px, which reads better rather than
worse.

### ⚠️ Narrow: the strip SCROLLS — it does not shrink and it does not wrap

At `< md` the content box is 386px and five tabs are 662px. The old two-tab
strip was 249px and fitted, so this is the one place the split changes the
narrow band's answer.

- **Shrinking** would truncate the labels, and the labels are the entire reason
  a reader knows which tab to switch to.
- **Wrapping** puts a second control row above a list whose rows are already two
  lines each — the tallest possible chrome on the shortest possible viewport.
- **Scrolling** keeps every tab reachable at full label, is the mobile
  convention, and the browser scrolls the active tab into view on load.

Implementation: `max-w-full overflow-x-auto` on the `<nav>` and `shrink-0` on
each tab. Both are ordinary Tailwind utilities; the mock declares them in its own
`<style>` block because its stylesheet is a frozen compile of the file as it was
before this revision used them, and the note on that block says so.

---

## Recently finished — the tab this surface has never had

`/home` excludes done work outright, and that was the right fix at the time:
[MOTIR-2758](motir:cmspdgjag006zi2ph3oj14n6l) was filed on a page whose own copy
said _"waiting on you"_ while it was 87% finished items. Hiding it entirely,
though, means the surface never tells you what you accomplished — and in a
product where agents do the work, this is the only place a person sees their own
week.

**Three things this tab draws that no other tab needs:**

1. **The window CAPTION**, immediately under the strip and above the list:
   _"Finished in the last 7 days. Older work stays on the item, and on the
   board."_ `text-xs` in `--el-text-secondary`. A bounded list that does not say
   what bounds it reads as a list that is missing things. The second sentence is
   there because the first raises the question it answers.
2. **A fifth column, `Finished`** — 96px, `text-xs` in `--el-text-secondary`,
   relative (`Yesterday`, `2 days ago`). The row already carries the value
   ([MOTIR-4780](motir:cmtqhxiaj000xhvphl9q2hijk) stores it and
   MOTIR-4781 puts it on the DTO), so rendering it costs no read. Column set:
   `Title (minmax(10rem,1fr)) · Your role (96) · Assignee (140) · Status (108) ·
Finished (96)` → **minimum 734px**, inside the 894px content box at 1200.
3. **`Cancelled` drawn beside `Done`.** Both are `done`-category and both land
   here, and they must not look alike: `Done` takes the `--el-tint-mint` Pill,
   `Cancelled` takes the neutral `--el-chip-bg` one. Cancelled is a `done`
   status that means ABANDONED, not accomplished — the same discrimination
   `applyStatusTransition`'s provenance stamp and `roadmapDoneStatusKeys`
   already make — so giving it the accomplishment tint would be a false claim in
   a colour.

**Ordering:** `completedAt DESC`. Not `updatedAt` — that is the whole reason
MOTIR-4780 exists, and a list ordered by last-touch would put a re-titled June
card above a card finished yesterday.

---

## Watching — an ORDER, not a filter

Membership is untouched: the same rows the tab returns today, and an item the
reader both owns and watches is still returned by both this tab and a work tab.
What is new is that every `in_progress`-category row sits ahead of every
`todo`-category one, so what is moving is above what is waiting.

**The separator is the COLUMN-HEADER BAND's grammar, with one label and a
count** — 30px against the header's 40px, `--el-surface-soft`,
`border-b --el-border`, an 11px uppercase `--el-text-secondary` label, and the
same count badge the tabs use.

- **Why a band and not a rule or a spacer.** The surface already has exactly one
  structural band, so reusing it is what makes a reader read this as STRUCTURE.
  A bare rule reads as a heavier row divider; a spacer says nothing about what
  changed.
- **Why it does not read as a second set of column labels**, which is the risk
  of sitting directly under the first: it carries ONE left-aligned label rather
  than four aligned to the columns, and it carries a COUNT — a column header
  never counts anything.
- **The labels are the tabs' own words** — `In progress`, `To do` — so a reader
  who has just switched from those tabs meets the same vocabulary.

**Groups, not a sort key.** The rows within each group keep the existing
`(updatedAt DESC, id DESC)` order, which is what lets the page boundary stay
exact; MOTIR-4781 carries the group in the cursor for the same reason.

---

## Empty states — one per tab, and only two carry an action

Panel 6 draws five, all of them the shipped `EmptyState` primitive's own markup
(`h-12` glyph in `--el-icon-muted`, `text-xl` serif title in `--el-text`,
`--el-text-subtitle` body).

| tab                   | glyph         | title                               | action                                 |
| --------------------- | ------------- | ----------------------------------- | -------------------------------------- |
| **To do**             | `Circle`      | Nothing to start                    | secondary `Button` → **`/ready`**      |
| **In progress**       | `CircleDot`   | Nothing in flight                   | secondary `Button` → **the To do tab** |
| **Recently finished** | `CircleCheck` | Nothing finished this week          | **none**                               |
| **Watching**          | `Star`        | You are not watching anything       | **none** (shipped copy, unchanged)     |
| **To approve**        | `Inbox`       | Nothing is waiting on your approval | **none**                               |

**Only a tab whose emptiness a reader can DO something about carries an action**,
which is why there are two and not five. To do sends you to Ready. In progress
sends you to the To do tab rather than mounting a second Ready button beside the
first — two buttons to the same place, one screen apart, is a duplicate. Nothing
finishes work on your behalf, nothing makes you watch an item, and nothing
conjures an approval, so those three offer no button rather than inventing one.

The tab strip stays above every empty state; it is their header, which is why
none carries a card header of its own.

---

## Copy (en)

| element               | copy                                                                           |
| --------------------- | ------------------------------------------------------------------------------ |
| rail row              | **Workbench**                                                                  |
| page `h1`             | **Workbench**                                                                  |
| subtitle              | **"What you are doing in {project}, and what you have just done."**            |
| window caption        | "Finished in the last 7 days. Older work stays on the item, and on the board." |
| tab labels            | To do · In progress · Recently finished · Watching · **To approve**            |
| Watching group labels | In progress · To do                                                            |

**⚠️ THE SUBTITLE DOES NOT SURVIVE, and the card asked whether it should.** The
shipped line is _"Everything in {project} that is waiting on you."_ It is false
of this surface: Recently finished is not waiting on you, and neither is half of
Watching. It is also the exact sentence MOTIR-2758 was filed against — a page
whose own copy said "waiting on you" over finished work. The replacement is the
journey question the story is built on, in the product's own words, and it is
true of every tab.

`messages/en.json` / `zh.json`: the `home.*` namespace moves to `workbench.*`
with the route (MOTIR-4782), keeping the key names so parity holds; only
`subtitle`'s value changes, plus the three new tab labels, the caption, the two
group labels and the three new empty states.

---

## Where it lives, and how it is reached

The authed route **`app/(authed)/workbench/page.tsx`** (Server Component),
rendering inside the shipped shell (`AppLayout`: top nav, the 240px rail,
`<main id="main">` with `px-4 py-6 sm:px-6 lg:px-8`). It resolves the session and
the **ACTIVE PROJECT** — `getActiveProject()`, the same resolver `/items`,
`/ready` and `/boards` use.

**Two doors, both drawn in Panel A:**

1. **The rail.** A **Workbench** entry as the **FIRST** primary nav item, above
   Dashboard, in `SidebarNav`'s existing item grammar (`--height-control` row,
   `--radius-control`, the glyph slot, `--el-sidebar-item-bg-active` +
   `--el-icon-active` when current). It is built inside `if (hasProject)`, so it
   is absent with no active project (Panel 8) exactly as every other primary
   entry is. The `<md` drawer renders the same `SidebarNav` and inherits it.
2. **The post-auth landing.** `AUTHED_LANDING_PATH`
   (`lib/navigation/landing.ts`, [MOTIR-3373](motir:cmt3fy07s009ri2n800i46wth))
   is the single owner of "where a reader lands", with a guard that keeps route
   literals retired — so the move is ONE constant plus a 308, not a sweep.
   `?next=` still wins and the `draftId → /onboarding` branch is untouched.

**The old address still lands.** `/home` **308**s to `/workbench` with its query
string intact, so a bookmark, a pasted link and every `?tab=` URL a reader has
saved all continue to work. A 308 rather than a 302 because the move is
permanent and the method must be preserved.

### ⚠️ The rail GLYPH stays lucide `House` — a decision, not an oversight

The mirror products put a house on the signed-in landing surface (GitHub's
dashboard) because the glyph means _where you land_, and the rename does not
change that. What changed is what the surface DOES, and the label is what says
so. Swapping a rail glyph people navigate by costs recognition and buys nothing
the word "Workbench" is not already carrying.

**The halo around the entry in Panel A is review decoration** — it is not part
of the design.

---

## ⚠️ Scope — the ACTIVE PROJECT (unchanged, carried from MOTIR-2761)

**The surface reads the active project, exactly like `/items`, `/ready` and
`/boards`.** MOTIR-2649 settled the scope from external precedent — Jira Cloud
"Your work", Linear Inbox, Plane Home — and applied it one level too shallowly:
in all three products that surface sits ABOVE the project selector, so its
cross-project scope is a property of its PLACEMENT. Motir imported the scope and
then put the surface FIRST in the PROJECT tier of the rail, under a switcher the
shell renders on every authed page. [MOTIR-2761](motir:cmspdsal400hyi2ph7f3ipusv)
fixed that; nothing here re-opens it.

Three consequences, all still drawn:

1. **No `Project` column**, in any panel.
2. **The subtitle names the PROJECT**, not the workspace.
3. **The ADDRESS has a no-project fall-through** — Panel 8 — and it is the
   **create-first door** (the shipped `ProjectsEmptyState`, reused from
   `/dashboard`) rather than the actionless `noProject` notice, because with no
   project there is no rail row and the address is only ever LANDED on. **It is
   not a state of the Workbench**, which has none — see the section below.

The cross-project question — _"what is on me across this whole workspace"_ — is
retained at the workspace tier as **MOTIR-2920**; it is a different surface, not
this one. `docs/decisions/home-scope.md` is the record.

---

## ⚠️ THE WORKBENCH HAS NO NO-PROJECT STATE — the ADDRESS falls through

**A workbench is somewhere you stand INSIDE a project.** With no project there
is no bench to draw, and a page headed _Workbench_ whose entire content is
_Create your first project_ would be a lie in a heading. So Panel 8 does not draw
a Workbench: it draws the **create-first door**, a DIFFERENT surface that
`/workbench` falls through to when `getActiveProject()` returns null.

**The shipped page already works exactly this way, and nothing here asks it to
change.** `app/(authed)/home/page.tsx`'s `!ctx` branch returns
`ProjectsEmptyState` **alone** — no `h1`, no subtitle, no tab strip — so nothing
on screen ever claims to be a Workbench with no project. The panel is faithful;
what was wrong was this asset calling it _"the state this surface never had"_,
which files it under a surface that cannot have it.

**It stays in this asset** because MOTIR-4782 has to build that branch and needs
to see it. What changes is that the asset now says whose state it is.

### ⚠️ The RENAME is what exposed this, and it falsifies a clause of the record

This is the story's own argument working on itself. _Home_ could tolerate being
empty and offering a door — a home can be empty, and `home-scope.md` §2.2 reasoned
about it under that name. _Workbench_ cannot. The name audited the content and
found a panel mis-filed, which is exactly what the story says a rename is for.

`docs/decisions/home-scope.md` §2.2 still reads _"`/home` in the no-project state
**is** the create-first door"_, and §2.3 leans on that sentence to reject
branching the landing (_"there is nothing left for a branch to accomplish"_).
**Both conclusions survive the rename; the sentence does not.** The honest form
is that the ADDRESS falls through to the door and the SURFACE has no such state —
same behaviour, same discriminator (§2.2's _landed-on gets a door, navigated-to
gets a notice_ is untouched), different noun.

That is an **amendment to a decision record, not an address swap**, which is why
it is flagged rather than folded into MOTIR-4783's sweep — see §Planning flags.

---

## ⚠️ What is NOT on this page

Carried from the 2026-08-11 revision (Yue), unchanged. An earlier revision drew
four surfaces; two were removed and stay removed:

- **Needs you** — a second mount of the notification stream. Removed as a
  **duplicate**: the bell drawer is already the notification surface, it is on
  every page, and it carries the unread badge. If notifications ever outgrow a
  drawer, that is a change to the drawer.
- **Quick links** — user-pinned shortcuts. Removed with MOTIR-2652, which is
  archived. It was the only part of the story that needed a table, bought for
  shortcuts to pages the nav already reaches.

**And the To-approve tab's ROWS.** This asset draws the slot, the label, the
count and the empty state; the rows, the gate records behind them and the
approve/confirm control belong to
[MOTIR-4778](motir:cmtqhxi7r000vhvphp60vjymc).

---

## The asset is the app's own markup, not a redraw

Every element on this page already ships. Rather than re-draw them, the mock was
composed from the **real components' own emitted markup**, dumped through the
repo's vitest + RTL setup (`renderWithIntl(<Component/>)` →
`container.innerHTML`) and pasted in verbatim:

| Element                                   | Dumped from                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| the work-item row + its cells             | `app/(authed)/items/_components/IssueListTable.tsx` (via `issueColumns`) |
| the sidebar rail                          | `app/(authed)/_components/SidebarNav.tsx`                                |
| `EmptyState` · `Card` · `Button` · `Pill` | `@motir/design-system` (the `components/ui/*` shims)                     |
| the tab strip                             | `app/(public)/_components/PublicTabNav.tsx` (the link-based Segmented)   |

The stylesheet inlined in the mock is **Tailwind's real output for that file**,
compiled from `app/globals.css`'s own `@import 'tailwindcss'` +
`@motir/design-system/theme.css` — so the token layer is the shipped one
byte-for-byte, not a hand-copied block.

**Everything this revision adds COMPOSES that same markup.** The five-tab strip
is the shipped Segmented with three more tabs; the Watching group band is the
column-header band with one label and a count; the Finished cell is the row's own
`text-xs` secondary cell; every empty state is the `EmptyState` primitive. No new
primitive, and no new token.

---

## Layout — one column, and the column set is the real decision

With no widgets, "where do the widgets go" is not a question this asset has to
answer. What it does have to answer, and what MOTIR-4782 must not re-decide, is
**which columns the row carries**.

### Measurements (taken in Chromium against this mock, not asserted)

The shipped `/items` row is a nine-column grid whose minimum width is **1204px**.
Content available to a page in the shell is `viewport − 240 (rail) − 64
(lg:px-8)`:

| viewport | content available | shipped 9-col row (needs 1204) |
| -------- | ----------------- | ------------------------------ |
| 1200     | **896**           | ✗ clips                        |
| 1280     | **976**           | ✗ clips                        |
| 1440     | 1136              | ✗ clips                        |

So this surface cannot render the full `/items` column set at any common laptop
width. (Nor can `/items` — that is the known MOTIR-1307 clipping; the Workbench
must not inherit it.)

**The column set — the same cells, a Workbench-specific set:**

```
Title (minmax(10rem,1fr)) · Your role (96) · Assignee (140) · Status (108)
```

→ minimum **622px**; measured title track **440px** at the 1200 viewport, 520 at
1280, 680 at 1440. Rows stay the shipped 44px. **Recently finished adds
`Finished (96)`** → minimum 734px, which still fits at 1200.

**What was dropped, and why.** `Reporter` (on a list defined by _you are the
assignee or the reporter_, a Reporter column answers a question the list has
already answered — "Your role" carries it), `Est.`, `Points`, and the trailing
row-actions `⋯` (the whole-row link + the `?peek=` quick view are the two
affordances this surface needs; bulk actions belong on `/items`).

---

## The one cell that only exists here

### `Your role` — "Assigned" · "Reported" · "Both" (and "Watching" on the Watching tab)

Plain `text-xs` in `--el-text-secondary`; the **`Both`** value takes
`--el-text-strong` + `font-medium` as a non-colour cue (finding #35 — never
colour alone).

This cell exists because assigned and reported are **merged into one membership
predicate**. That merge is what creates the dedupe requirement, and this is the
only place a human can see it hold — a row reading `Both` appears **once**. It is
partially derivable from Assignee (a row assigned to someone else is one you
reported), but a column that is usually derivable and never wrong is cheaper to
read than a rule the reader has to apply per row.

On the **Watching** tab the same cell distinguishes watch-only (`Watching`) from
watch-and-own (`Both`), which is why an item can legitimately appear in both a
work tab and Watching. Watching is a different audience, not a partition.

---

## The agent state — a row-level state, never a section

An item with `executor: coding_agent` renders **like any other row**. There is no
agent section, no agent widget and no agent tab anywhere in this asset; the human
assignee still answers for the item, so it belongs in that human's list.

**How the row shows it:** the assignee's avatar carries a **glyph badge** — the
same avatar-with-badge composition the shipped `NotificationRow` uses, with
lucide **`Bot`**, the glyph the shipped `ExecutorIndicator` already uses for
`executor: coding_agent`. The badge is `aria-hidden`; an `sr-only` span carries
the meaning.

**`--el-executor-agent`** is the Tier-3 token it paints with, added beside the
`--el-notif-*` set by MOTIR-2653 and unchanged here.

---

## Token map

| Element                           | Colour                                                                                                                                                        | Shape                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| page `h1` / subtitle              | `--el-text` / `--el-text-muted`                                                                                                                               | —                                                                                              |
| tab track / active tab / inactive | `--el-tabnav-track` · `--el-page-bg` + `--el-text-strong` · `--el-text-secondary`                                                                             | `--radius-btn` (track) · `--radius-control` (tab) · `--height-control` · `--spacing-control-x` |
| tab glyph active / inactive       | `--el-tabnav-active` / `--el-text-faint`                                                                                                                      | —                                                                                              |
| tab count badge                   | `--el-count-bg` / `--el-count-text`                                                                                                                           | `--radius-badge` · `--spacing-chip-x`                                                          |
| **window caption**                | **`--el-text-secondary`**                                                                                                                                     | `text-xs`                                                                                      |
| list container                    | `--el-border`                                                                                                                                                 | `--radius-card`                                                                                |
| column header strip               | `--el-surface-soft` / `--el-text-secondary`                                                                                                                   | 40px                                                                                           |
| **Watching group band**           | **`--el-surface-soft` / `--el-text-secondary`**, count on `--el-count-bg` / `--el-count-text`                                                                 | **30px** · `--radius-badge` (count)                                                            |
| row · row hover                   | `--el-border` (rule) · `--el-surface` (hover)                                                                                                                 | 44px · `pl-4 pr-7` · `gap-x-4`                                                                 |
| type glyph                        | `--el-type-{epic,story,task,bug,subtask}`                                                                                                                     | `h-4 w-4`                                                                                      |
| identifier                        | `--el-text-muted`, `font-mono text-xs`                                                                                                                        | —                                                                                              |
| title                             | `--el-text`                                                                                                                                                   | truncate                                                                                       |
| Your role · `Both`                | `--el-text-secondary` · `--el-text-strong` + `font-medium`                                                                                                    | `text-xs`                                                                                      |
| **`Finished` cell**               | **`--el-text-secondary`**                                                                                                                                     | `text-xs` · 96px                                                                               |
| avatar                            | `bg-(--el-text)` / `--el-text-inverted`                                                                                                                       | `rounded-full` 22px                                                                            |
| agent badge                       | `--el-executor-agent` / `--el-accent-text`, `ring-(--el-page-bg)`                                                                                             | `rounded-full` 14px                                                                            |
| status chip                       | `Pill` tones — `--el-tint-sky` (in-progress category), **`--el-tint-mint` (Done)**, **`--el-chip-bg` (To Do, Blocked, Cancelled)**, all on `--el-text-strong` | `--radius-badge`                                                                               |
| unassigned                        | `--el-text-muted`                                                                                                                                             | —                                                                                              |
| empty-state glyph / title / body  | `--el-icon-muted` · `--el-text` (serif) · `--el-text-subtitle`                                                                                                | `--radius-card` · `--spacing-card-padding`                                                     |
| rail Workbench entry (active)     | `--el-sidebar-item-bg-active` · `--el-text` · `--el-icon-active`                                                                                              | `--radius-control` · `--height-control`                                                        |

**No new token.** Every element above paints with a token the design system
already ships.

**AA:** `--el-text-faint` appears only on `aria-hidden` glyphs.
`--el-text-muted` appears only on the white page/card surface, never on
`--el-surface` / `--el-muted` (the `CLAUDE.md` contrast table) — which is why the
window caption and the `Finished` cell take `--el-text-secondary` and not
`--el-text-muted`: the caption sits on the page ground but the cell sits inside a
row whose hover state is `--el-surface`, and `--el-text-secondary` is 6.18–6.80:1
on all four surfaces in both themes.

---

## What this asset does NOT decide

- **The To-approve tab's rows, its gate records and its approve/confirm control**
  — [MOTIR-4778](motir:cmtqhxi7r000vhvphp60vjymc). Only the slot is drawn here.
- **Ordering within each work tab.** MOTIR-4781 owns it and specifies
  `updatedAt DESC` with a total, stable tiebreak (and `completedAt DESC` for
  Recently finished); nothing here overrides that.
- **The paging affordance** — the mock shows one page. MOTIR-4781's reads are
  cursor-paged and hand back an opaque `nextCursor`; MOTIR-4782 picks the control
  (the shipped `IssueListPager` is the obvious reuse) and keeps the cursor in the
  URL beside `?tab=`.
- **The finished window's LENGTH as a setting.** Seven days is drawn and is a
  constant; whether it should ever be configurable is not a question this asset
  raises.
- **The cross-project "my work" surface** — retained at the workspace tier as
  MOTIR-2920. It will have its own design area.

---

## GIVES / TAKES — every card this asset names

| card                                                     | GIVES                                                                                                                                                               | TAKES                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **MOTIR-4782** (the page)                                | The five-tab strip as one composition, every tab's empty state, the window caption, the Watching group band, the copy, the narrow scroll, the rail row and the 308. | Nothing. It draws no element this asset leaves unspecified, and it does not own the To-approve rows.                                 |
| **MOTIR-4783** (the sweep)                               | The area's new name and address, so `design/home/` is a hit its sweep must find nowhere.                                                                            | Nothing — but note that the two design-guard REGISTRIES key on the old paths and are re-keyed by THIS card's diff, not by the sweep. |
| **MOTIR-4781** (the reads)                               | The `Finished` column and the group order as things a reader SEES, so the DTO field and the cursor group are not speculative.                                       | Nothing. Its category predicate is unchanged by anything drawn here.                                                                 |
| **MOTIR-4780** (`completedAt`)                           | The window caption is the user-facing statement of what that column is for.                                                                                         | Nothing.                                                                                                                             |
| **MOTIR-4778** (the sibling story)                       | The To-approve SLOT — its position in the strip, its label, its glyph, its count treatment and its empty state.                                                     | **Its own design amendment no longer draws the strip.** The strip is composed once, here; that story draws the ROWS inside the slot. |
| **MOTIR-2649 / 2653 / 2654 / 2761 / 2758 / 2652 / 2920** | Nothing — they are `done` or archived and are not touched.                                                                                                          | Nothing.                                                                                                                             |
| **MOTIR-3373** (`AUTHED_LANDING_PATH`)                   | Nothing.                                                                                                                                                            | Nothing — the rename is one write to the constant it already owns, which is why the move is not a sweep.                             |

---

## ⚠️ Planning flags — surfaced by this pass, owned by no card in MOTIR-4777

1. **Two design-guard registries key on `design/home/*` paths.**
   `tests/design-asset-addresses.test.ts` carries two exemption entries keyed
   on the old mock and the old notes — one an address the docs surface took to
   motir-marketing, one a component that moved with it — and
   `tests/design-token-layer.test.ts` names the old mock in a synthetic
   fixture. This card's diff re-keys them, because a rename that
   leaves them behind turns the design lane red on its own pull request. Naming
   it here because MOTIR-4783's sweep would otherwise be expected to own it, and
   by then it would already have failed.
2. **`home-scope.md` §2.2's sentence is falsified by the rename, and MOTIR-4783
   is scoped too small to fix it.** That card sweeps what still _says_ `/home` or
   _Home_ — an address swap. This is not one: §2.2 concludes _"`/home` in the
   no-project state **is** the create-first door"_, and §2.3 rests on it
   (_"there is nothing left for a branch to accomplish"_). Both CONCLUSIONS
   survive — the behaviour is unchanged and the landed-on-vs-navigated-to
   discriminator is untouched — but the sentence has to become _the ADDRESS falls
   through to the door; the surface has no such state_, because a Workbench with
   no project is not a thing. A sweep that only re-addresses `/home` → `/workbench`
   leaves a record asserting a state this asset says does not exist. **Whoever
   picks up MOTIR-4783 should amend §2.2's wording, not just its addresses** —
   and if that is judged out of its scope, it is a decision card of its own. The
   section above is the design's position; the record is not this asset's to
   rewrite.

3. **`design/shell/` names this asset twice, by its old path.** Its
   `design-notes.md` rail-inventory table and `rail-bottom-section.mock.html`
   both cite `design/home/home.mock.html` as context for a DIFFERENT question
   (the rail's control budget). Neither is a broken reference to this surface —
   they are references to a rail — but both now name a file that does not exist.
   MOTIR-4783's sweep is the right owner; it is flagged so that sweep has the
   hits enumerated.
4. **The strip stretches to the content box and the tabs sit left**, leaving
   238px of empty track at 1200. That is shipped behaviour inherited from the
   `inline-flex`-in-a-flex-column composition, and it is not this story's to
   change — but with five tabs it is now visible enough to be a question
   somebody will ask. Whether the track should hug its tabs is a change to the
   shipped Segmented, not to this surface.
5. **Nothing checks that an `--el-*` named in a design note resolves in
   `theme.css`.** This asset names no new token, so it is not exposed — but the
   check does not exist, and it is a guard-lane test rather than a design card.

---

## Context refs

- `app/(authed)/items/_components/` — `IssueListTable`, `issueColumns`,
  `issueCellPrimitives` (the row and every cell reused here).
- `app/(authed)/_components/SidebarNav.tsx` — where the Workbench entry goes,
  inside `if (hasProject)`.
- `app/(public)/_components/PublicTabNav.tsx` — the link-based tab strip.
- `lib/navigation/landing.ts` — `AUTHED_LANDING_PATH`, the one landing constant.
- `components/ui/AppLayout.tsx` · `app/(authed)/layout.tsx` — the shell geometry
  the measurements above come from (240px rail; `px-4 py-6 sm:px-6 lg:px-8`).
- `packages/design-system/theme.css` — the Tier-3 block carrying
  `--el-executor-agent`.
- `design/shell/` — the rail and the navigation grammar the access path is
  grounded in.
- `docs/decisions/home-scope.md` — why the surface is active-project scoped and
  has a no-project panel.
- `design/ready/` · `design/reports/` — the three-file convention and PNG render
  settings this asset follows.
