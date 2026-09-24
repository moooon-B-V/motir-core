# The Playwright lane keeps reading `app`, and gets no path gate of its own — the share is 8.4% over 300 pull requests, not the 25% a 40-pull-request sample read

**Status:** accepted — **NO-GO** by the commissioning card's own criterion 1 ·
**Card:** Bug **MOTIR-6222** · **Date:** 2026-09-24 ·
**Evidence pinned at:** `motir-core` `origin/main` @ `8cac9804b455715081e36622511e5c60fac4ff60` ·
**Instrument:** [`scripts/ci/measure-e2e-reachability.mjs`](../../scripts/ci/measure-e2e-reachability.mjs)

> The question: **`ci.yml`'s `changes` job emits one `app` boolean and six jobs read it, so a pull
> request touching only the CLI package runs twelve Playwright legs for ~63 runner-minutes. Should
> `e2e` get its own narrower flag?** §1 is the mechanism, which is real. §2 is the measurement, which
> is what decides it. §3 is the decision. §4 is what it does not decide.

MOTIR-6222 wrote itself a falsification test and required that it be honoured:

> _"If the share of app=true pull requests with no E2E-reachable file comes out materially below the
> sample's 25%, this card is a NO-GO and says so — the same discipline `ci-affected-tests.md`
> Amendment 1 applied to itself, and a card that cannot fail its own measurement is not measuring."_

It came out at **8.4%**. This record is that NO-GO.

---

## §1 — The mechanism, which is not in dispute

`.github/workflows/ci.yml`'s `changes` job classifies each changed path with a DENY-list and emits
`app`; six jobs gate on it — `test` (Vitest, 12 shards), `coverage`, `e2e` (12 Playwright legs),
`e2e-at-scale`, `story-4753-coverage`, `story-4905-coverage`. To that classifier a change to
`packages/cli/sandbox/Dockerfile` is indistinguishable from a change to `app/page.tsx`.

**The cost half of the card's claim is confirmed.** Ten Playwright legs, measured on three real
green `pull_request` runs:

| run           | E2E legs | E2E runner-minutes | whole run |
| ------------- | -------: | -----------------: | --------: |
| `36042948894` |       10 |               64.1 |     256.6 |
| `36013589581` |       10 |               61.9 |     339.5 |
| `36010838459` |       10 |               63.9 |     268.1 |

So ~63 runner-minutes per skipped lane, against the card's ~62. Nothing below disputes the
mechanism or the unit cost. What the measurement moves is **how often the case arises**.

## §2 — The measurement, over 300 merged pull requests

`scripts/ci/measure-e2e-reachability.mjs` LIFTS the `classify` step's shell body out of `ci.yml` and
executes it per pull request, so `app` is decided by the classifier that ships rather than by a copy
of it. `main` squash-merges, so each first-parent commit whose subject ends `(#<n>)` is one merged
pull request and `<sha>^...<sha>` is its diff as merged — the same derivation
`measure-affected-tests.mjs` uses, needing no network and no credential.

```sh
node scripts/ci/measure-e2e-reachability.mjs --at 8cac9804b --limit 300
```

### §2.1 — The instrument reproduces the card's number exactly

Run over the **last 40** pull requests it answers **9 of 36 = 25.0%**, and names the same nine the
card named: #3094, #3090, #3089, #3086, #3085, #3081, #3075, #3074, #3070. The card measured
correctly. So the disagreement below is not about the instrument.

### §2.2 — And the number falls away as the window widens

| window   | app=true | no E2E-reachable file |     share |
| -------- | -------: | --------------------: | --------: |
| last 40  |       36 |                     9 | **25.0%** |
| last 100 |       89 |                    10 |     11.2% |
| last 150 |      128 |                    11 |      8.6% |
| last 200 |      161 |                    12 |      7.5% |
| last 250 |      199 |                    14 |      7.0% |
| last 300 |      238 |                    20 |  **8.4%** |

**The 300, in consecutive windows of forty** (no-reachable / app=true), newest first:

`#3103–#3058` **25%** · `#3059–#3010` 3% · `#3014–#2978` 3% · `#2943–#2940` 0% ·
`#2939–#2899` 4% · `#2895–#2847` 7% · `#2857–#2816` 7%

**The card's window is the only crest in the series, and every other window is 0–7%.** It is the
`packages/cli` sandbox cluster — #3094, #3090, #3089, #3086, #3070 are all sandbox-image or CLI-package
work landing in the same few days. `ci-affected-tests.md` Amendment 1 met the mirror image of this
("§3's window was the low trough of a bimodal series"); forty consecutive pull requests are too few
to see the mode they are not in, in either direction.

### §2.3 — And the card's proposed allow-list over-counts the saving

