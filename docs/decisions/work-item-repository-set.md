# A work item's repositories are a SET (`work_item.targetRepos`)

**Status:** accepted · **Date:** 2026-08-18 · **Card:** MOTIR-2726 (Story MOTIR-2725) ·
**Extends:** `docs/decisions/target-repo-attribution.md` (which decided the singular pin)

**Consumed by:** MOTIR-2727 (schema + write path) · MOTIR-2728 (read seams) ·
MOTIR-2729 (completion gate) · MOTIR-2413 / MOTIR-2414 (the two designs) ·
MOTIR-2415 / MOTIR-2416 (the two surfaces) · MOTIR-2417 (integration gate) ·
MOTIR-2730 (E2E)

> That list is a WORKLIST, not a record that the work is done. It is written here so
> the sweep in "Binding on MOTIR-2725's cards" below has an enumeration to walk —
> `notes.html` #197 is the case where an enumerated list was mistaken for the sweep
> itself, and #304 is the case where the sweep ran outward only.

## Context

`work_item.targetRepo` is one nullable `String` and `work_item.targetRepoRole` one
nullable `ProjectRepoRole`. A card whose work genuinely lands in two repositories — a
boundary contract with a producer side and a mirror side — has nowhere to record the
second one.

The cost is not cosmetic. `lib/services/changeRequestStatusSync.ts` completes an item
on a merge unless one of two gates holds it, and the gate that exists for exactly this
case counts what has ARRIVED:

```ts
// lib/repositories/githubPullRequestRepository.ts
async countOtherOpenByWorkItem(workItemId, excludePrId, tx) {
  return tx.githubPullRequest.count({
    where: { workItemId, state: 'open', id: { not: excludePrId } },
  });
}
```

A repository whose pull request has not been OPENED yet writes no row, so the count is
zero and the item completes on half its work. That is not a defect in
`countOtherOpenByWorkItem` — it answers precisely the question it was written for. The
missing input is the EXPECTED side, and the only honest ledger of what is expected is
the set the card itself carries. On 2026-08-11 that produced a parent closing on its
first merge and cascading `done` onto children with no code written (MOTIR-2664; the
incident is recorded on MOTIR-2700).

Turning the pin into a set touches 91 files
(`git grep -l targetRepo origin/main -- '*.ts' '*.tsx' '*.prisma'` → 91), including the
versioned `/api/v1` schema, the MCP tool payloads and the CLI's generated client. The
shape is therefore decided once, here, rather than by whichever implementation card
reaches it first.

## Decision

### 1. Storage — an ORDERED ARRAY COLUMN, `targetRepos String[]`, beside the existing scalar

```prisma
targetRepos           String[]          @default([])
targetRepo            String?           // KEPT — the PRIMARY, derived from targetRepos[0]
targetRepoRole        ProjectRepoRole?  // KEPT, and still singular — see §1.3
```

The set is **ordered**, **de-duplicated**, and **element 0 is the primary** — the one
repository dispatch routes to (§2). An empty array and a null pin are the same state:
_this card does not say where it ships_, which is legitimate, common, and the default.

#### 1.1 Why an array and not a join table

The card's own recommendation was (A), and the price of choosing (B) or (C) was stated
as: _name what integrity the chosen shape provides that the alternatives do not,
measured against what the column has on `origin/main` today._ Measured:

| Property `targetRepo` has today                              | Source                                                                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| No foreign key                                               | `schema.prisma`: _"no DB constraint, since the domain lives in another table and changes as repos connect/disconnect"_ |
| No index                                                     | `schema.prisma`: _"unindexed (never a lookup key)"_                                                                    |
| No join — it is never a query key, only a projected value    | `lib/mappers/workItemMappers.ts:72`, `lib/api/v1/workItems/schema.ts:575`                                              |
| Validated at the WRITE layer against a project-scoped domain | `lib/workItems/dispatchRepo.ts` → `matchAuthoredTargetRepo`                                                            |

