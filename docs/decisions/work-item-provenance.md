# ADR: Work-item provenance — how each item was planned & implemented

- **Status:** Accepted (2026-07-09)
- **Story / Subtask:** 7.x Work-item provenance (MOTIR-1685) · Subtask MOTIR-1686
- **Supersedes / superseded by:** none
- **Consumed by:** MOTIR-1687 (schema enums + columns + service/repository write API +
  read DTO), MOTIR-1688 (design), MOTIR-1689 (stamp manual + MCP planning), MOTIR-1690
  (motir-ai native-provenance producer), MOTIR-1691 (stamp native planning at
  materialize), MOTIR-1692 (implementation-provenance recording seam), MOTIR-1693
  (detail display), MOTIR-1694 (integration), MOTIR-1695 (E2E). Downstream hand-off:
  **Epic 9** (native/hosted AI coding — trusted, gateway-metered implementation
  provenance) calls this story's recording seam.

> Structured **Status → Context → Decision → Consequences**, with the load-bearing
> facts pinned in explicit tables so every downstream subtask implements against one
> authoritative source (the convention `work-item-type-taxonomy.md` set).

---

## Context

Motir is the three-pillar pipeline — **AI planning · project management · agent
orchestration**. To make that pipeline **auditable**, every work item should record its
**provenance**: how it was **planned** and, once executed, how it was **implemented** —
each as a `source · harness · model` triple. For any item a user can then see whether it
was planned natively in Motir, via the MCP, or added by hand; and whether it was
implemented by the hosted agent, a BYOK agent on the user's own machine, or manually —
and with which harness + LLM.

### Shipped reality this builds on (verified against `origin/main`, HEAD `8ae10ba0`)

- **`WorkItem` has no provenance field today** — greenfield. The nearest precedent is the
  `WorkItemExplanationSource` enum (`{user_authored, ai_draft, user_edited}`) on the
  `explanationSource` column (`prisma/schema.prisma:974,1392`): a small closed enum
  recording the origin of a piece of item metadata. Provenance follows that shape.
- **Every `WorkItem` row is inserted at ONE physical choke-point** —
  `workItemRepository.create` (`lib/repositories/workItemRepository.ts:2407`), a single
  `tx.workItem.create({ data })`. It is fed by exactly **two** builders:
  - `workItemsService.createWorkItem` (`lib/services/workItemsService.ts:602`, builder
    `data` at `:803`) — serves BOTH the manual Server Action `createIssueAction` AND the
    MCP `create_work_item` tool. Optional metadata columns are threaded with the
    `...(input.x ? { x } : {})` spread idiom (`explanationSource` at `:814`).
  - `plansService.materialize` (`lib/services/plansService.ts:205`, builder `data` at
    `:273`) — the AI-plan approve path, which maps a `PlanItemProposedFields` proposal
    (`pf`) onto the created row (same optional-spread idiom, e.g. `explanationSource` at
    `:289`).
- **Planning sources — all three shippable now.** `manual` (the UI Server Action),
  `mcp` (the agent token surface), and `native` (materialize of a motir-ai-generated
  plan). The native generation LLM is known to **motir-ai** via `PlanningRun.model`
  (`motir-ai/prisma/schema.prisma:364`, `String?`), **not** to motir-core — so motir-ai
  must carry it across the proposal seam (Decision 5).
- **Implementation sources — BYOK + manual shippable now; hosted deferred.** The BYOK /
  self-hosted lane already reports back via the session MCP tools `mark_integrated`
  (`lib/mcp/tools/markIntegrated.ts`) and `complete_session`
  (`lib/mcp/tools/completeSession.ts`) — the natural recording point. The **hosted**
  lane (trusted, gateway-metered) is **unbuilt** and belongs to
  [Epic 9](motir:cmqfb4me600k82d0ieesj6uul).

### Decision-authority evidence used below

- **Rung 1 (mirror tools).** Linear and GitHub attribute automated authorship to a
  **free-form integration / app identity** (an "app" / "integration" name), and model
  identifiers (`claude-opus-4-8`, `deepseek-chat`, `gpt-4o`) are an **inherently open,
  fast-moving set**. Neither is modelled as a closed enum. The _category_ of author
  (human vs app vs bot), by contrast, is a small closed set.
- **Rung 2 (shipped Motir reality).** The `explanationSource` enum precedent; the single
  insert choke-point + two builders; the internal proposal append seam
  `POST /api/internal/ai/plan-proposals` and its **optional, merge-order-free**
  `productName` field precedent (`motir-ai/docs/contract.md`).

---

## Decision 1 — Storage shape: denormalized columns on `WorkItem`

