# ADR: A work item's TO-DO LIST — what one to-do is, what its executor promises, and what a finished list does NOT do

- **Status:** Accepted (2026-08-28, drafted for Story MOTIR-3808 per the
  decision-subtask ladder). This is the rung-1/rung-2 contract the rest of
  MOTIR-3808 implements — no to-do code ships until these five points are
  pinned. **No application behaviour ships in this subtask** (the ADR only).
- **Story / Subtask:** MOTIR-3808 (A work item's TO-DO LIST — the ordered steps
  of a manual card, each ONE operation, ticked off, carrying its own executor and
  a command you copy) · Subtask MOTIR-3811.
- **Consumed by:** MOTIR-3812 (design: the To-do list section and a row's three
  faces), MOTIR-3813 (the `work_item_todo` store — migration → repository →
  service), MOTIR-3814 (the write path — Server Actions + the read DTO),
  MOTIR-3815 (the section on the work item page), MOTIR-3816 / MOTIR-3817 (the
  two test gates). Downstream, MOTIR-1344 (Help with a task) rewrites this list
  mid-session, MOTIR-3810 teaches the planner to propose one, and MOTIR-3809
  (Epic 9) hands ONE row to a hosted run.
- **Builds on:** the shipped `Executor` enum and its seeded-and-overridable
  default map (MOTIR-2629 / `work-item-type-taxonomy.md`), the fractional index
  (`lib/workItems/positioning.ts`), the item page's single permission read
  (MOTIR-2473), and the two shipped status authorities this record refuses to
  become a third of (`status-derivation.md`, `repo-set-completion-repair.md`).
- **Supersedes / superseded by:** none.

> Convention (set by `work-item-type-taxonomy.md`, followed by
> `billing-tiering.md` / `status-derivation.md` / `design-result.md` /
> `conversation-turn-intent.md`): a decision record is a markdown file under
> `docs/decisions/`, structured **Status → Context → Decision → Consequences**,
> with the load-bearing facts pinned in explicit tables so downstream code has
> one authoritative source to implement against.

---

## Context

Motir's smallest unit of execution is the work item. For anything an agent can
build that is the right grain — a card, a branch, a pull request. For the work a
**person** does it is the wrong grain: _"provision the DNS records"_, _"set up
the Stripe account"_, _"cut the release"_ are each one card and each a dozen
operations, and the only place those operations have ever lived is a paragraph
of prose in `description_md`. Prose cannot be ticked.

Story MOTIR-3808 gives that work rows: ordered, individually complete,
individually ticked, each carrying its own executor and — where the operation is
a command — the command itself, with a copy button.

Five questions have to be settled before any of its siblings can be authored,
because each of them would otherwise be answered silently, in passing, by
whichever card reached it first — in a migration, in a component, or in a test
fixture. Three of them would be answered _differently_ depending on which card
got there first, and by then the answer is in a schema.

### Shipped substrate this reconciles against

Verified on `origin/main` @ `ae490d52e` (motir-core), 2026-08-28. Every row was
read, not recalled.

