# What breaks under the non-bypass runtime role — an inventory

**MOTIR-2514.** Measured 2026-08-10, on the branch that also lands MOTIR-2519 (the
`prodect_app` → `motir_app` rename), MOTIR-2513 (the two-client test harness) and
MOTIR-2512 (the tenant-root INSERT policies). It **fixes nothing**; its output is a
count, a root-cause grouping, and the cards that follow from it.

## The question

MOTIR-2435 plans to point production's `DATABASE_URL` at `motir_app`, so the workspace
RLS policies finally execute. Its original premise was that the obstacle was the test
suite's fixtures. **How much of what fails is application code rather than fixtures?** —
because those are two different kinds of problem. A failing fixture is test debt. A
failing `lib/` path is a production defect that would break a feature for every customer
on the day of the cutover.

## How it was measured

Four batches under `TEST_DB_APP_ROLE=1`, which points `@/lib/db` at `motir_app` while
fixtures and teardown stay on the owner:

| batch | directories                                               | tests    |   failed |
| ----- | --------------------------------------------------------- | -------- | -------: |
| 1     | `workspaces`, `projects`, `comments`                      | 178      |      131 |
| 2     | `boards`, `sprints`                                       | 229      |      200 |
| 3     | `workItems`, `integration/work-items`, `custom-fields`    | 559      |      469 |
| 4     | `notifications`, `attachments`, `labels-components-watch` | 259      |      201 |
|       | **total**                                                 | **1225** | **1001** |

Coverage: these directories are a cross-section, not the whole surface — **441 test files
import `@/lib/db`** in total. The classification below is stable across all four batches,
which is the reason for stopping here rather than running the rest; the failure profile
had converged by batch 2.

Frames were classified by the topmost non-`node_modules` stack entry:

```
cat b*.txt | grep -oE "❯ [^ ]+ (tests|lib|app|scripts)/[^ :]+" \
  | awk '{print $3}' | sed -E 's#^(tests|lib|app|scripts)/.*#\1#' | sort | uniq -c
```

→ **1044 `lib/`**, **730 `tests/`**.

## Finding 1 — the `lib/` failures are ONE defect, not many

Every one of the 1044 `lib/` frames resolves to a single file, and 1048 failure lines
name a single error:

```
NotAMemberError: User <id> is not a member of workspace <id>.
 ❯ Object.assertMembership lib/services/projectsService.ts:532:19
 ❯ Object.createProject    lib/services/projectsService.ts:225:5
```

The user **is** a member. The gate reads the membership through
`workspaceMembershipRepository.findByUserAndWorkspace`, which uses the `db` singleton —
no transaction, so no GUCs. Under RLS `membership_visible_active_or_own` requires
`"workspaceId" = current_setting('app.workspace_id')` **or**
`"userId" = current_setting('app.user_id')`; with neither bound both sides are NULL, the
row is invisible, and the lookup returns `null`. The gate reports that as "not a member".

**The codebase already knows.** A tx-aware sibling exists, and its docstring is explicit:

> Same lookup as `findByUserAndWorkspace`, but inside the caller's transaction so the
> `membership_visible` RLS policy … admits the row under the non-bypass `motir_app`
> role. Used by role-gated reads that MUST be correct in production …; **the db-singleton
> variant above returns NULL under RLS when no context is bound.**

So the fix is not new code — it is routing the gates through the variant that already
exists. **12 call sites, across 7 services**, all of them access gates:

| file                                      | sites |
| ----------------------------------------- | ----: |
| `lib/services/projectAccessService.ts`    |     3 |
| `lib/services/workspacesService.ts`       |     3 |
| `lib/services/workspaceInvitesService.ts` |     2 |
| `lib/services/workItemsService.ts`        |     2 |
| `lib/services/projectsService.ts`         |     1 |
| `lib/services/triageService.ts`           |     1 |

**Why this is the worst possible failure mode, and worth its own card.** It fails CLOSED
and it fails DISHONESTLY: the user is told they are not a member of a workspace they own.
Nothing logs an RLS denial, because there is no denial — the query succeeded and returned
nothing. A cutover would present as "permissions are broken for everyone", with an error
message pointing at membership data that is perfectly correct.

## Finding 2 — the `tests/` failures are volume, and they are mechanical

