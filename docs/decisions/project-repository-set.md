# The project's REPOSITORY SET — cardinality, roles, seeding, ownership, and who pins the repo

**Status:** accepted · **Date:** 2026-07-30 · **Card:** MOTIR-1776 (Story MOTIR-1775 —
establish the repository set at plan approval) · **Evidence pinned at:** `motir-core`
`origin/main` @ `c3d3ac7e`, `motir-ai` `origin/main` @ `93afca4`

The recorded architecture every other card in MOTIR-1775 builds to. It decides six
things: what fixes the **number** of repositories a project has (§0), the **role**
vocabulary and naming (§1), what **seeds** a repo the default starter does not fit (§2),
**where** the repos are created and who owns them (§3), the per-row **lifecycle** and what
partial failure means (§4), and **who pins** the repo each work item ships in (§5). §6
shows the single-repo project falling out of the same model.

## Context

A Motir project needs somewhere for its code to live, and nothing in the shipped product
ever establishes it: the start-fresh journey ends at an approved plan with no repository,
no connection and no code graph. Story MOTIR-1775 closes that gap at plan approval.

The question this ADR exists to answer first is the one the Story's v1 got wrong. It was
authored as _"one repo per project"_, and ten subtasks were built on that cardinality
before Yue rejected the premise: **a project that separates frontend and backend is two
repositories; add a shared package and it is three; a monorepo is one.** How many repos a
project has is a property of its **architecture**, so the establish step must produce a
SET whose cardinality comes from the plan.

That was the _second_ occurrence of one class — the same collapse was flagged on the
MOTIR-930 migrate-onboarding wizard design, which had reduced the flow to a single
`acme/web`, and produced the recorded rule _"a Motir project usually spans MORE THAN ONE
repository (a web app + an API + a shared package); any migrate / code-graph / audit /
code-aware-plan surface must be designed multi-repo, not 'one project = one repo'."_ An
ADR that assumes one repo would be the third.

### What is actually shipped — verified, not assumed

| Fact                                                                                                                                                                                                                                                    | Where                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| There is **no project-level architecture record** — no model, no column. Nothing anywhere says "this project is web + api".                                                                                                                             | `prisma/schema.prisma` (grep: no `architecture`, no `projectClass`, no `platform` column)              |
| The connected repo set is **workspace-scoped and has no project link**: `GithubInstallation` belongs to a workspace and owns many `GithubRepo` rows, which carry `owner` / `name` / `defaultBranch` only                                                | `prisma/schema.prisma`, `model GithubInstallation` / `model GithubRepo`                                |
| A precise repo↔project association is explicitly an **unbuilt future refinement** — a repo installed at a workspace is indexed into _every_ project of that workspace                                                                                   | `lib/services/codeGraphIndexService.ts:24-31`                                                          |
| The planning envelope's code slot is already **plural** — `context.code.repos[]`, resolved server-side from the installation mirror                                                                                                                     | `lib/ai/codeContext.ts:24-61`                                                                          |
| The per-item pin is shipped: `work_item.targetRepo` holds a bare repo NAME, validated against the workspace's connected set, resolved at dispatch as _pin → the workspace's **single** connected repo → `null`_                                         | `lib/workItems/targetRepo.ts:99-131`, `docs/decisions/target-repo-attribution.md`                      |
| A generated plan **pins nothing**. `PlanItemProposedFields` carries `title` / `kind` / `descriptionMd` / `type` / `priority` / `executor` / sizing / explanation / provenance — and **no repo field**                                                   | `lib/dto/plans.ts`, `PlanItemProposedFields`                                                           |
| Neither does the generator's output schema — its proposal node has `type` / `priority` / `executor` / `blockedByRefs` and no repo field, though its prose rules tag repos per card                                                                      | `motir-ai/src/llm/treeGeneration.ts` (proposal JSON schema; `SHARED_PLANNING_RULES`)                   |
| The product's own planner already assumes multi-repo: _"ONE SUBTASK = ONE REPO = ONE PR"_, _"in a multi-repo product almost every card's runtime path crosses a repo boundary — that is the ARCHITECTURE"_, _"whatever the project's repo boundary is"_ | `motir-ai/src/llm/treeGeneration.ts`, `SHARED_PLANNING_RULES`                                          |
| The pre-plan session — the only place a project's shape is recorded — holds `classification`, `platform`, `designStarter`, `designChoice`, and lives in **motir-ai**, read by core over `GET /v1/preplan`                                               | `lib/ai/types.ts:392-410`, `lib/services/aiPreplanService.ts:47-57`                                    |
| There is **one** default platform starter — a full-stack Next.js + Prisma + Vercel web app. The `-with-design` variant is **retired and archived**; the bare starter now imports `@motir/design-system`                                                 | `nextjs-prisma-vercel-starter/README.md`, `nextjs-prisma-vercel-starter-with-design/README.md`         |
| The identity grant is **identity only** and grants no repo access; repo access is the separate installation grant                                                                                                                                       | `prisma/schema.prisma`, `model GithubIdentity` doc-comment; `lib/services/githubIdentityService.ts:11` |

