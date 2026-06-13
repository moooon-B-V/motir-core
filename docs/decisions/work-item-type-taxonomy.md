# ADR: The `WorkItemType` taxonomy + the type→executor default map

- **Status:** Accepted (2026-06-12, confirmed with Yue)
- **Story / Subtask:** 2.7 (Work-item type + executor) · Subtask 2.7.2
- **Supersedes / superseded by:** none
- **Consumed by:** 2.7.3 (schema enum + columns + default helper), 2.7.4 (picker UI),
  2.7.5 (seed-loader mapping), 2.7.6 (filter facet) — and downstream Story 7.6
  (the per-type prompt generator) and the Epic-7 AI dispatch layer.

> This is the first ADR in the repo, so it also sets the convention: a decision
> record is a markdown file under `docs/decisions/`, named for the thing it
> fixes, structured **Status → Context → Decision → Consequences**, with the
> load-bearing facts pinned in explicit tables so downstream code has a single
> authoritative source to implement against.

---

## Context

Two pieces of planning metadata — **what KIND of work** a leaf is (`code` vs
`design` vs `decision` …) and **WHO executes it** (a coding agent vs a human) —
already travel with every plan leaf in `scripts/plan-seed/data/` as
`PlanItem.type` / `PlanItem.executor` (see `scripts/plan-seed/types.ts`: `type`
is a free `string`, `executor` is `'coding_agent' | 'human'`). But the
`work_item` table has nowhere structural to land them, so the seed loader
(`scripts/plan-seed/seed.ts`) currently **stringifies them into the description
prose** ("Type: code", "Executor: coding_agent"). Prose is unqueryable,
unfilterable, and unroutable.

Story 2.7 promotes both to first-class `work_item` fields. This ADR freezes the
**set** those fields range over and the **default mapping** between them, so the
schema (2.7.3), the picker UI (2.7.4), the loader (2.7.5), and the filter facet
(2.7.6) all build against one authoritative definition rather than each
re-stating it — and so Story 7.6's per-type prompt generator can be a **total
function** over a closed enum (a `switch` with no `default` hole).

No application behaviour ships in this subtask. The set it freezes is what makes
the rest of the story buildable.

---

## Decision

### 1. The fixed `WorkItemType` enum (ten members)

`type` is a **FIXED enum** — not free text. Fixed so 7.6's per-type prompt
generator is a total function over it and the 2.7.6 filter facet is a closed
set. It is extensible later **only** by an explicit enum addition + migration,
never by ad-hoc strings.

| Member     | One-line scope (the authoritative gloss for picker labels + 7.6 prompt templates)     |
| ---------- | ------------------------------------------------------------------------------------- |
| `code`     | Application code — features, endpoints, services, schema, migrations.                 |
| `design`   | Visual/interaction design — mockups, design tokens, `design-notes.md`.                |
| `test`     | Automated tests — unit / integration / E2E suites and fixtures.                       |
| `content`  | Copy, docs, and translation — user-facing strings, READMEs, i18n locales.             |
| `research` | Spike / investigation — time-boxed exploration that produces findings, not ship-code. |
| `review`   | QA / acceptance review — verifying a deliverable against its acceptance criteria.     |
| `decision` | A decision record (ADR) — fixing a choice the rest of the work builds against.        |
| `deploy`   | Infrastructure / ops — pipelines, environments, release + rollout mechanics.          |
| `manual`   | Human-only out-of-band work — SaaS / dashboard / secret / DNS / OAuth provisioning.   |
| `chore`    | Maintenance — dependency bumps, renames, lint/format sweeps, housekeeping.            |

Exactly **ten** members, in this canonical order. 2.7.3 declares this enum in
`prisma/schema.prisma` verbatim; 2.7.5's loader validates `PlanItem.type`
against it and **fails loudly** on an unknown string (a plan-module typo is a
seed-time error, never a silently-dropped field — the structural backstop the
prose form never had).

### 2. `type` is DISTINCT from `kind`, and LEAF-ONLY

`kind` (`epic` / `story` / `task` / `subtask` / `bug`) is the **structural
hierarchy** — it governs parenting (the kind-parent grammar). `type` is the
**nature of executable work** and is **orthogonal** to `kind`: it never affects
parenting.

`type` is carried **only on executable leaves** — `task` / `subtask` / `bug`.
Epics and stories are containers, not units of execution, so they have **no
type**. Every epic/story row, and every legacy/pre-2.7 row, is `type = null`.

- The column is therefore simply **nullable**. Leaf-only is a **semantic rule
  the service layer enforces** (`workItemsService` rejects setting
  `type`/`executor` on an epic/story with a typed error) — not a DB constraint a
  single nullable column can express.

### 3. The `executor` enum + the type→executor DEFAULT map

`executor ∈ { coding_agent, human }`. It is **nullable**, set alongside `type`.

When a `type` is first chosen, `executor` is **seeded** from the default map
below — and the seed is **always overridable** at pick time. The map is the
single source `2.7.3`'s `defaultExecutorForType(type): Executor` helper encodes;
neither the picker (2.7.4) nor the loader (2.7.5) re-states it — they call the
helper.

