# ADR: A conversation turn's INTENT — how ask and plan-change are told apart, and what crosses the wire

- **Status:** Accepted (2026-08-19, drafted for Story MOTIR-1343 per the
  decision-subtask ladder). This is the rung-1/rung-2 contract the rest of
  MOTIR-1343 implements — no ask code ships until these points are pinned.
  **No application behaviour ships in this subtask** (the ADR only).
- **Story / Subtask:** MOTIR-1343 (The AI assistant — Ask about this project) ·
  Subtask MOTIR-1816.
- **Consumed by:** MOTIR-1815 (design: the cited-answer turn and the correction
  affordance), MOTIR-1817 (motir-ai `ask_project` handler), MOTIR-1818
  (motir-core conversation store), MOTIR-1819 (`POST /api/ai/ask` + the
  re-dispatch), MOTIR-1820 (the rail + the callout row), MOTIR-1821 / MOTIR-1822
  (the two vitest gates), MOTIR-1823 (the acceptance E2E). Downstream,
  MOTIR-1344 (Help with a task) inherits the per-turn intent model this fixes.
- **Builds on:** the shipped plan-change conversation (MOTIR-1728 / MOTIR-1730),
  the planner's own `assistant` turn (MOTIR-2222 / MOTIR-2226), the universal AI
  callout (MOTIR-1811 / MOTIR-1812), and the two-graph retrieval (MOTIR-806).
- **Supersedes / superseded by:** none. It does, however, **close** the "ask
  mode" framing that MOTIR-1343's own 2026-08-01 re-plan struck out of the story
  body but left as an open contract question here.

> Convention (set by `work-item-type-taxonomy.md`, followed by
> `billing-tiering.md` / `status-derivation.md` / `design-result.md`): a decision
> record is a markdown file under `docs/decisions/`, structured
> **Status → Context → Decision → Consequences**, with the load-bearing facts
> pinned in explicit tables so downstream code has one authoritative source to
> implement against.

---

## Context

The project conversation is about to carry two intents: **`plan_change`**
(shipped — accumulate what the user wants changed, run a plan-edit job, review
the proposal) and **`ask`** (new — answer a question about the project from its
plan tree and code graph, with citations, changing nothing).

Both ride **one thread and one composer**. That is settled above this record and
is not re-opened here:

- **Rung 1 (Yue, 2026-08-01):** the callout's rows all open the same surface
  _because the user can switch the topic in the middle of the conversation_.
- **Rung 2 (shipped):** `lib/planning/aiCallout.ts` computes ONE href for every
  row and says so in the file — _"the callout is not a mode picker and not a
  router… a row is a LABEL, not a route"_ — and `design/ai-chat/design-notes.md`
  § _"EVERY ROW OPENS THE SAME SURFACE"_ records the same, adding that a row
  **may seed the composer's starter phrasing but never constrains the thread**.
- **Rung 2 (shipped):** `PlanningMode` in `lib/planning/launcher.ts` is derived
  from WHERE the workspace was launched (`resolvePlanningMode`), not from what
  the user wants to do. An intent does not belong in it.

So the open question is narrow and entirely about the wire: **when a user types
one sentence into one composer, what decides which intent it is, and what does
the client send?**

### Shipped substrate this reconciles against

Verified on `origin/main` @ `fec2a4f6` (motir-core) and `origin/main` @ `21ae185`
(motir-ai), 2026-08-19.

