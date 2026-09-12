# Workbench — design notes

Design reference for the `workbench` UI area — **`/workbench`, the signed-in
landing surface** (Story [MOTIR-4777](motir:cmtqhxi4v000uhvphhq0lndce), drawn by
the MOTIR-4779 design gate). It is the layout source of truth for **MOTIR-4782**
(the page) and **MOTIR-4783** (the sweep), and both carry it in `blocked_by`.

**AMENDED by MOTIR-4851** (Story
[MOTIR-4850](motir:cmtrqmg1o001yhwphuhguhxni)) with the two things the first
revision handed forward: **how the surface PAGES** and **how its work tabs are
ORDERED**. Both were in § _What this asset does NOT decide_; both are now drawn,
and that section no longer carries them. It is the layout source of truth for
**MOTIR-4852** (the reads) and **MOTIR-4853** (the page), which carry it in
`blocked_by`.

| Surface                           | Asset                                   | Notes                                                                                                                                                                                                                      |
| --------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The `/workbench` landing page** | **`workbench.mock.html`** (HTML mockup) | The whole surface, multi-panel: the door · To do · In progress · Recently finished · Watching grouped · the all-empty page · every tab's empty state · narrow · **the pager, in five states**. Exports to `workbench.png`. |

**Panels:** A the door · 1 To do · 2 In progress · 3 Recently finished ·
4 Watching, grouped · 5 the all-empty page · 6 every tab's empty state ·
7 narrow (`< md`) · **8 a paged tab, and the kind order** · **9 a single-page
tab** · **10 an empty tab, with no pager** · **11 Watching over an offset page
(+ 11b a page inside one band)** · **12 the pager at narrow, and in `zh`**.
**There is no no-project panel** — see below.

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

| old                   | new                           | what happened                                                                                                   |
| --------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A the door            | **A the door**                | Rail row relabelled and re-addressed; the 308 added; the glyph decision recorded (below).                       |
| 1 populated (My work) | **1 To do**                   | Same frame, same row, same columns — the rows are now the `todo`-category slice.                                |
| —                     | **2 In progress**             | NEW tab. Same frame; the rows are the `in_progress` category, including Implemented and In Review.              |
| —                     | **3 Recently finished**       | NEW tab, and a dataset this surface has never shown. Fifth column, window caption, `Done` and `Cancelled` rows. |
| 2 Watching            | **4 Watching, grouped**       | Same membership, same rows; the two GROUPS and their band are new.                                              |
| 3 the all-empty page  | **5 the all-empty page**      | Five tabs to be empty in; the both-zero count suppression is unchanged and now suppresses five.                 |
| 4 both empty states   | **6 every tab's empty state** | Two became five.                                                                                                |
| 5 narrow              | **7 narrow**                  | The row collapse is unchanged; the STRIP now scrolls (measured, below).                                         |
| 6 no active project   | **REMOVED**                   | The Workbench has no no-project state, and the panel drew a defect rather than a design — see below.            |

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
  `lib/workbench/tab.ts` rule, carried).
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

**Groups, not a sort key — the group is the OUTER key and the kind order runs
INSIDE it.** ~~The rows within each group keep the existing
`(updatedAt DESC, id DESC)` order, which is what lets the page boundary stay
exact; MOTIR-4781 carries the group in the cursor for the same reason.~~
**AMENDED (MOTIR-4851).** The struck sentence was right about the SHAPE and is
superseded on the sort key and on the mechanism: within each group the rows now
order by the kind rank (§The ORDER below), and the page boundary is kept exact
by a total tiebreak rather than by a cursor, because the cursor is retired
(MOTIR-4852). The band structure is unchanged — Panel 11 draws it over an offset
page, including the two arrangements the keyset could never produce.

---

## The ORDER — `READY_KIND_RANK`, and the SAME constant rather than a second copy

**The three work tabs — To do, In progress, Watching — order by KIND:**
`subtask → bug → task → story → epic`. **Recently finished is untouched** and
keeps `completedAt DESC`, because _what did I just finish_ IS a time question.

**Why kind and not time.** `updatedAt DESC` answers _what did I touch last_,
which is a question nobody opens this page with. The question they do open it
with is _what do I pick up next_, and the product already knows the answer:
`/ready` orders by `READY_KIND_RANK`, most granular first, coarsening to
containers last, because the most granular work is the work you can actually
start. It matters more here than anywhere else precisely because agents fill
this surface — a reader looking at sixty rows is looking at a queue their agents
built, and the rows that can be started ought to be the rows they see.

**Drawn, not described: Panel 8's twenty-five rows are in that sequence** —
eleven subtasks, three bugs, five tasks, five stories, one epic — so the
`IssueTypeIcon` column reads as a sorted run. Panel 11 draws the same run
INSIDE each of Watching's two bands.

**The rank is read from `lib/workItems/readyFilter.ts`, not re-declared.** Two
lists that both claim to be "in ready order" and derive it separately will
disagree eventually, and quietly: nothing errors, one page just puts an epic
above a subtask. MOTIR-4852 imports the constant and spends a guard on the
agreement; this asset records that as a drawn property of the surface rather
than an implementation detail, because "the same order as Ready" is something a
reader can see and check.

