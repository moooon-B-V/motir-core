# ADR: A repository that CANNOT report a check counts as GREEN for the In-Review promotion

- **Status:** Accepted (2026-08-28)
- **Story / Subtask:** Bug MOTIR-3823 (Epic MOTIR-2200) · observed on MOTIR-3780
- **Extends:** [`work-item-delivery-links.md`](./work-item-delivery-links.md) — the
  delivery set — and MOTIR-3685's _every delivery must be green_ promotion rule
- **Consumed by:** `lib/services/ciPromotion.ts` (`everyDeliveryIsGreen`, both edges) ·
  `lib/workItems/deliverySet.ts` (`repoCannotReportChecks`, `deliveryStateForPromotion`) ·
  `lib/repositories/githubPullRequestRepository.ts` (the two evidence reads)
- **Supersedes / superseded by:** none. It changes NOTHING about
  `lib/github/prCiState.ts`, and NOTHING about what closes a card.

> Structured **Context → Decision → Consequences → References**. §2 is the part the card
> asked to be recorded explicitly: WHICH discriminator was chosen, what it costs, and
> what it does not answer.

---

## Context

`implemented` says the pull request is open. **In Review says a human should look at
this now.** The only thing entitled to move a card between them is the build
(MOTIR-3006), and since MOTIR-3685 the question is asked of the card's whole delivery
set: every pull request delivering it must be `passing`.

`derivePrCiState` returns `null` for a pull request with no recorded check rows, and
`deliverySetIsGreen` reads every `null` as "not passing". So:

**A card whose only delivery sits in a repository with no CI is permanently
un-promotable.** Nothing will ever report, so the latch never fires. That is not an
exotic case: it is _every_ `targetRepo: motir-meta` card — this project's own planning
corpus, its decision records and its authoring bars — a large share of that
repository's traffic. Those cards go `implemented → done` on merge (a legal edge) and
silently never pass through In Review at all. A state simply stops being reachable, and
the board stops telling anyone that a piece of work is waiting to be read.

Observed on **MOTIR-3780**, `parent/MOTIR-3780-agent-publishes-design-result`,
2026-08-28: `motir-core#2429` reported 29 passing checks; `motir-meta#334` reported
none, and `motir-meta` has zero files under `.github/` — it has no CI and never has.

### The trap — why `null → passing` is the wrong fix

`derivePrCiState` returns `null` for **two** situations, and only one of them is green:

1. the repository has **no CI at all** — nothing will ever report; and
2. **nothing has reported yet** — a pull request opened seconds ago, a webhook still in
   flight, a run that has not started.

Mapping `null` to `passing` treats (2) as a pass, and (2) is not an edge case: it is
the normal state of every pull request for the first seconds of its life. That matters
most at **edge 2**, `promoteIfCiAlreadyGreen`, which fires the instant a card ARRIVES at
`implemented` — which a run reaches immediately after `gh pr create`, reliably before
any check row exists. The naive fix therefore promotes essentially every card in the
system to In Review the moment its pull request opens, whatever CI later says. **It
fails in the direction where everything looks like it is working**, which is a worse
defect than the one being fixed.

So the deliverable is a DISCRIMINATOR, not a mapping change.

## Decision

**A CI-less repository counts as GREEN** (decided by Yue, 2026-08-28). The alternative
readings both fail: holding the card for ever punishes a repository for a choice it was
entitled to make, and requiring every repository to carry CI means adding a workflow to
a documentation repository purely to satisfy a status transition — configuration that
exists to please a machine, which this project removes rather than adds.

### 1 · The discriminator, and why this one

The two `null`s are indistinguishable AT THE PULL REQUEST, so the question is asked of
the **repository**, from what Motir has already recorded about it
(`repoCannotReportChecks`):

| what the record shows                                                                         | reading                   | why                                                                                |
| --------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| it has recorded a check run, ever                                                             | **CAN report** → hold     | its silence on this pull request means _not yet_                                   |
| never recorded one, **and** a pull request of its own reached **MERGE** without recording one | **CANNOT report** → green | a merged pull request had its entire lifetime to produce a check and produced none |
| neither — no history at all                                                                   | **CAN report** → hold     | absence of evidence resolves to the conservative side                              |

