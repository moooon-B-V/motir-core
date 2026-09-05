# Should a repository be indexed into EVERY project of its workspace?

**Status: PROPOSED — the options are weighed and the recommendation is stated; the choice is the
owner's.** Story MOTIR-1754 · Subtask MOTIR-2029. Carried out of MOTIR-2028 (the MOTIR-1989 planning
bug), whose fourth acceptance criterion required this question be filed rather than left in a bug body.

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

|                  | serverless                                                   | containers                                                                    |
| ---------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| N projects costs | N function invocations, absorbed by an included-minutes pool | **N machines × ~924 MB × minutes of billed compute, for byte-identical work** |

§6's argument — _one container per REPO_, forced by the ledger contract — is **untouched** by this
document. That argument is about not batching many REPOSITORIES into one container, and it survives
intact. What was never sized is the orthogonal ×N over PROJECTS.

**The multiplier is live, not hypothetical.** The `moooon` workspace holds two projects, `MOTIR` and
`TEST`, so indexing `motir-core` boots two containers and builds the same graph twice — half of it
into a throwaway test project. Every workspace pays its own project count.

**The number is measurable, and it should be measured before the choice is made rather than
estimated.** `ciFleetCostMeterService` stamps per-container seconds and cost with a `workload`
(MOTIR-1995), and its own header records that an earlier claim of per-workload attribution was false
until every row carried one. So the cost of this fan-out is a query against that rollup, per
workspace, keyed by the index workload — not a figure anyone has to assert.

## The options

### 1. Keep the workspace-wide fan-out

Every project of a workspace can plan against any repository the workspace connected, with no new
gate and no migration. Cost scales with project count; a scratch project costs a full index.

### 2. Narrow to the project's declared repository SET

`project_repository` (MOTIR-1780) already exists — one row per intended repository, each carrying the
realized `GithubRepo` it maps to, read through `projectRepoSetService.getSet` / `listByProject`.
Index only into projects whose set claims the repository.

Cheapest, and it matches what MOTIR-1767 already reads for the code-context surface. **Its cost is
the empty-set case:** a project that never ran the establish step has no rows and would silently go
code-blind — which is the exact failure MOTIR-1754 exists to end, re-created by its own story.

### 3. Narrow WITH a fallback — the declared set when non-empty, the workspace-wide fan-out when empty

Preserves today's behaviour for legacy and unestablished projects, and charges the multiplier only
where the plan asked for it. **Recommended.** It is the only option that reduces the cost without
creating a new silent downgrade, and its fallback is exactly the population that cannot express an
intent yet.

### 4. Index once per REPOSITORY and share the graph across a workspace's projects

The lowest theoretical cost, and out of scope here. It is a motir-ai TENANCY change: the code-graph
store is `aiProjectId`-keyed and `codeGraphContext` binds tenancy structurally. Recorded so the
decision says why it was not taken now, not because it is wrong.

## What the decision must settle

**⚠️ These are the three the options above do NOT answer, and they are the reason this is a decision
rather than a preference.**

1. **The empty-set case.** Under option 2 or 3, what does a project with no `project_repository` rows
   get? Option 3's answer is "today's behaviour". Option 2's is "nothing", and that must then be a
   VISIBLE state rather than a silent downgrade — MOTIR-1754 owns the code-blind signal, and
   narrowing must not manufacture more of what that signal is for.
2. **Already-indexed graphs the narrowed rule would exclude.** Left stale where they are, or actively
   removed? A stale graph that keeps answering is the failure MOTIR-2105 is about; leaving them is
   cheap and dishonest, removing them is `POST /v1/code-graph/offboard`'s job (MOTIR-2165) and is a
   second card either way.
3. **The measured multiplier, per workspace.** Quote the meter, not a guess.

## Consequences of the recommendation

If option 3 is chosen, the implementation is its own subtask, wired `blocked_by` this decision —
deliberately not folded in here, because narrowing the fan-out is a behaviour change to shipped,
working plumbing and it wants its own tests and its own review.

If option 1 is chosen, the reason is recorded here so the next planner does not re-open the question
from the same evidence.

## Corrections this document makes

- **`code-graph-index-fleet.md` §5's _"tarball re-fetched PER PROJECT"_ row is SUPERSEDED**, not
  amended away: the container does not remove that symptom, it relocates it. The row's banner points
  here.
- **`codeGraphIndexService.ts`'s TENANCY note now names THIS decision** as the question's owner,
  rather than a story that disclaims it.

## References

- `lib/services/codeGraphIndexService.ts:30-48` (the TENANCY note), `:243`, `:250`, `:258`.
- `docs/decisions/code-graph-index-fleet.md:90` (the superseded row), §6 (untouched).
- `lib/services/projectRepoSetService.ts` / `project_repository` — MOTIR-1780.
- `lib/services/ciFleetCostMeterService.ts` — the per-workload container-seconds rollup, MOTIR-1995.
- MOTIR-1754 (the story), MOTIR-2028 / MOTIR-1989 (where the question came from), MOTIR-2105 (the
  stale-graph signal), MOTIR-2165 (offboarding).
