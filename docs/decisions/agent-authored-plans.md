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
  MOTIR-3097 (the story's vitest gate).

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
