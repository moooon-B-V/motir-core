# The code graph is keyed to the ORGANISATION; project membership is visibility configuration

**Status: ACCEPTED — decided by Yue, 2026-09-05.** Story MOTIR-1754 · Subtask MOTIR-2029. Carried out
of MOTIR-2028 (the MOTIR-1989 planning bug), whose fourth acceptance criterion required this question
be filed rather than left in a bug body.

## The decision

**One repository has ONE code graph, keyed to the ORGANISATION, built once.** Which projects work on
that repository is **visibility configuration**: an org admin adds a repository to any project, in
any workspace of the org, and doing so **rebuilds nothing**.

**The reasoning, and it is the reasoning rather than the conclusion that matters here:**

> _The repository belongs to the whole org, and the org is the accounting unit, so there is no
> privacy issue. If a repo doesn't belong to the org, we need to maintain the index per project,
> which will be a total wrong design._

That is the argument in full. Ownership settles it: the org owns the repository and pays for the
indexing, so there is no boundary between two of its projects that a second copy of the same graph
would be protecting. The per-project list is about **relevance** — which code this project's planner
should read — and never about secrecy.

⚠️ **THIS DOCUMENT ORIGINALLY RECOMMENDED SOMETHING ELSE, AND THE RECOMMENDATION IS STRUCK RATHER
THAN QUIETLY REPLACED.** Its first revision weighed four options and recommended **option 3**, narrow
with a fallback — and dismissed **option 4**, the shared graph, as _"a motir-ai TENANCY change… much
larger than this card, and named here only so the decision records why it was not taken now."_
**Option 4 is the decision.** The first revision was reasoning about which narrowing was cheapest to
build while treating per-project graphs as the given; the question it never asked was whether a
per-project graph should exist at all. It should not. Recording that inversion is the point of
keeping the struck text: the cheapest change to a wrong model is still the wrong model.

## The question

A repository connected to a workspace is indexed into **every project of that workspace**, building
the same graph N times. Should it be, or should it be indexed only into the projects that actually
claim it?

## What is shipped today — rung 2, read on `origin/main` at `4dc08ff39`

`lib/services/codeGraphIndexService.ts` resolves the workspace's projects and dispatches one
container per project:

```
// codeGraphIndexService.ts:243   const projects = await projectRepository.findByWorkspace(input.workspaceId, tx);
// codeGraphIndexService.ts:250   projectIds: projects.map((p) => p.id),
// codeGraphIndexService.ts:258   if (resolved.projectIds.length === 0) return { indexed: false, reason: 'no_projects' };
```

Its own TENANCY note (`:30-48`) states the reason, and it is a real one: a repository belongs to a
WORKSPACE (`GithubRepo.workspaceId`, MOTIR-1931) while motir-ai's code-graph tenant is
PROJECT-scoped. The fan-out bridges the two.

The note also names an owner for narrowing it — _"it belongs to MOTIR-1754 … Do not read this
paragraph as an invitation to fix it in passing"_ (`:44-48`) — and MOTIR-1754's own scope boundary
hands it straight back. **The ownership was a closed loop.** This document is what closes it: the
question is a first-class unit, and the code's pointer is corrected to name it.

## Why the container move changed the calculus

`code-graph-index-fleet.md` §5's constraint table lists **"tarball re-fetched PER PROJECT"** as a
symptom the container REMOVES — _"one container fetches once and builds once"_ (`:90`).

**⚠️ THAT ROW DOES NOT HOLD AGAINST THE IMAGE THAT SHIPPED, and it is corrected below.** A container
is project-scoped by construction: the indexer reads exactly one `MOTIR_INDEX_RUN_CREDENTIAL`,
`src/codegraph/runCredential.ts` binds a credential to ONE `aiProjectId`, and motir-ai's
`docs/contract.md` states _"nothing in a request body can name a project."_ So the per-project
re-fetch **survives** the move — it only leaves Vercel.

What changed is the price:

|                  | serverless                                                   | containers                                                                                                                                        |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| N projects costs | N function invocations, absorbed by an included-minutes pool | **N machines × ~924 MB × minutes of metered compute, for byte-identical work — drawn from the org's index allowance AND from Motir's own margin** |

§6's argument — _one container per REPO_, forced by the ledger contract — is **untouched** by this
document. That argument is about not batching many REPOSITORIES into one container, and it survives
intact. What was never sized is the orthogonal ×N over PROJECTS.

**The multiplier is live, not hypothetical.** The `moooon` workspace holds two projects, `MOTIR` and
`TEST`, so indexing `motir-core` boots two containers and builds the same graph twice — half of it
into a throwaway test project. Every workspace's project count multiplies its own index cost.

**The number is measurable, and it should be measured before the choice is made rather than
estimated.** `ciFleetCostMeterService` stamps per-container seconds and cost with a `workload`
(MOTIR-1995), and its own header records that an earlier claim of per-workload attribution was false
until every row carried one. So the cost of this fan-out is a query against that rollup, per
workspace, keyed by the index workload — not a figure anyone has to assert.

## The options, as they were weighed

### 1. Keep the workspace-wide fan-out — REJECTED

Cost scales with project count; a scratch project costs a full index, and the graph is duplicated for
no reason anyone can name.

### 2. Narrow to the project's declared repository SET — REJECTED

Index only into projects whose `project_repository` set claims the repository. It reduces the
multiplier and keeps per-project graphs, so it still builds the same graph more than once whenever
two projects share a repository. Its own cost was the empty-set case: a project that never ran the
establish step would silently go code-blind.

