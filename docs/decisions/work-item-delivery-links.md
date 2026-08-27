# The delivery link — one join table between work item and pull request

**Status:** accepted · **Date:** 2026-08-27 · **Card:** MOTIR-3656 (story MOTIR-3655)

> **⚠️ THIS SUPERSEDES `change-request-cardinality.md`** (accepted 2026-08-26,
> MOTIR-3527 under story MOTIR-3525), which asked the same question and answered
> it the other way. That file is marked superseded and points here. The reversal
> is argued in full under **Superseding MOTIR-3527** below — which of its premises
> fell, and why each of its three arguments does not reach this design. A reader
> who finds the two and cannot tell that the difference is deliberate has been
> failed by this section, not by the older file.

> **On the file name.** `docs/decisions/` is slug-named, not numbered, so this
> takes the next free SLUG — checked against `origin/main` and against every
> remote branch (`git show <branch>:docs/decisions/…`), because two parallel runs
> picking the same name collide exactly as two picking the same number would.

---

## The decision

**There is ONE association between a work item and a pull request: a join table,
many-to-many, carrying the repository.**

```prisma
model WorkItemDelivery {
  workItemId          String
  githubPullRequestId String
  repoId              String   // a real column, not a join away
  workspaceId         String   // denormalised, own RLS policies

  @@unique([workItemId, githubPullRequestId])
}
```

It **retires both scalars**:

| retired                            | what it expressed                        | what replaces it |
| ---------------------------------- | ---------------------------------------- | ---------------- |
| `work_item.session_branch`         | many cards → ONE branch, matched by name | rows             |
| `github_pull_request.work_item_id` | many PRs → ONE card                      | rows             |

The many-to-many comes **entirely from the rows**. N cards linking to the same
pull-request row is N rows, and that is how one pull request delivers N cards;
one card linking to two pull-request rows is two rows, and that is how a card
spans repositories. Nothing else is needed to express either direction.

### Why the repository is a column and not a join

Two independent reasons, and the first is correctness rather than performance:

- **The completion gate compares each member's merge against THAT repository's
  own default branch.** A self-hoster's trunk is `master` or `trunk`; the
  comparison is per repository and resolving it per member through
  `githubPullRequest → repo` is an N+1 on the delivery path.
- **`GithubPullRequest` has no `workspaceId` of its own** — its tenancy read goes
  through `repo`. This table does not copy that shape: it carries its own
  workspace column and its own RLS policies, per the standing rule for a new
  table.

### Rejected — keyed on the BRANCH NAME

Storing `sessionBranch` instead of a foreign key to the pull-request row was the
obvious way to satisfy the write-timing constraint below, and it fails on
identity. `workItemRepository.findBySessionBranch` matches
`where: { sessionBranch, workspaceId }` — **workspace-scoped, not
repository-scoped** — while the runbook uses the SAME branch name in every
repository a card touches. So for the two-repository card this story exists for,
both halves carry an identical string, `(workItemId, sessionBranch)` collapses
them into ONE row, and the gate concludes a single merge satisfied both. That is
this story's own defect, re-introduced by its key. **A branch name is not an
identifier.**

---

## The write flow

**`link_pull_request` stays SINGLE-KEY — one card, one pull request.** No
multi-key form, no batching, no partial-failure semantics. The shipped shape
(`lib/mcp/tools/linkPullRequest.ts`) is kept as it is.

**The link is written ONCE PER ITERATION, in every lane:**

| lane          | pull request(s)                                                          | when the link is written       |
| ------------- | ------------------------------------------------------------------------ | ------------------------------ |
| `motir run`   | its card's, one per repository the card spans                            | after `gh pr create`           |
| `motir batch` | the same, one card at a time                                             | after `gh pr create`, per card |
| `motir auto`  | **opened at the first IMPLEMENTED card in each repository**, then reused | **per card, every iteration**  |

`motir auto` no longer defers its pull request to the end of the run. So the
agent instruction is one sentence with no lane branch:

> **When your work is committed and the pull request exists, call
> `link_pull_request` with your card and that pull request.**

### Rejected — a run-level CARD LIST