Provenance is stored as **six nullable columns + two enums directly on `WorkItem`**,
latest-authoritative — **NOT** a separate `ProvenanceRecord` / `ImplementationRun`
history table.

**Why:** provenance is **1:1 with the item**, read on the item detail, and needs no
run-history for v1 — exactly the `explanationSource` shape (rung 2). A per-run history
table (mirroring motir-ai's `PlanningRun` / `PlanningTurn`, and linking gateway usage)
buys nothing here and adds a join + a write-fan-out. It is **explicitly deferred to
Epic 9**, when hosted runs produce trusted, metered, potentially _multiple_ execution
attempts per item that genuinely warrant an `ImplementationRun` row. Stating it here so
Epic 9 knows the seam: the columns below are the "latest authoritative" projection; a
future `ImplementationRun` table would sit _behind_ the `implementation*` columns and
keep them as the denormalized latest.

### Columns (added to `model WorkItem`, all nullable)

| Column                  | Type                            | Meaning                                             |
| ----------------------- | ------------------------------- | --------------------------------------------------- |
| `planningSource`        | `WorkItemPlanningSource?`       | how the item was **planned** (enum)                 |
| `planningHarness`       | `String?`                       | planning harness/tool (free text, e.g. `Motir`)     |
| `planningModel`         | `String?`                       | planning LLM (free text, e.g. `claude-opus-4-8`)    |
| `implementationSource`  | `WorkItemImplementationSource?` | how the item was **implemented** (enum)             |
| `implementationHarness` | `String?`                       | implementation harness (free text, e.g. `opencode`) |
| `implementationModel`   | `String?`                       | implementation LLM (free text, e.g. `deepseek`)     |

- **All six nullable.** Both triples are independently optional: provenance may be
  **unknown** (pre-feature items; items never executed). A null triple renders as `—`
  (Decision, MOTIR-1688/1693). Naming is **camelCase with NO `@map`**, matching this
  table's existing columns (`explanationSource`, `storyPoints`, `sprintId` — the
  within-table-consistency call, rung 2).
- **Leaf-agnostic.** Unlike `type`/`executor` (leaf-only), provenance is meaningful on
  **any** kind (an epic/story can be MCP- or manually-created too). No leaf-only rule.

---

## Decision 2 — `source` as Prisma enums; `harness` + `model` as free-text

### The two enums (closed, small sets — mirror `WorkItemExplanationSource`)

```prisma
enum WorkItemPlanningSource {
  native   // materialized from a motir-ai-generated plan
  mcp      // created through the Motir MCP agent tool surface
  manual   // created by a human in the UI

  @@map("work_item_planning_source")
}

enum WorkItemImplementationSource {
  hosted   // executed by the Motir hosted agent (Epic 9 — trusted, gateway-metered)
  byok     // executed by a bring-your-own-key agent on the user's own machine
  manual   // implemented by a human, no agent

  @@map("work_item_implementation_source")
}
```

**Why enums for `source`:** the author _category_ is a small closed set (rung 1) that the
display switches over totally and that a filter facet could later close over — exactly
why `WorkItemType` / `WorkItemExplanationSource` are enums (rung 2). Extensible only by an
explicit enum-addition + migration, never ad-hoc strings.

**Why free-text for `harness` + `model`:** these are **open, fast-moving sets** — harness
(`opencode` / `Claude Code` / `Codex` / `Cursor` / `Aider` …) and model
(`claude-opus-4-8` / `deepseek-chat` / `gpt-4o` / `glm-4` …). An enum would force a
schema migration per new tool or model release. Mirror tools attribute automated
authorship to a **free-form** app identity and record open model ids (rung 1). Stored
**as-supplied** (trimmed, empty→null); no server-side validation against a fixed list.

---

## Decision 3 — Trust model: self-reported vs metered

- **Planning provenance** (all three sources) and **BYOK + manual implementation
  provenance** are **self-reported**: the caller/agent asserts `harness` + `model`. There
  is **no trusted meter** for a user's own machine, so the model **records the reported
  values as-is and MUST NOT imply verification.**
- **Only HOSTED implementation runs** get trusted, gateway-metered provenance — where
  motir-gateway records the authoritative model + provider per run. **Out of scope here**
  (Epic 9): this story ships the recording _seam_ the hosted lane will later call, but no
  hosted execution and no metered attribution.
- **Server-set vs caller-supplied `source`.** `source` is **never** taken from untrusted
  client input; each write-seam sets it server-side (Decision 4). `harness`/`model` are
  the only self-reported free-text values, and only where a caller legitimately supplies
  them (MCP / session tools).
