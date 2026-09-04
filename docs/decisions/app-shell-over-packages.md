# ADR: `motir-core` as an app shell over workspace packages

- **Status:** Accepted (2026-09-03). This is a `decision` card: it fixes shapes and ships no
  behaviour. Everything it describes is BUILT by the other cards of Story
  **MOTIR-4292**, and nothing here is a precondition a sibling may assume is present.
- **Story / Subtask:** MOTIR-4292 ("One type-check program becomes many") · Subtask
  **MOTIR-4297** (this decision). `blocks` MOTIR-4299 (extract `@motir/orchestrator`).
- **Builds on:** [`design-system-package.md`](./design-system-package.md) (MOTIR-1524 — the
  first extraction out of this repository, and the package contract this one generalises),
  the `@motir/cli` precedent (`packages/cli`, MOTIR-879),
  [`brand-asset-distribution.md`](./brand-asset-distribution.md) (MOTIR-3724 — what a
  package's CONSUMER LIST decides that its import rule cannot), and
  [`ci-runner-fleet.md`](./ci-runner-fleet.md) §3–§4, whose reversibility claim the first
  extraction cashes in.
- **Evidence pinned at:** `motir-core` `parent/MOTIR-4292-typecheck-program-split`, off
  `origin/main` `9c077d4c1`. Every number below is produced by
  `scripts/measure-module-coupling.ts`, committed with this ADR — the table in §4 is its
  output, not a transcription of it.
- **Does NOT decide:** anything about `motir-ai` or the gateway, and no repository split (§6).

---

## Context

`motir-core` is one Next application with 1 113 files under `lib/`, and three workspace
packages beside it that were each extracted for a reason of their own: `@motir/design-system`
so a second repository could install the 3-axis system rather than hand-copy it,
`@motir/cli` because a terminal client is not a web app, `@motir/brand` because a mark that
differs between motir.co and the app is a brand defect. Nothing has yet said what the SHAPE
those three are instances of is, or what the next one has to satisfy.

Two things made that worth deciding now rather than at the fourth package.

**The type checker ran out of heap.** `pnpm typecheck` was ONE `tsc` program over the whole
repository and measured 4.42 GB against node 22's ~4.05 GB default old-space; two jobs in
`ci.yml` took a `--max-old-space-size` bump within a fortnight. MOTIR-4293 split the program
into project references, which removes the immediate cliff — and makes a package's own
`tsconfig` a first-class member of a solution rather than an island. A bounded context that
can be type-checked and tested on its own lane is now a cheap thing to have; before the split
it was not.

**And `lib/` is not layered for extraction.** The coupling walk in §4 is the evidence: every
module of any size reaches `lib/services` or `lib/repositories`, and several leaf-looking
helpers import a service BACK — `lib/rateLimit/postgresStore.ts` → `rateLimitService`,
`lib/orchestrator/usageSink.ts` → `ciFleetCostMeterService`, `lib/git` →
`gitlabConnectionService`. `lib/services` alone is 165 files reaching 86 other directories.
**Nothing under `lib/` becomes a package by being moved.** Each extraction has to INVERT its
outward imports into ports injected at a composition root, which is the pattern
`lib/orchestrator/index.ts` already uses for its two adapters. That is a per-module cost, it
is knowable in advance, and it is what the order in §5 is derived from.

---

## §1 — The target shape

**The Next app at the repository root is a SHELL.** Bounded contexts live in `packages/*` as
`@motir/<name>`, and the app composes them.

1. **The app imports a package BY NAME.** `import { … } from '@motir/orchestrator'` — never a
   relative path into `packages/`, and never a deep path past the barrel.
2. **A package NEVER imports the app.** No `@/…` specifier may appear under `packages/*/src`.
   This is the direction that makes a package extractable at all: an import of `@/lib/db`
   inside a package is the app leaking back in, and it is invisible to the naked eye because
   the alias resolves.
3. **A package NEVER reaches into another package's internals.** The barrel is the surface —
   the RSC-safe-barrel rule of [`design-system-package.md`](./design-system-package.md) §5
   generalised from one package to all of them.
4. **Each package carries its own:**
   - `package.json` (`@motir/<name>`, `private` unless it is published), with a `tsup` build
     where it emits and a `main`/`types` pointing at `dist/`;
   - `tsconfig.json`, **`composite: true`, referenced from `tsconfig.solution.json`** — that
     reference is what puts it in `pnpm typecheck` (MOTIR-4293), and a package left off the
     solution file is simply never type-checked;
   - a vitest suite of its own, which the ROOT lane does not run (`vitest.config.ts`'s
     `include` globs only `tests/**`);
   - **a CI lane of its own**, in the mould of `ci.yml`'s `design-system` job, gated by the
     `changes` classifier's path sets;
   - **a COMPOSITION ROOT in the app** — one file that imports the package's factory and
     binds its ports. It is the only place the app names what it injects, and it is what
     makes "swap the implementation" a one-file change rather than a re-plan.
5. **What a package may depend on:** its own `dependencies`, its declared peers, and other
   `@motir/*` packages by name. Not the generated Prisma client, not `@/lib/db`, not a
   service. A context that needs persistence takes a PORT and the app binds it.

**⚠️ And the consumer list is a separate question from the import rule**
([`brand-asset-distribution.md`](./brand-asset-distribution.md)). A file whose imports are
clean may still be wrong to ship: ask who INSTALLS the package before deciding what goes in
it. For a `private` workspace package with exactly one consumer — which every extraction in
§5 is — the answer is trivial; it stops being trivial the moment a package is published, and
that is a decision to take then, not a default to inherit.

---

## §2 — Why a package rather than a directory convention

A directory convention is enforced by review; a package is enforced by resolution. Three
things become mechanical the moment the boundary is a `package.json`:

- **The import direction is checkable** — §3's two predicates, and MOTIR-4299's
  `tests/packages/importDirection.test.ts`.
- **The type-check is bounded** — the package is its own project in the solution, so its
  cost is its own files plus the declarations of what it references (MOTIR-4293), and it
  cannot silently start paying for the app's.
- **The test lane is bounded** — the package's suite runs on its own paths, so a change
  inside it does not pay for the app's E2E matrix and a change in the app does not re-run it.

None of that is available to `lib/<context>/` however well-named.

---

## §3 — The import-direction rule, as predicates

Written so a gate can assert them rather than a reviewer read them. Both hold on this branch
(run 2026-09-03, output recorded):

```
$ grep -rn "from '@/" packages/*/src            # → 0 matches
$ grep -rn "@motir/[a-z-]*/src" lib app components   # → 0 matches
```

The first says no package imports the app. The second says no app file reaches past a
package's barrel into its sources. **Both are ZERO today across `design-system`, `cli` and
`brand`, so this ADR records a property the repository already has** rather than a debt it
intends to pay — which is the only condition under which a new rule is worth writing down.

MOTIR-4299 lands them as a mutation-checked test (`tests/packages/importDirection.test.ts`)
so a regression fails a suite rather than surviving until somebody greps.

---

## §4 — The coupling table

Produced by `pnpm tsx --tsconfig tsconfig.node.json scripts/measure-module-coupling.ts` on
this branch. Every `lib/*` directory with 8 or more files; `--json` gives the machine-readable
form for a diff against this table.

**The ranking rule: fewest outward `@/` imports first**, because each one is a port to invert
before the module can live in `packages/*`. Ties break on the number of distinct `lib/*`
directories those imports reach (reaching one leaf helper is not reaching `lib/services`),
then on size. **`importers` is deliberately NOT part of the ranking** — a mechanical rename of
N import lines is cheap, and an outward import that must become a port is not.

| module                | files | outward `@/` | → `lib/*` dirs                                                                                                                                                              | `@/lib/db` | prisma | importers |
| --------------------- | ----: | -----------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------: | -----: | --------: |
| `lib/onboarding`      |     9 |            3 | `lib/dto`, `lib/e2eProdHarness`                                                                                                                                             |          0 |      0 |        49 |
| `lib/orchestrator`    |    11 |            3 | `lib/ciFleet`, `lib/services`                                                                                                                                               |          0 |      1 |        30 |
| `lib/git`             |     8 |            3 | `lib/github`, `lib/gitlab`, `lib/services`                                                                                                                                  |          0 |      0 |       136 |
| `lib/emailTemplates`  |    15 |            4 | `lib/baseUrl`, `lib/i18n`                                                                                                                                                   |          0 |      0 |         7 |
| `lib/rateLimit`       |    12 |            5 | `lib/api`, `lib/apiTokens`, `lib/services`, `lib/workItems`                                                                                                                 |          0 |      0 |        41 |
| `lib/publicAddresses` |     9 |            5 | `lib/billing`, `lib/e2eProdHarness`, `lib/projects`, `lib/publicProjects`, `lib/repositories`                                                                               |          0 |      0 |        29 |
| `lib/billing`         |    10 |            5 | `lib/ai`, `lib/dto`, `lib/internalApi`, `lib/jobs`, `lib/organizations`                                                                                                     |          0 |      0 |        52 |
| `lib/savedFilters`    |     8 |            6 | `lib/filters`, `lib/projects`                                                                                                                                               |          0 |      3 |        21 |
| `lib/projects`        |     8 |            8 | `lib/dto`, `lib/permissions`, `lib/repositories`, `lib/services`, `lib/workspaces`                                                                                          |          0 |      2 |       430 |
| `lib/apiDocs`         |     8 |            9 | `lib/api`, `lib/mcp`, `lib/permissions`, `lib/tokens`                                                                                                                       |          0 |      0 |         4 |
| `lib/workspaces`      |     9 |            9 | `lib/auth`, `lib/db`, `lib/organizations`, `lib/repositories`, `lib/services`                                                                                               |          1 |      3 |       495 |
| `lib/projectRepos`    |    13 |           10 | `lib/dto`, `lib/mappers`, `lib/projects`, `lib/repos`, `lib/repositories`, `lib/services`, `lib/workItems`, `lib/workspaces`                                                |          0 |      6 |        47 |
| `lib/publicProjects`  |    14 |           10 | `lib/baseUrl`, `lib/billing`, `lib/dto`, `lib/navigation`, `lib/organizations`, `lib/publicAddresses`, `lib/publicRequests`, `lib/services`, `lib/triage`                   |          0 |      0 |        52 |
| `lib/issues`          |    13 |           11 | `lib/dto`, `lib/filters`, `lib/projects`, `lib/services`, `lib/workItems`, `lib/workspaces`                                                                                 |          0 |      0 |        16 |
| `lib/github`          |    26 |           11 | `lib/ciMetering`, `lib/crypto`, `lib/dto`, `lib/git`, `lib/jobs`, `lib/projectRepos`, `lib/repositories`, `lib/workspaces`                                                  |          0 |      0 |        25 |
| `lib/planning`        |    24 |           13 | `lib/ai`, `lib/dto`, `lib/issues`, `lib/planChange`, `lib/services`                                                                                                         |          0 |      0 |        11 |
| `lib/import`          |    22 |           16 | `lib/dto`, `lib/issues`, `lib/projects`, `lib/repositories`, `lib/services`, `lib/workItems`, `lib/workspaces`                                                              |          0 |      3 |         6 |
| `lib/auth`            |    10 |           16 | `lib/baseUrl`, `lib/cliDevice`, `lib/db`, `lib/e2eProdHarness`, `lib/i18n`, `lib/jobs`, `lib/navigation`, `lib/repositories`, `lib/services`, `lib/users`, `lib/workspaces` |          1 |      0 |         7 |
| `lib/ai`              |    23 |           19 | `lib/dto`, `lib/organizations`, `lib/projectAiSettings`, `lib/projects`, `lib/rateLimit`, `lib/repositories`, `lib/services`, `lib/workItems`, `lib/workspaces`             |          0 |      0 |        35 |
| `lib/dto`             |    80 |           21 | 15 directories                                                                                                                                                              |          0 |      7 |       299 |
| `lib/hooks`           |    17 |           24 | `lib/ai`, `lib/dto`, `lib/mentions`, `lib/onboarding`, `lib/planning`, `lib/workItems`                                                                                      |          0 |      0 |         0 |
| `lib/workItems`       |    28 |           24 | 10 directories                                                                                                                                                              |          0 |      7 |       138 |
| `lib/repositories`    |   107 |           24 | 14 directories                                                                                                                                                              |         65 |    107 |       199 |
| `lib/api`             |    35 |           28 | 12 directories                                                                                                                                                              |          0 |      0 |        27 |
| `lib/jobs`            |    63 |           54 | 9 directories                                                                                                                                                               |          0 |      6 |        27 |
| `lib/mcp`             |    71 |           85 | 25 directories                                                                                                                                                              |          0 |      5 |         5 |
| `lib/mappers`         |    61 |          115 | 26 directories                                                                                                                                                              |          0 |     49 |        83 |
| `lib/services`        |   165 |          540 | 86 directories                                                                                                                                                              |         12 |     87 |        80 |

28 modules of 8+ files · 1 113 files under `lib/` · 0 computed dynamic imports (the one shape
the measurement cannot see; a non-zero count means this table is incomplete and the order
below needs re-reading before it is trusted).

**What the table says, in one paragraph.** The distribution is not a gentle slope: three
modules have exactly THREE outward imports and the tail runs to 540. There is no version of
"extract `lib/services`" that is one story, and there never will be — its 540 outward imports
across 86 directories are what a monolith IS. The extractable set is the head of this table,
and the head is small.

---

## §5 — The extraction order

### First: `lib/orchestrator` → `@motir/orchestrator` (MOTIR-4299)

**Not because it ranks first** — `lib/onboarding` ties it on outward imports and has fewer
callers to rename. It is first because it is the one module that already has the SHAPE:
a port (`ContainerHandle` / `ContainerUsage` in `types.ts`), two adapters (`adapters/fly`,
`adapters/fake`), a selector that is already a composition root (`index.ts`), an ADR
([`ci-runner-fleet.md`](./ci-runner-fleet.md)) whose §3 promises reversibility, and a boundary
guard (`tests/ciFleet/orchestratorPortBoundary.test.ts`) that already asserts nothing above
the adapter names Fly. **Extracting it CASHES a claim the repository already makes rather
than inventing a contract on a module nobody has bounded** — which is what a first extraction
is for: the package contract in §1 is tested against a case where the shape is not in doubt.

Its three outward imports, and the port each becomes:

| import                                                  | in                                  | becomes                                                                                                                                        |
| ------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `@/lib/ciFleet/workloads` (`FleetWorkloadKind`, a type) | `types.ts`, `adapters/fly/index.ts` | the type MOVES INTO the package — it is the port's own vocabulary — and `lib/ciFleet/workloads` re-exports it from there                       |
| `@/generated/prisma/client` (`Prisma`, for a `Decimal`) | the usage/rates path                | a `Decimal`-free representation at the port (a `string`/`number` the app converts at its edge), so the package has no Prisma dependency at all |
| `@/lib/services/ciFleetCostMeterService`                | `usageSink.ts`                      | a `UsageMeter` PORT on the package's factory; the app's composition root passes the service                                                    |

Thirty files import `@/lib/orchestrator/…` today. That rename is mechanical and is not what
makes this the first extraction.

### Then, in order, and each its OWN story

- **`lib/emailTemplates` (15 files, 4 outward).** Reaches `lib/baseUrl`, `lib/i18n/locales`,
  `lib/i18n/messages` and one `components/brand` component. Its templates are already PURE by
  rule (`CLAUDE.md`: no `sendEmail`, no `db`, no `process.env`), so the inversions are a
  `baseUrl` value passed in, a locale/messages port, and the brand component taken from
  `@motir/brand` — which is already a package. Seven importers.
- **`lib/rateLimit` (12 files, 5 outward).** Reaches `lib/api/v1/bearer`,
  `lib/api/v1/rateLimit`, `lib/apiTokens/token`, `lib/services/rateLimitService` and
  `lib/workItems/serviceContext`. The service import is the BACKWARD edge named in the
  Context above and is the whole of the work: the store needs a persistence port, and the
  app binds the Postgres-backed one.

**Everything after the first is its own story, one per package**, and each re-runs
`scripts/measure-module-coupling.ts` rather than trusting this table — the numbers move every
time a module is extracted, which is the point.

**And the order is a reading, not a commitment.** A module that stops being worth extracting
(its context dissolves, its consumer count collapses) drops off; the ranking rule is what
survives, not the row order.

---

## §6 — What this does NOT decide

- **Nothing about `motir-ai` or the gateway.** They are separate repositories with their own
  deployment and their own decisions; the shape here is about what `motir-core` contains.
- **No repository split.** A package is a DIRECTORY IN THIS REPOSITORY, and that is preferred
  deliberately: one CI run over the composed tree, one lockfile, one pull request per change,
  and no version skew between the app and the context it just changed. A second repository
  buys independent release cadence and pays for it with a published artifact between every
  producer and consumer — which is exactly the cost
  [`design-system-package.md`](./design-system-package.md) accepted for `@motir/design-system`
  BECAUSE its consumers are other repositories. **The counter-case is therefore named rather
  than dismissed:** the day a `packages/*` context has a consumer outside this repository, it
  has design-system's problem and should take design-system's answer.
- **Nothing about which context is a context.** The table in §4 measures what `lib/` looks
  like; it does not claim the directory boundaries are the right domain boundaries. A module
  whose extraction would require inventing its contract is not ready, and §5's first pick is
  the opposite case on purpose.
- **No `publishConfig`.** Every package this ADR contemplates is `private` with one consumer.
  Publishing one is a separate decision with a separate consumer list (§1's closing note).

---

## Consequences

- **A new bounded context has a checklist**, and five of its six items are mechanical: a
  `package.json`, a composite `tsconfig` referenced from the solution, a vitest config, a CI
  lane, a composition root. The sixth — what its ports are — is the design work, and the
  coupling table says in advance how much of it there is.
- **`pnpm typecheck` gets cheaper per extraction rather than more expensive.** Files leave the
  app project for a project of their own, and the app consumes them through declarations.
  MOTIR-4299 pins that as a criterion: the app project's `--listFilesOnly` count drops by at
  least the files that moved.
- **The import-direction predicates become a gate rather than an observation** (MOTIR-4299),
  so §3's two zeros stay zero.
- **The order in §5 will go stale, and re-deriving it is one command.** That is why the script
  is committed and the table is its output.
