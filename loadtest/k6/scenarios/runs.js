// RUN AGENTS (Story MOTIR-8538 · MOTIR-8676) — each iteration is one
// container-less `motir run <KEY>`: the same `/api/v1` calls in the same order
// (`../runs/sequence.js`), with the agent's working time a timed wait that beats
// and flushes as the real reporter does. No agent process, container, checkout
// or pull request exists anywhere; `origin: 'local'` records a run and starts
// nothing.
//
// Each VU uses its OWN `run` agent (by `__VU`) and takes cards from a disjoint
// slice of that agent's project's run pool, so two VUs never race for a card or
// share a token's 60/min `/api/v1` budget. After the close the card is recycled
// (unassigned, back to `todo`), tagged `step: recycle` and kept out of every
// run-lifecycle threshold.
//
// The token goes in the Authorization header only — never in a tag or a log.

import http from 'k6/http';
import exec from 'k6/execution';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { EMPTY, ERROR, LIMITED, OK, backoffSeconds } from '../lib/outcome.js';
import { classifyRunResponse } from '../runs/classify.js';
import { RUN_METRIC_NAMES, ROLE_RUN, recordRunStep } from '../runs/metrics.js';
import {
  RUN_OPERATIONS,
  idempotencyKey,
  pathFor,
  planIteration,
  runSlice,
} from '../runs/sequence.js';

export const metrics = {
  steps: new Counter(RUN_METRIC_NAMES.steps),
  stepDuration: new Trend(RUN_METRIC_NAMES.stepDuration, true),
  lifecycle: new Trend(RUN_METRIC_NAMES.lifecycle, true),
  completed: new Counter(RUN_METRIC_NAMES.completed),
  claimRefused: new Counter(RUN_METRIC_NAMES.claimRefused),
  poolExhausted: new Counter(RUN_METRIC_NAMES.poolExhausted),
  limited: new Counter(RUN_METRIC_NAMES.limited),
};

/** How many times one request is re-sent after `limited` answers. */
const MAX_LIMITED_RETRIES = 5;

/** Send one planned request, backing off and re-sending on a `limited` answer. */
function send(ctx, token, request, id) {
  const def = RUN_OPERATIONS[request.op];
  const url = `${ctx.baseUrl}${pathFor(request.op, { ...request.params, id })}`;
  const params = {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    tags: { name: `${def.method} ${def.path}`, step: request.step, role: ROLE_RUN },
    responseCallback: http.expectedStatuses({ min: 200, max: 299 }),
  };
  const body = request.body !== undefined ? JSON.stringify(request.body) : null;
  for (let attempt = 0; ; attempt += 1) {
    const res = http.request(def.method, url, body, params);
    const verdict = classifyRunResponse({
      step: request.step,
      status: res.status,
      headers: res.headers,
      body: typeof res.body === 'string' ? res.body : '',
    });
    recordRunStep(metrics, {
      step: request.step,
      outcome: verdict.outcome,
      durationMs: res.timings.duration,
    });
    if (verdict.outcome !== LIMITED || attempt >= MAX_LIMITED_RETRIES) return verdict;
    sleep(backoffSeconds(verdict.retryAfterSeconds, ctx.runs.maxRetryAfterSeconds));
  }
}

/**
 * `ctx`: `{ manifest, baseUrl, runs: { agentSeconds, logEventsPerBeat, recycle,
 * maxRetryAfterSeconds } }`. Returns the iteration function for the profile's
 * runs scenario.
 */
export function runsScenario(ctx) {
  const { manifest } = ctx;
  const runAgents = manifest.agents.filter((a) => a.role === 'run');
  return function runsIteration() {
    if (runAgents.length === 0) throw new Error('the manifest has no run agents');
    const vu = exec.vu.idInTest;
    const agent = runAgents[(vu - 1) % runAgents.length];
    const tags = { role: ROLE_RUN };
    const slice = runSlice(manifest, agent);
    if (slice.length === 0) {
      metrics.poolExhausted.add(1, tags);
      sleep(1);
      return;
    }
    const n = exec.vu.iterationInScenario;
    const card = slice[n % slice.length];
    const project = manifest.projects.find((p) => p.id === agent.projectId);
    const plan = planIteration({
      key: card.key,
      projectKey: project.key,
      agentSeconds: ctx.runs.agentSeconds,
      logEventsPerBeat: ctx.runs.logEventsPerBeat,
      recycle: ctx.runs.recycle,
      idempotencyKey: idempotencyKey(vu, n, Date.now()),
    });
    const recycleSteps = plan.after.filter((r) => r.step === 'recycle');
    const recycle = () => {
      for (const r of recycleSteps) send(ctx, agent.token, r, null);
    };

    let claimedAt = null;
    for (const request of plan.before) {
      const verdict = send(ctx, agent.token, request, null);
      if (request.step === 'claim') {
        if (verdict.outcome === EMPTY) {
          metrics.claimRefused.add(1, tags);
          return;
        }
        if (verdict.outcome !== OK) return;
        claimedAt = Date.now();
      } else if (verdict.outcome === ERROR && claimedAt !== null) {
        recycle();
        return;
      }
    }

    const opened = send(ctx, agent.token, plan.open, null);
    const runId = opened.json?.run?.id;
    if (opened.outcome !== OK || typeof runId !== 'string') {
      recycle();
      return;
    }

    const start = Date.now();
    let clean = true;
    for (const request of plan.after) {
      if (request.step === 'recycle') continue;
      const wait = start + request.atMs - Date.now();
      if (wait > 0) sleep(wait / 1000);
      const verdict = send(ctx, agent.token, request, runId);
      if (verdict.outcome !== OK) clean = false;
    }
    if (clean) {
      metrics.completed.add(1, tags);
      metrics.lifecycle.add(Date.now() - claimedAt, tags);
    }
    recycle();
  };
}
