# Moving the `github_pull_request.work_item_id` readers onto `work_item_delivery`

**Status:** accepted · **Date:** 2026-08-28 · **Card:** MOTIR-3751 (epic MOTIR-2200)

> **What this decides.** `work-item-delivery-links.md` decided that the delivery
> JOIN TABLE is the one association between a work item and a pull request, and
> that both scalars are dropped by a follow-up card. This file settles the four
> questions that follow-up (MOTIR-3721) cannot answer for itself, and names the
> BUILD SHAPE it is re-scoped to. It decides nothing about
> `work_item.session_branch` — [`session-branch-lineage.md`](./session-branch-lineage.md)
> (MOTIR-3734) is the mirror of this file for that column, and MOTIR-3735 the
> build. **⚠️ That mirror came back the other way (2026-08-28): the column is
> KEPT, so the _"both scalars are dropped"_ clause above holds for
> `github_pull_request.work_item_id` — this file's column — and for that one
> only.**

> **On the file name.** `docs/decisions/` is slug-named, not numbered. This slug
> was checked free against `origin/main` and against every remote branch
> (`git cat-file -e origin/<branch>:docs/decisions/delivery-reader-migration.md`
> over `git ls-remote --heads origin`), because two parallel runs picking the
> same slug collide exactly as two picking the same number would.

---

## 0 · The inventory, RE-MEASURED — and it is not nine

**Every number below was taken on `origin/main` `6e71acf21`, and the COMMAND is
printed beside it so a reader can ask whether it is the set the claim is about.**
That question is the whole reason this section exists: MOTIR-3721 inherited a
five-row table from `work-item-delivery-links.md` Q2 (planning bug MOTIR-3733),
MOTIR-3751 corrected it to nine — and nine is also short, in the same shape one
level out.

**MOTIR-3751's own re-derivation scoped its command to ONE FILE:**

```
git grep -n "workItemId" lib/repositories/githubPullRequestRepository.ts
```

That command is correct and its answer is correct. The claim it was used to
support — _"the real set is nine reader sites"_ — quantifies over the CODEBASE.
A column is read wherever a row carrying it is in scope, and a Prisma row is a
plain object: `pr.workItemId` in a service is a read of the column that no grep
of the repository file can see. **The claim quantifies over X, the command
enumerated Y, and X ⊋ Y** — which is `run.md`'s _re-measure the PREDICATE, not
only the ref_, and is the same mistake the card was filed to correct, applied to
its own correction.

**The predicate this file measures:** _every site that reads
`github_pull_request.work_item_id`, in `lib` / `app` / `packages`, on
`origin/main` `6e71acf21`._ Two commands, because the column is reachable two
ways:

```bash
# A — inside the repository: Prisma where / select / include on the column
git grep -nE "workItemId" origin/main -- lib/repositories/githubPullRequestRepository.ts

# B — outside it: the column read off a row the repository returned
git grep -nE "(pr|existingPr|existing|candidate|row|target|m)\.workItemId" \
  origin/main -- lib app packages
```

### A · Repository sites — 8 readers and 2 writers

| #   | site                                                          | line | disposition                           |
| --- | ------------------------------------------------------------- | ---- | ------------------------------------- |
| R1  | `countOtherOpenByWorkItem`                                    | 159  | mechanical                            |
| R2  | `listCompletionFactsByWorkItem`                               | 183  | mechanical                            |
| R3  | `countOpenByWorkItem`                                         | 207  | mechanical                            |
| R4  | **`findWorkspaceIdByWorkItem`**                               | 226  | **Q1**                                |
| R5  | **`listMergedMissingBaseRefByRepo`** projection               | 253  | **§5 — and it is NOT log-only**       |
| R6  | `listByWorkItemWithContext` (Development surface)             | 288  | mechanical                            |
| R7  | **`searchCandidates`'s `workItem` include**                   | 355  | **Q3**                                |
| R8  | **`findTouchingPaths`'s `excludeWorkItemId`**                 | 473  | **Q4 — and it is DEAD in production** |
| W1  | `setWorkItemLink` (the manual-link write)                     | 371  | write path                            |
| W2  | `UpsertGithubPullRequestInput.workItemId` (the webhook write) | 32   | write path                            |

The two WRITERS are named because a column drop retires them too and neither
appears on any prior table.

### B · Service-level sites — 7, in 6 files, none previously counted

| #   | site                                          | what it does                                                                                                                                                                                                 | why it is not mechanical                                                                                                          |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `changeRequestStatusSync.ts:241-242`          | `if (existingPr?.workItemId) findById(…)` — **the sync's primary resolve**                                                                                                                                   | the whole merge path hangs off one scalar; over a set it is _which of N?_                                                         |
| S2  | `changeRequestCiFeedback.ts:384,388`          | `resolveChangeRequest` projects `workItemId`, consumed at **eight** sites incl. `commentsService.addComment(resolved.workItemId, …)` (:305) and `workItemsService.setCiState(resolved.workItemId, …)` (:329) | a CI comment and a CI-state write are per-CARD acts; over a set each becomes N acts, and nothing in the file is shaped for a loop |
| S3  | `ciPromotion.ts:147`                          | `pr.workItemId ? findById : null` → `resolveChangeRequestWorkItemSet`'s `linked`                                                                                                                             | **Q2** — the cap enters here                                                                                                      |
| S4  | `githubPullRequestService.ts:74`              | `.filter((row) => row.workItemId !== currentItemId)` — the picker's self-exclusion                                                                                                                           | **Q3's sibling.** Over a set the filter is _does this PR already deliver me?_                                                     |
| S5  | `historicalPullRequestBackfillService.ts:357` | `existing.workItemId === target.workItemId` — the no-op comparison                                                                                                                                           | scalar equality becomes set equality                                                                                              |
| S6  | `proseGraphAdvisoryService.ts:522,599`        | projects `workItemId` onto `CoveringChange`, then `m.workItemId !== id`                                                                                                                                      | **Q4's REAL predicate** — see §4                                                                                                  |
| S7  | `pullRequestBaseRefBackfillService.ts:221`    | `candidate.workItemId` → `touchedWorkItemIds` → `reevaluateItems`                                                                                                                                            | **R5's consumer** — see §5                                                                                                        |

