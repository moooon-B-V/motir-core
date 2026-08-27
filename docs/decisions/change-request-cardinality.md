# May one pull request complete more than one work item?

**Status:** ⚠️ **SUPERSEDED** by [`work-item-delivery-links.md`](./work-item-delivery-links.md)
(MOTIR-3656, story MOTIR-3655, 2026-08-27) · **Originally accepted:** 2026-08-26 ·
**Card:** MOTIR-3527 (story MOTIR-3525)

> ## ⚠️ SUPERSEDED — Q1, Q3 and Q4 were REVERSED
>
> **The answer is now a join table**, `WorkItemDelivery(workItemId,
githubPullRequestId, repoId, workspaceId)`, many-to-many, retiring BOTH
> `work_item.session_branch` and `github_pull_request.work_item_id`. Read
> [`work-item-delivery-links.md`](./work-item-delivery-links.md) for the decision;
> its **Superseding MOTIR-3527** section argues the reversal against this file
> point by point.
>
> **Two premises below are false**, and neither is considered here:
>
> 1. _"Many cards, one pull request is already expressible"_ via `session_branch`
>    — expressible only in that the CARDS close. The pull request itself keeps
>    `work_item_id: null`, so a `motir auto` pull request appears on **no card's
>    Development rail**.
> 2. **A branch name is treated as an identifier throughout, and it is not.**
>    `findBySessionBranch` matches `where: { sessionBranch, workspaceId }` —
>    workspace-scoped — while the runbook reuses ONE branch name across every
>    repository a card touches. The two-repositories-one-branch-name case is never
>    examined, and it is the exact case MOTIR-3655 was filed for.
>
> **And the _Consequences_ section below names the defect that reversed this**, in
> its own words: _"link the second pull request BEFORE the first one merges, or
> the first merge closes the card."_ That residual hazard is MOTIR-3655's subject,
> and `deferred_incomplete_delivery_set` replaces the ordering discipline with a
> gate.
>
> **What SURVIVES and is carried forward unchanged:** the link is a per-card ACT
> and never an inference from a diff (which is why `link_pull_request` stays
> single-key and the title parse is retired by MOTIR-3672); and **Q2 stands
> entirely** — there is ONE kind of link, it is a completion claim, and there is no
> `contributes-to` relation. The successor has no relation column.
>
> **The text below is preserved as written.** Nothing in it is edited, because a
> superseded decision that has been quietly corrected cannot be audited against the
> one that replaced it.

> **On the file name.** `docs/decisions/` is slug-named, not numbered — forty-eight
> files, none carrying an ordinal — so this takes the next free SLUG, checked
> against `origin/main` and against every unmerged sibling branch
> (`git show <branch>:docs/decisions/`) for the same reason a number would have
> been: two parallel runs picking the same name collide (`adr-number-race`).

`github_pull_request.work_item_id` is a **single nullable FK** and there is no
join table, so at the level of that column one pull request completes at most one
work item. The story that commissioned this ADR asked whether that is right, and
asked it now rather than leaving a note, because three shapes the product already
produces collide with it and one measured defect runs the other way.

Every premise below was re-read on `origin/main` at `f3fff8cd`. The card's own
framing was accurate about the FK and about the three shapes; where it was
incomplete is recorded under **Premises, verified** at the end — and the omission
turns out to decide the answer.

---

## The three shapes, and the defect running the other way

1. **A parent-run opens ONE pull request for a whole story.** `run.md`'s parent
   flow lands every child as a commit on a `parent/MOTIR-<id>-<slug>` branch and
   opens one parent→`main` pull request carrying the PARENT's key. The children
   are referenced only in commit messages, which the sync does not parse, so they
   are closed by a roll-up sweep at the start of the next run rather than by the
   merge.
2. **A card that ships in more than one repository already has a repository SET**
   (MOTIR-2725), and the completion gate counts merges across it. That is the
   first mechanism that made _"one card, several pull requests"_ real. This
   question is its transpose.
3. **A corpus sweep opened one pull request delivering rule changes owed by
   twenty-five separate records** (the planner-bug home sweep, 2026-08-26). It
   carries no key precisely because a title holds one, and closing one card while
   shipping the other twenty-four unlinked is the defect MOTIR-3412 records.

And the inverse: **MOTIR-3412 also measured a pull request delivering ONE of FOUR
acceptance criteria closing a four-criterion card.** So the singular FK looks
wrong in both directions — it cannot express _many cards, one pull request_, and
it cannot express _this pull request contributes to but does not complete this
card_.

---

## Q1 — The cardinality

### Decision

**KEEP THE SINGULAR FK. No join table.** _"Many cards, one pull request"_ is
already expressible, and it is expressible through a better-placed key than a
column on `github_pull_request`.

`lib/services/changeRequestWorkItems.ts` — shipped for MOTIR-3007 — resolves
which work items a delivery carries, and it has two arms:

```
resolveChangeRequestWorkItemSet({ workspaceId, headRef, linked, tx })
  → { kind: 'session_branch', sessionBranch, items: [ …every card recorded on it… ] }
  → { kind: 'single_item',    sessionBranch: null, items: linked ? [linked] : [] }
```

The first arm reads `workItemRepository.findBySessionBranch(headRef, …)` — every
work item whose `session_branch` column names this pull request's head ref. On a
`done` delivery `changeRequestStatusSync` takes the `session_closed` path and
closes **every one of them**. It is not a name pattern and deliberately so: that
module's own header says _"a branch is a session branch when cards say they were
integrated onto it"_.

So the many-cards mechanism exists, it is exercised on every `motir auto` run,
and its key is a column on the **WORK ITEM** rather than a row joining a pull
request to one. That placement is the substance of this decision, not an
implementation detail:

- **It is a per-card ACT, not an inference about a pull request.** A card joins
  the set by someone writing `session_branch` on it — `mark_integrated` is the
  door — which is an assertion by a party that knows. A join table populated
  from a pull request is an assertion by a party that is guessing which cards a
  diff finished, and guessing is the failure mode this whole story exists to end.
- **It survives the pull request.** The membership question is asked twice, one
  hop apart — at CI green (MOTIR-3006) and at merge — and the answer must not
  differ. One column answers both.
- **It costs no migration.** The FK has rows in every deployed database, and both
  its readers (the Development surface, the sync) would have to keep working
  through a join-table cutover for a capability that is already shipped.

### What the answer does to the three shapes

- **Shape 3 (the twenty-five-record sweep) is SOLVED as it stands.** Those cards
  can record the sweep's branch and the merge closes all twenty-five. Nothing new
  is needed; what is needed is for a sweep to use it.
- **Shape 2 is untouched**, correctly — it is the transpose, served by the
  repository SET and by `countOtherOpenByWorkItem`'s defer.
- **Shape 1 (the parent-run) is solvable by the same mechanism and does not
  currently use it.** That is an observation, not a deferral; see _Consequences_.

---

## Q2 — The relation, which matters more than the cardinality

Is every link a claim of COMPLETION, or is there a second kind — _contributes to_
— that renders on the Development surface and is invisible to the completion gate?

### Decision

**Every link is a COMPLETION claim. There is no second kind of link.**

The case for a `contributes-to` relation is MOTIR-3412's four-criterion card, and
that case does not survive being looked at closely: **that failure has ONE card
and ONE pull request.** It is not a cardinality problem, so a join table would not
have prevented it and a second relation would only have given the wrong party a
second way to be wrong. What actually happened is that the link was **asserted by
a parse** — the title mentioned a key, so the sync inferred delivery. The fix is
the one MOTIR-3526 shipped: the link is DECLARED, by the agent that opened the
pull request, and an agent delivering one of four criteria simply does not
declare it.

And the partial case is already expressible without a new relation, because
completion is gated on more than the link's existence:

| gate                                 | reader                                                         | what it withholds                                                                              |
| ------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `deferred_open_pr` (MOTIR-1604)      | `githubPullRequestRepository.countOtherOpenByWorkItem`         | a card with another OPEN linked pull request stays In Review; only the LAST merge completes it |
| the trunk gate (MOTIR-1873)          | `changeRequestStatusSync`, `cr.baseRef !== repo.defaultBranch` | a merge that did not reach the trunk completes nothing                                         |
| the repository-SET gate (MOTIR-2725) | `listCompletionFactsByWorkItem`                                | a card is held until every repository in its set has merged                                    |

So _"this pull request contributes to the card but does not finish it"_ is said by
**linking the second pull request too**. The first merge defers, the last one
completes. That is a stronger statement than a `contributes-to` flag, because it
names what is still outstanding rather than merely declining to close.

---

## Q3 — What the completion gate counts

### Decision

**UNCHANGED. Nothing in the gate changes, and the two readers the card names are
named here as explicitly NOT changing.**

- **`changeRequestStatusSync`'s transition path** keeps reading _the item's linked
  pull requests_. Under Q2 every linked pull request is a completing one, so
  _"the item's COMPLETING linked pull requests"_ and _"the item's linked pull
  requests"_ denote the same set and no predicate is added.
- **`countOtherOpenByWorkItem`** keeps its `where: { workItemId, state: 'open', id: { not: excludePrId } }`
  — no relation column to filter on, and none wanted. Its sibling
  `countOpenByWorkItem` (the MOTIR-3034 re-evaluation path) is unchanged for the
  same reason.
- **The `session_closed` path** keeps closing every card recorded on the branch,
  and keeps NOT transitioning the title-linked item. A container therefore rolls
  up from its children rather than being closed directly, which is the correct
  order and is asserted by `tests/e2e/acceptance-scoped-run.spec.ts`.
- **No migration.** `github_pull_request` is untouched.

---

## Q4 — Should a story-wide pull request complete its children?

### Decision

**Yes — but only the children that RECORDED THEMSELVES on its branch, which is a
per-card act and never an inference from the pull request.**

