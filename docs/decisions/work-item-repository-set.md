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

> **⚠️ Amended 2026-08-18 (MOTIR-3037, Story MOTIR-2732) — a work item's repositories are
> REFERENCES to the project's repository rows, and every NAME on every surface is DERIVED
> from one.** §1's storage decision is REVERSED (an ordered array of names becomes a join
> table of references, `work_item_repository`); §1.3's singular `targetRepoRole` is
> SUPERSEDED (the column retires entirely, and MOTIR-1913's resolution pass with it); §1.2,
> §2, §3 and §4 are KEPT, with §4's "every repository name in the set" re-read as "every
> repository REFERENCE in the set" and given a fifth delivery state for a row that is not
> established yet. Nothing published is removed. **Read "Amendment 2026-08-18" below before
> building to §1.1 or §1.3** — both are answered there on their own terms rather than around
> them.

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

> **⚠️ REVERSED 2026-08-18 (MOTIR-3037) — the element is now a REFERENCE and the storage a join
> table.** The measurement below is accurate and was taken against the wrong table: the foreign key
> it declines is the one `target-repo-attribution.md` §1 declines to `github_repo`, and the one
> taken is to `project_repository`, whose row survives a disconnect by design. The shape chosen is
> also neither of the (B)/(C) rejected here. **Read "Amendment 2026-08-18 · §A1" below**, which
> answers each of the three objections rather than setting them aside.

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

> **⚠️ SUPERSEDED 2026-08-18 (MOTIR-3037) — `work_item.targetRepoRole` retires entirely**, and
> MOTIR-1913's resolution pass with it. The argument below is sound and its premise moved: a set
> mixing "a NAME, no role" with "a ROLE, no name" has no representation in two parallel scalar
> arrays — and it has an obvious one in a table of references, where the element is the ROW and
> both states are the same state. The deferral this section filed, **MOTIR-2978**, survives as the
> container ROLLUP rather than as a widened role. **Read "Amendment 2026-08-18 · §A3".**

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

> **⚠️ Amended 2026-08-18 (MOTIR-3037) — "every repository NAME in the item's `targetRepos` set"
> reads as "every repository REFERENCE in the item's set", and a reference to a row that is not
> established yet gets its own delivery meaning.** The rule, the three-gate order, the visible hold
> and the transaction are otherwise unchanged. **Read "Amendment 2026-08-18 · §A5"** for the five
> delivery states and which of them hold the item.

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

## Amendment 2026-08-18 (MOTIR-3037, Story MOTIR-2732) — the set is a set of REFERENCES, and every name is DERIVED

**Card:** MOTIR-3037 · **Story:** MOTIR-2732 · **Read on `origin/main` @ `d3346bad`.**

This ADR decided WHAT a repository set is one week before a screenshot asked what a
repository IS. A card names its repository as a **word**, on a page where that repository
is a first-class object with an `id`, a `role`, a `label`, an establish `state` and a page
of its own — so there is nothing to click, because there is nothing being referred to, only
a string that happens to match. This amendment changes the element from a name to a
**reference to the project's `project_repository` row**, and makes every name the product
displays a **read projection** of one.

### A0. What is reversed, and what is untouched

| §         | Verdict                                                                                                                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1        | **REVERSED.** The ordered `String[]` of names becomes the join table `work_item_repository` (§A2).                                                                                      |
| §1.1      | **ANSWERED** (§A1) — the rejection was correct against the table it was measured on, and this is not that table, nor is the chosen shape either of the (B)/(C) it rejected.             |
| §1.2      | **KEPT verbatim.** Order is meaningful, element 0 is the primary, and the author who did not think about order still produces a first element.                                          |
| §1.3      | **SUPERSEDED.** `work_item.targetRepoRole` retires entirely, and MOTIR-1913's resolution pass with it (§A3). The deferral it filed, MOTIR-2978, survives as the container ROLLUP (§A6). |
| §2        | **KEPT.** Dispatch reads the primary; the primary is now the first REFERENCE, resolved to a name (§A4).                                                                                 |
| §3        | **KEPT and extended.** Still additive, nothing published is removed, and the reference is ADDED beside the names (§A4).                                                                 |
| §4        | **KEPT.** "Every repository name in the item's set" is re-read as "every repository REFERENCE", and a row that is not established yet gets a delivery meaning it did not have (§A5).    |
| §4.1–§4.4 | **KEPT.** The third gate, its position, its visible hold and its transaction are unchanged.                                                                                             |

### A1. Answering §1.1 on its own terms

§1.1 is not overturned by preference. Three things, in order:

**1. The foreign key §1.1 declined is not the foreign key this takes.** Its reason is
quoted from `target-repo-attribution.md` §1, which rejected an FK **to `github_repo`** —
the workspace's _connected_ set — because "disconnecting a repo would either cascade the
attribution away or block the disconnect", and "a pin should survive a repo being briefly
disconnected". That is a true statement about `github_repo` and it is not a statement about
`project_repository`. A disconnect does not delete a `ProjectRepo` row: the relation is
`githubRepo GithubRepo? @relation(fields: [githubRepoId], references: [id], onDelete: SetNull)`
(`prisma/schema.prisma` :5053ff), so a disconnect nulls the mirror and **leaves the row, its
role, its label and its authored name standing**. The property §1.1 was protecting is
therefore _preserved by_ the reference rather than broken by it — a card pinned to a
disconnected repository still points at the same planning row, and says so.

**2. §1.1 measured what the column HAS; the defect is what it FAILS AT.** The costing asked
_"name what integrity the chosen shape provides that the alternatives do not, measured
against what the column has on `origin/main` today"_, measured no FK, no index, no join, and
concluded correctly that a join table bought nothing. What no rung asked was what the column
cannot do — and `ProjectRepo.name`'s own comment had already written the answer down:

> The INTENDED repo name, editable per row until the row is established … the authoritative
> checkout name is the realized repo's own `name`, which is what the read layer prefers
> (**a rename on the host must not silently re-point a dispatch**).

A `work_item.targetRepo` holding a NAME is re-pointed by exactly that rename, silently, and
nothing in the product notices. §1.1's inventory is an accurate description of a column
nothing depended on referentially, taken one week before something did.

**3. The chosen shape is neither of the two §1.1 rejected.** §1.1's **(B)** was _"a join
table **with the scalar dropped**"_, fatal because `/api/v1` publishes the scalar and §8
forbids removing a published field. §1.1's **(C)** was _"a join table plus the scalar kept
as a **denormalized primary**"_, fatal because it means "two writable representations of one
fact … only safe under a single-writer rule, and a single-writer rule that nothing enforces
is a convention, not a decision." This amendment takes a third shape:

> **The join table is the only WRITABLE representation. Every name the product publishes —
> `targetRepo`, `targetRepos`, the dispatch payload's `targetRepo` — is a READ PROJECTION of
> it, computed on read and stored nowhere.**

Against (B): nothing published is dropped, so §8 is satisfied by construction (§A4).
Against (C): there is no second _writable_ representation, and the single-writer rule §1.1
correctly refused to accept as a convention is replaced by a structural exclusion — after §A7's
contract step the surviving name column is written ONLY for a project that has no repository set
at all, i.e. exactly where no row exists to reference, so the two representations can never both
describe one item (§A7, asserted by MOTIR-3039 and MOTIR-3040 AC 5).

**The cost, re-priced honestly.** One workspace-scoped table and its RLS policies — the
convention `project_repository_collaborator` already follows, one table over; one join on the
work-item detail read, which since MOTIR-2725 already loads the item's repository set to
render per-repository delivery, so the read gains a join and not a query; and `position` as a
plain `Int` rather than the free ordering a Postgres array gave. What §1.1's rung 2 said about
scalar arrays being this schema's idiom stays true — it is simply not the deciding property
when the element has an owner one table away.

### A2. The element shape

```prisma
model WorkItemRepo {
  id            String   @id @default(cuid())
  workspaceId   String   @map("workspace_id")
  workItemId    String   @map("work_item_id")
  projectRepoId String   @map("project_repo_id")
  position      Int
  createdAt     DateTime @default(now()) @map("created_at")

  workspace   Workspace   @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  workItem    WorkItem    @relation(fields: [workItemId], references: [id], onDelete: Cascade)
  projectRepo ProjectRepo @relation(fields: [projectRepoId], references: [id], onDelete: Cascade)

  @@unique([workItemId, projectRepoId])
  @@unique([workItemId, position])
  @@index([workspaceId])
  @@index([projectRepoId])
  @@map("work_item_repository")
}
```

- **Ordered by `position`, ascending; position 0 is the PRIMARY.** §1.2's rule about what
  order means is unchanged.
- **`position Int`, not the fractional-index `String @db.Text`** this schema uses on
  `work_item.position` / `project_repository.position`. A fractional index buys a cheap
  insert-between on a list a user re-orders one element at a time; a repository set is
  REPLACED wholesale by one service write and has no incremental re-order, so the ordinal is
  both sufficient and assertable (`@@unique([workItemId, position])` makes a gap or a
  collision a database error rather than a rendering question).
- **Duplicates COLLAPSE at the write layer**, first occurrence winning, exactly as §1.2's
  name-level rule already does. `@@unique([workItemId, projectRepoId])` is the backstop, not
  the rule — a caller that sends the same row twice gets a two-element set silently reduced
  to one, not a 422, because that is what the name path does today and the change must not
  make an existing call fail.
- **A reference to a row in another PROJECT is rejected with a typed error** at the write
  layer (`ForeignProjectRepoError` → 422 / a self-correctable MCP tool error). The foreign
  key cannot see this: `project_repository.projectId` and `work_item.projectId` are two
  columns and nothing relates them, so the check is the same write-layer check
  `target-repo-attribution.md`'s 2026-07-30 amendment already applies to a NAME ("a pin
  naming a sibling project's repo is now the typed error it always should have been"), moved
  from a string comparison onto an id.
- **`onDelete: Cascade` on both parents.** On `workItem`, for the obvious reason. On
  `projectRepo`, because a row removed from the project's set is a repository the project no
  longer has, and a card cannot go on referring to it; `Restrict` would make the set
  **uneditable** the moment any card pinned a row, which `project-repository-set.md` §4.4
  ("the set is a durable property of the project, editable and completable afterwards")
  forbids. The pin's survival across a _disconnect_ — the property §1.1 was defending — is a
  different edge and is preserved by `ProjectRepo.githubRepoId`'s existing `SetNull` (§A1).
- **RLS:** workspace-scoped, `workspace_id` carried on the row, policies written per the
  new-table convention and asserted by a cross-tenant test that fails without them
  (MOTIR-3039 AC 4). This is the policy work §1.1 correctly priced as the array shape's
  saving; it is now spent, deliberately.

### A3. Question 2 — what a plan pins before any row exists: **(b)**, and the reading that decided it

MOTIR-3037 asked which of **(a)** keep the role as the pre-row stand-in, **(b)** propose the
repository rows BEFORE materialize, or **(c)** both inside one transaction, and named the one
reading that would settle it. Here is the reading, and what it showed.

**The derivation input does NOT depend on the materialized items — (b)'s precondition holds.**
In `lib/services/plansService.ts`'s `approvePlan`:

```
:1504   const repoPins  = await resolveProposedTargetRepos(preItems, plan.projectId, ctx);
:1515   const repoRoles = resolveProposedRepoRoles(preItems);          // ← the derivation signal
:1518   await withWorkspaceContext( … )                                 // ← the materialize transaction
…
:1670   projectRepoProposalService.proposeRepositorySet(plan.projectId, ctx, { itemRoles: repoRoles })
```

`repoRoles` is computed from `preItems` — the **pre-transaction proposal snapshot** — three
lines above the transaction that creates the work items, and it is the whole of what
`proposeRepositorySet` is given (`options.itemRoles`; the rest of its input is the project's
slug and the pre-plan signals). Nothing in the derivation reads a created work item. So the
ordering `project-repository-set.md` §5.3 recorded is not forced by the input, and the rows
CAN exist before the tree does.

**(c) is refuted by the same reading, one level down.** Two things inside
`proposeRepositorySet` forbid the materialize transaction, and neither is about the input:

- `lib/services/projectRepoProposalService.ts:128` — `readPreplanSignals` is a `server-only`
  cross-boundary read (`GET /v1/preplan` into motir-ai). A network call inside an open
  database transaction is the side-effects-outside-tx rule's exact prohibition, and it is
  the reason `plansService`'s own comment gives for the current placement.
- `:148` — the `addRow` loop writes **each row in its own transaction**, which
  `project-repository-set.md` §4.2 fixes deliberately: "rows are INDEPENDENT … there is no
  compensating delete, no transaction spanning repo creation, and no all-or-nothing gate."
  Nesting that inside materialize would invert a decision, not implement one.

**(b) is taken.** `proposeRepositorySet` moves from _after the commit_ to **before
`withWorkspaceContext`**, still best-effort (the same `catch` + warn), still passed
`itemRoles: repoRoles`, which is already in scope at that point. Materialize then resolves
each proposal's pin — a row reference where the plan carried one, a ROLE where it did not —
against rows that now exist, and writes `work_item_repository` rows.

**Why a `proposed` row is a legal target — the hinge of the whole decision.**
`project-repository-set.md` §5.2 argued the role into existence like this: at generation the
repositories do not exist, so "a name pinned at generation is stale the moment the user edits
a row, and meaningless before the row is created at all. A **role** is stable across both."
Every word of that is true of a NAME. **A row REFERENCE is stable across both as well** — the
row exists before the repository does, its `id` does not move when its `name` is edited, and
it survives the repository being renamed on the host, which is the defect this story exists
for. And it is strictly _more_ precise than a role: §5.3's third outcome — more than one row
carries the role, so the pin resolves to `null` and always will (§1.2's legitimate repeated
role) — **cannot arise** when the pin names the row. The role's entire reason to exist is
discharged by the reference, and its one residual weakness disappears with it.

**What retires, what stays:**

| Thing                                                                                             | Verdict                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `work_item.targetRepoRole` (`schema.prisma:1729`)                                                 | **RETIRES** — dropped in MOTIR-3039's migration.                                                                                                                                                                                                                                            |
| `PlanItemProposedFields.targetRepoRole` / `PlanItemPatch.targetRepoRole`                          | **STAYS.** Generation still runs before any row exists, so a fresh project's plan still pins a ROLE. An established project's plan may instead pin the ROW (§5.4's settled case, now expressible unambiguously). MOTIR-3045 adds the row pin and keeps the two mutually exclusive per node. |
| `projectRepoPinService.resolvePins` (MOTIR-1913) and its call site `projectRepoSetService.ts:794` | **RETIRE.** Under a reference, establishing a row makes every card pointing at it resolve to a name **on the next read** — the name is derived (§A4), so there is nothing left for a pass to write.                                                                                         |
| `lib/projectRepos/roleResolution.ts`                                                              | **STAYS**, as the role→row rule the backfill (§A7) and materialize both apply. What retires is the standing pass that _wrote a name_, not the rule that _picks a row_.                                                                                                                      |

**What (b) costs, stated here rather than discovered later.**

1. **A rolled-back approve leaves `proposed` rows behind.** The in-transaction gate re-reads
   the plan's status under the plan lock and can reject after the propose has already run.
   Bounded, and acceptable: the rows are `proposed`, editable, and guarded by the proposer's
   own "a project whose set has any row is left completely alone", and the approve that wins
   the race writes the same set from the same plan. §4.4 already says the set is editable
   afterwards; this makes a losing approve leave the same artifact a winning one would.
2. **A FAILED propose leaves that plan's items with no reference, and there is no longer a
   pass to fill them in.** The item is honestly unrouted — the same signal §5.3's second
   outcome already emits and the code-index loop already renders — but where the old shape
   self-healed when a row was later established, this one does not. **The record is not
   destroyed:** materialize sets `plan_item.workItemId` (`plansService.ts:763`) and the
   proposal's `proposedFields.targetRepoRole` is retained, so the role→item mapping survives
   on the plan and a repair is reconstructable from it at any time. Retiring the pass is what
   buys the column's removal, and carrying both — a column, a background pass, and a
   validator standing in for a foreign key — is the state this story exists to end.

### A4. Question 3 — what the public shapes carry, and WHICH name is the resolved one

**Additive on all three**, exactly as §3 prescribes; `public-api-conventions.md` §8 is
unchanged and no amendment to it is owed.

| Surface                                                    | Change                                                                                                                    | Kind         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `targetRepo: string \| null` (v1 read, MCP item, DTO)      | **KEPT** — now the DERIVED name of the primary reference                                                                  | none         |
| `targetRepos: string[]` (v1 read, MCP item, DTO)           | **KEPT** — now the DERIVED ordered names                                                                                  | none         |
| `targetRepositories` (v1 read, MCP item, DTO)              | **ADD** — `{ id, name, role, label, state, primary }[]`, in set order: the references themselves                          | **additive** |
| v1 / MCP WRITE shapes                                      | **ACCEPT** optional `targetRepositories: string[]` (row ids) beside the existing name fields                              | **additive** |
| MCP DISPATCH shape (`lib/mcp/payloads/workItems.ts`)       | **UNCHANGED** — single-valued; its `targetRepo` is the primary's resolved name, with the same clone-url/branch companions | none         |
| `lib/api/v1/ready/schema.ts` · `lib/dto/ready.ts`          | **UNCHANGED** — §3.3's answer is unaffected                                                                               | none         |
| `V1_CONTRACT_VERSION` (`lib/api/v1/contractVersion.ts:82`) | **`1.10.0` → `1.11.0`** — obligatory for an additive change under Amendment 8                                             | —            |

**The resolved name is the REALIZED repository's own `name`, falling back to the row's
authored `name` when the row is not realized yet.** This is stated to agree, in writing, with
`ProjectRepo.name`'s comment ("the authoritative checkout name is the realized repo's own
`name`, which is what the read layer prefers"), and it is not new machinery: it is exactly
what `lib/projectRepos/names.ts:115`'s `toProjectRepoPinNames` already computes —
`normalizeTargetRepo(realized?.name ?? row.name)` — and that function **already returns
`rowId`**, so the write path's name→row resolution is a projection of a function that ships
today.

**The write side is a THREE-way mutual exclusion**, extending §3.4's rule rather than
replacing it: a write may carry `targetRepo`, or `targetRepos`, or `targetRepositories`, and
**never two of them**; a write carrying more than one is rejected with the typed 422 §3.4
already names, and over MCP as a self-correctable tool error. A silent precedence rule is
rejected here for the same reason §3.4 rejected it. A name that arrives on a write is
RESOLVED to a row through the project's pin domain (`toProjectRepoPinNames` — every row, in
any state, per its own doc comment on why authoring uses the wider domain); a name that
resolves to no row is the existing `UnknownTargetRepoError`, unchanged.

**A container's set is not writable at all** on any of these surfaces — §A6.

### A5. Question 4 — what the classifier compares, and what a `proposed` row DELIVERS

`classifyRepoDelivery(expected, linked)` (`lib/workItems/repoDelivery.ts`) keeps its shape
and its purpose — ONE derivation shared by the completion gate and the rendered panel, so the
two can never disagree — and its `expected` side becomes the item's ordered **references**
rather than strings. Per reference:

| Row state (`project_repository.state`)                                | Delivery state      | Holds the item? | What the reader's next action is                       |
| --------------------------------------------------------------------- | ------------------- | --------------- | ------------------------------------------------------ |
| `created` / `connected`, realized, merged onto its own default branch | `delivered`         | no              | nothing                                                |
| `created` / `connected`, realized, no such merge                      | `awaiting`          | **yes**         | open (or merge) the pull request                       |
| `created` / `connected`, realized, merged with a null `base_ref`      | `unknown`           | **yes**         | say which branch that merge landed on                  |
| `proposed` / `creating`                                               | **`unestablished`** | **yes**         | **create the repository, on the establish step**       |
| `failed`                                                              | **`unestablished`** | **yes**         | retry, connect an existing repository, or skip the row |
| `skipped`                                                             | **`excluded`**      | **no**          | nothing — the project is deliberately code-less there  |

Five states, and that is the whole enumeration.

- **The established rows behave exactly as they do today**, comparing `linked` facts against
  the **realized** repository's name (case-insensitively, per the function's existing note
  that the two sides come from different tables and a git host is case-insensitive).