**Nothing about the ROW changes** — the same four columns, the same cells, the
same 44px. Only the sequence.

### ⚠️ The rows in this asset CAUGHT UP with the shipped component in the same pass

Drawing a sorted-by-kind run made two drifts load-bearing that had been merely
untidy, so they are fixed here, in this file, with the evidence:

| what                                 | the asset had       | the shipped `WorkbenchList` / `IssueTypeIcon` renders                                        |
| ------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------- |
| the **task** glyph (5 rows)          | lucide `circle-dot` | lucide `square-check-big` (`ISSUE_TYPE_META.task.icon`)                                      |
| the **bug** glyph (4 rows)           | lucide `circle-dot` | lucide `bug` (`ISSUE_TYPE_META.bug.icon`)                                                    |
| the row **identifier** ink (19 rows) | `--el-text-muted`   | `--el-text-secondary` — muted is 4.17:1 on `--el-surface`, which is the row's own hover fill |
| the **Unassigned** ink (2 rows)      | `--el-text-muted`   | `--el-text-secondary`, for the same pair                                                     |

The glyph pair is the one that could not be left: with task and bug drawn as the
same circle, a run ordered `subtask → bug → task → …` is invisible as a run, and
Panel 8 exists to make it visible. `git grep -c 'lucide-circle-dot text-(--el-type-'`
returned **9, all of them in this file** — every other asset in the tree already
drew the shipped glyphs, so this was a local staleness rather than a convention.

---

## The pager — the shipped control, COMPOSED and not re-specified

**The control has an owner, and it is not this asset.**
`design/work-items/list.mock.html` **panel 5** + `design/work-items/design-notes.md`
§ _server-paged navigator_ draw the `Showing X–Y of N` range line, the prev
chevron, the numbered buttons with ellipsis truncation and the next chevron, and
`app/(authed)/items/_components/IssueListPager.tsx` implements exactly that.
**This asset does not re-specify the control's internals.** What it decides is
where the control SITS on the Workbench, what it SAYS there, and the four states
the Workbench produces that `/items` does not.

**What today's surface does, and why it is being replaced.** `/workbench` pages
with a keyset cursor and two links — **Next** and **Back to the top** — sitting
OUTSIDE the bordered box. That is a one-way walk: a reader cannot see how far the
tab goes, cannot jump, and cannot step back a page except by starting over. Every
other list in Motir already solved this, so the surface a person lands on after
signing in is the one place in the product where paging is worse than everywhere
else.

### The five states, and the decision in each

| panel  | state                        | what is drawn                                                                                                                                                               |
| ------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **8**  | a paged tab, at rest         | The footer is the **last row INSIDE the bordered box** (`border-t --el-border` over `--el-surface-soft`), under a full 25-row page, so the reader sees the box close on it. |
| **9**  | a set that fits one page     | The **range line stays; the page nav is absent.** A lone `[1]` is a control that cannot do anything, but "9 of 9" still answers _is this all of it?_                        |
| **10** | an empty tab                 | **No pager at all**, and no bordered box — the drawn empty state IS the card. `Showing 0–0 of 0` would say what the empty state has just said, in a quieter voice.          |
| **11** | Watching over an offset page | The band boundary INSIDE a page, and each band's count reading the **GROUP** rather than the page. Plus **11b**: a page wholly inside one group draws that band ALONE.      |
| **12** | narrow (`< md`) and `zh`     | The footer **wraps** rather than shrinking; how far depends on the run length, and the ellipsis truncation bounds it to one extra line. The same footer, rendered in 中文.  |

**The pager's `N` is the tab strip's own count.** 63 in the range line and 63 on
the strip, because they are the same predicate — a reader is never handed two
numbers to reconcile. Panel 8 draws both in one frame for exactly that reason.

**The page rides the URL beside `?tab=`, and page 1 is the ABSENCE of the
param** — the same rule that makes To do the absence of `?tab=`, so a link to a
tab and a link to its first page are one link.

### The copy — `en` and `zh`, named here because the control ships neither

`IssueListPager.tsx` has no `next-intl` import at all: every string below is an
English literal today, and its number formatting is pinned to `en-US`. The
Workbench is the surface that ships in both languages, so this is where they are
named. `/items` and `/items/archived` inherit them unchanged.

| element                        | `en`                             | `zh`                                   |
| ------------------------------ | -------------------------------- | -------------------------------------- |
| range line                     | `Showing {from}–{to} of {total}` | `显示第 {from}–{to} 项，共 {total} 项` |
| previous chevron, `aria-label` | `Previous page`                  | `上一页`                               |
| next chevron, `aria-label`     | `Next page`                      | `下一页`                               |
| page button, `aria-label`      | `Page {n}`                       | `第 {n} 页`                            |
| the nav's `aria-label`         | `Pagination`                     | `分页`                                 |

- **The range line's two numbers stay `<strong>` on `--el-text`** in both
  languages: they are the answer, and the words around them are the frame.