| Fact                                                                                                                                                                                                                                                     | Where                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `Executor` is a two-member Prisma enum — `coding_agent` \| `human` — mapped to the `executor` PG type                                                                                                                                                    | `prisma/schema.prisma` (`enum Executor`)                                                         |
| The type→executor map is a **default that SEEDS and stays overridable**, never an authorization: _"The default SEEDS `executor` when a type is first chosen and is ALWAYS overridable afterward."_                                                       | `lib/issues/executorDefaults.ts` (`DEFAULT_EXECUTOR_BY_TYPE`, `defaultExecutorForType`)          |
| Only leaf kinds (`task` / `subtask` / `bug`) may carry `type` / `executor` at all; `epic` / `story` are containers and are never typed                                                                                                                   | `lib/issues/executorDefaults.ts` (`TYPEABLE_KINDS`, `isTypeableKind`)                            |
| The item page resolves the actor's whole permission set in ONE `projectAccessService.getPermissions` round trip, and every write affordance reads one key out of it (`work_item:edit` / `work_item:archive` / `work_item:delete` / `project:administer`) | `app/(authed)/items/[key]/page.tsx`                                                              |
| A per-item CHILD ROW carries `workspace_id` **on the row**, cascades from both `workspace` and `work_item`, and is indexed `(work_item_id, created_at)` for its panel read                                                                               | `prisma/schema.prisma` (`model Comment`, `model Attachment`)                                     |
| A new workspace-scoped table gets its RLS policy **in the same migration as the table** (no unguarded window), `FORCE`d so the owner role is subject to it, gated on the row's OWN `workspace_id` because _"RLS does not traverse foreign keys"_         | `prisma/migrations/20260827094500_work_item_delivery/migration.sql`                              |
| Ordering across sibling rows is an opaque **fractional index**, allocated by `keyForAppend` / `keyForPrepend` / `keyBetween`, so a reorder is a single-row write and never a renumber                                                                    | `lib/workItems/positioning.ts`; used by `lib/workflows/defaultWorkflow.ts` for status order      |
| A copy affordance is driven by an explicit **flag**, not by inspecting the content: _"Only the runnable samples get a copy button; a schema is read, not run."_                                                                                          | `app/(public)/docs/_components/CodeBlock.tsx` (`copyable`)                                       |
| The shipped clipboard grammar for a command is _write the string, then confirm_ — a toast where the reader's eye is elsewhere, the button's own state where it is not                                                                                    | `app/(authed)/ready/_components/ReadyList.tsx` (`CopyCommandAction`); `CodeBlock.tsx` (`copied`) |
| The item's audit trail is `work_item_revision` — a `changeKind` string (`created` / `updated` / `archived`) plus a JSON `diff`, indexed `(work_item_id, changed_at)`                                                                                     | `prisma/schema.prisma` (`model WorkItemRevision`)                                                |
| A section on the item page is a `ContentSectionCard` — a `Card` with a title, a muted `— <subtitle>` gloss, optional header extras and one right-aligned slot                                                                                            | `app/(authed)/items/[key]/_components/ContentSectionCard.tsx`                                    |

### ⚠️ ONE PREMISE IN THE CARD IS FALSE, AND IT IS CORRECTED HERE RATHER THAN INHERITED

MOTIR-3811's own body offers, as Q3's rung-2 evidence, that _"the shipped ladder
(`lib/workflows/defaultWorkflow.ts`) has **no `in_progress → done` edge at
all**"_. **That is not true on `origin/main`.**

```
$ git grep -n "'in_progress', 'done'" origin/main -- lib/workflows/defaultWorkflow.ts
origin/main:lib/workflows/defaultWorkflow.ts:145:  ['in_progress', 'done'],
```

The edge was added by MOTIR-1625 with a backfill migration for every existing
default-workflow project, on two stated grounds: a project with no review gate
should be able to finish work without parking it in a column it does not use,
and the MOTIR-1615 upward rollup moves a parent to `done` from wherever it is —
without the edge that rollup would be an illegal move and would strand the
parent. The live `MOTIR` project carries the transition today.

**The decision Q3 reaches is unchanged, and this is worth saying explicitly**,
because a falsified premise that leaves its conclusion standing is exactly the
shape that gets quietly re-scoped. The reason not to move a card's status from a
checkbox was never _"the ladder makes it impossible"_ — it is that Motir already
has two authorities over that column and a third one wired to a checkbox anyone
can click is how MOTIR-3229 happens again. The false premise made the argument
look _structural_ when it is a _design_ choice; §3 below states it as the design
choice it is, which is the stronger form. Planning bug filed under MOTIR-1465;
the card body is amended on the record.

### The mirror, OBSERVED (rung 1)

| Mirror                                                 | What is modelled                                                                                                                                                                                                                                                         | Where                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **Jira** — native checklist / action items on an issue | A checklist entry is a **short line with a state**, added inline, dragged to reorder — never a rich document with its own description and acceptance criteria. The issue below it is the thing with a body.                                                              | Atlassian's issue-checklist surface and the whole third-party checklist market built on it (Okapya, HeroCoders) |
| **Jira** — Checklist for Jira, "mandatory items"       | The market's version of _finish the list before you move the card_ is a **workflow VALIDATOR** the admin opts into per transition — a transition that refuses — **not an automatic transition** that fires when the last box is ticked. Nobody ships the automatic form. | HeroCoders "Checklist for Jira" validator docs                                                                  |
| **Linear** — sub-issue progress                        | A parent shows `n of m` as a **read-out**, and completing the last sub-issue does not close the parent.                                                                                                                                                                  | Linear's sub-issue progress indicator                                                                           |
| **GitHub** — task lists in an issue body               | A ticked task list moves a **progress bar** and nothing else; closing the issue stays an explicit act.                                                                                                                                                                   | GitHub task lists                                                                                               |

