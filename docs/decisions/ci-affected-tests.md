# A pull request runs the Vitest files its diff can reach — what `--changed` sees, what it cannot, and what it saves

**Status:** accepted 2026-09-13; **reversed by Amendment 1 (2026-09-21, at the end)** · **Date:** 2026-09-13 · **Card:** Subtask MOTIR-5322 (Task MOTIR-5321) ·
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
| `.github/ci/**`                                                                                                                                                                    | the force-full list itself — a change to it changes what every pull request runs                                                                                               | `tests/ci-changed-paths-gate.test.ts` (reads `.github/ci/full-suite-paths.txt`)                                                   |
| `scripts/ci/measure-affected-tests.mjs`                                                                                                                                            | the selection itself — the script every pull request's legs run to choose their files                                                                                          | `tests/ci-changed-paths-gate.test.ts` (asserts the script reads the list file)                                                    |

The list lives in one file, `.github/ci/full-suite-paths.txt` — read by `ci.yml`'s `changes` job, by
`scripts/ci/measure-affected-tests.mjs` and by `tests/ci-changed-paths-gate.test.ts`, which asserts that
this table equals it (MOTIR-5325).

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
pnpm exec tsx --tsconfig tsconfig.node.json scripts/ci/measure-affected-tests.mjs --at f59db9679
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

---

## Amendment 1 (2026-09-21) — the median is 66.5% over 118 pull requests: NO-GO by §4's own line; revert the pull-request lane to the full suite

