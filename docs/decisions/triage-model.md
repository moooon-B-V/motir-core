# ADR: The triage model — a submission IS a `work_item` in a `triage` state

- **Status:** Accepted (2026-06-13, model locked with Yue 2026-06-12)
- **Story / Subtask:** 6.11 (Triage inbox — bug/feature intake → promote) · Subtask 6.11.2
- **Supersedes / superseded by:** none
- **Consumed by:** 6.11.3 (schema marker + the read-exclusion-everywhere
  invariant + the queue read), 6.11.4 (intake — in-app submit + the public
  portal form), 6.11.5 (triage-actions service — accept / promote / decline /
  mark-duplicate-merge / snooze), 6.11.6 (inbox UI), 6.11.7 (submission-form
  UI), 6.11.8 (tests), 6.11.9 (e2e).

> Structured **Status → Context → Decision → Consequences → References**, the
> convention the first repo ADR (`work-item-type-taxonomy.md`) set: the
> load-bearing facts are pinned in explicit tables so the schema (6.11.3) and
> the actions service (6.11.5) build against one authoritative source rather
> than each re-deriving the shapes. No application behaviour ships in this
> subtask; the shapes it freezes are what make the rest of the story buildable.

---

## Context

Story 6.11 adds the **incoming-work front door**: bug reports and feature
requests arrive — from a team member through an in-app "report a bug / request a
feature" widget, or from anyone through a shareable public portal form — and
must land in a **triage inbox**, a staging queue that is EXCLUDED from the
planned tree until an admin acts on it (accept / promote / decline /
mark-duplicate-merge / snooze).

The shape decision that governs everything downstream is **how a submission is
stored**. The two candidate shapes:

1. **A separate `submissions` table** that is later copied/promoted into a
   `work_item`. Promotion is a copy — it duplicates the request grammar, and the
   submission's comment/attachment/history thread is either lost or has to be
   re-parented on copy.
2. **The submission IS a `work_item` from birth**, carrying a `triage` marker
   that makes it invisible to every normal read until it is promoted. Promotion
   is a metadata edit (clear the marker, set parent + rank), and the
   comment/attachment/history thread carries over for free because the row never
   moved.

Yue locked shape (2) on 2026-06-12. This ADR fixes the five load-bearing details
that shape leaves open: the **marker** (§1), the **central read-exclusion**
(§2), **submitter attribution** (§3), **promote/accept** semantics (§4), and
**decline / mark-duplicate-merge / snooze** semantics (§5).

### The verified mirror — Linear Triage (rung 1, verified not asserted)

