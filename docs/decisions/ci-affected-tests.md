# A pull request runs the Vitest files its diff can reach — what `--changed` sees, what it cannot, and what it saves

**Status:** accepted · **Date:** 2026-09-13 · **Card:** Subtask MOTIR-5322 (Task MOTIR-5321) ·
**Evidence pinned at:** `motir-core` `origin/main` @ `f59db9679dd1ae82db553273ca043fc39e42086f`,
`vitest@4.1.7` as installed from `pnpm-lock.yaml` at that sha · **Amends:**
[`merge-queue.md`](./merge-queue.md) §3, the _Pull request_ row — see §4

> The question: **if a pull request ran only the Vitest files its diff reaches, how much would it
> save, and which tests would it wrongly skip?** §1 is how Vitest decides, read from its source; §2
> is what that decision cannot see and what must run anyway; §3 is the saving, measured on the last
> 30 merged pull requests; §4 is the decision; §5 is what it costs.

---

## §1 — The mechanism, read from `vitest@4.1.7`'s source

Every answer below cites the installed bundle, `node_modules/vitest/dist/chunks/`. Where this
contradicted the card that commissioned it, the source is what is written here.

**How `--changed <ref>` finds changed files.** `GitVCSProvider.findChangedFiles`
(`cli-api.C6CiCDM3.js`) runs `git diff --name-only <ref>...HEAD` (`getFilesSince`) and adds the staged
and unstaged file lists, each resolved to an absolute path. On a CI checkout the last two are empty.
If the `git` command fails — a shallow clone without the merge base, an unknown ref —
`resolveFilesWithGitCommand` rethrows with git's stderr, `startVitest` treats it as an unhandled error
and sets `process.exitCode = 1`. **A broken selection is a red leg, never a silent pass.**

**How it maps changed files to test files.** `VitestSpecifications.filterTestsBySource`, in order:

1. If any changed path matches `forceRerunTriggers`, **every** spec runs.
2. If there are no changed paths and Vitest is not watching, **no** spec runs.
3. Otherwise, for each spec, `getTestDependencies` walks the **Vite SSR transform graph** from the
   spec: `transformRequest(file)` → `transformed.deps` (static imports) and `transformed.dynamicDeps`
   (dynamic imports with a literal specifier), recursively, skipping any path containing
   `node_modules` and any path that does not `existsSync`. A spec runs when it IS a changed path or a
   changed path is in its graph.

**`forceRerunTriggers` and its default.** `configDefaults` (`defaults.9aQKnqFk.js`) sets it to
`["**/package.json/**", "**/{vitest,vite}.config.*/**"]`; `vitest.config.ts` does not override it. It is
matched with `picomatch` against absolute paths. Measured with the `picomatch` Vitest itself resolves:
`package.json` and `packages/cli/package.json` **match**; `vitest.config.ts` and
`vitest.collect.config.ts` **do not** — the trailing `/**` needs a path segment after the file name. So
**the default does not re-run anything when the Vitest config itself changes.**

**What that means for each input the card asked about:**

| Input                                                  | Seen by `--changed`?                                                                                                                                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a `setupFiles` entry (`tests/helpers/perWorkerDb.ts`…) | **No.** The walk starts at the spec; setup files are loaded by the runner, not imported by any spec.                                                                                                  |
| the `globalSetup` entry (`tests/setup/globalDb.ts`)    | **No**, for the same reason.                                                                                                                                                                          |
| `vitest.config.ts`, `vitest.collect.config.ts`         | **No** — the default trigger does not match the file (above), and no spec imports a config.                                                                                                           |
| any `package.json`                                     | **Yes** — the default trigger re-runs everything.                                                                                                                                                     |
| `pnpm-lock.yaml`, a dependency upgrade                 | **No.** Dependencies resolve into `node_modules`, which the walk skips.                                                                                                                               |
| a JSON import (`messages/en.json`)                     | **Yes.** It is a graph node. `lib/i18n/messages.ts` imports both catalogues statically, so `messages/en.json` is in **1,083** of 1,649 graphs.                                                        |
| a workspace package (`@motir/design-system`)           | **No, not its source.** `@motir/*` resolves to `packages/<name>/dist/index.js`, which is git-ignored and built by `postinstall` — a pull request changes `packages/<name>/src`, which is in no graph. |
| a file a test reads with `fs`, or a spawned process    | **No.** Only imports are edges.                                                                                                                                                                       |
| `prisma/schema.prisma`, a migration                    | **No.** The client is generated into `generated/prisma` (git-ignored) and the migrations are applied before any test runs.                                                                            |

