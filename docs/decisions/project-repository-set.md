# The project's REPOSITORY SET — cardinality, roles, seeding, ownership, and who pins the repo

**Status:** accepted · **Date:** 2026-07-30 · **Card:** MOTIR-1776 (Story MOTIR-1775 —
establish the repository set at plan approval) · **Evidence pinned at:** `motir-core`
`origin/main` @ `c3d3ac7e`, `motir-ai` `origin/main` @ `93afca4`

**Amended:** 2026-07-30 (Yue · MOTIR-1893) — **§3 ownership**: a new project's repositories
are **always** created under Motir's org, for every user. The original what-the-user-HAS
branch (§3.1–§3.2, and §3.3's framing as a no-identity fallback) is **superseded**; it is
kept below, marked, with the reversal recorded in
[the amendment](#amendment-2026-07-30-yue--motir-1893--a-new-projects-repos-are-always-motir-owned).
Nothing in §0–§2 or §4–§6 changes.

**Amended:** 2026-07-31 (Yue · MOTIR-1930) — **§3's tenancy consequence**: because every
project's repos now sit behind ONE shared installation, the mirror's `installation → workspace`
binding no longer identifies a tenant. `github_repo` gains its own `workspace_id`,
`github_installation.workspace_id` becomes nullable, every delivery resolves its workspace
through the REPO row, and the shared installation never reconciles. Recorded in
[the tenancy amendment](#amendment-2026-07-31-yue--motir-1930--the-provisioning-orgs-mirror-is-per-workspace-and-tenancy-moves-onto-the-repo-row).
It **overturns nothing** — §3 and its 2026-07-30 amendment stand unchanged; this closes what
they cost. Nothing in §0–§2 or §4–§6 changes.

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

> **⚠️ Read the amendment below first.** §3.1, §3.2 and §3.3's fallback framing are
> **SUPERSEDED** by the 2026-07-30 amendment at the end of this section; §3.4 and §3.5
> survive with the readings the amendment fixes. The superseded text is kept verbatim
> because an ADR records how the thinking changed, not only where it landed.

**3.1 · ~~GitHub identity connected → the repos are created in the user's own account, as
them.~~** _(Superseded 2026-07-30.)_ Theirs from the first commit: no transfer, no
acceptance step, no lock-in.

**3.2 · ~~When the user administers several organizations, the target account is a single
choice for the SET, defaulting to their personal account~~**, _(Superseded 2026-07-30 —
there is no account choice for a created row; the target is always Motir's org.)_ and it
is recorded on the project alongside the set — not per row. A personal-account default is
the one that always works: org repo-creation is frequently governed, and defaulting to an
org would make the common case fail for a policy reason the user did not choose.

**3.3 · No GitHub identity → the repos are created under Motir's org, recorded as
Motir-owned and CLAIMABLE.** The non-technical user is not a different journey — same
step, same outcome, with the claim path available whenever they want it. _(Amended
2026-07-30: the OUTCOME stands and is now universal — every created repo is Motir-owned
and claimable. Only the trigger is superseded: this is no longer the no-identity branch of
a fork, it is **the** create path, for every user.)_

**3.4 · "Claimable" is recorded as project-scoped data, not as something to be
rediscovered.** The set carries an **ownership** value (`user` / `motir`) plus the target
account login. MOTIR-711 (9.3.7)'s transfer flow finds every claimable repo of a project
with one project-scoped read, and transfers **the whole set together** — never a GitHub
account scan, never a per-repo hunt. _(Unchanged, with the amendment's reading: a
**created** row is always `motir`; `user` now arises only from a **connect-existing** row,
or from a set that 9.3.7 has already transferred.)_

**3.5 · A set is never half in the user's account and half in Motir's.** A row that cannot
be created in the chosen target fails **as a row** (§4) and falls back to connect-existing
or skip; it does **not** silently retarget to Motir's org. A silent retarget would split
the ownership of one project's code across two accounts on an error path, and 9.3.7's
transfer would then be a partial answer that looks complete. If the user wants a different
target, they change it for the set and re-run the step. _(Amended 2026-07-30: the
invariant holds and gets easier to keep — every created row targets the same Motir org, so
the only way a set mixes ownership is the user deliberately connecting one of their own
repos as a row. The failure rule is unchanged: a row that cannot be created fails as a row
and is retried, connected, or skipped.)_

#### Amendment 2026-07-30 (Yue · MOTIR-1893) — a new project's repos are ALWAYS Motir-owned

**The decision.** **Every repository Motir CREATES for a new project is created under
Motir's own organization, for both audiences, with no branch on what the user has.** The
Motir org is no longer a fallback; it is the default and only home for a newly created
repo. What follows creation is the explicit take-it-over path (MOTIR-711 / 9.3.7), which
this decision promotes from an edge-case escape hatch to the standard way a project's code
ends up in the user's own account.

**Connect-existing is untouched.** It remains the only path that reaches a repository the
user owns, and it keeps the shipped installation hand-off (`githubInstallationManageUrl()`
— repo selection is changed on GitHub's install screen, never faked in-app). A user who
already has code still connects it, exactly as before.

**Why — three reasons, recorded with their evidence:**

**1 · Two audiences, one path.** The non-technical user never touches GitHub: they
validate the work on the site Motir built, while the code and the PM record sit ready to
be taken over if the team grows. The technical user runs agents locally and may use the
hosted agent. A branch keyed on _"do you have GitHub?"_ made the first case an edge case
of the second — a second flow to design, build, test, and support, differing on the one
axis the user cares least about. Removing the branch makes the establish step identical
for everyone, which is what MOTIR-1778's design already draws ("Motir hosts your code" as
the default, "Use your own GitHub instead" as the quiet secondary that leads to
connect-existing).

**2 · It avoids a permission escalation that would have cost the install funnel.**
Creating a repository in a user's account requires the App permission Repository
**`Administration: write`** (the spike's Mechanic 1 table). Three documented facts make
that expensive, and they compound:

- **Permissions are fixed at the App REGISTRATION, not per user.**
  [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app),
  verbatim: _"When you register a GitHub App, you can select permissions for the app."_ So
  the permission set is a property of the App every installer sees — there is no
  per-install, per-user, or per-flow subset. (GitHub has no optional-permission mechanism;
  the community's own summary of the gap, in the unanswered discussion
  [#51105](https://github.com/orgs/community/discussions/51105) _"Any way to define
  optional GitHub app permissions?"_, is _"scope permissions are given in their entirety or
  the login flow fails."_ **Stated as what it is: a user's conclusion in an unanswered
  community thread, not GitHub documentation** — the documented facts are the two quoted
  here and the re-consent quotes below.)
- **An App that asks for it can no longer be installed by a repository admin.**
  [Installing a GitHub App from a third party](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party),
  verbatim: _"Repository admins can install GitHub Apps in the organization that owns the
  repository if the app does not request any organization permissions nor the 'repository
  administration' permission."_ Requesting it therefore narrows installation to
  **organization owners** — a hard funnel loss for every team whose evaluator is a repo
  admin rather than an owner.
- **Adding it to the SHIPPED App is a two-sided re-consent, not a config change.** From
  [Editing a GitHub App's permissions](https://docs.github.com/en/apps/maintaining-github-apps/editing-a-github-apps-permissions),
  quoted in the spike: _"Each account where the app is installed will need to approve the
  new permissions."_ · _"…each user that has authorized the app will need to approve the
  permission changes."_ · _"Updated permissions won't take effect on an installation or
  user authorization until the new permissions are approved."_ Every existing installation
  and every already-connected user would have had to re-approve before creation worked for
  them.

The cost was therefore paid by **every** user of the product — including everyone who
never creates a repo — to serve a path the third reason shows was never universal anyway.

**3 · It was never universally possible.** The spike (MOTIR-1777,
`docs/github-repo-creation-mechanics.md` Mechanic 1) verified that `POST /user/repos` is
**user-access-token-only**: it is not available to installation access tokens. There is no
server-side, user-absent path to a personal-account repository at all — so the
what-the-user-HAS branch could only ever have worked while the user was present and
authorized, and never for the hosted agent acting later on their behalf. Creating in
**Motir's org** uses `POST /orgs/{org}/repos`, which the same table records as available
to an installation token.

**The credential split this makes explicit — three credentials, one consent.** They stay
separate on purpose:

| Credential                                                                   | What it is for                                                                                                | Permissions                                                               | Does a user consent to it?                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **The provisioning credential** — scoped to **Motir's own org** (MOTIR-1779) | Creating and seeding every new project's repositories (`POST /orgs/{org}/repos`, template `generate`)         | `Administration: write` **on Motir's org only**                           | **No.** It is Motir's credential on Motir's org; it never appears in any user's install or authorize flow |
| **The user-facing Motir App** (MOTIR-890, shipped)                           | Everything the product already does with a user's repos — installation, indexing, dispatch, the webhooks      | **Unchanged.** MOTIR-890's least privilege; `Administration` is NOT added | Yes — the same grant they already give today, not widened by this decision                                |
| **The opt-in writer App** (MOTIR-1894 / MOTIR-1895, Epic 9)                  | Letting the **hosted agent push** to a repository the USER owns (after a 9.3.7 transfer, or a connected repo) | `Contents: write`, and only for users who opt in                          | **Yes — and it is the only NEW consent this decision ever asks for**                                      |

**A repo Motir owns is still the user's to reach.** Motir-owned is a hosting arrangement,
not a wall: the user gets access to their own code on the repository itself (MOTIR-1900
invites them as a collaborator on every repo Motir creates), independently of whether they
ever take ownership via 9.3.7. Ownership and access are separate questions, and this
decision only moves the first.

`Contents: write` is neither an organization permission nor the repository-administration
permission, so per the third-party-install quote above it does **not** trigger the
org-owner-only install restriction. That is precisely why the escalation is cheap where
`Administration` was not — and why the write capability is a separate, opt-in App rather
than a widening of the App everyone installs.

**One-way door — the two Apps stay separate.** Folding the opt-in writer's `Contents:
write` into the default App later cannot be undone without registering a **new** App
(permissions come off a registration only by re-consent of every installation, and the
narrowed-funnel effects of a wider default App are not recoverable retroactively). Keeping
them separate is the reversible choice, so it is the one taken.

**The Motir org is now load-bearing at scale, not a fallback — and that has two standing
consequences.** Every new project's repositories live there, so **(a)** their Actions
minutes and storage bill to Motir (metering and the plan gates are Epic 9's problem, not
this ADR's), and **(b)** Motir holds users' code by default, which is a trust and
Terms-of-Service surface the product copy must state plainly rather than let the user
discover. MOTIR-1778's design already carries the promise this obliges — _"It's yours —
move it to your own GitHub whenever you want."_

**What this asks of the not-yet-built cards** (recorded here so the sweep is visible, not
to re-scope them): MOTIR-1779 provisions the org and the provisioning credential and is now
on the critical path for **every** project rather than only the no-identity ones;
MOTIR-1781 creates against Motir's org via the installation token and does not implement a
user-account create path; MOTIR-1782 renders one default path plus the connect-existing
secondary, with no account picker for created rows; MOTIR-1900 grants the user collaborator
access to each created repo; MOTIR-711 (9.3.7) becomes the standard hand-off, not an edge
case. The planning defect this amendment corrects is logged as MOTIR-1897.

#### Amendment 2026-07-31 (Yue · MOTIR-1930) — the provisioning org's mirror is PER-WORKSPACE, and tenancy moves onto the repo row

**Why this exists.** The amendment above put **every** project's repositories in **one**
Motir org, behind **one** GitHub App installation. Nothing then re-examined the mirror that
assumption broke: `GithubInstallation` binds an installation to exactly ONE workspace, and
every tenancy read in the product resolves _installation → workspace_. This amendment
closes that consequence. It changes no decision in §3 — it records what §3 costs and what
the shape must therefore be. Surfaced by `motir run MOTIR-1781` (2026-07-31) under the
run-time claim gate: the creation primitive could not satisfy its own acceptance criterion
("associated with the project, and in the installation") because the shipped mirror cannot
represent one installation seen by more than one workspace.

**The decision, in three rulings:**

1. **Tenancy is a property of the REPOSITORY, not of the installation.** `github_repo`
   gains its own `workspace_id` and its own RLS predicate; `github_installation.workspace_id`
   becomes **nullable**, and `NULL` means _"Motir's shared provisioning installation, owned
   by no tenant"_. `installation_id` stays `@unique` — one installation is still one row.
2. **Every inbound delivery resolves its workspace through the REPO row.** The installation
   still selects which mirror rows a delivery may touch; the repo row says whose they are.
   `installation.workspaceId` is never again read to route, attribute, or authenticate.
3. **The shared installation never goes through `persistInstallation`.** `deleteExcept` is
   unreachable on the Motir-hosted path, by construction rather than by care.

##### The contradiction — verified at `motir-core` `origin/main` @ `a87d53f4`, not assumed

Six facts, each re-verifiable at the citation. They compound in order.

1. **One org, one installation, every tenant.** `.env.example:177-188` — `GITHUB_FALLBACK_ORG`
   is a single org login, and the "Motir Studio" App (`GITHUB_STUDIO_APP_ID` /
   `GITHUB_STUDIO_APP_PRIVATE_KEY`) is _"private (installable solely on the account that owns
   it)"_. Every workspace's created repos therefore sit behind **one** installation id.
2. **The mirror binds that installation to exactly ONE workspace.** `prisma/schema.prisma`,
   `model GithubInstallation`: `installationId String @unique`, with a single non-null
   `workspaceId`.
3. **And re-binds it on the next write.** `lib/repositories/githubInstallationRepository.ts:65-75`
   — `upsert({ where: { installationId }, update: rest })`, where `rest` **includes
   `workspaceId`**. The second workspace to establish a set silently moves Motir's
   provisioning installation to itself.
4. **Taking the first workspace's repos with it.** `githubInstallationService.persistInstallation`
   then calls `githubRepoRepository.deleteExcept` (`lib/repositories/githubRepoRepository.ts:164-173`)
   — every `GithubRepo` of that installation not in _this_ run's list is **deleted**.
   Workspace A's mirrored repos are pruned by workspace B's establish.
5. **A repo mirrored under another tenant's installation is INVISIBLE, so the row never reads
   as established.** `prisma/migrations/20260703120000_add_github_installation_repo_pr/migration.sql:120-140`
   — `github_repo`'s RLS policy joins through `github_installation.workspace_id`.
   `projectRepoRepository.listByProject`'s LEFT JOIN therefore returns the realized half as
   NULL (its own comment says so, `lib/repositories/projectRepoRepository.ts:41-43`), so
   `ProjectRepoDto.established` is `false` (`lib/mappers/projectRepoMappers.ts:53`) and
   `toProjectRepoNames` (`lib/projectRepos/names.ts`) drops the row — the repo is never
   dispatchable. That defeats the Story's own criterion, "an agent is told where to build".
6. **Every downstream consumer resolves installation → ONE workspace.**
   `githubWebhookService.ts:168 / 330 / 357 / 408` (push→index, CI status, reconcile, PR
   status sync), `ciMinutesMeterService.ts:146` (**which workspace gets billed**),
   `codeGraphIndexService.ts:72`. Unchanged, every created repo's PR, CI and index events
   route to whichever single workspace currently holds the row.

**Two further consequences the surfacing card did not name, found while verifying it.** Both
are load-bearing, and the second is the sharpest argument for the shape chosen below.

7. **A created repo is undispatchable for a SECOND, independent reason.**
   `githubRepoRepository.listByWorkspace` (`:41`) reads
   `where: { installation: { is: { workspaceId } } }` — the workspace's connected repo set,
   which is the validation domain and default source for `work_item.targetRepo`
   (`lib/workItems/targetRepo.ts:79`, MOTIR-1804). A repo created for workspace A joins
   through an installation bound to B, so it is absent from A's connected set even before
   fact 5's `established` path is reached. `findConnectedByWorkspaceAndName` (`:100`, the
   code-scanning proxy, MOTIR-1605) has the same join and the same hole.
8. **The keyless-OIDC trust seam authenticates a CI job into the WRONG TENANT.**
   `lib/github/oidcAuth.ts:102` — after `jwtVerify` validates the token, the tenant is
   `match.installation.workspaceId`. The repo is resolved globally by `(owner, name)`
   (`githubRepoRepository.findConnectedByName`, `:125`), and the guard against picking a
   tenant arbitrarily is _"reject when the coordinate matches more than one row"_. In one
   shared org a coordinate is globally unique, so **that guard can never fire for a hosted
   repo** — the read succeeds, returns one row, and reads the tenant off the shared
   installation. A verified OIDC token from workspace A's repo would authenticate as
   workspace B, acting as B's owner. This is the one consequence that is a cross-tenant
   **authentication** defect rather than a routing or visibility one.

**None of this is reachable today** only because nothing has ever created a repo in the
provisioning org. That is the whole window this amendment lands in.

##### 1 · The shape — `github_repo` carries its own `workspace_id` (option b)

**Decided: (b).** `github_repo` becomes workspace-scoped in its own right — a `workspace_id`
column with a direct RLS predicate — and the provisioning installation is held **once**,
with `github_installation.workspace_id` **nullable**.

**Why, in four points:**

- **Tenancy genuinely IS a property of the repo here.** Workspace A's repo and workspace B's
  repo differ by repository, not by installation — they share the installation by
  construction. A column on the row that actually varies is the honest model; a discriminator
  on the row that does not vary is not.
- **The schema already has this exact precedent, one table over.** `project_repository`
  carries its own `workspace_id` and gates on it directly — its migration comment says so
  in terms: _"the gate is the row's OWN `workspace_id`, not a join through"_
  (`prisma/migrations/20260730115208_add_project_repository_set/migration.sql:107-119`).
  Making `github_repo` match it removes an inconsistency rather than adding one.
- **Nullable `workspace_id` on the installation converts a silent mis-route into a compile
  error.** This is the decisive practical argument. Every one of the ten call sites in §2
  reads `installation.workspaceId` as a `string`; making it `string | null` makes TypeScript
  name each one. The sweep below is a checklist for the reviewer, but the compiler is what
  guarantees it is complete — no site can be missed by oversight.
- **`installation_id` stays `@unique`, so "an installation" keeps meaning an installation.**
  The token mint (`lib/github/appAuth.ts:104`, keyed on the host installation id), the GitLab
  `FOR UPDATE` refresh lock (`githubInstallationRepository.lockByInstallationId`) and the
  uninstall delete (`deleteByInstallationId`) all continue to address exactly one row.

**Rejected — (a) N `GithubInstallation` rows, one per workspace** (relax to
`@@unique([installationId, workspaceId])`). The cheapest diff, and it fixes visibility for
free: each workspace's repos hang off its own installation row, so the existing
`github_repo` / `github_pull_request` RLS joins keep working with **no policy rewrite**, and
`deleteExcept(installation.id, …)` scopes itself. **Its cost is that it buys none of the
sweep and damages the invariant.** `findByInstallationId` is a `findUnique` today; under (a)
it returns an arbitrary one of N, so all ten sites must change **anyway** — but silently,
with no type change to force them. Meanwhile `lockByInstallationId` would lock N rows (the
GitLab token-rotation guard degrades from a lock to a race), `deleteByInstallationId` would
delete every tenant's row on one uninstall, and the column comment _"UNIQUE (one row per
connection)"_ becomes false — the invariant survives only by convention on the paths where N
happens to be 1. Paying a real correctness cost for a sweep it does not shorten is the wrong
trade. (a) also does **not** settle question 3: `fetchInstallationRepos` returns the whole
shared org, so a per-workspace reconcile would still upsert every tenant's repos into one
row — a leak in place of a delete.

**Rejected — (c) Motir-hosted rows bypass the mirror** (`ProjectRepo` carries its own
realized `owner` / `name` / `defaultBranch` / host repo id). Conceptually the cleanest, and
the only shape that widens no tenancy-bearing index. **It breaks the PR→work-item loop.**
`GithubPullRequest.repoId` is a required FK to `GithubRepo.id` with `@@unique([repoId, number])`
(`prisma/schema.prisma`, `model GithubPullRequest`), and `GithubCheckRun` hangs off that. A
hosted repo would have no `GithubRepo` row, so the status sync — the mechanism that flips a
card to Done on merge, for **every** new project — would have nowhere to write, and would
need either a parallel PR table or a polymorphic FK. It also dissolves
`ProjectRepo.githubRepoId @unique` (the "at most one project claims a repo" guarantee that
`attachRealizedRepo` enforces, `lib/services/projectRepoSetService.ts:623`), the
`established` rule (`row.githubRepo !== null`), and `repoCloneUrl`'s coordinate source — then
adds a permanent second resolution path in the webhook, meter, code-graph and dispatch. The
largest consequence of the three, as the surfacing card anticipated, and larger than it
looked: the cost is not "a second routing path", it is the PR loop.

##### 2 · The resolution rule — the installation SELECTS, the repo row ATTRIBUTES

**The rule.** An inbound delivery carries `installation.id` (shared) and `repository.id`
(per-repo). Resolution keeps both hops and changes only which one answers _whose_:

```
installation_id (delivery)  → GithubInstallation   — WHICH mirror rows this delivery may touch
  + repository.id           → GithubRepo           — via @@unique([installationId, repoId])
                            → repo.workspace_id    — WHOSE it is        ← the only tenancy read
```

Keying on `(installationId, repoId)` — not on `repoId` alone — is deliberate. `repo_id` is
**not** globally unique: two tenants may legitimately connect the same public repository
under their own installations, and `findConnectedByName`'s existing ambiguity guard exists for
exactly that. The compound unique index already in the schema disambiguates without a new
read, so this rule needs **no new repository method** — only a change to which field the
workspace is taken from. The GitLab webhook path already resolves repo-first
(`gitlabWebhookService.ts:143 / 176 / 190` via `findByRepoIdAndProvider`); this brings the
GitHub path to the posture the newer provider already chose.

**The sweep — every call site that must adopt it.** All ten currently read
`installation.workspaceId`; each becomes a `null` at the type level under this amendment.

| Call site                                                           | What it resolves today                                                   | After                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `githubWebhookService.ts:168` (`handlePush`)                        | the workspace the code-graph refresh job is enqueued for                 | `repo.workspaceId`                                                                               |
| `githubWebhookService.ts:330` (`resolveGithubCiContext`)            | the installation handed to the shared CI-feedback consumer               | `repo.workspaceId`                                                                               |
| `githubWebhookService.ts:357` (`reconcileInstallation`)             | the workspace the whole reconcile is performed for                       | **skip guard** — see question 3; not a re-route                                                  |
| `githubWebhookService.ts:408` (`resolveGithubChangeRequestContext`) | PR status sync's tenant **and** `resolveBoundMember`'s membership lookup | `repo.workspaceId` (both)                                                                        |
| `ciMinutesMeterService.ts:146`                                      | **who gets billed** — the workspace the attribution chain starts in      | `repo.workspaceId`; see the meter section below                                                  |
| `codeGraphIndexService.ts:72`                                       | installation → workspace → **all** its projects (the index fan-out)      | `repo.workspaceId`; the fan-out itself stays MOTIR-1754's                                        |
| `githubRepoRepository.ts:41` (`listByWorkspace`)                    | the workspace's connected repo set → the `targetRepo` domain (`:79`)     | filter on the repo's own `workspace_id`                                                          |
| `githubRepoRepository.ts:100` (`findConnectedByWorkspaceAndName`)   | the code-scanning proxy's repo→tenant read (MOTIR-1605)                  | filter on the repo's own `workspace_id`                                                          |
| `oidcAuth.ts:102` (via `findConnectedByName`, `:125`)               | **the authenticated tenant** of a keyless CI caller                      | `match.workspaceId`; the ambiguity guard stays, it is no longer load-bearing                     |
| `gitlabConnectionService.ts:104`                                    | the GitLab connection's workspace                                        | **unchanged semantics** — never shared (§5.6 of the CI ADR); must handle the now-nullable column |

The last row is in the list precisely because it does **not** change meaning: a nullable
column touches it, and a sweep that omits a site because it is correct is how the next
reader loses the guarantee that the list is complete.

##### 3 · Reconcile — the shared installation never reaches `persistInstallation`

**`deleteExcept` is NOT reachable on the Motir-hosted path.** Stated as a reachability
property, not a caution.

`persistInstallation` is correct for a user's own installation, where one reconcile sees that
workspace's whole selection: it fetches GitHub's authoritative repo set and prunes anything
absent. For the shared installation it is wrong twice over — `fetchInstallationRepos` returns
**every tenant's** repos, so a scoped reconcile would both delete the repos it did not fetch
and **leak** the ones it did into whichever workspace ran it.

So the shared path does not reconcile at all:

- **Creation writes one row.** MOTIR-1781 upserts exactly the `GithubRepo` it just created,
  stamped with the creating project's `workspace_id`, and calls `attachRealizedRepo`. It
  never calls `persistInstallation`, so no code path can reach `deleteExcept` with a
  provisioning-installation id.
- **The webhook skips it.** `reconcileInstallation` (`githubWebhookService.ts:357`) must
  return a typed **`skipped_shared_installation`** outcome — not `synced`, not `skipped_unbound`
  — for any delivery whose installation row has `workspace_id IS NULL`. A distinct outcome
  because the two mean different things operationally: unbound is "nobody connected this
  yet", shared is "this is ours and reconcile does not apply".
- **The null IS the guard.** A shared installation has no workspace to reconcile _for_, so
  the code cannot form the call: `persistInstallation` requires a `workspaceId: string`.
  There is no flag to forget to check.
- **Disconnect stays available and stays narrow.** `deleteByInstallationAndRepoId` (the
  single-repo delete) is unaffected — removing one hosted repo is still a legitimate,
  bounded write.

##### 4 · What the CI meter bills, and how the workspace is attributed

Cross-references `ci-minutes-allowance.md` §5.1–§5.2, which this amendment **narrows without
overturning**.

**The owner gate stands, as a QUALIFIER.** §5.1 meters a run iff its repository's owner login
is `GITHUB_FALLBACK_ORG` (`lib/ciMetering/config.ts:49`, read from the run's own payload per
§5.5). That remains exactly right: it answers _"does Motir pay for this run?"_, which is the
billing fact itself. §5.3 already recorded that the gate stops being selective once every
created repo is Motir-owned.

**What it can no longer do is attribute.** The owner login is now true for every tenant's
repos, so it qualifies a run for metering and identifies **nobody** to charge. Attribution
comes from the repo row: `repo.workspaceId` → `ProjectRepo` (via `githubRepoId @unique`) →
project → workspace → organization. §5.2's documented chain is unchanged — it always ran
through `ProjectRepo`; what changes is the workspace the chain is _entered_ under.

**The concrete failure this prevents, and its direction.** `ciMinutesMeterService.ts:146`
binds `withWorkspaceServiceContext(installation.workspaceId)` and reads `project_repository`
under it. That table's RLS gates purely on `app.workspace_id` with no system escape, so a
hosted repo read under the wrong tenant's GUC resolves **no** project row, and the run lands
in §5.4's _"metered as a cost, charged to nobody, and LOGGED"_ bucket. The defect therefore
degrades to **systematic under-billing**, not cross-tenant over-billing: Motir would pay for
every project's CI and invoice no one, loudly, in the log. Worth stating plainly — RLS holds
the safety line even while routing is wrong, which is why this is a correctness bug found in
a design review rather than an incident. The service's own comment claims cross-tenant
mis-attribution is "structurally impossible"; that claim survives this amendment intact, and
it is what converts the bug into silence rather than harm.

**No change to what a run costs, to §3's normalization, or to the pool.** Only which
workspace the chain starts in.

##### 5 · What this asks of the not-yet-built cards

Recorded so the sweep is visible; **no card below is re-scoped by this amendment.**

The schema change, the RLS policy rewrite and the ten-site sweep are **MOTIR-1931**'s, in
one PR — they are one contract, and landing the nullable column without the sweep is the
window in which the mis-routing is live. This amendment ships **no schema or app change**.

MOTIR-1781 (the creation primitive) is unblocked: it can now write a mirror row that its own
project can see, and its "in the installation" criterion becomes satisfiable. Through it,
**MOTIR-1782** (the approval-step UI reads `established` off a row that is finally true),
**MOTIR-1900** (collaborator invites, which act per created repo), **MOTIR-1913** (role →
`targetRepo` resolution, which reads `toProjectRepoNames` — fact 5 — and the workspace's
connected set — fact 7) and **MOTIR-711** (the take-it-over transfer, which must move a
repo's tenancy with it) all depend on this shape and none of them changes because of it.

The planning defect this amendment corrects — the ownership reversal moved every tenant's
repos behind one installation without re-checking the mirror — is logged as **MOTIR-1932**.
It is the second instance of a recorded class: _a card's preconditions include the
ENTITY/KEY it hangs on, not only the data-source mechanism it reads_ (`notes.html`, the
motir-ai org-identity finding). There the key was absent across a service boundary; here it
was present but no longer identifying. Both are the same check, missed the same way.

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
  transferable as a unit. _(2026-07-30 amendment: every created set is Motir-owned, so
  9.3.7 is on the **standard** path — the transfer flow is what makes the default
  honest, not a rarely-taken branch.)_
- **A `type: manual` prerequisite is confirmed, not created here:** §3.3 requires a Motir
  fallback org to exist. MOTIR-1779 already owns provisioning it, alongside whatever grant
  change MOTIR-1777 determines. _(2026-07-30 amendment: no longer a fallback — MOTIR-1779
  is a hard prerequisite for **every** project that establishes a repo set, and what it
  provisions is the org plus a provisioning credential holding `Administration: write` on
  **Motir's own org**. The grant change MOTIR-1777 was expected to determine for the
  user-facing App is **not** taken: that App keeps MOTIR-890's least privilege.)_
- **Nothing here re-decides the GitHub App model** (7.10, shipped) and nothing re-scopes the
  coding convention from project to repo (a 7.14 change). §1's per-row role is deliberately
  compatible with a per-repo convention landing later.
- **The connected-repo mirror becomes a TENANCY-BEARING table** _(2026-07-31 amendment)_.
  `github_repo` carries its own `workspace_id` and its own RLS predicate;
  `github_installation.workspace_id` is nullable, and null means the shared provisioning
  installation. Every installation→workspace read in the product moves to the repo row (the
  ten-site sweep), and the shared installation never reconciles. This is the first place a
  GitHub row's tenant is not derivable from its installation, and it is a property of §3's
  one-org decision rather than of the repo set itself. MOTIR-1931 lands it; MOTIR-1932 logs
  the planning defect.

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
- `docs/github-repo-creation-mechanics.md` — the MOTIR-1777 spike: Mechanic 1's
  permission/token table (`POST /user/repos` is user-token-only) and the re-consent quotes
  the §3 amendment rests on.
- GitHub documentation the §3 amendment quotes:
  [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
  (permissions are selected at registration) ·
  [Installing a GitHub App from a third party](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party)
  (the repository-administration permission narrows installation to organization owners) ·
  [Editing a GitHub App's permissions](https://docs.github.com/en/apps/maintaining-github-apps/editing-a-github-apps-permissions)
  (two-sided re-consent).
- `motir-meta/notes.html` — the collapse-to-one-repo lesson (MOTIR-1775) and #103
  (cardinality is a cross-story contract) this ADR is the correction to; planning bug
  MOTIR-1887. For the 2026-07-31 amendment: the org-identity finding — _a card's
  preconditions include the ENTITY/KEY it hangs on, not only the data-source mechanism it
  reads_ — of which the mirror's tenancy key is the second instance; planning bug
  MOTIR-1932.
- Read by the 2026-07-31 tenancy amendment:
  `prisma/migrations/20260703120000_add_github_installation_repo_pr/migration.sql` (the
  `github_installation` / `github_repo` / `github_pull_request` RLS policies, and the
  join-through-installation predicate it replaces) ·
  `prisma/migrations/20260730115208_add_project_repository_set/migration.sql` (the row's-OWN
  `workspace_id` predicate it mirrors) · `lib/repositories/githubInstallationRepository.ts`
  (`upsert` re-binds `workspaceId`; `findByInstallationId`) ·
  `lib/repositories/githubRepoRepository.ts` (`deleteExcept`, `listByWorkspace`,
  `findConnectedByName`, `findByRepoIdAndProvider`) · `lib/services/githubWebhookService.ts`
  · `lib/services/ciMinutesMeterService.ts` · `lib/github/oidcAuth.ts` — the sweep's ten
  sites.
- `docs/decisions/ci-minutes-allowance.md` §5.1–§5.2 — the owner-login gate the tenancy
  amendment narrows to a QUALIFIER, and the attribution chain it re-enters through the repo
  row.
