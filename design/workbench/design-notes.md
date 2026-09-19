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

**AMENDED by MOTIR-5216** (Story
[MOTIR-5213](motir:cmtxm4uzd00ebhztxrhk7nfo3), 2026-09-13): **the strip is
RE-ORDERED** so To approve leads, and **the landing CASCADES** — the bare
`/workbench` resolves to the first of To approve · In progress · To do with
anything in it. Every tab becomes addressable and the bare path stops being one
of their addresses. § _21 · AMENDED by MOTIR-5216_ is the record; the sections
it changes carry a pointer to it. It is the layout source of truth for
**MOTIR-5217** (the order), **MOTIR-5218** (the addresses) and **MOTIR-5221**
(the resolver), which carry it in `blocked_by`.

| Surface                               | Asset                                          | Notes                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The `/workbench` landing page**     | **`workbench.mock.html`** (HTML mockup)        | The whole surface, multi-panel: the door · To do · In progress · Recently finished · Watching grouped · the all-empty page · every tab's empty state · narrow · **the pager, in five states**. Exports to `workbench.png`.                                                                                                                                        |
| **The `To approve` tab's ROW** (§ 20) | **`approvals-row.mock.html`** (HTML mockup)    | The row and every state it can be in. **Its disclosure is superseded by the overlay below** (§ 20's dated amendment). Exports to `approvals-row.png`.                                                                                                                                                                                                             |
| **The approval OVERLAY** (§ 22)       | **`approval-overlay.mock.html`** (HTML mockup) | An approval decided full screen over the tab, the frame edge to edge under the exit row: anatomy · a taller-than-the-screen subject and a short screen · see-but-not-decide · unregistered kind / subject gone · not available / loading · refused in place · narrow in `zh` · every `ApprovalGateState` · the row's new door. Exports to `approval-overlay.png`. |

**Panels:** A the door · **B the landing cascade** · 1 To do · 2 In progress · 3 Recently finished ·
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

**RE-DRAWN by MOTIR-5216** — the order and the addresses below are the amended
ones; § _21_ carries the reasoning.

| tab                   | glyph (lucide) | href                                                  |
| --------------------- | -------------- | ----------------------------------------------------- |
| **To approve**        | `Inbox`        | `/workbench?tab=approvals`                            |
| **In progress**       | `CircleDot`    | `/workbench?tab=in-progress`                          |
| **To do**             | `Circle`       | **`/workbench?tab=todo`**                             |
| **Recently finished** | `CircleCheck`  | `/workbench?tab=finished`                             |
| **Watching**          | `Star`         | `/workbench?tab=watching`                             |
| _the bare path_       | —              | **`/workbench` — a RESOLVER: forwards, names no tab** |

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
  why the link form was chosen over the client `Segmented`. ~~**To do is the
  DEFAULT and is therefore spelled as the ABSENCE of the param**, so a link to
  the Workbench and a link to To do are the same link (the shipped
  `lib/workbench/tab.ts` rule, carried).~~ **REPLACED by MOTIR-5216:** there is
  no default tab. The one-canonical-URL-per-tab rule is kept by making it TOTAL
  — every tab carries a `?tab=`, and `/workbench` resolves (§ _21_).
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

**MOTIR-5216 re-ordered the tabs and this verdict is UNCHANGED** — the same five
labels at the same type scale are still **662px** of track against a **386px**
content box, and an order cannot move either number. What does change: under the
cascade the landed-on tab is always one of the FIRST THREE, so the common case
needs little or no scroll to show it (§ _21_).

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
param** — ~~the same rule that makes To do the absence of `?tab=`~~ (MOTIR-5216
retired that half: every tab now carries `?tab=`; the page-1 half stands), so a
link to a tab and a link to its first page are one link.

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

**MOTIR-5216 changes NONE of the five** — and the In-progress action's target is
now spelled `/workbench?tab=todo`, because To do has an address of its own. See
§ _21_ for why no To-approve door was added.

---

## Copy (en)

| element               | copy                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------- |
| rail row              | **Workbench**                                                                          |
| page `h1`             | **Workbench**                                                                          |
| subtitle              | **"What you are doing in {project}, and what you have just done."**                    |
| window caption        | "Finished in the last 7 days. Older work stays on the item, and on the board."         |
| tab labels            | **To approve** · In progress · To do · Recently finished · Watching (MOTIR-5216 order) |
| Watching group labels | In progress · To do                                                                    |
| **pager**             | § _The pager_ → _The copy_ above has the five strings, with their `zh` values          |

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

**Both doors still name `/workbench`, and after MOTIR-5216 both reach a
RESOLVER** rather than a fixed tab — Panel B draws where it forwards. Neither
door moves.

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

> **⚠️ AMENDED 2026-09-13 by MOTIR-5222** (Story
> [MOTIR-5214](motir:cmtxm4v3600edhztx2s78ff0u)) — **the row no longer DISCLOSES;
> it OPENS THE APPROVAL FULL SCREEN, over the tab.** The overlay is § 22
> (`approval-overlay.mock.html`). What this amendment changes, and what it leaves
> exactly as it was:
>
> - **SUPERSEDED: _The ROW is a DISCLOSURE_ below** — its third candidate, _Open
>   in place_, and Panel 3's drawing of it. The row's whole-row control and its
>   _Review_ button now write the overlay's address instead of expanding the row,
>   and the chevron is removed (§ 22 Panel 9).
> - **Why.** This section weighed three candidates and picked the best of them. It
>   did not weigh a fourth: keep the reader on the tab and give the thing being
>   judged the screen. The frame's own standard is that you decide after you look,
>   and a 32rem sandboxed design, inside a 34rem port, inside a 44px row, under a
>   pager, is the smallest screen in the product on which to meet it. The overlay
>   meets it with the viewport, and keeps what _Open in place_ was chosen for: the
>   list is still scannable between decisions, because it is still mounted
>   underneath and closing returns to it exactly.
> - **UNTOUCHED: the _Link to the item page_ rejection.** It still stands, for the
>   reason it gives. The overlay is not that candidate — the reader never leaves
>   `/workbench`, the address only gains two parameters, and Back returns to the
>   tab rather than from a card.
> - **UNTOUCHED: _THE POST-DECISION BEHAVIOUR — SETTLED_.** A decided row keeps its
>   position, swaps its Decide cell for a state pill, the strip count decrements
>   immediately, and the row leaves on the NEXT load. Deciding inside the overlay
>   produces exactly that underneath it (§ 22 Panel 8).
> - **UNTOUCHED: every row state and its treatment** (Panels 4–8), the column set,
>   narrow and the token map — with one consequence: Panel 7's two no-subject rows
>   now open the overlay too, which draws them (§ 22 Panel 4), instead of offering
>   nothing to open.
> - **FORWARD-ONLY.** [MOTIR-4794](motir:cmtqhxiy5001hhvph7yp96e54) and
>   [MOTIR-5147](motir:cmtwycrzk002ahxtxe5j0w2q7) are `done` and are not
>   re-opened, re-scoped or amended: the disclosure shipped correct against the
>   design that was current when it shipped. MOTIR-5225 deletes it in the same pull
>   request that lands the door, so the abandoned path leaves with the migration.

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

> **⚠️ SUPERSEDED 2026-09-13 by MOTIR-5222** — the row opens the approval full
> screen (§ 22). Kept verbatim as the record of the decision it replaces; the
> reasoning for the change is the dated amendment at the head of § 20.

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

> **⚠️ AMENDED 2026-09-17 by MOTIR-5239** (Story
> [MOTIR-5238](motir:cmtxm4x2e00fwhztxbr4hkj9s)) — **this rule SURVIVES live-ness,
> and § 26 states the rule that makes it survive: _a nudge ADDS and UPDATES; it
> never REMOVES._** A list that re-read itself on a nudge would remove a row
> somebody else had just decided, because the tab reads `state = awaiting` — which
> is this rule being overturned by a mechanism rather than by a decision. Nothing
> below changes: what § 26 adds is the HELD row, for the case this section did not
> have to consider because nothing re-read itself. See § 26 ·
> `workbench--live.mock.html`, Panel 3.

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

---

## 21 · AMENDED by MOTIR-5216 — the strip RE-ORDERED, and the landing CASCADES

**AMENDED 2026-09-13 by MOTIR-5216** (Story
[MOTIR-5213](motir:cmtxm4uzd00ebhztxrhk7nfo3)). Two things change about this
surface and nothing else: **which tab a reader lands on, and in what order the
tabs sit.** No tab's content, row, column, pager, empty state or count treatment
changes. The asset is revised in place — `workbench.mock.html` re-drawn and
`workbench.png` re-exported — because the strip is ONE composition and a second
drawing of it would be a second answer.

### The strip ORDER

**To approve · In progress · To do · Recently finished · Watching**, each tab's
glyph travelling with it (`Inbox` · `CircleDot` · `Circle` · `CircleCheck` ·
`Star`). § _The tab strip_'s table is re-drawn in that order. Every panel that
draws the strip draws it in this order — panels 1–5, 7, 8 and the new panel B in
`workbench.mock.html`, **and** the eight in situ strips in
`approvals-row.mock.html`, whose rows (§ 20) are untouched: the strip there is
composed from this asset, and leaving it in the old order would put two answers
to one composition in the same folder.

**The strip order and the cascade order are deliberately the SAME order** — the
first three tabs are the three rungs, left to right. So the strip reads as an
explanation of where the reader just landed, rather than as a menu to search.

### THE LANDING CASCADE — a RESOLUTION, not a default (Panel B)

> **`/workbench` with no `?tab=` resolves to: To approve** if its count is
> non-zero → **else In progress** if its count is non-zero → **else To do.**

Four properties, stated once so MOTIR-5217, MOTIR-5218 and MOTIR-5221 do not each
decide them:

1. **Three tabs only.** Recently finished and Watching are NEVER landed on.
2. **To do is TERMINAL** — landed on even when its own count is 0. The cascade
   always resolves; there is no fourth outcome and no blank page.
3. **An explicit `?tab=` ALWAYS wins.** `?tab=approvals` renders To approve at 0,
   with its empty state, because the reader asked. An unknown, misspelled or
   hand-edited value is not an explicit choice: it falls into the cascade rather
   than 404-ing (the shipped land-rather-than-404 rule, re-pointed).
4. **The only input is the five counts the strip already reads**
   (`HomeTabCountsDto`). The cascade asks no new question of the data.

**How the bare path forwards — a redirect, or rendering in place — is
MOTIR-5221's to implement.** The asset owes the RULE and draws the bare path as
an entrance whose address bar ends on the resolved `?tab=`; it does not pick the
mechanism.

### EVERY TAB IS ADDRESSABLE, and `/workbench` is not one of the addresses

| tab               | its one address                                        |
| ----------------- | ------------------------------------------------------ |
| To approve        | `/workbench?tab=approvals`                             |
| In progress       | `/workbench?tab=in-progress`                           |
| To do             | **`/workbench?tab=todo`** (new)                        |
| Recently finished | `/workbench?tab=finished`                              |
| Watching          | `/workbench?tab=watching`                              |
| _the bare path_   | `/workbench` — **resolves and forwards; names no tab** |

**This REPLACES the paramless-default convention; it does not bend it.** The
shipped rule is _one canonical URL per tab_, implemented by spelling the default
tab as the absence of `?tab=`. That implementation assumed the default was fixed.
Under a cascade the paramless address names a different tab for different
readers on different days — one spelling naming many views, which is the
ambiguity the rule exists to forbid, arriving from the other direction. So the
rule is kept by making it TOTAL: every tab carries its own `?tab=`, no tab has two
spellings, and the special case is gone. `?page=` is unaffected — page 1 is
still the absence of that param.

