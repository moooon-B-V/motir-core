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

## Cards filed from this inventory

Both are **successors** to MOTIR-2435, not children of it — tasks under Epic 8, in a
same-level chain. Filing them under the container would have made that container
un-completable by its own PR, which is recorded as planning bug MOTIR-2538.

- **MOTIR-2527** — route the 12 membership-gate reads through the tx-aware variant
  (the production defect; Finding 1). `high`, 5 points, `blocked_by` MOTIR-2435.
- **MOTIR-2528** — migrate the DB-backed fixtures onto `adminDb`, directory by directory,
  and flip the default when the last one lands (Finding 2). 8 points, `blocked_by` 2527.

The chain then ends at **MOTIR-2515**, the deployed cutover — which is the point at
which RLS actually starts executing in production. Nothing before it changes what the
deployed application is subject to.
