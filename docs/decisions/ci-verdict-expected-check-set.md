# The CI verdict establishes the commit's check set instead of inferring it

**Status:** accepted · **Card:** MOTIR-4199 · **Date:** 2026-09-03
**Supersedes nothing. Amends:** `docs/decisions/ci-feedback-comment-per-card.md` (MOTIR-2946 /
MOTIR-3770) and the promotion contract in `lib/services/ciPromotion.ts` (MOTIR-3006 · MOTIR-3685 ·
MOTIR-3823).

---

## The observation

On 2026-09-02, at `20:45:57.664Z`, Motir wrote this onto MOTIR-3941:

> ✅ **CI passing** — all **3** checks succeeded on the linked pull request. This work is verified.

and promoted the card `implemented → in_review`. The commit — `4eae3f0`, on
moooon-B-V/motir-ai#367 — had **five** jobs, all queued at `20:45:26Z`:

| check                                    | status at 20:47                                       |
| ---------------------------------------- | ----------------------------------------------------- |
| TypeScript build                         | `success`, completed `20:45:58Z`                      |
| Boot smoke (native-ESM interop)          | `success`, completed `20:45:56Z`                      |
| Prettier                                 | `success`, completed `20:46:09Z`                      |
| **Vitest**                               | **still running** — the repository's 3 000-test suite |
| **Indexer image / Build, assert, prove** | **still running**                                     |

Nothing was red, so nothing looked wrong. Had Vitest gone red, the card would have sat at In Review
carrying a comment saying it was verified.

## The mechanism

Three derivations, one shared premise:

- `changeRequestCiFeedback.deriveCiState` — _any `failure` → failing; else any `success` → passing;
  else null_. Its own doc says non-terminal rows "never gate the verdict".
- `summarizeChecks` — `total` is `rows.length`, `pending` is how many of those rows are `pending`.
  With no pending ROW recorded, `pending` is `0` and the comment renders the terminal form.
- `prCiState.derivePrCiState` — which BOTH promotion edges ask — returns `running` when a live row at
  the head sha is `pending`. So the promotion fires exactly when the table holds no pending row.

**All three read "no pending row" as "nothing is pending".** Nothing in the path knew how many checks
the commit HAS. GitHub delivers check runs one webhook at a time, so a recorded set that is a PREFIX
of the real set is not an edge case — it is the ordinary state of every pull request for the first
minutes of its life, and the promotion fires on the first terminal green inside that window whenever
the pending rows for the slower jobs have not landed yet.

