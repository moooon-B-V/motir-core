# `work_item.session_branch` is the INTEGRATION LINEAGE, and it is not retired

**Status:** accepted · **Date:** 2026-08-28 · **Card:** MOTIR-3734 (epic MOTIR-2200)

> **What this decides.** `work-item-delivery-links.md` Q2 listed
> `work_item.session_branch` among "the two scalars" a follow-up card drops once
> the delivery table is armed. This file settles the questions that follow-up
> (MOTIR-3735) cannot answer for itself — and the answer is that the column is
> **not dropped**. It decides nothing about `github_pull_request.work_item_id`:
> `delivery-reader-migration.md` is the mirror of this file for that column, and
> the two columns turn out to have opposite answers for a reason worth stating.

> **On the file name.** `docs/decisions/` is slug-named, not numbered. This slug
> was checked free against `origin/main` and against every remote branch
> (`git cat-file -e origin/<branch>:docs/decisions/session-branch-lineage.md`
> over `git ls-remote --heads origin`), because two parallel runs picking the
> same slug collide exactly as two picking the same number would.

---

## 0 · The inventory, RE-MEASURED — the card's own command contradicted its own table

**Every number below was taken on `origin/main` `17a3aba23`, and the COMMAND is
printed beside it.** MOTIR-3734's body opens with a six-row reader table
attributed to:

```bash
git grep sessionBranch lib app          # 188 lines across 31 files
```

That command is correct. Its answer is 31 files; the table names six sites. The
gap is not a rounding — **two of the three blocker-side reads are missing, and
they are the two that decide READINESS rather than lineage.** This is the third
consecutive occurrence of one shape in this story (MOTIR-3733, MOTIR-3753): a
claim quantifying over the codebase supported by a command scoped to less than
the codebase. Here the command was wide enough and the table was narrower than
the command, which is the same defect entered from the other side.

**The predicate this file measures:** _every site that reads or writes
`work_item.session_branch`, in `lib` / `app` / `packages/cli/src`, on
`origin/main` `17a3aba23`._ A column is reachable two ways, so two commands:

```bash
# A — inside a repository: a Prisma where / select on the column
git grep -n "sessionBranch: true\|where: { sessionBranch" -- lib/repositories
# B — outside it: the column read off a row a repository returned
git grep -n "\.sessionBranch" -- lib app packages/cli/src
```

### A — the SIX repository methods that touch the column

| #   | method                                                      | file:line                                        | what it asks                                      |
| --- | ----------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| R1  | `workItemRepository.findBySessionBranch`                    | `lib/repositories/workItemRepository.ts:1044`    | which cards are recorded on this branch?          |
| R2  | `workItemRepository.findProvenanceBackfillCandidates`       | `:679`                                           | (projection) did this card ship through an agent? |
| R3  | `workItemLinkRepository.findBlockerStates`                  | `lib/repositories/workItemLinkRepository.ts:229` | **is this blocker still OPEN?**                   |
| R4  | `workItemLinkRepository.findBlockerStatesForItems`          | `:266`                                           | **the same, batched for a page**                  |
| R5  | `workItemLinkRepository.findBlockerSessionBranchesForItems` | `:417`                                           | which lineage does this card inherit?             |
| W1  | `workItemRepository.update` via `applyStatusTransition`     | `lib/services/workItemsService.ts:2401,2430`     | the write and the clear                           |

**R3 and R4 are absent from MOTIR-3734's table entirely**, and MOTIR-3734 names
R5 as _"the one the table cannot serve"_. R3/R4 are a stronger instance of the
same thing, and §1 is mostly about them.

### B — the service-level reads, which no grep of a repository file can see

`blockerReadiness.ts:34,65` (the classifier) · `ciPromotion.ts:113` ·
`dispatchPromptService.ts:236` · `workItemsService.ts:2254,2401,2430,2794,4236,5240,6039` ·
`provenanceBackfill.ts:207` · `changeRequestWorkItems.ts:105` ·
`changeRequestStatusSync.ts:343,553` · `workItemMappers.ts:105`.

**Plus 48 non-test modules carry the name at all** — the DTO / wire / CLI
carriers §2 enumerates:

```bash
git grep -l sessionBranch -- lib app packages/cli/src prisma/schema.prisma \
  components scripts | grep -vi 'test\|spec' | wc -l     # 48
```

---

## 1 · Q1 — what replaces `inheritedSessionBranch`?

**Decision: (A) — keep the column. Nothing replaces it, because nothing can.**

MOTIR-3734 frames A as _"the likely answer and NOT the safe default"_. Having
measured it, A is not merely likely — B and C are both unbuildable, for reasons
that are structural rather than a matter of effort.