### B′ · AMENDMENT (MOTIR-3756) — command B was itself short, by TWO

**This section's own re-measurement repeated, one notch smaller, the mistake it
was written to correct.** Command B enumerates `(pr|existingPr|existing|candidate|row|target|m)\.workItemId`
— a LITERAL dot. TypeScript's optional-chaining operator is `?.`, which that
pattern cannot match, so every read of the form `x?.workItemId` was invisible to
it. Re-measured on `origin/main` `17a3aba23` while building EXPAND-2:

```bash
git grep -nE "\?\.workItemId" origin/main -- lib app packages components scripts
```

| #   | site                                          | what it does                                                                          | disposition                             |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------- |
| S8  | `githubPullRequestService.ts:277`             | `const previousWorkItemId = existing?.workItemId ?? null` — the source of `movedFrom` | **CONTRACT** — it reports on W1's move  |
| S9  | `historicalPullRequestBackfillService.ts:286` | `if (existing?.workItemId != null)` — the sweep's STICKY-LINK guard                   | **CONTRACT** — it guards W1/W2's column |

**Total: 19 sites (8 repository readers + 2 repository writers + 9 service
reads), plus the cardinality cap of §2.** Both new rows are attached to the two
WRITERS rather than to a reader that must move: `movedFrom` describes the FK move
`setWorkItemLink` performs, and the sticky-link guard exists so the sweep does not
overwrite a stored link. Neither can retire before the column does, so **neither
changes EXPAND-2's scope** — but the CONTRACT card must expect nineteen sites and
not seventeen, which is the whole reason this amendment is on the record rather
than in a pull-request body.

**And the takeaway is the section's own, applied to itself:** the claim quantifies
over _every site that reads the column_; the command enumerated _every site that
reads it through a plain dot_. A number with its COMMAND beside it is what let a
later reader ask whether the command's set was the claim's set — which is exactly
what happened, and is the argument for printing the command rather than only the
ref.

---

**Total: 17 sites (8 repository readers + 2 repository writers + 7 service
reads), plus the cardinality cap of §2** — amended to 19 by B′ above. MOTIR-3721's _"nine reader sites plus
one service-level cardinality cap"_ is amended on the record; it is not drift,
because every one of the seven predates the card (all are on
`origin/main` at the ref the card itself measured).

**⚠️ AND S2 IS TWO ACTS, ONLY ONE OF WHICH FITS THIS SHAPE — this row is where the
enumeration stops one level short of the claim built on it (MOTIR-3770).** The
`ciState` write became a loop in MOTIR-3721 because it needs no storage of its own.
The CI COMMENT could not: its identity is a nullable scalar carrying a real foreign
key on `github_check_run`, so N cards need N LIVE ids and one column holds one.
That is a STORAGE question, and this section never reaches it — it enumerates the
CONSUMERS of the projection, not what each of them writes to, which is a different
set and a strictly coarser one. Settled separately in
[`ci-feedback-comment-per-card.md`](./ci-feedback-comment-per-card.md), which adds
`github_ci_feedback_comment`, keys it on the comment's own identity, and leaves the
scalar WRITTEN as a mirror until a CONTRACT card drops it.

### B″ · AMENDMENT (MOTIR-3757) — the CONTRACT card's own measurements, and both were short again

**The drop is the moment the compiler can enumerate the set, and it found two
sites neither command could see.** Commands A and B match the TEXT `workItemId`;
Prisma's `githubPullRequests` back-relation reads the same column under a
different name, so:

| #   | site                                                  | what it is                                                                     |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| S10 | `workItemRepository.findProvenanceBackfillCandidates` | `select: { githubPullRequests: { … take: 1 } }` — the relation, not the column |
| S11 | `workItemsService:2591`                               | `hasLinkedPr: row.githubPullRequests.length > 0` — S10's consumer              |

Both moved to `deliveries` and the VALUE is unchanged for every row, because pass
1 of the EXPAND migration wrote one delivery per stored link. **Total: 21 sites.**
The takeaway is §0's own, one notch further out again: a column is reachable by a
third route neither command enumerated — an ORM relation — and the enumeration
that finally closed it was `tsc` after the drop, not a grep before it.

**⚠️ AND `tsc` IS NOT TOTAL EITHER — FIVE MORE SITES ONLY THE SUITE FOUND.** Two
kinds, neither of which the compiler can see and neither of which either grep
matched:

- **Three `expect(prRow).toMatchObject({ …, workItemId })` assertions** — in
  `changeRequestTrunkGate`, `changeRequestArtifactEvidenceGate` and
  `gitlabWebhookService`. `toMatchObject` takes a plain object literal, so an
  extra key naming a column that no longer exists is a type-correct expression
  that fails at run time. A green `tsc` says nothing about them.
- **Two suites that REPLAY shipped migration SQL** naming the column —
  `clear-cancelled-manual-provenance` (its part-4 `NOT EXISTS`) and this story's
  own `deliveryLinks` (backfill pass 1). `migrate deploy` is unaffected, because
  each runs at its own position in the sequence; a replay against a
  fully-migrated database raises `42703`.

So the honest enumeration order for a column drop is **grep → `tsc` → the suite**,
and only the third is total. Saying so is worth more than the count: a reader who
stops at a green `tsc` has done two thirds of the check.

**And the `SINGULAR` sweep §6 measured at `6e71acf21` as 12 hits / 10 files is
16 hits / 11 files at `ae490d52e`**, the four new ones added by MOTIR-3751 and
MOTIR-3756 themselves (three in THIS file, one in `unlinkPullRequest.ts`). The
false positives are **four**, not three: `packages/cli/src/ciWatch.ts:49` — named
in §6 as a site in the sweep — is `pluralize`'s grammatical singular and has
nothing to do with the foreign key. A hit list is a measurement with a ref, and
this one was read as a work list two cards later.

---

## 1 · Q1 — what resolves the TENANT once the column is gone

### The evidence, read back from a running system

The migration file is not the evidence and neither is this paragraph.
**186 migrations were applied to an empty cluster and the policies were read from
`pg_policies`** (`kind-leaf-deepen.md`'s provisioning limb — the artifact that
created the state does not discharge a claim about the state):

```sql
SELECT tablename, policyname, cmd, qual FROM pg_policies
WHERE tablename IN ('github_pull_request','github_repo','work_item','work_item_delivery')
ORDER BY tablename, policyname;
```

```
 github_pull_request | github_pull_request_workspace_or_system | ALL |
   ((current_setting('app.system_admin', true) = 'true') OR (EXISTS ( SELECT 1
      FROM github_repo r
     WHERE ((r.id = github_pull_request.repo_id)
        AND (r.workspace_id = current_setting('app.workspace_id', true))))))

 github_repo | github_repo_workspace_or_system | ALL |
   ((current_setting('app.system_admin', true) = 'true')
     OR (workspace_id = current_setting('app.workspace_id', true)))

 work_item | work_item_active_workspace     | ALL    | ("workspaceId" = current_setting('app.workspace_id', true))
 work_item | work_item_project_narrow       | SELECT | ((COALESCE(current_setting('app.project_id', true), '') = '') OR …)
 work_item | work_item_public_project_read  | SELECT | ((COALESCE(current_setting('app.workspace_id', true), '') = '') AND …)

 work_item_delivery | work_item_delivery_active_workspace | ALL |
   (workspace_id = current_setting('app.workspace_id', true))
```

`work_item_delivery` carries **one** policy and it has **no `app.system_admin`
arm**. `relforcerowsecurity` is `t` on all four tables, so the policy binds the
table owner too.

### The failure, DEMONSTRATED rather than argued

A superuser bypasses RLS entirely, so the first run of this experiment as
`prodect` (the bootstrap superuser, `rolsuper = t`, `rolbypassrls = t`) returned
the delivery row and looked like a refutation. **That reading was a blind spot,
not a verdict.** Repeated as a `NOSUPERUSER NOBYPASSRLS` role, under exactly
`withSystemContext`'s condition — `app.system_admin = 'true'`, no
`app.workspace_id` bound:

```
(1) TODAY  github_pull_request -> github_repo                 -> ws1     ✅
(2) repointed at work_item_delivery                           -> 0 rows  ❌
(3) work_item_delivery JOINED to the armed github_repo        -> 0 rows  ❌
(4) SELECT count(*) FROM work_item_delivery                   -> 0       (no error raised)
(5) control: SELECT count(*) FROM work_item                   -> 0       (same shape)
```

Three things this settles that the policy text alone does not:

- **(2) confirms the card's premise exactly.** The repointed resolution returns
  nothing.
- **(3) kills the obvious rescue.** `work_item_delivery` carries `repo_id` as a
  real column, so _"join to the armed repo table"_ looks available. It is not:
  RLS filters the delivery row **before** the join, so an armed table on the far
  side of an unarmed one buys nothing. This is _RLS does not traverse foreign
  keys_, in the only direction that matters here.
- **(4) is the reason this must be decided rather than discovered.** It does not
  raise. `workspaceId` is `null`, `reevaluateItem` answers
  `no_linked_change_request` for every card in the product, and MOTIR-3034's
  repair path dies in silence. **(5)** is the control: `work_item`, whose
  unarmed-ness is the invariant `repoSetCompletionService`'s own header states,
  behaves identically — so (2) is measuring RLS and not a broken fixture.

### The decision: (a) — arm `work_item_delivery` with the arm its joined tables already carry

```sql
DROP POLICY "work_item_delivery_active_workspace" ON "work_item_delivery";
CREATE POLICY "work_item_delivery_workspace_or_system" ON "work_item_delivery"
  USING      (current_setting('app.system_admin', true) = 'true'
              OR workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (current_setting('app.system_admin', true) = 'true'
              OR workspace_id = current_setting('app.workspace_id', true));
```