- **`unestablished` is deliberately not `awaiting`.** They hold the item identically and they
  are not the same statement: `awaiting` says a pull request has not been opened and points a
  reader at GitHub; `unestablished` says the repository does not exist yet and points a
  reader at the establish step. Collapsing them is what produces the false "No pull request
  yet" row MOTIR-3036 reports, so that bug's cause is named here and its fix belongs to the
  surface card.
- **`failed` reads as `unestablished`, not as its own state**, because §4.1 makes `failed`
  **resumable, not terminal** — the reader's next action is the same establish-step action.
  The row's `failureReason` is what distinguishes them on the surface, and it already exists.
- **`skipped` must NOT hold**, or `project-repository-set.md` §4.3 — "a skipped or failed row
  leaves the project **explicitly code-less for that role**", a state the product models and
  renders — becomes unreachable, and a card would wait forever for work the user declined.
  `excluded` abstains: it appears in neither shortfall list.
- **An ARCHIVED repository is not a sixth state.** A merge that landed before the archive
  still landed, so archival changes nothing about _delivery_. It changes _dispatch_, where
  `lib/projectRepos/roleResolution.ts` already refuses by name (MOTIR-1959) — a different
  question, asked at a different moment.

`RepoSetShortfall` gains a third list, `unestablished`, beside `outstanding` and
`unknownBase`; `hasRepoSetShortfall` is true when **any** of the three is non-empty, and the
comment posted by §4.2's visible hold names all three, split the same way — a gate that held
on one list while the note printed another would be the two-rules failure `repoDelivery.ts`
exists to prevent.