The convergent observation across all four is the one that decides §3: **every
mirror renders completion as a read-out, and the only place any of them lets a
checklist touch status is an opt-in validator that BLOCKS a transition — never
one that PERFORMS one.**

---

## Decision

### §1 — What ONE to-do IS: five fields, a done stamp, and a hard length cap

A to-do is **one operation** — _change this one setting_, _run this one
command_ — not a phase and not a sub-project. It is a **short plain-text line
with state**, and deliberately not a Markdown document: a to-do with paragraphs,
headings and its own acceptance criteria is a work item, and Motir already has
one of those.

| Field                     | Type                          | Notes                                                                                       |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| `id`                      | `String @id @default(cuid())` | the row                                                                                     |
| `workspaceId`             | `String`                      | **on the row**, because RLS does not traverse foreign keys (`work_item_delivery` precedent) |
| `workItemId`              | `String`                      | the card this list belongs to; `onDelete: Cascade`                                          |
| `text`                    | `String @db.Text`             | **plain text, single line.** Not Markdown. Capped at 200 by the SERVICE — see below         |
| `commandText`             | `String? @db.Text`            | nullable; present ⇒ this row is a command row (§5); capped at 500 by the service            |
| `executor`                | `Executor`                    | `coding_agent` \| `human`; declarative (§2)                                                 |
| `position`                | `String`                      | the shipped opaque fractional index (`lib/workItems/positioning.ts`)                        |
| `doneAt`                  | `DateTime?`                   | null ⇒ not done. The done STATE is `doneAt != null` — there is no separate boolean          |
| `doneById`                | `String?`                     | who ticked it; `onDelete: SetNull` (a departing member must not vaporise the tick)          |
| `createdAt` / `updatedAt` | `DateTime`                    | house convention                                                                            |

**THE GRANULARITY BAR IS A NUMBER, AND THE SERVICE IS WHERE IT IS ENFORCED.**

- **`text` ≤ 200 characters**, enforced by the SERVICE with a typed error. 200 is chosen against the operations the story
  itself names — _"change 1 setting in the UI"_, _"run one cli command"_ — which
  run 40–90 characters with room for a qualifier; it is comfortably above every
  honest one-operation line and comfortably below a paragraph. A step that does
  not fit in 200 characters is two steps, or it is a work item.
- **`commandText` ≤ 500 characters.** A real command with flags and a URL runs
  long; the cap exists to keep a shell script out of the field, not to keep a
  `curl` out.
- **Both caps live in ONE exported constant pair** (`lib/workItemTodos/limits.ts`)
  that the service validator, the DTO's documented contract, the error message a
  user reads and every test read, so the number has exactly one home.

**⚠️ WHERE THE CAP IS ENFORCED — THE COLUMN IS `TEXT`, NOT `VARCHAR(200)`, AND
THAT IS THE DECIDED FORM.** An earlier revision of this record specified
`@db.VarChar(200)` _in addition to_ the service check, on the reasoning that a
column width is a backstop the service cannot bypass. It was corrected while
MOTIR-3813 was being built, for two reasons that only became concrete at the
keyboard:

- **A width overflow surfaces as a raw Prisma `P2000`, not as a typed domain
  error.** The 4-layer contract requires the service to throw a typed error the
  caller translates; a `VARCHAR` would give two different failures for one
  condition, and the one a user is most likely to hit would be the untyped one.
- **A second home for the number is a second place for it to drift.** The whole
  point of the constant pair is that the bar has one definition. Encoding 200
  into a migration as well makes widening the bar a migration, and makes
  disagreeing with it silent.

The bar is not weaker for living in one place — the service is the table's only
writer — and `tests/integration/work-items/work-item-todos.test.ts` asserts the
rejection AT the cap, one past it, and on the EDIT path as well as the create
path.

**Why the cap is a CONSTRAINT and not advice.** _"One operation"_ stated in a
design note is a bar the first tired author walks past. Stated as a column width
the service rejects past, it is a bar the product holds. This is the same move
`TYPEABLE_KINDS` makes for types: the rule is enforced where the write happens,
not restated where the write is described.

**Rejected: a Markdown `body_md`.** It re-creates the work item at one tier
down, it makes the row un-scannable in a list, and it makes _"is this one
operation?"_ unanswerable. If a step needs a body, it needs a card.

