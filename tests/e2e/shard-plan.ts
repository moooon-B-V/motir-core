// The bulk-leg shard plan (MOTIR-2617) — spec→leg membership derived from
// MEASURED per-spec cost, not from Playwright's `--shard=i/5` slice.
//
// WHY this exists. `--shard=i/N` partitions by test COUNT, keeping whole files
// together in DISCOVERY (alphabetical) order and slicing contiguously. Nothing
// about that slice knows what a spec costs, so the heaviest specs collect on
// whichever leg the alphabet drops them on, and nothing notices when a new spec
// joins the pile. Measured over two green `main` runs (below), the count-based
// split ran the five bulk legs at 159–280 s of test time — a 55 %-of-mean spread
// with the slowest leg carrying ~1.75× the fastest. That imbalance is the
// standing input to the `bulk-4` webServer-degradation flake (MOTIR-2617, three
// occurrences: PRs #1636 / #1912 / #2014): one runner accumulates the load, its
// `next start` server creeps over a memory/CPU cliff partway through the shard,
// and every navigation after that point hangs for the full 180 s test timeout.
//
// So membership is computed here instead: `SPEC_COST_SECONDS` records what each
// spec actually cost, and `assignBulkLegs` bin-packs those costs across the legs
// (longest-processing-time first — the standard greedy makespan heuristic,
// deterministic and total). On the same measurement the spread drops to <1 %.
//
// THE GUARD IS THE POINT. `tests/e2e-shard-plan.test.ts` asserts that every spec
// file the main Playwright config can run has a cost entry here. A new spec that
// nobody measured therefore fails the unit lane instead of silently landing on
// whichever leg the alphabet picks — which is exactly the failure mode above.
//
// Consumed by `playwright.config.ts` (E2E_SHARD=<leg id> → `testMatch`) and by
// the `e2e` matrix in `.github/workflows/ci.yml`. Deliberately dependency-free:
// the Playwright config imports it at module scope, and so does a vitest guard.

/** The bulk legs, in matrix order. */
export const BULK_LEG_IDS = ['bulk-1', 'bulk-2', 'bulk-3', 'bulk-4', 'bulk-5'] as const;

export type BulkLegId = (typeof BULK_LEG_IDS)[number];

