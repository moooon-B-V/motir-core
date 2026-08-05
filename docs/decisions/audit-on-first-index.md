# Should a repository's FIRST successful code-graph index auto-fire its audit + convention derivation?

**Status:** accepted · **Date:** 2026-08-05 · **Card:** MOTIR-2251 (Story MOTIR-2244 — audit
coverage) · **Evidence pinned at:** `motir-core` `origin/main` @ `b82ed141`, `motir-ai`
`origin/main` (read via `git show origin/main:…` after `git fetch`, 2026-08-05)

**Decision: option B — auto-fire once, on the first SUCCESSFUL index of a repository that has
no audit yet.** Not behind a setting (option C) for now; §6 records what would reopen that.

## Context — the asymmetry that raises the question

Connecting a repository to a project gives it a code graph automatically and never gives it an
assessment. Both halves are verified, not cited:

**Indexing is edge-triggered, per-repo and self-healing.** A repo-add persists the grant and
calls `codeGraphIndexService.enqueueFirstIndexForRepos` → `enqueueReposMissingFirstIndex`,
which is gated on the succeeded-index ledger: _"A repo whose index is queued or in flight but
not yet succeeded re-enqueues"_ (`lib/github/indexEnqueue.ts:73`), and a reconcile whose repos
are all indexed enqueues nothing (`:69`). Add a sixth repository and exactly one index job is
created; the five already-indexed ones are untouched.

**Auditing has no edge trigger at all.** `lib/jobs/definitions/codeGraphIndex.ts` is 77 lines
and contains no follow-up `inngest.send` — index success emits nothing. The derivation has
exactly three write paths in the whole codebase, and none of them is a repository connecting:

| write path                                                                      | fires when                                 | gate                                                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `POST /api/ai/coding-convention/refresh` → `aiConventionService.reaudit`        | a person presses the `/code-health` button | `assertCanManage`                                                                                        |
| `migrateOnboardingService` `audit_convention` step (`:205`)                     | once per migrate-onboarding run            | `if (run.conventionApprovedAt) return`                                                                   |
| `conventionEstablishService.establishForFreshProject` (via `plansService:1385`) | first plan approve                         | self-gates OUT when a repo exists: `if (code) return { submitted: false, reason: 'has_connected_repo' }` |

So a repository connected to an established project sits un-assessed indefinitely, and the
third path is _specifically_ the one that declines to run when there IS a connected repo.

The rest of MOTIR-2244 papers over that with a nudge and a per-repo trigger. This record asks
whether the asymmetry should exist at all.

## The options

- **A — Manual only.** The story's shipped path is the whole answer: a person is told, a person
  presses. No new spend; every newly connected repository stays un-assessed until somebody
  acts, on every project, forever.
- **B — Auto-fire once**, on the first successful index of a repo with no audit — the same
  idempotent shape the index enqueue already uses, gated on _"does this repo have one yet"_,
  never on _"is this row new"_. The nudge survives as the exception path.
- **C — B behind a project setting**, defaulted ON.

## 1 · Rung-1 evidence — what comparable tools do on repository connect

Each row records WHERE it was observed. Nothing here is inferred from reputation.