An accumulated list of the cards a run picked up — CLI-local, or a server-side
run entity — with one multi-key link at the end. **Rejected for one failure mode
that could not be engineered away: a `motir auto` that dies mid-run loses every
card it had picked up and not yet linked.** A CLI-local list dies with the
process; a server-side one needs a new table and a new concept to hold what the
per-iteration link records for free.

Linking per iteration removes the window entirely. A crash at item 7 of 12 leaves
items 1–6 linked, durably, with real pull requests they can be seen on. There is
nothing to reconstruct, no partial-failure semantics for a batched call, and no
argument to have with `autoLoop.ts`'s _"no plan of the run"_ header — because
this adds no list of any kind, forward or backward.

**Recorded as rejected rather than omitted**, because it is the design a reader
reaches for first and its flaw is not visible until the crash.

---

## What the EARLY pull request costs, with a verdict on each

`motir auto` opening at the first implemented card rather than at the end is a
behavioural change, not a reordering.

| consequence                                                                                                        | verdict                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **CI runs on every push, not once per repository.** A twelve-card run pushes twelve times.                         | **ACCEPTED.** The fix loop needs a verdict to act on, and a verdict that arrives only at the end cannot stop a run from building nine more cards on a broken base. The cost buys the signal.           |
| **A red check can appear mid-run.**                                                                                | **The loop CONTINUES.** `implemented` is the correct status for code that is committed but whose build has not spoken. The watch and the five-attempt fix loop are MOTIR-3685.                         |
| **The trigger is IMPLEMENTED, not ATTEMPTED.**                                                                     | If an agent fails before implementing, no pull request exists in that repository and the next successful card opens it. Stated because _"the first card"_ is ambiguous and this is the disambiguation. |
| **`deferred_open_pr` holds cards 1..N−1 In Review for the length of the run**, instead of closing them at the end. | **INTENDED and correct.** None of them is delivered until the pull request lands. What changes is that the board now says so continuously rather than in one step at the end.                          |
| **A long run means a long-lived branch.**                                                                          | **Nothing caps it**, and nothing should: a run is bounded by its ready set, and a cap would truncate work rather than finish it. Named so it is a known property rather than a surprise.               |

---

## Q1 — repeat writes, and the status hop

- **A repeat link for the same `(card, pull request)` is IDEMPOTENT.** Deliveries
  redeliver and agents retry; the unique constraint makes the write a no-op and
  **the tool must not error.**
- **A second, DIFFERENT pull request for the same card ADDS a member.** This is
  the story's whole point, and it is the one place `link_pull_request`'s
  documented semantics change: today a second call **moves** the link, because the
  FK is singular. `docs/mcp.md` and the tool description both say so and both are
  amended by MOTIR-3658.
- **⚠️ THE LINK IS RECORDED WITHOUT DEMANDING THE TRANSITION.** There is no
  `in_review → implemented` edge in the workflow, so a card already In Review
  cannot be stamped again: `applyStatusTransition` raises `IllegalTransitionError`
  and — today — the branch is never recorded at all. That is precisely the
  two-delivery case this story exists for: the first delivery moves the card to
  `implemented`, CI turns it `in_review`, and the second delivery arrives to a
  card that cannot accept the stamp.

  **The remedy: writing the link and moving the status are separated.** The link
  row is a FACT and is always written; the `implemented` transition is a workflow
  move and is attempted only when the current status legally permits it. A fact
  that cannot be recorded because a workflow edge is missing is the wrong
  coupling, and it is the coupling that made the defect invisible.

- **A mistaken link is removed by an explicit `unlink_pull_request`.** With a
  singular FK, "remove" was expressible as a move; with rows it is not, so the
  door has to exist. Owned by MOTIR-3658.

---

## Q2 — when the two scalars go

**Both stay live-but-unread for the whole of MOTIR-3655, and are dropped by a
FOLLOW-UP card.** A column drop in the same migration as its replacement leaves
no state in which the old readers are still correct, and the rollback for a bad
behavioural change should be a code revert rather than a data restore.

So the story dual-writes: every writer keeps writing its scalar AND writes the
link row, and each reader is moved to the table one card at a time.

