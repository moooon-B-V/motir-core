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

---

## Amendment 1 (2026-08-10) — the enum grows to FOURTEEN: `copy`, `translate`, `legal`, `verification` are admitted; `doc` and `spike` are aliases and are NOT

> **Written by Story MOTIR-2622 · Subtask MOTIR-2629.** This is the "explicit
> enum addition" §1 reserved as the ONLY legal way to grow the set. It decides
> the members, their executor defaults, and their place in the canonical order.
> It ships no code — MOTIR-2632 implements the schema/contract half and
> MOTIR-2633 the presentation half, both against this section.
>
> **Numbered 1** — the first amendment to this record. Verified before
> numbering: every one of the 239 remote branches that carries
> `docs/decisions/work-item-type-taxonomy.md` holds the identical blob
> `7c1adf3`, so no sibling branch is racing an Amendment 1 to this ADR.

**Amends §1** (the member list and its canonical order) and **§3** (the
type→executor default map). It re-opens nothing else: §2's leaf-only rule, §4's
Jira-mirror deviation, and the closedness of the enum all stand exactly as
written. In particular the extension procedure is **reaffirmed, not relaxed** —
see "The enum stays closed" below.

### The problem this fixes

`motir-meta`'s `prompts/plan-rules.md` carries the **per-type authoring bar** —
the standing instruction that tells a planner to _"sweep the COMPLETE set"_ of
work types and what each type's card must specify. That bar and this enum have
drifted apart in both directions:

|                                            |                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| **Taught by the bar AND settable here**    | `code` · `design` · `test` · `content` · `research` · `review` · `decision` · `deploy` · `manual` |
| **Taught by the bar, NOT settable here**   | `doc` · `spike` · `copy` · `translate` · `legal` · `verification`                                 |
| **Settable here, never taught by the bar** | `chore`                                                                                           |

A planner told to sweep the complete set can correctly conclude a story needs a
`translate` card and then have nowhere to file it. The card becomes `content` or
`chore`, and the authoring bar written for translation work never applies to it,
because the card is not that type. Nothing fails visibly; the guidance simply
stops reaching the work.

### The `doc` / `content` and `spike` / `research` questions — answered

Both were flagged as possible duplicates rather than gaps, and **both collapse.**
The evidence is the shape of `plan-rules.md`'s own per-type bar, which gives each
distinct type its own bullet stating what that type's card must specify:

```
- **`doc` / `content`**    — the document / content to produce, its audience, and where it lives.
- **`research` / `spike`** — the question to answer, the written deliverable, and the timebox.
- **`copy`**               — the strings to write, the voice / tone, and the i18n keys.
- **`translate`**          — the locale, the source strings, and the style guide.
- **`legal`**              — the legal artifact (ToS / privacy / license), the requirement it
                             satisfies, and who signs off.
- **`verification`**       — what is verified, and the recipe to verify it.
```

`doc` and `spike` are the only two names in the taught set that **share a bullet
with an existing member**. They have no authoring bar of their own, because they
are not a different kind of work — they are a second name for one. `copy`,
`translate`, `legal` and `verification` each carry their own bar, specifying
their own deliverable: that is what a distinct member looks like.

The enum's own §1 glosses agree, and settle the two cases differently:

- **`spike` ≡ `research` — a SYNONYM.** §1's gloss for `research` reads
  _"Spike / investigation — time-boxed exploration that produces findings, not
  ship-code."_ The word `spike` appears in the definition of the member itself.
  There is nothing to add. **`spike` is declared an alias of `research` and is
  NOT admitted.**
- **`doc` ⊂ `content` — a BUNDLE, and the bundle is being unpacked.** §1's gloss
  for `content` reads _"Copy, docs, and translation — user-facing strings,
  READMEs, i18n locales."_ That is three things under one name, and two of them
  (`copy`, `translate`) ARE being admitted as members with their own bars. So the
  question is not "is `doc` a duplicate of `content`" but "what does `content`
  mean once `copy` and `translate` are lifted out of it." The answer that keeps
  the set unambiguous is that **`content` retains the documentary half and
  `doc` is its alias** — `content` is the member, `doc` is the word the playbook
  uses for it. Admitting both would create two picker entries a person choosing
  between them could only guess at, which is worse than the gap it closes.

Consequently `content`'s gloss is **narrowed** (below) to say what it now means,
and a **precedence rule** is recorded so the general member never competes with
the specific ones.

**The final admitted count is FOUR, and the enum lands at FOURTEEN, not sixteen.**
The story that raised this (MOTIR-2622) was authored expecting six additions and
sixteen members; the two collapses above are exactly the outcome its own
acceptance criterion anticipated, and the story's criteria are amended to fourteen
on the record.

### 1a. The four admitted members

Each gets the same treatment §1 gives the original ten: a one-line authoritative
gloss, plus the boundary against its nearest neighbour — the sentence that tells
a planner which of the two to pick.