- **The numbers are formatted in the ACTIVE locale**
  (`Intl.NumberFormat(locale)`), not `en-US`. A four-figure total is the only
  place it shows, and it shows there.
- **The chevrons carry no visible text in either language**, so the
  `aria-label` is the whole of their accessible name — which is why they are
  named here rather than left to the code card.

### The ACCESS PATH is unchanged, and is already drawn

`/workbench` is the signed-in landing surface and the rail's first project-tier
row; **Panel A draws both doors** (the rail entry and `AUTHED_LANDING_PATH`) and
neither moves. The pager is a control INSIDE a page the reader is already
standing on, not a new destination, so this amendment adds no entrance and
changes none. Stating it rather than leaving it unaddressed, because "draw the
entrance" is a standing requirement and its answer here is _already drawn, in
Panel A_.

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
| **pager**             | § _The pager_ → _The copy_ above has the five strings, with their `zh` values  |

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
   is absent with no active project exactly as every other primary
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
3. **There is NO no-project state**, and the panel that drew one is removed —
   see the section below. With no project there is no rail row and no Workbench;
   the reader belongs at the workspace tier.

The cross-project question — _"what is on me across this whole workspace"_ — is
retained at the workspace tier as **MOTIR-2920**; it is a different surface, not
this one. `docs/decisions/home-scope.md` is the record.

---

## ⚠️ THE WORKBENCH HAS ONE EMPTY STATE — _no work_, not _no project_

**You are always in a project.** That is the target, and it is what makes this
surface simple: the Workbench is project-tier — the rail row is built inside
`if (hasProject)`, every read is scoped to the active project — so its only empty
state is **"you have no work"**, Panel 5, the all-empty page.

### The target: there is no "Create project" screen

> **A default project is created at registration**, exactly as
> `ensureDefaultWorkspace` already does for the workspace. A newly registered
> reader lands in **`/onboarding`** — the new-project path — inside that project.
> **`getActiveProject()` never returns null**, so no surface needs a no-project
> state and no surface offers a _Create project_ screen.

The product already does this one step later: `startNewAiProjectAction`
("Plan a new project with AI") mints a project, pins it active, and only THEN
routes to `/onboarding`. The target applies the same order at registration.

**So this asset draws no no-project panel.** The earlier revision drew one,
carried across from `design/home/`, and it conflated two states:

| state                          | tier      | whose                                     |
| ------------------------------ | --------- | ----------------------------------------- |
| no work items                  | project   | **the Workbench's** — Panel 5             |
| zero projects in the workspace | workspace | nobody's — the target does not produce it |

### What ships today, and why it is a defect

Traced, because it decides how big the fix is:

- **Nothing seeds a default project.** `ensureDefaultWorkspace` self-heals the
  WORKSPACE; there is no project equivalent in `lib/` or `app/`. A fresh account
  has a workspace and zero projects.
- **Sign-up lands on `AUTHED_LANDING_PATH`** — this surface — so a brand-new
  reader arrives at a project-tier route with no project.
- **`/home` and `/dashboard` then render `ProjectsEmptyState`**, a _Create
  project_ screen, inside project chrome. `/ready`, `/plans`, `/roadmap`,
  `/backlog` and `settings/project/*` answer the same question with an actionless
  `noProject` notice.
- **`/onboarding` cannot absorb it either**: its entrance dead-ends for a
  projectless reader (`app/(onboarding)/onboarding/page.tsx` renders an actionless
  `noProject` EmptyState) because it expects a project to already exist.

`docs/decisions/home-scope.md` §2.2 decided that door, and its reasoning holds
**under the name and the premise it reasoned about** — a reader who is LANDED on
a route should not be stranded, and a projectless state was taken as a given.
Creating the project at registration removes the premise. §2.3 rests on §2.2, so
the two move together.

**This asset does not fix that and does not draw around it** — the fix spans
registration, the landing, a family of routes and a decision record, so it is
filed as its own card. What the asset does is stop presenting the defect as the
design.

### What MOTIR-4782 builds

- **No no-project panel**, because the Workbench has no such state.
- **It must not render `ProjectsEmptyState`** — a checkable criterion: no
  project-tier route renders a _Create project_ screen.
- **It does not seed the default project or move the landing.** That is the filed
  card's, because it also settles `/dashboard`, the notice family and the record.
  Until it lands, MOTIR-4782 keeps the shipped branch rather than inventing one.

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

**And so does MOTIR-4851's.** Panels 8–12's footer is `IssueListPager`'s own
emitted markup — its container, its `PG_BTN` class string, its two lucide
chevrons and its `aria` attributes, verbatim — so the asset cannot drift from
the control it composes. Eight of its utility classes, plus
`text-(--el-type-epic)` (the mock drew no epic row until Panel 8), are declared
in the mock's own `<style>` block for the same reason the two narrow-strip
utilities below them are: the stylesheet above is a frozen Tailwind compile of
this file as it stood BEFORE the revision, and it cannot contain a class the
file did not yet use. They are written exactly as Tailwind emits them.

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

