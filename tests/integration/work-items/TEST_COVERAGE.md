# Story 1.4 work-item model — integration test coverage matrix

This file maps every invariant from the **Subtask 1.4.7** card's _Test areas_
list to the test (file → `describe`) that protects it. It is the planner's
record of what 1.4.7 **added** versus what it **inherited** from the scoped
tests that shipped with 1.4.2–1.4.6.

The 1.4.7 card was authored before 1.4.2–1.4.6 landed individually; each of
those Subtasks shipped its own scoped tests, so much of the matrix was already
covered. 1.4.7's job was to **audit** that coverage, **fill** the gaps, and
**extract** shared fixtures — not to re-duplicate inherited assertions.

Files referenced (all under `tests/integration/work-items/` unless noted):

- `repository.test.ts` — `workItemRepository` (triggers via the repo path)
- `link-repository.test.ts` — `workItemLinkRepository` (link triggers)
- `service.test.ts` — `workItemsService` happy-path + concurrency
- `service-edge-cases.test.ts` — `workItemsService` error/guard/edge branches **(added 1.4.7)**
- `kind-parent-matrix.test.ts` — full service-driven kind-parent matrix **(added 1.4.7)**
- `cross-project-links.test.ts` — cross-project links, same workspace **(added 1.4.7)**
- `revisions.test.ts` — revision audit (diff, atomicity, ordering, RLS)
- `../../work-item-rls.test.ts` (i.e. `tests/work-item-rls.test.ts`) — RLS + finding #19

Status legend: **inherited** = shipped by an earlier Subtask, kept as-is ·
**filled** = was partial, 1.4.7 added the missing case(s) · **added** = net-new
in 1.4.7.

| Card invariant                                                                                                                                                                 | Status    | Covering test (file → describe)                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kind-parent matrix** — every (parentKind, childKind) pair; legal succeeds, illegal → `IllegalParentTypeError`; via service AND repo                                          | filled    | repo path (2 cells): `repository.test.ts` → "create — kind-parent trigger" (inherited 1.4.2). Service path (all 30 cells): `kind-parent-matrix.test.ts` → "kind-parent matrix — service-driven (every cell)" **(added 1.4.7)**                                                                                    |
| **Depth limit** — 4-deep legal max; 5th → `DepthLimitExceededError`                                                                                                            | inherited | `repository.test.ts` → "create — depth-limit trigger" (1.4.2)                                                                                                                                                                                                                                                     |
| **Cycle prevention (re-parent)** — A→B→C, move A under C → `ParentCycleError`                                                                                                  | filled    | 2-deep: `repository.test.ts` → "update — cycle trigger" (1.4.2). 3-hop (A→B→C→D): same describe, "rejects a 3-hop re-parent cycle" **(added 1.4.7)**. Service-path note (kind pre-flight pre-empts): `service.test.ts` → "moveWorkItem — re-parent cycle is intercepted by the kind pre-flight" **(added 1.4.7)** |
| **Concurrent key allocation** — 20 concurrent creates → contiguous 1..20, no dups/gaps                                                                                         | filled    | 8-wide: `service.test.ts` → "createWorkItem — key allocation" (1.4.4). 20-wide contiguous: same describe, "allocates a contiguous, gap-free, duplicate-free key set under 20-wide concurrency" **(added 1.4.7)**                                                                                                  |
| **Workspace RLS isolation** — W1 GUC hides W2; no GUC → zero rows; WITH CHECK rejects foreign insert                                                                           | inherited | `tests/work-item-rls.test.ts` → "work_item RLS — read isolation" + "write isolation (WITH CHECK)" (1.4.5)                                                                                                                                                                                                         |
| **Project RLS narrowing** — W1+P1 hides P2; W1 + no project shows both                                                                                                         | inherited | `tests/work-item-rls.test.ts` → "work_item RLS — project narrowing (restrictive policy)" (1.4.5)                                                                                                                                                                                                                  |
| **Fractional indexing** — move-to-start / -to-end / -between sort lexically                                                                                                    | filled    | reorder-between: `service.test.ts` → "moveWorkItem" (1.4.4). Three explicit slots: `service.test.ts` → "moveWorkItem — edge cases" **(added 1.4.7)**                                                                                                                                                              |
| **Revision atomicity — both directions** — revision-write-fails rolls back the item; item-write-fails leaves no orphan revision                                                | filled    | revision-fails (create): `revisions.test.ts` → "atomicity — revision write failure rolls back the mutation" (1.4.6). Item-fails (create) + revision-fails (update): same describe, "an injected failure in the work_item write…" + "updateWorkItem: an injected failure in the revision write…" **(added 1.4.7)** |
| **Revision diff correctness** — title-only diff; title+assigneeId both; no-op → no revision; explanationMd edit captures auto-source-transition                                | filled    | title-only / no-op / explanationMd+source: `revisions.test.ts` → "createWorkItem — revision" + "updateWorkItem — revision" (1.4.6). Multi-field (title+assigneeId): same describe, "writes ONE 'updated' revision capturing BOTH changed fields" **(added 1.4.7)**                                                |
| **Explanation-source state machine** — create → `user_authored`; explicit `ai_draft`; edit auto-flips to `user_edited`; explicit source wins; direct source-only PATCH allowed | filled    | 3 core cases: `service.test.ts` → "updateWorkItem — explanation-source state machine" (1.4.4). Source-only PATCH (badge dismissal): same describe, "patches explanationSource alone…" **(added 1.4.7)**                                                                                                           |
| **Link cycle prevention** — A↔B 2-cycle; deeper A→B→C→A; `relates_to` exempt                                                                                                   | filled    | 2-cycle + relates_to exempt: `link-repository.test.ts` → "create — cycle trigger (is_blocked_by only)" (1.4.3); service path: `service.test.ts` → "linkWorkItems" (1.4.4). 3-hop A→B→C→A: same link-repo describe, "rejects a 3-hop is_blocked_by cycle" **(added 1.4.7)**                                        |
| **Self-link rejection** — `linkWorkItems(A, A, *)` → `SelfLinkError`                                                                                                           | inherited | `link-repository.test.ts` → "create — self-link trigger" (1.4.3)                                                                                                                                                                                                                                                  |
| **Cross-workspace link rejection** — service guard AND trigger backstop                                                                                                        | filled    | trigger: `link-repository.test.ts` → "create — workspace consistency trigger" (1.4.3). Service guard: `service-edge-cases.test.ts` → "rejects a cross-workspace link at the service guard" **(added 1.4.7)**                                                                                                      |
| **Symmetric `relates_to`** — two rows on link; both removed on unlink                                                                                                          | inherited | `service.test.ts` → "linkWorkItems" ("relates_to writes BOTH rows") + "unlinkWorkItems" (1.4.4)                                                                                                                                                                                                                   |
| **Duplicate link rejection** — second identical link → `DuplicateLinkError`                                                                                                    | inherited | `link-repository.test.ts` → "create — duplicate-link rejection" (1.4.3)                                                                                                                                                                                                                                           |
| **Link revision audit** — link/unlink write a revision on the from item                                                                                                        | inherited | `revisions.test.ts` → "linkWorkItems / unlinkWorkItems — revisions" (1.4.6)                                                                                                                                                                                                                                       |
| **Ready-set predicate** — A is_blocked_by B+C: false→(B done)false→(C done)true; unlink restores                                                                               | filled    | done-progression: `service.test.ts` → "isReady" (1.4.4). Unlink-restores (re-reads live state): same describe, "re-reads the live blocker set…" **(added 1.4.7)**                                                                                                                                                 |
| **Cross-project links** — A∈P1, B∈P2 (same W1); link succeeds; getBlockers(A) returns B under P1-narrowing                                                                     | added     | `cross-project-links.test.ts` → "cross-project links — service path" + "…RLS narrowing does not apply to the link table" **(added 1.4.7)**                                                                                                                                                                        |