730 frames, all the same shape: a fixture seeds or asserts through `@/lib/db` with no
workspace context, so RLS hides its own setup. There is no defect here — the tests were
written against a connection where the policies were inert.

The remedy is the harness MOTIR-2513 already provides: fixtures move to `adminDb`. It is
per-file work with no design questions, and it is the reason `TEST_DB_APP_ROLE` is opt-in
rather than the default.

## Finding 3 — noise, called out so it does not inflate the numbers

- **6 × `EPERM: operation not permitted, open '…/node_modules/…'`** — this sandbox's
  hardlinked `node_modules`, not the product. Environmental.
- **1 × `[vitest-pool]: Worker forks emitted error` / `Worker exited unexpectedly`** —
  one worker died under batch 3's load. Environmental.
- **1 × `new row violates row-level security policy for table "workspace_membership"`** —
  a genuine RLS denial, and the ONLY one in 1001 failures. It is `addMember` running
  without a bound workspace context; the same root shape as Finding 1, one verb over.

No `P2025`, no SQLSTATE `42501` beyond that single case. **The RLS surface is far
narrower than the failure count suggests** — 1001 failures, one root cause, one variant.

## Is flipping `TEST_DB_APP_ROLE` to the default reachable?

**Not yet, and it is blocked on Finding 1, not on the fixtures.** Fixing the 12 gate call
sites removes ~1044 of the failures at a stroke. The remaining ~730 fixture failures are
what stands between that and a default flip, and they can be migrated directory by
directory behind the flag without ever red-lighting `main`.

## RE-MEASURED after MOTIR-2527 — the gates admit, and the layer behind them is now visible

**2026-08-10, same four batches, same flag, on the branch that lands MOTIR-2527.** The card's
own criterion was that the `NotAMemberError` count reach zero. It does.

| batch |    tests | failed (before → after) | `NotAMemberError` |
| ----- | -------: | ----------------------: | ----------------: |
| 1     |      178 |               131 → 108 |           131 → 0 |
| 2     |      236 |               200 → 202 |               → 0 |
| 3     |      676 |               469 → 581 |               → 0 |
| 4     |      259 |               201 → 207 |               → 0 |
|       | **1349** |         **1001 → 1098** |      **1048 → 0** |

Frames, by the same classification command: **1044 `lib/` → 143**, and `NotAMemberError`
does not appear once in any batch.

**But the total did not fall, and that is the finding.** Two things move underneath it. The
batches are bigger than in August's run (1225 → 1349 tests — other cards have landed since),
so the counts are not directly comparable. And more importantly:

### Finding 4 — the membership gate was MASKING a second layer of the same defect

The failures that replaced it are **not** the fixture debt Finding 2 predicted. The largest
single group is now `ProjectNotFoundError` (135), with **94 frames in
`lib/repositories/projectRepository.ts`**, plus 31 in `workItemsService` and 14 in
`projectTagsService`:

| error                           | count | where                                               |
| ------------------------------- | ----: | --------------------------------------------------- |
| `ProjectNotFoundError`          |   135 | `projectRepository.findById` on the `db` singleton  |
| `PrismaClientKnownRequestError` |   120 | mostly fixture writes with no bound context         |
| `AssertionError`                |    31 | downstream of the above                             |
| RLS denials (all tables)        |     4 | `workspace_membership` ×2, `project` ×1, `board` ×1 |

Same root cause, one layer down: `project`, `work_item` and `board` carry workspace-keyed RLS
policies of their own, and a service that opens with an unbound read of one of them fails
before any gate is consulted. `createWorkItem` and `getTriageItemDetail` are the clearest
cases — each starts with a `db`-singleton `findById`, so under the flag they now throw
`ProjectNotFoundError` / `WorkItemNotFoundError` and never reach the membership gate at all.

**Why the original inventory could not see this.** The membership gate was the FIRST unbound
read on essentially every path, so it consumed the failure and hid every read behind it. The
"1044 frames, one file, one error" result was true and was also a ceiling artefact: fixing the
gate did not remove 1044 failures, it removed 1044 _masks_. This is worth stating plainly
because the same shape will recur — each layer fixed will reveal the next, and a count that
does not fall is not evidence that the fix did nothing.