/**
 * MEASURED per-spec cost, in seconds of test execution.
 *
 * Source: the `playwright-report-bulk-{1..5}` artifacts of two green `main` CI
 * runs — **31438176201** (2026-08-10 22:24Z) and **31440981319** (2026-08-10
 * 23:05Z) — summing every `result.duration` per spec file and averaging the two.
 * Playwright attributes hook time to the test it runs for, so this includes each
 * spec's seeding, not just its assertions.
 *
 * A `0` is a real measurement, not a gap: those specs contribute NO tests to a
 * bulk leg because every test in them is selected away by the legs'
 * `--grep-invert "(board(-scrum)?|collab|epic6)-at-scale|@a11y"` — they belong to
 * the at-scale or @a11y legs. They are still assigned a bulk leg (Playwright
 * loads the file and finds nothing to run) so that "every spec file belongs to
 * exactly one leg" stays a total statement the guard can check.
 *
 * TO RE-MEASURE: download the `playwright-report-bulk-*` artifacts of a green
 * run and sum durations per file — or read the `out/e2e-harness/*.jsonl` series
 * the harness watchdog now uploads with every leg, whose `test` records carry
 * the same per-spec durations alongside the memory samples.
 *
 * ⚠️ THE TWELVE SPECS PROMOTED BY MOTIR-2769 carry a DIFFERENT provenance, stated
 * so nobody averages them with the rest: they were measured LOCALLY, in one run
 * against a production build on 2026-08-13, because they had never run in this
 * lane before and a spec with no entry is assigned to no leg at all. They are
 * honest numbers for one machine, not the two-CI-run average above — expect CI
 * to differ, and re-measure them from the first green run that includes them.
 * `onboarding-migrate.spec.ts` (43.5 s) is by far the heaviest of the twelve and
 * is the one to watch when the bin-packer redistributes.
 *
 * ⚠️ `plan-decision-permission.spec.ts` (MOTIR-3188) carries the LOCAL provenance
 * too, for the same reason the twelve above do: it is a brand-new spec, and a
 * spec with no entry here is assigned to no leg and never runs — which is what
 * the guard caught on its first CI run. Measured on 2026-08-20 against a
 * production build, twice: **2.8 s** alone on a cold server and **1.8 s** in a
 * warm run beside two siblings. The HIGHER reading is recorded, because
 * under-estimating is the direction that unbalances a bin-packer.
 *
 * That same run is the CALIBRATION for every local number in this file, which
 * nothing had until now: `custom-roles.spec.ts` measured **8.3 s** locally
 * against **8.2 s** here, and `roles-permissions.spec.ts` **6.5 s** against
 * **9.3 s**. So a local reading is in the same units and runs at or below the CI
 * cost — never above it. Re-measure from the first green run that includes it.
 *
 * ⚠️ `plan-proposal-correction.spec.ts` (MOTIR-3543) carries the LOCAL provenance
 * too, and the guard caught it with no entry on its FIRST CI run — the failure
 * this file exists to make loud, working exactly as designed: the spec passed
 * locally and would have been assigned to no leg and never run.
 *
 * Measured on 2026-08-26 against a production build, on its own port and
 * database, THREE times: **14.7 s** on a cold server, then **7.4 s** and
 * **6.3 s** warm. The COLD reading is what is recorded, following
 * `plan-decision-permission.spec.ts` above — under-estimating is the direction
 * that unbalances a bin-packer, and this spec's first navigation compiles the
 * plan-detail route. The spread is wider than the others here because the spec
 * drives six MCP round trips interleaved with four page loads, so a warm run
 * saves proportionally more. Re-measure from the first green CI run that
 * includes it; expect something between the two.
 *
 * ⚠️ `jobs-fanout-engine.spec.ts` (MOTIR-3462) carries the LOCAL provenance too,
 * and for the reason the guard exists: a brand-new spec with no entry here is
 * assigned to no leg and never runs — which is exactly what the guard caught on
 * its first CI run. Measured on 2026-08-26 against a production build, on its
 * own lane with its own port and database: **4.7 s + 1.8 s + 1.8 s = 8.3 s** of
 * test time (the ~4.7 min wall is the build, which the legs pay once). Like the
 * others here, it is an honest number for one machine and one run — re-measure
 * it from the first green CI run that includes it.
 *
 * ⚠️ `jobs-postgres-engine.spec.ts` (MOTIR-3427) carries the LOCAL provenance
 * too, and it is a brand-new spec — the guard caught it with no entry on its
 * first CI run, which is exactly the failure this file exists to make loud: a
 * spec with no cost here is assigned to NO leg and never runs, so it would have
 * gone green by not executing.
 *
 * Measured on 2026-08-25 against a production build, TWICE, six tests each:
 * 18.2 s and 18.0 s of test bodies. Recorded as **22.0**, from the sum of the
 * per-test MAXIMA across the two runs (20.3 s) plus headroom — the higher
 * reading is the one to keep, because under-estimating is the direction that
 * unbalances a bin-packer, and the calibration note above says a local reading
 * runs at or below the CI cost.
 *
 * ⚠️ `jobs-scheduled-engine.spec.ts` (MOTIR-3473) is the same story, one card
 * later — brand new, and the guard caught it with no entry on its first CI run.
 * Same LOCAL provenance, measured on 2026-08-25 against a production build.
 *
 * ⚠️ BUT ITS NUMBER IS A CEILING, NOT AN AVERAGE, AND THAT IS THE POINT. Its
 * catch-up scenario waits for a REAL `* * * * *` fire to pass on the scheduler's
 * own watch — the only way to observe the `skip` disposition, which suppresses a
 * fire from before start-up and is therefore indistinguishable from `latest`
 * through the lane's long-running shared worker. That wait is uniformly 0–60 s
 * depending on where in the minute the spec starts, so this spec's cost is not a
 * point value — and two back-to-back runs against the same server MEASURED that
 * directly: the catch-up scenario took **10.1 s** in one and **51.0 s** in the
 * next, a 41 s swing from nothing but the wall clock. Totals were 23.3 s and
 * 61.8 s of test bodies; the sum of per-test maxima is 64.2 s, and the true
 * worst case is that plus the ~9 s the longer run still had left to wait.
 *
 * **85.0 is recorded, the worst case rather than the observation**, because this
 * file's own argument cuts that way: under-estimating is the direction that
 * unbalances a bin-packer, and a spec whose true cost can exceed its entry by a
 * minute is exactly the input that produced the `bulk-4` degradation this plan
 * exists to fix. A leg packed against the ceiling is merely early; one packed
 * against the average is occasionally over.
 *
 * ⚠️ IT ALSO RUNS A THIRD PROCESS. This spec's lane starts the Postgres job
 * engine's worker (`tests/e2e/_helpers/job-worker-process.ts`), whose startup is
 * paid ONCE in `globalSetup` and therefore does NOT appear in this per-spec cost.
 * Re-measure from the first green run that includes it.
 *
 * ⚠️ `shell-viewport-floor.spec.ts` (MOTIR-3208, re-measured for MOTIR-3286)
 * carries a FOURTH provenance: it had never run in this lane, so it was measured
 * LOCALLY against a production build on 2026-08-20 — three test BODIES at
 * 2.6 / 1.2 / 1.1 s (4.9 s total, sign-up and seeding included, since this spec
 * seeds inside the test rather than in a hook), rounded to 8.0 to cover the
 * three `resetDatabase()` hooks the reporter attributes separately.
 *
 * MOTIR-3286 added a FOURTH test (the containing-block leak) and re-measured the
 * same way on 2026-08-21: bodies at 2.3 / 1.1 / 0.7 / 0.7 s = **4.8 s**. The
 * bodies did not grow — the new test is one of the cheap ones and the run was
 * warmer — but there is now a fourth hook, and the 8.0 entry priced hooks at
 * (8.0 − 4.9) / 3 ≈ 1.03 s each. 4.8 + 4 × 1.03 ≈ 8.9, recorded as **9.5**:
 * rounding UP is the safe direction, because under-estimating is what unbalances
 * a bin-packer. Re-measure it from the first green CI run that includes it.
 *
 * ⚠️ `app-role-surfaces.spec.ts` (MOTIR-2816) carries a THIRD provenance and a
 * cost of ~0 that is honest for THIS lane and misleading anywhere else. Every
 * test in it calls `test.skip()` unless `E2E_APP_ROLE=1`, and the bulk legs never
 * set that — so in this lane it loads, skips seven tests and contributes no
 * execution time. Under its own harness it is a full sign-in-plus-seven-surfaces
 * pass (measured locally at ~95 s). Re-measure it here only if the flag ever
 * becomes the lane default; until then a real number would be a lie about what
 * the bin-packer is scheduling.
 *
 * ⚠️ `auth-signed-in-bounce.spec.ts` (MOTIR-3372) carries the LOCAL provenance
 * too, and it is here because the guard caught it: a spec with no entry is
 * assigned to no leg, so its first CI run executed it ZERO times while every
 * check went green about it. Measured on 2026-08-21 against a production build
 * on a private cluster, twice: **3.6 s** wall for the file on the first run, and
 * **1.51 s** of test BODIES (1.155 + 0.351) on a warm second run. The gap is the
 * two `resetDatabase()` hooks the reporter attributes separately — ≈1.05 s each,
 * which agrees with the ≈1.03 s/hook figure `shell-viewport-floor` derived above.
 * Recorded as **4.5**: the higher reading, rounded UP, because under-estimating
 * is the direction that unbalances the bin-packer and a local number runs at or
 * below the CI cost. Re-measure from the first green run that includes it.
 */