### 3. Narrow WITH a fallback — REJECTED (and it was this document's first recommendation)

The declared set when non-empty, the workspace-wide fan-out when empty. Same objection as 2, plus a
fallback that re-introduces the leak precisely for the projects least able to notice.

### 4. ONE graph per repository, keyed to the ORG, shared — **ACCEPTED**

The repository is the org's. The graph is built once and read by every project the org configures it
into. **The multiplier does not shrink; it stops existing.**

Its cost is honest and is a tenancy change rather than a policy tweak — §_The audit_ below is the
whole of it. The first revision costed that change and stopped there; what it did not cost was the
alternative, which is maintaining N identical graphs for ever.

## The audit — a tenancy change is a schema audit, not a policy change

Read on `origin/main` at `4dc08ff39`. Each row is a place the graph's tenant is currently the
PROJECT and must become the ORG, or a place the project boundary is currently enforced and must
become configuration:

| #   | today                                                                                                                                    | under this decision                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | `CodeRepo @@unique([aiProjectId, repoRef])` — one graph per project                                                                      | `@@unique([aiOrganizationId, repoRef])`                                             |
| 2   | `CodeRepo` cascades from `AiProject` — deleting a project DROPS a graph                                                                  | cascades from the org; a project leaving cannot drop a graph others read            |
| 3   | `getCoordination(aiProjectId, repoRef)` — every caller in `codeGraphTools`, `codeGraphContext`, `graphIndexPublisher`, the control plane | keyed by org                                                                        |
| 4   | the run credential is minted bound to `(aiProjectId, repoRef, runId)`                                                                    | bound to the org                                                                    |
| 5   | the snapshot key is `codegraph/<aiProjectId>/<repoRef>/<sha>`, and retention prunes per `(aiProjectId, repoRef)`                         | org-keyed path and pruning                                                          |
| 6   | `GET /v1/code-graph/status` is keyed by core workspace + project (MOTIR-1765)                                                            | keyed by org, filtered by the project's configured set                              |
| 7   | MOTIR-1765's isolation test asserts _project A cannot read project B's row_                                                              | the isolation boundary is the **ORG**; that test asserts the wrong tenant           |
| 8   | `resolveCodeContext` → `listByInstallation` — the WORKSPACE's repos                                                                      | the project's configured set                                                        |
| 9   | `codeGraphIndexService` fans out to every project of the workspace                                                                       | one index per repository, per org                                                   |
| 10  | **`ProjectRepo.githubRepoId` is `@unique`**                                                                                              | dropped — a repository in two projects is the ordinary case                         |
| 11  | `GithubRepo.workspaceId` is the repo's tenancy column (MOTIR-1931)                                                                       | the org owns the repository; workspace must not constrain which projects may use it |

**Row 10 blocks the model outright** and is a one-line schema fact rather than a judgement: while
`githubRepoId` is `@unique`, _"an org admin adds this repository to a second project"_ is
inexpressible. **Row 7 is the one most likely to be missed**, because the test passes today and will
keep passing — it simply asserts a boundary the product no longer has.

**What does NOT change:** the org remains the isolation boundary, and nothing here weakens it. A
repository of org A is never readable by org B, and every read still resolves its tenant from the
caller's identity rather than from anything a caller sends.

## Consequences

- **The implementation is its own STORY, not a subtask.** Eleven rows across two repositories,
  including a schema change on each side and a migration that has to merge N per-project graphs into
  one per-org graph without losing a snapshot. It is `blocked_by` nothing in MOTIR-1754 and blocks
  none of it: the surface MOTIR-1754 draws renders the project's configured set either way.
- **A migration question this document does not answer, and names rather than hides:** when two
  projects hold graphs for the same repository at different commits, which survives the merge? The
  newest `indexedAt` is the obvious answer and it is not obviously right — a project pinned to an
  older commit would silently move. That belongs to the implementation story with a real reading of
  how many such pairs exist in production.
- **The cost stops being a multiplier, on both sides.** Indexing `motir-core` for an org with two
  projects boots one container, not two — so the org's index allowance is drawn once and Motir's
  container time is spent once. `ciFleetCostMeterService`'s per-workload rollup is where the
  before/after reading comes from; quote the meter, do not assert the saving.
- **MOTIR-1765's isolation test is amended, not deleted.** It moves from project-level to org-level
  and stays exactly as load-bearing.

## Corrections this document makes

- **`code-graph-index-fleet.md` §5's _"tarball re-fetched PER PROJECT"_ row is SUPERSEDED**, not
  amended away: the container does not remove that symptom, it relocates it. The row's banner points
  here.
- **`codeGraphIndexService.ts`'s TENANCY note now names THIS decision** as the question's owner,
  rather than a story that disclaims it.
- **This document's own first recommendation is struck** at the top rather than edited away — the
  inversion it records (pricing the change to a wrong model instead of questioning the model) is
  worth more to the next reader than a clean document.

## References

- `lib/services/codeGraphIndexService.ts:30-48` (the TENANCY note), `:243`, `:250`, `:258`.
- `docs/decisions/code-graph-index-fleet.md:90` (the superseded row), §6 (untouched).
- `lib/services/projectRepoSetService.ts` / `project_repository` — MOTIR-1780.
- `lib/services/ciFleetCostMeterService.ts` — the per-workload container-seconds rollup, MOTIR-1995.
- MOTIR-1754 (the story), MOTIR-2028 / MOTIR-1989 (where the question came from), MOTIR-2105 (the
  stale-graph signal), MOTIR-2165 (offboarding).