### Panel 5 is now the cascade's TERMINAL — the verdict

Panel 5 drew the all-empty page as a rare state a new reader found by looking.
After this change it is **exactly what a brand-new member is landed on,
immediately after sign-in, on the To do tab**: every count is 0, rungs 1 and 2
fall through, and rung 3 is terminal.

**Verdict: To do's shipped empty state STANDS as the landing.** It is the one
empty state of the five that carries a way forward (_Find something to start_ →
`/ready`), which is the best thing a first screen with nothing on it can offer.
The count suppression stands too: five `0`s on a first screen are still five
numbers to discard.

**The panel is REDRAWN, and that is a correction to the drawing, not a change to
the state.** It drew _"Nothing is waiting on you"_ under a `CircleCheck` glyph — a
pre-split empty that no tab renders, and the very phrase MOTIR-2758 was filed
against. It now draws what `EmptyTab` renders for To do on `origin/main`: the
`Circle` glyph, _Nothing to start_, the shipped body and the `/ready` action. In
the same pass the body lines of Panel 6's To do, In progress, Recently finished
and To approve empty states were brought into agreement with the shipped
`workbench.empty.*` catalog they had drifted from. Titles, glyphs and actions
were already correct; no state gains or loses anything.

### The five EMPTY STATES are UNCHANGED — and the To-approve door is DROPPED

An earlier cut of this work drew **a door from the To-approve empty state to To
do**, because landing on _"Nothing is waiting on your approval"_ with nowhere to
go is a dead end. **The cascade removes that dead end at the root, so the door is
not drawn.** A reader now reaches an empty To approve only by asking for it, and
§ _Empty states_' decision — three of the five carry no action, _"because nothing
a reader can press conjures an approval"_ — stands untouched. Verified on
`origin/main`: `EmptyTab` gives To do a `/ready` link and In progress a To-do
link, and the other three nothing. Named here so the next reader does not read
the absence as an oversight.

### Narrow (`< md`) — unchanged

§ _Narrow: the strip SCROLLS_ measured a **386px** content box against **662px**
of track. A re-order moves neither number, so the scroll verdict stands. The one
thing that changes: the landed-on tab is always among the first three, so the
browser rarely has to scroll it into view.

### COMPOSITION boundary — what this amendment does not redraw

- **Panel A owns the ACCESS PATH.** The rail row and `AUTHED_LANDING_PATH` still
  name `/workbench`; they now reach a resolver rather than a fixed tab. Composed,
  not redrawn.
- **§ 20 owns the To-approve ROWS** (`approvals-row.mock.html`). Its strip is
  re-ordered; its rows, disclosure and states are not touched, and neither is the
  disclosure-vs-overlay question, which is MOTIR-5214's own amendment.
- **`design/work-items/approval-control.mock.html` owns the FRAME.** Not this
  area's; not touched.
- **Every tab's CONTENT** — columns, the `< md` row collapse, the Watching bands,
  the Finished column and caption, the pager and its five states — composed
  unchanged.

### GIVES / TAKES — every card this amendment names

Scope as § _The MOTIR-4851 revision's own sweep_ sets it: every `MOTIR-<n>` this
section and the mock's new annotation prose name, plus MOTIR-5213's whole subtree.

| card                                  | GIVES                                                                                                                                                      | TAKES                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **MOTIR-5217** (the order)            | The ORDER and the per-tab glyph assignment — nothing else. It changes no address and no landing.                                                           | Nothing.                                                                                                    |
| **MOTIR-5218** (the addresses)        | The six-row address table: all five `?tab=` spellings including `todo`, and the statement that `/workbench` is no longer a tab address.                    | Nothing.                                                                                                    |
| **MOTIR-5221** (the resolver)         | The cascade's ORDER, its THREE-tab scope, its TERMINAL, the explicit-`?tab=`-wins rule and unknown-value-falls-in — the rule, stated once.                 | **The mechanism is its own** — redirect or render in place. The asset draws where the reader ends, not how. |
| **MOTIR-5219** (the vitest gate)      | The invariants a percentage cannot see: one address per tab, none for the bare path, and a cascade total over every count combination.                     | Nothing.                                                                                                    |
| **MOTIR-5220** (the E2E + video)      | The walk: land on To approve, then In progress, then To do; ask for an empty tab by address. Panel B's five frames are its five beats.                     | Nothing.                                                                                                    |
| **MOTIR-5213** (the story)            | Its acceptance criteria, drawn.                                                                                                                            | Nothing.                                                                                                    |
| **MOTIR-4879 / MOTIR-4794** (the tab) | Nothing new. The To-approve COUNT the cascade's first rung reads is theirs, as shipped.                                                                    | **Nothing from § 20's row decision** — the rows, the disclosure and every state are composed as drawn.      |
| **MOTIR-5214** (decide full screen)   | Nothing. What a row does when pressed is its own; this amendment is correct whether a row opens in place or full screen.                                   | Nothing.                                                                                                    |
| **MOTIR-4777 / MOTIR-4851** (`done`)  | Nothing. The strip, empty states and pager they drew are composed; the paramless-default convention they carried is REPLACED going forward, not re-opened. | Nothing.                                                                                                    |
| **MOTIR-2758**                        | Nothing — cited for the phrase Panel 5's old drawing repeated.                                                                                             | Nothing.                                                                                                    |
| **MOTIR-4908 / MOTIR-5238**           | Nothing — boundaries this amendment does not cross (the pending indicator; the live strip).                                                                | Nothing.                                                                                                    |

---

## 22 · The approval OVERLAY — MOTIR-5222

**AMENDED by MOTIR-5222** (Story [MOTIR-5214](motir:cmtxm4v3600edhztx2s78ff0u))
with the surface § 20's row now opens: **an approval decided full screen, over the
page you are on**. It is the layout source of truth for **MOTIR-5224** (the overlay
host) and **MOTIR-5225** (the row door), which carry it in `blocked_by`, and the
container **MOTIR-5382** draws its approve-to-merge port into.

**REVISED 2026-09-13 on review (PR #2864):** the cutaway panel is gone (a full-size
dialog hides the tab entirely, so drawing it behind the scrim faked a view nobody
gets); **the overlay IS the container**, so the frame's bands run edge to edge under
the exit row with no gutter, no centred column and no card chrome; and **"Design
result" appears once**, in band 1. Panels renumbered accordingly.

| Surface                  | Asset                                          | Notes                                                                                                                                                                                                                                                                     |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The approval OVERLAY** | **`approval-overlay.mock.html`** (HTML mockup) | Anatomy · a subject taller than the screen, and a short screen · see but not decide · unregistered kind / subject gone · not available / loading · refused in place · narrow in `zh` · every `ApprovalGateState` · the row's new door. Exports to `approval-overlay.png`. |

**Panels:** 1 the anatomy · 2a a subject taller than the screen · 2b a short screen ·
3 see but not decide · 4a a kind this build cannot render · 4b a subject that no
longer resolves · 5a the address names nothing this reader may see · 5b loading ·
6 refused in place · 7 narrow (`< md`), in `zh` · 8a approved · 8b changes requested ·
8c superseded · 9 the ACCESS PATH — the row once its disclosure is gone.

### Why an overlay, and why THIS overlay

§ 20's dated amendment carries the argument: the frame asks to be decided after it
is looked at, and the viewport is the cheapest way to make the look real. What this
section adds is that **the pattern is not new** — the planning workspace
([MOTIR-4726](motir:cmtpk3r5o0097hvn8brknuwxq) / MOTIR-4729) and the run modal
([MOTIR-3893](motir:cmteb0te7001mhvn8qbialic7) / MOTIR-3895) already open something
full screen over the page you are on, addressed by the URL and closed by Back.
`components/planning/PlanningWorkspaceOverlay.tsx` wrote its reasoning down, and
this asset follows it rather than choosing again: **the open state IS the address
and is held nowhere else**, it is the shipped `Modal` rather than a hand-rolled
layer, and every close goes through one function.

**The page underneath is never left.** `Modal size="full"` portals its scrim and
panel over the Workbench; the To-approve tab — its filters, its page, its scroll and
its client islands — stays mounted behind the dialog and is **restored exactly on
close**, because nothing was unmounted. The asset does not draw that tab behind the
scrim: at full size, with no inset, none of it is visible, and a drawing that showed
it would be drawing a view nobody gets.

### What this COMPOSES, and who owns each piece

**This asset draws the CONTAINER and nothing inside the frame.** The mock is built
from emitted markup, not redrawn: every frame is `ApprovalGateControl`'s own HTML,
rendered through the repo's vitest + RTL setup inside the shipped `Modal` and dumped
from `document.body`, one dump per state; the exit row's Close control is
`PlanningWorkspaceHost`'s class for class; Panel 9's tab is `approvals-row.mock.html`'s
Panel 1 with the two row edits this section makes. The mock's header comment carries
the provenance and the fill-form edits (below).

| piece                                                                               | owner                                                                                              |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| the dialog — `Modal size="full"`, scrim, focus trap, `Esc`                          | `components/ui/Modal.tsx` over `@motir/design-system` — **composed**                               |
| the approval FRAME, its three bands, nine states, confirm band and refusal          | `design/work-items/approval-control.mock.html` (MOTIR-4789) · `ApprovalGateControl` — **composed** |
| band 2's CONTENTS                                                                   | the gate KIND's — a design result's port, and later MOTIR-5382's Development block                 |
| the settings door in band 3 (MOTIR-5176, panel `S`)                                 | the frame asset — it renders here wherever the frame renders it                                    |
| the exit row, the address, the fill form, the three frameless arms, loading, narrow | **this section**                                                                                   |
| the row's door                                                                      | **this section**, Panel 9 — built by MOTIR-5225                                                    |

### THE ADDRESS — settled here, once, because three cards read it

**Two parameters, NAMESPACED**, for the reason `lib/planning/launcher.ts`'s
`OVERLAY_PARAM_NAMES` block records in full: the overlay opens on ANY authed route,
so its query rides beside the host page's own, and the obvious names are taken —
`?peek=`, `?run=`, `?item=`, `?tab=`, `?mode=`, `?from=`, the planning overlay's
`plan*`. Measured at `origin/main` `3a5b8a7f9`: no file under `app/`, `components/`
or `lib/` reads `approval` or `approvalKind` from a query.

| parameter          | carries                                                                                                                                                                                                                                    | values                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| **`approval`**     | **the presence switch AND the work item's identifier.** Its presence is what opens the overlay — one `has('approval')`, the way `?peek=<key>` and `?run=<id>` each own one word                                                            | `MOTIR-<n>`                    |
| **`approvalKind`** | **the gate kind.** Required. An absent value, or one that is not a member of `ApprovalGateKind`, opens the overlay on Panel 5a — never a guessed kind, because a work item can carry more than one gate and a guess can open the wrong one | a member of `ApprovalGateKind` |

**A gate is addressed by (work-item identifier, gate kind), not by a gate id —
because `approvalGatesService.getForWorkItem({ workItemId, kind })` is the only gate
read that ships.** `lib/services/approvalGatesService.ts` has `getForWorkItem`,
`getAwaitingForWorkItem`, `listAwaitingMe`, `countAwaitingMe` and `decide`, and the
repository underneath reads `findLatestByWorkItem(workItemId, kind)`; there is no
read by id. The pair also means an address survives a republish: a superseded gate
is replaced by a newer `awaiting` one on the same (item, kind), and the same link
opens the current question — the frame's own §6c pin keeps the decision honest about
which bytes it was.

- **Close strips exactly these two** and leaves every other parameter byte-identical,
  so _back to exactly where you were_ is true of a filtered, paged tab and not only
  of a bare route.