export const SPEC_COST_SECONDS: Readonly<Record<string, number>> = {
  'activity.spec.ts': 11.2,
  'app-role-surfaces.spec.ts': 0,
  'ai-callout-gate.spec.ts': 1.5,
  'ai-plan-generation.spec.ts': 10.0,
  'api-docs.spec.ts': 15.0,
  'api-tokens.spec.ts': 18.2,
  'appearance-sync.spec.ts': 4.9,
  'archive-flow.spec.ts': 10.3,
  'attachments.spec.ts': 14.9,
  'auth-credentials.spec.ts': 3.6,
  'auth-google.spec.ts': 3.5,
  'auth-post-auth-landing.spec.ts': 12.0,
  'auth-signed-in-bounce.spec.ts': 4.5,
  'automation.spec.ts': 12.1,
  'backlog-filter.spec.ts': 3.1,
  'backlog.spec.ts': 16.9,
  'billing-selfhost.spec.ts': 2.2,
  'board-a11y.spec.ts': 0,
  'board-at-scale-interaction.spec.ts': 0,
  'board-at-scale.spec.ts': 0,
  'board-config.spec.ts': 11.0,
  'board-crud.spec.ts': 16.8,
  'board-filter.spec.ts': 3.4,
  'board-load.spec.ts': 5.7,
  'board-projection.spec.ts': 7.5,
  'board-scrum-at-scale-interaction.spec.ts': 0,
  'board-scrum-at-scale.spec.ts': 0,
  'board-scrum.spec.ts': 11.0,
  'board-swimlanes.spec.ts': 12.3,
  'board-ui.spec.ts': 45.1,
  'build-in-public-flow.spec.ts': 8.0,
  'canvas-detail.spec.ts': 5.7,
  'charts.spec.ts': 8.9,
  'child-panel-graph.spec.ts': 4.4,
  'cli-connect.spec.ts': 20.2,
  'collab-at-scale.spec.ts': 0,
  'collab-journey.spec.ts': 10.4,
  'comments.spec.ts': 11.6,
  'custom-fields.spec.ts': 18.5,
  'custom-roles.spec.ts': 8.2,
  'dashboards.spec.ts': 12.6,
  'design-result.spec.ts': 6.3,
  'docs-index.spec.ts': 1.7,
  'epic-privacy-flow.spec.ts': 6.5,
  'epic2-acceptance.spec.ts': 6.7,
  'epic6-at-scale.spec.ts': 0,
  'epic6-journey.spec.ts': 12.7,
  'estimation.spec.ts': 12.9,
  'filter-builder.spec.ts': 20.0,
  'github.spec.ts': 7.1,
  'gitlab.spec.ts': 4.9,
  'home.spec.ts': 8.0,
  'import.spec.ts': 7.4,
  'issue-create-edit-flow.spec.ts': 14.1,
  'issue-detail-flow.spec.ts': 46.7,
  'issue-list-flow.spec.ts': 44.7,
  'jobs-dashboard.spec.ts': 7.4,
  'jobs-fanout-engine.spec.ts': 8.3,
  'jobs-flow.spec.ts': 89.7,
  'jobs-postgres-engine.spec.ts': 22.0,
  'jobs-scheduled-engine.spec.ts': 85.0,
  'labels-components-watch.spec.ts': 27.6,
  'link-search-flow.spec.ts': 12.6,
  'mcp-docs.spec.ts': 2.2,
  'member-facing-permissions.spec.ts': 6.6,
  'migrate-index-fleet.spec.ts': 26.1,
  'multi-tenant-isolation.spec.ts': 2.2,
  'notifications.spec.ts': 13.8,
  'onboarding-discovery.spec.ts': 2.5,
  'onboarding-entrance.spec.ts': 5.8,
  'onboarding-entry.spec.ts': 3.5,
  'onboarding-fresh.spec.ts': 8.6,
  'onboarding-migrate.spec.ts': 43.5,
  'onboarding-ran-gate.spec.ts': 11.9,
  'org-admin.spec.ts': 7.9,
  'per-domain-admin-permissions.spec.ts': 11.4,
  'permission-gated-ui.spec.ts': 10.8,
  'plan-change-planner-turn.spec.ts': 6.7,
  'plan-decision-permission.spec.ts': 2.8,
  'plan-proposal-correction.spec.ts': 14.7,
  'planning-anchor-level.spec.ts': 9.4,
  'plans-review.spec.ts': 6.3,
  'profile.spec.ts': 10.8,
  'project-access.spec.ts': 8.7,
  'project-details.spec.ts': 8.0,
  'project-isolation.spec.ts': 4.9,
  'project-logo.spec.ts': 9.0,
  'project-square-flow.spec.ts': 4.3,
  'projects-flow.spec.ts': 5.3,
  'provenance.spec.ts': 14.8,
  'public-overview-edit.spec.ts': 7.0,
  'public-project-flow.spec.ts': 7.2,
  'public-signin-modal.spec.ts': 3.4,
  'quick-view-edit.spec.ts': 14.5,
  'ready.spec.ts': 5.9,
  'reports.spec.ts': 18.0,
  // ⚠️ A FOURTH provenance (MOTIR-3009): promoted out of the acceptance lane by
  // the story that changed the lifecycle it walks, and measured LOCALLY in this
  // lane on 2026-08-19 against a production build — it had never run here. The
  // number is small because `_helpers/promoted-regression` makes its ~10 pacing
  // beats no-ops; the SAME spec takes about a minute when it is recording. Like
  // the twelve above, re-measure it from the first green CI run that includes it.
  'repository-set.spec.ts': 2.2,
  'roadmap-auto-drill.spec.ts': 4.0,
  'roadmap-done-ready.spec.ts': 2.6,
  'roadmap-flow.spec.ts': 4.8,
  'roadmap-fullscreen.spec.ts': 2.9,
  'roadmap-locate.spec.ts': 3.1,
  'roadmap-refresh-scope.spec.ts': 8.5,
  'roadmap-scope-toggle.spec.ts': 5.8,
  'roles-permissions.spec.ts': 9.3,
  'saved-filters.spec.ts': 15.2,
  'settings-area.spec.ts': 10.8,
  'shell-a11y-detail.spec.ts': 0,
  'shell-a11y-tokens.spec.ts': 0,
  'shell-a11y-wide.spec.ts': 0,
  'shell-a11y.spec.ts': 0,
  'shell-context-path.spec.ts': 12.6,
  'shell-empty-projects.spec.ts': 2.5,
  'shell-flows.spec.ts': 38.2,
  'shell-keyboard.spec.ts': 0,
  'shell-viewport-floor.spec.ts': 9.5,
  'shell.spec.ts': 2.7,
  'sprint-delete.spec.ts': 6.7,
  'sprint-edit-dates.spec.ts': 5.8,
  'sprint-field.spec.ts': 6.7,
  'sprint-lifecycle.spec.ts': 8.0,
  'sprint-rename.spec.ts': 6.3,
  'status-derivation.spec.ts': 15.5,
  'token-permissions.spec.ts': 2.2,
  'top-bar-budget.spec.ts': 6.8,
  'triage-flow.spec.ts': 11.6,
  'work-item-delete.spec.ts': 5.7,
  'work-item-mentions.spec.ts': 5.6,
  'work-item-type-vocabulary.spec.ts': 7.4,
  'work-item-type.spec.ts': 6.9,
  'work-items-isolation.spec.ts': 10.2,
  'workflow-delete-reassign.spec.ts': 5.5,
  'workflow-flow.spec.ts': 2.1,
  'workflow-settings.spec.ts': 5.4,
  'workspace-flows.spec.ts': 7.1,
};