A join table would supply referential integrity against a domain that **is deliberately
not referentially bound** — a pin is a recorded decision that must survive its repository
being briefly disconnected (`target-repo-attribution.md` §1, rejecting an FK to
`github_repo` for exactly this reason). It would also add a workspace-scoped table, its
RLS policies, a repository module and a join on every work-item read, in exchange for a
`position` column that a Postgres array gives for free and an integrity guarantee the
column never had and does not want.

**Rung 2 — the shape is already this codebase's idiom for an ordered scalar set**, on
tenant tables included: `project.publicTags`, `estimation_scale.customScaleValues`,
`api_token.scopes`, `code_audit.changedPaths`, `automation_rule.targetKeys`,
`plan_item.blockedByRefs`, `import_run.requestedLabels`. None of them is a join table,
and every one of them inherits its parent row's RLS policies unchanged — which is the
practical reason this decision is cheap: **a scalar array on `work_item` is covered by
`work_item`'s existing policies with no policy work at all.**

Rejected, on the record:

- **(B) a join table with the scalar dropped.** Buys the integrity described above,
  which this column has never had; costs a new tenant table + RLS + repository + a join
  on the hottest read in the product; and _drops a field that `/api/v1` publishes_,
  which §8 of `public-api-conventions.md` forbids without a major version.
- **(C) a join table plus the scalar kept as a denormalized primary.** All of (B)'s
  cost, plus two writable representations of one fact. The denormalization is only safe
  under a single-writer rule, and a single-writer rule that nothing enforces is a
  convention, not a decision.

#### 1.2 Order is meaningful, and that is a claim about the WRITE, not about the reader

The array preserves insertion order; the write path de-duplicates keeping the FIRST
occurrence (case-insensitively, storing the domain repo's own casing, exactly as
`matchAuthoredTargetRepo` already does for one value). So element 0 is whatever the
author put first.

That is a weaker guarantee than it sounds, and it is worth saying so here rather than
letting a surface discover it: **an author who did not think about order still produces
a first element.** This is why MOTIR-2413 is required to make the primary _visually
distinguishable_ rather than rendering N equal chips — the asymmetry is real, it drives
dispatch, and a reader must be able to see it and correct it.

#### 1.3 `targetRepoRole` stays SINGULAR in this story — deliberately, with the reason recorded

MOTIR-2726 proposed `targetRepoRoles ProjectRepoRole[]` beside the names. It is not
taken here, and the two facets are not made into parallel index-aligned arrays, because
**parallel scalar arrays cannot represent the states this domain has.** An element of
the set is one of:

1. a NAME, no role — a human or agent pin. Every pinned row on `origin/main` today.
2. a ROLE, no name — planned before the repository exists (`schema.prisma`: _"at
   generation the repositories DO NOT [exist] … a role is stable across both"_).
3. both — after MOTIR-1913's resolution pass fills the name. The pass does **not** clear
   the role (`workItemRepository.lockUnpinnedIdsByRepoRole` +
   the pin write, `WHERE targetRepo IS NULL`), so the two are complements describing one
   repository.

A set mixing states 1 and 2 has no index-aligned representation in two Prisma scalar
lists, which admit no null elements. Expressing it needs one row per element — a join
table — and that cost is not justified by anything this story delivers, because:

- **The completion gate's expected side is NAMES.** A role that has not resolved to a
  repository has no repository, therefore no default branch and no pull request; it
  cannot be a term in "has every repository merged?".
- **Nothing can author a multi-element role list yet.** Roles reach `work_item` only
  through `plansService.materialize` from `PlanItemProposedFields.targetRepoRole`, which
  is one value per proposed node. The planner emitting a set is MOTIR-2732, explicitly
  out of scope for MOTIR-2725.

So the role remains the portable stand-in for the PRIMARY, unchanged, and widening it
travels with the card that can first produce one. **That deferral is a card, not a
sentence** — see "What this decision leaves unowned" below. Recording it matters: this
story exists partly because a repository field was planned as a singular without anyone
examining the count (`notes.html` #279 / MOTIR-2733), and an unexamined singular is the
mistake, not a singular whose reason is written down.

### 2. Dispatch — the PRIMARY, and nothing else changes

`resolveDispatchRepo` returns the same three-rung answer it returns today, reading the
primary where it read the pin:

1. the item's explicit primary — `targetRepos[0]`, else the legacy scalar when the row
   predates the backfill (it cannot, after the migration; the rung is stated so the
   function's contract is total); else
2. the project's SINGLE established repository, when that is unambiguous; else
3. `null` — a real answer the CLI acts on.

`ArchivedTargetRepoError` still throws for whichever repository the resolution landed
on. `lib/workItems/dispatchRepo.ts`'s two-domain ladder (the project's set, else the
workspace's connected repos) is untouched. The CLI is untouched, and `packages/cli`'s
`<root>/<name>` checkout rule keeps its single answer.

**Is an N-repo card ever AMBIGUOUS at dispatch? No.** The set is ordered, so it always
has a first element and the primary always wins; there is no tie for the resolver to
break. Ambiguity survives only where it already lived — rung 2, an unpinned card in a
project with two or more repositories, which still resolves to `null`.

**What element 0 means at write time:** the author's first-listed repository, preserved
by the write path. A caller that sends only the legacy scalar produces the one-element
set `[thatName]`, and its primary is that name — which is why every existing card's
dispatch is unchanged by construction rather than by inspection.

**Running a card across N repositories** — a worktree and a pull request per repo — is
MOTIR-2731 and is NOT decided here. This decision deliberately leaves `motir run` with
exactly one repository per dispatch, which is what keeps MOTIR-2725 inside `motir-core`'s
app layer.

### 3. The public shapes — ADDITIVE on all three, and the scalar means THE PRIMARY

| Surface                                                                      | Change                                                                                              | Kind         |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------ |
| `lib/api/v1/workItems/schema.ts` (read, `:366`/`:575`)                       | ADD `targetRepos: string[]`; KEEP `targetRepo: string \| null` = the primary                        | **additive** |
| `lib/api/v1/workItems/schema.ts` (write, `:715`/`:743`)                      | ACCEPT optional `targetRepos: string[]`; KEEP optional `targetRepo`                                 | **additive** |
| `lib/mcp/payloads/workItems.ts` ITEM shape (`:179`/`:233`)                   | ADD `targetRepos`; KEEP `targetRepo` = the primary                                                  | **additive** |
| `lib/mcp/payloads/workItems.ts` DISPATCH shape (`:342`–`:344`/`:400`–`:402`) | **UNCHANGED** — single-valued, with its `targetRepoCloneUrl` / `targetRepoDefaultBranch` companions | none         |
| `lib/dto/workItems.ts` (`:152`, patches at `:900`/`:1042`)                   | ADD `targetRepos`; KEEP `targetRepo`                                                                | **additive** |
| `lib/api/v1/ready/schema.ts` · `lib/dto/ready.ts`                            | **UNCHANGED** — see §3.3                                                                            | none         |

#### 3.1 Why additive and not a replacement

`public-api-conventions.md` §8 lists _"removing a field"_, _"renaming a field"_ and
_"changing a field's type or nullability"_ as **forbidden without a new major**, and
_"a new field on a response object"_ as allowed. Turning `targetRepo` into an array
would be all three at once. There is no version of "replace the scalar" that is not a
`v2`, and a `v2` for one field on one resource is not a trade this story gets to make.

The cost of additive is honestly stated: **the product carries two ways to ask where a
card ships, permanently.** That is the price, and it is bounded by pinning the scalar's
meaning here rather than leaving it to drift: `targetRepo` **is** `targetRepos[0] ?? null`,
always, on every surface, and is never independently writable state.

#### 3.2 What a client written against today's shape sees afterwards

- **Every card that exists today**: byte-identical. Every row is either unpinned
  (`targetRepo: null`, and now `targetRepos: []`) or carries one pin (`targetRepo: "x"`,
  and now `targetRepos: ["x"]`).
- **A new multi-repository card**: `targetRepo` holds the FIRST repository — the one
  dispatch routes to, which is the question a client reading that field was asking.
  A client that never learns about `targetRepos` under-reports rather than mis-reports,
  and §8's _"a client MUST tolerate unknown fields"_ is the other half of the promise.
- **`V1_CONTRACT_VERSION` moves `1.8.0` → `1.9.0`.** Amendment 8 makes this obligatory
  for an additive change, because the number rides a response header rather than a
  document nobody fetches. This is an obligation on MOTIR-2728 and is added to its
  criteria (see the sweep).
- **No amendment to `public-api-conventions.md` is owed.** §8 already permits this
  shape of change; recording it as an exception would imply it was one.

#### 3.3 The READY row gains nothing, and that is already decided

`lib/api/v1/ready/schema.ts` deliberately carries **no** `targetRepo` at all —
Amendment 10 Q2 of `public-api-conventions.md` re-affirms the exclusion and routes a
client that needs it to `GET /api/v1/work-items/{key}/dispatch-prompt`. That endpoint is
the DISPATCH shape, which §2 leaves single-valued. So the ready row changes in neither
direction. MOTIR-2728's context ref asks this question; this is its answer, and it does
not need re-deriving.

#### 3.4 What the write path does when BOTH fields arrive

A caller may send `targetRepo`, or `targetRepos`, or neither — **never both.** A write
carrying both is rejected with a typed 422 (`UnknownTargetRepoError`'s sibling; MOTIR-2727
names it), and over MCP as a self-correctable tool error.

Rejected: a silent precedence rule ("`targetRepos` wins"). The two fields would then
disagree on the wire with no signal, and the losing value would be a decision the caller
believed they had recorded. A caller that wants a one-element set sends either field;
a caller that wants two sends `targetRepos`. There is no case that needs both.

#### 3.5 What `docs/mcp.md` must then say

`create_work_item` and `update_work_item` gain a `targetRepos` parameter whose
description states: it is ORDERED, the first element is the repository dispatch routes
to, it is validated element-by-element against the same project-scoped domain the
single pin is validated against, duplicates collapse, an empty array clears the set, and
`targetRepo` is the primary and may not be sent alongside it. **The tool description IS
the contract an agent reads** — an agent never opens this ADR — so the same sentences
appear in `docs/mcp.md`'s work-item section and in the two tool parameter descriptions.

### 4. Completion — the rule, in one sentence

> **A merge completes a work item only when, for EVERY repository name in the item's
> `targetRepos` set, the item has a linked change request that is merged onto that
> repository's own default branch; an item whose set is EMPTY is decided by the two
> existing gates alone, exactly as it is today.**

Testable, term by term:

- **Which repositories count as expected:** the names in `targetRepos`, and only those.
  Not the repositories of the item's linked pull requests, and not its children's sets.
- **What a merge on each must satisfy:** a linked `github_pull_request` row for that
  repository with `merged: true` whose base was that repository's own
  `repo.defaultBranch` — the same mirrored comparison `mergedIntoNonDefaultBase` already
  makes, never a hard-coded `'main'`.

  > **⚠️ Amended the same day, before the gate was built — the mirror did not RECORD the
  > base.** The sentence above says "reuse the comparison the first gate makes", and the
  > first gate makes it against `cr.baseRef`, a field of the LIVE delivery payload
  > (`changeRequestStatusSync.ts:213`). `github_pull_request` persists `state`, `merged`,
  > `merged_at`, `head_ref` and `changed_paths` — and no base
  > (`git grep "baseRef\|base_ref" -- lib/repositories/githubPullRequestRepository.ts`
  > → nothing). A per-delivery gate never needed it; a set-based gate asks about merges
  > that already happened in other repositories, and the mirror row is their only record.
  >
  > So **MOTIR-2729 also adds `github_pull_request.base_ref String?`**, written from
  > `cr.baseRef` (a required field on both providers and on the historical backfill),
  > **nullable and not backfilled** — a row written before the change genuinely does not
  > know its base. **A null reads as UNKNOWN, in both directions:** it does not satisfy a
  > repository (that would complete on a stranded merge — MOTIR-1873's case, `merged:
true` forever on a deleted branch, which is exactly the composition this gate must
  > not re-open), and it does not mark one outstanding either (that would hold every
  > already-complete card in the product on its next delivery). The hold names it as
  > _no record of the branch_ rather than asserting a branch Motir does not know.
  >
  > This paragraph is the ADR's own inward debt, found an hour after it was written and
  > fixed here rather than in a second document. Planning bug: **MOTIR-2979**.

- **The empty set:** the gate ABSTAINS. This is the common case and every card that
  exists today; it must not regress.

#### 4.1 A THIRD gate, beside the second — not a replacement

New outcome tag: **`deferred_incomplete_repo_set`**, added to the
`ChangeRequestSyncResult` outcome union.

Evaluation order, and the reason for each position:

1. `deferred_non_default_base` (MOTIR-1873) — first, unchanged. A merge with no path to
   the trunk is not partial completion, it is none.
2. `deferred_open_pr` (MOTIR-1604) — second, unchanged.
3. `deferred_incomplete_repo_set` — third, new.

**Replacing the second gate was considered and rejected.** The two answer different
questions and protect disjoint populations: `deferred_open_pr` holds a card whose sibling
change request is OPEN, and it works **without any expected set** — which is the state of
every card in the product today and of every card that never pins a repository. Dropping
it in favour of a set-based rule would silently remove the only protection those cards
have. The new gate holds a card whose sibling change request **does not exist yet**, a
state only an expected set can name.

Where both hold, the second fires first on purpose: _"a sibling pull request is still
open"_ names an artifact the reader can go and look at, which is strictly more
actionable than _"repository X has no merge"_.

#### 4.2 The hold is VISIBLE

Like the stranded-merge hold, the new hold posts a comment on the item naming the
repositories still outstanding — **once per merge**, guarded by the same
`mergeAlreadyRecorded` read taken under the row lock, and **best-effort**: a failed
comment leaves the hold intact and the delivery successful. A silent hold is what made
MOTIR-1873's incident expensive, and the same reasoning applies unchanged.

#### 4.3 The expected set is read inside the resolve transaction

`targetRepos` is read in the same `withSystemContext` transaction, after
`bindWorkspaceContext`, under the same row lock as the other two gates, so concurrent
redeliveries serialize exactly as they do now.

#### 4.4 The downward cascade needs no change — checked, not assumed

`childStatusCascadeService.cascadeToChildren` runs only once an item has ENTERED a
done-category status. A parent held at In Review by this gate never enters one, so the
cascade never fires and its children are not force-completed. The upward
`parentStatusRollupService` derives a parent from its children's aggregate; a parent
whose children are all done has, by construction, a merge in every repository any child
shipped to. Neither service is in this story's scope, and neither needs to be.

## The migration's back-compat contract

- Every non-null `work_item.targetRepo` becomes the one-element set `[thatValue]`; every
  null pin becomes `[]`. Backfilled in the SAME migration that adds the column.
- `targetRepoRole` is untouched — not backfilled, not widened, not read differently.
- **No card's resolved dispatch repository changes.** This is asserted directly by
  MOTIR-2727, over a fixture holding pinned, role-pinned and unpinned rows, not inferred
  from the rule above.
- The column is `@default([])`, so a row written by any path that predates the change
  gets the empty set rather than a null the readers would have to special-case.

## Out of scope, and who owns it

- **Dispatching across N repositories** (a worktree and a pull request per repo, and a
  parent that closes on all of them) — **MOTIR-2731**. §2 above is what keeps this story
  from touching it.
- **The planner PROPOSING a set** (`motir-ai` emitting `targetRepos` per node, and the
  `SHARED_PLANNING_RULES` mirror) — **MOTIR-2732**.
- **The planning RULE** that a story may span repositories while a subtask may not —
  **MOTIR-2700**, in `motir-meta`. This ADR fixes what a repository set IS; that card
  lifts this vocabulary rather than inventing a parallel one.
- **`project_repository` and the repository-set establishment flow** — untouched. This
  decision READS that domain.

## What this decision leaves unowned

Answered here, and owned by nobody until it was filed — the outward half of the
close-out (`notes.html` #181: a decision's outputs are deliverables, and an un-owned one
is invisible):

- **§1.3's deferral, `targetRepoRoles`.** Widening the portable half to a set has no card
  in MOTIR-2725 and cannot be done usefully before MOTIR-2732 gives something the power
  to author one. Filed as **MOTIR-2978**, under MOTIR-2732.

Every other answer above lands on an existing card: §1 and the migration on MOTIR-2727,
§3 on MOTIR-2728, §4 on MOTIR-2729, §1.2's primary-visibility obligation on MOTIR-2413,
and the back-compat assertion on MOTIR-2417.

## Binding on MOTIR-2725's cards

The INWARD half of the close-out — whose acceptance criteria did this decision just
falsify? (`notes.html` #304). Walked over the "Consumed by" list above, card by card;
the amendments were applied when this ADR merged, not deferred:

- **MOTIR-2727** — its change list said the migration backfills _"(and `targetRepoRole`
  likewise)"_. §1.3 declines to widen the role at all, so there is no role set to
  backfill. **Amended.** Its §3.4 obligation (the both-fields 422 and its typed error)
  was not in its body either. **Added.**
- **MOTIR-2728** — no criterion named `V1_CONTRACT_VERSION`, which Amendment 8 makes
  mandatory for the additive change §3 prescribes. **Added.** Its context ref asking
  whether the ready row is the dispatch shape or the item shape is answered by §3.3, so
  the card no longer owes that investigation. **Recorded.**
- **MOTIR-2729** — asked whether the set rule replaces `deferred_open_pr` or stands
  beside it, and for the new outcome tag; §4.1 answers both. Its criterion _"a parent
  whose children span two repositories is not rolled up to Done by the first
  repository's merge"_ reads as work in the cascade service, which §4.4 shows is
  already satisfied by the hold. **Recorded, criterion kept** — it is a true statement to
  assert, and asserting it is cheaper than reasoning about it twice.
- **MOTIR-2413 / MOTIR-2414 / MOTIR-2415 / MOTIR-2416** — the element states they must
  draw are unchanged by §1.3 (a role-without-a-repository is still a state a card can be
  in, it is simply still singular). No criterion falsified.
- **MOTIR-2417 / MOTIR-2730** — no criterion falsified; §4's sentence is what
  MOTIR-2730's step 4 drives and MOTIR-2417's item 2 asserts.

## Consequences

- The completion gate acquires an EXPECTED side, which is the whole point: a card can
  now be held for a pull request that does not exist, and that is the state MOTIR-2664
  closed through.
- Two ways to read a card's repository (`targetRepo` and `targetRepos`) exist
  permanently on three surfaces. §3.1 prices it; §1's rule that the scalar IS
  `targetRepos[0]` is what stops it becoming two facts.
- `work_item` grows one array column and no policies — the scalar array inherits the
  table's RLS unchanged, which is most of why this shape is cheap.
- A multi-repository card is now expressible, so `motir run <parent>`'s multi-repo fan-out
  stops being a shape the runbook survives and becomes one the product records
  (MOTIR-2700 writes the matching planning rule).