Per the decision-authority ladder, the mirror product is the primary standard,
and the mirror here is **Linear Triage**, whose docs are explicit on every
load-bearing point (observed, not asserted from memory — `notes.html` #33):

- **Triage is a state outside the normal workflow, excluded from all views.**
  "By default, we exclude triage issues from all views since triage is
  considered to be outside the normal workflow" — you must add an explicit
  status filter to even see them. (https://linear.app/docs/triage) This is §2's
  exclusion invariant verbatim.
- **What lands in triage:** issues created through an integration, created
  inside the Triage view, created by people outside the team, or submitted by
  external people via Linear Asks / support connections — Motir's analogue is the
  in-app widget + the public portal form (6.11.4/6.11.7).
- **The action set we mirror:** Accept ("move the issue to your team's default
  status"), Mark as Duplicate (merge into an existing issue; the duplicate "is
  updated to a Canceled status type" and attachments/customer-requests move to
  the canonical issue), Decline ("update the issue to a Canceled status type"),
  Snooze ("hide the issue from the triage queue to return at a time of your
  choosing, or when there's new activity on that issue: whichever comes first").
  (https://linear.app/docs/triage)

**Secondary mirror — Jira Product Discovery / JSM intake (cited):** external
submissions route through a JSM request type / form into a staging area, and an
agent only promotes a submission into the real backlog once it is triaged (a
triaged-gate before idea creation) — confirming the intake-then-deliberate-
promote split, never auto-injecting raw requests into the planned backlog.
(https://www.atlassian.com/software/jira/product-discovery)

### The shipped ground this builds on (rung 2 — enforced reality)

The model must respect what is already in `motir-core`, which on three points
**outranks the card's prose** (rung 2 over rung 3):

- **`work_item.status` is a free `String` workflow value, not an enum** — the
  per-project workflow ships six keys (`todo` `blocked` `in_progress` `in_review`
  `done` `cancelled`) with categories `todo | in_progress | done`; `todo` is
  `isInitial`, and `cancelled` is a terminal status of category `done`
  (`lib/workflows/defaultWorkflow.ts`).
- **`work_item.reporterId` is NON-NULL** (`onDelete: Restrict`); `assigneeId` is
  nullable (`prisma/schema.prisma`). There is no existing external/unauthenticated
  submitter shape anywhere in the repo.
- **Re-parent + reorder already exist** as `workItemsService.moveWorkItem(id,
{ newParentId, beforeId?, afterId? }, ctx)`; position is the `position`
  fractional index (within-parent) and `backlogRank` is the separate
  fractional index for backlog/sprint ordering. The kind-parent grammar is
  enforced by a DB trigger (`prisma/sql/work_item_triggers.sql`). There is **no**
  bespoke `reparent` / `setPosition` / `setRank` method — promotion composes the
  shipped ones.

---

## Decision

### 1. The marker: a dedicated `triagedAt: DateTime?` column — NOT a reserved status

A submission is **born a `work_item`** (kind `bug` for a bug report, `task` for a
feature request — the request grammar) with **no parent**, created at the
project workflow's initial status (`todo`), and carrying a dedicated nullable
column:

| Column      | Type        | Meaning                                                                                                                                                                                   |
| ----------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `triagedAt` | `DateTime?` | **Non-null ⇔ the item lives in triage and has NOT graduated to the planned tree.** NULL ⇔ a normal, graduated (or never-triage) item. Set at intake; cleared ONLY by accept/promote (§4). |

**The marker is a column, not a reserved `status` value** — justified, not by
default:

- **`status` must stay a normal workflow value the whole time.** A triage item
  is at `todo` from birth and can be declined straight to `cancelled` (§5). A
  reserved `status = 'triage'` would have to be injected into **every project's**
  `workflow_status` set, polluting every board's column configuration, and would
  collide with the item carrying a real workflow status. The triage gate must be
  **orthogonal** to status, which only a separate column gives.
- **It survives graduation cleanly.** On promote, clearing `triagedAt` to NULL
  leaves a perfectly normal `work_item` already at a real status — no status-value
  migration, no leftover synthetic status to scrub.
- **`DateTime?` over a boolean `isTriage`** because the queue read (6.11.3) needs
  **newest-first ordering and an age display for free**, and a partial index
  `WHERE "triagedAt" IS NOT NULL` makes both the exclusion predicate
  (`"triagedAt" IS NULL`) and the queue read cheap.

The other two markers the model needs (per §3/§5), also on `work_item`:

| Column                   | Type        | Meaning                                                                                                                                                                                 |
| ------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snoozedUntil`           | `DateTime?` | Set by snooze (§5): the item drops out of the **active** queue until this time or new activity. Does not affect the normal-read exclusion (a snoozed item is still `triagedAt`-marked). |
| `externalSubmitterName`  | `String?`   | External-portal submitter identity (§3); NULL for in-app member submissions.                                                                                                            |
| `externalSubmitterEmail` | `String?`   | External-portal submitter email (§3); NULL for in-app member submissions.                                                                                                               |

6.11.3 adds these with a migration + the supporting partial index, every FK
modelled as a Prisma `@relation` (the migration FK-as-relation rule).

### 2. Read-exclusion is total, central, and defined ONCE

**Every normal read excludes triage-marked items; the triage-queue read is the
ONLY read that returns them.** The exclusion predicate is dead simple and
**total**:

```
<alias>."triagedAt" IS NULL
```

It is total precisely because §5 keeps the marker set on declined/merged items
(they never graduated), so "is this item part of the planned workspace?" reduces
to this single predicate with no `status`/`cancelled` special-casing.

**Where the predicate lives — defined once, threaded everywhere.** The shipped
reads do NOT share a single scope today: `buildIssueFilterSql(filter, alias)`
powers the tree + the flat list + feeds search, but the board, ready-set, and
quick-search reads each build their `where` **inline** — and each already
repeats `"archivedAt" IS NULL` by hand (it appears ~38× across
`workItemRepository.ts`). That scatter is the anti-pattern this ADR refuses to
repeat. **Decision: a single shared `Prisma.Sql` "not-in-triage" fragment**,
defined once and threaded into `buildIssueFilterSql` **and** the three inline
reads, ANDed **outside** the user-supplied FilterAST (`compileFilterConditionsSql`)
so no user filter can opt back IN to triage items. The longer-term shape is a
repository **default scope** that folds `archivedAt` + `triagedAt` together; the
shippable decision now is the shared fragment plus a **parameterized guard test**
(6.11.8) over the whole read set so a future read that forgets the fragment
fails loudly.

**The enumerated read checklist (6.11.3 applies it; 6.11.8 asserts it at each):**

| Surface             | Read method (`workItemRepository`)           | How the fragment threads in                       |
| ------------------- | -------------------------------------------- | ------------------------------------------------- |
| Issue tree (forest) | `findProjectForest`                          | via `buildIssueFilterSql` (root + recursive arms) |
| Each board column   | `findColumnCards`                            | inline `where` — add the fragment                 |
| List / saved view   | `findProjectIssuesFlat`                      | via `buildIssueFilterSql`                         |
| Ready set           | `findReadyCandidates`                        | inline SQL — add the fragment                     |
| FilterAST / search  | `quickSearch` + `compileFilterConditionsSql` | AND the fragment outside the compiled filter      |

**The queue read (the one inclusion read):** a new repository read + service
method returning ONLY triage items for a project —

```
"triagedAt" IS NOT NULL
  AND <status category is not terminal>            -- hides declined/merged (cancelled, category 'done')
  AND ("snoozedUntil" IS NULL OR "snoozedUntil" <= now())   -- hides currently-snoozed
ORDER BY "triagedAt" DESC                          -- newest-first
```

paginated/cursor'd (finding #57 — never load-all), with submitter attribution.
The triage surface MAY offer a "resolved/declined" variant of this read (drop the
category + snooze predicates) so an admin can review terminal items; that variant
is still a triage-surface read, never a normal read.

### 3. Submitter attribution — member OR external, respecting non-null `reporterId`

A triage item records its origin. The card suggested a nullable
`submittedByUserId`; the **shipped non-null `reporterId` (rung 2) overrides that**
— making `reporterId` nullable would break its `Restrict` invariant and ripple
through ~38 reads + the DTO mappers for no gain. Decision:

| Origin                 | `reporterId`                                                           | `externalSubmitter{Name,Email}` | Tenant access                                   |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------- |
| In-app member submit   | the submitting **member** (they ARE reporter)                          | NULL                            | their existing membership                       |
| External portal submit | a designated per-project **intake user** (a non-login service account) | captured name + email           | **none** — no `User`/account row, no membership |

- **Origin is a derived predicate:** `externalSubmitterEmail IS NOT NULL` ⇒
  external; else a member submission whose `reporterId` is the real submitter. No
  redundant `submittedByUserId` (it would always either equal `reporterId` or be
  null).
- The **intake user** is the verified-mirror shape: Linear Asks / integration
  submissions are created by a bot/integration user with the customer captured
  separately. 6.11.4 provisions the per-project intake account and the
  rotatable/disableable public-form token; this ADR fixes only that **external
  submissions attribute `reporterId` to the intake user and grant no tenant
  access**, and that the public path leaks no tree/project data.

### 4. Promote / accept — graduation, through `workItemsService`, respecting the matrix

Graduation is the ONLY thing that clears `triagedAt` to NULL. Both actions route
through the shipped write authority — never raw Prisma — in one service
transaction, and honour 6.4 permissions + the kind-parent grammar (the DB
trigger enforces it; the UI offers only legal targets):

| Action      | Effect                                                                                                                                                                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Accept**  | Clear `triagedAt`; place in the **backlog** (no parent) at the workflow's initial status (`todo`) with a fresh `backlogRank`; optional comment. (Linear: accept → team default status.)                                                                                             |
| **Promote** | Clear `triagedAt`; set the target via `moveWorkItem({ newParentId, before/afterId })` for an **epic/story** parent, and/or set `sprintId` + `backlogRank` for a **sprint/backlog** placement. The same row now appears in the tree with its full comment/attachment/history thread. |

**The four promote "targets" map to two shipped mechanisms** — be precise: a
**sprint is not a parent** (`sprintId` + `backlogRank`), and the **backlog** is
"no parent, ranked." Only **epic/story** are `parentId` targets, and the
kind-parent matrix bounds them:

| Submission kind | Legal `parentId` targets (trigger)   |
| --------------- | ------------------------------------ |
| `bug`           | epic · story · task · (none/backlog) |
| `task`          | epic · story · (none/backlog)        |

A `subtask` is never a submission kind, so the subtask "must have a parent" rule
never applies to promotion.

### 5. Decline / mark-duplicate-merge / snooze — terminal & deferral outcomes

These do **not** clear `triagedAt` — a rejected submission never graduated, so
keeping the marker set is exactly what keeps it out of every normal read (§2)
forever, while letting it leave the **active queue**:

| Action                     | Effect                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Decline**                | `updateStatus(id, 'cancelled', ctx)` (terminal, category `done`) + optional comment; `triagedAt` stays set. It drops out of the active queue (terminal category) and never enters the tree — reachable only via search-within-triage / the resolved-queue variant. The `todo → cancelled` transition already ships. (Linear: decline → Canceled.) |
| **Mark-duplicate / merge** | Pick a canonical item; **cancel the duplicate** (`cancelled`, `triagedAt` kept) and **fold its comments + attachments into the canonical item** (re-point `comment.workItemId` / `attachment.workItemId`), recording a `duplicates` link (the 6.9 link grammar). Mirrors Linear moving attachments/customer-requests to the canonical issue.      |
| **Snooze / unsnooze**      | Set `snoozedUntil`; the item leaves the **active** queue until that time **OR new activity** (a comment / edit clears `snoozedUntil`), whichever first. It stays `triagedAt`-marked throughout, so it never leaks into a normal read while snoozed. Unsnooze clears `snoozedUntil` immediately.                                                   |

**Why decline/merge keep the marker** (the key correctness call): the forest read
roots on `parentId IS NULL AND archivedAt IS NULL` and does **not** exclude
`cancelled`. If decline cleared `triagedAt`, a parentless cancelled submission
would surface as a **tree root** — re-polluting the planned tree with rejected
intake, defeating the whole feature. Keeping `triagedAt` set makes the §2
predicate total and keeps declined/merged spam out of the tree permanently, while
remaining recoverable (reopen `cancelled → todo` returns it to the active queue —
back in triage, where a rejected-then-reopened item belongs).

**Concurrency:** each action is one service method = one transaction; a read that
gates a write (e.g. resolving the canonical item on merge, or re-checking the
marker before graduating) takes `tx` + `SELECT FOR UPDATE` where two triage
actions could race the same item (the lock-before-read-derived-update rule).

---

## Consequences

- **6.11.3** adds `triagedAt` / `snoozedUntil` / `externalSubmitterName` /
  `externalSubmitterEmail` to `work_item` (+ partial index, FKs as `@relation`),
  defines the single shared not-in-triage `Prisma.Sql` fragment, threads it into
  the five reads in §2's table, and adds the paginated queue read.
- **6.11.4** creates triage items through `workItemsService` from both channels;
  external submissions attribute `reporterId` to the per-project intake user and
  capture `externalSubmitter{Name,Email}`; the public route is rate-limited +
  abuse-guarded (net-new — no rate-limit infra ships today) and leaks no tree
  data; the form token is rotatable/disableable per project.
- **6.11.5** implements accept/promote (clear `triagedAt` + `moveWorkItem` /
  `backlogRank` / `sprintId`), decline/merge (cancel + keep marker + fold
  comments/attachments + `duplicates` link), and snooze/unsnooze — all through
  `workItemsService`, all 6.4-permission-checked and transactional.
- **6.11.8** asserts the exclusion at the tree, every board read, every list
  read, the ready set, AND FilterAST search via a **parameterized read-set test**
  (a new read missing the fragment fails), asserts the queue-only read, and
  asserts each action's post-state on a real Postgres within the per-file
  coverage gate.
- **6.11.6 / 6.11.7** build the inbox + submission surfaces over these reads /
  actions (gated behind the 6.11.1 design asset).
- **Extending the action set** later (e.g. AI auto-triage, integration channels)
  reuses the same intake-creation path + the same `triagedAt` gate — no new
  storage shape.

## References

- `scripts/plan-seed/data/story-6.11.ts` — the Story 6.11 module header (the
  locked work_item-with-`triage`-state model + the full mirror rationale this
  ADR records).
- Linear Triage (https://linear.app/docs/triage) — the verified mirror for
  state-outside-the-workflow exclusion and the accept/decline/merge/snooze
  taxonomy.
- Jira Product Discovery / JSM intake
  (https://www.atlassian.com/software/jira/product-discovery) — the
  triaged-gate-before-promote intake pattern.
- `lib/services/workItemsService.ts` — `moveWorkItem` / `updateStatus` /
  `createWorkItem`: the write authority promote/accept/decline route through.
- `lib/repositories/workItemRepository.ts` — `findProjectForest` /
  `findColumnCards` / `findProjectIssuesFlat` / `findReadyCandidates` /
  `quickSearch` / `buildIssueFilterSql` / `compileFilterConditionsSql`: the reads
  the shared exclusion fragment threads through.
- `lib/workflows/defaultWorkflow.ts` — the status keys/categories (`todo`
  initial, `cancelled` terminal) decline/accept reference.
- `prisma/sql/work_item_triggers.sql` — the kind-parent matrix promotion must
  satisfy.
- `prisma/schema.prisma` — `work_item` (`reporterId` non-null, `position` /
  `backlogRank` / `sprintId` / `archivedAt`) the marker columns extend.
- `notes.html` mistake #33 (verify the mirror, cite what was observed) and the
  decision-authority ladder (mirror → shipped code → card) this ADR resolves
  §1/§3 from.
