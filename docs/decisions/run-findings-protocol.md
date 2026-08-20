# A run's findings — what a dispatched agent may write, and who controls it

**Status:** accepted · **Date:** 2026-08-19 · **Card:** MOTIR-3019 (story MOTIR-3017)

> **On the file name.** `docs/decisions/` is slug-named, not numbered — forty-three
> files, none carrying an ordinal. MOTIR-3019 asked for "the next free number";
> there is none to take, so this takes the next free SLUG, checked against
> `origin/main` and against every unmerged sibling branch (`git show <branch>:docs/decisions/`)
> for the same reason a number would have been: two parallel runs picking the same
> name collide (`adr-number-race`).

An agent working a card finds two kinds of trouble: **this card is wrong**, and
**something else is broken**. Today the prompt handles the first and forbids
acting on the second — and the first does not survive the loop's close-out
(MOTIR-3018, fixed alongside this). This ADR settles what a dispatched agent may
write, how an operator controls it per run, and what automating plan approval
costs.

Every premise below was re-read on `origin/main` at `e04e2b9f`. Where the card
that commissioned this ADR described the code inaccurately, the correction is
recorded rather than quietly applied — see **Premises, verified** at the end.

---

## Q1 — How a per-run policy reaches the prompt

### Decision

**A single optional query parameter on `GET /api/v1/work-items/{key}/dispatch-prompt`,
`findingsPolicy`, carrying a comma-separated list of DISABLED capabilities from a
closed vocabulary.** It feeds a new field on `DispatchPromptOptions`, which
`dispatchPromptService` passes into `DispatchPromptSource` for
`lib/dispatch/promptTemplate.ts` to assemble conditionally.

```
GET /api/v1/work-items/MOTIR-42/dispatch-prompt?findingsPolicy=log-bug,replan
```

- **Vocabulary:** `log-bug`, `replan`. Named after the CAPABILITY, not after the
  CLI flag — the wire must not inherit a `--disable-` prefix that belongs to one
  client's ergonomics.
- **Absent or empty ⇒ the full protocol.** Every existing caller, and a human
  reading `motir run --print`, keeps today's output byte for byte.
- **An unrecognised token is a `400 INVALID_FINDINGS_POLICY`, not an ignored
  one.** A typo that silently rendered the full protocol would be precisely the
  lie this story exists to remove: the operator would believe they had disabled
  something the agent was still being told to do.
- The MCP `dispatch_prompt` tool takes the same option, so the two transports
  cannot disagree about the contract.

### Alternatives rejected

| alternative                                                                          | why not                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A CLI-side filter** — the flags change what `motir` does, not what the prompt says | Inert. The prompt is the ENTIRE contract with a sandboxed agent; an instruction it never receives cannot be obeyed or disobeyed. This is the whole reason the parameter has to exist.                                                                                                       |
| **A project-level setting only**                                                     | Cannot vary per run, which is the request. A protocol that always files bugs is wrong for a demo; one that never does is wrong for a maintenance sweep.                                                                                                                                     |
| **A prompt MODE enum** (`full` / `quiet` / …)                                        | A mode is a closed set over a product of independent capabilities: two booleans need four members, three need eight, and every new capability renumbers the vocabulary. A list of what is OFF grows by one token.                                                                           |
| **Two separate boolean parameters**                                                  | Equivalent in reach and slightly worse on the wire: `?logBug=false&replan=false` reads as two knobs with no shared meaning, and neither can be validated against a vocabulary — an unknown KEY is ignored by convention in both shapes, but an unknown VALUE is catchable only in this one. |

### What this reverses, quoted

MOTIR-2406, the card that wrote the outcome protocol, states: _"It does NOT add
a prompt MODE or a new parameter: every instruction here is unconditional,
because a human-driven `motir run` agent should report the same way."_

That is traded deliberately. The reasoning it rested on — instructions must not
drift between MODES — survives intact and is not what this does: there is still
exactly one grammar, and the policy REMOVES a branch rather than rewording one.
What it gives up is a different property, stated plainly because it is real:

- **A prompt is no longer reproducible from the card alone.** `motir run --print
--disable-log-bug` and a plain `motir run --print` on the same card produce
  different text, and both are correct.
- **Two agents on the same card can receive different instructions.** An operator
  who wants to know what an agent was told has to know the policy too.