/**
 * Bin-pack specs across the legs by measured cost — longest-processing-time
 * first: walk the specs from most to least expensive and hand each to the leg
 * with the least load so far.
 *
 * Deterministic by construction: the sort tie-breaks on the file name and the
 * leg choice tie-breaks on matrix order, so the same costs always yield the same
 * assignment. That matters because the Playwright config and the CI matrix
 * compute it independently on every leg — a non-deterministic assignment would
 * silently drop or double-run specs.
 */
export function assignBulkLegs(
  costs: Readonly<Record<string, number>> = SPEC_COST_SECONDS,
  legIds: readonly string[] = BULK_LEG_IDS,
): Record<string, string[]> {
  const assignment: Record<string, string[]> = {};
  const load: number[] = [];
  for (const id of legIds) {
    assignment[id] = [];
    load.push(0);
  }
  const ordered = Object.keys(costs).sort((a, b) => {
    const delta = (costs[b] ?? 0) - (costs[a] ?? 0);
    return delta !== 0 ? delta : a.localeCompare(b);
  });
  for (const spec of ordered) {
    let pick = 0;
    for (let i = 1; i < legIds.length; i++) {
      if ((load[i] ?? 0) < (load[pick] ?? 0)) pick = i;
    }
    assignment[legIds[pick] as string]?.push(spec);
    load[pick] = (load[pick] ?? 0) + (costs[spec] ?? 0);
  }
  return assignment;
}

/** The spec files assigned to `legId`, or `null` when it is not a bulk leg. */
export function specsForLeg(legId: string): string[] | null {
  return assignBulkLegs()[legId] ?? null;
}

/** The total measured cost of a leg, in seconds. */
export function legCostSeconds(legId: string): number {
  return (specsForLeg(legId) ?? []).reduce((sum, s) => sum + (SPEC_COST_SECONDS[s] ?? 0), 0);
}

/**
 * A `testMatch` RegExp selecting exactly this leg's spec files — an anchored
 * alternation over the file names rather than a glob, so a name containing a
 * glob metacharacter (or a future nested spec directory) can never widen the
 * selection. Returns `null` for a leg id that is not a bulk leg, which is how
 * the Playwright config leaves the a11y / at-scale / billing lanes untouched.
 */
export function legTestMatch(legId: string): RegExp | null {
  const specs = specsForLeg(legId);
  if (!specs) return null;
  const alternation = specs.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`[\\\\/]tests[\\\\/]e2e[\\\\/](?:${alternation})$`);
}
