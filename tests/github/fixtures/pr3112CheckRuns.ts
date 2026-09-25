// motir-core#3112 @ `88508fb2640aff3e0b7506735e75d2d1ff267fa3` — the commit
// MOTIR-6274 was measured on. Read from the host, not transcribed from a card:
//
//   gh api "repos/moooon-B-V/motir-core/commits/88508fb2…/check-runs?filter=all" \
//     --paginate --jq '.check_runs[] | [.check_suite.id, .app.slug, .conclusion, .name]'
//
// 46 check runs in four suites, plus the `license/cla` commit status. The
// conclusions are mapped the way ingestion maps them (`skipped` → `neutral`,
// which the host reconcile records and a webhook does not).

export type FixtureConclusion = 'success' | 'failure' | 'neutral';

/** CodeQL workflow (`codeql.yml`) — an Actions suite. */
export const CODEQL_SUITE = '97677437243';
/** Acceptance tests (`acceptance.yml`) — an Actions suite. */
export const ACCEPTANCE_SUITE = '97677437481';
/** CI (`ci.yml`) — an Actions suite, and the NEWEST of the three. */
export const CI_SUITE = '97677438584';
/** GitHub's own advanced-security App (CodeQL default setup) — a different App. */
export const ADVANCED_SECURITY_SUITE = '97678384884';

export const CODEQL_RUNS: [string, FixtureConclusion][] = [
  ['Analyze (javascript-typescript)', 'success'],
];

export const ACCEPTANCE_RUNS: [string, FixtureConclusion][] = [
  ['Acceptance complete', 'success'],
  ['Does the lane hold a spec?', 'success'],
  ['Next.js build (acceptance)', 'neutral'],
  [
    'Playwright E2E (acceptance) ${{ matrix.shard }}/${{ needs.membership.outputs.legs }}',
    'neutral',
  ],
];

export const CI_RUNS: [string, FixtureConclusion][] = [
  ['CI complete', 'failure'],
  ['CLI package', 'neutral'],
  ['Coverage (approved status)', 'success'],
  ['Coverage (onboarding routing)', 'success'],
  ['Deploy to Fly', 'neutral'],
  ['Design asset guards', 'success'],
  ['Design-system package', 'neutral'],
  ['Docs guards', 'success'],
  ['Lint + Prettier', 'success'],
  ['Next.js build', 'success'],
  ['Orchestrator package', 'neutral'],
  ['Playwright E2E (a11y-1)', 'success'],
  ['Playwright E2E (a11y-2)', 'success'],
  ['Playwright E2E (bulk-1)', 'success'],
  ['Playwright E2E (bulk-2)', 'success'],
  ['Playwright E2E (bulk-3)', 'success'],
  ['Playwright E2E (bulk-4)', 'success'],
  ['Playwright E2E (bulk-5)', 'success'],
  ['Playwright E2E (bulk-6)', 'success'],
  ['Playwright E2E (bulk-7)', 'success'],
  ['Playwright E2E (bulk-8)', 'success'],
  ['Playwright E2E at-scale (${{ matrix.id }})', 'neutral'],
  ['Runner image', 'neutral'],
  ['Sandbox images', 'neutral'],
  ['Structural guards', 'success'],
  ['TypeScript', 'success'],
  ['Vitest (1/12)', 'success'],
  ['Vitest (10/12)', 'success'],
  ['Vitest (11/12)', 'success'],
  ['Vitest (12/12)', 'success'],
  ['Vitest (2/12)', 'success'],
  ['Vitest (3/12)', 'failure'],
  ['Vitest (4/12)', 'success'],
  ['Vitest (5/12)', 'success'],
  ['Vitest (6/12)', 'failure'],
  ['Vitest (7/12)', 'success'],
  ['Vitest (8/12)', 'success'],
  ['Vitest (9/12)', 'success'],
  ['Vitest coverage', 'neutral'],
  ['What changed', 'success'],
];

export const ADVANCED_SECURITY_RUNS: [string, FixtureConclusion][] = [['CodeQL', 'success']];
