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

  | clause                    | what changed                                                                                                                    |
  | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
  | **§1** (INCOMPLETE)       | `decision_approval` joins the enum, and the SUBJECT is re-stated as _a document with a resolver_ rather than a concrete row     |
  | **§2** (WRONG)            | AUTHORITY is **assignee OR reporter OR admin** for both verbs, not two permission keys. ROUTING is unchanged                    |
  | **§3** (WRONG)            | approving writes `done` **only when there is no linked open pull request**; otherwise it writes `approved` and the merge closes |
  | **§4** (partly falsified) | the merge gate DOES write a status — `approved` — and still does not write `done`                                               |
  | **§6b** (incomplete)      | the `approved` WORK-ITEM status, and `decisionSource: github` with the unmappable-actor rule                                    |
  | **§6c** (FAILS SILENTLY)  | the pin is keyed on the **SUBJECT**, not on the gate kind                                                                       |
  | **§8 · §9** (new)         | THE TWO WORKFLOWS, and HOW TO TEST as a first-class deliverable                                                                 |

  **§8 is the one to read first.** It is the discriminator the other five
  amendments are consequences of.

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
> | kind                    | the port shows                                                            | fires when                           |
> | ----------------------- | ------------------------------------------------------------------------- | ------------------------------------ |
> | `design_result`         | the mock, the notes, the screenshot                                       | a design with **no pull request**    |
> | `decision_approval`     | the decision **document**                                                 | a decision with **no pull request**  |
> | `pull_request_approval` | what the card produced — design assets, or **what changed + how to test** | **any** card **with a pull request** |
> | `pull_request_merge`    | the same port; it is the second decision on the same subject (§8, row 4b) | **any** card **with a pull request** |
>
> **The kind decides the VERBS and the EFFECT; the PORT decides what you LOOK
> at, and the port is chosen by what the card PRODUCED, not by the kind.** That
> is why a design with a pull request is approved through
> `pull_request_approval` and still shows its mock: same gate, design port.
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
> **Approving in GITHUB decides only the FIRST gate.** A GitHub review approval
> syncs `pull_request_approval` and leaves `pull_request_merge` `awaiting`; the
> card reaches `approved` either way, and somebody still presses merge. §8's
> Workflow B row 4b is why there are two gates rather than one.

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

> ### §6b — AMENDMENT (MOTIR-4911, 2026-09-08): the `approved` WORK-ITEM status, and `decisionSource: github`
>
> **The gate state set above is unchanged and complete.** What was missing is
> everything on the OTHER side of the decision: the status the work item lands
> in, and where the decision came from.
>
> **⚠️ TWO DIFFERENT THINGS ARE SPELLED `approved`, AND CONFLATING THEM IS THE
> ONE READING ERROR THIS SECTION INVITES.** The table above is the **GATE's**
> state — one row's answer to one question. What follows is the **WORK ITEM's**
> workflow status. A card can hold an `approved` `pull_request_approval` gate and
> an `awaiting` `pull_request_merge` gate at the same time (§4's amendment), and
> be at work-item status `approved` because of the first. The two never have to
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
implemented → in_review → [ design_result | decision_approval ] → done
                           approve is TERMINAL
```

| #   | event                             | actor      | status        |
| --- | --------------------------------- | ---------- | ------------- |
| 1   | the subject is published          | agent      | `implemented` |
| 2   | the gate is created `awaiting`    | product    | `in_review`   |
| 3   | **Approve** — records, pins (§6c) | **person** | **`done`**    |
| 3′  | _or_ **Request changes**          | person     | unchanged     |

**Nothing will ever merge, so nothing else would write `done`. Approval writes
it**, and that is why §3's rule is conditional rather than simply reversed.

#### WORKFLOW B — a pull request exists (design and code, IDENTICALLY)

| #   | event                                                                                                               | actor                              | status         |
| --- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------- |
| 1   | the agent opens the pull request                                                                                    | agent                              | `implemented`  |
| 2   | CI goes green                                                                                                       | CI, server-side                    | `in_review`    |
| 3   | **both** gates created `awaiting` — `pull_request_approval` and `pull_request_merge`                                | product                            | —              |
| 4a  | **"Approve and merge" in Motir** — decides BOTH gates in ONE transaction                                            | **person**                         | **`approved`** |
| 4b  | _or_ the pull request is approved **IN GITHUB** → syncs the approval gate only; the **merge gate stays `awaiting`** | **GitHub reviewer**                | **`approved`** |
| 5   | merge — or ENQUEUE, where the repository has a merge queue                                                          | product (4a) / a second press (4b) | —              |
| 6   | the merge lands                                                                                                     | webhook                            | **`done`**     |

**Design and code take the SAME rows.** A design card that opened a pull request
is Workflow B; only its PORT differs — it shows the mock, the notes and the
screenshot instead of what changed and how to test it (§1's amendment).

**Row 4b is WHY there are two gates rather than one.** A GitHub approval tells
Motir the code was approved and **nothing else** — it is not a merge, and
treating it as one would merge on somebody's review. And the audit needs two rows
regardless: **if one person approves in GitHub and another merges in Motir, that
is two decisions by two people, and one row could not record it.**

**`decisionSource` gains `github` for row 4b**, and the approving actor may be a
GitHub identity Motir cannot map to a member — §6b's amendment says what the
record holds then, and why a null FK would be the wrong answer.

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
>   the work item. That is an authoring obligation on every card that produces a
>   pull request, and it is what the approval port renders.

### Deliberately NOT decided here

- **The decision gate.** ⚠️ **AMENDED (MOTIR-4911, 2026-09-08): the KIND is now
  decided — `decision_approval` is in §1's enum, with its port and its verbs.**
  ~~named by the requester as a future kind. §1's table says how it registers;
  this record ships none.~~ What is still not decided is its **HANDLER** — the
  resolver for a decision document, and where that document lives before the
  `pages` domain hosts it. `decision_choice`, the N-option verb set, is named in
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
