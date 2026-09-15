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
> | `design_result`         | the changed mock(s), the note as a link — `design-result.md` AMENDMENT 4  | a design with **no pull request**    |
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
> **Approving in GITHUB decides only the FIRST gate.** A GitHub review approval
> syncs `pull_request_approval` and leaves `pull_request_merge` `awaiting`; the
> card reaches `approved` either way, and somebody still presses merge. §8's
> Workflow B row 4b is why there are two gates rather than one.

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
> **Not decided here:** §8 row 4a (MOTIR-5479's), what a queue EJECTION does to
> the card (MOTIR-5461), how a GitHub review maps onto gates (MOTIR-4910), and
> whether a provisioned repository gets a queue at all (MOTIR-4161).

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

| #   | event                                                                                                                                                                                                                                                       | actor                              | status         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------- |
| 1   | the agent opens the pull request                                                                                                                                                                                                                            | agent                              | `implemented`  |
| 2   | CI goes green                                                                                                                                                                                                                                               | CI, server-side                    | `in_review`    |
| 3   | **both** gates created `awaiting` — `pull_request_approval` and `pull_request_merge`                                                                                                                                                                        | product                            | —              |
| 4a  | **"Approve and merge" in Motir** — ~~decides BOTH gates in ONE transaction~~ **commits the approval FIRST, then merges or ENQUEUES each pull request after that commit, deciding each merge gate only on success** (§8's amendment, MOTIR-5479, decision 5) | **person**                         | **`approved`** |
| 4b  | _or_ the pull request is approved **IN GITHUB** → syncs the approval gate only; the **merge gate stays `awaiting`**                                                                                                                                         | **GitHub reviewer**                | **`approved`** |
| 5   | merge — or ENQUEUE, where the repository has a merge queue                                                                                                                                                                                                  | product (4a) / a second press (4b) | —              |
| 6   | the merge lands                                                                                                                                                                                                                                             | webhook                            | **`done`**     |

**Design and code take the SAME rows.** A design card that opened a pull request
— one or many — is Workflow B; only its PORT differs: the Development block shows
the design result once (the mock(s) with the note as a link), then How to test,
then every pull-request row, and no `design_result` gate is raised for the card
(`design-result.md` AMENDMENT 4 Q8).

**Row 4b is WHY there are two gates rather than one.** A GitHub approval tells
Motir the code was approved and **nothing else** — it is not a merge, and
treating it as one would merge on somebody's review. And the audit needs two rows
regardless: **if one person approves in GitHub and another merges in Motir, that
is two decisions by two people, and one row could not record it.**

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
>   gate stays `awaiting` and decidable, the refusal renders on the surface naming
>   that pull request, and a retry is step (b) for that one gate alone. The
>   approval stands above it.
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
> what a merge queue EJECTING a pull request does to the card (MOTIR-5461); how
> one pull request's GitHub review maps onto a gate over a set (MOTIR-4910); and
> refusing a press whose stamp moved (MOTIR-5232). _What SHIPPED_'s _"What has NOT
> shipped"_ line still lists the `pull_request_approval` handler, correctly: this
> block ships no code.

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
