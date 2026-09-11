# ADR: A ratchet constant stays branch-measured — the failure MESSAGE is what changes

- **Status:** Accepted (2026-08-17)
- **Story / Subtask:** MOTIR-2832 (Make `motir_app` the suite's default) · Bug MOTIR-2941
- **Extends:** MOTIR-2784's ratchet convention (a number that may only fall, so a
  descent is visible) and MOTIR-2939's per-commit re-measurement of
  `UNCONVERTED_E2E_CEILING`.
- **Consumed by:** every guard under `tests/rls/` that declares a
  `*_CEILING` / `*_FLOOR`, and every guard added after this one — enrolment is by
  NAME, so there is no list to join.
- **Supersedes / superseded by:** none. **AMENDED 2026-09-12** (MOTIR-5207) — see
  _AMENDMENT 1_ below, which disposes of option 2's supersession trigger and widens
  enrolment. The 2026-08-17 record is unchanged.

> Structured **Context → Decision → Consequences → References**, the convention the
> repo's ADRs set. No product behaviour ships with this decision. What it freezes is
> the answer the next ratchet author would otherwise re-invent, and the reason the
> obvious fix was not taken.

---

## Context

### The mechanism

A ratchet constant records a measurement of a POPULATION taken at one commit, and
that commit is a branch tip. Between the measurement and the merge, siblings merge
their own work. If any of it touches the counted population, the constant now
describes a tree that no longer exists — and the guard fires on the composed tree
that nobody ever measured.

Nothing is wrong with anybody's change. Each was correct in isolation and each was
green in isolation. The **composition** is what fails, and no individual author was
in a position to see it, because the composed tree does not exist until the second
merge creates it.

### The first instance, in full

MOTIR-2939. `UNCONVERTED_E2E_CEILING` shipped as **454**, measured on MOTIR-2918's
branch at `bd0584c5`. `22316a62` merged **seven minutes** ahead of it, adding three
undispositioned statements. The true count at the merge was 457, so `05ac5337` —
the ratchet's own merge commit — was **red on arrival**, and every open PR
inherited it, because PR CI checks out the branch merged with `main`.

**The expensive half was not the fix.** The fix was five statement conversions. The
expense was that the failure message said _"a spec was written that seeds through
`@/lib/db`"_ — a specific, confident, and false accusation — and the whole cost was
proving that nobody had done it. The message was working exactly as designed. That
is what makes this a design defect rather than a bug.

### Why now, rather than after the second occurrence

**A ratchet of exactly 0 is the only immune value:** a count cannot fall below zero
and a floor of zero cannot fail, so nothing merging beneath one can move it. Every
ratchet written before MOTIR-2918 sat at zero or was the first of its kind, so the
class was invisible by luck rather than by design. The first non-zero one failed
within an hour of landing. As of this ADR, **seven of the eight** ratchets under
`tests/rls/` are non-zero.

### The enumeration

The card asked for every ratchet constant under `tests/rls/` enumerated with its
value. **That enumeration is a scan, not a table here** —
`tests/rls/ratchetScan.ts`, consumed by `tests/rls/ratchet-staleness-guard.test.ts`.

The reason is this ADR's own subject: a hand-written table of population counts,
transcribed into the source tree, is precisely the artifact that goes stale when a
sibling merges. MOTIR-2945 was in flight against `bare-transaction-guard.test.ts`
while this shipped and is expected to move `GATED_BARE_TRANSACTION_CEILING` off 8.
A table here would have been falsified by that merge — the second instance of the
defect, committed inside the document that diagnoses it. A derived enumeration
cannot be.

At `origin/main` @ `45dd9a48` the scan finds eight, and the SHAPE (not the values,
which move) is what this ADR relies on:

| ratchet                          | file                                     | direction | exposed |
| -------------------------------- | ---------------------------------------- | --------- | ------- |
| `UNREVIEWED_CEILING`             | `singleton-read-guard.test.ts`           | ceiling   | no — 0  |
| `UNBOUND_CALL_SITE_CEILING`      | `call-site-guard.test.ts`                | ceiling   | yes     |
| `BARE_TRANSACTION_CEILING`       | `call-site-guard.test.ts`                | ceiling   | yes     |
| `GATED_BARE_TRANSACTION_CEILING` | `bare-transaction-guard.test.ts`         | ceiling   | yes     |
| `UNCONVERTED_E2E_CEILING`        | `test-singleton-statement-guard.test.ts` | ceiling   | yes     |
| `UNCONVERTED_VITEST_CEILING`     | `test-singleton-statement-guard.test.ts` | ceiling   | yes     |
| `RAW_CEILING`                    | `test-singleton-statement-guard.test.ts` | ceiling   | yes     |
| `UNTOUCHED_OUT_OF_SCOPE_FLOOR`   | `test-call-site-guard.test.ts`           | **floor** | yes     |

**Two things the card's own four-name list did not have**, and which only reading
the files produced:

1. **`UNTOUCHED_OUT_OF_SCOPE_FLOOR` is a FLOOR**, asserted with
   `toBeGreaterThanOrEqual`. It is exposed in the OPPOSITE direction: a sibling
   that legitimately binds or deletes an out-of-scope call site drops the count
   below 49 and turns it red. Its message accuses the reader of "helpfully binding"
   a line that was never broken — the same false accusation, arrived at from the
   other side. A rule written only for ceilings would have missed it.
2. **`UNREVIEWED_CEILING` is doubly immune** — it is 0, and it counts entries in a
   hand-written `VERDICTS` map rather than a population of the tree, so no merge
   can reach it at all.

Bare numeric sanity floors (`expect(all.length).toBeGreaterThan(200)`) are
deliberately **not** ratchets: they carry no named constant, they sit an order of
magnitude away from the population precisely so ordinary movement cannot reach
them, and there is nothing to re-measure when one fires. The naming convention is
the enrolment mechanism — a number worth ratcheting is a number worth naming. The
latency ceiling in `shared-read-seams.test.ts` (`elapsedMs < 2_500`) is excluded on
that ground plus one more: it measures the machine, not a population, so
`origin/main` cannot adjudicate it.

---

## Decision

**The constants stay branch-measured. Every non-zero ratchet's failure message
opens by telling the reader to re-measure at `origin/main` before looking for a
culprit, and a meta-guard enforces that on every ratchet, including ones added
later.**

Concretely:

- `tests/rls/remeasureFirst.ts` renders the preamble, once, for all of them.
- `tests/rls/ratchetScan.ts` derives the ratchet set from the guards by AST.
- `tests/rls/ratchet-staleness-guard.test.ts` fails the build when a non-zero
  ratchet's message does not reach the preamble, when a ratchet is declared but
  never asserted, or when the scanner stops finding any exposed ratchet at all.
- A ratchet at exactly 0 is exempt. The exemption is enforced rather than
  documented, so a ratchet that later moves OFF zero starts failing the meta-guard
  — at exactly the moment it becomes exposed.

### What this rejects, and why

**(1) Derive the ceiling from `origin/main` at run time.** Rejected.

It is the fix that removes the staleness rather than explaining it, and the price
is larger than it first looks. The guard would need not a git _object_ but a
materialised `origin/main` copy of every scanned path — the scanners walk `lib/`,
`app/` and `tests/` — and then a second full TypeScript parse of it. That is a
worktree checkout inside a test that today costs milliseconds and is pure. It also
makes the result environment-dependent: CI's `actions/checkout` is shallow by
default, and a developer whose `origin/main` is a week stale would measure against
a different baseline than the runner. **And it changes what the number MEANS.** A
ratchet is a promise that a value only falls, recorded once, so nobody has to think
about it again; a value re-derived from `main` on every run is a diff, not a
promise, and the descent stops being visible in the history. Reintroducing
staleness-proofing at that price is a bad trade for a class whose only real cost so
far has been a wrong accusation.

**(2) Re-measure in a merge queue.** Rejected _here_, and it is the structurally
correct answer.

A merge queue runs CI on the composed tree before the merge, which is exactly where
this class first exists — so it would catch not only stale ratchets but every
semantic conflict between two independently-green PRs. There is no merge queue in
this repo today. Introducing one is a repository-infrastructure decision with a CI
minutes cost (`docs/decisions/ci-minutes-allowance.md`) that reaches far past
`tests/rls/`, and it is not a test card's to make. Recorded here as the candidate a
future infrastructure card should weigh, **not** as something this ADR forecloses:
if a merge queue ever lands, this decision is superseded and the preamble becomes
redundant rather than wrong.