### A6. A container's set is the UNION of its leaves' — MATERIALIZED, and NOT writable

§1.3's deferral, MOTIR-2978, resolves to this rather than to a widened role. Recorded here
because MOTIR-2978 and MOTIR-3033 both build to it and neither may decide it alone.

- **A container's references are the de-duplicated UNION of its non-archived descendants'
  leaf references.** `ONE SUBTASK = ONE REPO = ONE PR` is untouched and is not weakened
  anywhere by this amendment: a leaf's set has at most one element and is authored; a
  container's is derived and may have many.
- **Ordered by the project's own repository-set order** (`project_repository.position`), not
  by first appearance in a tree walk. The project's order is stable, project-wide, and
  independent of child order — so a re-parent that changes nothing about which repositories a
  story spans does not churn the order it renders in.
- **MATERIALIZED, not computed on read.** The completion gate reads the expected set on the
  delivery path, inside the resolve transaction under the item's row lock (§4.3); an ancestor
  walk there would be a subtree query per delivery AND a second implementation of the union.
  Recomputed on every mutation that can change it — a leaf's set changing, a re-parent, an
  archive, an unarchive, a delete — and **once per container per materialize**, after the adds
  pass, inside the same transaction (MOTIR-3033).
- **An ARCHIVED descendant contributes nothing.** A parent is not waiting on work that has
  been archived out of it, and §4's "has every repository merged?" would otherwise be
  unanswerable for a story whose archived child pinned a repository nothing will ever ship to.