### 1.1 The column has THREE jobs, and only one of them is a lineage

All three are computed by ONE pure function pair in
`lib/workItems/blockerReadiness.ts`, over rows R3/R4 supply:

```ts
export function isOpenBlocker(blocker, terminalByProject): boolean {
  const terminal = terminalByProject.get(blocker.projectId)?.has(blocker.status) ?? false;
  return !terminal && !blocker.sessionBranch; // ← job 1
}
```

1. **The READINESS PREDICATE.** A blocker is satisfied when it is terminal **OR**
   when it carries a session branch — Subtask 7.8.11's _integrated-awaiting-review_
   rule, _"keyed on the field, not the status"_ (`workItemsService.ts:4190`). The
   whole point of `motir auto` is that card two starts while card one sits at
   Implemented. **Without this field card two is `ready: false`, and every
   session run stops after its first card.**
2. **The LINEAGE.** The single branch the satisfied blockers share, which
   dispatch inherits. This is the only job MOTIR-3734's table names.
3. **The CONFLICT DETECTOR.** Deps spanning more than one branch ⇒ **not ready**,
   until a human merges one session pull request (`classifyBlockerReadiness`'s
   `conflicting`).

`classifyBlockerReadiness` has a third caller beyond the two readiness reads:
**`plansService.materialize`**, which uses it to decide the birth status of an
approved plan's `add`. So the column reaches plan approval, not only dispatch.

### 1.2 Why `work_item_delivery` cannot answer any of the three

**Reason one — a delivery row cannot exist before a pull request does, by FK.**

```prisma
model WorkItemDelivery {
  workItemId          String @map("work_item_id")
  githubPullRequestId String @map("github_pull_request_id")   // NOT NULL
  ...
}
```

`mark_integrated` writes `session_branch` and moves the card to **Implemented**
in one transaction (`workItemsService.markIntegrated`, `lib/mcp/tools/markIntegrated.ts`),
and it _"fires on agent success, which is often before a pull request exists"_ —
`work-item-delivery-links.md`'s own sentence, three paragraphs above the table
that schedules the column's removal.

**The window is not a moment; for one whole lane it is the entire run.**
MOTIR-3734 says the run _"opens the pull request at the first IMPLEMENTED card"_.
That is true of `motir auto` only:

```ts
// packages/cli/src/commands/auto.ts:628
if (openPrEagerly && landedWork(record)) { ... ensureRepoPullRequest(...) }
```

`openPrEagerly` defaults to `false` (`:403`) and is set `true` at exactly one
call site — `motir auto` (`:316`). The **scoped run** (`motir run <parent>`,
`commands/dispatch.ts`) shares the same loop and deliberately does not opt in,
because it can finish under a HOLD (MOTIR-3268) and _"an eager open here would
open exactly the pull request the hold exists to withhold."_ **So on that lane no
pull request exists on the session branch until close-out, and every card after
the first would inherit nothing at all.**

**Reason two — and this one survives the window: a delivery row carries no
branch, and the branch it can be joined to is the WRONG one.**

`work_item_delivery` has four columns and none of them is a ref. Deriving a
lineage means joining to `github_pull_request` and reading `headRef`. For an
ordinary per-item-PR card that head ref is **the card's own feature branch**
(`subtask/MOTIR-…`), not a session lineage — and `work_item.session_branch` is
`null` for exactly those cards. **The column's null-ness IS the discriminator
between _integrated on a shared lineage_ and _shipped its own pull request_, and
a delivery join cannot recover it: both cases look identical, a row pointing at a
pull request with a head ref.** So C does not merely lose the lineage inside a
window; outside the window it hands card two its blocker's feature branch and
tells it to build there. That is worse than the `main` fallback C was costed at.

### 1.3 What the rejected arms cost

- **(B) hang the lineage on the RUN.** A run entity would answer job 2 and could
  be made to answer job 3, and it answers job 1 not at all: readiness is a
  property of the _card_, read by `getReadiness`, `getReadinessForItems`,
  `list_ready`, `next_ready`, the board's ready column and `plansService.materialize`
  — none of which has a run in scope, and three of which run with no CLI
  anywhere near them. It also has to answer `autoLoop.ts`'s own header argument
  that there is _"no plan of the run"_; this file does not attempt that, because
  job 1 sinks B before the argument is reached.
- **(C) derive from the blocker's DELIVERY, null otherwise.** Falsified twice
  over by §1.2: null for a whole lane, and actively wrong outside the window.
  MOTIR-3734 costed C as _"the second card branches off `main`, which is the
  defect MOTIR-2400 was added to fix"_. The measured cost is larger — the second
  card is **not ready at all** (job 1), and where it is ready it is pointed at a
  sibling's feature branch.