| Fact                                                                                                                                                                                                                                | Where                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| The composer's send is already **append-then-run in one gesture** — `send()` POSTs the turn, then immediately submits. There is no separate "submit" button to hang a second intent off.                                            | `lib/hooks/usePlanChangeConversation.ts` (`send`)                                                     |
| `PlanChangeTurnRole` already has **three** values — `user` \| `system` \| `assistant` — and `assistant` is a real persisted turn, not client chrome                                                                                 | `prisma/schema.prisma` (`enum PlanChangeTurnRole`); `lib/dto/planChange.ts` (`PlanChangeTurnRoleDto`) |
| An `assistant` turn is written back **by the client after the stream settles**, keyed on `jobId` so the call is replayable                                                                                                          | `app/api/ai/plan-change/session/planner-turn/route.ts`                                                |
| The thread records **which affordance sent a turn** (`isAnswer`), deliberately, rather than re-deriving it from the words — _"which affordance sent it is recorded here"_                                                           | `prisma/schema.prisma` (`PlanChangeTurn.isAnswer`)                                                    |
| A turn append is **read-derived under a row lock** (`SELECT … FOR UPDATE` on the session, `turnCount` re-read inside the transaction)                                                                                               | `prisma/schema.prisma` (`PlanChangeSession.turnCount`)                                                |
| The turn-append route is deliberately **not rate-limited**, on the stated ground that _"no model job is submitted and no provider money is spent on this path"_                                                                     | `app/api/ai/plan-change/session/turns/route.ts`                                                       |
| A plan change is **already a proposal a human approves** — the job writes `PlanItem` proposals into a `generating` Plan and the rail confirms it; nothing is committed by a turn                                                    | `lib/hooks/usePlanChangeConversation.ts`; `app/api/plans/[planId]/approve`                            |
| `ResultEnvelope` is extended **per job kind, purely additively** — `validation`, `scanner`, `scope`, `sprintAssignment`, `planningTurn` are each present for some kinds and absent for the rest, and _"core reads results loosely"_ | `motir-ai/src/envelope.ts`                                                                            |
| `ask_project`'s retrieval substrate exists and is reused, not built — `assembleRetrievalTools` merges the plan-tree and code-graph tool families for `runToolSession`                                                               | `motir-ai/src/llm/retrievalTools.ts`                                                                  |
| The boundary client already carries **synchronous, non-job RPCs** beside `submitJob` (`embedTexts`, `getPreplanState`, `refreshCodeAudit`, `getConvention`, …) — a classification RPC would be an established shape, not a new one  | `lib/ai/motirAiClient.ts`                                                                             |

### The mirror, OBSERVED (rung 1)

MOTIR-1816 required this to be checked rather than asserted, because the
recommendation it carried was reasoning, not observation (`notes.html` #33 — the
board-pagination mistake, where a sentence naming Jira was never verified).
Observed 2026-08-19:

| Mirror                  | What was observed                                                                                                                                                                                                                                                                                                                                                          | Where                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Atlassian Rovo Chat** | ONE composer, **no ask/act toggle**. Its placeholder is _"write a prompt, @someone, or use `/` for actions"_ — free text is the default and `/` is an **optional** action menu, not a mode the thread enters. Correction is conversational: _"You don't always get amazing results with just one prompt, so keep iterating and asking until you get the answer you need."_ | `support.atlassian.com/rovo/docs/using-rovo-chat/`         |
| **Atlassian Rovo Chat** | The confirmation sits on the **acting** side, at execution: _"Skills typically require confirmation from the person who prompted the agent, except agents in automation rules."_ Not on the classification.                                                                                                                                                                | `support.atlassian.com/rovo/docs/chat-actions/`            |
| **Linear Agent**        | ONE unified chat (⌘/Ctrl-J, mobile, `@Linear` in a comment, Slack/Teams), **no ask/act toggle**, and the SAME thread carries both shapes — _"Read this backlog and pull out repeated themes that we can prioritize"_ beside _"Make issues based on the discussion here and assign them to me."_                                                                            | `linear.app/changelog/2026-03-24-introducing-linear-agent` |

**The counter-precedent, weighed as the card required.** Developer tools —
Cursor, Claude Code — do ship an explicit ask/agent switch. It is inapplicable
here, and the reason is structural rather than demographic. In those tools
"agent mode" writes to the user's working tree, so the switch is a _safety_
affordance over write scope, and a wrong guess costs unwanted edits. In Motir a
`plan_change` turn produces a **proposal a person approves** — the write is
already gated one layer down. The switch would be buying protection Motir
already has. "Our users are not developers" is the weaker version of this
argument and is not the one this record rests on.

**And a third observation that decided more than the absence of a toggle.**
Neither mirror classifies a sentence at the door and then forks to two backends.
Each routes one request to **one agent that works out what to do as part of
doing it**. That is the shape this record adopts, adapted to Motir's two very
differently-priced jobs.

---

## Decision

### §1 — `intent` is SERVER-RESOLVED. The client never sends one.

The client posts what it posts today — `{ body, targets?, isAnswer? }` — and
**adds no intent field, no mode, and no hint.** The resolved intent comes BACK,
on the turn.

