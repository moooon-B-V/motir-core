# The page-rooted strict-locator class — convert the incident SURFACES, permit the rest under a shrinking allow-list

**Status:** accepted · **Date:** 2026-09-11 · **Card:** MOTIR-5057 (epic MOTIR-2200)

The duplicate-locator class has taken `main` red six times, twice at `highest`
priority with production deploys held behind it. MOTIR-5035 stopped counting it
from memory and shipped a predicate; this decides what happens to what that
predicate returns. The decision was taken by the planner on 2026-09-10 on the
re-measured evidence below — **this record transcribes it, it does not re-open
it.**

> **On the file name.** `docs/decisions/` is slug-named, not numbered, so this
> takes the next free SLUG. Checked against `origin/main` and against the 120
> most recently updated `refs/remotes/origin/*` branches
> (`git ls-tree <branch> docs/decisions/`) — no `locator` / `page-rooted` /
> `strict-mode` slug exists on any of them. `ls docs/decisions/` was read first:
> no existing ADR covers this class, so this opens a new one rather than
> amending one. The closest neighbour is
> [`ratchet-constant-staleness.md`](./ratchet-constant-staleness.md), which
> decides how a ratchet CONSTANT behaves; this decides what the ratchet is
> ratcheting.

> **Every number in this record carries the command that produced it and the ref
> it was taken at.** A count is dated evidence and a predicate re-evaluates
> itself — that is the whole reason MOTIR-5035 shipped a script instead of a
> figure, and a decision record that quotes the figure without the command
> reintroduces exactly what the script was built to remove. The trailing
> [Numbers](#numbers--every-figure-with-its-command-and-its-ref) section is the
> index.

---

## Context

### The defect

React keeps the PREVIOUS subtree mounted while the new one streams, and
Playwright resolves locators BEFORE it filters on visibility. So a locator rooted
at `page` can match a node the author never knew was there. Three shapes, all
observed in this suite (`scripts/enumerate-page-locators.mjs`, header):

1. the transient VISIBLE double subtree — MOTIR-3692
2. the OUTGOING subtree on a navigation — MOTIR-3737, MOTIR-5035
3. React's hidden `S:0` SSR staging block — MOTIR-3929

`getByRole` is immune to all three, because the accessibility tree excludes the
hidden copy. `tests/e2e/_helpers/settle.ts` already says so at its
`expectSettledVisible` export: _"`getByRole` does not need it — the accessibility
tree excludes the hidden copy — and neither does a locator already scoped inside
a portalled dialog."_

The cost is not a red assertion. A failure in the merge queue **EJECTS** the pull
request with nothing red on it to explain why, and both `highest` incidents below
held production deploys for hours.

### The six incidents, read from the fix DIFFS

Read by opening each fix commit, not by reading each card's title — the title is
what got this wrong the first time (see [Provenance](#provenance--what-this-record-replaces)).

| incident   | fix commit          | date       | the locator that THREW                    | arm        | priority    |
| ---------- | ------------------- | ---------- | ----------------------------------------- | ---------- | ----------- |
| MOTIR-2033 | `f9e7c1ced` (#1850) | 2026-08-05 | `getByText('<org name>')`                 | text       | medium      |
| MOTIR-3692 | `3dd63c87e` (#2358) | 2026-08-27 | **`getByTestId('ai-planning-settings')`** | **testid** | **highest** |
| MOTIR-3725 | `e18a50a3b` (#2389) | 2026-08-28 | `getByLabel('Organization name')`         | label      | medium      |
| MOTIR-3737 | `4b67a68c1` (#2405) | 2026-08-28 | `getByLabel(…)` + `getByPlaceholder(…)`   | label      | medium      |
| MOTIR-3929 | `cf3226dfa` (#2458) | 2026-08-29 | **`getByTestId('ai-planning-save')`**     | **testid** | **highest** |
| MOTIR-4822 | `300d0ab43` (#2691) | 2026-09-07 | `getByText('Nothing has run yet')`        | text       | high        |

**2 testid / 2 label / 2 text.** Both `highest` incidents — the two that took
`main` red and held production deploys — were `getByTestId`.

### The predicate of record

`scripts/enumerate-page-locators.mjs` (MOTIR-5035, `e4b8e9484`, #2778). It rules
the four non-role `page.getBy*` methods — `getByTestId`, `getByText`,
`getByLabel`, `getByPlaceholder` — and exempts `.first()` / `.nth()` / `.last()`,
which resolve to one element and so cannot throw. `.filter()` is deliberately NOT
exempt: it narrows without guaranteeing one element.

It has two entry points and ONE predicate. `--ref` reads a commit through
`git ls-tree` + `git show`, so a count cannot pick up uncommitted edits from
whichever worktree it ran in; `--worktree` reads the checked-out tree and exists
for MOTIR-5037's guard, which must rule on the merge commit CI built — a ref
nobody can name in advance. `tests/helpers/pageLocatorInventory.json` is its
dated OUTPUT, not a second predicate.

---

## The population, re-measured

```
$ node scripts/enumerate-page-locators.mjs --ref origin/main
```

at `origin/main` = `65116fb197a86f64ccdf8e593f577c7b912fa2c1` (2026-09-11):

|           | rows | ruled    | exempt |
| --------- | ---- | -------- | ------ |
| **total** | 1289 | **1157** | 132    |

| method             | total | ruled |
| ------------------ | ----- | ----- |
| `getByTestId`      | 614   | 606   |
| `getByText`        | 610   | 489   |
| `getByLabel`       | 7     | 4     |
| `getByPlaceholder` | 58    | 58    |

277 files scanned, 150 carrying at least one ruled row.

**MOTIR-5057's own body says `~1201`, and that figure is superseded here.** It
was measured at `e4b8e9484`, BEFORE the card's own three conversion blockers
merged. Re-measuring at the ref the record actually ships against is not
diligence, it is the difference between a number that describes the tree and one
that describes no tree at all.

The ref trace, each row taken with the same command at that commit:

| ref         | what merged there                       | suite ruled | ruled on the 29 surfaces |
| ----------- | --------------------------------------- | ----------- | ------------------------ |
| `e4b8e9484` | MOTIR-5035 — the predicate              | 1400        | 199                      |
| `78579f21d` | MOTIR-5056 — the `getByLabel` arm       | 1314        | 191                      |
| `934b690be` | MOTIR-5115 — org / workspace settings   | 1295        | 158                      |
| `7c3ae250b` | MOTIR-5114 — AI-planning settings       | 1238        | 101                      |
| `3c16a6aaf` | MOTIR-5116 — cloud plan / roadmap / run | 1151        | 14                       |
| `65116fb19` | **`origin/main` today**                 | **1157**    | **14**                   |

The intervals between those merges contain sibling commits, so the SUITE column
is the state observed at each commit rather than a per-card delta.

**The 29-surface column IS card-attributable, and that is measured rather than
assumed.** Three non-conversion commits also touched files in that set in the
window — `b265d0423` (MOTIR-4775), `1b8f67e1f` (MOTIR-5132) and `10989eff9` —
and none of them adds or removes a single page-rooted locator line there:

```sh
for c in b265d0423 1b8f67e1f 10989eff9; do
  git show $c --unified=0 -- <the 29 files> \
    | grep -cE '^[+-].*page\.getBy(TestId|Text|Label|Placeholder)\('
done
# → 0, 0, 0
```

---

## Decision

**CONVERT the page-rooted sites on the 29 incident-adjacent surfaces. PERMIT the
remaining 1157 under MOTIR-5037's allow-list, which may only SHRINK.**

### The converted set, named

The conversion is complete. Four cards took it, and the set of files they touched
IS the definition of "converted" — there is no second list to keep in sync:

| card       | surface                                                            | files | sites taken on the 29 |
| ---------- | ------------------------------------------------------------------ | ----- | --------------------- |
| MOTIR-5056 | the `getByLabel` arm, suite-wide                                   | 37    | 8 (of 11)             |
| MOTIR-5115 | org / workspace settings — MOTIR-3725's and MOTIR-3737's own files | 10    | 33                    |
| MOTIR-5114 | AI-planning settings — the surface that took production down twice | 7     | 57                    |
| MOTIR-5116 | cloud plan / roadmap / run — the largest incident-adjacent arm     | 12    | 87                    |

The three surface cards touch **29 files**, exactly — that is where the number in
this record's title comes from, and it is a measurement rather than a target:

```
$ for c in 7c3ae250b 934b690be 3c16a6aaf; do
    git show --pretty="" --name-only $c; done | grep '^tests/e2e/' | sort -u | wc -l
29
```

**185 of the 199 ruled sites on those surfaces are gone; 14 remain and are
PERMITTED.** They are dealt with in the next section — they are not a shortfall.

### The permitted set, and what PERMITTED means

The other **1157** ruled sites stay as they are. Specifically:

- **MOTIR-5037's allow-list is the record of them.** It seeds from
  `tests/helpers/pageLocatorInventory.json` and asserts tight in BOTH directions,
  so a row that stops describing the tree turns the suite red.
- **It may only shrink.** Whoever next edits a spec converts the page-rooted
  sites in it and DELETES their rows. **No new row may be added.** A row leaving
  the list is the only legal movement.
- **This is a decision, not a residue.** The permitted set is the complement of a
  written-down converted set: 29 named files, four named cards, a predicate
  anyone can re-run. A future reader who runs the script, sees 1157 and opens a
  new finding is re-litigating a settled question — **do not.** What is open is
  MOTIR-5037's guard, not this disposition.

### Why the SURFACE and not the ARM

The defect needs a page that DOUBLE-MOUNTS. That is a property of the ROUTE, not
of the locator method — `getByTestId`, `getByText`, `getByLabel` and
`getByPlaceholder` are all equally page-rooted and all equally strict, and the
incident table proves the arms empirically indistinguishable: 2 / 2 / 2.

So slicing by arm buys nothing and costs everything. A sweep sized by the
population would have touched 150 files, most of them specs whose pages do not
double-mount; slicing by surface touches 29 and still contains every incident
file that had anything left to convert. `project-square-flow.spec.ts` — MOTIR-2033's
own file — is the sixth incident file and carries **zero** ruled rows at
`e4b8e9484` already, MOTIR-2033 having cleared it.

**And an arm-shaped remedy would have permanently permitted `getByTestId`** — 606
ruled sites, the largest arm, and the arm behind both production outages. That is
the concrete thing the corrected evidence changed.

---

## The third category the two-way split does not name

The decision reads _convert or permit_, and the tree turns out to hold a third
thing worth writing down, because it is 22% of the permitted set and it is not a
latent defect.

**A `toHaveCount(0)` assertion resolves the WHOLE match set, so it cannot throw
strict mode.** A page-rooted locator in an absence assertion is therefore outside
the defect class by construction — and converting it would make the test prove
strictly LESS, because the claim being made is that the string is absent from the
DOCUMENT, which a role filter or a subtree scope narrows.

That is why 14 ruled sites survive on the 29 converted surfaces. Each is a
DECLARED exclusion carrying its reason in the file, e.g.
`tests/e2e/org-admin.spec.ts`:

```ts
// ⚠️ NOT converted and NOT scoped (MOTIR-5115) — `toHaveCount` resolves the WHOLE
// match set, so it cannot throw strict mode and neither of these is in the defect
// class; and each asserts the string is absent from the DOCUMENT, which a role or
// a subtree scope would narrow. Both keep their inventory rows.
await expect(page.getByText('Coming soon')).toHaveCount(0);
```

Across the whole ruled population the class is **250 of 1157 (21.6%)**, in 82
files:

```sh
node scripts/enumerate-page-locators.mjs --ref origin/main > /tmp/inv.json
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const inv = JSON.parse(readFileSync("/tmp/inv.json", "utf8"));
const cache = new Map();
const src = (f) => {
  if (!cache.has(f))
    cache.set(f, execFileSync("git", ["show", `${inv.ref}:${f}`],
      { encoding: "utf8", maxBuffer: 64e6 }).split("\n"));
  return cache.get(f);
};
const ruled = inv.rows.filter((r) => !r.exempt);
const absence = ruled.filter((r) =>
  /toHaveCount\(\s*0\s*\)/.test(src(r.file).slice(r.line - 1, r.line + 2).join(" ")));
console.log(ruled.length, absence.length, new Set(absence.map((r) => r.file)).size);
'
# → 1157 250 82
```

**That command is a three-line window, not the scanner's own predicate**, so the
250 is an approximation. It over-counts where an unrelated `toHaveCount(0)` sits
within two lines of a ruled site and under-counts where the assertion is wrapped
further away — quoted here as a magnitude, not as a boundary. The rows are IN the
population and IN the allow-list either way: the exemption the scanner grants is
`.first()` / `.nth()` / `.last()` and nothing else, deliberately, so that the
inventory and MOTIR-5037's guard cannot disagree about what the population is.

**What follows from it:** 1157 permitted rows is not 1157 latent merge-queue
ejections. Roughly a fifth of the list is structurally safe, and whoever shortens
the list should convert the assertions that can actually throw first.

---

## Consequences

### The ordering constraint is real, and it is why this is four cards and not a sentence

MOTIR-5037 asserts its allow-list tight in BOTH directions. A row that no longer
describes the tree fails the suite — so **every conversion had to land BEFORE the
guard**, or correct work would have turned the suite red. All four have
(`78579f21d`, `934b690be`, `7c3ae250b`, `3c16a6aaf`); the guard is still open.

### The ratchet is the mechanism, and the window since the conversions proves it

Between `3c16a6aaf` (the last conversion) and `origin/main`, exactly one commit
touched `tests/e2e` — `65116fb19` (MOTIR-5118, #2814, merged 2026-09-11) — and it
added **six new ruled sites**, all in a new spec file:

```
+ tests/e2e/approval-gate-repaint.spec.ts:97   getByText('Awaiting you', { exact: true })
+ tests/e2e/approval-gate-repaint.spec.ts:116  getByText('Approving this will:')
+ tests/e2e/approval-gate-repaint.spec.ts:122  getByText('Approved', { exact: true })
+ tests/e2e/approval-gate-repaint.spec.ts:136  getByText('Files kept')
+ tests/e2e/approval-gate-repaint.spec.ts:149  getByText('Changes requested', { exact: true })
+ tests/e2e/approval-gate-repaint.spec.ts:158  getByText('Files kept')
```

Nothing was wrong with that pull request; nothing has ever stopped a sixth site
being written, which is why there have been six incidents. **The permitted set is
only credible as a shrinking list if something enforces the shrinking** — that is
MOTIR-5037's whole job, and without it this decision degrades into permanent
permission within days.

It also means the committed inventory is dated the moment it lands: it was
generated at base `0cdd700d` and reports 1151 ruled, against 1157 today. That is
the file behaving as documented — _"DATED EVIDENCE, not a contract … Re-run it
rather than hand-editing a row"_ — and the guard's seeding step, not a defect.

### What a future reader should do, by case

| you are…                                        | do this                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| editing a spec that has rows on the allow-list  | convert its page-rooted sites to `getByRole(<role>, { name })`, or scope them to a live subtree, and DELETE those rows               |
| writing a NEW spec                              | never write a page-rooted `getByTestId` / `getByText` / `getByLabel` / `getByPlaceholder` assertion; the guard will refuse a new row |
| holding an ABSENCE assertion (`toHaveCount(0)`) | leave it page-rooted, and say so in a comment beside it — scoping it proves less                                                     |
| looking at 1157 and reaching for a sweep        | read this record; the disposition is taken                                                                                           |
| about to add a row to the allow-list            | you cannot. The list only shrinks                                                                                                    |

### No code changes with this decision

This card records; MOTIR-5114 / MOTIR-5115 / MOTIR-5116 built, MOTIR-5056 took
the `getByLabel` arm, and MOTIR-5037 builds the guard. The diff is this file.

---

## Provenance — what this record replaces

MOTIR-5057 was authored as a `decision` card with `executor: human`, offering a
person three options. That was wrong on two counts, and both are recorded in
MOTIR-5109 (the planner-bug home):

1. **The question is a HOW** — slicing and sequencing — which the decision-authority
   ladder assigns to the planner, not to the user.
2. **The evidence its options were argued from was false.** The card asserted
   _"zero were `getByTestId`"_; the record says two, and they are the only two
   rated `highest`. The original table was built from the incident cards' TITLES:
   MOTIR-3692's names _"double-subtree strict-mode class"_ and MOTIR-3929's names
   _"React's hidden `S:0` streaming block"_ — both name the duplication SHAPE,
   neither names the method, so both were binned away from `getByTestId`.

Two arithmetic corrections came with it: the population was **1400** ruled and not
1407 (the 1407 was a `git grep` at `849f43f7e`, a commit predating MOTIR-5035's
own merge), and the post-`getByLabel` remainder was **1310** and not 1252 — the
1252 silently dropped the 63-site `getByPlaceholder` arm, which nothing in the
plan was converting.

**The general shape, worth keeping:** a menu carries the planner's authority while
contributing none of its judgement, and a choice made from a false table is
indistinguishable afterwards from a choice made from a true one. The incident
arms were read from six commit DIFFS because six card titles had already produced
a confident wrong answer.

---

## Numbers — every figure with its command and its ref

| figure                                                                                                      | command                                                                                                                                    | ref                                                                          |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 1289 rows / **1157 ruled** / 132 exempt; 277 files scanned, 150 with ruled rows; per-arm 606 / 489 / 4 / 58 | `node scripts/enumerate-page-locators.mjs --ref origin/main`                                                                               | `65116fb19`                                                                  |
| the ref trace (1400 / 1314 / 1295 / 1238 / 1151 / 1157)                                                     | the same, with `--ref <each commit>`                                                                                                       | `e4b8e9484`, `78579f21d`, `934b690be`, `7c3ae250b`, `3c16a6aaf`, `65116fb19` |
| **29** converted surfaces                                                                                   | `for c in 7c3ae250b 934b690be 3c16a6aaf; do git show --pretty="" --name-only $c; done \| grep '^tests/e2e/' \| sort -u \| wc -l`           | those three commits                                                          |
| 199 → 14 ruled rows on those 29 surfaces (**185 converted**)                                                | the enumeration above, rows filtered to that file set                                                                                      | `e4b8e9484` → `65116fb19`                                                    |
| per-card 8 / 33 / 57 / 87                                                                                   | the same, differenced across consecutive conversion merges                                                                                 | `78579f21d`, `934b690be`, `7c3ae250b`, `3c16a6aaf`                           |
| those deltas are card-attributable (0 / 0 / 0 from the three sibling commits)                               | the `git show … \| grep -cE '^[+-].*page\.getBy…'` loop under [the ref trace](#the-population-re-measured)                                 | `b265d0423`, `1b8f67e1f`, `10989eff9`                                        |
| **250 of 1157 (21.6%)** in 82 files are `toHaveCount(0)`                                                    | the three-line-window script in [the third category](#the-third-category-the-two-way-split-does-not-name); an approximation, stated as one | `65116fb19`                                                                  |
| 6 ruled rows added since the last conversion                                                                | row-id set difference between the two enumerations                                                                                         | `3c16a6aaf` → `65116fb19`                                                    |
| the six incident arms                                                                                       | `git show <fix sha>` for each of the six                                                                                                   | `f9e7c1ced`, `3dd63c87e`, `e18a50a3b`, `4b67a68c1`, `cf3226dfa`, `300d0ab43` |

---

## References

- `scripts/enumerate-page-locators.mjs` — the predicate of record (MOTIR-5035)
- `tests/helpers/pageLocatorInventory.json` — its dated output; MOTIR-5037's guard
  seeds the allow-list from `rows`
- `tests/e2e/_helpers/settle.ts` — `expectSettledVisible`, and where the
  `getByRole` immunity is already written down
- [`ratchet-constant-staleness.md`](./ratchet-constant-staleness.md) — how a
  ratchet CONSTANT behaves when siblings merge under it
- Cards: MOTIR-5035 (enumerate) · MOTIR-5056 (`getByLabel` arm) · MOTIR-5114 /
  MOTIR-5115 / MOTIR-5116 (the three surfaces) · MOTIR-5037 (the guard) ·
  MOTIR-5109 (the planning bug) · MOTIR-5057 (this record)
- Incidents: MOTIR-2033 · MOTIR-3692 · MOTIR-3725 · MOTIR-3737 · MOTIR-3929 ·
  MOTIR-4822