- **Written with `shallowPush`** — the page underneath is already in the browser
  (CLAUDE.md § _URL state the CLIENT reads_) — which leaves a history entry, which is
  what makes Back close it with no code watching.
- **Arriving COLD** (a pasted link): the host page renders first and the overlay opens
  over it, reading the query on the client and fetching its own gate over HTTP
  (MOTIR-5223). **Arriving SIGNED OUT**: the sign-in hop carries the whole address in
  `next=`, overlay query included.
- **The code constant is the single copy in code**, beside the host (MOTIR-5224) —
  this table is the single copy in prose. Renaming one is a change to this section first.

### THE EXIT — one row, four exits, ONE close

**`hideClose` suppresses the dialog's corner ✕.** The overlay carries its own exit
row, top-LEFT, exactly as the planning workspace does: two Closes in one dialog is a
question nobody should be asked, and the product already taught this one.

| exit             | what it is                                                   |
| ---------------- | ------------------------------------------------------------ |
| **Close**        | the control top-LEFT, with its `Esc` chip                    |
| **`Esc`**        | the DIALOG's handler (Radix)                                 |
| **the scrim**    | at full size the panel covers it; the path exists for parity |
| **browser Back** | a `popstate` whose query no longer carries `approval`        |

**All four land on ONE `requestClose()`**, which strips the two parameters with
`shallowPush` — so a later guard has one seam to intercept, as MOTIR-4731's
close-with-pending guard does on the planning overlay. **This overlay has nothing to
guard today**: a half-made decision is not state — the confirm band is one press from
nothing, and a refusal is already recorded server-side. **`Esc` while the confirm band
is open closes the overlay**, like any other `Esc`: the band is inline, not a dialog,
and there is no second key handler to arbitrate. **Focus returns to the element that
opened it** — the row, or its _Review_ button — recorded when the address changed,
because a door that writes a URL is not Radix's `Trigger`.

**The exit row names the WORK ITEM, not the kind**: _Close_ and its chip, then the
item's key (mono) and title, then **_Open work item_** — the one way out that LEAVES
the tab, a real link to `/items/<key>`, deliberately quiet, right-aligned. **In Panel
5a the row carries no work item at all**: the key in the address is the reader's own
text, and echoing it beside a refusal reads as a confirmation.

### "Design result" appears ONCE

**The kind's label lives in band 1 and nowhere else on screen.** An earlier revision
also put the kind's glyph and label in the exit row, so the reader met _Design result_
twice in 100px. The row now carries the work item; band 1 keeps _Design result ·
version … · state pill_ **byte-identical to the frame on the item page**, which is the
point of composing it. The dialog's accessible name keeps the kind —
`approvalOverlay.dialogTitle`, _{kind} for {key}_, as the sr-only title — because a
screen reader lands in the dialog before it reaches band 1.

**Checked against the real port, not the stand-in:** `DesignResultPanel`
(`app/(authed)/items/[key]/_components/DesignResultPanel.tsx` on `origin/main`) renders
no kind heading of its own — its parts are titled _Design note_, _Design mock —
{path}_ and _Screenshot_ (`designResult.note` / `.frameTitle` / `.screenshots`). The
label's other home on the item page is the SECTION CARD around the frame
(`LateSections` → `ContentSectionCard title={designResult.title}`), which is why the
item page shows it twice and **the overlay, which has no section card, shows it once**.
No third occurrence arises, so nothing in the port needs de-duplicating.

### THE FILL FORM — the overlay IS the container

**The frame is composed; what changes is its BOX, never its contents.** Stated per
element, because the frame's port mechanics are its design and not a detail:

| element                                             | in a row (§ 20)                                  | in the overlay                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| the frame's card chrome                             | `overflow-hidden rounded-(--radius-card) border` | **REMOVED** — `flex min-h-0 flex-1 flex-col overflow-hidden`: no radius, no border; the bands run edge to edge on the dialog's `--el-page-bg`  |
| a gutter / centred column around the frame          | —                                                | **NONE** — the frame sits directly under the exit row; the dialog body is `flex min-h-0 flex-1 flex-col` and nothing else                      |
| `PORT_FLOOR` (`min-h-[12.25rem]`)                   | kept                                             | **DROPPED** — exactly as the frame's own expanded form drops it: the viewport is the box, so a floor could only push band 3 off a short screen |
| `PORT_CEILING` (`max-h-[34rem]`)                    | kept                                             | **LIFTED** — the port is `flex-1`; the remaining viewport is its ceiling                                                                       |
| the in-frame **Expand** affordance                  | offered in state `A`                             | **NOT OFFERED** — the overlay IS the expanded form; an Expand inside it would open a 90vw dialog over a 100vw one                              |
| the port box                                        | `relative min-h max-h overflow-y-auto`           | `relative flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4` — the component's expanded arm verbatim (`Modal.Body`'s recipe)              |
| band 1, band 3, every state, verb, confirm, refusal | the frame's                                      | **the frame's, byte-identical**                                                                                                                |

**ONE vertical scroll owner, always band 2.** The dialog is a flex column: the exit
row, then the frame at `min-h-0 flex-1`, then inside it band 1, the port at
`min-h-0 flex-1`, and band 3 — so band 3 sits on the bottom edge of the screen
whatever the subject's height and whatever the screen's. **Why the floor goes too:**
in a row the frame's height comes from its content, so a floor stops a short subject
collapsing; in the overlay the height comes from the VIEWPORT, so a floor could only
push band 3 below the panel, where `overflow-hidden` clips it. The frame's own
`expanded` arm reached the same conclusion (_"expanded, the viewport is the ceiling"_);
the fill form is that arm without its fixed wrapper and without its card.