Two things follow immediately. **The inputs for a repo plan exist but are thin** — a
class, a platform, a starter flag, and a generated tree, none of which names an
architecture. And **the plan → dispatch path is broken above one repo**: with two or more
connected repos and no pin, `resolveDispatchTargetRepo` returns `null` by design, and no
agent is told where to build. That second fact is why §5 exists.

## Decision

### §0 — The cardinality comes from the plan, PROPOSED by Motir and CONFIRMED by the user

**The repo set is derived, presented as editable rows, and fixed by the user's
confirmation at the establish step. Motir proposes; the user decides.**

**0.1 · What the proposal is derived from**, in this order, each step falling through when
its signal is absent:

1. **Role signals in the generated tree.** The plan is the only artifact that describes
   what is actually being built, and the planner already reasons in repo boundaries. Under
   §5 each proposed item carries a **role**; the distinct roles present in the tree ARE the
   proposed set. This is the primary signal, and it is the one that makes a
   frontend/backend split produce two rows without anybody being asked a question.
2. **Platform**, from the pre-plan session (`platform`: `web` / `mobile` / `other`) — it
   fixes what the primary row's role is when the tree is thin or absent.
3. **The chosen starter** (`designStarter`) — it fixes what the `web` row seeds from (§2).
4. **Default: exactly one row, role `web`.** When the signals are thin — a project with no
   pre-plan session (a migrated or seeded project reads `session: null`), a tree whose
   cards carry no roles — the proposal is a single web repo, because that is what the
   default starter is.

One row the user can add to is **truthful**. A silently-guessed three-row set is not: it
would create repositories the user never asked for in an account they own.

**0.2 · Who has final say: the user, at the establish step.** Principle #3 — the plan is
editable before coding starts — applies to the repo set exactly as it does to the tree.
The set is presented with every row editable (add, remove, rename, change role, switch to
connect-existing) and nothing is created until it is confirmed.

**0.3 · No upstream ARCHITECTURE record is created. The confirmed repo set IS the
architecture decision's home.** This is settled, not left implied.

A first-class `ProjectArchitecture` record was considered and **rejected**:

- **Its entire content would be the repo set.** Every field such a record would carry is
  either already in the pre-plan session (class, platform, starter) or is precisely a
  column of the set (role, name, seed source). A record whose content is the repo set _is_
  the repo set under a second name, and two registries drift — the same argument that
  rejected a second repo registry in `docs/decisions/target-repo-attribution.md` §1.
- **A derived record would freeze a guess as if it were a decision.** `targetRepo`'s ADR
  §3 already settled this shape: _"baking today's default into every row would freeze a
  GUESS in a column whose whole purpose is to record a DECISION — and afterwards the two
  would be indistinguishable."_ An architecture record populated by the §0.1 derivation has
  exactly that defect. The repo set avoids it because the derivation is only a
  **proposal**: the user's edit and confirmation is a real decision event, with an actor
  and a timestamp, and it happens before anything is written.