**How `--changed` composes with `--shard` and the cost-balanced sequencer.** Selection happens first:
`Vitest.start` → `getRelevantTestSpecifications` → `filterTestsBySource`. Sharding happens after, in
`createPool` → `executeTests`, which calls `sequencer.shard(specs)` on the **selected** specs. So
`CostBalancedSequencer.shard` (`tests/helpers/vitestShardSequencer.ts`) bin-packs the subset with
`assignLegs`, which is deterministic on its input — every leg computes the same partition of the same
subset. Two consequences:

- `executeTests` throws `--shard <count> must be a smaller than count of test files` when the selection
  holds fewer files than there are legs, **unless `--passWithNoTests` is set.**
- A leg whose slice is empty exits non-zero without `--passWithNoTests` (`Logger.printNoTestFound`:
  _"No test files found, exiting with code 1"_).

**What an empty selection does.** `filterTestsBySource` returns `[]`; `Vitest.start` throws
`FilesNotFoundError`; `startVitest` swallows it and `printNoTestFound` exits **0 with
`--passWithNoTests` and 1 without.** `vitest list` and `vitest related` default `passWithNoTests` to
`true` (`cac.BuBILSID.js`); `vitest run` does not.

**What a positional filter does, because §4 needs one.** `TestProject.filterFiles` keeps a test file
when its repo-relative path **contains** a filter, case-insensitively. Filters narrow what is globbed
**before** `filterTestsBySource` runs, so `--changed` and a file list **intersect** — a set of
tests to add to a `--changed` selection cannot be expressed on one command line. Passing explicit paths
can only over-select (a path that is a prefix of another), which is the safe direction.

## §2 — What must run whatever the diff: the force-full paths and the always-run tests

The blind spot has **two** shapes, and they need two different remedies.

### §2.1 — Inputs every test depends on: a change here runs the whole suite

