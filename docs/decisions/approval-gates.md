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

| a handler supplies                                 | for `design_result`                              | for `pull_request_merge`                          |
| -------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| **how to resolve the SUBJECT** from the gate row   | the current `DesignEvidence` for the work item   | the linked pull-request delivery                  |
| **who it ROUTES to**                               | §2's rule (`assigneeId ?? reporterId`)           | the same                                          |
| **which PERMISSION authorises a decision**         | `work_item:edit`                                 | `work_item:merge_pull_request`                    |
| **which STATUS TRANSITION the gate owns**, or none | the move into the project's `done` category      | none — the webhook moves the card (§4)            |
| **what `approve` DOES**                            | §3                                               | §4                                                |
| **what `request_changes` DOES**                    | records the decision, moves nothing              | records the decision, moves nothing               |
| **what to RETAIN on approval**, or nothing         | pin the approved `DesignEvidence`'s assets (§6c) | nothing — the merge commit is durable on the host |

A third kind is then a row in the enum, a handler, and a renderer for its
subject body. **No second vocabulary, no second control, no second decide door.**

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

### 3. What approving a DESIGN result does — DECIDED BY THE PLANNER (rung 3: the story's own stated intent)

**Approve** records the decision, performs §6c's pin, and transitions the design
subtask into the project's `done` category — which is what unblocks the cards
`blocked_by` it. It goes through `workItemsService.applyStatusTransition`, the
one shipped status funnel, rather than writing `work_item.status` directly, so
it inherits the `completedAt` stamp and every existing guard.

**Request changes** records the decision and moves nothing. **It re-dispatches
nothing** — the revise loop is Story 9.2's (§5).

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

**⚠️ PIN, do NOT FREEZE — this is where we deliberately diverge from
`acceptance-receipt-lifecycle.md`.** The acceptance gate refuses to supersede an
approved receipt at all (`AcceptanceEvidenceAlreadyApprovedError`, 409,
MOTIR-2764). That is right for a story that is finished and **wrong here**: a
design legitimately evolves after approval, and 9.2's revise loop depends on
republishing. The design path keeps superseding; it simply stops feeding
approved blobs to the GC.

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
happened. That guard is a sibling story, not this record's to ship.

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

| value                | behaviour                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`manual`**         | a `pull_request_merge` gate IS created; a person decides it. The default for a project whose repositories are imported                                             |
| **`auto`**           | **no gate is created.** The default for a project established with Motir-hosted repositories                                                                       |
| **`review_on_fail`** | **RESERVED and UNIMPLEMENTED.** It behaves as `manual`. Stated here rather than left to be discovered; the enum value ships to avoid a later Postgres enum `ALTER` |

**The DEFAULT is derived from repository PROVENANCE, and it is a default rather
than a law.** A project established with Motir-hosted repositories seeds `auto`;
anything else seeds `manual`. It cannot be a law because
`lib/projectRepos/roomSections.ts` renders the Motir-hosted set and the
organisation's repositories as two sections of one project — a project can hold
both, so a provenance law for one would silently govern the other. The setting
overrides in either direction, which is what makes the deep link from the
approval surface meaningful: someone who defaulted to `manual` and cannot read a
diff can reach the switch that stops asking them.

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

### Deliberately NOT decided here

- **The decision gate** — named by the requester as a future kind. §1's table
  says how it registers; this record ships none.
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