- **A direct write to a container's set is REJECTED with a typed error** —
  `ContainerRepoSetNotWritableError` → 422 / a self-correctable MCP tool error — on all three
  write surfaces. **Not silently ignored**, for the reason §3.4 gives for rejecting a silent
  precedence rule: the losing value would be a decision the caller believed they had
  recorded, and the next rollup would erase it with no signal. This is MOTIR-2978's
  "chosen disposition".

### A7. The migration, and the back-compat contract — an EXPAND → CONTRACT sequence across four cards

A column replacement cannot land in one commit here: every child of MOTIR-2732 is a
separate commit gated by its own lint/typecheck/build, so a commit that DROPS a column
its siblings still read does not compile. The sequence below is therefore part of the
decision, not an implementation detail, and each step names the card that owns it.

**Step 1 — EXPAND (MOTIR-3039).** Add `work_item_repository` with its RLS policies and its
truncate-helper registration, and BACKFILL it. From this commit on, the references are the
AUTHORED state: `workItemsService.create` / `update` write them, and the legacy
`targetRepo` / `targetRepos` columns are maintained by **that same single service write** as
a derived projection of the references — output, never input, and never independently
writable. §3.4's "the singular or the set, never both" carries over and grows a third arm
(§A4).

The backfill, per work item, in this order:

1. **Names first.** Each element of `targetRepos` — or the scalar `targetRepo` when the
   array is empty — resolves through the project's PIN domain
   (`lib/projectRepos/names.ts`'s `toProjectRepoPinNames`: every row, in any state, which is
   the domain an authored pin was validated against, and which already returns the `rowId`)
   to a row, producing one reference per element **in the stored order**.
2. **Then the role.** An item with no name pin but a `targetRepoRole` resolves through
   `lib/projectRepos/roleResolution.ts`'s rule, counting rows carrying that role **in any
   state** exactly as §5.3 requires: exactly one → a reference to it; zero or more than one →
   none. Referencing an unestablished row is legal now (§A3), so this recovers items the old
   model could only leave `null` until a pass ran.
3. **Everything else is counted, not dropped.** The count of unresolvable pins, split by
   reason (no row of that name in the project; an ambiguous role; neither a role nor a name),
   is reported in MOTIR-3039's PR body. Never guessed across projects, never matched on a
   substring.

**Step 2 — MOVE THE READS (MOTIR-3041).** Every read seam resolves through the reference:
`targetRepo` and `targetRepos` become the DERIVED names on the wire, `targetRepositories` is
added, and `V1_CONTRACT_VERSION` moves (§A4). After this commit nothing READS the legacy
columns.

