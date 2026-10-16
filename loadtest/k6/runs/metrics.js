// THE RUN-LIFECYCLE METRIC CONTRACT (Story MOTIR-8538 · MOTIR-8676).
//
// What the report (MOTIR-8679) reads, fixed here:
//   run_steps              Counter EVERY request — tags step, outcome, role. The
//                                  source for every count (errors, refusals, empty
//                                  claims, throughput).
//   run_step_duration      Trend   `ok` requests only — tags step, role
//   run_lifecycle_duration Trend   one claim → close, `ok` iterations only
//   runs_completed         Counter iterations that reached the close
//   run_claim_refused      Counter claims answered taken / not_claimable
//   run_pool_exhausted     Counter iterations whose VU had no run card
//   run_limited            Counter 429s, on any step
//
// Every metric carries `role: run`. A `limited`, `empty` or `error` request never
// reaches a Trend. PURE: `scenarios/runs.js` creates the k6 objects and passes
// them in, so a test hands in stubs.

import { LIMITED, OK } from '../lib/outcome.js';

export const ROLE_RUN = 'run';

export const RUN_METRIC_NAMES = Object.freeze({
  steps: 'run_steps',
  stepDuration: 'run_step_duration',
  lifecycle: 'run_lifecycle_duration',
  completed: 'runs_completed',
  claimRefused: 'run_claim_refused',
  poolExhausted: 'run_pool_exhausted',
  limited: 'run_limited',
});

/**
 * Record one request. `metrics` holds `steps`, `stepDuration` and `limited`, each
 * with k6's `add(value, tags)`.
 *
 * @param {Record<'steps' | 'stepDuration' | 'limited', { add: (value: number, tags: Record<string, string>) => void }>} metrics
 * @param {{ step: string, outcome: string, durationMs: number }} request
 */
export function recordRunStep(metrics, { step, outcome, durationMs }) {
  const base = { role: ROLE_RUN, step };
  metrics.steps.add(1, { ...base, outcome });
  if (outcome === OK) metrics.stepDuration.add(durationMs, base);
  if (outcome === LIMITED) metrics.limited.add(1, base);
}