It is the twin of MOTIR-3823 (_"In Review is a promise to a person, made here before the build has
spoken"_) arriving through a different door: not `null` read as green, but a PARTIAL set read as
complete. It takes the same shape of remedy — **a fact established, not an absence inferred.**

## The decision

**Ask the host, and write the answer into the table every derivation already reads.**

1. `lib/github/checkRuns.ts` gains `readCommitCheckRuns` — `GET /repos/{owner}/{name}/commits/{sha}/check-runs?filter=all`,
   under the `checks: read` permission the App already holds, mapped through the GitHub provider's own
   `mapGithubCiConclusion` so a row written from a REST read is indistinguishable from the row that
   delivery would have written.
2. `lib/services/checkSetReconcile.ts` writes a `github_check_run` row for every reported check the
   recorded set is missing.
3. Nothing downstream learns a new concept. A `pending` row at the head sha ALREADY makes
   `summarizeChecks` render `⏳ CI running — 3 of 5 checks complete`, ALREADY makes `derivePrCiState`
   return `running`, and `running` is ALREADY what both promotion edges withhold on. The defect was
   never in how the folds treat what they see; it was that they could not see two of the rows.

### Where it is called from, and why in two places

| edge                                               | how it reaches the reconcile                                                                                                                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the CI-feedback consumer (`applyCiStatusFeedback`) | through the provider-supplied `CiFeedbackContext.readReportedCheckSet` callback — the same seam `buildChecksUrl` arrives on, so the consumer stays provider-agnostic and GitLab supplies none |
| `promoteIfCiAlreadyGreen` (the ARRIVAL edge)       | directly, with an injectable reader defaulting to the real one                                                                                                                                |

The arrival edge needs its own call because it has no delivery behind it: it fires the moment a card
reaches `implemented`, which a run does right after `gh pr create` — when the recorded set is at its
most partial. Left reading only what is recorded it would promote three-of-five for exactly the reason
edge 1 no longer does, and the two edges would disagree in precisely the window edge 2 exists for
(`ciPromotion.ts`'s own header: _the latch only works if the two edges ask the same question of the
same set_).

## The cost, measured

**One round trip per delivery that would otherwise assert a verdict** — that is, only when the
recorded set CLAIMS to be complete (at least one live row at the head sha, none of them `pending`).

- In the healthy case, GitHub's `created` / `in_progress` deliveries record `pending` rows before the
  slow lanes finish, so the set never claims completeness and **no call is made at all**.
- In the fixture's case the claim is made on the first terminal delivery, the reconcile fills in the
  missing rows, and every subsequent delivery at that commit sees a pending row and pays nothing.
  `tests/github/ciExpectedCheckSet.test.ts` asserts this directly: three successes on a five-job
  commit produce **one** host call, not three.
- A motir-core pull request carrying ~34 checks therefore pays for one round trip, not thirty-four.

The call is made OUTSIDE the transaction in both paths. On the feedback path the snapshot is taken
before `githubPullRequestRepository.lockById`; on the arrival edge the pass is three phases (read the
members, ask the host, write what is missing) rather than one, so no connection is held open on
GitHub's latency.

## What it does NOT answer — the failure modes, stated

1. **It is a snapshot of the runs the host has CREATED.** A workflow that has not started at all — a
   `workflow_dispatch` nobody fired, a job queued after the call — is in no snapshot and cannot be. The
   window narrows from _however many webhooks have been processed_ to _however many runs the host has
   created_. That is the whole of the improvement and the whole of the limit.
2. **A path-filtered workflow legitimately reports fewer checks than it defines**, and this is
   invisible to the reconcile and correctly so: the host reports the runs it created for THIS commit,
   which is exactly the set the verdict should be about. A repository whose `ci.yml` skips its app
   lanes on a docs-only diff reports the lanes it ran, and the card is judged on those.
3. **`null` is "no answer", not "no checks".** An unconfigured App, an unmintable token, an
   unreachable host, a 403, an unparseable body, or a commit carrying more than 500 check runs all
   answer `null`, and every caller then falls back to the recorded set — i.e. to the behaviour that
   shipped before this card. **A transient GitHub outage costs the sharper verdict rather than
   stalling every card behind it.** The opposite choice (withhold on `null`) was rejected: it converts
   an outage into a fleet-wide stall of every card at Implemented, with no signal saying why.
4. **The reconcile writes the host's OWN conclusion, not `pending` for everything it lacked.** Writing
   `pending` looks more conservative and is worse: a dropped webhook delivery would leave a card held
   at Implemented for ever behind a row nothing will refresh. The two transports describe the same
   checks, so a run the host reports as completed is recorded as completed — which makes a dropped
   delivery **self-healing**. The webhook's own later delivery upserts the identical value and is a
   no-op.
5. **It only ever CREATES** (`githubCheckRunRepository.createMissing`, `createMany` with
   `skipDuplicates`). The snapshot is taken outside the writing transaction, so a delivery about one of
   these checks may land in between; the unique key
   `(pull_request_id, commit_sha, check_name, check_suite_id)` is the arbiter, and a row that exists
   wins whatever the snapshot believed about it. That is what lets the arrival edge's pass run with no
   lock of its own, and it is why a `pending` written here can never overwrite a terminal conclusion.
6. **GitLab is unchanged.** Its provider supplies no `readReportedCheckSet`, so its verdicts are
   formed exactly as before. Closing that half is a separate card.

## The alternative that was not taken

The card named a second candidate: **record the EXPECTED set from the `workflow_run` / `workflow_job`
deliveries motir-core already handles** — a `workflow_job` `queued` names a job before its `check_run`
reports, so the feedback could know the commit has five jobs when three have completed. No extra call.

Rejected, for three reasons:

- It needs new persistence (an expected-set table keyed per `(repo, sha, run)`) where candidate 1
  needs none — the reconcile fills in the table that already exists.
- `handleWorkflowJob` today routes to `ciRunnerProvisioningService`, whose parser is scoped to fleet
  jobs; a general expected-set recorder is a different subscription and a different consumer.
- It depends on job events arriving before the last check completes, which the card itself calls
  "the normal order but not a guaranteed one". Candidate 1 asks the party that KNOWS, at the moment the
  answer is needed, and is exact.

## What is asserted

`tests/github/ciExpectedCheckSet.test.ts`, against real Postgres and the real promotion path:

- three successes on a five-job commit write the interim `3 of 5` comment and promote nothing; the
  two missing checks are recorded as `pending` rows;
- the same sequence completed writes the terminal comment ONCE (one comment, edited in place) and
  promotes; a fourth success plus a fifth `failure` writes `CI failed — 1 of 5` and holds the card at
  Implemented;
- **both edges separately** — `promoteDeliveredCardsOnGreen` returns `[]` and `promoteIfCiAlreadyGreen`
  returns `false` on that same set; and the arrival edge asks the host itself when nothing has
  reconciled before it;
- the control: the identical deliveries with no host callback reproduce the defect verbatim
  (`all 3 checks succeeded`, card at In Review), so the fixture cannot pass for an unrelated reason;
- the cost rules — not paid while a pending row is recorded, paid once per claim, falls back on a
  `null`, records nothing on an empty answer;
- the reconcile never overwrites a terminal row, and a dropped delivery self-heals.

MOTIR-3823's own criteria are unchanged and still green (`tests/github/ciGreenPromotion.test.ts`): a
repository that CANNOT report still counts as green, and a pull request with zero rows in a repository
that CAN report is still not promoted.