### 1.4 What A actually changes: the MEANING, on the record

The column stops being described as a delivery key scheduled for retirement and
is stated as what it is:

> **`work_item.session_branch` is the INTEGRATION LINEAGE — the branch this card's
> work was integrated onto BEFORE any pull request exists. It is a
> pre-pull-request fact. `work_item_delivery` is a post-pull-request fact. They
> are disjoint in time by construction (the delivery row's FK requires a pull
> request), which is why one is not a replacement for the other, and why the two
> columns `work-item-delivery-links.md` Q2 groups together have opposite
> answers.**

**No rename.** The name is on eleven published v1 sites (§2); renaming a field is
§8-forbidden, and `session_branch` is not wrong — it is under-described, which a
comment fixes and a migration does not.

---

## 2 · Q2 — what this costs the v1 contract

**Decision: NOTHING. `V1_CONTRACT_VERSION` does not move — it stays at `1.22.0`
(`lib/api/v1/contractVersion.ts`, `origin/main` `17a3aba23`). No CLI release is
needed.** Under A no field is added, removed, renamed or retyped, no error `code`
moves, no condition changes status, no limit tightens and no optional parameter
becomes required — so no §8 clause fires in either list, and there is nothing for
a bump to report.

That is worth stating with the surface in view, because MOTIR-3734 names two
published fields and the real surface is **eleven sites across six operations,
two of which are REQUEST BODIES**:

| #   | site                                                            | operation                                | direction                                                                       |
| --- | --------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------- |
| P1  | `ReadyItem.inheritedSessionBranch`                              | `GET …/projects/{key}/ready`             | response (added at **1.6.0**, MOTIR-2400)                                       |
| P2  | `DispatchPrompt.sessionBranch`                                  | `GET …/work-items/{key}/dispatch-prompt` | response                                                                        |
| P3  | `DispatchPrompt.prompt`                                         | the same                                 | response — **the branch name is inside the text** (`promptTemplate.ts:976,980`) |
| P4  | `IntegrationResult.sessionBranch`                               | `POST …/work-items/{key}/integration`    | response                                                                        |
| P5  | `ImplementationReport.sessionBranch`                            | `POST …/work-items/{key}/implementation` | response                                                                        |
| P6  | `SessionCloseOut.sessionBranch`                                 | `POST /api/v1/sessions/complete`         | response                                                                        |
| P7  | `integrationBodySchema.sessionBranch`                           | `POST …/work-items/{key}/integration`    | **request body, required, `min(1).max(200)`**                                   |
| P8  | `sessionCloseOutBodySchema.sessionBranch`                       | `POST /api/v1/sessions/complete`         | **request body, required**                                                      |
| P9  | `implementationReportBodySchema.strict()`                       | `POST …/work-items/{key}/implementation` | **behaviour: sending `sessionBranch` is a 422, deliberately**                   |
| P10 | `sessionBranch` on the MCP work-item payload                    | `get_work_item`                          | response                                                                        |
| P11 | `sessionBranch` + `inheritedSessionBranch` on the MCP ready row | `list_ready` / `next_ready`              | response                                                                        |

(`mark_integrated`'s `sessionBranch` input and `complete_session`'s result carry
it on the MCP surface too; the UI renders it in `CoreFieldsPanel.tsx:337`.)

**What B or C would have cost, since MOTIR-3734 asks for the number.** §8's
forbidden list opens with _removing a field_, so P1–P6 and P10–P11 cannot be
taken off v1 at all — a removal is a **v2**, not a minor. P7 and P8 are worse:
they are the only field in their bodies, so removing them retires the operations.
The reachable shape under B or C is therefore **not a version bump at all** — it
is every field keeping its name, its `string | null` type and its position while
its VALUE starts meaning something else. §8 has no clause for that because it
governs shape, and a silently re-meant field is the one outcome the additive-only
promise exists to prevent. A client pinned to `1.22.0` would read
`inheritedSessionBranch` and get a correct-looking `null` where the lineage it
needs still exists.

**And it would be a release event for someone else's binary.** Eleven
`packages/cli/src` modules read the field — `client.ts`, `adapters/reads.ts`,
`autoLoop.ts`, `batchPlan.ts`, `dispatch.ts`, `dispatchLeg.ts`, `git.ts`,
`commands/{auto,batch,dispatch,scopeDrain}.ts`. Under A none of them moves and
none of them needs a release.

---

## 3 · Q3 — the `done ⇒ session_branch = null` invariant

**Decision: unchanged, and inherited by nothing, because nothing replaces the
column.**