| Product                                         | On connecting a repository                                                                                                                                                                                                                                                                                                                                                                  | Observed at                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **SonarQube Cloud** (SonarCloud)                | Automatic. _"When you first import a project that supports automatic analysis, SonarQube Cloud analyzes the default branch (usually the main branch)"_ and _"If your project is eligible, SonarQube Cloud will automatically trigger the first analysis."_ Opt-OUT exists: project admins turn it off at _Administration → Analysis Method_; org admins can disable org-wide on Enterprise. | [docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/automatic-analysis](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/automatic-analysis)                     |
| **Codacy**                                      | Automatic. _"Codacy begins an initial analysis as soon as you add a repository and sets everything up to ensure your next commits on that repository are analyzed."_                                                                                                                                                                                                                        | [docs.codacy.com/getting-started/codacy-quickstart/](https://docs.codacy.com/getting-started/codacy-quickstart/)                                                                           |
| **GitHub code scanning (CodeQL default setup)** | **Opt-IN per repository or per org** — a person clicks _Enable CodeQL_. But once enabled, firing is automatic and never per-run manual: default setup _"will automatically trigger the first scan when a supported language is detected on the default branch"_, then scans each push to the default/protected branches.                                                                    | [docs.github.com/…/configuring-default-setup-for-code-scanning](https://docs.github.com/en/code-security/code-scanning/enabling-code-scanning/configuring-default-setup-for-code-scanning) |

**What the evidence actually supports.** Two of three analyse on connect with no further
action; the third requires one enablement decision and then fires automatically forever. **No
observed product makes a human press a button per repository per assessment**, which is exactly
what Motir does today. The GitHub row is the honest counterweight to a flat reading of "B is
what everyone does" — it is closer to C, and it is the reason C is recorded below as the live
alternative rather than dismissed.

**Recorded as an ASSUMPTION, not evidence:** that these products' users _want_ the automatic
behaviour, or that turning it off is rare. Neither is observable from documentation, and
neither was checked.

## 2 · What one auto-derivation actually costs

**The container cost is ZERO, and the card that filed this assumed otherwise.** MOTIR-2251's
own body says _"the container and model spend of one `code_audit` + one `propose_convention`"_.
That is wrong on the container half, verified on `motir-ai` `origin/main`:

- The **container is the INDEX job**, which has already run and succeeded — that is the very
  event this decision hangs off. The graph exists before the audit starts.
- `code_audit` _"carries NO MEASUREMENT LOGIC … metrics + SARIF ingest COMPUTE the findings,
  and the LLM only synthesizes"_ (`src/jobs/handlers/codeAudit.ts:28-33`, the MOTIR-1571/1573/
  1574/1575 re-scope). It reads the existing graph; it spawns nothing.
- `propose_convention` is likewise an LLM derivation over the rule set + stack idiom block
  (`src/jobs/handlers/proposeConvention.ts:94`), reporting `usage` like any model call.

So one auto-derivation costs **two LLM calls' tokens** — one synthesis pass and one convention
draft — on top of an index that was going to happen anyway. It is not a fresh container per
repository.

**The count arithmetic, which IS derivable.** The trigger is per-repository and idempotent, so
the fan-out is exactly one pair per repository that has no audit, once:

| scenario                                   | pairs fired                                       |
| ------------------------------------------ | ------------------------------------------------- |
| connect a 6th repo to a 5-repo project     | **1** (the five keep their reports)               |
| onboard a new 4-repo project               | **4**, once, spread across four index completions |
| re-run / reconcile with everything indexed | **0** — the gate is "has no audit yet"            |

Compare the status quo reachable today: learning about that 6th repository costs **6** pairs,
because the only trigger fans out over the whole set. **Auto-firing is cheaper than the button
it replaces**, per repository learned about.

**Recorded as an ASSUMPTION:** the dollar figure per pair. `aiUsageService` records usage but
this record does not quote a measured per-derivation cost, and none is published in-repo — so
"two LLM calls" is the honest unit, not a currency amount. §6 names what would change if that
number turns out to be large.

## 3 · Decision — B

**When a repository's first `system.code-graph-index` succeeds and that repository has no
derived audit, fire its `code_audit` + `propose_convention` pair, once.**

The reasons, in order:

1. **The capability is half-built without it.** The planner CONSULTS a repository's convention
   and audit when it decomposes code-shaped work. A repository with a graph and no assessment
   is one the next planning pass reasons about without knowing how its code is written — the
   gap is invisible at exactly the moment it costs something.
2. **The cost is bounded in the way a recurring cost is not.** It fires once per repository per
   project, on an event that happens once, and it is _less_ than the whole-set button it
   replaces (§2).
3. **The idempotency gate already exists and can be READ rather than invented** — the
   succeeded-index ledger shape in `enqueueReposMissingFirstIndex`, applied to "has an audit"
   instead of "has an index".
4. **Nothing observed makes a human press per repository** (§1), and Motir's stance is
   opinionated defaults with bounded configuration.

**Rejected — A (manual only).** Its one real argument is that it adds no spend, and the story's
nudge plus one-click trigger is already a large improvement on today. That is true and it is
not sufficient: cheapest is not the same as best, and A leaves a permanent trap where the
product silently knows less about a repository than the user believes it does. A is also the
status quo by accident rather than by decision — nothing was ever wired, which is not the same
as something having been chosen.

**Rejected FOR NOW — C (B behind a project setting, default ON).** C is B plus an escape hatch,
and the escape hatch costs a settings surface, a persisted flag, a migration, and a second
place for the trigger to be wrong. With the cost at two LLM calls once per repository (§2),
there is not yet a demonstrated need to opt out — and a setting added "just in case" is
bounded configuration spent on a problem nobody has reported. Recorded rather than discarded:
§6 is its trigger.

## 4 · What this does NOT decide

- **Re-firing.** This is a FIRST-audit trigger only. Whether an audit should refresh when a
  repository's graph is re-indexed after new commits is a separate, genuinely recurring-spend
  question and is not decided here.
- **The failure path.** A derivation that fails leaves the repository un-audited; the
  MOTIR-2244 nudge is what tells someone, which is the exception path the story already ships.
- **MOTIR-2244's surfaces.** The nudge (MOTIR-2250) and the per-repo triggers (MOTIR-2249) are
  correct under all three options and not one line of them changes with this answer — only how
  often the nudge has anything to say. This card was deliberately not wired as a blocker of
  either.

## 5 · Consequences — the cards that carry the work

This decision is not made until its consequence has a card:

- **MOTIR-2266 — the auto-fire trigger + its idempotency gate.** `motir-core`, `blocked_by`
  MOTIR-2247. On a successful first index, fire the pair for that repository only if it has no
  derived audit; the gate mirrors `enqueueReposMissingFirstIndex`'s ledger shape, and the
  trigger reuses MOTIR-2247's repo-SCOPED `reaudit` so exactly one repository is derived. Its
  own acceptance criteria carry the deliverable — naming a key is not transferring the work.

  **Filed under MOTIR-1755, NOT under MOTIR-2244.** MOTIR-2244's scope boundary says in as many
  words that it does not auto-fire, and it was right to: a recurring-spend question should not
  be settled as a side effect of a user-interface story. MOTIR-1755 is where the code-index and
  code-health surface work already lives (MOTIR-2087 / 2123 / 2206 / 2207 / 2223).

No card is filed for C's setting; §6 is what would file it.

## 6 · What would reopen this

- A **measured** per-derivation cost that makes a 4-repository onboarding materially expensive
  (§2 records the unit, not a currency amount) → file C's setting.
- A user asking to turn it off, or an org onboarding repositories in bulk → C.
- The audit refresh question (§4) being answered "yes, on every re-index" → that IS a recurring
  cost and would want C's switch to cover both.