> ⚠️ **BOTH SENTENCES ABOVE ARE NOW FALSE, AND NOT IN THE SAME WAY. A merge queue
> HAS landed — and it did NOT supersede this decision.** The premise ("there is no
> merge queue") was retired by infrastructure; the PREDICTION ("the preamble becomes
> redundant") was falsified by measurement. **AMENDMENT 1 (2026-09-12, MOTIR-5207)**
> is the disposition. Read it before citing this paragraph.

**(3) Accept staleness and make the failure legible.** Accepted, and the reason it
is not a cop-out is the diagnosis: **the guard is not misfiring.** The count really
did move; the assertion is correct; the only false thing in the entire event is the
sentence explaining it. A fix that changes when the guard fires is treating a
correct instrument as broken. A fix that changes what it SAYS repairs the only part
that was wrong.

Option 3 was named in MOTIR-2941 as "the floor that should ship whatever else is
chosen". Having priced 1 and 2, it is not the floor — it is the whole answer.

---

## Consequences

**What improves.** The reader of a red ratchet is told, in the first line, that the
movement may not be theirs, and given the command that settles it. The MOTIR-2939
diagnosis — reproduce on a clean worktree at `origin/main`, then measure per commit
across the window — becomes the first thing tried instead of the last.

**What does not.** Ratchets still go stale, `main` can still go red on a merge
commit, and the fix is still a human re-measurement. This decision buys the reader's
time, not the build's.

**Cost of being wrong.** Low and reversible. If the class recurs often enough to
justify option 1 or 2, nothing here blocks it: the preamble becomes redundant text
and the meta-guard is deleted in one commit.

**When to delete all of this.** When every ratchet under `tests/rls/` reaches zero,
the class is closed — nothing can merge beneath a zero. The meta-guard asserts that
at least one exposed ratchet exists, so that day arrives as a red build with an
instruction rather than as a suite that silently checks nothing.

**A note on the direction of the guarantee.** The meta-guard proves each ratchet
REACHES `remeasureFirst`; a separate test pins what `remeasureFirst` SAYS. Neither
is sufficient alone, and keeping them apart is deliberate: a wording change should
not be able to unenroll a ratchet, and a new ratchet should not be able to pass by
copying the words.

---

## References

- `MOTIR-2939` — the first instance: the per-commit measurement, the stale 454, and
  the bespoke preamble this decision generalises.
- `MOTIR-2918` — the guard whose merge commit was red on arrival.
- `MOTIR-2784` — the ratchet convention itself (a number that may only fall).
- `tests/rls/remeasureFirst.ts` · `tests/rls/ratchetScan.ts` ·
  `tests/rls/ratchet-staleness-guard.test.ts` — the implementation.
- `docs/decisions/ci-minutes-allowance.md` — the budget a merge queue would draw on.

---

## AMENDMENT 1 — the merge queue landed, and it does NOT supersede this decision (2026-09-12, MOTIR-5207)

**Status:** Accepted. The 2026-08-17 record above stands unchanged; this disposes of
its own supersession trigger and widens the enrolment rule its Decision relies on.

### The trigger fired, unobserved

Option 2 was rejected on one stated ground — _"There is no merge queue in this repo
today"_ — and the paragraph named the condition under which the whole decision would
retire. That condition has been met, and nobody was watching for it. Read from the
platform rather than from a config file in this repo:

```
gh api repos/moooon-B-V/motir-core/rulesets/17227448
  name: protect-main · enforcement: active · ref: ~DEFAULT_BRANCH
  rules[].type: merge_queue
    grouping_strategy: ALLGREEN · max_entries_to_build: 3 · max_entries_to_merge: 5
    merge_method: SQUASH · check_response_timeout_minutes: 60
```

So the repository has been running **the structurally correct answer and the
workaround for its absence at the same time**, with an accepted decision record
asserting the workaround was necessary because the answer did not exist.

### The disposition: the queue changes WHERE the failure is met, not WHAT it says

**The preamble is NOT redundant, and the prediction that it would be was wrong for a
reason the incident makes plain.** The evidence is the very event that proves the
queue landed. PR #2818 was green on its own branch and lost **two** merge-queue slots
— queued 19:47:23Z, ejected 21:27:56Z:

| run           | base        | job                              | result  |
| ------------- | ----------- | -------------------------------- | ------- |
| `34643738460` | `6df778b41` | `103409428163` Structural guards | 443/444 |
| `34646088683` | `da24c99fc` | `103417105853` Structural guards | 443/444 |

Both failed the same assertion with the same 32 rows, because `c7c8f22a9` (#2809) and
`da24c99fc` (#2811, merged **26 seconds** before the queue request) had added specs
the ratchet's seed never saw. The queue did exactly what option 2 promised: it built
the composed tree and caught the staleness there, before `main` went red. **And the
human standing in front of it met this:**

> _"These page-rooted strict locators are **NEW** — they are in tests/e2e and not in
> the allow-list, so this guard is the first thing to see them."_

Specific, confident, and false — the locators were four hours old on `main` and were
written by two other people in two other cards. That is verbatim the failure this ADR
exists to prevent, occurring **inside** the mechanism that was supposed to make it
redundant.

**The two mechanisms are orthogonal, and the ADR's own diagnosis is why.** Its
Decision section already says it: _"A fix that changes when the guard fires is
treating a correct instrument as broken. A fix that changes what it SAYS repairs the
only part that was wrong."_ A merge queue changes **when** — it moves the composed-tree
failure from `main` to the queue. The preamble changes **what it says**. Option 2 was
never an alternative to option 3; it was an answer to a different half of the problem,
and calling it _"the structurally correct answer"_ obscured that.

**If anything the queue RAISES the preamble's value.** A queue reports a stale
baseline as an **EJECTION** — a merge that did not happen — which is a worse artifact
to read than a red check on your own pull request, not a better one: there is no
review surface attached, the run is against a tree that exists nowhere in your
worktree, and the eviction is easily read as infrastructure flakiness. So
`remeasureFirst` now names the queue outright, and that sentence is pinned by a test.

### What this ADR still rejects, and what it now claims

- **Option 1** (derive the ceiling from `origin/main` at run time) — rejected,
  unchanged, on the prices the original Decision gives.
- **Option 2** (re-measure in a merge queue) — **SHIPPED, and it is not this ADR's**:
  it protects the trunk. It supersedes nothing here. The preamble convention stands
  and is **extended**, not retired.
- **Option 3** (accept staleness, make the failure legible) — stands, and it is now
  enforced over a wider population, below.

**When this decision WOULD retire:** not on a merge queue — that question is settled
here. It retires when a mechanism removes the WRONG SENTENCE rather than relocating
the failure. Deriving each baseline from `origin/main` at failure time would do it;
nothing else on the table does.

### AMENDMENT 1b — enrolment by NAME was a narrower net than it reads as

The Decision's _Consumed by_ line says _"enrolment is by NAME, so there is no list to
join"_, and the enumeration section is careful about the ratchets it could see. Both
were true of a NUMBER, in ONE directory. They caught nothing else, and the first
instance outside that shape arrived within hours of being written:

- `scanRatchets` read `tests/rls/` **non-recursively**, and enrolled a
  `const <NAME>_CEILING|_FLOOR = <n>` plus the comparator reading it.
- MOTIR-5037's ratchet is a **SET** — `tests/helpers/pageRootedLocatorAllowList.json`,
  an `ids` array asserted tight in both directions by
  `tests/e2e-page-rooted-locators.test.ts`. Neither file is under `tests/rls/` and
  neither declares a named number. `grep -rl remeasureFirst tests/` returned six
  files, all `tests/rls/`.

**The convention did not fail to hold. It failed to notice there was something to
hold.** So enrolment now answers _"which GUARD holds a baseline a sibling's merge can
move?"_, in two shapes, both derived, neither a list:

| shape        | enrolled by                                                                                         | obligation                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **CONSTANT** | `const <NAME>_CEILING`/`_FLOOR = <non-negative INTEGER>`, anywhere under `tests/`, recursively      | the assertion the COMPARATOR attributes to it opens with `remeasureFirst` — the original rule, intact |
| **CONTRACT** | a checked-in JSON under `tests/` declaring a numeric `count` beside an array of exactly that length | **every** `expect(value, message)` in the guard that reads it opens with `remeasureFirst`             |

**Why the CONTRACT obligation is file-wide rather than per-assertion.** A constant is
attributed through the comparator that reads it. A contract has no comparator to
follow — MOTIR-5037's guard computes its offender list in one statement and asserts it
in the next — so there is no identifier for an attribution to walk. What survives the
loss is the question the preamble answers: _when this guard is red, is the reader told
the movement may not be theirs?_ That is a property of every message the guard can
print. An `expect` with **no message argument** is out of scope, on the same ground
this ADR already excludes a bare numeric sanity floor: it accuses nobody.

**Why the contract predicate is `{count, array}` and not a path.** `tests/helpers/`
holds both of MOTIR-5037's artifacts, and the guard's own header argues at length that
they are different kinds of thing: the hand-shrunk **contract** and
`pageLocatorInventory.json`, the re-generated **evidence** whose note says _"DATED
EVIDENCE, not a contract"_. The evidence file declares no top-level `count`, so the
distinction the prose argues for falls out of the shape. That is what makes it a rule
and not a list.

### What the widening FOUND, which is why it is not tidiness

**`SERIAL_READ_CEILING = 4`** — `tests/navigation/loading-boundary-guard.test.ts`,
live since MOTIR-3449, one directory outside the old flat walk. A ceiling over 87
pages, fully exposed (a sibling merging a page with five serial reads moves it), whose
failure printed a **bare array diff and no instruction at all**. It now carries the
preamble, and its real assertion is stated in comparator form so the meta-guard can
attribute it. Its re-measure command is its own path, not `pnpm test:guards`: it runs
in the sharded root job, not the structural-guard lane.

### Explicitly OUT of scope, with the reason recorded

Per this amendment's own standard — a shape is either enrolled by a derived rule or
excluded with its reason written down, never left to a list.

- **A non-integer value.** A ratchet counts a POPULATION, so its value is a
  non-negative integer. `ARRIVAL_FLOOR = 0.8` (`tests/e2e/cloud-roadmap-arrival.spec.ts`)
  is the design's measured legibility floor, asserted with `toBeCloseTo` — it measures
  GEOMETRY, not a counted set, so `origin/main` cannot adjudicate it. Same exclusion
  and same reason as the latency ceiling in `shared-read-seams.test.ts`; the integer
  test is what derives it rather than naming it. **This rule is the widened root's own
  safety rail** — under the flat walk nothing outside one directory could be swept in
  at all.
- **The enrolment machinery itself.** A file that IMPORTS `ratchetScan` names a
  contract path in order to REASON about it, never to read it. Without this the
  meta-guard enrols itself the moment it asserts which contracts exist, and then
  demands a preamble on its own assertion about contracts. Keyed on the import and not
  on a mention, because a guard that cites where its own enrolment rule lives is still
  a guard — a substring test excluded MOTIR-5037's guard for exactly that.
- **A debt list held as a TypeScript literal** (`SERIAL_READ_DEBT`, `KNOWN_STATUS_DEBT`)
  is not a CONTRACT: it is not a separate committed artifact, so there is nothing for
  the JSON predicate to key on. Its staleness surfaces through the same assertions as
  its guard's ceiling, and those now carry the preamble — so the reader is covered even
  though the scanner does not see the list. If a third shape ever needs enrolling,
  **widen the predicate; do not start a list of files.**

### Cost of being wrong, revisited

Unchanged and still low. If the class recurs often enough to justify option 1, nothing
here blocks it — the preamble becomes redundant text and both halves of the meta-guard
are deleted in one commit. **What this amendment costs if IT is wrong** is a preamble
on guards that did not need one, which is four lines of message nobody reads on a green
run.

### References added

- `MOTIR-5207` — this amendment; `MOTIR-5037` — the unenrolled contract ratchet.
- PR #2818, runs `34643738460` / `34646088683` — the two ejections.
- `docs/decisions/page-rooted-locator-disposition.md` — the addendum recording the
  incident with the window measured (MOTIR-5057).
- `tests/rls/ratchetScan.ts` — `scanRatchets` (widened root, integer rule),
  `scanSetRatchets` / `guardMessages` (the contract shape).