One correction on the record. MOTIR-3734 says _"two services clear the column on
completion"_, naming `childStatusCascadeService` and `parentStatusRollupService`.
That is the wrong tier: neither clears it. Both route through
`workItemsService.applyStatusTransition`, and the clear is **one site**:

```ts
// lib/services/workItemsService.ts:2400
const update: Prisma.WorkItemUncheckedUpdateInput = { status: toStatusKey };
if (target.category === 'done') {
  update.sessionBranch = null;
  ...
} else if (branchDirective !== undefined) update.sessionBranch = branchDirective;
```

So the invariant holds for **every** path to a done-category status — the two
cascades, a board drag, an MCP `transition_status`, the sync — and it is not
narrowed for `cancelled` (an abandoned card must leave no stale lineage either).
There is a **second, explicit** clear in `completeSession` (`:2794`), which nulls
each item on the branch as it closes it; that one is a per-item write inside the
bulk close rather than a second copy of the rule.

The invariant is why job 1 in §1.1 is safe: a merged blocker's branch is gone, so
it satisfies its dependents as _terminal_ and contributes no lineage —
`classifyBlockerReadiness` `continue`s on a terminal blocker before it ever looks
at the field, _"so the rule stays correct even if that invariant were ever
violated."_

---

## 4 · Is `work_item.session_branch` dropped at all? (MOTIR-3734 AC 4)

**No. Not in this story, and not by MOTIR-3735.** The column stays, keeps its
`@@index([sessionBranch])`, keeps its writer and keeps all six repository sites in
§0.

Two premises behind that acceptance criterion have moved and are amended here
rather than left for a diff to discover:

- **MOTIR-3721 no longer assumes the drop.** Its title is now _"EXPAND-1 — arm
  `work_item_delivery`, and move every reader whose failure is SILENT"_ and it is
  `done`; its AC 7 says outright that `github_pull_request.work_item_id` is not
  dropped either, and its own body states _"nothing is dropped here, so the
  rollback is a code revert."_ The drop it was re-scoped away from is
  MOTIR-3757 (CONTRACT), and that card is about the **other** column.
- **`work-item-delivery-links.md` Q2 is amended.** Its table's last row — _"the
  columns themselves | both | a follow-up card, once this table is empty"_ — is
  correct for `github_pull_request.work_item_id` and **wrong for
  `work_item.session_branch`**, whose two listed readers were moved by MOTIR-3658
  / MOTIR-3659 while three others (R3, R4, R5) were never in that table at all.
  The sentence _"`mark_integrated`'s `sessionBranch` argument goes with the column
  it writes"_ is withdrawn: the column stays, so the argument stays, and §1.2
  quotes that section's own reasoning back at it.

### What MOTIR-3735 becomes

MOTIR-3735 is titled _"Retire `work_item.session_branch`"_ and its own body
names this outcome: _"If A is chosen, this card is re-planned rather than run …
Do not build a column drop the ADR did not choose, and do not silently re-scope
this card to fit."_ Under A, **its items 1–5 all evaporate**: there is no reader
to move (§1.2), no invariant to re-home (§3), no column to drop (§4) and nothing
on the wire to version (§2).

**And its criteria 3 and 4 do not survive either — because they are ALREADY
ASSERTED.** A first reading of this section proposed keeping them as regression
guards, on the assumption that a property this load-bearing could not already be
covered. It is, and has been since 7.8.11:

| the property                                                                                          | asserted at                                                 |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| an implemented dep WITH a branch unblocks its dependent; **WITHOUT one it does not**; done still does | `tests/mcp/integration-state.test.ts:44`                    |
| conflicting lineages keep the item out of the ready set, and the verdict names them                   | `:74`                                                       |
| `listReady` / `next_ready` honour the rule and the dispatch payload carries the inherited branch      | `:102`                                                      |
| `done` clears the branch on ANY transition                                                            | `:227`                                                      |
| a merged session-branch pull request closes every card the branch carried                             | `tests/github/changeRequestSessionCloseOut.test.ts:154-323` |
| the pure classifier, both arms                                                                        | `tests/workflows/blockerReadiness.test.ts`                  |

Those tests seed the blocker through `markIntegrated` with **no pull-request row
in existence**, which is precisely the window criterion 3 was reaching for. So
the honest re-scope is not a smaller build card: **it is a documentation sweep
with no test in it at all**, and re-asserting any of the above would be the
rebuild-a-sibling's-half defect wearing the costume of diligence.