| Glob                                                                                                                                                                               | Why                                                                                                                                                                            | A test that reads or depends on it                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`, `**/package.json`                                                                                                                                                  | dependencies live in `node_modules`; Vitest's own default already triggers on it                                                                                               | `tests/components/charts.test.tsx` (`readFileSync(resolve(process.cwd(), 'package.json'))`)                                       |
| `pnpm-lock.yaml`, `pnpm-workspace.yaml`                                                                                                                                            | a dependency or workspace change never appears in any graph                                                                                                                    | `tests/jobs/inngest-retired.test.ts` (reads `pnpm-lock.yaml`), `tests/scripts/release-contract.test.ts` (`pnpm-workspace.yaml`)   |
| `tsconfig*.json`                                                                                                                                                                   | the transform's JSX and module settings                                                                                                                                        | `tests/jobs/step-result-shape-guard.test.ts` (`join(root, 'tsconfig.json')`)                                                      |
| `vitest.config.ts`, `vitest.collect.config.ts`                                                                                                                                     | the lane's config; the default trigger misses the file (§1)                                                                                                                    | `tests/integration/acceptance-freeze-seam.test.ts` (reads `vitest.config.ts`), `tests/vitest-shard-plan.test.ts`                  |
| `tests/helpers/parallelDb.ts`, `tests/helpers/structuralGuardLane.ts`, `tests/helpers/vitestShardSequencer.ts`, `tests/helpers/vitestShardPlan.ts`                                 | imported by a config at config-load time, which no graph contains; the last two decide which leg runs which file                                                               | `tests/integration/parallel-db-isolation.test.ts`, `tests/publicAddresses/storyGuards.test.ts`, `tests/vitest-shard-plan.test.ts` |
| `tests/setup/**`, `tests/helpers/perWorkerDb.ts`, `tests/helpers/actEnvironment.ts`, `tests/helpers/inFlightProbe.ts`, `tests/helpers/inFlightWork.ts`, `tests/helpers/adminDb.ts` | `globalSetup`, `setupFiles` and their import closure — re-derived by the script at the pinned sha, which reports _"Setup-closure files FORCE_FULL_GLOBS does not cover: none"_ | every DB-backed spec; named: `tests/integration/parallel-db-isolation.test.ts`                                                    |
| `prisma/**`                                                                                                                                                                        | the generated client and the migrations every DB-backed test runs against                                                                                                      | `tests/components/DataExportCard.test.tsx` (`readFileSync('prisma/schema.prisma')`), `tests/integration/migrations/*.test.ts`     |
| `packages/**`                                                                                                                                                                      | tests import `packages/*/dist`, which is git-ignored — a package's source is in no graph                                                                                       | `tests/api/public/contract-drift.test.ts`, `tests/api/v1/cli-transport-seams.test.ts` (imports `packages/cli/src/api`)            |
| `.github/workflows/ci.yml`, `.github/actions/**`                                                                                                                                   | the lane's own definition                                                                                                                                                      | `tests/ciFleet/ciRunnerImage.test.ts` (reads `ci.yml`), `tests/ci-postgres-container.test.ts` (`.github/actions/postgres`)        |

The list lives in one place, `FORCE_FULL_GLOBS` in `scripts/ci/measure-affected-tests.mjs`, and this
table must equal it.

### §2.2 — Tests whose inputs are files, not imports: these run on every pull request

**The enumerating commands, at the pinned sha:**

```sh
git grep -lE "readFileSync|readdirSync" f59db9679 -- 'tests/**/*.test.ts' 'tests/**/*.test.tsx' | wc -l
# 261   (of 1,689 test files; 1,649 after the structural-guard exclude)

git grep -lE "readFile\(|readFileSync|readdirSync|existsSync|statSync|globSync|tinyglobby|fast-glob|execSync|execFileSync|spawnSync|import\.meta\.glob|\?raw['\"]" \
  f59db9679 -- 'tests/**/*.test.ts' 'tests/**/*.test.tsx' | wc -l
