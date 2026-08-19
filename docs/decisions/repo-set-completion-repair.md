# ADR: The repository-set completion gate gets a SECOND CHANCE — a backfilled base and an event-free re-evaluation

- **Status:** Accepted (2026-08-18)
- **Story / Subtask:** Bug MOTIR-3034 (Epic MOTIR-2200) · found on the live instance
- **Extends:** [`work-item-repository-set.md`](./work-item-repository-set.md) §4 (the
  completion rule) and MOTIR-2729's `github_pull_request.base_ref` column
- **Consumed by:** `lib/services/pullRequestBaseRefBackfillService.ts` ·
  `lib/services/repoSetCompletionService.ts` · `scripts/backfill-pull-request-base-ref.ts` ·
  `scripts/reevaluate-repo-set-completion.ts`
- **Supersedes / superseded by:** none. It relaxes NOTHING in
  `lib/workItems/repoDelivery.ts`.

> Structured **Context → Decision → Consequences → References**, the convention the
> repo's ADRs set. The card that produced it asked for one thing to be recorded here
> explicitly — WHICH FORM the re-evaluation path took, and why — because the card
> deliberately left that open. §2 is that answer.

---

## Context

Three decisions, each correct in isolation, compose into a state with no exit.

1. **A null `base_ref` reads as UNKNOWN, in both directions.**
   `lib/workItems/repoDelivery.ts` says so at the top of the file and means it: treating
   a null as satisfied completes a card on a possibly-STRANDED merge (MOTIR-1873 —
   merged onto a sibling branch that was then deleted, `merged: true` forever, no path
   to the trunk), and treating it as outstanding asserts something false about a merge
   that may well have landed.
2. **The column shipped NOT backfilled.** `20260818120000_pull_request_base_ref` says
   there is nothing to backfill it FROM — the base is not derivable from any other
   column, and defaulting it to `main` would manufacture the guess the story existed to
   remove.
3. **The completion decision runs on a DELIVERY event.** `changeRequestStatusSync` is
   the gate's only caller, and a delivery is when the answer can change.

Put together: for a repository whose work merged BEFORE the column existed, the row is
null, the repository is `unknown`, the item is held — and **no further delivery is ever
coming**, because the merge already happened. The item is held forever by a row nothing
will update, with no surface that can repair it.

This is not hypothetical. On 2026-08-18 it caught **MOTIR-2725, the story that built the
gate**, on the day it shipped: `motir-meta` #240 merged at 19:03:22Z, the sync ran, and
the card stayed In Review because `motir-core` #2121 — which _did_ merge onto `main`,
verified `baseRefName: main`, `mergedAt` 18:10:01Z — was mirrored before the column
existed. A ONE-element repository set, held by the arm written for the multi-repository
case.

The migration's own comment anticipates the outcome and rejects it — _"it does not prove
it did not (which would hold every already-complete card in the product)"_ — but that
reasoning was applied to the CLASSIFIER's two directions, not to the ITEM's fate. The
classifier is right. What is missing is anything that asks it a second time.

The blast radius is bounded and finite: every `github_pull_request` row that existed
before the base-ref deploy. It never grows — `baseRef` is required on
`NormalizedChangeRequest` and supplied by the GitHub parser, the GitLab parser and the
historical-PR backfill alike.

## Decision

### 1. BACKFILL `base_ref` from the provider — targeted, merged-only, never a guess

`pnpm db:backfill:pr-base-ref` (`pullRequestBaseRefBackfillService`) reads the base back
off `GET /repos/{owner}/{name}/pulls/{number}` with an installation token and writes it
onto rows that do not have one.

**Targeted, and not the historical-PR sweep beside it.**
`historicalPullRequestBackfillService` already re-reads a repository's whole merged
history and already writes `baseRef`, so running THAT would also fill these rows. It is
the wrong instrument, on two axes:

|                 | historical-PR sweep                                                                                  | this repair                           |
| --------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------- |
| requests        | one per PR in the repo's entire merged history                                                       | one per AFFECTED ROW                  |
| columns written | the whole content tuple — `state`, `merged`, `head_ref`, `title`, and the RE-RESOLVED work-item link | `base_ref`, and only where it is null |

The second row is the one that decides it. This repair has no business re-deriving a
work-item link: a row it touches must differ from its previous self in exactly the fact
that was missing, and nothing else.

**MERGED rows only** — the sub-decision the card asked to be recorded rather than
assumed. `classifyRepoDelivery` filters on `f.merged` before it ever reads `baseRef`, so
an unmerged row's null base is never a term in the gate; and an OPEN change request's
base is still mutable, so a value read today can be wrong tomorrow and the next delivery
writes the right one anyway. Spending a rate-limited request on either buys nothing.

**Unanswerable ≠ error, and neither is a guess.** A pull request the installation cannot
read — deleted or transferred repository, a number that 404s — leaves the column NULL and
the repository UNKNOWN, and is COUNTED as `unanswerable` in the report. The fail-closed
state is not a bug being worked around; this repair removes REASONS to be unknown, it
does not remove the state. A host that could not be reached at all is a per-repository
error and the sweep continues with the next repository.

**Idempotent at the database, not by a comparison.** The candidate query is
`merged AND base_ref IS NULL` and the write re-asserts `base_ref IS NULL`
(`setBaseRefIfNull`). A filled row leaves the candidate set, so a second run makes ZERO
host calls and ZERO writes, a repository with nothing to fix never even mints a token,
and a live delivery that filled a row mid-sweep is never clobbered (it is counted as
`racedByDelivery` — its value came from the payload and is at least as good).