**Step 3 — MOVE THE LAST WRITER (MOTIR-3033).** `plansService.materialize` is the one write
path that bypasses `workItemsService` entirely, which is why it has its own card. It writes
references, and stops writing `targetRepoRole`. After this commit nothing WRITES the legacy
columns except step 1's derived projection.

**Step 4 — CONTRACT (MOTIR-3040).** With no reader and no writer left,
`projectRepoPinService.resolvePins`, its call site at `projectRepoSetService.ts:794`, the two
`workItemRepository` role queries that serve it, and the columns `targetRepos` and
`targetRepoRole` are all removed, along with step 1's derived write of `targetRepo`. This is
the commit MOTIR-3040 AC 5 — "no repository fact is writable from two places after this card"
— is true of, and it is why that card must run AFTER MOTIR-3033 and MOTIR-3041 (§A8 wires the
two edges the sequence owes).

**What survives step 4: `work_item.targetRepo`, as the COMPATIBILITY-RUNG pin — and the two
representations are MUTUALLY EXCLUSIVE BY PROJECT.** This is the one place the reference model
does not reach, and it is a rung `target-repo-attribution.md`'s 2026-07-30 amendment already
installed rather than a residue this migration leaves:

> A project with **no** repository set validates and resolves its pins against the WORKSPACE's
> connected repos — "the compatibility rung, and it answers only for a MISSING set, never
> underneath one that exists."