- **Display does NOT distinguish self-reported vs metered.** A "verified/metered" badge is
  a **hosted-only concern deferred to Epic 9** — the v1 detail display (MOTIR-1688/1693)
  shows the triples plainly. (Recorded here so the design subtask does not invent a
  trust affordance the data can't yet back.)

---

## Decision 4 — Write-path & MCP contract (planning + implementation)

The **default `source` per write-seam** — server-set, never from client body:

| Write seam                                                     | `source` set                                  | `harness` / `model`                      |
| -------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------- |
| Manual UI (`createIssueAction`)                                | `planning = manual`                           | both null (a human via UI)               |
| MCP `create_work_item`                                         | `planning = mcp`                              | caller-supplied (new optional args)      |
| Native materialize (`plansService.materialize`)                | `planning = native`                           | `harness = Motir`, `model` from proposal |
| Self-reported session (`mark_integrated` / `complete_session`) | `implementation = byok` (default) or `manual` | caller-supplied                          |

### Service write API (MOTIR-1687)

`workItemsService.createWorkItem` accepts an **optional** structured param
`provenance?: { planning?: { source; harness?; model? }; implementation?: { … } }` and
threads it into the repository `create` input via the existing optional-spread idiom.
Omitting it is a **no-op**: all six columns write null (no behaviour change for existing
callers). A separate service path stamps **implementation** provenance from the session
tools (Decision 4, session row). `source` is a **server-set** value at each seam — it is
**not** added to `CreateIssueInput` and a client-forged `planningSource` is ignored (same
discipline as `reporterId`).

### MCP `create_work_item` — two new optional args (MOTIR-1689)

| arg                  | type               | notes                                    |
| -------------------- | ------------------ | ---------------------------------------- |
| `plannedWithHarness` | `string?` optional | the agent's harness (e.g. `Claude Code`) |
| `plannedWithModel`   | `string?` optional | the agent's LLM (e.g. `claude-opus-4-8`) |

The tool sets `provenance.planning = { source: 'mcp', harness, model }` (harness/model
null when omitted). Documented in `docs/mcp.md`.

### Session tools `mark_integrated` / `complete_session` — implementation triple (MOTIR-1692)

Both gain an **optional** implementation provenance input:

| arg                     | type                          | notes                                                                                       |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| `implementationSource`  | `'byok' \| 'manual'` optional | **default `byok`** when omitted; `hosted` is NOT accepted here (Epic 9 uses a trusted seam) |
| `implementationHarness` | `string?` optional            | self-reported harness                                                                       |
| `implementationModel`   | `string?` optional            | self-reported model                                                                         |

`mark_integrated` stamps the one item's implementation triple **in the same transaction**
that moves it to `in_review` + records `sessionBranch`. `complete_session` applies the
supplied triple to **every** item it closes on the branch. Omitted → implementation
columns untouched (a session that reports no provenance leaves the triple null → `—`).
`hosted` is intentionally rejected on these self-reported seams so a BYOK caller cannot
claim trusted-metered provenance.

---

## Decision 5 — motir-ai native-provenance proposal contract

The native LLM is known only to motir-ai (`PlanningRun.model`). motir-ai attaches planning
provenance to **each `add` PlanItem proposal** it streams to core over
`POST /api/internal/ai/plan-proposals`, so `plansService.materialize` can stamp it.

**Where it rides:** on **`proposedFields`** (the JSON contract materialize already
consumes and maps 1:1 onto the created `WorkItem`), as a nested object:

```jsonc
// PlanItemProposedFields (motir-core lib/dto/plans.ts) gains:
"planningProvenance": {
  "source": "native",     // constant for motir-ai
  "harness": "Motir",     // constant for motir-ai
  "model": "deepseek-chat" // resolved from the originating PlanningRun.model (may be null)
}
```

Chosen over a dedicated `PlanItem` column because (a) `proposedFields` is already the
JSON the append seam carries and materialize reads — no new column or migration in either
DB; (b) provenance is a field _of the proposed work item_, 1:1 with it, exactly like
`type`/`storyPoints`/`explanationSource` which already ride `proposedFields`.

**Consumer is DEFENSIVE — merge order is free (mirrors the `productName` contract).**
`materialize` (MOTIR-1691) stamps native planning provenance regardless of whether the
proposal carries `planningProvenance`:

```
planningSource  = 'native'                                 // pinned — it IS the native seam by construction, never read from the proposal
planningHarness = 'Motir'                                  // pinned — likewise
planningModel   = pf.planningProvenance?.model   ?? null   // RECORDED from the producer (for analysis) — see Decision 6
```

So the core consumer (MOTIR-1691) is correct **before** the motir-ai producer (MOTIR-1690)
ships — it just stamps `native · Motir` with a null model until proposals carry one. When
1690 lands, `planningModel` starts populating on the row. This is the two-PRs-one-contract
pattern (a `motir-core` consumer + a `motir-ai` producer), NOT a straddle: the field is
**optional by contract**, so an older core that predates it ignores it and a newer core
without the producer still stamps a valid native triple. `motir-ai/docs/contract.md` +
the frozen proposal-contract guard test are updated in 1690 (adding to the proposal
contract trips the drift guard, exactly like adding a JobKind).

Note: `source` AND `harness` are **pinned to `native`/`Motir` at materialize**, not read
from the proposal — a forged non-native `source`/`harness` on
`proposedFields.planningProvenance` can never change the stamp (the internal seam is trusted
as native by construction). Only the **model** is carried through from the producer, and
purely so it can be RECORDED for analysis (Decision 6) — it is never displayed.

**Why the producer still exists even though native never shows its model (Yue, 2026-07-10).**
Motir abstracts its own planning LLM — a natively-planned item reads **"Native · Motir"**, and
the underlying model is DELIBERATELY not exposed to the user (frontend or API). But we still
want the model RECORDED on the row for internal analysis (which models plan best, cost/quality
tracking). So the producer carries the model, materialize records it on the column, and the
read boundary strips it (Decision 6). Recorded ≠ exposed.

---

## Decision 6 — Read DTO + the native-model strip (recorded ≠ exposed)

The work-item detail read DTO (`WorkItemDto`, the shape `app/(authed)/items/[key]` reads)
carries **both triples** — `planningSource`/`planningHarness`/`planningModel` and
`implementationSource`/`implementationHarness`/`implementationModel` — mapped through the
work-item mapper (`toWorkItemDto`; enum values passed through as their DTO string). This is
what the display subtask (MOTIR-1693) renders. Adding fields to the read DTO is a
**shared-shape change**: the consumer sweep (MOTIR-1687) must update the exact-shape
route/DTO `.toEqual` tests across the whole affected test dirs, not grep-hits.

**The native-model strip (Yue, 2026-07-10).** `toWorkItemDto` is the single detail-read
choke-point, and it is where the native model is stripped:

```
planningModel = row.planningSource === 'native' ? null : row.planningModel
```

- For **`native`** planning, the underlying LLM is **recorded on the row** (for analysis)
  but **null in the DTO** — never exposed to the frontend or the API. A native item reads
  **"Native · Motir"**, model hidden.
- For **`mcp`** and **BYOK/manual** implementation, the model IS exposed — the user reported
  their OWN harness/model, so there is nothing to abstract.
- The strip lives at the mapper (read boundary), NOT at the write — so the column keeps the
  value for analytics queries while every user-facing read hides it. A future analytics
  surface reads the column directly (bypassing `toWorkItemDto`), which is the intended seam.

---

## Decision 7 — Display: provenance is COLLAPSED by default, at the BOTTOM of the rail (Yue, 2026-07-10)

Provenance is **secondary metadata**, not a primary field like Status/Assignee. On the
work-item detail it is **collapsed by default** behind a disclosure ("Provenance", expandable)
placed at the **very bottom of the rail — after every other field** (Reporter · Created ·
Updated), not inline among them. The user **expands to see** the two triples. The common case
is the `—`/unknown state anyway (most items are never executed), so defaulting to collapsed at
the bottom keeps the rail's primary fields uncluttered. The design (MOTIR-1688) draws the
collapsed + expanded states; the display (MOTIR-1693) implements the disclosure (the shipped
"Show all custom fields" toggle grammar), defaulting closed, appended after the last rail field.

---

## Consequences

- **One migration, additive, null-defaulted** — no backfill; every existing row reads
  `—` on both triples until re-touched. No behaviour change for any existing caller.
- **Total display switch** over the two `source` enums (closed sets) + free-text
  harness/model + the null/`—` state (MOTIR-1688/1693), rendered **collapsed by default**
  (Decision 7).
- **Native model recorded ≠ exposed** (Decision 6): the row keeps the native planning model
  for analysis; the read DTO strips it, so the API/UI show `Native · Motir` only. The
  motir-ai producer (MOTIR-1690) stays — it feeds the recorded (not displayed) model.
- **Epic-9 hand-off is explicit:** (1) the **hosted** implementation lane calls this
  story's recording seam with trusted, gateway-metered `model` + provider; (2) a
  self-reported-vs-metered display distinction is a hosted-only, later concern; (3) a
  future per-run **`ImplementationRun`** history table (mirroring `PlanningRun` /
  `PlanningTurn`, linking gateway usage) sits behind the `implementation*` columns and is
  Epic 9's call — the columns here are the denormalized latest-authoritative projection.
- **No new trust surface:** `source` is server-set at every seam; `hosted` is unreachable
  from the self-reported session tools; only `harness`/`model` are self-reported free text,
  recorded as-is without implying verification.

```

```