This is the question that makes a naive join table worse than the FK, and it is
worth stating as its own answer because the two readings are one word apart. _"A
story-wide pull request completes its children"_ is right. _"A story-wide pull
request completes the children of the card it names"_ is MOTIR-3412's defect
multiplied by the child count: a story with a `manual` child, a child whose work
was skipped, or a child added after the branch was cut would all be closed green
and unbuilt.

`session_branch` expresses the first and cannot express the second. A join table
written from the pull request expresses the second and cannot tell it from the
first.

---

## Rejected

- **(a) A join table with ONE meaning** — `(work_item_id, pull_request_id)`, every
  row a completion. Solves shape 3 and makes shape 1 **worse**, per Q4. It is also
  strictly weaker than what already ships: `session_branch` carries the same set
  with an explicit per-card act behind it, while a join table invites bulk
  population from whatever the diff touched.
- **(b) A join table with TWO relations** — `completes` and `contributes-to`. The
  discriminator it introduces is one **no actor can evaluate at link time**. The
  agent calling `link_pull_request` knows WHICH card with certainty; whether its
  diff finished that card's acceptance criteria is a judgement made later, by a
  reviewer, often after CI. A field an actor must guess at is the parse again,
  wearing a schema.
- **(c) Retiring the FK in favour of `session_branch` for everything.** The FK is
  what the item detail page's Development section renders and what the picker
  writes; the single-item case is the overwhelming majority of pull requests and
  needs no branch ceremony. Two mechanisms with clearly separate domains — one
  card by its link, many cards by their branch — is the shape that already works.
- **(d) Deciding nothing and leaving a note.** Recorded as rejected because it was
  the status quo this card was filed against: the FK's singularity was an
  unexamined property that three shipped shapes were already straining, and an
  unexamined property is one a later card re-litigates from scratch.

---

## Consequences

- **No card is owed by this decision, and that is the decision rather than a
  deferral.** MOTIR-3527's own criterion says a _keep-the-FK_ answer is recorded
  as a decision with no card, with its reason. The reason: every capability the
  three shapes need is already shipped — `session_branch` for many cards,
  `deferred_open_pr` for partial delivery, the repository SET for many
  repositories — so there is nothing to build, only something to use.
- **`link_pull_request`'s move-not-add semantics STAND UNCHANGED.** Its tool
  description says the FK is singular and that a second call naming a different
  item MOVES the link; `docs/mcp.md` says the same. Both are correct under this
  answer and neither is amended. (MOTIR-3526 shipped them stating the semantics
  plainly for exactly this reason — so that this decision could confirm them
  rather than have to correct them.)
- **⚠️ AN OBSERVATION, NAMED SO IT IS NOT MISTAKEN FOR A DEFERRAL: the hand-run
  parent-run does not use the mechanism this decision rests on.** `run.md`'s
  parent flow closes its children through the next run's close-out sweep, while
  `session_branch` would close them on the merge itself — the same set, recorded
  the same per-card way, with no sweep to forget. That gap PREDATES this card and
  is not created by it, so no card is opened here; it is written down because a
  decision that says _"the mechanism already exists"_ owes the reader the one
  place it is not being used.
- **The `deferred_open_pr` residual hazard is unchanged and still real.** It
  counts open linked pull request ROWS, so it protects a card whose pull requests
  are all open and does nothing for one whose sibling pull request does not exist
  yet. Under Q2 that is the mechanism for partial delivery, so the hazard is now
  load-bearing rather than incidental: link the second pull request BEFORE the
  first one merges, or the first merge closes the card.

---

## Premises, verified

Re-read on `origin/main` at `f3fff8cd`.

- **The FK and the absence of a join table — CONFIRMED.**
  `prisma/schema.prisma`: `workItemId String? @map("work_item_id")` on
  `GithubPullRequest`, with `@@unique([repoId, number])` and no join model
  anywhere.
- **The three gates — CONFIRMED**, at the readers named in Q3.
- **⚠️ The card's framing was INCOMPLETE, and the omission decides the answer.**
  MOTIR-3527 states _"there is no join table: one pull request completes at most
  one work item"_, and treats shapes 1 and 3 as unserved. The first clause is
  true of the SCHEMA and the second does not follow from it: `session_branch` +
  `resolveChangeRequestWorkItemSet` (MOTIR-3007) already close many cards from one
  merged pull request, and have since before this card was written. The card's own
  shape-1 paragraph half-notices this — it says the children "are closed by a
  separate roll-up sweep rather than by the merge" — without connecting it to the
  mechanism that would close them by the merge. Recorded rather than quietly
  applied, per the house rule: a reader who checks the card against this ADR must
  be able to see that the difference is deliberate.
- **`sessionBranchName` keeps the key OUT of the session branch — CONFIRMED**
  (`packages/cli/src/git.ts`), and `changeRequestWorkItems.ts`'s header says why:
  so the 1:1 resolver cannot pick one of a run's cards at random. That is the same
  instinct as this decision, one layer down.