| Member         | Authoritative gloss                                                                                                                            | Nearest neighbour, and the boundary                                                                                                                                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `copy`         | Product-facing WORDS — UI strings, labels, empty states, error messages, marketing body copy, and their i18n keys.                             | vs `content`: `copy` is the words rendered **inside the product**, reviewed against the design and tone. `content` is documentation **about** the system. If it lands in `messages/*.json` or a component string, it is `copy`.                                                                                                                         |
| `translate`    | A LOCALE twin of existing copy — moving already-authored strings into another language against a style guide.                                  | vs `copy`: `translate` authors **no new meaning**; the source strings already exist. New `en` wording is `copy`; its `zh` twin is `translate`.                                                                                                                                                                                                          |
| `legal`        | A legal artifact — terms of service, privacy policy, licence, DPA — and the requirement it satisfies.                                          | vs `content`/`decision`: a `legal` card produces a document that **binds the company** and needs a human signatory. A decision **about** legal posture with no artifact is `decision`.                                                                                                                                                                  |
| `verification` | Establishing that a stated FACT is true, and producing the evidence — a precondition, a published artifact, a config value, a claim on a card. | vs `review`: `review` judges a finished **deliverable** against its acceptance criteria and ends in a person's sign-off. `verification` checks a **claim** and ends in evidence (a pull, a grep, a command's output). vs `test`: a `test` card ships automated tests that run in CI; a `verification` card runs a check once and records what it found. |

**`content` is narrowed, and the specific beats the general.** With `copy` and
`translate` lifted out, §1's `content` gloss is amended to:

> `content` — Documentation and authored long-form material: `README`s, guides,
> runbooks, API documentation, help articles, seeded example/demo content.
> (`doc` is an alias of this member, not a member of its own.)

and the precedence rule that removes the remaining ambiguity:

> **When a card fits `copy`, `translate` or `legal`, one of those wins over
> `content`.** `content` is the residual member — it names authored material that
> is not product strings, not a locale twin, and not a binding legal artifact.

This narrowing is a **definition change, not a data change**. Per MOTIR-2622's
scope boundary there is **no backfill**: existing `content` rows keep their type,
and some of them describe work that would be filed as `copy` today. That is
accepted and recorded here so a later reader does not mistake the mixed history
for a broken rule.

### 1b. The canonical order of the fourteen

§1's order is load-bearing — it is what pickers, legends, filter menus and the
7.6 prompt generator iterate. The four newcomers are **inserted beside their
nearest neighbours**, and the original ten keep their existing relative order
exactly, so no downstream list is reshuffled by this amendment:

| #   | Member             | Group            |
| --- | ------------------ | ---------------- |
| 1   | `code`             | Build            |
| 2   | `design`           | Build            |
| 3   | `test`             | Build            |
| 4   | `content`          | Author           |
| 5   | **`copy`**         | Author           |
| 6   | **`translate`**    | Author           |
| 7   | `research`         | Investigate      |
| 8   | `review`           | Investigate      |
| 9   | **`verification`** | Investigate      |
| 10  | `decision`         | Govern & operate |
| 11  | `deploy`           | Govern & operate |
| 12  | `manual`           | Govern & operate |
| 13  | **`legal`**        | Govern & operate |
| 14  | `chore`            | Govern & operate |

As one list, for downstream code to be read against verbatim:

```
code · design · test · content · copy · translate · research · review ·
verification · decision · deploy · manual · legal · chore
```

**The four GROUPS are a consequence of the order, not a second ordering.** Each
group is a contiguous run, so a picker may render section headings without
reordering anything, and a picker that ignores them still shows the canonical
sequence. Whether the grouping is _drawn_ is MOTIR-2631's decision, taken by
measuring the menu — it is offered here, not mandated.

### 3a. The type→executor defaults for the four

Extending §3's map. The three groups §3 defines are unchanged; each newcomer
joins one of them.

| `type`         | Default `executor` | Group                 | Routing rationale                                                                                                                                       |
| -------------- | ------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `copy`         | `coding_agent`     | either, default agent | Drafting product strings against a design and a tone is agent work; a human rewrite is a reassignment, not the norm.                                    |
| `translate`    | `coding_agent`     | either, default agent | The source strings already exist and the register is written down; this project's `zh` catalogue is produced this way today.                            |
| `verification` | `coding_agent`     | either, default agent | Verification is executing a recipe and recording evidence — pulling an artifact, grepping shipped code, reading a platform API.                         |
| **`legal`**    | **`human`**        | **always-human**      | A binding artifact needs a signatory. An agent may draft, but the default must not route a card that ends in a signature to something that cannot sign. |

`legal` is the one where the default carries real cost, and it is deliberately
the conservative choice: a wrong `human` default costs one reassignment, while a
wrong `coding_agent` default surfaces as a stalled card mid-run, which is the
failure mode §3's map exists to prevent.

`defaultExecutorForType` therefore stays **total** over fourteen, and the
`Record<WorkItemTypeDto, ExecutorDto>` typing keeps a fifteenth member a compile
error until its default lands — the guarantee §3 was built for, unchanged.

### `chore` has no authoring bar — recorded, and owned

The drift runs both ways. `chore` has been settable since 2.7.3 and
`plan-rules.md` has **never** taught it: it appears in no bullet of the per-type
bar. It is also the type this project reaches for most often on its own
planning-bug cards, so the most-used type is the one with no guidance attached.