What remains for MOTIR-3735 is the three places that still promise the
retirement — `work-item-delivery-links.md` §Q2, `prisma/schema.prisma`'s
uncommented `sessionBranch` field, and `blockerReadiness.ts`'s header — because
a reader who lands on any of them re-derives a decision that has been made and
reversed. That card was re-scoped to exactly that on 2026-08-28.

> **⚠️ AMENDMENT — the field is NOT uncommented (MOTIR-3807, 2026-08-28).** The
> sentence above, and MOTIR-3735's deliverable 2 that it fed, both said
> `prisma/schema.prisma`'s `sessionBranch` _"carries no comment saying what it
> is"_. **It carries a twelve-line one, at the very ref this document pins every
> one of its own numbers to:**
>
> ```
> $ git show 17a3aba23:prisma/schema.prisma | sed -n '1979,1991p'
>   // Integration branch (Story 7.8 · Subtask 7.8.11) — the session branch this
>   // item's work currently sits on after a run integrated it (status moved to
>   // `in_review` via `mark_integrated`). NON-NULL ⇔ the item is integrated-
>   // awaiting-review: its work is mergeable so it UNBLOCKS dependents (the
>   // integrated-dep readiness rule, keyed on THIS field, not the status key …).
>   // CLEARED back to NULL the moment the item reaches a `done`-category status
>   // (the chokepoint is `applyStatusTransition`; `complete_session` is the bulk
>   // close-out after the human merges the session PR). Indexed for the
>   // `complete_session` lookup …
>   sessionBranch         String?
> ```
>
> That comment already states the field's meaning, the readiness rule keyed on
> it, the `done`-clears invariant and the reason for the index — three of the
> four things deliverable 2 asked to be written from scratch. **So the deliverable
> was never _author a comment_; it was _extend the comment that is there_, with
> the retirement answer and a pointer to this document**, which is what shipped.
>
> **How the claim survived a verified ref: `:1991` is the line the DECLARATION
> sits on, and a Prisma field's documentation sits ABOVE it.** A reader who opens
> the file at the coordinate sees `sessionBranch String?` and nothing else, so
> the claim was checked against a COORDINATE rather than against the thing the
> sentence is about — `git grep -n <symbol>` returns the one line guaranteed not
> to contain the prose. Read the block (`-B`), never the coordinate.
>
> **This is the FOURTH occurrence of the class §0 above exists to name**, after
> MOTIR-3733, MOTIR-3753 and §0's own re-measurement — and it was committed
> inside the document that documents the class, in the same pass. That is the
> strongest available evidence that _be more careful about measurements_ is not
> the fix; the rule is now in the authoring corpus as the SOURCE limb.

---

## Consequences

- **`motir auto` and the scoped run keep working**, which is not a null result:
  under C both would stop after their first card per lineage, and the failure
  would present as _"nothing is ready"_ rather than as an error.
- **`work-item-delivery-links.md`'s "two scalars" framing is retired.** There is
  one scalar being retired (`github_pull_request.work_item_id`, by MOTIR-3757)
  and one being kept and re-described. A future reader meeting the phrase should
  land here.
- **The delivery table and the lineage column now have a stated boundary** —
  post-pull-request vs pre-pull-request — so the next card that wants to collapse
  them has a sentence to argue against rather than a gap to fill.
- **R3/R4 are the readers to protect.** Any future change to blocker readiness
  touches the field that decides whether a session run can proceed at all, and
  its failure mode is a silent empty ready set, not an error.
- **One thing this file does NOT decide:** whether a card can be integrated on
  more than one lineage. `work_item.session_branch` is a scalar and
  `promptTemplate.ts:836` leans on that (_"one call for the item, not one per
  repository — the item records a single session branch, which is why the name is
  shared"_). Multi-lineage is a separate question with no card; it is named here
  so it is not mistaken for something this decision settled.

## References

- `docs/decisions/work-item-delivery-links.md` §Q2 — the table this file amends.
- `docs/decisions/delivery-reader-migration.md` — the mirror of this file for
  `github_pull_request.work_item_id`, whose answer is the opposite.
- `docs/decisions/public-api-conventions.md` §8 — the additive-only promise §2 reads.
- `lib/workItems/blockerReadiness.ts` — the three jobs, in one pure module.
- `lib/repositories/workItemLinkRepository.ts:229,266,417` — R3, R4, R5.
- `lib/services/workItemsService.ts:2400,2794,4190` — the write, the two clears,
  the readiness header that states the rule.
- `packages/cli/src/commands/auto.ts:316,628` — the eager-open gate that makes the
  window a whole run on the scoped lane.
- MOTIR-2400 — why the inherited branch exists. MOTIR-3733 / MOTIR-3753 — the
  inventory-measurement class §0 is the third occurrence of.