| Direction       | Carries                                                                                                                                                | Notes                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| client → server | `body`, `targets?`, `isAnswer?`                                                                                                                        | unchanged from the shipped shape                                                 |
| server → client | the session DTO, whose `user` turn now carries `intent: 'ask' \| 'plan_change'`, plus the dispatched job's id and kind                                 | the rail reads `intent` to know which chrome the latest turn earns               |
| persisted       | `PlanChangeTurn.intent` (nullable; set on `user` turns, null on `system` / `assistant`), and `PlanChangeTurn.intentCorrected` (boolean, default false) | the `isAnswer` precedent: the thread records what Motir DID, not a re-derivation |

`intent` is the **effective disposition** — what actually ran for that turn — not
a stored guess. If a turn is re-run under the other intent (§3), `intent` moves
to what ran and `intentCorrected` becomes true, so the transcript keeps the fact
that Motir read it wrong the first time.

### §2 — The resolver is motir-ai, and it is the FIRST STEP OF THE `ask_project` JOB. `ask` is the door.

Every user turn is dispatched as **`ask_project`** through `POST /api/ai/ask`.
The handler's first LLM turn — **before it assembles retrieval** — decides
whether the turn is a question it should answer or a request to change the plan:

- **A question** → it answers over the two-graph retrieval and returns the
  answer plus its citations. This is the whole of MOTIR-1817 as already written.
- **A plan-change request** → it returns **no answer**, and its result carries
  `intent: 'plan_change'`. It spends one small completion and **no retrieval
  budget**.

motir-core then records the user turn's `intent` as `plan_change` and dispatches
the **shipped** plan-change submit. The plan-change route, service and `augment`
contract are untouched; they gain a caller, not a behaviour.

**Why here and not in a classifier of its own.** Three alternatives were live:

| Option                                                                                | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A **synchronous `classifyTurnIntent` RPC** on `motirAiClient`, called before dispatch | Cleanest on paper, and the boundary already has synchronous RPCs. But it is a **new motir-ai endpoint, a new client function and a new core router** — three deliverables **no card in MOTIR-1343 owns** (MOTIR-1817 is scoped to the job and handler; MOTIR-1819 to the route and the stream). A decision whose answers have no home is `notes.html` #181, and paying for it here would mean creating a card mid-run to buy elegance the alternative does not need. |
| A classifier in **motir-core**                                                        | It is a model judgement. It belongs behind the open-core boundary, not in the GPL repo, and a keyword heuristic is exactly the mis-classification the correction affordance exists to catch.                                                                                                                                                                                                                                                                         |
| **One merged job** that classifies, then either answers or plans                      | The two jobs are not the same weight: `augment` assembles the plan engine's context, emits `search` / `drill` / `level_complete` / `pass` / `planned` / `validated` frames and writes a Plan. Merging makes every question pay for the plan engine.                                                                                                                                                                                                                  |

**The cost this accepts, stated plainly:** a plan-change turn now opens an
`ask_project` job that produces no answer, and the rail's state machine must
handle _job A settled with a redirect → open job B_. That is one small
completion and one extra hop on the path that already works. It is accepted
because it removes an entire boundary RPC, a router, and an unowned card, and
because the judgement it reuses is one the ask handler has to make anyway — its
own grounding discipline already requires it to recognise a turn it cannot
answer.

### §3 — A mis-read is corrected by RE-RUNNING THE SAME TURN, never by re-typing it.

The affordance lives on the **`assistant` turn Motir produced** — the moment the
user discovers the mis-read — as a single marker under the bubble, in the
idiom `plan-change-planner-speaks.mock.html` already draws for turn markers. Two
labels, one per direction, naming the act and not a mode:

- under an answer → **"Propose changes instead"**
- under a proposal → **"Answer this instead"**

What it does:

- **Re-runs the ORIGINAL `user` turn** under the other intent. No new `user`
  turn is appended — the person said one thing once, and the transcript is a
  record of who said what (the `assistant`-turn posture MOTIR-2226 established).
- **Appends a NEW `assistant` turn** with the corrected outcome. The superseded
  one stays on the thread; a correction is a second answer, not an erasure.
- Sets the user turn's `intent` to what ran and `intentCorrected` to true.
- Is **not** a mode: the next turn is classified from scratch.

### §4 — When classification is not confident, the default is `ask`.

The asymmetry decides it, and §2 makes the default **structural rather than a
confidence threshold nobody can calibrate**: `ask` is the door every turn goes
through, so "not confidently a plan change" _is_ an answer attempt. A wrong
`ask` costs one cheap answer and one click on the marker in §3. A wrong
`plan_change` spends the plan engine, opens a `generating` Plan, and puts
confirm chrome in front of somebody who asked a question.