Such a project has no `project_repository` row for a pin to point at, so the reference model has
nothing to say about it. The rule is therefore:

- **A project WITH a repository set** — its work items carry REFERENCES, and `work_item.targetRepo`
  is never written for them. After step 4 the column is not written by any path that runs for such
  a project.
- **A project WITHOUT one** — its work items carry NO references and keep writing
  `work_item.targetRepo` exactly as they do today, validated against the workspace's connected
  repos exactly as today. Nothing about those projects changes, which is what "dispatch is
  unchanged for every existing card" means for them.

The two are never both populated for one item, and which applies is decided by
`projectRepoSetService.getRepoNameDomains(...).hasSet` — a property of the project, read in one
place, and **assertable**: MOTIR-3039 asserts that a write in a set-bearing project leaves the
column null, and that a write in a setless one writes no reference. That is the difference from
§1.1's rejected (C), which had two representations of the same fact for the same row and only a
convention keeping them in step.

**A project that GAINS a set later keeps its old cards on the name.** The read ladder resolves
references first and falls back to the column, so those cards render and dispatch exactly as
before; they simply do not become links until someone re-pins them. Converting them is an
establishment-flow question — creating or connecting rows to point at — which Story MOTIR-2732
puts out of scope, and it is named here so it is a known gap rather than a discovered one.