### 2. THE RE-EVALUATION PATH — a SERVICE METHOD the backfill calls per touched item, plus an operator script over the same method

**This is the choice the card left to the implementation, and the answer is (a)+(c) of
the three it offered: a service method, and a CLI over it. Not (b) an affordance on the
item.**

- **`repoSetCompletionService.reevaluateItem(workItemId)`** is the primitive. The
  backfill calls it for every item whose row it filled, so the ordinary repair is one
  command and the two halves cannot be run half-way by accident.
- **`pnpm db:reevaluate:repo-set --item=<id>`** is the same method with no backfill in
  front of it — for the two situations that produce a stale verdict with no null base at
  all: an item whose repository SET was edited after its pull requests merged, and a
  repository whose DEFAULT BRANCH was renamed.

**Why a service method rather than only a script.** The card's own framing is that the
two halves are one repair: _"backfilling alone leaves every already-held card held,
because a corrected row changes nothing until something re-runs the decision."_ A repair
whose second half is a separate command an operator must remember is a repair that will
be run half-way, and the half that gets skipped is the one with the visible effect. Making
the primitive a service method is also what lets any future caller — a repository-set
edit, a `repository.renamed` delivery, an item-level affordance if one is ever wanted —
re-ask the question without re-implementing it.

**Why NOT an affordance on the item (the rejected option).** A button on the work item
would put the completion decision in a tenant user's hands at the exact moment the gate is
holding their card, which is when the pressure to complete it is highest and the evidence
is weakest. Nothing about the button could be wrong — it re-runs the same gate — but it
converts a data-repair operation into a self-service one, and the population that needs it
is bounded, finite and shrinking to zero. An affordance is the right shape for a recurring
need; this one has an end.

**What the re-evaluation is NOT allowed to be.** It owns no copy of the rule. The decision
comes from `lib/workItems/repoDelivery.ts` — the module that exists precisely so the gate
and the surface can never disagree — and the write goes through
`workItemsService.updateStatus`, the shipped authority. Three guards keep it from being a
bulk status rewrite:

1. **An EMPTY repository set ABSTAINS**, exactly as the gate abstains on a delivery. Every
   card in the product that never pinned a repository is in that state; completing them
   would be the single most damaging thing this repair could do.
2. **Any OPEN linked change request HOLDS it.** This is MOTIR-1604's rule, restated for a
   caller with no delivering row: the sync excludes the row it is deciding because that
   row has just closed, and nothing is closing here — so every open sibling counts. It is
   deliberately STRICTER than the delivery path.
3. **The transition is resolved BY CATEGORY against the project's live workflow** and
   applied through the write authority, so a card with no legal edge to done reports
   `illegal_transition` rather than being forced.

**Tenancy.** A caller holding only a work-item id cannot read `work_item` — that table has
no `system_admin` policy arm, and an unbound read returns ZERO ROWS and raises nothing
(MOTIR-2880), which would present as "no such work item" for an item that plainly exists.
So the workspace is resolved FIRST off the CONNECTION tier —
`githubPullRequestRepository.findWorkspaceIdByWorkItem`, a `github_pull_request` →
`github_repo` read where BOTH tables are armed — and `bindWorkspaceContext` is called
before the first tenant-table statement. An item with no linked change request has no
trusted tenant and is reported as `no_linked_change_request` rather than guessed at.

### 3. The hold NOTE stops claiming the item ships in more than one repository

`incompleteRepoSetCommentBody`'s heading read _"Merged, but this item ships in more than
one repository"_. The incident above is a ONE-element set, so the note told its reader
something plainly false about their own card, in bold, at the top. The gate is about
**every** repository, never about **more than one** — a set of size one is the common
case here, not an edge case. The heading is now cardinality-free, the per-repository
detail lines carry the specifics unchanged, and the `unknownBase` line now names the
repair (`pnpm db:backfill:pr-base-ref`) instead of telling the reader to re-merge.

## Consequences

- **The gate stays fail-closed and is not relaxed anywhere.** `unknown` still means
  unknown, still holds, and a row the provider cannot answer for still holds forever —
  correctly. What changed is that the population of such rows can now shrink, and that a
  verdict can be re-asked.
- **A verdict is no longer a function of when a delivery happened.** Any caller can ask
  the gate again. That is a new power and the three guards in §2 are its boundary.
- **Two operator commands, one dependency between them.** `db:backfill:pr-base-ref`
  subsumes `db:reevaluate:repo-set` for the null-base case; the second exists for the
  cases the first cannot see.
- **The `github_pull_request` mirror gains no column and no policy.** One existing column
  gets values it could always have held.

## References

- `lib/workItems/repoDelivery.ts` — the shared classification (`classifyRepoDelivery`,
  `repoSetShortfall`, `hasRepoSetShortfall`) and the `unknown` doctrine.
- `lib/services/changeRequestStatusSync.ts` — `deferred_incomplete_repo_set`, and the
  delivery-event trigger that was the only caller.
- `prisma/migrations/20260818120000_pull_request_base_ref/migration.sql` — nullable, no
  backfill, and the reasoning this decision completes.
- [`work-item-repository-set.md`](./work-item-repository-set.md) §4 — the completion rule
  and its same-day amendment (planning bug MOTIR-2979).
- `notes.html` #313 — a card specified a STATE check by pointing at an EVENT check; this
  bug is the next square along, where the STATE check's only trigger is still the event.