Applied to the same cluster and re-measured as the same non-superuser role:

```
AFTER (a): repointed resolution                    -> ws1   ✅ restored
ordinary caller bound to the WRONG workspace       -> 0     ✅ isolation intact
ordinary caller bound to the RIGHT workspace       -> 1     ✅ unchanged
```

**The parity argument, stated rather than assumed — and it is a real argument,
not a formality.** A `withSystemContext` caller can ALREADY read every
`github_pull_request` row today, `work_item_id` included, and every
`github_repo` row. The (pull request → work item) association is therefore
already fully readable under the system flag. `work_item_delivery` holds that
same association, denormalised. **Arming it preserves the existing tenancy
surface across a storage move; it does not widen it.**

**What a reader GAINS that it did not have — say it plainly, because "no
widening" is only true up to this.** The delivery table can express _one pull
request → many cards_, which the scalar could not. So a system-flag reader gains
the ability to enumerate the OTHER cards a pull request delivers in one read,
where today it would have to ask per card. That is a strictly larger _answer_
over the same _rows_, and it is admitted deliberately: every consumer of the arm
is an internal service that already holds the pull-request row.

**The join is lost, and that is a small gain.** `findWorkspaceIdByWorkItem`
currently reads `github_pull_request → github_repo`; a delivery row carries
`workspace_id` directly, so the replacement is a single-table read with no join
at all.

### What the rejected options cost

- **(b) — keep the resolution on the connection tier by some other armed path.**
  **Rejected: there is no total one.** Enumerated from the same live cluster —
  37 tables carry an `app.system_admin` arm, and of the 20 tables carrying a
  `work_item_id` column exactly five are among them: `attachment`,
  `automation_rule_execution`, `plan_item`, `plan_target_lock`,
  `public_request_vote`. **Not one is universal.** A card need have no
  attachment, no automation execution, no plan item, no lock and no vote, so
  none of them answers _"which workspace owns the card with this id?"_ for an
  arbitrary card. The only armed table that answered it did so THROUGH the
  column being dropped. Choosing (b) means keeping the column for exactly one
  reader — i.e. not doing the migration.
- **(c) — pass the workspace in from the caller.** **Rejected, and it is the
  tempting one.** `reevaluateItem`'s two callers do differ:
  `pullRequestBaseRefBackfillService` holds a repo (and so a workspace), and the
  MCP repair surface holds a project. But `reevaluateItem`'s contract is _"given
  only an item id, decide it"_, and its header calls the connection-tier
  resolution **the TRUSTED source** precisely because request input is not. Taking
  the workspace as an argument moves a tenancy decision from a policy the
  database enforces to a parameter every future caller must get right, and its
  failure mode is a cross-tenant read rather than an empty one. **A silent empty
  is the better failure and we are removing it anyway; a silent wrong tenant is
  not.**

**Acceptance evidence for the build card is a `pg_policies` read on the deployed
schema, never the migration file**, plus a test that runs `reevaluateItem` for a
card with a delivery row and no bound workspace and asserts a NON-empty
resolution. A green suite is not evidence here: the failure is an empty result,
not an error.

---

## 2 · Q2 — `ChangeRequestWorkItemSet.single_item`

### The card's premise is FALSE, and the correction makes this the cheap question

MOTIR-3751 states _"It is a `ChangeRequestDeliveryKind` **on the wire**: renaming
it is a contract change with a version story."_ Measured:

```bash
git grep -n "ChangeRequestDeliveryKind|single_item|deliveryKind|ChangeRequestWorkItemSet" origin/main -- lib app packages tests
```

**`ChangeRequestDeliveryKind` has exactly ONE reader, and it is internal:**

```ts
// lib/services/changeRequestStatusSync.ts:307
const sessionBranch = delivery?.kind === 'session_branch' ? delivery.sessionBranch : null;
```

It appears in no DTO (`lib/dto/**`), no v1 resource, no MCP payload, no OpenAPI
document and no client. It is a discriminant on a value that lives inside one
transaction in one service. **There is no wire, no contract version and no old
value with readers**, and the only reader tests the OTHER arm.

### The decision: rename `single_item` → `linked`, no version story

- **Keep the type.** The two arms are two genuinely different resolutions (a
  branch join versus a link read), and `sessionBranch` is non-null iff
  `session_branch` — a real invariant the discriminant carries.
- **Rename the member** so it stops asserting a cardinality it will not have. The
  arm's `items` becomes `workItemDeliveryRepository.listByPullRequest(prId)`,
  which returns N; `linked` names the RESOLUTION (the delivery links), which
  stays true at every N including 0.