| reader                                                                           | of                                 | moved by                                       |
| -------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------- |
| `findBySessionBranch` → `resolveChangeRequestWorkItemSet`'s `session_branch` arm | `work_item.session_branch`         | MOTIR-3659                                     |
| `closeOutSession` / `completeSession`                                            | `work_item.session_branch`         | MOTIR-3658                                     |
| `countOtherOpenByWorkItem` / `countOpenByWorkItem`                               | `github_pull_request.work_item_id` | MOTIR-3659                                     |
| `listCompletionFactsByWorkItem`                                                  | `github_pull_request.work_item_id` | MOTIR-3659                                     |
| the Development surface                                                          | `github_pull_request.work_item_id` | MOTIR-3660                                     |
| `ciPromotion`                                                                    | `resolveChangeRequestWorkItemSet`  | MOTIR-3685                                     |
| **the columns themselves**                                                       | both                               | **a follow-up card, once this table is empty** |

### `mark_integrated` SURVIVES, minus its `sessionBranch` argument

It is not made redundant by `link_pull_request`, and the two do not overlap once
the link is a row:

- **`mark_integrated` is the STATUS and PROVENANCE door.** It records the
  `implemented` transition and the agent/model that did the work — the one fact
  only the agent holds — and it fires on agent success, which is often before a
  pull request exists.
- **`link_pull_request` is the ASSOCIATION door**, and it fires when the pull
  request exists, because that is the only moment it can.

Its `sessionBranch` argument goes with the column it writes. Two tools, two
distinct meanings, no second way to say the same thing — which is the state
MOTIR-1965 argued for and the one this decision is trying to reach.

---

## Q3 — the gate order, and what is subsumed

The evaluated order in `syncChangeRequestStatus` becomes:

1. **`deferred_non_default_base`** — unchanged, and still FIRST. A merge with no
   path to the trunk is not partial completion, it is none.
2. **the actor gate** — unchanged.
3. **`deferred_incomplete_delivery_set`** — **NEW.** Any member of the card's
   delivery set that has not merged onto its own repository's default branch holds
   the card. Placed here because it is the most specific and most informative
   answer available, and because a card with links should be decided by its links
   rather than fall through to a proxy.
4. **`deferred_open_pr`** — unchanged, and now rarely reached.
5. **`deferred_incomplete_repo_set`** — unchanged.

### The two subsumption questions, answered

- **`deferred_open_pr` — SUBSUMED for a card that has delivery links, and kept
  for one that does not.** _The delivery set filtered to open_ is exactly what it
  computes. It is not retired here, because its outcome is a value the v1 contract
  and the MCP payloads already expose and removing it is a contract change with
  its own blast radius. **A follow-up card asks whether it can go** once every
  card has links.
- **`deferred_incomplete_repo_set` — NOT SUBSUMED. It stays, permanently.** It
  answers a question the delivery set structurally cannot: _has every repository
  this card CARRIES seen a merge?_ The delivery set knows only about pull requests
  that EXIST, so a repository whose pull request was never opened writes no row
  and is invisible to it. That is the gap the repo-set gate was built for and it
  is unchanged by this decision.

**Two gates that look alike are kept apart on purpose.** The delivery set is
evidence about work that happened; the repository set is a declaration about work
that was promised. A card can satisfy either without the other, and collapsing
them would lose the distinction in the direction that closes a card early.

---

## What MOTIR-3673's exemption becomes

**It disappears.** The unlinked-pull-request check (story MOTIR-3672) needed a
session-branch exemption because a `motir auto` pull request carried
`work_item_id: null` by construction and would have gone red on every auto run —
a permanent false positive on the busiest lane. Under this decision that pull
request is linked to every card it delivers, from its first iteration, so the
check passes on it for the ordinary reason. **MOTIR-3673's Q2 should record the
exemption as unnecessary rather than write it.**

---

## Superseding MOTIR-3527

`change-request-cardinality.md` decided **"KEEP THE SINGULAR FK. No join table"**
on 2026-08-26, and explicitly rejected _"(a) a join table with ONE meaning —
`(work_item_id, pull_request_id)`, every row a completion"_. That is the shape
adopted here. The reversal is not a disagreement about values; it is that two of
its premises are false and its arguments were aimed at a different design.

### Its three arguments, and why none reaches this one

