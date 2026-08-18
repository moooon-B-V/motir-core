# ADR: A ratchet constant stays branch-measured — the failure MESSAGE is what changes

- **Status:** Accepted (2026-08-17)
- **Story / Subtask:** MOTIR-2832 (Make `motir_app` the suite's default) · Bug MOTIR-2941
- **Extends:** MOTIR-2784's ratchet convention (a number that may only fall, so a
  descent is visible) and MOTIR-2939's per-commit re-measurement of
  `UNCONVERTED_E2E_CEILING`.
- **Consumed by:** every guard under `tests/rls/` that declares a
  `*_CEILING` / `*_FLOOR`, and every guard added after this one — enrolment is by
  NAME, so there is no list to join.
- **Supersedes / superseded by:** none.

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