| Element                            | Colour                                                                                                                                                        | Shape                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| page `h1` / subtitle               | `--el-text` / `--el-text-muted`                                                                                                                               | —                                                                                              |
| tab track / active tab / inactive  | `--el-tabnav-track` · `--el-page-bg` + `--el-text-strong` · `--el-text-secondary`                                                                             | `--radius-btn` (track) · `--radius-control` (tab) · `--height-control` · `--spacing-control-x` |
| tab glyph active / inactive        | `--el-tabnav-active` / `--el-text-faint`                                                                                                                      | —                                                                                              |
| tab count badge                    | `--el-count-bg` / `--el-count-text`                                                                                                                           | `--radius-badge` · `--spacing-chip-x`                                                          |
| **window caption**                 | **`--el-text-secondary`**                                                                                                                                     | `text-xs`                                                                                      |
| list container                     | `--el-border`                                                                                                                                                 | `--radius-card`                                                                                |
| column header strip                | `--el-surface-soft` / `--el-text-secondary`                                                                                                                   | 40px                                                                                           |
| **Watching group band**            | **`--el-surface-soft` / `--el-text-secondary`**, count on `--el-count-bg` / `--el-count-text`                                                                 | **30px** · `--radius-badge` (count)                                                            |
| row · row hover                    | `--el-border` (rule) · `--el-surface` (hover)                                                                                                                 | 44px · `pl-4 pr-7` · `gap-x-4`                                                                 |
| type glyph                         | `--el-type-{epic,story,task,bug,subtask}`                                                                                                                     | `h-4 w-4`                                                                                      |
| identifier                         | `--el-text-muted`, `font-mono text-xs`                                                                                                                        | —                                                                                              |
| title                              | `--el-text`                                                                                                                                                   | truncate                                                                                       |
| Your role · `Both`                 | `--el-text-secondary` · `--el-text-strong` + `font-medium`                                                                                                    | `text-xs`                                                                                      |
| **`Finished` cell**                | **`--el-text-secondary`**                                                                                                                                     | `text-xs` · 96px                                                                               |
| avatar                             | `bg-(--el-text)` / `--el-text-inverted`                                                                                                                       | `rounded-full` 22px                                                                            |
| agent badge                        | `--el-executor-agent` / `--el-accent-text`, `ring-(--el-page-bg)`                                                                                             | `rounded-full` 14px                                                                            |
| status chip                        | `Pill` tones — `--el-tint-sky` (in-progress category), **`--el-tint-mint` (Done)**, **`--el-chip-bg` (To Do, Blocked, Cancelled)**, all on `--el-text-strong` | `--radius-badge`                                                                               |
| unassigned                         | `--el-text-muted`                                                                                                                                             | —                                                                                              |
| empty-state glyph / title / body   | `--el-icon-muted` · `--el-text` (serif) · `--el-text-subtitle`                                                                                                | `--radius-card` · `--spacing-card-padding`                                                     |
| rail Workbench entry (active)      | `--el-sidebar-item-bg-active` · `--el-text` · `--el-icon-active`                                                                                              | `--radius-control` · `--height-control`                                                        |
| **pager footer bar**               | **`--el-surface-soft`**, top rule `--el-border`                                                                                                               | `px-3.5 py-2.5` (layout, not a control's own box)                                              |
| **pager range line · its numbers** | **`--el-text-secondary`** · `--el-text` (`font-semibold`)                                                                                                     | `text-[13px]`                                                                                  |
| **page button (rest)**             | **`--el-page-bg`** / `--el-text`, border `--el-border`, hover `--el-surface`                                                                                  | `--radius-control` · `--height-control` · `--spacing-control-x` · `min-w-(--height-control)`   |
| **page button (current)**          | **`--el-accent`** / `--el-accent-text`, `border-transparent`                                                                                                  | same                                                                                           |
| **prev / next chevron**            | glyph `--el-text-muted`; **disabled**: `--el-text-faint` at `opacity-55`                                                                                      | same                                                                                           |
| **the ellipsis**                   | **`--el-text-faint`**, `aria-hidden`                                                                                                                          | `min-w-6` · `text-[13px]`                                                                      |

**No new token.** Every element above paints with a token the design system
already ships, the pager included — it is the shipped control's own token set,
composed rather than re-chosen.

**AA on the pager, checked against the CLAUDE.md contrast table.** The footer's
ground is `--el-surface-soft`, where `--el-text-muted` is **4.34:1 and fails** —
which is why the range line is `--el-text-secondary` (6.51:1) and not muted, and
why the shipped component's own comment says so. `--el-text-faint` appears in
exactly two places and clears AA on neither surface, so both are exempt by
kind rather than by measurement: the **ellipsis** is `aria-hidden` decoration,
and the **disabled chevron's** glyph is disabled text, which 1.4.3 does not
measure — the button carries `disabled` and `aria-disabled="true"`, which is
what makes that legitimate rather than merely convenient. The current page is
**not colour alone**: it is also the only filled, borderless button in the run,
and it carries `aria-current="page"`.

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
- ~~**Ordering within each work tab.** MOTIR-4781 owns it and specifies
  `updatedAt DESC` with a total, stable tiebreak (and `completedAt DESC` for
  Recently finished); nothing here overrides that.~~ **DECIDED by MOTIR-4851** —
  § _The ORDER_ above. The three work tabs read `READY_KIND_RANK`; Recently
  finished keeps `completedAt DESC`, which was never the deferred half.
- ~~**The paging affordance** — the mock shows one page. MOTIR-4781's reads are
  cursor-paged and hand back an opaque `nextCursor`; MOTIR-4782 picks the control
  (the shipped `IssueListPager` is the obvious reuse) and keeps the cursor in the
  URL beside `?tab=`.~~ **DECIDED by MOTIR-4851** — § _The pager_ above, Panels
  8–12. The obvious reuse was the right one; what this asset adds is where it
  SITS, what it says, and the four states nobody had asked for.

  **Both lines are struck rather than deleted, and that is the convention this
  file already uses** (§Watching, §PR-title). A deferral that simply vanishes
  reads as though nobody ever raised the question; a struck one tells the next
  reader that it WAS raised, and where it was answered.

- **The page SIZE.** `HOME_PAGE_SIZE = 25` is drawn as a constant in every
  panel. Whether a reader may choose it — the `/items` list does not offer that
  either — is not a question this asset raises.
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

### The MOTIR-4851 revision's own sweep

**Scope of the sweep, stated because it is a judgement:** every `MOTIR-<n>` in
the NOTES, plus every one in the mock's own **annotation prose** (its
review-head, panel labels, `.note` blocks and captions). The mock's SAMPLE ROW
DATA is deliberately excluded — those keys are drawn content standing in for a
reader's list, not references to cards this asset allocates work to, and a
GIVES / TAKES line for each would be sixty rows of noise around the seven that
mean something. The sweep also ran over MOTIR-4850's whole SUBTREE rather than
only over the keys the asset happens to name.

