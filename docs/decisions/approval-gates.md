# ADR: The approval gate — one way of saying yes, whatever is being decided

- **Status:** Accepted (2026-09-08, drafted for Subtask MOTIR-4786 per the
  decision-subtask ladder). This is the rung-1 policy the rest of Story
  MOTIR-4778 implements — no schema, service, route or surface ships until these
  seven decisions are pinned. **No application behaviour ships in this subtask**
  (the ADR only, plus the one-line pointer §5 owes `design-result.md` §7).
- **Story / Subtask:** MOTIR-4778 (The approval GATE — a contract, a record, one
  shared control, and the DESIGN gate as its first and only kind) · Subtask
  MOTIR-4786. Epic MOTIR-4878.
- **Consumed by:** MOTIR-4788 (the `ApprovalGate` record), MOTIR-4789 (the
  design of the shared control), MOTIR-4790 (the decide door and its registry),
  MOTIR-4792 (the control itself), MOTIR-4795 (the author-facing
  documentation) — and, in sibling stories, MOTIR-4879 (the Approvals tab),
  MOTIR-4880 (`prMergeMode`), MOTIR-4882 (the merge gate).
- **Builds on:** `acceptance-receipt-lifecycle.md` (the freeze this deliberately
  does NOT copy — §6c), `design-result.md` (§4's supersede/retention, the
  premise §6 amends, and §7, the deferral §5 discharges),
  `unlinked-pull-request-check.md` (both GitHub Apps' declared permissions),
  `token-permissions.md` (the grant a new key joins).
- **Who decided what:** Q2 and Q6 were answered by **Yue on 2026-09-08** and are
  marked **DECIDED BY THE REQUESTER** below. Q1, Q3, Q4, Q5 and Q7 were resolved
  from the decision-authority ladder and are marked **DECIDED BY THE PLANNER**;
  each states the rung it was decided on.
- **Supersedes / superseded by:** none. It is the authority for what an approval
  gate IS and for the gate LIFECYCLE. `design-result.md` remains the authority
  for the design artefact itself; `acceptance-receipt-lifecycle.md` remains the
  authority for the acceptance receipt, which this record does not re-home.
- **AMENDED 2026-09-08 (MOTIR-4911), by Yue, at six clauses.** The record was
  accepted the same day and is right about most things; the amendments below
  correct what the model settled afterwards. **Every one keeps its struck text**,
  so a reader arriving from an old citation lands on the correction rather than
  on nothing. **No behaviour ships in the amendment either** — the ADR only, plus
  the one-line pointer §6c owes `design-result.md` §7.

  | clause                    | what changed                                                                                                                                                                                                                    |
  | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | **§1** (INCOMPLETE)       | `decision_approval` joins the enum, and the SUBJECT is re-stated as _a document with a resolver_ rather than a concrete row                                                                                                     |
  | **§2** (WRONG)            | AUTHORITY is **assignee OR reporter OR admin** for both verbs, not two permission keys. ROUTING is unchanged. **⚠️ The reporter arm was itself narrowed on 2026-09-11 — see §2's SECOND amendment, which is the rule in force** |
  | **§3** (WRONG)            | approving writes `done` **only when there is no linked open pull request**; otherwise it writes `approved` and the merge closes                                                                                                 |
  | **§4** (partly falsified) | the merge gate DOES write a status — `approved` — and still does not write `done`                                                                                                                                               |
  | **§6b** (incomplete)      | the `approved` WORK-ITEM status, and `decisionSource: github` with the unmappable-actor rule                                                                                                                                    |
  | **§6c** (FAILS SILENTLY)  | the pin is keyed on the **SUBJECT**, not on the gate kind                                                                                                                                                                       |
  | **§8 · §9** (new)         | THE TWO WORKFLOWS, and HOW TO TEST as a first-class deliverable                                                                                                                                                                 |

  **§8 is the one to read first.** It is the discriminator the other five
  amendments are consequences of.

- **AMENDED 2026-09-13 (MOTIR-5174), at §7, additively.** The rule for when the
  provenance default is written, what a MIXED or EMPTY project seeds, and the
  three-release retirement of `Workspace.subtaskPrMergeMode`. §7's own text and
  value table are unchanged.

- **AMENDED 2026-09-15 (MOTIR-5479), at §8 row 4a, and additively after §8's
  Workflow B.** The approve-and-merge gate's contract: where it hangs, what it
  is about, when it is raised and withdrawn, how _Approve and merge_ is recorded,
  and who may press. Row 4a's _"ONE transaction"_ is struck and replaced;
  nothing else in §8 changes.

- **AMENDED 2026-09-19 (MOTIR-5800), at §4 and §8, by Yue.** §4's FOURTH
  AMENDMENT: **one approval authorizes ONE merge or enqueue action.** Every
  un-landed outcome — a queue exit of any disposition, or a host refusal at the
  press — is CLASSED by reason: retryable and setting-blocked re-ask at
  `in_review` with ONE fresh gate, a conflict drops to `implemented` with the
  promotion held, and _Retry merge_ / _Queue again_ on the pull request's row
  DECIDE that fresh gate rather than reusing the spent approval. The host's
  refusal is recorded on the pull request, and `implemented → approved` leaves the
  workflow. It supersedes the THIRD's decisions 5–7 and §8's point 5(e), each
  struck in place and still readable.

- **AMENDED 2026-09-19 (MOTIR-5672), at §1, §8 and _Deliberately NOT decided
  here_ — THE DECISION GATE.** A `coding_agent` decision card's subject is the
  `docs/decisions/*.md` file in its MANDATORY pull request; the gate is PRIMARY
  over the merge like the design gate, and one press accepts it and merges.
  §1's _"a decision with no pull request"_ cell and §8 Workflow A's
  `decision_approval` are struck in place, §1's handler table gains its third
  column, and the rest is **§8's FIFTH AMENDMENT**, after the FOURTH.

- **AMENDED 2026-09-19 (MOTIR-5787), at §1, additively.** A fourth kind,
  `acceptance_result`: it hangs on the STORY whatever the run target; on a story
  run it is the PRIMARY of two gates whose one press also merges the story's code
  (never a pull request for the video, which is never committed); and approval
  writes `done` only when nothing under the story is left for the cascade to
  close. Nothing else in §1 changes.

- **CLOSED OUT 2026-09-10 (MOTIR-4795).** Everything Story MOTIR-4778 ships has
  landed, and **_What SHIPPED — the dated close-out_** below records the three
  places the implementation diverged from this record, plus what has NOT shipped
  so this record's silence is not read as delivery. **Read it before building
  against any section here:** §1's registry shape, §8's Workflow B status write
  and §6a's routing field each say something the code deliberately does
  differently.

> Convention (set by `work-item-type-taxonomy.md`, followed by
> `billing-tiering.md` / `acceptance-video.md` / `design-result.md` /
> `acceptance-receipt-lifecycle.md`): a decision record is a markdown file under
> `docs/decisions/`, structured **Status → Context → Decision → Consequences**,
> with the load-bearing facts pinned in explicit tables so downstream code has
> one authoritative source to implement against.

---

## Context

**Motir's promise is that an agent takes the work over end to end. It does not,
and the gap has a precise shape:** the agent produces something, and then a
person has to leave the product to say yes to it. They open GitHub to merge.
They look at a design in a panel that deliberately has no buttons. Motir finds
out afterwards, from a webhook. The tracker is a spectator at the two moments
that decide whether work ships.

### Shipped substrate this reconciles against (verified 2026-09-07/08 on `origin/main`)

| fact                                                                                                                                                                                                                                       | where                                                                          | why it matters here                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nothing delivers an approval gate.** `git grep -E 'model ApprovalGate\|approval_gate\|ApprovalGateKind' -- 'prisma/*'` and `git ls-tree -r --name-only \| grep -iE 'approvalGate'` both return nothing                                   | —                                                                              | this record is not re-deciding an existing mechanism. (A case-insensitive grep for _"approval gate"_ returns 23 hits and is the WRONG predicate — it matches prose and Story 9.2's unbuilt `Project.designApprovalGate`.) |
| **One approval language already ships, once** — Approve / Request changes over `pending \| approved \| changes_requested`, with `approvedById` and `approvedAt`                                                                            | `AcceptancePanel.tsx`, `acceptanceActions.ts`, `lib/dto/acceptanceEvidence.ts` | §1 generalises this vocabulary rather than inventing a second one                                                                                                                                                         |
| **…and it asserts NO decide permission of its own** — `acceptanceEvidenceService.decide` gates only through `workItemsService.updateStatus` → `assertCanEdit` → `work_item:edit`, which `member` holds                                     | `lib/services/acceptanceEvidenceService.ts`                                    | §2's authority decision either inherits this or improves on it deliberately. It improves on it, and says why                                                                                                              |
| **Design approval does not exist**, and the panel's own header says so                                                                                                                                                                     | `DesignResultPanel.tsx`; `design-result.md` §7                                 | §5 discharges that deferral                                                                                                                                                                                               |
| **No merge call exists anywhere** — `git grep -E "pulls/[^\"']*/merge\|merge_method\|mergeChangeRequest"` over `lib/**` and `app/**` returns nothing; and `GitProvider` declares no merge method                                           | `lib/git/provider.ts`                                                          | §4 is a new capability on an existing seam, not a call to add inline                                                                                                                                                      |
| **`motir-integration` (App 4206669) holds `contents: read`**, read back from `gh api /apps/motir-integration` on 2026-09-07 — matching `unlinked-pull-request-check.md`'s table exactly                                                    | GitHub's own API                                                               | §4's permission bump is genuinely owed (MOTIR-4787)                                                                                                                                                                       |
| **`motir-studio` (App 4445390) already holds `contents: write`**, but "is not a fallback: it is installed only on `motir-projects` … and is never installed where a user's repositories are"                                               | `unlinked-pull-request-check.md`                                               | §4 selects the App by repository PROVENANCE                                                                                                                                                                               |
| **`Workspace.subtaskPrMergeMode` has had no functional reader since MOTIR-30** — eight `git grep` hits, all schema / DTO / mapper / one test assertion / two prose comments / the frozen plan-seed snapshot; nothing branches on its value | `prisma/schema.prisma:1042`                                                    | §7 renames and re-tiers it while that is still free                                                                                                                                                                       |
| **A superseded design's blobs are RECLAIMED** — supersede unlinks the prior row's attachments and the orphan-GC sweeps them after a **7-day** window; `lib/dto/designEvidence.ts` documents `url` / `mimeType` / `sizeBytes` going null    | `designEvidenceService.ts`, `attachmentGc.ts`                                  | §6c's pin exists because of this                                                                                                                                                                                          |
| **`withdrawCurrentForWorkItem` already makes a row non-current WITHOUT unlinking** — "the row survives, its `design_asset` rows survive, and their `Attachment` rows are NOT unlinked — unlike a supersede"                                | `designEvidenceService.ts`                                                     | §6c is a predicate on an existing branch, not new machinery                                                                                                                                                               |
| **`Done → In Progress` is a declared workflow transition** (`cmqfb4dau000v2d0iki17vp82`)                                                                                                                                                   | the project's workflow                                                         | §6d's reopen path needs nothing built                                                                                                                                                                                     |
| **`boardsService.moveCard` routes through `workItemsService.applyStatusTransition`**                                                                                                                                                       | `lib/services/boardsService.ts`                                                | the status guard (a sibling story) has one funnel, not four                                                                                                                                                               |

### The precedent that shaped §6c, stated because it is the same bug one domain over

`lib/acceptanceEvidence/errors.ts` records what happened when an approval gate
met a supersede path with no status predicate (MOTIR-2764):

> _"`markSupersededByWorkItem` carries no status predicate, so before this error
> existed ANY publish flipped the approved row `isCurrent: false`, unlinked its
> attachments, and left the orphan-GC to reclaim **the very bytes the approval
> was given on** — triggered by something as small as a one-line fix to an
> `acceptance_.spec.ts`."\*

**The design supersede path still has no such predicate.** The design gate is
what will make it bite. §6c is the fix, and it is deliberately NOT the fix
acceptance took.

---

## Decision

### 1. What a gate IS, and how a kind registers — DECIDED BY THE PLANNER (rung 2: the shipped acceptance vocabulary)

An **approval gate** is a row with:

| field          | meaning                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| **subject**    | what is being decided — a `DesignEvidence` id, a pull-request delivery id                               |
| **kind**       | which vocabulary of verbs applies. A Prisma **enum**, not free text                                     |
| **state**      | where the decision stands (§6b)                                                                         |
| **the record** | who decided it, when, under which permission, through which surface, what it caused, and the note (§6a) |

`kind` is an enum rather than a string **so the registry can be TOTAL over it and
the compiler can prove it**: adding a member is a type error until its handler
exists. That is the whole mechanism by which a third kind cannot quietly ship
half-wired.

**The registry** is `Record<ApprovalGateKind, GateHandler>`. **What a third kind
must supply to register — the table this record exists to make re-usable:**

| a handler supplies                                 | for `design_result`                              | for `pull_request_merge`                          | for `decision_approval` — §8's FIFTH AMENDMENT (MOTIR-5672)                                                                 |
| -------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **how to resolve the SUBJECT** from the gate row   | the current `DesignEvidence` for the work item   | the linked pull-request delivery                  | the ONE `docs/decisions/*.md` file at the pull request's head, through a resolver; UNRESOLVABLE otherwise (clauses 1, 3, 8) |
| **who it ROUTES to**                               | §2's rule (`assigneeId ?? reporterId`)           | the same                                          | the same                                                                                                                    |
| **which PERMISSION authorises a decision**         | `work_item:edit`                                 | `work_item:merge_pull_request`                    | `work_item:edit`                                                                                                            |
| **which STATUS TRANSITION the gate owns**, or none | the move into the project's `done` category      | none — the webhook moves the card (§4)            | none — `approved` is the companion merge gate's, `done` the merge webhook's (clauses 2, 5)                                  |
| **what `approve` DOES**                            | §3                                               | §4                                                | records the decision and carries the merge ONCE; refused while UNRESOLVABLE (clauses 3, 5)                                  |
| **what `request_changes` DOES**                    | records the decision, moves nothing              | records the decision, moves nothing               | records the decision, moves nothing — allowed while UNRESOLVABLE (clause 3)                                                 |
| **what to RETAIN on approval**, or nothing         | pin the approved `DesignEvidence`'s assets (§6c) | nothing — the merge commit is durable on the host | nothing — the blob sha and the merge commit are durable on the host (clause 9)                                              |

_The third column is added by §8's FIFTH AMENDMENT (MOTIR-5672, 2026-09-19); the
first two are unchanged._

A third kind is then a row in the enum, a handler, and a renderer for its
subject body. **No second vocabulary, no second control, no second decide door.**

> ### §1 — AMENDMENT (MOTIR-4911, 2026-09-08): a third kind, and a SUBJECT that is a document with a RESOLVER
>
> **What was INCOMPLETE.** The section above is right about the mechanism and
> short by one kind, and its subject column named two concrete row types — _"a
> `DesignEvidence` id, a pull-request delivery id"_. Naming rows makes the enum
> look like it is keyed on STORAGE, so the next kind whose subject is not yet a
> row reads as needing a migration before it can register. It does not.
>
> **`decision_approval` is a third kind.** A `type: decision` card with
> `executor: coding_agent` produces a decision DOCUMENT — the agent researches,
> proposes, and writes it — and a person approves or requests changes on it, with
> exactly the verbs `design_result` already has. It is the same vocabulary over a
> different subject, which is the whole claim §1 makes.
>
> **The KIND axis, in full, after this amendment:**
>
> | kind                    | the port shows                                                            | fires when                                                                                                                                       |
> | ----------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
> | `design_result`         | the changed mock(s), the note as a link — `design-result.md` AMENDMENT 4  | a design with **no pull request**                                                                                                                |
> | `decision_approval`     | the decision **document**                                                 | ~~a decision with **no pull request**~~ **a `coding_agent` decision whose pull request carries the document** (§8's FIFTH AMENDMENT, MOTIR-5672) |
> | `pull_request_approval` | what the card produced — design assets, or **what changed + how to test** | **any** card **with a pull request**                                                                                                             |
> | `pull_request_merge`    | the same port; it is the second decision on the same subject (§8, row 4b) | **any** card **with a pull request**                                                                                                             |
>
> **The kind decides the VERBS and the EFFECT; the PORT decides what you LOOK
> at, and the port is chosen by what the card PRODUCED, not by the kind.** That
> is why a design with a pull request is approved through
> `pull_request_approval` and still shows its mock: same gate, design port.
>
> > ### §1 — AMENDMENT (MOTIR-5658, 2026-09-17): the `design_result` row's _fires when_ is WRONG, and the rule is ONE GATE PER QUESTION
> >
> > **`design_result` fires on a design with a published result, WITH OR WITHOUT a
> > pull request** — `design-result.md` AMENDMENT 6 Q1. The table's _a design with
> > **no pull request**_ is superseded, and so is the reading of the paragraph
> > above that a design with a pull request is approved through
> > `pull_request_approval` INSTEAD. It is approved through **both**: the
> > `design_result` gate is the PRIMARY question and the merge rides on the same
> > press.
> >
> > **What the port paragraph gets right and keeps:** the PORT is chosen by what
> > the card PRODUCED. A design card shows its mock. What changes is that the
> > design card now also has its own gate to show it in.
> >
> > **⚠️ AND [MOTIR-5603](motir:cmu396zoh005ihwtxd5xpny37) DID NOT SETTLE "ONE GATE
> > PER CARD".** It settled **one MERGE gate per card** — it was two merge gates,
> > a per-pull-request `pull_request_merge` beside the per-card
> > `pull_request_approval`. **The rule is one gate per QUESTION.** Two gates of
> > DIFFERENT kinds on one card is the model, not the defect; misreading it as
> > one-gate-per-card is what produced the suppression MOTIR-5652 was filed
> > against.
>
> **THE SUBJECT IS A DOCUMENT WITH A RESOLVER.** ~~what is being decided — a
> `DesignEvidence` id, a pull-request delivery id~~ **What a gate points at is a
> document, and the handler supplies the RESOLVER that fetches it.** The gate row
> stores an opaque `subjectId` plus its kind; nothing in the schema knows which
> table — or whether there is a table at all.
>
> **Why that matters concretely: Motir's `pages` domain will later host decision
> documents**, and a decision doc that moves from an attachment to a page must be
> a RENDERER change and a resolver change — never a migration on the gate table.
> A subject column typed to a concrete row would have made the move a schema
> change on the audit table, which is the one table that should never be
> rewritten. Registering a kind therefore stays exactly what §1's table says:
> **a row in the enum, a handler (resolver + routing + authority + effect +
> retention), and a renderer.**
>
> **A kind may also carry a VERB SET rather than two verbs.** `decision_choice`
> — a `type: decision` card with `executor: human`, where the card states two or
> more options on named axes and a person PICKS one — is a gate by every property
> that matters here: it blocks work, it routes to one person, it needs a surface,
> and what they chose must be stamped with the same audit §6a describes. What
> differs is only the verb set, N options instead of Approve / Request changes,
> and the frame already accommodates it because the KIND is what decides the
> verbs. **This record ships none of these handlers** — see _Deliberately NOT
> decided here_.

> ### §1 — AMENDMENT (MOTIR-5787, 2026-09-19): `acceptance_result` — the gate hangs on the STORY whatever the run target, and on a story run it is the PRIMARY of two gates whose ONE press merges the story's code
>
> **Settled by the requester, 2026-09-19** (Story
> [MOTIR-4949](motir:cmttv7s6o0087i0txzqwrpdw2)): _"if the run is on the story,
> then it's the double gate like design result gate too. the difference is
> approval to merge the story code, not the PR for acceptance video, acceptance
> video will never be committed. if the run is not for the story, the acceptance
> video gate is not on the test subtask which produced the video, it's on the
> story work item."_ This amendment writes that down as the rule, and answers the
> HOW questions it leaves (points 4–7), each with the rung that settles it.
>
> **Why this is a kind and not a new mechanism.** §1 generalised its vocabulary
> FROM acceptance — the evidence table above cites `AcceptancePanel.tsx` and
> `acceptanceActions.ts` — and acceptance never joined the registry.
> `acceptanceEvidenceService.decide` still flips the story `in_review → done |
in_progress` through its own path, so an acceptance decision is invisible to
> every surface built for gates in general. Registering the kind is
> [MOTIR-4950](motir:cmttv7s970088i0txmuykzjcw)'s; this amendment is the rule it
> builds to.
>
> **The row, in the kind table's own shape** (point 8):
>
> | kind                | the port shows                                                                  | fires when                                                                                                            |
> | ------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
> | `acceptance_result` | the RECEIPT — player, chapters, provenance (the port `AcceptancePanel` renders) | a **story** holds a published receipt, on a project whose acceptance-video switch is ON — **whatever the run target** |
>
> Its **status intent** is the project's `done` category, as the design gate's is
> (`DESIGN_APPROVAL_TARGET`) — which is what lets §6d's rule 1 hold a story's move
> into `done` while its acceptance is awaiting. Its **effect** is point 7 below.
> Its **authority and routing** are §2's, unchanged. Its **retention** is not this record's:
> `acceptance-receipt-lifecycle.md` §2 freezes an approved receipt and §6c here
> already defers to it — nothing is pinned, because nothing is ever superseded.
> **⚠️ AMENDED (MOTIR-5872, 2026-09-21):** that record's AMENDMENT 1 replaces the
> freeze with a PIN. An approved receipt IS superseded when its story is reworked,
> and its bytes are kept. The refusal now keys on the story, as the design gate's
> does: the story is closed, or it still stands on the approval.
>
> **⚠️ THE ACCEPTANCE VIDEO IS NEVER COMMITTED, AND THE ONE PRESS MERGES THE
> STORY'S CODE — NEVER A PULL REQUEST FOR THE VIDEO.** The receipt is an
> uploaded artefact on the story (`publish_acceptance_result`), not a file in any
> repository; there is no pull request for it to ride on, and none is ever opened.
>
> #### 1 — the gate hangs on the STORY, always
>
> The `acceptance_result` row's work item is **the story that owns the receipt**,
> whatever the run target. The receipt row is already the story's:
> `publish_acceptance_result` resolves a leaf key UP to its parent story
> (`lib/mcp/tools/publishAcceptanceResult.ts` → `publishAuth.findOwningStoryParent`),
> and `acceptanceEvidenceService.resolveStory` refuses anything that is not a
> story. The gate follows the receipt. **It is never raised on the producing test
> subtask**, whose own approve-to-merge gate — when that subtask is its own run
> target — asks only about that subtask's commits.
>
> **Why the story and not the run target.** §8's second amendment hangs a MERGE
> gate on the run target (`lib/services/runTarget.ts`), because the merge question
> is about the commits a run delivered. The acceptance question is not about any
> commits: _is this what I wanted?_ is a question about the STORY, and the video
> shows the story working. Hanging it on the E2E subtask would have a person
> approve a story from a card that is not the story, tangled with that subtask's
> own merge.
>
> #### 2 — run on the STORY ⇒ TWO gates on the story, ONE press
>
> When the story is its own run target, its run's pull requests are the story's
> delivery set, and the story holds two questions with different lifetimes —
> exactly the shape `design-result.md` AMENDMENT 6 Q1 settled, and this record's
> [MOTIR-5658](motir:cmu5x38aa002shvtxdrj3hwy8) amendment above names the rule it
> follows: **ONE GATE PER QUESTION**, not one gate per card.
>
> | gate                              | the question             | lifetime        |
> | --------------------------------- | ------------------------ | --------------- |
> | `acceptance_result` — **PRIMARY** | _is this what I wanted?_ | **durable**     |
> | `pull_request_approval`           | _do these commits land?_ | **per attempt** |
>
> **The acceptance gate is PRESENTED as the question**, with the story's pull
> requests and How to test beneath it as what the approval will merge. **One
> Approve decides the acceptance AND merges (or enqueues) every member of the
> story's delivery set**, through the existing merge-or-enqueue path
> (`pullRequestMergeService.approveAndMerge`). Putting `acceptance_result` into
> the gate-set predicate (`lib/approvalGates/gateSet.ts`, whose
> `AwaitableGateKind` today is `'design_result' | 'pull_request_approval'`) and
> wiring the one press are [MOTIR-5789](motir:cmu8msz0i0058hvoig072s3ml)'s; the
> frame that says which question is being asked is
> [MOTIR-5790](motir:cmu8msz1x005ahvoi3kq80xij)'s, drawn by
> [MOTIR-5788](motir:cmu8msyyw0056hvoifd30otz6).
>
> **⚠️ A STORY CANNOT HOLD BOTH A DESIGN PRIMARY AND AN ACCEPTANCE PRIMARY**,
> because a design result belongs to the design LEAF that produced it
> (`design-result.md` §3 — a container target is refused, `NotALeafError`). So the
> predicate never has to rank the two: on a story only `acceptance_result` can
> lead.
>
> #### 3 — run NOT on the story ⇒ the story's acceptance gate stands ALONE
>
> A single-card run of the E2E subtask delivers the subtask's pull request, not
> the story's; the story has no delivery set of its own. So the story holds the
> `acceptance_result` gate alone, and the subtask holds its own
> `pull_request_approval` alone. **The two presses are independent**: approving
> the subtask's merge says nothing about the story's acceptance, and approving the
> acceptance merges nothing.
>
> #### 4 — approving BEFORE green holds the merge, not the press (rung: `design-result.md` AMENDMENT 6 Q4)
>
> Q4 applies unchanged. The acceptance gate rises on PUBLISH and the merge gate
> on GREEN, so the primary can be pressed first. **The decision stands, and the
> merge follows on the next green verdict with no second press** — the same
> one-time carry `settleGreenVerdict` (`lib/services/mergeGates.ts`) already reads
> for a design through `designApprovalStandsForMerge`, including its MOTIR-5666
> clause that the carry holds only while the card has never had a merge gate.
> Teaching that reader to accept a standing ACCEPTANCE approval is
> [MOTIR-5789](motir:cmu8msz0i0058hvoig072s3ml)'s.
>
> #### 5 — what re-asks WHICH question (rung: AMENDMENT 6 Q2, and §6b's supersede)
>
> - **A merge that fails after approval re-opens the merge question ALONE.** The
>   acceptance decision stands. The routes back are AMENDMENT 6 Q2's own: _Queue
>   again_ while the head is unchanged, and a PUSH, whose next green raises a fresh
>   merge gate. Neither touches the acceptance gate.
> - **A PUSH does not by itself re-ask acceptance.** It supersedes the merge gate
>   with `head_moved`, as it does today. The receipt is not a function of the
>   head: a push that changes the story's behaviour is expected to produce a new
>   recording, and it is the RECORDING that re-asks.
> - **A newly PUBLISHED receipt re-asks acceptance.** It supersedes an `awaiting`
>   `acceptance_result` gate with the cause **`republished`** — the value
>   AMENDMENT 6 Q5 already carries for "a newer version superseded the one the gate
>   asked about". No new cause is minted.
>
> #### 6 — a DECIDED acceptance CLOSES the receipt — and that rule already SHIPS, stronger than Q3 (rung: `acceptance-receipt-lifecycle.md` §2 and §6, read at `acceptanceEvidenceService.persistEvidence`)
>
> The card asked for the AMENDMENT 6 Q3 analogue: an approved gate refuses a
> republish while a story pull request is open at or above `implemented`, so an
> agent returning to a failed merge cannot swap the video under an approval.
> **Measured: acceptance already has it, unconditionally.** `persistEvidence`
> locks the story's current receipt row and throws
> `AcceptanceEvidenceAlreadyApprovedError` when its status is `approved`
> (MOTIR-2764), and `acceptance-receipt-lifecycle.md` §6 holds that even a
> re-opened story does not unfreeze it.
>
> **So this record keys the refusal on the RECEIPT's `approved` status, as today,
> and deliberately NOT on Q3's three conditions.** Q3 needs its open-delivery and
> `implemented`-rung conditions because a design is legitimately re-published
> after an approval when the work is pulled back and reworked; a receipt is a
> signature on one recording and is never re-published after it is signed —
> lifecycle §2 rejected every weaker trigger on the record. Narrowing the freeze
> to Q3's window would re-open the evidence loss MOTIR-2764 closed. **The one
> obligation this puts on the build:** the gate's approve effect must still stamp
> the receipt row `approved` in the same transaction as the decision, or the
> freeze stops firing. That is [MOTIR-4950](motir:cmttv7s970088i0txmuykzjcw)'s
> handler (its criterion 4), and it is the reason `stampStatus`'s lock-derived
> stamp (MOTIR-2851) moves into the handler rather than being dropped with
> `decide`. The refusal's copy stays `AcceptanceEvidenceAlreadyApprovedError`'s;
> no new refusal is minted, so [MOTIR-5789](motir:cmu8msz0i0058hvoig072s3ml) owes
> a test that the freeze holds under the gate, not a second refusal.
>
> #### 7 — which STATUS approval writes, per run shape (rung: §3's MOTIR-4911 amendment, and the code read below)
>
> §3's rule is _approval writes `done` only when nothing will ever merge_, and it
> exists to keep ONE writer of `done`. For acceptance the rule has to be read over
> the story's **subtree**, because a story's `done` does something a leaf's does
> not: **`childStatusCascadeService` closes every not-done direct child** — from
> any status, `blocked` included, by a `{ system: true }` write — and each child's
> own transition re-emits and carries the cascade down.
>
> **Measured — why the design handler's discriminator CANNOT be copied.**
> `designResultGateHandler.approve` (`lib/approvalGates/designResultHandler.ts`)
> asks `workItemDeliveryRepository.countOpenByWorkItem(gate.workItemId)`, which
> counts deliveries whose `workItemId` is **the gated card itself**. On a
> single-card run the story delivers nothing — the open pull request belongs to
> the E2E subtask — so that count reads **0**, the arm writes `done` on the story,
> and the cascade then closes the E2E subtask whose pull request is still open,
> plus every sibling not yet built. Approving acceptance would complete unmerged
> and unbuilt work. **That is the defect this point exists to prevent.**
>
> | the story …                                                                                                                                        | approve does                                                                                                                                                                                                                                                                                                                                                                     |
> | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | **has an open delivery of its own** — a story run                                                                                                  | record the decision, stamp the receipt `approved` (point 6), write **no status** from the acceptance gate. The same press decides the companion `pull_request_approval`, whose handler writes **`approved`** (`PULL_REQUEST_APPROVAL_TARGET`, `pullRequestApprovalHandler.ts`), and **the merge writes `done`**. The cascade then closes children that merge delivered — correct |
> | **delivers nothing itself, and ANY descendant is not in the `done` category** — a single-card run with work still open, or children still to build | record the decision, stamp the receipt, write **no status**. The story reaches `done` through `parentStatusRollupService`'s forward arm when its LAST child completes — by then the acceptance gate is decided, so §6d's rule 1 no longer holds that move                                                                                                                        |
> | **delivers nothing itself, and EVERY descendant is in the `done` category**                                                                        | record the decision, stamp the receipt, and write **`done`** — approval is TERMINAL. The rollup already tried this move when the last child finished and was refused `approval_pending` (§6d rule 1: the awaiting gate held the status its intent names), and it does not re-fire, so nothing else would write it                                                                |
>
> **The discriminator is therefore "is anything left under this story that a
> `done` would close?"** — the subtree's done-category check — **plus** the
> story's own open deliveries, never the card's own open-delivery count alone.
> `done` keeps exactly one writer in every row: the merge, the rollup, or the
> approval, and never two. `request_changes` moves nothing, as for every kind
> (§3); the old path's `in_review → in_progress` write retires with
> `acceptanceEvidenceService.decide`. Building the effect is
> [MOTIR-4950](motir:cmttv7s970088i0txmuykzjcw)'s (its criterion 4 names this
> point), and the placement matrix that proves it on both run shapes is
> [MOTIR-5791](motir:cmu8msz3a005chvoioew71yhw)'s.
>
> **What this amendment does NOT change.** The gate mechanism, routing, authority
> and state set ([MOTIR-4778](motir:cmtqhxi7r000vhvphp60vjymc)'s);
> `pull_request_approval`'s own raise conditions (§8's MOTIR-5479 amendment); the
> switch and its tier ([MOTIR-4925](motir:cmttap29j006dhxoipknbjh7v)); what a run
> records, how the video is paced, and the storage caps (`acceptance-video.md`).

### 2. Routing and authority — DECIDED BY THE REQUESTER (Yue, 2026-09-08)

**ROUTING: `assigneeId ?? reporterId`.** Assignee first; the reporter receives
the gate **only when there is no assignee**. Exactly one person is shown a gate.

**⚠️ This is a deliberate DIVERGENCE from `homeService`'s membership predicate,
and the reason is recorded here so the next reader does not "fix" it back.** The
three Workbench work tabs use assignee **OR** reporter, deduped, and MOTIR-2649
argues for that union because an item filed through the MCP carries its creator
as reporter and that same person runs it — two hats, one person. **That
reasoning is about a WORK LIST and does not transfer to a DECISION QUEUE.** A
work list may be generous: showing you your own item twice costs a glance. A
gate shown to two people is a decision neither owns — each waits for the other,
and _who_ is the entire question a gate asks. The fallback yields one recipient
in every case, including the MCP case the union was built for: no assignee ⇒ the
reporter, who is the same person anyway.

**Options A–D as originally framed (assignee-only; assignee-or-reporter;
browse-scoped; assignee-or-reporter with a permission) were all rejected.** The
answer is none of them: it is the fallback above, with the authority axis split
off entirely.

**AUTHORITY: two permission keys, because the two kinds differ in severity.**

| gate kind            | key                                      | rationale                                                                                       |
| -------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `design_result`      | the existing **`work_item:edit`**        | flips a subtask `done` inside Motir — reversible, in-product, exactly what edit already governs |
| `pull_request_merge` | a NEW **`work_item:merge_pull_request`** | writes a commit to the default branch on an external host — **irreversible, and outside Motir** |

The merge key **also joins `IRREVERSIBLE_PERMISSIONS`** (`lib/tokens/grant.ts`,
today `['work_item:delete']`), which `apiTokensService` filters out of what an
API token may confer — otherwise a minted PAT could merge to `main`. Both keys
enter the catalog as `enforcement: 'planned'` and are excluded from
`getRoleCatalog` until their call sites are wired.

**Why two rather than one, when the shipped acceptance gate asserts none.**
Inheriting `work_item:edit` for both would mean every `member` can merge to
`main`, with no way for a custom role to withhold it. Motir has unpicked exactly
this shape twice — `ai:view_plan` / `ai:decide_plan` (MOTIR-3188) and
`work_item:archive` / `work_item:delete` (MOTIR-3629) — and both times the fix
was a migration over a persisted `role_definition.permissions` value. Splitting
at the point the vocabulary is introduced costs one row in a frozen array.

**ROUTING and AUTHORITY are separate axes.** A gate appears in one person's tab;
a permission-holder who is neither assignee nor reporter may still decide it
from the item page, without it cluttering their queue. A reader who may see a
gate but not decide it sees its state and no control.

> ### §2 — AMENDMENT (MOTIR-4911, 2026-09-08): AUTHORITY is a RELATIONSHIP or ADMIN, not two permission keys
>
> **ROUTING IS UNCHANGED, and the paragraphs above stand in full.**
> `assigneeId ?? reporterId`, exactly one recipient, and the recorded divergence
> from `homeService`'s union is still the right divergence for the reason it
> gives. Only the AUTHORITY half is amended.
>
> **What was WRONG.** The table above settles authority on **two permission
> keys** — `work_item:edit` for the design gate, a new
> `work_item:merge_pull_request` for the merge gate — and derives who may press
> from a ROLE. Yue settled it the other way on 2026-09-08:
>
> ~~| gate kind | key | rationale |~~
> ~~| `design_result` | the existing **`work_item:edit`** | … |~~
> ~~| `pull_request_merge` | a NEW **`work_item:merge_pull_request`** | … |~~
>
> **THE RULE IS: assignee OR reporter OR admin — for BOTH verbs, and an admin
> may approve and merge ANY work item.** Authority follows a RELATIONSHIP to the
> work item, with an org-wide override for admins; it does not follow a
> permission a role happens to carry. Three people may press a gate that is shown
> to one.
>
> | axis                                          | rule                                                                        |
> | --------------------------------------------- | --------------------------------------------------------------------------- |
> | **ROUTING** — whose Approvals tab it lands in | `assigneeId ?? reporterId` — exactly ONE recipient. **Unchanged**           |
> | **AUTHORITY** — who may press                 | **assignee OR reporter OR admin**, both verbs; an admin may act on ANY item |
>
> **A gate appears in ONE queue and can be pressed by THREE people, and that is
> coherent rather than sloppy** — because the two axes answer different
> questions. ROUTING answers _whose job is it to look?_, and a gate shown to two
> people is a decision neither owns, which is the whole argument the routing half
> already makes. AUTHORITY answers _may this press be honoured?_, and the failure
> it must prevent is the OPPOSITE one: a gate whose single recipient is on leave,
> has left the company, or was never the right person, with nobody able to
> unblock the work. **Widening authority costs the queue nothing** — a
> reporter or an admin who presses from the item page never sees the gate in
> their own tab — so the two can be tuned independently, and are.
>
> **The design gate keeps `work_item:edit` as its floor**; the relationship test
> is applied on top of it, not instead of it. What is retired is the ROLE-derived
> answer to who may merge.
>
> **`work_item:merge_pull_request` SURVIVES, and its only remaining job is to sit
> in `IRREVERSIBLE_PERMISSIONS`** (`lib/tokens/grant.ts`, today
> `['work_item:delete']`), which `apiTokensService` filters out of what an API
> token may confer. **So no API token can ever confer merge**, whatever grant it
> is minted with. The key is no longer how a PERSON is authorised — that is the
> relationship rule above — it is how a TOKEN is refused. It enters the catalog
> as `enforcement: 'planned'` and is excluded from `getRoleCatalog` exactly as
> §2 originally said.
>
> **What this costs, stated because §2's original argument was good.** The
> rejected split bought a custom role that could withhold merge from a `member`.
> The relationship rule cannot express that: every assignee and every reporter
> may merge their own item. **That is the accepted trade** — the merge is gated
> by a person pressing a button on an item that is already theirs, and a team
> that wants a narrower rule sets `prMergeMode` per project (§7) rather than
> per role.

> ### §2 — SECOND AMENDMENT (MOTIR-5192, 2026-09-11): the REPORTER may press only when there is NO ASSIGNEE
>
> **This REVERSES the reporter half of the amendment directly above.** That
> amendment is dated, reasoned and was right about the question it was answering;
> it stays in full, above, so a reader can see that authority was considered the
> other way round and why. What follows is the rule in force.
>
> **ROUTING IS STILL UNCHANGED.** `assigneeId ?? reporterId`, exactly one
> recipient, for the reason §2's original paragraphs give. Every amendment to
> this section so far has left routing alone, and this one does too.
>
> **THE RULE IS: the ASSIGNEE, or the REPORTER WHEN THE ITEM HAS NO ASSIGNEE, or
> an ADMIN.** The reporter arm becomes conditional on `assigneeId === null`.
>
> | axis                                          | rule                                                                                                    |
> | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
> | **ROUTING** — whose Approvals tab it lands in | `assigneeId ?? reporterId` — exactly ONE recipient. **Unchanged, again**                                |
> | **AUTHORITY** — who may press                 | **assignee, or reporter when there is no assignee, or admin**, both verbs; an admin may act on ANY item |
>
> **AUTHORITY NOW COLLAPSES ONTO THE ROUTING RULE for the relationship arms.**
> `assigneeId ?? reporterId` and _"the assignee, or the reporter when there is no
> assignee"_ are the same person, term for term. A gate is pressed by the person
> it is shown to, or by an admin. The two axes have not stopped being different
> questions — they part company at the admin override, and only there.
>
> **WHY, and it is a different failure from the one the first amendment
> optimised for.** An approval is a statement that somebody looked, and it means
> less when it is ambiguous who. With an assignee on the item and two people able
> to press, the decision belongs to neither in particular: either can sign off
> work the other was accountable for, and each can reasonably assume the other
> is the one being asked. Ownership is the whole question a gate exists to ask,
> and the routing rule already answers it — the amendment above then let two
> people answer it.
>
> **WHY THE ADMIN ARM IS A SUFFICIENT ESCAPE HATCH, stated rather than assumed —
> because the worry it is answering is a real one.** The 2026-09-08 amendment's
> stated reason was _"a gate whose single recipient is on leave, has left the
> company, or was never the right person, with nobody able to unblock the work."_
> That stall is still possible and still must be answerable. **It is now answered
> by an admin instead of by the reporter, and that is a better shape for an
> override, not merely an equivalent one:**
>
> - **It is VISIBLE.** Workspace owner/admin is a role in the permission grid. A
>   team can see who can unblock a stuck gate without reading a work item's
>   reporter column.
> - **It is GRANTABLE.** ⚠️ _False as written, and corrected on the record by the
>   THIRD amendment below (MOTIR-5292): a workspace role is not grantable in the
>   sense the permission model means._ A team that needs more unblockers grants the role; a
>   team that needs fewer does not. The reporter arm was un-tunable — it came
>   attached to whoever happened to file the item, which for an MCP-filed card is
>   an automation's account.
> - **It is AUDITABLE.** `decided_under_authority` records `admin`, and a reader
>   of that row can ask what that role was and who held it. `reporter` on an
>   assigned item recorded a relationship that answered no question anybody was
>   asking.
> - **It costs the queue nothing**, exactly as the first amendment's own argument
>   had it: an admin pressing from the item page never sees the gate in their own
>   tab.
>
> **WHAT THIS COSTS.** An unblock now needs an admin rather than anyone with a
> relationship to the item, so a small team with one admin has one unblocker. That
> is the accepted trade: the stall is rare, an admin is reachable, and the thing
> being bought — an approval that belongs to exactly one person — is paid for on
> every gate rather than on the rare one.
>
> **WHAT WOULD REVERSE THIS AGAIN.** Evidence that gates actually stall: a
> measurable population of `awaiting` gates whose routed recipient is inactive
> and whose project has no reachable admin. The instrument is the gate table's own
> `created_at` against `routed_to_id` — if such gates accumulate, the answer is to
> widen the ESCAPE HATCH (a project-scoped approver role, say), and **not** to
> re-widen the relationship arms, which is what makes ownership ambiguous. A
> narrower `prMergeMode` per project (§7) remains the per-team dial either way.
>
> **`decided_under_authority` IS UNCHANGED, and historical rows are NOT
> migrated.** The `reporter` member stays legal in the vocabulary — it simply
> becomes reachable only on an unassigned item. Rows that say `reporter` on an
> assigned item record what was true when the press happened, which is the entire
> reason §6a freezes the arm rather than re-deriving it; a migration over them
> would destroy the one thing the column exists to preserve.
>
> **THE FLOOR IS UNCHANGED.** The kind's permission key is still asserted first
> and independently, and the relationship test is applied on top of it. A project
> `viewer` who is the assignee is still refused, at the floor.

> ### §2 — THIRD AMENDMENT (MOTIR-5292, 2026-09-13): the escape hatch is a PERMISSION, `approval:decide_any` — not the workspace role
>
> **ROUTING IS UNCHANGED, and so are both relationship arms and their order.**
> This amendment touches only the third arm — WHO ELSE may press — and it
> corrects the second amendment's argument for that arm rather than reversing
> its rule.
>
> **What was WRONG.** The second amendment defended the admin arm as _GRANTABLE_:
> _"a team that needs more unblockers grants the role."_ The arm it shipped asked
> `isWorkspaceManager(workspaceRole)` — owner or admin of the WORKSPACE — and that
> is not grantable in the sense Motir's permission model means. A role in Motir
> only CARRIES permissions; no custom role could carry this, because there was no
> key. A team wanting its QA lead to unblock a stuck gate had one lever — making
> them a workspace admin, which hands over every project and every setting — and
> a user who is **Admin on the project itself** but a plain member of the
> workspace was refused. The check was also invisible to the role editor and to
> `tests/permissions/storyGate.test.ts`, because it was laundered through
> `projectAccessService.isWorkspaceManagerFor`, inside the one file that guard
> trusts to derive policy.
>
> **THE RULE IS: the ASSIGNEE, or the REPORTER WHEN THE ITEM HAS NO ASSIGNEE, or
> anyone holding `approval:decide_any` on the project.** It is the shape Motir
> already uses for acting on what is not yours — your OWN row by relationship,
> ANYONE's by an `_any` key (`attachment:delete_any`, `comment:moderate`) — and
> the reversal clause above had already named it: _"widen the ESCAPE HATCH (a
> project-scoped approver role, say)."_
>
> | who                                                | before                      | after                                                          |
> | -------------------------------------------------- | --------------------------- | -------------------------------------------------------------- |
> | workspace owner / admin                            | may decide any gate         | **unchanged** — the always-pass rail holds the key             |
> | project **Admin** (workspace `member`)             | refused                     | **may decide any gate** — the built-in Admin set holds the key |
> | a CUSTOM role granted the key                      | impossible — no key existed | **may decide any gate**                                        |
> | project Member / Viewer, implicit workspace member | refused                     | refused — none of those sets holds the key                     |
>
> **The widening to project Admins is the point, not a side effect**: they are
> the people a project already names as able to run it.
>
> **The key.** `approval:decide_any`, domain `approval` (the Approvals room's
> `approval:view_any`, MOTIR-5305, joins it), `enforcement: 'enforced'` in the
> same change that consults it, in `ROLE_GATED_PERMISSIONS` and so in the built-in
> Admin set, and in neither `member`, `viewer` nor
> `IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS`. `levelGrants` gives it the default arm,
> so on a `private` project it still requires a project membership. It is
> **UNGRANTABLE to an API token by derivation** (`lib/tokens/grant.ts`): the
> decide route is session-authed and no MCP tool or `/api/v1` operation asserts
> the key, and §6a's rule that a decision names a PERSON is exactly why none
> should.
>
> **`decided_under_authority` — the vocabulary is KEPT, and its meaning is
> restated.** The `admin` member now means **decided under
> `approval:decide_any`**. No member is added. Every row that already says
> `admin` was written by a workspace owner/admin, who holds the key, so no
> historical row becomes false and nothing is migrated — the same treatment
> `reporter` got in the second amendment. A second member would have given one
> authority two names, split by the date of this amendment, and every reader of
> the column would have had to know that date.
>
> **Asked, never derived.** `approvalGatesService.resolveGateAuthority` asks
> `projectAccessService.getPermissions` for the key. `isWorkspaceManagerFor` is
> deleted, and `tests/permissions/storyGate.test.ts` now refuses the access
> service handing a bare role predicate back to a caller — the laundering path
> this defect used.
>
> **What would reverse this.** Nothing in the second amendment's reversal
> evidence changes: a population of stalled gates is answered by granting the key
> more widely, which is now possible, and never by re-widening the relationship
> arms.

### 3. What approving a DESIGN result does — DECIDED BY THE PLANNER (rung 3: the story's own stated intent)

**Approve** records the decision, performs §6c's pin, and transitions the design
subtask into the project's `done` category — which is what unblocks the cards
`blocked_by` it. It goes through `workItemsService.applyStatusTransition`, the
one shipped status funnel, rather than writing `work_item.status` directly, so
it inherits the `completedAt` stamp and every existing guard.

**Request changes** records the decision and moves nothing. **It re-dispatches
nothing** — the revise loop is Story 9.2's (§5).

> ### §3 — AMENDMENT (MOTIR-4911, 2026-09-08): approval writes `done` ONLY when nothing will ever merge
>
> **What was WRONG, and it is the clause that produced the confusion this whole
> amendment exists to end.** The paragraph above says approve _"transitions the
> design subtask into the project's `done` category"_ — unconditionally:
>
> ~~**Approve** records the decision, performs §6c's pin, and transitions the
> design subtask into the project's `done` category — which is what unblocks the
> cards `blocked_by` it.~~
>
> **The shipped status sync says the MERGE writes `done`.** Both cannot be the
> single writer, and §4 four paragraphs below states the invariant in its own
> words — _"there is **one status writer, not two**"_. So the record contradicted
> itself, and _"approved but still `in_review`"_ is what that collision looks
> like from the board.
>
> **THE CORRECTION — approval is a TRIGGER, not a status write, and the
> discriminator decides what it triggers:**
>
> | the work item has …             | approve does                                                                              |
> | ------------------------------- | ----------------------------------------------------------------------------------------- |
> | **no linked OPEN pull request** | record the decision, perform §6c's pin, and write **`done`** — approval is TERMINAL       |
> | **a linked OPEN pull request**  | record the decision, perform §6c's pin, and write **`approved`**; the MERGE writes `done` |
>
> **Nothing else changes.** It still goes through
> `workItemsService.applyStatusTransition`, the one shipped status funnel, rather
> than writing `work_item.status` directly, so it inherits the `completedAt`
> stamp and every existing guard — and **Request changes** still records the
> decision and moves nothing.
>
> **The invariant is PRESERVED, not weakened: there is still exactly one writer
> of `done`.** In the first row nothing will ever merge, so nothing else would
> write it. In the second the merge writes it, and approval stops one status
> short. §8 is the discriminator and both workflows in full; §6b is the
> `approved` status it writes.

### 4. What approving a MERGE does — DECIDED BY THE PLANNER (rung 2: the shipped provider seam)

**Approve merges the pull request on the host**, through the `GitProvider` seam.

- **The seam gains `mergeChangeRequest`**, returning a normalised success or a
  typed refusal. **It is not a direct GitHub call.** GitLab is a shipped,
  registered second provider (Story 7.23 / MOTIR-1474) whose merge requests
  already drive the same status machine; a GitHub-only merge would give every
  GitLab-backed card a gate that renders, routes to a person and can never be
  satisfied. GitLab's own implementation is Epic MOTIR-4608's (MOTIR-4883).
- **The App is chosen by repository PROVENANCE** — a Motir-HOSTED repository
  mints through `motir-studio`, which already holds `contents: write`; an
  IMPORTED repository mints through `motir-integration`, which needs MOTIR-4787's
  bump. The choice is read from the repository row, never defaulted.
- **The gate does NOT write the card's status.** The card advances on the
  resulting webhook, exactly as when a person merges by hand, so there is **one
  status writer, not two**.
- **Every refusal renders in the control rather than being thrown** — checks not
  green, merge conflict, protected branch, no linked pull request, the App
  lacking permission, and a gate somebody else decided while the row was on
  screen.

**Merging for real is the point, and it costs a permission and a re-consent.**
An approval that does not merge is a note, not a gate.

> ### §4 — AMENDMENT (MOTIR-4911, 2026-09-08): the gate writes `approved`, and still does not write `done`
>
> **Everything above stands except one bullet, and it is falsified in a narrow
> way that matters.** The seam, the provider argument, the App-by-provenance
> rule and the render-every-refusal rule are all unchanged.
>
> ~~**The gate does NOT write the card's status.** The card advances on the
> resulting webhook, exactly as when a person merges by hand, so there is **one
> status writer, not two**.~~
>
> **The gate DOES write a status — `approved` — and it does NOT write `done`.**
> The sentence conflated the two, and correcting it is what makes §3's amendment
> and §8's Workflow B expressible at all: a person pressing Approve is an EVENT
> the board has to be able to show, and before `approved` existed there was no
> status for it to land in.
>
> **The invariant the struck sentence was protecting is intact and is now stated
> exactly:** `done` has **one writer**, the merge webhook. `approved` has one
> writer too, the decision. Two statuses, two writers, no contention — which is
> strictly stronger than the original claim, because it also says who writes the
> intermediate state instead of leaving it unwritten.
>
> ~~**Approving in GITHUB decides only the FIRST gate.** A GitHub review approval
> syncs `pull_request_approval` and leaves `pull_request_merge` `awaiting`; the
> card reaches `approved` either way, and somebody still presses merge. §8's
> Workflow B row 4b is why there are two gates rather than one.~~
>
> **⚠️ STRUCK by §8's SECOND AMENDMENT (MOTIR-5609, 2026-09-16).** There is no
> second gate for a GitHub approval to leave behind. What a synced approval does
> under one gate is MOTIR-4910's, recorded by MOTIR-5590.

> ### §4 — SECOND AMENDMENT (MOTIR-5510, 2026-09-14): the MERGE gate's contract — one per pull request, raised on green, merged or enqueued OUTSIDE the decision, and its outcome recorded on the PULL REQUEST
>
> **What was OPEN.** §4 decides the seam, the App-by-provenance rule and that
> every refusal renders; §8 row 3 says the gates are raised on green and row 5
> says _merge — or ENQUEUE_. Nothing here said what one merge gate is ABOUT on a
> card with several pull requests, when it goes away, how an Approve that must
> call a host is recorded by a door that runs in one transaction, or what an
> automatic merge leaves behind. Story MOTIR-4882's children build against those
> answers, so they are written down once, here. **Everything above in §4 stands**;
> this block adds to it and supersedes one earlier card's wording (decision 2).
>
> **Read at base `cc09db183`.** Written to merge in EITHER order with
> MOTIR-5479's amendment for the approve-and-merge gate: this block touches no
> line that one edits (§8 row 4a), and its decisions 4 and 5 are the merge gate's
> side of 5479's decision 5 — merge, or enqueue where the repository has a queue;
> each merge gate decided only on success, with `outcomeRef: null`; the merge
> commit or queue entry on the pull request; a refused one stays `awaiting`.
>
> **1. SUBJECT — one gate per pull request** (rung 2: the shipped uniqueness
> key). `subjectId` is the `github_pull_request` row id and `subjectVersion` is
> `owner/name#number@headSha`. The gate hangs on the **run target** — the work
> item the delivering run was launched against, as
> `howToTestService.getForWorkItem` resolves it (`runTarget`). The partial unique
> index `approval_gate_one_awaiting_per_subject` over
> `(work_item_id, kind, subject_id) WHERE state = 'awaiting'`
> (`prisma/migrations/20260908210000_add_approval_gate/migration.sql:91-93`)
> already allows exactly this, and §6b states why: a card carrying several open
> pull requests legitimately has several simultaneous awaiting merge gates. This
> narrows §1's amendment row _"**any** card **with a pull request**"_ to the run
> target; a child the same pull requests also deliver gets no merge gate of its own.
>
> **2. RAISED on the all-green verdict, and only there** (rung 2: §8 row 3, and
> §7's amendment point 4). The raise takes §8 row 3's verdict and moment — the
> run target's delivery set turning green, as `lib/services/ciPromotion.ts`
> judges it (`everyDeliveryIsGreen`) — and fires only when the project's
> `prMergeMode` is `manual` and only for a provider that can merge (decision 11).
> **A merge gate is never raised on a pull request whose checks are not green, in
> either mode**: only a green pull request is a merge candidate (§7 amendment
> point 4). **This supersedes, by quotation, the wording MOTIR-4793 carried before
> plan `cmu1iamkg009rhutxld323mnw` re-scoped it** — that its gate is _"created
> when a pull request is LINKED"_. A link is not a verdict; a gate raised on it
> would ask a person to merge code CI has not judged.
>
> **3. WITHDRAWN** (rung 2: §6b's `superseded`, written by the product). An
> awaiting merge gate is set `superseded` when its pull request's head moves, when
> the pull request closes, or when its delivery row leaves the run target. It
> writes `state` and nothing else, exactly as the design publish path does (§6b
> SHIPPED). The next all-green verdict raises a fresh gate against the new head.
>
> **4. APPROVE IS EXECUTED OUTSIDE THE DECIDE TRANSACTION, and its OUTCOME is
> recorded on the PULL REQUEST, not on the gate** (rung 2: the shipped decide
> door). `approvalGatesService.decide` is one transaction with no post-commit
> hook — its own doc comment says _"a failing effect still discards the
> decision"_ — so it cannot call a host and survive the call failing. The merge
> entry point therefore runs:
>
> - **(a) check** — read the gate; it is `awaiting`, the actor holds §2's
>   authority, and the pull request still matches `subjectVersion`, is open, and
>   is still delivered. A mismatch SUPERSEDES that gate (decision 3) and returns
>   the shipped `APPROVAL_GATE_SUPERSEDED`;
> - **(b) call the seam** — merge or enqueue, outside any transaction;
> - **(c) on `merged` or `enqueued`** — call `decide` normally. The handler writes
>   no status, so the gate's **`outcomeRef` is `null`**; then record
>   `merge_authority = 'gate'` and `merge_outcome_ref` (the merge commit SHA, or
>   `queue:<entryId>`) on the pull request;
> - **(d) on a refusal** — write NOTHING. The gate stays `awaiting` and decidable.
>
> **Why not `outcomeRef`.** `outcome_ref` is written as `effect.statusWritten`
> (`lib/services/approvalGatesService.ts:909`), and the item page applies it as a
> status KEY — `OptimisticStatusProvider.tsx`, and
> `DesignResultSection.tsx:168`'s `applyOptimisticStatus(result.gate.outcomeRef)`.
> A merge SHA there would be painted onto the card as a status.
>
> **The race.** Two people press at once and one merges. The other's seam call
> returns `MERGE_ALREADY_MERGED`, or its `decide` loses to the partial index or to
> `APPROVAL_GATE_ALREADY_DECIDED`. Neither is a 500.
>
> **The stamp.** When MOTIR-5234's stamp is required on `decide`, the entry point
> carries it through from its caller, and its `APPROVAL_GATE_STALE_SUBJECT` is
> checked after (a)'s supersede check, never instead of it.
>
> **5. THE MERGE METHOD is the repository's, never hard-coded** (rung 2: the host
> setting). It is read from the repository's own settings, first allowed wins:
> `allow_squash_merge` → `allow_merge_commit` → `allow_rebase_merge`.
>
> **6. THE QUEUE** (rung 2: GitHub's documented API; the permission is a
> HYPOTHESIS). A base branch whose active rules include `merge_queue` is detected
> with `GET /repos/{owner}/{repo}/rules/branches/{branch}`, which GitHub lists
> under _Repository permissions for Metadata_ (read) on its _Permissions required
> for GitHub Apps_ page — so no App needs anything new to ASK. Such a pull request
> is enqueued with the GraphQL mutation `enqueuePullRequest`, passing
> `expectedHeadOid` so a moved head cannot be enqueued. A `405` from the merge
> call reading _"must be merged through the merge queue"_ also routes to enqueue.
> An enqueued pull request leaves the card where it is: `done` still arrives only
> through the merge webhook, when the queue lands it. **The enqueue is expected to
> need `pull_requests: write` — recorded as a hypothesis, not a reading**, to be
> confirmed by the first real enqueue. `motir-studio` holds no `pull_requests`
> permission, so a HOSTED repository could not be enqueued today; MOTIR-4161
> carries that consequence.
>
> **7. THE APP** (rung 2: the shipped provenance helper). The role is
> `'provisioning'` (`motir-studio`) when
> `isMotirHostedOwner(repo.owner, provisioningOrgLogin())`
> (`lib/git/hostOwnership.ts:43`, `lib/ciMetering/config.ts:33`) holds, and
> `'user-facing'` (`motir-integration`) otherwise — including when the host owner
> is `null`. The two grants, as read in
> `docs/decisions/unlinked-pull-request-check.md:30-31` after its 2026-09-14
> amendment:
>
> | App                 | what matters here                                                                                       |
> | ------------------- | ------------------------------------------------------------------------------------------------------- |
> | `motir-integration` | `contents: write` (MOTIR-4787) · `pull_requests: write` · `metadata: read` — merges an imported repo    |
> | `motir-studio`      | `contents: write` · `metadata: read` · **no `pull_requests`** — merges a hosted repo, cannot enqueue it |
>
> The merge itself needs `contents: write`: GitHub lists
> `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` under _Repository
> permissions for Contents_ (write).
>
> **8. THE REFUSAL UNION — FIVE new members** (rung 2: `lib/approvalGates/refusals.ts`,
> which mirrors the server's tag and forbids a second vocabulary):
>
> | member                         | the host's answer                                                                          |
> | ------------------------------ | ------------------------------------------------------------------------------------------ |
> | `MERGE_CHECKS_NOT_GREEN`       | `405` — not mergeable while required checks are pending or failing                         |
> | `MERGE_CONFLICT`               | `mergeable_state: dirty`                                                                   |
> | `MERGE_BRANCH_PROTECTED`       | `405` — a required review or rule is not satisfied                                         |
> | `MERGE_ALREADY_MERGED`         | the pull request is already merged                                                         |
> | `MERGE_APP_PERMISSION_MISSING` | `403`, or GraphQL `FORBIDDEN` — naming the permission from `X-Accepted-GitHub-Permissions` |
>
> **A changed subject is NOT a sixth member.** A moved head (`409`, which GitHub
> documents as _"sha was provided and pull request head did not match"_), a closed
> pull request or a lost link SUPERSEDES the gate and returns
> `APPROVAL_GATE_SUPERSEDED`; a gate somebody else decided is
> `APPROVAL_GATE_ALREADY_DECIDED`; MOTIR-5234's `APPROVAL_GATE_STALE_SUBJECT` is
> its own. A second name for any of these is exactly the second vocabulary
> `refusals.ts`'s header forbids. (§4's original list above — _"no linked pull
> request"_ and _"a gate somebody else decided"_ — maps onto those two shipped
> members rather than onto new ones.)
>
> **9. AUTO MODE, and §7a's authority record made concrete** (rung 3: §7a's own
> reading, still the planner's). On the same green verdict, in an `auto` project,
> **no gate is raised**; Motir merges or enqueues each pull request after commit,
> through the same seam. The pull request records `merge_authority = 'auto_mode'`
> and `merge_outcome_ref`. **§7a's _"the `work_item_delivery` / pull-request row"_
> is settled as the pull request**: the columns are
> `github_pull_request.merge_authority` (`gate` | `auto_mode`) and
> `merge_outcome_ref`, written only when Motir merges or enqueues — a hand merge on
> the host leaves both `null`, which is the honest answer. A refused automatic
> merge writes no record: it posts ONE comment on the run target naming the pull
> request, the refusal and its next action, and is not retried for the same head
> SHA.
>
> **10. THE PERMISSION KEY** (rung 2: §1's handler table). `work_item:merge_pull_request`
> is the permission §1 names for this kind, and it does not exist yet —
> `git grep -n "merge_pull_request" cc09db183 -- lib prisma` returns no hits (exit
> 1). It is added to `lib/permissions/catalog.ts`, granted to every built-in role
> that holds `work_item:edit`.
>
> **11. CAPABILITY** (rung 2: the seam's own convention). Merging is declared by the
> optional `mergeChangeRequest?` method and a `providerSupportsMerge` helper, the
> way `resolveRepoTarballUrl?` (`lib/git/provider.ts:161`) declares its capability
> today. MOTIR-4610 replaces capability-by-optional-method with a declared set, and
> this helper is one of the sites it converts.
>
> **Not decided here:** §8 row 4a (MOTIR-5479's), how a GitHub review maps onto
> gates (MOTIR-4910), and whether a provisioned repository gets a queue at all
> (MOTIR-4161). What a queue EJECTION does to the card is decided by §4's THIRD
> AMENDMENT, directly below.

> ### §4 — THIRD AMENDMENT (MOTIR-5629, 2026-09-16): a merge-queue EJECTION — the reason map, the exit recorded on the pull request, the card's ONE decided gate stands, _Queue again_ while the heads are unchanged, and a push re-arms
>
> **What was OPEN.** Decision 6 above enqueues a pull request, and §8's second
> amendment makes approving the card's ONE `pull_request_approval` gate merge or
> enqueue every member. Nothing said what happens when the queue then REMOVES a
> member: to the card, to the approval a person already gave, to the pull
> request's _Queued to merge_ record, and to the card's other members. Story
> MOTIR-5461's children build against these answers. **Everything above in §4,
> and §8's second and third amendments, stands. No path this amendment
> describes raises a gate per pull request, and no path raises a second
> `pull_request_approval` over commits a person already approved.**
>
> **Read at base `58bb046d0`.** The evidence is MOTIR-5627's capture, attached to
> that card as `mq-deliveries-cla-hook-2026-09-13.json.txt` with its findings in
> the card's comments: 963 real deliveries to a repository hook on
> `moooon-B-V/motir-core` (2026-09-13 12:32 → 2026-09-16 12:31), read back with
> `gh api repos/moooon-B-V/motir-core/hooks/<id>/deliveries/<delivery-id>`.
>
> **1. THE EVENT** (rung 2: the capture). The signal is the `pull_request`
> event, action **`dequeued`**. Motir's App (`motir-integration`) already
> subscribes to `pull_request`, so no grant is needed to HEAR an ejection. The
> payload carries `number`, `pull_request` (head SHA included) and `reason`, and
> **nothing about the merge group or the check that failed.** It is normalised
> through the `GitProvider` seam as an OPTIONAL capability, the way
> `parseWorkflowRunEvent?` (`lib/git/provider.ts:362`) is. GitLab merge trains are
> MOTIR-4608's.
>
> **2. THE REASON MAP — closed and total** (rung 2: the capture; rung 1: the
> published webhook schema). **A delivery spells the reason in the webhook
> schema's UPPER_SNAKE enum, not in the GraphQL timeline's lowercase one.**
> Counted over 110 real `dequeued` deliveries: `MERGE` 88, `CI_FAILURE` 15,
> `MANUAL` 4, `MERGE_CONFLICT` 3. The timeline's `failed_checks` / `merged` /
> `checks_timed_out` never appear in a delivery. A successful merge is `MERGE`,
> not `merged`. The match is EXACT; nothing is case-folded.
>
> | `reason` (exact)         | seen in a delivery | disposition | why                                                                                             |
> | ------------------------ | ------------------ | ----------- | ----------------------------------------------------------------------------------------------- |
> | `CI_FAILURE`             | yes (15)           | failure     | the queue's checks failed on the merge group                                                    |
> | `CI_TIMEOUT`             | no — schema        | failure     | the checks did not finish; GitHub lists a timeout as a removal cause beside failures            |
> | `MERGE_CONFLICT`         | yes (3)            | failure     | the pull request does not combine with what is ahead of it; the work needs a change             |
> | `INVALID_MERGE_COMMIT`   | no — schema        | failure     | the queue could not build a merge commit for it                                                 |
> | `GIT_TREE_INVALID`       | no — schema        | failure     | the queue could not build a tree for it                                                         |
> | `BRANCH_PROTECTIONS`     | no — schema        | failure     | GitHub: _"branch protection failure that could not automatically be resolved"_ — it cannot land |
> | `MANUAL`                 | yes (4)            | neutral     | somebody took it out on purpose; nothing is said about the work                                 |
> | `QUEUE_CLEARED`          | no — schema        | neutral     | the queue was reset                                                                             |
> | `ROLL_BACK`              | no — schema        | neutral     | removed for a roll-back, not for its own content                                                |
> | `UNKNOWN_REMOVAL_REASON` | no — schema        | neutral     | GitHub itself does not know; a card never moves on an unknown                                   |
> | `MERGE`                  | yes (88)           | landed      | it merged                                                                                       |
> | `ALREADY_MERGED`         | no — schema        | landed      | it was merged already                                                                           |
> | **any other string**     | —                  | neutral     | recorded raw and logged once, so a new spelling is visible and moves no card                    |
>
> The three schema-only failure rows are decided as failures because in each
> the queue could not produce a mergeable result for that pull request as it
> stands, which is what `implemented` says (MOTIR-3685: committed code whose
> build has not passed).
>
> **3. WHAT A REMOVAL RECORDS, AND WHAT A FAILURE DOES** (rung 2: §4 decision 4
> and §8's second amendment, decision 4 — the outcome lives on the PULL
> REQUEST).
>
> - **Every non-landed removal writes ONE queue-EXIT ROW** on the pull request:
>   the raw reason, its disposition, the head SHA it left at, the time, the
>   delivery GUID (decision 9), and a nullable `requeuedAt` (decision 5). Rows
>   accumulate; the latest is the pull request's current exit. The failing
>   check's name and link are added by decision 8.
> - **A `queue:` `merge_outcome_ref` is CLEARED**, and only a `queue:` one, so the
>   pull request stops reading _Queued to merge_. `merge_authority` stays: it
>   still says who asked for the enqueue.
> - **On a failure, every card the pull request DELIVERS moves to
>   `implemented`** — from `approved` in a `manual` project, from `in_review` in
>   an `auto` one — through `applyStatusTransition` as a SYSTEM write. A
>   delivered card at any other status (somebody moved it) is left alone and
>   named in the handler's result. §6d rule 6 does not fire, because it is scoped
>   to a person's move, and there is no awaiting gate to withdraw anyway.
> - **The card's OTHER members still in the queue are left there.** They were
>   approved at their own heads, and those heads have not moved.
> - **All of it is ONE transaction**, and nothing external is called. A failure
>   inside it answers non-2xx; GitHub does not retry by itself, so recovery is a
>   hand redelivery, which decision 9 makes safe.
>
> **4. NEUTRAL AND LANDED.** A neutral removal writes the row, clears the ref,
> and moves no card; the pull request is put back by _Queue again_. A landed
> removal writes nothing and moves nothing: the merge webhook already owns
> `done` (§4 amendment).
>
> **⚠️ SUPERSEDED by the FOURTH AMENDMENT below (MOTIR-5800, 2026-09-19)** for
> EVERY un-landed removal in a `manual` project, NEUTRAL included: the merge
> question is asked again on ONE fresh gate (or, for a `MERGE_CONFLICT`, the card
> drops to `implemented` and no gate is raised), and _Queue again_ DECIDES that
> gate rather than reusing the spent approval. It still holds for `auto` mode.
> Kept visible as the record.
>
> ~~**5. THE CARD'S ONE DECIDED GATE STANDS, AND _QUEUE AGAIN_ REUSES IT WHILE THE
> HEADS ARE UNCHANGED**~~ (rung 1: GitHub; rung 3: MOTIR-5603's record).
>
> - **An ejection neither supersedes nor re-opens the decided
>   `pull_request_approval` gate.** A decided gate is a record (§6a), and the
>   trigger `trg_approval_gate_decided_immutable` refuses to edit it anyway.
> - **While a member's head still equals its entry in the gate's
>   `subjectVersion`, the approval still describes that code.** GitHub agrees:
>   its documented removal causes do not touch a review, and an approval is
>   dismissed only when new commits change the diff, and only where the branch
>   rule _Dismiss stale pull request approvals when new commits are pushed_ is on
>   (_About protected branches_, and _Managing a merge queue_, read 2026-09-16).
>   Asking again for the same commits is _"the same person answering the same
>   question twice"_, which MOTIR-5603 retired.
> - **_Queue again_ in a `manual` project is the shipped per-member RETRY**
>   (`pullRequestMergeService.retryApproveAndMergeMember`, MOTIR-5613), addressed
>   by (the card's approved gate, the pull request), extended to accept an
>   exited member whose latest exit is not yet re-queued. Under the card's row
>   lock it re-runs merge-or-enqueue, records the outcome
>   (`recordMotirMerge`), stamps the exit row's `requeuedAt`, and, if a failure
>   had moved the card, writes `implemented → approved` carrying
>   `decidingGateId` = that gate. **It decides nothing and raises nothing.** A
>   moved head is refused by the retry's shipped head check.
> - **_Queue again_ in an `auto` project** has no gate to reuse, so it is a
>   person's press on (the card, the pull request): the same permission floor as
>   the press (`work_item:edit`), an unchanged head, and an un-re-queued exit. It
>   re-dispatches `pull-request/auto-merge.requested` with an idempotency key
>   that includes the exit row's id, because the shipped key is `prId:headSha`
>   (`lib/services/ciPromotion.ts`, `dispatchAutoMerges`) and would otherwise
>   refuse the same head for ever. It stamps `requeuedAt` and returns the card
>   `implemented → in_review`, the status the failure moved it from.
>   `merge_authority` stays `auto_mode`.
> - **Two presses on one exit enqueue once.** The card's row lock plus a
>   `requeuedAt IS NULL` predicate decide it; the loser gets a named refusal.
>
> **⚠️ SUPERSEDED by the FOURTH AMENDMENT below (MOTIR-5800, 2026-09-19)** in its
> first half: a manual RETRYABLE or SETTING outcome now moves the card to
> `in_review` and DOES raise ONE fresh gate over the same commits, computed from
> the standing outcome rather than from the promotion. For a CAN'T-LAND outcome
> the promotion hold below is exactly what the amendment keeps, and the push
> re-arm is unchanged. Kept visible as the record.
>
> ~~**6. NO SECOND GATE OVER THE SAME COMMITS, AND A PUSH RE-ARMS**~~ (rung 2: the
> shipped promotion). **This is the rule the story turns on, because the shipped
> latch would otherwise break decision 5 by itself.** After a failure exit the
> card is `implemented` while its members' OWN checks are still green: only the
> queue's merge commit failed. Two shipped paths would promote it straight back:
>
> - `workItemsService.latchCiGreen` runs `promoteIfCiAlreadyGreen` whenever a card
>   ARRIVES at `implemented`, which includes the ejection's own write; and
> - `promoteDeliveredCardsOnGreen` promotes on the next green check event at that
>   head.
>
> Either promotion calls `raisePullRequestApprovalGate`, which checks only for an
> `awaiting` gate, so it would raise a second gate over the commits the decided
> gate already covers. **So the promotion HOLDS a card while any delivered
> member has an un-re-queued FAILURE exit at its CURRENT head**, in both edges,
> read in the transaction the promotion already opens. The hold lifts in exactly
> two ways:
>
> - **a push** moves that member's head, the exit is no longer at the current
>   head, and the next green verdict promotes the card to `in_review` through the
>   shipped path, which raises **ONE fresh awaiting gate** over the new heads
>   (§8's amendment, decisions 3 and 4; the partial unique index is on `awaiting`
>   only). Nothing new raises a gate;
> - **_Queue again_** stamps the exit, and moves the card itself (decision 5).
>
> **And the raise itself never asks about commits a person already approved.**
> `REVIEW_STATUSES` includes `approved`, so a late green check on an `approved`
> card whose member is still queued reached `raisePullRequestApprovalGate`, which
> found no `awaiting` gate and raised a second one over the approved commits —
> MOTIR-5632 reproduced it before fixing it. The raise now refuses when the card's
> latest gate of this kind is `approved` with the SAME `subjectVersion`. A push
> changes the version, so the re-arm above is untouched. (Refusing queued members
> as merge candidates was the alternative, and it was rejected: a card with one
> member re-pushed and another still queued would then never be asked again.)
>
> **⚠️ SUPERSEDED by the FOURTH AMENDMENT below (MOTIR-5800, 2026-09-19)** at its
> second bullet: `implemented → approved` is REMOVED and `approved → in_review`
> is DECLARED. The first and third bullets stand. Kept visible as the record.
>
> ~~**7. THE WORKFLOW EDGES**~~ (rung 2: `DEFAULT_TRANSITIONS`, which carries 33
> edges at this base).
>
> - `approved → implemented` and `in_review → implemented` are declared
>   defaults: a person in an `auto` project may make the same move by hand, and
>   the workflow editor must show the real lifecycle even though the ejection's
>   own write is a system write.
> - `implemented → approved` is declared for _Queue again_. **It was
>   deliberately ABSENT** (`lib/workflows/defaultWorkflow.ts`, the `approved`
>   block): an undeclared hop kept a card from skipping CI. The protection
>   survives where there is a build to skip: the product's only writer is
>   _Queue again_, which carries a decided gate whose `subjectVersion` names
>   heads CI already judged green, and a HAND move into `approved` while an open
>   pull request delivers the card is still refused by §6d rule 2b. A card with
>   no open pull request may now be moved there by hand; it has no build to
>   skip. The tests asserting the absence are rewritten to assert rule 2b,
>   citing this decision.
> - Existing default-workflow projects are backfilled by a KEY join with a
>   `NOT EXISTS` guard, the pattern of
>   `prisma/migrations/20260911140000_add_approved_default_status/migration.sql`.
>   A project missing any of the three keys gets nothing, which leaves a custom
>   workflow alone.
>
> **8. THE FAILING CHECK — the `merge_group` event, which needs a grant**
> (rung 2: the capture). Two candidates were open; the capture settles it:
>
> - **REJECTED — a `check_run` delivery's `check_suite.head_branch`.** Over REST a
>   failed merge-group check run reads `pull_requests: []` and
>   `check_suite.head_branch: null`, and no webhook sample of it was captured.
>   Nothing verified says a delivery names the queue branch.
> - **CHOSEN — the `merge_group` event.** 126 `checks_requested` and 129
>   `destroyed` deliveries were captured. Each carries
>   `merge_group.head_sha` and `merge_group.head_ref` =
>   `refs/heads/gh-readonly-queue/<base>/pr-<N>-<base_sha>`; `destroyed` also
>   carries a lowercase `reason` (`merged` 88, `invalidated` 24, `dequeued` 17).
>   Every `CI_FAILURE` `dequeued` pairs with a `destroyed`/`dequeued` for the same
>   `pr-<N>`, delivered about 0.3 s EARLIER; a `MERGE_CONFLICT` removal, and some
>   `MANUAL` ones, have no merge group at all, and so no failing check.
>
> So Motir records a QUEUE ATTEMPT at `checks_requested` (the merge group's
> `head_sha` and the pull request number(s) parsed from `head_ref`), before any of
> its checks can complete. A failed `check_run` whose `head_sha` is a known
> attempt writes its `name` and `html_url` onto that attempt (the first failure
> to complete wins), and the failure exit row takes its failing check from the
> pull request's latest attempt. Because the attempt exists first, a check that
> completes before the `dequeued` delivery is not lost. **A queue check NEVER
> writes `github_check_run`**: that table is the pull request's own CI state at
> its head (`derivePrCiState`), and a red row there would stop decision 6's
> re-arm. **A named step with its own owner:** the App needs the `merge_group`
> event and the _Merge queues_ (read) permission — MOTIR-5638, a person's card
> in the App settings. Until an installation has accepted it, an exit row's
> failing check is null and the surface says the check is unknown; nothing
> else degrades.
>
> **9. IDEMPOTENCY — the delivery GUID** (rung 2: the capture). There is no
> delivery-id table today, and `app/api/github/webhook/route.ts` reads
> `x-hub-signature-256` and `x-github-event` but not `X-GitHub-Delivery`. **The
> key is that header, UNIQUE on the exit row.** MOTIR-5627 redelivered a
> delivery and read both rows back: a new delivery id
> (`3843060808573517824`, `redelivery: true`) with the SAME GUID as the
> original (`3843059981840547840`, `redelivery: false`) —
> `0e648c86-b1d0-11f1-8f8e-188ebfa2d67b`, in the list and in the request header
> alike. So a hand-redelivered old exit is a no-op, even after _Queue again_,
> while a genuine second exit at the same head, which is a new event, acts.
> **A `(head, reason)` key is REJECTED on the record**: the capture shows one
> head ejected four times (pull request #2877 at `1a74b77`: `CI_FAILURE`,
> `CI_FAILURE`, `MANUAL`, `CI_FAILURE`), each by a different merge group, and
> such a key would collapse them. No fallback is needed, because the GUID is
> repeated.
>
> **10. DELIBERATELY NOT DECIDED HERE.** The card BADGE and the `motir fix`
> claim for an ejected card (MOTIR-5628); any notification; GitLab merge trains
> (MOTIR-4608).
>
> **Which card builds which decision:**
>
> | decisions    | card                                                        |
> | ------------ | ----------------------------------------------------------- |
> | 1–4, 6 and 9 | MOTIR-5632 — the ejection arm and the two promotion guards  |
> | 5            | MOTIR-5634 — _Queue again_, in both modes                   |
> | 7            | MOTIR-5630 — the edges and their backfill                   |
> | 8            | MOTIR-5633 — the failing check · MOTIR-5638 — the App grant |
> | the surface  | MOTIR-5631 — the design delta · MOTIR-5635 — the frame      |

> ### §4 — FOURTH AMENDMENT (MOTIR-5800, 2026-09-19): ONE APPROVAL = ONE MERGE/ENQUEUE ACTION — every un-landed outcome is classed by REASON, retryable and setting-blocked re-ask at `in_review` with ONE fresh gate, a conflict drops to `implemented` HELD, _Retry merge_ / _Queue again_ ARE the new approval, and `implemented → approved` leaves the workflow
>
> **DECIDED BY THE REQUESTER (Yue, 2026-09-19)**, first answering MOTIR-5144's
> open criterion and then widening it at the design review of MOTIR-5801. Their
> words:
>
> - _"every merge/requeue needs to be approved again, one approval for one
>   merge/enqueue action"_
> - _"retry merge is needed too, retry merge can be on the work item link PR"_
> - _"if it's conflict the PR really can't be merged, retry is useless"_
> - a NEUTRAL removal: _"re-ask too"_
>
> The requester's reasoning, in their terms: `approved` serves two gates, the
> DESIGN gate and the MERGE gate. The design gate never rolls back. The merge gate
> does — a pull request that did not land did not honour the yes a person gave
> about those commits — and the yes was about ONE attempt.
>
> **What this reverses.** The THIRD AMENDMENT's decisions 5, 6 (first half) and 7
> (second bullet), struck in place above, and §8's point 5(e) _"a retry is step (b)
> for that one gate alone"_, struck in place below (point 8). Its decisions 1–4, 8
> and 9 stand unchanged: the event, the reason map, the exit row, the failing check
> and the delivery-GUID idempotency. **Every rule below is for a `manual`-mode
> project.** `auto` mode is unchanged throughout and is restated at point 10.
>
> **1. ONE APPROVAL AUTHORIZES ONE MERGE OR ENQUEUE ACTION.** Once that action has
> been attempted and has NOT landed, the approval is SPENT. No door re-performs it
> on the same approval — not _Queue again_, not _Retry merge_, not a second press
> of the same gate. _Why:_ an approval is a person saying "land these commits
> now"; when that attempt fails, nobody has said "try again", and the product must
> not supply that sentence on their behalf.
>
> **2. EVERY UN-LANDED OUTCOME IS CLASSED BY ITS REASON**, by ONE total map in
> `lib/mergeQueue/queueExit.ts` over BOTH sources: the queue's exit reason
> (`GithubPullRequestQueueExit.rawReason`) and the host's `MergeRefusalCode`
> (`lib/git/types.ts`) when a press is refused.
>
> | class                       | reasons                                                                                                                                                              | the card                 | the gate                                    |
> | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------- |
> | **RETRYABLE**               | queue `CI_FAILURE`, `CI_TIMEOUT`, `INVALID_MERGE_COMMIT`, `GIT_TREE_INVALID`, and every NEUTRAL removal (`MANUAL`, `QUEUE_CLEARED`, `ROLL_BACK`, an unmapped reason) | `approved → in_review`   | ONE fresh awaiting gate                     |
> | **CAN'T LAND AS IT STANDS** | queue `MERGE_CONFLICT`; host `conflict`, `checks_not_green`                                                                                                          | `approved → implemented` | none — the promotion is HELD at that head   |
> | **BLOCKED BY A SETTING**    | queue `BRANCH_PROTECTIONS`; host `branch_protected`, `app_permission_missing`                                                                                        | `approved → in_review`   | ONE fresh awaiting gate, naming the setting |
> | **LANDED**                  | `MERGE`, `ALREADY_MERGED`; host `already_merged`                                                                                                                     | unchanged                | none                                        |
>
> The reason for each class, one sentence each:
>
> - **RETRYABLE** — re-running the SAME commits can succeed (a flaky check, a
>   cleared queue, a hand removal), so the question is worth asking again.
> - **CAN'T LAND AS IT STANDS** — the same commits cannot land however many times
>   anyone says yes, so asking would offer a button guaranteed to fail; the card
>   goes back to `implemented`, where `motir fix` claims it.
> - **BLOCKED BY A SETTING** — a person can change the setting and the same
>   commits then land, so the question is asked and the surface NAMES the setting.
> - `subject_changed` is **NOT an outcome at all.** It is the stale-stamp refusal
>   (MOTIR-5232): the action was never attempted, so nothing was spent and no row
>   is written.
>
> **3. THE RE-ASKED GATE** is ONE fresh awaiting `pull_request_approval` gate over
> the SAME delivery-set version, standing alone.
>
> - **The decided gate row is never edited.** It is a record (§6a), and
>   `trg_approval_gate_decided_immutable` refuses the write anyway. _Why:_ the
>   first yes happened and stays true as history; what changed is that it did not
>   land.
> - **The re-ask is COMPUTED from the STANDING OUTCOME** — a queue exit that is
>   not re-queued, or a recorded host refusal that is not superseded — at the
>   member's CURRENT head and later than the approval. `resolveGateSet` treats
>   such an outcome as making the merge question OWED even though the latest merge
>   gate is `approved` at the same set version. _Why:_ the old row cannot carry the
>   change, so the only honest input is the outcome record.
> - **A decided `design_result` gate stays decided and is not re-asked**, also
>   where the un-landed merge had been carried by the design approval (MOTIR-5664's
>   one-press carry). _Why:_ the design was never the problem, only the merge. The
>   new gate stands alone, drawn the way MOTIR-5667's state 2 draws a merge gate
>   re-opened beside a decided design.
> - **Exactly one.** A redelivered `dequeued` (the same delivery GUID, decision 9)
>   raises nothing new, and the partial unique index on `awaiting` still holds.
>   _Why:_ asking twice about one set of commits is the thing MOTIR-5603 retired.
> - **A CAN'T-LAND outcome raises NOTHING, and the promotion is HELD at that
>   head.** A green check at the same head must not raise a gate; the head moving
>   is what re-arms it (point 6).
>
> **4. _RETRY MERGE_ AND _QUEUE AGAIN_ ARE THE NEW APPROVAL.** They stay on the
> PULL REQUEST's own row, where the person sees the outcome — the requester's
> _"retry merge can be on the work item link PR"_. Pressing one **DECIDES the
> awaiting re-asked gate** with the member's stamp and then performs ONE merge or
> enqueue, stamping the exit's `requeuedAt` or the refusal's `supersededAt` and
> moving the card `in_review → approved` under that gate's `decidingGateId`. With
> NO awaiting gate they refuse by name (`MERGE_REQUEUE_NEEDS_APPROVAL`) and press
> nothing. Approving the gate from the item page or the full-screen overlay
> performs the SAME action through the same service path. A CAN'T-LAND member
> offers neither verb. _Why:_ the familiar button is kept where people look for it,
> and it is made to MEAN the fresh yes rather than a replay of the spent one.
>
> **5. THE HOST'S REFUSAL IS RECORDED** on the pull request —
> `GithubPullRequestMergeRefusal`: the `MergeRefusalCode`, the head it refused, the
> gate whose approval it spent, and when — written in its own transaction after the
> press's transaction has rolled back. _Why:_ before this the refusal existed only
> in the press's HTTP response, so a reload showed a card reading **Approved** with
> nothing anywhere saying the merge had been refused or why. A class cannot be
> assigned to an outcome nobody wrote down.
>
> **6. `motir fix` IS FOR THE CLASSES WHERE THE CODE MAY BE AT FAULT.** It claims a
> CAN'T-LAND card at `implemented` (where it already did) and a `CI_FAILURE` /
> `CI_TIMEOUT` / `INVALID_MERGE_COMMIT` / `GIT_TREE_INVALID` card at `in_review`.
> It REFUSES a BLOCKED-BY-A-SETTING card and a NEUTRAL one, naming what would help
> instead. It is offered wherever the re-asked gate is decided: the item page's
> Development block AND the full-screen approval overlay. A push after an un-landed
> outcome supersedes the fresh gate `head moved`, and the next green raises exactly
> one gate over the new commits (MOTIR-5604's path, unchanged) — which is also how
> a CAN'T-LAND card leaves its hold. _Why:_ `motir fix` sends an agent to change
> code; against branch protection or a hand removal it has nothing to change.
>
> **7. THE EDGES.** After this amendment the ejection edges in the default workflow
> read:
>
> | edge                      | state        | writer                                                  |
> | ------------------------- | ------------ | ------------------------------------------------------- |
> | `approved → in_review`    | **DECLARED** | a RETRYABLE or SETTING outcome (point 2)                |
> | `implemented → approved`  | **ABSENT**   | none — an approval is only ever given from `in_review`  |
> | `approved → implemented`  | kept         | a CAN'T-LAND outcome (point 2); also a legal hand move  |
> | `in_review → implemented` | kept         | an `auto` FAILURE removal (THIRD AMENDMENT, decision 3) |
>
> _Why:_ the absence of `implemented → approved` is what guarantees a card only
> becomes Approved where CI has spoken and a person has said yes, and its only
> product writer was _Queue again_, which point 4 turns into a gate decision.
> Existing default workflows are converged by a KEY-joined migration that inserts
> `approved → in_review` behind a `NOT EXISTS` guard and deletes only the
> `implemented → approved` rows Motir's own backfill wrote, never a transition a
> person added in the workflow editor.
>
> **8. §8's point 5(e) — _"a retry is step (b) for that one gate alone. The
> approval stands above it."_ (MOTIR-5613) — is SUPERSEDED**, struck in place at
> §8 below. A refused merge still writes no decision on its gate and still renders
> its refusal on the surface naming that pull request; what changes is that the
> retry no longer rides on the standing approval. The refusal is recorded (point
> 5), classed (point 2), and the card leaves `approved` accordingly; _Retry merge_
> then decides the fresh gate (point 4). _Why:_ that rule is the same shortcut as
> _Queue again_, one door over, and point 1 admits no exception for it.
>
> **9. CARDS LEFT STRANDED BY THE OLD RULES ARE CONVERGED, by an operator, after
> deploy.** Four populations, each moved through the SAME service entry point a
> live outcome runs: a card at `implemented` with a standing RETRYABLE or SETTING
> exit at its head (→ `in_review` plus one fresh gate); a card at `implemented`
> with a standing `MERGE_CONFLICT` exit (already in its new state — counted, not
> moved); a card at `approved` with a standing NEUTRAL exit (→ `in_review` plus one
> gate); and a card at `approved` holding an un-landed member with no outcome at
> all, which is a host refusal the press never recorded (a refusal row is written
> with the backfill-only code `unrecorded`, classed RETRYABLE, then the same move).
> A card whose head has moved is skipped: it re-arms on its next green, as today.
> _Why:_ changing a rule going forward must not leave the cards caught under the
> old one with no way back, and RETRYABLE is the safe default for an outcome nobody
> recorded — a person is asked, and can still reach for `motir fix`.
>
> **10. `auto` MODE IS UNCHANGED.** No gate is raised, a failure exit still writes
> `in_review → implemented`, and `requeueAutoMember` (MOTIR-5634) still
> re-dispatches the same head on a person's press. _Why:_ there is no approval in
> `auto` mode to spend, so point 1 has nothing to bind.
>
> **Not decided here:** GitLab merge trains (MOTIR-4608); any notification.
> MOTIR-5785 (the design-card direct-merge defect) is `done` and its design-hold
> refusal stays ahead of every merge or enqueue this amendment describes.
>
> **Which card builds which point** (Story MOTIR-5799):
>
> | points      | card                                                                  |
> | ----------- | --------------------------------------------------------------------- |
> | 2, 3, 7     | MOTIR-5805 — the class map, `settleUnlandedOutcome`, and the gate set |
> | 1, 4        | MOTIR-5802 — no door reuses a spent approval after a queue exit       |
> | 5           | MOTIR-5833 — the host refusal record                                  |
> | 4, 8        | MOTIR-5834 — _Retry merge_ after a host refusal                       |
> | 6 (claim)   | MOTIR-5803 — `motir fix` claims by class                              |
> | 6 (surface) | MOTIR-5801 — the design · MOTIR-5806 — the frame and the overlay      |
> | 7 (edges)   | MOTIR-5804 — the edges and their migration                            |
> | 9           | MOTIR-5809 — the script · MOTIR-5810 — its production run             |

### 5. The line against Story 9.2 — DECIDED BY THE PLANNER (rung 3, and it re-scopes existing cards)

| owned HERE (Epic MOTIR-4878)                   | kept by MOTIR-693 (9.2)                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| the DECISION, its record and its status effect | the ephemeral hosted PREVIEW, its deploy and teardown                         |
| the shared control and its confirm step        | the **revise-chat re-dispatch** after a rejection                             |
| the routing surface                            | `Project.designApprovalGate` and the HOLD it applies to the `motir auto` loop |

**9.2's review UI COMPOSES this record's control rather than drawing its own.**

**Why the decision moved out of 9.2 at all:** 9.2 sits behind hosted agent
execution (MOTIR-683), so leaving design approval there means nobody can approve
a design until an entire epic lands — while the artefact it would approve has
been shipping to cards since MOTIR-2664.

`design-result.md` §7 currently points the other way and is amended by this
record's own pull request to point here for the half this epic takes.

### 6. The gate LIFECYCLE — DECIDED BY THE REQUESTER (Yue, 2026-09-08), mechanics by the planner

#### 6a. A gate is an EAGER row, and the row is an AUDIT ARTEFACT

A gate row is written **when its subject appears** — in the same transaction as
the design-result publish, or the `link_pull_request` call — not derived on read.

Two things forced it and both are already requirements elsewhere in the story: a
**partial unique index** over the awaiting state cannot exist without a row, and
the decide door's **`SELECT … FOR UPDATE`** has nothing to lock without one.
Locking the subject instead would make two gate kinds on one card contend with
each other. And since `decidedById` / `decidedAt` need a row at decision time
regardless, a derived model is the eager model minus its index and its lock.

**But the row is not a workflow row that happens to keep a timestamp.** Yue:
_"it has to be informational, that will be used for later audits … **the human in
the agent loop evidence**."_ It is read months later by someone who was not
there, so it carries:

| field                                                                                                               | why an auditor needs it                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| the subject **and its immutable VERSION** — the design's `commitSha`, the pull request's `headSha` at decision time | a design can be republished and a pull request can gain commits, so _"approved the design"_ is not evidence and _"approved these bytes"_ is |
| **who decided, surviving their departure** — a denormalised actor label beside the nullable FK                      | `onDelete: SetNull` preserves _that_ a decision happened and destroys _who made it_, which is the one thing the audit is for                |
| **when**                                                                                                            | the server's timestamp                                                                                                                      |
| **who it was ROUTED to**                                                                                            | §2's answer computed at creation; the assignee can change afterwards                                                                        |
| **under which PERMISSION**                                                                                          | answers _"was this person entitled?"_ without re-deriving a role that has since changed                                                     |
| **through which SURFACE** — `ui \| api \| mcp`                                                                      | a human click must be distinguishable from a programmatic call                                                                              |
| **what it CAUSED** — the merge commit sha, or the transition applied                                                | closes the loop from decision to effect                                                                                                     |
| **the note**                                                                                                        | why they said yes, or what they sent back                                                                                                   |

**A decided gate is IMMUTABLE.** There is no update path for a decided row —
audit evidence that can be edited is not evidence.

#### 6b. The state set

| state               | written by                                             | is it a decision?                   |
| ------------------- | ------------------------------------------------------ | ----------------------------------- |
| `awaiting`          | the product, when the subject appears                  | —                                   |
| `approved`          | a person                                               | **yes**                             |
| `changes_requested` | a person                                               | **yes**                             |
| `superseded`        | **the product**, when the gate's subject is superseded | **no** — the question was withdrawn |

**`superseded` is required, and its absence was a real gap.** The revise loop
publishes v2 while v1's gate is still `awaiting`. Without this state the
Approvals tab would ask about a design that is no longer current, and approving
it would pin bytes for a version the product had already moved past. It carries
no actor, no permission and no note, **so that the audit can never read a
withdrawn question as a human decision.**

**Uniqueness is keyed on `(workItemId, kind, subjectId)`, not `(workItemId,
kind)`.** For `design_result` there is one current design, so superseding frees
the slot; for `pull_request_merge` a card carrying a repository SET legitimately
has several open pull requests and therefore several simultaneous awaiting gates.

> ### §6b — AMENDMENT (MOTIR-5658, 2026-09-17): a supersede records its CAUSE
>
> **A supersede writes `state` and nothing else, and that is why no surface can
> say a true sentence about a withdrawn gate.** State `G` and the
> `APPROVAL_GATE_SUPERSEDED` refusal both say _a newer design was published … the
> current version is above_ — true for ONE of the writing paths and false for the
> rest ([MOTIR-5586](motir:cmu30qjra00g6hvoiiu6ljuhv),
> [MOTIR-5651](motir:cmu5aympl0020hvoik1mfccrg)). Both were repaired by making
> the sentence vaguer, which is the only repair available while the row is
> silent.
>
> **A `superseded` row now carries a CAUSE**, from a closed vocabulary with one
> value per writing path and **no value meaning _unsaid_**: `republished` ·
> `withdrawn` · `head_moved` · `member_closed` · `member_drafted` · `set_changed` ·
> `pulled_back` (`member_drafted` added by MOTIR-5699).
> The full table, with which path writes each, is `design-result.md`
> AMENDMENT 6 Q5. (A seventh, `reopened_by_hand`, was named here when the
> amendment was written and removed before it shipped — MOTIR-5661 found that a
> decided gate cannot be updated at all, so nothing was left to write it.)
>
> **Rows superseded before this amendment carry an UNKNOWN value**, which a
> surface renders as _the reason was not recorded_ — never as one of the real
> causes. Inferring a cause from a row's shape manufactures evidence, and these
> sentences are shown to a person as fact.
>
> **It is still a product write with NO actor, no authority and no note.** A
> cause does not make a withdrawn question readable as a human decision, which is
> what §6b's no-actor rule exists to guarantee.

> ### §6b — SHIPPED (MOTIR-4913, 2026-09-10): what WRITES `superseded`, and when
>
> The state has been in the enum since MOTIR-4788 and the decide door has refused
> it since MOTIR-4790. **Nothing wrote it until now**, so a republish left the
> prior version's gate `awaiting` and the Approvals tab kept asking about a
> design that was no longer current.
>
> **The writer is the PUBLISH path** — `designEvidenceService`'s supersede
> transaction, via
> `approvalGateRepository.supersedeAwaitingByWorkItem(workItemId, 'design_result')`.
> It writes `state` and **nothing else**: no actor, no authority, no note, no
> `decided_at`. That is what keeps §6b's _"the audit can never read a withdrawn
> question as a decision somebody made"_ true on the row rather than only in
> prose, and `tests/approval-gate-retention.test.ts` asserts every one of those
> columns is still null.
>
> **It is keyed on `(work_item_id, kind)`, not on the superseded subject's id**,
> and that is a domain fact rather than a shortcut: `design_evidence` carries one
> CURRENT row per work item, so an `awaiting` `design_result` gate on the item is
> by construction asking about the version the publish is replacing.
>
> **⚠️ AND IT RUNS BEFORE THE `design_evidence` LOCK, WHICH IS A LOCK-ORDER
> DECISION, NOT A STYLE ONE.** The decide door locks the GATE row (step 1) and
> then writes `design_evidence` (§6c's pin, step 4b). A publish that locked
> `design_evidence` first and reached for the gate afterwards would take the same
> two locks in the opposite order — a deadlock, on precisely the interleaving §6c
> exists for. Retiring the gate first makes both paths take `approval_gate` then
> `design_evidence`, so the race resolves by WAITING and lands on one of two
> legitimate outcomes: the publish wins and the decide door refuses with
> `ApprovalGateSupersededError` (nothing was approved, nothing needed pinning), or
> the decide wins and the supersede finds the pin and keeps the bytes.
>
> ### §6b — AMENDMENT (MOTIR-5574, 2026-09-15): WITHDRAWAL is the second writer
>
> **A republish is not the only product write that retires the question. A
> withdrawal does too.** A reviewer who withdraws the current design result
> (`DELETE /api/work-items/<KEY>/design-evidence`, MOTIR-3215) takes the gate's
> subject away with nothing in its place. Until this amendment that path wrote no
> gate, so the gate stayed `awaiting`. The To-approve tab kept the row, and the
> held transitions that read an awaiting gate kept holding the card.
>
> **So `designEvidenceService.withdrawCurrentForWorkItem` makes the same call as
> the publish path**: `supersedeAwaitingByWorkItem(workItemId, 'design_result')`,
> in the withdrawal's own transaction, **before the `design_evidence` lock** for
> the lock-order reason above. The rest of this section holds unchanged:
>
> - it writes `state` alone;
> - a DECIDED gate is untouched;
> - a withdrawal refused for having no current result rolls back and retires
>   nothing.

> ### §6b — AMENDMENT (MOTIR-4911, 2026-09-08): the `approved` WORK-ITEM status, and `decisionSource: github`
>
> **The gate state set above is unchanged and complete.** What was missing is
> everything on the OTHER side of the decision: the status the work item lands
> in, and where the decision came from.
>
> **⚠️ TWO DIFFERENT THINGS ARE SPELLED `approved`, AND CONFLATING THEM IS THE
> ONE READING ERROR THIS SECTION INVITES.** The table above is the **GATE's**
> state — one row's answer to one question. What follows is the **WORK ITEM's**
> workflow status. ~~A card can hold an `approved` `pull_request_approval` gate and
> an `awaiting` `pull_request_merge` gate at the same time (§4's amendment), and
> be at work-item status `approved` because of the first.~~ **STRUCK by §8's
> SECOND AMENDMENT (MOTIR-5609, 2026-09-16): that state no longer exists, because
> a card has exactly one approve-to-merge gate.** The warning itself stands: a
> GATE's state is not a WORK ITEM's status. The two never have to
> agree, and nothing derives one from the other by name.
>
> #### The `approved` work-item status
>
> ```
> todo → in_progress → implemented → in_review → approved → done
>                      PR open       CI green    a person   merged
>                                                said yes
> ```
>
> `in_review → approved → done`, joining the project's default workflow beside
> the seven statuses it already has. **Its CATEGORY is `in_progress`. Only `done`
> and `cancelled` are terminal**, and that is the load-bearing field rather than
> a detail of presentation — **three things follow from it, and each would be a
> defect if the category were `done`:**
>
> | consequence           | what the `in_progress` category buys                                                                                                                                             |
> | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | **open counts**       | an `approved` card is still OPEN in every count, board column total, sprint burndown and report. A card whose pull request has not merged has not shipped                        |
> | **the parent rollup** | `parentStatusRollupService` must NOT complete a container out of `approved` children. A story is finished when its work is on `main`, not when somebody said yes to it           |
> | **dependents**        | cards `blocked_by` it stay BLOCKED. Readiness is computed from `done`, so an approved-but-unmerged blocker cannot make a dependent claimable against substrate that is not there |
>
> **This record does not decide the status's MIGRATION** — its transitions, its
> position, and the `restricted`-policy edges it needs are a sibling story's.
> What is decided here is the status, its category, and the three consequences
> above.
>
> #### `decisionSource` gains `github`
>
> §6a already records **through which SURFACE** a decision arrived — `ui | api |
mcp`. **A fourth value, `github`, is required**, because a pull request
> approved in GitHub's own review UI syncs into the
> `pull_request_approval` gate (§4's amendment, §8 row 4b) and none of the three
> existing values is true of it: nobody clicked in Motir, no token called an API,
> no agent called the MCP.
>
> **⚠️ AND THE APPROVING ACTOR MAY BE A GITHUB IDENTITY MOTIR CANNOT MAP TO A
> MEMBER.** A reviewer with no linked Motir account, a GitHub App, a former
> member whose row is gone. **The record states that in WORDS rather than leaving
> `decidedById` null**, because `decidedById: null` already means something else
> and something worse: §6b's `superseded` state uses exactly that shape to mean
> **the question was withdrawn and nobody decided it**. An unmappable human
> approver recorded as a null FK is therefore indistinguishable, in the one table
> an auditor trusts, from a decision that never happened.
>
> So the row carries the **denormalised actor label** §6a already requires — for
> this case the GitHub login and the fact that it did not resolve to a member —
> beside the nullable FK. The audit then answers _"who approved this?"_ with _"a
> GitHub identity we could not map, and here is the handle"_, which is true,
> legible, and not the same sentence as _"nobody"_. It is the same argument §7a
> makes about `auto`: **an absence and an unattributable presence must not read
> the same.**

> ### §6b / §6c — AMENDMENT (MOTIR-5234, 2026-09-18): a press carries a STAMP of what the reader was shown
>
> **Story MOTIR-5232.** §6b's `superseded` refuses a WITHDRAWN question. It cannot refuse a
> press from a page rendered an hour ago about a question that is still live but has CHANGED,
> because the decide door recorded nothing about what the reader saw. Two changes were
> uncaught: the card's **acceptance criteria** (the how-to-test a reviewer judges against)
> belong to no subject, so editing them supersedes nothing; and since MOTIR-5652, one press on
> a design with pull requests also decides the card's approve-to-merge gate and merges its
> members, and that press did not check them.
>
> **Decided:**
>
> 1. **Every read that renders a gate returns a `stamp`** (`WorkItemGateRead.stamp`, and the
>    overlay's `ApprovalGateOverlayReadDTO.stamp`). **The decide door REQUIRES it**
>    (`DecideGateInput.stamp`, no default). A surface hands back what it was handed, and the
>    REST route refuses a body without one with a `400`.
> 2. **What it covers:** the pressed gate's `subjectVersion`; for a `design_result` gate, the
>    `subjectVersion` of the card's awaiting `pull_request_approval` gate (the _companion_ the
>    press also decides); and the work item's `descriptionMd`. **Nothing else.** The assignee,
>    labels, status, watchers and `updatedAt` never make a decision stale. `lib/approvalGates/stamp.ts`
>    is the only definition.
> 3. **Derived, never stored.** No column, no migration, no backfill.
> 4. **Opaque to the client, composite on the server.** One digest per component, so the door
>    can say WHAT moved: `subject` · `pull_requests` · `criteria`. A pressed approve-to-merge
>    gate reports its own subject as `pull_requests`, because that is what its reader was looking at.
> 5. **It errs wide.** The whole `descriptionMd` is hashed, so a typo fix also invalidates. A
>    false stale costs one re-read; a missed one applies an approval to a question that changed.
> 6. **Checked UNDER THE LOCK, AFTER the state refusals** (`decide` step 3b), recomputed from the
>    locked gate, the item read after it, and the companion as it stands. A mismatch raises
>    `APPROVAL_GATE_STALE_SUBJECT` (`409`, carrying `moved`) and writes nothing: no state, no
>    audit columns, no status, no pin. **It runs BESIDE §6b's supersede check and never replaces it.**
>    `superseded` means _withdrawn, leave_; stale means _still yours, look again_.
> 7. **The ONE bypass is a symbol, `DECIDED_WITHOUT_A_READER`**, for a decision nobody pressed:
>    the GitHub review sync (§8's fourth amendment), and the companion gate inside
>    `approveDesignAndMerge`, whose primary was already checked. A symbol cannot be serialised,
>    so no request can carry it.
> 8. **The two-gate press decides the companion only while its version is the one checked.**
>    The door returns the companion version it read under its lock, and `approveDesignAndMerge`
>    leaves a companion raised since then awaiting. Its commits are a new question.
>
> **The refusal is the mechanism.** A live _this changed while you were reading_ notice is
> MOTIR-5243's (Story MOTIR-5238) and reads its own stream. It does not replace this check.
> The refusal's copy and its one control are drawn in
> `design/work-items/approval-control--stale-refusal.mock.html` (MOTIR-5233) and built by MOTIR-5235.

#### 6c. Retention — only an approval keeps its bytes, and it PINS rather than FREEZES

**Yue:** _"I don't think we should keep the not approved versions. We don't need
to record all the user behaviours, we just need to record the user said 'yes'
behaviour — the 'yes' moves the project and agent forward."_

**Evidence is retained for decisions that had an EFFECT.** An auditor asks _what
authorised this change?_, and only an approval answers it: a rejection moves
nothing, the agent revises, and the next version supersedes the one sent back.

|                     | the gate ROW                   | the subject's BYTES                 |
| ------------------- | ------------------------------ | ----------------------------------- |
| never decided       | no gate, or `superseded`       | superseded → reclaimed after 7 days |
| `changes_requested` | **kept** — who, when, the note | superseded → reclaimed              |
| **`approved`**      | **kept**                       | **PINNED — kept indefinitely**      |

So the trail still says _"Yue sent v1 back on the 8th because the confirm step
was wrong."_ It does not keep a picture of v1. **That is the intended loss.**

**The mechanism is a PREDICATE on an existing branch.**
`withdrawCurrentForWorkItem` already makes a row non-current without unlinking
its attachments. The supersede path gains the same behaviour under one more
condition: **do not unlink the attachments of a row an approved gate
references.** The pin is written **in the same transaction as the decision** —
written afterwards, a republish racing an approval re-opens the window it exists
to close.

~~**⚠️ PIN, do NOT FREEZE — this is where we deliberately diverge from
`acceptance-receipt-lifecycle.md`.** The acceptance gate refuses to supersede an
approved receipt at all (`AcceptanceEvidenceAlreadyApprovedError`, 409,
MOTIR-2764). That is right for a story that is finished and **wrong here**: a
design legitimately evolves after approval, and 9.2's revise loop depends on
republishing. The design path keeps superseding; it simply stops feeding
approved blobs to the GC.~~ **AMENDED 2026-09-15 (MOTIR-5554):** a design
evolves after approval only once a person reopens its card. A design card in the
`done` status category is CLOSED — read the _A DONE DESIGN CARD IS CLOSED_
amendment below, which retires this divergence. The pin itself is unchanged.

> ### §6c — AMENDMENT (MOTIR-4911, 2026-09-08): the pin is keyed on the SUBJECT, never on the gate KIND
>
> **What FAILS SILENTLY as written, and this is the expensive one.** The
> mechanism paragraph keys retention on the **`design_result` gate**:
>
> ~~The supersede path gains the same behaviour under one more condition: **do
> not unlink the attachments of a row an approved gate references** [where the
>
> > approved gate is the `design_result` one].~~
>
> **A design with a pull request is approved through `pull_request_approval`, not
> through `design_result`** (§1's amendment: the KIND is chosen by whether there
> is a pull request; the PORT is chosen by what the card produced). So the clause
> as written **stops pinning for the common case** — a design card that opened a
> pull request, which is most of them.
>
> **⚠️ Keying retention on the gate KIND would fail with no error and no red
> test: the supersede path simply stops finding an approved `design_result` gate,
> unlinks the attachments as it always did, and the orphan-GC reclaims the bytes
> seven days later — so the failure is invisible for a week and then arrives as
> an approval pointing at nothing.**
>
> **THE CORRECTION — key it on the SUBJECT.** ⚠️ **When a WORK ITEM carrying a
> current design result is approved, pin THAT version's assets — whichever gate
> kind carried the decision.** The predicate is _does an approved gate on this
> work item reference this `DesignEvidence` version?_, and it does not read the
> gate's `kind` at all.
>
> **Everything else about §6c is unchanged**, and each half is now stated against
> the subject rather than the kind:
>
> - **PIN, do not FREEZE.** The design path keeps superseding; it stops feeding
>   approved blobs to the GC. The divergence from
>   `acceptance-receipt-lifecycle.md` stands for the reason given.
> - **Written in the SAME TRANSACTION as the decision** — written afterwards, a
>   republish racing an approval re-opens the window it exists to close.
> - **PER APPROVED VERSION, never "the approved one"** (§6d) — approvals
>   accumulate, and a card approved, reopened and approved again holds two pinned
>   sets.
> - **Only approvals pin.** `changes_requested` and `superseded` keep the ROW and
>   let the bytes go, which is the intended loss.
>
> **The general form, worth stating once because the next kind will need it:**
> §1's registration table asks a handler for _what to RETAIN on approval_, and
> the answer is a property of the SUBJECT — what was decided — never of the gate
> that carried the decision. A retention rule keyed on a kind is a rule that
> stops applying the moment the same subject can be decided through a second
> door, which is exactly what happened here.
>
> **`design-result.md` §7 carries the pointer** — its statement of this clause is
> amended in the same pull request, because the trigger it was told about has
> changed.

> ### §6c — SHIPPED (MOTIR-4913, 2026-09-10), and the AMENDMENT's restatement of the predicate is CORRECTED
>
> **The mechanism is a nullable `design_evidence.pinned_at`**, written by the
> decide door on every APPROVAL — step 4b, in the decision's own transaction —
> and read by the supersede path as one predicate on an existing branch: a row
> with `pinned_at` set is made non-current WITHOUT its attachments being unlinked,
> so the orphan-GC never reaches them. PIN, not FREEZE: the supersede always
> proceeds.
>
> **⚠️ THE AMENDMENT ABOVE RESTATES THE PREDICATE AS _"does an approved gate on
> this work item reference this `DesignEvidence` version?"_, AND THAT SENTENCE IS
> NOT IMPLEMENTABLE — the correction it is part of is what proves it.** A gate
> references its subject through `subject_id`, and a `pull_request_approval`
> gate's subject is a PULL REQUEST, not a design version. So the only gate that
> can be found "referencing this `DesignEvidence` version" is a `design_result`
> one — which is exactly the kind-keying the amendment was written to remove. The
> amendment's own governing sentence is the correct one and is what shipped:
> **when a work item carrying a current design result is approved, pin THAT
> version, whichever gate kind carried the decision.**
>
> **So the pin is a WRITE at decision time, not a JOIN at supersede time**, and
> the difference is not cosmetic. At the moment of the decision the product knows
> which version was current; at supersede time it can only know which gates
> exist, and for every kind but one those gates say nothing about design bytes.
> Writing the answer down is also what §6c already required for a second reason —
> _written in the same transaction as the decision_ — so the two halves of the
> rule turn out to be the same instruction.
>
> **What this buys, concretely:** the door contains no reference to a gate kind,
> and `pull_request_approval` inherits the pin the day MOTIR-4909 / MOTIR-4910
> register it, with no line of code in its handler.
>
> **First pin wins on any one row.** §6d's _per approved version_ accumulates
> across DIFFERENT rows; re-approving the SAME version keeps the timestamp of the
> decision that first bought the retention, rather than quietly re-dating it.

> ### §6c — SECOND AMENDMENT (MOTIR-5554, 2026-09-15): a DONE design card is CLOSED — it accepts no new version and gives up none
>
> **Decided by the requester (Yue, 2026-09-15).** Read on `origin/main` @
> `570ecd199`.
>
> **The question.** What happens when a design result is published, an upload
> grant is minted, or the current result is withdrawn, on a design card that is
> already `done`?
>
> **The options.**
>
> 1. **Keep _pin, do not freeze_.** The supersede always proceeds, so a `done`
>    card's current design can change. That was this section's rule, restated in
>    the comment above `DesignEvidence.pinnedAt` in `prisma/schema.prisma` and in
>    `designEvidenceService`'s supersede comments.
> 2. **A publish onto a `done` card moves it back to review.** Rejected: it puts a
>    status write on the publish path, and it lets an agent silently reopen a
>    decision a person made.
> 3. **Close the `done` card — CHOSEN.** The publish, the mint and the withdrawal
>    are refused. The way back is a person reopening the card by hand; after that,
>    today's behaviour applies.
>
> #### 1. The rule and its scope
>
> **A design card whose status is in the `done` CATEGORY accepts no new design
> result and gives up none.**
>
> - **The category, not the key.** `cancelled` is in the done category, so a
>   cancelled design card is closed too. A project that renamed its done status is
>   covered, because the category is resolved through the project's workflow and
>   never by comparing a key to the string `'done'` — the same predicate readiness
>   applies to a `blocked_by` edge (`isTerminalStatus`).
> - **The card's STATUS, never a gate.** A `done` design card whose result was
>   approved through a pull request raises no `design_result` gate at all
>   (`design-result.md` AMENDMENT 4 Q8), and it is closed exactly the same. A rule
>   keyed on the gate would miss the common case — the failure this section's
>   first amendment already recorded once.
>
> #### 2. The four acts, and the one refusal
>
> Each of these is refused on a closed card, and nothing is written — no evidence
> row, no asset row, no gate row, no supersede, no upload grant:
>
> | act                         | service method               | doors                                                           |
> | --------------------------- | ---------------------------- | --------------------------------------------------------------- |
> | publish inline              | `recordFromBytes`            | `publish_design_result` (`contentBase64`)                       |
> | publish by upload pathnames | `recordFromPathnames`        | `publish_design_result` (`pathname`) · `POST …/design-evidence` |
> | mint an upload grant        | `createUploadTokens`         | `create_design_upload` · `POST …/design-evidence/upload-token`  |
> | withdraw the current result | `withdrawCurrentForWorkItem` | `DELETE …/design-evidence`                                      |
>
> **One typed error, code `DESIGN_CARD_CLOSED`, HTTP 409** on the routes and a
> tool error carrying the same code on the MCP tools. Its message names **both
> ways forward**:
>
> - **reopen the card by hand** — the default workflow's `done → in_progress`
>   edge, a status change the card's history records; or
> - **propose a new design card beside the card that needs it, `relates_to` this
>   one** — when the old design did not cover something, rather than being wrong.
>   The closed card then stays as the record of what was decided.
>
> An agent told only _not allowed_ retries or improvises. One told these two
> things has two moves, and both leave a visible record.
>
> **The upload-grant mint is refused as well, although it writes no row**, for
> the reason the mint already refuses a card nothing waits on: a grant for a
> publish that can never succeed is bytes uploaded for nothing.
>
> #### 3. The race: a publish against the approval that closes the card
>
> A person can press Approve while an agent is still publishing. **The outcome is
> exactly one of the two, never both a new current version and a `done` status**,
> and it is reached by waiting under the lock order the two paths already share:
>
> **`approval_gate` → `design_evidence` → `work_item`.** That is the order
> `approvalGatesService.decide` takes — the gate `FOR UPDATE` (step 1), the pin's
> `design_evidence` lock (step 4), then the kind's effect, which transitions the
> card and locks the `work_item` row — and the publish path already takes the
> first two in that order (§6b's shipped note, the comment above
> `supersedeAwaitingByWorkItem`). **So the closed check reads the card's status
> AFTER the `design_evidence` lock, under a `work_item` row lock**, inside the
> publish's own transaction. Taking the `work_item` lock any earlier would
> reverse the last two locks against `decide` and deadlock precisely on the
> interleaving this rule exists for. The existing order is unchanged.
>
> The approval that CLOSES a card is §8's first arm — no open pull request, so
> approving writes `done`. (With a pull request open, approving writes `approved`
> and the merge writes `done`; part 7 below.)
>
> - **The approval wins** → the publish waits on the gate row (or on the
>   `design_evidence` row the pin holds), then reads a `done` status and is
>   refused. Nothing is written.
> - **The publish wins** → it commits a new version and supersedes the prior
>   version's `awaiting` `design_result` gate; `decide` then re-reads that gate
>   under its own lock and refuses it as `superseded`. The card is not `done`.
>
> The pre-checks the publish makes before it uploads are courtesies that stop a
> doomed publish writing orphan objects. **The read inside the transaction is the
> authoritative one**, exactly as for _does work wait on this?_. The withdrawal
> takes the same order — `design_evidence`, then `work_item`. The mint writes
> nothing, so its check needs no lock.
>
> #### 4. What is unchanged
>
> - **Every card that is NOT `done`.** Supersede, pin, retention, idempotency and
>   the gate lifecycle behave exactly as before. **The revise loop is untouched**
>   — publish, changes requested, publish again — because it runs before
>   approval.
> - **The pin.** An approval still pins the version it was given on; §6d's
>   _approvals accumulate_ still holds. A card approved, reopened and approved
>   again holds two pinned versions.
> - **Reopening.** §6d's lifecycle step 4 is now the ONLY way back: after a
>   person moves the card `done → in_progress`, it is open, a new version
>   publishes as it does today, and it is decided again.
> - **No status, no column, no migration.**
>
> #### 5. What it supersedes
>
> - **_PIN, do NOT FREEZE — a design legitimately evolves after approval_** —
>   struck above. Its replacement: **a design evolves after approval only once a
>   person reopens its card.**
> - **The divergence from the acceptance domain is RETIRED.** This section called
>   it deliberate: the acceptance gate refuses a republish over an approved
>   receipt (`AcceptanceEvidenceAlreadyApprovedError`, 409, MOTIR-2764) while the
>   design path kept superseding. The two now agree that a decided subject is not
>   silently replaced. They still differ in WHAT they key on — the receipt on its
>   own `approved` status, the design on its CARD's status — because a design
>   result has no status of its own, and a card can be reopened while a receipt
>   cannot.
>
> #### 6. Why
>
> The next story in this epic (MOTIR-5553) hands every agent run the current
> result of a `done` design card as _the approved design_. That reading is true
> only if the result cannot change while the card is `done`. Under _pin, do not
> freeze_ it could, and the card would still say the decision was made.
>
> #### 7. Deliberately NOT decided here
>
> - **A card at `approved` with an open pull request** — decided, but not yet
>   `done` until the merge (§2b). This rule closes the `done` category and nothing
>   else, so a publish in that window still supersedes, and after the merge the
>   card can be `done` with a current version nobody approved. Which version a run
>   is handed as _the approved design_ — the pinned one, or a closed `approved`
>   window — is MOTIR-5555's to decide; the finding is on that card.
> - **What an agent is handed from an approved design** — MOTIR-5553's own
>   decision card.
>
> #### Which card implements which part
>
> | part     | card                                                                                |
> | -------- | ----------------------------------------------------------------------------------- |
> | 1–3      | MOTIR-5556 — the refusal, `DESIGN_CARD_CLOSED`, every door, the in-transaction read |
> | 3, 4     | MOTIR-5558 — the approve → refuse → reopen → accept seam and the race, on Postgres  |
> | the walk | MOTIR-5559 — the browser E2E                                                        |

#### 6d. The reopen lifecycle, and why the guard keys on `awaiting`

**Yue:** _"if a design is approved, the card should be marked to done. Our agent
run will never be instructed to reopen the card again, but the project
management system is allowed to reopen the card, so the user may open the card
manually and run again, then the new design needs to be approved again, the old
approved design should be kept."_

1. A design result is published → a gate is created `awaiting`.
2. Approving records the decision, pins that version, and moves the design
   subtask `done`.
3. **No agent ever reopens that card** — a dispatched run is never instructed to.
4. **A person may**, through the ordinary board (`Done → In Progress`, a declared
   transition).
5. The new run publishes a new design result, which supersedes the old row and
   gets its own new gate, `awaiting`.
6. **Every previously approved version stays pinned. Approvals ACCUMULATE.**

**The pin is PER APPROVED VERSION, never "the approved one."** A card approved,
reopened and approved again holds two pinned sets, both fetchable. The naive
singular would silently destroy exactly the history this policy exists to keep.
The bound is human clicks, which is inherently small.

**A guard on manual status changes keys on `awaiting`, not on "a gate exists"** —
which is what makes the reopen legal: after approval the gate is `approved`, so
a person reopening the card is not blocked by the decision that already
happened. ~~That guard is a sibling story, not this record's to ship.~~
**AMENDED 2026-09-14 (MOTIR-5522):** the guard is still built by a sibling
story (MOTIR-4887), but its RULES are now this record's, in the amendment
directly below. Build to them.

> ### §6d — AMENDMENT (MOTIR-5522, 2026-09-14): the manual-flip GUARD, the withdraw, the re-ask, and the lock order
>
> **Why the rules are written here and not on the cards.** Five cards under
> MOTIR-4887 change `applyStatusTransition` — the funnel every status change
> passes through — or render what it refuses. Each needs the same answers: which
> move a gate holds, how its own approval gets through, when pulling work back
> withdraws the question and when coming back asks it again, and in what order
> rows are locked. Stated once, here, those cards build to one contract rather
> than to each other's guesses. Read on `origin/main` @ `cc09db183`.
>
> #### 1. What a gate OWNS is the registry's answer, resolved per project
>
> A gate owns the status its kind's `GateHandler.statusIntent`
> (`lib/approvalGates/registry.ts`) resolves to in the item's project — **key
> first, then category**, the same rule `workflowsService.resolveStatusKey`
> applies for the decide door. Three things own NOTHING:
>
> - **A `null` intent** — `pull_request_merge` (§4), where the webhook is the one
>   writer of `done`.
> - **A kind this build does not register** (`isRegisteredGateKind` false). Such
>   a row has no door it can be decided through, so refusing its move would
>   strand the card with no way forward.
> - **An intent the project's workflow cannot resolve** — a custom workflow with
>   no status of that key or category. There is nothing to hold.
>
> **Never a `design_result` literal.** The guard reads the handler, so the next
> kind (`pull_request_approval`, the acceptance receipt) is covered the day it
> registers, with no line of guard code.
>
> _Why:_ the kind already declares what approving it moves. A guard with its own
> list of kinds and statuses is a second declaration, and the two drift.
>
> #### 2. The key is `awaiting`
>
> Only an `awaiting` gate refuses. `approved`, `changes_requested` and
> `superseded` refuse nothing.
>
> _Why:_ this is what keeps the reopen path above legal. After approval the gate
> is `approved`, so a person reopening the card is not blocked by a decision that
> already happened; a `changes_requested` gate has already sent the work back;
> a `superseded` one asks nothing.
>
> #### 2b. It is about whether there is a PULL REQUEST — with one open, `approved` and `done` each have ONE writer — ADDED 2026-09-14 (Yue)
>
> **Yue:** _"when the design work item has a linked PR, approve the design should
> change the status to approved, and merge should be auto triggered or auto
> enqueued, webhook changes approved to done after PR merge. if no PR, the work
> item status will be changed to done after approving. so it's about if there's a
> PR. if there's a PR, the design gate is actually gone, approval gate is the
> trigger merge gate like any other regular PR"_ — and, of this story's guard:
> _"not only done is blocked, approved manual set should be blocked too."_
>
> | the work item has…                  | the decision…                              | `approved` is written by                     | `done` is written by  |
> | ----------------------------------- | ------------------------------------------ | -------------------------------------------- | --------------------- |
> | **no open pull request**            | the kind's own gate (e.g. the design)      | —                                            | **approving**         |
> | **an open delivering pull request** | the approve-to-merge gate (§1, MOTIR-4909) | **approving**, which also merges or enqueues | **the merge webhook** |
>
> So, beside rule 1's hold on an `awaiting` gate's owned status, **while the item
> has an OPEN delivering pull request a hand move INTO `approved` is refused unless
> it is the deciding gate's own write, and a hand move INTO the done category
> (Cancelled excepted) is refused outright.** Same code, `APPROVAL_GATE_PENDING`:
> `waitingOn: 'decision'` for `approved`, `waitingOn: 'merge'` for `done`. The
> payload's `canDecide` is true only when a gate is actually awaiting a decision —
> never for the merge wait, and never while the pull request is open but not yet
> green, when no gate has been raised (the refusal then names the
> `pull_request_approval` kind with no gate id).
>
> - **Checked BEFORE rule 1**, because with a pull request open the answer to
>   "what is Done waiting for?" is the merge, whichever gate rows exist.
> - **The merge itself passes.** The status sync commits its pull request as
>   closed before it transitions the card, so it sees no open delivery (and a
>   sibling still open is already `deferred_open_pr`).
> - **System writes are exempt**, and the parent rollup treats the refusal as a
>   logged no-op (`approval_pending`) — a derivation must not take either status
>   from its writer, nor fail its job trying.
> - **Every other move stays open**, as rule 3 says.
> - **Not decided here:** the approve-to-merge gate itself, the `approved` write
>   and the merge or enqueue (MOTIR-4909 / MOTIR-4882), and a design card with a
>   pull request raising no `design_result` gate (MOTIR-5534). This rule is the
>   guard's half of that model and holds whichever of them has landed.
>
> #### 3. Exactly ONE move is refused per gate: the move INTO the owned status
>
> Every other move the workflow declares stays legal — `→ in_progress`,
> `→ blocked`, `→ cancelled` — and re-assignment and every field edit are
> untouched. The refusal is placed with `applyStatusTransition`'s two sibling
> gates (the artifact-evidence gate and the container-completeness gate), AFTER
> the legal-edge check.
>
> _Why:_ a pending decision must not make the card unusable. A guard that holds
> more than the one move the decision itself performs teaches people that
> approvals get in the way, and the next request is to turn them off.
>
> #### 4. The refusal has its own code, `APPROVAL_GATE_PENDING`
>
> Not `ILLEGAL_TRANSITION`: the edge IS legal, and a caller told otherwise goes
> and edits their workflow. `ContainerHasOpenChildrenError`
> (`lib/workItems/errors.ts`) makes the same argument for its own code.
>
> - **`/api/v1`** answers **422**, beside the other refusal codes on the
>   transitions sub-resource.
> - **The board move** (`POST /api/board/move`) answers **409 carrying `code`**,
>   so the board can tell it apart from an illegal edge and render it in place.
> - **Every door carries one payload** — `{ itemKey, kind, canDecide,
routedToLabel }` — with `canDecide` computed as the Approvals read computes
>   it (the permission floor AND §2's authority), so a surface never offers a
>   door that would refuse the person pressing it.
>
> #### 5. Two exemptions, and only two
>
> - **`opts.system` writes** — the importer, the downward cascade, the parent
>   rollup — exactly as both sibling gates in `applyStatusTransition` are scoped.
>   None of them is a person deciding the work is finished.
> - **The deciding gate's OWN effect.** `approvalGatesService.decide` runs the
>   kind's effect (step 5) BEFORE it writes the decision (step 6) — the order
>   MOTIR-5046 set so `outcome_ref` is written in the deciding write. So the gate
>   is still `awaiting` at the moment its own approval writes `done`. The door
>   passes THAT gate's id (`decidingGateId`), and the guard skips that gate and
>   no other: a second `awaiting` gate owning the same status still refuses.
>
> _Why:_ without the second exemption, approving a gate is refused by the guard
> the gate exists to protect, and approval breaks the day the guard ships.
>
> **A consequence, not a third exemption (recorded by MOTIR-5526, 2026-09-14): a
> MERGE is a door like any other.** `changeRequestStatusSync` moves a card
> through `workItemsService.updateStatus`, which is neither `system` nor a
> deciding gate, so a pull request that merges while a gate owning `done` is
> still `awaiting` is HELD — outcome `approval_pending`, with a note on the card
> saying so. Nothing is stranded: with the pull request merged, approving the
> gate finds no open delivery and writes `done` itself (§8's first arm). That is
> the order the gate exists to enforce — the decision, then the status — and a
> merge that skipped it is exactly the walk-around this amendment closes.
>
> #### 6. Pulling the work back WITHDRAWS the question
>
> A move that is not `opts.system`, and is either of:
>
> - a move from a status ranked at or above `in_review` (`rankOfStatus`,
>   `lib/workItems/statusLadder.ts`) to one ranked below it, other than the
>   status keyed `blocked`; or
> - any move to the cancelled status,
>
> **supersedes the item's `awaiting` gates**, in the same transaction as the
> move. **A PERSON's move, not the product's lifecycle:** the merge status sync
> moving a card out of review because one of its pull requests closed passes
> `keepPendingQuestions` and withdraws nothing here — it withdraws merge gates BY
> SUBJECT itself (MOTIR-4882), and a blanket withdraw would take a sibling pull
> request's question with it. **`→ blocked` does not:** blocking pauses the work, it does not abandon
> the question. The supersede writes `state` and nothing else, exactly as §6b's
> publish-path supersede does — no actor, no note, no `decided_at` — so the audit
> still cannot read a withdrawn question as a decision. Who pulled the work back
> is recorded where it already is: the work item's own status revision.
>
> _Why:_ a person who takes the card out of review has answered the question by
> other means. Leaving it `awaiting` would keep it in somebody's Approvals queue
> asking about work that is no longer on offer — and, under rule 3, would hold a
> move on a card that is no longer anywhere near it.
>
> #### 7. Entering review ASKS AGAIN
>
> **Any move INTO `in_review`**, whoever makes it, raises a fresh `awaiting`
> gate when both hold:
>
> - the item's kind resolves a CURRENT subject (a registry seam every registered
>   kind supplies; for `design_result`, the item's current design result); and
> - that subject has no `awaiting` or `approved` gate.
>
> The CI-green promotion (`lib/services/ciPromotion.ts`, which moves a card to
> `in_review` through `workItemsService.updateStatus`) is exactly the return to
> review this rule is for. The importer and the rollup reach cards with no
> current subject, so they raise nothing whatever their context.
>
> _Warrant:_ the story's own outcome. Without this rule, withdraw-then-re-enter
> leaves a card with no gate, and that card can be moved to Done by hand — the
> precise walk-around MOTIR-4887 exists to close.
>
> _Mirror, as corroboration only:_ Jira Service Management starts a new approval
> round when an issue is transitioned back into its approval step — _"an approval
> round is started and the approvers list is populated from the defined field
> when the issue is subsequently transitioned to the 'Needs Approval' workflow
> step"_ ([Atlassian Support — _How to automatically update Jira Service
> Management Approvals when Assets approvers change_](https://support.atlassian.com/jira/kb/how-to-automatically-update-jira-service-management-approvals-when-assets-approvers-change/),
> read 2026-09-14). The rule stands on the warrant above; the mirror agrees.
>
> **Rules 6 and 7 are ADDITIONAL triggers, not replacements.** MOTIR-5482
> raises and withdraws the pull-request gate on its own triggers (a delivery set
> turning green, a head moving); those stand.
>
> #### 8. Lock order: gate rows first, then the work item — on every transition
>
> The decide door locks the gate `FOR UPDATE` (step 1) and then, through the
> kind's effect, transitions the item, which locks the work item
> (`workItemRepository.lockById`). A funnel that locked the item first and then
> reached for the gate to supersede it (rule 6) would take the same two locks in
> the opposite order: a deadlock on exactly the interleaving where a person
> approves while another pulls the card back. **So the funnel locks the item's
> `awaiting` gate rows BEFORE the work item**, matching the door — the same
> argument §6b's shipped note makes for the publish path's supersede preceding
> the `design_evidence` lock. The race then resolves by waiting, onto one of two
> legitimate outcomes: the approval wins and the pull-back is an ordinary move
> off an approved card, or the pull-back wins and the decide door refuses a
> `superseded` gate.
>
> #### 9. Deliberately NOT decided here
>
> - Any notification on a withdraw or a re-ask.
> - Any new surface for a withdrawn record.
> - The acceptance receipt, which inherits all of the above when MOTIR-4949
>   registers its kind.
>
> #### Which card implements which rule
>
> | rules        | card                                                                                       |
> | ------------ | ------------------------------------------------------------------------------------------ |
> | 1–5, 2b      | MOTIR-5526 — the guard, `APPROVAL_GATE_PENDING` and its payload on every door              |
> | 6 and 8      | MOTIR-5527 — the withdraw, and the lock order                                              |
> | 7            | MOTIR-5532 — the re-ask, and the current-subject registry seam                             |
> | the surfaces | MOTIR-5528 — the item page, quick view and edit page · MOTIR-5529 — the board and the list |

### 7. `prMergeMode` — DECIDED BY THE PLANNER, tier and rename BY THE REQUESTER (Yue, 2026-09-08)

**`Workspace.subtaskPrMergeMode` becomes `Project.prMergeMode`**, and
`enum SubtaskPrMergeMode` becomes `PrMergeMode`.

- **The RENAME**, because a pull request is no longer a subtask's: a parent run
  opens ONE pull request for a whole story and links the parent. A field name
  encoding a retired cardinality is what the next reader will trust.
- **The TIER MOVE**, because a merge policy is a property of a codebase and its
  team, and a workspace holds several projects with different ones — and because
  a gate is scoped `workspaceId` + `projectId`, so reading a workspace column to
  decide a project's card is a tier mismatch.
- Both are nearly free **today**: the column has no functional reader, and will
  have one the moment §4 ships.

| value                    | behaviour                                                                                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`manual`**             | a `pull_request_merge` gate IS created; a person decides it. The default for a project whose repositories are imported                                                                                                             |
| **`auto`**               | **no gate is created.** The default for a project established with Motir-hosted repositories                                                                                                                                       |
| ~~**`review_on_fail`**~~ | ~~**RESERVED and UNIMPLEMENTED.** It behaves as `manual`. Stated here rather than left to be discovered; the enum value ships to avoid a later Postgres enum `ALTER`~~ — **RETIRED 2026-09-13, see the amendment below (point 4)** |

**The DEFAULT is derived from repository PROVENANCE, and it is a default rather
than a law.** A project established with Motir-hosted repositories seeds `auto`;
anything else seeds `manual`. It cannot be a law because
`lib/projectRepos/roomSections.ts` renders the Motir-hosted set and the
organisation's repositories as two sections of one project — a project can hold
both, so a provenance law for one would silently govern the other. The setting
overrides in either direction, which is what makes the deep link from the
approval surface meaningful: someone who defaulted to `manual` and cannot read a
diff can reach the switch that stops asking them.

#### 7 · AMENDED 2026-09-13 (MOTIR-5174) — WHEN the default is written, what a MIXED project gets, and what retiring the old column costs

§7 above decides the rename, the tier and that the default follows provenance.
It left three things unsaid, and Story MOTIR-4880's cards build on all three.
They are settled here, so every card reads one record rather than three plan
summaries. **One row above is struck**: `review_on_fail` is retired (point 4).

**1. The default is written at ESTABLISHMENT, not at `project.create`.** A
project row exists before it has any repositories. `projectRepository`'s create
runs long before the _"where should your code live?"_ step, whose read model is
`lib/services/projectRepoEstablishService.ts` and whose rows
`lib/services/projectRepoSetService.ts` owns. At `create` there is no provenance
to read, so the provenance default **cannot be a column `@default`**. The column
default (`manual`) is a FLOOR: it is what a row holds until something decides
the value.

- **The moment.** A project is ESTABLISHED the first time its repository set
  holds at least one row and every row is settled (`created` / `connected` /
  `skipped` — `transitions.isSettledState`, the ADR §4.1 machine's own
  definition). The check runs at the seams that settle a row or append a settled
  one: `projectRepoSetService`'s `attachRealizedRepo` (the `created` and
  `connected` hops) and `transitionRow` (the `skipped` hop), and
  `organizationRepoService`'s `linkRealized` / `connectAndLink`. Those two write
  a `connected` organisation row directly, and they are how a project connected
  to its organisation's repositories gets its set.
- **ONCE, and a stamp says whether it has happened.** `Project` carries a
  nullable `prMergeModeDecidedAt`. Null means nothing has decided the value yet
  and the floor stands. Deriving the default writes the value AND the stamp,
  under the project row's lock, and only where the stamp is null. A person
  changing the setting writes the stamp too. So later events never re-derive
  the value: re-establishing, adding a hosted repository to a `manual` project,
  or removing a row and settling the set again. **A value a person holds is
  never overwritten by a default.** Without the stamp, a floor `manual` and a
  chosen `manual` are the same bytes.
- **The backfill stamps established projects only.** The migration that adds
  `Project.prMergeMode` copies each project's workspace value, so nobody's
  effective answer changes on the day it lands. It stamps
  `prMergeModeDecidedAt` only on a project that already holds a settled row. A
  project that was already established never has an establishment event to wait
  for, so it keeps the carried value. A project that has not established yet
  gets the provenance default when it does. Nobody could have chosen the carried
  workspace value: the column was never rendered and never read.

**2. The rule is total. A MIXED project and an EMPTY one both seed `manual`.**

| the set's REPOSITORIES at establishment (a `skipped` row has none, and is ignored) | seeds    |
| ---------------------------------------------------------------------------------- | -------- |
| at least one, and **every** one is Motir-hosted                                    | `auto`   |
| at least one is not Motir-hosted — imported, or MIXED with hosted ones             | `manual` |
| **none** — an empty set, or every row `skipped`                                    | `manual` |

**Why the mixed case falls to `manual`, for a reader who never opens the code:**
asking a question nobody needed costs one click, but merging into somebody's
own repository without asking costs their trust. So Motir stops asking only when
every repository in the project is one it hosts.
§7's own argument, that a project can hold both sections
(`lib/projectRepos/roomSections.ts`), is exactly why a project that is not
wholly Motir's must not be governed by the hosted default.

**Provenance is `isMotirHostedOwner` (`lib/git/hostOwnership.ts`) and nothing
else**, composed over each realized repository's owner login with the
`hostOwner` the server resolves once (`provisioningOrgLogin()`). **Do not
re-spell the comparison.** Bug MOTIR-4892 found three surfaces spelling it three
times and disagreeing about one row, which is the whole reason that module
exists. `hostOwner: null` classifies nothing as hosted, so a deployment that
cannot provision seeds every project `manual`. That is the correct answer, not a
degraded one.

**3. Retiring `Workspace.subtaskPrMergeMode` takes THREE releases, and so it is
not in this story.** An expand/contract removal is normally two phases: move the
readers, then drop the column. Here that is one phase short, **because the
Prisma datamodel declaration is itself a reader**. A client asked for a
`Workspace` without a `select` fetches every field the model declares, and the
declaration is removed by the same commit that drops the column. The migration
is applied before the new build takes traffic, so a two-phase retirement leaves
the still-serving build selecting a column that is gone for the whole rollout. A
search for the field's name cannot find that reader, because no line names it.
The phases:

| release | what ships                                                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**   | Story MOTIR-4880: every application reader moves to `Project.prMergeMode`. The workspace column and its Prisma field both STAY                                 |
| **2**   | the field leaves the generated client while the column stays in the database, deployed on its own, so a build that neither selects nor names it serves traffic |
| **3**   | the column is dropped                                                                                                                                          |

Releases 2 and 3 are Story **MOTIR-5175**, `blocked_by` MOTIR-4880.

**Completed (2026-09-19).** The three phases shipped as MOTIR-4880 (readers),
MOTIR-5505 (`@ignore`, in Story MOTIR-5175) and MOTIR-5508 (the drop, migration
`20260919150000_drop_workspace_subtask_pr_merge_mode`, whose marker is
`-- @client-stopped-selecting: MOTIR-5505`). Between phases 2 and 3, MOTIR-5506
read the platform at 2026-09-19T13:58:48Z. Fly release **v595** was `complete`
and served by all four `motir-core` machines (app ×2, worker, standby worker)
from one image whose `GH_SHA` is **`5ce9c84ecfe96cb90394238367c62f5cb3d2e0f2`**.
That commit contains MOTIR-5505's merge `6dccc212f` and declares the field
`@ignore`. The column no longer exists, and the `pr_merge_mode` type stays
because `Project.prMergeMode` uses it.

**4. `review_on_fail` is RETIRED, not reserved (Yue, 2026-09-13).** Only a
**green** pull request is ever a merge candidate, in every mode. A red pull
request never reaches In Review: it belongs to the run's fix loop, and when that
loop gives up the work item is stuck, which is not an approval. So a mode that
"asks when checks fail" would put a merge approval on broken code, and no
meaning survives its name. The reason it was reserved had the cost backwards:
adding a Postgres enum value later is a cheap `ALTER TYPE … ADD VALUE`, and
**removing** one is the expensive direction.

- `PrMergeMode` is `auto | manual`. The migration that renames the type
  (`20260913120000_project_pr_merge_mode`) rebuilds it without the retired
  member, mapping any workspace that held it to `manual`, which is how it
  behaved.
- The two modes, stated against the lifecycle: **`manual`** — a person approves
  a green pull request before it merges; **`auto`** — Motir merges a green pull
  request with no gate.
- A future mode that needs a third value (e.g. _merge automatically unless the
  run had to repair its own checks_) is added then, as its own decision.

#### 7a. What the audit trail says when `auto` means no gate — DECIDED BY THE PLANNER (rung: Yue's own §6c principle)

`auto` creates no gate, which is correct and means **no human was in the loop for
that merge**. An audit must be able to say that explicitly: _"no record"_ and
_"no human reviewed this"_ must not read the same.

**An earlier draft of this record recommended writing a terminal
`auto_approved` gate. That recommendation is WITHDRAWN**, because it contradicts
the principle Yue set in §6c: the gate table records **a person saying yes**, and
an automatic merge is not a person saying yes. A synthetic approval row would put
a decision nobody made into the one table an auditor trusts to contain only
decisions people made.

**Instead: the MERGE record carries the authority it merged under.** The
`work_item_delivery` / pull-request row records that the merge was performed by
Motir under `prMergeMode: auto`, with no gate. The gate table stays exactly what
it claims to be, and the audit answers _"who authorised this?"_ with _"the
project's merge mode, not a person"_ — which is a true and legible answer rather
than a fabricated approval.

**This is the one decision in this record that the requester has not
confirmed.** It follows from their stated principle and is recorded as the
planner's reading of it; it is cheap to reverse before MOTIR-4882 ships.

### 8. THE TWO WORKFLOWS — NEW (MOTIR-4911, 2026-09-08), DECIDED BY THE REQUESTER (Yue, 2026-09-08)

**This section is the record's own statement of the model, not a pointer at
one.** It was settled in conversation and would otherwise live only in a plan
summary — which is read once, by whoever approves it, and then archived. A
decision record is read by everyone who builds against it, months later, and the
two workflows are the thing they will need most. §3, §4 and §6b are consequences
of what is stated here.

**The defect it fixes: approval and the merge were both trying to write `done`.**
§3 said approving flips the design subtask `done`; the shipped status sync says
the merge flips the card `done`. Both cannot be the single writer, and
_"approved but still `in_review`"_ is what that collision looks like from the
board.

**APPROVAL IS A TRIGGER, NOT A STATUS WRITE.** What it triggers is decided by one
question, asked once.

#### The discriminator: does the work item have a linked OPEN pull request?

**It is READ, never configured.** The answer comes from the work item's own
**delivery rows** — `work_item_delivery` joined to the pull request's `state`,
the same set `countOtherOpenByWorkItem` already counts for the
`deferred_open_pr` defer. There is no setting, no field on the card, and nothing
for a planner to get wrong: a card that opened a pull request has a delivery row
because `link_pull_request` wrote one, and a card that never will has none.

_(`prMergeMode` (§7) is a different question and does not enter here. The
discriminator asks whether a merge is COMING; `prMergeMode` asks whether a PERSON
decides it. `auto` still merges, so `done` still comes from the merge.)_

#### WORKFLOW A — no pull request

```
implemented → in_review → [ design_result ] → done
                           approve is TERMINAL
```

~~`implemented → in_review → [ design_result | decision_approval ] → done`~~
**AMENDED (MOTIR-5672, 2026-09-19): a decision never takes Workflow A.** Its
pull request is MANDATORY, so a merge always writes its `done` (§8's FIFTH
AMENDMENT, clause 2). The diagram above is the struck line with
`decision_approval` removed and nothing else changed.

| #   | event                             | actor      | status        |
| --- | --------------------------------- | ---------- | ------------- |
| 1   | the subject is published          | agent      | `implemented` |
| 2   | the gate is created `awaiting`    | product    | `in_review`   |
| 3   | **Approve** — records, pins (§6c) | **person** | **`done`**    |
| 3′  | _or_ **Request changes**          | person     | unchanged     |

**Nothing will ever merge, so nothing else would write `done`. Approval writes
it**, and that is why §3's rule is conditional rather than simply reversed.

#### WORKFLOW B — a pull request exists (design and code, IDENTICALLY)

| #   | event                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | actor                                                                                 | status         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------- |
| 1   | the agent opens the pull request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | agent                                                                                 | `implemented`  |
| 2   | CI goes green                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | CI, server-side                                                                       | `in_review`    |
| 3   | ~~**both** gates created `awaiting` — `pull_request_approval` and `pull_request_merge`~~ **ONE gate created `awaiting` — `pull_request_approval`** (§8's second amendment, MOTIR-5609)                                                                                                                                                                                                                                                                                                                                                                                | product                                                                               | —              |
| 4a  | **"Approve and merge" in Motir** — ~~decides BOTH gates in ONE transaction~~ **commits the approval FIRST, then merges or ENQUEUES each pull request after that commit, deciding each merge gate only on success** (§8's amendment, MOTIR-5479, decision 5)                                                                                                                                                                                                                                                                                                           | **person**                                                                            | **`approved`** |
| 4b  | _or_ **EVERY** pull request the card delivers is approved **IN GITHUB**, each at its current head, by a reviewer with write access → ~~syncs the approval gate only; the **merge gate stays `awaiting`**~~ **decides the card's ONE gate — and the merge follows it, per member, after the decision commits** (§8's second amendment for the one gate; what a review decides is §8's FOURTH amendment, MOTIR-5590 — the set rule, which reviews count, the synced actor and its `github_review` authority). One member of several approved leaves the gate `awaiting` | **GitHub reviewer** (recorded as a member, or as `@login` when Motir cannot map them) | **`approved`** |
| 5   | merge — or ENQUEUE, where the repository has a merge queue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | product, after either 4a or 4b — ~~a second press (4b)~~                              | —              |
| 6   | the merge lands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | webhook                                                                               | **`done`**     |

**Design and code take the SAME rows.** A design card that opened a pull request
— one or many — is Workflow B; only its PORT differs: the Development block shows
the design result once (the mock(s) with the note as a link), then How to test,
then every pull-request row, ~~and no `design_result` gate is raised for the card
(`design-result.md` AMENDMENT 4 Q8)~~ **and the card ALSO holds its own
`design_result` gate, which is the PRIMARY question the block is a port for**
(`design-result.md` AMENDMENT 6 Q1, MOTIR-5658).

> ### WORKFLOW B — AMENDMENT (MOTIR-5658, 2026-09-17): a DESIGN card in Workflow B holds TWO gates, and row 4a's press decides both
>
> The rows above are unchanged for a code card. **A design card with a published
> result additionally holds a `design_result` gate, presented as the PRIMARY**,
> with the pull requests beneath it as what the approval will merge. Row 4a's one
> press decides both; rows 5 and 6 are unchanged.
>
> **Row 2 is not a precondition of the design half.** The `design_result` gate
> rises at PUBLISH, so it can exist — and be pressed — before CI has spoken.
> **The merge is then HELD until green** and follows on the next green verdict
> with no second press (AMENDMENT 6 Q4). `done` still has exactly one writer.
>
> **And when a merge FAILS after row 4** — an ejection, a conflict, a failed
> validation — **the merge gate re-opens ALONE and the design gate stays
> decided** (AMENDMENT 6 Q2). A decided design gate also CLOSES the design:
> publish, upload and withdraw are refused on that card whatever its status, so a
> failure after approval can only be about the commits (AMENDMENT 6 Q3).

~~**Row 4b is WHY there are two gates rather than one.** A GitHub approval tells
Motir the code was approved and **nothing else** — it is not a merge, and
treating it as one would merge on somebody's review. And the audit needs two rows
regardless: **if one person approves in GitHub and another merges in Motir, that
is two decisions by two people, and one row could not record it.**~~

**⚠️ STRUCK by §8's SECOND AMENDMENT (MOTIR-5609, 2026-09-16), and kept visible
because it was a considered position rather than an oversight.** The product
owner has decided that approving a card's pull requests IS the instruction to
merge them, so the two gates asked one question twice. The case this paragraph
defends — a GitHub approval that is not a merge — was never built:
`githubWebhookService` has no `pull_request_review` arm. What a synced approval
does under one gate is decided by MOTIR-4910, and recorded by **§8's FOURTH
AMENDMENT (MOTIR-5590) below** — which builds the arm this paragraph says was
never built, and answers the audit worry it raises: one row, naming the reviewer
who completed the set, with the merge following the same decision rather than a
second press.

**`decisionSource` gains `github` for row 4b**, and the approving actor may be a
GitHub identity Motir cannot map to a member — §6b's amendment says what the
record holds then, and why a null FK would be the wrong answer.

> ### §8 — AMENDMENT (MOTIR-5479, 2026-09-15): the APPROVE-AND-MERGE gate — hung on the run target, about its delivery SET, raised on green, withdrawn by a moved head, and _Approve and merge_ recorded as the approval first, then a merge per pull request
>
> **What was OPEN.** §1's amendment names `pull_request_approval` and gives it
> _"**any** card **with a pull request**"_; §2 says who may press; row 3 says the
> gates are raised on green; row 4a says one press decides both gates. Nothing
> said what this gate is ABOUT when a card has several pull requests, when it
> goes away, or how a press that has to call a host is recorded by a door that
> runs in one transaction. Six cards of Story MOTIR-4909 build against those
> answers, so they are written down once, here. **Everything else in §8
> stands**: this block adds to it, strikes one cell (row 4a, above), and
> supersedes two cards' wording (decision 3).
>
> **Read at base `f174964e6`.** It is the approval half of the pair §4's second
> amendment (MOTIR-5510) is the merge half of. Where the two meet — decision 5
> here, decision 4 there — they say the same thing, and this block edits no line
> that one wrote. It is also written to merge in either order with MOTIR-5522's
> §6d amendment (open as a draft on `parent/MOTIR-4887-gate-owns-status`); see
> decision 3's last paragraph.
>
> **1. WHERE it hangs — the RUN TARGET** (rung 2: the shipped run-target
> resolution). The gate hangs on the work item the delivering run was launched
> against: `resolveRunTarget` (`lib/services/runTarget.ts`), the one resolution
> `howToTestService.getForWorkItem` returns as `runTarget` and §4's merge gates
> already hang on (`lib/services/mergeGates.ts`, via `resolveRunTargetFor`). **A
> child card the same pull requests also deliver gets NO gate.** Its Development
> card shows _Tested as part of_ the target instead (`design/github/design-notes.md`
> §20, Panel 12m; `howToTestService`'s `tested_via_ancestor` state). This narrows
> §1's amendment row to the run target, exactly as §4's second amendment,
> decision 1, narrows it for the merge gate.
>
> **2. WHAT it is about — the delivery SET, at its commits** (rung 2: the shipped
> uniqueness key). The subject is every pull request the run target's
> `work_item_delivery` rows name.
>
> - **`subjectId` is the work item's own id.** The partial unique index
>   `approval_gate_one_awaiting_per_subject` over
>   `(work_item_id, kind, subject_id) WHERE state = 'awaiting'`
>   (`prisma/migrations/20260908210000_add_approval_gate/migration.sql:91-93`)
>   then enforces _one awaiting approve-and-merge gate per card_, with no new
>   index.
> - **`subjectVersion` is the set written canonically**: each member as
>   `owner/name#number@headSha` — the per-member form a merge gate's
>   `subjectVersion` already uses — sorted, and comma-joined. The row then says
>   _these commits_ rather than _these pull requests_, which is §6a's first audit
>   row.
>
> **3. WHEN it is raised — the all-green verdict, in a `manual` project** (rung 2:
> §8 row 3, the shipped promotion, §7a). It is raised on the verdict
> `lib/services/ciPromotion.ts` computes in `everyDeliveryIsGreen` for the run
> target's set, and only when the project's `prMergeMode` is `manual`. It is
> raised at the same two moments as §4's merge gates: in the promotion's own
> transaction (`settleGreenVerdict`), and for a card already in review
> (`reRaiseMergeGates`). In `auto`, Motir merges without a person (§4's second
> amendment, decision 9), so a gate would sit in somebody's To-approve tab while
> the merge happened anyway. §7a's rule — no synthetic approval row — is why
> nothing is written instead.
>
> **This SUPERSEDES, by quotation, the "created when the pull request is linked"
> wording.** MOTIR-4910's scope boundary said the pull-request gates _"are
> created when the pull request is linked"_, and MOTIR-4793's sealed body
> _"created the gate when a pull request was LINKED"_. Both cards were corrected
> on the record on 2026-09-14, and the second is also superseded for the merge
> gate by §4's second amendment, decision 2. A link is not a verdict: a gate
> raised on it would ask a person to approve code CI has not judged.
>
> **If §6d's re-ask rule lands** (MOTIR-5522, rule 7: _entering review ASKS
> AGAIN_, through a current-subject seam every registered kind supplies), **this
> kind's current subject EXISTS only when decision 3 holds**: the run target's
> set is green and its project is `manual`. A hand move into `in_review` over a
> red set then raises nothing, and one rule answers when this gate is asked,
> whichever record merges first.
>
> **4. WHEN it is withdrawn — a moved head, or a changed set** (rung 2: §6b's
> `superseded`, written by the product). The awaiting gate is set `superseded`
> when any member's head moves, when a member closes, or when a delivery row
> joins or leaves the run target's set. The write sets `state` and nothing else,
> as §6b's shipped note requires. The next all-green verdict raises a fresh gate
> over the new `subjectVersion`.
>
> **Why a withdraw needs its own trigger: the card never leaves `in_review` on a
> push.** Nothing moves a work item back when its pull request gains a commit.
> Re-run at this amendment's base:
>
> ```sh
> git grep -n -i "demot" f174964e6 -- lib/services
> ```
>
> It returns **10 hits in 5 files, and none is a work-item status**:
>
> | file                                            | lines              | what it demotes                            |
> | ----------------------------------------------- | ------------------ | ------------------------------------------ |
> | `lib/services/organizationsService.ts`          | 432, 434, 761, 765 | an organisation owner's role               |
> | `lib/services/projectMembersService.ts`         | 286, 288, 290      | a project member's role                    |
> | `lib/services/projectAccessService.ts`          | 327                | project members to their workspace role    |
> | `lib/services/ciRunnerBootService.ts`           | 697                | a comment on a runaway guard, not a status |
> | `lib/services/codeGraphIndexDispatchService.ts` | 1748               | a comment on a runaway guard, not a status |
>
> So a raise keyed on the `implemented → in_review` transition alone would fire
> once and never again. That is why §4's merge gates already carry a second raise
> arm for cards in review (`reRaiseMergeGates`, MOTIR-5515), and why this gate
> rides both arms (decision 3).
>
> **5. HOW _Approve and merge_ is recorded — row 4a is amended on the record**
> (rung 2: the shipped decide door, and §4's merge entry point). Row 4a said the
> press _"decides BOTH gates in ONE transaction"_. The shipped record makes that
> impossible for the merge gate, whose outcome is not known inside the
> transaction:
>
> - §4 attempts the merge and renders a refusal rather than recording one;
> - §6a writes `outcome_ref` in the deciding write
>   (`approvalGatesService.decide`, step 6: `outcomeRef: effect.statusWritten`);
> - `trg_approval_gate_decided_immutable`
>   (`prisma/migrations/20260910120000_approval_gate_audit_columns/migration.sql:138`)
>   refuses any later edit of a decided row;
> - and `decide` is one transaction in which _"nothing external happens"_.
>
> **Row 4a's AUDIT promise is kept — one person's decision, at one instant,
> naming the commits — and its MECHANISM is replaced:**
>
> - **(a) The approval commits FIRST.** `decide` runs on the
>   `pull_request_approval` gate in the door's own transaction, and the card moves
>   `in_review → approved`. A refusal the door already raises (not authorised,
>   already decided, superseded) ends the press, and nothing is merged or queued.
> - **(b) Each pull request is then handed to §4's merge entry point, AFTER that
>   commit and outside any transaction** — `pullRequestMergeService.approveMergeGate`
>   (MOTIR-5517), in `subjectVersion`'s canonical order. **That path MERGES it,
>   or ENQUEUES it where the repository has a merge queue** (§8 row 5: _merge — or
>   ENQUEUE_; §4's second amendment, decision 6). Every member is attempted: a
>   refusal on one does not stop the next, because the approval covers all of
>   them.
> - **(c) Each `pull_request_merge` gate is decided only once that path reports
>   success.** It carries the approval's `decidedById`, its `decisionSource`, and
>   the approval's `decidedAt` as its own — the press instant, supplied rather
>   than stamped again, so the rows of one press agree. The shipped door stamps
>   `decidedAt: new Date()` itself, so the press adds an internal input that only
>   its own service may pass (MOTIR-5483). **Its `outcomeRef` is `null`.**
>   `outcome_ref` is the status KEY the decision applied, and the item page paints
>   it as one: `OptimisticStatusProvider.tsx` reads `ApprovalGateDTO.outcomeRef`
>   as _"the status KEY the deciding transaction actually applied"_. A merge gate
>   applies none. The merge commit, or the queue entry for an enqueue, is recorded
>   on `github_pull_request.merge_outcome_ref` with `merge_authority = 'gate'` by
>   §4's path — §4's second amendment, decision 4(c).
> - **(d) A queued pull request leaves the card `approved`.** `done` still
>   arrives only through the merge webhook, when the queue lands it. `done`'s one
>   writer is unchanged.
> - **(e) A refused merge or enqueue writes NO decision on its merge gate.** The
>   gate stays `awaiting` and decidable, and the refusal renders on the surface
>   naming that pull request. ~~and a retry is step (b) for that one gate alone.
>   The approval stands above it.~~ **⚠️ SUPERSEDED by §4's FOURTH AMENDMENT
>   (MOTIR-5800, 2026-09-19), point 8:** one approval authorizes ONE merge or
>   enqueue action, so a retry does NOT ride on the standing approval. The refusal
>   is recorded on the pull request, classed by reason, and the card leaves
>   `approved` accordingly; _Retry merge_ then DECIDES the fresh gate the class
>   raised. Kept visible as the record.
>
> **Why the approval is not held back until every merge succeeds:** a person did
> approve, at that moment, and the record should say so. A merge that did not
> happen then stays visibly unmerged under that approval, rather than hiding
> behind it or erasing it.
>
> **6. WHO may press — §2 as SHIPPED, restated so no later card copies the
> superseded wording** (rung 2: `resolveGateAuthority`; MOTIR-5192, MOTIR-5292).
> The **assignee**, or the **reporter when the item has no assignee**, or
> **anyone holding `approval:decide_any`** on the project. That is
> `approvalGatesService.resolveGateAuthority`, asked by the door and asked again
> by §4's entry point for each merge gate. Nothing changes here. §2's first
> amendment, _"assignee OR reporter OR admin"_, is superseded twice (§2's second
> and third amendments), and a card that repeats it is wrong. The kind's
> permission floor is still asserted first, and routing is still
> `assigneeId ?? reporterId`, one recipient.
>
> **Which card builds which decision:**
>
> | decisions    | card                                                                                                                                                                        |
> | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | 2 and 6      | MOTIR-5481 — the `pull_request_approval` handler                                                                                                                            |
> | 1, 3 and 4   | MOTIR-5482 — raise and withdraw                                                                                                                                             |
> | 5            | MOTIR-5483 — the press                                                                                                                                                      |
> | the surfaces | MOTIR-5484 — the Development frame's verbs, plus `docs/approval-gates.md` and `CLAUDE.md`'s merge-gate paragraph once the behaviour ships · MOTIR-5485 — the To-approve row |
>
> **Not decided here:** §4's merge and enqueue seam and §7's modes (MOTIR-4882's);
> what a merge queue EJECTING a pull request does to the card (MOTIR-5461 —
> decided since by §4's THIRD AMENDMENT, MOTIR-5629); how one pull request's GitHub review maps onto a gate over a set (MOTIR-4910); and
> refusing a press whose stamp moved (MOTIR-5232). _What SHIPPED_'s _"What has NOT
> shipped"_ line still lists the `pull_request_approval` handler, correctly: this
> block ships no code.

> ### §8 — SECOND AMENDMENT (MOTIR-5609, 2026-09-16): ONE approve-to-merge gate per card — approving it MERGES every pull request the card delivers, and the merge gate retires
>
> **What was DECIDED, and by whom.** A card in a `manual` project carried TWO
> awaiting gates once its pull requests went green: `pull_request_approval` over
> the card's delivery set, and one `pull_request_merge` per pull request. The
> Workbench's **To approve** tab listed the same pull request twice, one row
> reading _Not built yet_. The product owner decided (2026-09-16, rung 3):
> **approving a card's pull requests IS the instruction to merge them, so it is
> ONE decision and ONE gate.** MOTIR-5603 is the defect; this block is the
> contract its seven other children build against.
>
> **Read at base `09e30b21f`.** This block STRIKES text in §4, §6b and §8 in
> place, each strike kept visible. **It supersedes MOTIR-5510's §4 second
> amendment, decision 1**, and it leaves §4's merge-and-enqueue SEAM, §2's
> authority rule and §6c retention untouched.
>
> **1. ONE GATE PER CARD** (rung 3: the decision above). The
> `pull_request_approval` gate over the run target's delivery set is the ONLY
> approve-to-merge gate. Its subject, its `subjectVersion` and its raise moment
> are unchanged from MOTIR-5479's amendment, decisions 2 and 3. **No
> `pull_request_merge` gate is raised, in either merge mode.** A second gate asks
> the same person the same question twice: if the commits are right, approving
> merges them.
>
> **2. §8 row 3 is STRUCK in place.** It read _"**both** gates created
> `awaiting`"_. One gate is created.
>
> **3. §8 row 4b's RATIONALE is STRUCK in place**, including the paragraph that
> began _"Row 4b is WHY there are two gates rather than one."_ **Row 4b's own
> promise SURVIVES** — a pull request approved on GitHub reaches Motir — but
> **what a GitHub review DECIDES under one gate is not decided here**: it is
> MOTIR-4910's, recorded by its own amendment, MOTIR-5590. The case the struck
> paragraph defended is unbuilt in any event: `githubWebhookService` has no
> `pull_request_review` arm (`lib/services/githubWebhookService.ts:192-214`).
>
> **4. A PULL REQUEST'S MERGE IS AN OUTCOME, NOT A GATE — this SUPERSEDES §4's
> second amendment, decision 1**, which reads _"**1. SUBJECT — one gate per pull
> request** (rung 2: the shipped uniqueness key)"_. That decision is struck by
> this one. Where the merge result lives is unchanged and already shipped:
> `githubPullRequestRepository.recordMotirMerge`
> (`lib/repositories/githubPullRequestRepository.ts:513-528`) writes
> `merge_authority` (`gate` | `auto_mode`) and `merge_outcome_ref` — the merge
> commit SHA, or `queue:<entryId>` for an enqueue — on the pull request itself.
> **Nothing new is stored, and both of that function's existing callers stay**:
> `pullRequestMergeService` writes `'gate'` (`:283-288`) and
> `pullRequestAutoMergeService` writes `'auto_mode'` (`:139-148`).
>
> **5. §6b's simultaneous-gates sentence is STRUCK in place.** A card can no
> longer hold an `approved` `pull_request_approval` beside an `awaiting`
> `pull_request_merge`, because the second gate does not exist. §6b's warning
> that a GATE's state is not a WORK ITEM's status is unaffected.
>
> **6. THE REFUSAL UNION SURVIVES, UNCHANGED.** The five `MERGE_*` members are
> facts about a merge ATTEMPT, not about a gate kind: they render on the card's
> own gate, and a refused pull request is retried from the Development frame
> against **(the card's approved gate, that pull request)**. Stated explicitly
> because the obvious misreading of decision 1 is that the refusals retire with
> the kind. They do not.
>
> **7. `auto` MODE IS UNCHANGED** (§7a). It raises no gate and merges or enqueues
> through the same seam, recording `merge_authority = 'auto_mode'`.
> `settleGreenVerdict` (`lib/services/mergeGates.ts:87`) is the hook BOTH modes
> pass through; only its `manual` arm's raise goes.
>
> **8. THE POSTGRES ENUM VALUE STAYS.** `pull_request_merge` is a member of
> `approval_gate_kind`
> (`prisma/migrations/20260908210000_add_approval_gate/migration.sql:36`) and
> gates already raised keep referencing it after they are superseded. **The kind
> is retired at the REGISTRY tier** — moved into `UNREGISTERED_GATE_KINDS`
> (`lib/approvalGates/registry.ts`) — **and the enum member is NOT dropped.**
> Recorded as a decision because the obvious next edit is to drop it, which would
> break every superseded row.
>
> **9. What this does NOT decide**, each with its key: what a GitHub review
> decides under one gate (MOTIR-4910 / MOTIR-5590); a merge-queue EJECTION
> (MOTIR-5461 — decided since by §4's THIRD AMENDMENT, MOTIR-5629); the decision STAMP (MOTIR-5234); GitLab merge-request approvals
> (MOTIR-5593).
>
> ### §8 — THIRD AMENDMENT (MOTIR-5624, 2026-09-16): EVERY door that approves the card's gate MERGES — the REST decide route included
>
> **The defect.** Decision 1 above is door-agnostic — _approving merges every pull
> request_ — but MOTIR-5613 made `pullRequestMergeService.decideGate` a straight
> pass-through to the decide door, and `POST /api/approval-gates/[id]/decide`
> calls `decideGate`. Approving through the route therefore moved the card to
> `approved` and merged nothing, leaving no gate for anyone to press. Only the
> item page's _Approve and merge_ (`approveAndMerge`) merged.
>
> **1. ONE ARM, KEYED ON THE SURVIVING GATE** (rung 2: decision 1 above).
> `decideGate` sends an `approve` on a `pull_request_approval` gate through the
> press's own two steps — decide first, then merge or enqueue each member — so
> the order MOTIR-5613 protected holds. Every other decision reaches the door
> unchanged. The press and the route share one internal step, so they cannot
> drift apart again. The decision still records the door it came through:
> `source: 'api'` for the route.
>
> **2. THE RESPONSE GAINS `members` — ADDITIVE** (rung 3: the route returns its
> result verbatim). The route's 200 body is the decision it always was (`gate`,
> `effect`, `filesKept`) plus `members`: one outcome per pull request, in the
> same shape the press returns (`merged` / `enqueued` / `refused` with its typed
> refusal / `no_merge_gate`). It is `[]` for a decision that merged nothing. **A
> host refusal is a MEMBER outcome of a 200, never an error status**: the
> approval committed first and stands, every other member is still attempted,
> and the refused one is retried from the Development frame (decision 6). So the
> route no longer returns a merge refusal's status, or a 502 for a host that did
> not answer, for this gate. Those now arrive as a member's `refused`
> (`UNEXPECTED` for a host that did not answer), exactly as the press reports
> them.
>
> **3. AN API CALLER MAY MERGE — NO SEPARATE KEY** (rung 3: decision 1 above and
> §2). The route is gated on the same permission floor
> (`work_item:edit`, `APPROVAL_MERGE_PERMISSION`) and the same §2 authority check
> the press uses, and the merge step re-asserts both per member. Refusing the
> verb for this kind on the route was the alternative. It was rejected because
> it would leave the API unable to approve the card at all: under decision 1,
> approving and merging are one decision. The retired
> `work_item:merge_pull_request` key (MOTIR-5616) is **not** revived. Whoever may
> approve the card's pull requests may merge them, through any door.
>
> **4. What this does NOT decide:** the GitHub-sync door's merge, which is
> MOTIR-5608's under MOTIR-4910 and the same principle applied to a third door.

> ### §8 — FOURTH AMENDMENT (MOTIR-5590, 2026-09-17): what a GitHub REVIEW decides — every member approved at its current head by a writer decides the card's ONE gate, and the merge follows
>
> **What was OPEN.** §8's second amendment (MOTIR-5609) made the
> approve-to-merge gate ONE PER CARD and struck row 4b's two-gate rationale, but
> it deliberately left row 4b's own promise — _a pull request approved on GitHub
> reaches Motir_ — undecided under the new model, naming this amendment as where
> it lands. Four things were unrecorded: how a review of ONE pull request maps
> onto a gate whose subject is the run target's delivery SET; which reviews
> count; who the decision is recorded as, under which authority, and how it
> reaches a door that requires a signed-in Motir actor; and that the merge
> follows a synced decision exactly as it follows a press.
>
> **Read at base `6471cac0f`.** MOTIR-5609's one-gate block is the BASE this
> extends, not a thing it re-decides: every rule below is stated under one gate,
> and none of them revives `pull_request_merge`. It strikes nothing in §2, §4's
> merge seam, §6c retention, or MOTIR-4909's raise and withdraw rules.
>
> **1. THE SET RULE** (rung 2: the gate's own `subjectVersion`). The gate is
> decided `approved` only when EVERY member of the set named in its
> `subjectVersion` has a countable approving review at the head that version
> names. **One member's approval decides nothing**, because the row would then
> claim commits nobody approved. `subjectVersion` is each member as
> `owner/name#number@headSha`, sorted and comma-joined
> (`deliverySetVersion`, `lib/approvalGates/deliverySetVersion.ts`) — MOTIR-5479's
> amendment, decision 2. The gate is decided **`changes_requested` on the FIRST**
> countable changes-requested review on any member; the remaining members are not
> consulted, because one reviewer asking for changes is already the answer.
>
> **2. WHICH REVIEWS COUNT** (rung 1: GitHub's own required-review rule). A
> review counts only when ALL of these hold:
>
> - its `state` is `approved` or `changes_requested` — `commented` never counts;
> - its `commit_id` equals that member's head in the gate's `subjectVersion`;
> - it has not been dismissed;
> - its author held `write`, `maintain` or `admin` on the repository when the
>   review arrived.
>
> **Per member, each reviewer's LATEST countable review is the one that counts** —
> a reviewer who requests changes and then approves has approved. This mirrors
> GitHub's own rule for required approving reviews: approvals count from people
> with write access, and a review made at an older commit is stale
> (<https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-protected-branches#require-pull-request-reviews-before-merging>).
> **A reviewer whose permission could not be READ counts for nothing.** The
> decision is safe in that direction: nothing is decided on an unverified
> permission, and the person can still approve in Motir.
>
> **3. THE ACTOR** (rung 3: §6b's amendment, and §8's `decisionSource` line
> above). Resolve the reviewer's GitHub user id through `GithubIdentity`
> (`githubUserId @unique → userId`, `prisma/schema.prisma:6191-6192`), and accept
> the resolution only when that user is a member of the gate's workspace.
>
> - **Resolved:** `decidedById` is that user, and `decidedByLabel` is the member's
>   label followed by ` (@login)`.
> - **Unresolved:** `decidedById` is `null`, and `decidedByLabel` is `@login`.
>
> `decisionSource` is **`github`** in both cases — already a member of
> `ApprovalGateDecisionSource` (`prisma/schema.prisma:4498-4513`), so no enum
> changes for it. **The pair `decisionSource = github, decidedById = null` is what
> a surface reads as _"not a Motir member"_**; it is not an error and not a hole
> in the audit, which is exactly why §6b's amendment kept a surviving label beside
> the nullable FK. The recorded actor is **the reviewer whose review COMPLETED the
> set** — the decision has one decider, and that is the one whose act made it
> true. `noteMd` lists every member's counting review, one per line, as
> `owner/name#number@sha — approved by @login`, so the row names the reviews it
> rests on and not only the last of them.
>
> **4. THE AUTHORITY — a FOURTH value, `github_review`** (rung 2: `enum
ApprovalGateAuthority` is `assignee | reporter | admin`,
> `prisma/schema.prisma:4479-4488`). None of the three is true of a GitHub
> reviewer: they are not the card's assignee or reporter, and they hold no Motir
> permission — an unmapped reviewer holds no Motir anything. So
> `decidedUnderAuthority` gains **`github_review`**: _authority conferred by the
> HOST's review permission_, which decision 2 is the check for. **§2 is unchanged
> for every Motir surface** — this value is never resolved by
> `resolveGateAuthority` and never reachable from a route, a press or the MCP.
>
> **5. THE DOOR — still exactly one** (rung 2: `tests/approval-gate-one-language.test.ts`,
> _ONE DOOR_, MOTIR-4796). A synced decision goes through
> `approvalGatesService.decide`, which stays the single caller of
> `approvalGateRepository.decide`. It arrives as an **internal option carrying the
> synced actor** — never a route, a server action or an MCP tool, because there is
> no caller to authenticate: the webhook's signature is the authentication, and
> the reviewer may have no Motir account at all. The **status transition** runs as
> the resolved member, else the workspace owner — the same fallback
> `changeRequestStatusSync` uses for a webhook-driven move
> (`lib/services/changeRequestStatusSync.ts:487-505`) — and **that actor is the
> WRITER, never the recorded decider.** The two are different questions and the
> row keeps them apart: `decidedById` answers who said yes, and the transition's
> actor answers who had standing to write a status from a webhook.
>
> **6. ⚠️ THE MERGE FOLLOWS THE DECISION** (rung 3: MOTIR-5609's model; rung 2:
> MOTIR-5479's press, §8 row 4a). Because approving the gate IS the instruction to
> merge, a synced approval runs the **SAME merge-or-enqueue the press runs, per
> member, AFTER the decision's transaction commits**, recording each outcome on
> its pull request (`merge_authority: 'gate'`,
> `githubPullRequestRepository.recordMotirMerge`). A host refusal on one member
> **leaves the approval standing** and the other members still attempted; the
> refused one is retried from the Development frame, exactly as MOTIR-5609's
> decision 6 says. **A synced approval and a press differ in WHO decided and in
> nothing else.** There is no state in which a card is approved from GitHub and
> its pull requests are left with no question and no merge — that state was the
> old two-gate model's, and it is gone.
>
> **7. FIRST DECISION STANDS.** A countable review for a gate already `approved`,
> `changes_requested` or `superseded` overwrites nothing — the database refuses it
> (`trg_approval_gate_decided_immutable`) — and **merges nothing a second time.**
> The delivery's outcome names what it found rather than failing: a second
> reviewer approving after the set was complete is normal, not an error.
>
> **8. A GATE RAISED AFTER THE REVIEWS ARRIVED.** Reviews are recorded **whether
> or not a gate exists** — the row is a fact about GitHub, not about Motir's
> workflow. When a gate is later raised (`raisePullRequestApprovalGate`,
> `lib/services/pullRequestApprovalGates.ts`), the recorded reviews are evaluated
> ONCE after that transaction commits. **An approval given while CI was still
> running is therefore not lost**, and the reviewer is not asked a second time —
> which is the whole promise of row 4b.
>
> **9. ONE-DIRECTIONAL.** Motir posts **no review, comment or status to GitHub**
> from any approval path. Approving in Motir must not write into a customer's
> review history: their GitHub record is theirs, and a Motir press is not a review
> by the person whose token Motir holds. Asserted by the ABSENCE of the call, not
> by a comment.
>
> **10. `auto` MODE.** No gate is raised (§7a), so a review is **recorded and
> decides nothing**; the merge there is the automatic one, unchanged
> (`merge_authority = 'auto_mode'`). A team on `auto` that reviews on GitHub gets
> the history without a second question, which is the point of the mode.
>
> **11. What this does NOT decide:** **GitLab merge-request approvals**, deferred
> to MOTIR-5593 by key. GitLab's approval model is not GitHub's — it has approval
> RULES with counts — and nothing here is written to generalise to it.

> ### §8 — FIFTH AMENDMENT (MOTIR-5672, 2026-09-19): the DECISION gate — its subject is the `docs/decisions/*.md` file in the card's MANDATORY pull request, it is PRIMARY over the merge like the design gate, and one press accepts it and merges
>
> **What was OPEN, and what was WRONG.** §1's MOTIR-4911 amendment named
> `decision_approval` and gave it _"a decision with **no pull request**"_; §8's
> Workflow A listed it as a terminal `done` writer; and _Deliberately NOT decided
> here_ left its HANDLER open — _"the resolver for a decision document, and where
> that document lives before the `pages` domain hosts it"_. **This block decides
> the handler and reverses the first two.** Each is struck in place above, and
> Story MOTIR-4907's seven other children build against the clauses below.
>
> **The requester decision it records (Yue, 2026-09-19, rung 3).** A
> `type: decision` + `executor: coding_agent` card ships its decision document as
> a FILE in a PULL REQUEST, and **the pull request is MANDATORY**. Motir builds
> **no document store and no document API** for it — no table, no asset, no
> upload door — because the lasting home for documents is a pages domain
> (Epic MOTIR-5746), and a document API built now would be thrown away. The
> decision gate works like the design gate: approval-gated, PRIMARY over the
> approve-to-merge gate, one press. Decision documents are Motir's own, at its
> ADR convention `docs/decisions/*.md`; Motir hosts no customer project whose
> layout this has to guess.
>
> **Read at base `5ce9c84ec`.** It strikes text in §1's MOTIR-4911 amendment
> table, §8's Workflow A and _Deliberately NOT decided here_, and fills §1's
> handler table's third column. It changes nothing for a design card or a code
> card: every rule MOTIR-5609, MOTIR-5479, MOTIR-5590 and `design-result.md`
> AMENDMENT 6 set stands, and this block reuses them rather than restating them.
>
> **1. THE SUBJECT — the decision document in the card's pull request** (rung 3:
> the requester decision). For a `type: decision` + `executor: coding_agent`
> card, the subject is the markdown file under `docs/decisions/` that the card's
> delivering pull request ADDS or MODIFIES, read at that pull request's HEAD.
> **Motir keeps no copy of it** — not its text, not a render, not an excerpt on
> the gate row. What Motir stores is only the file's IDENTITY at the head
> (clause 7), which is a fact about the host, not a copy of the document.
>
> **2. THE PULL REQUEST IS MANDATORY — there is no Workflow A for a decision**
> (rung 3). A decision card with no delivering pull request has nothing to
> accept, and raises no decision gate. It reaches `done` **only by a merge**,
> exactly like a code card; §8's _`done` has exactly ONE writer_ is the merge
> webhook for every decision card, always. The agent's side of this — the
> dispatch prompt telling a decision card's agent to write ONE
> `docs/decisions/<slug>.md` and open a pull request carrying it — is
> MOTIR-5682's.
>
> **3. EXACTLY ONE DOCUMENT, OR UNRESOLVABLE — and an unresolvable gate still
> HOLDS the merge** (rung 3: the principle §6c and §8 already rest on — a merge
> ships what a person said yes to). The document is the ONE `docs/decisions/*.md`
> file added or modified across the card's delivery SET (every open pull
> request the card's `work_item_delivery` rows name). Any other count still
> RAISES the decision gate, in a state that cannot be approved:
>
> | captured outcome (clause 7)           | the gate                  | Approve     | Request changes | the merge            |
> | ------------------------------------- | ------------------------- | ----------- | --------------- | -------------------- |
> | `one`                                 | resolvable over that file | allowed     | allowed         | follows the approval |
> | `none` — no such file                 | UNRESOLVABLE, says so     | **refused** | allowed         | **HELD**             |
> | `several` — two or more               | UNRESOLVABLE, names them  | **refused** | allowed         | **HELD**             |
> | `unreadable` — the host could not say | UNRESOLVABLE, says so     | **refused** | allowed         | **HELD**             |
>
> **Why a missing document does not simply raise nothing:** a decision card
> must not merge without a person accepting a decision, and _"we could not find
> it"_ must never become _"nobody had to accept it"_. A gate with no Approve and a
> held merge is the loud version of that state; no gate at all is the silent one.
> The same UNRESOLVABLE answer covers a document that the resolver (clause 8)
> cannot fetch when the port renders it — the file is gone at the head, the host
> is unreachable — and there the surface disables Approve because nothing was
> rendered to approve; the door's own refusal keys on the CAPTURED outcome, which
> it can read inside its transaction. Request changes is allowed in every row,
> because _"there is no document here"_ is exactly the answer it exists to give.
>
> **4. IDENTITY AND VERSION — `subjectId` is the CARD, `subjectVersion` is the
> document's BLOB** (rung 2: MOTIR-5479's amendment, decision 2 — the
> approve-to-merge gate's precedent for `subjectId`).
>
> - **`subjectId` = the work item's own id.** The partial unique index
>   `approval_gate_one_awaiting_per_subject` over
>   `(work_item_id, kind, subject_id) WHERE state = 'awaiting'` then enforces
>   _one awaiting decision gate per card_ with no new index — the same reuse the
>   approve-to-merge gate made.
> - **`subjectVersion` = `<owner/name>:<path>@<blobSha>`** for a resolvable
>   document — the repository, the file's path, and the git BLOB sha the host
>   reports for that file at the head. For an UNRESOLVABLE outcome it is
>   `<owner/name>:unresolvable:<outcome>@<headSha>` (the head of the member that
>   produced the outcome), so each unresolvable head is its own question and a
>   push that fixes it raises a resolvable one.
>
> **Why the BLOB sha and not the head sha — the rule this clause exists for.**
> A head sha changes on EVERY push, including a push that only fixes a test or
> a typo in code next to the document. Keyed on the head, an accepted decision
> would be re-asked after every unrelated commit, and a person would be asked to
> accept the same text again and again until they stopped reading it. The blob
> sha is git's content address for exactly that file's bytes: it changes when,
> and only when, the document changes. So:
>
> - **a push that leaves the blob unchanged keeps the decision question AND its
>   answer** — an awaiting decision gate stays awaiting over the same version, a
>   decided one stays decided — and only the merge question moves (MOTIR-5479's
>   decision 4 withdraws the approve-to-merge gate on a moved head, unchanged);
> - **a push that changes the blob SUPERSEDES the decision gate** and raises a
>   fresh one over the new version. The supersede records the cause
>   `head_moved` (`design-result.md` AMENDMENT 6 Q5): the writing path is the head
>   move, and for this kind that path writes only when the head move changed the
>   document, so a surface can render it truthfully as _"a push changed the
>   decision document"_. No new cause is minted — Q5's rule is one value per
>   writing PATH, and this is an existing path.
>
> **5. TWO GATES, ONE PRESS, THE DECISION PRIMARY — `design-result.md`
> AMENDMENT 6, clause by clause** (rung 2: the shipped design arm, MOTIR-5658 /
> MOTIR-5664 / MOTIR-5666). A decision card whose delivery set is green in a
> `manual` project holds two questions, and they have different lifetimes
> exactly as a design card's do:
>
> | gate                              | the question              | lifetime    |
> | --------------------------------- | ------------------------- | ----------- |
> | `decision_approval` — **PRIMARY** | _is this decision right?_ | **durable** |
> | the approve-to-merge gate         | _do these commits land?_  | per attempt |
>
> - **The decision gate is PRIMARY** (AMENDMENT 6 Q1): presented as the thing
>   being decided, with the pull requests beneath it as what the approval will
>   merge. `resolveGateSet`'s `primary` prefers it the way it prefers the design
>   gate.
> - **One press accepts the decision AND authorises the merge**, carried ONCE,
>   and only while the card has had no approve-to-merge gate at all — the
>   MOTIR-5666 clause `resolveGateSet` already applies to the design carry
>   (`lib/approvalGates/gateSet.ts:258-265`). Once a merge gate has existed, a
>   later push is a new question about new commits, and the decision approval
>   does not authorise it.
> - **The merge is HELD until green** (Q4): the press is never refused for CI,
>   the decision stands, and the merge follows on the next green verdict with no
>   second press — the arm `settleGreenVerdict` already carries for a design
>   approval (`lib/services/mergeGates.ts:110-122`).
> - **A failed merge re-opens ONLY the merge question** (Q2): an ejection, a
>   conflict or a refusal leaves the decision gate decided, and the routes back
>   are MOTIR-5461's _Queue again_ and a push — neither touches the decision.
>   (Q3's _a decided design gate closes the design_ has no analogue to build here:
>   the document lives in the pull request, so the only way to change it is a
>   push, and clause 4 already makes a push that changes it a new question.)
> - **`done` has exactly one writer, the merge webhook.**
>
> **Which STATUS the decision press writes: NONE.** Its `approve` returns
> `{ statusWritten: null, statusDeferredReason: 'merge_writes_done' }` — the
> arm `designResultGateHandler.approve` takes when a pull request is open
> (`lib/approvalGates/designResultHandler.ts:176-182`), and for this kind a pull
> request is always open while the gate is live. **The `approved` work-item status
> MOTIR-4905 shipped is written by the COMPANION decision** — the approve-to-merge
> gate the same press decides, through `pullRequestApprovalGateHandler.approve`
> (`PULL_REQUEST_APPROVAL_TARGET`, `lib/approvalGates/pullRequestApprovalHandler.ts:32`)
> — exactly as for a design card. When the press lands before green, no companion
> exists yet, nothing writes `approved`, and the card waits in the review band
> until the held merge follows. Request changes records the decision and moves
> nothing.
>
> **And the merge follows ONLY the decision.** While a card's decision gate is
> awaiting or unresolvable, approving its approve-to-merge gate through a door
> that is not the decision press — the REST decide route on that gate alone, or
> the GitHub review sync of §8's FOURTH AMENDMENT — merges nothing. The GitHub
> reviews are still RECORDED (FOURTH AMENDMENT decision 8), so nobody is asked
> twice; they are carried out when the decision is accepted. Built by MOTIR-5677
> with the gate set, because it is the gate set's question: _does anything still
> hold this merge?_
>
> **6. `auto` MERGE MODE — an unanswered decision HOLDS the automatic merge**
> (rung 3: §7a says `auto` means no MERGE gate; it never said no decision). In an
> `auto` project no approve-to-merge gate is raised (§7a), and the decision gate
> is raised exactly as in `manual`. **An awaiting or unresolvable decision gate
> holds the automatic merge**, and so does a decision card whose document has not
> yet been captured (clause 7's `null`), because the safe reading of _"not known
> yet"_ is _"not accepted"_. The automatic merge follows the decision's approval
> on the next green verdict. Built by MOTIR-5677, in `settleGreenVerdict`.
>
> **What the `auto` arm does TODAY for an awaiting DESIGN gate — read, and then
> reproduced:** it MERGES over it. `settleGreenVerdict`'s `auto` arm
> (`lib/services/mergeGates.ts:123-135` at `5ce9c84ec`) checks only the run
> target and returns an `AutoMergeRequest` for every merge candidate; it never
> reads the `design_result` gate, and `pullRequestAutoMergeService` checks no gate
> either. A real-Postgres spec — an `auto` project, a green design card, its
> design gate `awaiting` — got a merge back. **That is a defect, filed as
> [MOTIR-5762](motir:cmu8fyt3h007phvoi9s2sz9i6)**, and it is out of this record's
> scope: the rule for the design arm is AMENDMENT 6's, and this clause states only
> the decision arm's. The two holds are the same rule for two kinds, so whichever
> card lands second extends the first.
>
> **7. WHERE THE IDENTITY COMES FROM — CAPTURED at the head, never fetched in a
> gate transaction** (rung 2: `lib/services/gateSetFor.ts` reads every input on
> its caller's transaction and makes no network call). Which `docs/decisions/*.md`
> file a head carries is known only to the host, so it is CAPTURED onto the
> pull-request mirror when the head is observed, and the gate set and the handler
> read the captured value. Four nullable columns on `github_pull_request`,
> expand-only:
>
> | column                  | holds                                                            |
> | ----------------------- | ---------------------------------------------------------------- |
> | `decision_doc_outcome`  | `one` · `none` · `several` · `unreadable`; null = never captured |
> | `decision_doc_path`     | the file's path, for `one`                                       |
> | `decision_doc_blob_sha` | the file's git blob sha at that head, for `one`                  |
> | `decision_doc_head_sha` | the head the capture was read at, for every outcome              |
>
> **When it is captured:** on `opened`, `synchronize` and `reopened` for a pull
> request delivering a `decision` + `coding_agent` card, **and when a delivery
> row is written for such a card** (`link_pull_request`) — because a run links its
> pull request right after opening it, so the `opened` delivery routinely arrives
> before the link and would find no decision card to capture for. The read runs
> OUTSIDE any transaction (the file list is a host call), filters the head's file
> list to `docs/decisions/*.md` with an added or modified status, and writes the
> outcome. A failed read writes `unreadable` and never fails the webhook.
>
> **`changedPaths` / `changedPathsTruncated` stay what MOTIR-2922 made them: the
> MERGE's file list**, captured once at merge for the subsumption question. The
> decision columns are a separate HEAD-time fact; one column meaning two
> different moments would make both answers wrong. Built by MOTIR-5674, which also
> extends `lib/github/pullRequestFiles.ts` to return each file's `sha` and
> `status`.
>
> **8. THE RESOLVER — content is read through an interface, and its one
> implementation reads the host** (rung 3: the requester decision; rung 2: §1's
> MOTIR-4911 amendment, _the subject is a document with a resolver_). The handler
> resolves the document's CONTENT through a `DecisionDocumentResolver`. Its one
> production implementation reads the file at the captured head through the
> shipped core-owned read, `repoFileReadService.readFile`
> (`lib/services/repoFileReadService.ts`), whose outcomes are all NAMED
> (`RepoFileServiceResult`: `found`, `not_found`, `ref_not_found`, `too_large`,
> `unauthorized`, `invalid_path`, `unreachable`, plus `repo_not_connected` and
> `provider_unavailable`). `found` is content; every other outcome maps to a named
> UNRESOLVABLE reason, and the mapping is total. **The interface is the seam a
> later pages domain replaces** — a decision document that moves into a page is a
> new resolver and a new renderer, never a migration on the gate table, which is
> the whole reason §1's amendment made the subject opaque. **No Motir-side
> document store exists until then**, by the requester decision above. Built by
> MOTIR-5676, whose second-resolver test is what proves the seam.
>
> **9. RETENTION — NOTHING is pinned** (rung 2: §6c; the retired merge kind's
> answer). The approved version is the blob sha on the decided gate's
> `subjectVersion` plus the merge commit on `github_pull_request.merge_outcome_ref`,
> and both are durable on the host: a merged blob is reachable from the trunk for
> as long as the repository exists. Motir holds no bytes to pin, so §6c's row for
> this kind is _nothing_, the same answer the retired `pull_request_merge` gave.
>
> **10. THE EXECUTOR DISCRIMINATOR** (rung 2: §1's MOTIR-4911 amendment).
> `decision` + **`coding_agent`** raises `decision_approval`. `decision` +
> **`human`** raises NONE here: a person picking one of N options is
> `decision_choice`, which Story MOTIR-4914 owns. A card whose `type` is not
> `decision` never raises this kind, whatever files its pull request touches — a
> code card that also edits an ADR is a code card.
>
> **11. §1's HANDLER TABLE gains a `decision_approval` column**, filled from
> clauses 1–10 above; it is marked there as this amendment's.
>
> **Which card builds which clause:**
>
> | clauses                        | card                                                                                                        |
> | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
> | 7                              | MOTIR-5674 — the head capture and its columns                                                               |
> | 1, 3, 4, 8, 9, 10, 5's verbs   | MOTIR-5676 — the handler, the resolver and the subject summary                                              |
> | 3's raise, 4's supersede, 5, 6 | MOTIR-5677 — the gate set, the one-time carry and both merge holds                                          |
> | 2                              | MOTIR-5682 — the agent's decision lane in the dispatch prompt                                               |
> | the surfaces                   | MOTIR-5673 (design) · MOTIR-5678 (the port, and `docs/approval-gates.md`) · MOTIR-5679 (the To-approve row) |
>
> **Not decided here:** how a pages domain later imports these documents
> (Epic MOTIR-5746, Story MOTIR-5761); what the `decision` TYPE means in the
> taxonomy (MOTIR-4155, which owns `work-item-type-taxonomy.md`); how a planner
> chooses a decision card's executor (MOTIR-4915); the `human` decision path
> (MOTIR-4914); and the design arm's `auto` hold (MOTIR-5762).

#### What the two workflows settle, in one line each

- **`done` has exactly ONE writer, in both workflows.** In A it is the approval,
  because nothing else ever will. In B it is the merge webhook, exactly as when a
  person merges by hand.
- **`approved` exists so that B has somewhere to land** between _a person said
  yes_ and _it shipped_ — and it is `in_progress`-category, so the card is still
  open (§6b).
- **The discriminator is asked ONCE, at decision time**, from data the product
  already has.

### 9. HOW TO TEST is a first-class deliverable, and it belongs on the WORK ITEM — NEW (MOTIR-4911, 2026-09-08), DECIDED BY THE REQUESTER (Yue, 2026-09-08)

**A person deciding a `pull_request_approval` gate is being asked to say yes to
something they have not seen run.** The port shows what changed; that is
necessary and it is not sufficient. **So a coding card's agent writes a HOW TO
TEST section as part of its deliverable — onto the WORK ITEM, not into the
pull-request body — and the port renders it.**

**Why the work item rather than the pull request.** The gate is decided in Motir,
by someone who may not open GitHub at all; a pull-request body is a surface the
decision surface does not read. It is also the wrong lifetime — a pull-request
body is edited by whoever pushes next, while the work item is the record the
audit trail (§6a) points back at.

**It carries EVERY path available, and the diff is a link out rather than the
lead:**

| path               | what it must state                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **the preview**    | the URL the repository's own CI produced, **and its click-path** — how to reach the changed surface once it is open         |
| **locally**        | fetch, install, migrate, seed, run — then the click-path. Name the SEED that makes the surface non-empty or hits the branch |
| **what CI proved** | which lanes ran and what they assert, so the reader knows what they do NOT have to re-check by hand                         |

**A path that is unavailable is SAID to be unavailable**, with what is missing. A
reviewer who cannot tell _"there is no preview"_ from _"nobody wrote this
section"_ is being asked to approve on faith.

**⚠️ SCOPE: SELF-HOSTED REPOSITORIES ONLY.** The preview URL above is one the
repository's OWN CI produced — Motir reads it, it does not create it. **A
Motir-hosted deploy, where Motir stands up the preview itself, is epic
MOTIR-4527 (_Hosting what the agent builds — tenant applications on
motir.site_)** and is not decided here. Until it lands, a project whose
repositories produce no preview has two paths rather than three, and says so.

> ### 9 — AMENDMENT: HOW TO TEST is per RUN (MOTIR-4906 re-plan, 2026-09-13), DECIDED BY THE REQUESTER (Yue, 2026-09-13)
>
> _"'how to test' should not be per PR, it should be per run, so the design is
> not right for a story/container run. how to test in the PR should still be
> there, the agent should produce 'how to test' in the run target before finish
> the run"_ — Yue, 2026-09-13.
>
> §9 said the section belongs on _the work item_ and the consequences amendment
> made it _"an authoring obligation on every card that produces a pull
> request"_. Read literally, that keys HOW TO TEST per card and per pull request,
> and that is the reading the first design of MOTIR-4906 drew: a block under
> every Development row. **For a story run that is wrong** — nobody accepts a
> story one child's pull request at a time. This amendment settles the unit:
>
> 1. **The unit is the RUN.** One HOW TO TEST record per run, written onto the
>    **run target** — the work item the run was launched against:
>    - a **container / parent run** (the runbook's parent run of a story) — the
>      container;
>    - a **scoped CLI run** — its scope target;
>    - a **single-card dispatch** (and each card of an unscoped batch) — the card
>      itself.
>
>    A run that touches several repositories writes **one** record with a
>    **section per repository** (that repository's head commit and setup
>    commands). The click-path is one, for the run. A child card of a container
>    run writes none of its own.
>
> 2. **The agent writes it BEFORE THE RUN FINISHES** — for a run delivered
>    through a session or parent pull request, before that pull request is
>    marked ready; for a single card, before `implemented`. Where a run finishes
>    in orchestrator code with no agent in it, the run gains a close-out step
>    that puts one there.
> 3. **The pull-request body KEEPS its How to test section.** This amends §9's
>    _"not into the pull-request body"_: the record on the work item is what
>    Motir renders; the body is what a reviewer on the host reads. Both carry the
>    same content, and neither replaces the other.
> 4. **Where it renders — ONE gate, ONE block** (Yue, 2026-09-13: _"'approve to
>    merge the PRs' is the gate, how to test is telling user how to validate the
>    PRs, so they are the same gate, not 2 separated things"_). On the run target's
>    item page the **Development block** carries the pull-request rows AND the
>    run's How to test in one section. How to test is the EVIDENCE of the one
>    gate _approve to merge the pull requests_, never a gate, section or verb of
>    its own. When that gate is awaiting, the block IS the universal approval
>    frame — its rows and How to test are the port — exactly as the Design result
>    section is for a design decision. A child card of a container run shows a
>    pointer to its run target instead. (The full-screen approval overlay is not
>    part of this amendment; it is MOTIR-5214's, for every gate.)
>
>    **Content.** The record's content is **rich text** (`bodyMd`, sections
>    allowed), written by the agent over MCP like a design note or an acceptance
>    receipt. Every command sits in a fenced code block, which renders
>    click-to-copy. Only what Motir derives stays structured: the repositories and
>    their commits, the preview, the checks CI ran, the branch fetch.
>
> 5. **Which record is current:** the newest run's. Earlier runs' records remain
>    as history.
>
> The three paths, the _an unavailable path is SAID_ rule and the self-hosted
> scope above are unchanged.

> ### 9 — AMENDMENT: a PERSON writes How to test too (MOTIR-5450, 2026-09-17), DECIDED BY THE REQUESTER (Yue, 2026-09-17)
>
> _"how to test should be able to added/edited manually, the human should be
> able to do the same job too, the human can already link the PRs, add/edit how
> to test should be the same"_ — Yue, 2026-09-17.
>
> _"the human should be able to add what an agent can add"_ — Yue, 2026-09-17.
>
> The amendment above settles the UNIT (the run) and leaves the AUTHOR implicit,
> because at the time an agent was the only one. Read literally, that makes How
> to test agent-only: a pull request a person delivered and linked by hand
> reaches its approve-to-merge gate with a _No How to test_ callout, and a wrong
> agent record can only be corrected by starting another run. Motir treats
> people as first-class executors (Principle #12), so this amendment settles the
> author:
>
> 1. **Two author kinds, one record, one writer.** A record is written by a RUN
>    — over `publish_test_instructions`, with `dispatchRunId` set while a
>    dispatch is running — or by a PERSON, from the item page, with
>    `dispatchRunId` null and `publishedById` the person. **Both go through
>    `testInstructionsService.publish`.** There is no second write path, no
>    second evidence field and no second table, and the block renders the two
>    kinds identically apart from the author line.
> 2. **What a person writes is the INSTRUCTIONS; what Motir derives is the
>    DELIVERY.** A person sets:
>    - the **rich-text body** (`bodyMd`), with headings, lists, links and fenced
>      code blocks _with their language_;
>    - the **preview path** (`previewPath`).
>
>    The **repository sections** (`repos[]`) are DERIVED from the work item's
>    linked pull requests. **A person never sets them — not through a picker,
>    not through a commit field, not as a read-only row** (Yue, 2026-09-17:
>    _"the team can still add repo/PR, they can just use the link PR feature,
>    which is there in the card already"_, and _"why read-only? they are simply
>    not needed, link a PR shows the PR in the development panel"_).
>
>    **⚠️ THE CUT IS BY WHO KNOWS, NOT BY WHAT THE WRITER ACCEPTS.** _"A person
>    may add what an agent may add"_ is a fairness rule, and reading it as
>    `publish`'s input list is what produced a form asking somebody to paste a
>    commit the page was already displaying one line higher. Nobody but the
>    person can write the instructions; nobody but Motir need supply the
>    delivery. **`+ Link pull request`, in the same Development block, is the
>    door that decides which repositories a record covers** — a second control
>    inside the form would be a second door onto one fact, and the worse of the
>    two: `assembleHowToTestRepo` composes the fetch command, the preview and
>    the checks FROM the bound pull request, so a hand-named repository renders
>    with all three empty.
>
> 3. **Motir does not decide how a team works.** A team may keep its pull
>    requests on the host and its work items in Motir and never link the two,
>    and that team must still be able to write How to test. Requiring a link
>    before the door opens would make Motir's own convention a precondition for
>    describing your work.
>
>    **So a record with ZERO repository sections is legal**, and
>    `publish` is changed to accept one: the `repos` list becomes optional, and
>    the refusal _"give one entry per repository the run pushed to — at least
>    one"_ is retired. Everything governing the entries that ARE given — the
>    cap, the 7–64 hex commit, the repository-in-the-project rule and the
>    no-repository-twice rule — is unchanged. **The form suggests nothing and
>    forces nothing**: on Edit it opens on the current record's body and preview
>    path, and on Add it opens empty.
>
> 4. **Who may write, and versions.** A person needs **`work_item:edit`** on the
>    item's project — the permission the explicit pull-request link and
>    `publish_test_instructions` both assert
>    (`githubPullRequestService.linkPullRequest*`). Only the RUN TARGET gets a
>    door; a `tested_via_ancestor` child shows its pointer and no door. A save is
>    a new current record and the previous one moves to history (point 5 of the
>    amendment above — newest wins, in both directions). Identical content writes
>    nothing.
> 5. **The pull-request body is a SNAPSHOT.** Point 3 of the amendment above says
>    the pull-request body and the record carry _"the same content"_. That is
>    amended to **the same content at the run's close-out**: after close-out
>    Motir's record is authoritative, and a person's later edit does not rewrite
>    the pull-request body. The quick-view peek and the approval overlay's port
>    (MOTIR-5214 / MOTIR-5438) draw no edit door.

---

## Consequences

- **The `design_result` gate is the only kind that ships in MOTIR-4778.** The
  registry carries a deliberate compile-time hole where `pull_request_merge`'s
  handler goes, so MOTIR-4882 cannot register without the compiler agreeing.
- **MOTIR-4788 grows** — the audit columns of §6a, the fourth state of §6b, and
  the accumulate-don't-replace property of §6d. Its estimate predates all three
  and is flagged for re-sizing.
- **MOTIR-4790 grows** — the pin of §6c, the supersede predicate, and the
  `superseded` write of §6b, each needing a concurrency test. Same flag.
- **A new permission key reaches `member`'s effective capability set for the
  design gate only** (`work_item:edit`, already held). The merge key is
  additive and held by nobody until a role is edited.
- **`design-result.md` §7 is amended** by this record's pull request; it is the
  only file outside this one that changes.
- **Storage grows with approvals, and only with approvals** — bounded by human
  clicks, which does not scale the way CI artefacts do.

> ### Consequences — AMENDMENT (MOTIR-4911, 2026-09-08)
>
> - **The `approved` work-item status is a new consequence, and it is a
>   MIGRATION** — a status row, its two transitions, and its `restricted`-policy
>   edges. It is a sibling story's, not MOTIR-4778's, and §6b says so.
> - **MOTIR-4788 grows again** — `decisionSource: github`, the unmappable-actor
>   label, and a `subjectId` typed as an opaque id with a per-kind resolver rather
>   than a concrete FK (§1). Its estimate predates all of it.
> - **MOTIR-4790 grows again** — the pin's predicate is now keyed on the SUBJECT
>   (§6c), which is a different query from the one its estimate assumed, and the
>   discriminator read (§8) is a delivery-row join it did not carry.
> - **No new permission key reaches anybody.** §2's amendment retires the
>   role-derived answer entirely: authority is a relationship, and
>   `work_item:merge_pull_request` exists only to sit in
>   `IRREVERSIBLE_PERMISSIONS` so no API token can confer merge.
> - **`design-result.md` §7 is amended a SECOND time** by this record's
>   amendment pull request, for §6c's re-keying. It remains the only file outside
>   this one that changes.
> - **A coding card's deliverable grows a HOW TO TEST section** (§9), written onto
>   the work item (per RUN, on the run target — see §9's 2026-09-13 amendment). That is an authoring obligation on every card that produces a
>   pull request, and it is what the approval port renders.

## What SHIPPED — the dated close-out (MOTIR-4795, 2026-09-10)

Read on `origin/main` @ `d4981d354`, against the code MOTIR-4788 (the record),
MOTIR-4790 (the decide door and its registry), MOTIR-4792 (the frame), MOTIR-4912
(the audit columns) and MOTIR-4913 (retention) landed.

**Most of this record shipped as decided**, and where it did the code says so
itself: §1's registration table, §2's routing and its amended authority rule,
§6a's audit set, §6b's four states and its `(work_item_id, kind, subject_id)`
partial unique index over `awaiting`, §6c's pin, §6d's accumulate-don't-replace,
and §8's discriminator — read from the delivery rows exactly as §8 says, in
`designResultHandler.approve`. **§6b's and §6c's own SHIPPED notes above carry
the two clauses whose mechanism changed while they were being built**, including
the finding that the MOTIR-4911 amendment's restatement of §6c's predicate was
not implementable; they are not restated here.

**Three places the implementation DIVERGED, and each is a decision rather than a
shortfall:**

### 1 · §1 and Consequences — the registry is total over the REGISTERED half, and there are THREE holes, not one

§1 says the registry is `Record<ApprovalGateKind, GateHandler>`, and Consequences
names ONE deliberate hole, _"where `pull_request_merge`'s handler goes"_. Both
predate MOTIR-4911's amendment, which added `decision_approval` and split the
pull-request kind in two — so the enum has **four** members and this build
registers **one**.

A `Record` over the whole enum cannot express that: it would not compile with
three handlers missing. What shipped (`lib/approvalGates/registry.ts`) is
`Record<RegisteredGateKind, GateHandler>` plus a declared
`UnregisteredGateKind = Exclude<ApprovalGateKind, RegisteredGateKind>` and a
`UNREGISTERED_GATE_KINDS` tuple asserted, at the type level, to enumerate it
exactly.

**The guarantee §1 asks for is preserved and is strictly stronger:** a new enum
member fails the build until it is CLASSIFIED (registered, or named as a hole),
and promoting a kind fails the build until its handler exists. The obvious
alternative — `Record<ApprovalGateKind, GateHandler | null>` — was considered and
rejected in the file itself, because `null` is a value, so
`decision_approval: null` compiles silently and the hole stops being a decision
anybody made.

### 2 · §8's Workflow B — the design gate writes NO status when a pull request is open. It does not write `approved`

§3's amendment and §8's Workflow B land such a card in the **`approved`
work-item status**. That status does not exist:
`lib/workflows/defaultWorkflow.ts` carries eight statuses — `todo`, `blocked`,
`in_progress`, `implemented`, `planning`, `in_review`, `done`, `cancelled` — and
no `approved`, and the live tenant's own project workflow carries the same eight.
§6b's amendment already says the migration is a sibling story's; that sibling is
**MOTIR-4905**, still `todo`.

So `designResultGateHandler.approve` returns
`{ statusWritten: null, statusDeferredReason: 'merge_writes_done' }` in that arm.
Writing the status the ADR names would resolve to `UnknownStatusError` on every
request that reached it.

**The invariant is untouched, which is why this is a divergence in the WRITE and
not in the model:** `done` still has exactly one writer, and in this arm it is
the merge webhook. What is missing is only the intermediate place to pause. When
MOTIR-4905 ships, the arm gains one `applyStatusTransition` call and nothing else
moves.

**⚠️ And this arm is not the ordinary path for `design_result` at all.** §1's
amendment keys the kind to _a design with no pull request_; a design that opened
one is Workflow B and takes a `pull_request_approval` gate, which this build
leaves as a registry hole. The arm exists because a gate is created when the
subject is PUBLISHED and the question is asked at DECISION time — a pull request
can appear in between — so a door that assumed its own kind's precondition still
held would write `done` over work that had not merged.

### 3 · §6a — `routedToId` carries NO surviving label, and `decidedById` does

§6a's table asks for _who it was ROUTED to_ and _who decided, surviving their
departure_ as two separate rows, and says nothing about whether the first also
needs to survive. Both columns shipped `onDelete: SetNull`; only `decidedById`
gained the denormalised `decidedByLabel` beside it.

That is deliberate. The harm §6a names for the routing field is the ROUTING
MOVING — the assignee can change after the gate is created, so the live card
cannot answer who the product actually ASKED — and a deletion does not cause it.
The attribution the audit is built around is the DECIDER's, and a null there
already means something else and something worse: §6b's `superseded` uses exactly
that shape to mean _the question was withdrawn and nobody decided it_.

---

**What has NOT shipped**, so that this record's silence is not read as delivery:
the **Approvals tab** (gates are decided on the work item's own page), the
**merge gate** and everything in §4, **`prMergeMode`** and everything in §7 —
including the rename and the tier move, which are still pending, so
`Workspace.subtaskPrMergeMode` stands as it did — the **`decision_approval`** and
**`pull_request_approval`** handlers, §9's HOW TO TEST section as a rendered
port, and two states of the frame itself (MOTIR-5032's port floor / ceiling /
Expand and its `X` state; MOTIR-5033's decided and superseded states). The
user-facing page carries the same list in the user's own words —
[`docs/approval-gates.md`](../approval-gates.md) § _What does not exist yet_.

**Consequences' last pointer is discharged:** _"`design-result.md` §7 is amended
by this record's pull request"_ — it was, by MOTIR-4786, and twice more since
(MOTIR-4911's re-keying and MOTIR-4913's correction of it). Nothing further is
owed there.

### Deliberately NOT decided here

- **The decision gate.** ⚠️ **AMENDED (MOTIR-4911, 2026-09-08): the KIND is now
  decided — `decision_approval` is in §1's enum, with its port and its verbs.**
  ~~named by the requester as a future kind. §1's table says how it registers;
  this record ships none.~~ ~~What is still not decided is its **HANDLER** — the
  resolver for a decision document, and where that document lives before the
  `pages` domain hosts it.~~ **AMENDED (MOTIR-5672, 2026-09-19): the HANDLER is
  now decided too — §8's FIFTH AMENDMENT.** The document lives in the card's
  mandatory pull request, at `docs/decisions/*.md`; Motir stores only its
  identity at the head, and reads its content through a resolver the `pages`
  domain will later replace. `decision_choice`, the N-option verb set, is named in
  §1 and likewise ships nothing here.
- **Re-homing the ACCEPTANCE gate.** `AcceptancePanel` is the language §1
  generalises from and is deliberately left where it is; folding it onto the
  Approvals tab is its own story.
- **Notifications** — no gate email, no bell change.
- **Cross-project routing** — the Workbench is active-project scoped.
- **A merge QUEUE or branch protection on a provisioned repository** — that is
  MOTIR-4161's separate decision, about semantic conflicts between two green
  pull requests, and is a different question from who presses merge.
- **Whether a gate can be delegated or re-routed** after creation. Nothing in
  this record forbids it; nothing implements it.