**A FAILED classification is not a guess.** If the `ask_project` job itself
fails — transport, out-of-credits, timeout — the turn surfaces in the rail's
**shipped error state**: recoverable in place, the thread and any prior proposal
survive, and `retry` re-sends the accumulated intent without appending a second
turn (`usePlanChangeConversation`'s documented posture). Motir does not silently
fall through to the other intent, because spending a plan generation on a turn
whose reading failed is the expensive half of the asymmetry above.

### §5 — Recorded, not re-decided: the intent is per-TURN, and a row seeds text only.

- **A thread may alternate freely, turn by turn.** The previous turn's intent
  places **no** constraint on the next. There is no session-scoped mode, no
  `?mode=` parameter, no chrome a thread is locked into, and nothing about
  intent belongs in `PlanningMode`.
- **A callout row seeds the composer's starter phrasing and nothing else.** The
  seed is **TEXT, not an intent** — it must not arrive as a client-supplied
  hint, because a hint on the wire is the mode re-entering through the back
  door. It is classified exactly like anything the user typed themselves.

---

## Consequences

1. **No composer switch, ever.** The composer keeps one field and one send. The
   design card must not draw an ask/act control.
2. **The canvas chrome follows the LATEST turn**, as MOTIR-1343 already says:
   after an answer there is nothing to confirm, so the diff + confirm bar are
   absent; the moment a later turn resolves to `plan_change`, the shipped chrome
   returns in the same thread.
3. **The rail streams twice on a plan-change turn.** `POST /api/ai/ask` returns a
   job whose result may say "this was a plan change"; the rail then attaches to
   the plan-change job. This is a state-machine consequence MOTIR-1819 and
   MOTIR-1820 own between them, not an accident to discover at build time.
4. **`POST /api/ai/ask` is the composer's ONE door**, not an "ask-only" endpoint
   the client picks when it already knows. MOTIR-1819's criteria are amended
   accordingly (below).
5. **An ask writes no work item**, and the vitest gates (MOTIR-1821 / MOTIR-1822)
   assert it — including on the redirect path, where an `ask_project` job that
   resolved to `plan_change` must still have written nothing itself.
6. **Metering is honest about the extra hop.** The classification turn is a
   `recordTurn` like any other; a redirected turn bills one small completion plus
   the plan-change job it hands off to.
7. **`intentCorrected` is queryable telemetry.** How often Motir reads a turn
   wrong is the number that decides whether §2's default ever needs revisiting.
   Nothing in MOTIR-1343 surfaces it; it is recorded so the question is
   answerable later.

## Binding on MOTIR-1343's cards

> ⚠️ **This list is not a sweep.** `notes.html` #197 records exactly this trap: a
> decision that enumerates the cards it affects makes its own sweep look already
> done, and the card whose MECHANISM moved is the one that gets missed. Every row
> below was applied to the work item itself in the same pass that merged this
> record.

| Card                                 | What this record changes for it                                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MOTIR-1815** (design)              | Draw the **correction marker** on the assistant turn (§3), both labels, and the redirect's second-stream state. Do **not** draw an ask/act switch (§1).                                                                                    |
| **MOTIR-1817** (motir-ai handler)    | The handler's first turn also **classifies**, before retrieval, and its result carries `intent: 'plan_change'` with no answer when the turn was not a question (§2). Additive on `ResultEnvelope`, the shipped per-kind pattern.           |
| **MOTIR-1818** (store)               | `intent` is **server-resolved**, nullable, on `user` turns only; plus `intentCorrected` (§1). The `assistant` role and its `question` / `isAnswer` / `jobId` columns **already ship** — this card adds intent and citations, not the role. |
| **MOTIR-1819** (route)               | `POST /api/ai/ask` is the composer's **one door** for every turn, not an ask-only endpoint; it owns the **re-dispatch** to the shipped plan-change submit on a redirect, and the **correction re-run** of an existing turn (§2, §3).       |
| **MOTIR-1820** (rail)                | The composer sends to the one door and carries **no switch**; the rail renders the correction marker and handles the two-stream redirect (§3, Consequence 3).                                                                              |
| **MOTIR-1821 / MOTIR-1822** (vitest) | Cover the redirect path and assert an ask — including a redirected one — writes no work item (Consequence 5).                                                                                                                              |
| **MOTIR-1823** (E2E)                 | The acceptance walk asks, gets a cited answer, then asks for a plan change **in the same thread with no mode change** (§5).                                                                                                                |