| card                                                     | GIVES                                                                                                                                                                                                                                                                                                                                                                                              | TAKES                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-4852** (the reads)                               | The ORDER as a drawn fact — `subtask → bug → task → story → epic` on the three work tabs, `completedAt DESC` untouched on Recently finished — and the requirement that Watching's GROUP is the outer key across a page boundary, which is why it is ONE ordered read rather than two. Also the pager's denominator: `N` is the tab strip's own count, so the list and the total are one predicate. | **Nothing structural, and one PREMISE it should read:** its disposition table retires the cursor module, and Panel 11's band-boundary arrangement is the thing that table's replacement has to keep producing. Nothing here re-opens the category predicate, the window or `HOME_PAGE_SIZE`. |
| **MOTIR-4853** (the page)                                | All five panels and every string: the footer INSIDE the box, the single-page and empty states, the two Watching arrangements, the narrow wrap, and the `en` + `zh` values for all five pager strings, so the card transcribes rather than invents.                                                                                                                                                 | **Nothing.** It draws no element this asset leaves unspecified, and the access path it renders is the one Panel A already draws.                                                                                                                                                             |
| **MOTIR-4854** (the vitest gate)                         | Nothing it can assert against a mock. The kind-order run and the band counts are what its integration seams are seams BETWEEN.                                                                                                                                                                                                                                                                     | Nothing.                                                                                                                                                                                                                                                                                     |
| **MOTIR-4855** (the E2E + acceptance video)              | The states the walk checks against — the footer, the disabled prev on page 1, the single-page and empty arms, and the Chinese strings its `zh` step reads.                                                                                                                                                                                                                                         | Nothing.                                                                                                                                                                                                                                                                                     |
| **MOTIR-4850** (the story)                               | Its own acceptance criteria, drawn.                                                                                                                                                                                                                                                                                                                                                                | Nothing.                                                                                                                                                                                                                                                                                     |
| **MOTIR-4781 / 4782** (`done`)                           | Nothing. This revision REPLACES two behaviours they delivered — `updatedAt DESC` and the keyset links — going forward; it does not re-open either card.                                                                                                                                                                                                                                            | Nothing. Their work shipped and is correct as shipped.                                                                                                                                                                                                                                       |
| **MOTIR-4778 / 4794** (the sibling story)                | Nothing new. The To-approve SLOT is still drawn once, here, and its rows are still that story's.                                                                                                                                                                                                                                                                                                   | Nothing — but note that the tab **inherits this pager for free** the moment MOTIR-4794 renders rows into the shared list. That is a fact about composition, not a deliverable of either card.                                                                                                |
| **the `design/work-items/` asset**                       | Nothing. It OWNS the control; this asset composes it and cites it.                                                                                                                                                                                                                                                                                                                                 | **A dependency worth naming:** if panel 5's navigator is ever re-specified, these five panels are downstream of it and are not a second opinion about it.                                                                                                                                    |
| **MOTIR-1307 / 2651 / 3171 / 3173 / 4779 / 4780 / 4783** | Nothing — named in prose as history or as context, not allocated work by this revision.                                                                                                                                                                                                                                                                                                            | Nothing.                                                                                                                                                                                                                                                                                     |

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
2. **A projectless reader is landed INSIDE the project-tier shell** — the
   finding this pass made, filed as its own card and NOT fixed here. Nothing
   seeds a default project, so a fresh account lands on this surface with none;
   `app/(authed)/layout.tsx` renders the shell anyway and two project-tier routes
   render a create-project door inside it. It also amends
   `docs/decisions/home-scope.md` §2.2 (which decided that door) and §2.3 (which
   rests on §2.2). **This is bigger than MOTIR-4783's sweep**, which re-addresses
   `/home` → `/workbench`: an address swap there would leave the record asserting
   a state this asset says does not exist.

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