## Acceptance-criteria infrastructure (added by 1.4.7)

| AC item                                                                                                                      | Where                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Shared fixtures (`userFixtures`, `workspaceFixtures`, `projectFixtures`, `workItemFixtures`, `index`, `makeWorkItemFixture`) | `tests/fixtures/` — the four existing test files import from here; inlined helpers removed                                       |
| Coverage ≥90% (branches/functions/lines) on the service + 3 repos                                                            | `vitest.config.ts` `coverage.thresholds`; run via `pnpm test:coverage`; enforced in CI (`.github/workflows/ci.yml` → `test` job) |
| 20-wide `Promise.all` contiguous-key stress                                                                                  | `service.test.ts` → "createWorkItem — key allocation"                                                                            |
| Every test names the invariant in its `describe`                                                                             | enforced throughout (see table)                                                                                                  |

## A note on test parallelism + GUC hygiene (card AC)

`vitest.config.ts` sets `fileParallelism: false` + `sequence.concurrent: false`,
so test files run serially against the one local Postgres — the "passes under
default concurrency" requirement is met by design, with no cross-file row races.

Every RLS assertion runs **inside** a transaction that binds the GUCs via
`set_config(..., true)` (transaction-local) and `SET LOCAL ROLE prodect_app`
(reverts at commit) — see `asAppRole` in `tests/work-item-rls.test.ts`,
`revisions.test.ts`, and `cross-project-links.test.ts`, and `withWorkspaceContext`
in `lib/workspaces/context.ts`. Because the binding is transaction-scoped, the
GUC is discarded at every transaction boundary; **no test sets a GUC outside a
transaction**, so there is no cross-test GUC bleed to reset. `beforeEach`
truncates the work-item / link / revision tables plus the auth tables, so row
state never carries between cases either.

## Coverage numbers (latest `pnpm test:coverage`)

| Module                                           | % Branch | % Funcs | % Lines |
| ------------------------------------------------ | -------- | ------- | ------- |
| `lib/services/workItemsService.ts`               | 94.97    | 100     | 99.46   |
| `lib/repositories/workItemRepository.ts`         | 91.93    | 100     | 100     |
| `lib/repositories/workItemLinkRepository.ts`     | 91.66    | 100     | 100     |
| `lib/repositories/workItemRevisionRepository.ts` | 100      | 100     | 100     |

The handful of remaining uncovered branches are defensive error-shape parsers
(`extractSqlState` / `extractMessage` fallbacks, the final rethrows, the
`?? 0` count guard) that real Postgres/Prisma error shapes never reach; each is
marked with an inline `/* istanbul ignore … -- <reason> */` at its site.