- **`promptTemplate`'s purity claim changes shape.** Its module header says
  _"PURE: a function of its input record only … two calls for an unchanged item
  return byte-identical output"_ — the property MOTIR-881 pins. The property is
  RESTATED, not weakened: the same item **with the same policy** returns
  byte-identical output; the same item with a DIFFERENT policy returns different
  output, and that second half must be asserted explicitly or the switch could be
  inert and every disabled-branch assertion would pass vacuously.

Judged worth it because the alternative is worse in kind: an operator can already
decide whether to run an agent at all, and refusing them a say in what it may
write while it runs is a control gap, not a safety property.

### The naming — recorded as decided, not re-opened

**Primary spelling `--disable-log-bug` / `--disable-replan`** (Yue, 2026-08-18),
deliberately NOT the repo's `--no-*` convention (`--no-browser`, `program.ts:98`,
is the shipped example). `--no-log-bug` is a verb+object compound reading
ambiguously between _"don't log a bug this time"_ and _"the bug-logging
capability is off"_, and only the second is meant. `--disable-x` also leaves room
for a symmetric `--enable-x` if the project-level default of Q2 lands, without
commander's negation defaults getting in the way.

**`--no-log-bug` and `--no-replan` are accepted as HIDDEN aliases** — identical
behaviour, absent from `motir help` (`commander`'s `Option.hideHelp()`). The point
is that someone typing the house convention on instinct gets what they meant
instead of `unknown option`; the point is NOT to offer two documented spellings.

There is no `--no-auto-approve-replan`: that flag is positive and has no negation.

---

## Q2 — Automated plan approval: surface, scope, and bounds

### Decision: `/api/v1` only, and deliberately NOT an MCP tool

`plansService.approvePlan` gains a second CALLER, never a second implementation.

**Route: `POST /api/v1/work-items/{key}/plan-approval`.** It resolves the
workspace from the bearer token, calls the shipped service, and maps its typed
errors. Everything that decides whether a proposal becomes a row stays inside
`approvePlan`; the re-validation on the way through is untouched.

> **⚠️ AMENDED 2026-08-19 while building the loop half (MOTIR-3023).** This was
> written as `POST /api/v1/plans/{planId}/approval`, with the card named in the
> body. **The caller cannot learn a plan id.** The plan is submitted by the
> AGENT, in a sandbox, with `motir plan --detach <KEY>`; the id comes back on
> that agent's stdout, which the loop streams straight to the terminal and never
> captures — and MOTIR-3023 forbids scraping it for exactly that reason. A
> plan-addressed route therefore needed either a second `/api/v1` read to
> discover the id or a second source of truth, and B1's anchoring check would
> have been a check on data the CALLER supplied.
>
> Addressed by the CARD, the bound stops being a check and becomes structural:
> **there is no way to name a plan the card did not produce.** The server derives
> it, and the route takes no body at all — so there is nowhere for a plan id to
> creep back in. One operation instead of two, and a stronger guarantee.

**Scope: `ai:view_plan`** — the key `lib/mcp/toolPermissions.ts` already records
as gating the plan DECISIONS (`approvePlan` / `declinePlan` / `addProposals`). No
new scope is minted.

> ⚠️ **AMENDED 2026-08-20 (MOTIR-3188): the route now declares `ai:decide_plan`.**
> The rule this answer applied is unchanged and still the right one — _a route
> names the key its own service asserts, and no new scope is minted for a decision
> that already has one._ What changed is the service. `ai:view_plan` gated no view
> and held two authorities at once (AUTHOR: `addProposals` / `markPlanned` /
> `editAddProposal`; DECIDE: `approvePlan` / `declinePlan`), which made a custom
> role ticking a switch labelled _"View AI plans"_ a bulk work-item creator.
> `approvePlan` moved to the DECIDE half and this route followed it. The operation's
> shape, statuses and error codes are untouched. See
> `docs/decisions/agent-authored-plans.md` AMENDMENT 5.

**Not an MCP tool, and that is the sharpest bound available.** MCP is the AGENT's
surface. A tool would put approval in reach of the credential the sandboxed agent
holds, which is the one party that must never approve its own re-plan — the
approving party is the OPERATOR's loop, not the agent it launched. Expressing
that structurally beats expressing it as a check, and it costs nothing: the CLI
speaks `/api/v1` exclusively (`docs/decisions/cli-v1-client.md`).

It is also already enforced from the other side and by accident of good design:
`CLI_TOKEN_GRANT` is `['project:browse', 'work_item:edit', 'comment:add',
'ai:plan']` — **no `ai:view_plan`** — so a token minted for a dispatched agent
cannot reach this endpoint even if someone hands it the URL. That is MOTIR-3051's
refusal working as intended, and it must not be "fixed" by widening the grant.

> ⚠️ **AND SINCE MOTIR-3188 THE BOUND IS STRUCTURAL, NOT AN OMISSION.** The
> argument above rests on one entry being absent from one grant — true, but a
> single edit away from false. The route now declares `ai:decide_plan`, which
> `CLI_TOKEN_GRANT` also omits AND which **no MCP tool asserts at all**, so a
> dispatched agent's credential cannot reach approval by any route — and could not
> even if somebody widened that grant to the full author key. The key is reachable
> by an OPERATOR's token, through this one v1 operation and no other:
> `lib/tokens/grant.ts`'s `V1_ONLY_PERMISSIONS` carries it, the first entry that
> array has ever held.

### The bounds — each implementable and testable from this text alone

**B1 — the CARD is the address, and the plan is DERIVED from it.**
The key is in the path and there is no request body. The server resolves the plan
through `buildScope([key])` → `planChangeSessionRepository.findByProjectAndScope`
→ that session's `lastJobId` → `plansService.findPlanIdForJob`. Every hop is
shipped; nothing new is stored. A `motir plan --detach <KEY>` thread is anchored
at exactly that scope, so this reaches the plan the card's refusal caused and
nothing else.

Refusal is a typed error naming why — `NO_PLAN_FOR_WORK_ITEM`, 422 — never a
silent narrowing. Two consequences worth stating:

- A card with **no** anchored conversation, or one that has never submitted, is
  **not** approvable here — and neither is a plan from the project-wide thread,
  which is the shape a cadence plan and an onboarding generation both have.
  That is correct: this endpoint exists for a plan a run's agent submitted about
  the card it was handed, and every other plan keeps the human gate.
- It bounds the endpoint to the plan a run **caused**, which is stronger than
  "the plan this run submitted" (unobservable server-side) and weaker than a
  per-run token (not worth a new mechanism). The gap is: a second run on the same
  card, in the same window, could approve the first's plan. It is named rather
  than hidden, and it is acceptable — both runs are the same operator's, working
  the same card, and the card is held out of the ready set the whole time.

**B2 — status, inherited not added.** `approvePlan` already refuses a plan that
is not `planned` (`PlanNotInExpectedStatusError`), and a second concurrent
approve observes `approved` and 409s. This endpoint adds nothing; it must not
re-derive the check.

**B3 — approving an already-approved or declined plan answers the same 409 the
session route answers.**

> **⚠️ CORRECTED 2026-08-19, before it was built (MOTIR-3021).** This bound was
> written as _"the same no-op the session route produces"_, taken from
> MOTIR-3019's own text and not verified. It is false: the session route maps
> `PlanNotInExpectedStatusError` to **409**
> (`app/api/plans/[id]/approve/route.ts`), which is the atomic one-shot guard —
> the loser of two concurrent approves observes `approved` and is refused. There
> is no no-op anywhere on that path.
>
> Mirroring the 409 is also the right answer, not merely the true one: two
> entrances answering ONE condition two different ways is exactly what "no second
> approval implementation" exists to prevent. What the loop does with a 409
> _because the plan was already approved_ is the loop's decision (MOTIR-3023),
> and it is a different question from what the endpoint says.

**B4 — cross-workspace refusal is indistinguishable from an unknown plan.** A
plan in another workspace and a plan id that does not exist return the same
response. No existence leak.

**B5 — an approved plan MAY change the run, and the loop absorbs it; the server
does not forbid it.** This is the case the endpoint exists for: the agent said
the card is wrong, so a plan that re-scopes or REMOVES that card is the correct
output, and a server that refused it would make the flag useless in its central
case. The obligations therefore sit in the loop (MOTIR-3023):

- The refused card is **not dispatched again by the same run**, approved plan or
  not — the existing `seenKeys` guard and exclude list, and the summary says it
  was held out. Without this, approve → ready → dispatch → refuse → approve is an
  infinite loop that spends AI credits every turn.
- **A card that stopped existing must not crash the run.** An archived or removed
  card is an ordinary outcome, recorded and stepped past.
- **Cards already FINISHED are not revisited.** The run's records are a log of
  what happened, not live state; a plan that re-scopes a card whose pull request
  is already open changes the card, not the history.
- **`--max` still binds.** An approved plan can enlarge the ready set without
  limit; the cap is what stops a run expanding forever.

**B6 — a REFUSED approval stops the run with the server's own message.** Never
continue as though it had succeeded: the loop's next iteration would dispatch
against a tree the operator has not agreed to.

### The project-level default — decided in shape, not built here

**Yes, a project must be able to forbid automatic approval outright**, and the
check belongs SERVER-SIDE where a CLI flag cannot route around it. Its shape is
fixed here so a later card does not re-derive it:

- A project setting `aiPlanAutoApproval: 'allowed' | 'forbidden'`, default
  **`allowed`**. Default-forbidden would make the flag inert until someone flipped
  a setting, which contradicts the request that produced it; a team that wants the
  human gate opts INTO it, which is the same direction every other Motir setting
  runs.
- Enforced in the route, before the service call, as a typed
  `AUTO_APPROVAL_FORBIDDEN` refusal naming the project.

**This story does not build it.** It is named so MOTIR-3021's "every bound the ADR
set is enforced server-side" reads unambiguously: B1–B6 are that story's bounds;
the setting is a specified follow-up, and the route should be written so adding it
is one guard.

### What this reverses, quoted

Four places in the codebase assert that plan decisions are not available off the
session surface. They are listed in **Comments the implementing cards must
correct**, below, with what each should say instead. The strongest is
`lib/mcp/tools/getPlan.ts:34`: _"`plansService.approvePlan` — a human decision
made in Motir — is the only path from a proposal to a `work_item` row."_

The half that stays TRUE is the important half: `approvePlan` **is** still the
only path from a proposal to a work item, and this ADR does not add a second one.
What changes is who may call it and from where. The trade is worth making because
the alternative on offer was not "a human decides" but "an unattended run stops
and the finding sits until someone notices" — and the operator who passes
`--auto-approve-replan` is a human deciding, once, in advance, with the bounds
above written down. What it costs is real and is the reason for B1 and the
project setting: **an unattended loop can now change a plan somebody owns while
they are not watching.**

---

## Q3 — Where a run-filed bug is parented

### Decision: ONE rule, no discriminator the agent can get wrong

**A bug a dispatched agent files is parented under the IN-FLIGHT CARD'S PARENT,
and `relates_to` the in-flight card.** Where the in-flight card has no parent, the
bug is parented under the in-flight card itself.

The parent key is already on the dispatch payload the agent was handed
(`DispatchPrompt.parentKey`, MOTIR-2445), so the prompt can state it as a
CONCRETE key rather than as a rule to apply. There is nothing to look up, nothing
to choose, and nothing to invent — which is the whole requirement.

### Why not the planner-bug home

`lib/ai/plannerBugHome.ts` resolves `PLANNER_BUG_HOME_MARKER` to the project's
`story` titled `Captured planning-mistake bugs`, and `aiWorkItemsService.fileBug`
files there. That home is for **PLANNING** defects — telemetry about the planner,
whose fix is the plan or the rule that would have prevented it.

A dispatched agent cannot produce one through this branch, by construction: a
defect in the CARD it was handed goes down the THE-CARD-IS-WRONG branch and
becomes a re-plan. The FOUND-A-DEFECT branch is, by definition, _"my card is fine
but something else is broken"_ — a product defect, whose fix is code in a repo.
So the two homes stay separate and the agent never has to tell them apart.

The home is also unreachable from a dispatched agent's credential: `fileBug` sits
behind the internal service-auth route, and `CLI_TOKEN_GRANT` does not carry what
it asserts. A rule the agent could not execute would be worse than no rule.

### What the prompt must REQUIRE, so a filed bug is not under-authored

- `kind: 'bug'`, `parentKey` as above, and a `relates_to` link to the in-flight
  card. The link is the discovery trace: the parent says where the bug LIVES, the
  link says where it was FOUND.
- A description carrying, in order: **the REPRODUCTION** (what to do to make it
  happen), **the EVIDENCE** (the command run and its verbatim output, or the file
  and line read), and **the CARD AND BASE it was seen at** — the key, and the
  branch or commit, because a figure measured on an unmerged branch is not a
  figure about `main`.
- **Reproduce FIRST.** A bug filed from a code-reading theory is a claim, not an
  observation, and it costs the next reader the same investigation twice.
- **It blocks nothing and claims no scope.** No `blocked_by` edge, no sprint, no
  estimate. Filing is purely additive — which is what makes it safe for an
  unattended run to do at all, and it must stay that way.
- **Only the description axis.** `create_work_item` has no `explanationMd`
  parameter, so the WHY axis cannot be set at create. The prompt asks for the
  description and nothing else; the standing rationale is written by whoever
  triages it, who has context the agent does not.

### And the branch must say what filing does NOT do

**Filing a bug does not end the run and does not change the card's own outcome.**
Stated explicitly in the prompt text, because an agent that has just found
something broken will otherwise treat it as a reason to stop. It reports what it
found and carries on with the card in hand.

### The contradiction this closes

`WHAT_TO_DO.code` step 5 (`promptTemplate.ts:156`) already tells the agent to
_"log anything else you find as a separate work item"_, while `outcomeProtocol`
two sections later forbids it: _"do not create or edit work items yourself. A
plan is PROPOSALS awaiting a human's approval; writing the cards would be doing
the approving."_ Both texts are in every `code` prompt shipped today.

The justification is also simply wrong about the mechanism: `create_work_item` is
a DIRECT write. Nothing about it is a proposal and nobody approves it — it is how
`motir log-bug` files bugs and how every card in this story was authored. The
prohibition is REPLACED, not deleted, and what survives is the part that is true
and load-bearing: **do not restructure the plan.** Creating a bug and submitting a
re-plan are permitted; archiving, re-parenting, re-scoping and editing another
card remain forbidden, and the prompt must say which is which.

---

## Q4 — Why `--auto-approve-replan` is `auto`-only

Settled by Yue on 2026-08-18. Recorded here because the RATIONALE is what keeps it
from being helpfully extended later.

- **`run` and `next` dispatch ONE item and exit.** The flag's whole value is
  _"the run can continue to finish the cards"_, and there is no continuation to
  have. Approving there would change the tree and then exit.
- **`batch`'s snapshot is FROZEN before the first agent starts**, and nothing
  re-reads the ready set to pick work — its defining contract
  (`packages/cli/src/batchPlan.ts`: _"it FREEZES the ready set once, up front, and
  implements exactly those items"_). Approving a plan there would change the tree
  and then decline to act on it, which is worse than refusing the flag. **Nothing
  in this story weakens that guarantee**; `batch` gains the two `--disable-*`
  flags and nothing else.
- **`auto` asks `next_ready` each iteration**, so newly-approved cards genuinely
  enter the run. It is the only command where the flag means anything.

**The other three REGISTER the flag in order to refuse it**, with a description
naming `auto`. A flag a command guards but never declares is rejected by commander
first with a bare `unknown option`, leaving the guard that carries the real
guidance unreachable — the MOTIR-1828 / MOTIR-1830 defect, shipped twice. The
remedy is already in `program.ts`: `auto` and `batch` register `--print` precisely
so their own guards can speak (`program.ts:234`, `program.ts:250`). Mirror it.

**On `auto`, `--auto-approve-replan` together with `--disable-replan` (or its
alias) is contradictory** and is refused at parse time, with a message naming both
flags. Approving a re-plan that the prompt was told not to offer cannot happen,
and a run that accepted both would be silently ignoring one of them.

---

## Comments the implementing cards must correct

Left as they stand, the codebase argues with itself — a comment insisting
approval is never automated, beside the endpoint that automates it. Each is either
corrected to describe what is now true or annotated with this ADR. MOTIR-3021
discharges the list.

| path                                                 | the assertion                                                                                                                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/mcp/tools/getPlan.ts:34`                        | _"`plansService.approvePlan` — a human decision made in Motir — is the only path from a proposal to a `work_item` row"_                                                            |
| `lib/mcp/tools/planSession.ts:53`                    | _"`plansService.approvePlan` — a decision made in Motir, not on this surface — is the only path from a proposal to a work item"_                                                   |
| `lib/mcp/tools/expandItem.ts:37`                     | _"`plansService.approvePlan` is the ONLY path from a proposal to a work item"_                                                                                                     |
| `app/api/v1/work-items/[key]/expansions/route.ts:20` | _"`plansService.approvePlan` — a human decision made in Motir, not on this surface"_                                                                                               |
| `lib/mcp/toolPermissions.ts:78–90`                   | two comments describing `ai:view_plan` as gating decisions that have no door; one already carries a 2026-08-18 amendment note for `add_plan_items` and needs the same for this one |
| `lib/mcp/scopes.ts:97`                               | _"`approvePlan` / `declinePlan` assert the same key and are not"_ [reachable]                                                                                                      |
| `lib/services/aiPlanEditsService.ts:19`              | _"the ONE path that turns proposals into work items is `plansService.approvePlan`"_ — **still TRUE, and must NOT be edited into saying otherwise.** Annotate only.                 |
| `lib/dto/plans.ts:572`                               | _"Nothing here has touched the tree: `plansService.approvePlan` is the…"_ — same: true, annotate only.                                                                             |

The discriminator: a comment saying `approvePlan` is the ONLY proposal→row path
stays, because it is still true. A comment saying it is reachable only from Motir,
or only from a session, is now false and is corrected.

---

## Premises, verified — and three the commissioning card got wrong

Every claim MOTIR-3019 makes was re-read on `origin/main` at `e04e2b9f`. Three did
not survive, and none changes a decision:

1. **"`planSession.ts`, `expandItem.ts` and `getPlan.ts` each say approval is _'a
   human decision made in Motir'_."** Only `getPlan.ts` uses that exact phrase.
   `planSession.ts` says _"a decision made in Motir, not on this surface"_ and
   `expandItem.ts` says only _"the ONLY path from a proposal to a work item"_. A
   FOURTH file the card does not name — `app/api/v1/work-items/[key]/expansions/route.ts`
   — carries the phrase verbatim. The corrected list is the table above.
2. **"`docs/decisions/` — grep for the next free ADR number."** The directory is
   slug-named; there are no numbers. Handled in the note at the top.
3. **The MOTIR-2406 quote about unconditionality** is from that CARD, not from
   `promptTemplate.ts`; the module carries the property in its header's purity
   claim instead (_"PURE: a function of its input record only"_). Both are quoted
   above, from where they actually live.

Confirmed as stated: `approvePlan` is the only proposal→row path and re-validates;
`app/api/plans/[id]/approve/route.ts` is session-bound via `getWorkspaceContext()`;
`toolPermissions.ts` records `ai:view_plan` as the decisions' key;
`CLI_TOKEN_GRANT` omits it; `plannerBugHome.ts` resolves a marker to a
title-matched story that `aiWorkItemsService.fileBug` uses; `batchPlan.ts` carries
the frozen-snapshot contract; `program.ts` carries both the `--no-browser`
convention and the `--print` refuse-by-registering precedent; and the
`WHAT_TO_DO.code` step-5 / `outcomeProtocol` contradiction is live in every `code`
prompt.

---

## Consequences

- **The prompt stops being unconditional.** That was a deliberate property; it is
  traded deliberately, and `promptTemplate`'s determinism contract is restated per
  policy rather than dropped.
- **An unattended run can change a plan somebody owns.** Only when the operator
  asks for it, only for a plan anchored to the card the run was refused on, only
  with a scope a dispatched agent's own token does not carry, and — once the
  follow-up lands — never in a project that has turned it off.
- **A run's most valuable output stops evaporating.** The bug it reproduced
  becomes a card; the re-plan it submitted survives the close-out. Both were
  previously prose on a card nobody re-reads.
- **`batch` is untouched in every respect but the two `--disable-*` flags.** Its
  frozen snapshot is the one contract this story must not bend, and the `auto`-only
  scoping of the approval flag is what protects it.

## Consumed by

- **MOTIR-3020** — Q1's parameter shape and Q3's parenting rule, in the prompt.
- **MOTIR-3021** — Q2's surface, scope and bounds B1–B6, and the comment list.
  Its two amendments above (B3's status and B1's address) were both made while
  building, from code that contradicted the text.
- **MOTIR-3022** — Q1's naming, Q4's registration-to-refuse and the contradictory-flag refusal.
- **MOTIR-3023** — Q2's B5 loop obligations and B6.
- **MOTIR-3026 / MOTIR-3027** — the documented protocol, in `motir-core` and in `motir-meta`.