**Measured** in Chromium against the mock (each panel's own viewport box, 1× scale):

| viewport                | exit row | band 1 | port (client / scroll) | band 3 (top–bottom) | what scrolls                        |
| ----------------------- | -------- | ------ | ---------------------- | ------------------- | ----------------------------------- |
| 1136 × 720 (Panel 1)    | 51       | 50     | 562 / 568              | 663 – 720           | the port                            |
| 1136 × 720, tall (2a)   | 51       | 50     | 562 / 3168             | 663 – 720           | the port; band 3 does not move      |
| 1136 × 360, tall (2b)   | 51       | 50     | 202 / 3168             | 303 – 360           | the port; band 3 still on the edge  |
| 1136 × 620, state B (3) | 51       | 50     | 475 / 568              | 576 – 620           | the port                            |
| 388 × 760, `zh` (7)     | 49       | 102    | 525 / 568              | 676 – 760           | the port; band 1 and the verbs wrap |

Against the previous revision's 1136 × 720 the port gains **50px** (512 → 562): the
48px of body gutter and the frame's 2px of border are band 2's now.

### The three arms that mount NO frame — and loading

**The overlay is TOTAL over `ApprovalGateKind`.** Three answers have nothing to decide
after, and for each the frame is **not mounted**: band 3 sits below the port, and a
port with nothing in it would put live verbs under nothing. Each is the shipped
`EmptyState` primitive, centred in the body with `--spacing-card-padding` around it,
under the exit row.

| arm                                      | when                                                                                                                      | what it says, and its one action                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **4a · a kind this build cannot render** | `approvalKind` is in `UNREGISTERED_GATE_KINDS`                                                                            | `CircleDashed` · _Motir cannot show this kind yet_ · names the kind · _Not built yet_ · **Open work item** |
| **4b · the subject no longer resolves**  | a registered kind whose handler's `resolveSubject` answers null                                                           | `FileX2` · _The design this asked about is gone_ · **Open work item**                                      |
| **5a · nothing this reader may see**     | the read answers 404 — no such item, another workspace, not browsable, no gate of that kind, or an invalid `approvalKind` | `Lock` · _This approval is not available_ · **Close** (primary) — no work item in the exit row             |

**4a and 4b look alike and are opposite** — § 20's Panel 7 distinction, carried up a
level: the first is a feature that has not shipped, the second is a gate worth
withdrawing. **5a is ONE answer for "does not exist" and "not yours to see"**, because
the read returns one 404 for both (MOTIR-5223's no-existence-leak contract) and a
second message would say which. **The page behind it never 404s** — there is no route
to fail.

**5b · loading**: the read has not answered. The exit row shows Close alone, and the
body draws the frame's three bands as muted blocks at their real proportions, edge to
edge like the frame they stand in for (`--el-muted`, `animate-pulse`, `aria-busy` with
_Loading the approval_), so an answer that arrives does not reflow the screen.

### After a decision — § 20's rule, unchanged, reached from a different surface

**Deciding does not close the overlay.** The frame re-renders with the decided record
the write returned (Panels 8a–8c) — the reader sees what they did on the screen they
did it on. Underneath, **in the same reconcile and with no reload**: the row settles in
place with its state pill and no verb, and the strip count is one lower. Closing then
reveals exactly that. **What reaches each surface** (CLAUDE.md § _Page state after a
mutation_):

- **the frame in the overlay** — the decided gate from the write's own response (case 1);
- **the strip count** — server-rendered, so `router.refresh()` (case 2), riding the
  decide action's own revalidation as MOTIR-5118 measured is needed;
- **the row underneath** — `ApprovalsList` is a CLIENT island whose row holds its
  decided gate in its own state (case 3): a decision made OUTSIDE that island needs an
  explicit signal the island watches. See planning flag 2.

### Narrow (`< md`)

Panel 7, drawn in `zh`. The frame is already edge to edge at every width, so narrow
changes only the exit row: the `Esc` chip is hidden (there is no key to press on a
phone), the item TITLE leaves the row, which keeps _Close_ and the key, and **_Open work
item_ becomes its icon**, with the label kept as its accessible name. Band 2 still owns
the scroll, band 1 wraps its meta line under the kind, and band 3 wraps its sentence
above the verbs — the frame already does both.

### Token map — the overlay's own elements

| Element                | Colour                                                                  | Shape                                                   |
| ---------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| scrim                  | `--el-overlay-scrim`                                                    | —                                                       |
| dialog panel           | `--el-page-bg`, no border — **the ground the frame's bands sit on**     | `rounded-none` — full size overrides `--radius-modal`   |
| exit row               | `--el-surface`, bottom `--el-border-soft`                               | `px-4 py-2`                                             |
| Close · Open work item | `--el-text-secondary`; hover `--el-text` on `--el-surface-soft`         | `--radius-control` · `--spacing-control-x/y`            |
| `Esc` chip             | `--el-text-secondary`, border `--el-border`                             | `--radius-kbd` · `--spacing-kbd-x/y`                    |
| exit-row key · title   | `--el-text-secondary` (mono; 6.24:1 on `--el-surface`) · `--el-text`    | `text-xs` · `text-sm`                                   |
| frame, fill form       | none of its own — no border, no radius, no fill; bands keep their rules | edge to edge                                            |
| frameless arms         | `EmptyState`: `--el-icon-muted` · `--el-text` · `--el-text-subtitle`    | `Card`, inset by `--spacing-card-padding`               |
| _Not built yet_        | `Pill tone="archived"`                                                  | `--radius-badge`                                        |
| skeleton blocks        | `--el-muted`                                                            | `--radius-control` · `--radius-badge` · `--radius-card` |

**Removed in this revision:** the body's `--el-surface-soft` ground and its
`px-3 py-3` / `md:px-6 md:py-6` gutter, the `max-w-[72rem]` column, the frame's
`--radius-card` + `--el-border`, and the exit row's kind glyph (`--el-type-design`) and
label. No raw hex and no raw shape utilities in the asset. The board's own chrome (the
viewport boxes and the numbered pins in Panel 1's margin) is review chrome with
`--el-text` / `--el-text-secondary` inks only.

### Copy — `en` and `zh`

Named here because no component ships them yet; MOTIR-5224 owns the catalog entry.
**Reused, not re-keyed:** `common.close`; `workbench.approvals.kind.*` (in the dialog's
accessible name and in arm 4a), `.notRenderable`, `.subjectGone`, `.notBuiltYet`; every
`approvalGate.*` string the frame already renders — including band 1's
`approvalGate.designResult.kindLabel`, the one visible _Design result_.

| key                                  | en                                                                                                                                          | zh                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `approvalOverlay.escKey`             | Esc                                                                                                                                         | Esc                                                                            |
| `approvalOverlay.dialogTitle`        | {kind} for {key} — **sr-only**, the dialog's accessible name; never rendered visibly                                                        | {key} 的{kind}                                                                 |
| `approvalOverlay.openWorkItem`       | Open work item                                                                                                                              | 打开工作项                                                                     |
| `approvalOverlay.loading`            | Loading the approval                                                                                                                        | 正在加载审批                                                                   |
| `approvalOverlay.notAvailable.title` | This approval is not available                                                                                                              | 此审批不可用                                                                   |
| `approvalOverlay.notAvailable.body`  | It may no longer exist, or you may not have access to it. The page behind this is unchanged.                                                | 它可能已不存在，或你没有访问权限。后面的页面没有变化。                         |
| `approvalOverlay.notRenderable.body` | This is a {kind} approval. It will open here once Motir can show that kind — nothing you did caused this.                                   | 这是一项{kind}审批。Motir 支持展示此类型后，它会在这里打开——这不是你造成的。   |
| `approvalOverlay.subjectGone.body`   | The design was removed after this approval was asked for, so there is nothing here to approve. Open the work item to see what it holds now. | 此设计在发起审批后被移除，这里已没有可批准的内容。打开工作项查看它现在的内容。 |

### The ACCESS PATH — the row's new door (Panel 9)

- **The chevron is removed.** It promised the row would grow, and it no longer does.
- **The whole row is the door**: a real `<a href="/items/<key>" aria-haspopup="dialog">`
  over the row, whose **plain primary click** writes the overlay address with
  `shallowPush` and whose **modified or middle click** opens the card in a new tab —
  exactly `usePeekRowClick`'s contract for `?peek=`, so the two cannot collide: the row
  writes `approval`, never `peek`.
- **The _Review_ button survives** as the labelled door a keyboard and a screen reader
  find, and opens the same address.
- **The work-item cell stays** the one link that visibly leaves, above the row on `z-10`.
- **Every row has the door**, including a settled, not-built or subject-gone row: they
  open Panels 8, 4a and 4b. The Decide cell keeps § 20's treatment per state.

### What this asset does NOT decide

- **The frame's states, verbs, confirm band or refusal** — MOTIR-4789's, composed.
- **Band 2's contents** — the kind's. The mock draws § 20's token stand-in.
- **The gate record, the decide door, routing or authority** — MOTIR-4778 / MOTIR-4786,
  as amended by MOTIR-5192 and MOTIR-5292. Read, not touched.
- **The item page's door** — [MOTIR-5215](motir:cmtxm4v6g00efhztx79g9zyar), which
  composes this overlay and writes this address.
- **The pending-decision indicator** — [MOTIR-4908](motir:cmtt4ogn7000fhutx7zrhizuo).
- **The approve-to-merge port** — MOTIR-5382, which draws INTO this container.
- **The item page's own double label** (section card title + band 1) — outside this
  surface; recorded above, not changed.
- **The `zh` catalogue** — the strings above are drafts for MOTIR-5224's entry.

### GIVES / TAKES — every card this asset names

Swept over MOTIR-5214's whole subtree (5222–5227, 5382–5385) and every other key in
this section and the mock's prose, on the ELEMENT, STRUCTURE and PREMISE axes.

| card                                                                  | GIVES                                                                                                                                                                                                          | TAKES                                                                                                                                                                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-5214** (the story)                                            | The design half of its criteria: the address, the one close, band 2 at viewport height, totality over the kind enum, the one-answer not-available arm, narrow, `en` + `zh`.                                    | **PREMISE:** _"composes `ApprovalGateControl` unmodified"_ holds for every state, verb, band and decide path, and needs ONE presentational layout input to select the fill form — planning flag 1.                  |
| **MOTIR-5223** (the read)                                             | A drawn consumer for each distinct answer it produces: gate + subject, no subject (4b), unregistered kind (4a), 404 (5a).                                                                                      | Nothing. Its query names are its own and need not match `approval` / `approvalKind`.                                                                                                                                |
| **MOTIR-5224** (the host)                                             | The anatomy, the exit row (Close + key + title + Open work item), the two parameter names, `hideClose`, the one `requestClose()`, the chrome-less fill form, the frameless arms, loading, narrow and the copy. | **PREMISE:** the fill form is a layout input on the frame (planning flag 1). Nothing else.                                                                                                                          |
| **MOTIR-5225** (the row door)                                         | The row once its disclosure is gone (Panel 9), and the post-decision reconcile it must carry into its island.                                                                                                  | **ELEMENT:** the disclosure, the chevron and the in-list frame — already its scope to delete. **STRUCTURE:** § 20 Panel 7's no-subject rows now open the overlay rather than offering nothing. **PREMISE:** flag 2. |
| **MOTIR-5226** (the vitest gate)                                      | The seams to assert: ONE close, the frameless arms read from `UNREGISTERED_GATE_KINDS`, the fill form's scroll container, and _Design result_ rendered once.                                                   | Nothing.                                                                                                                                                                                                            |
| **MOTIR-5227** (the acceptance E2E)                                   | The walk, in `en` and `zh`, and where each assertion lands: the port, the decided record, the settled row, the count.                                                                                          | Nothing.                                                                                                                                                                                                            |
| **MOTIR-5382 / 5383 / 5384 / 5385** (approve-to-merge in the overlay) | The container — edge to edge, band 2 at viewport height — and the settings door staying in band 3.                                                                                                             | Nothing — MOTIR-5382 draws INTO this container rather than redrawing it.                                                                                                                                            |
| **MOTIR-5215** (the item page's door)                                 | The overlay it composes and the address it writes.                                                                                                                                                             | Nothing.                                                                                                                                                                                                            |
| **MOTIR-4794** (the Approvals tab) · `done`                           | Nothing.                                                                                                                                                                                                       | **ELEMENT:** the disclosure and the chevron. **Not amended**: a `done` card is immutable history, and it shipped correct against the design current at the time. The supersession is § 20's dated amendment.        |
| **MOTIR-5147** (the row's design) · `done`                            | Nothing.                                                                                                                                                                                                       | **STRUCTURE:** _Open in place_. Superseded forward by § 20's amendment; its post-decision rule and every row state are untouched.                                                                                   |
| **MOTIR-4789 / 4792 / 5032 / 5033** (the frame)                       | A fourth mount context, and the answer to MOTIR-5032's recorded want — _a reader in `B` who wants the whole viewport_ — without an Expand in state `B`.                                                        | **PREMISE:** in the fill form the frame drops its card chrome and does not offer Expand. Its bands, states and its own asset are unchanged.                                                                         |
| **MOTIR-4778 / 4786 / 5192 / 5292** (the gate, its authority)         | Nothing.                                                                                                                                                                                                       | Nothing — `canDecide` is still the read's answer.                                                                                                                                                                   |
| **MOTIR-4726 / 4729 / 4731 / 3893 / 3895** (the precedents)           | Nothing — cited for the pattern and its reasoning.                                                                                                                                                             | Nothing.                                                                                                                                                                                                            |
| **MOTIR-5176** (the settings door)                                    | Nothing.                                                                                                                                                                                                       | Nothing — its door renders in band 3 wherever the frame does.                                                                                                                                                       |
| **MOTIR-5118 / MOTIR-5160**                                           | Nothing — cited for the page-state contract a decision must meet.                                                                                                                                              | Nothing.                                                                                                                                                                                                            |
| **MOTIR-4908 / MOTIR-5299 / MOTIR-5300**                              | Nothing — boundaries this asset does not cross.                                                                                                                                                                | Nothing (flag 3 names the one open question).                                                                                                                                                                       |

### ⚠️ Planning flags — surfaced by this pass

1. **The fill form needs ONE presentational input on `ApprovalGateControl`.** The frame
   has no prop that gives it the viewport: its only viewport-sized form is its internal
   `expanded` state, which wraps the frame in its own fixed dialog and keeps its card.
   The overlay needs that port recipe **without** the wrapper, **without** Expand and
   **without the frame's own container chrome** (no `--radius-card`, no border — the
   overlay is the container) — a layout input such as `layout: 'inline' | 'fill'`,
   adding no state, verb, band or decide path, so
   `tests/approval-gate-one-language.test.ts` is unaffected. **MOTIR-5224** should name
   the input and both halves of what `fill` means in its criteria, and **MOTIR-5214**'s
   _"composed unmodified"_ should read as _no new state, verb, band or decide path_.
2. **A decision made in the overlay must reach the row's CLIENT island.** Today
   `ApprovalsList`'s row settles because its OWN `onDecide` sets its own gate state.
   Decided from the overlay, that island is not the caller, so `router.refresh()` alone
   cannot settle it (case 3 of the page-state contract). **MOTIR-5225** carries the
   signal — a tick the list watches, or a shared reconcile — as part of _settled in
   place, in one reconcile, with no reload_.
3. **Whether the Approvals room's rows open this overlay** is
   [MOTIR-5300](motir:cmtyy44gy01mshvtx6hmyi1r3)'s decision. This asset gives it a
   surface to compose; it does not decide it.

## 23 · The `pull_request_approval` row AT REST — MOTIR-5480

**AMENDS § 20** (`approvals-row.mock.html`, **Panel 9**) for Story
[MOTIR-4909](motir:cmtt4ogps000ghutxdx7laze2), card
[MOTIR-5480](motir:cmu1aj15k00gchyoidbhlbomo). It is the layout source of truth for
[MOTIR-5485](motir:cmu1aj1d000gmhyoic2qrsb4v), which builds it.

**What changes, and for which kind.** Once `pull_request_approval` registers
(MOTIR-5481) and gates are raised (MOTIR-5482), a real, decidable gate would reach
Panel 7's _Not built yet_ row. Panel 9 draws its row instead. ~~**`decision_approval`
and `pull_request_merge` keep Panel 7's row**, unchanged, and Panel 7's note says
so.~~ **AMENDED by § 25 (MOTIR-5612):** `decision_approval` keeps Panel 7's row.
**`pull_request_merge` has no row at all** — a card holds ONE approve-to-merge gate,
so the per-pull-request row and its _Not built yet_ cell are removed rather than
re-worded. The struck sentence is kept visible because it is what the asset promised
until 2026-09-16, and a reader arriving from MOTIR-5485 will be looking for it.

| element           | treatment                                                                                                                              | field                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| kind glyph        | lucide `git-pull-request`, `h-4 w-4`, **`--el-accent-on-surface`** (a live kind's mark, never the unregistered `--el-text-faint`)      | `row.kind`                                             |
| kind label        | **Pull requests**, `text-sm font-medium text-(--el-text)`                                                                              | `row.kind`                                             |
| subject line      | each `owner/name · #n` in the set's canonical order, `text-xs text-(--el-text-secondary)`, truncating                                  | the `pull_request_approval` arm of the subject summary |
| the pill          | **none** — _Not built yet_ goes for this kind only                                                                                     | —                                                      |
| whole-row control | a link to **the work item's page** (`/items/{key}`), where the Development frame decides it; no chevron, because nothing opens in-list | `row.workItem.identifier`                              |
| decide cell       | **Open card** (the shipped secondary `sm` button), to the same page                                                                    | —                                                      |
| waited, work item | unchanged from § 20                                                                                                                    | unchanged                                              |

**The truncation rule for the subject line.** One or two pull requests are listed in
full, comma-separated. **Three or more list the first two, then _+n more_**, and the
cell's `title` attribute carries the whole list. Past that the line truncates with an
ellipsis like every other subject line. Panel 9 draws one, two and three pull requests.

**Why _Open card_ and not _Review_.** The full-screen door for this kind is
[MOTIR-5437](motir:cmu118c1q0007hytx0tt38vq4)'s. Until it lands, this row takes the
reader to the item page, where the gate is decided; when it lands, 5437 swaps the
decide cell for _Review_ exactly as design rows have it. **Narrow** follows Panel 8
unchanged.

**Copy — `en` + `zh`**, keyed for MOTIR-5485 under `workbench.approvals.pullRequest`:

| key         | en                                            | zh              |
| ----------- | --------------------------------------------- | --------------- |
| `kindLabel` | Pull requests                                 | 拉取请求        |
| `more`      | +{count} more                                 | 另有 {count} 个 |
| `openCard`  | the shipped _Open card_ string — not re-keyed | —               |

### GIVES / TAKES

`grep -o 'MOTIR-[0-9]*' approvals-row.mock.html | sort -u` goes from 19 keys at `HEAD`
to 21: MOTIR-5480 and MOTIR-5437 are new. The row's SAMPLE keys are `ACME-n`.

| card                                          | GIVES                                                                               | TAKES                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [MOTIR-5485](motir:cmu1aj1d000gmhyoic2qrsb4v) | The row: glyph, label, subject line and its truncation rule, the link, and the copy | Nothing. Its criteria (glyph, every pull request named, no pill, reaches the page) all hold |
| [MOTIR-5437](motir:cmu118c1q0007hytx0tt38vq4) | The row its _Review_ door replaces _Open card_ on                                   | Nothing                                                                                     |
| MOTIR-5481 / MOTIR-5482                       | Nothing — named as what puts a gate in this row                                     | Nothing                                                                                     |

## 24 · The approval overlay renders the APPROVE-TO-MERGE gate — MOTIR-5438

**AMENDS § 22** (`approval-overlay.mock.html`) for ONE gate kind, `pull_request_approval`, in the delta
**`approval-overlay--pull-request-gate.mock.html`** (Story [MOTIR-5437](motir:cmu118c1q0007hytx0tt38vq4),
card [MOTIR-5438](motir:cmu118c4s0009hytxgtmyfeg8)). It is the layout source of truth for
[MOTIR-5440](motir:cmu118ca1000dhytx0jofi4gl) (the host), which carries it in `blocked_by`, and for
[MOTIR-5439](motir:cmu118c7e000bhytxn9l5u1v0) (the read), which feeds what band 2 renders. Neither § 22's
mock nor any other asset is edited, and no image export ships (`docs/decisions/design-result.md`
AMENDMENT 4).

**Why it is owed.** § 22 built the overlay for every gate kind but a port only for `design_result`. On
`origin/main` the read answers `kind_not_built` for `pull_request_approval`
(`app/api/work-items/approval-gate/route.ts`, whose comment names this story), so the decision most cards
end in opened to _Not built yet_.

| Surface                                      | Asset                                                       | Panels |
| -------------------------------------------- | ----------------------------------------------------------- | ------ |
| **The overlay on the approve-to-merge gate** | **`approval-overlay--pull-request-gate.mock.html`** (delta) | 1–10   |

**Panels:** 1 awaiting, a two-repository run under ONE frame · 2 a short screen · 3 see but not decide ·
4 How to test missing · 5 a design card (state 7's block) · 6a approved · 6b changes requested ·
6c superseded · 7 one refused, in place · 8 narrow, in `zh` · 9 dark · 10 the To-approve row's door.

### Rendered first

Composed from what ships, not from memory. Rendered headless before drawing: § 22's Panel 1
(`approval-overlay.mock.html`, the shipped `ApprovalOverlay` inside `Modal size="full"`) and
`design/github/approve-and-merge.mock.html` Panel 12p (the Development block with its frame flush in the
section card). Read against the components: `ApprovalGateControl` takes `layout: 'inline' | 'fill' |
'flush' | 'section'` and `ApprovalOverlay` already passes `fill`; `DevelopmentGateFrame` passes `flush` on
the item page; `DevelopmentSectionBody` already renders state 7's order when it is handed a design result.
**Nothing in this section needs a new component input.**

### The answer in one line

**Band 2 is the item page's Development block**, composed unchanged: every linked pull-request row, then
the run's How to test (body, one sub-block per repository, earlier runs) — and on a design card, state 7's
design slot first. Band 1 and band 3 are MOTIR-4909's kind words and verbs, byte-identical to the item
page. One frame and one _Approve and merge_ over every pull request, in any repository.

### What is composed, and who owns it

| piece                                                                | owner — composed, not redrawn                                                                                                     |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| the dialog, the exit row, the address, the fill form, narrow         | § 22 (MOTIR-5222)                                                                                                                 |
| band 1, band 3, the confirm step, every gate state, the refusal      | `design/github/design-notes.md` § 20 _The verbs and their states_ (MOTIR-5480) · `ApprovalGateControl`                            |
| band 2 — the rows and How to test                                    | `design/github/design-notes.md` § 20 (MOTIR-5327) · `github.mock.html` Panel 12b, 12i                                             |
| band 2 on a design card — the design slot                            | `design/work-items/design-notes.md` § _States 7–8_ (MOTIR-5494) · `design-result--what-to-review.mock.html` state 7 and section 8 |
| the row's glyph, label and subject line                              | § 23 (MOTIR-5480)                                                                                                                 |
| **which content band 2 holds for this kind, and the row's _Review_** | **this section**                                                                                                                  |

**Nothing in the Development block is redrawn.** The mock carries `approve-and-merge.mock.html`'s own
stylesheet and sprite sheet byte for byte, so its rows, pills, How to test, code blocks and `af-` frame
bands are that sheet's rules; the overlay container is re-declared under `ov-` names quoting § 22's class
strings, and state 7's slot under `ds-` names quoting its sheet.

### FILL, not FLUSH — the one thing that differs from the item page

The same block renders in two frame layouts, and the difference is the BOX only:

| element                                    | item page — `layout="flush"` (12p)            | overlay — `layout="fill"` (this section)                          |
| ------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------- |
| the container                              | the Development section card                  | the overlay itself — no card around the frame                     |
| the section card's title, gloss and door   | _Development_, its gloss, _Link pull request_ | **absent** — they are the page's, not the gate's                  |
| the port's floor · 34rem ceiling · Expand  | kept                                          | **dropped** — the viewport is the box                             |
| scroll                                     | the port, inside its ceiling                  | the port, at viewport height; band 3 on the bottom edge (Panel 2) |
| bands 1 and 3, every state, verb and alert | the frame's                                   | **the frame's, byte-identical**                                   |

**_Pull requests_ appears ONCE**, as band 1's kind label. The overlay has no section card, so there is no
_Development_ heading above it and nothing to de-duplicate; the dialog's accessible name keeps the kind
(`approvalOverlay.dialogTitle`, _Pull requests for ACME-12_).

### How to test is evidence, never a gate

It renders inside band 2, below the rows (or below the design slot on a design card). It has **no band,
no gate row, no verb and no approval of its own**, in every panel. Its copy controls work in every state,
including see-but-not-decide (Panel 3), because reading is not deciding. When no run wrote it, the
block's **record-missing** callout renders inside the port (Panel 4, 12i unchanged) and the verbs stay:
the gate is real, and a reviewer may approve without instructions.

### A design card — state 7, and it outranks the card

Panel 5. On a design card with an open linked pull request (AMENDMENT 4 Q8) band 2 is state 7's block:
**the design result once, then How to test, then every pull-request row** behind a soft rule. No design
band, no design gate, no design verbs.

**⚠️ This corrects MOTIR-5438's own criterion**, which placed the result _"below every pull-request row
and above How to test"_. State 7 merged at 2026-09-14T23:10Z (#2894), after the card was last edited
(19:11Z), on review: _"design result and how to test should be before the PRs"_. The shipped
`DevelopmentSectionBody` renders that order. The criterion is amended on the card, 2026-09-15.

### States — composed, one panel each

| state                          | panel | composed from                                                                   |
| ------------------------------ | ----- | ------------------------------------------------------------------------------- |
| awaiting (you)                 | 1, 2  | 12p                                                                             |
| awaiting, see but not decide   | 3     | 12w — no verbs, _Waiting on {name}._, pill _Awaiting_                           |
| How to test record missing     | 4     | 12i inside 12p                                                                  |
| approved — all merged          | 6a    | 12t                                                                             |
| changes_requested              | 6b    | the frame's record band (state E) with this kind's commit count; nothing merged |
| superseded — withdrawn by push | 6c    | 12v                                                                             |
| merging · queued to merge      | —     | 12r · 12s, unchanged — the same bands in the same fill form, not repeated       |
| one refused, in place          | 7     | 12u                                                                             |

**Deciding does not close the overlay** (§ 22): the frame re-renders with the decided record, and the row
underneath settles in place in the same reconcile.

**Band 3's copy is the SHIPPED copy.** `approvalGate.pullRequestApproval.consequence.named` reads
_Approving merges {prs} — each now, or through its repository's merge queue where one is required — then
moves {key} to Approved._ `approve-and-merge.mock.html` 12p still draws the earlier per-member wording
(_… and adds {queued} to its merge queue …_); the panels here draw what `messages/en.json` ships.

### Narrow (`< md`) and dark

Panel 8, in `zh`: § 22's narrow exit row unchanged (no `Esc` chip, no title, _Open work item_ as its icon
with the label as its accessible name); rows wrap their pills under the title; band 3 wraps its sentence
above the verbs. Panel 9: Panel 1 under `data-theme="dark"` — no token of its own.

### The ACCESS PATH — the row's door (Panel 10)

§ 23 said it: once this story lands the `pull_request_approval` row's decide cell swaps **_Open card_ for
_Review_**, exactly as design rows have it. **The whole row is the door** (§ 22 Panel 9, MOTIR-5225's
`aria-haspopup="dialog"` link): a plain primary click writes
`?approval=<key>&approvalKind=pull_request_approval` with `shallowPush` and this overlay opens over the
tab; a modified or middle click opens `/items/<key>` in a new tab. The glyph, _Pull requests_ label and
subject line with its _+n more_ rule are § 23's, unchanged.

### Fields the port reads

The port is `DevelopmentSectionBody`, so it reads exactly what the item page hands it — which is what the
read (MOTIR-5439) must return beside `gate` and `canDecide`.

| rendered element                      | field(s)                                                                                                  | source on the item page                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| every pull-request row                | `deliveries` — `WorkItemDeliveryDto[]`, each with its `LinkedPullRequestDto`                              | `workItemsService.getDeliveryView(item.id, targetRepos)` |
| a repository with no pull request yet | `repos` — the repository set amended by the delivery set (`AwaitingRepoRow`, 12l)                         | the same `getDeliveryView` call                          |
| How to test — every part              | `HowToTestDto` (`record` · `record_missing` · `tested_via_ancestor`)                                      | `howToTestService.getForWorkItem`                        |
| the design slot (Panel 5)             | the current `DesignEvidenceDTO`, or `null` on a card with none                                            | `designEvidenceService.getCurrentForWorkItem`            |
| band 1, band 3, every state           | `ApprovalGateDTO`, `canDecide`, `routedToLabel`; the member outcomes as `DevelopmentGateFrame` reads them | the overlay read (MOTIR-5223)                            |

### Copy — `en` + `zh`

**No new string.** Every visible string is shipped: `common.close`; `approvalOverlay.*`;
`approvalGate.state.*`, `approvalGate.waitingOn`, `approvalGate.verb.requestChanges`;
`approvalGate.pullRequestApproval.*`; `github.development.howToTest.*`; `designResult.*`;
`workbench.approvals.review` (_Review_ / _查看_) and `workbench.approvals.pullRequest.*`.

### Tokens

`--el-*` colour and element-semantic shape tokens only, no raw hex. The overlay's own elements keep
§ 22's token map. Board chrome inks are `--el-text` and `--el-text-secondary` only. Code blocks and the
design slot's frame and note row take `--el-card` inside the port, so `--el-link` keeps AA.

### What this asset does NOT decide

- **The overlay container, the address, the exit row** — § 22's.
- **The frame's states, verbs, confirm step, refusal copy or merge behaviour** — MOTIR-4909 / MOTIR-4882.
- **The Development block, How to test, the design slot** — MOTIR-5327 / MOTIR-5336 / MOTIR-5494.
- **The item page's door** — MOTIR-5215.

### GIVES / TAKES — every card this asset names

| card                                                                                                                                                               | GIVES                                                                                                                            | TAKES                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[MOTIR-5438](motir:cmu118c4s0009hytxgtmyfeg8)** (this card)                                                                                                      | Panels 1–10 and this section                                                                                                     | **PREMISE:** its design-card criterion's order (_"below every pull-request row and above How to test"_) — state 7 outranks it. **Amended on the card, 2026-09-15.**                                                                                              |
| **[MOTIR-5439](motir:cmu118c7e000bhytxn9l5u1v0)** (the read)                                                                                                       | The Fields-read table: `deliveries`, `repos`, `HowToTestDto`, `DesignEvidenceDTO` or `null`                                      | **ELEMENT:** _"the item's linked pull requests, in the same shape the item page's Development section reads"_ names one of the two delivery fields; the block also reads `repos` to draw a repository with no pull request. **Amended on the card, 2026-09-15.** |
| **[MOTIR-5440](motir:cmu118ca1000dhytx0jofi4gl)** (the host)                                                                                                       | Every panel, the fill form around this port, no new frame input, and the row's door                                              | **ELEMENT:** the row's decide cell _Open card_ → _Review_ (§ 23's promise), which its criteria did not name. **Amended on the card, 2026-09-15.**                                                                                                                |
| **[MOTIR-5441](motir:cmu118cco000fhytx4onw4dk2)** (the vitest gate)                                                                                                | The seams to assert: one frame over both repositories, How to test with no verb, record-missing inside the port, state 7's order | Nothing.                                                                                                                                                                                                                                                         |
| **[MOTIR-5442](motir:cmu118cf8000hhytxpqsqhdqm)** (the acceptance E2E)                                                                                             | The walk's surfaces: the row's _Review_, both rows and How to test at full size, a copy control, band 3 on the bottom edge       | Nothing.                                                                                                                                                                                                                                                         |
| **[MOTIR-5222](motir:cmtxm4vqc00euhztx2esa99wa)** (§ 22) · `done`                                                                                                  | A second port for its container                                                                                                  | Nothing — the container is composed.                                                                                                                                                                                                                             |
| **[MOTIR-5223](motir:cmtxm4vsr00ewhztxdvzgyay8)** (the read's route) · `done`                                                                                      | A drawn consumer for a resolved `pull_request_approval` subject                                                                  | Nothing — its `kind_not_built` arm for this kind is what MOTIR-5439 replaces.                                                                                                                                                                                    |
| **[MOTIR-5224](motir:cmtxm4vvp00eyhztxhm8nwmrs)** (the host) · `done`                                                                                              | Nothing                                                                                                                          | Nothing — `layout="fill"` shipped; this port needs no other input.                                                                                                                                                                                               |
| **[MOTIR-5225](motir:cmtxm4vyn00f0hztxmer6bqau)** (the row door) · `done`                                                                                          | Its door, reached from a second kind                                                                                             | Nothing.                                                                                                                                                                                                                                                         |
| **[MOTIR-5327](motir:cmtzoqqmt00bzhvtxgxduxev2)** (the Development block) · `done`                                                                                 | A third mount context for the block                                                                                              | Nothing — composed.                                                                                                                                                                                                                                              |
| **[MOTIR-5494](motir:cmu1hrmoo001shutx9zav5r0h)** (state 7) · `done`                                                                                               | Nothing                                                                                                                          | Nothing — its section 8 already drew this overlay's band 2 on a design card; Panel 5 composes it.                                                                                                                                                                |
| **[MOTIR-4909](motir:cmtt4ogps000ghutxdx7laze2)** · **[MOTIR-5480](motir:cmu1aj15k00gchyoidbhlbomo)** · **[MOTIR-5484](motir:cmu1aj1bj00gkhyoi0iuds6xy)** · `done` | A fourth mount context for the kind's bands                                                                                      | Nothing — bands 1 and 3 composed; the shipped consequence copy is drawn where 12p's sheet predates it.                                                                                                                                                           |
| **[MOTIR-5485](motir:cmu1aj1d000gmhyoic2qrsb4v)** (the row) · `done`                                                                                               | Nothing                                                                                                                          | **ELEMENT:** _Open card_ → _Review_ and the row's link → the overlay door. Not amended: a `done` card is history; § 23 recorded the swap as MOTIR-5437's.                                                                                                        |
| **[MOTIR-4882](motir:cmtrwx3580055hxph0vfamj1l)** · `done`                                                                                                         | Nothing                                                                                                                          | Nothing — its refusal union is cited in Panel 7's slot, not re-worded.                                                                                                                                                                                           |
| **[MOTIR-5215](motir:cmtxm4v6g00efhztx79g9zyar)** · `done`                                                                                                         | Nothing                                                                                                                          | Nothing — the item page's door writes the same address.                                                                                                                                                                                                          |

Fixture items use `ACME-n` keys and link to nothing.

## 25 · The To-approve ROW SET and the Development frame WITHOUT a merge gate — MOTIR-5612

**AMENDS § 20** (`approvals-row.mock.html`, Panel 9 as § 23 revised it) **and § 23 itself**, in the
delta **`approvals-row--one-gate.mock.html`** (Bug [MOTIR-5603](motir:cmu396zoh005ihwtxd5xpny37),
card [MOTIR-5612](motir:cmu3bguy400drhwtx2p8zl203)). It also amends the Development frame drawn in
`design/github/design-notes.md` § 20 (MOTIR-5327 · MOTIR-5484). It is the layout source of truth for
[MOTIR-5615](motir:cmu3bgv5u00dxhwtxlgojcou8), which builds it and carries this card in `blocked_by`.
**No existing mock is edited** and no image export ships (`docs/decisions/design-result.md`
AMENDMENT 4).

**Why it is owed.** A card in a `manual` project was raised TWO approve-to-merge gates — one per pull
request beside the one per card — so the To-approve tab listed the same pull request twice, and one of
those rows read _Not built yet_ about a kind that is in fact registered. The model is now ONE gate per
card, and approving it merges every pull request the card delivers
(`docs/decisions/approval-gates.md` § 8's SECOND AMENDMENT, **decisions 3 and 5**). § 23 of this file
SPECIFIED the row being removed, so the new state had to be drawn before it is built.

### Rendered against shipped reality, not redrawn

Every string, structure and class string in the delta was taken from the REAL components mounted with
the shipped fixtures at `origin/main` `45b107a5f`, not read off the source:

- `components/approvals/ApprovalRow.tsx` — both rows of Panel 2, including the `Pill tone="archived"`
  _Not built yet_ cell and the `Pull-request merge` subject line `mergeSubjectMeta` writes;
- `components/github/DevelopmentGateFrame.tsx` (via `DevelopmentSection.tsx`) — the frame header, the
  pull-request rows, the outcome chips, _Retry merge_ and the refusal alert of Panels 3–5.

The mock's second stylesheet re-declares those components' markup under prefixed names, each rule
quoting the class string it maps to; the first stylesheet is § 24's delta byte for byte.

### The panels

| panel | what it settles                                                                                                                                                                                                                                                                                                 |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **To approve draws ONE row for one card, whatever it delivers.** The subject cell already names the whole set in the gate's canonical order, so the row states what approving it merges. The decide cell is § 23's _Review_ and the door is § 24's overlay — both unchanged.                                    |
| **2** | **The row that is GONE**, as a before/after pair over the same card: 2a draws today's three rows — the card's own plus one `pull_request_merge` row per pull request, each carrying the _Not built yet_ pill in its decide cell — and 2b draws the one row that remains.                                        |
| **3** | **The frame at rest.** The card's single gate holds the decision; each pull request's merge OUTCOME is drawn in its own row's trailing cell, read from `merge_authority` / `merge_outcome_ref` on the pull-request row rather than from a gate of its own.                                                      |
| **4** | **ONE member refused.** _Retry merge_ stays in the refused row's trailing cell and is addressed to **(the card's approved gate, THIS pull request)**. The gate stays `approved`, the card stays `approved`, and the sibling that merged keeps its outcome — a retry carries out a decision that already stands. |
| **5** | **A QUEUED pull request.** _Queued to merge_ is an outcome, not a pending decision: the card sits `approved` until the merge webhook lands it. No retry is offered while an outcome exists.                                                                                                                     |

**No second gate is drawn in any panel**, which is the one thing a reader should be able to check by
looking rather than by reading.

### What this asset does NOT decide

- **The copy.** Every string in the delta is the shipped one. Retiring the strings this change makes
  unreachable for the kind — `workbench.approvals.notBuiltYet`, `mergeSubjectMeta` — in `en` and `zh`
  is [MOTIR-5615](motir:cmu3bgv5u00dxhwtxlgojcou8)'s.
- **The overlay.** § 22 and § 24 draw it. Its `kind_not_built` arm for this kind retires with the row,
  and that arm is MOTIR-5615's and [MOTIR-5616](motir:cmu3bgv8100dzhwtx5nb0ovib)'s.
- **The registry and the enum.** The kind stays registered until MOTIR-5616, and the
  `approval_gate_kind` Postgres value is kept permanently, because superseded rows reference it.

### ⚠️ A line in a sibling asset that is TRUE ONLY LATER

`approval-overlay.mock.html:4815` labels a panel
`4a · kind = pull_request_merge (in UNREGISTERED_GATE_KINDS)`. **That is not true today** — the kind is
registered (`lib/approvalGates/registry.ts`), which is exactly why the To-approve row was decidable-looking
enough to reach a _Not built yet_ cell rather than an unregistered one. It becomes true when
[MOTIR-5616](motir:cmu3bgv8100dzhwtx5nb0ovib) moves the kind to `UNREGISTERED_GATE_KINDS`. It is named
here, and not edited, because § 22's mock is a record of what was drawn: a reader meeting that label
should know it describes the destination rather than the present.

### GIVES / TAKES — every card this amendment names

| card                                                                    | GIVES                                                                                                                   | TAKES                                                                                                                                     |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **[MOTIR-5615](motir:cmu3bgv5u00dxhwtxlgojcou8)** (the UI) · `blocked`  | Panels 1–5: the row set, the outcome cell, RETRY's address, and the copy it must retire in `en` + `zh`                  | Nothing to amend — it was authored against this delta and carries it in `blocked_by`                                                      |
| **[MOTIR-5616](motir:cmu3bgv8100dzhwtx5nb0ovib)** (the retirement)      | The `UNREGISTERED_GATE_KINDS` line above becomes true at this card, and the overlay's `kind_not_built` arm goes with it | Nothing — its scope is the registry tier, unchanged by this asset                                                                         |
| **[MOTIR-5485](motir:cmu1aj1d000gmhyoic2qrsb4v)** (§ 23's row) · `done` | Nothing                                                                                                                 | Nothing — a `done` card is history. § 23's struck sentence records that its sibling row is gone, so a reader arriving there is not misled |
| **[MOTIR-5480](motir:cmu1aj15k00gchyoidbhlbomo)** (§ 23) · `done`       | Nothing                                                                                                                 | **ELEMENT:** the Panel 7 promise for `pull_request_merge` is struck in place, above                                                       |
| **[MOTIR-5438](motir:cmu118c4s0009hytxgtmyfeg8)** (§ 24) · `done`       | Nothing                                                                                                                 | Nothing — the overlay and its port are unchanged; this delta composes them                                                                |
| **[MOTIR-5603](motir:cmu396zoh005ihwtxd5xpny37)** (the bug)             | The drawn state of its own fix                                                                                          | Nothing                                                                                                                                   |

Fixture items use `MOTIR-4931` and link to nothing.

---

## The CI badge (MOTIR-5471)

**Asset: `workbench--ci-badge.mock.html`** (panels 10–12). It amends § _Layout_. Story MOTIR-5469;
built by MOTIR-5475.

**The column set is untouched.** `minmax(10rem, 1fr) 96px 140px 108px` — Title · Your role · Assignee ·
Status — with the same `gap-x-4` and `pl-4 pr-7`: `344 fixed + 48 gaps + 44 padding + a 160px title
floor = 596px`, against the **622px** minimum § _Layout_ records, and a measured title track of **440px
at 1200**.

**The badge takes the title cell, as a GLYPH**, for the same reason and in the same form as on
`/items` — `design/work-items/design-notes.md` § _The CI badge (MOTIR-5471)_ carries the measurement and
is the authority. **The 1200 fit is therefore untouched: no fixed width is added, and 440px of title
track absorbs a ~20px glyph.** No new column, so nothing in § _Layout_'s budget moves.

**Per tab:**

- **_In progress_** — the tab the badge is for. A card whose run opened pull requests sits at
  `implemented` both while its checks run and after they fail, and this is where its owner sees which.
- **_Recently finished_** — **never shows it, structurally rather than by exception.** That tab lists
  cards in the `done` CATEGORY, and the badge's rule is that a done-category card carries none. The tab
  needs no special case and no extra column; the same rule that governs the board card governs it.
- **_Watching_** — follows the same rule as _In progress_: drawn when the card is not done.

At ~400px the row is far under its 622px minimum and already scrolls horizontally — the Workbench's
existing behaviour, which the badge neither causes nor changes.

---

## 26 · WHAT LIVE LOOKS LIKE — MOTIR-5239

**AMENDS § 20** (the To-approve row, and its POST-DECISION rule) **and § 22** (the
approval overlay) for Story
[MOTIR-5238](motir:cmtxm4x2e00fwhztxbr4hkj9s), card
[MOTIR-5239](motir:cmtxm4x5800fyhztxp88bxw52). It is the layout source of truth for
**MOTIR-5242** (the host and its lists) and **MOTIR-5243** (the open approval), which
carry it in `blocked_by`.

| Surface                 | Asset                                        | Notes                                                                                                                                                                   |
| ----------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The Workbench, LIVE** | **`workbench--live.mock.html`** (HTML delta) | A row arriving and a count moving · reconnecting · DECISION 1, the held row · DECISION 2, the notice in the overlay · the notice and the refusal side by side · narrow. |

**Panels:** 1 a row arrives and the count moves · 2 reconnecting · 3 DECISION 1, a row
that left the awaiting set · 4 DECISION 2, the notice in the open approval · 5 the
notice and the refusal side by side · 6 narrow (`< md`).

**It is a DELTA and holds only what live-ness changes.** The strip, the shell, the
five-tab composition, the pager, the empty states, the frame, the exit row, the
address and the fill form are all composed from the assets that own them
(`workbench.mock.html`, `approvals-row.mock.html`, `approval-overlay.mock.html`) and
are not re-decided here. Every row in it is `ApprovalsList` / `ApprovalRow`'s own
emitted markup; the four edits the asset makes are listed in its header comment.

### ⚠️ AMENDED 2026-09-17 by MOTIR-5239 — § 20's POST-DECISION rule SURVIVES live-ness, and here is the rule that makes it

§ 20 settled, with its reasons, that **a decided row keeps its position, swaps its
Decide cell for a state pill, and leaves on the NEXT LOAD — it never vanishes under
the cursor**, because _"a surface that sometimes removes a row silently and sometimes
explains one teaches the reader that disappearance is ambiguous, which is the most
expensive thing a queue can teach."_

**A list that re-reads itself on a nudge removes that row.** The tab reads
`state = awaiting`, so a row somebody else has just decided is simply absent from the
next read. That is § 20's rule being overturned BY A MECHANISM rather than by a
decision, and this amendment refuses it.

> **THE RULE — A NUDGE ADDS AND UPDATES. IT NEVER REMOVES.** A row that is in the
> reader's list stays in the reader's list until the NEXT LOAD — a navigation, a tab
> switch, a pager move, a reload. A row that has left the awaiting set is HELD in
> place, its subject and work-item ink go `--el-text-secondary`, its verb is replaced
> by the colourless **Decided elsewhere** pill, and it still opens. The strip count
> goes DOWN with it, because § 20's count is about what is AWAITING and a held row is
> a receipt, not a member.

**The two candidates this rejects, and why neither is the shape:**

- **_A row the reader has already SETTLED is held until they navigate._** It protects
  the rows THIS reader decided — which the product already handles, through
  `lib/approvals/decidedGates.ts` (§ 22 planning flag 2). The hazard is the row
  somebody ELSE decided, which this reader never touched, so the rule is correct
  about a case that was not in danger and silent about the one that was.
- **_A row the reader INTERACTED with is exempt._** The same defect, stated as an
  exemption: interaction is not what makes a disappearance ambiguous. A reader who has
  been reading a queue for a minute and looks back to find one fewer row cannot tell
  whether they misremembered, whether a filter moved, or whether something was
  decided — and they did not interact with any of it.

**What is NOT amended:** the settled TREATMENT itself (§ 20 owns it, and the held row
uses it), the state pills, the column set, the narrow reflow, the token map, and the
rule that a row this reader decided settles from the write's own response.

**Why the held row's pill says _Decided elsewhere_ rather than naming the state.** The
tab's read returns only `awaiting` gates and the stream carries no content, so when a
row leaves the set the surface knows THAT it left and not WHERE it went. **Drawing a
state it cannot read would be the surface guessing**, and `approved` / `changes
requested` / `withdrawn` are three different pieces of news. So the pill says the true
thing — it is no longer yours to decide — and the row still opens, where the frame
shows the real record: who decided, when, and on which bytes. Colourless for § 20's own
reason: a tinted pill would let a reader take somebody else's answer for their own.

### DECISION 2 — an open approval learns its subject MOVED

**The case, from the story:** a person is holding the full-screen approval open and
reading a design at full size — which is the entire reason that surface exists — and
the design is republished under them. Interrupting them costs their attention at the
moment they are giving it. Saying nothing means they finish, press Approve, and meet
the stale refusal instead. **Neither is right, and the third option is the answer.**

> **THE RULE — SAY NOTHING LOUDLY, AND MAKE IT IMPOSSIBLE TO MISS WHEN THEY LOOK UP.**
> A persistent, non-modal notice is drawn as **band 3's first child, immediately above
> the verbs**. It does not move, does not animate, does not steal focus and does not
> dismiss itself. It is INFORMATIVE: the verbs stay exactly as they were.

**Three constraints the drawing answers, each of them a thing a later change is likely
to break:**

1. **THE PORT IS NOT COVERED, TAKEN AWAY, OR REFLOWED.** The notice is inside band 3,
   which is anchored to the bottom edge of the screen, so band 3 grows downward-inward
   and the port's scroll container loses one line at its BOTTOM edge. **The port keeps
   its `scrollTop`, so the sentence the reader is on does not move.** Nothing is
   overlaid on the design, and nothing above the notice re-lays out. (A notice drawn
   at the TOP, near the port, would reflow the thing being read — which is the one
   move this surface may not make.)
2. **IT IS A NOTICE, NOT A GATE.** The stamp is what actually prevents a wrong
   approval (`docs/decisions/approval-gates.md` § 6a — the decision records the
   subject's immutable version, and a press against a superseded gate is REFUSED
   server-side). A notice can be missed, so drawing it as a blocking banner, or
   disabling the verbs behind it, would claim a guarantee it cannot make and would
   make this surface a precondition when it is not. The verbs stay live and the
   refusal stays the guarantee.
3. **IT IS TELLABLE FROM THE REFUSAL IT PRECEDES.** Panel 5 draws the two side by
   side. **The notice is about the SUBJECT and arrives BEFORE the press, so it offers
   a way forward; the refusal is about the PRESS and arrives AFTER it, so it reports
   that nothing was recorded.** Neither repeats the other's words — which is what
   stops a reader who saw the first from reading the second as the same message
   repeating, and wondering why their press did not land.

**Why the notice carries NO TINT, on a surface whose product language for _out of
date_ is yellow.** `--el-tint-yellow` is already spent inside this frame: band 1's
state pill reads **Awaiting you** in it. A second yellow in the same 720px, meaning
something else, is a reader's problem rather than a palette question — so the notice
is drawn on `--el-surface-soft` with an `--el-border` hairline, and carries its meaning
in a `TriangleAlert` glyph and in WORDS (finding #35's rule, applied in the direction
that is always safe: never rest a state on colour, and where colour is taken, do not
take it twice).

### The copy — `en` and `zh`

| key                                 | `en`                                                | `zh`                               |
| ----------------------------------- | --------------------------------------------------- | ---------------------------------- |
| `approvalOverlay.moved.title`       | This design was republished while you were reading. | 你正在阅读时，该设计已被重新发布。 |
| `approvalOverlay.moved.consequence` | Approving this version will be refused.             | 批准此版本将被拒绝。               |
| `approvalOverlay.moved.action`      | Reopen                                              | 重新打开                           |
| `workbench.live.new`                | New                                                 | 新增                               |
| `workbench.live.decidedElsewhere`   | Decided elsewhere                                   | 已由他人决定                       |
| `workbench.live.reconnecting`       | Reconnecting…                                       | 正在重新连接…                      |

**These are DRAFTS for the catalog**, exactly as § 20's were: MOTIR-5242 and
MOTIR-5243 own their `en` + `zh` entries. `moved.consequence` deliberately states the
CONSEQUENCE rather than the mechanism — a reader does not need to know what a stamp is
to know that this press will not land. **`Reopen` is the verb because the address
survives a republish** (§ 22 — a gate is addressed by `(work item, kind)`, so the same
link opens the current question); it is not _Reload_, which would suggest the page.

### The ARRIVAL and the COUNT

**A row arrives in its ORDERED POSITION and carries a `New` chip until the next load.**
On this tab the order is `createdAt asc` (§ 20), so an arrival lands at the BOTTOM and
nothing the reader was looking at moves. **The chip is a WORD in the shipped neutral
`Pill`, not a tint and not an animation** — a sudden silent insertion teaches a reader
to distrust what they have already read, and a flash or a slide moves a surface whose
whole promise is that it can be left alone.

**The COUNT moves and is NOT marked.** A number that changes is self-evident; a badge
that pulses is a second thing to look at on a page the reader is deliberately not
watching. **The strip and the list move in ONE page state** — § 21's rule, restated for
a live surface: a frame that moves one moves both, so a count of 4 above a list of 3 is
a state this surface never renders.

**On a list ordered `updatedAt desc` — the three work tabs — an arrival lands at the
TOP.** The rule is the same and so is the treatment; what differs is that rows below it
shift by one row's height. That is acceptable on those tabs and would not be on this
one, which is why the order each tab already has is what decides it rather than a
second rule.

### RECONNECTING — and what it is NOT

**It is not loading, and the difference is the whole of its treatment.** Loading means
_there is nothing on your screen yet_ (§ 22's Panel 5b: muted blocks at the real
proportions, `aria-busy`, so an answer that arrives does not reflow the screen).
Reconnecting means _everything on your screen is real and may be a few seconds old_.

So: **the rows keep their full ink, nothing pulses, nothing is greyed, and no skeleton
appears.** The only new element is a quiet chip beside the strip — the shipped chip
recipe (`--el-chip-bg` + `--el-chip-border` + `--el-text-secondary`), a `RefreshCw`
glyph and the word. **It offers no action**, because there is nothing for a reader to
do: `useRunEvents`' backoff already retries to a 15s ceiling, and the watermark resumes
with neither a replay nor a gap. It leaves when the stream reconnects.

**At `< md` it is drawn BELOW the strip rather than beside it** — the strip already
scrolls at that width (§ _Narrow: the strip SCROLLS_), and a chip inside a scrolling
track is a chip that can be scrolled out of sight.

### Token map — this amendment's own elements

| Element                      | Colour                                                      | Shape                                   |
| ---------------------------- | ----------------------------------------------------------- | --------------------------------------- |
| the `New` chip               | `--el-chip-bg` · `--el-chip-border` · `--el-text-secondary` | `--radius-badge` · `--spacing-chip-x/y` |
| the `Decided elsewhere` pill | `--el-chip-bg` · `--el-chip-border` · `--el-text-secondary` | `--radius-badge` · `--spacing-chip-x/y` |
| a HELD row's ink             | `--el-text-secondary` — § 20's AA note applies unchanged    | —                                       |
| the reconnecting chip        | `--el-chip-bg` · `--el-chip-border` · `--el-text-secondary` | `--radius-badge` · `--spacing-chip-x/y` |
| its `RefreshCw` glyph        | `currentColor` (`--el-text-secondary`)                      | `h-3.5 w-3.5`                           |
| the moved notice             | `--el-surface-soft` · `--el-border` · `--el-text-strong`    | `--radius-card`                         |
| its `TriangleAlert` glyph    | `--el-text-strong`                                          | `h-4 w-4`                               |
| its `Reopen` action          | the shipped secondary `Button`                              | `--radius-btn` · `--height-btn-sm`      |

**A HELD row's ink is `--el-text-secondary`, not `--el-text-muted`**, for the reason
§ 20 records on the record: muted is 4.12–4.34:1 on `--el-surface`, which is this row's
HOVER fill, so it would drop below AA in the one moment a pointer is on it. No raw hex
and no raw shape utilities anywhere in the asset.

### GIVES / TAKES — every card this amendment names

Scope: every `MOTIR-<n>` in this section plus the mock's annotation prose, grepped over
the story's SUBTREE. Axes: ELEMENT (what is drawn), STRUCTURE (where it sits), PREMISE
(what it assumes).

| card                                                      | GIVES                                                                                                                                                                                                                                                                                                                                            | TAKES                                                                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-5242** (the host, the lists, the counts)          | **ELEMENT:** the `New` chip, the held row's ink and pill, the reconnecting chip. **STRUCTURE:** a nudge ADDS and UPDATES and never REMOVES; the arrival lands in its ordered position; the chip beside the strip at `≥ md` and below it at `< md`. **PREMISE:** the count decrements with a held row, and strip and list move in one page state. | Nothing. Its stream, its hook and its one-connection rule are the parent story's and are untouched here.                                                  |
| **MOTIR-5243** (the open approval)                        | **ELEMENT:** the notice, its glyph, its two sentences, its `Reopen` action, and its `en` + `zh` drafts. **STRUCTURE:** band 3's first child, above the verbs, with the port keeping its `scrollTop`. **PREMISE:** it is informative and the verbs stay live, because the stamp is the guarantee.                                                 | Nothing. It does not decide what the frame's bands contain, and this section does not re-open § 22's fill form.                                           |
| **MOTIR-5238** (the story)                                | **Both decisions it named as owed to this card, SETTLED**, as rules its code cards are closed against.                                                                                                                                                                                                                                           | Nothing.                                                                                                                                                  |
| **MOTIR-5240 / MOTIR-5241** (the read, the stream)        | **PREMISE, and it is the one that constrains them:** the surface needs to know WHICH TABS moved and nothing else — no row content — and a held row means the client must tolerate a row the read no longer returns.                                                                                                                              | Nothing. The watermark's shape and the stream's frame are theirs; this section reads them and draws against them.                                         |
| **MOTIR-5147 / MOTIR-4794** (§ 20's row)                  | Nothing they do not already own. The held row USES their settled treatment; the drawn rows are `ApprovalRow`'s own markup.                                                                                                                                                                                                                       | **Nothing is taken, and the boundary is stated:** § 20's post-decision rule is honoured, not re-opened — this amendment says HOW a live re-read obeys it. |
| **MOTIR-5222 / MOTIR-5224 / MOTIR-5225** (§ 22's overlay) | Nothing they do not already own. The notice is composed INTO the frame they specify, and the exit row, the address, the fill form and every state are theirs, unchanged.                                                                                                                                                                         | **One element of band 3's box:** band 3 may now carry a full-width first child. Its verbs, its consequence line and its refusal are untouched.            |
| **MOTIR-5302** (`ApprovalRow`)                            | A drawn consumer for two more row conditions — the arrived chip and the held pill — both inside the one row grammar rather than beside it.                                                                                                                                                                                                       | Nothing. Neither condition adds a column or a band.                                                                                                       |
| **MOTIR-4908**                                            | Nothing — named only as a boundary this asset does not cross. The pending-decision indicator is that story's, and nothing here draws or reads one.                                                                                                                                                                                               | Nothing.                                                                                                                                                  |

### ⚠️ Planning flags — surfaced by this pass

1. **The held row needs a SIGNAL the list can watch, and one already exists.**
   `lib/approvals/decidedGates.ts` carries a decision made in the overlay to
   `ApprovalsList`'s client island (§ 22 planning flag 2). A row held because SOMEBODY
   ELSE decided arrives by a different route — the live re-read finds it absent — so
   **MOTIR-5242** owns turning that absence into the held treatment rather than into a
   removal. Named here because the two paths produce the same row state and should not
   grow two implementations of it.
2. **A row held for a whole session is a list that only grows.** The rule is bounded by
   the NEXT LOAD, and every ordinary use of this surface reaches one quickly (a tab
   switch, a pager move, a reload). A reader who leaves the Workbench open for a day
   without navigating would accumulate held rows, and **no card in this story caps
   that**. It is not a defect of the rule — a cap is exactly the silent removal the
   rule refuses — but if it ever becomes real, the answer is a LOAD the reader asks
   for, never a quiet sweep.
3. **The three work tabs' arrival treatment is drawn but not exercised here.** This
   asset draws the arrival on the To-approve tab, whose `createdAt asc` order puts it
   at the bottom. `updatedAt desc` puts it at the top and shifts the rows below it; the
   rule and the chip are the same, and **MOTIR-5242** should assert the chip on at
   least one `updatedAt desc` tab so the treatment is not accidentally
   approvals-only.

## 27 · The To-approve ROW for a DECISION — MOTIR-5673

**Asset:** `design/workbench/approvals-row--decision.mock.html` — a NEW delta mock. It amends
`design/workbench/approvals-row.mock.html` (MOTIR-5147, § 23) as amended by
`design/workbench/approvals-row--one-gate.mock.html` (MOTIR-5612, § 25), and composes the row exactly
as `design/workbench/approval-overlay--pull-request-gate.mock.html` (MOTIR-5438) Panel 10 draws it,
whose token block, sprites and `rw-*` rules are spliced 1:1. None of them is edited. The port the row
opens is `design/github/approve-and-merge--decision.mock.html`, noted in `design/github/design-notes.md`
§ 27, with the full copy table for the kind. Drawn to `docs/decisions/approval-gates.md` § 8's FIFTH
AMENDMENT (MOTIR-5672).

### The row

- **Glyph:** the decision TYPE's own mark — lucide `scale` in `--el-type-decision`
  (`lib/issues/workItemTypeMeta.ts`), exactly as a design row takes the design type's pencil in
  `--el-type-design`. `aria-hidden`; the words carry the meaning. The only new CSS rule is that hue.
- **Kind:** _Decision_ / _决策_ — the short row label, as _Pull requests_ is for the approve-to-merge
  row.
- **Subject line:** the document's first `#` heading (a leading `ADR:` dropped) · its path, truncated as
  every subject line is; the cell's `title` carries the path and the blob. **When the heading is not
  available**, the title from the file name (`titleFromDecisionPath`: `page-body.md` → _Page body_) — never an
  empty cell, and the row never waits on GitHub to draw (Panel 7b).
- **Unresolvable decisions list too** (Panel 7c): _No decision document · {pr}_ / _无决策文档 · {pr}_,
  and _{count} decision documents · {pr}_ / _{count} 份决策文档 · {pr}_. They are real questions —
  their Request changes is live — so they list and they open the overlay.
- **_Not built yet_ is gone for this kind** (Panel 7d, before / after).
- **The ACCESS PATH** (Panel 8b): the whole row is the door, as every live row —
  `?approval={key}&approvalKind=decision_approval` by `shallowPush`, opening the overlay over the tab.

### Copy — new strings, `en` and `zh`

| key                                             | en                                | zh                        |
| ----------------------------------------------- | --------------------------------- | ------------------------- |
| `workbench.approvals.rowKind.decision_approval` | Decision                          | 决策                      |
| `workbench.approvals.decisionSubject.none`      | No decision document · {pr}       | 无决策文档 · {pr}         |
| `workbench.approvals.decisionSubject.several`   | {count} decision documents · {pr} | {count} 份决策文档 · {pr} |
| `workbench.approvals.decisionSubject.title`     | {path} at blob {blob}             | {path}，文件版本 {blob}   |

The resolvable subject is data (heading or file-name title, and the path) and needs no key.

### GIVES / TAKES

Scope: `grep -o 'MOTIR-[0-9]*' approvals-row--decision.mock.html | sort -u` — 29 keys. Eight are this
section's own (MOTIR-4907, 5147, 5438, 5612, 5673, 5676, 5679 and the base's 5480); the other 21 are the
base stylesheet and sprite provenance carried verbatim, which GIVE or TAKE nothing.

| key                             | GIVES / TAKES                                                                                                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOTIR-5679                      | **GIVES** Panels 7a–7d and 8b, the glyph, the subject rule and the copy above. **TAKES** `DecisionApprovalSubjectSummaryDTO` (shipped by MOTIR-5676) and, for the heading, one resolver read per row it chooses to make; amended onto the card |
| MOTIR-5676                      | **nothing either way** — the summary DTO the row reads already ships                                                                                                                                                                           |
| MOTIR-5147 / 5612 / 5438 / 5480 | **nothing either way** — composed, not redrawn                                                                                                                                                                                                 |
| MOTIR-4907                      | the story; its verification recipe's step 4 walks Panel 7a                                                                                                                                                                                     |
| MOTIR-5673                      | this card                                                                                                                                                                                                                                      |

Fixture items use `ACME-n` keys, so they link to nothing.