**Rejected: a separate `isDone Boolean`.** Two columns encoding one fact drift —
`doneAt` set with `isDone false` is representable and meaningless. `doneAt` is
the state _and_ the stamp.

### §2 — The per-to-do `executor` DESCRIBES; it AUTHORIZES nothing

**In one sentence: `executor` records who an operation is _for_, and it does not
restrict who may tick it, edit it, reorder it or delete it.**

That is the whole promise, and it is deliberately a small one, because the row
carries `coding_agent` months before MOTIR-3809 can hand one to a hosted run.

| Question                                                           | Answer                                                                                                                                                                           |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| May a person tick a `coding_agent` row?                            | **Yes.** They may simply have done it themselves. Nothing about the row's executor is checked at tick time.                                                                      |
| May an agent's row be edited / reordered / deleted by a person?    | **Yes.** The permission is `work_item:edit` (§4), the same for every row.                                                                                                        |
| What does a `coding_agent` row RENDER as while nothing can run it? | **As the agent's, with no run control.** A glyph and a label that say _this step is the agent's_ — and no button. **Not a disabled button, and not a "coming soon" affordance.** |
| Is a to-do's executor derived from the card's at read time?        | **No.** It is a real column, seeded once at create (below) and independent thereafter.                                                                                           |

**The DEFAULT: a new to-do inherits the CARD's `executor`, and is overridable
per row.** Where the card carries no executor (an untyped card, or a container —
`isTypeableKind` is false for `epic` / `story`), the default is **`human`**: a
list a person is holding while they work is a person's list until somebody says
otherwise.

This is exactly the shape `defaultExecutorForType` already ships — _seeded on
create, always overridable, never an authorization_ — one tier down. It is what
makes Yue's _"even the subtask is marked manual, there can be some to-dos
executed by the agent"_ a one-click exception on the odd row rather than a field
every row makes you fill in.

**Rejected: gating the tick on the executor** (only an agent may complete an
agent's row). It is a rule with no upside and one guaranteed failure mode: the
person who did the work by hand cannot record that they did.

**Rejected: rendering an agent row DISABLED until dispatch ships.** A disabled
control with no explanation is a promise the product cannot keep, presented as a
malfunction. The row is not disabled; it simply has no run control yet, and
MOTIR-3809 adds one beside a field that already means the right thing.

### §3 — Ticking the LAST to-do does NOT move the card's status. Neither automatically nor as a gate.

**Decided, not deferred.** An all-done list is a visible STATE of the section —
the header count reads `6 of 6`, the section renders its all-done treatment —
and it is nothing else. The person moves the card with the status controls that
already exist.

**Two options were on the table, and BOTH are rejected:**

| Option                                                                                    | Verdict      | Reason                                                                                                                  |
| ----------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **(a) AUTO-TRANSITION** — ticking the last row moves the card (e.g. → `done`)             | **REJECTED** | It makes the checklist a **second status authority**.                                                                   |
| **(b) TRANSITION VALIDATOR** — the card may not leave `in_progress` while a to-do is open | **REJECTED** | It makes the checklist a status authority too, in the negative direction, and it is a rubber stamp on a reversible act. |

**Why (a) is rejected — the two-authorities reason, stated precisely.**

Motir already has two writers of a work item's status, and they are already
carefully partitioned:

1. **`childStatusCascadeService` / the parent rollup** — a container's status is
   derived from its children.
2. **The delivery completion gate** — `syncChangeRequestStatus` moves a card on
   the merge of its LINKED pull requests, and defers (`deferred_open_pr`,
   `deferred_incomplete_repo_set`, `deferred_non_default_base`,
   `missing_artifact_evidence`) rather than closing early.

A checkbox anyone can click, wired to that same column, would be a **third**,
with no defer arm and no notion of what the other two are holding. **MOTIR-3229
is what that costs**: a container claimed `implemented` and then `done`, with a
merged pull request, while its children were not — two authorities disagreeing
about one column, and the card closed over unfinished work. Adding a third
writer whose trigger is a single click is how that recurs, and the failure is
silent: a card reads `done`, its dependents become claimable, and nobody
re-reads the list.

**And the ladder is NOT the reason.** `lib/workflows/defaultWorkflow.ts:145`
carries `['in_progress', 'done']` (MOTIR-1625), so the transition an
auto-complete would want is perfectly legal. The refusal is a design choice
about who owns the column, not a discovery that the graph forbids it. (This
corrects the premise MOTIR-3811 was authored with — see Context above.)

**Why (b) is rejected — reversibility beats a rubber stamp.**

A validator is the checklist market's actual answer here (Checklist for Jira
ships one; the automatic form (a) is shipped by nobody), so it deserves a real
refusal rather than an omission:

- It converts an advisory list into a **hard gate on a reversible act**. Moving
  a card's status is one of the cheapest, most reversible things in Motir — the
  workflow has explicit backward and reopen edges (`in_review → in_progress`,
  `done → in_progress`, `cancelled → todo`). A gate on an act you can undo in
  one click buys nothing and costs the moment where somebody genuinely knows
  better than their own list.
- **A list is a plan, and a plan written before the work is never quite right.**
  MOTIR-3808 says so in its own body and MOTIR-1344 exists to correct it
  mid-session. Gating status on a provisional artifact makes the artifact
  authoritative in exactly the moment its author has learnt it was wrong.
- It is the same reasoning that gives Draft-with-AI no accept/discard step: where
  the act is reversible, Motir's standing position is that a confirmation is a
  rubber stamp.

**A reader must not be able to mistake this section for an unanswered
question.** Both options were considered; both are rejected; the reasons are
above. **A later card proposing either one is re-opening a decision, not filling
a gap** — and would need to say what changed about the two-authorities argument.

**What all-done DOES do:** it is rendered. The section header carries `n of m`,
and the all-done state is drawn by MOTIR-3812 and built by MOTIR-3815. That
read-out is the whole feature, and it is what every mirror ships.

### §4 — `work_item:edit` for every write; a TICK stamps the ROW, it does not write the revision trail

**The permission key is `work_item:edit`** — for add, edit, reorder, tick and
delete alike. One key, no split.

Ticking changes the item's content, and the shipped permission model is explicit
that reading and watching are not editing while writing is. The item page
already resolves the whole set in one `projectAccessService.getPermissions`
call, and the To-do list section reads `work_item:edit` out of that same set —
**no second round trip.** An actor without it sees the list, sees the count, and
gets no checkbox, no add row, no drag handle and no delete.

**THE TRAIL SPLIT, stated explicitly because it is the kind of thing that gets
decided by accident:**

| Act                                                    | `work_item_revision` row?                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| **add** a to-do                                        | **YES** — `changeKind: 'updated'`, the diff naming the added step |
| **edit** a to-do's `text` / `commandText` / `executor` | **YES**                                                           |
| **reorder** a to-do                                    | **YES**                                                           |
| **delete** a to-do                                     | **YES**                                                           |
| **TICK / UNTICK** a to-do                              | **NO.** The record is `doneAt` + `doneById` **on the row**        |

**Why.** Add / edit / reorder / delete are **structural** — they change what the
work IS, which is exactly what a revision trail is for. A tick is **progress**,
and it is the one act that happens six times on a six-step list, twice more when
somebody un-ticks and re-ticks. Writing a revision per tick turns a short
checklist into a wall of history entries the reader has to scroll past to find
the edit that mattered, and it degrades the trail's signal for every other
consumer of `work_item_revision`.

The row itself is not a worse record: `doneAt` + `doneById` answers _who
completed this step and when_ directly, at the row, where the reader is already
looking — which is more than a diff entry would give them.

### §5 — The command is its OWN nullable column, never parsed out of the text

`commandText String? @db.Text`, capped at 500 by the service. **Non-null ⇒ this row is a command row**
and renders its command with a copy button; null ⇒ it is a plain step.

**Rejected: deriving the command by parsing `text`** (a backtick span, a leading
`$`, a fenced block).

- **A copy button needs a value with an unambiguous start and end.** A parse
  breaks the first time somebody writes a sentence containing a backtick, and it
  breaks _silently_ — the row copies the wrong substring, and the user finds out
  in their shell.
- It makes _"is this row copyable?"_ a **rendering accident** instead of a data
  fact. Every consumer — the section, the DTO, MOTIR-1344's assistant rewriting
  the list, MOTIR-3809's dispatch — would have to re-run the same heuristic and
  agree with it.
- The codebase models this kind of thing as typed columns throughout
  (`AcceptanceEvidence`, `DesignAsset`, `GithubPullRequest`), and the shipped
  copy affordance is already a **flag**: `CodeBlock`'s `copyable` prop, whose own
  comment says _"Only the runnable samples get a copy button; a schema is read,
  not run."_ A heuristic here would be the one place in the product that guesses.