**Card:** Bug MOTIR-5924 (discovered in MOTIR-5324's case 5) · **Evidence pinned at:** `motir-core`
`origin/main` @ `1f12eca70e32e6ff5513d2f38280f166a4eb9f0a`, `vitest@4.1.7`, a fresh
`pnpm install --frozen-lockfile` + `prisma generate` in a worktree at that sha. The instrument is §3's,
unchanged.

> **What changed is not the import graph — it is which pull requests land.** Scored against today's
> graph, the sixteen pull requests §3 measured still select a median **20.9%**. The last thirty select
> **73.2%**, the last 260 **66.5%**, and no edge cut that a card could make brings either under 50%.

### A1.1 — §3 re-measured at the pin

```sh
pnpm exec tsx --tsconfig tsconfig.node.json scripts/ci/measure-affected-tests.mjs --at 1f12eca70
pnpm exec tsx --tsconfig tsconfig.node.json scripts/ci/measure-affected-tests.mjs --at 1f12eca70 --limit 260 --json
```

**1,984 spec files · always-run 408 (20.6%, was 342 of 1,649 = 20.7%) · setup-closure files the
force-full list does not cover: none.** The table, as the script prints it:

| PR    | commit      | changed | app | force-full on                                                                           | graph | + always-run | files |  cost |
| ----- | ----------- | ------: | :-: | --------------------------------------------------------------------------------------- | ----: | -----------: | ----: | ----: |
| #3027 | `1f12eca70` |       8 | yes | —                                                                                       |    89 |          477 | 24.0% | 23.1% |
| #3026 | `5888abd14` |       3 | yes | —                                                                                       |  1234 |         1452 | 73.2% | 79.1% |
| #3023 | `475c9b573` |      11 | yes | —                                                                                       |  1351 |         1550 | 78.1% | 81.7% |
| #3024 | `a3b605e20` |      30 | yes | —                                                                                       |  1363 |         1560 | 78.6% | 82.1% |
| #3020 | `9004ed77b` |      10 | yes | —                                                                                       |  1080 |         1319 | 66.5% | 72.6% |
| #3022 | `0e6d99688` |       1 | yes | —                                                                                       |     1 |          409 | 20.6% | 18.9% |
| #3021 | `7c7bea604` |       1 | no  | skipped                                                                                 |     — |            — |     — |     — |
| #3015 | `c4c62a837` |      61 | yes | —                                                                                       |  1352 |         1551 | 78.2% | 81.7% |
| #3010 | `9372f7d5c` |      38 | yes | `prisma/migrations/20260921090000_add_monitor_issue_authoring_job/migration.sql`        |     — |         1984 |  100% |  100% |
| #3014 | `409632726` |      16 | yes | —                                                                                       |  1350 |         1549 | 78.1% | 81.7% |
| #3019 | `d85ce78c2` |      10 | yes | `.github/workflows/ci.yml`                                                              |     — |         1984 |  100% |  100% |
| #3005 | `c4b5298f8` |      49 | yes | `prisma/migrations/20260920090000_add_planning_parking_edges/migration.sql`             |     — |         1984 |  100% |  100% |
| #3018 | `afb638546` |       4 | yes | —                                                                                       |  1080 |         1319 | 66.5% | 72.6% |
| #3017 | `4f81cbdcf` |       2 | no  | skipped                                                                                 |     — |            — |     — |     — |
| #3012 | `a1aa449ec` |      23 | yes | —                                                                                       |  1350 |         1548 | 78.0% | 81.6% |
| #3013 | `af6618ccd` |      14 | yes | `prisma/migrations/20260921090000_email_delivery_created_at_index/migration.sql`        |     — |         1984 |  100% |  100% |
| #3016 | `6da90c91c` |       3 | no  | skipped                                                                                 |     — |            — |     — |     — |
| #3011 | `bb0180061` |      17 | yes | `prisma/migrations/20260921090000_add_job_dlq_standing_filing/migration.sql`            |     — |         1984 |  100% |  100% |
| #2992 | `de31060f1` |      78 | yes | `package.json`                                                                          |     — |         1984 |  100% |  100% |
| #3009 | `5dd09995c` |       7 | yes | —                                                                                       |  1234 |         1452 | 73.2% | 79.1% |
| #3008 | `f0ff631a2` |       1 | no  | skipped                                                                                 |     — |            — |     — |     — |
| #3007 | `cdcebaf1e` |       3 | yes | —                                                                                       |  1349 |         1548 | 78.0% | 81.6% |
| #3006 | `38310cc7a` |      10 | yes | —                                                                                       |   157 |          541 | 27.3% | 26.7% |
| #2995 | `ad94477f4` |      59 | yes | `prisma/migrations/20260919190000_add_acceptance_result_gate_kind/migration.sql`        |     — |         1984 |  100% |  100% |
| #3004 | `264ef6054` |       6 | yes | —                                                                                       |  1351 |         1549 | 78.1% | 81.7% |
| #2994 | `6c2e687d2` |      34 | yes | —                                                                                       |  1359 |         1556 | 78.4% | 81.9% |
| #3002 | `69d8b9c7b` |       9 | yes | —                                                                                       |  1234 |         1452 | 73.2% | 79.1% |
| #3003 | `ac5dfcf06` |       2 | yes | —                                                                                       |   206 |          578 | 29.1% | 28.7% |
| #3001 | `fba2c375e` |      13 | yes | —                                                                                       |  1238 |         1455 | 73.3% | 79.2% |
| #2998 | `ded9b1ca2` |      21 | yes | `prisma/migrations/20260919210000_project_planner_bug_destination_folder/migration.sql` |     — |         1984 |  100% |  100% |

| Window                                 | pull requests | app=false | force-full | measured | median selected / total |   p90 | median cost share | graph alone | above 50% |
| -------------------------------------- | ------------: | --------: | ---------: | -------: | ----------------------: | ----: | ----------------: | ----------: | --------: |
| §3, at `f59db9679` (#2795–#2842)       |            30 |         8 |          6 |       16 |                   20.9% | 77.3% |             18.8% |        0.1% |    3 / 16 |
| last 30, at `1f12eca70` (#2992–#3027)  |            30 |         4 |          8 |       18 |               **73.2%** | 78.4% |             79.1% |       62.2% |   14 / 18 |
| last 260, at `1f12eca70` (#2762–#3027) |           260 |        59 |         83 |      118 |               **66.5%** | 78.2% |             72.6% |       54.4% |  66 / 118 |

It agrees with the legs' own logs: MOTIR-5924 read 15 real `pull_request` runs between 2026-09-20 08:59Z
and 2026-09-21 16:29Z at a median of 73.2%, 11 of 15 above 50%.

**The 118, in consecutive windows of twenty** (median selected / total, and how many above 50%):
#2762–#2796 **66.4%** (10) · #2791–#2826 **20.6%** (6) · #2827–#2872 27.7% (9) · #2874–#2920 24.9% (9) ·
#2926–#2986 **66.5%** (16) · #2993–#3027 **73.2%** (16). **§3's window was the low trough of a bimodal
series**, and the twenty pull requests immediately before it sat at 66.4%. §3 measured correctly; thirty
consecutive pull requests were too few to see the mode it was not in.

### A1.2 — The graph did not invert; the pull requests did

The same script, with §3's sixteen measured pull requests scored against **today's** graph (taken from
the `--limit 260` run above): **median 20.9%**, fourteen of the sixteen within a point of §3's cell.
#2829 moved 21.0% → 24.6%, and #2842 moved 21.4% → 66.6% — its files have since been pulled into the hub. So the graph
grew, but modestly, and the jump from 20.9% to 73.2% is the _mix_: the last month's pull requests are
approval gates, merge queues, CI promotion and job definitions — the product's hub — and user-facing
copy, and every one of those reaches half the suite.

**How much of the codebase is hub**, counted with a probe that rebuilds the edges `getTestDependencies`
walks (the same `transformRequest` → `deps` + `dynamicDeps` rule, `node_modules` excluded) and counts,
for each source module, the spec graphs that contain it:

| At                        | source modules | reached by ≥ half the specs |
| ------------------------- | -------------: | --------------------------: |
| `f59db9679` (1,649 specs) |          1,871 |                 354 (18.9%) |
| `1f12eca70` (1,984 specs) |          2,120 |                 430 (20.3%) |

A fifth of the source tree was already a hub when §4 said GO, and it still is. A pull request that
touches any of those 430 modules pays for about three quarters of the suite.

### A1.3 — The hubs, and each hub's reach

The changed file with the largest reach, for every measured pull request above 50% in the last thirty,
with its reach then and now (specs whose graph contains it):

| Hub                                                | pull requests it carried over 50% | reach at `f59db9679` | reach at `1f12eca70` |
| -------------------------------------------------- | --------------------------------: | -------------------: | -------------------: |
| `messages/en.json`                                 |                                 8 |        1,083 / 1,649 |        1,349 / 1,984 |
| `lib/git/errors.ts`, `lib/git/providers/github.ts` |                                 2 |          997 / 1,649 |        1,234 / 1,984 |
| `lib/approvalGates/gateSet.ts`                     |                                 2 |      (did not exist) |        1,080 / 1,984 |
| `lib/jobs/definitions/pullRequestReconcile.ts`     |                                 1 |      (did not exist) |        1,234 / 1,984 |
| `lib/jobs/definitions/dailyHealthCheck.ts`         |                                 1 |          997 / 1,649 |        1,234 / 1,984 |

And the modules they route through, which a change to any file below them inherits:

| Module                                     | reach at `f59db9679` | reach at `1f12eca70` |
| ------------------------------------------ | -------------------: | -------------------: |
| `lib/i18n/locales.ts`                      |                1,161 |                1,425 |
| `lib/db.ts`                                |                1,051 |                1,294 |
| `lib/ai/motirAiClient.ts`                  |                1,009 |                1,249 |
| `lib/repositories/githubRepoRepository.ts` |                1,002 |                1,239 |
| `lib/git/index.ts`                         |                  997 |                1,234 |
| `lib/i18n/messages.ts`                     |                  879 |                1,100 |
| `lib/github/checkRuns.ts`                  |                  859 |                1,079 |
| `lib/services/workItemsService.ts`         |                  859 |                1,078 |

**Two corrections to the card that commissioned this.** `lib/services/changeRequestStatusSync.ts` is
not a 1,000-spec file — its reach is **313** (136 at the pin). #3026's 1,234 comes from
`lib/git/errors.ts`, the other file in the same diff. And `lib/approvalGates/gateSet.ts` reaches 1,080
because `lib/services/gateSetFor.ts` imports it and `workItemsService` imports `gateSetFor`.

**The edge that ties the hub together is a cycle.** Sixteen modules are one strongly connected
component, so any spec that reaches one reaches all of them and everything they import:
`workItemsService`, `boardsService`, `projectsService`, `approvalGatesService`, `ciPromotion`,
`designEvidenceService`, `dispatchRunService`, `mergeQueueExitService`, `pullRequestMergeService`,
`pullRequestReviewSync`, `syncedMergeRunner` (all under `lib/services/`), and
`lib/approvalGates/{registry,subjectSummary,acceptanceResultHandler,designResultHandler,pullRequestApprovalHandler}.ts`.
It closes because the gate registry's handlers import `workItemsService`, which imports the registry
(MOTIR-4887, #2897), and `ciPromotion` imports `pullRequestReviewSync` → `syncedMergeRunner` →
`pullRequestMergeService` → `ciPromotion`. At `f59db9679` the largest component was a different
fourteen: `lib/git/index.ts`, the GitLab provider and the job registry and engine.

### A1.4 — What cutting an edge buys, simulated

The probe replays the last thirty against the edge set with edges removed; the rule, the always-run set
(recomputed: 408) and the diffs are §3's. Baseline 73.2% · 14 of 18 above 50%.

| Edges removed                                                                                                                                                                           | `workItemsService`'s closure | median selected / total | above 50% |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------: | ----------------------: | --------: |
| none                                                                                                                                                                                    |                          428 |                   73.2% |   14 / 18 |
| `workItemsService` → `ciPromotion`                                                                                                                                                      |                          415 |                   73.2% |   14 / 18 |
| `workItemsService` → `ciPromotion`, `approvalGatesService`, `approvalGates/registry`, `designEvidenceService`, `gateSetFor`, `ciAllowanceService`, `dispatchRunService` (seven at once) |                          346 |                   73.2% |   14 / 18 |
| the two service-layer imports of the catalogue: `workflowsService` and `pullRequestAutoMergeService` → `lib/i18n/messages.ts` (`en.json`'s reach falls 1,349 → 581)                     |                          428 |                   66.5% |   11 / 18 |

**No edge a card could cut brings the median under 50%.** The PR-and-CI hub reaches ~1,080–1,234 specs
by more paths than any one module's imports — route handlers, the job registry, test fixtures — so
removing even seven of `workItemsService`'s outgoing edges together leaves every selection where it was.
The catalogue cut is real (three pull requests fall under the line) and still leaves the median at
66.5%.

**And a lazy import cuts nothing.** `getTestDependencies` follows `transformed.dynamicDeps` (§1), so an
`await import('./ciPromotion')` with a literal specifier is still an edge in the selection's graph. An
edge leaves the graph only by being removed from the code — an injected dependency, an event, a module
split — which is an architecture change, not a CI one.

### A1.5 — The decision: NO-GO, revert the pull-request lane to the full suite

**§4's line was: no-go if the median selected / total over non-force-full pull requests is above 50%.**
Measured: **66.5% over the 118 such pull requests in the last 260** (73.2% over the last thirty's
eighteen), and **83 of 260** hit the force-full set — under half, so that arm still holds. The median arm
does not, and none of the three ways out holds:

- **Keep** — no. The saving §5 bought the ejection trade with (_"the typical pull request's Vitest lane
  falls to ~19% of its cost"_) is now a fall to **72.6%** of its cost on the typical subset pull request
  (79.1% over the last thirty), for the same cost: a break the subset misses is found by the queue.
  MOTIR-5324's wall clock points the same way — a median of **1,274 s** over the latest ten consecutive
  pull-request runs against **875 s** for the ten before the merge. That comparison is not controlled
  (other changes landed between the two windows), so it is recorded here as consistent with the
  decision, not as its basis.
- **Cut a named edge** — no. A1.4: none gets under 50%.
- **Re-decide at a different threshold** — no. The threshold was set before the measurement to keep the
  decision honest, and moving it after the measurement misses would undo that.

So:

| Lane               | Vitest             | Coverage gate                                           | E2E       |
| ------------------ | ------------------ | ------------------------------------------------------- | --------- |
| **Pull request**   | **the full suite** | enforced on a pull request again, as before this record | unchanged |
| **`merge_group`**  | the full suite     | enforced                                                | unchanged |
| **push to `main`** | unchanged (none)   | unchanged                                               | unchanged |

**What the revert carries, and what it keeps:**

1. **`merge-queue.md` §3's _Pull request_ row is restored** — this record's §4 amended it, and this
   amendment takes that back. _"A failure must be visible before queueing, or ejection becomes the
   normal feedback path"_ holds again.
2. **`ci.yml`'s `test` job loses the select step and the subset step, and the `vitest-full` label stops
   meaning anything.** §5's re-decided `fail-fast` goes back to the reason `ci.yml` first gave for it:
   affordable on `merge_group` because the pull-request lane runs the whole suite.
3. **`scripts/ci/measure-affected-tests.mjs` keeps its MEASURE mode**, and `.github/ci/full-suite-paths.txt`
   with it. They are what re-opens this record: **re-run the measurement over at least the last 100 pull
   requests; if the median selected / total over the non-force-full ones is under 50%, subset selection
   can come back without re-deriving §1–§2.** Whether SELECT mode stays in the script is the revert
   card's call — nothing reads it once the step is gone.
4. **The hub is still worth cutting, for the build and the type-checker if not for this lane.** The
   sixteen-module cycle in A1.3 is a real architecture finding, and it is not scheduled by this record:
   cutting it would not re-open this lane on A1.4's numbers.

The revert is implemented by its own card, proposed alongside this record's pull request.
