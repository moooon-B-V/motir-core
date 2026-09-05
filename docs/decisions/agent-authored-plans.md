# ADR: Agent-authored plans — an MCP door onto the plan substrate

- **Status:** Accepted (2026-08-18)
- **Story / Subtask:** Author a plan over the MCP (MOTIR-2982) · Subtask MOTIR-2984
- **Amends:** `docs/decisions/work-item-provenance.md` — Decision 4 (the write-seam
  table) and Decision 5 (the materialize pin). Both amendments are written into that
  file; this ADR argues them.
- **Consumed by:** MOTIR-2985 (design — the Plans-surface attribution), MOTIR-2986
  (the Plan's authorship carrier), MOTIR-2988 (`create_plan` + `add_plan_items`),
  MOTIR-2990 (materialize reads the proposal's provenance), MOTIR-2991 (the surface),
  MOTIR-2992 (the vitest gate), MOTIR-2993 (the E2E). AMENDMENT 3 is consumed by
  MOTIR-3095 (projected validity on the MCP), MOTIR-3096 (projected reads),
  MOTIR-3097 (the story's vitest gate). AMENDMENT 6 amends AMENDMENT 2 — its
  empty-only exclusion — and is written by MOTIR-3189.
  AMENDMENT 10 amends AMENDMENT 8's boundary — it is written by MOTIR-3596 and consumed by
  MOTIR-3598 (the job-token door), MOTIR-3599 (the `revise_plan` submit), MOTIR-3600 (the motir-ai
  handler), MOTIR-3601 (the review-surface affordance) and MOTIR-3602 (the story's vitest gate).

> Every reading below was taken off `origin/main` at `d82b5fa7` on 2026-08-18. Where a
> reading and a card's prose disagreed, the code won and the difference is recorded — in
> §6 for the cards, in each answer for the ADRs.

---

## Context

Motir's promise is that a plan is reviewed before it becomes work: a `Plan` of `PlanItem`
proposals, a person reads the tree, and only `plansService.approvePlan` turns a proposal
into a `work_item` row. Every planner Motir ships produces into that substrate — except an
external agent on the MCP, which has exactly two write paths and neither authors a
proposal:

- **`create_work_item`** (`lib/mcp/tools/createWorkItem.ts`) writes a `work_item` row
  immediately. No proposal, no diff, no approval.
- **`open_plan_session` / `append_plan_turn` / `submit_plan_session`**
  (`lib/mcp/tools/planSession.ts`) do reach a `Plan`, but by handing a PROMPT to motir-ai:
  the agent describes what it wants, spends the owner's AI credits, and Motir's generator
  does the planning. The agent cannot say what the tree should be.

The substrate this needs is entirely shipped. `plansService.createPlan` → repeated
`addProposals` → `markPlanned` is the same sequence motir-ai's generator drives through
`POST /api/internal/ai/plan-proposals` — a §4 job-token route, unreachable from a PAT. What
is missing is a PAT-authed door onto it, plus the two things an externally-authored plan
needs that a generated one did not: an honest record of who authored it, and a materialize
that does not overwrite that record with Motir's own name.

This ADR answers the four questions the rest of MOTIR-2982 builds on. Three have answers
already implied by shipped code, and for those the work is to write them down with their
evidence. **Q4 is different — it amends a recorded decision, and it is argued rather than
asserted.**

---

## Q1 — One tool, two, or three?

### Decision: TWO — `create_plan`, and `add_plan_items` carrying a `final` flag.

**Evidence for the shape.** The shipped producer contract is `createPlan` → repeated
`addProposals` → `markPlanned`, composed by `aiGenerationService.appendProposals`
(`lib/services/aiGenerationService.ts:126-156`) behind `POST /api/internal/ai/plan-proposals`.
`markPlanned` is reached by a **flag on the last append**, not a second endpoint, and that
route's own header says so: _"`final: true` marks the plan `planned` on frontier completion
(a flag on this route, not a second endpoint)"_
(`app/api/internal/ai/plan-proposals/route.ts:23-24`). Two tools mirror that contract
exactly; a third `finalize_plan` would add a call the shipped seam demonstrably does not
need.

**Why not ONE `propose_plan(tree)`.** `addProposals` returns the created PlanItems in
append order, and those ids ARE the intra-plan temp-refs a later batch needs:
`TEMP_REF_PREFIX` is `planItem:<planItemId>` (`lib/plans/refs.ts`, re-exported from
`plansService`), so a `parentRef` or a `blockedByRef` pointing at another `add` in the same
plan can only be written once that `add` has an id. A tree deeper than one level therefore
requires a round-trip per layer, and a single whole-tree call would have to invent a second
ref vocabulary that materialize does not understand.

### The two tools

| tool             | arguments                                                                      | returns                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `create_plan`    | `projectKey`, `title?`, `summary?`, `plannedWithHarness?`, `plannedWithModel?` | the plan (`id`, `status: 'generating'`, `projectId`, the authorship triple)                              |
| `add_plan_items` | `planId`, `proposals[]`, `final?`                                              | the plan, its items, and `planItemIds` — **the ids of the proposals THIS call created, in append order** |

**`planItemIds` in append order is the temp-ref contract, and it is load-bearing.** A caller
reads the id at index _i_ of `planItemIds` as the id of the proposal it passed at index _i_,
and passes `planItem:<that id>` as the `parentRef` / `blockedByRefs` entry of the next
batch. `aiGenerationService.appendProposals` computes exactly this slice today, with the
reasoning recorded in place: _"a generation job is the SOLE writer of its plan and appends
sequentially … so this call's creations are exactly the last `proposals.length` items"_
(`lib/services/aiGenerationService.ts:140-144`). The same reasoning holds for a
token-holding agent, and the reason it holds is the **plan row lock** `addProposals` takes
(`planRepository.lockById`), not the caller's discipline: two concurrent appends to one
plan serialize, so neither can interleave into the other's slice.

**`final` is a flag, not a tool**, and it composes exactly as the internal seam composes it:
`addProposals`, then `markPlanned` when the flag is set, in that order, in one tool call.

### Argument names — `plannedWith*`, matching the shipped MCP vocabulary

MOTIR-2988's description proposed `authoredWithHarness` / `authoredWithModel`. **This ADR
names them `plannedWithHarness` / `plannedWithModel` instead**, because `create_work_item`
already publishes those two argument names for the identical fact — the planning agent's
harness and model — fixed by `work-item-provenance.md` Decision 4 and shipped in
`lib/mcp/tools/createWorkItem.ts:225-234`. `create_plan` is the reviewable twin of
`create_work_item`; an agent wiring both should pass the same values under the same names,
and one agent-facing vocabulary is worth more than a marginally better noun. MOTIR-2988's
criteria are amended accordingly (§6).

### Where the authorship is PUBLISHED on the MCP payload

Both tools derive through the shipped plan payloads (`lib/mcp/payloads/workLoop.ts`), and
`mcpPlanSchema` is a **narrowing of v1's `planSchema` plus MCP's own fields** — it already
extends with `projectId`, `itemCount`, `items` and `decidedById`, the last with the note
_"MCP has always published it; v1 does not"_ (`lib/mcp/payloads/workLoop.ts:175-181`). The
authorship triple joins that extension: **published on the MCP payload, and deliberately
NOT added to v1's `planSchema`.** That keeps MOTIR-2982's scope boundary (_"it does NOT add
a `/api/v1` twin"_) true at the schema, not merely at the route list, and `decidedById` is
the precedent that the extension point exists for exactly this.

---

## Q2 — Which permission gates each tool?

### Decision: `create_plan: 'work_item:edit'` · `add_plan_items: 'ai:view_plan'`

`docs/decisions/token-permissions.md` §3 fixes the rule: each `TOOL_PERMISSIONS` entry
names **the permission the tool's own SERVICE already asserts**, read off the code, with no
row on an exception list. Read off `origin/main`:

| tool             | service call                                             | the assertion, at                                                                                                                                           | key              |
| ---------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `create_plan`    | `plansService.createPlan`                                | `projectAccessService.assertCanEdit` (`lib/services/plansService.ts:1078`) → `canEdit` → `hasPermission(i, 'work_item:edit')` (`lib/projects/access.ts:59`) | `work_item:edit` |
| `add_plan_items` | `plansService.addProposals` (+ `markPlanned` on `final`) | `assertPermission(plan.projectId, ctx, 'ai:view_plan')` (`lib/services/plansService.ts:1117`, and `:1165` for `markPlanned`)                                | `ai:view_plan`   |

**Consequence: a token must hold BOTH keys to author a plan**, and that is the right
narrowing rather than an accident. `create_plan` opens the container; `add_plan_items` puts
proposals in it. A token holding only `work_item:edit` can open an empty plan and nothing
more; a token holding only `ai:view_plan` can append to a plan somebody else opened. Neither
half is a capability worth withholding the other for, and neither is a path to a work item.

Two observations the map's comments must state rather than smooth over, because both look
like mistakes to the next reader:

1. **`work_item:edit` gates a tool that creates no work item.** It is the key the service
   asserts, and asserting a _narrower_ key on the MCP door than the browser door to the same
   service would be a fiction — the gate does not become tighter because the map says so.
2. **`ai:view_plan` — a key whose name reads as a view — gates a WRITE.** This is not new and
   is already recorded in the code: _"⚠️ THE NAME IS THE MISLEADING PART: this key governs
   reading a generated plan AND acting on it … Approving MATERIALIZES work items, so it is a
   write key wearing a read's name — which is why the decision record puts it at `member`
   rather than at browse, and why every method that writes to a PLAN row asks it"_
   (`lib/services/plansService.ts:972-979`).

**No new catalog key is minted here.** The catalog is `docs/decisions/permission-inventory.md`'s
and MOTIR-2254's; `ai:view_plan` is already `{ domain: 'ai', enforcement: 'enforced' }`
(`lib/permissions/catalog.ts:207`) and already held by the built-in member role
(`lib/permissions/builtinRoles.ts:112`).

### Two INWARD consequences of this answer

**(a) A shipped comment stops being true.** `lib/mcp/toolPermissions.ts:62-65` says of the
plan reads: _"They are NOT `ai:view_plan`: that key gates the plan DECISIONS (`approvePlan`
/ `declinePlan` / `addProposals`), **none of which is an MCP tool**."_ The final clause is
correct today and false the moment `add_plan_items` lands. The comment must be amended in the
same change as the map entry — it is not decoration, it is the reasoning a future reader
would use to conclude the new entry is wrong. Written into MOTIR-2988's criteria (§6).

**(b) A device-minted CLI token cannot author a plan, and that is correct.**
`CLI_TOKEN_GRANT` is `['project:browse', 'work_item:edit', 'comment:add', 'ai:plan']`
(`lib/mcp/toolPermissions.ts`) — no `ai:view_plan`. The grant's own doc comment says the
co-location IS the guardrail: _"adding an MCP tool now carries a second question next to its
map entry — does the CLI call it, and does this set already cover it?"_ Asked and answered:
`packages/cli/src/client.ts` calls neither tool, and the grant is deliberately NOT widened.
A credential living unattended on a remote box does not need to author plans, and the
approval screen cannot be widened by the user.

**Neither tool joins the billable set.** `MCP_BILLABLE_TOOLS` is
`['expand_item', 'submit_plan_session']` (`lib/mcp/rateLimitGate.ts:65`) — the tools that
cause motir-ai to run a model job. These two spend no provider tokens and start no job; they
are database writes, covered by the transport's own `mcp:call` limit like every other write
tool. Adding them would cap plan authoring against the owner's _generation_ allowance for no
reason.

---

## Q3 — How does a Plan record WHO authored it?

### Decision: mirror the `source · harness · model` triple onto the `Plan`, as `authorSource` / `authorHarness` / `authorModel`.

**Why not `origin`.** `Plan.origin` (`PlanOrigin`, `user` | `cadence`) answers **WHY** the
plan was started — _"`user` (someone clicked) or `cadence` (the auto-plan watcher fired it).
Set at submit; never changes"_ (`prisma/schema.prisma`, `model Plan`). That is orthogonal to
who wrote it: an agent-authored plan and a Motir generation are both `origin: 'user'`. The
review surface needs both facts and must not conflate them — MOTIR-2985 draws them as
separate states for exactly this reason.

**Why not `sourceJobId IS NULL`.** It is an inference, not a record: it says _no motir-ai job
produced this_, which is true of an agent-authored plan and would also be true of any future
producer that does not run a job. An inference that happens to be right is not an
attribution, and the surface that shows it cannot say where it came from.

**The vocabulary already exists one level down.** `work-item-provenance.md` Decision 2 fixes
`WorkItemPlanningSource` as a closed enum, with `harness` and `model` as free text ("open,
fast-moving sets"). Read off `origin/main` it now has **FOUR** members — `native` | `mcp` |
`manual` | **`api`** — not the three Decision 2 lists: `api` was added by
`20260804003255_add_api_planning_source` for `POST /api/v1/projects/{projectKey}/work-items`
(`app/api/v1/…/route.ts:138`, `provenance: { planning: { source: 'api' } }`). Decision 2's
code block is a dated record and stays as written; a note recording the addition is appended
to it, because a card that reads the ADR for the enum's members would otherwise implement a
switch that is one arm short. This ADR **REUSES that enum for the Plan
column** rather than minting a parallel `PlanAuthorSource` with the same three members. The
reason is not brevity: the plan's author and its items' authors must be drawn from ONE
vocabulary or the Plans surface and the work-item detail can disagree about the same fact,
and a second enum is a second display switch to keep total. The name is now slightly wider
than its original scope; that is the honest cost and it is recorded here rather than paid in
a duplicate.

### The fields

| field           | type                      | set by                                                                                                               |
| --------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `authorSource`  | `WorkItemPlanningSource?` | **SERVER-SET** at the write seam — `mcp` from `create_plan`, `native` from the generator path. Never a caller field. |
| `authorHarness` | `String?`                 | caller-supplied free text (`plannedWithHarness`), trimmed, empty → null                                              |
| `authorModel`   | `String?`                 | caller-supplied free text (`plannedWithModel`), trimmed, empty → null                                                |

All three are **nullable with no default and no backfill**. Every plan created before this
ships genuinely has no recorded author; `null` is the _unattributed_ state MOTIR-2985 draws,
and inventing a value for history would be the one outcome worse than showing nothing.

**The generator path is NOT retrofitted in this story.** `aiGenerationService` and
`aiPlanEditsService` call `createPlan` without the triple, so their plans stay
`null · null · null` and behave byte-identically. Their attribution is not lost — a plan with
a `sourceJobId` is a Motir generation and the surface can say so — but recording it
explicitly is a separate change with its own backfill question, and MOTIR-2982's scope
boundary keeps it out — specifically, MOTIR-2986's own criterion that every shipped
`createPlan` caller stay byte-identical, which is what lets that card ship a schema change
with no risk to a running producer. **The deferral is CARDED, not left as prose:
MOTIR-2996**, `blocked_by` this story, which passes the native pair at both call sites,
backfills the existing job-sourced rows, and REMOVES the inference from both surfaces so the
fact has one source rather than two. **This is deliberate, not an oversight**, and MOTIR-2985's
_Motir-generated_ row state must therefore be drawn from what a generated plan actually
carries (`sourceJobId != null`, `authorSource == null`), not from `authorSource == 'native'`,
which no shipped writer produces. Written into MOTIR-2985's and MOTIR-2991's criteria (§6).

### How `add_plan_items` fills a proposal's `planningProvenance`

**Rule: `add_plan_items` STAMPS `proposedFields.planningProvenance` on every `add` it
appends, from the plan's own triple, and does NOT accept `planningProvenance` as a caller
field.** The tool's proposal argument schema omits it entirely.

- **Why stamp rather than default.** Materialize reads the proposal, not the plan
  (Decision 5's contract, unchanged by Q4). If the tool left the field empty and materialize
  fell back to the plan, materialize would need a second read and a second rule; stamping at
  the append means the plan's attribution and its items' attribution **cannot disagree**,
  because there is only one place they are written.
- **Why not accept it from the caller.** Per-proposal harness/model is a distinction without
  a difference — one agent authors one plan — and accepting a caller-supplied `source` is
  precisely what Q4's safety argument must be able to rule out. The service still honours a
  `planningProvenance` a caller supplies, because the INTERNAL generator route supplies one;
  that door is the trusted §4 job-token seam. The MCP door simply does not offer the field.

MOTIR-2988's criterion _"a proposal … that carries its own keeps it"_ is amended to this
shape (§6).

---

## Q4 — Does an approved MCP-authored plan still materialize as `native · Motir`?

### Decision: NO. `materialize` READS the proposal's `planningProvenance.source` / `.harness`, defaulting to `native` / `Motir`. `work-item-provenance.md` Decision 5 is amended.

This is the one question that overturns something. It is argued below rather than asserted,
and the superseded sentence is quoted so the reversal reads as a reversal.

### What is being overturned, in its own words

`plansService.materialize` does not merely default to the native pair — it PINS it,
deliberately, with the rationale in the code above the write
(`lib/services/plansService.ts:635-648`):

> Native PLANNING provenance (Story MOTIR-1685, docs/decisions/work-item-provenance.md
> Decision 5): **every item materialized from an approved plan was planned NATIVELY by
> Motir** → `source: native` (**PINNED — never read from the proposal**), `harness: Motir`.

And in `work-item-provenance.md` Decision 5:

> Note: `source` AND `harness` are **pinned to `native`/`Motir` at materialize**, not read
> from the proposal — a forged non-native `source`/`harness` on
> `proposedFields.planningProvenance` can never change the stamp (**the internal seam is
> trusted as native by construction**).

### Which half this story falsifies, and which half survives

Read carefully, the pin rests on two claims, and they are not the same claim.

- **The PREMISE — _every item materialized from an approved plan was planned natively by
  Motir_.** True when written: the only writer of a `Plan` was motir-ai's generator. **This
  story falsifies it directly.** After MOTIR-2988, a plan can be authored by an arbitrary
  token-holding agent, approved by a person, and materialize into work items. Left alone,
  every one of those items is stamped as Motir's own planning — a false claim on the exact
  record `work-item-provenance.md` exists to keep truthful, on every item of every such
  plan, and nothing downstream could tell it from the real thing.
- **The SAFETY PROPERTY — _a proposal must not be able to CLAIM it was planned natively_.**
  Untouched, and it must stay untouched. This is what the pin was actually protecting.

The pin conflated the two because, at the time, pinning was the cheapest way to hold the
safety property: if the value is never read, it cannot be forged. That equivalence is what
stops being available, not the property.

### Why reading the field does NOT weaken the safety property

Because **no caller ever supplies it.** Three write paths reach
`proposedFields.planningProvenance`, and none of them is caller input at the MCP door:

1. **`add_plan_items` (new)** stamps it SERVER-SIDE from the plan's triple and does not
   accept it as an argument (Q3). This is the same discipline `create_work_item` already
   applies, in its own words: _"The source is fixed here — never taken from a caller field —
   so an agent cannot claim `manual`/`native`"_ (`lib/mcp/tools/createWorkItem.ts:227-228`).
   And `create_plan` stamps `authorSource` server-side, so the value `add_plan_items` copies
   is itself never caller-chosen.
2. **`POST /api/internal/ai/plan-proposals`** supplies `native · Motir`. It is a §4
   service-bearer + job-token route, authenticated by `authenticateAndLimitJobRequest` and
   unreachable from a PAT — the seam Decision 5 already calls _trusted as native by
   construction_.
3. **The proposal-EDIT path cannot reach the field at all.** `UpdateProposalInput`
   (`lib/dto/plans.ts:272-289`) has no `planningProvenance` member, and
   `mergeProposedFields` (`lib/services/plansService.ts:168-182`) is an explicit
   key-by-key merge over eight named fields — it copies `current` and overwrites only
   `title`, `kind`, `descriptionMd`, `type`, `priority`, `storyPoints`, `estimateMinutes`,
   `explanationMd`. A patch carrying `planningProvenance` is discarded by construction, not
   by validation, and the proposal keeps whatever the append stamped.

So materialize ends up trusting **a value a Motir write seam wrote**, not one an agent sent.
That is a different proposition from reading caller input, and it is the one the amended
Decision 5 rests on.

### The narrow way to keep it true

**Reject an unrecognised `source` at the proposal boundary, rather than writing it through.**
The enum is closed and `validateProposal` / `lib/plans/validateProposals.ts` is where a
malformed proposal is already refused (the sizing and repo-role checks live there, for the
stated reason that telling a machine producer its value is wrong while it is still writing
beats discovering it at approve, when a human is waiting). A `source` outside
`WorkItemPlanningSource` therefore fails at the append with a typed `InvalidProposalError`,
and the column can never receive a value the display switch does not cover.

### The rule

```
planningSource  = pf.planningProvenance?.source  ?? 'native'   // was: pinned 'native'
planningHarness = pf.planningProvenance?.harness ?? 'Motir'    // was: pinned 'Motir'
planningModel   = pf.planningProvenance?.model   ?? null       // unchanged
```

**The default is what keeps every existing native materialize byte-identical.** The shipped
producers — generation, augment, expand, replan, contextual, cadence — reach materialize
either with `planningProvenance` absent (older proposals) or with
`{ source: 'native', harness: 'Motir', model }` (MOTIR-1690's producer). The first case takes
the default and the second writes the same pair the pin wrote, so **no shipped path changes
its output**. Decision 5's defensive-consumer property survives with it: a proposal carrying
no provenance still stamps a valid native triple.

### One deliberate consequence, and it is the shipped rule rather than a new one

`lib/mappers/workItemMappers.ts:85` strips `planningModel` from the read DTO when
`planningSource === 'native'`, so Motir does not expose its own model. An `mcp`-sourced item
is not stripped and therefore **SHOWS the model the agent self-reported** — which is what
Decision 5's own note already prescribes: _"MCP/BYOK keep + expose their model — the user
reported their OWN."_ The mapper does not change; the consequence is asserted in
MOTIR-2990's tests so it is a decision on the record rather than a side effect nobody named.

---

## 5. What this ADR does NOT decide

- **It does not retire `create_work_item`.** Direct authoring stays; this adds the reviewable
  path beside it.
- **It does not add an approve/decline tool.** `plansService.approvePlan` — a decision a
  person makes in Motir — stays the only path from a proposal to a `work_item` row. Both new
  tools' descriptions must say so, in the same words their siblings already carry
  (`lib/mcp/tools/getPlan.ts:176`, `lib/mcp/tools/planSession.ts:321-323`): the failure mode
  is a client reporting work it never created.
- **It does not retrofit the generator path's attribution** (Q3) — a separate change with its
  own backfill question, carded as **MOTIR-2996** and `blocked_by` MOTIR-2982.
- **It does not itself change how Motir's own planner runbook works** — but that adoption is
  **inside** this story, not after it: **MOTIR-3047** (`motir-meta`), `blocked_by` MOTIR-2988.
  Moved in on 2026-08-18 (Yue), superseding the deferred stub MOTIR-2983, because a door nobody
  walks through is not shipped (Principle #10) and this runbook is the most demanding planner
  Motir has — deep trees, sibling edges between proposals that do not exist yet — so it is where
  an awkward append-order or temp-ref contract surfaces first, on us.
  **⚠️ Not a total conversion, and the split is the card's first deliverable:** the passes that
  produce a tree propose it; the corrections that happen INSIDE a run (THE REPLAN ACTION, bug
  filing, status flips, the dispatch claim) stay DIRECT, because `run.md`'s never-ask contract
  forbids a run that stops to wait for an approval.

---

## 6. The INWARD sweep — criteria this ADR falsified, and where each was amended

`notes.html` #304: an ADR run that sweeps only OUTWARD (what did this decision leave
unowned?) misses the mirror case — a sentence somewhere else that has just stopped being
true, on a card that still reads green. Every answer above was diffed against the five
sibling cards' acceptance criteria. Four contradictions were found and amended on the record
at the same time as this document:

| card                    | the clause this ADR falsified                                                                  | disposition                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| MOTIR-2988              | `create_plan`'s args named `authoredWithHarness` / `authoredWithModel`                         | amended to `plannedWithHarness` / `plannedWithModel` (Q1)                                                |
| MOTIR-2988              | _"a proposal … that carries its own keeps it"_ — implies the tool accepts `planningProvenance` | amended: the tool's proposal schema OMITS the field and stamps it server-side (Q3)                       |
| MOTIR-2988              | its `TOOL_PERMISSIONS` criterion did not name the stale comment the new entry contradicts      | criterion added: amend `lib/mcp/toolPermissions.ts:62-65`'s _"none of which is an MCP tool"_ (Q2a)       |
| MOTIR-2985 · MOTIR-2991 | the _Motir-generated_ row state, read as `authorSource == 'native'`                            | amended: a generated plan carries `authorSource == null` and is identified by `sourceJobId != null` (Q3) |

**Nothing this ADR names as follow-up work is left unfiled.** `notes.html` #181: a decision's
ANSWERS are deliverables, and an un-owned one is invisible — nothing downstream goes red when
an answer has no home. The two pieces of work this ADR does not do itself both have one:

- **Retrofitting the generator path's attribution** (Q3) → **MOTIR-2996**, filed with this
  ADR, `blocked_by` MOTIR-2982. It was named here as a scope boundary and would otherwise have
  been exactly the orphan #181 describes: the inference it removes lives in two files, is
  correct today, and goes wrong silently the first time a non-job producer writes a `Plan`.
- **The runbook adoption** → **MOTIR-3047**, a `motir-meta` child of MOTIR-2982 itself. It began
  as the deferred stub MOTIR-2983 and was pulled INTO the story on 2026-08-18; that stub is
  archived as a duplicate. Its hedge about a second `motir-ai` half is measurably empty —
  `src/llm/planningRulePacks.ts` names the direct-write tools **zero** times, because the mirrored
  corpus governs how to SHAPE a plan, not which tool writes it — so ONE SUBTASK = ONE REPO = ONE
  PR holds for the single motir-meta card.

Neither is a deliverable this decision produces and leaves homeless.

---

## AMENDMENT 1 — an EMPTY plan is not a pending proposal (MOTIR-3051, 2026-08-19)

Q2's answer is unchanged: `create_plan: 'work_item:edit'` · `add_plan_items: 'ai:view_plan'`,
each the key its own service asserts, §3's rule total and its exception list still empty.
**What is amended is one sentence of Q2's reasoning** — the clause that priced the split's
consequence:

> _"A token holding only `work_item:edit` can open an empty plan **and nothing more**."_

It was more than nothing. `planRepository.findUndecidedByProject` reads `generating` as
UNDECIDED, and that read is the pending-proposal gate MOTIR-916 pauses auto-plan cadence on —
so the empty plan Q2 waved through **stopped that project planning itself, indefinitely, with
nothing on any surface saying why.** Q2 reasoned about what the token could DO and not about
what the row it left behind would MEAN to a consumer one service away.

### The decision: fix the GATE, not the door

MOTIR-3051 offered three repairs. **Chosen: an undecided plan with no producer and no
proposals does not gate cadence** (`planRepository.findUndecidedByProject`). The other two are
rejected on the record, because the reasoning is what a future reader needs:

- **Rejected — make `create_plan` require BOTH keys.** It is neither sufficient nor
  necessary. _Not sufficient_: the same orphan arrives with no permission involved at all,
  because a generation job that dies before its first append leaves its plan `generating`
  forever — `aiPlanEditsService.resolveJobState` says exactly that in its own doc comment, and
  that path holds every key. _Not necessary_: once the gate stops reading a zero-item plan as a
  decision, the hole the door was going to close is not a hole. And it is not free: the rule it
  would break is §3's, whose `Record<McpToolName, PermissionKey>` totality is what makes an
  unmapped tool a compile error, what `lib/tokens/grant.ts` derives the grantable set from, and
  what groups the public `/docs/mcp/tools` page — one key per tool, three consumers.
  Asserting the second key in `plansService.createPlan` instead is worse still: `expand_item`
  reaches that service, and `CLI_TOKEN_GRANT` holds `ai:plan` **without** `ai:view_plan`, so it
  would 403 a capability the device grant deliberately confers.
- **Rejected — widen `CLI_TOKEN_GRANT`.** Unchanged, as the card required and as §7 and Q2(b)
  already argued: an unattended credential on a remote box does not gain plan authoring because
  of a modelling artifact.

### The discriminator is the PRODUCER, not the count

`autoPlanCadenceTick` is `retryPolicy: 'idempotent'` on the stated ground that _"a project that
already fired now HAS an undecided plan, so the gate skips it on the re-run"_. Between
`submitExpand`'s `createPlan` and motir-ai's first append, that plan holds **zero items** — so a
rule keyed on the count alone would let an Inngest retry fire a second job at the same stub, and
would have replaced a permanent pause with the stacked proposal the gate exists to prevent.

`sourceJobId` separates the two cleanly and already exists for provenance: every generator
submit sets it (`aiGenerationService.startGeneration`, `aiPlanEditsService.submitPlanEditJob`),
and the MCP door leaves it null (`lib/mcp/tools/authorPlan.ts`). So **an empty plan with a job
still gates; an empty plan with no job does not.** The exclusion is a WHERE clause rather than a
caller-side filter, because the read returns one row newest-first and dropping the orphan after
the fact would answer _not paused_ for a project whose real `planned` proposal sits one row down.

### What this does NOT do

- It does not expire or auto-decline anything. A plan **with** proposals is a decision somebody
  owes, however long they take; `declinePlan` remains the release valve and MOTIR-1740 remains
  what makes the wait visible.
- It does not reach an empty plan left by a **crashed generation job** — that row carries a
  `sourceJobId`, so it still gates, and it still pauses cadence for good. Filed separately
  rather than absorbed here: the fix is a terminal plan state on job failure, which is job
  lifecycle, not a gate predicate.

---

## AMENDMENT 2 — a plan whose PRODUCER died is reconciled, not gated around (MOTIR-3064, 2026-08-19)

> **⚠️ Its EMPTY-ONLY scope is superseded by AMENDMENT 6 (MOTIR-3189)**, which found that the
> partial plan this amendment left to a human decision could not be decided by anyone. The
> reasoning below is otherwise live — read both.

AMENDMENT 1 closed the orphan with **no producer** and said, in its own _What this does NOT
do_, that the other half was filed separately:

> _"It does not reach an empty plan left by a **crashed generation job** — that row carries a
> `sourceJobId`, so it still gates, and it still pauses cadence for good. […] the fix is a
> terminal plan state on job failure, which is job lifecycle, not a gate predicate."_

This is that card. The diagnosis held; the shape of the fix took one correction.

### Why it could not be another exclusion

AMENDMENT 1's exclusion works because a plan with `sourceJobId IS NULL` can be judged **from
the row**. This one cannot. A plan whose job died is byte-for-byte what a healthy generation
looks like between `submitPlanEditJob`'s `createPlan` and motir-ai's first append: same status,
same producer, same zero items. The discriminator is not in the plan table at all — it is
whether the job behind it is still alive. So `findUndecidedByProject` is **unchanged by this
card, deliberately**: a gate that guessed at liveness would be exactly the count-keyed rule
AMENDMENT 1 rejected, wearing a different hat.

### The decision: a reconciling SWEEP, because the callback does not exist

The card offered two shapes — _(1)_ write a terminal status on job failure, or _(2)_ a
reconciling sweep — and asked for one, with reasons. **Chosen: (2).** The reasoning is that
(1) is not a smaller version of (2); it is not available at all:

- **There is no failure callback to hang it on.** motir-ai's inbound seams into core are the
  SUCCESS path — `aiGenerationService.appendProposals` and `patchProposal`, both resolved by
  `sourceJobId`. Nothing in core is called when a job fails. Core learns a job's outcome by
  ASKING (`resolveJobState` → `GET /v1/jobs/:id`) or by holding an SSE stream open. So (1)
  means a NEW inbound route on the AI boundary, which is a larger change than (2), not a
  smaller one.
- **And it would still miss the case that matters most.** `motir-ai/src/jobs/worker.ts` marks
  a job `failed` only when the HANDLER throws. A worker process that dies mid-job writes
  nothing anywhere — its own row stays `running` — so a failure callback has nobody to fire it.
  The card said as much in advance (_"(2) is likely necessary regardless"_), and reading the
  producer confirms it. A sweep that ASKS covers both halves; a callback covers one.

`abandonedPlanService.reconcileAbandoned` runs hourly at `:10`, ten minutes ahead of
`autoPlanCadenceTick` at `:20`, so a plan freed this hour unpauses that project in the SAME
hour's tick. It selects `generating` plans that have a producer, hold **no** proposals, and are
past a 15-minute grace; asks motir-ai about each one's job; and declines only the ones whose
producer is provably gone.

Three of those conjuncts are load-bearing and none is a performance tweak:

- **The 15-minute grace is a CORRECTNESS bound.** The window between `createPlan` and the first
  append is exactly the shape the sweep selects, and the grace keeps it out of that window
  entirely — so the reconciler can never be asking about a submit that happened a moment ago.
- **Empty-only is the card's AC 5**, and it is the same line AMENDMENT 1 drew: a PARTIAL plan is
  a real proposal a person can read and decline, so nothing here may touch it.
  **⚠️ SUPERSEDED by AMENDMENT 6 (MOTIR-3189): a partial plan could be read and NOT declined** —
  every decider refused anything but `planned`, so this clause protected a decision the status
  guard made impossible and stranded the plans permanently. The sweep now takes partial plans
  too, once `declinePlan` gained the `generating` entry that makes the release valve real. The
  other two conjuncts in this list are unchanged.
- **Unreachable is not death.** `resolveJobState` reports a motir-ai outage as
  `reachable: false`; the sweep terminates nothing on that arm and asks again next tick. The one
  unreachable-shaped answer that IS evidence is `MOTIR_AI_JOB_NOT_FOUND` — a 404 is motir-ai
  answering that no such job exists.

**And there is a second bound, for the failure the ASK cannot see.** A worker that dies mid-job
leaves its row `running` forever, so the question has no answer and the plan would gate forever
with it. After **24 hours** an empty plan behind a non-terminal, reachable job is treated as
abandoned anyway. This is `planTargetLockSweep`'s argument applied to the row that crash
strands — _"the only signal left is the passage of time"_ — and the number is picked by the
asymmetry: cutting off a genuinely long generation destroys work, while a day of a paused
cadence costs a project some suggestions.

### The terminal state is `declined` with a NULL decider, not a new `failed` member

The card named the trade honestly: a new enum member _"costs a migration and a display switch
in every plan surface"_, while `declined` _"costs nothing and is arguably a lie about who
decided."_ Both halves survive scrutiny; the second is smaller than it looks and the first is
larger.

- **`PlanStatus` is a PUBLIC vocabulary, not an internal flag.** A new member reaches v1's
  `planStatusSchema` (`lib/api/v1/workLoop/schema.ts`), the `get_plan_status` MCP tool
  description, `PlanStatusDto`, and four display switches — `PlanRow`'s icon + square + pill,
  `planRowView`'s `PlanWhenKey`, `PlanReviewRail`, `PlanHistoryEventDto`'s `kind` — plus the
  i18n catalogue and its zh-parity gate. That is a product decision about what people are shown,
  and it is larger than this defect. It is owed its own card if it is ever wanted.
- **Nothing downstream would branch on it.** Every consumer of this row asks _is it decided?_
  — `plansService`, `planReviewService` and `planRowView` all test `approved || declined`, and
  the gate this card exists for tests `generating || planned`. A third terminal member would
  need adding to each of those predicates to mean anything, and would then mean the same thing.
- **The honesty lives in the ACTOR, and the table already has the idiom.** `Plan.createdById`
  is NULL ⟺ _nobody asked_ — the cadence case, documented in `schema.prisma` as _"NULL is a
  MEANING"_. `decidedById: null` on a declined plan is the same convention one column over:
  _nobody decided_. The sweep therefore writes `status: 'declined'` and `decidedAt`, and leaves
  the decider null.
- **The failure is not lost.** `sourceJobId` still points at the job, whose status and error
  stay readable through `resolveJobState`; each reconciliation is logged with the job's reported
  state and the reason it was judged abandoned.

**One consequence, stated rather than discovered later:** `getOutcome` attaches the `job` block
only while the plan is `generating`, so once the sweep declines a plan the job's failure reason
stops riding that read. That is the right trade and it costs nothing in practice — the client
polling a live submit sees `generating` plus `job.failure` immediately, long before the grace
elapses. The sweep is for the long tail where nobody is polling, and there the useful answer is
_this is over_, which `declined` gives.

### RLS: the scan needs an arm, and so does `plan_item`

The discovery read is cross-workspace, so it runs under `withSystemContext`, and this card adds
the `FOR SELECT` `app.system_admin` arm to `plan` — the same shape MOTIR-916 added to `project`
and MOTIR-2787 to `plan_target_lock`, and for the same reason: without it the scan returns zero
rows and raises nothing, which for a sweep is indistinguishable from _nothing is abandoned_.

`plan_item` gets one too, and that direction is the surprising one. The emptiness test is a
correlated `NOT EXISTS` in the SAME statement, so an RLS-hidden proposal row makes it vacuously
true and a PARTIAL plan read as empty. A blind spot here does not narrow the scan — it **widens**
it, onto exactly the plans AC 5 forbids touching. (The write is guarded independently: it
re-reads the plan and re-counts its items under the plan's own workspace context before acting,
which is also what makes a late append safe. But a predicate saved only by its guard means
something other than what it says.)

Both arms are `FOR SELECT` only. Every write the sweep makes runs under
`withWorkspaceServiceContext` bound to that plan's own workspace, so `WITH CHECK` is untouched
and the tenant-root write refusal stays exactly as strong as it was.

### What this does NOT do

- It still does not expire or auto-decline a plan **with proposals in it**, at any age or in any
  status. AMENDMENT 1's line holds: that is a decision somebody owes.
  **⚠️ AMENDED by AMENDMENT 6 (MOTIR-3189).** It does now, on the same evidence it uses for an
  empty one — because the decision this deferred to a person was not one a person could make.
  What survives unchanged is the shape of the evidence: age alone still terminates nothing, and a
  plan with no producer to ask about is reachable only by a person, through the discard path.
- It does not release planning-target locks. `plansService` does that on approve/decline through
  a best-effort helper that needs an acting user this sweep does not have, and its own documented
  fallback is already the right one — _"the lease will expire and the sweep will clear it"_
  (`planTargetLockSweep`, every ten minutes). Two recovery paths for one lease is how they drift.
- It does not give motir-ai a stale-job reaper. A worker that dies leaves `running` on ITS side
  too, and that row is still wrong; this card makes core stop _depending_ on the answer, which is
  the harm it owns. Fixing the producer's own bookkeeping is a motir-ai card.

---

## AMENDMENT 3 — the PROJECTION: how an MCP call names the plan it is working in, and which calls can see it (MOTIR-3094, 2026-08-19)

The four answers above gave an agent a door onto the plan substrate. They did not give it eyes.
Every read tool a PAT holds sees only committed `work_item` rows and every validity tool it holds
checks only committed rows, so an agent closes its plan with `final: true` and finds out whether
the tree it proposed is coherent when a person reads it — or at approve. Motir's own planner never
does this: `motir-ai`'s `generate_tree` runs `planValidityService.validateProjectedPlan` as its
**pre-commit post-condition** before closing a plan. The check is written, tested, and running; it
is simply unreachable from a token.

This amendment answers the four questions **MOTIR-3093** builds on.
It ADDS to Q1–Q4 above and overturns none of them: the two doors stay two doors, their permissions
are unchanged, and nothing here creates a work item.

> Every reading below was taken off `origin/main` at `d7550252` on 2026-08-19.

**The substrate is already built and is not re-litigated here.**
`planValidityService.buildProjection` (`lib/services/planValidityService.ts:122`) assembles _the
project's live tree ⊕ the plan's `PlanItem` delta_ — pure in-memory over read-only repository
loads, reading the plan through `plansService.getPlan` so the browse gate applies — and the three
`validateProjected*` methods (`:460`, `:534`, `:607`) run the shipped finishability rules over it.
All three are reachable today only from `POST /api/internal/ai/validate-plan{,-forest,-sprint}`,
§4 job-token routes. What follows is a transport decision, not a semantics decision.

---

### Q5 — how does a call NAME the plan it is projecting?

#### Decision: an explicit `planId` parameter, per call, always optional. Omitting it is today's behaviour, byte for byte.

**Why an explicit parameter.** It matches every plan-addressed tool the surface already has —
`get_plan(planId)`, `add_plan_items(planId)`, `get_plan_status` — and every internal route this
mirrors: `validate-plan`, `validate-plan-forest` and `validate-plan-sprint` each take a `planId`
in the body. A projected mode that is _opt-in by an argument_ also makes the compatibility
promise checkable rather than aspirational: a call without the parameter never reaches
`buildProjection` at all, so "unchanged" is a property of the code path and not of a test.

**Why the implicit "the caller's open plan" LOSES — and it is not a matter of taste.** There is no
column that could resolve it. `Plan` records three parties and none of them is _the token that is
writing_:

- `createdById` is the REQUESTER — _"WHO ASKED for this plan … as opposed to `decidedById`'s who
  APPROVED it and `authorSource`'s which AGENT wrote it"_ (`prisma/schema.prisma`, the `Plan`
  model) — and it is deliberately NULL for a cadence plan.
- `decidedById` is the approver, and does not exist yet at authoring time.
- `authorSource` / `authorHarness` / `authorModel` (Q3) record WHAT wrote it — `mcp`, a harness
  name, a model name. They identify a KIND of producer, never an instance: two agents on two
  tokens both write `mcp · Claude Code`.

So "the token's most recent `generating` plan on the project" would have to be resolved by
`(projectId, status)` and a timestamp — a query that is not scoped to the caller at all, and that
two concurrent agents on one project would both win. And the row it binds to is one this very ADR
has now twice documented as a real, reachable state: AMENDMENT 1 (MOTIR-3051) records a
`work_item:edit`-only token opening an empty `generating` plan it can never fill, and AMENDMENT 2
(MOTIR-3064) records a `generating` plan whose PRODUCER died. Implicit resolution binds a READ to
exactly those rows, and the failure is silent — the call succeeds and returns a plausible tree.

**Why a SESSION loses.** The MCP transport is stateless streamable HTTP and builds one server per
request (`lib/mcp/registry.ts`, `buildMcpServer`); there is no session to hang state on and
inventing one means a new persisted concept, its lifecycle, and its expiry — a large contract for
an argument the caller already holds, since it got the `planId` back from `create_plan`.

**The parameter accepts a `planItem:<id>` temp-ref wherever it names a TARGET, not only a real
key.** `resolveProjectedRoot` (`:426`) already takes both forms, and the temp-ref case is the one
an authoring agent actually has: it wants to validate the epic it _proposed_, which has no key
until approve. Rejecting the temp-ref would leave the most useful call unreachable.

---

### Q6 — WHICH calls gain a projected mode?

#### Decision: the four work-item reads/validations whose subject is a tree, plus one new plan-level tool. Every other read is OUT, and the ready-set family is out FOR A REASON, not by omission.

The verdict is given for every tool the server registers, so a tool added later has a rule to
follow rather than a precedent to guess at.

| tool                           | projected mode          | why                                                                                                                                                                                                                                                      |
| ------------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate_work_item`           | **IN** — gains `planId` | `validateProjectedWorkItem`, the subtree verdict. Target may be a real key or a `planItem:<id>`                                                                                                                                                          |
| `validate_sprint`              | **IN** — gains `planId` | `validateProjectedSprint`, the active-sprint verdict                                                                                                                                                                                                     |
| **`validate_plan`** (NEW)      | **IN** by construction  | `validateProjectedPlan`, the FOREST verdict. It takes no target, which is why it cannot be a parameter on an existing tool                                                                                                                               |
| `get_work_item`                | **IN** — gains `planId` | the authoring loop's per-card read                                                                                                                                                                                                                       |
| `search_work_items`            | **IN** — gains `planId` | the authoring loop's set read                                                                                                                                                                                                                            |
| `list_ready`                   | **OUT**                 | see the ready-set rule below                                                                                                                                                                                                                             |
| `next_ready`                   | **OUT**                 | same                                                                                                                                                                                                                                                     |
| `claim_next_ready`             | **OUT**                 | same, and it is a write                                                                                                                                                                                                                                  |
| `dispatch_prompt`              | **OUT**                 | it assembles the instruction an agent EXECUTES. A proposal has nothing to execute                                                                                                                                                                        |
| `get_work_item_activity`       | **OUT**                 | a proposal has no comments and no history. There is nothing to project                                                                                                                                                                                   |
| `list_sprints`                 | **OUT**                 | a plan cannot change sprint membership. `PlanItemPatch` carries no sprint field and an `add` lands in the backlog (`validateProjectedSprint`: _"an `add` lands in the backlog, so it is NOT a member"_), so the projected answer is the committed answer |
| `get_project_state`            | **OUT**                 | reports planning PRECONDITIONS — established, code connected, indexed, repo set. A plan projects none of them                                                                                                                                            |
| `get_plan` / `get_plan_status` | **N/A**                 | already plan-addressed. They ARE the plan read; projecting a plan onto itself is not a mode                                                                                                                                                              |
| `list_projects` · `whoami`     | **OUT**                 | no work-item subject                                                                                                                                                                                                                                     |

**The ready-set exclusion, in the words the next reader needs.** `list_ready`, `next_ready` and
`claim_next_ready` do **NOT** gain a projected mode, and that is a decision rather than an
oversight. **A proposal is not dispatchable.** It is not a work item, it has no key, nothing may
claim it, and `claim_next_ready` cannot transition a row that does not exist. A projected ready
list would put a card in front of an agent whose very next call is _claim this_ — so the harm is
not a confusing answer, it is a dispatch attempt against nothing. Readiness is the one read whose
output is an INSTRUCTION TO ACT, and the projection is the one input that describes work which
cannot be acted on.

**The rule a later tool follows.** A read gains a projected mode ⟺ **(a)** its subject is a work
item or a set of work items, and **(b)** its answer is a DESCRIPTION rather than an instruction to
act on one. Clause (b) is the whole ready-set family, and it is why `dispatch_prompt` — a read by
permission — is out with them.

---

### Q7 — is a projected row DISTINGUISHABLE from a work item?

#### Decision: YES, by an explicit field on the row, and it carries NO key. A caller must never need to read prose, a summary line, or an id's shape to tell the two apart.

The plan substrate already rests on this rule and states it in three places: `get_plan`'s own
description (_"these are PROPOSALS, NOT work items … an `add`'s `workItemId` stays null until
then"_), `create_plan`'s and `add_plan_items`' (_"this creates NO work item"_), and §5 above,
whose stated failure mode is _"a client reporting work it never created."_ A read that returns
both kinds in one array is precisely where that rule could quietly stop being true, so the
discriminator is what makes the read safe rather than a nicety on top of it.

A projected proposal row therefore carries:

- **`proposal: true`** — present and `true` on a proposal, present and `false` on a committed row.
  Not an absent-means-false optional: a consumer that forgets the field must not silently read
  every proposal as a work item.
- **`planItemId`** and the **`planItem:<id>` temp-ref** it is addressed by.
- **`key: null` / `identifier: null`.** A proposal has no key until approve, and **no synthesized
  key is invented for it** — a `MOTIR-`-shaped string on a row that no `get_work_item` can fetch
  is the single worst thing this story could ship.

Fields a proposal genuinely does not have — `status` history, `commentCount`, `assignee`,
`sprintId` — are `null`, never defaulted to a plausible value. `0` comments and _no comment
thread_ are different facts and only one of them is true.

#### ⚠️ AMENDED WHILE BUILDING IT (MOTIR-3096, 2026-08-19): the discriminator is STRUCTURAL as well as per-row.

The paragraph above describes a proposal as a marked row _inside_ the read's existing array,
and that is not what shipped — for a reason that only became visible at the keyboard, so it is
recorded here rather than quietly applied. The MCP **payload seam** (ADR Amendment 7) requires
`search_work_items`' `items` and `get_work_item`'s `children` to satisfy the shared `/api/v1`
resource shapes, and a keyless proposal cannot: `derived()` validates it, and it would fail.

So proposals ride their **own arrays** — `proposals` on the search envelope,
`proposedChildren` on the projected detail — beside the committed ones. **That is strictly
stronger than what Q7 asked for**, in the direction Q7 wanted:

- Every existing reader of `items` / `children` is untouched **by construction**, not by care.
- A caller cannot mix the two by accident, because they never arrive mixed.
- A caller that flattens the arrays anyway **still** cannot lose the distinction, because each
  row carries `proposal` and a null `key` exactly as specified above.

The per-row marking is therefore unchanged and is not weakened by the array split — it is the
second of two locks, not a replacement for the first.

---

### Q8 — which PERMISSION does a projected call name?

#### Decision: `project:browse`, unchanged, for all five. The projected mode neither narrows nor widens the key, and it is NOT `ai:view_plan`.

§3's rule that a declared permission may not be a fiction applies here exactly as it did to
`add_plan_items`, so the answer is read off the gates rather than off the tool's ambition. A
projected call reaches two things and asserts browse on both:

- the WORK ITEM side — `projectsService.getByKey` / `workItemsService.getWorkItemByIdentifier` →
  `assertCanBrowse`, which is what `validate_work_item` and `get_work_item` name today;
- the PLAN side — `buildProjection` reads the plan through `plansService.getPlan`, which runs
  `projectAccessService.assertCanBrowse(plan.projectId, ctx)` at
  `lib/services/plansService.ts:1686`, after a not-found that precedes it.

Both are `project:browse` and both are on the _same project_, so the composed reach of a projected
call is exactly the reach of the two calls it replaces. Widening would be a fiction in one
direction; declaring something narrower would be a fiction in the other.

**NOT `ai:view_plan`, and the near-miss is worth naming** because `add_plan_items` sits under that
key one section up. `ai:view_plan` gates the plan DECISIONS — `approvePlan` / `declinePlan` /
`addProposals` — the _"write key wearing a read's name"_ `lib/mcp/toolPermissions.ts` describes.
A projection decides nothing, writes nothing and persists nothing. Filing these reads under it
would mean a token granted browse-only could no longer validate a plan it is allowed to READ in
full through `get_plan` — a narrowing with no gate behind it.

**The consequence, stated so nobody has to derive it:** a token that can already read a project's
tree and its plans can now also read them JOINED. It reaches no row it could not fetch with two
calls it already holds.

---

### What this amendment does NOT decide

- **The FILTER GRAMMAR over projected rows.** A `FilterAST` condition on `sprint`, `assignee`,
  `created` or a custom field has no meaning for a proposal, and whether each is satisfied,
  never-matched, or an honest refusal naming the field is
  **MOTIR-3096**'s to settle per field. Q7 binds it only this far:
  whatever the answer is, it is the SAME answer every time and not an accident of which rows the
  delta happened to contain.
- **The COST of the projection on a read path.** `buildProjection` loads the project's whole live
  node set (`findAllByProjectForValidity`) — proportionate for a validity check run once before
  closing a plan, and not obviously proportionate for a search called on every turn. Measuring it
  and bounding it if it does not hold is MOTIR-3096's, and Q6's IN verdict is not a finding that
  it is free.
- **A `/api/v1` twin.** Plan authoring is agent-facing; v1's plan operations stay as read-only and
  as wide as they are today, exactly as Q1's _Consequences_ line already says.
- **Anything in `motir-ai`.** The internal `validate-plan*` routes and the client-side
  `ctx.proposals` overlay (`src/llm/retrievalTools.ts`, MOTIR-2638) stay as they are. This is a
  second consumer of one service, not a migration, and the two overlays must not share code
  across the repo boundary.

---

### The INWARD sweep — what this amendment falsified, and where each was amended

`notes.html` #304: an ADR run that sweeps only OUTWARD misses the mirror case — a sentence
somewhere else that has just stopped being true on a card that still reads green. The three
sibling cards' criteria were diffed against every answer above.

| card       | the clause                                                                                                                                    | disposition                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOTIR-3095 | _"joined to all four compile-total registries"_, naming `lib/mcp/registry.ts`, `toolPermissions.ts`, `payloads/registry.ts`, `apiDocs/mcp.ts` | **There are FIVE.** `lib/mcp/scopes.ts`'s `TOOL_SCOPES` is declared `Record<McpToolName, TokenScope>` and is total over the registry, so a new tool does not COMPILE without a row there. It is deprecated scaffolding governing only the legacy docs rendering — which is exactly why it reads as skippable and is not. Amended on the card                                                         |
| MOTIR-3095 | `lib/apiDocs/mcp.ts` named as a registry to JOIN                                                                                              | Joining it is half the obligation. `TOOL_SUMMARIES` pins a `descriptionFingerprint` of each tool's shipped `title` + `description`, recomputed from a live `tools/list` by MOTIR-2330's gate — so amending `validate_work_item`'s / `validate_sprint`'s / `get_work_item`'s / `search_work_items`' description RE-PINS four existing fingerprints in addition to adding one row. Amended on the card |
| MOTIR-3095 | _"`validate_work_item` gains the plan parameter Q1 pinned"_                                                                                   | Holds. Q5 pins `planId`, optional, absent = unchanged — which is also that card's acceptance criterion 4                                                                                                                                                                                                                                                                                             |
| MOTIR-3096 | _"`get_work_item` on a `planItem:<id>` temp-ref returns the proposed card"_                                                                   | Holds, and Q7 tightens it: that row carries `proposal: true` and `key: null`                                                                                                                                                                                                                                                                                                                         |
| MOTIR-3097 | _"every amended tool's `toolPermissions` entry is exactly the key Q4 pinned"_                                                                 | Holds, and the key is `project:browse` (Q8) — including for the NEW `validate_plan`, which is the entry most likely to be filed under `ai:view_plan` by analogy with its neighbour                                                                                                                                                                                                                   |

**Nothing this amendment names as follow-up is left unfiled.** The filter grammar and the cost
bound are both MOTIR-3096's own deliverables, named in its body; neither is an orphan.

---

## AMENDMENT 4 — the DEEPEN turn: an agent fills in the cards it proposed (MOTIR-3089, 2026-08-19)

Q1 gave the authoring door two tools and no third. `add_plan_items` is **append-only**, and a
proposal is frozen the moment it lands — which forbids the one authoring strategy Motir's own
generator uses. `motir-ai`'s issue-tree handler runs **titles-first** (MOTIR-845): Phase 1 appends
title-only `add`s so the SHAPE is settled and reviewable early, Phase 2 PATCHES each card's body,
type, priority and sizing one at a time, all before `markPlanned` closes the frontier. That deepen op
is shipped — `plansService.deepenProposal` (MOTIR-1441) — and is reachable **only** over the §4 job
token, so an external agent on the MCP is held to a strategy Motir abandoned for its own planner.

This amendment answers the four questions the PAT-authed twin needs. They are numbered **D1–D4** to
avoid colliding with Q1–Q4 above; they are MOTIR-3089's own Q1–Q4 in order.

> Every reading below was taken off `origin/main` at `d7550252` on 2026-08-19.

There are two edit-a-proposal paths, and they delegate to ONE helper:

| method           | status gate  | route                                        | auth                                            |
| ---------------- | ------------ | -------------------------------------------- | ----------------------------------------------- |
| `updateProposal` | `planned`    | `PATCH /api/plans/{id}/items/{itemId}`       | session cookie — the human review surface       |
| `deepenProposal` | `generating` | `PATCH /api/internal/ai/plan-proposals/{id}` | §4 job token (`authenticateAndLimitJobRequest`) |

Both call `editAddProposal` (`lib/services/plansService.ts:1336`) — row-locked one-shot, add-only,
sparse merge, non-empty-title + sizing re-validation — differing **only** in the status they expect
(`:1710` vs `:1733`). So the behaviour is written and tested; what is missing is a caller.

---

### D1 — Which plan STATUS may a PAT deepen in?

#### Decision: `generating` ONLY. `update_plan_item` is the PAT-authed twin of `deepenProposal` and inherits its gate unchanged.

The tool passes `expectedStatus: 'generating'` by calling `plansService.deepenProposal`, and a call
against any other status refuses with `PlanNotInExpectedStatusError` **naming the actual status**, so
the agent can tell a terminal refusal from a retryable one.

**Rejected: `generating` + `planned`.** Three reasons, in the order they bind:

1. **`planned` IS the review queue, and a queue that moves under the reader is not a review.** The
   whole proposition this ADR exists to serve is that a person looks at a tree before it becomes
   work. An agent that can rewrite a card while somebody is reading it has taken back the thing the
   review was for. Nothing about the deepen use case needs it: `final: true` is the agent's OWN
   decision about when it has finished, so an agent that wants another turn simply does not send it
   yet.
2. **It duplicates `updateProposal`'s reach with a weaker record of who did it.** The review edit runs
   under a session cookie and a named human; a PAT edit records the token owner, who may not be the
   person holding the queue. Two writers on one row with two different attribution stories is how an
   audit trail stops answering the question it exists for.
3. **A change after `final` is not a deepen, it is a re-decision.** Deepening fills in a card whose
   shape the agent already settled. Changing a card somebody has been asked to approve is a different
   act with a different owner, and the surface for it already exists.

**The consequence, stated rather than smoothed over:** an agent that sends `final: true` and then
notices a bad card cannot fix it on this surface. Its recourses are the reviewer's own inline edit,
or a decline and a fresh plan — which is cheap, and is D4's territory.

---

### D2 — Which PERMISSION does the tool name?

#### Decision: `ai:view_plan` — the key `editAddProposal` itself asserts.

`docs/decisions/token-permissions.md` §3's rule is total and Q2 above applied it: an entry names the
permission the tool's own SERVICE already asserts, read off the code. Read off `origin/main`:

| tool               | service call                  | the assertion, at                                                                | key            |
| ------------------ | ----------------------------- | -------------------------------------------------------------------------------- | -------------- |
| `update_plan_item` | `plansService.deepenProposal` | `assertPermission(plan.projectId, ctx, 'ai:view_plan')` (`plansService.ts:1355`) | `ai:view_plan` |

Not `work_item:edit` — that is `create_plan`'s key because `createPlan` asserts `assertCanEdit`, and
naming it here would be a fiction in the narrowing direction: the gate does not become tighter because
the map says so. Not `ai:plan` either — Q2's last paragraph holds unchanged: this tool starts no model
job and spends no provider tokens, so it does not join `MCP_BILLABLE_TOOLS`.

**The family resemblance and the assertion agree, and the assertion is why.** `add_plan_items` is
`ai:view_plan` because `addProposals` asserts it; the deepen is the same act on the same plan and
asserts the same key at `:1355`. That the two answers coincide is a check, not the argument.

**Two consequences carry over from Q2 unchanged, and neither is widened here:**

- **A device-minted CLI token cannot deepen.** `CLI_TOKEN_GRANT` is
  `['project:browse', 'work_item:edit', 'comment:add', 'ai:plan']` — no `ai:view_plan`. Asked and
  answered per the grant's own doc comment: `packages/cli/src/client.ts` calls no plan-authoring tool,
  and the grant is deliberately NOT widened.
- **AMENDMENT 1's refusal shape is unchanged, one call earlier.** A sandboxed run holding that grant
  can `create_plan` and is refused on its first `add_plan_items` (MOTIR-3051); it never reaches a
  deepen. This amendment adds no new way for such a token to leave a half-built plan behind.

---

### D3 — Does the EDITABLE SET widen?

#### Decision: by exactly ONE field — `executor`. `targetRepo` / `targetRepoRole` and `parentRef` / `blockedByRefs` are NOT deepenable.

The line, stated once so the next field lands on a rule rather than on a precedent: **a deepen may
change what a card SAYS and who ACTS on it; it may not change where the card SITS or SHIPS.** Structure
is settled by append order and validated at approve; content is what a second pass is for.

#### (a) `executor` — WIDENED, and the reading the card asked for

MOTIR-3089 asked whether a titles-first proposal that gains its `type` on deepen ends up with the right
executor at materialize, _"or a null one"_, and said to read the code before answering. **It ends up
with a null one.**

- `mergeProposedFields` is an explicit key-by-key merge and says so:
  _"`executor` is never touched (not in the editable set)"_ (`plansService.ts:224`).
- `materialize` writes
  `executor: (pf.executor as Prisma.WorkItemUncheckedCreateInput['executor']) ?? null`
  (`plansService.ts:805`). It never calls `defaultExecutorForType`.

So the type→executor default map — `lib/issues/executorDefaults.ts`, which the 2.7.2 ADR froze as the
single source for _"what executor does a freshly-typed work item default to"_, and which the picker, the
seed loader and `workItemsService` all call — is the one thing the materialize path does not consult. A
card deepened to `type: 'code'` materializes unassignable, and nothing on the way there says so.

- **Rejected — make `materialize` seed from `defaultExecutorForType`.** It would change what EVERY
  approve does, including every plan motir-ai has ever generated, to close a gap in one new caller; and
  it would overwrite a deliberate `executor: null` with a default, since a proposal cannot express the
  difference between _unset_ and _deliberately nobody_. It also puts a defaulting rule inside the one
  transaction that creates rows, which is the worst place to discover it is wrong.
- **Rejected — leave the set closed and require `executor` at APPEND.** It is expressible today
  (`add_plan_items`'s `proposedFields` already carries `executor`), but it demands that the skeleton
  pass already know the card's `type` — which is precisely what the deepen pass exists to decide. A
  phase split that forces the second phase's input into the first is not a phase split.

**Widening costs the human review surface nothing, and that is a reading rather than an intention.**
`UpdateProposalInput` already carries a field the review route does not pick up — `explanationMd`
(`lib/dto/plans.ts:363`, added by MOTIR-850) — because
`app/api/plans/[id]/items/[itemId]/route.ts` builds its input by ENUMERATING the keys it accepts. Adding
`executor` to the DTO and to `mergeProposedFields` therefore leaves `PATCH /api/plans/{id}/items/{itemId}`
byte-identical, and MOTIR-3088's boundary — _the human review surface does not change_ — holds literally.

**Where the value is validated: at the transport, exactly as on the append path.** `add_plan_items`
constrains `executor` with `z.enum(['coding_agent', 'human'])` in its own argument schema
(`lib/mcp/tools/authorPlan.ts`), not in the service; `validateProposal` does not check it. The deepen
tool constrains it identically. **No service-level validation is added and none is removed** — this
amendment widens a merge, not a contract.

#### (b) `targetRepo` / `targetRepoRole` — NOT widened

`mergeProposedFields` omits both, and the code already records that it does
(`plansService.ts:1794` — _"`updateProposal`'s editable set (`mergeProposedFields`) does not include
`targetRepo`"_).

**Is the pin knowable at skeleton time? Yes — and it has to be.** ONE SUBTASK = ONE REPO = ONE PR makes
the repo pin part of a leaf's IDENTITY: the card that ships in `motir-core` and the card that ships in
`motir-meta` are two cards, not one card with a field to fill in later. That is the same class of fact as
`parentRef` and `blockedByRefs`, and it belongs in the same pass.

- **Rejected — widen so a deepen may re-pin.** It would give an AGENT a power the human REVIEWER does not
  have: the review route cannot re-pin a proposal's repo either, and `updateProposal` could not express it
  if it tried. A capability asymmetry in that direction is the wrong one to introduce.
- It also buys no earlier validation. A proposal's `targetRepo` is checked at APPROVE against the
  project's repository set (`PlanItemProposedFields.targetRepo`), not at append, so a late pin is not a
  pin that gets verified sooner.

**What an agent does when it pinned wrong:** before `final`, author a fresh plan — they cost nothing and
start no job. After `final`, it is the reviewer's decline.

#### (c) `parentRef` / `blockedByRefs` — NOT widened, explicitly

- **They are not in the editable set's SHAPE at all.** They live on the `PlanItem` row, not inside
  `proposedFields`, so "widen `UpdateProposalInput`" is not even the right move for them — it would be a
  second, different write.
- **A mutable ref graph moves a cycle's discovery to the worst possible moment.** The append-order
  temp-ref contract is what makes a tree buildable layer by layer: `add_plan_items` returns
  `planItemIds` in append order, and `topoOrderAdds` (`plansService.ts:279`) resolves `planItem:` parent
  refs at materialize, throwing `UnresolvedPlanRefError` on a cycle. Refs that can be rewritten after they
  land let an agent build a cycle inside a `generating` plan that nothing catches until a person clicks
  approve.

**What an agent does instead:** send the layers in dependency order, parents before children — the
contract `add_plan_items` already publishes — or author a fresh plan.

---

### D4 — Is `remove` reachable? Can an agent WITHDRAW a proposal it appended?

#### Decision: NO, and it is DEFERRED to its own card rather than answered here.

**This is not the same shape as the deepen, and the difference is why it is deferred.** The deepen was a
transport gap: the service method existed, was tested, and had no PAT-authed caller. Withdrawing a
proposal has no substrate at all.

- `op: 'remove'` is not it. It requires `workItemId` (`plansService.ts:216`) — it targets an existing
  `work_item` and removes a card from the TREE at approve. It cannot address a `PlanItem` this plan
  created.
- `planItemRepository` has `create` / `findById` / `findByPlan` / `update` / `setWorkItemId` /
  `deleteByPlan`. There is no per-item delete, and `deleteByPlan` is a whole-plan operation.

**The interim answer, and it is a real one: decline the plan and author a new one.** A plan costs nothing,
starts no job and spends no credits; nothing exists in the tree until approve. Re-authoring a `generating`
plan is cheap in exactly the way re-doing shipped work is not.

- **Rejected — neuter the card through the deepen** (retitle it _withdrawn_, empty its body). It leaves a
  proposal a reviewer must still read and dispose of, and it makes the plan's item count a lie.

**The debt this defers, named so the next card inherits it rather than rediscovers it.** An MCP-authored
plan abandoned mid-skeleton stays `generating`: AMENDMENT 2's reconciling sweep asks motir-ai what became
of the JOB, and an MCP-authored plan has no job (`sourceJobId` is null). AMENDMENT 1 keeps an EMPTY one
from pausing that project's cadence; one that already holds proposals is exactly the case AMENDMENT 1
says somebody owes a decision on. **This amendment does not pay that debt** — it is the reason a withdraw
op is worth its own card rather than a clause here.

---

### What this amendment does NOT do

- **It does not change `materialize`.** Approve reads `proposedFields` exactly as it did; the executor a
  deepened card carries is one the agent set, never one the platform inferred.
- **It does not change the human review surface.** `updateProposal` and
  `PATCH /api/plans/{id}/items/{itemId}` are untouched, including their accepted key set.
- **It does not touch the internal generation seam.** `aiGenerationService.patchProposal` and its
  `sourceJobId` resolution stay as they are; the MCP tool resolves by `planId` and must not grow a second
  resolution path into that service.
- **It does not widen `CLI_TOKEN_GRANT`,** and it adds no `/api/v1` twin — plan authoring is agent-facing,
  and the public REST plan operations stay read-only.
- **It does not add a withdraw / remove-a-proposal op** (D4).

---

---

## AMENDMENT 5 — AUTHOR and DECIDE are two permissions, not one (MOTIR-3188, 2026-08-20)

Q2 gave `add_plan_items` the key `ai:view_plan`, and gave a reason that is still the right reason:
a row names **the key its own service asserts**, and `plansService.addProposals` asserts that one.
What Q2 did not ask is whether the key it was naming describes a single authority. It does not, and
by the time Q2 was written the conditions that made the conflation safe had already gone.

> Every reading below was taken off `origin/main` at `a1f8aaad` on 2026-08-20.

### The key gates no view

Every plan READ runs on `project:browse`:

- `planReviewService.getPlanReview` — the plan-detail read — is enforced by `canBrowse`, and its own
  doc comment says so.
- `GET /api/v1/plans/[planId]` and `.../status` both declare `permission: 'project:browse'`.
- The MCP `get_plan` / `get_plan_status` rows in `lib/mcp/toolPermissions.ts` are `project:browse`.

So the name has never described the gate. Every call site that asserts `ai:view_plan` is a WRITE —
and **two different authorities sit inside it**:

| call site                                          | what it does                             | authority  |
| -------------------------------------------------- | ---------------------------------------- | ---------- |
| `plansService.addProposals`                        | appends proposals to a `generating` plan | author     |
| `plansService.markPlanned` (the `final: true` arm) | closes the generation frontier           | author     |
| `plansService.editAddProposal` (both its callers)  | edits a proposal in place                | author     |
| `plansService.approvePlan`                         | MATERIALIZES the subtree into work items | **decide** |
| `plansService.declinePlan`                         | ends the plan                            | **decide** |

`approvePlan` asserted `ai:view_plan` and **nothing else** — no `work_item:edit`, no
`work_item:triage`. The key that creates work items in bulk was the key whose name says _can look at
a plan_.

### The shipped rationale, and why it expired

`editAddProposal` stated it in terms, and it was sound when written:

> THE NAME IS THE MISLEADING PART: this key governs reading a generated plan AND acting on it,
> because they are the same surface and a reviewer who may not act has nothing to review for.

That premise held while the only reviewer was a person under a **built-in** role: `member` holds
`ai:plan` + `ai:view_plan`, `viewer` holds neither, so nobody could see a plan without being able to
act on it and the conflation was unobservable. Two shipped changes broke it.

1. **Custom roles (MOTIR-2257).** `builtinRoles.ts` states the rule: _"a custom role grants EXACTLY
   WHAT IT LISTS, on every access level […] a permission set an admin enumerated by hand is not
   coarse."_ An admin who ticks `ai:view_plan` meaning the thing its label said has handed that role
   bulk work-item creation — while deliberately leaving `work_item:edit` unticked. A privilege
   escalation reachable entirely from the Roles & permissions screen, with no code change and no
   warning.
2. **The reviewer is no longer only a person (MOTIR-2984 / -2988, and MOTIR-3021 in flight).**
   Authoring a proposal and deciding a plan are now done by different actors holding different
   tokens. One key cannot express that, and _"a reviewer who may not act"_ is exactly the actor an
   agent-authoring token is supposed to be.

### Decision: `ai:view_plan` keeps the AUTHOR writes; a new `ai:decide_plan` gates the two decisions

`approvePlan` and `declinePlan` assert **`ai:decide_plan`**. `addProposals`, `markPlanned` and
`editAddProposal` are untouched, and so are the `add_plan_items` / `update_plan_item` rows in
`lib/mcp/toolPermissions.ts` — Q2 and AMENDMENT 4 D2 are unchanged, because both named the key
their own service asserts and their services still assert it.

**Behaviour-neutral on the built-in roles by construction.** `ai:decide_plan` enters
`ROLE_GATED_PERMISSIONS` (so `admin` and both workspace-manager rails hold it) and
`BUILTIN_ROLE_PERMISSIONS.member`, and enters neither `viewer` nor
`IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS`. `levelGrants` names only the three edit-ish keys, so the new
key takes the default arm and resolves identically to `ai:view_plan` on all four access levels and
both rails. Every actor who could approve a plan before can approve one after. What changes is that a
**custom** role can now withhold one without the other — the same property MOTIR-2256's twelve
administrative keys claimed.

**It IS grantable to a token, through exactly one operation — and MOTIR-3021 settled that while
this amendment was open.** An earlier draft of this paragraph said the opposite, and recording the
correction is worth more than the tidier text:

> It is not grantable to a token, and that is derived rather than chosen. `GRANTABLE_PERMISSIONS` is
> computed from the operations a token can reach; no MCP tool and no `/api/v1` operation asserts
> `ai:decide_plan`, so it lands in `UNGRANTABLE_PERMISSIONS` on its own. MOTIR-3021's public approve
> entrance is the card that would change that, and when it lands it must name `ai:decide_plan` and
> add the key to `V1_ONLY_PERMISSIONS` with a reason.

MOTIR-3021 **landed first** (2026-08-20, motir-core#2191), shipping
`POST /api/v1/work-items/{key}/plan-approval` — the bounded entrance
`motir auto --auto-approve-replan` drives. So the obligation the paragraph named came due
immediately, and both halves are in this change: the route declares `ai:decide_plan`, and
`V1_ONLY_PERMISSIONS` carries the key. That array had been **empty since it was created**, held open
as an extension point for exactly this; `ai:decide_plan` is the first key to need it, because it is
the first key a v1 operation asserts that no MCP tool does.

**Still not an MCP tool, and that bound got STRONGER rather than weaker.** The route's own comment
argues that a sandboxed agent must never approve its own re-plan, and rested that on
`CLI_TOKEN_GRANT` omitting `ai:view_plan` — one entry missing from one grant. After the split the
route declares a key that grant also omits AND that no tool asserts at all, so the agent credential
cannot reach approval by any route, and could not even if somebody widened that grant to the whole
author key. `declinePlan` remains unreachable by any token: no tool, no v1 operation.

### Rejected: rename `ai:view_plan` to `ai:author_plan` instead

The honest name for what survives in `ai:view_plan` is `ai:author_plan`, and renaming it is the
option that fixes the label without adding a key. It was rejected **for this card**, not on the
merits:

- The key id is a **persisted value** — `role_definition.permissions` is a `String[]` of catalog keys
  — so a rename is a data migration over every custom role in every workspace, plus every stored
  `api_token.scopes` row that expanded to it. `expandStoredGrant` drops values it cannot interpret,
  by design, so a missed row degrades to LESS access silently.
- A rename does not close the escalation. A custom role that holds the renamed key still approves
  plans; only the split does.
- Bundling both makes one change irreversible: a rename is a migration to write backwards, while
  adding a key and moving two assertions is a revert.

So the split ships alone, the key id is left exactly as it is, and the rename is a second card.

**One thing this card DID change about the name, deliberately and without touching the key id:** the
`permissions.ai_view_plan` **label and description** in `en` / `zh`. They read _"View AI plans" /
"Open a generated plan and read its proposals"_ — a description of a gate that does not exist, on the
one surface where the whole escalation happens (an admin reading names off a grid). They now describe
the AUTHOR writes. That is display copy, not the persisted key, so it carries none of the migration
cost above; leaving it would have meant shipping the split while the screen still told the admin the
old lie.

### What this amendment does NOT do

- **It does not rename `ai:view_plan`.** The key id is unchanged, in the catalog, in every role set,
  and in every persisted row.
- **It does not change any AUTHOR gate.** `addProposals`, `markPlanned` and `editAddProposal` assert
  `ai:view_plan` exactly as before, and `create_plan` still asserts `work_item:edit` (Q2).
- **It does not change any plan READ.** They were `canBrowse` before and are `canBrowse` after; this
  amendment records that fact rather than altering it.
- **It does not widen `CLI_TOKEN_GRANT`,** and it adds no route. `approvePlan` reaches the public
  surface through MOTIR-3021's `POST /api/v1/work-items/{key}/plan-approval`, which landed first;
  this change re-declares that route's key and nothing else about it.
- **It does not bump `V1_CONTRACT_VERSION`.** Re-declaring an operation's gate moves no §8 clause —
  no field removed, renamed or retyped, no `code` repurposed, no existing condition's status
  changed, no limit tightened, no optional parameter made required. §8 governs the contract's
  SURFACE, and a permission is not on it; adding a clause for one would be a policy decision with a
  test binding of its own (`lib/apiDocs/guide.ts`'s `POLICY_FORBIDDEN`), not a footnote to this card.
  The one real consequence is stated in `contractVersion.ts` rather than hidden: a token holding an
  explicit grant of `ai:view_plan` and not `ai:decide_plan` loses that operation and needs its grant
  edited. Every built-in role is unaffected, and `DEFAULT_TOKEN_GRANT` is derived at mint.
- **It does not touch `PLANNED_PERMISSIONS`.** The new key is `enforced` on arrival, because the gate
  and the key land in the same change.

---

## AMENDMENT 6 — a `generating` plan can be DISCARDED, and a `declined` one records WHY it ended (MOTIR-3189, 2026-08-20)

AMENDMENT 2 reconciles an abandoned plan only when it is EMPTY, and said so on purpose:

> **Empty-only is the card's AC 5**, and it is the same line AMENDMENT 1 drew: a PARTIAL plan is
> a real proposal a person can read and decline, so nothing here may touch it.

Read, yes. Decline, no.

> Every reading below was taken off `origin/main` at `05d9cc71` on 2026-08-20.

### The exclusion protected a decision nobody could make

`plansService.declinePlan` re-reads the plan under its row lock and throws
`PlanNotInExpectedStatusError` unless `fresh.status === 'planned'`. `approvePlan` does the same.
So there was **no path out of `generating` for anyone** — not the sweep, not a person, not a
token. The clause above is not a narrow exclusion; it is a permanent one, and the plans it
strands are stranded in exactly the state MOTIR-3064 was written to end.

The harm is that card's harm, unchanged. `planRepository.findUndecidedByProject` reads
`generating` as UNDECIDED, and that is `autoPlanCadenceService`'s first gate — so a stranded
partial plan pauses its project's auto-plan cadence indefinitely, with the AI-planning settings
page reporting a proposal waiting on a decision nobody can make.

And the class is not small. Generation STREAMS: `motir-ai/src/llm/treeGeneration.ts` instructs
_"Emit ONE proposal per tool call — never a batched tree-delta"_, and each call is a
`POST /api/internal/ai/plan-proposals` append. The only `generating → planned` transition is
`markPlanned`, i.e. the `final: true` flag on that same seam. So a plan goes non-empty at the
FIRST `propose_node` and stays that way until the last call — AMENDMENT 2's window is the gap
between `createPlan` and the first append, and the generation itself is **everything after it**.
A worker crash, a job failure, a cancel or a context blowup anywhere in that span leaves a
partial plan, which is to say: almost every motir-ai death.

A second class has no sweep at all. A plan opened by `create_plan` over the MCP carries no
`sourceJobId` (Q3), so `listAbandonedCandidates` — whose whole method is to ASK motir-ai what
became of the job — can never reach it, however old it gets. There is nothing to ask about.
Observed 2026-08-19: plan `cmt0nxdb600qni3phtsm1jpdp`, three proposals, `authorSource: mcp`,
`sourceJobId: null`, abandoned mid-authoring because its skeleton batch omitted a `blocked_by`
edge, re-authored as a fresh plan — and still `generating`, with no way to end it.

### D1 — the DISCARD is `declinePlan` with a second legal from-status, not a second method

`declinePlan` now accepts `planned` OR `generating`, and refuses anything else with the same
typed 409 (naming both legal origins; `actual` still rides the field per MOTIR-3025).

The alternative was a `discardPlan` beside it. Rejected: the two are the same act — _stop this
plan, keep what it proposed_ — and everything that makes the act safe is shared. A second method
would be a second copy of the `ai:decide_plan` assertion, the `lockById` + re-read, the
retain-every-PlanItem rule, the real item count and the planning-target lock release, kept in
step by hand. The only thing that genuinely differs is which reason gets recorded, and the
from-status already answers that.

**Nothing is deleted, and that is settled law here rather than a fresh decision.** `declinePlan`
used to drop every PlanItem in the same transaction; that is the defect MOTIR-3154 reported and
MOTIR-3160 fixed, and the repository's delete method went with its only caller. There is no
`plan.delete` / `planItem.delete*` call site in `lib/` or `app/` today and this card adds none.
No `deletedAt` column either — **the row IS the tombstone**. The rule matters MORE on a discard
than on a review: a half-generated plan's proposals are the only surviving record of how far its
producer actually got.

**`plannedAt` is not back-filled.** The generation frontier genuinely never closed. Stamping it
would make a plan that died halfway indistinguishable from one that finished and was turned
down, which is the precise conflation D3 exists to remove.

### D2 — the sweep gains the PARTIAL arm, and the write's guard becomes a COMPARISON

With the valve real, `listAbandonedCandidates` drops `items: { none: {} }`. A `generating` plan
with a producer, past the grace, whose job is provably gone is declined whatever it holds.

Nothing else about the decision table moved. `job_terminal` / `job_gone` / `max_age` still
terminate; `job_in_flight`, `ai_unreachable` and `row_moved` still terminate nothing; the
15-minute grace still keeps the sweep out of the submit→first-append window, and a partial plan
behind a LIVE job is left alone by exactly the arm that leaves an empty one alone.

One thing did have to change, and it is worth stating because it is easy to read the old code as
a single guard. `items: { none: {} }` was doing **two** jobs: the discovery filter here, and the
did-it-move check the write re-ran under the plan's own workspace context. With the filter gone
the check cannot stay a presence test, or a plan that was already partial at discovery would be
selected and then refused for the very property it was selected for. So the candidate carries
`_count.items`, read in the same statement, and the write refuses on a **mismatch**. `row_moved`
keeps meaning exactly what it always meant — the row changed between the ask and the act — and a
proposal that lands DURING the network call is still a leave, because it means the producer was
alive after the job said otherwise.

**The RLS direction reverses, into the safe one.** AMENDMENT 2 flagged the surprising half: under
a correlated `NOT EXISTS`, an RLS-hidden `plan_item` row makes the test vacuously true, so the
blind spot **widened** the scan onto exactly the plans the exclusion protected. Under `_count` a
hidden proposal reads the count LOW at discovery, the write re-counts bound to that plan's own
workspace, the two disagree, and the verdict is `row_moved`. A blind spot now costs a pass, not a
plan. The `plan_item_system_read` arm stays regardless — the scan reads that table either way,
and a permanently-`row_moved` sweep is a broken sweep.

### D3 — `decisionReason` is a private COLUMN, not a fourth `PlanStatus` member

Once discard also writes `declined`, that one status covers three histories:

| what happened                                 | `plannedAt` | `decidedById` | `decisionReason` |
| --------------------------------------------- | ----------- | ------------- | ---------------- |
| a person reviewed a finished plan and said no | set         | set           | `reviewed`       |
| a person discarded a half-generated plan      | null        | set           | `discarded`      |
| the sweep terminated a dead producer          | null        | null          | `abandoned`      |

All three were **derivable** from the null pattern and none was **recorded**.
`PlanHistoryEventDto.kind` was `'created' | 'planned' | 'approved' | 'declined'`, so
`planReviewService` pushed one `declined` event and `PlanReviewRail` rendered all three
identically — a reader could see that a plan ended, not why. Telling somebody whose generation
crashed that a person read their plan and rejected it is not a cosmetic defect.

**This does NOT reopen AMENDMENT 2's rejection of a new `PlanStatus` member, and the reasoning is
unchanged in both directions.** That vocabulary is PUBLIC: v1's `planStatusSchema`, the
`get_plan_status` MCP tool description, `PlanStatusDto`, four display switches, the i18n catalogue
and its zh-parity gate — and every consumer of the status is asking _is it decided?_, which
`declined` already answers. A private column reaches the review surface and the sweep's log line,
and costs none of that. AMENDMENT 2's own fallback — _"the honesty lives in the ACTOR:
`decidedById` is NULL"_ — was already doing a column's work with a null; this finishes it.

- **The event KIND is what carries it to the reader, not the status.** `PlanHistoryEventDto.kind`
  gains `'discarded'` and `'abandoned'`, mapped from the reason by `planReviewService`. Widening
  `kind` IS one of the four display switches D3 just declined to pay for a status member — paid
  deliberately, because making the difference visible is the entire point here and was not the
  point there.
- **NULL is not a fourth reason.** Every row written before the column reads null, which means
  _not recorded_, and both the timeline and the outcome block fall back to the original `declined`
  wording — the one that was true for those rows. `approved` carries null always: an approval has
  one history.
- **`declinedOutcomeKey` is total over the union** rather than a lookup with a default, so adding
  a reason is a type error at the surface rather than a plan silently rendering as
  reviewed-and-rejected.

### What this does NOT do

- **It does not expire or auto-decline a plan by AGE alone.** `max_age` still requires a producer
  that was asked about and a job that never went terminal; a plan nobody can ask about
  (`sourceJobId IS NULL`) is reachable only by a PERSON, through the discard path. AMENDMENT 1's
  line holds for it: that is a decision somebody owes.
- **It does not add a Discard BUTTON.** `design/ai-planning/design-notes.md` Panel B fixes the
  decision bar as Approve + Decline and says _"NO 'Discard'"_, and that is about the bar a
  `planned` plan shows — which this card does not touch. The `generating` surface has no decision
  bar at all today; drawing one is a design question and its own card.
- **It does not rename the `declined` status.** Three endings share it, and D3 is how they are
  told apart.
- **It does not give motir-ai a stale-job reaper.** A worker that dies still leaves `running` on
  its own side; this card widens what core can recover from without it.

---

## AMENDMENT 7 — a plan with NO producer is judged by the decision table, not excluded by the query (MOTIR-3236, 2026-08-20)

AMENDMENT 4 named a debt and declined to pay it:

> **The debt this defers, named so the next card inherits it rather than rediscovers it.** An
> MCP-authored plan abandoned mid-skeleton stays `generating`: AMENDMENT 2's reconciling sweep asks
> motir-ai what became of the JOB, and an MCP-authored plan has no job (`sourceJobId` is null).
> […] **This amendment does not pay that debt.**

**This one does.** The mechanism is exact and was grepped rather than guessed:
`planRepository.listAbandonedCandidates` selected
`{ status: 'generating', sourceJobId: { not: null }, createdAt: { lte: olderThan } }`, and
`create_plan` writes `sourceJobId: null` by construction. **The two sets are disjoint**, so the
hourly sweep could never see an agent-authored plan, whatever its age.

**The live reading that closed the hypothesis** (production `motir-core`, 2026-08-20T20:21Z, both
rows in the `MOTIR` project — they were the entire `generating` population across every project):

| age    | `source_job_id` | `author_source` | items |
| ------ | --------------- | --------------- | ----- |
| 21.9 h | **NULL**        | `mcp`           | 3     |
| 19.5 h | **NULL**        | `mcp`           | 1     |

### The second harm, which is not the same one

AMENDMENT 1 (MOTIR-3051) keeps an **EMPTY** job-less plan from pausing the project's auto-plan
cadence, through `findUndecidedByProject`'s
`NOT: { status: 'generating', sourceJobId: null, items: { none: {} } }`. That exclusion is
**presence-based**, so a job-less plan that appended a SKELETON and then stopped holds items, is
not excluded, and **pauses that project's cadence permanently** — the exact harm AMENDMENT 2 was
written to remove, arriving through the door AMENDMENT 1 left open. Both live rows above hold
items, so both were doing it, for ~22 and ~20 hours.

### The decision — a RE-SHAPE, not a fourth widening

The predicate has now been narrowed or widened three times (AMENDMENT 1's gate exclusion,
MOTIR-3064's sweep, AMENDMENT 6's widening to partial plans) and this is the fourth defect in the
same shape. **They share a root: the SQL predicate was a WHITELIST of the plan shapes the sweep
knew how to judge, so every newly-recognised shape was a new query-level edit.** The service
already owns a pure, unit-testable decision table built for precisely this reasoning.

So: **the predicate selects every `generating` plan past the grace, and
`classifyAbandonedCandidate` decides.** `sourceJobId` becomes an INPUT to the classification
rather than a condition of selection, and the next unrecognised shape is a new arm in a pure
function with a test, not another migration-adjacent query change.

- **`AbandonedPlanCandidate.sourceJobId` is nullable again** — the cast that narrowed it to
  `string` is REMOVED, not weakened, so the compiler forces the caller to handle the null rather
  than letting one reach `resolveJobState` as a job id.
- **The new arm is `no_producer`.** A plan with no `sourceJobId` has nothing to ask, so the only
  signal left is the passage of time — which is the argument `ABANDONED_PLAN_MAX_AGE_HOURS` already
  makes for the crashed-worker case. It **REUSES that constant**; no second threshold is
  introduced. Past it: `declined`, `decisionReason: 'abandoned'`, `decidedById: null` — nobody
  decided it. Inside it: the new KEEP arm `no_producer_recent`, because an agent mid-skeleton right
  now looks exactly like one that stopped, and the 15-minute grace is far too short to tell them
  apart.
- **`reconcileAbandoned` does not call `resolveJobState` for a producerless candidate.** Asking
  about a job id that does not exist is a request that can only 404, and a 404 already means
  something else here (`job_gone` — a producer that existed and is provably dead). Sending one
  would launder _there was never a job_ into _the job died_.
- **The `row_moved` re-read and the `_count.items` comparison run unchanged** for a no-producer
  candidate, so a plan an agent appended to DURING the pass is left alone exactly as before.
- **The sweep's log line names the absent producer** rather than printing `job null` beside a job
  status, which would read as a failed lookup instead of a plan that never had one.

### ⚠️ What this SUPERSEDES in AMENDMENT 6

AMENDMENT 6's _What this does NOT do_ says, in full:

> - **It does not expire or auto-decline a plan by AGE alone.** `max_age` still requires a producer
>   that was asked about and a job that never went terminal; a plan nobody can ask about
>   (`sourceJobId IS NULL`) is reachable only by a PERSON, through the discard path. AMENDMENT 1's
>   line holds for it: that is a decision somebody owes.

**That is reversed here, deliberately, and the reasoning that failed is worth keeping.** It rests
on AMENDMENT 1's line — _a partial plan is a real proposal somebody owes a decision on_ — plus
AMENDMENT 6's own new discard valve, which gives a person the door AMENDMENT 1 assumed. The part
that did not survive contact is the assumption that **somebody is there**. A plan authored over the
MCP is written by an agent in a session that has since ended; the person whose token it used is not
watching the Plans list, and the two live rows sat there for the better part of a day with the
discard valve shipped and reachable. A decision somebody owes and nobody makes is indistinguishable
from an abandoned plan after a day — which is exactly the judgement `ABANDONED_PLAN_MAX_AGE_HOURS`
was chosen to make. **The discard valve is not removed and is not weakened**: a person can still end
one of these at any moment, and doing so records `discarded` rather than `abandoned`, so the two
histories stay told apart on the row.

The narrower claim in that bullet — that `max_age` itself requires a producer — remains TRUE:
`max_age` and `no_producer` are separate arms, and `max_age` still means _asked, and told nothing
terminal_.

### What AMENDMENT 7 does NOT do

- **It does not change `findUndecidedByProject`.** Its exclusion stays exactly as written and
  becomes REDUNDANT rather than wrong: once the sweep can reach these rows, an abandoned job-less
  plan leaves `generating` on its own and the gate never sees it. Two mechanisms narrowing the same
  set is how they drift; one of them is now the mechanism and the other is a fast path.
- **It does not add an inbound failure callback.** AMENDMENT 2 rejected that and the rejection
  holds — this widening needs no producer to report anything.
- **It does not change `declinePlan`, the cadence tick, the Plans list UI, or any `PlanStatus` /
  `PlanDecisionReason` vocabulary.** `abandoned` already exists (AMENDMENT 6, D3) and is what this
  arm writes.
- **It does not shorten the grace or the max age.** Both constants are untouched; what changed is
  which rows are measured against them.

---

## AMENDMENT 8 — a proposal can be CORRECTED and WITHDRAWN, for an explicit correction only (MOTIR-3540, 2026-08-26)

AMENDMENT 3 D3 fixed the deepen turn's editable set with a rule, and D4 declined the withdraw and
deferred it to its own card. **This is that card, and it amends both.**

The two answers are still right about the act they were written about, and this amendment does not
soften either one. What neither had a case for is an AUTHOR CORRECTING ITSELF.

### What forced it — a live artifact, not an argument

Plan `cmt9dk0bs00a2i2phxl2xb5x1` reached the review queue carrying
`blockedByAdd: ['planItem:PLACEHOLDER']` — a temp-ref naming no proposal, written because both
proposals went out in ONE `add_plan_items` batch and an `add`'s id does not exist until that call
returns. The mistake was visible one second later. **There was nothing to do about it.** The repair
was a whole second plan (`cmt9dlzvg00c1i1n83d0fc9zd`), and the broken one still had to be declined
by hand.

The asymmetry, written down, is the argument: an agent may create a plan, append any number of
proposals, deepen each of them, and close it for review — four write doors. To correct any of it, it
had zero.

### D3, amended — the editable set widens for a CORRECTION, and NOT for a deepen

D3's line — _a deepen may change what a card SAYS and who ACTS on it; it may not change where the
card SITS or SHIPS_ — is preserved verbatim for the deepen turn. `UpdateProposalInput` is unchanged,
`update_plan_item` is unchanged, and the human review route stays byte-identical.

**A CORRECTION is a different act**, and the difference is not a preference:

|                 | a DEEPEN                                   | a CORRECTION                                                 |
| --------------- | ------------------------------------------ | ------------------------------------------------------------ |
| trigger         | the second phase of titles-first authoring | the author discovered its own structural mistake             |
| when            | mid-generation, structure freshly settled  | after the append, often after `final: true`                  |
| the alternative | send the next layer                        | author an entire second plan and ask a person to decline one |

So `CorrectProposalInput` is a SEPARATE interface carrying `parentRef`, `blockedByRefs`,
`targetRepo` and a `modify`'s `patch`, reached by a THIRD service method (`correctProposal`).

> **⚠️ AMENDED 2026-08-29 (MOTIR-3865) — the structural set is FIVE, not four: `targetRepoRole`
> joins it.** The omission was not a decision taken here; it is what a four-item list looks like when
> the fifth member was never weighed. And it is the member an ONBOARDING plan actually carries: at
> generation the project's repositories DO NOT EXIST, so a fresh plan pins a ROLE and no name (§5.4 ·
> `PlanItemProposedFields.targetRepoRole`), and a correction reaching only the NAME could not correct
> such a plan's pin at all. Validated against the closed role vocabulary rather than the project's
> rows — the same check the append and a `modify`'s patch run — so it needs no repository to exist,
> which is the property that makes it sayable this early. The reasoning above is unchanged: a
> correction reaches where a proposal SHIPS, and a deepen still does not.
>
> **The same card closed the mirror hole on the CONTENT half.** `UpdateProposalInput` has declared
> `explanationMd` (MOTIR-850) and `executor` (AMENDMENT 4 D3a) all along, and the INTERNAL transport —
> `PATCH /api/internal/ai/plan-proposals/[itemId]`, the door Motir's own hosted planner reaches this
> service through — read NEITHER off the request body, on either mode. The service accepted them and
> the transport never supplied them, silently: a `200`, and the proposal keeps what it had. So an
> external MCP client could rewrite a landed plan's rationale and the product's own agent could not.
> The guard that ends the class is a DECLARED key constant (`UPDATE_PROPOSAL_KEYS` /
> `CORRECT_PROPOSAL_KEYS` in `lib/dto/plans.ts`) that the interfaces are held to at compile time and
> every transport is held to by test — so the next field added to either input fails in the pull
> request that adds it rather than being found months later by a re-plan that quietly under-delivered.

- **Rejected — widen `UpdateProposalInput`.** It would re-open structure on the deepen path as a
  side effect, which is exactly what D3 was protecting. Two inputs is what keeps both true at once.
- **D3(c)'s objection is answered rather than overridden.** It rejected a mutable ref graph because
  _"refs that can be rewritten after they land let an agent build a cycle inside a `generating` plan
  that nothing catches until a person clicks approve."_ That was true when it was written and is not
  true now: MOTIR-3539 moved the ref check to the APPEND, and `correctProposal` re-runs the same
  check on the corrected shape with the proposal being corrected EXCLUDED from the resolvable set —
  so a self-reference is refused, and a ref naming nothing cannot be written by a correction any more
  than by an append. The objection was to an UNCHECKED mutable graph.
- **D3(b)'s capability-asymmetry objection no longer applies in the direction it was aimed.** It
  rejected a re-pin because it would give an agent a power the human reviewer lacks. The reviewer's
  route was subsequently REMOVED (MOTIR-3084 — _"a proposal is READ and changed by re-planning"_),
  so there is no human editing surface to be asymmetric with; and re-planning, the remedy that
  removal named, is precisely the remedy that costs a human a decline per typo.

### D4, amended — the withdraw EXISTS, and it refuses rather than cascades

D4 said NO and named exactly what was missing: _"`planItemRepository` has `create` / `findById` /
`findByPlan` / `update` / `setWorkItemId` / `deleteByPlan`. There is no per-item delete."_ There is
now — `deleteById` — and `withdrawProposal` is the one caller.

- **It is not `op: 'remove'`,** which D4 correctly distinguished: that is a proposal to delete an
  existing work item from the TREE at approve and requires a `workItemId`.
- **It is not the neutering D4 rejected.** Retitling a card _withdrawn_ leaves a proposal a reviewer
  must still read and makes the plan's item count a lie. The row goes.
- **A referenced proposal is REFUSED, not cascaded** (`PlanProposalReferencedError`, naming every
  referrer). This is MOTIR-3539's check in the mirror: that card made a dangling ref impossible to
  CREATE, and this stops one arriving by DELETION instead. Cascading would take cards off the plan
  nobody asked to withdraw; blanking the refs would change what those proposals mean.
- **Withdrawing a `modify` RELEASES its target**, so a corrected `modify` on that work item can be
  appended — the escape `DUPLICATE_PLAN_TARGET` never had. That falls out of the delete rather than
  being coded: `claimedTargets` reads the rows that exist.

### The boundary — `approved` and `declined` are FROZEN

**Decided here, not deferred.** `generating` and `planned` are editable; the other two are not, for
two different reasons:

- **`approved`** — the proposals have MATERIALIZED. The work item is the source of truth and
  `update_work_item` is its door; editing the proposal afterwards leaves two disagreeing records of
  one thing.
- **`declined`** — a closed decision, with nothing downstream for an edit to reach.

`assertPlanProposalsEditable` is written as a DENY of the terminal states rather than an allow of the
two, so a future status is refused by default. The refusal NAMES the status and points at the
editable surface, because the caller is an agent that can act on being told where to go.

### What this does NOT change

- **`update_plan_item` / `deepenProposal` / `updateProposal`** — untouched, and a vitest gate pins
  that the deepen input still cannot reach `parentRef`, `blockedByRefs` or `targetRepo`. (MOTIR-3865
  adds `targetRepoRole` to the CORRECTION's set and to no other; the deepen's exclusion is unchanged,
  and the same gate covers it because it is one of the pins §5.4 pairs.)
- **`CLI_TOKEN_GRANT`** — not widened. `correctProposal` asserts `ai:view_plan`, the same key the
  rest of the author writes assert, so a sandboxed run still cannot author or correct a plan.
- **What approve materializes**, the resolver, and `PlanItem`'s `@@unique` / cascade shape.
- **The UI.** MOTIR-3084's removal stands; no component is added or modified.

### The trail

Both writes go through MOTIR-3532's content trail, in the mutation's own transaction, so the
six-site guarantee becomes eight and the structural guard in
`tests/integration/plans/planTrailCompleteness.test.ts` holds by derivation rather than by anyone
remembering. A correction records `edited` with `correction: true` in its diff; a withdraw records
the seventh verb, **`withdrawn`**.

**`withdrawn`, not `removed`** — a `remove` OP is a proposal to delete an existing work item, so
rendering a withdraw as _"1 proposal removed"_ would read to a reviewer as a card being deleted from
the tree.

**And the ACTOR is the agent, not the person.** `editAddProposal` discriminates on `expectedStatus`,
reading `planned` as _"only a person reaches this"_ — true while the review route was its sole
caller, and false the moment this method exists. A reviewer must be able to see WHICH harness and
model changed the tree under them, which is the whole reason this story is `blocked_by` the trail
story rather than merely sequenced after it.

## AMENDMENT 10 — a `planned` plan can be REVISED, and an approve that races one is REFUSED (MOTIR-3596, 2026-08-26)

AMENDMENT 8 gave an author two doors onto a plan it had already closed — `correctProposal` and
`withdrawProposal`, legal on `generating` and `planned` alike. It answered the question it was asked
(_may an author fix its own structural mistake?_) and left two it did not have to: whether a
correction may ADD, and what happens when the one irreversible act on the whole planning surface
runs at the same time as one.

**Both become load-bearing the moment a REVIEWER can ask for a revision**, which is the story this
amendment is written for. A correction door reachable only by the agent that wrote the plan races
nothing in practice — the author is finished before the plan reaches the queue. A door on the review
surface is pressed by definition while a person is looking at Approve.

> Every reading below was taken off `origin/main` at `3d1ffb25` on 2026-08-26.

### D1 — a revision MAY append, and the condition is VISIBILITY rather than status

`addProposals` asserts `plan.status === 'generating'`, twice — once before the transaction and once
under the plan row lock. So the one revision verb the substrate does not permit is the archetypal
request: _"split that story in two"_ needs a card that does not exist yet.

**Decision: an append to a `planned` plan is permitted exactly when the append DECLARES itself part
of a revision, and therefore records itself on the plan's content trail as one.** Concretely,
`addProposals` gains a fourth, optional argument; absent, the gate is `generating` and the method is
byte-identical to today; present, the gate is `assertPlanProposalsEditable` — the same two-status
gate `correctProposal` already uses.

**Why that is a rule and not an exception.** The `generating` assertion was never about generation.
It is the guarantee that _a plan under review does not change under the reviewer without their
knowing_ — which is why it was correct for as long as every write door was invisible. Restated as
the property it actually protects, the assertion reads: **the proposal set of a `planned` plan may
not change INVISIBLY.** AMENDMENT 8's correction door already satisfies that property (it writes an
`edited` row on MOTIR-3532's trail, with the harness and model that made it), and an append that
writes its `appended` row satisfies it identically. The relaxation is bound to the trail write, not
to the caller's identity, so there is nothing to check about who is asking.

Rejected:

- **No append at all — corrections and withdraws only.** It is a coherent boundary and it halves the
  feature. Most requests to change a plan are requests to add something; a revision that can only
  edit and delete leaves the reviewer's commonest ask on the decline path, which is the cost this
  story exists to remove.
- **Relax the assertion for everyone.** It would take the guarantee away from the four shipped
  producers to serve one new caller, and none of them asked. A gate that is relaxed by default is
  not a gate.
- **A second method — `appendRevisionProposals`.** It would duplicate the append's ref check, its
  `claimedTargets` map and its topological insert. MOTIR-3539's whole point is that the ref check
  lives where the write is; two writes means two places for it to drift.

**What D1 does NOT relax.** `markPlanned` still requires `generating`: a revision does not re-open a
plan, and `final: true` has no second meaning here — the plan is already `planned` and stays
`planned` throughout (the story's own boundary). And the resolvable set for a `planItem:` ref is
unchanged — the plan's already-persisted `add`s — which now simply includes everything the original
authoring pass wrote. A revision can therefore reference the tree it is revising, for free.

### ⚠️ D2 — an APPROVE that races a REVISION is REFUSED, by a LEASE on the plan's own trail

**The failure, named exactly.** `approvePlan` takes the plan row lock, re-reads the proposal set
FRESH under it, and materializes the whole set in one transaction. Every individual write is
therefore atomic and the COMPOSITION is not: a revision is a SEQUENCE of transactions — one proposal
per call, the discipline every shipped sink call site already follows — and an approve that takes the
lock between the third and the fourth of them materializes a tree that is neither the plan the
reviewer read nor the plan they asked for. **Approve is one-shot.** There is no un-approve, so the
cost of discovering this empirically is a half-revised tree in somebody's backlog with nothing to
say which cards were meant.

**And it is not a hazard this story introduces — it is one this story is the first to have to
answer.** `approvePlan` resolves its repository pins from a PRE-transaction snapshot, and justifies
that in its own comment: _"on a `planned` plan the proposal set is frozen"_, followed by an
enumeration of the doors that cannot move it. AMENDMENT 8's `correctProposal` reaches `targetRepo`
on a `planned` plan, so the enumeration is already incomplete on `origin/main` and a correction
landing between the snapshot and the transaction is dropped — the card materializes with the old pin
or with none. The comment's own warning named `mergeProposedFields`; the widening arrived through a
different door and walked past it. **A list of the doors that cannot move a set is a list that goes
stale silently.** D4 replaces it with a property.

**Decision: a LEASE on the plan. `approvePlan` and `declinePlan` REFUSE while a revision holds it,
naming the holder and the expiry. Neither act ever cancels the other; the loser retries.**

- **HELD** means: the plan's trail carries a `revision_started` with no `revision_ended` after it,
  and the most recent trail row at or after that `revision_started` is inside the lease window.
- **ACQUIRE** is a trail write under `planRepository.lockById` — the lock every plan mutation already
  takes. The plan row always exists, so the lock is real; this is the reasoning
  `planTargetLockService` records for locking the work ITEM rather than the lease row, and it applies
  here for the same reason.
- **The refusal is checked INSIDE the approve transaction, under that same lock.** Checked before
  the transaction it would be a TOCTOU read; checked under the lock it is an exclusion.
- **RELEASE** is `revision_ended`, written by the job that started it, in the transaction of its last
  write. A job that dies writes nothing and the lease ages out. **The expiry is the ONLY recovery
  path**, exactly as `lib/planChange/targetLock.ts` says of its own, and for the same reason: a plan
  whose edit job died sits at `planned` and no product event ever fires to say the session is over.
- **The window REFRESHES on every write the revision makes**, because it is measured from the latest
  trail row and every correction writes one. A long revision never ages out while it is doing
  something; the clock only starts running down once it stops, which is the condition the expiry
  exists to detect.

Rejected:

- **OPTIMISTIC — the revision carries a revision count, approve refuses if it moved.** Wrong at both
  ends, which is what disqualifies it rather than its cost. It cannot see a HALF-written revision,
  because the count moves on the revision's first write and the danger is the fourth; and it REFUSES
  an approve after a COMPLETED revision, which is precisely the act this story exists to allow — a
  reviewer approving the plan they asked for. A guard that fires on the safe case and not on the
  unsafe one is not a weaker version of the lease.
- **APPROVE WINS — cancel the in-flight revision.** It does not close the window. The revision runs
  in another service over HTTP; a cancel is cooperative and its in-flight call still lands after the
  approve has begun. And it silently discards work the user asked for at the moment they were most
  engaged, which is the exact complaint the story opens with.
- **A LEASE IN ITS OWN TABLE**, the shape `planTargetLockService` uses. Right when the lock's subject
  is a work item that may have no lease row yet; here it is a migration for a fact
  `PlanRevision.changeKind` already has somewhere to put — the column is plain text precisely so a
  new verb is a code change rather than a migration, which `planRevisionsService` records in as many
  words. Rejected as redundant, not as wrong. It also keeps the lease and its VISIBILITY the same
  record: the reviewer learns a revision is running by reading the timeline they were already
  reading.

### D3 — the two outcomes, and what a refused reviewer sees

An approve concurrent with a revision resolves to **exactly one** of these, and to nothing else:

1. **The approve is REFUSED.** `PlanRevisionInFlightError` — thrown before `materialize`, so the plan
   stays `planned`, no proposal is touched and **no work item is created**. The reviewer is told a
   revision is running, by which harness and model, and when the lease expires. They wait, read what
   changed, and approve the plan they asked for.
2. **The approve SUCCEEDS**, on a plan whose lease is not held — the revision had already ended, or
   had not yet started — and materializes a wholly consistent proposal set.

**Never a partially materialized tree.** That is the property the story's own criterion asserts and
the one its vitest gate drives against a real Postgres with a genuinely concurrent approve; a
sequential approximation never takes the lock in the window and proves nothing.

**And a revision is never cancelled by a decision.** A `declined` plan is a closed decision, so
`declinePlan` refuses under the lease for the same reason `approvePlan` does — a revision that
finishes writing into a declined plan leaves proposals on a plan nobody will ever read.

### D4 — the pre-transaction pin snapshot is justified by the LOCK, not by an enumeration

`approvePlan`'s repository-pin resolution runs before the transaction because it makes a domain read
the write lock has no business holding. That stays. What changes is its warrant:

- **The enumeration is deleted.** _"`addProposals` / `deepenProposal` require `generating`,
  `updateProposal`'s editable set does not include `targetRepo`, …"_ was a list of doors, and
  AMENDMENT 8 opened one the list does not name.
- **Under the lease, a JOB-driven revision cannot interleave at all** — it is excluded by the lock,
  which is a property of the mechanism rather than a fact about the current door set.
- **The residual case is the MCP correction door, which takes no lease and needs none**: it is ONE
  transaction, so approve either sees it whole or does not see it. What it can still do is invalidate
  the snapshot. **So approve compares, inside the transaction, the pins its fresh proposal set
  AUTHORS against the keys its pre-transaction snapshot resolved, and REFUSES when they disagree** —
  a Map-versus-set comparison over rows it has already read, no domain read, no second resolution.
  A refusal that costs a reviewer one retry is the right trade against materializing a card pinned to
  the wrong repository, or to none.

**This is a DEFECT that already ships**, not a consequence of this story, and it is filed as its own
bug rather than absorbed here. What this amendment owes it is the rule the fix implements.

### The boundary — what AMENDMENT 10 does NOT decide

> **⚠️ THE FIFTH `PlanStatus` IS IN FLIGHT ELSEWHERE, AND THIS AMENDMENT DECIDES NOTHING ABOUT IT.**
> MOTIR-3574's AMENDMENT 9 adds `stale` and was unmerged when this was written (pull request #2309,
> read on its branch — which is also why this one is numbered 10). Everything above is stated against
> the FOUR-member enum as it stands on `origin/main`: the editable set is `generating` + `planned`,
> written as a DENY of the terminal states, so a fifth member is refused by default and its
> disposition is AMENDMENT 9's to make, not this one's. What this amendment owes that work is one
> sentence: **a lease is orthogonal to status** — it excludes a concurrent DECISION, and which
> statuses a decision is legal from is the status amendment's question.

- **No `PlanStatus` member.** The plan is `planned` before a revision, during it and after it. A
  revision is a thing that happens TO a plan under review, not a state the plan enters, and the
  timeline is what tells the reviewer it moved.
- **No migration.** Two new `changeKind` verbs (`revision_started`, `revision_ended`) on a plain-text
  column, and one constant. `PlanRevisionChangeKind` reaches nine members; nothing switches
  exhaustively on it, and the timeline read filters by a derived-kind set rather than mapping a
  closed union.
- **No change to what approve MATERIALIZES**, to `resolveRef`, or to `PlanItem`'s shape. The revision
  changes the proposals; materialize reads whatever set it finds under the lock, exactly as today.
- **No widening of the MCP surface.** `update_plan_proposal` / `withdraw_plan_proposal` keep their
  contract and their permission. The revision's door is the job-token seam, which is a different
  caller with a different credential.
- **`CLI_TOKEN_GRANT` is not widened.** A sandboxed run still cannot author, correct or revise a
  plan.
- **Not the three existing plan-edit jobs.** `augment` / `expand_item` / `replan` keep resolving
  work-item keys against the committed tree. `revise_plan` is a fourth kind beside them.

### The constant and the type this card ships

`PLAN_REVISION_LEASE_MS` — **ten minutes**, in a pure module beside the target lock's own constants
so the ADR, the service and the tests name one value. Sized against what it races: ONE motir-ai job
over a tree that is already written, which is minutes rather than the tens of minutes
`PLAN_TARGET_LOCK_LEASE_MS` is sized for (that one races a human-paced conversation). Short enough
that _"wait for it to clear"_ is a real answer to a stuck lease rather than a joke, and refreshed on
every write so length is never what ends a revision that is still working.

The two verbs join `PlanRevisionChangeKind`. **No service logic ships in this card** — the cards this
one blocks implement the acquire, the refusal and the release.

---

## Consequences

- **One migration, additive, three nullable columns, no backfill** (MOTIR-2986). Every
  existing plan reads _unattributed_; no producer changes behaviour.
- **A token needs two permissions to author a plan** (`work_item:edit` + `ai:view_plan`), and
  a device-minted CLI token has neither path — deliberately. **The empty plan a
  `work_item:edit`-only token can still open no longer pauses that project's auto-plan cadence**
  (AMENDMENT 1, MOTIR-3051): a plan with no producer and no proposals is not a pending proposal.
- **An empty plan whose PRODUCER died is reconciled out of `generating`, hourly** (AMENDMENT 2,
  MOTIR-3064): the sweep asks motir-ai what became of the job and writes `declined` with a NULL
  decider — nobody decided it. `PlanStatus` gains no member, and the gate predicate is unchanged.
- **And a plan with NO producer is reconciled too, by AGE** (AMENDMENT 7, MOTIR-3236): the sweep's
  predicate selects every `generating` plan past the grace and the decision table judges it, so an
  MCP-authored plan its author never closed is `declined` as `no_producer` once it passes
  `ABANDONED_PLAN_MAX_AGE_HOURS` — the same constant, no second threshold, no new query shape for
  the next case. This pays the debt AMENDMENT 4 named and supersedes one bullet of AMENDMENT 6.
- **A proposal can be CORRECTED and WITHDRAWN, for an explicit correction only** (AMENDMENT 8,
  MOTIR-3540): `correctProposal` carries the structural fields AMENDMENT 3 D3 excluded — `parentRef`,
  `blockedByRefs`, `targetRepo`, a `modify`'s `patch` — through a SEPARATE input, so the deepen
  turn's contract is preserved exactly as D3 fixed it; and `withdrawProposal` pays the debt D4
  deferred, refusing rather than cascading when a sibling still references the proposal. Legal on
  `generating` and `planned` only: `approved` is frozen because its proposals have materialized and
  the work item is the source of truth, `declined` because it is a closed decision. D3(c)'s
  mutable-ref-graph objection is answered by MOTIR-3539's append-time check, which the correction
  re-runs. No grant change, no UI, no change to what approve materializes.
- **A `modify` may RE-PARENT its target** (AMENDMENT 11, MOTIR-3859): `PlanItemPatch` gains
  `parentRef`, so D3's `SITS or SHIPS` pair — widened for SHIPS by MOTIR-1884 / MOTIR-1912 and for
  SITS by nothing — is whole. A `planItem:` temp-ref is refused (every guard a re-parent owes is a
  question about a live row), a `done`-category parent is refused (derivation walks the re-open up the
  whole ancestor chain, and an approve has nobody watching), and the check runs at the APPEND through
  the same function the approve runs.
- **A `planned` plan can be REVISED, and an approve that races one is REFUSED** (AMENDMENT 10,
  MOTIR-3596): an append is legal on a `planned` plan exactly when it declares itself part of a
  revision and records itself on the trail as one — the `generating` assertion was never about
  generation, it was the guarantee that a plan does not change INVISIBLY under its reviewer, and a
  trail row is what makes a change loud. The approve/revise race is closed by a LEASE held on the
  plan's own content trail (`revision_started` … `revision_ended`, checked inside the approve
  transaction under the plan row lock), so an approve resolves to exactly one of _refused, tree
  untouched_ or _succeeded on a consistent set_ — never a partially materialized tree. Neither act
  cancels the other; the loser retries. No `PlanStatus` member, no migration, no MCP change: two
  plain-text `changeKind` verbs and one constant. It also replaces `approvePlan`'s pin-snapshot
  warrant — an enumeration of doors AMENDMENT 8 had already outgrown — with the lock, and names the
  residual MCP-door case as a shipped defect filed on its own.
- **Neither tool is billable.** Authoring a plan never draws on the owner's generation
  allowance.
- **The materialize pin is lifted, and the safety property is now held by the WRITE SEAMS
  rather than by not reading the value.** That is a load-bearing shift: any future writer of
  `proposedFields.planningProvenance` inherits the obligation to set `source` server-side.
  The proposal boundary's closed-enum rejection is the backstop, not the guarantee.
- **An `mcp`-planned item exposes its model** where a `native` one does not — the shipped
  mapper rule, now reachable for the first time.
- **The authorship is published on the MCP plan payload and NOT on v1's `planSchema`**, so
  the public REST surface's plan operations stay exactly as read-only and as wide as they
  are today.
- **The MCP surface can SEE and CHECK a plan it is writing** (AMENDMENT 3, MOTIR-3094): five
  calls take an optional `planId` and answer over the live tree ⊕ that plan's delta —
  `validate_work_item`, `validate_sprint`, `get_work_item`, `search_work_items`, and a new
  plan-level `validate_plan` for the forest verdict. All five stay on `project:browse`, none
  persists anything, and the ready-set family (`list_ready` / `next_ready` /
  `claim_next_ready`) is deliberately excluded — a proposal is not dispatchable. Omitting
  `planId` leaves every one of them byte-identical to today.
- **A PAT may now DEEPEN a proposal it appended, while the plan is still `generating`**
  (AMENDMENT 4, MOTIR-3089): `update_plan_item`, gated by `ai:view_plan` — the key
  `editAddProposal` asserts — so the titles-first strategy Motir's own generator uses is
  reachable from the MCP. The editable set gains exactly one field, `executor`, because
  `materialize` writes `pf.executor ?? null` and never consults the type→executor default map;
  the repo pin and the ref graph stay structural and stay settled at append. `remove` is still
  unreachable, and an abandoned MCP-authored plan that already holds proposals is still a debt
  nobody has paid.
- **AUTHOR and DECIDE are two permissions** (AMENDMENT 5, MOTIR-3188): `ai:view_plan` keeps the
  author writes and a new `ai:decide_plan` gates `approvePlan` / `declinePlan`. Behaviour-neutral on
  every built-in role by construction — both keys sit at `admin` and `member` and at neither `viewer`
  nor the implicit workspace-member grant — so what the split buys is a CUSTOM role that can follow a
  plan without being able to enact one. Q2 and D2 are unchanged: both named the key their own service
  asserts, and both services still assert it. The key id `ai:view_plan` is knowingly wrong and its
  rename is a persisted-value migration left to its own card.
- **A `generating` plan can be ENDED, and a `declined` one says how** (AMENDMENT 6, MOTIR-3189):
  `declinePlan` takes a second legal from-status, so a plan whose producer died mid-generation is
  discardable by a person holding `ai:decide_plan` instead of stranded for ever — including the
  agent-authored orphan with no producer, which no sweep can ever ask about. The reconciling sweep
  drops its empty-only conjunct and takes partial plans too, with its write guard becoming a
  count COMPARISON so a late append is still `row_moved`; the RLS blind spot that used to WIDEN
  that scan now fails safe. Every PlanItem survives every ending, unchanged since MOTIR-3160, and
  a nullable `decisionReason` column (`reviewed` / `discarded` / `abandoned`) records which of the
  three histories a `declined` row holds. No `PlanStatus` member, no backfill, no delete.

---

## AMENDMENT 9 — `planned` is a PROMISE, and a plan that stops keeping it says so (MOTIR-3574, 2026-08-26)

**Read against `origin/main` `5bb1928b`.** Every code claim below was checked there.

### The defect this answers

`planned` is not an internal bookkeeping state. It is the one status in a plan's life that means _a
person should look at this now_, and it is the status that renders a button. Reaching it did not mean
the plan could be approved.

Measured: a plan carrying an unresolvable `parentRef` was accepted by `addProposals`, reported
**VALID** by `validate_plan`, closed to `planned` by `markPlanned`, sat in the review queue — and
failed at the approve button with `INVALID_PLAN_REF_GRAPH / dangling`, at which point the plan is
immutable and the only repair is to author a whole new plan and decline this one. Three gates stood
between authoring the bad ref and a human meeting it; none of them looked (MOTIR-3560).

### D1 — THE INVARIANT

> **A plan is `planned` only while it is approvable.**

Anything the approve path can reject a plan for is either **knowable when the plan closes**, or **is
not the plan's fault**. The two need opposite treatment, and before this both were the same hard throw
at the button.

`validatePlanProposals` (`lib/plans/validateProposals.ts`) raises exactly four rejections, and they
split on one question — _could this have been known at the close?_

| class | rejection                        | knowable at close?                   | where it now runs     |
| ----- | -------------------------------- | ------------------------------------ | --------------------- |
| **A** | `PlanRefGraphError('cycle')`     | yes, PURELY                          | the APPEND            |
| **A** | `PlanRefGraphError('duplicate')` | yes, PURELY                          | the APPEND            |
| **A** | `PlanRefGraphError('dangling')`  | yes, one batched read                | the CLOSE             |
| **A** | `PlanGrammarError`               | yes, the same read                   | the CLOSE             |
| **B** | `PlanTargetImmutableError`       | **no** — the target moved AFTERWARDS | approve, and a STATUS |

Class A is discharged by MOTIR-3573: the pure half runs at `addProposals`, the batched half at
`markPlanned`, and a rejection there leaves the plan `generating` — repairable, because the author
still owns it. **This amendment is about Class B**, which no close-time gate can foresee.

### D2 — Class B gets a STATUS, not a column

AMENDMENT 6 faced the neighbouring question and answered it the other way: `Plan.decisionReason` is a
private column _"rather than a fourth `PlanStatus` member"_, because `PlanStatus` is a public
vocabulary and the reason was not worth its blast radius. **That precedent is right and does not reach
this case.** The distinction is mechanical:

- **`decisionReason` records why a plan ENDED.** All three values are histories of one terminal state.
  The plan is over; nothing branches on it. A column describes.
- **This one GATES BEHAVIOUR ON A LIVE PLAN.** It must make approve refuse, take the plan out of the
  review queue, and open a repair path `planned` does not have. Every one of those is a status query.
  A status decides what may happen next.

Put it in a column and `planned` still would not mean approvable — which is the defect, unfixed,
wearing a new field.

### D3 — ⚠️ THE NAME: `stale`, UNIFIED with the engine that already owns the word

MOTIR-3560 proposed `stale` and argued it against `outdated` and `superseded`. It never argued it
against the codebase, where **`stale` has named something else on this exact entity since MOTIR-1340**.
`lib/services/planStalenessService.ts` computes a per-`PlanItem` drift verdict, rolls it up as
`PlanStalenessDto.stale`, and renders it as `staleCount` on every plan row and in the review rail. Its
header states two contracts a blocking `PlanStatus.stale` walks straight into:

> _"PURE READ. Staleness NEVER blocks approve; it WARNS, and the user decides (approve anyway /
> decline / regenerate)."_

> _"⚠️ ONLY A `planned` PLAN CAN BE STALE (MOTIR-3165). Staleness answers one question — would
> approving this now still be correct? — and `approvePlan` / `declinePlan` each refuse unless the plan
> is `planned`, so on a decided plan that question cannot be asked again."_

**The second is a live bug, not a wording quibble.** Ship `PlanStatus.stale` and change nothing else,
and a plan entering it stops producing per-proposal reasons — `computePlanStaleness` short-circuits at
`plan.status !== 'planned'` — so the reviewer loses the one thing they need at the exact moment they
need it: _which proposal went stale_. That is MOTIR-3560's own complaint arriving through MOTIR-3560's
own fix.

**DECISION: UNIFY (disposition a).** The new member is **`stale`**, and the engine is extended rather
than left behind.

**Why unify rather than pick a second word.** Read the engine's `RULES` and the family is already
exactly this one: `parent_removed`, `blocker_removed`, and `base_revision_drift` with
`change: 'archived'` all mean _the world moved under this proposal_. The Class B condition — a
`modify`/`remove` target reached a terminal status — is **a missing reason code in that engine**, not a
new concept beside it. One entity carrying two unrelated meanings of one word is the thing to avoid;
one word at two SEVERITIES is a distinction the domain already has.

**Why not (b) SEPARATE.** A second name buys nothing the severity axis does not, and costs a reader
having to learn that a plan can be `stale`-the-status and `stale`-the-count independently. It also
leaves the guard bug unfixed by default, because nothing forces the engine to be revisited.

**Why not (c) RENAME the incumbent.** Priced rather than skipped: `PlanStalenessDto.stale`,
`PlanItemStalenessDto.stale`, `StaleReasonCode`, `staleCount` on `PlanRowView`, the rail's rendering,
`AutoPlanPauseDto.stale`, `planRowView.staleCountFor`, `autoPlanCadenceService`'s own guard, and the
en/zh strings — a rename spanning a shipped DTO, a rendered count and a documented reason list, to free
a word we then hand to a concept the same engine should be modelling anyway. It loses on cost and on
concept.

**⚠️ WHAT HAPPENS TO THE `planned`-ONLY GUARD — the clause MOTIR-3578 is closed against.**
`computePlanStaleness`'s short-circuit **WIDENS to `planned | stale`**. MOTIR-3165's reasoning is
preserved exactly, not overturned: it excluded _decided_ plans, because on a decided plan the question
_would approving this now still be correct?_ no longer has meaning. A `stale` plan is **not decided** —
it is live, it is awaiting action, and it is the plan for which that question matters most. The guard's
predicate was a proxy for _is this plan still awaiting a decision?_, and adding a fifth status is what
makes the proxy and the intent come apart.

And the engine gains one **FATAL** reason code — `target_terminal`, carrying the target and the status
it reached — so `StaleReason` acquires a severity axis: every existing code is `advisory`, the new one
is `fatal`, and **`Plan.status === 'stale'` ⟺ some proposal carries a fatal reason.** The count on the
row keeps counting all of them; the rail distinguishes them.

### D4 — The transitions: THREE, not four

MOTIR-3560 proposed four. One of them is **not implementable today**, and discovering that is the
second thing this decision records.

| from → to          | trigger                                                       | notes                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planned → stale`  | a `modify`/`remove` target enters a terminal status           | eager, on `work-item/transitioned`; the approve path is the backstop                                                                                                                               |
| `stale → planned`  | the drift REVERSES — every fatal target is non-terminal again | `done → in_progress` is a legal work-item transition, so a plan's premise can come back. Cheap, and wrong to omit: without it a plan is punished for a target that was briefly closed              |
| `stale → declined` | the reviewer gives up                                         | `declinePlan`'s guard widens from `planned \| generating` to `planned \| generating \| stale`; the recorded `decisionReason` is **`reviewed`**, because the plan DID reach a reviewer and was read |

**`stale` is reachable only from `planned`.** A `generating` plan is in front of nobody and has nothing
to be stale about.

**⚠️ `stale → generating` IS NOT IN THE TABLE, and the reason is a capability that does not exist.**
MOTIR-3560 described it as _"the author repairs it — drop or re-target the offending proposal, then
re-close"_. Neither move is possible: `editAddProposal` states _"Only an `add` is editable"_, a
`modify`'s `workItemId` is in no patch shape, `addProposals` only appends, and there is no withdraw.
Measured while building MOTIR-3573 — a plan refused at the close for a bad REF is unrepairable for the
same reason and can only be declined.

So a `stale` plan's exits are: **wait for the drift to reverse, or decline.** That is a real
limitation, and it is strictly better than what it replaces — a plan that is `planned`, unapprovable,
uneditable, and _still in the queue asking a reviewer to press a button that cannot work_.

**⚠️ SUPERSEDED IN PART — that capability SHIPPED, between this decision being written and
MOTIR-3578 running (2026-08-26).** AMENDMENT 8 (MOTIR-3540) landed `correctProposal` — which carries
`parentRef`, `blockedByRefs`, `targetRepo` and a `modify`'s `patch` — and `withdrawProposal`, backed
by a real `planItemRepository.deleteById`. So _"neither move is possible"_ above is no longer true,
and the paragraph is kept as the record of why the table was written with three edges rather than as
a live constraint.

**What actually remains is smaller and is a DECISION, not a missing capability.** Both new methods go
through `assertPlanProposalsEditable`, which admits `generating | planned` and refuses everything
else — so a `stale` plan is not editable today, and the fourth edge needs that guard widened to
`generating | planned | stale`, not a new door built. **MOTIR-3579 must re-decide D4 rather than
inherit it**, and weigh the widening against the frozen-proposal-set assumption named below, which is
the reason the guard is narrow in the first place.

**Restoring the fourth edge needs a way to WITHDRAW or RE-TARGET a proposal, which is its own card**
(cited in D6). It is deliberately not smuggled in here: it changes what a `planned` plan's proposal set
means, which is the frozen-set assumption `approvePlan`'s pre-transaction repo-pin resolution rests on
(see its own comment: _"THAT SECOND CLAUSE IS LOAD-BEARING"_).

**`addProposals` / `update_plan_item` are unaffected** — both assert `generating`, no transition
reaches `generating` from `stale`, so neither changes.

### D5 — Who moves it: EAGER, with approve as the backstop

**Eager is the one that satisfies the invariant.** If a plan only goes `stale` when somebody presses
Approve, then `planned` was still lying right up until the click and the queue was still full of plans
nobody can act on — the same defect, discovered one step later.

The mover is a consumer of **`work-item/transitioned`**, emitted post-commit for every ingress, which
is why `statusDerivation.ts` rides it rather than each caller knowing. It must be **best-effort** (a
failure may not fail the transition that woke it), keyed on the **transition** into a terminal status
rather than on the state, and **idempotent under a lock**.

**Lazy stays as the backstop**, because the listener can lose a race: `approvePlan`'s in-transaction
gate keeps its verdict, and on `PlanTargetImmutableError` it transitions the plan to `stale` instead of
throwing and leaving it `planned`. One button press then never leaves the plan worse than it found it.

**⚠️ One correction to MOTIR-3560's mechanism.** It states _"`PlanItem.workItemId` is already the
reverse index."_ It is not: `PlanItem` carries `@@unique([planId, workItemId])`, `@@index([planId])`
and `@@index([workspaceId])`, and the composite's leftmost column is `planId`, so it cannot serve a
lookup by `workItemId` alone — which is exactly the query this listener makes on every work-item
transition in the product. **The index is owed, with its migration.**

### D6 — The cost, enumerated by file

A `PlanStatus` member is a public vocabulary. Each of these owes a value:

| surface                                                          | file                                                                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| the Prisma enum + a migration                                    | `prisma/schema.prisma` (`enum PlanStatus`)                                                                                  |
| the wire vocabulary (the type DERIVES from the array — one edit) | `lib/dto/plans.ts` — `PLAN_STATUS_DTO_VALUES`                                                                               |
| the v1 public schema                                             | `lib/api/v1/workLoop/schema.ts` — `planStatusSchema`                                                                        |
| the MCP tool descriptions                                        | `lib/mcp/tools/getPlan.ts`; `lib/mcp/tools/expandItem.ts` (`runGetPlanStatus`)                                              |
| the list row's timestamp + verb                                  | `app/(authed)/plans/planRowView.ts` — `whenFor` (⚠️ its `default:` arm absorbs an unknown status silently)                  |
| the list row's icon + tone                                       | `app/(authed)/plans/_components/PlanRow.tsx` (⚠️ `Record` maps — no exhaustiveness check)                                   |
| the tab strip                                                    | `app/(authed)/plans/_components/PlanStatusTabs.tsx` (iterates the array, so it grows a tab; its label + empty state do not) |
| the URL parser                                                   | `lib/planning/planStatusFilter.ts`                                                                                          |
| the review rail                                                  | `components/planning/PlanReviewRail.tsx` — tone map, `decided`, the outcome line                                            |
| the plan detail                                                  | `components/planning/PlanDetail.tsx` — `decided`                                                                            |
| the catalogs + parity gate                                       | `messages/en.json`, `messages/zh.json`, `tests/i18n-catalog.test.ts`                                                        |
| the staleness engine                                             | `lib/services/planStalenessService.ts` — the widened guard + the fatal reason                                               |

**⚠️ `decided` MUST STAY FALSE for `stale`**, in both components. The plan is live and awaiting action,
not ended. `PlanDetail`'s own comment records that a declined plan once fell into the empty state and
SHADOWED the rail's outcome line, so this has a known failure shape.

**⚠️ The compiler will not find most of these.** `PlanStatus` is a closed enum, which sounds like it
guarantees exhaustiveness — but two icon/tone maps are `Record`s, `whenFor` has a `default:` arm, and
two components compute _is this decided?_ by naming two statuses. Every one of them compiles unchanged
with a fifth value in the world and renders something wrong.

### Follow-ups this decision creates

- **The withdraw/re-target capability** that would restore `stale → generating` — its own card, not
  folded into the vocabulary or transition work (D4).
- **The `PlanItem.workItemId` index** and its migration, owed by the transitions card (D5).

### What this does NOT change

`approvePlan` keeps BOTH its `runPersistGate` calls. They answer whether the world moved while the plan
waited, and no check taken at the close can foresee that. The whole point of D4 is that Class B is real
and permanent; the status makes it _legible_, not preventable.

### ⚠️ ADDENDUM (MOTIR-4129, 2026-09-03) — D3's widening had a SECOND consumer, and this amendment named only the first

D3 widened `computePlanStaleness`'s short-circuit from `planned` to `planned | stale`, and stated the
class in one sentence: _"the guard's predicate was a proxy for **is this plan still awaiting a
decision?**, and adding a fifth status is what makes the proxy and the intent come apart."_

**`planRepository.findUndecidedByProject` is the same proxy for the same question, and it was not
widened.** It reads `status: { in: ['generating', 'planned'] }` and is THE pending-proposal gate: the
cadence tick skips a project with one (`autoPlanCadenceService`, gate 1) and MOTIR-1740's paused
indicator reports one. So a plan a reviewer was holding read as decided — the tick fired a second
expand beside it, and the settings page showed no pause while a Stale pill sat on the Plans list. It is
the mirror of MOTIR-3051 / MOTIR-3064 / MOTIR-3189, which each took a plan that gated when it should
NOT have; this is the more expensive direction, because the failure is a SECOND plan arriving rather
than a silence. It is now `['generating', 'planned', 'stale']`.

**Why the enumeration missed it, and the general lesson for the next member.** D6 above lists twelve
surfaces a `PlanStatus` member obliges, by file. Every one of them **DISPLAYS** a status. Not one
**ASKS A QUESTION** of one. That is not a lapse in care: a display surface announces itself by breaking
a `Record`, a switch or the translation-parity gate, while a predicate keeps compiling, keeps returning
a plausible answer, and answers a slightly different question than it did yesterday. **A sixth member
owes a sweep of every hardcoded `PlanStatus` list classified by the QUESTION it asks — _is this
decided?_ (widen) versus anything else (leave) — and D6's table is the wrong instrument for it.**

That sweep, run for this addendum, also found the SIBLING the point repair would have left:
`autoPlanCadenceService`'s own `staleCountFor` — whose doc comment says it _mirrors_
`app/(authed)/plans/planRowView.ts`'s function of the same name, which D3's card widened while this
copy stayed at `planned`. The divergence was unreachable until `findUndecidedByProject` could hand that
consumer a `stale` plan at all, so fixing the gate is exactly what made it live. Both are widened here.
Every other `PlanStatus` predicate in the repository was classified and left: they ask _is generation
finished?_, _may this proposal set still change?_ (`assertPlanProposalsEditable`, whose narrowness D4
records as a decision for MOTIR-3579 to re-take, not an oversight), or _can this plan go stale?_ — none
of which is _is this decided?_.

---

## AMENDMENT 11 — a `modify` may RE-PARENT its target: the patch carries D3's `SITS` half at last (MOTIR-3859, 2026-08-29)

AMENDMENT 8 widened what a CORRECTION may reach and left one thing where it found it: `parentRef` is
an `add`-only column on the `plan_item` row, so for a `modify` the widening reached only the `patch` —
**and the patch had no parent key.** This amendment adds one.

### The defect this answers

**D3's own pair came apart, and nobody decided that it should.** D3 draws the deepen line as _"a
deepen may change what a card SAYS and who ACTS on it; it may not change where the card **SITS or
SHIPS**"_ — one sentence naming two halves. The `modify` patch was then given **SHIPS** twice, each
time with its own reasoning and its own card (`targetRepo`, MOTIR-1884; `targetRepoRole`,
MOTIR-1912), and was given **SITS** never. Nothing anywhere in this document argues it should not
have been. The two halves were widened by different cards and only one of them ran.

Two consequences, both observed on 2026-08-28 in one `motir re-plan MOTIR-1043`:

1. **A re-plan stopped being one reviewable act.** The corrected shape moved a card between two
   stories; the plan could carry the re-scope and not the move, so the re-plan was split across two
   doors — the scope through plan `cmtdl09xr003jhvphju1lwjoy`, the placement through a direct
   `move_to_parent`. Half of it was a proposal a person approves; the other half was already applied
   and could not be declined with it. **That is the exact property routing a re-plan through the
   proposal door exists to buy, spent.**
2. **A cross-parent `blocked_by` edge had to be ARGUED instead of avoided.** Dependency edges are
   legal between siblings; a card in the wrong story generates cross-parent edges that then need the
   no-legal-lift justification written onto the card in prose, where nothing can check it. The move
   made the edge ordinary — but only after the plan had been written the other way.

And in `motir-ai`, `modify_node`'s own description promised the operation three times
(_"propose a `modify` (**re-parent** / re-scope / re-sequence / re-title)"_, plus two prompt lines)
while carrying no parameter for it. **A tool that advertises an operation it silently discards is
worse than one that never offered it**: the model gets a success, and the plan it believes it wrote
is not the plan it wrote.

### D1 — the key rides in the `patch`, not on the row

`plan_item.parentRef` stays `add`-only and `correctProposal`'s existing refusal —
_"Only an `add` proposal carries a `parentRef`"_ — stays correct and unchanged. The new key is
`PlanItemPatch.parentRef`, which the correction door already reaches (AMENDMENT 8 gave it a
`modify`'s whole `patch`), so **one field lands the capability on both the append and the correction
paths with no third door.**

Sparse like every patch key: absent leaves the parent alone, an explicit `null` moves the target to
the project root.

### ⚠️ D2 — a `planItem:` temp-ref is REFUSED, and that is a decision rather than an omission

The other four ref sites accept an intra-plan temp-ref. This one does not.

**Every guard a re-parent owes is a question about a LIVE row** — the kind-parent matrix, same-project
tenancy, the no-cycle walk, the depth cap, and D3's terminal-parent refusal below — and a proposal has
none until approve. Admitting a temp-ref would mean a re-parent that nothing could check until the
`work_item` triggers raised a raw SQLSTATE from inside `materialize`, at the approve button, where the
plan is immutable and the only repair is to author a new one. That is precisely the failure
`validatePlanProposals` exists to prevent.

**Nothing is lost.** A card that must land under a card the same plan is adding is already
expressible — `add` it with that `parentRef`.

### D3 — a re-parent onto a `done`-category parent is REFUSED, and this is the load-bearing check

The interactive `move_to_parent` permits it. The plan path must not, and the asymmetry is not
timidity:

Status derivation recomputes a container from its **CURRENT child set** on
`work-item/child-set.changed` and applies the result BACKWARD (`docs/decisions/status-derivation.md`
§3a). So materializing a re-parent under a finished card returns that card to an open status and walks
the re-open **up its whole ancestor chain** — dropping every card `blocked_by` anything that came back
out of the ready set. **A plan path that skips this check is strictly more dangerous than the
interactive one, because nobody is watching at approve time**: `moveWorkItem` is a person clicking, and
an approve is a person saying yes to a summary.

It surfaces as `PlanGrammarError` with `reason: 'parent_terminal'`, naming the parent's status.

### D4 — validated at the APPEND, through the SAME function the approve runs

`assertReparentLegal` is one pure function in `lib/plans/validateProposals.ts`, called from
`plansService.addProposals` (under the plan's row lock, before the first insert) and from
`validatePlanProposals` (step 3c, at the close and again under the approve's row locks). One
implementation, so a move refused at the append cannot be admitted at approve or the reverse.

**⚠️ It is the one append-time check that costs a workspace read**, and the header on the pure gate
says such a check belongs at the close. A re-parent is the case that argument does not cover: its
questions are about a row that must exist ALREADY, so **nothing a later call does can turn an illegal
move into a legal one** — which is `assertTempRefsResolvable`'s own argument (MOTIR-3539) for refusing
where the ref is written. The read is skipped entirely when no proposal in the batch carries
`patch.parentRef`, so a plan that re-parents nothing costs exactly what it cost before.

The depth arithmetic MIRRORS `enforce_work_item_depth_limit` rather than replacing it — the trigger
stays the structural backstop, as it does for the kind matrix.

### D5 — the move is VISIBLE on the surface that approves it

A re-parent that the review canvas drew in the card's OLD level would be the plan review showing the
approver the opposite of what approving does. So `planReviewService` gains a `parent` entry in
`PLAN_ITEM_CHANGE_FIELDS` (with copy in both catalogs and all three hand-maintained label maps, per
MOTIR-3151), and `parentNodeIdOf` reads `patch.parentRef` — the canvas draws the card where the plan
proposes to put it.

### What the approve owes BESIDES the column

A move is not one write. `moveWorkItem` has always done three things, and the plan path now does the
same three:

- the `parentId` **revision diff cell**, inside the existing one-revision-per-modify guarantee;
- the **derived repository set** recomputed on BOTH chains — the one joined AND the one vacated. The
  end-of-pass rollup walks up from the moved row, so after the write it climbs the NEW chain and never
  visits the parent the row LEFT, whose set is now wrong in the other direction;
- the **`work-item/child-set.changed` event**, post-commit, naming both parents. `work-item/transitioned`
  fires on neither end of a move, which is the whole reason that event exists (MOTIR-2892) — and it is
  the check `moveWorkItem` itself went without until MOTIR-2888, when a `move_to_parent` reached no job
  in the system at all.

### The consumer half

`motir-ai`'s `modify_node` gains the parameter — in the tool schema, in `ModifyPatch`, in
`modifyExecutor`, and in the four handler payloads — and a call whose ONLY change is the parent stops
being rejected as _"needs at least one changed field"_, which was false: it did specify a change, and
the tool could not carry it. **No prompt change is needed for that half; the prose it already ships
becomes true.**

### What this does NOT change

`UpdateProposalInput` and `update_plan_item` are untouched: D3's line still holds for a **deepen**, and
a re-parent is not one. This widens the `modify` PATCH — an act whose whole content is "change this
existing card" — not the turn that fills in a proposal's own body.

---

## AMENDMENT 12 — the APPEND is the third verb on a `planned` plan, and the MCP door declares itself (MOTIR-4153, 2026-09-02)

AMENDMENT 8 drew a boundary — `generating` and `planned` are editable, `approved` and `declined` are
frozen — and shipped **two** verbs against it. AMENDMENT 10 D1 then relaxed the append's own status
gate and shipped it for **one caller**, closing its boundary with _"No widening of the MCP surface"_.
So the surface an MCP author actually met was: a landed plan it may reshape and shrink, and may not
grow.

**That shape was never decided.** AMENDMENT 8 does not reject the appending door anywhere — not in
D3, not in D4, not in _What this does NOT change_; its own framing lists append FIRST, as one of the
four write doors an author already has, which is what made it read as part of the problem rather than
as a candidate. AMENDMENT 10 then answered the question for the caller in front of it and said so
honestly. Neither is wrong; between them a boundary formed that no sentence in either document
argues for.

> Every reading below was taken off `origin/main` at `436855df7` on 2026-09-02.

### The cost, measured

A re-plan of MOTIR-3942 closed its plan; the conversation then surfaced two further findings, each
needing a card:

|                                                              |       |
| ------------------------------------------------------------ | ----- |
| plans authored                                               | **4** |
| plans the reviewer must DECLINE by hand                      | **3** |
| proposals re-authored verbatim into the survivor             | **8** |
| corrections `update_plan_proposal` absorbed in one call each | 2     |

Every repair that fitted the correction door cost one call; every repair that needed a card cost a
plan. One session is an anecdote about the rate and not about the shape — and the shape is what
recurs, because a re-plan that discovers its second finding is the normal case rather than the
unlucky one.

### D1 — the remedy is (a), the append reaching `planned` — NOT a `reopen_plan`

The bug named two candidates and deliberately picked neither: **(a)** `add_plan_items` accepts
`planned`, or **(b)** a `reopen_plan` returning `planned → generating` with the append left
`generating`-only.

**Decision: (a).** Three reasons, in the order they settle it:

1. **AMENDMENT 10 has already decided (b) against, in as many words.** Its own boundary reads _"a
   revision does not re-open a plan, and the plan is `planned` before, during and after"_, and
   `markPlanned` is the one thing D1 explicitly did NOT relax. A `reopen_plan` is that rejection
   reimplemented as a tool.
2. **(b) takes the plan OUT of the review queue to change it.** The property the `generating`
   assertion protects — restated by D1 as _the proposal set of a `planned` plan may not change
   INVISIBLY_ — is satisfied by a trail row, and (b) satisfies it by removing the plan from the
   surface the reviewer is reading instead. That is strictly worse for the person the objection is
   about: a plan that vanishes and comes back is harder to follow than one that gains a card on its
   timeline.
3. **(a) is already built.** `addProposals` has taken `opts.revision` since MOTIR-3596; what was
   missing was a caller. (b) is a new verb, a new status transition and a new race with approve.

### D2 — the MCP append DECLARES itself a revision; it is not inferred from the status

`add_plan_items` gains one optional boolean, `revision`, passed through verbatim to the option
AMENDMENT 10 D1 built. Absent, the call is byte-identical to what it has always been.

**Why a declaration and not a status read.** D1's condition is precisely that _"an append to a
`planned` plan is permitted exactly when the append DECLARES itself part of a revision"_. Inferring
the flag from the plan's status would make one call mean either _append to the tree I am writing_ or
_change a plan somebody is reading_ depending on a status the caller may not have re-read since it
last looked — and the second of those is the one that should have to be typed. It would also put a
second status predicate in front of the real one, which is the duplication D1 rejected a second
append METHOD to avoid: the adapter's read is pre-lock, and the service re-takes the decision under
the plan row lock.

Two cross-field refusals ride with it, both in the adapter beside the existing empty-and-not-final
rule:

- **`revision` + `final` is refused.** `final` CLOSES a plan and a revision's plan is already closed;
  `markPlanned` is un-relaxed, so the composed call would append and then throw from the close,
  having already written. A refusal is not the same thing as a half-applied call.
- **`revision` with an EMPTY batch is refused.** A revision has no close to perform, so an empty one
  is the whole call doing nothing. The existing empty-batch refusal would have sent the caller to
  `final: true`, which is the one thing this pairing must not do.

### ⚠️ D3 — a revision append runs the CLOSE's gate, because it is the only append with no close coming

`addProposals`' own comment says what it deliberately leaves out: the arm of the persist gate that
needs `liveById` — a real work-item id that resolves to nothing — _"is left to `markPlanned` (the
close), because the read is not free and a plan may legitimately reference an item created between
the two"_. **That argument holds for exactly as long as a close is still coming.** A revision appends
to a plan that already closed, so the omitted arm would never run again, and a `modify` naming a
deleted work item would be met by whoever pressed Approve.

This is MOTIR-3936's finding one door over, and it takes MOTIR-3936's own remedy rather than a second
one: a revision append runs `assertCorrectionKeepsPlanApprovable` — the same helper, on the same
BEFORE/AFTER basis — inside its own transaction, after the inserts, so a refusal rolls every one of
them back. The BEFORE/AFTER shape is what keeps it a _do not make it worse_ check rather than a _must
be perfect_ one: a plan that is ALREADY unapprovable is precisely the plan somebody is appending a
card to in order to repair.

An ordinary `generating` append pays nothing for it — the terminal-status read is taken only when the
revision flag is set.

### What this does NOT change

- **`approved` and `declined` stay FROZEN**, through the same `assertPlanProposalsEditable` the
  correction doors use — a DENY of the terminal states, not an ALLOW of two, so a fifth `PlanStatus`
  member is still refused by default. No second status predicate ships.
- **No re-open, no `PlanStatus` member, no migration.** The plan is `planned` before, during and
  after a revision append, exactly as D1 says of a revision.
- **The append's ref check is untouched on the new path.** `assertTempRefsResolvable`, the
  self-consistency gate, the duplicate-target check and the re-parent gate all run exactly as they do
  on a `generating` append; the resolvable set for a `planItem:` ref is still the plan's
  already-persisted `add`s, which for a revision simply includes everything the authoring pass wrote.
  A ref naming nothing is still refused AT THE CALL, leaving the plan byte-identical.
- **No lease.** The MCP append is ONE transaction, so approve either sees it whole or does not see
  it — the same reasoning that leaves the correction doors unleased (D2's own argument, and
  `revisionStoryGate.test.ts` block 5 asserts it for those). Gating it would take a capability away
  from a surface for a race it cannot lose.
- **`CLI_TOKEN_GRANT` is NOT widened.** `add_plan_items` asserts `ai:view_plan` and the grant does not
  carry it, so a sandboxed run still cannot author, correct, revise or append. Asserted from the
  constant, so a later widening fails a test.
- **No UI.** MOTIR-3084's removal of the proposal edit modal stands.
- **Nothing about what approve MATERIALIZES**, the resolver, or `PlanItem`'s shape.

### The residual, named rather than discovered

An append landing between `approvePlan`'s pre-transaction pin snapshot and its transaction is
D4's residual MCP-door case, unchanged in kind: a proposal whose pin ARRIVED in that window is caught
by `assertRepoPinsUnmoved` (`before` is absent, `after` is a pin, and the approve refuses with
nothing materialized); an UNPINNED one materializes with the rest. That is the same window a
correction has had since AMENDMENT 8, it costs the reviewer a card they had not read rather than a
card pinned wrongly, and the trail row is what tells them. **It is also the whole trade this
amendment makes:** the alternative is not "the reviewer reads only what they started with" — it is a
second plan they must decline by hand, which is two surfaces to read instead of one.

### The corpus statement this falsifies

`motir-meta` `prompts/_shared.md` states _"`final: true` on the LAST batch → … Appending after that
is refused."_ Under this amendment that is false for a declared revision. **Nothing in `motir-meta`
changes in this card's pull request** — one subtask is one repo — and the sweep is filed as its own
sibling, MOTIR-4154, `blocked_by` this card.

---

## AMENDMENT 13 — an `add` proposal CARRIES the card's to-do list (MOTIR-3810 · MOTIR-4614, 2026-09-05)

MOTIR-3808 gave a `manual` card's operations somewhere to live: an ordered list of `work_item_todo`
rows, each ONE operation, each carrying its own executor and an optional command you copy, ticked off
by the person doing them. It is a surface you edit while you are WORKING.

**Planning never reaches it.** A plan proposes a `manual` card whose `descriptionMd` says _"provision
the DNS records"_, a reviewer approves that sentence, and the twelve operations inside it are written
— if they are written at all — by whoever opens the card afterwards. So the one thing the reviewer is
actually approving on a `manual` card, the work a person will do, is the one thing the review surface
cannot show them.

This amendment settles the shape that closes that gap: **an `add` proposal carries the card's steps,
the reviewer reads them before approving, and approve writes them as the card's real to-do rows.**

> Every reading below was taken off `origin/main` at `4dc08ff39` on 2026-09-05.

### The context, and why it is an amendment rather than a decision

Nothing here is a product choice. Yue settled the WHAT on 2026-08-28 — _"when plan a manual subtask,
it should be planned like a to-do list, each to-do can be manual or agent"_ — and every question below
is a HOW that the shipped code already answers, if it is asked. What makes them worth writing down is
that each would otherwise be answered **implicitly, by whichever card reached it first**:

- whether a `modify` may rewrite a committed card's list — decided by a schema key nobody argues about;
- whether the caps are re-declared or imported — decided by a validator;
- whether materialize writes through the service or the repository — decided by an import;
- whether an agent's `manual` card with no steps is finished — decided by a completeness predicate.

Four files, four authors, four defensible answers, no reader. The cost of the alternative is not a
wrong feature; it is a feature whose reasons live nowhere, and a `modify` delta added six months from
now by someone who could not find the sentence saying why it was left out.

### D1 — the carrier is a field on `proposedFields`, and array order IS list order

`PlanItemProposedFields` (`lib/dto/plans.ts:106`) gains:

```ts
todos?: ProposedTodo[] | null;

interface ProposedTodo {
  text: string;
  notesMd?: string | null;
  commandText?: string | null;
  executor?: 'coding_agent' | 'human' | null;
}
```

**Array order is list order.** There is no `position` on a proposed row and there must not be: a
fractional index is minted from its NEIGHBOURS at write time (`keyForAppend`,
`lib/workItems/positioning.ts`), so a key minted at append would be a key computed against a list that
does not exist yet. The array is the order; materialize mints the keys (D5).

It is one of the `add`'s own values, exactly like `descriptionMd` — persisted in the `proposedFields`
JSON, no new table, no new column, no migration. `PlanItem.proposedFields`'s doc comment in
`prisma/schema.prisma:5404` enumerates the fields it holds and says _"`PlanItemProposedFields` in
`lib/dto/plans.ts` is the authoritative shape — this list is a reader's summary of it, so keep the two
in step when the shape grows."_ The shape grows here, so that comment is a **deliverable of the carrier
card**, not a nicety.

### D2 — `add` ONLY. A `modify` may not rewrite a committed card's list

`PlanItemPatch` (`lib/dto/plans.ts:220`) gains NO `todos` key, and `PLAN_ITEM_PATCH_KEYS` with its
compile-time exhaustiveness guard (`lib/dto/plans.ts:350-380`) is untouched.

**The symmetric feature was considered and is REJECTED.** The obvious shape — a `todosAdd` /
`todosRemove` delta on the patch, mirroring `blockedByAdd` / `blockedByRemove` — is the one a reader
expects to find, so the rejection is recorded rather than left as an omission.

**The reason is that a committed card's list is not content the planner owns.** Every row carries
`doneAt` and `doneById`: the list on a live card is the record of **how far a person has got**. A
re-plan that overwrote four ticked rows with four fresh ones would not be an edit to a description
that happens to be a list — it would be the day the checkbox stopped meaning anything, and the loss
would be silent, because a re-plan is approved as one act by someone reading titles.

The two doors that DO edit a live card's list are unchanged and are the right ones: the shipped
section on the item page (a person editing their own progress) and the item-scoped assistant,
MOTIR-1344. `blockedByAdd` is not a precedent against this — an edge has no `doneAt`.

An omission invites the next reader to add the missing half. A recorded rejection does not, which is
the whole reason this D exists in a document about a field that is not being added.

### D3 — DEEPENABLE, because a step list is what a card SAYS

AMENDMENT 3 D3 fixed the deepen turn's editable set with a rule: **a deepen may change what a card
SAYS and who ACTS on it, never where it SITS or SHIPS.** AMENDMENT 4 D3a is the one widening that rule
has taken, adding `executor` on exactly that reasoning.

A to-do list is CONTENT — it is the card's own words about the work, at a finer grain than
`descriptionMd` — so it falls on the SAYS side and joins the deepen's editable set. It is not
placement: it says nothing about where the card sits or which repository it ships in, so D3's excluded
columns (`parentRef`, `blockedByRefs`, `targetRepo` / `targetRepoRole`) are untouched by this
amendment.

**Three doors carry it on the deepen side**, and they are the ones that already carry
`explanationMd`:

1. **`update_plan_item`** — the MCP deepen turn (`lib/mcp/tools/`), onto `plansService.updateProposal`;
2. **`update_plan_proposal`** — the AMENDMENT 8 correction door, onto `plansService.correctProposal`;
3. **the internal AI deepen + correct routes** — the `/api/internal/ai/plan-proposals` §4 job-token
   seam Motir's own planner writes through.

Mechanically, `todos` joins `UpdateProposalInput` (`lib/dto/plans.ts:533`), and therefore
`CorrectProposalInput` (`:593`), which extends it. **That is the one place this amendment cannot be
implemented incompletely**, and it is deliberate: `UPDATE_PROPOSAL_KEYS` (`:643`) is the declared
source every transport derives from, held to the interface by a compile-time assertion (`:684`) and to
the internal route's parser by `tests/integration/ai/planRevisionRoutes.test.ts`. Its own comment says
why it exists — a key declared on an input and read by no transport is _"invisible from both ends: the
request succeeds, the response is a `200`, and the proposal simply keeps the value it had"_, which
happened three times to this contract. Adding `todos` to `UpdateProposalInput` without carrying it
through every transport **fails `tsc` in the pull request that adds it.**

**Sparse like every key in that set:** absent leaves the proposal's list alone; an explicit `[]` or
`null` CLEARS it. `mergeProposedFields` (`lib/services/plansService.ts:387`) is an explicit key-by-key
merge, so it gains one line and no behaviour anywhere else changes.

### D4 — the bar is the STORE's bar, imported and never re-declared

Validated at BOTH write boundaries — the append (`plansService.addProposals`, `lib/services/plansService.ts:2635`)
and the deepen / correction (`updateProposal` `:3284`, `correctProposal`):

| field         | rule                                                         | constant                   |
| ------------- | ------------------------------------------------------------ | -------------------------- |
| `text`        | non-empty after trim, ≤ 200 characters                       | `TODO_TEXT_MAX_LENGTH`     |
| `notesMd`     | ≤ 2000 characters                                            | `TODO_NOTES_MAX_LENGTH`    |
| `commandText` | ≤ 500 characters                                             | `TODO_COMMAND_MAX_LENGTH`  |
| `executor`    | `coding_agent` \| `human` \| null, at the TRANSPORT's schema | — (AMENDMENT 4 D3a's rule) |

All three are imported from **`lib/workItemTodos/limits.ts`**, whose header is explicit that this is
the point of the file: _"⚠️ THE POINT OF THIS FILE IS THAT THE NUMBER HAS ONE HOME … a bar enforced in
two places is a bar that drifts — so the service, the DTO's documented contract, the error message a
user reads and every test assert against THESE constants, never against a literal."_ A proposal path
that re-declared `200` would be the second home that file exists to prevent, and the drift would be
invisible: a step accepted at plan time and rejected on the card it materializes into.

**A `todos` on a CONTAINER kind is refused** — `InvalidProposalError`, at the same boundary as every
other proposal-shape refusal. A container's steps are its children; a story with a checklist is a
story whose children were never planned, and the refusal is what says so at the moment somebody writes
it rather than at the moment somebody reads it.

**It is ALLOWED on every leaf kind** — `task`, `bug`, `subtask` — because the STORE allows a to-do on
any card and the carrier's job is to reach the store, not to re-decide its scope. **Nothing here makes
a list mandatory on anything.** The expectation that a `manual` card HAS one is a planning RULE, and it
lives in the two rule homes (D7 and the Consequences below), not in this field's validator.

### D5 — what MATERIALIZE writes

In `plansService.materialize` **Pass 1** (`lib/services/plansService.ts:1281`), immediately after the
`workItemRepository.create` for that `add` (`:1411`) and inside the SAME transaction:

- **one `workItemTodoRepository.create` per row** (`lib/repositories/workItemTodoRepository.ts:71`), in
  array order;
- **`position` minted with `keyForAppend`** from the PREVIOUS row's key (`null` for the first) — the
  same fractional-index arithmetic `addTodo` uses, and the same helper Pass 1 already calls twice for
  the created item's own `position` and `backlogRank` (`:1312`, `:1320`). No lock is taken: the rows
  are minted in one loop inside one transaction against a list nobody else can see, which is the one
  case `addTodo`'s `FOR UPDATE` re-read is not protecting against;
- **`executor` per row = `todo.executor ?? pf.executor ?? 'human'`** — the store's own seed rule
  (`work-item-todo-list.md` §2), restated for the proposal path. `workItemTodosService.addTodo`
  (`lib/services/workItemTodosService.ts:309`) writes
  `input.executor !== undefined ? input.executor : (item.executor ?? 'human')`, reading the CARD's
  executor as the fallback; on the proposal path the card does not exist yet, so `pf.executor` is that
  same fact one step earlier;
- **`doneAt` / `doneById` null.** A proposal never ticks. There is no field for it and there will not
  be: an approved plan that arrived with rows already checked would be a plan asserting that work was
  done, which is the one thing a proposal cannot know.

**The created-row revision records them.** `buildAddDiff` (`lib/services/plansService.ts:407`) gains
`todos: { added: [{ id, text }] }` — byte-identical to the shape `recordTodoRevision`
(`lib/services/workItemTodosService.ts:227`) writes for a hand-added row, so the activity feed renders
a materialized list through the disposition it already has rather than through a second one.

**It goes through the REPOSITORY, not `workItemTodosService.addTodo`.** This is not a layering
shortcut and the reason is already written down, one layer up: the `plansService` header
(`:137-149`) explains that materialize composes the tx-aware LEAF repositories directly rather than
calling `workItemsService.createWorkItem`, because _"those service methods own their OWN
`db.$transaction` and Prisma cannot nest interactive transactions — calling them here would break the
'approve applies in ONE transaction' guarantee."_ `addTodo` has exactly that shape — its own
`withWorkspaceContext`, its own `resolveEditableWorkItem`, its own `lockTodoList` — so it is bypassed
for the identical reason, and the executor seed and the revision diff are what have to be restated
here as a consequence.

### D6 — who READS it

| reader                                                                | file                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------- |
| the review surface's item DTO — `PlanReviewItemDto.todos` on an `add` | `lib/dto/planReview.ts`                                  |
| the peek's PROPOSAL MODE, read-only, composed from the shipped row    | `app/(authed)/items/_components/IssueQuickViewPanel.tsx` |
| the public v1 proposal schema + presenter                             | `app/api/v1/**` (`planProposalFieldsSchema`)             |
| the CLI's one-line render — `· N steps`                               | `packages/cli/src/**` (`describeProposal`)               |
| `get_plan`'s per-proposal line — a step COUNT                         | `lib/mcp/tools/`                                         |

`/api/v1` carries it **additively**, with a `V1_CONTRACT_VERSION` **MINOR** bump and the regenerated
client types. MOTIR-3157 is the precedent for forgetting exactly that, and is `relates_to` this story
for that reason.

**A `modify` and a `remove` render NO list, and this amendment does not add one.** The reason is a
decision already taken next door: `PlanProposalPeekDto` (`lib/dto/planReview.ts:131`) deliberately
carries the ENVELOPE and not the payload, because a `modify` names a real work item and the shipped
peek is already client-fetched by key from both hosts — merging the target's `QuickViewData` into the
plan read would mean _"~14 reads … once per proposal … ~280 reads for a plan with twenty `modify`s, to
serve a peek the reviewer opens at most one of."_ And `QuickViewData` (`lib/dto/quickView.ts`) carries
no to-do field at `d2a0c964b` in any case. So the rule is exact: **the peek shows steps on an `add`,
which has no live card to fetch them from, and on nothing else.** Widening it is MOTIR-3808's surface
plus MOTIR-4181's, not this story's.

### D7 — the PRODUCER on the closed side

`motir-ai` mirrors the field on its own `ProposedFields` and `ProposalPatch`; the `author` tool takes
`todos` on a leaf; the writer carries it to core's append and deepen seams.

**And `walkCompleteness` treats a `type: manual` leaf with an empty `todos` as INCOMPLETE**
(`AUTHOR_REQUIRED_ON_MANUAL`). That is the load-bearing half of D7 and the reason it is a `D` rather
than a note: it turns the rule from advice into a **field the walk reads**, which is this document's
own standard — a bar stated in prose is a bar the first tired author walks past; _"a bar enforced as a
value the service rejects past"_ is a bar the product holds (`lib/workItemTodos/limits.ts`, quoted in
D4). D4 makes a list optional at the CARRIER precisely so that the RULE can be the thing that requires
it, in the one place a `manual` card is authored.

### What this does NOT change

- **Nothing about the STORE.** `work_item_todo`, its columns, its policy, the section on the item page
  and hand-editing are MOTIR-3808's and are untouched. This amendment adds a second WRITER of those
  rows and no new way for them to be shaped.
- **`work-item-todo-list.md` is not amended.** That record stands; this one cites it and composes with
  it. The caps, the executor seed rule and _"a to-do is one operation"_ are quoted here, never
  re-decided.
- **No migration, no new table, no new column.** D1 is a JSON field on a row that already exists.
- **Nothing about DISPATCHING a step.** Handing one row to a hosted agent is MOTIR-3809 (Epic 9), and
  the `executor` a proposed row carries is the same declarative promise §2 of the store's ADR already
  defines — it says who the step is FOR, and nothing schedules it.
- **Nothing about the assistant that rewrites a list.** MOTIR-1344, `blocked_by` this story.
- **No committed-card list in the quick view.** D6.
- **`CLI_TOKEN_GRANT` is NOT widened.** `add_plan_items` and `update_plan_item` assert `ai:view_plan`
  and the grant does not carry it, so a sandboxed run can no more propose a step list than it can
  propose a card. AMENDMENT 12's own bullet, unchanged.
- **Nothing about approve's other passes.** The birth-status derivation (Pass 2b), the ref resolver,
  the repo-pin checks and `PlanItem`'s shape are all as they were.

### Consequences — what each sibling of MOTIR-3810 inherits

| card                                                          | inherits                                                                                                                                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The CARRIER — `PlanItemProposedFields.todos`** (MOTIR-4616) | D1's field and element type verbatim; D3's sparse merge; D4's imported caps, the container refusal and the leaf allowance                                                          |
| **MATERIALIZE writes the rows** (MOTIR-4618)                  | D5 entire — the repository call, the `keyForAppend` minting, the executor seed expression, the untouched `doneAt`, and `buildAddDiff`'s new key                                    |
| **Every DOOR carries `todos`** (MOTIR-4619)                   | D3's three deepen doors plus the append; `UPDATE_PROPOSAL_KEYS` as the guard that makes an incomplete pass fail to compile; `get_plan`'s step count and the MCP tool-doc catalogue |
| **`/api/v1` and the CLI read the steps** (MOTIR-4620)         | D6's public rows — the schema, the presenter, the MINOR `V1_CONTRACT_VERSION` bump with regenerated client types, and `· N steps`                                                  |
| **The DESIGN of the proposed list in the peek** (MOTIR-4615)  | D6's read-only rule and D2's _why a `modify` shows none_, which the asset has to draw as an ANSWER rather than leave as an empty state                                             |
| **The REVIEW SURFACE shows the steps** (MOTIR-4622)           | D6's `PlanReviewItemDto.todos` and the peek's PROPOSAL MODE, built to MOTIR-4615's asset                                                                                           |
| **The SHIPPED planner PROPOSES the steps** (MOTIR-4623)       | D7 entire — the mirrored fields, `author`'s parameter, the caps re-validated on the closed side, and `AUTHOR_REQUIRED_ON_MANUAL`                                                   |
| **`SHARED_PLANNING_RULES` teaches the bar** (MOTIR-4621)      | D7's rule half, as sentences in `A_MANUAL_CARD_BAR`                                                                                                                                |
| **`type-manual.md` teaches the runbook planner** (MOTIR-4617) | the same sentences in `motir-meta`'s pack — the other of the two rule homes                                                                                                        |
| **The two test gates** (MOTIR-4624 · MOTIR-4626)              | every refusal D4 names, the round trip D5 describes, and the `modify`-carries-no-steps rule D2 decides                                                                             |
| **The Playwright acceptance E2E** (MOTIR-4625)                | the story's own verification recipe, which is D6 and D5 read end to end by a person                                                                                                |