**Why the backfill does not simply give every project a set.** It would make the tail empty and
the feature universal, and it would also **narrow every such project's future validation domain**
from the workspace's connected repositories to whatever the migration happened to write — a
behaviour change to authoring, made by a data migration, for projects nobody asked to establish.
That is the establishment flow wearing a migration's clothes.

**No card's resolved dispatch repository changes**, at any step. Asserted directly by
MOTIR-3039 over a fixture holding pinned, role-pinned, unpinned and unresolvable rows — not
inferred from the rules above — and re-asserted by MOTIR-3040 after the contract.

### A8. Binding on MOTIR-2732's cards

The inward half of the close-out (`notes.html` #304) — whose acceptance criteria does this
amendment settle, and whose does it falsify? Walked over MOTIR-3037's `blocks` closure, card
by card. **Nothing below is falsified; every entry is an answer a card no longer has to
re-derive.**

- **MOTIR-3039** (schema + backfill + write path) — AC 1's "ordered set of references,
  enforced by the database, with element 0 the primary" is §A2's model verbatim; AC 2's
  cross-project rejection is §A2's `ForeignProjectRepoError` (and §A2 says why the FK cannot
  supply it); AC 3's unresolvable tail is §A7; AC 5's duplicate disposition is §A2's
  _collapse, first wins_; AC 6's dispatch invariance is §A7's last paragraph.
- **MOTIR-3040** (the resolution pass) — AC 1 asks which branch. **The RETIRE branch**, per
  §A3's table: the pass, its call site at `projectRepoSetService.ts:794`, the two
  `workItemRepository` role queries that serve it, and the columns all go. AC 5's "no
  repository fact is writable from two places" is §A7's step 4 plus §A1's point 3.
  **⚠️ This card is §A7's CONTRACT step, so it owes two dependency edges the plan did not
  have** — it cannot drop `targetRepoRole` while `plansService.materialize` still writes it,
  nor `targetRepos` while a read seam still reads it. **`MOTIR-3040 blocked_by MOTIR-3033`
  and `MOTIR-3040 blocked_by MOTIR-3041`**, wired by this card rather than left as a build
  order somebody has to rediscover (`plan-rules/core.md` gate 4: an absent edge and a
  considered exclusion are the same absent edge).
- **MOTIR-3041** (read seams) — §A4 gives the exact shape of every seam, the resolved-name
  source, the `V1_CONTRACT_VERSION` bump, and the write-side three-way exclusion AC 5 asks
  about. AC 3's rename assertion is the property §A1 point 2 exists for.
- **MOTIR-2978** (the container rollup) — §A6 is its specification, including AC 4's "chosen
  disposition" for a direct write (rejected, typed) and AC 2's archive case.
- **MOTIR-3033** (`materialize` writes the set) — §A6's "once per container per materialize,
  after the adds pass, inside the same transaction" is its AC 5; §A3 removes its own open
  question about whether the role still rides along (it does not).
- **MOTIR-3042** (the surfaces) — AC 2's "a `proposed` row reads as proposed rather than as
  awaiting a pull request" is §A5's `unestablished`, and AC 3's shared derivation is
  `repoDelivery.ts` keeping its single-derivation contract.
- **MOTIR-3038** (the design) — AC 4's "all five Development-section states" are §A5's five,
  by those names.
- **MOTIR-3044** (the planning envelope) — AC 1's "reference, name, role, label, establish
  state" is §A4's `targetRepositories` element shape, with §A4's resolved-name rule deciding
  what `name` holds.
- **MOTIR-3045** (the planner sees the repositories) — AC 6/7's row-pin-or-role-pin is §A3's
  table: the role stays on the PLAN, the row pin is added, the two are exclusive per node.
  AC 8's "two repositories of the same role can be pinned unambiguously" is the §5.3 third
  outcome that §A3 shows the reference dissolves.
- **MOTIR-3031 / MOTIR-3043** (the gates) — no criterion falsified; §A5's five states and
  §A6's rollup are what they assert over.

**Out of this story, and named so it is not lost:** the false "No pull request yet" row
(**MOTIR-3036**) has its cause in §A5 and its fix on the surface card; the null-`base_ref`
trap (**MOTIR-3034**) is untouched by this amendment — `unknown` keeps exactly the meaning
§4 gave it.

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