- **Retire the `linked: ChangeRequestWorkItemRef | null` parameter.** It is where
  the cap actually lives — a `| null` in a signature that collapses a set (row 10
  of MOTIR-3721's table, and the reason `git grep work_item_id` cannot find it).
  The function reads the delivery set itself, so callers S1 and S3 stop resolving
  a scalar and hand it the pull-request id.
- **Cost of NOT renaming:** a payload whose discriminator says _one_ over a list
  that holds N. That is exactly the class MOTIR-3722 filed — four shipped texts
  telling an agent a pull request _"cannot point at two"_ work items, one of which
  a parent run reads before mis-linking. Leaving a false discriminant in place
  after measuring it false is how the fifth one gets written.
- **Cost of renaming:** one enum member, one call site (`:307` compares
  `'session_branch'`, so it does not even change), the two callers' argument, and
  their tests. It is a rename inside one module.

---

## 3 · Q3 — the explicit-link picker's takeover chip

### What is actually there

`searchCandidates` (R7) includes `workItem: { select: { identifier: true } }`;
`toPullRequestLinkCandidateDto` (`lib/mappers/githubMappers.ts:119`) maps it to
`linkedTo: string | null`; `DevelopmentLinkControl.tsx:167` renders it as a
single `<Pill tone="neutral">{t('development.linkedTo', { key })}</Pill>` in the
`Combobox` option's `trailing` slot, in place of the PR-state pill. The i18n key
is `development.linkedTo` = `"Linked to {key}"` (`zh`: `"已关联到 {key}"`).
`githubPullRequestService.ts:74` (S4) filters out candidates already linked to
the CURRENT item, which is why a present `workItem` is always a different item.

The design of record is `design/github/design-notes.md` **Panel 5b**, and it
specifies the chip AND its rationale:

> _"A PR linked elsewhere shows a neutral chip **"Linked to MOTIR-\<n\>"** in place
> of its state pill; picking it MOVES the link (single FK — `workItemId` points
> at one item). This IS the mis-link correction path: there is deliberately **no
> per-row unlink**…"_

### The decision: a count-based chip; ONE new i18n key; the DTO carries a set

| deliveries | trailing slot                                                                         |
| ---------- | ------------------------------------------------------------------------------------- |
| 0          | the PR-state `Pill` — **unchanged**                                                   |
| 1          | `Linked to MOTIR-a` — **unchanged copy, unchanged key**                               |
| ≥2         | `Delivers {count} work items` — one new key `development.deliversN` (+ its `zh` twin) |

`PullRequestLinkCandidateDto.linkedTo: string | null` becomes
`linkedTo: string[]` (identifiers, ordered oldest link first); the mapper reads
the delivery set. S4's filter becomes _"does this PR's delivery set already
CONTAIN the current item?"_ — the same question, over the same set as Q4's, and
they should be written to agree.

**Not a list and not a cap.** A list in a Combobox option's trailing slot is an
unbounded string in a fixed-width row, which is a layout problem dressed as a
copy decision; a cap ("+3 more") is a list with a truncation rule and buys
nothing a count does not. The picker's job is to say _this pull request is
already spoken for_ — a count says that at every N.

### Does this need a design asset? **No — and here is the test that was applied**

`run.md`'s design-reference rule distinguishes two senses of _unspecified_: an
unspecified **DETAIL inside a surface the mockup DOES depict** falls to rung 1
and the named primitive; an unspecified **ELEMENT/PANEL the mockup does not
depict at all** is the NONE-exists case and the design gate fires.

Panel 5b depicts this chip: same `Pill`, same `tone="neutral"`, same trailing
slot, same tokens (`--el-chip-bg` / `--el-chip-border` / `--el-text-secondary`,
design-notes line 296), same row grammar. What changes is one string at N≥2.
**That is a detail inside a depicted surface. The design gate does NOT fire, and
this ADR says so on the record rather than leaving it ambiguous.**

**But ONE deliverable is owed to the design, and it is not pixels.** Panel 5b's
stated RATIONALE is falsified by this migration and must be amended in the same
pull request that moves R7:

- _"picking it MOVES the link (single FK — `workItemId` points at one item)"_ —
  after the move, picking it **ADDS** a delivery row. The chip stops being a
  takeover warning and becomes information: a pull request delivering several
  cards is the normal shape the table exists to allow, not a collision.
- _"there is deliberately no per-row unlink … an unlinked PR would just be
  re-resolved by the next webhook event"_ — that argument died with the
  title/branch parse (MOTIR-3674): nothing re-resolves an unlinked pull request
  any more. `unlinkPullRequest` already ships on the service and the item page
  reaches it; **MOTIR-3756** adds the MCP tool (§6 assigns it to EXPAND-2, and that assignment is the one that holds — this sentence named the wrong card).

**A design-notes amendment is a required deliverable of the picker card, not a
scope note** — a mock whose prose argues from a retired mechanism is how the next
reader re-derives the retired mechanism.

---

## 4 · Q4 — the subsumption advisory's exclusion predicate

### The predicate the question is about is DEAD; the live one is somewhere else

`findTouchingPaths(workspaceId, paths, since, excludeWorkItemId)` (R8) spells the
exclusion as an explicit OR at `githubPullRequestRepository.ts:473`. Its **only
production call site passes `null`**:

```ts
// lib/services/proseGraphAdvisoryService.ts:515
githubPullRequestRepository.findTouchingPaths(ctx.workspaceId, [...union], since, null, tx);
```

`buildSubsumptionIndex`'s own header says why: `since` and `excludeWorkItemId`
are per-SUBJECT facts and the query is widened to the UNION of a whole batch, so
**both per-subject clauses are re-applied in memory**. The live exclusion is:

```ts
// lib/services/proseGraphAdvisoryService.ts:599
m.workItemId !== id &&
```

`excludeWorkItemId` is exercised by `tests/github/mergedPullRequestCapture.test.ts:594`
and by nothing else.

**So Q4 as posed would have been answered in the wrong layer.** Deciding the SQL
predicate's set semantics settles a parameter no caller uses, and leaves the
predicate that actually runs to be improvised at line 599 by whoever gets there.

### The decision

1. **DELETE `excludeWorkItemId` from `findTouchingPaths`.** A parameter whose
   sole production caller passes `null` is not a predicate to port. Its
   header's KEEP argument (rows linked to NO work item are deliberately retained)
   survives unchanged and becomes trivially true: with no exclusion clause there
   is nothing that could drop them. Update the test to assert the in-memory
   predicate instead.
2. **`CoveringChange.workItemId: string | null` becomes `workItemIds: string[]`**
   (empty for a pull request delivering nothing — the new spelling of `null`),
   read from the delivery set.
3. **Line 599 becomes `!m.workItemIds.includes(id)` — the CONTAINS reading.**

### Why CONTAINS and not "is exactly `{asker}`"

The two readings differ precisely for a pull request delivering the asker **plus
other cards**, which is the shape the delivery table exists to allow.

The advisory's question is _"has somebody ELSE already changed this path?"_ A
pull request that delivers the asker was opened by work ON the asker — a
`motir auto` session pull request carrying twelve cards is twelve cards' own
pull request, not a stranger's. Under the **is-exactly** reading that pull
request would be reported back to each of its twelve cards as evidence that
someone else had already shipped their deliverable. That is exactly the false
positive the exclusion was written to suppress, and the repository header's own
words for it are _"a card's own merged PR touching its own paths is the ordinary
case and is not evidence that someone ELSE already shipped its deliverable."_
The CONTAINS reading keeps that sentence true when _own_ becomes _shared_.

**What the advisory reports for a multi-card pull request, stated:** it is
SUPPRESSED for every card it delivers, and REPORTED to every card it does not.
The cost is real and is accepted: two cards on the same session pull request no
longer warn each other about a shared path. They cannot usefully — they are
already on one branch, in one run, and the finding _"somebody is changing this
path right now"_ is answered by _"you are"_. The failure the advisory exists to
prevent is two INDEPENDENT sessions colliding, and independent sessions do not
share a delivery set.

---

## 5 · Row R5 — `listMergedMissingBaseRefByRepo`'s projection is **not log-only**

MOTIR-3751 lists this row as _"log-only; state the disposition"_. Measured, that
is false:

```ts
// lib/services/pullRequestBaseRefBackfillService.ts:221
if (candidate.workItemId) touchedWorkItemIds.add(candidate.workItemId);
// …:157-159
touchedWorkItemIds.size > 0
  ? await repoSetCompletionService.reevaluateItems([...touchedWorkItemIds], …)
```

The projection is the INPUT to the re-evaluation set — which is `reevaluateItem`,
which is Q1. **R5 and R4 are the two ends of one path**, and R5's failure mode is
the same one, one layer out: a projection that comes back empty produces an empty
`touchedWorkItemIds`, `reevaluateItems` is skipped entirely, and the backfill
reports success having repaired nothing. Nothing raises, and the sweep's own
report says `filled: N`.

**Disposition: R5 moves to the delivery table (`listByWorkItem` per candidate, or
a batched delivery read keyed on the candidate pull-request ids), and it ships in
the SAME card as R4** — not because the code is coupled, but because the two share
one failure mode and one acceptance test. Splitting them puts the consumer of a
silently-empty read in a different pull request from the fix for it.

---

## 6 · Q5 — the BUILD SHAPE

> **⚠️ SUPERSEDED IN ONE RESPECT — read §6a first.** The shape below is
> EXPAND → CONTRACT, and a column drop needs a THIRD phase between them: the
> release that takes the field out of the generated client while the column
> stays. Executing this table as written is what took `get_work_item` down
> tenant-wide on 2026-08-28 (MOTIR-3852). Everything else here — the cut by
> failure mode, the per-card scopes, the ordering — stands.

### Not one card, and not a pair

MOTIR-3721 stands at 8 points, which `kind-leaf-deepen.md`'s estimation gate reads
as a SPLIT signal rather than a size — and that 8 was measured against **nine**
sites. Against **seventeen** plus an RLS migration plus an MCP tool, one card is
not arguable. A straight EXPAND/CONTRACT pair is not either: it puts all
seventeen readers in one half, which re-trips the gate at roughly 8 points on its
own.

**The cut is by FAILURE MODE, not by count** — which is what makes it a shape
rather than a partition:

|              | card                      | scope                                                                       | pts   | min    |
| ------------ | ------------------------- | --------------------------------------------------------------------------- | ----- | ------ |
| **EXPAND-1** | **MOTIR-3721**, re-scoped | the arm, and every reader whose failure is SILENT and product-wide          | **5** | **75** |
| **EXPAND-2** | new                       | the readers whose failure is VISIBLE and local, plus the correction surface | **5** | **75** |
| **CONTRACT** | new                       | drop the column, sweep the prose                                            | **3** | **45** |

**EXPAND-1 — MOTIR-3721** · the RLS migration of §1 with its `pg_policies`
acceptance read; R4, R5+S7, R1, R2, R3, S1, S2, S3; the `single_item` → `linked`
rename and the retirement of the `linked` parameter (§2). The column is still
WRITTEN and still PRESENT — W1/W2 untouched, nothing dropped, so the rollback is
a code revert. Every member of this half fails by returning nothing while
raising nothing; each needs a test that asserts a NON-EMPTY result, and a green
suite proves nothing about any of them.

**EXPAND-2** · R6 (Development surface), R7 + S4 (the picker chip and its
self-exclusion, §3) with the `design/github/design-notes.md` Panel 5b amendment;
R8 deleted and S6 rewritten to the CONTAINS reading (§4); S5; and
`unlink_pull_request` on the MCP with the key `link_pull_request` asserts.
**The tool belongs HERE and this is the half MOTIR-3721's own argument was
about:** the mis-link hazard appears the moment a re-link ADDS instead of MOVES,
which is the moment the picker's readers move — not before, and never after.
Every member of this half fails where a person can see it.

**CONTRACT** · drop `github_pull_request.work_item_id`; W1/W2 retire with it;
`prisma migrate diff --exit-code` clean; the `SINGULAR` phrase sweep — measured
`git grep -n "SINGULAR" origin/main -- lib app packages docs` returns **12 hits
across 10 files** (re-measured at **16 across 11** when CONTRACT ran — § B″) (`app/api/v1/…/plan-session/route.ts:19`,
`docs/decisions/change-request-cardinality.md:92`,
`docs/decisions/public-api-conventions.md:1526`,
`docs/decisions/work-item-delivery-links.md:260`,
`docs/decisions/work-item-repository-set.md:135`, `docs/mcp.md:1172`,
`lib/mcp/payloads/exemptions.ts:94`, `lib/mcp/tools/linkPullRequest.ts:242,275,279`,
`lib/services/githubPullRequestService.ts:187`, `packages/cli/src/ciWatch.ts:49`);
**three of those are false positives about a different singular** (the plan-session
route, the public-API conventions, and `targetRepoRole`) — carry the pattern, the
count and the per-site disposition in the pull-request body and phrase the list as
_the sites this card judged_, never _every site_. Re-pin
`tests/api-docs/mcp-truth.test.ts`'s fingerprint from a live `tools/list`
handshake; `packages/cli` green (its suite sits outside the repo's gate).

### Ordering and edges

`EXPAND-1 → EXPAND-2 → CONTRACT`, each `blocked_by` the last. CONTRACT cannot
precede either — the column is read until both land. EXPAND-2 is after EXPAND-1
rather than parallel because both touch `resolveChangeRequestWorkItemSet` and
`githubPullRequestRepository`, and two sessions amending one file is the collision
this project pays for weekly.

MOTIR-3735 (`work_item.session_branch`) stays `blocked_by` MOTIR-3721 as it is:
its own decision is MOTIR-3734's, and nothing here changes that edge. MOTIR-3752
(the `motir-meta` `run.md` amendment — _a parent run stops linking the PARENT
because the scalar MOVES_) is `blocked_by` MOTIR-3721 today and **should be
re-pointed at CONTRACT**: the sentence it retires is true until the column is
gone.

### One thing this shape deliberately does NOT do

It does not add a card for the migration's effect on the shared development
database. MOTIR-3721 already carries that warning and it belongs to whichever
card drops the column (CONTRACT), which is where a `TEMPLATE`-cloned worker
database actually breaks.

---

## 6a · AMENDMENT (MOTIR-3852) — the build shape above is TWO phases and a column drop needs THREE

§6's table is EXPAND → CONTRACT, and executing it exactly as written took
`get_work_item` down tenant-wide for about six minutes on 2026-08-28. The
sequence was not performed carelessly. It was performed correctly, and the shape
is one phase short.

### What happened

`Deploy to Fly` on run `33218107466` (head `741e7cec3`) ran **`23:12:13Z →
23:18:37Z`**, its `Build the image and release it` step spanning `23:12:33Z →
23:18:35Z`. Inside that window every `get_work_item` returned

```
Invalid `prisma.workItemDelivery.findMany()` invocation:
The column `github_pull_request.work_item_id` does not exist in the current database.
```

Observed OK at `23:12`, 500 three times at `23:17`, and 200 again at `23:40` once
the rollout finished — the outage is bounded by the deploy job to the minute.

### Why the reader sweep did not prevent it, and could not have

§0 re-measured the reader inventory twice and got it right; re-run at
`origin/main` today it returns nothing. **The reader still selecting the column
was not a reader anybody wrote.**

`workItemDeliveryRepository` reads `include: WITH_PR`, where

```ts
const WITH_PR = { pullRequest: true, repo: true } as const;
```

A relation include with no `select` emits **every scalar the model declares**, so
the column list a query touches is a property of `prisma/schema.prisma` and of no
line of application code. **The model declaration is itself a reader — and it is
the one reader a search for the field's name cannot find**, which is precisely
why a complete sweep and a total outage are compatible facts.

That declaration was removed by `4466ea7ff`, the same commit that dropped the
column. So the client stopped asking and the column disappeared in ONE release,
with no interval between them. `fly.toml`'s `release_command` runs
`prisma migrate deploy` in a temporary machine _"before any new machine takes
traffic"_ (`scripts/release-migrate.mjs`, its own header) — the correct ordering
for an ADDITIVE migration, and for a destructive one it guarantees an interval in
which the schema no longer has what the still-serving image is asking for.

### The rule

> **The image that is SERVING when a `DROP COLUMN` lands must already have a
> client that does not select it** — which is only true if the client stopped
> selecting it in an EARLIER release.

So a column removal is three phases, and the boundary between the last two is a
DEPLOY:

|       | phase           | ships                                                            | released before the next phase merges?     |
| ----- | --------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| **1** | **EXPAND**      | move the application readers; the column and the field both stay | yes                                        |
| **2** | **SCHEMA-ONLY** | take the field out of the GENERATED CLIENT; the column stays     | **yes — this is the one that was missing** |
| **3** | **CONTRACT**    | drop the column                                                  | —                                          |

Phase 2 is constrained by the drift gate (`Assert the datamodel and the
migrations agree`, MOTIR-1960): deleting a field while its column remains IS
drift, and the gate is right to say so. The phase therefore has to exclude the
field from the client without removing it from the datamodel.

### A release gate on phase 1 is necessary and NOT sufficient

MOTIR-3818 is the right instrument — a `verification` card holding a CONTRACT
until its EXPAND is genuinely deployed — and it was created at `19:05Z`, an hour
before MOTIR-3757 merged without one. It would not have prevented this. It asks
whether the REPLACEMENT is live; the question that decides whether a drop is safe
is whether anything still SELECTS the old column, and after phase 1 the answer is
still yes. Both gates are owed, and they are different questions.

### What enforces it

`tests/contract-phase-guard.test.ts`. A migration containing `DROP COLUMN` or
`DROP TABLE` must carry

```sql
-- @client-stopped-selecting: MOTIR-<n>
```

naming the work item whose release stopped the client selecting it, plus a second
check that needs no declaration at all: a column being dropped may not still be
declared in the datamodel.

**Its cost and its blind spot, recorded rather than left to be discovered.** The
property that matters is HISTORICAL — _was the client already not selecting this
in the previous release?_ — and at the contract commit the tree is identical
either way, so nothing static can tell the safe case from the unsafe one. Reading
the diff was measured and **rejected**: `tests/api/v1/work-loop-story-gate.test.ts`
GUARD 4 already records `git diff --name-only <merge-base>` as _"WRONG — not
weak, wrong … a check that only works in the author's worktree is worse than
none, because it reads as coverage"_, and only one of `ci.yml`'s thirteen
checkouts pays `fetch-depth: 0`. So the guard holds the property the diff stood
in for, as a DECLARATION — **the marker's truth is asserted by the author, and no
check here can prove the named release happened.** What it removes is the SILENT
version: a two-phase drop can no longer be written by someone who never
considered the question.

The ten destructive migrations that predate the rule are exempted as an
enumerated SET (measured at `origin/main` `2a30b92fd`, 10 of 188), never as a
date cutoff — coverage is a set, and a cutoff would exempt anything that sorted
below it, including a migration added later on a long-lived branch.

### The consequence for the sibling pair, already applied

MOTIR-3803 was written as phase 2 and phase 3 in one card and would have
reproduced this on `github_check_run.feedback_comment_id`. It is re-scoped to the
drop alone; MOTIR-3863 is the schema-only phase and MOTIR-3864 the deploy gate
between them.

---

## Consequences

- **`work_item_delivery` gains a `system_admin` policy arm.** The tenancy surface
  is unchanged in rows and larger in answers (§1). Any future table that must be
  readable before a tenant is bound needs the arm at creation; a table added
  without one cannot serve a connection-tier resolution, and it will fail by
  returning nothing.
- **`ChangeRequestDeliveryKind.single_item` becomes `linked`.** No contract
  version, no client, one internal reader unaffected (§2).
- **`PullRequestLinkCandidateDto.linkedTo` becomes a `string[]`**, and Panel 5b's
  rationale is amended in the same pull request (§3).
- **`findTouchingPaths` loses a parameter** and the subsumption advisory excludes
  on CONTAINS (§4).
- **MOTIR-3721 is re-scoped to EXPAND-1** and two cards are proposed beside it.
- **A column removal is THREE phases, not two** (§6a, MOTIR-3852). The
  datamodel's field declaration is itself a reader, so the client must stop
  selecting the column in a RELEASE of its own before the drop lands.
  Enforced by `tests/contract-phase-guard.test.ts`.

## References

- `docs/decisions/work-item-delivery-links.md` — the table, and the Q2 reader
  list this file re-measures. Read it as the source of the SHORT inventory.
- `docs/decisions/change-request-cardinality.md` — superseded; its _"KEEP THE
  SINGULAR FK"_ is one of the `SINGULAR` hits CONTRACT disposes of (twelve when
  §6 measured them, sixteen when CONTRACT ran — see § B″).
- `docs/decisions/unlinked-pull-request-check.md`,
  `docs/decisions/repo-set-completion-repair.md` — the check and the repair path
  §1 is about.
- `lib/services/repoSetCompletionService.ts:105-145` — the tenant-binding
  sequence, with the invariant in its own header.
- `lib/repositories/workItemDeliveryRepository.ts:12-21` — _"A read through the
  bare singleton does not fail — it returns an EMPTY LIST"_, which is why §1
  fails silently.
- MOTIR-3733 — the planning bug recording the inherited-inventory class.
  MOTIR-3734 / MOTIR-3735 — the mirror of this file, and its build, for
  `work_item.session_branch`.