# 273
```

**What those 273 read**, counted as the files whose non-import lines name each top-level path (a file
counts once per path it names, so the rows overlap):

| Read under    | Files | Read under                                                  |    Files |
| ------------- | ----: | ----------------------------------------------------------- | -------: |
| `app/`        |   179 | `.github/`                                                  |       27 |
| `lib/`        |   173 | `scripts/`                                                  |       20 |
| `components/` |    87 | `tests/helpers/`, `tests/e2e/`                              |   19, 18 |
| `docs/`       |    61 | `CLAUDE.md`                                                 |       15 |
| `design/`     |    60 | `messages/`                                                 |       14 |
| `packages/`   |    57 | `package.json`                                              |       10 |
| `public/`     |    36 | `Dockerfile`, `next.config.ts`, `fly.toml`, `hooks/`, other | ≤ 5 each |
| `prisma/`     |    28 |                                                             |          |

**This is why the blind spot is a TEST set and not a path set.** The card asked for a few broad globs.
The largest classes are tests that read **application source as text** — the guards that grep `app/`,
`lib/` and `components/` for a pattern. As globs, `app/**` and `lib/**` would put almost every
application pull request into the force-full set and the saving would be zero by construction. So the
remedy is inverted: **a test that reads the tree runs on every pull request**, and everything else runs
when its import graph is touched.

**The always-run rule, as the script applies it:** a spec is always-run when its own source, or the
source of any module under `tests/` or `scripts/` in its graph, matches `ALWAYS_RUN_PATTERN` (the
second command's pattern widened to `readdir(`, `glob(`, `createReadStream`, `child_process`, `spawn(`,
`execa` and `new URL(…, import.meta.url)`), **with comments stripped**. Matched on content, so a new
file-reading test joins the set without anybody editing a list. At the pinned sha: **342 of 1,649
specs (20.7%)**.

**Product modules that read the filesystem**, which the script lists rather than folds in — each is a
module under `lib/`, `app/` or `packages/` reached by some spec:

| Module                                                                          | Specs | Why it is not a blind spot                                                  |
| ------------------------------------------------------------------------------- | ----: | --------------------------------------------------------------------------- |
| `packages/orchestrator/dist/index.js`                                           |  1000 | `packages/**` is force-full                                                 |
| `lib/email.ts`                                                                  |   120 | reads `process.env.EMAIL_FAULT_PATH`, a path outside the repository         |
| `lib/test-fixture-file.ts`                                                      |     6 | reads a path handed over in an environment variable                         |
| `packages/cli/src/config/*.ts`, `repoClone.ts`, `dispatch.ts`, `git.ts`         |   2–5 | a user's config directory and cloned repositories; also under `packages/**` |
| `lib/services/repoFileReadService.ts`, `app/api/internal/ai/repo-file/route.ts` |     2 | reads a cloned customer repository at run time, not this one                |

## §3 — The saving, measured

**The instrument** is `scripts/ci/measure-affected-tests.mjs`:

```sh
pnpm exec tsx --tsconfig tsconfig.node.json scripts/ci/measure-affected-tests.mjs
```

It builds every spec's graph **once, at the pinned sha**, with Vitest's own `getTestDependencies` and
its own `picomatch`, then applies `filterTestsBySource`'s predicate to each of the last 30 squash
commits on `main` (`<sha>^..<sha>` is the pull request's diff as merged). `app` is the `changes` job's
predicate: a pull request with `app=false` runs no Vitest lane today and has no ratio. _graph_ is what
`vitest --changed` alone would select; _+ always-run_ adds §2.2; _cost_ is the share of the suite's
cost by `tests/helpers/vitestShardPlan.ts`'s `costSeconds`, the same numbers the legs are packed by.

**Two approximations, both stated.** The graph is resolved at the pinned sha, not at each pull
request's merge base — over a window of four days it is the same code, and 30 checkouts with 30
`node_modules` states would buy nothing this decision needs. And `main`'s squash commit is used as the
pull request's diff, which is what was merged rather than the branch's own history.

**The cross-check that the replica is the real thing.** For #2842, at the pinned sha,
`pnpm exec vitest list --config vitest.config.ts --changed HEAD~1 --filesOnly --json` selects **13**
files; the script's _graph_ column selects **13**, and the two sets are identical.

The table, as the script prints it at the pinned sha (Prettier re-pads the columns; the cells are the
script's):

| PR    | commit      | changed | app | force-full on                                                                         | graph | + always-run | files |  cost |
| ----- | ----------- | ------: | :-: | ------------------------------------------------------------------------------------- | ----: | -----------: | ----: | ----: |
| #2842 | `f59db9679` |      11 | yes | —                                                                                     |    13 |          353 | 21.4% | 19.2% |
| #2835 | `707c0bb63` |       3 | no  | skipped                                                                               |     — |            — |     — |     — |
| #2837 | `d8d88214e` |       3 | no  | skipped                                                                               |     — |            — |     — |     — |
| #2836 | `20a73e836` |       3 | no  | skipped                                                                               |     — |            — |     — |     — |
| #2834 | `eaa8a9418` |       3 | yes | —                                                                                     |    27 |          360 | 21.8% | 20.0% |
| #2832 | `0e35d4cbc` |       3 | no  | skipped                                                                               |     — |            — |     — |     — |
| #2833 | `038d4adf7` |       2 | yes | —                                                                                     |    86 |          409 | 24.8% | 23.8% |
| #2829 | `911f5f7ee` |       5 | yes | —                                                                                     |     4 |          346 | 21.0% | 18.9% |
| #2827 | `4a3e89ebb` |       4 | yes | —                                                                                     |     2 |          344 | 20.9% | 18.8% |
| #2826 | `1c4a2735e` |      17 | yes | —                                                                                     |  1097 |         1275 | 77.3% | 81.6% |
| #2822 | `fa06841bf` |       5 | yes | —                                                                                     |     0 |          342 | 20.7% | 18.8% |
| #2815 | `9cb1baa4a` |      28 | yes | `prisma/migrations/20260911170000_project_acceptance_video_gate_switch/migration.sql` |     — |         1649 |  100% |  100% |
| #2825 | `9421599ae` |      16 | yes | `vitest.config.ts`                                                                    |     — |         1649 |  100% |  100% |
| #2823 | `9dbaa414e` |      10 | yes | —                                                                                     |     1 |          342 | 20.7% | 18.8% |
| #2817 | `876847c81` |       1 | yes | —                                                                                     |     1 |          343 | 20.8% | 18.8% |
| #2824 | `e5a9e8443` |       1 | no  | skipped                                                                               |     — |            — |     — |     — |
| #2821 | `55fb371e0` |       3 | no  | skipped                                                                               |     — |            — |     — |     — |
| #2819 | `2c92853de` |       9 | yes | —                                                                                     |  1198 |         1368 | 83.0% | 87.3% |
| #2818 | `faeb26e61` |       5 | yes | `tests/helpers/structuralGuardLane.ts`                                                |     — |         1649 |  100% |  100% |
| #2820 | `5012036aa` |       5 | yes | —                                                                                     |     2 |          344 | 20.9% | 18.8% |
| #2811 | `da24c99fc` |      27 | yes | `prisma/migrations/20260911140000_approval_gate_project_state_idx/migration.sql`      |     — |         1649 |  100% |  100% |
| #2809 | `c7c8f22a9` |      36 | yes | `package.json`                                                                        |     — |         1649 |  100% |  100% |
| #2816 | `e934ea483` |       1 | no  | skipped                                                                               |     — |            — |     — |     — |
| #2814 | `65116fb19` |       6 | yes | —                                                                                     |     5 |          346 | 21.0% | 18.9% |
| #2813 | `7d590b37f` |       3 | no  | skipped                                                                               |     — |            — |     — |     — |
| #2812 | `595114d77` |      10 | yes | —                                                                                     |  1013 |         1208 | 73.3% | 80.0% |
| #2810 | `d0f6c0c07` |       5 | yes | —                                                                                     |     0 |          342 | 20.7% | 18.8% |
| #2795 | `3c16a6aaf` |      13 | yes | —                                                                                     |     0 |          342 | 20.7% | 18.8% |
| #2808 | `2227ec69c` |       8 | yes | `vitest.config.ts`                                                                    |     — |         1649 |  100% |  100% |
| #2807 | `e98c999f4` |       2 | yes | —                                                                                     |     1 |          342 | 20.7% | 18.8% |

**Summary.** 30 pull requests · **8** run no Vitest lane (`app=false`) · **6** hit the force-full set
(two migrations, two `vitest.config.ts`, one `structuralGuardLane.ts`, one `package.json`) · **16**
measured.

| Over the 16 measured | median |   p90 |
| -------------------- | -----: | ----: |
| selected / total     |  20.9% | 77.3% |
| cost share           |  18.8% | 81.6% |
| graph alone          |   0.1% |     — |

**The distribution is bimodal, and the modes have names.** Thirteen of the sixteen sit on the
always-run floor (20.7–24.8%) — the import graph adds almost nothing for them. The other three reach a
**hub**: #2826 and #2819 change `messages/en.json` (in 1,083 graphs), #2819 also
`lib/repositories/githubRepoRepository.ts` (1,002), and #2812 changes `lib/ai/motirAiClient.ts`
(1,009). A pull request that edits a user-facing string pays for most of the suite, correctly — those
tests render that catalogue.

**Across all 22 pull requests that run the lane**, force-full included, the mean cost share is **~50%**:
the lane's runner-time roughly halves on average and falls by ~80% on the typical pull request. It does
not fall by the same share in wall clock — each leg keeps its ~75 s of checkout, Postgres, install and
`migrate deploy` whatever it runs.

## §4 — The decision

**GO.** The card's thresholds were: **no-go** if the median _selected / total_ over non-force-full pull
requests is above 50%, or if more than half of the 30 hit the force-full set. Measured: **median
20.9%**, and **6 of 30** hit the force-full set.

| Lane               | Vitest                                                                                                                                    | Coverage gate                                    | E2E                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------- |
| **Pull request**   | the **affected subset** — graph selection ∪ §2.2's always-run tests — **or the full suite** when a §2.1 path changed, or on any fail-open | skipped on a subset run; unchanged on a full run | unchanged                           |
| **`merge_group`**  | the full suite                                                                                                                            | enforced                                         | unchanged, including `e2e-at-scale` |
| **push to `main`** | unchanged (none)                                                                                                                          | unchanged                                        | unchanged                           |

**What the implementation has to respect, from §1 — this is the list the code card builds to:**

1. **The selection is not `vitest run --changed` alone.** `--changed` cannot add the always-run tests,
   because a positional filter intersects with it (§1). The selection is computed once — the graph
   predicate this script already implements, run as a selection mode of the same code so that the rule
   that was measured and the rule that is enforced cannot drift — and handed to each leg as positional
   file filters: `vitest run --config vitest.collect.config.ts --shard=<n>/12 --passWithNoTests <files…>`.
2. **`--passWithNoTests` is mandatory** on a subset run: without it `--shard` throws when the subset
   holds fewer than twelve files, and an empty leg exits 1.
3. **The sequencer needs no change.** `CostBalancedSequencer.shard` receives the selected specs and
   packs them deterministically, so twelve legs computing the same selection agree on the partition.
4. **Fail open.** Any error while selecting — including `git` failing on a shallow checkout — runs the
   leg's full shard. The checkout must hold the merge base.
5. **No coverage on a subset.** The per-file thresholds are enforced on a merged report; a subset
   cannot satisfy them, so a subset run collects none and the `coverage` job is skipped.
6. **A `vitest-full` label on a pull request forces the full suite** — the diagnosis door §5 depends on.

## §5 — What it costs, stated plainly

**A break the subset misses is caught when the merge queue ejects the pull request, not on the pull
request.** That reverses the reason `merge-queue.md` §3 gave for keeping the full gate on a pull
request: _"A failure must be visible before queueing, or ejection becomes the normal feedback path."_

It is accepted for three measured reasons:

- **The missable class is narrow.** §2.1 and §2.2 cover every non-import input the source reading and
  the enumeration found. What remains is a test whose dependency is invisible to both — a
  non-literal dynamic import, a file read through an API outside `ALWAYS_RUN_PATTERN`, a runtime-generated
  input.
- **Ejection is already where composed-tree failures surface, and Vitest is a small share of them.**
  `merge-queue.md` §6.1: of 23 failed queue builds, **3** had a failing Vitest shard, against 17
  `TypeScript` and 15 `Structural guards`.
- **The saving is large and lands on every agent.** The typical pull request's Vitest lane falls to
  ~19% of its cost (§3).

**⚠️ And one recorded trade this reverses has to be re-decided in the same change.** `ci.yml`'s `test`
job sets `fail-fast` on `merge_group` only, and its comment says that is _"only affordable because the
pull-request lane still runs this whole suite"_ and _"Do not do one without re-deciding the other."_
Re-decided here: **the queue keeps `fail-fast`**, because the queue is still not where a failure is
diagnosed. The pull request is — and after a queue ejection with a failing Vitest leg, the author adds
the **`vitest-full`** label (§4.6) to get the full, un-cancelled fan-out on the pull request, where
rotation can be read. The comment is rewritten with the implementation.

**The remedy for that ejection is to fix the break, not to re-queue.** A re-queued entry runs the same
full suite against the same tree and fails the same way.

**Where to look first if this ever goes wrong:** re-run this script on the pull request's squash commit
and check whether the failing test was selected. If it was not, name the input it read, and add it to
§2.1 or widen `ALWAYS_RUN_PATTERN` — in the one place each lives.