---

## 20 · The To-approve tab's ROW — MOTIR-5147

**AMENDED by MOTIR-5147** (Story [MOTIR-4879](motir:cmtrwx30n0052hxphd0yqbnwb))
with the one element this area drew a SLOT for and deliberately left empty. It is
the layout source of truth for **MOTIR-4794** (the tab), which carries it in
`blocked_by`.

| Surface                        | Asset                                       | Notes                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The `To approve` tab's ROW** | **`approvals-row.mock.html`** (HTML mockup) | The row and every state it can be in: in situ · its anatomy · the disclosure · a treatment per `ApprovalGateState` · see-but-not-decide · refused in place · no-subject · narrow. Exports to `approvals-row.png`. |

**Panels:** 1 the tab in situ · 2 the row's anatomy · **3 the disclosure** ·
4 a row per `ApprovalGateState` · 5 see but not decide · 6 refused in place ·
7 the two rows with no subject · 8 narrow (`< md`).

### What this COMPOSES, and who owns each piece

**This asset draws the ROW and nothing else on the screen.** Two shipped assets
own the rest, and neither is re-decided here:

| piece                                                                                                                         | owner                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| the five-tab strip, the `To approve` label, its `Inbox` glyph, its count treatment, the tab's EMPTY state, the numbered pager | **`workbench.mock.html`** (this file, §§ _The tab strip_ · _The pager_ · _Empty states_) |
| the universal approval FRAME, in all nine of its states                                                                       | **`design/work-items/approval-control.mock.html`** (MOTIR-4789)                          |

The mock reproduces both from their own markup rather than redrawing them — the
strip and pager from `workbench.mock.html`, the frame from
`ApprovalGateControl`'s own emitted HTML, one dump per state. Its glyphs are
generated from the installed `lucide-react@1.16.0`'s icon nodes. The header
comment in the mock carries the full provenance.

**The tab's EMPTY state is NOT re-drawn here.** _Nothing is waiting on your
approval_ is already specified in § _Empty states_ above, with no action,
because nothing a reader can press conjures an approval. A second drawing of it
would be a second answer.

### The component contract this designed TO

**`components/approvals/ApprovalGateControl.tsx`**, and it is **PRESENTATIONAL**:
it fetches nothing, renders what it is fed, and `onDecide` resolves to a refusal
it draws IN PLACE rather than throwing. The props the row supplies:

| prop                                            | what the row supplies                                                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `gate`                                          | the `ApprovalGateDTO` behind the row                                                                                                     |
| `canDecide`                                     | the AUTHORITY answer — assignee, reporter when there is no assignee, or admin (ADR §2's 2026-09-11 amendment), never the routing one     |
| `kindLabel` / `subjectMeta`                     | band 1: _Design result_, and _Published 4 days ago · 3 files · `9840d00ea1b2`_ — where `subject.noteExcerpt` lands                       |
| `port`                                          | band 2, the subject RENDERED. **Its contents are the KIND's, not this asset's** — the mock draws a token stand-in, never a specification |
| `verbs` / `consequence` / `confirmConsequences` | band 3                                                                                                                                   |
| `routedToLabel`                                 | state `B`'s _waiting on_ line (Panel 5)                                                                                                  |
| `onDecide`                                      | records the decision; a `GateRefusal` comes back and the frame draws it (Panel 6)                                                        |

### WHICH FIELD each element of the row reads

Every cell names a field of `ApprovalQueueRowDto` (MOTIR-4791), so the row cannot
promise data the read has no producer for:

| element                         | field                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| kind glyph + _Design result_    | `row.kind`                                                                                              |
| _3 files · `9840d00ea1b2`_      | `row.subject.assetCount` · `row.subject.commitSha`                                                      |
| `MOTIR-5147` + title            | `row.workItem.identifier` · `row.workItem.title`                                                        |
| _4 days_                        | `row.waitingSince` (the gate's `createdAt`), relative in the cell and ABSOLUTE in its `title` attribute |
| the disclosure / the state pill | `row.state`, plus the frame's `canDecide`                                                               |

**`row.subject.noteExcerpt` is deliberately NOT on the row.** A 44px row carries
one line, better spent on which design and how long it has waited than on the
first sentence of its notes. It is the frame's `subjectMeta` when the row opens —
the same DTO, read one interaction later.

### The ROW is a DISCLOSURE — the question this card existed to answer

**The row opens, and the shipped frame renders inside the list.** One row open at
a time; opening a second closes the first.

Three candidates were live, and two are wrong for reasons already on the record:

- **Verbs on every row** — the frame's own first cut drew the BUTTON as the
  shared element and was rejected on review: _"Approve button without review
  doesn't stand — the user needs to see what he is approving."_ A 44px row cannot
  carry a rendered design, so verbs on it would be approving something you have
  not looked at.
- **Link to the item page** — defeats the tab, whose promise is that you stop
  needing to know which card to open.
- **Open in place** — keeps the port's floor, ceiling and Expand affordance
  unchanged, and keeps the list scannable between decisions.
  `approval-control.mock.html`'s Panel 0b already drew this door with a ghost row
  labelled _"the frame renders here"_; Panel 3 is that sentence, drawn.

### ⚠️ THE POST-DECISION BEHAVIOUR — SETTLED: a decided row SETTLES IN PLACE

[MOTIR-4879](motir:cmtrwx30n0052hxphd0yqbnwb) deferred this here by name. **The
rule, in one sentence: a decided row keeps its position, swaps its Decide cell
for a state pill, and leaves on the NEXT LOAD — it never vanishes under the
cursor.**

**Why.** This is a SHARED queue: routing shows a gate to one person, but ADR §2
lets an ADMIN press any gate, so a row can be decided by somebody else while you
are reading it. (Before §2's 2026-09-11 amendment the reporter of an ASSIGNED
item could press it too; narrowing that arm removed one route into this state and
not the state itself, so the rule below is unchanged.) A surface that sometimes removes a row
silently and sometimes explains one teaches the reader that **disappearance is
ambiguous**, which is the most expensive thing a queue can teach. And the frame
already refuses to vanish one interaction over — when somebody else decides
between render and press it draws the refusal IN PLACE (Panel 6) — so a list that
removed rows would contradict the panel inside it.

**What settling looks like:** the subject and work-item cells go
`--el-text-muted`, the Decide cell carries the state pill, and no verb remains —
a decided gate is immutable (ADR §6a), so there is nothing left to press. **The
strip count decrements immediately**, because the count and the list are one read
(MOTIR-4791) and the count is about what is AWAITING; the settled row is a
receipt, not a member. A reload removes it, because the read returns only
`awaiting` gates.

### Every state a row can be in

**Four are `ApprovalGateState`'s** (`prisma/schema.prisma`), so they are a
checklist rather than a judgement — Panel 4 draws one row per value:

| state               | treatment                                                           |
| ------------------- | ------------------------------------------------------------------- |
| `awaiting`          | the live row: full ink, the disclosure                              |
| `approved`          | muted ink, `--el-tint-mint` pill reading **Approved**               |
| `changes_requested` | muted ink, `--el-tint-peach` pill reading **Changes requested**     |
| `superseded`        | muted ink, **colourless** `--el-chip-bg` pill reading **Withdrawn** |

`superseded` is colourless deliberately: it is written by the PRODUCT, never by a
person, and a tinted pill would let a reader take a withdrawn question for
somebody's answer. Every pill carries its own WORD, so no state is signalled by
colour alone (finding #35).

**Three more are states of the ROW rather than of the gate**, and the mock draws
each:

- **See but not decide** (Panel 5) — the Decide cell names who it is waiting on
  and carries no verb; the frame renders its state `B`, port live and verbs
  absent. **The row still OPENS**: what is withheld is the DECISION, never the
  look.
- **Refused in place** (Panel 6) — somebody else decided between render and
  press. The frame's own refusal, naming who, with an unattributed arm for a
  decider whose account has gone.
- **Unregistered kind** (Panel 7) — `lib/approvalGates/registry.ts` registers
  `design_result` alone and names three declared holes. The row takes the
  colourless `circle-dashed` glyph, says **Not built yet** in words, NAMES the
  kind, and offers no disclosure because there is nothing behind it to open.

**And a FOURTH row state this asset adds, because the read can produce it:** a
gate whose **subject no longer resolves** (Panel 7, row two). A handler's
`resolveSubject` is documented to return null, so `ApprovalQueueRowDto.subject`
is nullable. _This build cannot render this kind_ and _the row this gate points
at is gone_ look alike and are opposite — the first is a feature that has not
shipped, the second is a gate worth withdrawing — so collapsing them would report
a shipped kind as unbuilt. Its affordance is **Open card**, not _Review_.

### Narrow (`< md`)

The four-column grid does not survive 388px. The row becomes two stacked lines in
the same list container — _subject + waited_, then _work item_ — with the Decide
affordance full-width beneath them where a thumb reaches it; 44px → 76px. **The
column-header band is dropped rather than re-flowed**: it labels a grid that no
longer exists, and a header reading _Work item_ above something that is not a
column is worse than no header. The strip above already scrolls at this width
(§ _Narrow: the strip SCROLLS_), which is why a fifth tab costs this surface
nothing.

### Token map — the row's own elements

| Element                      | Colour                                                                     | Shape                                   |
| ---------------------------- | -------------------------------------------------------------------------- | --------------------------------------- |
| kind glyph (`design_result`) | `--el-type-design` (the shipped design-type hue, `workItemTypeMeta.ts`)    | `h-4 w-4`                               |
| kind glyph (unregistered)    | `--el-text-faint`                                                          | `h-4 w-4`                               |
| kind label / subject meta    | `--el-text` / `--el-text-secondary`                                        | `text-sm` / `text-xs`                   |
| a SETTLED row's ink          | `--el-text-secondary` — see the AA note below                              | —                                       |
| work-item key / title        | `--el-text-secondary` (mono) / `--el-text`                                 | `font-mono text-xs` / `text-sm`         |
| waited                       | `--el-text-secondary`                                                      | `text-xs`                               |
| state pills                  | `--el-tint-mint` · `--el-tint-peach` · `--el-chip-bg` + `--el-chip-border` | `--radius-badge` · `--spacing-chip-x/y` |
| the disclosure               | `--el-text` on `--el-button-secondary-border`                              | `--radius-btn`                          |
| row / list container         | `--el-border`, hover `--el-surface`                                        | `--radius-card`, 44px rows              |

⚠️ **A SETTLED ROW'S INK IS `--el-text-secondary`, NOT `--el-text-muted` — AMENDED
2026-09-11 by MOTIR-4794, on the record.** The first cut of this table named
muted, and `tests/theme/inkContrastLint.test.ts` refused it on the build: muted
is **4.12–4.34:1 on `--el-surface`**, which is exactly this row's HOVER FILL, so
the ink would drop below AA in the one moment a pointer is on it. It clears AA
only on the white page/card. `WorkbenchList` records the identical pair for its
own identifier cell, which is the tell that this is a property of the SURFACE
rather than a mistake in this row. The guard caught it before a reader did, and
the asset is corrected rather than the guard exempted.

No raw hex and no raw shape utilities anywhere in the asset.

### What this asset does NOT decide

- **The tab's empty state** — § _Empty states_ above owns it.
- **The port's CONTENTS.** Band 2 renders the subject, and what a design result
  looks like inside it is MOTIR-4789's. The mock draws a token stand-in so the
  frame has something in band 2; it is not a specification.
- **A port for `decision_approval`, `pull_request_approval` or
  `pull_request_merge`** — each belongs to the story that registers that kind.
  This asset draws only the unregistered-kind row those will replace.
- **The item-page / board / list indicator** — [MOTIR-4908](motir:cmtt4ogn7000fhutx7zrhizuo).
- **The `zh` catalogue.** Every string here is a DRAFT for MOTIR-4794's catalog
  entry, not the catalog.

### GIVES / TAKES — every card this asset names

Scope, as § _The MOTIR-4851 revision's own sweep_ sets it: every `MOTIR-<n>` in
these notes plus the mock's annotation prose. The mock's SAMPLE ROW DATA is
excluded — those keys stand in for a reader's list.

| card                                        | GIVES                                                                                                                                                        | TAKES                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **MOTIR-4794** (the tab)                    | The row, its cells, the disclosure, a treatment per state, the settled post-decision rule, and the narrow reflow — so none of it is decided at the keyboard. | Nothing. It builds what is drawn here and owns the `en` + `zh` catalog, which this asset only drafts.      |
| **MOTIR-4791** (the read)                   | A drawn consumer for every field of `ApprovalQueueRowDto`, and the confirmation that `noteExcerpt` has a home (the frame) rather than a row cell.            | Nothing. Its predicate, its paging and its DTO are unchanged by anything drawn here.                       |
| **MOTIR-4879** (the story)                  | **The deferred post-decision decision, SETTLED** — the one thing it named as owed to this card.                                                              | Nothing.                                                                                                   |
| **MOTIR-4777 / MOTIR-4851** (the Workbench) | Nothing. Their slot, strip, empty state and pager are composed exactly as drawn.                                                                             | Nothing — and the boundary they stated four times is honoured: this asset draws the rows and not the slot. |
| **MOTIR-4789** (the frame)                  | Nothing it does not already own. Its Panel 0b's ghost row _"the frame renders here"_ is now a drawing.                                                       | Nothing. Band 2's contents stay its own.                                                                   |
| **MOTIR-4786 / MOTIR-4911** (the ADR)       | Nothing. Routing and authority are read from the record, not re-decided.                                                                                     | Nothing.                                                                                                   |
| **MOTIR-4907 / 4909 / 4910 / 4882**         | The not-built-yet ROW each of them replaces when it registers its kind — so a fourth kind is a renderer rather than a layout question.                       | Nothing.                                                                                                   |
| **MOTIR-4908 / MOTIR-4949 / MOTIR-2920**    | Nothing — named only as boundaries this asset does not cross.                                                                                                | Nothing.                                                                                                   |
| **MOTIR-5008**                              | Nothing — cited for its LESSON (a hand-typed sprite is a wrong glyph waiting for a reader who trusts its name), which is why every glyph here is generated.  | Nothing.                                                                                                   |
