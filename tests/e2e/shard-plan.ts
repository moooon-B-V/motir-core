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
 */
export const SPEC_COST_SECONDS: Readonly<Record<string, number>> = {
  'activity.spec.ts': 11.2,
  'ai-callout-gate.spec.ts': 1.5,
  'ai-plan-generation.spec.ts': 10.0,
  'api-tokens.spec.ts': 18.2,
  'appearance-sync.spec.ts': 4.9,
  'archive-flow.spec.ts': 10.3,
  'attachments.spec.ts': 14.9,
  'auth-credentials.spec.ts': 3.6,
  'auth-google.spec.ts': 3.5,
  // Not measured from a green `main` run — this spec did not exist for either
  // of them. The value is its own budget: the two injected document holds
  // (1.5s + 4s, `auth-post-auth-landing.spec.ts`) plus sign-in and seeding.
  'auth-post-auth-landing.spec.ts': 12.0,
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
  'collab-at-scale.spec.ts': 0,
  'collab-journey.spec.ts': 10.4,
  'comments.spec.ts': 11.6,
  'custom-fields.spec.ts': 18.5,
  'dashboards.spec.ts': 12.6,
  'epic-privacy-flow.spec.ts': 6.5,
  'epic2-acceptance.spec.ts': 6.7,
  'epic6-at-scale.spec.ts': 0,
  'epic6-journey.spec.ts': 12.7,
  'estimation.spec.ts': 12.9,
  'filter-builder.spec.ts': 20.0,
  'github.spec.ts': 7.1,
  'gitlab.spec.ts': 4.9,
  // Story MOTIR-2649 · Subtask MOTIR-2656 — three tests: the journey, the two
  // shell affordances (rail + bell), and the workspace-scope check. Seeds two
  // projects and five items through the services, so the cost is mostly fixture
  // build; measured against the other seed-then-signIn specs of this shape.
  'home.spec.ts': 8.0,
  'import.spec.ts': 7.4,
  'issue-create-edit-flow.spec.ts': 14.1,
  'issue-detail-flow.spec.ts': 46.7,
  'issue-list-flow.spec.ts': 44.7,
  'jobs-dashboard.spec.ts': 7.4,
  'jobs-flow.spec.ts': 89.7,
  'labels-components-watch.spec.ts': 27.6,
  'link-search-flow.spec.ts': 12.6,
  'member-facing-permissions.spec.ts': 6.6,
  'migrate-index-fleet.spec.ts': 26.1,
  'multi-tenant-isolation.spec.ts': 2.2,
  'notifications.spec.ts': 13.8,
  'onboarding-discovery.spec.ts': 2.5,
  'onboarding-entrance.spec.ts': 5.8,
  'onboarding-entry.spec.ts': 1.2,
  'onboarding-fresh.spec.ts': 8.6,
  'onboarding-ran-gate.spec.ts': 11.9,
  'org-admin.spec.ts': 7.9,
  'per-domain-admin-permissions.spec.ts': 11.4,
  'permission-gated-ui.spec.ts': 10.8,
  'plan-change-planner-turn.spec.ts': 6.7,
  'planning-anchor-level.spec.ts': 9.4,
  'plans-review.spec.ts': 6.3,
  'profile.spec.ts': 10.8,
  'project-access.spec.ts': 8.7,
  'project-details.spec.ts': 8.0,
  'project-isolation.spec.ts': 4.9,
  'project-square-flow.spec.ts': 4.3,
  'projects-flow.spec.ts': 5.3,
  'provenance.spec.ts': 14.8,
  'public-overview-edit.spec.ts': 7.0,
  'public-project-flow.spec.ts': 7.2,
  'public-signin-modal.spec.ts': 3.4,
  'quick-view-edit.spec.ts': 14.5,
  'ready.spec.ts': 5.9,
  'reports.spec.ts': 18.0,
  'roadmap-done-ready.spec.ts': 2.6,
  'roadmap-flow.spec.ts': 4.8,
  'roadmap-fullscreen.spec.ts': 2.9,
  'roadmap-locate.spec.ts': 3.1,
  'roadmap-refresh-scope.spec.ts': 8.5,
  'roadmap-scope-toggle.spec.ts': 5.8,
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
  'shell.spec.ts': 2.7,
  'sprint-delete.spec.ts': 6.7,
  'sprint-edit-dates.spec.ts': 5.8,
  'sprint-field.spec.ts': 6.7,
  'sprint-lifecycle.spec.ts': 8.0,
  'sprint-rename.spec.ts': 6.3,
  'status-derivation.spec.ts': 15.5,
  'top-bar-budget.spec.ts': 6.8,
  'triage-flow.spec.ts': 11.6,
  'work-item-delete.spec.ts': 5.7,
  'work-item-mentions.spec.ts': 5.6,
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