1. **"A join table populated from a pull request is an assertion by a party that
   is GUESSING which cards a diff finished, and guessing is the failure mode this
   whole story exists to end."** — This table is not populated from a pull
   request. Every row is written by `link_pull_request`, a per-card declaration by
   the agent that did that card's work. That is precisely the _"assertion by a
   party that knows"_ the older ADR wanted; the disagreement is only about whether
   such an assertion lives in a column or a row. Its companion worry — that a join
   table _"invites bulk population from whatever the diff touched"_ — is foreclosed
   by the single-key decision above: there is no bulk door to invite anyone
   through.
2. **"It survives the pull request. The membership question is asked twice, one
   hop apart — at CI green and at merge — and the answer must not differ. One
   column answers both."** — Satisfied. Both reads hit this one table, and
   MOTIR-3685 requires them to read it the same way.
3. **Q4: a join table would close "a story with a `manual` child, a child whose
   work was skipped, or a child added after the branch was cut."** — None of those
   links itself, so none of them acquires a row. The property that makes
   `session_branch` safe — a card joins the set by its own act — is the property
   this table has.

### The two premises that fell

- **"Many cards, one pull request is already expressible."** It is expressible
  only in the sense that the cards close. **The pull request itself stays linked
  to nothing:** its `work_item_id` is null, so a `motir auto` pull request appears
  on **no card's Development rail**. A mechanism that closes cards while leaving
  the delivery invisible to every one of them is not the same capability.
- **A branch name is treated as an identifier throughout, and it is not.**
  `findBySessionBranch` is workspace-scoped while the runbook reuses one branch
  name across every repository a card touches. The older ADR never considers the
  two-repositories-one-branch-name case, which is the exact case MOTIR-3655 was
  filed for.

### And its own Consequences section names this story's defect

> _"The `deferred_open_pr` residual hazard is unchanged and still real. It counts
> open linked pull request ROWS, so it protects a card whose pull requests are all
> open and does nothing for one whose sibling pull request does not exist yet.
> Under Q2 that is the mechanism for partial delivery, so the hazard is now
> load-bearing rather than incidental: **link the second pull request BEFORE the
> first one merges, or the first merge closes the card.**"_

That is MOTIR-3655's defect, written down, with a mitigation that is human
discipline about ordering. `deferred_incomplete_delivery_set` replaces the
discipline with a gate. An accepted decision whose stated residual hazard is the
subject of a later story is the ordinary reason a decision gets revisited, and it
is the strongest single argument for this one.

### What MOTIR-3527 got right and is KEPT

- **The link must be a per-card ACT, never an inference from a diff.** This
  decision keeps that completely — it is why `link_pull_request` stays single-key
  and why the title parse is retired by MOTIR-3672.
- **There is only ONE kind of link, and it is a completion claim.** Its Q2
  rejected a `contributes-to` relation on the grounds that no actor can evaluate
  the discriminator at link time. That reasoning is untouched by the cardinality
  change and is **not** re-opened: this table has no relation column.
- **Its observation that the hand-run parent-run does not use the mechanism.**
  Under this decision it does, because every child links itself.

---

## Premises, verified

Re-read on `origin/main` at `d4072154c`.

- **The FK, and the absence of a join table — CONFIRMED.**
  `prisma/schema.prisma`: `workItemId String? @map("work_item_id")` on
  `GithubPullRequest`, `repoId String @map("repo_id")`, no `workspaceId`, and no
  join model anywhere.
- **`findBySessionBranch` is workspace-scoped — CONFIRMED.**
  `lib/repositories/workItemRepository.ts`: `where: { sessionBranch, workspaceId }`.
  No repository predicate.
- **`motir auto` is multi-repository — CONFIRMED.**
  `lib/dispatch/promptTemplate.ts`'s `sessionLineageWorkflow` builds its worktree
  from `src.targetRepo` and branches off `origin/<sessionBranch>` in that card's
  own repository, so the session branch exists once per repository and a run
  spanning three opens three pull requests.
- **`link_pull_request` is single-key — CONFIRMED.**
  `lib/mcp/tools/linkPullRequest.ts`, `inputSchema.key`.
- **The absent `in_review → implemented` edge — CONFIRMED** against the project's
  workflow transition set.
- **`ciPromotion` is a latch over `derivePrCiState` — CONFIRMED**, and its rule
  that _"the only thing entitled to move a card between those two is the build"_
  is unchanged by this decision.