| `type`     | Default `executor` | Routing rationale                                                |
| ---------- | ------------------ | ---------------------------------------------------------------- |
| `code`     | `coding_agent`     | Code is the coding agent's core competency.                      |
| `test`     | `coding_agent`     | Test authoring is coding-agent work.                             |
| `deploy`   | `coding_agent`     | Pipeline/infra-as-code is agent-authorable.                      |
| `manual`   | `human`            | Out-of-band SaaS/dashboard work an agent structurally cannot do. |
| `decision` | `human`            | A judgement call / sign-off a human owns.                        |
| `review`   | `human`            | Acceptance review is a human gate.                               |
| `design`   | `coding_agent`     | Either; default agent (HTML mockups from the design system).     |
| `content`  | `coding_agent`     | Either; default agent (copy/docs/i18n drafting).                 |
| `research` | `coding_agent`     | Either; default agent (spikes), reassignable to a human.         |
| `chore`    | `coding_agent`     | Either; default agent (mechanical maintenance).                  |

Read as the three groups the story header records: **always-agent**
(`code` / `test` / `deploy`), **always-human** (`manual` / `decision` /
`review`), and **either, default agent** (`design` / `content` / `research` /
`chore`). Every one of the ten types has a default — the helper is **total**, so
adding an eleventh enum member without extending the map is a compile/test-time
failure (2.7.7 iterates the full enum), not a silent `default` fall-through.

### 4. The Jira-mirror deviation (Principle #11 — the honest paper trail)

Motir's primary standard is the mirror product, Jira (decision-authority
rung 1). Splitting `type` from `kind` and adding a separate `executor` axis is a
**deliberate deviation** from Jira, recorded here with its concrete
justification per Principle #11.

**The verified mirror (what Jira actually does):**

- **"Issue type" in Jira IS the kind hierarchy** — epic / story / task /
  sub-task / bug. That hierarchy is the _only_ native type axis: software
  projects ship the standard bug / story / task types plus sub-task, and custom
  issue types still slot into that same `Epic → {story, task, bug} → sub-task`
  shape. (Atlassian Support — _"What are work types?"_ / work-type management.)
- **Routing WHO executes is done through the ASSIGNEE field, not a sub-type.**
  With Rovo you "can add an agent to the assignee field," so an AI agent "shows
  up as an assignee, with the same fields and patterns" a human assignee would.
  (Atlassian Support — _"Collaborate on work items with AI agents."_)
- **Therefore Jira has no native executor sub-type orthogonal to issue-type.**
  The "what kind of work" and "who executes it" signals are both overloaded onto
  existing fields (issue-type = the kind hierarchy; assignee = the router).

> These are **observed** mirror behaviours (per `notes.html` #33: cite what was
> observed in the mirror, never assert from memory). The citations above are the
> surfaces verified; the deviation below is justified against them.

**The deviation and its concrete use case:** Motir separates the two axes —
`type` (what NATURE of work) and `executor` (WHO does it) — because the Epic-7
**AI dispatch layer** needs both as structural, queryable fields:

- it routes by **`type`** to select the right **prompt template** (Story 7.6's
  per-type generator — a total function over the fixed enum); and
- it routes by **`executor`** to decide **coding-agent dispatch vs human
  assignment**.

The kind-as-type + assignee-as-router shape cannot express this without
overloading two fields that already carry other meaning (kind drives parenting;
assignee names a specific person). The split is the load-bearing axis the
AI-native execution layer is built on — exactly the kind of recorded,
concrete-use-case deviation Principle #11 permits, and **not** "richer than the
standard because we can."

---

## Consequences

- **2.7.3** declares `enum WorkItemType` (the ten members, in order) + `enum
Executor` + nullable `work_item.type` / `work_item.executor`, and implements
  `defaultExecutorForType` as a total function matching the §3 table exactly,
  plus the service-layer leaf-only enforcement.
- **2.7.4** (picker UI) and **2.7.5** (seed loader) both seed `executor` by
  calling that single helper — neither re-states the map.
- **2.7.5** stops emitting the "Type:" / "Executor:" prose lines; the structured
  fields become the source of truth, and an unknown `PlanItem.type` aborts the
  seed.
- **2.7.6** registers `type` as a closed-set enum filter facet (`= X` /
  `in (…)` / `is null`); the fixed enum is what makes it a clean equality
  predicate.
- **7.6** keys its per-type prompt generator off this enum, relying on its
  fixedness for the total-function guarantee.
- **Extending the taxonomy** later = an explicit enum addition + migration +
  extending the default map (the total-function test fails until the map covers
  the new member) — never an ad-hoc string.

## References

- `scripts/plan-seed/data/story-2.7.ts` — the Story 2.7 module header (the
  locked taxonomy + the full deviation rationale this ADR records).
- `scripts/plan-seed/types.ts` — `PlanItem.type` (free `string`) /
  `PlanItem.executor` (`'coding_agent' | 'human'`): the plan-side inputs 2.7.5
  maps to the structured fields.
- Atlassian Support — _"What are work types?"_ (issue-type = the kind hierarchy)
  and _"Collaborate on work items with AI agents"_ (agent routing via the
  assignee field) — the cited mirror surfaces.
- Story 7.6 (stub) — the per-type prompt generator whose total-function
  guarantee this fixed enum exists to support.
- `notes.html` mistake #33 (verify the mirror, cite what was observed) and
  Principle #11 (deviate from the mirror only with a recorded concrete
  justification).