**MOTIR-2630 owns writing that bar**, and this amendment hands it three items
rather than one:

1. Write the missing **`chore`** authoring bar.
2. Re-express **`doc`** in the bar as an alias of `content`, not a separate
   sweep entry — the collapse decided above.
3. Re-express **`spike`** in the bar as an alias of `research`, likewise.

Items 2 and 3 are this amendment's consequence for that card: the bar currently
lists both names as sweep entries, which is what made them look like gaps.

### The enum stays closed

Reaffirmed without change. `type` remains a **fixed enum**, not free text, for
the reason §1 gave: 7.6's per-type prompt generator must be a total function and
the filter facet must be a closed set. **The extension procedure is unchanged and
is exactly the one this amendment followed** — an explicit amendment to this ADR,
then an enum addition plus migration, then the consumer sweep below. Never an
ad-hoc string.

One consequence worth naming, because it is the same defect one repo over:
`motir-ai`'s `propose_node` declares `type` as a free `string` with no
enumeration, so the hosted generator can propose a type no work item can carry.
That is out of MOTIR-2622's scope (a different repository) and belongs to the
`motir-ai` story; it is recorded here so the closedness of this enum is not
mistaken for closedness at every producer.

### Consequences — the full consumer sweep

Adding a member touches more than the schema. Enumerated here so the
implementation cards read one list instead of re-deriving it, in the repo's
layering order:

| Layer                       | What moves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Card       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Schema                      | `prisma/schema.prisma`'s `WorkItemType` enum + an **additive** migration. No column change, no backfill.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | MOTIR-2632 |
| Domain                      | `lib/issues/executorDefaults.ts` — `WORK_ITEM_TYPES` in the §1b order, and `DEFAULT_EXECUTOR_BY_TYPE` extended per §3a so the helper stays total.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | MOTIR-2632 |
| DTO                         | `WorkItemTypeDto` in `lib/dto/workItems.ts`, and the `lib/dto/{ai,ready,quickView}.ts` re-exports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | MOTIR-2632 |
| Filter grammar              | `lib/filters/registry.ts`'s `type` facet, whose `valueWhitelist` reads `WORK_ITEM_TYPES` — it should follow with no edit; that must be **verified**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | MOTIR-2632 |
| Published contracts         | `lib/mcp/tools/{createWorkItem,updateWorkItem}.ts`, `lib/api/v1/{workItems,ready}/schema.ts`, and the CLI's generated `packages/cli/src/api/schema.d.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | MOTIR-2632 |
| Seed                        | `scripts/plan-seed/mapItem.ts`, which validates a plan leaf's type against the enum and fails loudly on an unknown string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | MOTIR-2632 |
| Presentation metadata       | `lib/issues/workItemTypeMeta.ts` — a lucide glyph + an `--el-type-*` hue per member. It is a total `Record`, so **the build fails until it covers the new members**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | MOTIR-2633 |
| Tokens                      | `packages/design-system/theme.css` — the Tier-3 `--el-type-*` tokens (the design system was extracted; **not** `app/globals.css`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | MOTIR-2633 |
| i18n                        | `messages/en.json` **and** `messages/zh.json` — a label per member, each with its `zh` twin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | MOTIR-2633 |
| Surfaces                    | `components/issues/WorkItemType{Picker,Chip,Icon}.tsx` and every surface that renders the set (list column, board card, roadmap node, quick view, filter bar).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | MOTIR-2633 |
| Design                      | The picker/chip/legend redrawn for fourteen, measured across `design/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | MOTIR-2631 |
| The playbook                | `chore`'s bar; `doc` and `spike` re-expressed as aliases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | MOTIR-2630 |
| Hosted planner (`motir-ai`) | `motir-ai` `src/llm/planningRulePacks.ts`'s `PLAN_ALL_SUBTASK_TYPES_AND_COMPOSITION` — a segment of `SHARED_PLANNING_RULES`, the corpus handed verbatim to the hosted planner. The set is **prose in a template literal, in a second repository**, so **no compile-time guard reaches it** (the compiler sees a string; `workItemTypeMeta.ts`'s total `Record` above fails a build in THIS repo only). It drifted for eight days after this amendment landed. That repo holds a **second, typed** copy that DID track it — `src/llm/workItemTypes.ts`'s `WORK_ITEM_TYPES` — so `motir-ai` carries **two** copies of §1b's list and only one is compiler-checked. | MOTIR-2972 |

The compile-time guard in the presentation map means MOTIR-2632 cannot land
without touching MOTIR-2633's file. That is the guard working as designed; the
resolution is the minimum needed to build, labelled as placeholder in that PR.

### References added by this amendment

- `motir-meta` `prompts/plan-rules.md` — the per-type authoring bar quoted
  above; the source of the taught set and the evidence for both collapses.
- MOTIR-2622 (the story), MOTIR-2629 (this amendment), MOTIR-2631 (design),
  MOTIR-2632 (enum + contracts), MOTIR-2633 (presentation), MOTIR-2630 (the
  playbook's missing bars).