The merge is what makes the middle row _evidence_ rather than the absence of it. "A pull
request exists and is silent" is exactly what a newly-connected repository WITH CI looks
like in the seconds before its first run reports; "a pull request merged and was silent
throughout" is not.

**Two candidates were weighed and declined:**

- **Read the repository's workflow list from GitHub and cache it on the repository row.**
  It answers the question directly, but it costs an API call, a schema column, a refresh
  path on installation events, and a staleness question — and the staleness failure is
  the _silent_ one: a repository that ADDS CI after being cached as workflow-less
  promotes its cards early until something refreshes it, with nothing self-correcting.
  It is also not exact — a check can be written by an app that is not an Actions
  workflow.
- **An explicit per-repository flag set at connect time.** Exact and honest, but it is
  configuration a human must get right, which is the class of thing this project
  removes.

### 2 · What it costs, and what it does NOT answer

- **Cost:** two indexed reads on `github_pull_request`, and **only** for a delivery
  whose verdict came back `null`. A set with no `null` member — nearly every card in
  the tree — issues neither query. No GitHub API call, no cached column, nothing for a
  human to configure.
- **It answers _"can this REPOSITORY report a check?"_** It does **not** answer _"will
  anything report for THIS pull request?"_ A repository whose workflows are
  paths-filtered can be perfectly able to report and stay silent on a docs-only pull
  request, and **such a card is still held at `implemented`** — unchanged by this
  decision. That is the conservative direction, deliberately: the alternative reads a
  silence as a pass, which is the trap above.
- **The residual failure, stated so the next reader does not over-trust it:** a
  genuinely CI-less repository holds its cards until one of its own pull requests has
  merged. Bounded to the start of a repository's life, in the safe direction, and it
  clears itself. The mirror failure — a repository that HAS CI but has never run it
  promoting a card early — is what the merge evidence buys out.
- **Self-correcting in both directions:** the first check row a repository records
  answers the question for ever, and so does its first merge without one.

### 3 · Where it lives, and what it must not touch

- **`derivePrCiState` is UNCHANGED.** `null` still means _absence of CI is not a state_,
  and every surface reading it — the Development pill, the `deliveries` field — renders
  exactly what it rendered before. The promotion learns to ask a **second** question;
  the shared derivation does not change meaning underneath its other readers.
- **One function, both edges.** The amendment lives inside `everyDeliveryIsGreen`, which
  `promoteDeliveredCardsOnGreen` and `promoteIfCiAlreadyGreen` both call. `ciPromotion`'s
  own header says the latch only works if the two edges ask the same question of the same
  set; a fix applied to one edge is the defect that file was written to avoid.
- **The COMPLETION gate is untouched.** `deferred_open_pr` and
  `deferred_incomplete_delivery_set` ask about MERGES, not about green. Nothing here
  changes what closes a card.
- **The empty set is still not green.** A card with no delivery at all has nothing to
  map, so `deliverySetIsGreen`'s first line is unaffected — the property MOTIR-3685
  asserted and this change must not perturb.

## Consequences

- Every `targetRepo: motir-meta` card now reaches In Review on the same terms as any
  other, and a mixed set (one code repository, one docs repository) promotes on the code
  repository's green.
- A card whose delivery has simply not reported yet is still held, at **both** edges.
  This is asserted directly (`tests/github/ciGreenPromotion.test.ts`), because it is the
  criterion the naive fix fails.
- A repository with paths-filtered workflows that reports nothing for a particular pull
  request still holds its card. If that turns out to matter, the fix is a per-pull-request
  question, not a widening of this one — and it should be filed rather than folded in.

## References

- `lib/workItems/deliverySet.ts` — `repoCannotReportChecks`, `deliveryStateForPromotion`,
  and the full reasoning at the constant.
- `lib/services/ciPromotion.ts` — `everyDeliveryIsGreen`, the one place both edges share.
- `lib/repositories/githubPullRequestRepository.ts` —
  `listRepoIdsWithAnyCheckRun`, `listRepoIdsWithAMergedPullRequestWithoutChecks`.
- `tests/github/ciGreenPromotion.test.ts` — the two paired describes: what the CI-less
  rule makes green, and what it must still withhold.
- [`work-item-delivery-links.md`](./work-item-delivery-links.md) — the delivery set this
  reads over.