**Consequence for the chain.** The claim that flipping `TEST_DB_APP_ROLE` to the default is
blocked only on fixtures (MOTIR-2528) is no longer accurate: it is blocked on the application
reads above as well. That work is filed separately rather than absorbed into MOTIR-2527, whose
scope was the membership gates and the one `addMember` write.

## RE-MEASURED after MOTIR-2569 — the Finding-4 reads are bound, and the table above was mis-attributed

**2026-08-11, same four batches, same flag, on the branch that lands MOTIR-2569.**

### First, the correction — 94 of those frames are not what this document said they were

Finding 4's table reads `ProjectNotFoundError | 135 | projectRepository.findById on the db
singleton`. **The attribution is wrong, and it matters more than the count.** Re-reading the raw
stack blocks rather than the frame tally:

```
ProjectNotFoundError: Project cmso… not found.
 ❯ Object.allocateWorkItemNumber lib/repositories/projectRepository.ts:913:34
 ❯ tests/fixtures/workItemFixtures.ts:154:17
 ❯ buildScenario tests/comments/commentsService.test.ts:87:17
```

Those frames are **`allocateWorkItemNumber`** — a raw `UPDATE "project" … RETURNING` that throws
when it matches zero rows — and they are entered **directly from a test fixture**, which opens its
own bare `db.$transaction` and calls the repository. They are Finding 2 fixture debt wearing a
`lib/` frame, not an application read.

**The classifier is what hid it.** Grouping by the topmost non-`node_modules` frame cannot separate
_the application read unbound_ from _a fixture reached into a repository_ — both land in `lib/`.
Finding 4 read the file name as if it identified the caller. Splitting the same 2026-08-10 baseline
by whether the frame BELOW the `lib/` one is a service or a test file:

| batch |    tests |   failed | `ProjectNotFoundError` — application | — entered from a fixture |
| ----- | -------: | -------: | -----------------------------------: | -----------------------: |
| 1     |      178 |      108 |                                    7 |                       41 |
| 2     |      236 |      202 |                                   17 |                        0 |
| 3     |      776 |      581 |                                   42 |                       59 |
| 4     |      262 |      204 |                                    2 |                      122 |
|       | **1452** | **1095** |                               **68** |                  **222** |

`WorkItemNotFoundError` is **0** across all four batches in both runs — these batches do not
exercise `getTriageItemDetail`; `tests/permissions/membershipGate.test.ts` is where that case is
pinned, and it now passes under the flag.

### And then the result

| batch |    tests | failed (before → after) | application `ProjectNotFoundError` | fixture-entered |
| ----- | -------: | ----------------------: | ---------------------------------: | --------------: |
| 1     |      178 |                108 → 98 |                          7 → **0** |         41 → 41 |
| 2     |      236 |               202 → 202 |                         17 → **0** |           0 → 0 |
| 3     |      776 |               581 → 579 |                         42 → **0** |         59 → 59 |
| 4     |      262 |               204 → 204 |                          2 → **0** |       122 → 122 |
|       | **1452** |         **1095 → 1083** |                         **68 → 0** |   **222 → 222** |

**Every application-path `ProjectNotFoundError` / `WorkItemNotFoundError` from a `lib/` frame is
gone.** The 222 that remain are unchanged by design: each is a `tests/` file calling
`projectRepository.allocateWorkItemNumber` directly, which is MOTIR-2528's fixture migration and
which MOTIR-2569's scope excludes by name. **A card cannot be gated on a number its own scope
forbids it to move** — the criterion was amended on the record for exactly this, and the reasoning
is filed as planning bug MOTIR-2686.

And the headline lesson holds a second time: **the total fell by 12 out of 1095.** Read alone that
looks like a fix that did nothing. The named class it was aimed at went to zero.

### What MOTIR-2569 changed

`lib/workspaces/tenantRead.ts` — `readProject` / `readProjectByIdentifier` / `readWorkItem`, the
sibling of `lib/workspaces/membershipGate.ts` one layer down. Each binds
`withWorkspaceContext({ userId, workspaceId })` when the caller has no bound transaction and reuses
the caller's when it has one. Roughly 60 gate-preceding reads across 20 services now go through
them, and the services that no longer need `@/lib/db` or the repository at all have had those
imports removed — which is the invariant worth keeping: **a service that still imports `db` is a
service that can still open an unbound transaction.**

Three sub-shapes were NOT the plain unbound read, and each is worth naming because none is visible
from the call site:

- **A bare `db.$transaction` fed into a gate.** 18 sites passed their own unbound `tx` into
  `assertPermission` / `assertCanEdit` / `resolveGatedWorkItem`, which defeats the
  `if (!tx) withWorkspaceContext(...)` short-circuit MOTIR-2527 installed — the gate then reads
  through a transaction that binds nothing. `readMembership`'s docstring warns about exactly this
  ("do not pass a transaction that binds no GUCs"); the warning had no enforcement.
- **`createWorkItem`'s key-allocation transaction.** Fixing only its opening read moved the failure
  four gates later without removing it: `allocateWorkItemNumber` is the transaction's first
  statement. Worse, the gate probe in `membershipGate.test.ts` classifies ANY `ProjectNotFoundError`
  as `blocked-before-gate`, so an unbound write transaction reads as an unreached gate.
- **The operator backfills** (`boardsService.backfillDefaultBoard`,
  `workflowsService.backfillDefaultWorkflow`, `workItemsService.backfillProvenanceForProject`) have
  no session, and the workspace they would bind is what the read RESOLVES. They use the
  `app.system_admin` arm the 2026-07-27 migration added to `project_workspace_or_system_read` for
  operator tooling, then run everything after it tenant-scoped. Their existence probes moved inside
  that tenant transaction too — `board` and `workflow_status` are workspace-keyed as well, so an
  unbound probe would report "none" for a project that has one and seed a second.

### Two branches left, both filed

- **MOTIR-2684 — the PUBLIC-project read path is structurally dark.** `project` carries exactly one
  policy and its `USING` is `workspaceId = app.workspace_id OR app.system_admin = 'true'`. A public
  reader is anonymous or cross-org, so there is no user to bind and no workspace to bind that would
  not presume the answer — and no arm admits the row regardless. A binding cannot fix it; the policy
  needs a public arm, which MOTIR-2569's scope excludes. **Every public-project surface 404s after
  the cutover, including a team's own logged-out view.**
- **MOTIR-2685 — the USERLESS reads.** The job runtime and the `workspaceId`-only helpers
  (`workflowsService.requirePolicyMode` / `canTransition`,
  `projectsService.assertProjectInWorkspace`, whose own docstring already says it is
  "only safe under the BYPASSRLS dev role") have a workspace but no actor, so they want
  `withWorkspaceServiceContext`, not these readers.

**Consequence for the chain, updated.** MOTIR-2528's default flip is now `blocked_by` MOTIR-2684 and
MOTIR-2685 as well as by its own fixture migration.

## Cards filed from this inventory

Both are **successors** to MOTIR-2435, not children of it — tasks under Epic 8, in a
same-level chain. Filing them under the container would have made that container
un-completable by its own PR, which is recorded as planning bug MOTIR-2538.

- **MOTIR-2527** — route the 12 membership-gate reads through the tx-aware variant
  (the production defect; Finding 1). `high`, 5 points, `blocked_by` MOTIR-2435.
- **MOTIR-2528** — migrate the DB-backed fixtures onto `adminDb`, directory by directory,
  and flip the default when the last one lands (Finding 2). 8 points, `blocked_by` 2527.
  **ARCHIVED 2026-08-12, superseded by the twenty-one cards in the section below.**

Filed later, from the Finding-4 re-measurement above:

- **MOTIR-2569** — route the tenant-table reads that gate or precede a gate through a bound
  context (Finding 4). `high`, 5 points, `blocked_by` MOTIR-2527. **Done.**
- **MOTIR-2684** — give the `project` policy a public arm so the public-project path resolves
  at all. `high`, 5 points, `blocked_by` 2569.
- **MOTIR-2685** — bind the userless reads (job runtime + `workspaceId`-only helpers) through
  `withWorkspaceServiceContext`. 3 points, `blocked_by` 2569.

The flip is `blocked_by` 2684 and 2685 as well — an application path that cannot read
its own tenant is not made ready by migrating fixtures.

## The fixture migration, partitioned (2026-08-12)

MOTIR-2528 was one card describing several pull requests, which no single card can close. It was
split by planning bug **MOTIR-2587** and archived. The partition below was **measured on
`origin/main` at `9e7637cf`**, not carried over from the batch names at the top of this document —
those are vitest filter substrings, and three of the directories they name (`tests/sprints`,
`tests/workspaces`, `tests/projects`) do not exist.

**The real surface: 464 files importing `@/lib/db`, holding 3 042 `db.` call sites.** That is every
file under `tests/` other than the Playwright directory `tests/e2e`. Playwright's specs end in
`.spec.ts`, and the `include` glob in `vitest.config.ts` matches only `.test.ts` / `.test.tsx`, so
the flag never reached those 20 files and they are not in any batch. Roughly 402 of the 3 042 sites
sit inside an `expect(...)`; those are the ones that must **stay** on `@/lib/db`, and getting that
call wrong is the only way this work can fail silently.

Each batch is one card, one PR, and independent of the other nineteen — nothing in the fixture
layer orders them, so they can be worked in any order or in parallel.

|   # | card       | paths                                                                   |   files | `db.` sites |
| --: | ---------- | ----------------------------------------------------------------------- | ------: | ----------: |
|   1 | MOTIR-2735 | `tests/` root — tenancy + RLS suites                                    |      14 |         195 |
|   2 | MOTIR-2736 | `tests/` root — org / workspace / project services                      |      14 |          92 |
|   3 | MOTIR-2737 | `tests/` root — identity, billing, route tests                          |      29 |         117 |
|   4 | MOTIR-2738 | `tests/integration/work-items` (A–L)                                    |      24 |         164 |
|   5 | MOTIR-2739 | `tests/integration/work-items` (M–W)                                    |      24 |         122 |
|   6 | MOTIR-2740 | `tests/boards`                                                          |      21 |         157 |
|   7 | MOTIR-2741 | `tests/ciFleet`                                                         |      13 |         208 |
|   8 | MOTIR-2742 | `tests/projectRepos` + `tests/ciMetering`                               |      22 |         204 |
|   9 | MOTIR-2743 | `tests/mcp`                                                             |      28 |          93 |
|  10 | MOTIR-2744 | `tests/jobs` + `dispatch` + `hosting`                                   |      22 |         115 |
|  11 | MOTIR-2745 | `tests/ai` + `tests/integration/ai`                                     |      29 |         125 |
|  12 | MOTIR-2746 | `tests/github` + `tests/gitlab`                                         |      25 |         132 |
|  13 | MOTIR-2747 | `tests/integration/sprints` + `tests/ready`                             |      24 |         125 |
|  14 | MOTIR-2748 | `tests/integration/plans` + `plan-seed` + `planning`                    |      17 |         213 |
|  15 | MOTIR-2749 | `tests/workflows` + `tests/automation`                                  |      22 |         161 |
|  16 | MOTIR-2750 | `tests/permissions` + `publicProjects` + `api-tokens`                   |      26 |         154 |
|  17 | MOTIR-2751 | `tests/attachments` + labels + notifications + comments + custom-fields |      19 |         211 |
|  18 | MOTIR-2752 | `tests/integration` root + `reports` + `dashboards`                     |      31 |         172 |
|  19 | MOTIR-2753 | `tests/work-items` + `triage` + `import` + `migrations`                 |      29 |         189 |
|  20 | MOTIR-2754 | `tests/api/v1` + the long tail                                          |      31 |          93 |
|     |            | **total**                                                               | **464** |   **3 042** |

- **MOTIR-2734** — retire `TEST_DB_APP_ROLE` and make `motir_app` the suite's default connection.
  `blocked_by` all twenty batches **and** 2684 and 2685. MOTIR-2515, the deployed cutover, is now
  `blocked_by` this card rather than 2528.

Two claims 2528 carried are false on `origin/main` and are not rebuilt into 2734: **no CI workflow
has ever set the flag** (`grep -rn TEST_DB_APP_ROLE .github/` is empty), and the `gateReachable`
guards in `membershipGate.test.ts` were already removed by 2569. The flag's whole code footprint is
now five sites: `parallelDb.ts:109` and `:133`, `app-role-harness.test.ts:5,34,83`,
`tenant-root-creation-rls.test.ts:6,36`, and `membershipGate.test.ts:16,78`.

The chain then ends at **MOTIR-2515**, the deployed cutover — which is the point at
which RLS actually starts executing in production. Nothing before it changes what the
deployed application is subject to.