**The two fields are independent, and both are shown.** `text` says what the
step IS (_"apply the migration on the staging database"_); `commandText` is what
you run (`pnpm prisma migrate deploy`). A command row is not a row whose text is
a command — it is a row that has one.

**Clipboard grammar:** the shipped one. Write with
`navigator.clipboard.writeText`, then confirm — the `CopyCommandAction` toast
where the reader's eye may be elsewhere in a list, or `CodeBlock`'s own
transient button state where it is not. MOTIR-3812 picks between them for this
surface; both already ship, and neither is invented here.

---

## Consequences

### MOTIR-3813 — the to-do STORE (migration → repository → service)

Inherits, as a column definition it transcribes rather than decides:

- **The nine fields of §1**, both text columns as `TEXT`, with the two caps
  enforced by the service out of the exported constant pair those numbers live
  in (`lib/workItemTodos/limits.ts`).
- **`doneAt` as the state** — no `isDone` boolean.
- **`workspaceId` on the row**, `workspace` and `workItem` FKs both
  `onDelete: Cascade`, `doneById` `onDelete: SetNull`.
- **RLS in the SAME migration as the table**, `ENABLE` + `FORCE`, gated on the
  row's own `workspace_id` via `current_setting('app.workspace_id', true)` — the
  `work_item_delivery` shape exactly. No explicit `GRANT` (the workspace RLS
  migration's `ALTER DEFAULT PRIVILEGES` covers new tables).
- **`position` as the shipped fractional index** — `keyForAppend` on create,
  `keyBetween` / `keyBetweenSafe` on a move. A reorder is a single-row write.
- **The service enforces the caps and rejects past them with a typed error** —
  the column width is the floor, not the whole gate, because the message a user
  reads has to come from somewhere.
- Index `(work_item_id, position)` for the ordered panel read, plus
  `(workspace_id)` — the `Comment` / `Attachment` shape, with `position` in place
  of `created_at` because this list is ordered, not chronological.

### MOTIR-3812 — the DESIGN of the section and a row's three faces

Inherits, as the states it must draw:

- **A row's three faces are decided here, not in the mock**: a **plain step**
  (`commandText` null), a **command step** (`commandText` present → the command
  plus its copy affordance), and an **agent step** (`executor: coding_agent` →
  the agent's mark, **and no run control**, per §2).
  The three are orthogonal, not exclusive: an agent step may also be a command
  step, and the design owes that combination as a drawn state.
- **The header carries `n of m`** — §3's read-out — and the section has an
  **all-done** state that changes nothing about the card.
- **A `work_item:edit`-less actor sees the list and none of the controls** (§4).
- **The empty state**, since a card with no to-dos is the common case for every
  card in the tree today.
- It draws into the shipped `ContentSectionCard` grammar on
  `app/(authed)/items/[key]/`, and it draws the **access path** — where in the
  page's two-column body the section sits and what a reader clicks to add the
  first step.

### MOTIR-3814 / MOTIR-3815 — the write path and the section

- **Every write is `work_item:edit`** (§4), read out of the page's existing
  permission set.
- **Tick writes `doneAt` / `doneById` and NO revision row**; add / edit /
  reorder / delete write one (§4).
- **Nothing in either card touches `work_item.status`** (§3). A card whose to-do
  list is complete is a card with a complete to-do list.

### MOTIR-3809 (Epic 9) and MOTIR-1344

- **MOTIR-3809** adds a run control **beside** `executor`, which by then already
  means _this operation is the agent's_ — it does not re-interpret a field that
  meant something else. The seam is the field and the control's placement; §2 is
  what keeps the field honest in the interval.
- **MOTIR-1344** rewrites this list mid-session. §1's shape is what makes that
  cheap — a short line, an optional command, an executor, a position — and §3 is
  what makes it safe: an assistant editing a provisional list cannot move a
  card's status by doing so.

### What this record does NOT decide

- **How a to-do is DISPATCHED** — MOTIR-3809.
- **Whether the PLANNER proposes a manual card's to-dos at plan time** —
  MOTIR-3810.
- **Whether to-dos appear on any surface other than the item page** (the board,
  the ready list, the API). No card in MOTIR-3808 ships one, and this record
  takes no position on a later one.