- **It would have no second consumer.** Nothing in the current plan reads an architecture
  record that could not read the set. Filing a card for it would be inventing work — the
  mirror of the orphaned-deferral defect (MOTIR-1826 / MOTIR-1834), and the same reasoning
  `docs/decisions/code-access-for-planning.md` used to file no implementation cards for a
  "no" decision.

**The trigger that would justify revisiting it is named, so it is recognisable:** an
architecture fact that is **not a repo boundary** (an event-driven vs request/response
choice, a deployment topology) or one needed **before or without** repos (a project whose
rows are all skipped, yet whose plan must still be shaped by its architecture). Neither
exists today. If one arrives, the record is a new card and this section is amended — not a
hole someone quietly fills.

### §1 — Roles are a small fixed enum plus a free-form label; names are derived and editable

**1.1 · The role vocabulary is a fixed enum of six values, plus an optional free-form
label per row:**

| Role     | What it means                                                              |
| -------- | -------------------------------------------------------------------------- |
| `web`    | A browser-facing application (the default platform starter's shape)        |
| `api`    | A backend service exposing an API — a separated backend, or one of several |
| `mobile` | A native / cross-platform mobile app                                       |
| `shared` | A library or package consumed by the other repos                           |
| `infra`  | Infrastructure-as-code, deployment, CI-only content                        |
| `other`  | The honest escape hatch — a CLI, a desktop app, a docs site                |

An enum, not free text, because **the role drives real behaviour** — it selects what the
repo is seeded from (§2), and it is the join key the item pin resolves through (§5). An
open string cannot do either without a lookup table that would be the enum, less safely.
The **free-form label** carries what the enum deliberately does not: `api` + label
"billing" versus `api` + label "search".

**1.2 · A role MAY appear more than once.** Two services are two `api` rows distinguished
by their labels and names. Nothing in the model treats roles as unique, and forbidding
repetition would push a service-oriented backend into `other`, losing the seeding
behaviour the role exists to select. §5's pin therefore resolves through the row, not the
role alone, whenever a role repeats (see §5.3).

**1.3 · ORDER is meaningful, and the first row is the project's primary repo.** It is what
a single-repo project's one row is, what the UI names when it speaks of "your project's
repository", and the deterministic tie-break anywhere a set needs one. Order carries **no
dispatch meaning** — an item is never routed by position.

**1.4 · Names.** A proposed repo is named `<project-slug>` when the set has exactly one
row, and `<project-slug>-<role>` once it has two or more (`acme` → `acme-web`, `acme-api`).
No suffix noise on the common case; an unambiguous, guessable name as soon as there is
something to disambiguate. When a role repeats, the label joins the name
(`acme-api-billing`), slugified. **Every name is editable per row**, always, and an edited
name is never re-derived behind the user's back.

**1.5 · Collisions never dead-end a row.** When the target account already holds a repo of
that name, Motir offers the same name with a numeric suffix (`acme-web-2`, then `-3`),
**pre-filled and editable, before the row is created**, and the other rows are unaffected.
_Whether_ availability is learned from a pre-check or from the creation attempt's own
error is a GitHub mechanic this ADR does not assert — MOTIR-1777 (d) settles it. The
user-visible behaviour above is fixed either way.

### §2 — Seeding is per row, per role, and admits where a repo starts near-empty

There is **one** default platform starter and it is a full-stack Next.js web app. It
cannot seed an API-only or a shared-package repo, and the multi-stack scaffold registry is
Epic 9's (MOTIR-709 / 9.3.5), out of scope here. So:

| Role                                        | Seeded from                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `web`                                       | The default platform starter — `nextjs-prisma-vercel-starter` (which imports `@motir/design-system`)          |
| `api`, `mobile`, `shared`, `infra`, `other` | An **initialised** repo: a README naming the project and the row's role, a licence, a `.gitignore`, a CI stub |

**A non-web repo starts near-empty, and the flow says so rather than implying a scaffold
that does not exist.** This is acceptable, not a compromise to hide: the plan's own rules
already slice a backend into _schema/migration → repository → service → route_
(`SHARED_PLANNING_RULES`), so the first card dispatched into that repo builds its
skeleton — which is what a scaffold would have guessed at, done by an agent that has read
the plan.

**The seed source is recorded per row as a string**, not as a boolean or an enum of two.
When MOTIR-709 lands, a row's seed source becomes a starter-registry key and this table
becomes its default map — no migration, no second code path.

**One correction to record:** `aiPreplanService` writes `designStarter: 'bare'` on a
design pick versus `'with-design'` on a skip, describing two starters. There is now one —
`nextjs-prisma-vercel-starter-with-design` is retired and archived (its own README says
so), and the bare starter ships the design system. Both values therefore resolve to the
same starter for a `web` row; the flag survives as the record of the user's design _choice_,
not as a repo selector.

### §3 — Ownership is decided ONCE for the whole set

**3.1 · GitHub identity connected → the repos are created in the user's own account, as
them.** Theirs from the first commit: no transfer, no acceptance step, no lock-in.

**3.2 · When the user administers several organizations, the target account is a single
choice for the SET, defaulting to their personal account**, and it is recorded on the
project alongside the set — not per row. A personal-account default is the one that always
works: org repo-creation is frequently governed, and defaulting to an org would make the
common case fail for a policy reason the user did not choose.

**3.3 · No GitHub identity → the repos are created under Motir's org, recorded as
Motir-owned and CLAIMABLE.** The non-technical user is not a different journey — same
step, same outcome, with the claim path available whenever they want it.

**3.4 · "Claimable" is recorded as project-scoped data, not as something to be
rediscovered.** The set carries an **ownership** value (`user` / `motir`) plus the target
account login. MOTIR-711 (9.3.7)'s transfer flow finds every claimable repo of a project
with one project-scoped read, and transfers **the whole set together** — never a GitHub
account scan, never a per-repo hunt.

**3.5 · A set is never half in the user's account and half in Motir's.** A row that cannot
be created in the chosen target fails **as a row** (§4) and falls back to connect-existing
or skip; it does **not** silently retarget to Motir's org. A silent retarget would split
the ownership of one project's code across two accounts on an error path, and 9.3.7's
transfer would then be a partial answer that looks complete. If the user wants a different
target, they change it for the set and re-run the step.

### §4 — Rows are INDEPENDENT, failure is honest, and the step is resumable

**4.1 · The per-row lifecycle:**

```
proposed ──create──▶ creating ──▶ created
   │                    │
   │                    └──error──▶ failed ──retry──▶ creating
   │                                   │
   ├──connect-existing──▶ connected ◀──┘
   │                                   │
   └──skip──▶ skipped ◀────────────────┘
```

`created`, `connected` and `skipped` are settled states. **`failed` is resumable, not
terminal**: a failed row can be retried, switched to connect-existing, or skipped, at any
later visit to the step.

**4.2 · One row's failure does nothing to the others, and nothing is rolled back.** A
created repository is a real artifact in the user's own account. Deleting it to preserve
an all-or-nothing illusion would mean Motir destroying something the user can already see,
on an error path, to make a report look tidier — strictly worse than reporting the truth.
So there is no compensating delete, no transaction spanning repo creation, and no
all-or-nothing gate. Per the side-effects-outside-tx rule, repo creation is a network side
effect outside any database transaction anyway.

**4.3 · Approval MAY complete with a row unresolved — yes, deliberately.** A skipped or
failed row leaves the project **explicitly code-less for that role**, which is a state the
product already models and renders (the BYOK code-index loop, MOTIR-1754). Blocking
approval on a GitHub failure would hold the user's whole plan hostage to an org policy or
a rate limit.

**4.4 · The per-row state lives on the project, which is what makes the step
re-enterable.** Approval is not the last chance to establish a repo; the set is a durable
property of the project, editable and completable afterwards.

### §5 — The PLANNER pins, by ROLE; MATERIALIZE resolves it to a repo and validates it

This is the consequence that the one-repo premise hid. `resolveDispatchTargetRepo` falls
back to _the workspace's **single** connected repo_, and returns `null` at two or more,
deliberately refusing to guess. **The fallback that carries a one-repo project cannot carry
a two-repo one.** So a multi-repo plan must pin each item — and the Story's acceptance
criterion "an agent is told where to build" is unsatisfiable otherwise.

**5.1 · The planner pins, at generation.** It is the only participant that knows which
layer a card belongs to — it already writes a repo tag per card in prose, under a rule that
says _"name the OWNING REPO of each file the card will create or modify."_ Neither the
materializer nor the user can recover that from a title. The alternatives are worse: a
**materializer** guess is the arbitrary choice the shipped resolver already refuses to
make; asking the **user** to pin every item is a form for something the planner just
decided.

**5.2 · What is pinned is the ROLE, not the repo name — and this is the load-bearing
detail.** At generation the repositories **do not exist**: the set is derived from the tree
(§0.1) and the user may rename any row before it is created. A name pinned at generation is
stale the moment the user edits a row, and meaningless before the row is created at all. A
**role** is stable across both. So:

```
generate ──▶ each proposal carries a repo ROLE
   └──▶ the distinct roles ARE the proposed set (§0.1)
          └──▶ user edits + confirms the set, rows are established (§4)
                 └──▶ materialize resolves role ──▶ the confirmed row's repo NAME
                        └──▶ work_item.targetRepo (the shipped bare-name column)
```

This closes the ordering hazard cleanly — the tree can be generated before any repository
exists, which is the actual sequence — and it leaves the shipped `targetRepo` contract
untouched: the column still holds a bare repo NAME, still validated against the connected
set by `resolveAuthoredTargetRepo`.

**5.3 · Materialize VALIDATES, and never guesses.** Resolution has exactly three outcomes,
and only the first writes a pin:

- the role matches **exactly one** established row → `targetRepo` is that row's repo name;
- the role matches **no** established row (it was skipped, failed, or removed from the
  set) → `targetRepo` stays `null`. The item is honestly unrouted, which is the same
  signal the shipped resolver already emits, and the code-index loop already renders;
- the role matches **more than one** row (a repeated role, §1.2) → the proposal must name
  the row, not just the role; an ambiguous pin resolves to `null` rather than to an
  arbitrary row. Guessing here would send an agent into the wrong checkout, which
  `docs/decisions/target-repo-attribution.md` §3 established is strictly worse than no
  answer.

**5.4 · Once a set is established, a proposal MAY carry the resolved repo NAME directly.**
For a re-plan, an augment, or an `expand_item` on a project whose repos already exist, the
names are final and there is no ordering problem — so the pin may be the name, validated
the same way `create_work_item` / `update_work_item` already validate an authored
`targetRepo`. **Role is the portable pin; name is the settled one.** Materialize accepts
either.

**5.5 · What this asks of the two producers**, so no seam is left unowned: motir-ai's
generator emits the role (MOTIR-1885), `PlanItemProposedFields` carries it through the
proposal and materialize resolves + validates it (MOTIR-1884). Both cards are `blocked_by`
this ADR and this section is the specification they build to — including the refinement
that what a proposal pins is a **role** (or, per §5.4, a settled name), not always a repo
name.

### §6 — The single-repo project is the degenerate case, not a second code path

One architecture, one model, one decision:

- **§0** proposes **one row**, role `web` — the thin-signal default.
- **§1.4** names it `<project-slug>`, with **no role suffix**, so nothing about it reads
  like "one of several".
- **§1.3** makes it the primary row by construction.
- **§2** seeds it from the default starter — the ordinary path.
- **§5** resolves every item's role to that one row, so every item is pinned to it.
- **§4** applies unchanged: one row that can fail, be skipped, or be connected to an
  existing repo — which, chosen for a project's only row, is exactly how a **monorepo**
  collapses the set to one.

The one-question feel is a property of the **presentation** of a one-row set (MOTIR-1778 /
MOTIR-1782), never of a second branch in the model.

## Consequences

- **MOTIR-1780's table is a SET table**, per row: role, free-form label, name, seed source,
  establish state, and the project-level ownership + target account. Ordered, primary
  first. It is also the **project↔repo association** whose absence
  `codeGraphIndexService.ts:30-31` records as an unbuilt refinement — this ADR does not
  ask that card to fix the indexing fan-out, only to make the association exist.
- **MOTIR-1881 must read across the open/closed boundary.** The class / platform /
  starter signals live in **motir-ai** and reach core only via
  `aiPreplanService.getPreplanState` (`GET /v1/preplan`), which returns `session: null` for
  any project that never ran a pre-plan — a migrated project, a seeded one. The derivation
  must degrade through §0.1's ladder to the one-web-repo default rather than fail.
- **`PlanItemProposedFields` grows a repo field** (MOTIR-1884) — the first field it carries
  that materialize must resolve against _project_ state rather than map straight onto the
  created row. Adding a field to a read-back DTO breaks exact-shape route tests; expect the
  sweep.
- **motir-ai's proposal schema grows a role field** (MOTIR-1885). Its enum must stay in
  lockstep with §1.1 — the same cross-repo constant discipline `AI_DRAFT_EXPLANATION_SOURCE`
  already follows.
- **`resolveDispatchTargetRepo`'s single-connected-repo fallback stays**, as the
  compatibility path for every project that predates the set (including this one). Once a
  project has an established set, MOTIR-1783 resolves against the **project's** set instead
  of "the workspace's single repo"; the fallback is what answers for a project that has
  none.
- **Ownership is a set-level property**, so 9.3.7's transfer flow gets a project-scoped
  query and a whole-set transfer, not a per-repo hunt. §3.5 is what guarantees the set is
  transferable as a unit.
- **A `type: manual` prerequisite is confirmed, not created here:** §3.3 requires a Motir
  fallback org to exist. MOTIR-1779 already owns provisioning it, alongside whatever grant
  change MOTIR-1777 determines.
- **Nothing here re-decides the GitHub App model** (7.10, shipped) and nothing re-scopes the
  coding convention from project to repo (a 7.14 change). §1's per-row role is deliberately
  compatible with a per-repo convention landing later.

## Deferred to the spike — asserted nowhere in this document

MOTIR-1777 verifies four GitHub mechanics, and **no decision above depends on their
outcome**: (a) whether creating a repo needs a scope beyond the identity grant — which the
schema documents as granting _no_ repo access; (b) whether an all-repositories installation
covers repos created afterwards; (c) whether a repo can be added to an existing
installation by API rather than by sending the user to GitHub's settings; (d) what creating
N repos back-to-back costs, and whether a partial failure is retryable per repo. §1.5's
collision _mechanism_ and §4.1's retry _ergonomics_ are the two places this ADR
deliberately stops short and points at (d).

## References

- `lib/workItems/targetRepo.ts` · `docs/decisions/target-repo-attribution.md` — the shipped
  pin/normalize/validate/resolve policy §5 stays consistent with.
- `prisma/schema.prisma` — `GithubIdentity` (identity only, no repo access),
  `GithubInstallation` (workspace-scoped, many repos), `GithubRepo` (no project link),
  `WorkItem.targetRepo`, `PlanItem.proposedFields`.
- `lib/dto/plans.ts` — `PlanItemProposedFields`, the proposal payload §5 extends.
- `lib/ai/codeContext.ts` — the already-plural `context.code.repos[]` contract.
- `lib/services/codeGraphIndexService.ts` — the fan-out whose deferred project↔repo
  association this set supplies.
- `lib/services/aiPreplanService.ts` · `lib/ai/types.ts` — the pre-plan session
  (`classification` / `platform` / `designStarter`), §0.1's secondary signals.
- `lib/services/plansService.ts` — `approvePlan` / `materialize`, the transaction the
  establish step joins and where §5's resolution runs.
- `motir-ai/src/llm/treeGeneration.ts` — `SHARED_PLANNING_RULES`' multi-repo architecture
  rule and the proposal schema §5 extends (search with python/node — grep fails on the long
  lines).
- `nextjs-prisma-vercel-starter` — the one default platform starter; its `-with-design`
  sibling is retired and archived.
- `docs/decisions/code-access-for-planning.md` — the sibling ADR whose "a NO decision files
  no cards" reasoning §0.3 follows.
- `motir-meta/notes.html` — the collapse-to-one-repo lesson (MOTIR-1775) and #103
  (cardinality is a cross-story contract) this ADR is the correction to; planning bug
  MOTIR-1887.