The card's _Direction_ names the reachable surfaces as
`app/`, `components/`, `lib/`, `messages/`, `prisma/`, `public/`, `tests/e2e/`,
`packages/design-system/`, `playwright.config`, `next.config`, `middleware`. Scored against shipped
reality that list is wrong in both directions:

- **`middleware` does not exist in this repository** — there is no `middleware.ts` at the root.
- **It omits surfaces a Playwright run demonstrably reads**, each of which is a pull request the flag
  would have skipped while the browser could see the change: `hooks/**` (imported by `app/` and
  `components/`), `instrumentation.ts` (which `next.config.ts`'s own comment describes as carrying
  the E2E boundary mocks), `packages/brand/**` and `packages/orchestrator/**` (imported by
  `app/globals.css`, `components/brand/`, `lib/ciFleet/`), `scripts/**` (`tests/e2e/` imports
  `scripts/seedLargeBoard`), `tests/helpers/**` and `tests/fixtures/**` (imported by the specs), and
  the root build inputs `package.json`, `pnpm-lock.yaml`, `tsconfig*.json`, `postcss.config.mjs`,
  `proxy.ts`, `sentry.*.config.ts`.

Scored with the card's own list the 300-pull-request share is **13.1%**; with the evidence-based list
the script carries it is **8.4%**. The difference is entirely pull requests the card's list would
have skipped E2E on _wrongly_ — the fail-CLOSED direction the `changes` job's own comments call
"the defect this job was written to remove". **Even taking the card's more generous list at face
value, 13.1% is materially below 25%.**

**The verdict does not rest on the debatable entries.** Dropping the three groups a reader is most
likely to argue with — `scripts/**`, `tsconfig*.json` and `tests/helpers/**` — moves seven pull
requests, to **11.3%**, and calling the whole of `tests/**` outside `tests/e2e/` unreachable is what
produces the card's own 13.1%. **Every reading of the reachable set lands between 8.4% and 13.1%**,
and none of them is near 25%.

## §3 — The decision

**`e2e` keeps gating on `app`. No `app_e2e` output is added, and no job's `if:` changes.** At 8.4%
of app=true pull requests the gate buys ~63 runner-minutes on about one pull request in twelve,
against a new classifier arm whose direction is INVERTED relative to every other arm in that job: the
existing rule is a deny-list that fails OPEN, and an allow-list over "surfaces a browser can reach"
fails CLOSED on every path nobody anticipated. §2.3 is that hazard already realised — the card's own
list, written carefully by someone who had just read the classifier, missed seven reachable surfaces.

The saving is real but small and the failure it risks is silent. That is the trade the commissioning
card's criterion 1 anticipated, and its instruction on this outcome was explicit.

**`scripts/ci/measure-e2e-reachability.mjs` is KEPT as the instrument that re-opens this**, on
`ci-affected-tests.md` A1.5 point 3's precedent: re-running the measurement is what re-opens the
decision. Re-run it over at least the last 100 merged pull requests. **If the share is durably at or
above 25% — a crest that persists across consecutive windows rather than one window's cluster — the
gate can be written without re-deriving anything above.** The `changes` job would then gain an
`app_e2e` output, `e2e` would read it, and `test` / `coverage` / `build` and the two story-coverage
jobs would keep reading `app`.

`tests/ci-changed-paths-gate.test.ts` pins this verdict: `e2e` still gates on `app`, no `app_e2e`
flag exists, and §2.3's reachable list is the script's, not a second copy.

## §4 — What this does NOT decide

- **Whether the CLI package's paths should be excluded from `app` itself.** They should not, and that
  is settled elsewhere rather than here: root Vitest suites genuinely read them
  (`tests/ci-changed-paths-gate.test.ts` re-derives the image patterns from the workflows,
  `tests/reader-facing-noun.test.ts` scans `packages/cli/sandbox/README.md`), so narrowing `app` is
  the question `ci-affected-tests.md` Amendment 1 already answered. This record does not reopen it.
- **Which Vitest FILES a pull request runs.** That is `ci-affected-tests.md`'s question — _which
  files inside a lane an import graph reaches_ — and Amendment 1 reverted the selection at a median
  66.5%. This record asked whether a LANE runs at all. The two share a file and nothing else, and
  neither answers the other.
- **Whether the E2E lane costs too much.** ~63 runner-minutes over ten legs, of which a measured 45%
  is per-leg boot rather than test work, is a real number and a separate question; `ci.yml`'s `e2e`
  job comment already names halving the boot as the better lever and calls it a separate
  investigation. Nothing here makes that cheaper or more expensive.
- **The `e2e-at-scale`, `story-4753-coverage` and `story-4905-coverage` jobs.** They also read `app`.
  `e2e-at-scale` is additionally label-gated and already skips by default; the two story-coverage
  jobs were not measured. A future gate for any of them is its own card with its own measurement.
